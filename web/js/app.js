// 应用入口：路由、外壳、登录态。
import { get, setUnauthorizedHandler } from './api.js';
import * as ui from './ui.js';
import { renderLogin } from './view_login.js';
import { renderProjects } from './view_projects.js';
import { renderProject } from './view_project.js';
import { renderAnnotate } from './view_annotate.js';
import { renderModels } from './view_models.js';
import { renderUsers } from './view_users.js';
import { renderSettings } from './view_settings.js';

export const state = {
  user: null,
  system: null,
  projects: [],
  route: { name: 'projects', params: {} },
};

const app = document.getElementById('app');

export function navigate(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

function parseRoute() {
  const raw = (location.hash || '#/projects').replace(/^#/, '');
  const p = raw.split('/').filter(Boolean);
  if (p.length === 0 || p[0] === 'projects') return { name: 'projects', params: {} };
  if (p[0] === 'project' && p[1]) {
    const id = Number(p[1]);
    if (p[2] === 'annotate') {
      return { name: 'annotate', params: { id, imageId: p[3] ? Number(p[3]) : null } };
    }
    return { name: 'project', params: { id, tab: p[2] || 'overview' } };
  }
  if (p[0] === 'models') return { name: 'models', params: {} };
  if (p[0] === 'users') return { name: 'users', params: {} };
  if (p[0] === 'settings') return { name: 'settings', params: {} };
  return { name: 'projects', params: {} };
}

const NAV = [
  { key: 'projects', label: '项目', icon: 'grid' },
  { key: 'models', label: '模型库', icon: 'cpu' },
  { key: 'users', label: '成员', icon: 'users' },
  { key: 'settings', label: '设置', icon: 'layers' },
];

function shellHTML(route) {
  const u = state.user;
  const initials = (u.display_name || u.username || '?').slice(0, 2);
  const activeKey = route.name === 'annotate' ? 'projects'
    : route.name === 'project' ? 'projects' : route.name;
  return `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><img src="/assets/logo.png" alt=""></div>
        <div>
          <div class="brand-name">AnnoHub</div>
          <div class="brand-sub">标注台</div>
        </div>
      </div>
      <nav class="nav">
        ${NAV.filter((n) => n.key !== 'users' || u.role === 'admin').map((n) => `
          <div class="nav-item ${activeKey === n.key ? 'active' : ''}" data-nav="${n.key}">
            ${ui.icon(n.icon, 16)}<span>${n.label}</span>
          </div>`).join('')}
        <div class="nav-sep"></div>
        <div class="nav-item" data-nav="help">${ui.icon('help', 16)}<span>使用指南</span></div>
      </nav>
      <div class="sidebar-foot">
        <div class="user-chip" id="user-chip">
          <div class="avatar">${ui.esc(initials)}</div>
          <div class="grow" style="min-width:0">
            <div style="font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ui.esc(u.display_name)}</div>
            <div style="font-size:11px;color:var(--text-3)">${u.role === 'admin' ? '管理员' : '标注员'}</div>
          </div>
          ${ui.icon('chevronDown', 14)}
        </div>
      </div>
    </aside>
    <div class="main">
      <div class="topbar" id="topbar"></div>
      <div class="page" id="page"></div>
    </div>
  </div>`;
}

async function render() {
  if (!state.user) {
    const box = document.createElement('div');
    box.className = 'login-wrap';
    app.innerHTML = '';
    app.appendChild(box);
    renderLogin(box, { state, onDone: boot });
    return;
  }

  const route = parseRoute();
  state.route = route;

  if (route.name === 'annotate') {
    app.innerHTML = '<div id="annot-root" style="height:100%"></div>';
    try {
      await renderAnnotate(document.getElementById('annot-root'),
        { state, navigate, projectId: route.params.id, startImageId: route.params.imageId });
    } catch (e) {
      app.innerHTML = `<div class="page"><div class="banner banner-err">${ui.esc(e.message)}</div></div>`;
    }
    return;
  }

  app.innerHTML = shellHTML(route);
  const page = document.getElementById('page');
  const topbar = document.getElementById('topbar');

  // 导航
  app.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = el.dataset.nav;
      if (k === 'help') return showHelp();
      navigate('/' + k);
    });
  });
  const chip = document.getElementById('user-chip');
  if (chip) chip.addEventListener('click', (e) => userMenu(e, chip));

  try {
    if (route.name === 'projects') await renderProjects(page, topbar, { state, navigate });
    else if (route.name === 'project') await renderProject(page, topbar, { state, navigate, id: route.params.id, tab: route.params.tab });
    else if (route.name === 'models') await renderModels(page, topbar, { state, navigate });
    else if (route.name === 'users') await renderUsers(page, topbar, { state, navigate });
    else if (route.name === 'settings') await renderSettings(page, topbar, { state, navigate });
  } catch (e) {
    if (e.unauthorized) return;
    page.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 16)}<div>${ui.esc(e.message)}</div></div>`;
  }
}

function userMenu(e, anchor) {
  const r = anchor.getBoundingClientRect();
  const host = document.getElementById('modals');
  const menu = document.createElement('div');
  menu.style.cssText = `position:fixed;left:${r.left}px;bottom:${window.innerHeight - r.top + 6}px;`
    + 'background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);'
    + 'padding:4px;min-width:186px;z-index:950;font-size:13px';
  const cur = ui.currentTheme();
  menu.innerHTML = `
    <div style="padding:7px 10px;font-size:12px;color:var(--text-3);border-bottom:1px solid var(--border);margin-bottom:4px">
      ${ui.esc(state.user.username)}</div>
    <div data-act="pwd" style="padding:7px 10px;border-radius:5px;cursor:pointer">修改密码</div>
    <div style="padding:7px 10px 3px;font-size:11px;color:var(--text-3);margin-top:4px">界面外观</div>
    ${ui.THEMES.map((t) => `<div data-theme="${t.v}" style="padding:6px 10px;border-radius:5px;cursor:pointer;
        display:flex;align-items:center;gap:7px${t.v === cur ? ';color:var(--primary);font-weight:600' : ''}">
        ${t.v === cur ? ui.icon('check', 13) : '<span style="width:13px"></span>'}${t.t}</div>`).join('')}
    <div style="height:1px;background:var(--border);margin:4px 0"></div>
    <div data-act="out" style="padding:7px 10px;border-radius:5px;cursor:pointer;color:var(--danger)">退出登录</div>`;
  host.appendChild(menu);

  let done = false;
  const kill = () => {
    if (done) return;
    done = true;
    document.removeEventListener('mousedown', onDocDown, true);
    menu.remove();
  };
  // 关键：点在菜单内部不能关菜单，否则 mouseup/click 落到已移除的节点上，
  // 「退出登录」这类点击永远触发不了。
  function onDocDown(ev) {
    if (!menu.contains(ev.target)) kill();
  }
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0);

  menu.querySelectorAll('[data-theme]').forEach((el) => {
    el.addEventListener('mouseenter', () => (el.style.background = 'var(--bg-soft)'));
    el.addEventListener('mouseleave', () => (el.style.background = ''));
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ui.applyTheme(el.dataset.theme);
      kill();
      render();
    });
  });

  menu.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('mouseenter', () => (el.style.background = 'var(--bg-soft)'));
    el.addEventListener('mouseleave', () => (el.style.background = ''));
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const act = el.dataset.act;
      kill();
      if (act === 'out') {
        const { post } = await import('./api.js');
        await post('/api/auth/logout', {}).catch(() => {});
        state.user = null;
        state.system = null;
        if (location.hash && location.hash !== '#/projects') location.hash = '#/projects';
        else render();
      } else {
        const { openModal, toast } = ui;
        openModal({
          title: '修改密码',
          body: `<div class="field"><label>原密码</label><input class="input" type="password" id="p0"></div>
                 <div class="field"><label>新密码（至少 6 位）</label><input class="input" type="password" id="p1"></div>`,
          actions: [
            { label: '取消' },
            {
              label: '保存', primary: true, onClick: async (close, b) => {
                const { post } = await import('./api.js');
                try {
                  await post('/api/auth/password', {
                    old: b.querySelector('#p0').value, new: b.querySelector('#p1').value,
                  });
                  toast('密码已修改', 'ok');
                  close();
                } catch (err) { toast(err.message, 'err'); }
              },
            },
          ],
        });
      }
    });
  });
}

function showHelp() {
  ui.openModal({
    title: '使用指南',
    wide: true,
    body: `<div style="font-size:13px;line-height:1.85;color:var(--text-2)">
      <p style="margin-bottom:10px"><b>一条完整流程</b>：建项目 → 加图片（裁切大图，或导入已裁好的图）
      → 标注（可先用模型预标注）→ 导出训练集。</p>
      <p style="margin-bottom:10px"><b>多人协作</b>：把「设置 → 局域网访问」中的地址发给协作成员，他们用浏览器
      打开就能用，不需要安装任何东西。第一次点「注册账号」自己建号。同一张图同一时刻只有一个人能标，
      标完点「完成」才释放。</p>
      <p style="margin-bottom:10px"><b>加图片的三种方式</b>：裁切大图（边缘块贴边对齐，不丢条带）、
      导入已裁好的图片、导入别人标好的标注（YOLO / VOC / COCO / LabelMe / CSV）。每次裁切或导入都会单独成组，
      在「图片」页左侧按组管理，可以整组删掉重来。</p>
      <p style="margin-bottom:10px"><b>标注工具</b>：画布左侧竖排是矩形、多边形、折线、点、画笔与选择工具，
      任何项目里都能随时切换，不受项目类型限制。具体操作与快捷键见标注页右上角「标注说明」。</p>
      <p style="margin-bottom:10px"><b>导出的划分与格式</b>：支持 10 种训练/验证划分比例，YOLO 检测、
      YOLO 分割、YOLO 分类、VOC、COCO、CSV 六种格式可任意组合，一次导出。</p>
      <p style="margin-top:12px"><b>界面外观</b>：左下角账号菜单里可切换「明亮 / 深色 / 护眼」三套配色。</p>
    </div>`,
    actions: [{ label: '知道了', primary: true }],
  });
}

setUnauthorizedHandler(() => {
  state.user = null;
  render();
});

async function boot() {
  ui.applyTheme(ui.currentTheme(), { save: false });
  try {
    const me = await get('/api/auth/me');
    state.user = me.user;
  } catch {
    state.user = null;
  }
  if (state.user) {
    get('/api/system/info').then((s) => { state.system = s; }).catch(() => {});
  }
  render();
}

window.addEventListener('hashchange', render);

// 兜底：任何没被 catch 的接口错误都弹一次提示，避免点了按钮毫无反应。
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason || {};
  if (r.unauthorized) { e.preventDefault(); return; }
  const msg = r.message || String(r);
  if (!msg) return;
  ui.toast(msg, 'err', 4600);
  if (e.preventDefault) e.preventDefault();
});

boot();
