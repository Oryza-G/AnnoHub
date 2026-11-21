// 路径选择：优先弹系统自带的文件对话框，非本机访问时退回网页内浏览器。
//
// 为什么分两条路：系统对话框弹在服务端那台电脑上，同学从自己电脑用浏览器
// 访问时看不到、也不该看到。所以只有本机访问才走 native，其他一律网页内选。
import { get, post } from './api.js';
import * as ui from './ui.js';

export function isLocalHost() {
  const h = (location.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

// 返回 { path, files } 或 null（用户取消）
export async function pickFolder({ initial = '', title = '选择文件夹' } = {}) {
  if (isLocalHost()) {
    try {
      const r = await post('/api/system/pick-folder', { initial });
      if (r && r.path) return { path: r.path, files: [] };
      if (r && typeof r.path === 'string' && !r.path) return null;   // 取消了
    } catch (e) {
      if (e.status === 409) { ui.toast(e.message, 'err'); return null; }
      // 其他错误（无 GUI 等）静默退回网页浏览器
    }
  }
  return browseModal(initial, { mode: 'dir', title });
}

// kind: image | model | label | any
export async function pickFiles({ kind = 'image', multi = true, initial = '', title = '选择文件' } = {}) {
  if (isLocalHost()) {
    try {
      const r = await post('/api/system/pick-files', { kind, multi, initial });
      if (r && r.files && r.files.length) return { path: '', files: r.files };
      return null;
    } catch (e) {
      if (e.status === 409) { ui.toast(e.message, 'err'); return null; }
    }
  }
  const extMap = { image: 'jpg,jpeg,png,bmp,tif,tiff,webp', model: 'onnx', label: 'txt,xml,json,csv', any: '' };
  return browseModal(initial, { mode: 'files', ext: extMap[kind] || '', title, multi });
}

/**
 * 网页内文件浏览器。
 * mode = 'dir'  只选目录（按钮「用这个目录」）
 *      = 'files' 选文件（按钮「用选中的 N 个文件」，multi=false 时单选）
 */
export function browseModal(start, { mode = 'dir', ext = '', title = '选择文件夹', multi = true } = {}) {
  return new Promise((resolve) => {
    let cur = start || '';
    let picked = new Set();
    let fileMap = new Map();

    const m = ui.openModal({
      title,
      wide: true,
      body: `<div style="margin-bottom:10px">
          <div class="row">
            <button class="btn btn-sm" id="up" title="上一级">${ui.icon('arrowLeft', 14)}</button>
            <input class="input grow" id="cur" readonly placeholder="选择一个磁盘">
          </div>
        </div>
        <div class="dir-list" id="dl" style="max-height:210px"></div>
        <div id="fwrap" style="margin-top:12px"></div>
        <div class="hint" id="dhint" style="margin-top:8px"></div>`,
      actions: [
        { label: '取消', onClick: () => { m.close(); resolve(null); } },
        {
          label: mode === 'files' ? '用选中的文件' : '用这个目录',
          primary: true,
          onClick: () => {
            if (mode === 'files') {
              if (!picked.size) { ui.toast('先勾选要用的文件', 'err'); return false; }
              m.close();
              resolve({ path: '', files: [...picked] });
              return;
            }
            m.close();
            resolve({ path: cur || null, files: [] });
          },
        },
      ],
      onMount: (body) => {
        const dl = body.querySelector('#dl');
        const fwrap = body.querySelector('#fwrap');
        const curInput = body.querySelector('#cur');
        const hint = body.querySelector('#dhint');
        const upBtn = body.querySelector('#up');
        const footBtn = body.parentElement.querySelector('.modal-foot .btn-primary');

        async function load(p) {
          cur = p;
          picked = new Set();
          fileMap = new Map();
          curInput.value = p || '（磁盘列表）';
          dl.innerHTML = '<div class="empty" style="padding:18px"><div class="spin dark" style="margin:0 auto"></div></div>';
          fwrap.innerHTML = '';
          try {
            const qs = new URLSearchParams();
            if (p) qs.set('path', p);
            if (ext) qs.set('ext', ext);
            const d = await get('/api/browse' + (qs.toString() ? `?${qs}` : ''));
            cur = d.path || '';
            curInput.value = cur || '（磁盘列表）';

            const rows = [];
            if (d.quick) {
              rows.push(...d.quick.map((x) => `<div class="dir-item" data-p="${ui.esc(x.path)}">
                ${ui.icon('folder', 14)}<span>${ui.esc(x.name)}</span>
                <span class="hint" style="margin-left:auto">${ui.esc(x.path)}</span></div>`));
              rows.push('<div style="height:1px;background:var(--border);margin:4px 0"></div>');
            }
            rows.push(...(d.dirs || []).map((x) => `<div class="dir-item" data-p="${ui.esc(x.path)}">
              ${ui.icon('folderOpen', 14)}<span>${ui.esc(x.name)}</span>
              <span class="hint" style="margin-left:auto">进入</span></div>`));
            dl.innerHTML = rows.join('') || '<div class="empty" style="padding:18px">这个目录下没有子目录</div>';
            dl.querySelectorAll('[data-p]').forEach((el) => { el.onclick = () => load(el.dataset.p); });

            // 文件区
            if (d.files && d.files.length) {
              (d.files || []).forEach((f) => fileMap.set(f.path, f));
              fwrap.innerHTML = `
                <div class="row-between" style="margin-bottom:6px">
                  <span class="hint">这个目录里有 ${d.n_files || d.files.length} 个${ext ? '匹配' : '图片'}文件
                    ${d.n_files > d.files.length ? `（只列出前 ${d.files.length} 个）` : ''}</span>
                  <div class="row" style="gap:6px">
                    ${multi ? '<button class="btn btn-sm" id="f-all">全选</button>' : ''}
                    <button class="btn btn-sm" id="f-none">清空</button>
                  </div>
                </div>
                <div class="dir-list" style="max-height:190px" id="fl">
                  ${d.files.map((f) => `
                    <label class="dir-item" data-f="${ui.esc(f.path)}" style="cursor:pointer">
                      <input type="checkbox" style="margin:0">
                      ${ui.icon('image', 13)}
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ui.esc(f.name)}</span>
                      <span class="hint" style="margin-left:auto;font-family:var(--mono)">${ui.fmtBytes(f.size)}</span>
                    </label>`).join('')}
                </div>`;
              const fl = fwrap.querySelector('#fl');
              fl.querySelectorAll('[data-f]').forEach((el) => {
                const cb = el.querySelector('input');
                el.addEventListener('click', (e) => {
                  if (e.target !== cb) cb.checked = !cb.checked;
                  if (cb.checked) {
                    if (!multi) {
                      picked.clear();
                      fl.querySelectorAll('[data-f]').forEach((o) => {
                        if (o !== el) { o.querySelector('input').checked = false; o.classList.remove('sel'); }
                      });
                    }
                    picked.add(el.dataset.f);
                  } else {
                    picked.delete(el.dataset.f);
                  }
                  el.classList.toggle('sel', cb.checked);
                  sync();
                });
              });
              const allBtn = fwrap.querySelector('#f-all');
              if (allBtn) allBtn.onclick = () => {
                fl.querySelectorAll('[data-f]').forEach((el) => {
                  el.querySelector('input').checked = true;
                  el.classList.add('sel');
                  picked.add(el.dataset.f);
                });
                sync();
              };
              fwrap.querySelector('#f-none').onclick = () => {
                fl.querySelectorAll('[data-f]').forEach((el) => {
                  el.querySelector('input').checked = false;
                  el.classList.remove('sel');
                });
                picked.clear();
                sync();
              };
            } else if (mode === 'files' && cur) {
              fwrap.innerHTML = `<div class="hint">这个目录里没有${ext ? ' ' + ext.split(',').join(' / ') : '图片'}文件</div>`;
            }

            hint.textContent = cur
              ? (mode === 'files'
                ? '进到文件所在目录，勾选文件；也可以直接点「用这个目录」把整个目录交给程序扫描。'
                : '当前目录会连同子目录一起扫描。确认后点右下角。')
              : '先选一个磁盘，再逐级进入目标目录';
            upBtn.disabled = !d.parent && !d.path;
            upBtn.onclick = () => load(d.parent || '');
            sync();
          } catch (e) {
            dl.innerHTML = `<div class="banner banner-err" style="margin:8px">${ui.icon('alert', 15)}
              <div>${ui.esc(e.message)}</div></div>`;
          }
        }

        function sync() {
          if (!footBtn) return;
          if (mode === 'files') {
            footBtn.textContent = picked.size ? `用选中的 ${picked.size} 个` : '用选中的文件';
          }
        }

        load(cur);
      },
    });
  });
}
