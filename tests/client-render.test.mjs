/**
 * 客户端面板渲染自测（离线）：
 * 用最小假 React 渲染「OneBot 模式」与「官方机器人模式」两条分支，
 * 抓渲染期抛错（真正的白屏风险）。preflight 只跑默认态，这里补官方分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..');
const 源码 = readFileSync(join(包根, 'lib', 'client.js'), 'utf8');

/**
 * 以给定 useState 初值种子渲染面板，返回 { 树, 文本 }。
 * 种子按 hook 调用顺序（面板里 22 个 useState 全在分支之前，顺序固定）。
 */
function 渲染面板(种子 = {}) {
  let 载入模块 = null;
  const 沙箱 = {
    window: { __ModuleLoader__: { load(对象) { 载入模块 = 对象; } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }),
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
  };
  vm.createContext(沙箱);
  vm.runInContext(源码, 沙箱, { filename: 'client.js' });
  assert.ok(载入模块, '必须调用 window.__ModuleLoader__.load');

  let 序号 = 0;
  class 组件基类 {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState() {}
    render() { return this.props ? this.props.children : null; }
  }
  const react = {
    Component: 组件基类,
    createElement: (类型, 属性, ...子) => ({ 类型, 属性: 属性 || {}, 子 }),
    Fragment: 'Fragment',
    useState: (初值) => {
      const i = 序号;
      序号 += 1;
      return [Object.prototype.hasOwnProperty.call(种子, i) ? 种子[i] : 初值, () => {}];
    },
    useEffect: () => {}, useLayoutEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (f) => f(), useCallback: (f) => f,
    memo: (c) => c, forwardRef: (c) => c,
  };

  const 模块 = 载入模块.factory((名) => (名 === 'react' ? react : undefined));
  assert.equal(typeof 模块.apply, 'function');

  const 注册 = [];
  const ctx = {
    slots: {
      inject(名, 生成器) {
        const g = 生成器();
        let 结果 = g.next();
        while (!结果.done) 结果 = g.next();
      },
      register(配置, 组件) { 注册.push({ 配置, 组件 }); return {}; },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  模块.apply(ctx);
  const 主 = 注册.find((r) => r.配置.name === 'main');
  assert.ok(主, '必须注册主面板');
  const 树 = 主.组件({});
  return { 树, 文本: 收集文本(树) };
}

/** 递归收集元素树里的文本，同时把每个节点都摸一遍（渲染期异常会在这里抛） */
function 收集文本(节点, 深度 = 0) {
  if (深度 > 60 || 节点 == null) return '';
  if (typeof 节点 === 'string') return 节点 + '\n';
  if (typeof 节点 === 'number') return String(节点) + '\n';
  if (Array.isArray(节点)) return 节点.map((子) => 收集文本(子, 深度 + 1)).join('');
  if (typeof 节点 !== 'object') return '';
  let 出 = '';
  for (const 键 of Object.keys(节点.属性 || {})) {
    const 值 = 节点.属性[键];
    if (typeof 值 === 'string') 出 += 值 + '\n';
  }
  // 宿主组件（函数组件 / ErrorBoundary 类组件）要真的渲染一次，才能看见面板主体
  if (typeof 节点.类型 === 'function') {
    try {
      if (节点.类型.prototype && typeof 节点.类型.prototype.render === 'function') {
        const 实例 = new 节点.类型(节点.属性);
        出 += 收集文本(实例.render(), 深度 + 1);
      } else {
        出 += 收集文本(节点.类型(节点.属性), 深度 + 1);
      }
    } catch (e) {
      throw new Error('组件渲染抛错：' + String((e && e.message) || e));
    }
  }
  出 += 收集文本(节点.子, 深度 + 1);
  return 出;
}

test('客户端面板：OneBot 默认态渲染不抛错，含通道切换', () => {
  const { 文本 } = 渲染面板();
  assert.match(文本, /深鲸 QQ 桥接/);
  assert.match(文本, /QQ 官方机器人/);
  assert.match(文本, /OneBot v11/);
  assert.match(文本, /连接测试/);
  assert.match(文本, /入站消息/);
});

test('客户端面板：官方机器人模式渲染不抛错（状态/入站/回复/发送区齐全）', () => {
  const { 文本 } = 渲染面板({
    1: 'official',                                        // 模式
    8: '1904047384',                                      // AppID
    12: {                                                 // 官方状态
      state: '已连接', connected: true, sandbox: false,
      bot_name: 'feely-bot2', bot_id: '7111817165780244444',
      heartbeat_interval: 41250, reconnects: 1, last_error: '',
    },
    17: {                                                 // 入站
      消息: [{
        来源通道: 'official', 会话类型: 'group', 事件类型: 'GROUP_AT_MESSAGE_CREATE',
        群: '…ABCDEF', group_openid: 'GROUP_OPENID_ABCDEF', openid: 'MEMBER_OPENID_XYZ123',
        msg_id: 'MSGID_GROUP_1', 文本: '合同什么时候签？', 时刻: '2026-10-30T10:00:00.000Z', 昵称: '',
      }],
      总数: 1, 上限: 1000,
    },
    21: '提示：已连接',                                    // 提示
    22: true,                                             // 自动回复开关
    23: '收到～{昵称}',                                    // 默认模板
    24: '价格,多少钱=价格表发你了',                          // 关键词规则文本
    25: 'c2c',                                            // 范围
    26: 30,                                               // 最小间隔（秒）
    27: 60,                                               // 每小时上限
    28: {                                                 // 自动回复统计
      运行状态: '运行中', 今日次数: 3, 小时次数: 2, 每小时上限: 60,
      连续失败: 0, 暂停: false, 暂停原因: '', 上次回复: '2026-10-30T10:00:00.000Z',
    },
  });
  assert.match(文本, /AppID/);
  assert.match(文本, /AppSecret/);
  assert.match(文本, /沙箱环境/);
  assert.match(文本, /已连接/);
  assert.match(文本, /feely-bot2/);
  assert.match(文本, /官方通道/);
  assert.match(文本, /msg_id/);
  assert.match(文本, /回复/);
  assert.match(文本, /GROUP_AT_MESSAGE_CREATE/);
  assert.match(文本, /合同什么时候签/);
  assert.match(文本, /入站消息/);
  // v0.3 自动回复卡片
  assert.match(文本, /自动回复（关键词 \+ 模板）/);
  assert.match(文本, /开启自动回复/);
  assert.match(文本, /关键词规则/);
  assert.match(文本, /今日已自动回复 3 次/);
  assert.match(文本, /本小时 2\/60/);
  assert.match(文本, /价格表发你了/);
  assert.match(文本, /保存并生效/);
  assert.match(文本, /恢复自动回复/);
});

test('客户端面板：自动回复暂停态显示原因（不白屏）', () => {
  const { 文本 } = 渲染面板({
    1: 'official',
    22: true,
    28: {
      运行状态: '已暂停', 今日次数: 0, 小时次数: 0, 每小时上限: 5,
      连续失败: 3, 暂停: true, 暂停原因: '连续 3 次自动回复失败：模拟 40034005',
    },
  });
  assert.match(文本, /已暂停/);
  assert.match(文本, /40034005/);
});

test('客户端面板：错误态与未查询态都能渲染（不白屏）', () => {
  const 错 = 渲染面板({ 1: 'official', 12: { state: '错误', last_error: '取 access_token 失败：code 100016' }, 20: '连接失败' });
  assert.match(错.文本, /错误/);
  assert.match(错.文本, /100016/);
  const 空 = 渲染面板({ 1: 'official', 12: null });
  assert.match(空.文本, /未查询/);
});
