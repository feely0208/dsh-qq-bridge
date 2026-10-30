/**
 * 自动回复自测（全程离线）：规则匹配 / 占位符 / 默认模板 / scope / 防刷 / 过期 / 暂停 / 审计
 * 不联外网、不碰真实 ~/.dsh；发送器全部用假实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  解析路径, 读审计, 保存配置, 读配置, 脱敏配置, 归一化回复规则, 自动回复配置,
} from '../lib/core.js';
import {
  匹配规则, 渲染模板, 消息时刻毫秒, 评估自动回复, 触发自动回复,
  造自动回复状态, 重置自动回复状态, 设自动回复状态, 自动回复统计, 恢复自动回复,
  设自动回复发送器, 默认回复模板, 回复窗口毫秒, 失败暂停阈值,
} from '../lib/autoreply.js';

const 基准 = new Date('2026-10-30T10:00:00+08:00').getTime();

function 新家() {
  const 目录 = mkdtempSync(join(tmpdir(), 'qq-autoreply-test-'));
  process.env.DSH_QQ_BRIDGE_HOME = 目录;
  return { 目录, 路径: 解析路径() };
}

function 造配置(额外 = {}) {
  return {
    official_auto_reply: true,
    official_reply_text: '默认回复',
    official_reply_rules: [],
    official_reply_scope: 'c2c',
    official_reply_min_interval_ms: 30000,
    official_reply_hourly_cap: 60,
    ...额外,
  };
}

const c2c = (文本, 额外 = {}) => ({
  来源通道: 'official', 会话类型: 'c2c', openid: 'USER_OPENID_QQQ456',
  group_openid: '', msg_id: 'MSGID_1', 昵称: '阿鲸', 文本,
  时刻: new Date(基准).toISOString(), ...额外,
});
const 群 = (文本, 额外 = {}) => ({
  来源通道: 'official', 会话类型: 'group', group_openid: 'GROUP_OPENID_ABCDEF',
  openid: 'MEMBER_OPENID_XYZ123', msg_id: 'MSGID_G1', 昵称: '', 文本,
  时刻: new Date(基准).toISOString(), ...额外,
});
const 数据 = (时刻毫秒 = 基准) => ({ timestamp: new Date(时刻毫秒).toISOString() });

/** 假发送器：记录每次调用，按要求成功/失败 */
function 假发送(结果 = { ok: true, 消息号: 'msg-auto-1' }) {
  const 调用 = [];
  const fn = async (入参, 选项) => { 调用.push({ 入参, 选项 }); return 结果; };
  fn.调用 = 调用;
  return fn;
}

/* ────────────────────────── 规则与模板 ────────────────────────── */

test('规则：按顺序命中第一条；包含/精确/正则三种模式；坏正则跳过', () => {
  const 规则 = [
    { 关键词: ['价格', '多少钱'], 回复: '价格表发你了', 模式: '包含' },
    { 关键词: ['你好'], 回复: '你好呀', 模式: '精确' },
    { 关键词: ['^订单\\d+$'], 回复: '这就查订单', 模式: '正则' },
    { 关键词: ['你好'], 回复: '第二条你好', 模式: '包含' },
  ];
  const 一 = 匹配规则(规则, '请问价格是多少');
  assert.equal(一.命中, true);
  assert.equal(一.索引, 0);
  assert.equal(一.关键词, '价格', '同一规则里先命中的关键词为准');

  assert.equal(匹配规则(规则, '多少钱').索引, 0);
  assert.equal(匹配规则(规则, '你好').索引, 1, '精确模式：完全相等才命中');
  assert.equal(匹配规则(规则, '你好啊').索引, 3, '精确不命中 → 落到后面的包含规则');
  assert.equal(匹配规则(规则, '订单123').索引, 2, '正则模式');
  const 未命中 = 匹配规则(规则, '订单abc');
  assert.equal(未命中.命中, false);
  assert.equal(未命中.索引, -1);

  // 坏正则不能让整条链路报错：这条跳过，下一条继续
  const 坏 = [{ 关键词: ['['], 回复: 'x', 模式: '正则' }, { 关键词: ['价格'], 回复: 'y' }];
  assert.equal(匹配规则(坏, '价格').索引, 1);

  // 模式缺省 = 包含；大小写不敏感（英文）
  assert.equal(匹配规则([{ 关键词: ['Hello'], 回复: 'hi' }], 'say hello').索引, 0);
  // 空规则表/坏输入不抛错
  assert.equal(匹配规则(null, 'x').命中, false);
  assert.equal(匹配规则([], '').命中, false);
});

