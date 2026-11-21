// 项目列表
import { get, post, patch, del } from './api.js';
import * as ui from './ui.js';

// 四类项目。类型只决定"主要产出什么"，不限制标注工具：
// 除图像分类外，画布上的矩形、多边形、折线、点、画笔都可用。
export const TASKS = [
  { v: 'detect', t: '目标检测', d: '以矩形框为主：数目标、定位置', sample: 'rice, weed' },
  { v: 'segment', t: '实例分割', d: '以多边形为主：贴轮廓、算面积', sample: 'rice, weed' },
  { v: 'classify', t: '图像分类', d: '一张图一个类别，不画形状', sample: 'healthy, blight' },
  { v: 'mixed', t: '其他', d: '关键点、折线、旋转框等，工具全开', sample: 'rice, lesion' },
];

let scope = 'active';   // active | archived | all
let canManage = false;  // 只有管理员能看到归档/删除入口

export async function renderProjects(page, topbar, { state, navigate }) {
  topbar.innerHTML = `
    <h1>项目</h1>
    <div class="grow"></div>
    <select class="select" id="scope" style="width:132px">
      <option value="active">进行中的项目</option>
      <option value="archived">已归档的项目</option>
      <option value="all">全部项目</option>
    </select>
    <button class="btn btn-primary" id="new-proj">${ui.icon('plus', 15)} 新建项目</button>`;

  page.innerHTML = '<div class="empty"><div class="spin dark"></div></div>';

  const data = await get('/api/projects');
  state.projects = data.projects;
  canManage = !!(state.user && state.user.role === 'admin');
  const nActive = data.projects.filter((p) => p.status !== 'archived').length;
  const nArch = data.projects.length - nActive;

  const sel = topbar.querySelector('#scope');
  sel.value = scope;
  sel.querySelector('[value="active"]').textContent = `进行中（${nActive}）`;
  sel.querySelector('[value="archived"]').textContent = `已归档（${nArch}）`;
  sel.onchange = () => { scope = sel.value; renderProjects(page, topbar, { state, navigate }); };
  topbar.querySelector('#new-proj').onclick = () => newProject(state, navigate);

  const list = data.projects.filter((p) => (scope === 'all' ? true
    : scope === 'archived' ? p.status === 'archived' : p.status !== 'archived'));

  if (!list.length) {
    const ico = scope === 'archived' ? 'archive' : 'grid';
    page.innerHTML = `
      <div class="card"><div class="empty">
        ${ui.icon(ico, 34)}
        <h4>${scope === 'archived' ? '没有已归档的项目' : '还没有项目'}</h4>
        <p>${scope === 'archived'
          ? '归档只是从列表里收起来，数据都还在。在项目「设置」里可以归档或恢复。'
          : '一个项目对应一件事。建好项目后，可以把大图裁成小图，也可以直接导入已经裁好的图片和标注。'}</p>
        ${scope === 'archived' ? '' : `<button class="btn btn-primary" id="new-proj2">${ui.icon('plus', 15)} 新建第一个项目</button>`}
      </div></div>`;
    const b = page.querySelector('#new-proj2');
    if (b) b.onclick = () => newProject(state, navigate);
    return;
  }

  page.innerHTML = `<div class="proj-grid">${list.map(card).join('')}</div>`;
  page.querySelectorAll('[data-pid]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-act]')) return;
      navigate(`/project/${el.dataset.pid}`);
    };
  });
  page.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const pid = Number(btn.dataset.pid);
      const p = list.find((x) => x.id === pid);
      if (btn.dataset.act === 'restore') {
        await patch(`/api/projects/${pid}`, { status: 'active' });
        ui.toast('已恢复到进行中', 'ok');
      } else if (btn.dataset.act === 'delete') {
        if (!await ui.confirmBox(
          `「${p.name}」下的 ${p.stats ? p.stats.total : 0} 张图片、全部标注和磁盘文件都会被删除，不能恢复。\n`
          + '如果只是想暂时收起来，用「归档」更稳妥。',
          { title: '彻底删除项目', okLabel: '删除项目', danger: true },
        )) return;
        await del(`/api/projects/${pid}?hard=true`);
        ui.toast('项目已删除', 'ok');
      }
      renderProjects(page, topbar, { state, navigate });
    };
  });
}

