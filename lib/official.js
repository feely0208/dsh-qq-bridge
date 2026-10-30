/**
 * 深鲸 QQ 桥接 —— QQ 官方机器人（QQ 开放平台）WebSocket 通道
 *
 * 与 OneBot 通道并列、二选一：不依赖本机 OneBot 框架，直接用
 * AppID + AppSecret 走官方 API（q.qq.com）。
 *
 * 链路：
 *   ① POST https://bots.qq.com/app/getAppAccessToken → access_token（缓存到 expires_in-60s）
 *   ② GET  https://api.sgroup.qq.com/gateway      → wss 地址
 *   ③ WebSocket：收 op10 hello → 发 op2 identify → 收 op0 READY
 *      按 heartbeat_interval 发 op1；op11 视为 ack；op7 重连；op9 换 token 重连
 *   ④ dispatch 事件归一化入队 + 审计（GROUP_AT / C2C / 频道 / 频道私信）
 *   ④' 入队后立刻触发自动回复（v0.3：关键词规则 + 模板 + 防刷，见 lib/autoreply.js）
 *   ⑤ 发送：C2C /v2/users/{openid}/messages、群 /v2/groups/{group_openid}/messages、
 *      频道 /channels/{channel_id}/messages、频道私信 /dms/{guild_id}/messages
 *
 * 安全边界：
 *   · AppSecret 只从 ~/.dsh/qq-bridge.json 读，永不写入审计/日志/接口响应
 *   · access_token 只在内存里，且只会发给 bots.qq.com 与 api.sgroup.qq.com（或沙箱同名域）
 *   · 所有错误原样回报 code / message / trace_id，不吞错
 *
 * @module @deepwhale-cn/dsh-qq-bridge/official
 */
import { createHash } from 'node:crypto';
import {
  读配置, 解析路径, 写审计, 追加收件记录,
} from './core.js';
import { 触发自动回复, 设自动回复发送器 } from './autoreply.js';

export const 取令牌地址 = 'https://bots.qq.com/app/getAppAccessToken';
export const 官方基址表 = {
  正式: 'https://api.sgroup.qq.com',
  沙箱: 'https://sandbox.api.sgroup.qq.com',
};
/** 群与私聊事件（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE） */
export const 群与私聊意图 = 1 << 25;
export const 官方请求超时毫秒 = 10000;
const 心跳缺省毫秒 = 41250;
const 退避阶梯 = [1000, 2000, 4000, 8000, 16000, 30000];

export const 会话类型表 = ['c2c', 'group', 'channel', 'dm'];
// 官方 id 实测形态：ROBOT1.0_8rS.7Mq…（含 . _ -，长度可超 128），回执 id 还带 !
const 标识符 = /^[A-Za-z0-9_.:\-!+/=]{3,512}$/;
const 重复提及 = /<@!?\d+>/g;

/** 进程内 token 缓存：{ 指纹, token, 过期时刻 }。只存内存，不落盘。 */
let 令牌缓存 = null;

export function 清官方令牌缓存() { 令牌缓存 = null; }

function 指纹(appId, secret) {
  return createHash('sha256').update(String(appId) + '\n' + String(secret)).digest('hex');
}

/** 「（code 100016 / 鉴权失败 / trace_id xxx）」—— 官方错误原样回报 */
function 描述(体, 原文) {
  const 部 = [];
  if (体 && 体.code !== undefined && 体.code !== null) 部.push('code ' + 体.code);
  if (体 && 体.message) 部.push(String(体.message));
  if (体 && 体.trace_id) 部.push('trace_id ' + 体.trace_id);
  if (!部.length && 原文) 部.push(String(原文).slice(0, 200));
  return 部.length ? '（' + 部.join(' / ') + '）' : '';
}

function 超时名(e) { return e && (e.name === 'AbortError' || e.name === 'TimeoutError'); }

/* ────────────────────────── 取 token ────────────────────────── */

/**
 * 取 access_token（带缓存）。
 * 缓存到 expires_in - 60s；appId/secret 变了自然失效；选项.强制=true 跳过缓存。
 */
