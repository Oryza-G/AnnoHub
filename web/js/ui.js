// 图标、提示、弹窗、格式化 —— 所有视图共用的小工具。

const P = {
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  scissors: 'M6 4l12 12M6 20L18 8M9 7a3 3 0 11-4.2 4.2A3 3 0 019 7zM9 17a3 3 0 10-4.2-4.2A3 3 0 009 17z',
  tag: 'M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6zM7.5 7.5h.01',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM10 2v4M14 2v4M10 18v4M14 18v4M2 10h4M2 14h4M18 10h4M18 14h4',
  users: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 10a4 4 0 100-8 4 4 0 000 8zM22 20v-2a4 4 0 00-3-3.9M16 2.1a4 4 0 010 7.8',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 17V5M7 10l5-5 5 5M4 19h16',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  image: 'M4 5h16v14H4zM4 15l4-4 3 3 3-3 5 5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  save: 'M5 3h11l3 3v15H5zM8 3v6h7V3M8 14h8v7H8z',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-4',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h4',
  skip: 'M5 4l10 8-10 8zM19 4v16',
  refresh: 'M20 11a8 8 0 10-1.6 6M20 4v7h-7',
  alert: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 8h.01',
  zoomIn: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3M11 8v6M8 11h6',
  zoomOut: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3M8 11h6',
  lock: 'M6 11h12v10H6zM9 11V7a3 3 0 016 0v4',
  unlock: 'M6 11h12v10H6zM9 11V7a3 3 0 015.7-1.3',
  play: 'M6 4l14 8-14 8z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  arrowLeft: 'M20 12H4M10 6l-6 6 6 6',
  edit: 'M4 20h4L20 8l-4-4L4 16z',
  copy: 'M9 9h11v11H9zM4 4h11v3M4 4v11h3',
  pointer: 'M5 3l14 8-6 1.5L10 19z',
  square: 'M4 4h16v16H4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  wand: 'M15 4l1.5 3.5L20 9l-3.5 1.5L15 14l-1.5-3.5L10 9l3.5-1.5zM6 20l6-6M4 14l2 2',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  db: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  power: 'M12 3v9M6.4 6.4a8 8 0 1011.2 0',
  wifi: 'M5 12.5a10 10 0 0114 0M8.5 16a5.5 5.5 0 017 0M12 20h.01',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 114 2c-.8.6-1.5 1-1.5 2M12 17h.01',
  stop: 'M6 6h12v12H6z',
  importIn: 'M12 3v11M8 10l4 4 4-4M4 17v3h16v-3',
  folderOpen: 'M3 8a1 1 0 011-1h5l2 2h8a1 1 0 011 1v1H3zM3 10h18l-2 9H5z',
  polygon: 'M12 3l8.5 6.2-3.2 10H6.7l-3.2-10z',
  line: 'M4 19L20 5M4 19h.01M20 5h.01',
  point: 'M12 18a6 6 0 100-12 6 6 0 000 12zM12 13a1 1 0 100-2 1 1 0 000 2z',
  shield: 'M12 3l8 3v6c0 4.6-3.6 7.7-8 9-4.4-1.3-8-4.4-8-9V6z',
  userPlus: 'M15 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M8.5 10a4 4 0 100-8 4 4 0 000 8zM18 8v6M21 11h-6',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  scan: 'M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 13a1 1 0 100-2 1 1 0 000 2z',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  archive: 'M3 8h18v12H3zM3 4h18v4H3zM9 12h6',
  brush: 'M6 20c3 .5 5-1.5 5-4 0-1.5-1-2.5-2.5-2.5S6 14.5 6 16c0 2-1 3-3 3M16 4l4 4-9 9-4-4z',
  theme: 'M12 21a9 9 0 110-18 9 9 0 010 18zM12 3v18',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
};

