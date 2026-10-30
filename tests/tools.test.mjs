/**
 * 宿主装配自测：真正 import lib/index.js（临时目录 + dsh-tools 桩），
 * 验证 webServer 出口注册、qq_send / qq_inbox 工具与面板共用配置/审计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { 启动假OneBot } from './fake-onebot.mjs';

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 复制 lib 到临时目录，并放一个最小的 @deepseek-ai/dsh-tools 桩（不联网安装依赖） */
function 造临时包() {
  const 目录 = mkdtempSync(join(tmpdir(), 'qq-bridge-pkg-'));
  mkdirSync(join(目录, 'lib'), { recursive: true });
  mkdirSync(join(目录, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true });
  cpSync(join(包根, 'lib', 'index.js'), join(目录, 'lib', 'index.js'));
  cpSync(join(包根, 'lib', 'core.js'), join(目录, 'lib', 'core.js'));
  cpSync(join(包根, 'lib', 'official.js'), join(目录, 'lib', 'official.js'));
  cpSync(join(包根, 'lib', 'autoreply.js'), join(目录, 'lib', 'autoreply.js'));
  writeFileSync(join(目录, 'package.json'), JSON.stringify({ name: 'qq-bridge-temp', type: 'module', private: true }));
  writeFileSync(join(目录, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.js', exports: './index.js',
  }));
  writeFileSync(join(目录, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), [
    'export function defineTool(o) {',
    '  if (!o || typeof o.name !== "string" || typeof o.execute !== "function") throw new Error("bad tool");',
    '  return { name: o.name, description: o.description, parameters: o.parameters, output: o.output, execute: o.execute };',
    '}',
  ].join('\n'));
  return 目录;
}

test('装配：注册 HTTP 出口 + 两个 Agent 工具，工具与面板共用配置和审计', async () => {
  const 包目录 = 造临时包();
  const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-home-'));
  process.env.DSH_QQ_BRIDGE_HOME = 家;

  const 内核 = await import(pathToFileURL(join(包目录, 'lib', 'core.js')).href);
  const 假 = await 启动假OneBot();
  try {
    内核.保存配置({ endpoint: 假.地址, default_target: '30001', default_target_type: 'group' }, 内核.解析路径());

    const 出口 = [];
    const 工具 = [];
    const ctx = {
      webServer: { register(路由) { 出口.push(路由); return () => {}; } },
      tools: { register(t) { 工具.push(t); } },
      effect(fn) { return fn(); },
      logger: { info() {}, warn() {}, error() {} },
    };
    const 插件 = await import(pathToFileURL(join(包目录, 'lib', 'index.js')).href);
    assert.equal(插件.name, 'qq-bridge');
    assert.deepEqual(插件.inject, ['webServer', 'tools']);
    插件.apply(ctx);

    assert.equal(出口.length, 1);
    assert.equal(出口[0].path, '/dsh-qq-bridge');
    assert.equal(typeof 出口[0].handler, 'function');
    assert.deepEqual(工具.map((t) => t.name).sort(), ['qq_inbox', 'qq_send']);

    const 发送工具 = 工具.find((t) => t.name === 'qq_send');
    const 发送结果 = await 发送工具.execute({ target: '30001', target_type: 'group', text: '审批待办：合同已到' });
    assert.match(发送结果, /已发送到群 30001/);
    const 到站 = 假.收到.at(-1);
    assert.equal(到站.动作, 'send_group_msg');
    assert.equal(到站.体.group_id, 30001);
    assert.equal(到站.体.message, '审批待办：合同已到');

    const 审计 = 内核.读审计(20, 内核.解析路径());
    const 工具审计 = 审计.filter((r) => r.动作 === '发送消息' && r.结果 === '成功').at(-1);
    assert.equal(工具审计.来源, 'tool', '工具发送必须标来源 tool');

    内核.追加收件箱({
      post_type: 'message', message_type: 'group', group_id: 555666, user_id: 10002,
      sender: { nickname: '客户B' }, raw_message: '想约时间面谈',
    }, 内核.解析路径());
    const 收件工具 = 工具.find((t) => t.name === 'qq_inbox');
    const 收件结果 = await 收件工具.execute({ limit: 5 });
    assert.match(收件结果, /群 555666/);
    assert.match(收件结果, /想约时间面谈/);

    // 失败也走同一条审计路径
    假.失败动作.add('send_group_msg');
    const 败 = await 发送工具.execute({ target: '30001', target_type: 'group', text: '会失败' });
    assert.match(败, /^发送失败：/);
    assert.match(败, /模拟失败/);
    const 失败审计 = 内核.读审计(10, 内核.解析路径()).filter((r) => r.结果 === '失败').at(-1);
    assert.equal(失败审计.来源, 'tool');
  } finally {
    await 假.关闭();
  }
});