export async function 取AccessToken(配置 = {}, 选项 = {}) {
  const appId = String(配置.official_appid || '').trim();
  const secret = String(配置.official_secret || '');
  if (appId === '' || secret === '') {
    return { ok: false, 错误: '未配置官方机器人 AppID / AppSecret（面板「官方机器人」里填，再点保存）' };
  }
  const 印 = 指纹(appId, secret);
  const 现在 = typeof 选项.现在 === 'function' ? 选项.现在() : Date.now();
  if (!选项.强制 && 令牌缓存 && 令牌缓存.指纹 === 印 && 现在 < 令牌缓存.过期时刻) {
    return { ok: true, token: 令牌缓存.token, 缓存: true };
  }
  const 取 = 选项.fetchImpl || globalThis.fetch;
  if (typeof 取 !== 'function') return { ok: false, 错误: '当前运行时没有 fetch，取不到 access_token' };

  const 控制 = new AbortController();
  const 定时 = setTimeout(() => 控制.abort(), 选项.超时毫秒 || 官方请求超时毫秒);
  try {
    const res = await 取(取令牌地址, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: 控制.signal,
    });
    const 原文 = await res.text();
    let 体 = null;
    try { 体 = 原文 ? JSON.parse(原文) : null; } catch { /* 下面按非 JSON 报错 */ }
    if (!res.ok) {
      return { ok: false, status: res.status, 错误: '取 access_token 失败：HTTP ' + res.status + 描述(体, 原文) };
    }
    if (!体 || typeof 体.access_token !== 'string' || 体.access_token === '') {
      return { ok: false, status: res.status, 错误: '取 access_token 失败：响应里没有 access_token' + 描述(体, 原文) };
    }
    const 寿命秒 = Number(体.expires_in);
    const 有效秒 = Number.isFinite(寿命秒) && 寿命秒 > 0 ? 寿命秒 : 7200;
    const 过期时刻 = 现在 + Math.max(30000, 有效秒 * 1000 - 60000);
    令牌缓存 = { 指纹: 印, token: 体.access_token, 过期时刻 };
    return { ok: true, token: 体.access_token, 缓存: false, 过期秒: Math.round(有效秒) };
  } catch (e) {
    return {
      ok: false,
      错误: 超时名(e)
        ? '取 access_token 超时（' + (选项.超时毫秒 || 官方请求超时毫秒) / 1000 + 's）'
        : '取 access_token 连不上 bots.qq.com：' + String((e && e.message) || e),
    };
  } finally {
    clearTimeout(定时);
  }
}

/* ────────────────────────── 通用官方 API ────────────────────────── */

export function 官方基址(配置 = {}) {
  return 配置 && 配置.official_sandbox ? 官方基址表.沙箱 : 官方基址表.正式;
}

/**
 * 调官方 API。401 时清缓存重取一次 token（覆盖 token 提前失效）。
 * @returns {Promise<{ok:boolean, status?:number, data?:any, code?:any, message?:string, trace_id?:string, 错误?:string}>}
 */