export function icon(name, size = 16, cls = '') {
  const d = P[name] || P.info;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="${d}"/></svg>`;
}

// ---------------------------------------------------------------- 外观主题
// 三套配色，颜色全在 app.css 的变量里，这里只切 data-theme。

export const THEMES = [
  { v: 'light', t: '明亮', d: '默认的白底界面，适合白天' },
  { v: 'dark', t: '深色', d: '工作背景转深，夜里不刺眼' },
  { v: 'sepia', t: '护眼', d: '米黄纸感，长时间标注不易疲劳' },
];

const THEME_KEY = 'annohub_theme';

export function currentTheme() {
  let v = 'light';
  try { v = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* 隐私模式 */ }
  return THEMES.some((t) => t.v === v) ? v : 'light';
}

export function applyTheme(v, { save = true } = {}) {
  const name = THEMES.some((t) => t.v === v) ? v : 'light';
  document.documentElement.dataset.theme = name;
  if (save) {
    try { localStorage.setItem(THEME_KEY, name); } catch { /* 忽略 */ }
  }
  return name;
}

export const STATUS = {
  todo: { label: '待标注', color: '#8a919b', tag: 'tag-gray' },
  annotating: { label: '标注中', color: '#2563eb', tag: 'tag-blue' },
  done: { label: '已完成', color: '#12805c', tag: 'tag-green' },
  reviewed: { label: '已复核', color: '#0b6b57', tag: 'tag-teal' },
  skipped: { label: '已跳过', color: '#b54708', tag: 'tag-amber' },
};

// 标签配色：红蓝绿黄青棕，避开紫色
export const PALETTE = ['#e5484d', '#2563eb', '#12805c', '#d97706', '#0e7490',
  '#b45309', '#4d7c0f', '#be123c', '#0369a1', '#a16207'];

export function clsColor(labels, cls) {
  const i = labels.indexOf(cls);
  return PALETTE[(i < 0 ? labels.length : i) % PALETTE.length];
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return fmtTime(iso);
}

// ---------------------------------------------------------------- 提示

export function toast(msg, type = '', ms = 3200) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span style="flex:1">${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(10px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
  return el;
}

// ---------------------------------------------------------------- 弹窗

export function openModal({ title, body, actions = [], wide = false, onMount }) {
  const host = document.getElementById('modals');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = `modal${wide ? ' wide' : ''}`;
  box.innerHTML = `
    <div class="modal-head">${esc(title || '')}</div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>`;
  const bodyEl = box.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  const foot = box.querySelector('.modal-foot');

  const close = (val) => {
    mask.remove();
    if (box._resolve) box._resolve(val);
  };

  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`;
    b.textContent = a.label;
    b.onclick = async () => {
      if (a.onClick) {
        const r = await a.onClick(close, bodyEl);
        if (r === false) return;
      } else close();
    };
    foot.appendChild(b);
  });

  mask.appendChild(box);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
  host.appendChild(mask);
  if (onMount) onMount(bodyEl, close);
  const first = box.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 40);
  return { close, bodyEl };
}

export function confirmBox(message, { title = '确认', okLabel = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<div style="font-size:13px;line-height:1.7;color:var(--text-2)">${esc(message)}</div>`,
      actions: [
        { label: '取消', onClick: () => { m.close(); resolve(false); } },
        { label: okLabel, primary: !danger, danger, onClick: () => { m.close(); resolve(true); } },
      ],
    });
    m._resolveHook = resolve;
  });
}

export function promptBox(message, { title = '输入', value = '', placeholder = '', okLabel = '确定' } = {}) {
  return new Promise((resolve) => {
    let inputEl;
    const m = openModal({
      title,
      body: `<div class="field"><label>${esc(message)}</label>
             <input class="input" id="pb-in" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`,
      actions: [
        { label: '取消', onClick: () => { m.close(); resolve(null); } },
        { label: okLabel, primary: true, onClick: () => { m.close(); resolve(inputEl.value.trim()); } },
      ],
      onMount: (b) => {
        inputEl = b.querySelector('#pb-in');
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { m.close(); resolve(inputEl.value.trim()); }
        });
      },
    });
  });
}

export function alertBox(message, { title = '提示', okLabel = '知道了' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: `<div style="font-size:13px;line-height:1.75;color:var(--text-2);white-space:pre-wrap">${esc(message)}</div>`,
      actions: [{ label: okLabel, primary: true, onClick: () => { m.close(); resolve(true); } }],
    });
  });
}

// 把事件绑定在容器上，供 HTML 字符串模板使用
export function bind(root, selector, event, handler) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
