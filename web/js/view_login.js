// 登录 / 自助注册
import { get, post } from './api.js';
import * as ui from './ui.js';

export function renderLogin(container, { onDone }) {
  let mode = 'login';
  let pub = { allow_register: true, need_approval: false, note: '', version: '' };

  container.innerHTML = `
    <div class="login-card">
      <div class="brand">
        <div class="brand-mark"><img src="/assets/logo.png" alt=""></div>
        <div>
          <div class="brand-name">AnnoHub</div>
          <div class="brand-sub">标注台</div>
        </div>
      </div>
      <div class="seg" id="seg">
        <button data-m="login" class="on">登录</button>
        <button data-m="register">注册账号</button>
      </div>
      <h2 id="ttl">欢迎回来</h2>
      <div class="sub" id="sub">用已有账号进入标注平台</div>
      <form id="lf" autocomplete="on">
        <div class="field" id="f-name" style="display:none">
          <label>显示名字</label>
          <input class="input" id="dn" placeholder="同学看到的名字，可留空" autocomplete="nickname">
        </div>
        <div class="field">
          <label>账号</label>
          <input class="input" id="u" autocomplete="username" placeholder="3~24 位字母数字" required>
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" id="p" type="password" autocomplete="current-password" placeholder="至少 6 位" required>
        </div>
        <div class="field" id="f-p2" style="display:none">
          <label>再输一次密码</label>
          <input class="input" id="p2" type="password" autocomplete="new-password" placeholder="确认密码">
        </div>
        <div id="err" class="banner banner-err" style="display:none;margin-bottom:12px"></div>
        <div id="ok" class="banner banner-ok" style="display:none;margin-bottom:12px"></div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%;margin-top:2px" id="go">进入</button>
      </form>
      <div class="hint" id="foot" style="margin-top:16px;text-align:center">
        首次使用可用内置管理员登录：<b>admin / admin123</b>（登录后请立即改密码）
        <div style="margin-top:6px">忘记管理员密码：在运行本程序的那台电脑上打开命令提示符，
          执行 <span class="num">AnnoHub.exe --reset-admin</span></div>
      </div>
    </div>`;

  const $ = (s) => container.querySelector(s);
  const form = $('#lf');
  const errBox = $('#err');
  const okBox = $('#ok');
  const btn = $('#go');

  function applyMode() {
    const isReg = mode === 'register';
    $('#seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    $('#ttl').textContent = isReg ? '创建账号' : '欢迎回来';
    $('#sub').textContent = isReg
      ? (pub.allow_register ? '填个账号密码就能一起标了' : '管理员已关闭自助注册')
      : '用已有账号进入标注平台';
    $('#f-name').style.display = isReg ? '' : 'none';
    $('#f-p2').style.display = isReg ? '' : 'none';
    btn.textContent = isReg ? '注册并进入' : '进入';
    errBox.style.display = 'none';
    okBox.style.display = 'none';
    if (isReg) {
      btn.disabled = !pub.allow_register;
      $('#foot').innerHTML = pub.note ? ui.esc(pub.note)
        : '注册后%s'.replace('%s', pub.need_approval ? '需管理员审批，通过后才能登录' : '立即可以使用');
    } else {
      btn.disabled = false;
      $('#foot').innerHTML = pub.allow_register
        ? '没有账号？点上面的「注册账号」自己建一个'
        : '账号由管理员统一创建';
    }
    $('#p').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    setTimeout(() => (isReg ? $('#u') : $('#u')).focus(), 40);
  }

  $('#seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (!b || b.dataset.m === mode) return;
    mode = b.dataset.m;
    applyMode();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.style.display = 'none';
    okBox.style.display = 'none';
    const username = $('#u').value.trim();
    const password = $('#p').value;

    if (mode === 'register') {
      if (!$('#p2').value) return fail('请再输一次密码');
      if ($('#p2').value !== password) return fail('两次输入的密码不一样');
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span> ${mode === 'register' ? '注册中' : '登录中'}`;
    try {
      if (mode === 'register') {
        const r = await post('/api/auth/register', {
          username, password, display_name: $('#dn').value.trim(),
        });
        if (r.need_approval) {
          mode = 'login';
          applyMode();
          okBox.textContent = r.message;
          okBox.style.display = 'flex';
          btn.disabled = false;
          btn.textContent = '进入';
          return;
        }
        okBox.textContent = '注册成功，正在进入…';
        okBox.style.display = 'flex';
      }
      const r = await post('/api/auth/login', { username, password });
      if (r.user.must_change) ui.toast('建议在左下角菜单里改一下密码', '', 4200);
      onDone();
    } catch (err) {
      fail(err.message);
    }
  });

  function fail(msg) {
    errBox.textContent = msg;
    errBox.style.display = 'flex';
    btn.disabled = false;
    btn.textContent = mode === 'register' ? '注册并进入' : '进入';
    return false;
  }

  // 拉公开配置，决定是否显示注册入口
  get('/api/auth/public')
    .then((r) => {
      pub = { ...pub, ...r };
      if (!pub.allow_register) {
        const seg = $('#seg');
        seg.style.display = 'none';
      }
      applyMode();
    })
    .catch(() => applyMode());
}
