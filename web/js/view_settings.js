// 设置：界面外观、局域网访问、存储位置、运行状态、使用须知
import { get, post } from './api.js';
import * as ui from './ui.js';

const TABS = [
  { k: 'appearance', t: '界面外观' },
  { k: 'access', t: '局域网访问' },
  { k: 'storage', t: '存储位置' },
  { k: 'status', t: '运行状态' },
  { k: 'notes', t: '使用须知' },
];

let tab = 'appearance';
let INFO = null;

const isLocal = () => ['127.0.0.1', 'localhost', '::1', ''].includes(location.hostname);

export async function renderSettings(page, topbar, { state }) {
  topbar.innerHTML = '<h1>设置</h1><div class="grow"></div>';
  // 首次进入才等接口；之后切页签直接用缓存，避免每次都转圈
  if (!INFO) page.innerHTML = '<div class="empty"><div class="spin dark"></div></div>';

  const info = INFO || await get('/api/system/info');
  INFO = info;
  state.system = info;
  const acc = info.access || {};

  page.innerHTML = `
    <div class="set-tabs">
      ${TABS.map((t) => `<div class="nav-item ${t.k === tab ? 'active' : ''}" data-tab="${t.k}">${t.t}</div>`).join('')}
    </div>
    <div id="pane"></div>`;

  page.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => { tab = el.dataset.tab; renderSettings(page, topbar, { state }); };
  });

  const pane = page.querySelector('#pane');
  if (tab === 'appearance') appearance(pane);
  else if (tab === 'access') access(pane, info, acc);
  else if (tab === 'storage') storage(pane, info);
  else if (tab === 'status') status(pane, info, acc);
  else notes(pane);
}

// ---------------------------------------------------------------- 外观

function appearance(pane) {
  const cur = ui.currentTheme();
  const PREVIEW = {
    light: ['#f5f6f8', '#ffffff', '#2456d6'],
    dark: ['#14171b', '#1e2329', '#5b8cf5'],
    sepia: ['#efe9dc', '#fbf7ee', '#1f6b5e'],
  };
  pane.innerHTML = `
    <div class="set-grid">
      <div class="card span2">
        <div class="card-head"><h3>界面外观</h3><span class="hint">只影响本机浏览器，各人各自设置</span></div>
        <div class="card-body">
          <div class="theme-grid">
            ${ui.THEMES.map((t) => {
              const c = PREVIEW[t.v];
              return `<div class="theme-card ${t.v === cur ? 'on' : ''}" data-theme="${t.v}">
                <div class="pv">
                  <i style="width:30%;background:${c[0]}"></i>
                  <i style="flex:1;background:${c[1]}"></i>
                  <i style="width:12%;background:${c[2]}"></i>
                </div>
                <div class="nm">${t.t}${t.v === cur ? ' · 使用中' : ''}</div>
                <div class="ds">${t.d}</div>
              </div>`;
            }).join('')}
          </div>
          <div class="hint" style="margin-top:14px">切换后立即生效，下次打开仍是这套配色。
            画布底色随主题变化，图像始终以深底衬托，标注线看得更清。</div>
        </div>
      </div>
    </div>`;

  pane.querySelectorAll('[data-theme]').forEach((el) => {
    el.onclick = () => {
      ui.applyTheme(el.dataset.theme);
      pane.querySelectorAll('[data-theme]').forEach((x) => x.classList.remove('on'));
      el.classList.add('on');
      appearance(pane);
    };
  });
}

// ---------------------------------------------------------------- 访问