async function 官方请求(配置, 方法, 路, 体, 选项 = {}) {
  const 取 = 选项.fetchImpl || globalThis.fetch;
  if (typeof 取 !== 'function') return { ok: false, 错误: '当前运行时没有 fetch' };
  const 基 = 官方基址(配置);
  let 强制重取 = false;
  let 最后一次 = null;
  for (let 轮 = 0; 轮 < 2; 轮 += 1) {
    const 令牌 = await 取AccessToken(配置, { ...选项, 强制: 强制重取 });
    if (!令牌.ok) return { ok: false, 错误: 令牌.错误, code: 'token' };
    const 头 = { authorization: 'QQBot ' + 令牌.token, accept: 'application/json' };
    if (体 !== undefined && 体 !== null) 头['content-type'] = 'application/json';
    const 控制 = new AbortController();
    const 定时 = setTimeout(() => 控制.abort(), 选项.超时毫秒 || 官方请求超时毫秒);
    try {
      const res = await 取(基 + 路, {
        method: 方法,
        headers: 头,
        body: 体 === undefined || 体 === null ? undefined : JSON.stringify(体),
        signal: 控制.signal,
      });
      const 原文 = await res.text();
      let 数据 = null;
      try { 数据 = 原文 ? JSON.parse(原文) : null; } catch { /* 保留原文用于报错 */ }
      if (res.status === 401 && !强制重取) {
        清官方令牌缓存();
        强制重取 = true;
        最后一次 = { ok: false, status: 401, 错误: '鉴权失败（401）：' + 描述(数据, 原文) };
        continue;
      }
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          code: 数据 && 数据.code,
          message: 数据 && 数据.message,
          trace_id: 数据 && 数据.trace_id,
          错误: 'HTTP ' + res.status + 描述(数据, 原文),
        };
      }
      return { ok: true, status: res.status, data: 数据 };
    } catch (e) {
      return {
        ok: false,
        错误: 超时名(e)
          ? '官方 API 超时（' + (选项.超时毫秒 || 官方请求超时毫秒) / 1000 + 's）：' + 方法 + ' ' + 路
          : '连不上官方 API（' + 基 + '）：' + String((e && e.message) || e),
      };
    } finally {
      clearTimeout(定时);
    }
  }
  return 最后一次 || { ok: false, 错误: '鉴权失败（401）' };
}

/** 取 WebSocket 网关地址 */
export async function 取Gateway(配置 = {}, 选项 = {}) {
  const 结果 = await 官方请求(配置, 'GET', '/gateway', null, 选项);
  if (!结果.ok) return { ok: false, 错误: 结果.错误, code: 结果.code, trace_id: 结果.trace_id };
  const url = 结果.data && 结果.data.url;
  if (typeof url !== 'string' || !/^wss:\/\//.test(url)) {
    return { ok: false, 错误: 'gateway 响应里没有 wss 地址：' + JSON.stringify(结果.data).slice(0, 200) };
  }
  return { ok: true, url };
}

/* ────────────────────────── 事件归一化 ────────────────────────── */

export function 短号(值) {
  const 串 = String(值 == null ? '' : 值);
  if (串 === '') return '';
  return 串.length <= 6 ? 串 : '…' + 串.slice(-6);
}

/**
 * 官方 dispatch 事件 → 面板/队列能看的一条。
 * 只保留会话定位需要的 id 与文本；原始事件不落盘（避免带进无关字段）。
 */
/**
 * 官方消息里的「表情/图片/附件」是 XML 片段，不是文字：
 *   <faceType=6,faceId="0",ext="eyJ0ZXh0IjoiW+eOq+eRsF0ifQ==">  ← ext 是 base64 的 {"text":"[萝卜]"}
 *   <attachment .../>
 * 直接显示会变成一坨乱码，统一转成 [表情]/[图片]/[附件] 这类可读占位。
 */
export function 清洗官方文本(原文) {
  let t = String(原文 == null ? '' : 原文);
  t = t.replace(/<face[^>]*>/gi, (段) => {
    const m = /ext="([^"]+)"/i.exec(段);
    if (m) {
      try {
        const 解 = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
        if (解 && typeof 解.text === 'string' && 解.text.trim() !== '') return 解.text;
      } catch { /* 解不开就用占位 */ }
    }
    return '[表情]';
  });
  t = t.replace(/<attachment[^>]*\/?>/gi, '[附件]');
  t = t.replace(/<image[^>]*>/gi, '[图片]');
  t = t.replace(/<[^>]{1,60}>/g, '');   // 其余标签直接去掉，别把标记当正文
  return t;
}

