/**
 * 深鲸 QQ 桥接 —— 核心逻辑（无 DSH 依赖，便于单测与复用）
 *
 * 定位：QQ 桥接的两条通道（OneBot v11 / QQ 官方机器人）。
 * v0.2 新增官方机器人 WebSocket 通道（见 lib/official.js），与 OneBot 二选一；
 * 仍然只做「发得出去、收得进来、留得下痕」，不做自动回复与会话路由。
 *
 * 三个用法：法律/客服接待归档、企业审批通知、多渠道统一后台的基础通道。
 *
 * 设计边界：
 *   · endpoint 只允许 http(s)，拒绝带账号/口令/查询串的 URL
 *   · access_token 只存本机 ~/.dsh/qq-bridge.json（0600），API 只回掩码，不落审计
 *   · 所有 OneBot 调用 10s 超时，错误如实回报（HTTP 状态 / retcode / 超时）
 *   · 上报入口校验 X-Signature（HMAC-SHA1）或 Bearer token；未配置密钥时放行但审计注明
 *   · 收件箱最多 1000 条，落本机 JSON；审计写 JSONL，字段经脱敏
 *
 * @module @deepwhale-cn/dsh-qq-bridge/core
 */
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ROUTE = '/dsh-qq-bridge';
export const 收件箱上限 = 1000;
export const 审计上限 = 500;
export const 请求超时毫秒 = 10000;

export const 默认配置 = {
  /** onebot（默认，兼容 v0.1 用户）| official（QQ 官方机器人） */
  mode: 'onebot',
  endpoint: 'http://127.0.0.1:3000',
  access_token: '',
  hook_secret: '',
  default_target_type: 'private',
  default_target: '',
  /** QQ 开放平台 AppID（明文，不是密钥） */
  official_appid: '',
  /** 只在 ~/.dsh/qq-bridge.json 里，接口/面板/审计一律只回掩码 */
  official_secret: '',
  /** 沙箱环境（sandbox.api.sgroup.qq.com） */
  official_sandbox: false,
  /** 启动 DSH 时自动连接官方机器人（默认关，由用户点「连接」） */
  official_auto_connect: false,
  /** 自动回复（v0.3，默认关）：收到私聊/群 @ 消息后按规则立刻被动回复 */
  official_auto_reply: false,
  /** 没有命中任何关键词时用的默认模板；支持 {昵称}{内容}{时间} */
  official_reply_text: '收到～我是深鲸机器人，稍后回复你。',
  /** 关键词规则：[{ 关键词:[...], 回复:'...', 模式:'包含|精确|正则' }]，按顺序命中第一条 */
  official_reply_rules: [],
  /** c2c = 只回私聊；all = 私聊 + 群（群里只有被 @ 才有事件） */
  official_reply_scope: 'c2c',
  /** 同一会话两条自动回复的最小间隔（毫秒） */
  official_reply_min_interval_ms: 30000,
  /** 全局每小时自动回复上限（条） */
  official_reply_hourly_cap: 60,
};

/** 自动回复规则的归一化：面板/HTTP 传来的东西一律清洗，坏项丢弃而不是让整份配置失效 */
export function 归一化回复规则(原, 最多 = 100) {
  if (!Array.isArray(原)) return [];
  const 出 = [];
  for (const 项 of 原.slice(0, 最多)) {
    if (!项 || typeof 项 !== 'object') continue;
    const 原词 = Array.isArray(项.关键词) ? 项.关键词 : (typeof 项.关键词 === 'string' ? 项.关键词.split(/[,，]/) : []);
    const 词 = 原词.map((x) => String(x == null ? '' : x).trim()).filter((x) => x !== '').slice(0, 20);
    if (!词.length) continue;
    const 回复 = typeof 项.回复 === 'string' ? 项.回复.slice(0, 2000) : '';
    const 模式 = ['包含', '精确', '正则'].includes(项.模式) ? 项.模式 : '包含';
    出.push({ 关键词: 词, 回复, 模式 });
  }
  return 出;
}

/** 数据文件位置；测试用环境变量覆盖，避免碰真实 ~/.dsh */
export function 解析路径(环境 = process.env) {
  const 基 = 环境.DSH_QQ_BRIDGE_HOME || join(homedir(), '.dsh');
  return {
    配置: 环境.DSH_QQ_BRIDGE_CONFIG || join(基, 'qq-bridge.json'),
    审计: 环境.DSH_QQ_BRIDGE_AUDIT || join(基, 'qq-bridge-audit.jsonl'),
    收件箱: 环境.DSH_QQ_BRIDGE_INBOX || join(基, 'qq-bridge-inbox.json'),
  };
}

/* ────────────────────────── 端点与配置 ────────────────────────── */