test('模板占位符：{昵称}{内容}{时间}；没昵称用「你」；未知占位符原样保留', () => {
  const 文本 = 渲染模板('{昵称}，你问的是「{内容}」，现在是 {时间}', {
    昵称: '阿鲸', 内容: '价格', 现在: 基准,
  });
  assert.match(文本, /^阿鲸，你问的是「价格」，现在是 \d{2}:\d{2}$/);
  assert.equal(渲染模板('{昵称}', {}), '你');
  assert.equal(渲染模板('{未知}占位', {}), '{未知}占位');
  assert.equal(渲染模板('', {}), '');
  assert.equal(渲染模板('收到～'), '收到～');
});

test('消息时刻：解析官方 ISO 时间戳；解析不出来按新消息处理', () => {
  assert.equal(消息时刻毫秒({ timestamp: '2026-10-30T10:00:00+08:00' }), 基准);
  assert.equal(消息时刻毫秒({ timestamp: 'not-a-date' }), null);
  assert.equal(消息时刻毫秒({}), null);
});

/* ────────────────────────── 评估（不发请求） ────────────────────────── */

test('默认模板：未命中走 official_reply_text；模板为空则跳过', () => {
  const 状态 = 造自动回复状态();
  const 命 = 评估自动回复({ 记录: c2c('随便说点什么'), 数据: 数据(), 配置: 造配置(), 状态, 现在: 基准 });
  assert.equal(命.动作, '回复');
  assert.equal(命.正文, '默认回复');
  assert.equal(命.命中.命中, false);

  const 空 = 评估自动回复({
    记录: c2c('随便'), 数据: 数据(), 配置: 造配置({ official_reply_text: '' }), 状态, 现在: 基准,
  });
  assert.equal(空.动作, '跳过');
  assert.match(空.原因, /回复模板为空/);

  // 命中规则但规则回复是空串 → 也跳过（不能发空消息）
  const 空规则 = 评估自动回复({
    记录: c2c('价格'), 数据: 数据(),
    配置: 造配置({ official_reply_rules: [{ 关键词: ['价格'], 回复: '  ' }] }), 状态, 现在: 基准,
  });
  assert.equal(空规则.动作, '跳过');
  assert.match(空规则.原因, /回复模板为空/);

  // 入站没有可读文本 → 跳过
  const 无文本 = 评估自动回复({ 记录: c2c('  '), 数据: 数据(), 配置: 造配置(), 状态, 现在: 基准 });
  assert.equal(无文本.动作, '跳过');
  assert.match(无文本.原因, /没有可读文本/);

  // 开关没开 → 跳过
  const 关 = 评估自动回复({ 记录: c2c('在吗'), 数据: 数据(), 配置: 造配置({ official_auto_reply: false }), 状态, 现在: 基准 });
  assert.equal(关.动作, '跳过');
  assert.match(关.原因, /未开启/);
});

test('scope：默认只回私聊；all 才回群；频道/私信永远不自动回', () => {
  const 状态 = 造自动回复状态();
  assert.equal(评估自动回复({ 记录: c2c('在吗'), 数据: 数据(), 配置: 造配置(), 状态, 现在: 基准 }).动作, '回复');

  const 群跳过 = 评估自动回复({ 记录: 群('@机器人 在吗'), 数据: 数据(), 配置: 造配置(), 状态, 现在: 基准 });
  assert.equal(群跳过.动作, '跳过');
  assert.match(群跳过.原因, /范围只允许私聊/);

  assert.equal(评估自动回复({
    记录: 群('@机器人 在吗'), 数据: 数据(), 配置: 造配置({ official_reply_scope: 'all' }), 状态, 现在: 基准,
  }).动作, '回复');

  const 频道 = 评估自动回复({
    记录: { 会话类型: 'channel', channel_id: 'CH1', 文本: 'x' }, 数据: 数据(),
    配置: 造配置({ official_reply_scope: 'all' }), 状态, 现在: 基准,
  });
  assert.equal(频道.动作, '跳过');
  assert.match(频道.原因, /会话类型不在/);
});

/* ────────────────────────── 发送与防刷 ────────────────────────── */