export function 归一化官方事件(事件类型, 数据 = {}) {
  const 数据对象 = 数据 && typeof 数据 === 'object' ? 数据 : {};
  const 作者 = 数据对象.author && typeof 数据对象.author === 'object' ? 数据对象.author : {};
  const 文本 = 清洗官方文本(数据对象.content).replace(重复提及, '').trim().slice(0, 2000);
  const 记录 = {
    时刻: new Date().toISOString(),
    来源通道: 'official',
    事件类型: String(事件类型 || ''),
    msg_id: String(数据对象.id == null ? '' : 数据对象.id),
    文本,
    昵称: String(作者.username || '').slice(0, 60),
  };
  if (事件类型 === 'GROUP_AT_MESSAGE_CREATE' || 事件类型 === 'GROUP_MESSAGE_CREATE') {
    return {
      ...记录,
      会话类型: 'group',
      group_openid: String(数据对象.group_openid == null ? '' : 数据对象.group_openid),
      openid: String(作者.member_openid == null ? '' : 作者.member_openid),
    };
  }
  if (事件类型 === 'C2C_MESSAGE_CREATE') {
    return { ...记录, 会话类型: 'c2c', openid: String(作者.user_openid == null ? '' : 作者.user_openid) };
  }
  if (事件类型 === 'AT_MESSAGE_CREATE' || 事件类型 === 'MESSAGE_CREATE') {
    return {
      ...记录,
      会话类型: 'channel',
      channel_id: String(数据对象.channel_id == null ? '' : 数据对象.channel_id),
      guild_id: String(数据对象.guild_id == null ? '' : 数据对象.guild_id),
      openid: String(作者.id == null ? '' : 作者.id),
    };
  }
  if (事件类型 === 'DIRECT_MESSAGE_CREATE') {
    return {
      ...记录,
      会话类型: 'dm',
      guild_id: String(数据对象.guild_id == null ? '' : 数据对象.guild_id),
      channel_id: String(数据对象.channel_id == null ? '' : 数据对象.channel_id),
      openid: String(作者.id == null ? '' : 作者.id),
    };
  }
  return { ...记录, 会话类型: 'other' };
}

/** 消息类事件才入队；其他（READY/RESUMED 等）只更新状态 */
export function 是官方消息事件(事件类型) {
  return [
    'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE',
    'AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE',
  ].includes(String(事件类型 || ''));
}

/* ────────────────────────── 发送 ────────────────────────── */

function 明示会话类型(入参 = {}) {
  return String(入参.channel || 入参.会话类型 || '').trim();
}

function 推断会话类型(入参 = {}) {
  const 明示 = 明示会话类型(入参);
  if (会话类型表.includes(明示)) return 明示;
  if (入参.group_openid) return 'group';
  if (入参.guild_id && 入参.channel_id) return 'dm';
  if (入参.channel_id) return 'channel';
  if (入参.openid || 入参.user_openid) return 'c2c';
  return '';
}

function 取目标(入参 = {}, 会话类型) {
  if (会话类型 === 'group') return String(入参.group_openid || '').trim();
  if (会话类型 === 'c2c') return String(入参.openid || 入参.user_openid || '').trim();
  if (会话类型 === 'channel') return String(入参.channel_id || '').trim();
  if (会话类型 === 'dm') return String(入参.guild_id || '').trim();
  return '';
}

export function 校验官方目标(会话类型, 目标) {
  if (!会话类型表.includes(会话类型)) return 'channel 只能是 c2c / group / channel / dm';
  const 名 = 会话类型 === 'group' ? 'group_openid' : (会话类型 === 'c2c' ? 'openid' : (会话类型 === 'channel' ? 'channel_id' : 'guild_id'));
  if (typeof 目标 !== 'string' || !标识符.test(目标)) return 目标 === '' ? '缺少 ' + 名 : 名 + ' 格式不合法（3~512 位字母/数字/._:-!+/=）';
  return null;
}

function 发送路径(会话类型, 目标) {
  const 编 = encodeURIComponent(目标);
  if (会话类型 === 'c2c') return '/v2/users/' + 编 + '/messages';
  if (会话类型 === 'group') return '/v2/groups/' + 编 + '/messages';
  if (会话类型 === 'channel') return '/channels/' + 编 + '/messages';
  return '/dms/' + 编 + '/messages';
}

/**
 * 发官方消息。面板 / 工具 / HTTP 出口共用这一条路径。
 * @param {{channel?:string, openid?:string, group_openid?:string, channel_id?:string, guild_id?:string, text:string, msg_id?:string}} 入参
 */
