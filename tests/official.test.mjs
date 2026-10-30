/**
 * QQ 官方机器人通道自测：全程 mock fetch + mock WebSocket，**不联网**、不碰真实 ~/.dsh。
 *
 * 覆盖：token 缓存/强制刷新/失败报错、hello→identify→READY、op11 ack、op7 重连、
 * op9 换 token 重连、GROUP_AT/C2C/频道事件归一化入队、发送 payload（含 msg_id）、
 * 401 重取 token、审计脱敏、HTTP 出口（status/connect/send）、配置校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import {
  解析路径, 保存配置, 读配置, 脱敏配置, 读收件箱, 读审计, 写审计, 建处理器, ROUTE,
} from '../lib/core.js';
import {
  取令牌地址, 取AccessToken, 取Gateway, 清官方令牌缓存, 官方基址,
  归一化官方事件, 清洗官方文本, 发送官方消息, 连接官方, 断开官方, 官方状态, 群与私聊意图,
} from '../lib/official.js';

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 假配置 = { official_appid: '1904047384', official_secret: 'secret-xyz-9876' };

function 新家() {
  const 目录 = mkdtempSync(join(tmpdir(), 'qq-official-test-'));
  process.env.DSH_QQ_BRIDGE_HOME = 目录;
  return { 目录, 路径: 解析路径() };
}

const 等 = (毫秒) => new Promise((完成) => setTimeout(完成, 毫秒));
async function 等条件(判断, 说明 = '条件', 超时 = 800) {
  const 起 = Date.now();
  while (Date.now() - 起 < 超时) {
    if (判断()) return;
    await 等(5);
  }
  throw new Error('等条件超时：' + 说明);
}

/* ────────────────────────── 假网络 ────────────────────────── */

function 假响应(状态码, 体) {
  return {
    ok: 状态码 >= 200 && 状态码 < 300,
    status: 状态码,
    text: async () => JSON.stringify(体),
  };
}

/**
 * 假 fetch：只认 取令牌 / gateway / 发送三类地址，全部记录到 状态。
 * 选项：{ 令牌失败, 网关401, 发送失败:{status,体} }
 */
function 造假网络(选项 = {}) {
  const 状态 = { 令牌次数: 0, 网关次数: 0, 发送: [], 调用: [] };
  const impl = async (地址, 配置 = {}) => {
    const 体 = 配置.body ? JSON.parse(配置.body) : null;
    状态.调用.push({ 地址, 方法: 配置.method || 'GET', 头: 配置.headers || {}, 体 });
    if (地址 === 取令牌地址) {
      状态.令牌次数 += 1;
      if (选项.令牌失败) return 假响应(401, { code: 100016, message: 'appid or clientSecret invalid' });
      return 假响应(200, { access_token: 'tok-' + 状态.令牌次数, expires_in: 7200 });
    }
    if (地址.endsWith('/gateway')) {
      状态.网关次数 += 1;
      if (选项.网关401 && 状态.网关次数 === 1) return 假响应(401, { code: 11244, message: 'token invalid', trace_id: 'tr-401' });
      return 假响应(200, { url: 选项.网关 || 'wss://api.sgroup.qq.com/websocket' });
    }
    状态.发送.push({ 地址, 体, 头: 配置.headers || {} });
    if (选项.发送失败) {
      const 败 = 选项.发送失败;
      return 假响应(败.status, 败.体);
    }
    return 假响应(200, { id: 'msg-' + 状态.发送.length, timestamp: '2026-10-30T00:00:00+08:00' });
  };
  return { impl, 状态 };
}

/* ────────────────────────── 假 WebSocket ────────────────────────── */

