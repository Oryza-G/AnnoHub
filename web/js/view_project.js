// 项目详情：概览 / 图片 / 裁切 / 导入 / 导出 / 设置
import { get, post, patch, del } from './api.js';
import * as ui from './ui.js';
import { renderCropTab } from './view_crop.js';
import { renderImportTab } from './view_import.js';
import { renderExportTab } from './view_export.js';

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'images', label: '图片' },
  { key: 'crop', label: '裁切' },
  { key: 'import', label: '导入' },
  { key: 'export', label: '导出' },
  { key: 'settings', label: '设置' },
];

export async function renderProject(page, topbar, ctx) {
  const { navigate, id } = ctx;
  const tab = ctx.tab || 'overview';
  const proj = await get(`/api/projects/${id}`);

  topbar.innerHTML = `
    <span class="crumb" data-go="/projects" style="cursor:pointer">项目</span>
    <span class="crumb">/</span>
    <h1>${ui.esc(proj.name)}</h1>
    <span class="task-chip">${ui.esc(proj.task_label || proj.task_type)}</span>
    <div class="grow"></div>
    <button class="btn" id="btn-export">${ui.icon('download', 15)} 导出</button>
    <button class="btn btn-primary" id="btn-annotate">${ui.icon('tag', 15)} 开始标注</button>`;

  topbar.querySelector('[data-go]').onclick = () => navigate('/projects');
  topbar.querySelector('#btn-annotate').onclick = () => navigate(`/project/${id}/annotate`);
  topbar.querySelector('#btn-export').onclick = () => navigate(`/project/${id}/export`);

  page.innerHTML = `
    <div class="row" style="gap:2px;border-bottom:1px solid var(--border);margin-bottom:18px" id="tabs">
      ${TABS.map((t) => `<div class="nav-item ${t.key === tab ? 'active' : ''}" data-tab="${t.key}"
        style="height:34px;padding:0 13px;margin-bottom:-1px">${t.label}</div>`).join('')}
    </div>
    <div id="tab-body"></div>`;

  page.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => navigate(`/project/${id}/${el.dataset.tab}`);
  });

  const body = page.querySelector('#tab-body');
  const reload = () => renderProject(page, topbar, { ...ctx, tab });

  if (tab === 'overview') await overview(body, proj, ctx, reload);
  else if (tab === 'images') await imagesTab(body, proj, ctx);
  else if (tab === 'crop') await renderCropTab(body, proj, ctx, reload);
  else if (tab === 'import') await renderImportTab(body, proj, ctx, reload);
  else if (tab === 'export') await renderExportTab(body, proj, ctx);
  else if (tab === 'settings') await settingsTab(body, proj, ctx, reload);
}

// ---------------------------------------------------------------- 概览