export async function 发送官方消息(入参 = {}, 选项 = {}) {
  const 配置 = 选项.配置 || 读配置(选项.路径);
  const 会话类型 = 推断会话类型(入参);
  const 文本 = typeof 入参.text === 'string' ? 入参.text
    : (typeof 入参.content === 'string' ? 入参.content : '');
  const 目标 = 取目标(入参, 会话类型);
  const 被动消息号 = typeof 入参.msg_id === 'string' ? 入参.msg_id.trim() : String(入参.msg_id || '').trim();
  const 基础 = {
    动作: '发送消息', 来源: 选项.来源 || 'panel', 通道: 'official',
    会话类型: 会话类型 || '?', 目标: 短号(目标), 内容: 文本.slice(0, 200),
  };

  const 明示 = 明示会话类型(入参);
  if (明示 !== '' && !会话类型表.includes(明示)) {
    写审计({ ...基础, 结果: '拒绝', 错误: 'channel 只能是 c2c / group / channel / dm' }, 选项.路径);
    return { ok: false, 原因: 'channel 只能是 c2c / group / channel / dm' };
  }
  const 目标错 = 校验官方目标(会话类型, 目标);
  if (目标错) {
    写审计({ ...基础, 结果: '拒绝', 错误: 目标错 }, 选项.路径);
    return { ok: false, 原因: 目标错 };
  }
  if (文本.trim() === '') {
    写审计({ ...基础, 结果: '拒绝', 错误: '消息内容为空' }, 选项.路径);
    return { ok: false, 原因: '消息内容为空' };
  }
  if (文本.length > 4000) {
    写审计({ ...基础, 结果: '拒绝', 错误: '消息过长（>4000 字符）' }, 选项.路径);
    return { ok: false, 原因: '消息过长（>4000 字符）' };
  }
  if (被动消息号 !== '' && !标识符.test(被动消息号)) {
    写审计({ ...基础, 结果: '拒绝', 错误: 'msg_id 格式不合法' }, 选项.路径);
    return { ok: false, 原因: 'msg_id 格式不合法（3~512 位字母/数字/._:-!+/=）' };
  }

  const 体 = { content: 文本, msg_type: 0 };
  if (被动消息号 !== '') 体.msg_id = 被动消息号;

  const 结果 = await 官方请求(配置, 'POST', 发送路径(会话类型, 目标), 体, 选项);
  if (!结果.ok) {
    // 2026-10-30 实测：不带 msg_id 的群消息 = 主动消息，本机器人没有权限（40034105）。
    // 直接把「怎么发才成功」写进错误里，避免用户以为插件坏了。
    const 主动无权限 = 结果.code === 40034105 || /主动消息/.test(String(结果.message || '')) || /主动消息/.test(String(结果.错误 || ''));
    let 原因 = 结果.错误;
    if (主动无权限) {
      原因 += ' —— 该机器人没有主动消息权限：请用「回复最近一条」（带 msg_id 的被动回复），'
        + '或在 q.qq.com 申请主动消息配额/权限';
    }
    写审计({
      ...基础, 结果: '失败', 错误: 原因,
      code: 结果.code, trace_id: 结果.trace_id,
    }, 选项.路径);
    return {
      ok: false, 原因, code: 结果.code, message: 结果.message, trace_id: 结果.trace_id,
    };
  }
  const 消息号 = 结果.data && 结果.data.id !== undefined ? 结果.data.id : null;
  写审计({ ...基础, 结果: '成功', 消息号, 被动回复: 被动消息号 !== '' }, 选项.路径);
  return { ok: true, 消息号, 通道: 'official', 会话类型, 目标: 短号(目标) };
}

/* ────────────────────────── WebSocket 连接 ────────────────────────── */

function 空状态(配置 = {}) {
  return {
    state: '空闲', connected: false,
    sandbox: !!(配置 && 配置.official_sandbox),
    bot_id: '', bot_name: '',
    last_error: '', attempts: 0, reconnects: 0,
    heartbeat_interval: null, last_ack_at: null,
    connected_at: null, last_event_at: null,
  };
}