function access(pane, info, acc) {
  const nets = (acc.addresses || []).filter((a) => !a.virtual);
  pane.innerHTML = `
    <div class="set-grid">
      <div class="card">
        <div class="card-head"><h3>访问地址</h3>
          <button class="btn btn-sm" id="copy-all">${ui.icon('copy', 13)} 复制给同学</button></div>
        <div class="card-body">
          <div class="hint" style="margin-bottom:12px">同学用浏览器打开即可，<b>不用装任何东西</b>。
            手机连同一 Wi-Fi 也能用。同一网段优先用 IP 那一行。</div>
          <div class="field" style="margin-bottom:12px">
            <label>推荐：计算机名（换网络后依然有效）</label>
            <div class="row"><input class="input grow" readonly value="${ui.esc(acc.url_host || '')}" id="u-host">
              <button class="btn" data-copy="u-host">复制</button></div>
          </div>
          <div class="field" style="margin-bottom:10px">
            <label>备用：IP 地址</label>
            <div class="row"><input class="input grow" readonly value="${ui.esc(acc.url_ip || '')}" id="u-ip">
              <button class="btn" data-copy="u-ip">复制</button></div>
          </div>
          ${nets.length ? `<table class="table" style="margin-top:6px">
            <thead><tr><th>本机网卡</th><th>网络</th><th style="text-align:right">状态</th></tr></thead>
            <tbody>${nets.map((a) => `<tr>
              <td style="font-family:var(--mono);font-size:12px">${ui.esc(a.ip)}</td>
              <td style="color:var(--text-3)">${ui.esc(a.name || '—')}</td>
              <td style="text-align:right">${a.main ? '<span class="tag tag-green">主用</span>' : ''}</td>
            </tr>`).join('')}</tbody></table>
            <div class="hint" style="margin-top:6px">已隐藏虚拟网卡与未联网的 169.254 地址。</div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>连接自检</h3>
          <button class="btn btn-sm" id="recheck">${ui.icon('refresh', 13)} 重新检测</button></div>
        <div class="card-body" id="net-body"><div class="hint">检测中…</div></div>
      </div>
    </div>`;

  pane.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => {
      const v = pane.querySelector('#' + b.dataset.copy).value;
      navigator.clipboard.writeText(v)
        .then(() => { b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制'), 1400); })
        .catch(() => ui.toast('复制失败，请手动选中复制', 'err'));
    };
  });

  pane.querySelector('#copy-all').onclick = () => {
    const url = acc.url_ip || acc.url_host || location.origin;
    const msg = `标注平台地址：${url}\n`
      + '用浏览器打开就能用，不用装东西。\n'
      + '第一次去点「注册账号」自己建一个，之后用这个账号登录。\n'
      + '同一张图同一时间只有一个人能标，标完点「完成」才会释放给别人。';
    navigator.clipboard.writeText(msg)
      .then(() => ui.toast('说明已复制，直接粘给同学', 'ok'))
      .catch(() => ui.alertBox(msg, { title: '说明文本（可复制）' }));
  };

  const netBody = pane.querySelector('#net-body');
  async function loadNet() {
    netBody.innerHTML = '<div class="hint">检测中…</div>';
    let d;
    try {
      d = await get('/api/system/netcheck');
    } catch (e) {
      netBody.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 15)}
        <div>${ui.esc(e.message)}</div></div>`;
      return;
    }
    const fw = d.firewall || {};
    const bad = !fw.exists || !d.listening;
    netBody.innerHTML = `
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
        <span class="tag ${d.listening ? 'tag-green' : 'tag-red'}">
          ${d.listening ? '服务在运行' : '服务没在监听'}</span>
        <span class="tag ${fw.exists ? 'tag-green' : 'tag-amber'}">
          ${fw.exists ? '防火墙已放行' : '防火墙未放行'}</span>
        ${(d.profiles || []).map((p) => `<span class="tag ${p.private ? 'tag-green' : 'tag-amber'}">
          ${ui.esc(p.name || '网络')}·${ui.esc(p.category || '未知')}</span>`).join('')}
      </div>
      ${(d.hints || []).map((h) => `<div class="banner ${bad ? 'banner-warn' : 'banner-ok'}"
          style="margin-bottom:8px">${ui.icon(bad ? 'alert' : 'check', 15)}<div>${ui.esc(h)}</div></div>`).join('')}
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn ${fw.exists ? '' : 'btn-primary'}" id="fw-open">
          ${ui.icon('shield', 14)} ${fw.exists ? '重新放行端口' : '一键放行端口'}</button>
        <span class="hint">会弹一次系统权限确认，点「是」即可。</span>
      </div>`;

    netBody.querySelector('#fw-open').onclick = async () => {
      const btn = netBody.querySelector('#fw-open');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin dark"></span> 等待确认…';
      try {
        const r = await post('/api/system/firewall/open', { port: acc.port });
        if (r.ok) ui.toast('已放行，可以让同学再试一次', 'ok');
        else ui.toast(r.detail || '没有成功，可能取消了权限弹窗', 'err', 6000);
      } catch (e) {
        ui.toast(e.message, 'err');
      }
      loadNet();
    };
  }
  pane.querySelector('#recheck').onclick = loadNet;
  loadNet();
}

// ---------------------------------------------------------------- 存储