async function overview(root, proj, { navigate, id }, reload) {
  const s = await get(`/api/projects/${id}/stats`);
  const bs = s.by_status || {};
  const nLabels = (s.by_class || []).reduce((a, c) => a + c.c, 0);
  const fromModel = (s.by_class || []).reduce((a, c) => a + (c.from_model || 0), 0);
  const g = s.by_geom || {};
  const GEOM_CN = { rect: '框', polygon: '多边形', line: '折线', point: '点', classify: '整图' };

  root.innerHTML = `
    <div class="stat-row" style="margin-bottom:18px">
      ${stat('图片总数', s.total, '张')}
      ${stat('已完成', (bs.done || 0) + (bs.reviewed || 0), '张')}
      ${stat('待标注', (bs.todo || 0) + (bs.annotating || 0), '张')}
      ${stat('标注对象', nLabels, '个')}
      ${stat('模型预标', fromModel, '个')}
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>总体进度</h3>
        <span class="num" style="font-size:13px;color:var(--text-2)">${s.progress}%</span></div>
      <div class="card-body" style="padding-top:6px">
        <div class="bar" style="height:8px"><i style="width:${s.progress}%"></i></div>
        <div class="row" style="gap:18px;margin-top:12px;font-size:12px;color:var(--text-3);flex-wrap:wrap">
          ${Object.entries(ui.STATUS).map(([k, v]) => `
            <span class="row" style="gap:5px"><i class="dot" style="background:${v.color}"></i>
            ${v.label} <b class="num" style="color:var(--text-2)">${bs[k] || 0}</b></span>`).join('')}
          ${Object.keys(g).length ? `<span style="width:1px;height:12px;background:var(--border)"></span>` : ''}
          ${Object.entries(g).map(([k, v]) => `
            <span class="row" style="gap:5px">${GEOM_CN[k] || k}
            <b class="num" style="color:var(--text-2)">${v}</b></span>`).join('')}
        </div>
      </div>
    </div>

    <div class="two-col" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head"><h3>按成员</h3>
          <button class="btn btn-sm" data-assign="0">${ui.icon('userPlus', 13)} 分配任务</button></div>
        <div class="card-body" style="padding:0">
          ${(s.by_user || []).length ? `<table class="table">
            <thead><tr><th>成员</th><th class="num">已领</th><th class="num">完成</th><th style="width:64px"></th></tr></thead>
            <tbody>${s.by_user.map((u) => `<tr>
              <td>${ui.esc(u.display_name)}</td>
              <td class="num">${u.total || 0}</td>
              <td class="num">${u.done || 0}</td>
              <td style="text-align:right"><button class="btn btn-sm" data-assign="${u.id}"
                data-name="${ui.esc(u.display_name)}">分配</button></td></tr>`).join('')}</tbody>
          </table>` : `<div class="empty" style="padding:28px">
            <p style="margin-bottom:10px">还没有人领到任务</p>
            <button class="btn btn-sm" data-assign="0">分配任务</button></div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>按来源分组</h3>
          <span class="hint">裁切或导入各成一组</span></div>
        <div class="card-body" style="padding:0">
          ${(s.by_batch || []).length ? `<table class="table">
            <thead><tr><th>分组</th><th class="num">张数</th><th class="num">完成</th></tr></thead>
            <tbody>${s.by_batch.map((b) => `<tr>
              <td>${ui.esc(b.name)}
                <span class="tag tag-gray" style="margin-left:5px">${b.kind === 'import' ? '导入' : '裁切'}</span></td>
              <td class="num">${b.n_now || 0}</td>
              <td class="num">${b.done || 0}</td></tr>`).join('')}</tbody>
          </table>` : '<div class="empty" style="padding:28px">还没有分组</div>'}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>最近更新</h3></div>
      <div class="card-body" style="padding:0">
        ${(s.recent || []).length ? `<table class="table">
          <tbody>${s.recent.map((r) => `<tr>
            <td style="width:70px" class="num">#${r.id}</td>
            <td style="color:var(--text-2);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ui.esc((r.rel_path || '').split('/').pop())}</td>
            <td><span class="tag ${ui.STATUS[r.status]?.tag || 'tag-gray'}">${ui.STATUS[r.status]?.label || r.status}</span></td>
            <td style="color:var(--text-3)">${ui.esc(r.display_name || '')}</td>
            <td style="color:var(--text-3);text-align:right">${ui.relTime(r.updated_at)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:28px">还没有操作记录</div>'}
      </div>
    </div>`;

  root.querySelectorAll('[data-assign]').forEach((b) => {
    b.onclick = () => openAssign(id, proj, {
      userId: Number(b.dataset.assign) || 0,
      userName: b.dataset.name || '',
      onDone: reload,
    });
  });
}

// 派活：选成员 → 选分组 → 张数。只挑自己、或交给别人（管理员）。
function openAssign(pid, proj, { userId = 0, userName = '', onDone } = {}) {
  Promise.all([get('/api/users'), get(`/api/projects/${pid}/groups`)]).then(([ud, gd]) => {
    const users = (ud.users || []).filter((u) => u.active !== 0);
    const groups = gd.groups || [];
    if (!users.length) return ui.toast('还没有可用成员', 'err');
    const me = users.find((u) => u.id === userId);
    ui.openModal({
      title: '分配标注任务',
      body: `
        <div class="banner banner-info" style="margin-bottom:14px">${ui.icon('info', 15)}
          <div>按分组把图片指派给成员。被指派的图会出现在他的「只看我的」里，
          但不会阻止别人标注。</div></div>
        <div class="field"><label>分配给</label>
          <select class="select" id="as-user">
            ${users.map((u) => `<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>
              ${ui.esc(u.display_name)}${u.role === 'admin' ? '（管理员）' : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label>从哪个分组挑</label>
          <select class="select" id="as-batch">
            <option value="0">全部分组</option>
            ${groups.map((g) => `<option value="${g.id}">${ui.esc(g.name)}（${g.n_now} 张）</option>`).join('')}
          </select></div>
        <div class="field"><label>分配张数（0 = 该范围内全部）</label>
          <input class="input" id="as-n" type="number" value="50" min="0"></div>
        <label class="row" style="gap:7px;font-size:12.5px;margin-bottom:8px">
          <input type="checkbox" id="as-un" checked> 只挑还没分配给别人的</label>
        <label class="row" style="gap:7px;font-size:12.5px">
          <input type="checkbox" id="as-done"> 已完成/已复核的也一起分配</label>
        ${me ? '' : ''}`,
      actions: [
        { label: '取消' },
        {
          label: '开始分配', primary: true, onClick: async (close, b) => {
            const uid = Number(b.querySelector('#as-user').value);
            const r = await post(`/api/projects/${pid}/assign/batch`, {
              user_id: uid,
              batch_id: Number(b.querySelector('#as-batch').value) || null,
              n: Number(b.querySelector('#as-n').value) || 0,
              only_unassigned: b.querySelector('#as-un').checked,
              include_done: b.querySelector('#as-done').checked,
            });
            close();
            if (!r.n) return ui.toast('这个范围里没有可分派的图', 'err', 4000);
            ui.toast(`已分配 ${r.n} 张`, 'ok');
            if (onDone) onDone();
            return false;
          },
        },
      ],
    });
  }).catch((e) => ui.toast(e.message, 'err'));
}

