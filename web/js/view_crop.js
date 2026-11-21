// 裁切页：选源图 → 调参数 → 预演 → 执行。裁切只管裁切，不判空图、不存波段。
import { post, pollJob } from './api.js';
import * as ui from './ui.js';
import { pickFolder, pickFiles } from './dialogs.js';

export async function renderCropTab(root, proj, ctx, reload) {
  let sourceRoot = '';
  let sourceFiles = [];
  let plan = null;

  root.innerHTML = `
    <div class="banner banner-info" style="margin-bottom:16px">
      ${ui.icon('info', 16)}
      <div>把大图按固定尺寸切成小图。<b>边缘块贴边对齐，不会把画面边缘的窄条丢掉</b>。
      裁出来的图会单独成一组，在「图片」页左侧能看到，不满意整组删掉重切即可。</div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,392px) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card">
        <div class="card-head"><h3>源图</h3></div>
        <div class="card-body">
          <div class="row" style="gap:8px;margin-bottom:10px">
            <button class="btn grow" id="pick-dir">${ui.icon('folderOpen', 15)} 选文件夹</button>
            <button class="btn grow" id="pick-files">${ui.icon('image', 15)} 选图片</button>
          </div>
          <div id="src-box" class="drop-zone" style="padding:14px">
            尚未选择源图。可指定一个文件夹（含子目录），也可逐张挑选。
          </div>
          <div class="field" style="margin-top:12px;margin-bottom:0">
            <label>分组名称</label>
            <input class="input" id="bname" placeholder="留空则用文件夹名">
            <div class="hint" style="margin-top:4px">分组名称显示在「图片」页左侧，用来区分不同日期的航拍。
              切出来的图片统一命名为 <span class="num">组号-源图名-r行c列</span>，例如
              <span class="num">03-DJI_0021-r002c005.jpg</span>，按文件名排序即按组、按源图、按行列排列。</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>裁切参数</h3>
          <span class="hint" id="fp"></span></div>
        <div class="card-body">
          <div class="row" style="gap:10px">
            <div class="field grow"><label>小图宽（像素）</label><input class="input" id="tw" type="number" value="640"></div>
            <div class="field grow"><label>小图高（像素）</label><input class="input" id="th" type="number" value="640"></div>
            <div class="field grow"><label>输出格式</label>
              <select class="select" id="fmt">
                <option value="jpg">JPG（体积小）</option>
                <option value="png">PNG（无损）</option>
              </select></div>
          </div>
          <div class="row" style="gap:10px">
            <div class="field grow"><label>JPG 质量</label><input class="input" id="q" type="number" value="95"></div>
            <div class="field grow"><label>横向重叠（像素）</label><input class="input" id="ox" type="number" value="128"></div>
            <div class="field grow"><label>纵向重叠（像素）</label><input class="input" id="oy" type="number" value="128"></div>
          </div>
          <div class="hint" style="margin:-6px 0 12px">重叠 128 像素相当于 20%。重叠越小张数越少，
            但目标被切断的概率越高；密集小目标建议 15%~25%。PNG 无损但体积约为 JPG 的 3~8 倍。</div>
          <div class="row" style="gap:10px">
            <div class="field grow" style="margin-bottom:0"><label>只读前 N 张源图（0 = 全部）</label>
              <input class="input" id="mx" type="number" value="0"></div>
            <div class="field grow" style="margin-bottom:0"><label>递归子目录</label>
              <select class="select" id="rec"><option value="1">是</option><option value="0">否</option></select></div>
          </div>
          <div class="row" style="margin-top:16px">
            <button class="btn grow" id="plan-btn">预演</button>
            <button class="btn btn-primary grow" id="run-btn" disabled>开始裁切</button>
          </div>
        </div>
      </div>
    </div>

    <div id="result" style="margin-top:16px"></div>`;

  const $ = (s) => root.querySelector(s);
  const result = $('#result');
  const runBtn = $('#run-btn');
  const srcBox = $('#src-box');

  result.innerHTML = `<div class="card"><div class="empty">${ui.icon('scissors', 30)}
    <h4>选择源图后开始预演</h4>
    <p>预演只读取尺寸并抽样检查边缘，不改动任何文件，参数可反复调整。</p></div></div>`;

  function drawSource() {
    if (sourceFiles.length) {
      srcBox.classList.remove('drop-zone');
      srcBox.innerHTML = `
        <div class="row-between" style="margin-bottom:8px">
          <span style="font-size:12.5px;color:var(--text-2)">已选 ${sourceFiles.length} 张图片</span>
          <button class="btn btn-sm btn-ghost" id="clr">清空</button>
        </div>
        <div class="file-chips">
          ${sourceFiles.slice(0, 60).map((f) => `<span class="file-chip">
            ${ui.icon('image', 12)}<span>${ui.esc(f.split(/[\\/]/).pop())}</span></span>`).join('')}
          ${sourceFiles.length > 60 ? `<span class="file-chip"><span>…还有 ${sourceFiles.length - 60} 张</span></span>` : ''}
        </div>`;
      srcBox.querySelector('#clr').onclick = () => {
        sourceFiles = [];
        srcBox.className = 'drop-zone';
        srcBox.style.padding = '14px';
        srcBox.textContent = '尚未选择源图。可指定一个文件夹（含子目录），也可逐张挑选。';
        resetPlan();
      };
    } else if (sourceRoot) {
      srcBox.classList.remove('drop-zone');
      srcBox.innerHTML = `
        <div class="row-between">
          <div style="min-width:0">
            <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;
                 white-space:nowrap" title="${ui.esc(sourceRoot)}">${ui.esc(sourceRoot)}</div>
            <div class="hint">这个目录连同子目录一起扫描</div>
          </div>
          <button class="btn btn-sm btn-ghost" id="clr">换一个</button>
        </div>`;
      srcBox.querySelector('#clr').onclick = () => {
        sourceRoot = '';
        srcBox.className = 'drop-zone';
        srcBox.style.padding = '14px';
        srcBox.textContent = '尚未选择源图。可指定一个文件夹（含子目录），也可逐张挑选。';
        resetPlan();
      };
    } else {
      srcBox.className = 'drop-zone';
      srcBox.style.padding = '14px';
      srcBox.textContent = '尚未选择源图。可指定一个文件夹（含子目录），也可逐张挑选。';
    }
  }

  function resetPlan() {
    plan = null;
    runBtn.disabled = true;
    result.innerHTML = `<div class="card"><div class="empty">${ui.icon('scissors', 30)}
      <h4>选择源图后开始预演</h4>
      <p>预演只读取尺寸并抽样检查边缘，不改动任何文件，参数可反复调整。</p></div></div>`;
  }

  $('#pick-dir').onclick = async () => {
    const r = await pickFolder({ initial: sourceRoot, title: '选择源图文件夹' });
    if (!r) return;
    sourceRoot = r.path || '';
    sourceFiles = [];
    drawSource();
    resetPlan();
  };

  $('#pick-files').onclick = async () => {
    const r = await pickFiles({ kind: 'image', multi: true, initial: sourceRoot });
    if (!r || !r.files.length) return;
    sourceFiles = r.files;
    sourceRoot = '';
    drawSource();
    resetPlan();
  };

  function params() {
    const fmt = $('#fmt').value === 'png' ? 'png' : 'jpg';
    return {
      tile_w: Number($('#tw').value) || 640,
      tile_h: Number($('#th').value) || 640,
      overlap_x: Number($('#ox').value) || 0,
      overlap_y: Number($('#oy').value) || 0,
      max_images: Number($('#mx').value) || 0,
      recursive: $('#rec').value === '1',
      jpeg_quality: Number($('#q').value) || 95,
      out_format: fmt,
    };
  }

  // 选 PNG 时 JPG 质量没意义，直接置灰，避免让人以为它还在起作用
  $('#fmt').onchange = () => {
    const isPng = $('#fmt').value === 'png';
    $('#q').disabled = isPng;
    $('#q').style.opacity = isPng ? '.45' : '1';
    resetPlan();
  };

  $('#plan-btn').onclick = async () => {
    if (!sourceRoot && !sourceFiles.length) return ui.toast('先选源图', 'err');
    const btn = $('#plan-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin dark"></span> 预演中';
    result.innerHTML = `<div class="card"><div class="empty">
      <div class="spin dark" style="margin:0 auto 12px"></div><p>正在读图片尺寸并抽样…</p></div></div>`;
    try {
      plan = await post(`/api/projects/${proj.id}/crop/plan`, {
        source_root: sourceRoot, files: sourceFiles, params: params(),
      });
      drawPlan(plan);
      runBtn.disabled = !plan.n_tiles;
      $('#fp').textContent = plan.fingerprint ? `参数指纹 ${plan.fingerprint}` : '';
    } catch (e) {
      result.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 16)}<div>${ui.esc(e.message)}</div></div>`;
    }
    btn.disabled = false;
    btn.textContent = '预演';
  };

  function drawPlan(p) {
    if (!p.n_sources) {
      result.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 16)}
        <div>没找到可用的图片。${(p.warnings || []).map(ui.esc).join('；')}</div></div>`;
      return;
    }
    const first = (p.per_file || [])[0];
    result.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><h3>预演结果</h3>
          ${p.params.tile_w < 200 ? '<span class="tag tag-amber">小图偏小</span>' : ''}</div>
        <div class="card-body">
          <div class="stat-row" style="margin-bottom:14px">
            <div class="stat"><div class="sl">源图</div><div class="sv">${p.n_sources}<span class="su">张</span></div>
              ${first ? `<div class="hint" style="margin-top:2px;font-size:11px">首张 ${first.width}×${first.height}，切 ${first.nx}×${first.ny}</div>` : ''}</div>
            <div class="stat"><div class="sl">将切出</div><div class="sv">${p.n_tiles}<span class="su">张</span></div></div>
            <div class="stat"><div class="sl">单张尺寸</div><div class="sv" style="font-size:17px">${p.params.tile_w}×${p.params.tile_h}</div></div>
            <div class="stat"><div class="sl">重叠</div><div class="sv" style="font-size:17px">${p.params.overlap_x}<span class="su">/</span>${p.params.overlap_y}</div></div>
          </div>
          ${(p.warnings || []).length ? `<div class="banner banner-warn" style="margin-bottom:12px">
            ${ui.icon('alert', 15)}<div>${p.warnings.map(ui.esc).join('<br>')}</div></div>` : ''}
          <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">
            下面是抽到的 ${p.samples.length} 个块，四个角都抽到了，注意看边缘是否也覆盖到：</div>
          <div class="sample-grid">
            ${p.samples.map((s) => `
              <div class="sample">
                <img src="${s.thumb}" alt="">
                <div class="sm">
                  <span>(${s.x}, ${s.y})</span>
                  <span>${s.edge ? '边缘块' : `${s.w}×${s.h}`}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>
      </div>
      <div class="card"><div class="card-body" style="padding:12px 16px">
        <div class="row" style="font-size:12.5px;color:var(--text-2)">
          ${ui.icon('info', 15)} 确认无误后点「开始裁切」。执行中可以取消，已经切好的会留在项目里。
        </div>
      </div></div>`;
  }

  $('#run-btn').onclick = async () => {
    if (!plan) return;
    const ok = await ui.confirmBox(
      `把 ${plan.n_sources} 张源图切成 ${plan.n_tiles} 张小图，存进项目「${proj.name}」。`,
      { title: '开始裁切', okLabel: '开始' });
    if (!ok) return;
    const btn = $('#run-btn');
    btn.disabled = true;
    try {
      const r = await post(`/api/projects/${proj.id}/crop/run`, {
        source_root: sourceRoot, files: sourceFiles, params: params(),
        batch_name: $('#bname').value.trim() || null,
      });
      result.innerHTML = `<div class="card"><div class="card-head"><h3>裁切中</h3></div>
        <div class="card-body">
          <div class="row-between" style="margin-bottom:8px">
            <span id="jmsg" class="hint">准备中…</span>
            <span id="jpct" class="num" style="font-size:12px">0%</span></div>
          <div class="bar"><i id="jbar" style="width:0"></i></div>
          <div style="margin-top:14px"><button class="btn btn-danger btn-sm" id="jcancel">取消</button></div>
        </div></div>`;
      const cancelBtn = result.querySelector('#jcancel');
      cancelBtn.onclick = async () => {
        await post(`/api/jobs/${r.job_id}/cancel`, {});
        cancelBtn.disabled = true;
        cancelBtn.textContent = '正在停止…';
      };
      const j = await pollJob(r.job_id, (st) => {
        const bar = result.querySelector('#jbar');
        if (!bar) return;
        bar.style.width = st.progress + '%';
        result.querySelector('#jpct').textContent = Math.round(st.progress) + '%';
        result.querySelector('#jmsg').textContent = st.message || '';
      });
      if (j.status === 'done') {
        const res = j.result || {};
        result.innerHTML = `<div class="card"><div class="card-head">
            <h3>完成</h3><span class="tag tag-green">${res.n_images} 张</span></div>
          <div class="card-body">
            <div class="stat-row" style="margin-bottom:14px">
              <div class="stat"><div class="sl">切出</div><div class="sv">${res.n_images}<span class="su">张</span></div></div>
              <div class="stat"><div class="sl">与已有重复跳过</div><div class="sv">${res.n_dup}<span class="su">张</span></div></div>
            </div>
            ${res.n_dup > 0 ? `<div class="banner banner-info" style="margin-bottom:12px">
              ${ui.icon('info', 15)}<div>有 ${res.n_dup} 张与库里已有图片完全一致（sha256 相同），已跳过，不会重复占用人力。</div></div>` : ''}
            <div class="row">
              <button class="btn btn-primary" id="go-annot">去标注</button>
              <button class="btn" id="go-imgs">查看图片</button>
              <div class="grow"></div>
              <a class="btn btn-ghost" href="/api/projects/${proj.id}/batch/${res.batch_id}/manifest" download>下载 manifest</a>
            </div>
          </div></div>`;
        result.querySelector('#go-annot').onclick = () => ctx.navigate(`/project/${proj.id}/annotate`);
        result.querySelector('#go-imgs').onclick = () => ctx.navigate(`/project/${proj.id}/images`);
        reload();
      } else {
        result.innerHTML = `<div class="banner banner-err">${ui.icon('alert', 16)}
          <div>${j.status === 'cancelled' ? '已取消，已切好的图片保留在项目里。' : '失败：' + ui.esc(j.message)}</div></div>`;
        btn.disabled = false;
      }
    } catch (e) {
      ui.toast(e.message, 'err');
      btn.disabled = false;
    }
  };

  drawSource();
}