test('秒回：一调用就把被动回复发出去（带 msg_id、走 c2c），并更新统计', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 发送 = 假发送();
  const 结果 = await 触发自动回复(c2c('价格多少'), 数据(), { 路径, 配置: 造配置(), 状态, 发送, 现在: 基准 });
  assert.equal(结果.动作, '回复');
  assert.equal(结果.成功, true);
  assert.equal(发送.调用.length, 1, '必须立刻发，不能等轮询');
  assert.deepEqual(
    { channel: 发送.调用[0].入参.channel, openid: 发送.调用[0].入参.openid, msg_id: 发送.调用[0].入参.msg_id },
    { channel: 'c2c', openid: 'USER_OPENID_QQQ456', msg_id: 'MSGID_1' },
  );
  assert.equal(发送.调用[0].入参.text, '默认回复');
  assert.equal(发送.调用[0].选项.来源, 'auto', '发送也要标来源 auto');

  assert.equal(状态.今日.次数, 1);
  assert.equal(状态.小时窗口.length, 1);
  assert.equal(状态.连续失败, 0);
  assert.equal(状态.上次规则, null);
});

test('并发到达：同一会话只回一条（第二条让路），不同会话可并行', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  let 放行 = null;
  const 门 = new Promise((完成) => { 放行 = 完成; });
  const 调用 = [];
  const 慢发送 = async (入参) => { 调用.push(入参); await 门; return { ok: true, 消息号: 'msg-late' }; };

  const 第一条 = 触发自动回复(c2c('一'), 数据(), { 路径, 配置: 造配置(), 状态, 发送: 慢发送, 现在: 基准 });
  const 第二条 = 触发自动回复(c2c('二'), 数据(), { 路径, 配置: 造配置(), 状态, 发送: 慢发送, 现在: 基准 });
  const 第二条结果 = await 第二条;
  assert.equal(第二条结果.动作, '跳过', '同一会话的上一条还在发，第二条必须让路');
  assert.match(第二条结果.原因, /正在回复中/);
  assert.equal(调用.length, 1);

  // 另一个会话可以并行
  const 别的 = 触发自动回复(c2c('三', { openid: 'USER_OPENID_OTHER99' }), 数据(), { 路径, 配置: 造配置(), 状态, 发送: 慢发送, 现在: 基准 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(调用.length, 2, '不同会话之间不能互相锁');

  放行();
  await Promise.all([第一条, 别的]);
  assert.equal(状态.进行中.size, 0, '发完必须释放');
  assert.equal(状态.今日.次数, 2);
});

test('同一会话最小间隔；换会话/间隔为 0 可继续', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 发送 = 假发送();
  const 配置 = 造配置({ official_reply_min_interval_ms: 30000 });

  await 触发自动回复(c2c('一'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 });
  const 快 = await 触发自动回复(c2c('二'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 + 1000 });
  assert.equal(快.动作, '跳过');
  assert.match(快.原因, /最小间隔/);
  assert.equal(发送.调用.length, 1, '间隔内不能发第二条');

  // 换一个 openid = 另一个会话，可以回
  const 别人 = await 触发自动回复(c2c('三', { openid: 'USER_OPENID_OTHER99' }), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 + 1000 });
  assert.equal(别人.动作, '回复');

  // 间隔过 30s 后可以回
  const 后 = await 触发自动回复(c2c('四'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 + 30001 });
  assert.equal(后.动作, '回复');

  // 间隔配 0 = 不限
  const 零 = 造配置({ official_reply_min_interval_ms: 0 });
  const 零态 = 造自动回复状态();
  await 触发自动回复(c2c('a'), 数据(), { 路径, 配置: 零, 状态: 零态, 发送, 现在: 基准 });
  const 连发 = await 触发自动回复(c2c('b'), 数据(), { 路径, 配置: 零, 状态: 零态, 发送, 现在: 基准 });
  assert.equal(连发.动作, '回复');
});

test('全局每小时上限；超过一小时的旧记录会被清掉', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  状态.小时窗口 = Array.from({ length: 3 }, () => 基准 - 1000);
  const 配置 = 造配置({ official_reply_hourly_cap: 3 });
  const 发送 = 假发送();

  const 满 = await 触发自动回复(c2c('还能回吗'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 });
  assert.equal(满.动作, '跳过');
  assert.match(满.原因, /每小时上限/);
  assert.equal(发送.调用.length, 0);

  // 窗口里的记录都超过 1 小时 → 清空后可以继续
  状态.小时窗口 = Array.from({ length: 3 }, () => 基准 - 3600000 - 1);
  const 空 = await 触发自动回复(c2c('现在呢'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 });
  assert.equal(空.动作, '回复');
});