function 造假WS类() {
  const 实例 = [];
  class 假WebSocket {
    constructor(地址) {
      this.地址 = 地址;
      this.sent = [];
      this.readyState = 0;
      this.关闭过 = false;
      实例.push(this);
    }
    send(串) { this.sent.push(JSON.parse(串)); }
    close() { this.关闭过 = true; this.readyState = 3; }
    打开() { this.readyState = 1; if (this.onopen) this.onopen({}); }
    推(帧) { if (this.onmessage) this.onmessage({ data: JSON.stringify(帧) }); }
    出错(原因 = 'boom') { if (this.onerror) this.onerror({ message: 原因 }); }
    掉线(码 = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code: 码 }); }
  }
  假WebSocket.实例 = 实例;
  return 假WebSocket;
}

/** 连上一条官方连接，返回 { 网络, WS, ws, 配置 } */
async function 起官方连接(路径, 网络选项 = {}) {
  保存配置({ mode: 'official', ...假配置, official_sandbox: false }, 路径);
  const 网络 = 造假网络(网络选项);
  const WS = 造假WS类();
  await 连接官方(读配置(路径), { 路径, fetchImpl: 网络.impl, WebSocketImpl: WS, 退避毫秒: [5, 10] });
  const ws = WS.实例[0];
  assert.ok(ws, '必须发起 WebSocket 连接');
  return { 网络, WS, ws, 配置: 读配置(路径) };
}

/** 走完 hello → identify → READY */
function 握手(ws, 机器人 = { id: '7111817165780244444', username: 'feely-bot2' }) {
  ws.打开();
  ws.推({ op: 10, d: { heartbeat_interval: 40 } });
  ws.推({ op: 0, t: 'READY', s: 1, d: { user: { ...机器人, bot: true } } });
}

/* ────────────────────────── 测试 ────────────────────────── */

test('官方 token：缓存到 expires_in-60s、强制刷新、失败原样报 code/message', async () => {
  清官方令牌缓存();
  const 网络 = 造假网络();
  const 一 = await 取AccessToken(假配置, { fetchImpl: 网络.impl });
  assert.equal(一.ok, true);
  assert.equal(一.token, 'tok-1');
  assert.equal(一.缓存, false);
  assert.equal(网络.状态.令牌次数, 1);
  const 令牌请求 = 网络.状态.调用[0];
  assert.equal(令牌请求.地址, 'https://bots.qq.com/app/getAppAccessToken');
  assert.deepEqual(令牌请求.体, { appId: 假配置.official_appid, clientSecret: 假配置.official_secret });

  const 二 = await 取AccessToken(假配置, { fetchImpl: 网络.impl });
  assert.equal(二.token, 'tok-1');
  assert.equal(二.缓存, true);
  assert.equal(网络.状态.令牌次数, 1, '有效期内必须走缓存，不能每次都打 bots.qq.com');

  const 三 = await 取AccessToken(假配置, { fetchImpl: 网络.impl, 强制: true });
  assert.equal(三.token, 'tok-2');
  assert.equal(网络.状态.令牌次数, 2);

  // 时间推进到过期之后 → 重新取
  清官方令牌缓存();
  const 时钟 = { 现在: 1_000_000 };
  await 取AccessToken(假配置, { fetchImpl: 网络.impl, 现在: () => 时钟.现在 });
  const 前 = 网络.状态.令牌次数;
  时钟.现在 += 7_200_000;
  await 取AccessToken(假配置, { fetchImpl: 网络.impl, 现在: () => 时钟.现在 });
  assert.equal(网络.状态.令牌次数, 前 + 1, '过期后必须重新取 token');

  const 败 = await 取AccessToken(假配置, { fetchImpl: 造假网络({ 令牌失败: true }).impl, 强制: true });
  assert.equal(败.ok, false);
  assert.match(败.错误, /100016/);
  assert.match(败.错误, /appid or clientSecret invalid/);
  assert.doesNotMatch(JSON.stringify(败), /secret-xyz-9876/, 'AppSecret 不能出现在错误里');

  const 缺 = await 取AccessToken({ official_appid: '', official_secret: '' }, { fetchImpl: 网络.impl });
  assert.equal(缺.ok, false);
  assert.match(缺.错误, /未配置官方机器人 AppID/);
});