function card(p) {
  const s = p.stats || {};
  const tk = TASKS.find((x) => x.v === p.task_type);
  const archived = p.status === 'archived';
  return `
  <div class="proj-card" data-pid="${p.id}">
    <div class="row-between">
      <h3><span class="t">${ui.esc(p.name)}</span>
        ${archived ? '<span class="tag tag-gray">已归档</span>' : ''}
      </h3>
      <span class="task-chip" title="${ui.esc(tk ? tk.d : '')}">${esc(p.task_label || (tk ? tk.t : p.task_type))}</span>
    </div>
    ${p.desc ? `<div class="hint" style="margin-top:-4px">${ui.esc(p.desc)}</div>` : ''}
    <div>
      <div class="row-between" style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">
        <span>完成 ${s.done || 0} / ${s.total || 0}</span>
        <span class="num">${s.progress || 0}%</span>
      </div>
      <div class="bar ${(s.progress || 0) >= 100 ? 'green' : ''}"><i style="width:${s.progress || 0}%"></i></div>
    </div>
    <div class="proj-meta">
      <span>待标 <b>${s.todo || 0}</b></span>
      <span>分组 <b>${p.n_batches || 0}</b></span>
      <span>类别 <b>${(p.labels || []).length}</b></span>
      ${archived
        ? (canManage ? `<span style="margin-left:auto;display:flex;gap:6px">
        <button class="btn btn-sm" data-act="restore" data-pid="${p.id}">恢复</button>
        <button class="btn btn-sm btn-danger" data-act="delete" data-pid="${p.id}">删除</button>
      </span>` : '')
        : (canManage ? `<span class="card-acts">
        <button class="btn btn-sm btn-ghost" data-act="delete" data-pid="${p.id}"
          title="删除项目（含图片与标注，不可恢复）">${ui.icon('trash', 12)} 删除</button>
      </span>` : '')}
    </div>
  </div>`;
}

const esc = (v) => ui.esc(v);

export function newProject(state, navigate) {
  ui.openModal({
    title: '新建项目',
    wide: true,
    body: `
      <div class="field"><label>项目名称</label>
        <input class="input" id="pn" placeholder="例如：早稻秧苗计数 2026-06">
        <div class="hint" style="margin-top:4px">建议写成「做什么 + 什么时候/哪块田」，一眼能分清就够了。</div></div>
      <div class="field"><label>项目类型</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="task-grid">
          ${TASKS.map((t, i) => `
            <label class="cls-btn ${i === 0 ? 'on' : ''}" data-tv="${t.v}" style="cursor:pointer;align-items:flex-start">
              <span>
                <span style="display:block;font-weight:600">${t.t}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-3);font-weight:400">${t.d}</span>
              </span>
            </label>`).join('')}
        </div>
        <input type="hidden" id="pt" value="detect">
        <div class="hint" style="margin-top:6px">类型只说明这个项目主要产出什么，<b>不限制标注方法</b>。
          除图像分类外，画布上的矩形、多边形、折线、点、画笔都可以随时切换。</div></div>
      <div class="field"><label>类别名（英文逗号分隔，顺序就是类别编号）</label>
        <input class="input" id="pl" value="rice" placeholder="rice">
        <div class="hint" style="margin-top:4px" id="pl-hint">
          标注时只能从这些类别里选，避免同一目标出现多个叫法。导出时第 1 个对应类别 0。</div></div>
      <div class="field" style="margin-bottom:4px"><label>用途说明（可选）</label>
        <textarea class="textarea" id="pd" placeholder="数据来源、拍摄条件、给同学交代的注意事项"></textarea></div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建', primary: true, onClick: async (close, b) => {
          const name = b.querySelector('#pn').value.trim();
          if (!name) { ui.toast('请填写项目名称', 'err'); return false; }
          const task = b.querySelector('#pt').value;
          const labels = b.querySelector('#pl').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
          if (!labels.length) { ui.toast('至少填一个类别', 'err'); return false; }
          try {
            const r = await post('/api/projects', {
              name, task_type: task, labels, desc: b.querySelector('#pd').value.trim(),
            });
            close();
            ui.toast('项目已创建', 'ok');
            navigate(`/project/${r.id}`);
          } catch (e) { ui.toast(e.message, 'err'); return false; }
        },
      },
    ],
    onMount: (b) => {
      const hid = b.querySelector('#pt');
      const pl = b.querySelector('#pl');
      const hint = b.querySelector('#pl-hint');
      b.querySelectorAll('[data-tv]').forEach((el) => {
        el.addEventListener('click', () => {
          b.querySelectorAll('[data-tv]').forEach((x) => x.classList.remove('on'));
          el.classList.add('on');
          const t = TASKS.find((x) => x.v === el.dataset.tv);
          hid.value = t.v;
          pl.value = t.sample;
          hint.textContent = t.v === 'classify'
            ? '分类项目里每张图只给一个类别，类别就是你要分的那些类。'
            : '标注时只能从这些类别里选，避免同一目标出现多个叫法。导出时第 1 个对应类别 0。';
        });
      });
    },
  });
}