test('过期不尝试：msg_id 超过 4.5 分钟直接跳过，不发请求', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 发送 = 假发送();
  const 旧 = 基准 - 回复窗口毫秒 - 1000;
  const 结果 = await 触发自动回复(c2c('老消息'), 数据(旧), { 路径, 配置: 造配置(), 状态, 发送, 现在: 基准 });
  assert.equal(结果.动作, '跳过');
  assert.match(结果.原因, /4\.5 分钟/);
  assert.equal(发送.调用.length, 0, '过期绝不能发（平台会 40034005）');

  // 刚好在窗口内 → 回
  const 新 = await 触发自动回复(c2c('新消息'), 数据(基准 - 1000), { 路径, 配置: 造配置(), 状态, 发送, 现在: 基准 });
  assert.equal(新.动作, '回复');
});

test('连续失败 3 次自动暂停；手动恢复后继续；失败不计入今日次数', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 配置 = 造配置({ official_reply_min_interval_ms: 0 });
  const 失败发送 = 假发送({ ok: false, 原因: '模拟 40034005 回复消息msg_id已过期', code: 40034005 });

  for (let i = 1; i <= 失败暂停阈值; i += 1) {
    const r = await 触发自动回复(c2c('第' + i + '条', { openid: 'USER_OPENID_QQQ45' + i }), 数据(), {
      路径, 配置, 状态, 发送: 失败发送, 现在: 基准,
    });
    assert.equal(r.成功, false);
    assert.equal(r.连续失败, i);
    assert.equal(r.已暂停, i >= 失败暂停阈值);
  }
  assert.equal(状态.暂停, true);
  assert.match(状态.暂停原因, /3 次/);
  assert.match(状态.暂停原因, /40034005/);
  assert.equal(状态.今日.次数, 0, '失败不算「已自动回复」');

  // 暂停后不再发
  const 前 = 失败发送.调用.length;
  const 停 = await 触发自动回复(c2c('还在吗', { openid: 'USER_OPENID_NEW999' }), 数据(), {
    路径, 配置, 状态, 发送: 失败发送, 现在: 基准,
  });
  assert.equal(停.动作, '跳过');
  assert.match(停.原因, /已暂停/);
  assert.equal(失败发送.调用.length, 前);

  设自动回复状态(状态);
  const 统计 = 自动回复统计(配置, 基准);
  assert.equal(统计.运行状态, '已暂停');
  assert.equal(统计.暂停, true);

  const 恢复后 = 恢复自动回复({ 路径, 配置, 状态, 现在: 基准 });
  assert.equal(恢复后.运行状态, '运行中');
  assert.equal(恢复后.连续失败, 0);
  assert.equal(状态.暂停, false);

  // 恢复后能继续回
  const 继续 = await 触发自动回复(c2c('好了吗', { openid: 'USER_OPENID_NEW999' }), 数据(), {
    路径, 配置, 状态, 发送: 假发送(), 现在: 基准,
  });
  assert.equal(继续.动作, '回复');
  重置自动回复状态();
});

test('审计：来源 auto + 规则索引/关键词/命中内容；失败也写', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 规则 = [
    { 关键词: ['你好'], 回复: '你好呀' },
    { 关键词: ['价格'], 回复: '{昵称}，价格表发你了' },
  ];
  await 触发自动回复(c2c('请问价格'), 数据(), {
    路径, 配置: 造配置({ official_reply_rules: 规则 }), 状态, 发送: 假发送(), 现在: 基准,
  });
  await 触发自动回复(c2c('价格又变了', { openid: 'USER_OPENID_QQQ999', msg_id: 'MSGID_2' }), 数据(), {
    路径, 配置: 造配置({ official_reply_rules: 规则 }), 状态,
    发送: 假发送({ ok: false, 原因: '模拟失败', code: 40054 }), 现在: 基准,
  });

  const 审计 = 读审计(50, 路径).filter((r) => r.动作 === '自动回复');
  assert.equal(审计.length, 2);
  assert.equal(审计[0].来源, 'auto');
  assert.equal(审计[0].结果, '成功');
  assert.equal(审计[0].规则索引, 1);
  assert.equal(审计[0].关键词, '价格');
  assert.equal(审计[0].匹配模式, '包含');
  assert.match(审计[0].内容, /阿鲸，价格表发你了/);
  assert.equal(审计[0].被动回复, 'msg_id');
  assert.equal(审计[1].结果, '失败');
  assert.equal(审计[1].code, 40054);
  assert.match(String(审计[1].错误), /模拟失败/);
});