test('hello→identify→READY：intents=1<<25、shard=[0,1]、op1 心跳、op11 ack', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const { ws } = await 起官方连接(路径);
    握手(ws);

    const 首帧 = ws.sent[0];
    assert.equal(首帧.op, 2, 'hello 之后必须先 identify');
    assert.equal(首帧.d.token, 'QQBot tok-1');
    assert.equal(首帧.d.intents, 群与私聊意图);
    assert.equal(首帧.d.intents, 1 << 25);
    assert.deepEqual(首帧.d.shard, [0, 1]);
    assert.deepEqual(首帧.d.properties, {});
    assert.ok(ws.sent.some((帧) => 帧.op === 1), '必须按 heartbeat_interval 发 op1');

    const 状态 = 官方状态();
    assert.equal(状态.connected, true);
    assert.equal(状态.state, '已连接');
    assert.equal(状态.bot_name, 'feely-bot2');
    assert.equal(状态.bot_id, '7111817165780244444');
    assert.equal(状态.sandbox, false);

    ws.推({ op: 11 });
    assert.ok(官方状态().last_ack_at, 'op11 必须记 ack 时间');

    // 审计里有连接成功，但没有 token / secret
    const 审计 = JSON.stringify(读审计(50, 路径));
    assert.match(审计, /feely-bot2/);
    assert.doesNotMatch(审计, /secret-xyz-9876/);
    assert.doesNotMatch(审计, /tok-1/);
  } finally {
    断开官方();
  }
});

test('op7 用缓存 token 重连；op9 清 token 重新取再连；断线退避重连', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const { 网络, WS, ws } = await 起官方连接(路径);
    握手(ws);
    assert.equal(WS.实例.length, 1);
    const token前 = 网络.状态.令牌次数;

    // op7：服务端要求重连，token 仍有效 → 不重取
    ws.推({ op: 7 });
    await 等条件(() => WS.实例.length === 2, 'op7 后新建连接');
    assert.equal(网络.状态.令牌次数, token前, 'op7 不应重取 token');
    assert.equal(ws.关闭过, true, '旧 socket 必须被关掉');
    握手(WS.实例[1]);
    assert.equal(官方状态().connected, true);

    // op9：会话失效 → 清 token 重取
    WS.实例[1].推({ op: 9 });
    await 等条件(() => WS.实例.length === 3 && 网络.状态.令牌次数 === token前 + 1, 'op9 后换 token 重连');
    assert.match(官方状态().last_error, /op9/);
    握手(WS.实例[2]);
    assert.equal(官方状态().connected, true);

    // 异常掉线（code 1006）→ 退避后自动重连
    WS.实例[2].掉线(1006);
    await 等条件(() => WS.实例.length === 4, '掉线后自动重连');
    assert.match(官方状态().last_error, /断开/);
  } finally {
    断开官方();
  }
});

test('进程内单例：换配置再连接会先断开旧 socket，按新凭证重连', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const 网络 = 造假网络();
    const WS = 造假WS类();
    const 选项 = { 路径, fetchImpl: 网络.impl, WebSocketImpl: WS, 退避毫秒: [5, 10] };
    保存配置({ mode: 'official', ...假配置 }, 路径);
    await 连接官方(读配置(路径), 选项);
    const 第一条 = WS.实例[0];
    握手(第一条, { id: '1', username: 'bot-甲' });
    assert.equal(官方状态().bot_name, 'bot-甲');

    // 换 AppID 再连（相当于面板改了配置点「连接」）
    保存配置({ official_appid: '1904047399' }, 路径);
    await 连接官方(读配置(路径), 选项);
    assert.equal(第一条.关闭过, true, '旧连接必须被关掉');
    assert.equal(WS.实例.length, 2, '必须用新配置重新建连');
    握手(WS.实例[1], { id: '2', username: 'bot-乙' });
    assert.equal(官方状态().bot_name, 'bot-乙');
    assert.equal(官方状态().connected, true);

    // 新 token 必须按新 AppID 取（指纹不同，缓存不复用）
    assert.ok(网络.状态.令牌次数 >= 2);
  } finally {
    断开官方();
  }
});

