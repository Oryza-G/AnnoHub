// 导入页：① 导入已经裁好的图片 ② 导入别人标好的标注文件
import { post, pollJob } from './api.js';
import * as ui from './ui.js';
import { pickFolder, pickFiles } from './dialogs.js';

const FORMATS = [
  { v: 'auto', t: '自动识别' },
  { v: 'yolo', t: 'YOLO txt（每图一个 txt）' },
  { v: 'voc', t: 'Pascal VOC xml' },
  { v: 'coco', t: 'COCO json' },
  { v: 'labelme', t: 'LabelMe json' },
  { v: 'csv', t: 'CSV 表格' },
];

const FORMAT_CN = {
  yolo: 'YOLO txt', voc: 'Pascal VOC xml', coco: 'COCO json',
  labelme: 'LabelMe json', csv: 'CSV',
};

export async function renderImportTab(root, proj, ctx, reload) {
  let imgRoot = '';
  let imgFiles = [];
  let labRoot = '';
  let labFiles = [];
  let preview = null;

  root.innerHTML = `
    <div class="banner banner-info" style="margin-bottom:16px">
      ${ui.icon('info', 16)}
      <div>这里导入两类数据：<b>已经裁好的图片</b>（无需再切），以及<b>已有标注</b>
      （YOLO / VOC / COCO / LabelMe / CSV 均可读取）。每次导入单独成组，可整组撤掉重来。</div>
    </div>

    <div class="set-grid">
      <!-- 图片 -->
      <div class="card">
        <div class="card-head"><h3>导入图片</h3>
          <span class="hint">已裁好、可直接标注的图</span></div>
        <div class="card-body">
          <div class="row" style="gap:8px;margin-bottom:10px">
            <button class="btn grow" id="ip-dir">${ui.icon('folderOpen', 15)} 选文件夹</button>
            <button class="btn grow" id="ip-files">${ui.icon('image', 15)} 选图片</button>
          </div>
          <div id="ip-src" class="drop-zone" style="padding:14px">尚未选择。可整目录导入，也可逐张挑选。</div>

          <div class="field" style="margin-top:12px"><label>分组名称</label>
            <input class="input" id="ip-name" placeholder="留空则用文件夹名"></div>
          <div class="row" style="gap:10px">
            <div class="field grow"><label>递归子目录</label>
              <select class="select" id="ip-rec"><option value="1">是</option><option value="0">否</option></select></div>
            <div class="field grow"><label>只读前 N 张（0 = 全部）</label>
              <input class="input" id="ip-max" type="number" value="0"></div>
          </div>
          <div class="hint" style="margin-top:-6px;margin-bottom:12px">
            TIF/BMP 会自动转成 JPEG。内容完全相同的图按哈希跳过，不重复占人力。
            文件统一命名为 <span class="num">组号-原文件名</span>，例如 <span class="num">02-IMG_2041.jpg</span>。</div>
          <div id="ip-out" style="margin-bottom:10px"></div>
          <div class="push-bottom">
            <button class="btn btn-primary" id="ip-go" style="width:100%">开始导入</button>
          </div>
        </div>
      </div>

      <!-- 标注 -->
      <div class="card">
        <div class="card-head"><h3>导入标注</h3>
          <span class="hint">把已有标注写到图上去</span></div>
        <div class="card-body">
          <div class="row" style="gap:8px;margin-bottom:10px">
            <button class="btn grow" id="lb-dir">${ui.icon('folderOpen', 15)} 选文件夹</button>
            <button class="btn grow" id="lb-files">${ui.icon('tag', 15)} 选文件</button>
          </div>
          <div id="lb-src" class="drop-zone" style="padding:14px">尚未选择。指向标注文件所在目录，或单个 json / csv。</div>

          <div class="row" style="gap:10px;margin-top:12px">
            <div class="field grow"><label>格式</label>
              <select class="select" id="lb-fmt">
                ${FORMATS.map((f) => `<option value="${f.v}">${f.t}</option>`).join('')}
              </select></div>
            <div class="field grow"><label>已有标注如何处理</label>
              <select class="select" id="lb-mode">
                <option value="merge">合并（重复项跳过）</option>
                <option value="replace">替换（先清空该图）</option>
              </select></div>
          </div>
          <div class="field"><label>类别名（可留空，自动从 classes.txt / yaml 读取）</label>
            <input class="input" id="lb-cls" placeholder="${ui.esc((proj.labels || []).join(', '))}"></div>

          <div id="lb-prev-out" style="margin-bottom:10px"></div>
          <div id="lb-out" style="margin-bottom:10px"></div>
          <div class="row push-bottom" style="gap:8px">
            <button class="btn" id="lb-prev">预检</button>
            <button class="btn btn-primary grow" id="lb-go">开始导入</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>标注与图片的配对规则</h3></div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--text-2);line-height:1.9">
          程序按<b>文件名</b>配对，会忽略目录、扩展名，以及导出时自动加的 4~8 位编号前缀。
          所以 <span class="num">rice_0001.jpg</span>、<span class="num">000012_rice_0001.jpg</span>、
          <span class="num">rice_0001.txt</span> 都认成同一张图。
          COCO json 优先用它自己记录的 file_name。
          对不上的会单独统计，不会静默丢掉。
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);

  // ------------------------------------------------------------ 图片选择
  function drawImgSrc() {
    const box = $('#ip-src');
    if (imgFiles.length) {
      box.classList.remove('drop-zone');
      box.innerHTML = `<div class="row-between" style="margin-bottom:8px">
          <span style="font-size:12.5px;color:var(--text-2)">已选 ${imgFiles.length} 张</span>
          <button class="btn btn-sm btn-ghost" id="ip-clr">清空</button></div>
        <div class="file-chips">${chips(imgFiles)}</div>`;
      box.querySelector('#ip-clr').onclick = () => { imgFiles = []; resetImgBox(); };
    } else if (imgRoot) {
      box.classList.remove('drop-zone');
      box.innerHTML = `<div class="row-between">
          <div style="min-width:0">
            <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;
                 white-space:nowrap" title="${ui.esc(imgRoot)}">${ui.esc(imgRoot)}</div>
            <div class="hint">整个目录连同子目录</div></div>
          <button class="btn btn-sm btn-ghost" id="ip-clr">换一个</button></div>`;
      box.querySelector('#ip-clr').onclick = () => { imgRoot = ''; resetImgBox(); };
    } else resetImgBox();
  }
  function resetImgBox() {
    const box = $('#ip-src');
    box.className = 'drop-zone';
    box.style.padding = '14px';
    box.textContent = '尚未选择。可整目录导入，也可逐张挑选。';
  }

  $('#ip-dir').onclick = async () => {
    const r = await pickFolder({ initial: imgRoot, title: '选择已裁好的图片文件夹' });
    if (!r) return;
    imgRoot = r.path || '';
    imgFiles = [];
    drawImgSrc();
  };
  $('#ip-files').onclick = async () => {
    const r = await pickFiles({ kind: 'image', multi: true, initial: imgRoot });
    if (!r || !r.files.length) return;
    imgFiles = r.files;
    imgRoot = '';
    drawImgSrc();
  };

  $('#ip-go').onclick = async () => {
    if (!imgRoot && !imgFiles.length) return ui.toast('先选文件夹或图片', 'err');
    const out = $('#ip-out');
    out.innerHTML = jobBox('准备中');
    const btn = $('#ip-go');
    btn.disabled = true;
    try {
      const r = await post(`/api/projects/${proj.id}/import/images`, {
        source_root: imgRoot, files: imgFiles,
        batch_name: $('#ip-name').value.trim() || null,
        recursive: $('#ip-rec').value === '1',
        max_images: Number($('#ip-max').value) || 0,
      });
      await runJob(r.job_id, out, (res) => {
        out.innerHTML = `<div class="banner banner-ok">${ui.icon('check', 15)}<div>
          导入 ${res.n_images} 张${res.n_dup ? `，重复跳过 ${res.n_dup} 张` : ''}
          ${res.n_bad ? `，读取失败 ${res.n_bad} 张` : ''}。</div></div>
          <div class="row" style="margin-top:10px">
            <button class="btn btn-sm" id="to-imgs">去图片页看</button></div>`;
        out.querySelector('#to-imgs').onclick = () => ctx.navigate(`/project/${proj.id}/images`);
        reload();
      });
    } catch (e) {
      out.innerHTML = errBox(e.message);
    }
    btn.disabled = false;
  };

  // ------------------------------------------------------------ 标注选择
  function drawLabSrc() {
    const box = $('#lb-src');
    if (labFiles.length) {
      box.classList.remove('drop-zone');
      box.innerHTML = `<div class="row-between" style="margin-bottom:8px">
          <span style="font-size:12.5px;color:var(--text-2)">已选 ${labFiles.length} 个文件</span>
          <button class="btn btn-sm btn-ghost" id="lb-clr">清空</button></div>
        <div class="file-chips">${chips(labFiles)}</div>`;
      box.querySelector('#lb-clr').onclick = () => { labFiles = []; resetLabBox(); };
    } else if (labRoot) {
      box.classList.remove('drop-zone');
      box.innerHTML = `<div class="row-between">
          <div style="min-width:0">
            <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;
                 white-space:nowrap" title="${ui.esc(labRoot)}">${ui.esc(labRoot)}</div>
            <div class="hint">整个目录连同子目录</div></div>
          <button class="btn btn-sm btn-ghost" id="lb-clr">换一个</button></div>`;
      box.querySelector('#lb-clr').onclick = () => { labRoot = ''; resetLabBox(); };
    } else resetLabBox();
  }
  function resetLabBox() {
    const box = $('#lb-src');
    box.className = 'drop-zone';
    box.style.padding = '14px';
    box.textContent = '尚未选择。指向标注文件所在目录，或单个 json / csv。';
  }

  $('#lb-dir').onclick = async () => {
    const r = await pickFolder({ initial: labRoot, title: '选择标注文件所在文件夹' });
    if (!r) return;
    labRoot = r.path || '';
    labFiles = [];
    preview = null;
    $('#lb-prev-out').innerHTML = '';
    drawLabSrc();
  };
  $('#lb-files').onclick = async () => {
    // 只选单个标注文件：COCO 那种一个大 json，或者某个单独的 xml
    const r = await pickFiles({ kind: 'label', multi: false, initial: labRoot });
    if (!r || !r.files.length) return;
    labFiles = r.files;
    labRoot = '';
    preview = null;
    $('#lb-prev-out').innerHTML = '';
    drawLabSrc();
  };

  $('#lb-prev').onclick = async () => {
    if (!labRoot && !labFiles.length) return ui.toast('先选标注所在位置', 'err');
    const out = $('#lb-prev-out');
    out.innerHTML = '<div class="hint">正在识别…</div>';
    try {
      const r = await post(`/api/projects/${proj.id}/import/labels/preview`, {
        source_root: labRoot || labFiles[0], format: $('#lb-fmt').value,
      });
      preview = r;
      const cls = $('#lb-fmt').value === 'auto';
      out.innerHTML = `<div class="banner ${r.n_files ? 'banner-info' : 'banner-warn'}">
        ${ui.icon('info', 15)}<div>
        识别为 <b>${FORMAT_CN[r.format] || r.format}</b>，找到 <b>${r.n_files}</b> 个标注文件。
        项目里现有 ${r.n_images_in_project} 张图可用于配对。
        ${!r.n_files ? '<br>没找到标注文件，可能是格式选错了，或者目录里确实没有。' : ''}
        ${cls ? '' : '<br>格式是你手动指定的，如果识别结果不对，改回「自动识别」再试。'}
        </div></div>`;
      if (cls) $('#lb-fmt').value = r.format;
    } catch (e) {
      out.innerHTML = errBox(e.message);
    }
  };

  $('#lb-go').onclick = async () => {
    if (!labRoot && !labFiles.length) return ui.toast('先选标注所在位置', 'err');
    const cls = $('#lb-cls').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    const out = $('#lb-out');
    out.innerHTML = jobBox('准备中');
    const btn = $('#lb-go');
    btn.disabled = true;
    try {
      const r = await post(`/api/projects/${proj.id}/import/labels`, {
        source_root: labRoot || labFiles[0],
        format: $('#lb-fmt').value,
        classes: cls,
        mode: $('#lb-mode').value,
      });
      await runJob(r.job_id, out, (res) => {
        out.innerHTML = `<div class="banner ${res.n_matched ? 'banner-ok' : 'banner-warn'}">
          ${ui.icon(res.n_matched ? 'check' : 'alert', 15)}<div>
          导入 <b>${res.n_labels}</b> 条标注，命中 <b>${res.n_matched}</b> 张图。
          ${res.n_unmatched ? `<br>有 ${res.n_unmatched} 个标注文件没对上任何图片，检查文件名是否和图片一致。` : ''}
          ${res.n_skipped ? `<br>${res.n_skipped} 条因为重复或坐标无效被跳过。` : ''}
          </div></div>
          <div class="row" style="margin-top:10px">
            <button class="btn btn-sm" id="to-imgs2">去图片页看</button></div>`;
        out.querySelector('#to-imgs2').onclick = () => ctx.navigate(`/project/${proj.id}/images`);
        reload();
      });
    } catch (e) {
      out.innerHTML = errBox(e.message);
    }
    btn.disabled = false;
  };

  drawImgSrc();
  drawLabSrc();
}

function chips(files) {
  const list = files.slice(0, 40).map((f) => `<span class="file-chip">
    <span>${ui.esc(f.split(/[\\/]/).pop())}</span></span>`).join('');
  return list + (files.length > 40
    ? `<span class="file-chip"><span>…还有 ${files.length - 40} 个</span></span>` : '');
}

function jobBox(msg) {
  return `<div class="row-between" style="margin-bottom:6px">
      <span class="hint" data-jmsg>${ui.esc(msg)}…</span>
      <span class="num" style="font-size:12px" data-jpct>0%</span></div>
    <div class="bar"><i data-jbar style="width:0"></i></div>`;
}

async function runJob(jobId, host, onDone) {
  const j = await pollJob(jobId, (st) => {
    const bar = host.querySelector('[data-jbar]');
    if (!bar) return;
    bar.style.width = st.progress + '%';
    host.querySelector('[data-jpct]').textContent = Math.round(st.progress) + '%';
    host.querySelector('[data-jmsg]').textContent = st.message || '';
  });
  if (j.status === 'done') onDone(j.result || {});
  else if (j.status === 'cancelled') host.innerHTML = errBox('已取消');
  else host.innerHTML = errBox(j.message || '失败了');
}

function errBox(msg) {
  return `<div class="banner banner-err">${ui.icon('alert', 15)}<div>${ui.esc(msg)}</div></div>`;
}