test('空模板跳过要留审计；没有 msg_id 不尝试（避免 40034105）', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 发送 = 假发送();
  const 空 = await 触发自动回复(c2c('随便'), 数据(), {
    路径, 配置: 造配置({ official_reply_text: '' }), 状态, 发送, 现在: 基准,
  });
  assert.equal(空.动作, '跳过');
  const 审计 = 读审计(20, 路径).filter((r) => r.动作 === '自动回复');
  assert.equal(审计.length, 1, '空回复属于配置错误，要留痕');
  assert.equal(审计[0].结果, '跳过');
  assert.match(String(审计[0].错误), /回复模板为空/);

  const 无号 = await 触发自动回复(c2c('在吗', { msg_id: '' }), 数据(), {
    路径, 配置: 造配置(), 状态, 发送, 现在: 基准,
  });
  assert.equal(无号.动作, '跳过');
  assert.match(无号.原因, /缺少 msg_id/);
  assert.equal(发送.调用.length, 0);
});

test('跳过只计数不刷审计；统计能区分跳过类别', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  const 发送 = 假发送();
  const 配置 = 造配置({ official_auto_reply: false });
  await 触发自动回复(c2c('在吗'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 });
  await 触发自动回复(c2c('在吗'), 数据(), { 路径, 配置, 状态, 发送, 现在: 基准 });
  const 审计 = 读审计(20, 路径).filter((r) => r.动作 === '自动回复');
  assert.equal(审计.length, 0, '跳过不逐条写审计（否则每条入站都多一行）');
  assert.equal(状态.跳过['自动回复未开启'], 2);
  assert.equal(发送.调用.length, 0);
});

test('规则归一化：字符串关键词、坏项丢弃、模式校验、上限', () => {
  const 规则 = 归一化回复规则([
    { 关键词: '你好,价格，在吗', 回复: 'hi', 模式: '精确' },
    { 关键词: ['  '], 回复: '空关键词要丢' },
    { 关键词: ['x'], 回复: 'y', 模式: '乱写' },
    null,
    'not-an-object',
  ]);
  assert.equal(规则.length, 2);
  assert.deepEqual(规则[0].关键词, ['你好', '价格', '在吗']);
  assert.equal(规则[0].模式, '精确');
  assert.equal(规则[1].模式, '包含', '非法模式回落到包含');
  assert.deepEqual(归一化回复规则('oops'), []);
});

/* ────────────────────────── 配置与 HTTP ────────────────────────── */

test('配置：自动回复默认关、规则/数值落盘后可读、非法数值拒绝', () => {
  const { 路径 } = 新家();
  const 默 = 读配置(路径);
  assert.equal(默.official_auto_reply, false, '默认必须关闭');
  assert.equal(默.official_reply_scope, 'c2c');
  assert.equal(默.official_reply_min_interval_ms, 30000);
  assert.equal(默.official_reply_hourly_cap, 60);
  assert.equal(默.official_reply_text, 默认回复模板);

  const 存 = 保存配置({
    mode: 'official', official_appid: '1904047384', official_secret: 'secret-xyz-9876',
    official_auto_reply: true,
    official_reply_text: '{昵称}你好',
    official_reply_rules: [{ 关键词: ['价格'], 回复: '10 元' }],
    official_reply_scope: 'all',
    official_reply_min_interval_ms: 5000,
    official_reply_hourly_cap: 10,
  }, 路径);
  assert.equal(存.ok, true, JSON.stringify(存));
  const 回 = 读配置(路径);
  assert.equal(回.official_auto_reply, true);
  assert.equal(回.official_reply_text, '{昵称}你好');
  assert.equal(回.official_reply_rules[0].关键词[0], '价格');
  assert.equal(回.official_reply_scope, 'all');
  assert.equal(回.official_reply_min_interval_ms, 5000);
  assert.equal(回.official_reply_hourly_cap, 10);

  const 对外 = 自动回复配置(回);
  assert.equal(对外.official_auto_reply, true);
  assert.equal(对外.official_reply_rules.length, 1);
  const 全量 = JSON.stringify(脱敏配置(回));
  assert.doesNotMatch(全量, /secret-xyz-9876/);

  // 非法值在本地拦下
  assert.equal(保存配置({ official_reply_min_interval_ms: -1 }, 路径).ok, false);
  assert.equal(保存配置({ official_reply_hourly_cap: 99999 }, 路径).ok, false);
  // 非法 scope 静默忽略（保持原值）
  保存配置({ official_reply_scope: 'wechat' }, 路径);
  assert.equal(读配置(路径).official_reply_scope, 'all');

  // 坏规则不会让整份配置读不出来
  assert.deepEqual(归一化回复规则([{ 关键词: [], 回复: 'x' }]), []);
});