test('事件归一化：GROUP_AT / C2C / 频道 / 频道私信 → 入队 + 审计', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const { ws } = await 起官方连接(路径);
    握手(ws);
    ws.推({
      op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 2,
      d: {
        id: 'MSGID_GROUP_1', content: '<@!123456> 合同什么时候签？',
        group_openid: 'GROUP_OPENID_ABCDEF', author: { member_openid: 'MEMBER_OPENID_XYZ123' },
      },
    });
    ws.推({
      op: 0, t: 'C2C_MESSAGE_CREATE', s: 3,
      d: { id: 'MSGID_C2C_1', content: '私聊咨询', author: { user_openid: 'USER_OPENID_QQQ456', username: '阿鲸' } },
    });
    ws.推({
      op: 0, t: 'AT_MESSAGE_CREATE', s: 4,
      d: { id: 'MSGID_CH_1', content: '频道里问一句', channel_id: 'CHANNEL_001', guild_id: 'GUILD_001', author: { id: 'AUTHOR_001', username: '频道用户' } },
    });
    ws.推({
      op: 0, t: 'DIRECT_MESSAGE_CREATE', s: 5,
      d: { id: 'MSGID_DM_1', content: '频道私信', guild_id: 'GUILD_002', channel_id: 'CHANNEL_002', author: { id: 'AUTHOR_002' } },
    });
    await 等条件(() => 读收件箱(10, 路径).总数 >= 4, '四条事件入队');

    const 消息 = 读收件箱(10, 路径).消息;
    const 群 = 消息.find((m) => m.会话类型 === 'group');
    assert.equal(群.来源通道, 'official');
    assert.equal(群.事件类型, 'GROUP_AT_MESSAGE_CREATE');
    assert.equal(群.group_openid, 'GROUP_OPENID_ABCDEF');
    assert.equal(群.openid, 'MEMBER_OPENID_XYZ123');
    assert.equal(群.msg_id, 'MSGID_GROUP_1');
    assert.equal(群.文本, '合同什么时候签？', '提及标签要剥掉');

    const 私 = 消息.find((m) => m.会话类型 === 'c2c');
    assert.equal(私.openid, 'USER_OPENID_QQQ456');
    assert.equal(私.昵称, '阿鲸');
    assert.equal(私.文本, '私聊咨询');

    const 频道 = 消息.find((m) => m.会话类型 === 'channel');
    assert.equal(频道.channel_id, 'CHANNEL_001');
    assert.equal(频道.guild_id, 'GUILD_001');

    const 私信 = 消息.find((m) => m.会话类型 === 'dm');
    assert.equal(私信.guild_id, 'GUILD_002');

    const 审计 = JSON.stringify(读审计(50, 路径));
    assert.match(审计, /收到官方事件/);
    assert.match(审计, /XYZ123/, '审计只留 openid 后 6 位（脱敏）');
    assert.doesNotMatch(审计, /secret-xyz-9876/);
    assert.doesNotMatch(审计, /tok-1/);

    // 归一化单独校验：不认识的事件不猜会话类型
    // 2026-10-30 实测：用户发表情，官方推的是 <faceType=...> XML，不清洗就显示乱码
    test('表情/附件标记转成可读占位（ext 里的 text 优先）', () => {
      assert.equal(清洗官方文本('<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiW+eOq+eRsF0ifQ==">'), '[玫瑰]');
      assert.equal(清洗官方文本('<faceType=1,faceId="1">你好'), '[表情]你好');
      assert.equal(清洗官方文本('看图 <image url="x"/>'), '看图 [图片]');
      const 归一 = 归一化官方事件('C2C_MESSAGE_CREATE', {
        id: 'ROBOT1.0_x', content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiW+eOq+eRsF0ifQ==">',
        author: { user_openid: 'u1' },
      });
      assert.equal(归一.文本, '[玫瑰]');
    });

    const 未知 = 归一化官方事件('SOMETHING_ELSE', {});
    assert.equal(未知.会话类型, 'other');
  } finally {
    断开官方();
  }
});

