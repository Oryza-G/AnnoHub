// 统一请求封装。401 一律回到登录页，其余错误抛出可读消息。

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(path, { method = 'GET', body, raw = false, signal } = {}) {
  const opts = { method, credentials: 'same-origin', signal };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('无法连接到服务，请确认启动窗口还在运行');
  }
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    const err = new Error('未登录或登录已过期');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch { /* 非 JSON 响应 */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

export const get = (p, o) => api(p, { ...o, method: 'GET' });
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body });
export const put = (p, body, o) => api(p, { ...o, method: 'PUT', body });
export const patch = (p, body, o) => api(p, { ...o, method: 'PATCH', body });
export const del = (p, o) => api(p, { ...o, method: 'DELETE' });

// 轮询任务直到结束
export async function pollJob(jobId, onTick, interval = 1200) {
  for (;;) {
    const j = await get(`/api/jobs/${jobId}`);
    if (onTick) onTick(j);
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') return j;
    await new Promise((r) => setTimeout(r, interval));
  }
}
