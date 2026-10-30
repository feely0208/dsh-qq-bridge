/**
 * 深鲸 QQ 桥接 —— 宿主（服务端）半边
 *
 * 把 QQ 接进 DSH：面板/Agent 工具共用同一份配置、审计与发送路径。
 * 两条通道二选一：
 *   · OneBot v11（本机 NapCat / Lagrange.OneBot 等框架，v0.1 起支持）
 *   · QQ 官方机器人（qq.qq.com AppID + AppSecret + WebSocket，v0.2 新增）
 * v0.3 起支持「自动回复」：关键词规则 + 模板 + 防刷（默认关闭，见 lib/autoreply.js）。
 *
 * 出口：
 *   GET  /dsh-qq-bridge/api/config             端点 / 通道 / 掩码
 *   POST /dsh-qq-bridge/api/config             保存配置（密钥只落本机 0600 文件）
 *   POST /dsh-qq-bridge/api/test               调 OneBot /get_login_info
 *   POST /dsh-qq-bridge/api/send               发消息（按 mode 分派）
 *   GET  /dsh-qq-bridge/api/official/status    官方机器人连接状态
 *   POST /dsh-qq-bridge/api/official/connect   连接官方机器人
 *   POST /dsh-qq-bridge/api/official/disconnect 断开官方机器人
 *   GET  /dsh-qq-bridge/api/official/autoreply 自动回复配置 + 今日/小时统计
 *   POST /dsh-qq-bridge/api/official/autoreply 保存自动回复配置（恢复=true 可手动解除暂停）
 *   GET  /dsh-qq-bridge/api/inbox              最近入站（两条通道同一个队列）
 *   GET  /dsh-qq-bridge/api/audit              最近审计
 *   GET  /dsh-qq-bridge/api/badge             powered-by-dwh 徽章
 *   POST /dsh-qq-bridge/api/hook               OneBot 事件上报入口（X-Signature / token）
 *
 * @module @deepwhale-cn/dsh-qq-bridge
 */
import { createHash } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  ROUTE, 建处理器, 解析路径, 读配置, 读收件箱, 发送分派,
} from './core.js';
import * as 官方通道 from './official.js';
import { 自动回复统计, 恢复自动回复 } from './autoreply.js';

export const name = 'qq-bridge';
export const inject = ['webServer', 'tools'];

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, 值) => [{ type: 'text', text: 值 }],
};

/* ────────────────────────── 官方通道门面（注入给 core 的 handler） ────────────────────────── */

/** 上一次连接所用的 AppID/Secret/沙箱签名：只有变了才重启连接，避免保存无关配置就重连 */
let 最近官方签名 = '';

function 官方签名(配置) {
  const 密钥 = 配置.official_secret || '';
  // 只用于判断「配置有没有变」，哈希不进文件/日志/接口
  const 密钥指纹 = 密钥 === '' ? 'unset' : createHash('sha256').update(密钥).digest('hex').slice(0, 12);
  return [配置.official_appid || '', 密钥指纹, 配置.official_sandbox ? 'sandbox' : 'prod'].join('|');
}

const 官方门面 = {
  发送: (入参, 选项) => 官方通道.发送官方消息(入参, 选项),
  连接: async (配置, 选项 = {}) => {
    最近官方签名 = 官方签名(配置);
    return 官方通道.连接官方(配置, { 路径: 解析路径(), ...选项 });
  },
  断开: () => {
    最近官方签名 = '';
    return 官方通道.断开官方();
  },
  状态: (配置) => 官方通道.官方状态(配置),
  自动回复: {
    统计: () => 自动回复统计(读配置(解析路径())),
    恢复: () => 恢复自动回复({ 路径: 解析路径(), 配置: 读配置(解析路径()) }),
  },
  配置变更: (配置) => {
    const 在连 = 官方通道.当前官方连接();
    if (配置.mode !== 'official') {
      if (在连) 官方门面.断开();
      return;
    }
    const 新签名 = 官方签名(配置);
    if (在连) {
      // 通道内配置变了 → 按新配置重启；没变就不动（保持连接）
      if (新签名 !== 最近官方签名) void 官方门面.连接(配置).catch(() => {});
      return;
    }
    if (配置.official_auto_connect && 配置.official_appid && 配置.official_secret) {
      void 官方门面.连接(配置).catch(() => {});
    }
  },
};