test('自动回复联动：C2C 入队后立刻被动回复（带 msg_id、来源 auto）', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const { 网络, ws } = await 起官方连接(路径);
    // 面板打开自动回复（连接器每条消息都会读最新配置，不用重连）
    保存配置({
      official_auto_reply: true,
      official_reply_text: '收到～{昵称}，稍后回你',
      official_reply_rules: [{ 关键词: ['价格'], 回复: '价格表：{内容}' }],
      official_reply_scope: 'c2c',
      official_reply_min_interval_ms: 30000,
      official_reply_hourly_cap: 60,
    }, 路径);
    握手(ws);

    ws.推({
      op: 0, t: 'C2C_MESSAGE_CREATE', s: 20,
      d: {
        id: 'MSGID_AUTO_1', content: '请问价格多少', timestamp: new Date().toISOString(),
        author: { user_openid: 'USER_OPENID_AUTO12', username: '阿鲸' },
      },
    });
    await 等条件(() => 网络.状态.发送.length >= 1, '自动回复必须发出去');
    const 请求 = 网络.状态.发送.at(-1);
    assert.equal(请求.地址, 'https://api.sgroup.qq.com/v2/users/USER_OPENID_AUTO12/messages');
    assert.deepEqual(请求.体, { content: '价格表：请问价格多少', msg_type: 0, msg_id: 'MSGID_AUTO_1' });
    assert.match(String(请求.头.authorization), /^QQBot tok-/);

    // 第二条换会话、未命中规则 → 默认模板
    ws.推({
      op: 0, t: 'C2C_MESSAGE_CREATE', s: 21,
      d: {
        id: 'MSGID_AUTO_2', content: '在吗', timestamp: new Date().toISOString(),
        author: { user_openid: 'USER_OPENID_AUTO34', username: '小鲸' },
      },
    });
    await 等条件(() => 网络.状态.发送.length >= 2, '第二条自动回复');
    assert.deepEqual(网络.状态.发送.at(-1).体, { content: '收到～小鲸，稍后回你', msg_type: 0, msg_id: 'MSGID_AUTO_2' });

    // 入队在先、审计两条线都在
    const 收件 = 读收件箱(10, 路径).消息;
    assert.ok(收件.some((m) => m.msg_id === 'MSGID_AUTO_1'));
    const 审计 = 读审计(80, 路径);
    const 自动 = 审计.filter((r) => r.动作 === '自动回复');
    assert.equal(自动.length, 2);
    assert.equal(自动[0].来源, 'auto');
    assert.equal(自动[0].结果, '成功');
    assert.equal(自动[0].规则索引, 0);
    assert.equal(自动[0].关键词, '价格');
    assert.equal(审计.filter((r) => r.动作 === '发送消息' && r.来源 === 'auto').length, 2);
    assert.doesNotMatch(JSON.stringify(审计), /secret-xyz-9876|tok-1/);
  } finally {
    断开官方();
  }
});

