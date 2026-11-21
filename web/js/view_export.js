// 导出页：范围 → 格式 → 划分 → 打包下载
import { get, post, del, pollJob } from './api.js';
import * as ui from './ui.js';

const FORMATS = [
  { key: 'yolo', label: 'YOLO 检测', desc: 'images/ labels/ data.yaml，矩形框（多边形取包围盒）', task: ['detect', 'segment', 'keypoint', 'obb', 'mixed'] },
  { key: 'yolo_seg', label: 'YOLO 分割', desc: 'labels 里是多边形顶点，矩形自动展开成四点', task: ['segment', 'detect', 'mixed'] },
  { key: 'yolo_cls', label: 'YOLO 分类', desc: '按类别分目录的 ImageFolder，train/val 已分好', task: ['classify'] },
  { key: 'voc', label: 'Pascal VOC', desc: 'JPEGImages/ Annotations/ ImageSets，多边形写 polygon', task: ['detect', 'segment', 'keypoint', 'obb', 'mixed'] },
  { key: 'coco', label: 'COCO', desc: 'instances_{split}.json，含 segmentation 与 keypoints', task: ['detect', 'segment', 'keypoint', 'mixed'] },
  { key: 'csv', label: 'CSV', desc: '一行一个标注，附几何原始坐标，便于统计核对', task: ['detect', 'segment', 'keypoint', 'classify', 'obb', 'mixed'] },
];

const SCOPES = [
  { key: 'all', label: '全部已标注', desc: '状态为已完成或已复核的图' },
  { key: 'mine', label: '我标注的', desc: '只导出分配给我并已完成的' },
  { key: 'reviewed', label: '复核通过', desc: '只含已复核的图' },
  { key: 'batch', label: '指定来源分组', desc: '某一组裁切或导入的图' },
  { key: 'all_with_todo', label: '全部图片（含未标注）', desc: '含未标图，用于先看数据分布' },
  { key: 'images_only', label: '仅图片，不含标签', desc: '只打包图片，做纯推理测试集用' },
];