test('装配降级：没有 webServer / tools 时 apply 不抛错', async () => {
  const 包目录 = 造临时包();
  const 插件 = await import(pathToFileURL(join(包目录, 'lib', 'index.js')).href);
  assert.doesNotThrow(() => 插件.apply({}));
  assert.doesNotThrow(() => 插件.apply(null));
});

test('装配：qq_send 支持官方机器人参数（mode=official，离线 mock fetch）', async () => {
  const 包目录 = 造临时包();
  const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-home-'));
  process.env.DSH_QQ_BRIDGE_HOME = 家;
  const 内核 = await import(pathToFileURL(join(包目录, 'lib', 'core.js')).href);
  内核.保存配置({ mode: 'official', official_appid: '1904047384', official_secret: 'secret-xyz-9876' }, 内核.解析路径());

  const 工具 = [];
  const 插件 = await import(pathToFileURL(join(包目录, 'lib', 'index.js')).href);
  插件.apply({
    webServer: { register() { return () => {}; } },
    tools: { register(t) { 工具.push(t); } },
    effect(fn) { return fn(); },
    logger: { info() {}, warn() {}, error() {} },
  });
  const 发送工具 = 工具.find((t) => t.name === 'qq_send');
  assert.ok(发送工具.parameters.openid, 'qq_send 必须暴露官方通道参数');

  const 原fetch = globalThis.fetch;
  const 调用 = [];
  globalThis.fetch = async (地址, 配置 = {}) => {
    调用.push({ 地址, 体: 配置.body ? JSON.parse(配置.body) : null, 头: 配置.headers || {} });
    if (地址.includes('getAppAccessToken')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-tool-1', expires_in: 7200 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'msg-tool-1' }) };
  };
  try {
    const 结果 = await 发送工具.execute({ mode: 'official', channel: 'c2c', openid: 'USER_OPENID_QQQ456', text: '工具官方发送' });
    assert.match(结果, /已通过官方机器人发送/);
    assert.match(结果, /msg-tool-1/);
    const 发送请求 = 调用.find((c) => c.地址.includes('/v2/users/'));
    assert.equal(发送请求.地址, 'https://api.sgroup.qq.com/v2/users/USER_OPENID_QQQ456/messages');
    assert.deepEqual(发送请求.体, { content: '工具官方发送', msg_type: 0 });
    const 审计 = 内核.读审计(20, 内核.解析路径()).filter((r) => r.动作 === '发送消息' && r.通道 === 'official');
    assert.equal(审计.at(-1).结果, '成功');
    assert.equal(审计.at(-1).来源, 'tool');
    assert.doesNotMatch(JSON.stringify(审计), /secret-xyz-9876|tok-tool-1/);
  } finally {
    globalThis.fetch = 原fetch;
  }
});

/** 端到端装配：真实 index.js + official.js + HTTP 出口，只 mock 网络 */
function 造假WS类() {
  const 实例 = [];
  class 假WebSocket {
    constructor(地址) { this.地址 = 地址; this.sent = []; this.readyState = 0; this.关闭过 = false; 实例.push(this); }
    send(串) { this.sent.push(JSON.parse(串)); }
    close() { this.关闭过 = true; this.readyState = 3; }
    打开() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    推(帧) { if (this.onmessage) this.onmessage({ data: JSON.stringify(帧) }); }
  }
  假WebSocket.实例 = 实例;
  return 假WebSocket;
}

test('端到端：/api/official/connect → READY → 配置变更重启 → /api/send 发出去', async () => {
  const http = await import('node:http');
  const 包目录 = 造临时包();
  const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-home-'));
  process.env.DSH_QQ_BRIDGE_HOME = 家;

  const 插件 = await import(pathToFileURL(join(包目录, 'lib', 'index.js')).href);
  const 出口 = [];
  插件.apply({
    webServer: { register(路由) { 出口.push(路由); return () => {}; } },
    tools: { register() {} },
    effect(fn) { return fn(); },
    logger: { info() {}, warn() {}, error() {} },
  });
  const 服务 = http.createServer(出口[0].handler);
  await new Promise((完成) => 服务.listen(0, '127.0.0.1', 完成));
  const 地址 = 'http://127.0.0.1:' + 服务.address().port + 出口[0].path + '/api';

  const 原fetch = globalThis.fetch;
  const 本地 = (路, 选项) => 原fetch(路, 选项); // 本地 HTTP 用真 fetch，别被下面的 mock 截走
  const 原WS = globalThis.WebSocket;
  const WS = 造假WS类();
  const 发送 = [];
  globalThis.WebSocket = WS;
  globalThis.fetch = async (url, 配置 = {}) => {
    const 体 = 配置.body ? JSON.parse(配置.body) : null;
    if (String(url).includes('getAppAccessToken')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok-e2e', expires_in: 7200 }) };
    }
    if (String(url).endsWith('/gateway')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' }) };
    }
    发送.push({ url: String(url), 体, 头: 配置.headers || {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'msg-e2e-1' }) };
  };

  try {
    // 1) 面板保存官方配置
    const 存 = await 本地(地址 + '/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'official', official_appid: '1904047384', official_secret: 'secret-e2e' }),
    });
    assert.equal(存.status, 200);

    // 2) 点「连接」→ 真实装配里建 WebSocket
    const 连 = await 本地(地址 + '/official/connect', { method: 'POST' });
    assert.equal(连.status, 200);
    assert.equal(WS.实例.length, 1);
    const ws = WS.实例[0];
    ws.打开();
    ws.推({ op: 10, d: { heartbeat_interval: 41250 } });
    assert.equal(ws.sent[0].op, 2);
    assert.equal(ws.sent[0].d.token, 'QQBot tok-e2e');
    ws.推({ op: 0, t: 'READY', s: 1, d: { user: { id: '7111817165780244444', username: 'feely-bot2', bot: true } } });

    const 状态 = await (await 本地(地址 + '/official/status')).json();
    assert.equal(状态.状态.connected, true);
    assert.equal(状态.状态.bot_name, 'feely-bot2');

    // 3) 端到端自动回复：HTTP 开自动回复 → 推 C2C 事件 → 立刻带 msg_id 回出去
    const 自动存 = await 本地(地址 + '/official/autoreply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        official_auto_reply: true, official_reply_text: '收到～', official_reply_rules: [],
        official_reply_scope: 'c2c', official_reply_min_interval_ms: 0, official_reply_hourly_cap: 10,
      }),
    });
    assert.equal(自动存.status, 200);
    assert.equal((await 自动存.json()).配置.official_auto_reply, true);
    ws.推({
      op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
      d: { id: 'MSGID_E2E_AUTO', content: '在吗', timestamp: new Date().toISOString(), author: { user_openid: 'USER_OPENID_E2E456', username: '阿鲸' } },
    });
    for (let i = 0; i < 100 && 发送.length < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(发送.length, 1, '自动回复必须立刻发出去');
    assert.equal(发送[0].url, 'https://api.sgroup.qq.com/v2/users/USER_OPENID_E2E456/messages');
    assert.deepEqual(发送[0].体, { content: '收到～', msg_type: 0, msg_id: 'MSGID_E2E_AUTO' });
    const 自动统计 = await (await 本地(地址 + '/official/autoreply')).json();
    assert.equal(自动统计.统计.今日次数, 1);
    assert.equal(自动统计.统计.小时次数, 1);

    // 4) 改 AppSecret 保存 → 按新配置重启连接（旧 socket 关掉）
    const 改 = await 本地(地址 + '/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ official_secret: 'secret-e2e-v2' }),
    });
    assert.equal(改.status, 200);
    for (let i = 0; i < 100 && WS.实例.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(WS.实例.length, 2, '配置变更必须重启连接');
    assert.equal(ws.关闭过, true, '旧 socket 必须被关掉');

    // 5) 面板发送 → 官方接口 + 审计
    const 发 = await 本地(地址 + '/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'official', channel: 'c2c', openid: 'USER_OPENID_QQQ456', text: '端到端', msg_id: 'MSGID_1' }),
    });
    assert.equal(发.status, 200);
    const 请求 = 发送.at(-1);
    assert.equal(请求.url, 'https://api.sgroup.qq.com/v2/users/USER_OPENID_QQQ456/messages');
    assert.deepEqual(请求.体, { content: '端到端', msg_type: 0, msg_id: 'MSGID_1' });
    assert.match(String(请求.头.authorization), /^QQBot tok-/);

    // 6) 断开
    const 断 = await 本地(地址 + '/official/disconnect', { method: 'POST' });
    assert.equal((await 断.json()).状态.state, '已断开');
  } finally {
    globalThis.fetch = 原fetch;
    globalThis.WebSocket = 原WS;
    await new Promise((完成) => 服务.close(完成));
  }
});