test('发送 payload：C2C / 群 / 频道 / 频道私信路径与 msg_id 被动回复', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  try {
    const 网络 = 造假网络();
    const 发送环境 = { 路径, fetchImpl: 网络.impl, 配置: 假配置 };

    const 群 = await 发送官方消息({
      channel: 'group', group_openid: 'GROUP_OPENID_ABCDEF', text: '明天上午', msg_id: 'MSGID_GROUP_1',
    }, 发送环境);
    assert.equal(群.ok, true, JSON.stringify(群));
    assert.equal(群.通道, 'official');
    assert.equal(群.消息号, 'msg-1');
    const 群请求 = 网络.状态.发送.at(-1);
    assert.equal(群请求.地址, 官方基址(读配置(路径)) + '/v2/groups/GROUP_OPENID_ABCDEF/messages');
    assert.deepEqual(群请求.体, { content: '明天上午', msg_type: 0, msg_id: 'MSGID_GROUP_1' });
    assert.match(String(群请求.头.authorization), /^QQBot tok-/);

    const 私 = await 发送官方消息({ channel: 'c2c', openid: 'USER_OPENID_QQQ456', text: '收到' }, 发送环境);
    assert.equal(私.ok, true, JSON.stringify(私));
    const 私请求 = 网络.状态.发送.at(-1);
    assert.equal(私请求.地址, 'https://api.sgroup.qq.com/v2/users/USER_OPENID_QQQ456/messages');
    assert.deepEqual(私请求.体, { content: '收到', msg_type: 0 }, '没有 msg_id 时不能带空字段');

    const 频道 = await 发送官方消息({ channel: 'channel', channel_id: 'CHANNEL_001', text: '频道消息' }, 发送环境);
    assert.equal(频道.ok, true, JSON.stringify(频道));
    assert.equal(网络.状态.发送.at(-1).地址, 'https://api.sgroup.qq.com/channels/CHANNEL_001/messages');

    const 私信 = await 发送官方消息({ guild_id: 'GUILD_002', channel_id: 'CHANNEL_002', text: '私信', msg_id: 'MSGID_DM_1' }, 发送环境);
    assert.equal(私信.ok, true, JSON.stringify(私信));
    assert.equal(私信.会话类型, 'dm');
    assert.equal(网络.状态.发送.at(-1).地址, 'https://api.sgroup.qq.com/dms/GUILD_002/messages');

    // 参数错误：本地拦下，不打网络
    const 前 = 网络.状态.发送.length;
    const 缺 = await 发送官方消息({ channel: 'c2c', text: 'x' }, 发送环境);
    assert.equal(缺.ok, false);
    assert.match(缺.原因, /openid/);
    const 长 = await 发送官方消息({ channel: 'c2c', openid: 'USER_OPENID_QQQ456', text: 'x'.repeat(4001) }, 发送环境);
    assert.equal(长.ok, false);
    assert.match(长.原因, /过长/);
    const 空 = await 发送官方消息({ channel: 'group', group_openid: 'GROUP_OPENID_ABCDEF', text: '   ' }, 发送环境);
    assert.equal(空.ok, false);
    assert.match(空.原因, /为空/);
    const 错通道 = await 发送官方消息({ channel: 'wechat', openid: 'USER_OPENID_QQQ456', text: 'x' }, 发送环境);
    assert.equal(错通道.ok, false);
    assert.match(错通道.原因, /c2c/);
    assert.equal(网络.状态.发送.length, 前, '参数错误不应发出请求');

    // 发送审计：成功 + 拒绝，且不带 token/secret
    const 审计 = JSON.stringify(读审计(50, 路径));
    assert.match(审计, /"通道":"official"/);
    assert.match(审计, /成功/);
    assert.match(审计, /拒绝/);
    assert.doesNotMatch(审计, /secret-xyz-9876/);
    assert.doesNotMatch(审计, /tok-\d/);
  } finally {
    断开官方();
  }
});

test('发送失败：code / message / trace_id 原样回报并入审计', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  const 网络 = 造假网络({ 发送失败: { status: 400, 体: { code: 40054, message: '消息内容不合法', trace_id: 'tr-bad-9' } } });
  const 结果 = await 发送官方消息(
    { channel: 'c2c', openid: 'USER_OPENID_QQQ456', text: '违规内容' },
    { 路径, fetchImpl: 网络.impl, 配置: 假配置 },
  );
  assert.equal(结果.ok, false);
  assert.equal(结果.code, 40054);
  assert.equal(结果.trace_id, 'tr-bad-9');
  assert.match(结果.原因, /40054/);
  assert.match(结果.原因, /消息内容不合法/);
  assert.match(结果.原因, /tr-bad-9/);
  const 审计 = 读审计(20, 路径).filter((r) => r.动作 === '发送消息').at(-1);
  assert.equal(审计.结果, '失败');
  assert.equal(审计.code, 40054);
  assert.equal(审计.trace_id, 'tr-bad-9');
});