function storage(pane, info) {
  const rows = [
    { t: '数据目录', d: '数据库、图片、导出包都在这里', v: info.data_dir },
    { t: '项目目录', d: '每个项目一个子目录，项目号即目录名', v: info.projects_dir },
    { t: '导出目录', d: '导出生成的 zip 包', v: info.exports_dir },
    { t: '模型目录', d: '模型库读写的目录，换模型直接替换文件', v: info.models_dir },
    { t: '程序目录', d: info.frozen ? 'exe 所在目录，程序自身文件' : '源码目录（开发模式）', v: info.app_dir },
  ];
  pane.innerHTML = `
    <div class="set-grid">
      <div class="card span2">
        <div class="card-head"><h3>存储位置</h3>
          <span class="hint">${info.frozen ? '打包版：数据跟着 exe 走' : '开发模式：数据在源码目录下'}</span></div>
        <div class="card-body">
          ${rows.map((r, i) => `
            <div style="margin-bottom:12px">
              <div class="row-between" style="margin-bottom:4px">
                <span style="font-size:12.5px;font-weight:550">${r.t}</span>
                <span class="hint">${r.d}</span>
              </div>
              <div class="path-row">
                <span class="p" title="${ui.esc(r.v)}">${ui.esc(r.v)}</span>
                <button class="btn btn-sm" data-copy-path="${i}">复制</button>
                ${isLocal() ? `<button class="btn btn-sm" data-open-path="${ui.esc(r.v)}">打开</button>` : ''}
              </div>
            </div>`).join('')}
          <div class="banner banner-info" style="margin-top:4px">${ui.icon('info', 15)}
            <div>备份就是把「数据目录」整个拷走，图和库都在里面。
            不要用同步盘实时同步 <b>.db</b> 文件，容易写坏。</div></div>
        </div>
      </div>
    </div>`;

  pane.querySelectorAll('[data-copy-path]').forEach((b) => {
    b.onclick = () => {
      const v = rows[Number(b.dataset.copyPath)].v;
      navigator.clipboard.writeText(v)
        .then(() => ui.toast('路径已复制', 'ok'))
        .catch(() => ui.toast('复制失败，请手动选中', 'err'));
    };
  });
  pane.querySelectorAll('[data-open-path]').forEach((b) => {
    b.onclick = async () => {
      try {
        await post('/api/system/reveal', { path: b.dataset.openPath });
      } catch (e) { ui.toast(e.message, 'err'); }
    };
  });
}

// ---------------------------------------------------------------- 状态

function status(pane, info, acc) {
  pane.innerHTML = `
    <div class="set-grid">
      <div class="card">
        <div class="card-head"><h3>运行状态</h3></div>
        <div class="card-body" style="padding:0">
          <table class="table">
            <tr><td style="color:var(--text-3);width:110px">版本</td><td class="num">v${ui.esc(info.version)}</td></tr>
            <tr><td style="color:var(--text-3)">端口</td><td class="num">${acc.port || ''}</td></tr>
            <tr><td style="color:var(--text-3)">在线账号</td><td class="num">${info.online}</td></tr>
            <tr><td style="color:var(--text-3)">标注锁超时</td><td class="num">${info.lock_ttl} 秒</td></tr>
            <tr><td style="color:var(--text-3)">自动保存间隔</td><td class="num">${info.autosave} 秒</td></tr>
            <tr><td style="color:var(--text-3)">运行方式</td><td>${info.frozen ? '打包 exe' : '源码'}</td></tr>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>磁盘占用</h3></div>
        <div class="card-body">
          ${info.disk && info.disk.total ? `
            <div class="row-between" style="font-size:12.5px;color:var(--text-2);margin-bottom:6px">
              <span>已用 ${ui.fmtBytes(info.disk.used)}</span>
              <span>共 ${ui.fmtBytes(info.disk.total)}</span></div>
            <div class="bar" style="height:8px"><i style="width:${Math.round(info.disk.used / info.disk.total * 100)}%"></i></div>
            <div class="hint" style="margin-top:8px">剩余 ${ui.fmtBytes(info.disk.free)}。
            导出包与标注缩略图都算在数据目录里。</div>`
            : '<div class="hint">读不到磁盘信息。</div>'}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 须知

function notes(pane) {
  pane.innerHTML = `
    <div class="set-grid">
      <div class="card">
        <div class="card-head"><h3>服务端须知</h3></div>
        <div class="card-body" style="font-size:12.5px;line-height:1.9;color:var(--text-2)">
          <p><b>这台机器要一直开着。</b>关机或睡眠时别人就连不上。</p>
          <p style="margin-top:8px"><b>只在局域网内使用。</b>不要把端口映射到公网，
          这套程序没有为公网做过安全加固。</p>
          <p style="margin-top:8px"><b>别用同步盘同步数据库。</b>数据目录里的 .db 只能被本程序写。</p>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>协作约定</h3></div>
        <div class="card-body" style="font-size:12.5px;line-height:1.9;color:var(--text-2)">
          <p><b>一张图同一时刻只有一个人能标。</b>别人正在标的图会显示占用者，标完点「完成」才释放。</p>
          <p style="margin-top:8px"><b>类别由项目统一维护。</b>个人不要自行改名，同物异名会让导出对不上。</p>
          <p style="margin-top:8px"><b>自动保存 30 秒一次。</b>切图、完成时也会保存，不必手动点。</p>
        </div>
      </div>
    </div>`;
}