/**
 * 一条官方 WebSocket 连接（进程内单例由 连接官方/断开官方 管理）。
 * 选项：{ 配置, 路径, fetchImpl, WebSocketImpl, 退避毫秒 }
 */
export class 官方连接 {
  constructor(选项 = {}) {
    this.配置 = 选项.配置 || {};
    this.路径 = 选项.路径 || 解析路径();
    this.fetchImpl = 选项.fetchImpl;
    this.WebSocketImpl = 选项.WebSocketImpl;
    this.退避毫秒 = Array.isArray(选项.退避毫秒) && 选项.退避毫秒.length ? 选项.退避毫秒 : 退避阶梯;
    // 连续失败上限：超过就停在「错误」，别无限打 bots.qq.com（用户点「连接」重来）
    this.重试上限 = Number.isFinite(选项.重试上限) && 选项.重试上限 > 0 ? Math.floor(选项.重试上限) : 10;
    this.状态 = 空状态(this.配置);
    this.停止 = false;
    this.尝试 = 0;
    this.代号 = 0;
    this.序号 = null;
    this.令牌 = '';
    this.心跳毫秒 = 心跳缺省毫秒;
    this.ws = null;
    this.心跳定时 = null;
    this.重连定时 = null;
  }

  状态快照() { return { ...this.状态, connected: this.状态.state === '已连接' }; }

  async 启动() {
    this.停止 = false;
    await this.#一次连接(false);
    return this.状态快照();
  }

