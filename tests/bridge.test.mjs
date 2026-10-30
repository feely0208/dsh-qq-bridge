/**
 * 服务端链路自测：配置 / 发送 / 收上报 / 审计
 * 全程只连本地 http.createServer 假 OneBot 与本地宿主，不碰外网、不碰真实 ~/.dsh。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { 启动假OneBot } from './fake-onebot.mjs';
import {
  解析路径, 校验端点, 保存配置, 读配置, 脱敏配置, 连接测试, 发送消息,
  追加收件箱, 读收件箱, 读审计, 写审计, 脱敏, 建处理器, 校验上报鉴权,
  收件箱上限, ROUTE,
} from '../lib/core.js';

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 每个用例一个隔离的“家目录”，绝不污染真实 ~/.dsh */
function 新家() {
  const 目录 = mkdtempSync(join(tmpdir(), 'qq-bridge-test-'));
  process.env.DSH_QQ_BRIDGE_HOME = 目录;
  return { 目录, 路径: 解析路径() };
}

async function 起本地服务(handler) {
  const 服务 = http.createServer(handler);
  await new Promise((完成) => 服务.listen(0, '127.0.0.1', 完成));
  const 端口 = 服务.address().port;
  return {
    基址: 'http://127.0.0.1:' + 端口,
    关闭: () => new Promise((完成) => 服务.close(完成)),
  };
}

test('端点校验：只允许 http(s)，拒绝账号/查询串，去掉尾部斜杠', () => {
  assert.equal(校验端点('http://127.0.0.1:3000/').值, 'http://127.0.0.1:3000');
  assert.equal(校验端点('https://bot.example.com/onebot/').值, 'https://bot.example.com/onebot');
  assert.match(校验端点('ftp://127.0.0.1:3000').错, /只允许 http\(s\)/);
  assert.match(校验端点('http://user:pass@127.0.0.1:3000').错, /用户名\/密码/);
  assert.match(校验端点('http://127.0.0.1:3000/?access_token=x').错, /查询串/);
  assert.match(校验端点('').错, /不能为空/);
});

test('配置：token 落本机 0600，对外只给掩码，坏文件退回默认值', () => {
  const { 路径, 目录 } = 新家();
  const 保存 = 保存配置({ endpoint: 'http://127.0.0.1:3000/', access_token: 'supersecret-token', hook_secret: 'hook-secret-xyz' }, 路径);
  assert.equal(保存.ok, true);
  assert.equal(保存.配置.endpoint, 'http://127.0.0.1:3000');
  assert.equal(保存.配置.has_token, true);

  const 原 = readFileSync(join(目录, 'qq-bridge.json'), 'utf8');
  assert.match(原, /supersecret-token/, '真 token 必须在本机文件里（面板要能发消息）');
  assert.equal(statSync(join(目录, 'qq-bridge.json')).mode & 0o777, 0o600, '配置必须是 0600');

  const 对外 = JSON.stringify(脱敏配置(读配置(路径)));
  assert.doesNotMatch(对外, /supersecret-token/);
  assert.doesNotMatch(对外, /hook-secret-xyz/);
  assert.match(对外, /••••oken/);

  // 空字符串 = 不覆盖已有 token（面板留空即不改）
  保存配置({ endpoint: 'http://127.0.0.1:3999', access_token: '' }, 路径);
  assert.equal(读配置(路径).access_token, 'supersecret-token');
  保存配置({ clear_token: true }, 路径);
  assert.equal(读配置(路径).access_token, '');

  const 坏 = join(目录, 'bad.json');
  assert.deepEqual(读配置({ 配置: 坏, 审计: '', 收件箱: '' }).endpoint, 'http://127.0.0.1:3000');
});