function stat(label, value, unit) {
  return `<div class="stat"><div class="sl">${label}</div>
    <div class="sv">${value ?? 0}<span class="su">${unit}</span></div></div>`;
}

// ---------------------------------------------------------------- 图片

async function imagesTab(root, proj, { navigate, id, state }) {
  const user = state.user;
  const isAdmin = user.role === 'admin';
  let status = '';
  let batchId = '';
  let q = '';
  let hasLabels = null;
  let onlyMine = false;
  let offset = 0;
  const LIMIT = 120;
  const selected = new Set();
  let items = [];
  let groups = [];
  let totalImages = 0;
  let lastTotal = 0;

  root.innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start">
      <aside class="group-side">
        <div class="card" style="padding:8px">
          <div class="nav-label" style="padding:4px 9px 6px">来源分组</div>
          <div id="glist"></div>
        </div>
      </aside>
      <div class="grow">
        <div class="card" style="margin-bottom:14px"><div class="card-body" style="padding:12px">
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <select class="select" id="f-status" style="width:126px">
              <option value="">全部状态</option>
              ${Object.entries(ui.STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
            </select>
            <select class="select" id="f-labels" style="width:126px">
              <option value="">有无标注</option>
              <option value="1">已有标注</option>
              <option value="0">还没标注</option>
            </select>
            <input class="input" id="f-q" placeholder="搜索文件名" style="width:170px">
            <label class="row" style="gap:5px;font-size:12.5px;color:var(--text-2)">
              <input type="checkbox" id="f-mine"> 只看我的</label>
            <div class="grow"></div>
            <button class="btn btn-sm" id="batch-pre">${ui.icon('wand', 14)} 批量预标注</button>
          </div>
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:9px;padding-top:9px;
               border-top:1px dashed var(--border);display:none" id="selbar">
            <span class="hint" id="sel-info"></span>
            <div class="grow"></div>
            <button class="btn btn-sm" id="sel-pre">${ui.icon('wand', 13)} 预标注选中</button>
            <button class="btn btn-sm" id="sel-mine">分配给我</button>
            <button class="btn btn-sm" id="sel-unassign">取消分配</button>
            ${isAdmin ? '<button class="btn btn-sm btn-danger" id="sel-del">删除选中</button>' : ''}
            <button class="btn btn-sm btn-ghost" id="sel-none">取消选择</button>
          </div>
        </div></div>
        <div id="img-grid"></div>
      </div>
    </div>`;

  const grid = root.querySelector('#img-grid');
  const glist = root.querySelector('#glist');
  const selbar = root.querySelector('#selbar');
  const selInfo = root.querySelector('#sel-info');

  function drawGroups() {
    const all = `<div class="group-item ${batchId === '' ? 'on' : ''}" data-g="">
        ${ui.icon('layers', 14)}<span>全部图片</span><span class="gc">${totalImages}</span></div>`;
    glist.innerHTML = all + groups.map((g) => `
      <div class="group-item ${String(batchId) === String(g.id) ? 'on' : ''}" data-g="${g.id}" title="${ui.esc(g.source_root || '')}">
        ${ui.icon(g.kind === 'import' ? 'importIn' : 'scissors', 14)}
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ui.esc(g.name)}</span>
        <span class="gc">${g.n_now}</span>
        ${isAdmin ? `<span class="del" data-delg="${g.id}" title="删除整组"
          style="color:var(--text-3);cursor:pointer;display:flex">${ui.icon('trash', 12)}</span>` : ''}
      </div>`).join('');

    glist.querySelectorAll('[data-g]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-delg]')) return;
        batchId = el.dataset.g;
        load(true);
      });
    });
    glist.querySelectorAll('[data-delg]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteGroup(Number(el.dataset.delg));
      });
    });
  }

  async function loadGroups() {
    const d = await get(`/api/projects/${id}/groups`);
    groups = d.groups;
    totalImages = d.total;
    drawGroups();
  }

  async function load(reset) {
    if (reset) { offset = 0; items = []; }
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (batchId) params.set('batch_id', batchId);
    if (q) params.set('q', q);
    if (hasLabels !== null) params.set('has_labels', String(hasLabels));
    if (onlyMine) params.set('assignee', String(user.id));
    params.set('limit', LIMIT);
    params.set('offset', offset);
    const d = await get(`/api/projects/${id}/images?${params}`);
    items = reset ? d.items : items.concat(d.items);
    offset += d.items.length;
    lastTotal = d.total;
    draw(d.total, d.items.length === LIMIT);
    markSel();
  }

  function draw(total, more) {
    if (!items.length) {
      grid.innerHTML = `<div class="card"><div class="empty">${ui.icon('image', 32)}
        <h4>没有符合条件的图片</h4>
        <p>换个筛选条件，或者先去「裁切」「导入」把图片加进来。</p>
        <div class="row" style="justify-content:center">
          <button class="btn" id="to-crop">裁切大图</button>
          <button class="btn" id="to-import">导入图片</button>
        </div></div></div>`;
      grid.querySelector('#to-crop').onclick = () => navigate(`/project/${id}/crop`);
      grid.querySelector('#to-import').onclick = () => navigate(`/project/${id}/import`);
      return;
    }
    grid.innerHTML = `
      <div class="row-between" style="margin-bottom:10px">
        <span class="hint">共 ${total} 张，已显示 ${items.length} 张。单击选中，双击进入标注。</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:10px">
        ${items.map(imgCard).join('')}
      </div>
      ${more ? '<div style="text-align:center;margin-top:16px"><button class="btn" id="more">加载更多</button></div>' : ''}`;

    grid.querySelectorAll('[data-iid]').forEach((el) => {
      const iid = Number(el.dataset.iid);
      el.addEventListener('click', () => {
        if (selected.has(iid)) selected.delete(iid);
        else selected.add(iid);
        markSel();
      });
      el.addEventListener('dblclick', () => navigate(`/project/${id}/annotate/${iid}`));
      const dl = el.querySelector('[data-dl]');
      if (dl) dl.addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = `/api/images/${iid}/download`;
      });
    });
    const moreBtn = grid.querySelector('#more');
    if (moreBtn) moreBtn.onclick = () => load(false);
  }

  function markSel() {
    grid.querySelectorAll('[data-iid]').forEach((el) => {
      const on = selected.has(Number(el.dataset.iid));
      el.style.outline = on ? '2px solid var(--primary)' : 'none';
      el.style.outlineOffset = '1px';
    });
    selbar.style.display = selected.size ? 'flex' : 'none';
    selInfo.textContent = `已选 ${selected.size} 张`;
  }

  function imgCard(it) {
    const st = ui.STATUS[it.status] || ui.STATUS.todo;
    return `
    <div data-iid="${it.id}" style="position:relative;border:1px solid var(--border);border-radius:8px;
         overflow:hidden;cursor:pointer;background:#fff;transition:border-color .1s">
      <div style="position:relative;aspect-ratio:1;background:var(--bg-soft)">
        <img src="/api/images/${it.id}/thumb?size=280" loading="lazy"
             style="width:100%;height:100%;object-fit:cover;display:block"
             ${it.locked_by ? 'draggable="false"' : ''}>
        <span class="dot" style="position:absolute;right:6px;top:6px;box-shadow:0 0 0 2px #fff;background:${st.color}"></span>
        ${it.locked_by ? `<span class="tag" style="position:absolute;left:5px;top:5px;background:rgba(20,24,30,.72);color:#fff">
          ${ui.esc(it.locked_by)}</span>` : ''}
        ${it.prelabeled ? `<span class="tag tag-blue" style="position:absolute;left:5px;bottom:5px">AI</span>` : ''}
        <button data-dl title="下载这张" class="btn btn-sm btn-icon"
          style="position:absolute;right:4px;top:26px;height:22px;width:22px;opacity:0"
          onmouseover="this.style.opacity=1">${ui.icon('download', 12)}</button>
      </div>
      <div style="padding:5px 8px;display:flex;gap:6px;align-items:center;font-size:11px;color:var(--text-3)">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${ui.esc(it.rel_path || '')}">
          ${ui.esc((it.rel_path || '').split('/').pop())}</span>
        <span style="margin-left:auto;flex:none">${it.n_labels || 0} 条</span>
      </div>
    </div>`;
  }

  root.querySelector('#f-status').onchange = (e) => { status = e.target.value; load(true); };
  root.querySelector('#f-labels').onchange = (e) => {
    hasLabels = e.target.value === '' ? null : e.target.value === '1';
    load(true);
  };
  root.querySelector('#f-mine').onchange = (e) => { onlyMine = e.target.checked; load(true); };
  const qInput = root.querySelector('#f-q');
  let qt;
  qInput.oninput = () => {
    clearTimeout(qt);
    qt = setTimeout(() => { q = qInput.value.trim(); load(true); }, 300);
  };

  root.querySelector('#sel-mine').onclick = async () => {
    await post(`/api/projects/${id}/assign`, { image_ids: [...selected], user_id: user.id });
    ui.toast(`已把 ${selected.size} 张分配给 ${user.display_name}`, 'ok');
    selected.clear();
    load(true);
  };
  root.querySelector('#sel-unassign').onclick = async () => {
    await post(`/api/projects/${id}/assign`, { image_ids: [...selected], user_id: null });
    ui.toast('已取消分配', 'ok');
    selected.clear();
    load(true);
  };
  root.querySelector('#sel-none').onclick = () => { selected.clear(); markSel(); };
  root.querySelector('#sel-pre').onclick = () => {
    openPrelabel(id, proj, { ids: [...selected], onDone: () => { selected.clear(); load(true); } });
  };
  const selDel = root.querySelector('#sel-del');
  if (selDel) selDel.onclick = async () => {
    const n = selected.size;
    if (!await ui.confirmBox(`将删除 ${n} 张图片及其标注，磁盘文件一并删除，不能恢复。`, {
      title: '删除选中图片', okLabel: `删除 ${n} 张`, danger: true,
    })) return;
    const r = await post(`/api/projects/${id}/images/delete`, { image_ids: [...selected] });
    ui.toast(`已删除 ${r.deleted} 张${r.skipped_locked ? `，${r.skipped_locked} 张正在标注已跳过` : ''}`, 'ok');
    selected.clear();
    await loadGroups();
    load(true);
  };

  root.querySelector('#batch-pre').onclick = () => {
    openPrelabel(id, proj, { onDone: () => load(true) });
  };

  async function deleteGroup(gid) {
    const g = groups.find((x) => x.id === gid);
    if (!g) return;
    if (!await ui.confirmBox(
      `「${g.name}」这一组共 ${g.n_now} 张，删除后图片与标注一起消失，不能恢复。`,
      { title: '删除整组', okLabel: `删除 ${g.n_now} 张`, danger: true },
    )) return;
    const r = await del(`/api/projects/${id}/batch/${gid}`);
    ui.toast(`已删除 ${r.deleted} 张`, 'ok');
    if (String(batchId) === String(gid)) batchId = '';
    await loadGroups();
    load(true);
  }

  await loadGroups();
  await load(true);
}

// 预标注对话框：ids 有值时只跑这几张，没有就按筛选条件批量跑
function openPrelabel(pid, proj, { ids = null, onDone } = {}) {
  get('/api/models').then((md) => {
    if (!md.models.length) {
      return ui.toast('还没有可用模型，先去「模型库」上传 ONNX', 'err', 4200);
    }
    const usable = md.models.filter((m) =>
      !proj.task_type || m.task === proj.task_type || proj.task_type === 'mixed'
      || (m.task === 'detect' && ['detect', 'segment'].includes(proj.task_type)));
    const list = usable.length ? usable : md.models;
    const def = proj.model_id || md.active || (list[0] && list[0].id);
    const scope = ids ? `选中的 ${ids.length} 张图` : '按当前筛选条件命中的图';

    ui.openModal({
      title: ids ? `预标注选中的 ${ids.length} 张` : '批量预标注',
      body: `
        <div class="banner banner-info" style="margin-bottom:14px">
          ${ui.icon('info', 15)}
          <div>模型会跑一遍并把结果写进库里，标注员打开就能看到。已有标注的图默认跳过，不会覆盖人工结果。</div>
        </div>
        <div class="field"><label>处理范围</label>
          <div class="input" style="display:flex;align-items:center;background:var(--bg-soft);
               border-style:dashed;color:var(--text-2)">${ui.esc(scope)}</div></div>
        <div class="field"><label>使用模型</label>
          <select class="select" id="bp-model">
            ${list.map((x) => `<option value="${x.id}" ${x.id === def ? 'selected' : ''}>
              ${ui.esc(x.name)}（${ui.esc(MODEL_TASK[x.task] || x.task)}，${(x.classes || []).length} 类）</option>`).join('')}
          </select></div>
        <div class="field"><label>置信度阈值 <span class="num" id="bp-cv">0.25</span></label>
          <input type="range" id="bp-conf" min="0.05" max="0.9" step="0.05" value="0.25" style="width:100%">
          <div class="hint">低于阈值的预测不写入。密集小目标建议 0.2~0.3。</div></div>
        <label class="row" style="gap:7px;font-size:12.5px;margin-bottom:10px">
          <input type="checkbox" id="bp-only" checked> 只处理还没有任何标注的图</label>
        ${ids ? '' : `<div class="field"><label>最多处理张数（0 = 全部）</label>
          <input class="input" id="bp-limit" type="number" value="0"></div>`}`,
      actions: [
        { label: '取消' },
        {
          label: '开始', primary: true, onClick: async (close, body) => {
            const modelId = Number(body.querySelector('#bp-model').value);
            const conf = Number(body.querySelector('#bp-conf').value);
            const onlyEmpty = body.querySelector('#bp-only').checked;
            const limitEl = body.querySelector('#bp-limit');
            const limit = limitEl ? Number(limitEl.value) || 0 : 0;
            const prog = document.createElement('div');
            prog.innerHTML = `<div class="row-between" style="margin-bottom:6px">
                <span class="hint" id="bpm">提交中…</span>
                <span class="num" style="font-size:12px" id="bpp">0%</span></div>
              <div class="bar"><i id="bpb" style="width:0"></i></div>`;
            body.innerHTML = '';
            body.appendChild(prog);
            try {
              const payload = {
                model_id: modelId, conf, iou: 0.45,
                only_empty_labels: onlyEmpty,
                status_filter: ['todo', 'annotating', 'done'],
              };
              if (ids) payload.image_ids = ids;
              else payload.limit = limit;
              const r = await post(`/api/projects/${pid}/prelabel`, payload);
              const { pollJob } = await import('./api.js');
              const j = await pollJob(r.job_id, (st) => {
                const b = prog.querySelector('#bpb');
                if (!b) return;
                b.style.width = st.progress + '%';
                prog.querySelector('#bpp').textContent = Math.round(st.progress) + '%';
                prog.querySelector('#bpm').textContent = st.message || '';
              });
              if (j.status === 'done') {
                const res = j.result || {};
                prog.innerHTML = `<div class="banner banner-ok">${ui.icon('check', 15)}
                  <div>完成：${res.n_images} 张，共 ${res.n_boxes} 个标注，平均 ${res.avg_ms} ms/张</div></div>`;
                setTimeout(() => { close(); if (onDone) onDone(); }, 1500);
              } else {
                prog.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 15)}
                  <div>${ui.esc(j.message || '失败')}</div></div>`;
              }
            } catch (e) {
              prog.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 15)}
                <div>${ui.esc(e.message)}</div></div>`;
            }
            return false;
          },
        },
      ],
      onMount: (body) => {
        const c = body.querySelector('#bp-conf');
        c.oninput = () => { body.querySelector('#bp-cv').textContent = Number(c.value).toFixed(2); };
      },
    });
  }).catch((e) => ui.toast(e.message, 'err'));
}

const MODEL_TASK = { detect: '检测', segment: '分割', classify: '分类', keypoint: '关键点', obb: '旋转框' };

// ---------------------------------------------------------------- 设置

async function settingsTab(root, proj, { navigate, id, state }, reload) {
  const models = await get('/api/models');
  let nImg = 0;
  try { nImg = (await get(`/api/projects/${id}/stats`)).total || 0; } catch { /* 忽略 */ }
  const TASK_CN = { detect: '目标检测', segment: '实例分割', classify: '图像分类', mixed: '其他' };
  // 老项目可能还是关键点/旋转框这类历史类型，保留在选项里免得一改就丢
  const taskOpts = ['detect', 'segment', 'classify', 'mixed'];
  if (proj.task_type && !taskOpts.includes(proj.task_type)) taskOpts.push(proj.task_type);
  const localHost = ['127.0.0.1', 'localhost', '::1', ''].includes(location.hostname);
  const isAdmin = state.user && state.user.role === 'admin';

  root.innerHTML = `
    <div class="set-grid">
      <div class="card">
        <div class="card-head"><h3>基本信息</h3>
          <span class="tag ${proj.status === 'archived' ? 'tag-gray' : 'tag-green'}">
            ${proj.status === 'archived' ? '已归档' : '进行中'}</span></div>
        <div class="card-body">
          <div class="field"><label>项目名称</label><input class="input" id="s-name" value="${ui.esc(proj.name)}"></div>
          <div class="field"><label>项目类型</label>
            <select class="select" id="s-task">
              ${taskOpts.map((t) => `<option value="${t}" ${proj.task_type === t ? 'selected' : ''}>
                ${TASK_CN[t] || t}</option>`).join('')}
            </select>
            <div class="hint" style="margin-top:5px">类型只影响导出的默认格式与预标注模型匹配，
            不限制标注方法。改动不影响已有标注。</div></div>
          <div class="field"><label>用途说明</label>
            <textarea class="textarea" id="s-desc">${ui.esc(proj.desc || '')}</textarea></div>
          <button class="btn btn-primary" id="s-save">保存</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>类别</h3><span class="hint">${(proj.labels || []).length} 个</span></div>
        <div class="card-body">
          <div class="field"><label>类别（英文逗号分隔，顺序即导出编号）</label>
            <input class="input" id="s-labels" value="${ui.esc((proj.labels || []).join(', '))}">
          </div>
          <div class="banner banner-warn" style="margin-bottom:12px">
            ${ui.icon('alert', 15)}<div>改类别名不会改动已标好的对象，但导出时旧类别名会被追加成新编号。
            想统一已有标注的类别，用「批量替换类别」。</div></div>
          <div class="row">
            <button class="btn btn-primary" id="s-labels-save">保存类别</button>
            <button class="btn" id="s-rename">批量替换类别</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>预标注模型</h3></div>
        <div class="card-body">
          <div class="field"><label>本项目默认使用</label>
            <select class="select" id="s-model">
              <option value="">跟随全局默认</option>
              ${(models.models || []).map((m) => `<option value="${m.id}" ${proj.model_id === m.id ? 'selected' : ''}>
                ${ui.esc(m.name)}（${ui.esc(MODEL_TASK[m.task] || m.task)}）</option>`).join('')}
            </select>
            <div class="hint" style="margin-top:5px">检测、分割、分类模型都支持，换模型去「模型库」。</div>
          </div>
          <button class="btn" id="s-model-save">保存</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>协作与导出</h3></div>
        <div class="card-body">
          <label class="row" style="gap:8px;align-items:flex-start;margin-bottom:14px">
            <input type="checkbox" id="s-allow" ${proj.allow_export_all ? 'checked' : ''} style="margin-top:3px">
            <span><b style="font-size:12.5px">允许标注员导出全量</b>
            <div class="hint">关闭后，普通标注员只能导出自己标的部分，避免多人各下一份全量互相覆盖。</div></span>
          </label>
          <button class="btn" id="s-allow-save">保存</button>
        </div>
      </div>

      <div class="card span2">
        <div class="card-head"><h3>项目存储位置</h3>
          <span class="hint">图片与标注的实际落盘位置</span></div>
        <div class="card-body">
          <div style="margin-bottom:10px">
            <div class="hint" style="margin-bottom:4px">项目目录</div>
            <div class="path-row"><span class="p" title="${ui.esc(proj.dir || '')}">${ui.esc(proj.dir || '')}</span>
              <button class="btn btn-sm" data-copy="${ui.esc(proj.dir || '')}">复制</button>
              ${localHost ? `<button class="btn btn-sm" data-open="${ui.esc(proj.dir || '')}">打开</button>` : ''}
            </div>
          </div>
          <div>
            <div class="hint" style="margin-bottom:4px">图片目录（按分组分子目录）</div>
            <div class="path-row"><span class="p" title="${ui.esc(proj.images_dir || '')}">${ui.esc(proj.images_dir || '')}</span>
              <button class="btn btn-sm" data-copy="${ui.esc(proj.images_dir || '')}">复制</button>
              ${localHost ? `<button class="btn btn-sm" data-open="${ui.esc(proj.images_dir || '')}">打开</button>` : ''}
            </div>
          </div>
          <div class="hint" style="margin-top:10px">标注数据存在数据库里，不单独落文件；
          导出时会生成 zip 包。备份整个项目目录即可连同图片一起带走。</div>
        </div>
      </div>

      <div class="card span2">
        <div class="card-head"><h3>项目状态</h3></div>
        <div class="card-body">
          ${isAdmin ? '' : `<div class="banner banner-warn" style="margin-bottom:12px">
            ${ui.icon('lock', 15)}<div>归档与删除只有管理员可以操作。需要清理项目时，请联系管理员或使用管理员账号登录。</div>
          </div>`}
          <div class="danger-zone">
            <h4>归档</h4>
            <div class="hint" style="margin-bottom:8px">
              <b>归档不等于删除。</b>归档只是把它从项目列表里收起来，图片、标注、导出记录全部保留，
              随时可以在「已归档的项目」里恢复。项目结题、暂时不标了，用这个。</div>
            <button class="btn" id="s-archive" ${isAdmin ? '' : 'disabled'}>${proj.status === 'archived' ? '取消归档' : '归档项目'}</button>
          </div>
          <div class="danger-zone" style="margin-top:12px;border-color:var(--danger)">
            <h4 style="color:var(--danger)">删除项目</h4>
            <div class="hint" style="margin-bottom:8px">
              会连同该项目的全部图片文件、标注、导出记录一起删掉，<b>不能恢复</b>。
              只在建错了、数据不要了的时候用。</div>
            <button class="btn btn-danger" id="s-delete" ${isAdmin ? '' : 'disabled'}>删除这个项目</button>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      navigator.clipboard.writeText(b.dataset.copy)
        .then(() => ui.toast('路径已复制', 'ok'))
        .catch(() => ui.toast('复制失败，请手动选中', 'err'));
    };
  });
  root.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = async () => {
      try { await post('/api/system/reveal', { path: b.dataset.open }); }
      catch (e) { ui.toast(e.message, 'err'); }
    };
  });

  root.querySelector('#s-save').onclick = async () => {
    await patch(`/api/projects/${id}`, {
      name: root.querySelector('#s-name').value.trim(),
      desc: root.querySelector('#s-desc').value.trim(),
      task_type: root.querySelector('#s-task').value,
    });
    ui.toast('已保存', 'ok');
    reload();
  };

  root.querySelector('#s-labels-save').onclick = async () => {
    const labels = root.querySelector('#s-labels').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    if (!labels.length) return ui.toast('至少一个类别', 'err');
    await patch(`/api/projects/${id}`, { labels });
    ui.toast('类别已更新', 'ok');
    reload();
  };

  root.querySelector('#s-rename').onclick = () => {
    const labels = proj.labels || [];
    if (!labels.length) return ui.toast('先去设置里加类别', 'err');
    ui.openModal({
      title: '批量替换类别',
      body: `<div class="hint" style="margin-bottom:12px">把已经标好的对象从旧类别整体改成新类别，用于清理同物异名。</div>
        <div class="field"><label>原类别</label><select class="select" id="r-from">
          ${labels.map((l) => `<option>${ui.esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label>新类别名</label><input class="input" id="r-to" placeholder="例如 rice">
          <div class="hint" style="margin-top:4px">新名字会自动加进类别集，不用另外保存。</div></div>`,
      actions: [
        { label: '取消' },
        {
          label: '替换', primary: true, onClick: async (close, b) => {
            const from = b.querySelector('#r-from').value;
            const to = b.querySelector('#r-to').value.trim();
            if (!to) { ui.toast('填新类别名', 'err'); return false; }
            const r = await post(`/api/projects/${id}/labels/rename`, { from, to });
            if (!labels.includes(to)) {
              await patch(`/api/projects/${id}`, { labels: [...labels, to] });
            }
            close();
            ui.toast(`已把 ${r.changed} 个标注改成 ${to}`, 'ok');
            reload();
          },
        },
      ],
    });
  };

  root.querySelector('#s-model-save').onclick = async () => {
    const v = root.querySelector('#s-model').value;
    await patch(`/api/projects/${id}`, { model_id: v ? Number(v) : null });
    ui.toast('已保存', 'ok');
  };

  root.querySelector('#s-allow-save').onclick = async () => {
    await patch(`/api/projects/${id}`, { allow_export_all: root.querySelector('#s-allow').checked });
    ui.toast('已保存', 'ok');
  };

  root.querySelector('#s-archive').onclick = async () => {
    const archiving = proj.status !== 'archived';
    const ok = await ui.confirmBox(
      archiving
        ? '归档后项目从列表里收起来，图片和标注都保留，可以在「已归档的项目」里恢复。'
        : '恢复到项目列表？',
      { title: archiving ? '归档项目' : '取消归档', okLabel: archiving ? '归档' : '恢复' });
    if (!ok) return;
    if (archiving) await del(`/api/projects/${id}`);
    else await patch(`/api/projects/${id}`, { status: 'active' });
    ui.toast(archiving ? '已归档' : '已恢复', 'ok');
    reload();
  };

  root.querySelector('#s-delete').onclick = async () => {
    if (!await ui.confirmBox(
      `「${proj.name}」下的 ${nImg} 张图片、全部标注与磁盘文件都会被删除，不能恢复。\n`
      + '只想暂时收起来的话，用上面的「归档」。',
      { title: '彻底删除项目', okLabel: '删除', danger: true },
    )) return;
    await del(`/api/projects/${id}?hard=true`);
    ui.toast('项目已删除', 'ok');
    navigate('/projects');
  };
}