  #清心跳() {
    if (this.心跳定时) { clearInterval(this.心跳定时); this.心跳定时 = null; }
  }

  #清定时() {
    this.#清心跳();
    if (this.重连定时) { clearTimeout(this.重连定时); this.重连定时 = null; }
  }

  #发(帧) {
    const ws = this.ws;
    if (!ws) return false;
    try {
      // 0=CONNECTING 1=OPEN；mock 里 readyState 可能是 undefined，按可发处理
      if (ws.readyState !== undefined && ws.readyState !== 0 && ws.readyState !== 1) return false;
      ws.send(JSON.stringify(帧));
      return true;
    } catch (e) {
      this.状态.last_error = 'WebSocket 发送失败：' + String((e && e.message) || e);
      return false;
    }
  }

  async #一次连接(刷新令牌 = false) {
    this.#清定时();
    if (this.停止) return;
    const 代 = ++this.代号;
    this.状态.state = this.尝试 > 0 ? '重连中' : '连接中';
    try {
      const 网关 = await 取Gateway(this.配置, { fetchImpl: this.fetchImpl, 强制: 刷新令牌 });
      if (代 !== this.代号 || this.停止) return;
      if (!网关.ok) throw new Error(网关.错误);
      const 令牌 = await 取AccessToken(this.配置, { fetchImpl: this.fetchImpl });
      if (代 !== this.代号 || this.停止) return;
      if (!令牌.ok) throw new Error(令牌.错误);
      this.令牌 = 令牌.token;
      const WS = this.WebSocketImpl || globalThis.WebSocket;
      if (typeof WS !== 'function') {
        throw new Error('当前运行时没有 WebSocket：官方机器人通道需要 Node 22+ 的全局 WebSocket（桌面端 Electron 44 自带 Node 24，可用）');
      }
      const ws = new WS(网关.url);
      this.ws = ws;
      ws.onopen = () => { if (代 === this.代号 && !this.停止) this.状态.state = '握手中'; };
      ws.onmessage = (事件) => { if (代 === this.代号 && !this.停止) this.#收消息(事件 && 事件.data); };
      ws.onerror = (错误) => {
        if (代 !== this.代号 || this.停止) return;
        const 底 = 错误 && (错误.message || (错误.error && 错误.error.message));
        this.状态.last_error = 'WebSocket 错误：' + String(底 || '未知（可能是网络中断或凭证被拒）');
      };
      ws.onclose = (事件) => { if (代 === this.代号 && !this.停止) this.#掉线(事件); };
      this.状态.state = '握手中';
    } catch (e) {
      if (代 !== this.代号 || this.停止) return;
      this.状态.state = '错误';
      this.状态.last_error = String((e && e.message) || e);
      this.尝试 += 1;
      this.状态.attempts = this.尝试;
      写审计({ 动作: '官方连接', 结果: '失败', 错误: this.状态.last_error }, this.路径);
      this.#安排重连(false);
    }
  }

  #收消息(原) {
    if (typeof 原 !== 'string') return;
    let 帧 = null;
    try { 帧 = JSON.parse(原); } catch { return; }
    if (!帧 || typeof 帧 !== 'object') return;
    this.状态.last_event_at = new Date().toISOString();
    if (帧.s !== undefined && 帧.s !== null) this.序号 = 帧.s;
    const 操作 = Number(帧.op);
    const 数据 = 帧.d && typeof 帧.d === 'object' ? 帧.d : {};
    if (操作 === 10) {
      const 间隔 = Number(数据.heartbeat_interval);
      this.心跳毫秒 = Number.isFinite(间隔) && 间隔 > 0 ? Math.max(20, 间隔) : 心跳缺省毫秒;
      this.状态.heartbeat_interval = this.心跳毫秒;
      this.#发({
        op: 2,
        d: { token: 'QQBot ' + this.令牌, intents: 群与私聊意图, shard: [0, 1], properties: {} },
      });
      this.#开始心跳();
      return;
    }
    if (操作 === 11) { this.状态.last_ack_at = new Date().toISOString(); return; }
    if (操作 === 1) { this.#发心跳(); return; }
    if (操作 === 7) {
      this.状态.last_error = '服务端要求重连（op7）';
      this.#重连(false, true);
      return;
    }
    if (操作 === 9) {
      清官方令牌缓存();
      this.令牌 = '';
      this.状态.last_error = '会话失效（op9），已重新取 token 再连';
      this.#重连(true, true);
      return;
    }
    if (操作 === 0) { this.#收事件(String(帧.t || ''), 数据); }
  }

  #收事件(类型, 数据) {
    if (类型 === 'READY') {
      const 用户 = 数据.user && typeof 数据.user === 'object' ? 数据.user : {};
      this.状态.state = '已连接';
      this.状态.connected = true;
      this.状态.bot_id = String(用户.id == null ? '' : 用户.id);
      this.状态.bot_name = String(用户.username || '');
      this.状态.connected_at = new Date().toISOString();
      this.状态.last_error = '';
      this.尝试 = 0;
      this.状态.attempts = 0;
      写审计({
        动作: '官方连接', 结果: '已连接', 机器人: this.状态.bot_name, 机器人ID: this.状态.bot_id,
        沙箱: this.状态.sandbox,
      }, this.路径);
      return;
    }
    if (类型 === 'RESUMED') {
      this.状态.state = '已连接';
      this.状态.connected = true;
      this.尝试 = 0;
      this.状态.attempts = 0;
      写审计({ 动作: '官方连接', 结果: '已恢复' }, this.路径);
      return;
    }
    if (!是官方消息事件(类型)) return;

    const 记录 = 归一化官方事件(类型, 数据);
    if (记录.会话类型 === 'other') return;
    try { 追加收件记录(记录, this.路径); } catch { /* 队列写失败不能断连接 */ }
    写审计({
      动作: '收到官方事件', 结果: '入队', 来源: 'official', 通道: 'official',
      会话类型: 记录.会话类型, 事件类型: 记录.事件类型,
      群: 短号(记录.group_openid), 发送者: 短号(记录.openid),
      昵称: 记录.昵称, 内容: 记录.文本.slice(0, 200),
    }, this.路径);

    // 先入队保证不丢，再立刻（不 await、不轮询）走自动回复；出错也不能影响连接
    if (记录.会话类型 === 'c2c' || 记录.会话类型 === 'group') {
      const 发送 = (入参, 发送选项) => 发送官方消息(入参, { ...发送选项, fetchImpl: this.fetchImpl });
      void 触发自动回复(记录, 数据, { 路径: this.路径, 发送 }).catch(() => { /* 自动回复失败已在内部审计 */ });
    }
  }

  #开始心跳() {
    this.#清心跳();
    this.#发心跳();
    this.心跳定时 = setInterval(() => this.#发心跳(), this.心跳毫秒);
    try { this.心跳定时.unref?.(); } catch { /* 非 Node 环境忽略 */ }
  }

  #发心跳() {
    this.#发({ op: 1, d: this.序号 === null ? null : this.序号 });
  }

  #掉线(事件) {
    this.#清心跳();
    this.ws = null;
    if (this.停止) return;
    const 码 = 事件 && 事件.code !== undefined ? 事件.code : '?';
    this.状态.state = '重连中';
    this.状态.last_error = '连接断开（code ' + 码 + '），准备重连';
    this.尝试 += 1;
    this.状态.attempts = this.尝试;
    this.状态.reconnects += 1;
    this.#安排重连(false);
  }

  #重连(刷新令牌, 立即) {
    this.#清定时();
    this.代号 += 1; // 让旧 socket 的回调全部失效
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.onopen = null;
      try { ws.close(1000); } catch { /* 已断就忽略 */ }
    }
    if (this.停止) return;
    this.状态.connected = false;
    this.状态.state = '重连中';
    this.状态.reconnects += 1;
    if (刷新令牌) { 清官方令牌缓存(); this.令牌 = ''; }
    this.#安排重连(刷新令牌, 立即);
  }

  #安排重连(刷新令牌, 立即 = false) {
    if (this.停止 || this.重连定时) return;
    if (!立即 && this.尝试 >= this.重试上限) {
      this.状态.state = '错误';
      this.状态.connected = false;
      this.状态.last_error = (this.状态.last_error ? this.状态.last_error + '；' : '')
        + '已连续失败 ' + this.尝试 + ' 次，已停止自动重连（点「连接」重试）';
      写审计({ 动作: '官方连接', 结果: '失败', 错误: this.状态.last_error, 重试: this.尝试 }, this.路径);
      return;
    }
    const 序 = Math.min(Math.max(this.尝试 - 1, 0), this.退避毫秒.length - 1);
    const 延迟 = 立即 ? 0 : this.退避毫秒[序];
    this.重连定时 = setTimeout(() => {
      this.重连定时 = null;
      void this.#一次连接(刷新令牌);
    }, 延迟);
    try { this.重连定时.unref?.(); } catch { /* ignore */ }
  }

  断开() {
    this.停止 = true;
    this.代号 += 1;
    this.#清定时();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.onopen = null;
      try { ws.close(1000); } catch { /* 已断就忽略 */ }
    }
    this.令牌 = '';
    this.状态.state = '已断开';
    this.状态.connected = false;
    this.尝试 = 0;
    this.状态.attempts = 0;
    写审计({ 动作: '官方连接', 结果: '已断开', 机器人: this.状态.bot_name }, this.路径);
    return this.状态快照();
  }
}

/* ────────────────────────── 进程内单例 ────────────────────────── */

let 当前连接 = null;

/** 连接（已有连接会先断开再按新配置重连） */
export async function 连接官方(配置 = {}, 选项 = {}) {
  if (当前连接) {
    try { 当前连接.断开(); } catch { /* ignore */ }
    当前连接 = null;
  }
  const 连 = new 官方连接({ ...选项, 配置 });
  当前连接 = 连;
  await 连.启动();
  return 连.状态快照();
}

/** 断开；没连接也返回「已断开」而不是报错 */
export function 断开官方() {
  if (!当前连接) return { ...空状态(), state: '已断开' };
  const 快照 = 当前连接.断开();
  当前连接 = null;
  return 快照;
}

export function 官方状态(配置 = {}) {
  if (当前连接) return 当前连接.状态快照();
  return 空状态(配置);
}

export function 当前官方连接() { return 当前连接; }

/* 自动回复默认使用的发送器：走同一条 发送官方消息 路径（审计/错误处理只有一份）。
   测试可直接 设自动回复发送器(假发送) 覆盖，或用 选项.发送 注入。 */
设自动回复发送器(发送官方消息);