test('发送链路：私聊/群聊打假 OneBot，token 走请求头，成功与失败都写审计', async () => {
  const { 路径 } = 新家();
  const 假 = await 启动假OneBot({ token: 'tk-123456' });
  try {
    保存配置({ endpoint: 假.地址, access_token: 'tk-123456' }, 路径);

    const 私 = await 发送消息({ target: '123456789', target_type: 'private', text: '深鲸测试' }, { 路径 });
    assert.equal(私.ok, true, JSON.stringify(私));
    assert.equal(私.消息号, 9001);
    const 第一条 = 假.收到.at(-1);
    assert.equal(第一条.动作, 'send_private_msg');
    assert.equal(第一条.体.user_id, 123456789);
    assert.equal(第一条.体.message, '深鲸测试');
    assert.equal(第一条.头.authorization, 'Bearer tk-123456');

    const 群 = await 发送消息({ target: '987654321', target_type: 'group', text: '群通知' }, { 路径, 来源: 'tool' });
    assert.equal(群.ok, true, JSON.stringify(群));
    assert.equal(假.收到.at(-1).动作, 'send_group_msg');
    assert.equal(假.收到.at(-1).体.group_id, 987654321);

    const 登录 = await 连接测试(读配置(路径), { 路径 });
    assert.equal(登录.ok, true, JSON.stringify(登录));
    assert.equal(登录.帐号, '10001');
    assert.equal(登录.昵称, '深鲸测试号');

    假.失败动作.add('send_private_msg');
    const 败 = await 发送消息({ target: '123456789', target_type: 'private', text: '会失败' }, { 路径 });
    assert.equal(败.ok, false);
    assert.match(败.原因, /模拟失败/);

    // 参数错误在本地拦下，不打网络
    const 前 = 假.收到.length;
    const 空 = await 发送消息({ target: '123', target_type: 'private', text: 'x' }, { 路径 });
    assert.equal(空.ok, false);
    assert.match(空.原因, /5~20 位数字/);
    const 长 = await 发送消息({ target: '123456789', target_type: 'private', text: 'x'.repeat(4001) }, { 路径 });
    assert.equal(长.ok, false);
    assert.match(长.原因, /过长/);
    assert.equal(假.收到.length, 前, '参数错误不应发出请求');

    const 审计 = 读审计(50, 路径);
    assert.ok(审计.some((r) => r.动作 === '发送消息' && r.结果 === '成功' && r.目标 === '123456789'));
    assert.ok(审计.some((r) => r.动作 === '发送消息' && r.结果 === '失败' && /模拟失败/.test(r.错误)));
    assert.ok(审计.some((r) => r.动作 === '连接测试' && r.结果 === '成功'));
    // token 不能出现在审计里
    assert.doesNotMatch(JSON.stringify(审计), /tk-123456/);
  } finally {
    await 假.关闭();
  }
});

test('上报入口：URL 自解析、签名/token 校验、入队与审计、徽章', async () => {
  const { 路径 } = 新家();
  保存配置({ endpoint: 'http://127.0.0.1:3000', hook_secret: 'shared-secret' }, 路径);
  const handler = 建处理器({ 路径, 包根 });
  const 宿主 = await 起本地服务(handler);
  const 事件 = {
    post_type: 'message', message_type: 'group', message_id: 501, time: 1760000000,
    self_id: 10001, group_id: 777888, user_id: 10002,
    sender: { nickname: '阿鲸', card: '客户A' },
    raw_message: '你好，想咨询合同',
    message: [{ type: 'text', data: { text: '你好，想咨询合同' } }],
  };
  const 体 = JSON.stringify(事件);
  const 地址 = 宿主.基址 + ROUTE + '/api';
  try {
    // 查询串必须被当查询，而不是路径
    const 配置响应 = await fetch(地址 + '/config?ts=1');
    assert.equal(配置响应.status, 200);
    const 配置体 = await 配置响应.json();
    assert.equal(配置体.ok, true);
    assert.equal(配置体.配置.has_hook_secret, true);
    assert.doesNotMatch(JSON.stringify(配置体), /shared-secret/);

    const 审计响应 = await fetch(地址 + '/audit?limit=2');
    assert.equal(审计响应.status, 200, '带查询串不能 404');
    assert.equal((await 审计响应.json()).ok, true);

    const 徽章 = await fetch(地址 + '/badge');
    assert.equal(徽章.status, 200);
    assert.equal(徽章.headers.get('content-type'), 'image/png');
    assert.ok((await 徽章.arrayBuffer()).byteLength > 1000);

    // 无鉴权
    const 裸 = await fetch(地址 + '/hook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 体 });
    assert.equal(裸.status, 401);
    // 错签名
    const 错签 = await fetch(地址 + '/hook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'sha1=' + '0'.repeat(40) }, body: 体,
    });
    assert.equal(错签.status, 401);
    // 正确 HMAC-SHA1
    const 签名 = 'sha1=' + createHmac('sha1', 'shared-secret').update(体, 'utf8').digest('hex');
    const 收 = await fetch(地址 + '/hook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 签名 }, body: 体,
    });
    assert.equal(收.status, 204);

    const 收件 = 读收件箱(10, 路径);
    assert.equal(收件.总数, 1);
    assert.equal(收件.消息[0].group_id, '777888');
    assert.equal(收件.消息[0].昵称, '客户A');
    assert.match(收件.消息[0].文本, /咨询合同/);

    const 审计 = 读审计(20, 路径);
    const 入队 = 审计.filter((r) => r.动作 === '收到上报');
    assert.equal(入队.at(-1).结果, '入队');
    assert.equal(入队.at(-1).鉴权, 'X-Signature');
    assert.match(JSON.stringify(审计), /咨询合同/);
    assert.doesNotMatch(JSON.stringify(审计), /shared-secret/);

    // Bearer 方式也能过
    const 第二体 = JSON.stringify({ ...事件, message_id: 502 });
    const 带令牌 = await fetch(地址 + '/hook', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shared-secret' }, body: 第二体,
    });
    assert.equal(带令牌.status, 204);
    assert.equal(读收件箱(10, 路径).总数, 2);

    // 非 JSON / 未知路径
    const 坏体 = await fetch(地址 + '/hook', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer shared-secret' }, body: '{oops',
    });
    assert.equal(坏体.status, 400);
    const 无 = await fetch(地址 + '/nope');
    assert.equal(无.status, 404);
  } finally {
    await 宿主.关闭();
  }
});

