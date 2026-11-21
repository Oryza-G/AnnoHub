// 模型库：上传 / 本机导入 / 切换默认 / 测试。检测、分割、分类、关键点、旋转框都能放。
import { get, post, patch, del } from './api.js';
import * as ui from './ui.js';
import { pickFiles } from './dialogs.js';

const TASK = {
  detect: '目标检测', segment: '实例分割', classify: '整图分类',
  keypoint: '关键点', obb: '旋转框',
};

export async function renderModels(page, topbar, { state }) {
  let filter = '';

  topbar.innerHTML = `
    <h1>模型库</h1>
    <div class="grow"></div>
    <button class="btn btn-ghost" id="m-sync">${ui.icon('refresh', 15)} 扫描目录</button>
    <button class="btn" id="m-path">${ui.icon('folderOpen', 15)} 从本机导入</button>
    <button class="btn btn-primary" id="m-up">${ui.icon('upload', 15)} 上传模型</button>`;

  page.innerHTML = `
    <div class="banner banner-info" style="margin-bottom:16px">
      ${ui.icon('info', 16)}
      <div>预标注用的模型都放这里。<b>换模型 = 放一个新 ONNX 并设为默认</b>，
      之后标注页和批量预标注自动用新的。检测、分割、分类、关键点、旋转框都支持，
      项目会按自己的标注方式挑匹配的模型。</div>
    </div>
    <div class="row" style="gap:4px;margin-bottom:14px" id="m-tabs">
      <div class="nav-item active" data-f="" style="height:30px;padding:0 12px;margin:0">全部</div>
      ${Object.entries(TASK).map(([k, v]) => `<div class="nav-item" data-f="${k}"
        style="height:30px;padding:0 12px;margin:0">${v}</div>`).join('')}
    </div>
    <div id="mlist"></div>`;

  const list = page.querySelector('#mlist');
  let models = [];

  page.querySelectorAll('[data-f]').forEach((el) => {
    el.onclick = () => {
      page.querySelectorAll('[data-f]').forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      filter = el.dataset.f;
      draw();
    };
  });

  async function load() {
    list.innerHTML = '<div class="empty"><div class="spin dark"></div></div>';
    const d = await get('/api/models');
    models = d.models;
    draw();
  }

  function draw() {
    const shown = filter ? models.filter((m) => (m.task || 'detect') === filter) : models;
    if (!models.length) {
      list.innerHTML = `<div class="card"><div class="empty">${ui.icon('cpu', 34)}
        <h4>还没有模型</h4>
        <p>放一个 ONNX 进来就能做预标注。手头是 .pt，先用 tools/export_onnx.py 转成 onnx。
        分类模型导出的 onnx 也能直接用。</p>
        <div class="row" style="justify-content:center">
          <button class="btn btn-primary" id="m-up2">${ui.icon('upload', 15)} 上传模型</button>
          <button class="btn" id="m-path2">${ui.icon('folderOpen', 15)} 从本机导入</button>
        </div>
      </div></div>`;
      list.querySelector('#m-up2').onclick = uploadModal;
      list.querySelector('#m-path2').onclick = importFromPath;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="card"><div class="empty">${ui.icon('filter', 30)}
        <h4>这个类别下还没有模型</h4><p>切换到「全部」查看，或上传一个模型。</p></div></div>`;
      return;
    }
    list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(334px,1fr));gap:14px">
      ${shown.map(card).join('')}</div>`;
    bindCards(shown);
  }

  function card(m) {
    return `<div class="card" data-mid="${m.id}">
      <div class="card-body">
        <div class="row-between" style="margin-bottom:8px;gap:8px">
          <div style="font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:6px;min-width:0">
            ${ui.icon('cpu', 15)} <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ui.esc(m.name)}</span>
          </div>
          <div class="row" style="gap:4px;flex:none">
            <span class="task-chip">${TASK[m.task] || '目标检测'}</span>
            ${m.is_default ? '<span class="tag tag-green">默认</span>' : ''}
            ${!m.exists ? '<span class="tag tag-red">文件缺失</span>' : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
          ${(m.classes || []).map((c) => `<span class="tag tag-gray">${ui.esc(c)}</span>`).join('')
            || '<span class="tag tag-amber">未填写类别名</span>'}
        </div>
        <div class="hint" style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin-bottom:10px">
          <span>输入尺寸 <b>${m.imgsz}</b></span>
          <span>大小 <b>${ui.fmtBytes(m.size_bytes)}</b></span>
          <span>被项目引用 <b>${m.n_uses}</b></span>
          <span title="${ui.esc(m.file_name)}">文件 <b>${ui.esc(m.file_name.slice(0, 16))}${m.file_name.length > 16 ? '…' : ''}</b></span>
        </div>
        ${m.note ? `<div class="hint" style="margin-bottom:10px">${ui.esc(m.note)}</div>` : ''}
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm" data-test="${m.id}">${ui.icon('play', 13)} 测试</button>
          <button class="btn btn-sm" data-edit="${m.id}">编辑</button>
          ${!m.is_default ? `<button class="btn btn-sm" data-default="${m.id}">设为默认</button>` : ''}
          <div class="grow"></div>
          <button class="btn btn-sm btn-ghost" data-del="${m.id}" style="color:var(--danger)">删除</button>
        </div>
      </div>
    </div>`;
  }

  function bindCards(shown) {
    const byId = {};
    shown.forEach((m) => { byId[m.id] = m; });

    list.querySelectorAll('[data-default]').forEach((b) => {
      b.onclick = async () => {
        await patch(`/api/models/${b.dataset.default}`, { is_default: true });
        ui.toast('已切换默认模型', 'ok');
        load();
      };
    });
    list.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!await ui.confirmBox('删除模型文件？被项目引用会解除引用。', { danger: true, okLabel: '删除' })) return;
        await del(`/api/models/${b.dataset.del}`);
        ui.toast('已删除', 'ok');
        load();
      };
    });
    list.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const m = byId[b.dataset.edit];
        if (!m) return;
        ui.openModal({
          title: '编辑模型',
          body: `<div class="field"><label>显示名称</label><input class="input" id="mn" value="${ui.esc(m.name)}"></div>
            <div class="field"><label>做什么任务</label>
              <select class="select" id="mtask">
                ${Object.entries(TASK).map(([k, v]) => `<option value="${k}" ${(m.task || 'detect') === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
              <div class="hint" style="margin-top:4px">填错了会导致预标注结果贴上错误的形状，选了框却没有坐标这类问题。</div></div>
            <div class="field"><label>类别名（英文逗号分隔，顺序必须与训练时一致）</label>
              <input class="input" id="mc" value="${ui.esc((m.classes || []).join(', '))}"></div>
            <div class="field"><label>输入尺寸</label><input class="input" id="mi" type="number" value="${m.imgsz}"></div>
            <div class="field"><label>备注</label><input class="input" id="mnote" value="${ui.esc(m.note || '')}"></div>`,
          actions: [
            { label: '取消' },
            {
              label: '保存', primary: true, onClick: async (close, body) => {
                await patch(`/api/models/${m.id}`, {
                  name: body.querySelector('#mn').value.trim(),
                  task: body.querySelector('#mtask').value,
                  classes: body.querySelector('#mc').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                  imgsz: Number(body.querySelector('#mi').value) || 640,
                  note: body.querySelector('#mnote').value.trim(),
                });
                close();
                ui.toast('已保存', 'ok');
                load();
              },
            },
          ],
        });
      };
    });
    list.querySelectorAll('[data-test]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.innerHTML = '<span class="spin dark"></span>';
        try {
          const r = await post(`/api/models/${b.dataset.test}/test`, { conf: 0.25 });
          const isCls = r.samples.length && r.samples[0].geom_type === 'classify';
          ui.openModal({
            title: `测试：${r.model}`,
            body: `<div class="stat-row" style="margin-bottom:12px">
                <div class="stat"><div class="sl">${isCls ? '判定类别' : '检出对象'}</div>
                  <div class="sv">${isCls ? ui.esc(r.samples[0].cls) : r.n}</div></div>
                <div class="stat"><div class="sl">耗时</div><div class="sv">${r.ms}<span class="su">ms</span></div></div>
              </div>
              <div class="hint" style="margin-bottom:8px">用图 #${r.image_id} 测试，前几个结果：</div>
              <div style="font-family:var(--mono);font-size:11.5px;line-height:1.7;
                   background:var(--bg-soft);padding:10px;border-radius:6px;max-height:220px;overflow:auto">
                ${r.samples.map((s) => isCls
                  ? `${ui.esc(s.cls)} ${(s.conf * 100).toFixed(1)}%`
                  : `${ui.esc(s.cls)} ${s.conf.toFixed(3)}  [${Math.round(s.x1)},${Math.round(s.y1)},${Math.round(s.x2)},${Math.round(s.y2)}]`
                ).join('<br>') || '（没有检出）'}
              </div>`,
            actions: [{ label: '关闭', primary: true }],
          });
        } catch (e) {
          ui.toast(e.message, 'err', 5000);
        }
        b.disabled = false;
        b.innerHTML = `${ui.icon('play', 13)} 测试`;
      };
    });
  }

  function taskSelect(id, def = 'detect') {
    return `<select class="select" id="${id}">
      ${Object.entries(TASK).map(([k, v]) => `<option value="${k}" ${def === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>`;
  }

  function uploadModal() {
    ui.openModal({
      title: '上传 ONNX 模型',
      wide: true,
      body: `<div class="field"><label>模型文件（.onnx）</label>
          <input type="file" id="uf" accept=".onnx" class="input" style="height:auto;padding:7px">
          <div class="hint" style="margin-top:4px">文件大（几十 MB）时浏览器上传会慢，可以改用右上角「从本机导入」直接读磁盘。</div></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label>做什么任务</label>${taskSelect('utask')}</div>
          <div class="field grow"><label>输入尺寸</label><input class="input" id="ui2" type="number" value="640"></div>
        </div>
        <div class="field"><label>显示名称</label><input class="input" id="un" placeholder="例如 早稻秧苗 v2 20260701"></div>
        <div class="field"><label>类别名（英文逗号分隔，顺序必须与训练时一致）</label>
          <input class="input" id="uc" placeholder="rice">
          <div class="hint" style="margin-top:4px">顺序错了预标注的类别会错位。分类模型填类别的全集。</div></div>
        <div class="field"><label>备注</label><input class="input" id="unote" placeholder="mAP50 0.82，训练于 2026-06"></div>
        <div class="banner banner-info">${ui.icon('info', 15)}
          <div>手头只有 .pt？在装了 ultralytics 的环境里跑一次：
          <code style="font-family:var(--mono);font-size:11.5px">python tools/export_onnx.py best.pt models 模型名</code></div></div>`,
      actions: [
        { label: '取消' },
        {
          label: '上传', primary: true, onClick: async (close, body) => {
            const f = body.querySelector('#uf').files[0];
            if (!f) { ui.toast('选一个 onnx 文件', 'err'); return false; }
            const fd = new FormData();
            fd.append('file', f);
            fd.append('name', body.querySelector('#un').value.trim());
            fd.append('classes', body.querySelector('#uc').value.trim());
            fd.append('imgsz', body.querySelector('#ui2').value || '640');
            fd.append('task', body.querySelector('#utask').value);
            fd.append('note', body.querySelector('#unote').value.trim());
            const btn = body.closest('.modal').querySelector('.modal-foot .btn-primary');
            btn.disabled = true;
            btn.innerHTML = '<span class="spin"></span> 上传中';
            try {
              const r = await post('/api/models/upload', fd);
              close();
              ui.toast('模型已入库', 'ok');
              if (r.warnings && r.warnings.length) ui.toast(r.warnings[0], '', 5000);
              load();
            } catch (e) {
              ui.toast(e.message, 'err');
              btn.disabled = false;
              btn.textContent = '上传';
            }
          },
        },
      ],
    });
  }

  async function importFromPath() {
    const r = await pickFiles({ kind: 'model', multi: false, title: '选择 ONNX 模型文件' });
    if (!r || !r.files.length) return;
    const path = r.files[0];
    const base = path.split(/[\\/]/).pop().replace(/\.onnx$/i, '');
    ui.openModal({
      title: '导入模型',
      wide: true,
      body: `<div class="field"><label>文件</label>
          <div class="input" style="display:flex;align-items:center;background:var(--bg-soft);
               border-style:dashed;color:var(--text-2);overflow:hidden">${ui.esc(path)}</div></div>
        <div class="row" style="gap:10px">
          <div class="field grow"><label>做什么任务</label>${taskSelect('itask')}</div>
          <div class="field grow"><label>输入尺寸</label><input class="input" id="ii" type="number" value="640"></div>
        </div>
        <div class="field"><label>显示名称</label><input class="input" id="iname" value="${ui.esc(base)}"></div>
        <div class="field"><label>类别名（英文逗号分隔）</label>
          <input class="input" id="ic" placeholder="rice"></div>
        <div class="field"><label>备注</label><input class="input" id="inote" placeholder="可选"></div>`,
      actions: [
        { label: '取消' },
        {
          label: '导入', primary: true, onClick: async (close, body) => {
            const btn = body.closest('.modal').querySelector('.modal-foot .btn-primary');
            btn.disabled = true;
            btn.innerHTML = '<span class="spin"></span> 复制中';
            try {
              await post('/api/models/import-path', {
                path,
                name: body.querySelector('#iname').value.trim(),
                task: body.querySelector('#itask').value,
                imgsz: Number(body.querySelector('#ii').value) || 640,
                classes: body.querySelector('#ic').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
                note: body.querySelector('#inote').value.trim(),
              });
              close();
              ui.toast('模型已入库', 'ok');
              load();
            } catch (e) {
              ui.toast(e.message, 'err');
              btn.disabled = false;
              btn.textContent = '导入';
            }
          },
        },
      ],
    });
  }

  topbar.querySelector('#m-up').onclick = uploadModal;
  topbar.querySelector('#m-path').onclick = importFromPath;
  topbar.querySelector('#m-sync').onclick = async () => {
    const r = await post('/api/models/sync', {});
    ui.toast(r.added ? `新增 ${r.added} 个模型` : '目录里没有新模型', 'ok');
    load();
  };

  await load();
}
