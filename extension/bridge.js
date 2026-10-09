(() => {
  'use strict';
  const CHANNEL = 'x-follower-count-v1';
  const MAX_USERS = 5000;
  const users = new Map();
  const TTL = 30 * 60 * 1000;

  // 只提取用户名和粉丝数，不保存原始响应、Cookie 或授权头。
  function extractUsers(root) {
    const output = new Map();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited++ < 50000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      const handle = node.core?.screen_name ?? node.legacy?.screen_name ?? node.screen_name;
      const count = node.relationship_counts?.followers ?? node.legacy?.followers_count ?? node.followers_count;
      if (typeof handle === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(handle)
          && Number.isSafeInteger(count) && count >= 0) {
        output.set(handle.toLowerCase(), { handle: handle.toLowerCase(), count });
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return [...output.values()];
  }

  function publish(records) {
    for (let i = 0; i < records.length; i += 250) {
      window.postMessage({ channel: CHANNEL, type: 'counts', users: records.slice(i, i + 250) }, location.origin);
    }
  }

  function consume(json) {
    const records = extractUsers(json);
    const now = Date.now();
    for (const record of records) {
      users.delete(record.handle);
      users.set(record.handle, { ...record, at: now });
    }
    while (users.size > MAX_USERS) users.delete(users.keys().next().value);
    publish(records);
  }

  function isUserResponse(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin && parsed.pathname.startsWith('/i/api/graphql/');
    } catch { return false; }
  }

  // 克隆响应，不消耗 X 自己需要读取的正文；额外处理失败不能影响原请求。
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const pending = Reflect.apply(originalFetch, this, args);
    pending.then(response => {
      if (response.ok && isUserResponse(response.url)) {
        response.clone().json().then(consume).catch(() => {});
      }
    }).catch(() => {});
    return pending;
  };

  // X 当前使用 XHR，兼容将来改用 fetch 的情况。
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('loadend', () => {
      try {
        if (this.status < 200 || this.status >= 300 || !isUserResponse(this.responseURL)) return;
        if (this.responseType === 'json') consume(this.response);
        else if (!this.responseType || this.responseType === 'text') consume(JSON.parse(this.responseText));
      } catch { /* 非 JSON 或接口异常时，不改动页面行为。 */ }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };

  // 两个脚本启动顺序不固定，界面准备好时重放本次页面收到的数据。
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin
        || event.data?.channel !== CHANNEL || event.data.type !== 'ready') return;
    const now = Date.now();
    publish([...users.values()].filter(record => now - record.at < TTL));
  });
})();