test('上报队列上限 1000，最旧的先丢', () => {
  const { 路径 } = 新家();
  for (let i = 0; i < 收件箱上限 + 3; i += 1) {
    追加收件箱({ post_type: 'message', message_type: 'private', user_id: 1, message_id: i, raw_message: 'msg-' + i }, 路径);
  }
  const 结果 = 读收件箱(收件箱上限, 路径);
  assert.equal(结果.消息.length, 1000);
  assert.equal(结果.总数, 1000);
  assert.equal(结果.消息[0].文本, 'msg-3');
  assert.equal(结果.消息.at(-1).文本, 'msg-1002');
});

test('审计脱敏：敏感键与 Bearer 串都不落明文', () => {
  const { 路径 } = 新家();
  写审计({
    动作: '演示', access_token: 'plain-token-abc', token: 'another-secret',
    错误: '调用失败 Bearer abc.def.ghi', 内容: 'access_token=zzz-secret&x=1',
  }, 路径);
  const 原文 = readFileSync(路径.审计, 'utf8');
  assert.equal(statSync(路径.审计).mode & 0o777, 0o600, '审计含消息正文，必须 0600');
  for (const 禁 of ['plain-token-abc', 'another-secret', 'abc.def.ghi', 'zzz-secret']) {
    assert.doesNotMatch(原文, new RegExp(禁.replace(/[.]/g, '\\.')), '不应出现 ' + 禁);
  }
  assert.match(原文, /\[已隐藏\]/);
  assert.equal(脱敏('Bearer deadbeef1234').includes('deadbeef'), false);
});

test('宿主传 URL 对象时查询串仍按查询解析（2026-10-30 踩过的坑）', async () => {
  const { 路径 } = 新家();
  const handler = 建处理器({ 路径, 包根 });
  // 模拟宿主第三个参数是 URL 对象，而不是 req.url 字符串
  const 宿主 = await 起本地服务((req, res) => handler(req, res, new URL(req.url || '/', 'http://local')));
  try {
    const 响应 = await fetch(宿主.基址 + ROUTE + '/api/audit?limit=3');
    assert.equal(响应.status, 200);
    assert.equal((await 响应.json()).ok, true);
    const 收件 = await fetch(宿主.基址 + ROUTE + '/api/inbox?limit=2');
    assert.equal(收件.status, 200);
    assert.equal((await 收件.json()).ok, true);
  } finally {
    await 宿主.关闭();
  }
});

test('上报鉴权：未配置密钥时放行但注明方式', () => {
  const 空 = 校验上报鉴权({}, '{}', { hook_secret: '', access_token: '' });
  assert.equal(空.ok, true);
  assert.equal(空.方式, '未配置共享密钥');
  const 缺 = 校验上报鉴权({}, '{}', { hook_secret: 's', access_token: '' });
  assert.equal(缺.ok, false);
  const 格式 = 校验上报鉴权({ 'x-signature': 'md5=abc' }, '{}', { hook_secret: 's', access_token: '' });
  assert.match(格式.原因, /格式/);
});