test('HTTP：/api/official/autoreply 读写 + 恢复暂停', async () => {
  const http = await import('node:http');
  const { 建处理器, ROUTE } = await import('../lib/core.js');
  const { 路径 } = 新家();
  const 调用 = { 恢复: 0 };
  const 门面 = {
    状态: () => ({ state: '已连接', connected: true }),
    连接: async () => ({ state: '握手中' }),
    断开: () => ({ state: '已断开' }),
    发送: async () => ({ ok: true }),
    配置变更: () => {},
    自动回复: {
      统计: () => ({ 运行状态: '已暂停', 暂停: true, 暂停原因: '连续 3 次自动回复失败：模拟', 今日次数: 0, 小时次数: 0, 每小时上限: 10 }),
      恢复: () => { 调用.恢复 += 1; return { 运行状态: '运行中', 暂停: false }; },
    },
  };
  const 服务 = http.createServer(建处理器({ 路径, 官方: 门面 }));
  await new Promise((完成) => 服务.listen(0, '127.0.0.1', 完成));
  const 地址 = 'http://127.0.0.1:' + 服务.address().port + ROUTE + '/api/official/autoreply';
  try {
    const 初 = await (await fetch(地址)).json();
    assert.equal(初.ok, true);
    assert.equal(初.配置.official_auto_reply, false);
    assert.equal(初.统计.运行状态, '已暂停');
    assert.match(初.统计.暂停原因, /连续 3 次/);

    const 存 = await fetch(地址, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        official_auto_reply: true,
        official_reply_text: '收到',
        official_reply_rules: [{ 关键词: ['价格'], 回复: '10 元' }],
        official_reply_scope: 'all',
        official_reply_min_interval_ms: 1000,
        official_reply_hourly_cap: 5,
      }),
    });
    assert.equal(存.status, 200);
    const 存体 = await 存.json();
    assert.equal(存体.配置.official_auto_reply, true);
    assert.equal(存体.配置.official_reply_rules[0].回复, '10 元');
    assert.equal(读配置(路径).official_reply_hourly_cap, 5);

    // 恢复暂停
    const 恢 = await fetch(地址, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 恢复: true }),
    });
    const 恢体 = await 恢.json();
    assert.equal(恢体.已恢复, true);
    assert.equal(调用.恢复, 1);

    // 非法数值 → 400
    const 坏 = await fetch(地址, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ official_reply_hourly_cap: 999999 }),
    });
    assert.equal(坏.status, 400);
  } finally {
    await new Promise((完成) => 服务.close(完成));
  }
});

test('发送器注入：设自动回复发送器 后不传 发送 也能发；不装时跳过', async () => {
  const { 路径 } = 新家();
  const 状态 = 造自动回复状态();
  设自动回复发送器(null);
  const 无 = await 触发自动回复(c2c('价格'), 数据(), { 路径, 配置: 造配置(), 状态, 现在: 基准 });
  assert.equal(无.动作, '跳过');
  assert.match(无.原因, /发送器未装配/);

  const 假 = 假发送();
  设自动回复发送器(假);
  const 有 = await 触发自动回复(c2c('价格'), 数据(), { 路径, 配置: 造配置(), 状态, 现在: 基准 });
  assert.equal(有.动作, '回复');
  assert.equal(假.调用.length, 1);
  设自动回复发送器(null);
});