/* ────────────────────────── Agent 工具 ────────────────────────── */

/** 工具与面板共用一条发送路径：配置、校验、审计都只有一份 */
function 建发送工具() {
  return defineTool({
    name: 'qq_send',
    description: '通过 QQ 桥接发送消息。两条通道二选一：官方机器人（QQ 开放平台，mode=official）用 openid/group_openid/channel_id/guild_id 定位会话；OneBot v11（mode=onebot 或未配 mode）用 target/target_type。发送结果与失败原因都会写审计。',
    parameters: {
      mode: { type: 'string', enum: ['onebot', 'official'], description: '通道；不填则用面板配置的通道（默认 onebot）。' },
      text: { type: 'string', required: true, description: '消息正文，最多 4000 字符。' },
      // 官方机器人
      channel: { type: 'string', enum: ['c2c', 'group', 'channel', 'dm'], description: '官方通道会话类型：c2c 私聊 / group 群 / channel 频道 / dm 频道私信。' },
      openid: { type: 'string', description: '官方 C2C 私聊的 user_openid（来自 qq_inbox 的入站记录）。' },
      group_openid: { type: 'string', description: '官方群消息的 group_openid（来自 qq_inbox）。' },
      channel_id: { type: 'string', description: '官方频道子频道 id。' },
      guild_id: { type: 'string', description: '官方频道/频道私信的 guild_id。' },
      msg_id: { type: 'string', description: '被动回复时带上原消息 msg_id（官方要求被动回复才不需要主动消息配额）。' },
      // OneBot v11
      target: { type: 'string', description: 'OneBot：QQ 号（私聊）或群号（群聊），5~20 位数字。' },
      target_type: { type: 'string', enum: ['private', 'group'], description: 'OneBot：private = 私聊，group = 群聊。' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (入参) => {
      const 结果 = await 发送分派(入参 || {}, {
        来源: 'tool', 官方: 官方门面, 路径: 解析路径(),
      });
      if (!结果.ok) return '发送失败：' + 结果.原因;
      if (结果.通道 === 'official') {
        return '已通过官方机器人发送（' + 结果.会话类型 + ' ' + 结果.目标 + '）' +
          (结果.消息号 === null || 结果.消息号 === undefined ? '' : '（id ' + 结果.消息号 + '）');
      }
      return '已发送到' + (结果.目标类型 === 'group' ? '群 ' : ' QQ ') + 结果.目标 +
        (结果.消息号 === null || 结果.消息号 === undefined ? '' : '（message_id ' + 结果.消息号 + '）');
    },
    presentCall: () => ({ card: 'generic', kind: 'write', title: '发送 QQ 消息' }),
  });
}

function 一行入站(m) {
  const 时刻 = String(m.时刻 || '').replace('T', ' ').slice(0, 19);
  if (m.来源通道 === 'official') {
    const 会话 = m.会话类型 === 'group'
      ? '群 ' + m.group_openid
      : (m.会话类型 === 'c2c' ? '私聊 ' + m.openid
        : (m.会话类型 === 'channel' ? '频道 ' + m.channel_id : '私信 ' + m.guild_id));
    const 谁 = m.昵称 ? m.昵称 + ' / ' + 官方通道.短号(m.openid) : 官方通道.短号(m.openid);
    return '· ' + 时刻 + ' · [官方] ' + 会话 + ' · ' + 谁 + ' · ' + (m.文本 || '（非文本）').slice(0, 200) +
      (m.msg_id ? '（msg_id ' + m.msg_id + '）' : '');
  }
  const 谁 = m.post_type === 'message'
    ? (m.message_type === 'group' ? '群 ' + m.group_id + ' / ' + (m.昵称 || m.user_id) : '私聊 ' + m.user_id)
    : (m.post_type + (m.原始类型 ? ':' + m.原始类型 : ''));
  return '· ' + 时刻 + ' · ' + 谁 + ' · ' + (m.文本 || '（非文本）').slice(0, 200);
}

function 建收件箱工具() {
  return defineTool({
    name: 'qq_inbox',
    description: '读取 QQ 桥接最近收到的入站消息（官方机器人：群/私聊/频道；OneBot v11：群/私聊消息、通知、请求）。只读本机队列，不触发联网。',
    parameters: {
      limit: { type: 'number', description: '返回最近多少条，默认 20，最多 1000。' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (入参) => {
      const 条数 = Math.min(1000, Math.max(1, Number(入参 && 入参.limit) || 20));
      const 结果 = 读收件箱(条数, 解析路径());
      if (!结果.消息.length) return '收件箱为空（官方机器人连上后收到的消息会自动入队；OneBot 需把上报指向 ' + ROUTE + '/api/hook）。';
      const 行 = 结果.消息.slice().reverse().map(一行入站);
      return '最近 ' + 结果.消息.length + ' 条（共 ' + 结果.总数 + ' 条，上限 ' + 结果.上限 + '）：\n' + 行.join('\n');
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '读取 QQ 收件箱' }),
  });
}

export function apply(ctx) {
  const 路径 = 解析路径();

  // ── HTTP 出口：注册失败只影响面板，不影响宿主 ──
  try {
    if (ctx && ctx.webServer && typeof ctx.webServer.register === 'function') {
      const handler = 建处理器({ 路径, 官方: 官方门面 });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'qq-bridge: http 出口');
      } else {
        ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler });
      }
      try { ctx.logger?.info?.('[qq-bridge] 已挂 HTTP 出口 ' + ROUTE + '/api'); } catch { /* ignore */ }
    } else {
      try { ctx?.logger?.warn?.('[qq-bridge] 没有 webServer 服务，面板会取不到数据'); } catch { /* ignore */ }
    }
  } catch (e) {
    try { ctx?.logger?.warn?.('[qq-bridge] HTTP 出口注册失败（已跳过）：' + String(e && e.message || e)); } catch { /* ignore */ }
  }

  // ── 官方机器人：只有显式打开 auto_connect 才自动连（默认等用户点按钮） ──
  try {
    const 配置 = 读配置(路径);
    if (配置.mode === 'official' && 配置.official_auto_connect && 配置.official_appid && 配置.official_secret) {
      void 官方门面.连接(配置).catch((e) => {
        try { ctx?.logger?.warn?.('[qq-bridge] 官方机器人自动连接失败：' + String(e && e.message || e)); } catch { /* ignore */ }
      });
    }
  } catch { /* 自动连接失败不能挡住插件加载 */ }

  // ── Agent 工具：每个单独 try，一个失败不影响另一个 ──
  if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
    try { ctx.tools.register(建发送工具()); }
    catch (e) { try { ctx.logger?.warn?.('[qq-bridge] qq_send 注册失败（已跳过）：' + String(e && e.message || e)); } catch { /* ignore */ } }
    try { ctx.tools.register(建收件箱工具()); }
    catch (e) { try { ctx.logger?.warn?.('[qq-bridge] qq_inbox 注册失败（已跳过）：' + String(e && e.message || e)); } catch { /* ignore */ } }
  } else {
    try { ctx?.logger?.warn?.('[qq-bridge] 没有 tools 服务，Agent 工具不可用'); } catch { /* ignore */ }
  }
}

export default { name, inject, apply };
