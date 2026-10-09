const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const bridge = fs.readFileSync('extension/bridge.js', 'utf8');
const content = fs.readFileSync('extension/content.js', 'utf8');
const channel = 'x-follower-count-v1';
const tick = () => new Promise(resolve => setTimeout(resolve, 45));

function cell(handle, name = handle) {
  return `<div data-testid="UserCell"><div data-testid="UserAvatar-Container-${handle}"></div><div><a href="/${handle}">${name}</a></div><a href="/${handle}">@${handle}</a><a href="/WrongUser">简介提到的账号</a></div>`;
}

function setup(html = cell('Alice'), before = false) {
  const dom = new JSDOM(`<main data-testid="primaryColumn">${html}</main><aside>${cell('Alice')}</aside>`, {
    url: 'https://x.com/demo_account/verified_followers', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const { window: w } = dom;
  const observers = [];
  const NativeObserver = w.MutationObserver;
  w.MutationObserver = class extends NativeObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const close = w.close.bind(w);
  w.close = () => { observers.forEach(observer => observer.disconnect()); close(); };
  // jsdom 的 postMessage 未设置来源，这里模拟浏览器同源消息。
  w.postMessage = data => w.dispatchEvent(new w.MessageEvent('message', { data, origin: w.location.origin, source: w }));
  if (!before) w.eval(content);
  return { dom, w, main: w.document.querySelector('main') };
}

function send(w, users, origin = w.location.origin) {
  w.dispatchEvent(new w.MessageEvent('message', { data: { channel, type: 'counts', users }, origin, source: w }));
}

test('粉丝数对应账号，支持零值、万和精确悬停提示，侧栏也可显示', async () => {
  const { dom, w, main } = setup(cell('Alice') + cell('Bob') + cell('Zero'));
  try {
    send(w, [{ handle: 'ALICE', count: 104912 }, { handle: 'Bob', count: 913 }, { handle: 'Zero', count: 0 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 10.5万', '粉丝 913', '粉丝 0']);
    assert.match(main.querySelector('[data-xfc-badge]').title, /104,912/);
    assert.equal(w.document.querySelector('aside [data-xfc-badge]').textContent, '粉丝 10.5万');
  } finally { dom.window.close(); }
});

test('滚动新增、DOM 复用、重复消息不会错配或重复插入', async () => {
  const { dom, w, main } = setup();
  try {
    send(w, [{ handle: 'Alice', count: 9 }, { handle: 'Bob', count: 40 }]);
    await tick();
    main.insertAdjacentHTML('beforeend', cell('Bob'));
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
    const first = main.firstElementChild;
    first.querySelector('[data-testid]').setAttribute('data-testid', 'UserAvatar-Container-Carol');
    for (const link of first.querySelectorAll('a[href="/Alice"]')) { link.href = '/Carol'; link.textContent = 'Carol'; }
    await tick();
    assert.equal(first.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    send(w, [{ handle: 'Carol', count: 75 }]);
    send(w, [{ handle: 'Carol', count: 75 }]);
    await tick();
    assert.equal(first.querySelector('[data-xfc-badge]').textContent, '粉丝 75');
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
  } finally { dom.window.close(); }
});

test('非法来源、错误数字不展示；切换路由后继续处理有效账号卡片', async () => {
  const { dom, w, main } = setup();
  try {
    send(w, [{ handle: 'Alice', count: 999 }], 'https://other.example');
    send(w, [{ handle: 'Alice', count: -1 }, { handle: 'Alice', count: '42' }, null]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    w.history.pushState({}, '', '/home');
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 1);
    main.firstElementChild.removeAttribute('data-testid');
    await tick();
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 0);
  } finally { dom.window.close(); }
});

function author(handle, linked = true, testid = 'User-Name') {
  const name = linked ? `<a href="/${handle}">作者 ${handle}</a>` : `<div>作者 ${handle}</div>`;
  return `<div data-testid="${testid}"><div>${name}</div><div><span>@${handle}</span><time>1h</time></div></div>`;
}

test('首页原帖、无链接的引用帖分别映射作者，正文提及不添加标签', async () => {
  const { dom, w, main } = setup(`<article>${author('Alice')}<p><a href="/Carol">@Carol</a></p><div role="link">${author('Bob', false)}</div></article>`);
  try {
    w.history.pushState({}, '', '/home');
    send(w, [{ handle: 'Alice', count: 111 }, { handle: 'Bob', count: 222 }, { handle: 'Carol', count: 333 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => [x.dataset.xfcHandle, x.textContent]), [['alice', '粉丝 111'], ['bob', '粉丝 222']]);
    assert.equal(main.querySelector('p [data-xfc-badge]'), null);
    const quote = main.querySelector('[role="link"] [data-testid="User-Name"]');
    quote.children[1].querySelector('span').textContent = '@Carol';
    await tick();
    assert.equal(quote.querySelector('[data-xfc-badge]').textContent, '粉丝 333');
    assert.equal(main.querySelectorAll('[data-xfc-badge]').length, 2);
  } finally { dom.window.close(); }
});

test('搜索、回复及个人页标题复用同一账号匹配，未知作者不借用其他数字', async () => {
  const { dom, w, main } = setup(author('Alice', false, 'UserName') + author('Unknown') + author('Alice'));
  try {
    send(w, [{ handle: 'Alice', count: 99 }]);
    for (const path of ['/search?q=test', '/Alice/status/123', '/Alice']) {
      w.history.pushState({}, '', path);
      w.dispatchEvent(new w.PopStateEvent('popstate'));
      await tick();
      assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 99', '粉丝 —', '粉丝 99']);
    }
    main.querySelector('[data-testid="UserName"]').children[1].innerHTML = '<span>@Alice</span><span>@Bob</span>';
    await tick();
    assert.equal(main.querySelector('[data-testid="UserName"] [data-xfc-badge]'), null);
  } finally { dom.window.close(); }
});

test('fetch 提取新旧字段，原响应仍可读取，并支持晚启动重放', async () => {
  const { dom, w, main } = setup(cell('Alice') + cell('Bob'), true);
  let calls = 0;
  const body = { data: [{ core: { screen_name: 'Alice' }, relationship_counts: { followers: 12345 } }, { legacy: { screen_name: 'Bob', followers_count: 0 } }] };
  w.fetch = () => { calls++; return Promise.resolve({ ok: true, url: 'https://x.com/i/api/graphql/test/Followers', clone: () => ({ json: async () => body }), json: async () => body }); };
  try {
    w.eval(bridge);
    const response = await w.fetch('/i/api/graphql/test/Followers');
    assert.deepEqual(await response.json(), body);
    await tick();
    w.eval(content);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 1.2万', '粉丝 0']);
    assert.equal(calls, 1);
  } finally { dom.window.close(); }
});

test('XHR 成功读取，接口失败和外域响应不会覆盖已知数字', async () => {
  const { dom, w, main } = setup();
  class XHR extends w.EventTarget {
    send() { this.dispatchEvent(new w.Event('loadend')); }
  }
  w.XMLHttpRequest = XHR;
  w.fetch = async () => { throw new Error('network'); };
  try {
    w.eval(bridge);
    const xhr = new XHR();
    xhr.status = 200; xhr.responseType = ''; xhr.responseURL = 'https://x.com/i/api/graphql/test/BlueVerifiedFollowers';
    xhr.responseText = JSON.stringify({ core: { screen_name: 'Alice' }, relationship_counts: { followers: 31 } });
    xhr.send(); await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 31');
    xhr.status = 429; xhr.responseText = 'not json'; xhr.send();
    xhr.status = 200; xhr.responseURL = 'https://other.example/i/api/graphql/test/Users'; xhr.send();
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 31');
    await assert.rejects(w.fetch('/anything'), /network/);
  } finally { dom.window.close(); }
});

test('安装清单只匹配 X，无额外权限，脚本文件均存在', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  for (const script of manifest.content_scripts) {
    assert.equal(script.run_at, 'document_start');
    for (const file of [...script.js, ...(script.css || [])]) assert.ok(fs.existsSync(`extension/${file}`));
  }
});

test('异常链接不会阻断其他作者，显示名以 @ 开头也能匹配', async () => {
  const { dom, w, main } = setup(cell('Alice', '@Alice display name') + cell('Bob'));
  try {
    main.firstElementChild.insertAdjacentHTML('afterbegin', '<a href="http://[">bad URL</a>');
    send(w, [{ handle: 'Alice', count: 15 }, { handle: 'Bob', count: 26 }]);
    await tick();
    assert.deepEqual([...main.querySelectorAll('[data-xfc-badge]')].map(x => x.textContent), ['粉丝 15', '粉丝 26']);
  } finally { dom.window.close(); }
});

test('缓存超过 30 分钟不继续展示旧数；新响应恢复数字', async () => {
  const { dom, w, main } = setup();
  try {
    let now = 1000000;
    w.Date.now = () => now;
    send(w, [{ handle: 'Alice', count: 10 }]);
    await tick();
    now += 30 * 60 * 1000 + 1;
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
    send(w, [{ handle: 'Alice', count: 11 }]);
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 11');
  } finally { dom.window.close(); }
});

test('忽略同源 iframe 的伪造消息和超大消息', async () => {
  const { dom, w, main } = setup();
  try {
    w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: null,
      data: { channel, type: 'counts', users: [{ handle: 'Alice', count: 500 }] } }));
    send(w, Array.from({ length: 251 }, () => ({ handle: 'Alice', count: 500 })));
    await tick();
    assert.equal(main.querySelector('[data-xfc-badge]').textContent, '粉丝 —');
  } finally { dom.window.close(); }
});

test('批量响应分片发送，只传递用户名和数字，不传递原始数据', async () => {
  const { dom, w } = setup('', true);
  const messages = [];
  w.postMessage = data => messages.push(data);
  const users = Array.from({ length: 600 }, (_, i) => ({ core: { screen_name: `demo${i}` }, relationship_counts: { followers: i }, private_fixture: 'SHOULD_NOT_LEAVE_BRIDGE' }));
  w.fetch = async () => ({ ok: true, url: 'https://x.com/i/api/graphql/test/Followers', clone: () => ({ json: async () => ({ users }) }) });
  try {
    w.eval(bridge);
    await w.fetch('fixture'); await tick();
    assert.deepEqual(messages.map(m => m.users.length), [250, 250, 100]);
    assert.ok(messages.every(m => m.users.every(u => Object.keys(u).sort().join(',') === 'count,handle')));
    assert.ok(!JSON.stringify(messages).includes('SHOULD_NOT_LEAVE_BRIDGE'));
  } finally { dom.window.close(); }
});

test('外域响应、非 JSON 以及 clone 异常不改变原请求结果', async () => {
  const { dom, w } = setup('', true);
  const messages = [];
  w.postMessage = data => messages.push(data);
  const response = { ok: true, url: 'https://other.example/i/api/graphql/test/Followers', clone() { throw new Error('must not read'); } };
  w.fetch = () => Promise.resolve(response);
  try {
    w.eval(bridge);
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
    response.url = 'https://x.com/i/api/graphql/test/Followers';
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
    response.clone = () => ({ json: async () => { throw new Error('invalid JSON'); } });
    assert.equal(await w.fetch('fixture'), response);
    await tick(); assert.equal(messages.length, 0);
  } finally { dom.window.close(); }
});

test('XHR 网络错误结束后不遗留监听器，复用请求只发送一次新结果', async () => {
  const { dom, w } = setup('', true);
  class XHR extends w.EventTarget { send() { this.dispatchEvent(new w.Event('loadend')); } }
  w.XMLHttpRequest = XHR;
  w.fetch = async () => {};
  const messages = [];
  w.postMessage = data => messages.push(data);
  try {
    w.eval(bridge);
    const xhr = new XHR();
    xhr.status = 0; xhr.send();
    xhr.status = 200; xhr.responseType = 'json'; xhr.responseURL = 'https://x.com/i/api/graphql/test/Users';
    xhr.response = { legacy: { screen_name: 'Alice', followers_count: 99 } };
    xhr.send();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].users[0].count, 99);
  } finally { dom.window.close(); }
});
