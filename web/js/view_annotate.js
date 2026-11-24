// 标注页：画布、多几何编辑、锁、快捷键、预标注
// 坐标规则（不可变）：内部一律用图像像素坐标，缩放系数只在绘制与鼠标换算时乘一次，落库不取整。
// 几何统一形式：{ cls, geom_type, geom, conf, source }
//   rect     geom = [x1,y1,x2,y2]
//   polygon  geom = [[x,y],...]
//   line     geom = [[x,y],...]
//   point    geom = [x,y]
//   classify geom = []
import { get, post, put, del } from './api.js';
import * as ui from './ui.js';

const HANDLE = 4;          // 手柄半径（屏幕像素）
const MIN_BOX = 3;         // 建框最小尺寸（图像像素）
const AUTOSAVE_MS = 30000;

const GT_NAME = { rect: '矩形框', polygon: '多边形', line: '折线', point: '点', classify: '整图', brush: '画笔' };
const GT_ICON = { rect: 'square', polygon: 'polygon', line: 'line', point: 'point', brush: 'brush' };

export async function renderAnnotate(root, ctx) {
  const { navigate, projectId, startImageId } = ctx;
  const ac = new AbortController();
  const on = (el, ev, fn, opt) => el.addEventListener(ev, fn, { signal: ac.signal, ...opt });

  // ------------------------------------------------------------ 状态
  const S = {
    proj: null, labels: [], sel: -1, hover: -1,
    image: null, imageId: null, version: 0, img: null,
    scale: 1, ox: 0, oy: 0, fitScale: 1,
    tool: 'rect',          // rect | polygon | line | point | select
    drag: null,            // {type, ...}
    draft: null,           // {geom_type, pts:[[x,y]], cursor:[x,y]}
    dirty: false, saving: false, savedAt: null,
    undo: [], redo: [],
    list: [], listTotal: 0, locked: new Set(), groups: [], counts: {},
    listLoading: false,
    model: null, conf: 0.25, iou: 0.45,
    cls: '',
    busy: false,
  };

  let raf = null, hbTimer = null, autoTimer = null, spaceDown = false;
  let ALLOWED = ['rect'];
  let isClassify = false;
  // 图片列表：展开组一次渲染到 GROUP_ROWS 行，折叠只切 class 不重建 DOM。
  // 1845 张图全量 innerHTML 加逐行绑事件会明显卡顿，这里改为一次性取全元数据、
  // 分组渲染、事件委托；2000 行以内直接全见，更大的组才分批。
  const GROUP_ROWS = 2000;
  const expandedGroups = new Set();
  const groupRows = new Map();
  let filterText = '';

  // ------------------------------------------------------------ DOM
  root.innerHTML = `
  <div class="annot">
    <div class="annot-top">
      <button class="btn btn-sm btn-ghost" id="back">${ui.icon('arrowLeft', 15)} 返回</button>
      <div style="font-size:13px;font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
           id="pname"></div>
      <span class="task-chip" id="ptask"></span>
      <span class="tag tag-gray" id="pos">—</span>
      <span id="state-dot"></span>
      <div class="grow"></div>
      <span class="hint" id="saveinfo"></span>
      <button class="btn btn-sm" id="helpbtn" title="标注说明与快捷键">${ui.icon('help', 14)} 标注说明</button>
      <button class="btn btn-sm" id="prelabel">${ui.icon('wand', 14)} 预标注</button>
      <button class="btn btn-sm" id="skip">${ui.icon('skip', 14)} 跳过</button>
      <button class="btn btn-sm btn-primary" id="done">${ui.icon('check', 14)} 完成并下一张</button>
    </div>
    <div class="annot-body">
      <div class="imagelist">
        <div class="imagelist-head"><span>图片</span><span class="num" id="fcount"></span></div>
        <div style="padding:6px 8px 2px">
          <input class="input" id="fsearch" placeholder="按文件名筛选" style="height:28px;font-size:12px">
        </div>
        <div class="imagelist-body" id="film"></div>
      </div>
      <div class="canvas-wrap" id="wrap">
        <canvas id="cv"></canvas>
        <div class="canvas-tools" id="tools"></div>
        <div class="canvas-info" id="cinfo"></div>
        <div class="canvas-hintbar" id="chint"></div>
        <div class="canvas-empty" id="cempty" style="display:none"></div>
      </div>
      <div class="side-panel">
        <div class="panel-sec">
          <div class="panel-sec-head"><span id="cls-title">类别</span><span class="hint">按数字键切换</span></div>
          <div class="panel-sec-body"><div id="clist"></div></div>
        </div>
        <div class="panel-sec">
          <div class="panel-sec-head"><span>本图标注</span><span class="hint" id="boxcount"></span></div>
          <div class="panel-sec-body"><div class="box-list" id="blist"></div></div>
        </div>
        <div class="panel-sec">
          <div class="panel-sec-head"><span>预标注</span><span class="hint" id="mname"></span></div>
          <div class="panel-sec-body">
            <div class="row" style="margin-bottom:8px">
              <span class="hint" style="width:52px">置信度</span>
              <input type="range" id="conf" min="0.05" max="0.9" step="0.05" value="0.25" class="grow">
              <span class="num" id="confv" style="width:30px;text-align:right;font-size:11.5px">0.25</span>
            </div>
            <div class="hint" style="font-size:11px">低于阈值的预测不写入。</div>
          </div>
        </div>
        <div class="panel-sec" style="border-bottom:none">
          <div class="panel-sec-head"><span>图像信息</span></div>
          <div class="panel-sec-body hint" id="imginfo" style="font-size:11.5px;line-height:1.8"></div>
        </div>
      </div>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const wrap = $('#wrap');
  const canvas = $('#cv');
  const ctx2d = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  // ------------------------------------------------------------ 初始化
  try {
    S.proj = await get(`/api/projects/${projectId}`);
  } catch (e) {
    root.innerHTML = `<div class="page"><div class="banner banner-err">${ui.esc(e.message)}</div></div>`;
    return;
  }
  $('#pname').textContent = S.proj.name;
  $('#ptask').textContent = S.proj.task_label || S.proj.task_type;
  ALLOWED = (S.proj.geom_types && S.proj.geom_types.length) ? S.proj.geom_types.slice() : ['rect'];
  isClassify = ALLOWED.includes('classify');
  // 画笔不在项目类型里，任何能画形状的项目都开放（产出的是多边形）
  if (!isClassify && !ALLOWED.includes('brush')) ALLOWED.push('brush');
  S.cls = (S.proj.labels || [])[0] || '';
  S.tool = isClassify ? 'select' : (ALLOWED.find((g) => g !== 'classify') || 'rect');

  try {
    const md = await get('/api/models');
    const list = md.models || [];
    S.model = list.find((m) => m.id === S.proj.model_id)
      || list.find((m) => m.task === S.proj.task_type)
      || list.find((m) => m.is_default) || list[0] || null;
    $('#mname').textContent = S.model ? S.model.name.slice(0, 16) : '无模型';
  } catch { /* 忽略 */ }

  buildTools();
  drawClsList();
  await loadFilmstrip();

  if (startImageId) await openImage(startImageId, false);
  else {
    const nx = await get(`/api/projects/${projectId}/next?after=0&mode=todo`);
    if (nx.image_id) await openImage(nx.image_id, false);
    else showEmpty('这个项目还没有可标注的图片。先去「裁切」或「导入」把图片加进来。');
  }

  // ------------------------------------------------------------ 工具栏
  function buildTools() {
    const tools = $('#tools');
    if (isClassify) { tools.style.display = 'none'; return; }
    const draws = ALLOWED.filter((g) => g !== 'classify');
    tools.innerHTML = `
      ${draws.map((g) => `<button data-tool="${g}" title="${GT_NAME[g]}">
        ${ui.icon(GT_ICON[g], 14)}</button>`).join('')}
      <div class="sep"></div>
      <button data-tool="select" title="选择 (V)">${ui.icon('pointer', 14)}</button>
      <div class="sep"></div>
      <button id="t-undo" title="撤销 (Ctrl+Z)">${ui.icon('undo', 14)}</button>
      <button id="t-redo" title="重做 (Ctrl+Shift+Z)">${ui.icon('redo', 14)}</button>
      <div class="sep"></div>
      <button id="t-fit" title="适应窗口">1:1</button>
      <button id="t-zin" title="放大">${ui.icon('zoomIn', 14)}</button>
      <button id="t-zout" title="缩小">${ui.icon('zoomOut', 14)}</button>`;
    tools.querySelectorAll('[data-tool]').forEach((b) => {
      b.onclick = () => setTool(b.dataset.tool);
    });
    tools.querySelector('#t-undo').onclick = doUndo;
    tools.querySelector('#t-redo').onclick = doRedo;
    tools.querySelector('#t-fit').onclick = fit;
    tools.querySelector('#t-zin').onclick = () => zoomAt(canvas.width / dpr / 2, canvas.height / dpr / 2, 1.2);
    tools.querySelector('#t-zout').onclick = () => zoomAt(canvas.width / dpr / 2, canvas.height / dpr / 2, 1 / 1.2);
    setTool(S.tool);
  }

  function setTool(t) {
    S.tool = t;
    if (S.draft) cancelDraft();
    const tools = $('#tools');
    if (tools && tools.querySelectorAll('[data-tool]').length) {
      tools.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    }
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    updateHint();
  }

  function updateHint() {
    const el = $('#chint');
    if (!el) return;
    if (isClassify) { el.style.display = 'none'; return; }
    const m = {
      rect: ['拖拽画矩形框', '点中框可拖动，拖角改大小'],
      polygon: ['依次单击加顶点', '回到起点或双击闭合'],
      line: ['依次单击加折点', '双击结束'],
      point: ['单击落一个点', ''],
      brush: ['按住拖动描出轮廓', '松手自动闭合成多边形'],
      select: ['拖动移动，拖顶点改形状', 'Delete 删除'],
    }[S.tool] || ['', ''];
    let extra = '';
    if (S.draft) {
      if (S.draft.brush) extra = `画笔描边中，已记录 ${S.draft.pts.length} 个点 · 松手闭合`;
      else if (S.draft.geom_type === 'polygon') {
        extra = `正在画多边形，${S.draft.pts.length} 个点 · 双击闭合 · Esc 取消`;
      } else {
        extra = `正在画折线，${S.draft.pts.length} 个点 · 双击结束 · Esc 取消`;
      }
    }
    el.style.display = 'flex';
    el.innerHTML = extra
      ? `<span style="color:#ffd479">${ui.esc(extra)}</span>`
      : `<span>${ui.esc(m[0])}</span>${m[1] ? `<span style="opacity:.6">·</span><span>${ui.esc(m[1])}</span>` : ''}`;
  }

  // ------------------------------------------------------------ 图片列表
  // 只列文件名，不加载缩略图：几千张图逐张请求缩略图既慢又吃内存，
  // 标的时候真正需要的是"这一组还有几张没做"，文件名比小图更好扫。

  async function loadFilmstrip() {
    S.listLoading = true;
    const gd = await get(`/api/projects/${projectId}/groups`).catch(() => null);
    if (gd) S.groups = gd.groups || [];

    // 分页取全量元数据（compact 只返回列表需要的字段）。不再用“加载更多”按钮，
    // 否则 1500 张的第二组要连点十几次才看得见，组内计数也会只按已加载的部分算。
    const PAGE = 1000;
    let offset = 0;
    let total = 0;
    S.list = [];
    do {
      const d = await get(
        `/api/projects/${projectId}/images?compact=1&limit=${PAGE}&offset=${offset}`,
      );
      const items = d.items || [];
      S.list = S.list.concat(items);
      total = d.total ?? S.list.length;
      S.listTotal = total;
      S.counts = d.counts || S.counts;
      offset = S.list.length;
      if (!items.length) break;
    } while (S.list.length < total);

    S.listLoading = false;
    S.listTotal = total || S.list.length;
    if (S.imageId && S.image && !S.list.some((x) => x.id === S.imageId)) {
      S.list.unshift(S.image);
      S.listTotal = Math.max(S.listTotal, S.list.length);
    }
    renderFilmstrip();
  }

  function fileName(it) {
    const p = (it.rel_path || '').split('/');
    return p[p.length - 1] || `#${it.id}`;
  }

  function batchName(id) {
    const g = (S.groups || []).find((x) => x.id === id);
    return g ? g.name : (id ? `分组 ${id}` : '未分组');
  }

  function filteredItems() {
    const kw = filterText.trim().toLowerCase();
    return kw ? S.list.filter((it) => fileName(it).toLowerCase().includes(kw)) : S.list;
  }

  function groupBuckets(items) {
    // 按来源分组：组号在文件名里也在最前面，两边顺序对得上
    const order = [];
    const buckets = new Map();
    (S.groups || []).forEach((g) => { buckets.set(g.id, []); order.push(g.id); });
    items.forEach((it) => {
      const k = it.batch_id ?? 0;
      if (!buckets.has(k)) { buckets.set(k, []); order.push(k); }
      buckets.get(k).push(it);
    });
    return { order, buckets };
  }

  function rowsHTML(arr) {
    return arr.map((it) => {
      const st = ui.STATUS[it.status] || ui.STATUS.todo;
      const lockedOther = it.locked_by && it.id !== S.imageId;
      return `<div class="il-row ${it.id === S.imageId ? 'active' : ''} ${lockedOther ? 'locked' : ''}"
        data-id="${it.id}" title="#${it.id} ${ui.esc(fileName(it))}${it.locked_by ? ' · 占用：' + ui.esc(it.locked_by) : ''}">
        <span class="st" style="background:${st.color}" title="${st.label}"></span>
        <span class="nm">${ui.esc(fileName(it))}</span>
        ${lockedOther ? `<span class="lk">${ui.icon('lock', 11)}</span>` : ''}
      </div>`;
    }).join('');
  }

  function moreHTML(arr, k, shown) {
    if (shown >= arr.length) return '';
    return `<div class="il-more"><button class="btn btn-sm" data-more="${k}">显示更多（剩 ${arr.length - shown} 张）</button></div>`;
  }

  function groupBodyHTML(arr, k) {
    const shown = Math.min(arr.length, groupRows.get(k) || GROUP_ROWS);
    return rowsHTML(arr.slice(0, shown)) + moreHTML(arr, k, shown);
  }

  function renderFilmstrip() {
    const film = $('#film');
    if (!film) return;
    const kw = filterText.trim().toLowerCase();
    const items = filteredItems();
    $('#fcount').textContent = S.listLoading
      ? `加载中 ${S.list.length}/${S.listTotal || '…'}`
      : (kw ? `${items.length} 命中 / ${S.listTotal}` : `${S.list.length}/${S.listTotal}`);

    if (!items.length) {
      film.innerHTML = `<div class="hint" style="padding:14px 8px">${kw ? '没有匹配的文件名' : '这个项目还没有图片'}</div>`;
      return;
    }

    const { order, buckets } = groupBuckets(items);
    film.innerHTML = order.filter((k) => buckets.get(k).length).map((k) => {
      const arr = buckets.get(k);
      const g = (S.groups || []).find((x) => x.id === k);
      // 分组计数优先用 groups 接口的真实总数，避免只加载了一部分时显示成 655/655
      const total = kw ? arr.length : (g ? g.n_now : arr.length);
      // 完成数从已加载的完整列表实时算，标完一张后组头能立刻 +1；
      // 组总数仍用 groups 接口的值，避免分页加载期间显示成已加载的数量。
      const nDone = arr.filter((x) => x.status === 'done' || x.status === 'reviewed').length;
      const hasActive = arr.some((x) => x.id === S.imageId);
      if (hasActive) expandedGroups.add(k);
      // 筛选状态下把命中的组直接展开，否则搜到了却看不见结果
      if (kw) expandedGroups.add(k);
      const expanded = expandedGroups.has(k);
      return `
        <div class="il-group ${expanded ? '' : 'collapsed'}" data-g="${k}">
          <div class="il-group-head" data-gt="${k}">
            <span class="cv">${ui.icon('chevronDown', 12)}</span>
            <b title="${ui.esc(batchName(k))}">${ui.esc(batchName(k))}</b>
            <span class="n">${nDone}/${total}</span>
          </div>
          <div class="il-items">${expanded ? groupBodyHTML(arr, k) : ''}</div>
        </div>`;
    }).join('');

    markActiveRow();
  }

  function markActiveRow() {
    const film = $('#film');
    if (!film) return;
    film.querySelectorAll('.il-row.active').forEach((el) => el.classList.remove('active'));
    if (!S.imageId) return;
    const el = film.querySelector(`.il-row[data-id="${S.imageId}"]`);
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function fillGroup(k, groupEl) {
    if (!groupEl) return;
    const arr = filteredItems().filter((it) => (it.batch_id ?? 0) === k);
    const body = groupEl.querySelector('.il-items');
    if (!body) return;
    body.innerHTML = groupBodyHTML(arr, k);
    markActiveRow();
  }

  function toggleGroup(k) {
    const film = $('#film');
    const groupEl = film && film.querySelector(`[data-g="${k}"]`);
    if (!groupEl) return;
    if (groupEl.classList.contains('collapsed')) {
      expandedGroups.add(k);
      const body = groupEl.querySelector('.il-items');
      if (body && !body.children.length) fillGroup(k, groupEl);
      groupEl.classList.remove('collapsed');
    } else {
      expandedGroups.delete(k);
      groupEl.classList.add('collapsed');
    }
  }

  function revealActive() {
    const film = $('#film');
    if (!film) return;
    if (!S.imageId) { markActiveRow(); return; }
    const it = S.list.find((x) => x.id === S.imageId);
    if (!it) { renderFilmstrip(); return; }
    const k = it.batch_id ?? 0;
    expandedGroups.add(k);
    const kw = filterText.trim().toLowerCase();
    if (kw && !fileName(it).toLowerCase().includes(kw)) {
      filterText = '';
      const search = $('#fsearch');
      if (search) search.value = '';
    }
    const arr = filteredItems().filter((x) => (x.batch_id ?? 0) === k);
    const idx = arr.findIndex((x) => x.id === S.imageId);
    const shown = groupRows.get(k) || GROUP_ROWS;
    if (idx >= shown) groupRows.set(k, idx + GROUP_ROWS);

    const groupEl = film.querySelector(`[data-g="${k}"]`);
    if (groupEl && groupEl.classList.contains('collapsed')) {
      const body = groupEl.querySelector('.il-items');
      if (body && !body.children.length) fillGroup(k, groupEl);
      groupEl.classList.remove('collapsed');
    }
    if (film.querySelector(`.il-row[data-id="${S.imageId}"]`)) markActiveRow();
    else renderFilmstrip();
  }

  function refreshGroupCount(k) {
    const film = $('#film');
    const el = film && film.querySelector(`[data-g="${k}"] .il-group-head .n`);
    if (!el) return;
    const arr = filteredItems().filter((it) => (it.batch_id ?? 0) === k);
    const g = (S.groups || []).find((x) => x.id === k);
    const kw = filterText.trim().toLowerCase();
    const total = kw ? arr.length : (g ? g.n_now : arr.length);
    const nDone = arr.filter((x) => x.status === 'done' || x.status === 'reviewed').length;
    el.textContent = `${nDone}/${total}`;
  }

  function updateFilmRow(it) {
    const film = $('#film');
    if (!film || !it) return;
    const row = film.querySelector(`.il-row[data-id="${it.id}"]`);
    if (row) {
      const st = ui.STATUS[it.status] || ui.STATUS.todo;
      const dot = row.querySelector('.st');
      if (dot) { dot.style.background = st.color; dot.title = st.label; }
    }
    refreshGroupCount(it.batch_id ?? 0);
  }

  $('#film').addEventListener('click', (e) => {
    const head = e.target.closest('[data-gt]');
    if (head) { toggleGroup(Number(head.dataset.gt)); return; }
    const more = e.target.closest('[data-more]');
    if (more) {
      const k = Number(more.dataset.more);
      groupRows.set(k, (groupRows.get(k) || GROUP_ROWS) + GROUP_ROWS);
      fillGroup(k, more.closest('.il-group'));
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) openImage(Number(row.dataset.id), true);
  });

  let filterTimer = null;
  $('#fsearch').addEventListener('input', (e) => {
    filterText = e.target.value;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      groupRows.clear();
      renderFilmstrip();
    }, 120);
  });

  // ------------------------------------------------------------ 打开图片
  async function openImage(id, checkDirty = true) {
    if (S.busy) return;
    if (id === S.imageId) return;
    if (checkDirty && S.dirty) await save(false);
    S.busy = true;
    try {
      await releaseLock();
      let r;
      try {
        r = await post(`/api/images/${id}/lock`, {});
      } catch (e) {
        ui.toast(e.message, 'err', 4200);
        S.busy = false;
        return;
      }
      S.image = r.image;
      S.imageId = id;
      S.version = r.image.version;
      S.labels = [];
      S.sel = -1; S.undo = []; S.redo = []; S.dirty = false; S.savedAt = null;
      S.draft = null;
      const d = await get(`/api/images/${id}`);
      S.labels = (d.labels || []).map(normLabel);
      S.version = d.image.version;
      await loadBitmap();
      // 从「下一张」直接进来时，这张图可能不在已加载的列表里，补进去免得列表里没有高亮
      if (!S.list.some((x) => x.id === id) && S.image) {
        S.list.unshift(S.image);
        S.listTotal = Math.max(S.listTotal, S.list.length);
      }
      revealActive();
      renderBoxList();
      updateTopbar();
      updateInfo();
      startHeartbeat();
      fit();
    } finally {
      S.busy = false;
    }
  }

  function normLabel(l) {
    const gt = l.geom_type || 'rect';
    let g = l.geom;
    if (gt === 'rect') {
      g = (Array.isArray(g) && g.length >= 4 && typeof g[0] === 'number')
        ? g.slice(0, 4).map(Number)
        : [Number(l.x1), Number(l.y1), Number(l.x2), Number(l.y2)];
    } else if (gt === 'point') {
      g = (Array.isArray(g) && g.length >= 2 && typeof g[0] === 'number')
        ? [Number(g[0]), Number(g[1])]
        : [Number(l.x1), Number(l.y1)];
    } else if (gt === 'classify') {
      g = [];
    } else {
      g = Array.isArray(g) ? g.map((p) => [Number(p[0]), Number(p[1])]) : [];
    }
    return { cls: l.cls, geom_type: gt, geom: g, conf: l.conf, source: l.source || 'human' };
  }

  function bboxOf(l) {
    const g = l.geom;
    if (l.geom_type === 'rect') {
      return [Math.min(g[0], g[2]), Math.min(g[1], g[3]), Math.max(g[0], g[2]), Math.max(g[1], g[3])];
    }
    if (l.geom_type === 'point') return [g[0], g[1], g[0], g[1]];
    if (l.geom_type === 'classify') {
      return [0, 0, S.image ? S.image.width : 0, S.image ? S.image.height : 0];
    }
    if (!g.length) return [0, 0, 0, 0];
    const xs = g.map((p) => p[0]), ys = g.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function labelSize(l) {
    const b = bboxOf(l);
    return [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])];
  }

  function loadBitmap() {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { S.img = img; resolve(); };
      img.onerror = () => {
        S.img = null;
        showEmpty('图片文件读取失败，可能被移动或删除了。');
        resolve();
      };
      img.src = `/api/images/${S.imageId}/file?t=${Date.now()}`;
    });
  }

  function showEmpty(msg) {
    const el = $('#cempty');
    el.style.display = 'flex';
    el.innerHTML = `${ui.icon('image', 30)}<div>${ui.esc(msg)}</div>`;
  }

  // ------------------------------------------------------------ 尺寸与绘制
  function requestDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; draw(); });
  }

  function resize() {
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    fit();
  }

  function fit() {
    if (!S.img) { requestDraw(); return; }
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const s = Math.min(cw / S.img.naturalWidth, ch / S.img.naturalHeight) * 0.94;
    S.fitScale = s;
    S.scale = s;
    S.ox = (cw - S.img.naturalWidth * s) / 2;
    S.oy = (ch - S.img.naturalHeight * s) / 2;
    requestDraw();
  }

  function zoomAt(mx, my, factor) {
    const ns = Math.max(0.08, Math.min(12, S.scale * factor));
    if (ns === S.scale) return;
    const wx = (mx - S.ox) / S.scale;
    const wy = (my - S.oy) / S.scale;
    S.scale = ns;
    S.ox = mx - wx * ns;
    S.oy = my - wy * ns;
    requestDraw();
  }

  const toImg = (sx, sy) => ({ x: (sx - S.ox) / S.scale, y: (sy - S.oy) / S.scale });
  const toScreen = (x, y) => ({ x: S.ox + x * S.scale, y: S.oy + y * S.scale });

  function draw() {
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cw, ch);
    if (!S.img) return;

    ctx2d.imageSmoothingEnabled = S.scale < 1;
    ctx2d.imageSmoothingQuality = 'high';
    ctx2d.drawImage(S.img, S.ox, S.oy, S.img.naturalWidth * S.scale, S.img.naturalHeight * S.scale);

    ctx2d.strokeStyle = 'rgba(255,255,255,.14)';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(S.ox, S.oy, S.img.naturalWidth * S.scale, S.img.naturalHeight * S.scale);

    S.labels.forEach((l, i) => {
      if (l.geom_type === 'classify') return;   // 整图标签不画形状
      drawShape(l, i === S.sel, i === S.hover);
    });

    drawDraft();
    drawCreateRect();

    $('#cinfo').textContent =
      `${S.img.naturalWidth}×${S.img.naturalHeight} · ${Math.round(S.scale * 100)}%`;
  }

  function drawShape(l, selected, hovered) {
    const color = ui.clsColor(S.proj.labels, l.cls);
    const gt = l.geom_type;
    ctx2d.setLineDash([]);
    ctx2d.shadowBlur = 0;

    if (gt === 'rect') {
      const [x1, y1, x2, y2] = bboxOf(l);
      const a = toScreen(x1, y1);
      const w = (x2 - x1) * S.scale, h = (y2 - y1) * S.scale;
      ctx2d.lineWidth = selected ? 2.4 : hovered ? 1.8 : 1.3;
      ctx2d.strokeStyle = color;
      if (selected) { ctx2d.shadowColor = 'rgba(255,255,255,.85)'; ctx2d.shadowBlur = 5; }
      ctx2d.strokeRect(a.x, a.y, w, h);
      ctx2d.shadowBlur = 0;
      if (l.source !== 'human' || selected) {
        ctx2d.fillStyle = hexA(color, selected ? 0.22 : 0.12);
        ctx2d.fillRect(a.x, a.y, w, h);
      }
      if (selected || hovered || (w > 40 && h > 26)) drawTag(l, selected, a.x, a.y - 16, a.x, a.y, a.y + h);
      if (selected) drawRectHandles(a.x, a.y, w, h);
      return;
    }

    if (gt === 'polygon') {
      const pts = l.geom.map((p) => toScreen(p[0], p[1]));
      if (pts.length < 2) return;
      ctx2d.beginPath();
      ctx2d.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx2d.lineTo(p.x, p.y));
      ctx2d.closePath();
      ctx2d.fillStyle = hexA(color, selected ? 0.2 : l.source !== 'human' ? 0.12 : 0.07);
      ctx2d.fill();
      ctx2d.lineWidth = selected ? 2.4 : hovered ? 1.8 : 1.3;
      ctx2d.strokeStyle = color;
      if (selected) { ctx2d.shadowColor = 'rgba(255,255,255,.85)'; ctx2d.shadowBlur = 5; }
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
      const top = pts.reduce((a, b) => (b.y < a.y ? b : a), pts[0]);
      if (selected || hovered) drawTag(l, selected, top.x, top.y - 16, top.x, top.y, top.y);
      if (selected) drawPts(pts);
      return;
    }

    if (gt === 'line') {
      const pts = l.geom.map((p) => toScreen(p[0], p[1]));
      if (pts.length < 2) return;
      ctx2d.beginPath();
      ctx2d.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach((p) => ctx2d.lineTo(p.x, p.y));
      ctx2d.lineWidth = selected ? 2.8 : hovered ? 2.2 : 1.8;
      ctx2d.strokeStyle = color;
      ctx2d.lineJoin = 'round';
      if (selected) { ctx2d.shadowColor = 'rgba(255,255,255,.85)'; ctx2d.shadowBlur = 5; }
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
      if (selected) drawPts(pts);
      const top = pts.reduce((a, b) => (b.y < a.y ? b : a), pts[0]);
      if (selected || hovered) drawTag(l, selected, top.x, top.y - 16, top.x, top.y, top.y);
      return;
    }

    if (gt === 'point') {
      const a = toScreen(l.geom[0], l.geom[1]);
      const r = selected ? 6.5 : hovered ? 5.5 : 4.5;
      ctx2d.beginPath();
      ctx2d.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = color;
      ctx2d.fill();
      ctx2d.lineWidth = 1.8;
      ctx2d.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,.85)';
      ctx2d.stroke();
      if (selected) {
        ctx2d.beginPath();
        ctx2d.arc(a.x, a.y, r + 4, 0, Math.PI * 2);
        ctx2d.strokeStyle = hexA(color, 0.9);
        ctx2d.lineWidth = 1;
        ctx2d.stroke();
      }
      if (selected || hovered) drawTag(l, selected, a.x + 8, a.y - 8, a.x, a.y, a.y);
    }
  }

  function drawTag(l, selected, x, y, anchorX, anchorY, bottomY) {
    const color = ui.clsColor(S.proj.labels, l.cls);
    const withConf = (selected || l.conf != null) && l.conf != null;
    const text = `${l.cls}${withConf ? ' ' + l.conf.toFixed(2) : ''}`;
    ctx2d.font = '600 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    const tw = ctx2d.measureText(text).width + 9;
    const bh = 15;
    let by = y;
    if (by < 0) by = anchorY + 2;
    ctx2d.fillStyle = selected ? '#ffffff' : color;
    ctx2d.fillRect(x, by, tw, bh);
    ctx2d.fillStyle = selected ? '#111827' : '#ffffff';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText(text, x + 4.5, by + bh / 2 + 0.5);
  }

  function drawRectHandles(x, y, w, h) {
    const pts = [
      [x, y], [x + w / 2, y], [x + w, y],
      [x + w, y + h / 2], [x + w, y + h],
      [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
    ];
    ctx2d.fillStyle = '#ffffff';
    ctx2d.strokeStyle = '#2563eb';
    ctx2d.lineWidth = 1.4;
    pts.forEach(([px, py]) => {
      ctx2d.beginPath();
      ctx2d.rect(px - HANDLE, py - HANDLE, HANDLE * 2, HANDLE * 2);
      ctx2d.fill();
      ctx2d.stroke();
    });
  }

  function drawPts(pts) {
    ctx2d.fillStyle = '#ffffff';
    ctx2d.strokeStyle = '#2563eb';
    ctx2d.lineWidth = 1.4;
    pts.forEach((p) => {
      ctx2d.beginPath();
      ctx2d.rect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
      ctx2d.fill();
      ctx2d.stroke();
    });
  }

  function drawDraft() {
    if (!S.draft) return;
    const color = ui.clsColor(S.proj.labels, S.cls) || '#f59e0b';
    const pts = S.draft.pts.map((p) => toScreen(p[0], p[1]));
    if (!pts.length) return;
    ctx2d.setLineDash([5, 3]);
    ctx2d.lineWidth = 1.6;
    ctx2d.strokeStyle = color;
    ctx2d.beginPath();
    ctx2d.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx2d.lineTo(p.x, p.y));
    if (S.draft.cursor) {
      const c = toScreen(S.draft.cursor[0], S.draft.cursor[1]);
      ctx2d.lineTo(c.x, c.y);
      if (S.draft.geom_type === 'polygon') ctx2d.lineTo(pts[0].x, pts[0].y);
    }
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    ctx2d.fillStyle = color;
    pts.forEach((p) => {
      ctx2d.beginPath();
      ctx2d.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx2d.fill();
    });
    if (S.draft.geom_type === 'polygon' && pts.length > 2) {
      ctx2d.beginPath();
      ctx2d.arc(pts[0].x, pts[0].y, 7, 0, Math.PI * 2);
      ctx2d.strokeStyle = '#fff';
      ctx2d.lineWidth = 1.4;
      ctx2d.stroke();
    }
  }

  function drawCreateRect() {
    if (!S.drag || S.drag.type !== 'create' || !S.drag.cur) return;
    const a = S.drag.cur;
    const x = S.ox + Math.min(a.x0, a.x1) * S.scale;
    const y = S.oy + Math.min(a.y0, a.y1) * S.scale;
    const w = Math.abs(a.x1 - a.x0) * S.scale;
    const h = Math.abs(a.y1 - a.y0) * S.scale;
    const color = ui.clsColor(S.proj.labels, S.cls);
    ctx2d.setLineDash([5, 3]);
    ctx2d.lineWidth = 1.6;
    ctx2d.strokeStyle = color;
    ctx2d.strokeRect(x, y, w, h);
    ctx2d.setLineDash([]);
    ctx2d.fillStyle = hexA(color, 0.12);
    ctx2d.fillRect(x, y, w, h);
    ctx2d.font = '600 11px monospace';
    ctx2d.fillStyle = '#fff';
    ctx2d.fillText(`${Math.round(w / S.scale)} × ${Math.round(h / S.scale)}`,
      x + 3, Math.max(11, y - 4));
  }

  function hexA(hex, a) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ------------------------------------------------------------ 命中测试
  function hitRectHandle(l, ix, iy) {
    const tol = (HANDLE + 3) / S.scale;
    const near = (a, b) => Math.abs(a - b) <= tol;
    const [x1, y1, x2, y2] = bboxOf(l);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (near(ix, x1) && near(iy, y1)) return 'nw';
    if (near(ix, cx) && near(iy, y1)) return 'n';
    if (near(ix, x2) && near(iy, y1)) return 'ne';
    if (near(ix, x2) && near(iy, cy)) return 'e';
    if (near(ix, x2) && near(iy, y2)) return 'se';
    if (near(ix, cx) && near(iy, y2)) return 's';
    if (near(ix, x1) && near(iy, y2)) return 'sw';
    if (near(ix, x1) && near(iy, cy)) return 'w';
    return null;
  }

  function hitVertex(l, ix, iy) {
    if (l.geom_type !== 'polygon' && l.geom_type !== 'line') return -1;
    const tol = (HANDLE + 3) / S.scale;
    for (let i = 0; i < l.geom.length; i++) {
      if (Math.abs(l.geom[i][0] - ix) <= tol && Math.abs(l.geom[i][1] - iy) <= tol) return i;
    }
    return -1;
  }

  function pointInPoly(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function hitLabel(ix, iy) {
    const tol = 7 / S.scale;
    for (let i = S.labels.length - 1; i >= 0; i--) {
      const l = S.labels[i];
      if (l.geom_type === 'classify') continue;
      if (l.geom_type === 'rect') {
        const [x1, y1, x2, y2] = bboxOf(l);
        if (ix >= x1 && ix <= x2 && iy >= y1 && iy <= y2) return i;
      } else if (l.geom_type === 'point') {
        if (Math.hypot(ix - l.geom[0], iy - l.geom[1]) <= tol) return i;
      } else if (l.geom_type === 'polygon') {
        if (pointInPoly(ix, iy, l.geom)) return i;
      } else if (l.geom_type === 'line') {
        for (let k = 0; k < l.geom.length - 1; k++) {
          if (distSeg(ix, iy, l.geom[k][0], l.geom[k][1],
            l.geom[k + 1][0], l.geom[k + 1][1]) <= tol) return i;
        }
      }
    }
    return -1;
  }

  // ------------------------------------------------------------ 鼠标
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  on(canvas, 'mousedown', (e) => {
    if (!S.img) return;
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.ox, oy: S.oy };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    if (e.detail > 1) return;   // 双击的第二下不再加点，否则收尾时多一个重复顶点
    const p = pos(e);
    const ip = toImg(p.x, p.y);
    const ix = clampX(ip.x), iy = clampY(ip.y);

    // 画多边形/折线的过程中：单击加点，靠回起点则闭合
    if (S.draft) {
      if (S.draft.geom_type === 'polygon' && S.draft.pts.length >= 3) {
        const first = toScreen(S.draft.pts[0][0], S.draft.pts[0][1]);
        if (Math.hypot(first.x - p.x, first.y - p.y) <= 9) { finishDraft(); return; }
      }
      S.draft.pts.push([round2(ix), round2(iy)]);
      updateHint();
      requestDraw();
      return;
    }

    // 已有对象的手柄优先
    if (S.sel >= 0) {
      const l = S.labels[S.sel];
      if (l && l.geom_type === 'rect') {
        const h = hitRectHandle(l, ip.x, ip.y);
        if (h) {
          S.drag = {
            type: 'resize', handle: h, ix: ip.x, iy: ip.y,
            orig: bboxOf(l), moved: false,
          };
          pushUndo();
          return;
        }
      } else if (l && (l.geom_type === 'polygon' || l.geom_type === 'line')) {
        const vi = hitVertex(l, ip.x, ip.y);
        if (vi >= 0) {
          S.drag = { type: 'vertex', vi, moved: false };
          pushUndo();
          return;
        }
      }
    }

    const idx = hitLabel(ip.x, ip.y);

    if (S.tool === 'select') {
      if (idx >= 0) {
        S.sel = idx;
        S.drag = { type: 'move', ix: ip.x, iy: ip.y, moved: false };
        pushUndo();
        renderBoxList(); requestDraw();
      } else {
        S.sel = -1;
        S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: S.ox, oy: S.oy };
        renderBoxList(); requestDraw();
      }
      return;
    }

    // 画点：单击即落点
    if (S.tool === 'point') {
      pushUndo();
      S.labels.push({
        cls: S.cls, geom_type: 'point', geom: [round2(ix), round2(iy)],
        conf: null, source: 'human',
      });
      S.sel = S.labels.length - 1;
      markDirty(); renderBoxList(); requestDraw();
      return;
    }

    // 多边形/折线：起笔
    if (S.tool === 'polygon' || S.tool === 'line') {
      S.draft = { geom_type: S.tool, pts: [[round2(ix), round2(iy)]], cursor: null };
      if (S.sel >= 0) { S.sel = -1; renderBoxList(); }
      updateHint(); requestDraw();
      return;
    }

    // 画笔：按住拖动，松手自动闭合成多边形
    if (S.tool === 'brush') {
      S.draft = { geom_type: 'polygon', brush: true, pts: [[round2(ix), round2(iy)]], cursor: null };
      S.drag = { type: 'brush' };
      if (S.sel >= 0) { S.sel = -1; renderBoxList(); }
      updateHint(); requestDraw();
      return;
    }

    // 拉矩形：点在已有对象上是移动，空白处是新建
    if (idx >= 0) {
      S.sel = idx;
      S.drag = { type: 'move', ix: ip.x, iy: ip.y, moved: false };
      pushUndo();
      renderBoxList(); requestDraw();
      return;
    }
    S.sel = -1;
    S.drag = {
      type: 'create',
      cur: { x0: ix, y0: iy, x1: ix, y1: iy },
    };
    renderBoxList();
    requestDraw();
  });

  on(window, 'mousemove', (e) => {
    const p = pos(e);
    const ip = toImg(p.x, p.y);

    if (S.draft) {
      S.draft.cursor = [clampX(ip.x), clampY(ip.y)];
      // 画笔：拖动过程中按 4 像素抽稀记录轨迹，松手后闭合成多边形
      if (S.draft.brush && S.drag && S.drag.type === 'brush') {
        const last = S.draft.pts[S.draft.pts.length - 1];
        if (!last || Math.hypot(ip.x - last[0], ip.y - last[1]) >= 4) {
          if (S.draft.pts.length < 600) S.draft.pts.push([round2(clampX(ip.x)), round2(clampY(ip.y))]);
        }
      }
      requestDraw();
      return;
    }

    if (!S.drag) {
      if (!S.img) return;
      if (S.sel >= 0) {
        const l = S.labels[S.sel];
        if (l && l.geom_type === 'rect') {
          const h = hitRectHandle(l, ip.x, ip.y);
          if (h) {
            canvas.style.cursor = ({ nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize',
              sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' })[h];
            return;
          }
        }
      }
      const idx = hitLabel(ip.x, ip.y);
      if (idx !== S.hover) { S.hover = idx; requestDraw(); }
      canvas.style.cursor = spaceDown ? 'grab'
        : idx >= 0 ? 'move'
          : S.tool === 'select' ? 'default' : 'crosshair';
      return;
    }

    if (S.drag.type === 'pan') {
      S.ox = S.drag.ox + (e.clientX - S.drag.sx);
      S.oy = S.drag.oy + (e.clientY - S.drag.sy);
      requestDraw();
      return;
    }

    if (S.drag.type === 'create') {
      S.drag.cur.x1 = clampX(ip.x);
      S.drag.cur.y1 = clampY(ip.y);
      requestDraw();
      return;
    }

    const l = S.labels[S.sel];
    if (!l) return;
    const dx = ip.x - S.drag.ix;
    const dy = ip.y - S.drag.iy;

    if (S.drag.type === 'move') {
      if (!S.drag.moved && Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) return;
      if (!S.drag.moved) S.drag.orig = cloneGeom(l);
      S.drag.moved = true;
      moveTo(l, S.drag.orig, dx, dy);
      markDirty(); requestDraw(); return;
    }

    if (S.drag.type === 'resize') {
      const o = S.drag.orig;   // [x1,y1,x2,y2]
      let [x1, y1, x2, y2] = o;
      const h = S.drag.handle;
      if (h.includes('w')) x1 = clamp(o[0] + dx, 0, o[2] - MIN_BOX);
      if (h.includes('e')) x2 = clamp(o[2] + dx, o[0] + MIN_BOX, S.image.width);
      if (h.includes('n')) y1 = clamp(o[1] + dy, 0, o[3] - MIN_BOX);
      if (h.includes('s')) y2 = clamp(o[3] + dy, o[1] + MIN_BOX, S.image.height);
      l.geom = [x1, y1, x2, y2];
      S.drag.moved = true;
      markDirty(); requestDraw();
      return;
    }

    if (S.drag.type === 'vertex') {
      const vi = S.drag.vi;
      l.geom[vi] = [round2(clampX(ip.x)), round2(clampY(ip.y))];
      S.drag.moved = true;
      markDirty(); requestDraw();
    }
  });

  on(window, 'mouseup', () => {
    if (!S.drag) return;
    const d = S.drag;
    S.drag = null;
    canvas.style.cursor = S.tool === 'select' ? 'default' : 'crosshair';
    if (d.type === 'brush') {
      finishDraft();
      requestDraw();
      return;
    }
    if (d.type === 'create') {
      const c = d.cur;
      const x1 = Math.min(c.x0, c.x1), y1 = Math.min(c.y0, c.y1);
      const x2 = Math.max(c.x0, c.x1), y2 = Math.max(c.y0, c.y1);
      if (x2 - x1 >= MIN_BOX && y2 - y1 >= MIN_BOX) {
        pushUndo();
        S.labels.push({
          cls: S.cls, geom_type: 'rect',
          geom: [round2(x1), round2(y1), round2(x2), round2(y2)],
          conf: null, source: 'human',
        });
        S.sel = S.labels.length - 1;
        markDirty();
        renderBoxList();
      }
    } else if ((d.type === 'move' || d.type === 'resize' || d.type === 'vertex') && !d.moved) {
      undoStackPopIfNoop();
    }
    requestDraw();
  });

  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    const p = pos(e);
    zoomAt(p.x, p.y, e.deltaY < 0 ? 1.14 : 1 / 1.14);
  }, { passive: false });

  on(canvas, 'dblclick', (e) => {
    if (S.draft) { finishDraft(); return; }
    const p = pos(e);
    const ip = toImg(p.x, p.y);
    const idx = hitLabel(ip.x, ip.y);
    if (idx >= 0) { S.sel = idx; openLabelEditor(idx); }
  });

  function cloneGeom(l) {
    if (l.geom_type === 'rect') return bboxOf(l).slice();
    return l.geom.map((p) => [p[0], p[1]]);
  }

  function moveTo(l, orig, dx, dy) {
    if (l.geom_type === 'rect') {
      const w = orig[2] - orig[0], h = orig[3] - orig[1];
      const nx = clamp(orig[0] + dx, 0, S.image.width - w);
      const ny = clamp(orig[1] + dy, 0, S.image.height - h);
      l.geom = [nx, ny, nx + w, ny + h];
      return;
    }
    // 整块平移：先按最远可移动量夹一次，避免变形
    let minDx = -Infinity, maxDx = Infinity, minDy = -Infinity, maxDy = Infinity;
    orig.forEach((p) => {
      minDx = Math.max(minDx, -p[0]);
      maxDx = Math.min(maxDx, S.image.width - p[0]);
      minDy = Math.max(minDy, -p[1]);
      maxDy = Math.min(maxDy, S.image.height - p[1]);
    });
    const ddx = Math.max(minDx, Math.min(maxDx, dx));
    const ddy = Math.max(minDy, Math.min(maxDy, dy));
    l.geom = orig.map((p) => [round2(p[0] + ddx), round2(p[1] + ddy)]);
  }

  function clampX(v) { return clamp(v, 0, S.image ? S.image.width : 0); }
  function clampY(v) { return clamp(v, 0, S.image ? S.image.height : 0); }

  // ------------------------------------------------------------ 草稿收尾
  function finishDraft() {
    const d = S.draft;
    S.draft = null;
    if (!d) return;
    // 去掉连续重合点：双击收尾时容易多出一个位置相同的顶点
    const pts = d.pts.filter((p, i, arr) => i === 0
      || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.5);
    const need = d.geom_type === 'polygon' ? 3 : 2;
    if (pts.length < need) {
      ui.toast(d.geom_type === 'polygon' ? '多边形至少要 3 个点' : '折线至少要 2 个点', '', 2200);
      updateHint(); requestDraw();
      return;
    }
    pushUndo();
    S.labels.push({
      cls: S.cls, geom_type: d.geom_type, geom: pts,
      conf: null, source: 'human',
    });
    S.sel = S.labels.length - 1;
    markDirty();
    renderBoxList();
    updateHint();
    requestDraw();
  }

  function cancelDraft() {
    S.draft = null;
    updateHint();
    requestDraw();
  }

  // ------------------------------------------------------------ 撤销
  function snapshot() {
    return JSON.stringify(S.labels.map((l) => [l.cls, l.geom_type, l.geom, l.source, l.conf]));
  }
  function pushUndo() {
    S.undo.push(snapshot());
    if (S.undo.length > 60) S.undo.shift();
    S.redo = [];
  }
  function undoStackPopIfNoop() {
    if (S.undo.length) {
      const last = S.undo[S.undo.length - 1];
      if (last === snapshot()) S.undo.pop();
    }
  }
  function restore(json) {
    S.labels = JSON.parse(json).map((a) => ({
      cls: a[0], geom_type: a[1], geom: a[2], source: a[3], conf: a[4],
    }));
    if (S.sel >= S.labels.length) S.sel = -1;
    markDirty();
    renderBoxList();
    requestDraw();
  }
  function doUndo() {
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    restore(S.undo.pop());
  }
  function doRedo() {
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    restore(S.redo.pop());
  }

  // ------------------------------------------------------------ 侧栏
  function drawClsList() {
    const el = $('#clist');
    const labels = S.proj.labels || [];
    if (isClassify) {
      // 整图分类：一图一类，点一下就是这张图的类别
      const cur = S.labels.find((l) => l.geom_type === 'classify');
      el.className = 'cls-grid';
      el.innerHTML = labels.map((c, i) => `
        <button class="cls-btn ${cur && cur.cls === c ? 'on' : ''}" data-cls="${ui.esc(c)}">
          <span class="label-swatch" style="background:${ui.clsColor(labels, c)}"></span>
          <span>${ui.esc(c)}</span><span class="k">${i + 1}</span>
        </button>`).join('');
      el.querySelectorAll('[data-cls]').forEach((b) => {
        b.onclick = () => setClassify(b.dataset.cls);
      });
      return;
    }
    el.className = 'label-list';
    el.innerHTML = labels.map((c, i) => `
      <div class="label-row ${c === S.cls ? 'sel' : ''}" data-cls="${ui.esc(c)}">
        <span class="label-swatch" style="background:${ui.clsColor(labels, c)}"></span>
        <span>${ui.esc(c)}</span>
        <span class="label-key">${i + 1}</span>
      </div>`).join('');
    el.querySelectorAll('[data-cls]').forEach((r) => {
      r.onclick = () => setCls(r.dataset.cls);
    });
  }

  function setCls(c) {
    S.cls = c;
    drawClsList();
    if (S.sel >= 0 && S.labels[S.sel].cls !== c) {
      pushUndo();
      S.labels[S.sel].cls = c;
      markDirty();
      renderBoxList(); requestDraw();
    }
  }

  function setClassify(c) {
    pushUndo();
    S.labels = S.labels.filter((l) => l.geom_type !== 'classify');
    S.labels.push({ cls: c, geom_type: 'classify', geom: [], conf: null, source: 'human' });
    S.sel = -1;
    markDirty();
    drawClsList(); renderBoxList();
    ui.toast(`这张图记为「${c}」，记得保存`, '', 1600);
  }

  function renderBoxList() {
    const el = $('#blist');
    const n = S.labels.length;
    $('#boxcount').textContent = n ? `${n} 个` : '空';
    if (!n) {
      el.innerHTML = isClassify
        ? '<div class="hint" style="padding:6px 2px">上面点一个类别，就算标完这张图。</div>'
        : `<div class="hint" style="padding:6px 2px">还没有标注。左侧选工具后在图上画，
          或点上方「预标注」让模型先给一版。</div>`;
      return;
    }
    el.innerHTML = S.labels.map((l, i) => {
      const color = ui.clsColor(S.proj.labels, l.cls);
      const size = l.geom_type === 'rect' ? labelSize(l).join('×')
        : l.geom_type === 'point' ? `${Math.round(l.geom[0])},${Math.round(l.geom[1])}`
          : l.geom_type === 'classify' ? '整图'
            : `${l.geom.length} 点`;
      return `<div class="box-row ${i === S.sel ? 'sel' : ''}" data-b="${i}">
        <span class="label-swatch" style="background:${color}"></span>
        <span>${ui.esc(l.cls)}</span>
        <span class="tag tag-gray" style="height:15px;font-size:9.5px;padding:0 4px">${GT_NAME[l.geom_type] || l.geom_type}</span>
        ${l.source !== 'human' ? '<span class="tag tag-blue" style="height:15px;font-size:9.5px;padding:0 4px">AI</span>' : ''}
        <span class="bsz">${size}</span>
        <span class="del" data-del="${i}">${ui.icon('x', 12)}</span>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-b]').forEach((r) => {
      r.onclick = (e) => {
        if (e.target.dataset.del !== undefined) return;
        S.sel = Number(r.dataset.b);
        renderBoxList(); requestDraw();
        focusLabel(S.sel);
      };
    });
    el.querySelectorAll('[data-del]').forEach((d) => {
      d.onclick = (e) => {
        e.stopPropagation();
        deleteLabel(Number(d.dataset.del));
      };
    });
  }

  function focusLabel(i) {
    const l = S.labels[i];
    if (!l) return;
    const cw = canvas.width / dpr, ch = canvas.height / dpr;
    const b = bboxOf(l);
    const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
    const sx = S.ox + bx * S.scale, sy = S.oy + by * S.scale;
    if (sx < 0 || sy < 0 || sx > cw || sy > ch) {
      S.ox = cw / 2 - bx * S.scale;
      S.oy = ch / 2 - by * S.scale;
      requestDraw();
    }
  }

  function deleteLabel(i) {
    if (i < 0 || i >= S.labels.length) return;
    pushUndo();
    S.labels.splice(i, 1);
    if (S.sel >= S.labels.length) S.sel = S.labels.length - 1;
    markDirty();
    drawClsList();
    renderBoxList(); requestDraw();
  }

  function openLabelEditor(i) {
    const l = S.labels[i];
    if (!l) return;
    const labels = S.proj.labels || [];
    const clsSel = `<div class="field"><label>类别</label>
        <select class="select" id="eb-c">${labels.map((c) => `<option ${c === l.cls ? 'selected' : ''}>${ui.esc(c)}</option>`).join('')}</select></div>`;

    if (l.geom_type === 'point') {
      ui.openModal({
        title: '编辑点',
        body: `${clsSel}
          <div class="row" style="gap:8px">
            <div class="field grow"><label>x</label><input class="input" id="eb-x" type="number" value="${round2(l.geom[0])}"></div>
            <div class="field grow"><label>y</label><input class="input" id="eb-y" type="number" value="${round2(l.geom[1])}"></div>
          </div>`,
        actions: [
          { label: '删除', danger: true, onClick: (close) => { close(); deleteLabel(i); } },
          {
            label: '保存', primary: true, onClick: (close, b) => {
              pushUndo();
              l.cls = b.querySelector('#eb-c').value;
              l.geom = [clamp(+b.querySelector('#eb-x').value, 0, S.image.width),
                clamp(+b.querySelector('#eb-y').value, 0, S.image.height)];
              markDirty(); renderBoxList(); requestDraw(); close();
            },
          },
        ],
      });
      return;
    }

    if (l.geom_type === 'rect') {
      const [x1, y1, x2, y2] = bboxOf(l);
      ui.openModal({
        title: '编辑矩形框',
        body: `${clsSel}
          <div class="row" style="gap:8px">
            <div class="field grow"><label>x1</label><input class="input" id="eb-x1" type="number" value="${round2(x1)}"></div>
            <div class="field grow"><label>y1</label><input class="input" id="eb-y1" type="number" value="${round2(y1)}"></div>
          </div>
          <div class="row" style="gap:8px">
            <div class="field grow"><label>x2</label><input class="input" id="eb-x2" type="number" value="${round2(x2)}"></div>
            <div class="field grow"><label>y2</label><input class="input" id="eb-y2" type="number" value="${round2(y2)}"></div>
          </div>`,
        actions: [
          { label: '删除', danger: true, onClick: (close) => { close(); deleteLabel(i); } },
          {
            label: '保存', primary: true, onClick: (close, b) => {
              pushUndo();
              l.cls = b.querySelector('#eb-c').value;
              let a = clamp(+b.querySelector('#eb-x1').value, 0, S.image.width);
              let bb = clamp(+b.querySelector('#eb-y1').value, 0, S.image.height);
              let c = clamp(+b.querySelector('#eb-x2').value, 0, S.image.width);
              let d = clamp(+b.querySelector('#eb-y2').value, 0, S.image.height);
              if (c < a) [a, c] = [c, a];
              if (d < bb) [bb, d] = [d, bb];
              l.geom = [a, bb, c, d];
              markDirty(); renderBoxList(); requestDraw(); close();
            },
          },
        ],
      });
      return;
    }

    // 多边形 / 折线：只改类别，顶点在画布上拖
    ui.openModal({
      title: `编辑${GT_NAME[l.geom_type]}`,
      body: `${clsSel}
        <div class="hint">共 ${l.geom.length} 个顶点。要改形状，选中后直接拖图上的白点。</div>`,
      actions: [
        { label: '删除', danger: true, onClick: (close) => { close(); deleteLabel(i); } },
        {
          label: '保存', primary: true, onClick: (close, b) => {
            pushUndo();
            l.cls = b.querySelector('#eb-c').value;
            markDirty(); renderBoxList(); requestDraw(); close();
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------ 顶栏状态
  function updateTopbar() {
    const idx = S.list.findIndex((x) => x.id === S.imageId);
    const n = S.listTotal || S.list.length;
    const posEl = $('#pos');
    if (!S.imageId || !S.image) {
      posEl.textContent = '—';
      posEl.removeAttribute('title');
    } else {
      const nm = fileName(S.image);
      posEl.textContent = `${nm} · ${idx >= 0 ? idx + 1 : '?'}/${n}`;
      posEl.title = `#${S.image.id} ${nm}`;
      posEl.style.maxWidth = '260px';
      posEl.style.overflow = 'hidden';
      posEl.style.textOverflow = 'ellipsis';
      posEl.style.whiteSpace = 'nowrap';
    }
    const st = S.image ? (ui.STATUS[S.image.status] || ui.STATUS.todo) : null;
    $('#state-dot').innerHTML = st
      ? `<span class="tag ${st.tag}"><span class="dot" style="background:${st.color}"></span>${st.label}</span>`
      : '';
    updateSaveInfo();
  }

  function updateSaveInfo() {
    const el = $('#saveinfo');
    if (S.saving) { el.textContent = '保存中…'; return; }
    if (S.dirty) { el.innerHTML = '<span style="color:var(--warn)">有未保存修改</span>'; return; }
    el.textContent = S.savedAt ? `已保存 ${S.savedAt}` : '';
  }

  function updateInfo() {
    if (!S.image) { $('#imginfo').textContent = ''; return; }
    const l = S.labels;
    const ai = l.filter((x) => x.source !== 'human').length;
    const byType = {};
    l.forEach((x) => { byType[x.geom_type] = (byType[x.geom_type] || 0) + 1; });
    $('#imginfo').innerHTML = `
      <div style="word-break:break-all">文件 <b>${ui.esc(fileName(S.image))}</b></div>
      <div>编号 <b class="num">#${S.image.id}</b></div>
      <div>尺寸 <b class="num">${S.image.width}×${S.image.height}</b></div>
      <div>标注 <b class="num">${l.length}</b>（人工 ${l.length - ai}，AI ${ai}）</div>
      ${Object.keys(byType).length ? `<div>构成 ${Object.entries(byType)
        .map(([k, v]) => `${GT_NAME[k] || k} ${v}`).join('，')}</div>` : ''}
      <div>分组 <b>${ui.esc(batchName(S.image.batch_id))}</b></div>
      <div style="word-break:break-all">来源 ${ui.esc(S.image.src_image || '—')}</div>
      ${S.image.src_x != null ? `<div>偏移 <b class="num">(${S.image.src_x}, ${S.image.src_y})</b></div>` : ''}`;
  }

  function markDirty() {
    S.dirty = true;
    updateSaveInfo();
    updateInfo();
    scheduleAutosave();
  }

  function scheduleAutosave() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { if (S.dirty) save(false); }, AUTOSAVE_MS);
  }

  // ------------------------------------------------------------ 保存
  function payload() {
    return S.labels.map((l) => ({
      cls: l.cls, geom_type: l.geom_type, geom: l.geom,
      conf: l.conf, source: l.source,
    }));
  }

  async function save(complete) {
    if (!S.imageId) return false;
    if (S.saving) return false;
    S.saving = true; updateSaveInfo();
    try {
      const r = await put(`/api/images/${S.imageId}/labels`, {
        labels: payload(),
        version: S.version,
        complete: !!complete,
      });
      S.version = r.version;
      S.dirty = false;
      S.savedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      if (S.image) { S.image.status = r.status; S.image.n_labels = r.n_labels; }
      const it = S.list.find((x) => x.id === S.imageId);
      if (it) { it.status = r.status; it.n_labels = r.n_labels; }
      updateTopbar();
      updateFilmRow(it || S.image);
      updateInfo();
      return true;
    } catch (e) {
      if (e.status === 409) {
        ui.toast('这张图已被更新，正在重新加载', 'err');
        S.labels = [];
        const d = await get(`/api/images/${S.imageId}`);
        S.labels = (d.labels || []).map(normLabel);
        S.version = d.image.version;
        S.dirty = false;
        renderBoxList(); drawClsList(); requestDraw();
        return false;
      }
      ui.toast('保存失败：' + e.message, 'err', 5000);
      return false;
    } finally {
      S.saving = false;
      updateSaveInfo();
    }
  }

  // ------------------------------------------------------------ 锁
  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(async () => {
      if (!S.imageId) return;
      try { await post(`/api/images/${S.imageId}/heartbeat`, {}); }
      catch (e) { ui.toast('锁已失效：' + e.message, 'err', 5000); }
    }, 30000);
  }
  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }
  async function releaseLock() {
    stopHeartbeat();
    if (!S.imageId) return;
    const id = S.imageId;
    S.imageId = null;
    try { await del(`/api/images/${id}/lock`); } catch { /* 已释放 */ }
  }

  // ------------------------------------------------------------ 操作
  async function completeAndNext() {
    if (!S.imageId) return;
    if (S.draft) finishDraft();
    const ok = await save(true);
    if (!ok) return;
    ui.toast('已完成', 'ok', 1200);
    const nx = await get(`/api/projects/${projectId}/next?after=${S.image.id}&mode=todo`);
    if (nx.image_id && nx.image_id !== S.image.id) {
      S.imageId = null;
      await openImage(nx.image_id, false);
    } else {
      S.imageId = null;
      stopHeartbeat();
      ui.toast('当前范围都标完了', 'ok', 3000);
      markActiveRow();
      updateTopbar();
    }
  }

  $('#done').onclick = completeAndNext;

  $('#skip').onclick = async () => {
    if (!S.imageId) return;
    if (S.dirty) { if (!await save(false)) return; }
    const id = S.imageId;
    await post(`/api/images/${id}/skip`, {});
    ui.toast('已跳过', '', 1200);
    S.imageId = null;
    const nx = await get(`/api/projects/${projectId}/next?after=${id}&mode=todo`);
    if (nx.image_id) await openImage(nx.image_id, false);
  };

  $('#back').onclick = async () => {
    if (S.dirty) {
      const r = await ui.confirmBox('有未保存的修改，先保存再离开？', { okLabel: '保存并离开' });
      if (r) await save(false);
    }
    await releaseLock();
    navigate(`/project/${projectId}`);
  };

  // 标注说明：只讲当前项目用得上的工具与规则，不把所有内容堆进全局帮助
  $('#helpbtn').onclick = () => {
    const tools = (S.proj.geom_types || []).filter((g) => g !== 'classify');
    const TOOL_ROW = {
      rect: ['W', '矩形框', '按下拖出矩形；拖八个手柄改大小'],
      polygon: ['P', '多边形', '依次单击加顶点，回到起点或双击闭合'],
      line: ['L', '折线', '依次单击加折点，双击结束'],
      point: ['K', '关键点', '单击落一个点'],
      brush: ['B', '画笔', '按住拖出自由轮廓，松手自动闭合成多边形'],
    };
    const rows = tools.map((g) => TOOL_ROW[g]).filter(Boolean);
    ui.openModal({
      title: '标注说明',
      wide: true,
      body: `
        <div class="help-list">
          <p><b>这个项目：</b>${ui.esc(S.proj.task_label || S.proj.task_type)}
            ${isClassify ? '，每张图只需选一个类别' : `，可用工具 ${rows.map((r) => r[1]).join('、')}`}。
            类别共 ${(S.proj.labels || []).length} 个，从右侧列表或数字键选择。</p>
          ${isClassify ? '' : `
          <p style="margin-top:12px"><b>画法</b></p>
          <table class="table" style="font-size:12.5px;margin-top:4px">
            ${rows.map((r) => `<tr>
              <td style="width:150px"><span class="kbd">${r[0]}</span> ${r[1]}</td>
              <td>${r[2]}</td></tr>`).join('')}
            <tr><td><span class="kbd">V</span> 选择</td><td>点选、整体拖动；拖顶点改形状</td></tr>
          </table>`}
          <p style="margin-top:14px"><b>常用快捷键</b></p>
          <div class="help-cols" style="margin-top:4px">
            <div><span class="kbd">A</span><span class="kbd">D</span> 上一张 / 下一张</div>
            <div><span class="kbd">1</span>–<span class="kbd">9</span> 切换类别</div>
            <div><span class="kbd">Del</span> 删除选中标注（画多边形时删上一个点）</div>
            <div><span class="kbd">Esc</span> 取消当前绘制 / 取消选中</div>
            <div><span class="kbd">Ctrl</span>+<span class="kbd">S</span> 保存（不释放锁）</div>
            <div><span class="kbd">Ctrl</span>+<span class="kbd">Z</span> 撤销，<span class="kbd">Ctrl</span>+<span class="kbd">Shift</span>+<span class="kbd">Z</span> 重做</div>
            <div><span class="kbd">Ctrl</span>+<span class="kbd">D</span> 复制选中标注</div>
            <div>方向键 微调 1 像素，按住 <span class="kbd">Shift</span> 为 10 像素</div>
            <div><span class="kbd">Enter</span> 完成并进入下一张</div>
            <div>滚轮缩放，空格 + 拖动平移</div>
            <div>双击标注 改类别与坐标</div>
            <div>双击空白 结束当前多边形 / 折线</div>
          </div>
          <p style="margin-top:14px"><b>标注规则</b></p>
          <div class="help-list" style="margin-top:2px">
            <div>· 只标<b>完整可见</b>的目标；被图像边缘截断超过一半的不标。</div>
            <div>· 框要贴紧目标外轮廓，不要留大片空白，也不要切掉目标。</div>
            <div>· 同一目标只标一次；重叠目标各自成框，不要合并。</div>
            <div>· 拿不准的图点「跳过」，留给别人复核，不要硬标。</div>
            <div>· 换图会自动保存；离开前确认右上角没有「有未保存修改」。</div>
          </div>
        </div>`,
      actions: [{ label: '知道了', primary: true }],
    });
  };

  // 预标注（单张）
  $('#prelabel').onclick = async () => {
    if (!S.imageId) return;
    if (!S.model) return ui.toast('还没有可用模型，去「模型库」上传', 'err');
    const btn = $('#prelabel');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin dark"></span> 推理中';
    try {
      const r = await post(`/api/images/${S.imageId}/prelabel`, {
        conf: S.conf, iou: S.iou, model_id: S.model.id,
      });
      const preds = r.predictions || [];
      if (!preds.length) {
        ui.toast('模型没有给出结果，可降低置信度再试', '', 3200);
      } else if (S.labels.length === 0) {
        applyPreds(preds, 'replace');
        ui.toast(`模型给出 ${preds.length} 个结果`, 'ok');
      } else {
        const choice = await askMerge(preds.length);
        if (choice) applyPreds(preds, choice);
      }
    } catch (e) {
      ui.toast(e.message, 'err', 5000);
    }
    btn.disabled = false;
    btn.innerHTML = `${ui.icon('wand', 14)} 预标注`;
  };

  function askMerge(n) {
    let resolveFn;
    const p = new Promise((res) => { resolveFn = res; });
    const m = ui.openModal({
      title: `模型给出 ${n} 个结果`,
      body: `<div style="font-size:13px;line-height:1.8;color:var(--text-2)">
        当前这张图已有 ${S.labels.length} 个标注。要替换掉，还是把模型结果追加进来？</div>`,
      actions: [
        { label: '取消', onClick: () => { m.close(); resolveFn(null); } },
        { label: '追加', onClick: () => { m.close(); resolveFn('append'); } },
        { label: '替换', primary: true, onClick: () => { m.close(); resolveFn('replace'); } },
      ],
    });
    return p;
  }

  function applyPreds(preds, mode) {
    pushUndo();
    const mapped = preds.map((p) => ({
      cls: p.cls,
      geom_type: p.geom_type || 'rect',
      geom: p.geom && p.geom.length ? p.geom
        : p.geom_type === 'classify' ? []
          : [p.x1, p.y1, p.x2, p.y2],
      conf: p.conf, source: 'model',
    }));
    S.labels = mode === 'replace' ? mapped : S.labels.concat(mapped);
    markDirty();
    renderBoxList(); drawClsList(); requestDraw();
  }

  $('#conf').oninput = (e) => {
    S.conf = Number(e.target.value);
    $('#confv').textContent = S.conf.toFixed(2);
  };

  // ------------------------------------------------------------ 快捷键
  function typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
      || t.tagName === 'SELECT' || t.isContentEditable);
  }

  on(window, 'keydown', (e) => {
    if (typing(e)) return;
    const meta = e.ctrlKey || e.metaKey;

    if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.dirty) save(false); return; }
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    if (meta && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (S.sel >= 0) {
        const l = S.labels[S.sel];
        pushUndo();
        const off = 6;
        const geom = l.geom_type === 'rect'
          ? [l.geom[0] + off, l.geom[1] + off, l.geom[2] + off, l.geom[3] + off]
          : l.geom_type === 'point'
            ? [l.geom[0] + off, l.geom[1] + off]
            : l.geom.map((p) => [p[0] + off, p[1] + off]);
        S.labels.push({ ...l, geom, source: 'human', conf: null });
        S.sel = S.labels.length - 1;
        markDirty(); renderBoxList(); requestDraw();
      }
      return;
    }
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); canvas.style.cursor = 'grab'; return; }

    if (e.key === 'Escape') {
      if (S.draft) { cancelDraft(); return; }
      S.sel = -1; renderBoxList(); requestDraw();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.draft) { finishDraft(); return; }
      completeAndNext();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (S.draft) {
        S.draft.pts.pop();
        if (!S.draft.pts.length) cancelDraft(); else { updateHint(); requestDraw(); }
        return;
      }
      if (S.sel >= 0) deleteLabel(S.sel);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!S.labels.length) return;
      S.sel = (S.sel + 1) % S.labels.length;
      renderBoxList(); requestDraw(); focusLabel(S.sel);
      return;
    }

    const low = e.key.toLowerCase();
    if (low === 'v') { setTool('select'); return; }
    if (low === 'w' && ALLOWED.includes('rect')) { setTool('rect'); return; }
    if (low === 'p' && ALLOWED.includes('polygon')) { setTool('polygon'); return; }
    if (low === 'l' && ALLOWED.includes('line')) { setTool('line'); return; }
    if (low === 'k' && ALLOWED.includes('point')) { setTool('point'); return; }
    if (low === 'b' && ALLOWED.includes('brush')) { setTool('brush'); return; }
    if (low === 'a') { prevImage(); return; }
    if (low === 'd') { nextImage(); return; }

    if (/^[1-9]$/.test(e.key)) {
      const labels = S.proj.labels || [];
      const i = Number(e.key) - 1;
      if (labels[i]) {
        if (isClassify) setClassify(labels[i]);
        else setCls(labels[i]);
      }
      return;
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      if (S.sel < 0) return;
      e.preventDefault();
      const l = S.labels[S.sel];
      if (l.geom_type === 'classify') return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!e.repeat) pushUndo();
      moveTo(l, cloneGeom(l), dx, dy);
      markDirty(); requestDraw();
    }
  });

  on(window, 'keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      canvas.style.cursor = S.tool === 'select' ? 'default' : 'crosshair';
    }
  });

  async function prevImage() {
    if (S.dirty) await save(false);
    const idx = S.list.findIndex((x) => x.id === S.imageId);
    if (idx > 0) await openImage(S.list[idx - 1].id, false);
    else ui.toast('已经是第一张', '', 1400);
  }
  async function nextImage() {
    if (S.dirty) await save(false);
    const idx = S.list.findIndex((x) => x.id === S.imageId);
    if (idx >= 0 && idx < S.list.length - 1) await openImage(S.list[idx + 1].id, false);
    else {
      const nx = await get(`/api/projects/${projectId}/next?after=${S.imageId}&mode=todo`);
      if (nx.image_id) await openImage(nx.image_id, false);
      else ui.toast('已经是最后一张', '', 1400);
    }
  }

  // ------------------------------------------------------------ 生命周期
  const ro = new ResizeObserver(() => resize());
  ro.observe(wrap);
  on(window, 'resize', resize);
  resize();

  const beforeUnload = (e) => {
    if (S.dirty) {
      if (S.imageId) {
        fetch(`/api/images/${S.imageId}/labels`, {
          method: 'PUT', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels: payload(), version: S.version, complete: false }),
        });
      }
      e.preventDefault();
      e.returnValue = '';
    }
  };
  on(window, 'beforeunload', beforeUnload);

  on(window, 'pagehide', () => {
    if (S.imageId) fetch(`/api/images/${S.imageId}/lock`, { method: 'DELETE', keepalive: true });
  });

  const cleanup = () => {
    stopHeartbeat();
    clearTimeout(autoTimer);
    ro.disconnect();
    ac.abort();
  };
  root._cleanup = cleanup;
  on(window, 'hashchange', () => { cleanup(); });
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round2(v) { return Math.round(v * 100) / 100; }
