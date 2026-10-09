(() => {
  'use strict';
  const CHANNEL = 'x-follower-count-v1';
  const BADGE = 'data-xfc-badge';
  const counts = new Map();
  const TTL = 30 * 60 * 1000;
  let scheduled = false;

  function formatCount(value) {
    if (value >= 100000000) return `${Number((value / 100000000).toFixed(1))}亿`;
    if (value >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
    return value.toLocaleString('zh-CN');
  }

  function profileLink(cell) {
    // 优先头像对应的账号，避免把简介里提到的其他人误认成该行用户。
    const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
    const avatarHandle = avatar?.getAttribute('data-testid').slice('UserAvatar-Container-'.length).toLowerCase();
    for (const link of cell.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(link.getAttribute('href'), location.href); }
      catch { continue; }
      const match = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/);
      if (url.origin !== location.origin || !match || link.getAttribute('aria-hidden') === 'true') continue;
      const handle = match[1].toLowerCase();
      if (avatarHandle && handle !== avatarHandle) continue;
      if (!link.textContent.trim()) continue;
      return { link, handle };
    }
    return null;
  }

  function authorHeader(header) {
    const name = header.firstElementChild;
    if (!name) return null;
    // 仅看这个作者标题内的链接，不向外查找，避免引用帖认成外层作者。
    const profile = profileLink(header);
    if (profile) return { anchor: name, handle: profile.handle, mode: 'append' };
    // 引用帖中的名字不是链接；从标题的账号一栏读取完整 @handle。
    const accountColumn = header.children[1];
    if (!accountColumn) return null;
    const handles = new Set();
    for (const node of accountColumn.querySelectorAll('span, div')) {
      if (node.children.length) continue;
      const match = node.textContent.trim().match(/^@([a-zA-Z0-9_]{1,15})$/);
      if (match) handles.add(match[1].toLowerCase());
    }
    if (handles.size !== 1) return null;
    return { anchor: name, handle: [...handles][0], mode: 'append' };
  }

  function render() {
    scheduled = false;
    const now = Date.now();
    const targets = [];
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      const profile = profileLink(cell);
      if (profile) targets.push({ root: cell, anchor: profile.link, handle: profile.handle, mode: 'after' });
    }
    for (const header of document.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]')) {
      if (header.closest('[data-testid="UserCell"]')) continue;
      const profile = authorHeader(header);
      if (profile) targets.push({ root: header, ...profile });
    }
    const liveBadges = new Set();
    const liveRows = new Set();
    for (const profile of targets) {
      const row = profile.mode === 'after' ? profile.anchor.parentElement : profile.anchor;
      let badge = [...row.children].find(child => child.hasAttribute(BADGE));
      // X 会复用列表 DOM；账号改变时，立刻移除旧账号的标签。
      if (badge && badge.dataset.xfcHandle !== profile.handle) { badge.remove(); badge = null; }
      const record = counts.get(profile.handle);
      const known = record && now - record.at < TTL;
      const label = known ? `粉丝 ${formatCount(record.count)}` : '粉丝 —';
      const title = known
        ? `@${profile.handle} · ${record.count.toLocaleString('zh-CN')} 位粉丝\n来自 X 页面本次返回的数据`
        : '尚未收到这个账号的粉丝数。刚安装插件时，请刷新页面。';
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(BADGE, '');
        badge.dataset.xfcHandle = profile.handle;
        // 放在名字链接旁，避免挤压用户名或干扰关注按钮。
        if (profile.mode === 'after') profile.anchor.insertAdjacentElement('afterend', badge);
        else profile.anchor.append(badge);
      }
      if (!row.hasAttribute('data-xfc-name-row')) row.setAttribute('data-xfc-name-row', '');
      liveBadges.add(badge);
      liveRows.add(row);
      if (badge.textContent !== label) badge.textContent = label;
      if (badge.title !== title) badge.title = title;
      const state = known ? 'ready' : 'pending';
      if (badge.dataset.xfcState !== state) badge.dataset.xfcState = state;
    }
    // React 复用或替换作者标题时清理遗留标签和样式。
    document.querySelectorAll(`[${BADGE}]`).forEach(badge => { if (!liveBadges.has(badge)) badge.remove(); });
    document.querySelectorAll('[data-xfc-name-row]').forEach(row => {
      if (!liveRows.has(row)) row.removeAttribute('data-xfc-name-row');
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin
        || event.data?.channel !== CHANNEL || event.data.type !== 'counts'
        || !Array.isArray(event.data.users) || event.data.users.length > 250) return;
    for (const user of event.data.users) {
      if (!user || typeof user.handle !== 'string' || !/^[a-zA-Z0-9_]{1,15}$/.test(user.handle)
          || !Number.isSafeInteger(user.count) || user.count < 0) continue;
      const handle = user.handle.toLowerCase();
      counts.delete(handle);
      counts.set(handle, { count: user.count, at: Date.now() });
    }
    while (counts.size > 5000) counts.delete(counts.keys().next().value);
    schedule();
  });

  // 监听路由、列表追加、虚拟列表复用和名字变化。自身标签变化不会重复写入。
  new MutationObserver(schedule).observe(document, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['href', 'data-testid']
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('pageshow', schedule);
  setInterval(schedule, 30000);
  window.postMessage({ channel: CHANNEL, type: 'ready' }, location.origin);
  schedule();
})();