test('401 自动清缓存重取 token（gateway 第一次 401，第二次成功）', async () => {
  const { 路径 } = 新家();
  清官方令牌缓存();
  const 网络 = 造假网络({ 网关401: true });
  const 网关 = await 取Gateway(假配置, { fetchImpl: 网络.impl });
  assert.equal(网关.ok, true, JSON.stringify(网关));
  assert.equal(网关.url, 'wss://api.sgroup.qq.com/websocket');
  assert.equal(网络.状态.令牌次数, 2, '401 后必须清缓存重取一次 token');
  assert.equal(网络.状态.网关次数, 2, '401 后必须重发一次 gateway 请求');
  assert.match(String(网络.状态.调用.filter((c) => c.地址.endsWith('/gateway'))[0].头.authorization), /^QQBot tok-/);

  // 沙箱开关走 sandbox 域
  assert.equal(官方基址({ official_sandbox: true }), 'https://sandbox.api.sgroup.qq.com');
  assert.equal(官方基址({ official_sandbox: false }), 'https://api.sgroup.qq.com');
  // 路径不会漏到配置里
  assert.equal(existsSync(join(路径.配置)), false);
});

test('审计脱敏：official_secret / clientSecret / QQBot token 都不落明文', () => {
  const { 路径 } = 新家();
  写审计({
    动作: '演示', official_secret: '官方密钥-abc', appSecret: 'app-secret-xyz',
    错误: 'identify 失败 QQBot tok-abcdef123456', 内容: 'clientSecret=zzz-secret&x=1',
  }, 路径);
  const 原文 = readFileSync(路径.审计, 'utf8');
  assert.equal(statSync(路径.审计).mode & 0o777, 0o600);
  for (const 禁 of ['官方密钥-abc', 'app-secret-xyz', 'tok-abcdef123456', 'zzz-secret']) {
    assert.doesNotMatch(原文, new RegExp(禁.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不应出现 ' + 禁);
  }
  assert.match(原文, /\[已隐藏\]/);
});

test('配置：mode 默认 onebot、官方字段只回掩码、AppSecret 留空不清、可显式清除', async () => {
  const { 路径, 目录 } = 新家();
  assert.equal(读配置(路径).mode, 'onebot', '老配置没有 mode 必须按 onebot');

  const 存 = 保存配置({
    mode: 'official', official_appid: '1904047384', official_secret: 'secret-xyz-9876',
    official_sandbox: true, official_auto_connect: true,
  }, 路径);
  assert.equal(存.ok, true, JSON.stringify(存));
  assert.equal(存.配置.mode, 'official');
  assert.equal(存.配置.official_appid, '1904047384');
  assert.equal(存.配置.has_official_secret, true);
  assert.equal(存.配置.official_ready, true);
  assert.equal(存.配置.official_sandbox, true);
  assert.equal(存.配置.official_auto_connect, true);

  const 原 = readFileSync(join(目录, 'qq-bridge.json'), 'utf8');
  assert.match(原, /secret-xyz-9876/, 'AppSecret 必须在 0600 本机文件里');
  assert.equal(statSync(join(目录, 'qq-bridge.json')).mode & 0o777, 0o600);
  const 对外 = JSON.stringify(脱敏配置(读配置(路径)));
  assert.doesNotMatch(对外, /secret-xyz-9876/);
  assert.match(对外, /••••9876/);

  // 留空 = 不修改
  保存配置({ official_secret: '' }, 路径);
  assert.equal(读配置(路径).official_secret, 'secret-xyz-9876');
  // 显式清除
  保存配置({ clear_official_secret: true }, 路径);
  assert.equal(读配置(路径).official_secret, '');
  // AppID 格式校验
  const 坏 = 保存配置({ official_appid: 'abc' }, 路径);
  assert.equal(坏.ok, false);
  assert.match(坏.原因, /AppID/);
  // mode 只接受两个值
  保存配置({ mode: 'nonsense' }, 路径);
  assert.equal(读配置(路径).mode, 'official');
});

/* ────────────────────────── HTTP 出口 ────────────────────────── */

async function 起本地服务(handler) {
  const 服务 = http.createServer(handler);
  await new Promise((完成) => 服务.listen(0, '127.0.0.1', 完成));
  return {
    基址: 'http://127.0.0.1:' + 服务.address().port,
    关闭: () => new Promise((完成) => 服务.close(完成)),
  };
}

test('HTTP 出口：status / connect / disconnect / send 按 mode 分派', async () => {
  const { 路径 } = 新家();
  const 记录 = { 连接: [], 发送: [], 断开: 0 };
  const 门面 = {
    状态: () => ({ state: '已连接', connected: true, sandbox: false, bot_name: 'feely-bot2', bot_id: '7' }),
    连接: async (配置) => { 记录.连接.push(配置); return { state: '握手中', connected: false, sandbox: false }; },
    断开: () => { 记录.断开 += 1; return { state: '已断开', connected: false }; },
    发送: async (入参) => { 记录.发送.push(入参); return { ok: true, 消息号: 'msg-9', 通道: 'official', 会话类型: 'c2c', 目标: '…456' }; },
    配置变更: () => {},
  };
  const 宿主 = await 起本地服务(建处理器({ 路径, 包根, 官方: 门面 }));
  const 地址 = 宿主.基址 + ROUTE + '/api';
  try {
    // 未配置就 connect → 400
    const 早 = await fetch(地址 + '/official/connect', { method: 'POST' });
    assert.equal(早.status, 400);

    // 保存官方配置（面板路径）
    const 存 = await fetch(地址 + '/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'official', official_appid: '1904047384', official_secret: 'secret-xyz-9876' }),
    });
    assert.equal(存.status, 200);
    const 存体 = await 存.json();
    assert.equal(存体.配置.mode, 'official');
    assert.doesNotMatch(JSON.stringify(存体), /secret-xyz-9876/);

    const 配置响应 = await fetch(地址 + '/config?ts=1');
    const 配置体 = await 配置响应.json();
    assert.equal(配置体.配置.has_official_secret, true);
    assert.doesNotMatch(JSON.stringify(配置体), /secret-xyz-9876/);

    const 状态 = await (await fetch(地址 + '/official/status')).json();
    assert.equal(状态.ok, true);
    assert.equal(状态.状态.connected, true);
    assert.equal(状态.已配置, true);

    const 连 = await fetch(地址 + '/official/connect', { method: 'POST' });
    assert.equal(连.status, 200);
    assert.equal(记录.连接.length, 1);
    assert.equal(记录.连接[0].official_appid, '1904047384');

    // 发送按配置 mode 走官方门面
    const 发 = await fetch(地址 + '/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '面板发送', openid: 'USER_OPENID_QQQ456', channel: 'c2c' }),
    });
    assert.equal(发.status, 200, await 发.clone?.().text?.() || '');
    assert.equal(记录.发送.length, 1);
    assert.equal(记录.发送[0].text, '面板发送');

    const 断 = await fetch(地址 + '/official/disconnect', { method: 'POST' });
    assert.equal(断.status, 200);
    assert.equal(记录.断开, 1);
  } finally {
    await 宿主.关闭();
  }
});

test('没有装配官方门面时：官方路由 501，OneBot 通道照旧', async () => {
  const { 路径 } = 新家();
  保存配置({ mode: 'onebot' }, 路径);
  const 宿主 = await 起本地服务(建处理器({ 路径, 包根 }));
  const 地址 = 宿主.基址 + ROUTE + '/api';
  try {
    const 状态 = await (await fetch(地址 + '/official/status')).json();
    assert.equal(状态.ok, true);
    assert.equal(状态.状态.state, '未装配');
    const 连 = await fetch(地址 + '/official/connect', { method: 'POST' });
    assert.equal(连.status, 501);
    const 配置 = await (await fetch(地址 + '/config')).json();
    assert.equal(配置.配置.mode, 'onebot');
  } finally {
    await 宿主.关闭();
  }
});
