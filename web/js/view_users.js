// 成员管理：自助注册开关、审批、停用、重置密码、删除
import { get, post, patch, del } from './api.js';
import * as ui from './ui.js';

const ROLE = { admin: '管理员', manager: '项目管理员', annotator: '标注员', reviewer: '复核员' };

export async function renderUsers(page, topbar, { state }) {
  topbar.innerHTML = `<h1>成员</h1><div class="grow"></div>
    <button class="btn btn-primary" id="u-add">${ui.icon('userPlus', 15)} 直接建账号</button>`;

  page.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>自助注册</h3><span class="hint">成员自行注册，无需逐个创建</span></div>
      <div class="card-body">
        <label class="row" style="gap:9px;align-items:flex-start;margin-bottom:12px">
          <input type="checkbox" id="r-allow" style="margin-top:3px">
          <span><b style="font-size:12.5px">允许在登录页自助注册</b>
            <div class="hint">关掉之后登录页只显示登录框，账号只能由你在这里创建。</div></span>
        </label>
        <label class="row" style="gap:9px;align-items:flex-start">
          <input type="checkbox" id="r-approval" style="margin-top:3px">
          <span><b style="font-size:12.5px">注册后需要我审批才能登录</b>
            <div class="hint">勾上更稳妥：陌生人注册了也进不来，你在下面点「通过」才生效。</div></span>
        </label>
      </div>
    </div>
    <div id="utable"></div>`;

  const box = page.querySelector('#utable');
  const allowBox = page.querySelector('#r-allow');
  const approvalBox = page.querySelector('#r-approval');
  let pending = 0;

  async function load() {
    const d = await get('/api/users');
    allowBox.checked = !!d.allow_register;
    approvalBox.checked = !!d.need_approval;
    approvalBox.disabled = !d.allow_register;

    const users = d.users;
    const waiting = users.filter((u) => !u.active && u.source === 'self');
    pending = waiting.length;

    box.innerHTML = `
      ${waiting.length ? `<div class="card" style="margin-bottom:16px;border-color:#e7d3ae">
        <div class="card-head"><h3>等待审批</h3>
          <span class="tag tag-amber">${waiting.length} 人</span></div>
        <div class="card-body" style="padding:12px 16px">
          <div class="row" style="gap:10px;flex-wrap:wrap">
            ${waiting.map((u) => `<div class="row" style="gap:8px;padding:7px 11px;
              background:var(--warn-weak);border-radius:8px">
              <div class="avatar" style="background:#f3e2c8">${ui.esc((u.display_name || '?').slice(0, 2))}</div>
              <div>
                <div style="font-size:12.5px;font-weight:600">${ui.esc(u.display_name)}</div>
                <div class="num" style="font-size:11px;color:var(--text-3)">${ui.esc(u.username)} · ${ui.relTime(u.created_at)}</div>
              </div>
              <button class="btn btn-sm btn-primary" data-approve="${u.id}">通过</button>
              <button class="btn btn-sm btn-ghost" data-reject="${u.id}" style="color:var(--danger)">拒绝</button>
            </div>`).join('')}
          </div>
        </div></div>` : ''}

      <div class="card">
        <div class="card-head"><h3>全部账号</h3>
          <span class="hint">共 ${users.length} 个，其中 ${users.filter((u) => u.active).length} 个可用</span></div>
        <div class="card-body" style="padding:0">
          <table class="table">
          <thead><tr><th>成员</th><th>账号</th><th>角色</th><th>状态</th><th>最近在线</th><th class="num">已完成</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td><div class="row" style="gap:8px">
              <div class="avatar">${ui.esc((u.display_name || '?').slice(0, 2))}</div>
              <div>
                <div style="font-weight:550">${ui.esc(u.display_name)}</div>
                ${u.source === 'self' ? '<div class="hint" style="font-size:10.5px">自助注册</div>' : ''}
              </div></div></td>
            <td class="num" style="color:var(--text-2)">${ui.esc(u.username)}</td>
            <td><span class="tag ${u.role === 'admin' ? 'tag-blue' : 'tag-gray'}">${ROLE[u.role] || u.role}</span></td>
            <td>${u.active ? '<span class="tag tag-green">正常</span>' : '<span class="tag tag-red">已停用</span>'}</td>
            <td style="color:var(--text-3)">${u.last_seen ? ui.relTime(u.last_seen) : '—'}</td>
            <td class="num">${u.n_done || 0}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm btn-ghost" data-pwd="${u.id}">重置密码</button>
              ${u.id !== state.user.id ? `
                <button class="btn btn-sm btn-ghost" data-toggle="${u.id}" data-active="${u.active ? 1 : 0}">
                  ${u.active ? '停用' : '启用'}</button>
                <button class="btn btn-sm btn-ghost" data-del="${u.id}" style="color:var(--danger)">删除</button>` : ''}
            </td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;

    box.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = async () => {
        await post(`/api/users/${b.dataset.approve}/approve`, {});
        ui.toast('已通过，对方可以登录了', 'ok');
        load();
      };
    });
    box.querySelectorAll('[data-reject]').forEach((b) => {
      b.onclick = async () => {
        if (!await ui.confirmBox('拒绝申请会直接删掉这个账号。', { danger: true, okLabel: '拒绝并删除' })) return;
        await del(`/api/users/${b.dataset.reject}`);
        ui.toast('已拒绝', 'ok');
        load();
      };
    });
    box.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        await patch(`/api/users/${b.dataset.toggle}`, { active: b.dataset.active !== '1' });
        ui.toast('已更新', 'ok');
        load();
      };
    });
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!await ui.confirmBox('删掉这个账号？他标过的图会保留，但不再显示归属。',
          { danger: true, okLabel: '删除账号' })) return;
        await del(`/api/users/${b.dataset.del}`);
        ui.toast('已删除', 'ok');
        load();
      };
    });
    box.querySelectorAll('[data-pwd]').forEach((b) => {
      b.onclick = () => {
        ui.openModal({
          title: '重置密码',
          body: `<div class="field"><label>新密码（至少 6 位）</label>
            <input class="input" id="np" value="annohub123"></div>
            <div class="hint">把密码告诉对方，登录后建议他自己改一次。</div>`,
          actions: [
            { label: '取消' },
            {
              label: '重置', primary: true, onClick: async (close, body) => {
                const v = body.querySelector('#np').value.trim();
                if (v.length < 6) { ui.toast('至少 6 位', 'err'); return false; }
                await patch(`/api/users/${b.dataset.pwd}`, { password: v });
                close();
                ui.toast('密码已重置', 'ok');
              },
            },
          ],
        });
      };
    });

    // 标题上显示待审数量，方便一眼看到
    const badge = topbar.querySelector('#u-badge');
    if (badge) badge.remove();
    if (pending) {
      topbar.insertAdjacentHTML('afterbegin',
        `<span class="tag tag-amber" id="u-badge" style="margin-left:8px">${pending} 人待审批</span>`);
    }
  }

  allowBox.onchange = async () => {
    await patch('/api/system/registration', { allow_register: allowBox.checked });
    ui.toast(allowBox.checked ? '已开放自助注册' : '已关闭自助注册', 'ok');
    load();
  };
  approvalBox.onchange = async () => {
    await patch('/api/system/registration', { need_approval: approvalBox.checked });
    ui.toast(approvalBox.checked ? '新注册需要审批' : '新注册直接可用', 'ok');
    load();
  };

  topbar.querySelector('#u-add').onclick = () => {
    ui.openModal({
      title: '直接建账号',
      body: `<div class="field"><label>登录账号</label>
          <input class="input" id="nu" placeholder="拼音或工号，登录用"></div>
        <div class="field"><label>显示名字</label><input class="input" id="nd" placeholder="真实姓名"></div>
        <div class="field"><label>初始密码</label><input class="input" id="np" value="annohub123"></div>
        <div class="field"><label>角色</label>
          <select class="select" id="nr">
            <option value="annotator">标注员（只能标分配到的图）</option>
            <option value="reviewer">复核员</option>
            <option value="manager">项目管理员</option>
            <option value="admin">管理员（全部权限）</option>
          </select></div>`,
      actions: [
        { label: '取消' },
        {
          label: '创建', primary: true, onClick: async (close, body) => {
            const username = body.querySelector('#nu').value.trim();
            const display = body.querySelector('#nd').value.trim();
            const pwd = body.querySelector('#np').value;
            if (!username) { ui.toast('填登录账号', 'err'); return false; }
            if (pwd.length < 6) { ui.toast('密码至少 6 位', 'err'); return false; }
            try {
              await post('/api/users', {
                username, display_name: display || username, password: pwd,
                role: body.querySelector('#nr').value,
              });
              close();
              ui.toast('账号已创建', 'ok');
              load();
            } catch (e) { ui.toast(e.message, 'err'); return false; }
          },
        },
      ],
    });
  };

  await load();
}