export async function renderExportTab(root, proj, ctx) {
  const defaultFmt = proj.task_type === 'classify' ? 'yolo_cls'
    : proj.task_type === 'segment' ? 'yolo_seg' : 'yolo';
  let state = JSON.parse(localStorage.getItem(`exp_${proj.id}`) || '{}');
  state = { scope: 'all', formats: [defaultFmt], split: 'none', ...state };

  let splits = [
    ['none', '不划分（全部放 train）'], ['9:1', '9 : 1（train / val）'],
    ['8:2', '8 : 2（train / val）'], ['7:3', '7 : 3（train / val）'],
    ['8:1:1', '8 : 1 : 1（train / val / test）'],
  ];
  try {
    const sc = await get(`/api/projects/${proj.id}/export/scopes`);
    if (sc.splits && sc.splits.length) splits = sc.splits;
  } catch { /* 老版本没有这个接口，用兜底列表 */ }
  const save = () => localStorage.setItem(`exp_${proj.id}`, JSON.stringify(state));

  const fmts = FORMATS.filter((f) => !f.task || f.task.includes(proj.task_type));

  root.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(0,404px) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card">
        <div class="card-head"><h3>导出设置</h3>
          <span class="task-chip">${ui.esc(proj.task_label || proj.task_type)}</span></div>
        <div class="card-body">
          <div class="field"><label>导出范围</label>
            <select class="select" id="e-scope">
              ${SCOPES.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}
            </select>
            <div class="hint" id="scope-hint" style="margin-top:5px"></div>
          </div>

          <div class="field" id="batch-field" style="display:none">
            <label>选择分组</label>
            <select class="select" id="e-batch">
              ${(proj.batches || []).map((b) => `<option value="${b.id}">${ui.esc(b.name)}（${b.n_images} 张）</option>`).join('')}
            </select>
          </div>

          <div class="field"><label>导出格式（可多选，同时打包到一个 zip）</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${fmts.map((f) => `<label class="row" style="gap:8px;align-items:flex-start;
                  padding:7px 9px;border:1px solid var(--border);border-radius:6px;cursor:pointer">
                <input type="checkbox" value="${f.key}" class="fmt" style="margin-top:2px">
                <span><b style="font-size:12.5px">${f.label}</b>
                  <div class="hint" style="margin-top:1px">${f.desc}</div></span>
              </label>`).join('')}
            </div>
          </div>

          <div class="field"><label>数据划分</label>
            <select class="select" id="e-split">
              ${splits.map(([v, t]) => `<option value="${v}">${ui.esc(t)}</option>`).join('')}
            </select>
            <div class="hint" style="margin-top:5px">按固定种子随机划分，同一次导出的划分可复现。</div>
          </div>

          <button class="btn btn-primary btn-lg" id="e-go" style="width:100%">开始导出</button>
          <div id="e-prog" style="margin-top:12px"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>导出记录</h3>
          <span class="hint">包保留 7 天，过期请重新导出</span></div>
        <div class="card-body" style="padding:0" id="e-list">
          <div class="empty" style="padding:32px"><div class="spin dark" style="margin:0 auto"></div></div>
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const scopeSel = $('#e-scope');
  const batchField = $('#batch-field');

  function syncUI() {
    scopeSel.value = state.scope;
    $('#e-split').value = state.split;
    root.querySelectorAll('.fmt').forEach((c) => { c.checked = state.formats.includes(c.value); });
    batchField.style.display = state.scope === 'batch' ? '' : 'none';
    const s = SCOPES.find((x) => x.key === state.scope);
    $('#scope-hint').textContent = s ? s.desc : '';
  }

  scopeSel.onchange = () => { state.scope = scopeSel.value; save(); syncUI(); };
  $('#e-split').onchange = (e) => { state.split = e.target.value; save(); };
  root.querySelectorAll('.fmt').forEach((c) => c.addEventListener('change', () => {
    state.formats = [...root.querySelectorAll('.fmt')].filter((x) => x.checked).map((x) => x.value);
    save();
  }));
  syncUI();

  $('#e-go').onclick = async () => {
    if (!state.formats.length) return ui.toast('至少选一种格式', 'err');
    const body = { scope: state.scope, formats: state.formats, split: state.split, seed: 42 };
    if (state.scope === 'batch') {
      if (!(proj.batches || []).length) return ui.toast('这个项目还没有分组，先去裁切或导入', 'err');
      body.batch_id = Number($('#e-batch').value);
    }
    if (state.scope === 'all' && !proj.allow_export_all && ctx.state.user.role !== 'admin') {
      return ui.toast('管理员已关闭全量导出，请用「我标注的」', 'err');
    }
    const btn = $('#e-go');
    btn.disabled = true;
    const prog = $('#e-prog');
    prog.innerHTML = `<div class="row-between" style="margin-bottom:6px">
      <span class="hint" id="pm">准备中…</span><span class="num" style="font-size:12px" id="pp">0%</span></div>
      <div class="bar"><i id="pb" style="width:0"></i></div>`;
    try {
      const r = await post(`/api/projects/${proj.id}/exports`, body);
      const j = await pollJob(r.job_id, (st) => {
        const b = prog.querySelector('#pb');
        if (!b) return;
        b.style.width = st.progress + '%';
        prog.querySelector('#pp').textContent = Math.round(st.progress) + '%';
        prog.querySelector('#pm').textContent = st.message || '';
      });
      if (j.status === 'done') {
        const res = j.result || {};
        prog.innerHTML = `<div class="banner banner-ok">${ui.icon('check', 15)}
          <div>导出完成：${res.n_images} 张 / ${res.n_labels} 个标注 / ${ui.fmtBytes(res.size)}</div></div>
          <button class="btn btn-sm" style="margin-top:8px" id="dl-now">立即下载</button>`;
        prog.querySelector('#dl-now').onclick = () => {
          window.location.href = `/api/exports/${res.export_id}/download`;
        };
        loadList();
      } else if (j.status === 'cancelled') {
        prog.innerHTML = `<div class="banner banner-warn">${ui.icon('info', 15)}<div>已取消</div></div>`;
      } else {
        prog.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 15)}
          <div>${ui.esc(j.message || '导出失败')}</div></div>`;
      }
    } catch (e) {
      prog.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 15)}<div>${ui.esc(e.message)}</div></div>`;
    }
    btn.disabled = false;
  };

  async function loadList() {
    const d = await get(`/api/projects/${proj.id}/exports`);
    const list = $('#e-list');
    if (!d.exports.length) {
      list.innerHTML = `<div class="empty" style="padding:36px">${ui.icon('download', 28)}
        <p>还没有导出记录</p></div>`;
      return;
    }
    list.innerHTML = `<table class="table">
      <thead><tr><th>时间</th><th>范围</th><th>格式</th><th class="num">张数</th>
      <th class="num">标注</th><th class="num">大小</th><th></th></tr></thead>
      <tbody>${d.exports.map((e) => `<tr>
        <td style="white-space:nowrap">${ui.fmtTime(e.created_at)}</td>
        <td style="white-space:nowrap">${ui.esc(SCOPES.find((s) => s.key === e.scope)?.label || e.scope)}${
          (e.options || {}).split && e.options.split !== 'none'
            ? `<span class="split-note" style="margin-left:5px">${ui.esc(e.options.split)}</span>` : ''}</td>
        <td style="white-space:nowrap">${((e.options || {}).formats || []).join(' + ')}</td>
        <td class="num">${e.n_images || 0}</td>
        <td class="num">${e.n_labels || 0}</td>
        <td class="num" style="white-space:nowrap">${ui.fmtBytes(e.size)}</td>
        <td style="text-align:right;white-space:nowrap">
          ${e.exists ? `<button class="btn btn-sm" data-dl="${e.id}">下载</button>` : '<span class="hint">文件已清理</span>'}
          ${ctx.state.user.role === 'admin' && e.exists ? `<button class="btn btn-sm btn-ghost" data-share="${e.id}">分享</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-del="${e.id}" style="color:var(--danger)">删除</button>
        </td></tr>`).join('')}</tbody></table>`;

    list.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = () => { window.location.href = `/api/exports/${b.dataset.dl}/download`; };
    });
    list.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!await ui.confirmBox('删除这个导出包？文件会从磁盘移除。', { danger: true, okLabel: '删除' })) return;
        await del(`/api/exports/${b.dataset.del}`);
        ui.toast('已删除', 'ok');
        loadList();
      };
    });
    list.querySelectorAll('[data-share]').forEach((b) => {
      b.onclick = async () => {
        const r = await post(`/api/exports/${b.dataset.share}/share`, { days: 7, max_downloads: 0 });
        const url = location.origin + r.url;
        ui.openModal({
          title: '分享链接',
          body: `<div class="hint" style="margin-bottom:8px">7 天内有效，拿到链接的人不用登录就能下载。</div>
            <input class="input" value="${ui.esc(url)}" readonly onclick="this.select()">`,
          actions: [{
            label: '复制链接', primary: true, onClick: (close) => {
              navigator.clipboard.writeText(url).then(() => ui.toast('已复制', 'ok')).catch(() => {});
              close();
            },
          }],
        });
      };
    });
  }

  await loadList();
}