/** 只允许 http(s)；不允许 URL 里塞账号、口令、查询串（避免把 token 写进地址栏/日志） */
export function 校验端点(值) {
  const 串 = typeof 值 === 'string' ? 值.trim() : '';
  if (串 === '') return { 错: '端点不能为空' };
  let u;
  try { u = new URL(串); } catch { return { 错: '端点不是合法 URL（示例：http://127.0.0.1:3000）' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { 错: '只允许 http(s) 端点，收到 ' + u.protocol };
  if (u.username || u.password) return { 错: '端点不能带用户名/密码' };
  if (u.search || u.hash) return { 错: '端点不要带查询串或锚点（access_token 会放在请求头里）' };
  const 路径 = u.pathname.replace(/\/+$/, '');
  return { 值: u.origin + 路径 };
}

/** 读本地配置；文件坏了不抛错，退回默认值（面板要能打开） */
export function 读配置(路径 = 解析路径()) {
  const 配置 = { ...默认配置 };
  try {
    if (!existsSync(路径.配置)) return 配置;
    const 原 = JSON.parse(readFileSync(路径.配置, 'utf8'));
    if (原 && typeof 原 === 'object') {
      for (const 键 of Object.keys(默认配置)) {
        if (键 === 'default_target_type') {
          if (原[键] === 'private' || 原[键] === 'group') 配置[键] = 原[键];
        } else if (键 === 'mode') {
          // 老配置没有 mode → 按 onebot（不能影响 v0.1 用户）
          if (原[键] === 'onebot' || 原[键] === 'official') 配置[键] = 原[键];
        } else if (键 === 'official_sandbox' || 键 === 'official_auto_connect' || 键 === 'official_auto_reply') {
          if (typeof 原[键] === 'boolean') 配置[键] = 原[键];
        } else if (键 === 'official_reply_rules') {
          配置[键] = 归一化回复规则(原[键]);
        } else if (键 === 'official_reply_scope') {
          if (原[键] === 'c2c' || 原[键] === 'all') 配置[键] = 原[键];
        } else if (键 === 'official_reply_min_interval_ms') {
          const n = Number(原[键]);
          if (Number.isFinite(n) && n >= 0 && n <= 3600000) 配置[键] = Math.floor(n);
        } else if (键 === 'official_reply_hourly_cap') {
          const n = Number(原[键]);
          if (Number.isFinite(n) && n >= 0 && n <= 10000) 配置[键] = Math.floor(n);
        } else if (typeof 原[键] === 'string') {
          配置[键] = 原[键];
        }
      }
    }
  } catch { /* 坏文件按默认值处理 */ }
  return 配置;
}

function 写私密文件(文件, 文本) {
  mkdirSync(dirname(文件), { recursive: true });
  const 临时 = 文件 + '.' + process.pid + '.tmp';
  writeFileSync(临时, 文本, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(临时, 0o600); } catch { /* 非 POSIX 忽略 */ }
  renameSync(临时, 文件);
  try { chmodSync(文件, 0o600); } catch { /* ignore */ }
}

/**
 * 保存配置。access_token / hook_secret 传非空字符串才覆盖；传 clear_token /
 * clear_hook_secret=true 才清除 —— 避免面板回填掩码时把真 token 覆盖掉。
 */
export function 保存配置(输入 = {}, 路径 = 解析路径()) {
  const 旧 = 读配置(路径);
  const 新 = { ...旧 };
  if (输入.endpoint !== undefined) {
    const 查 = 校验端点(输入.endpoint);
    if (查.错) return { ok: false, 原因: 查.错 };
    新.endpoint = 查.值;
  }
  if (typeof 输入.access_token === 'string' && 输入.access_token.trim() !== '') {
    新.access_token = 输入.access_token.trim();
  } else if (输入.clear_token === true) {
    新.access_token = '';
  }
  if (typeof 输入.hook_secret === 'string' && 输入.hook_secret.trim() !== '') {
    新.hook_secret = 输入.hook_secret.trim();
  } else if (输入.clear_hook_secret === true) {
    新.hook_secret = '';
  }
  if (输入.default_target_type === 'private' || 输入.default_target_type === 'group') {
    新.default_target_type = 输入.default_target_type;
  }
  if (typeof 输入.default_target === 'string') {
    新.default_target = 输入.default_target.trim().slice(0, 40);
  }
  if (输入.mode === 'onebot' || 输入.mode === 'official') 新.mode = 输入.mode;
  if (typeof 输入.official_appid === 'string') {
    const 号 = 输入.official_appid.trim();
    if (号 !== '' && !/^\d{5,32}$/.test(号)) return { ok: false, 原因: 'AppID 必须是 5~32 位数字（qq.qq.com 机器人资料页可见）' };
    新.official_appid = 号;
  }
  if (typeof 输入.official_secret === 'string' && 输入.official_secret.trim() !== '') {
    新.official_secret = 输入.official_secret.trim();
  } else if (输入.clear_official_secret === true) {
    新.official_secret = '';
  }
  if (typeof 输入.official_sandbox === 'boolean') 新.official_sandbox = 输入.official_sandbox;
  if (typeof 输入.official_auto_connect === 'boolean') 新.official_auto_connect = 输入.official_auto_connect;
  if (typeof 输入.official_auto_reply === 'boolean') 新.official_auto_reply = 输入.official_auto_reply;
  if (typeof 输入.official_reply_text === 'string') 新.official_reply_text = 输入.official_reply_text.slice(0, 2000);
  if (输入.official_reply_rules !== undefined) 新.official_reply_rules = 归一化回复规则(输入.official_reply_rules);
  if (输入.official_reply_scope === 'c2c' || 输入.official_reply_scope === 'all') 新.official_reply_scope = 输入.official_reply_scope;
  if (输入.official_reply_min_interval_ms !== undefined) {
    const n = Number(输入.official_reply_min_interval_ms);
    if (!Number.isFinite(n) || n < 0 || n > 3600000) return { ok: false, 原因: '最小间隔必须是 0~3600000 毫秒' };
    新.official_reply_min_interval_ms = Math.floor(n);
  }
  if (输入.official_reply_hourly_cap !== undefined) {
    const n = Number(输入.official_reply_hourly_cap);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return { ok: false, 原因: '每小时上限必须是 0~10000' };
    新.official_reply_hourly_cap = Math.floor(n);
  }
  try { 写私密文件(路径.配置, JSON.stringify(新, null, 2) + '\n'); }
  catch (e) { return { ok: false, 原因: '配置写不进去：' + String(e && e.message || e) }; }
  return { ok: true, 配置: 脱敏配置(新) };
}

function 掩码(值) {
  if (typeof 值 !== 'string' || 值 === '') return '';
  return '••••' + 值.slice(-4);
}

/** 对外（面板/API/工具）只给掩码；完整 token 不出本机文件 */
export function 脱敏配置(配置 = 读配置()) {
  return {
    mode: 配置.mode === 'official' ? 'official' : 'onebot',
    endpoint: 配置.endpoint,
    has_token: 配置.access_token !== '',
    token_masked: 掩码(配置.access_token),
    has_hook_secret: 配置.hook_secret !== '',
    hook_secret_masked: 掩码(配置.hook_secret),
    default_target_type: 配置.default_target_type,
    default_target: 配置.default_target,
    official_appid: 配置.official_appid || '',
    has_official_secret: (配置.official_secret || '') !== '',
    official_secret_masked: 掩码(配置.official_secret || ''),
    official_sandbox: !!配置.official_sandbox,
    official_auto_connect: !!配置.official_auto_connect,
    official_ready: (配置.official_appid || '') !== '' && (配置.official_secret || '') !== '',
    official_auto_reply: !!配置.official_auto_reply,
    official_reply_text: 配置.official_reply_text || '',
    official_reply_rules: 归一化回复规则(配置.official_reply_rules),
    official_reply_scope: 配置.official_reply_scope === 'all' ? 'all' : 'c2c',
    official_reply_min_interval_ms: Number(配置.official_reply_min_interval_ms) || 0,
    official_reply_hourly_cap: Number(配置.official_reply_hourly_cap) || 0,
  };
}

/* ────────────────────────── 审计（脱敏） ────────────────────────── */

const 敏感键 = /^(access_token|token|secret|hook_secret|authorization|password|official_secret|appsecret|app_secret|clientsecret|client_secret)$/i;
const 串内敏感 = /((?:bearer|qqbot)\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
const 键值敏感 = /((?:access_token|token|secret|hook_secret|authorization|password|official_secret|appSecret|clientSecret)\s*["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi;

/** 递归脱敏：token/secret 类键直接打码，字符串里的 Bearer xxx 也打码 */
export function 脱敏(值, 深度 = 0) {
  if (深度 > 6) return '[过深]';
  if (typeof 值 === 'string') {
    return 值.replace(串内敏感, '$1[已隐藏]').replace(键值敏感, '$1[已隐藏]');
  }
  if (Array.isArray(值)) return 值.map((x) => 脱敏(x, 深度 + 1));
  if (值 && typeof 值 === 'object') {
    const 出 = {};
    for (const [键, 子] of Object.entries(值)) {
      出[键] = 敏感键.test(键) ? (子 === '' || 子 == null ? '' : '[已隐藏]') : 脱敏(子, 深度 + 1);
    }
    return 出;
  }
  return 值;
}

export function 写审计(记录, 路径 = 解析路径()) {
  try {
    mkdirSync(dirname(路径.审计), { recursive: true });
    appendFileSync(路径.审计, JSON.stringify(脱敏({ 时刻: new Date().toISOString(), ...记录 })) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(路径.审计, 0o600); } catch { /* 非 POSIX 忽略 */ }
    return true;
  } catch { return false; }
}

export function 读审计(limit = 50, 路径 = 解析路径()) {
  try {
    if (!existsSync(路径.审计)) return [];
    const 条数 = Math.min(审计上限, Math.max(1, Number(limit) || 50));
    const 行 = readFileSync(路径.审计, 'utf8').split('\n').filter(Boolean);
    return 行.slice(-条数).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/* ────────────────────────── OneBot v11 调用 ────────────────────────── */

/**
 * 调 OneBot v11 HTTP API。
 * @param {object} 配置
 * @param {string} 动作 例如 get_login_info / send_private_msg
 * @param {object} 参数
 * @returns {Promise<{ok:boolean, data?:any, retcode?:number, status?:number, 错误?:string}>}
 */
export async function 调OneBot(配置, 动作, 参数 = {}, 选项 = {}) {
  const 查 = 校验端点(配置 && 配置.endpoint);
  if (查.错) return { ok: false, 错误: 查.错 };
  if (typeof 动作 !== 'string' || !/^[a-z_]{1,40}$/.test(动作)) return { ok: false, 错误: '非法的 OneBot 动作名' };
  const 取 = typeof 选项.fetchImpl === 'function' ? 选项.fetchImpl : fetch;

  const 头 = { 'content-type': 'application/json', accept: 'application/json' };
  const 令牌 = typeof 配置.access_token === 'string' ? 配置.access_token : '';
  if (令牌 !== '') 头.authorization = 'Bearer ' + 令牌;

  const 控制 = new AbortController();
  const 定时 = setTimeout(() => 控制.abort(), 请求超时毫秒);
  try {
    const res = await 取(查.值 + '/' + 动作, {
      method: 'POST', headers: 头, body: JSON.stringify(参数 || {}), signal: 控制.signal,
    });
    const 原文 = await res.text();
    let 体 = null;
    try { 体 = JSON.parse(原文); } catch { /* 下面按非 JSON 处理 */ }
    if (!res.ok) {
      return { ok: false, status: res.status, 错误: 'OneBot 返回 HTTP ' + res.status + (体 && (体.message || 体.wording) ? '：' + (体.message || 体.wording) : '') };
    }
    if (!体 || typeof 体 !== 'object') return { ok: false, status: res.status, 错误: '响应不是 JSON：' + 原文.slice(0, 200) };
    const 码 = 体.retcode;
    if (码 !== undefined && 码 !== 0) {
      return { ok: false, status: res.status, retcode: 码, 错误: 体.message || 体.wording || ('retcode ' + 码) };
    }
    return { ok: true, status: res.status, retcode: 码 === undefined ? 0 : 码, data: 体.data === undefined ? null : 体.data };
  } catch (e) {
    const 超时 = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    const 底 = String((e && e.message) || e);
    return {
      ok: false,
      错误: 超时
        ? '请求超时（' + 请求超时毫秒 / 1000 + 's）'
        : ('连不上 OneBot 端点 ' + 查.值 + '：' + 底
          + ' —— 先启动 OneBot v11 框架（Lagrange.OneBot / NapCatQQ），QQ 登录在它里面；'
          + '3000 是它的端口，不是本面板自己开的服务。'),
    };
  } finally {
    clearTimeout(定时);
  }
}

export async function 连接测试(配置, 选项 = {}) {
  const 结果 = await 调OneBot(配置, 'get_login_info', {}, 选项);
  const 记录 = {
    动作: '连接测试', 结果: 结果.ok ? '成功' : '失败',
    帐号: 结果.ok && 结果.data ? String(结果.data.user_id || '') : '',
    昵称: 结果.ok && 结果.data ? String(结果.data.nickname || '') : '',
    错误: 结果.ok ? undefined : 结果.错误,
  };
  写审计(记录, 选项.路径);
  return 结果.ok
    ? { ok: true, 帐号: 记录.帐号, 昵称: 记录.昵称 }
    : { ok: false, 原因: 结果.错误 };
}

/* ────────────────────────── 发送 ────────────────────────── */

export function 校验目标(目标, 类型) {
  if (类型 !== 'private' && 类型 !== 'group') return 'target_type 只能是 private 或 group';
  if (typeof 目标 !== 'string' && typeof 目标 !== 'number') return 'target 必须是 QQ 号或群号';
  const 串 = String(目标).trim();
  if (!/^\d{5,20}$/.test(串)) return 'target 必须是 5~20 位数字的 QQ 号/群号';
  return null;
}

/**
 * 发消息。工具、面板、HTTP 出口共用这一条路径 —— 审计与错误处理只有一份。
 * @param {{target:string, target_type:'private'|'group', text:string}} 入参
 */
export async function 发送消息(入参 = {}, 选项 = {}) {
  const 配置 = 选项.配置 || 读配置(选项.路径);
  const 目标 = String(入参.target == null ? '' : 入参.target).trim();
  const 类型 = 入参.target_type === 'group' ? 'group' : (入参.target_type === 'private' ? 'private' : String(入参.target_type || ''));
  const 文本 = typeof 入参.text === 'string' ? 入参.text : '';
  const 基础 = { 动作: '发送消息', 来源: 选项.来源 || 'panel', 目标类型: 类型, 目标, 内容: 文本.slice(0, 200) };

  const 目标错 = 校验目标(目标, 类型);
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

  const 动作 = 类型 === 'group' ? 'send_group_msg' : 'send_private_msg';
  const 参数 = 类型 === 'group'
    ? { group_id: Number(目标), message: 文本 }
    : { user_id: Number(目标), message: 文本 };
  const 结果 = await 调OneBot(配置, 动作, 参数, 选项);
  if (!结果.ok) {
    写审计({ ...基础, 结果: '失败', 错误: 结果.错误, retcode: 结果.retcode }, 选项.路径);
    return { ok: false, 原因: 结果.错误 };
  }
  const 消息号 = 结果.data && 结果.data.message_id !== undefined ? 结果.data.message_id : null;
  写审计({ ...基础, 结果: '成功', 消息号 }, 选项.路径);
  return { ok: true, 消息号, 目标类型: 类型, 目标 };
}

/**
 * 按通道分派发送：入参.mode 优先，其次配置 mode；都没配 → onebot（兼容 v0.1）。
 * 官方通道由装配层通过 选项.官方 注入，core 不直接依赖 official.js（避免循环依赖）。
 */
export async function 发送分派(入参 = {}, 选项 = {}) {
  const 配置 = 选项.配置 || 读配置(选项.路径);
  const 模式 = 入参.mode === 'official' || 入参.mode === 'onebot'
    ? 入参.mode
    : (配置.mode === 'official' ? 'official' : 'onebot');
  if (模式 === 'official') {
    if (!选项.官方 || typeof 选项.官方.发送 !== 'function') {
      return { ok: false, 原因: '官方机器人通道未装配（插件加载不完整，请重启 DSH）' };
    }
    return 选项.官方.发送(入参, { ...选项, 配置 });
  }
  return 发送消息(入参, { ...选项, 配置 });
}

/* ────────────────────────── 入站上报 ────────────────────────── */

export const 上报类型 = ['message', 'message_sent', 'notice', 'request', 'meta_event'];

/** 把 OneBot 事件压成面板能看的一条；不认识的字段不往队列里塞 */
export function 解析上报(事件 = {}) {
  const 消息 = Array.isArray(事件.message)
    ? 事件.message.filter((段) => 段 && 段.type === 'text' && 段.data).map((段) => String(段.data.text || '')).join('')
    : '';
  const 文本 = typeof 事件.raw_message === 'string' && 事件.raw_message !== '' ? 事件.raw_message : 消息;
  const 发送者 = 事件.sender && typeof 事件.sender === 'object' ? 事件.sender : {};
  return {
    时刻: new Date().toISOString(),
    post_type: String(事件.post_type || ''),
    message_type: String(事件.message_type || ''),
    message_id: 事件.message_id === undefined ? null : 事件.message_id,
    time: Number.isFinite(事件.time) ? 事件.time : null,
    self_id: 事件.self_id === undefined ? '' : String(事件.self_id),
    user_id: 事件.user_id === undefined ? '' : String(事件.user_id),
    group_id: 事件.group_id === undefined ? '' : String(事件.group_id),
    昵称: String(发送者.card || 发送者.nickname || '').slice(0, 60),
    文本: String(文本 || '').slice(0, 2000),
    原始类型: String(事件.notice_type || 事件.request_type || 事件.meta_event_type || ''),
  };
}

export function 读收件箱(limit = 50, 路径 = 解析路径()) {
  try {
    if (!existsSync(路径.收件箱)) return { 消息: [], 总数: 0, 上限: 收件箱上限 };
    const 原 = JSON.parse(readFileSync(路径.收件箱, 'utf8'));
    const 表 = Array.isArray(原) ? 原 : (原 && Array.isArray(原.消息) ? 原.消息 : []);
    const 条数 = Math.min(收件箱上限, Math.max(1, Number(limit) || 50));
    return { 消息: 表.slice(-条数), 总数: 表.length, 上限: 收件箱上限 };
  } catch { return { 消息: [], 总数: 0, 上限: 收件箱上限 }; }
}

/** 追加一条已归一化的收件记录（OneBot 与官方机器人共用同一个收件箱文件） */
export function 追加收件记录(记录, 路径 = 解析路径()) {
  try {
    const 旧 = 读收件箱(收件箱上限, 路径).消息;
    旧.push(记录);
    const 表 = 旧.slice(-收件箱上限);
    写私密文件(路径.收件箱, JSON.stringify(表));
  } catch { /* 队列写失败不影响响应，但审计会记 */ }
  return 记录;
}

export function 追加收件箱(事件, 路径 = 解析路径()) {
  return 追加收件记录(解析上报(事件), 路径);
}

/** 校验上报来源：X-Signature(HMAC-SHA1) 或 Bearer / access_token 查询串 */
export function 校验上报鉴权(头 = {}, 原始体 = '', 配置 = 读配置(), 查询 = null) {
  const 密钥 = 配置.hook_secret || 配置.access_token || '';
  if (密钥 === '') return { ok: true, 方式: '未配置共享密钥' };

  const 取头 = (名) => String(头[名] || 头[名.toLowerCase()] || '').trim();
  const 签名 = 取头('x-signature');
  if (签名 !== '') {
    const m = /^sha1=([0-9a-f]{40})$/i.exec(签名);
    if (!m) return { ok: false, 原因: 'X-Signature 格式应为 sha1=<hex>' };
    const 期望 = createHmac('sha1', 密钥).update(原始体, 'utf8').digest();
    let 收到;
    try { 收到 = Buffer.from(m[1], 'hex'); } catch { return { ok: false, 原因: 'X-Signature 不是合法十六进制' }; }
    if (收到.length === 期望.length && timingSafeEqual(收到, 期望)) return { ok: true, 方式: 'X-Signature' };
    return { ok: false, 原因: 'X-Signature 校验失败' };
  }

  const 授权 = 取头('authorization');
  let 令牌 = '';
  if (/^Bearer\s+/i.test(授权)) 令牌 = 授权.replace(/^Bearer\s+/i, '').trim();
  else if (查询 && typeof 查询.get === 'function') 令牌 = String(查询.get('access_token') || '').trim();
  if (令牌 === '') return { ok: false, 原因: '缺少 X-Signature 或 Authorization' };
  const A = Buffer.from(令牌, 'utf8');
  const B = Buffer.from(密钥, 'utf8');
  if (A.length === B.length && timingSafeEqual(A, B)) return { ok: true, 方式: 'token' };
  return { ok: false, 原因: 'token 不匹配' };
}

/* ────────────────────────── HTTP 出口 ────────────────────────── */

function 回JSON(res, 码, 数据) {
  const 体 = JSON.stringify(数据);
  res.writeHead(码, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(体),
    'cache-control': 'no-store',
  });
  res.end(体);
}

function 读原始体(req, 上限 = 1 << 20) {
  return new Promise((resolve, reject) => {
    let 累 = '';
    req.on('data', (块) => {
      累 += 块;
      if (累.length > 上限) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(累));
    req.on('error', reject);
  });
}

function 读JSON体(req) {
  return 读原始体(req).then((原) => {
    if (原.trim() === '') return {};
    try { return JSON.parse(原); } catch { throw new Error('请求体不是合法 JSON'); }
  });
}

function 数字参数(查询, 名, 默认值) {
  const 原 = 查询 && typeof 查询.get === 'function' ? 查询.get(名) : null;
  const n = Number(原);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 默认值;
}

/** 自动回复这组配置的对外形态（不涉及任何密钥，可原样回给面板） */
export function 自动回复配置(配置 = 读配置()) {
  const 脱 = 脱敏配置(配置);
  return {
    official_auto_reply: 脱.official_auto_reply,
    official_reply_text: 脱.official_reply_text,
    official_reply_rules: 脱.official_reply_rules,
    official_reply_scope: 脱.official_reply_scope,
    official_reply_min_interval_ms: 脱.official_reply_min_interval_ms,
    official_reply_hourly_cap: 脱.official_reply_hourly_cap,
  };
}

/**
 * 建 webServer handler。宿主不保证第三个参数是 URL 对象，所以路径与查询都自己拼。
 * @param {{路径?:object, fetchImpl?:Function, 包根?:string, 官方?:object}} 选项
 *   官方：装配层注入的官方机器人门面 { 发送, 连接, 断开, 状态, 配置变更 }；
 *   不给时官方相关路由回 501，OneBot 通道照常工作。
 */
export function 建处理器(选项 = {}) {
  const 路径 = 选项.路径 || 解析路径();
  const 包根 = 选项.包根 || join(dirname(fileURLToPath(import.meta.url)), '..');
  const 官方 = 选项.官方 || null;
  const 调用选项 = { 路径, fetchImpl: 选项.fetchImpl, 官方 };

  return async function handler(req, res, url) {
    // ⚠️ 宿主只保证给 (req,res,url)，url 不一定是 URL 对象；查询串也不能当路径。
    const 原始 = (url && url.pathname)
      ? (url.pathname + (url.search || ''))
      : String(req.url || '/');
    let 解析;
    try { 解析 = new URL(原始, 'http://local'); } catch { 解析 = new URL('/', 'http://local'); }
    let 全路径;
    try { 全路径 = decodeURIComponent(解析.pathname); } catch { 全路径 = 解析.pathname; }
    // 只剥掉真正的路由前缀：/dsh-qq-bridge-xxx 不能被误当成 /xxx
    const 是路由 = 全路径 === ROUTE || 全路径.startsWith(ROUTE + '/');
    const 路 = (是路由 ? 全路径.slice(ROUTE.length) : 全路径) || '/';
    const 查询 = 解析.searchParams;
    const 方法 = String(req.method || 'GET').toUpperCase();

    try {
      if (路 === '/api/badge' && 方法 === 'GET') {
        try {
          const 图 = readFileSync(join(包根, 'assets', 'deepwhale-badge.png'));
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
          res.end(图);
        } catch { 回JSON(res, 404, { ok: false, 原因: '徽章图片缺失' }); }
        return;
      }

      if (路 === '/api/config' && 方法 === 'GET') {
        return 回JSON(res, 200, { ok: true, 配置: 脱敏配置(读配置(路径)), 配置文件: 路径.配置 });
      }

      if (路 === '/api/config' && 方法 === 'POST') {
        let 体;
        try { 体 = await 读JSON体(req); } catch (e) { return 回JSON(res, 400, { ok: false, 原因: String(e.message || e) }); }
        if (!体 || typeof 体 !== 'object' || Array.isArray(体)) return 回JSON(res, 400, { ok: false, 原因: '请求体必须是对象' });
        const 结果 = 保存配置(体, 路径);
        if (!结果.ok) return 回JSON(res, 400, 结果);
        // 配置真的变了（AppID/Secret/沙箱/通道）→ 由装配层决定是否按新配置重启连接
        try { 官方?.配置变更?.(读配置(路径)); } catch { /* 连接重启失败不能影响保存结果 */ }
        return 回JSON(res, 200, { ok: true, 配置: 结果.配置 });
      }

      if (路 === '/api/test' && 方法 === 'POST') {
        let 体 = {};
        try { 体 = await 读JSON体(req); } catch { /* 允许空体，用已保存配置 */ }
        const 配置 = (体 && 体.endpoint) ? 保存配置({ endpoint: 体.endpoint }, 路径) : null;
        if (配置 && !配置.ok) return 回JSON(res, 400, 配置);
        const 当前 = 读配置(路径);
        const 结果 = await 连接测试(当前, 调用选项);
        return 回JSON(res, 结果.ok ? 200 : 502, 结果);
      }

      if (路 === '/api/send' && 方法 === 'POST') {
        let 体;
        try { 体 = await 读JSON体(req); } catch (e) { return 回JSON(res, 400, { ok: false, 原因: String(e.message || e) }); }
        if (体 && 体.text !== undefined && typeof 体.text !== 'string') return 回JSON(res, 400, { ok: false, 原因: 'text 必须是字符串' });
        const 结果 = await 发送分派(体 || {}, { ...调用选项, 来源: 'panel' });
        const 参数错 = !结果.ok && /target|openid|channel|guild|为空|过长|格式不合法/.test(String(结果.原因 || ''));
        return 回JSON(res, 结果.ok ? 200 : (参数错 ? 400 : 502), 结果);
      }

      if (路 === '/api/official/status' && 方法 === 'GET') {
        const 当前 = 读配置(路径);
        const 状态 = 官方 && typeof 官方.状态 === 'function'
          ? 官方.状态(当前)
          : { state: '未装配', connected: false, sandbox: !!当前.official_sandbox };
        return 回JSON(res, 200, {
          ok: true, 状态,
          已配置: 当前.official_appid !== '' && 当前.official_secret !== '',
        });
      }

      if (路 === '/api/official/connect' && 方法 === 'POST') {
        if (!官方 || typeof 官方.连接 !== 'function') return 回JSON(res, 501, { ok: false, 原因: '官方机器人通道未装配' });
        const 当前 = 读配置(路径);
        if (当前.official_appid === '' || 当前.official_secret === '') {
          return 回JSON(res, 400, { ok: false, 原因: '先填 AppID 与 AppSecret 并保存配置' });
        }
        const 状态 = await 官方.连接(当前, 调用选项);
        const 失败 = 状态 && 状态.state === '错误';
        return 回JSON(res, 失败 ? 502 : 200, { ok: !失败, 状态, 原因: 失败 ? 状态.last_error : undefined });
      }

      if (路 === '/api/official/disconnect' && 方法 === 'POST') {
        if (!官方 || typeof 官方.断开 !== 'function') return 回JSON(res, 501, { ok: false, 原因: '官方机器人通道未装配' });
        return 回JSON(res, 200, { ok: true, 状态: 官方.断开() });
      }

      if (路 === '/api/official/autoreply' && 方法 === 'GET') {
        const 统计 = 官方 && 官方.自动回复 && typeof 官方.自动回复.统计 === 'function'
          ? 官方.自动回复.统计()
          : null;
        return 回JSON(res, 200, { ok: true, 配置: 自动回复配置(读配置(路径)), 统计 });
      }

      if (路 === '/api/official/autoreply' && 方法 === 'POST') {
        let 体;
        try { 体 = await 读JSON体(req); } catch (e) { return 回JSON(res, 400, { ok: false, 原因: String(e.message || e) }); }
        if (!体 || typeof 体 !== 'object' || Array.isArray(体)) return 回JSON(res, 400, { ok: false, 原因: '请求体必须是对象' });
        const 结果 = 保存配置(体, 路径);
        if (!结果.ok) return 回JSON(res, 400, 结果);
        // 自动回复字段不在连接签名里，正常不会触发重连；这里只是让装配层有机会感知
        try { 官方?.配置变更?.(读配置(路径)); } catch { /* 不能影响保存结果 */ }
        let 已恢复 = false;
        if (体.恢复 === true || 体.resume === true) {
          if (官方 && 官方.自动回复 && typeof 官方.自动回复.恢复 === 'function') {
            官方.自动回复.恢复();
            已恢复 = true;
          }
        }
        const 统计 = 官方 && 官方.自动回复 && typeof 官方.自动回复.统计 === 'function'
          ? 官方.自动回复.统计()
          : null;
        return 回JSON(res, 200, { ok: true, 配置: 自动回复配置(读配置(路径)), 统计, 已恢复 });
      }

      if (路 === '/api/inbox' && 方法 === 'GET') {
        const 结果 = 读收件箱(数字参数(查询, 'limit', 50), 路径);
        return 回JSON(res, 200, { ok: true, ...结果 });
      }

      if (路 === '/api/audit' && 方法 === 'GET') {
        return 回JSON(res, 200, { ok: true, 记录: 读审计(数字参数(查询, 'limit', 50), 路径), 文件: 路径.审计 });
      }

      if (路 === '/api/hook' && 方法 === 'POST') {
        let 原始体;
        try { 原始体 = await 读原始体(req); } catch (e) { return 回JSON(res, 413, { ok: false, 原因: String(e.message || e) }); }
        const 配置 = 读配置(路径);
        const 鉴权 = 校验上报鉴权(req.headers || {}, 原始体, 配置, 查询);
        let 体 = null;
        try { 体 = JSON.parse(原始体 || '{}'); } catch { /* 下面按坏体处理 */ }
        if (!鉴权.ok) {
          写审计({ 动作: '收到上报', 结果: '拒绝', 错误: 鉴权.原因, 来源: 'hook' }, 路径);
          return 回JSON(res, 401, { ok: false, 原因: 鉴权.原因 });
        }
        if (!体 || typeof 体 !== 'object' || Array.isArray(体)) {
          写审计({ 动作: '收到上报', 结果: '拒绝', 错误: '请求体不是 JSON 对象', 来源: 'hook' }, 路径);
          return 回JSON(res, 400, { ok: false, 原因: '请求体不是 JSON 对象' });
        }
        const 记录 = 追加收件箱(体, 路径);
        写审计({
          动作: '收到上报', 结果: '入队', 来源: 'hook', 鉴权: 鉴权.方式,
          类型: 记录.post_type, 消息类型: 记录.message_type, 群号: 记录.group_id,
          QQ号: 记录.user_id, 昵称: 记录.昵称, 内容: 记录.文本.slice(0, 200),
        }, 路径);
        // OneBot v11 上报端通常接受 204；body 留空
        res.writeHead(204);
        res.end();
        return;
      }

      return 回JSON(res, 404, { ok: false, 原因: '未知路径：' + 路 });
    } catch (e) {
      try { 回JSON(res, 500, { ok: false, 原因: '内部错误：' + String(e && e.message || e) }); } catch { /* ignore */ }
    }
  };
}
