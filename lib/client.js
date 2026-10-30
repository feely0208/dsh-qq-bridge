/**
 * 深鲸 QQ 桥接 —— 客户端半边（侧栏面板）
 *
 * 槽位：sidebar.panellist（图标）+ main（keyed 'qq-bridge'）
 * 数据：/dsh-qq-bridge/api/{config,test,send,inbox,audit,badge,official/status,official/connect,official/disconnect}
 * 两条通道二选一：QQ 官方机器人（qq.qq.com AppID + AppSecret + WebSocket）/ OneBot v11。
 *
 * 三层白屏自保：
 *   ① 整个 factory 包 try/catch，失败返回 {inject:[],apply(){}}
 *   ② 面板包 React ErrorBoundary
 *   ③ apply 整体 try + 每个 slot 注册单独 try
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-qq-bridge',
  factory: (require) => {
    try {
      var module = { exports: {} };
      var exports = module.exports;
      const react = require('react');
      const h = react.createElement;

      const API = '/dsh-qq-bridge/api';
      const SLOT_ICON = 'sidebar.panellist';
      const SLOT_MAIN = 'main';
      const PANEL_ID = 'qq-bridge';

      const V = {
        卡底: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
        浅底: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.14))',
        边: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.28))',
        差: 'var(--dsw-alias-state-error-primary, #D64541)',
      };
      const 好 = '#2E9E5B', 警 = '#C77F1A';
      const 卡样式 = { background: V.卡底, border: '1px solid ' + V.边, borderRadius: 10, padding: '10px 12px', marginBottom: 10, color: 'inherit' };
      const 小字 = { fontSize: 12, opacity: 0.72, lineHeight: 1.6 };
      const 正字 = { fontSize: 13, lineHeight: 1.6 };
      const 等宽 = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
      const 按钮 = (主要) => ({
        background: 主要 ? 'rgba(127,127,127,0.20)' : V.浅底, color: 'inherit',
        border: '1px solid ' + V.边, borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12,
        ...(主要 ? { boxShadow: 'inset 0 0 0 1.6px currentColor', fontWeight: 600 } : {}),
      });
      const 小按钮 = (色) => ({
        background: 'transparent', color: 色 || 'inherit', border: '1px solid ' + V.边,
        borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 11, marginLeft: 6,
      });
      const 输入 = { background: V.浅底, color: 'inherit', border: '1px solid ' + V.边, borderRadius: 6, padding: '6px 8px', fontSize: 13, width: '100%', ...等宽 };
      const 页签 = (选中) => ({
        background: 选中 ? 'rgba(127,127,127,0.22)' : 'transparent',
        color: 'inherit', border: '1px solid ' + V.边, borderRadius: 8,
        padding: '5px 14px', cursor: 'pointer', fontSize: 12,
        fontWeight: 选中 ? 600 : 400, opacity: 选中 ? 1 : 0.75,
      });

      async function 取(路, 选项) {
        const res = await fetch(API + 路, 选项);
        let 体 = null;
        try { 体 = await res.json(); } catch { 体 = { ok: false, 原因: 'HTTP ' + res.status + ' 非 JSON 响应' }; }
        return 体;
      }
      const 发 = (路, 体) => 取(路, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(体) });

      const 尾号 = (值) => {
        const 串 = String(值 == null ? '' : 值);
        if (串 === '') return '';
        return 串.length <= 6 ? 串 : '…' + 串.slice(-6);
      };
      const 会话名 = (类型) => (类型 === 'group' ? '群' : (类型 === 'c2c' ? '私聊' : (类型 === 'channel' ? '频道' : '私信')));
      const 目标字段名 = (类型) => (类型 === 'group' ? 'group_openid' : (类型 === 'c2c' ? 'openid' : (类型 === 'channel' ? 'channel_id' : 'guild_id')));
      const 状态色 = (状态) => {
        const 名 = 状态 && 状态.state ? 状态.state : '';
        if (名 === '已连接') return 好;
        if (名 === '错误' || 名 === '已断开') return V.差;
        if (名 === '握手中' || 名 === '连接中' || 名 === '重连中') return 警;
        return 'inherit';
      };
      const 状态说明 = (状态) => {
        if (!状态) return '未查询';
        const 名 = 状态.state || '空闲';
        if (名 === '已连接') return '已连接' + (状态.bot_name ? '（' + 状态.bot_name + '）' : '');
        if (名 === '握手中') return '握手中（等 READY）';
        if (名 === '连接中') return '连接中…';
        if (名 === '重连中') return '重连中…' + (状态.last_error ? '：' + 状态.last_error : '');
        if (名 === '错误') return '错误：' + (状态.last_error || '未知');
        if (名 === '已断开') return '已断开';
        return 名;
      };

      /** 规则数组 → 面板里的多行文本：`关键词1,关键词2=回复`，非「包含」模式加前缀 */
      const 规则转文本 = (表) => (Array.isArray(表) ? 表 : []).map((r) => {
        const 词 = (Array.isArray(r && r.关键词) ? r.关键词 : []).join(',');
        const 前 = r && r.模式 && r.模式 !== '包含' ? r.模式 + ':' : '';
        return 前 + 词 + '=' + String((r && r.回复) || '');
      }).join('\n');
      /** 面板文本 → 规则数组（服务端还会再归一化一次，这里只管把用户写的解析出来） */
      const 文本转规则 = (文本) => String(文本 || '').split('\n').map((行) => 行.trim()).filter(Boolean).map((行) => {
        const 等 = 行.indexOf('=');
        if (等 < 0) return null;
        let 左 = 行.slice(0, 等).trim();
        const 回复 = 行.slice(等 + 1).trim();
        let 模式 = '包含';
        const m = /^(包含|精确|正则)\s*[:：]\s*(.*)$/.exec(左);
        if (m) { 模式 = m[1]; 左 = m[2]; }
        const 词 = 左.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
        if (!词.length) return null;
        return { 关键词: 词, 回复, 模式 };
      }).filter(Boolean);

      function 错误边界_渲染({ 错 }) {
        return h('div', { style: { padding: 16, fontSize: 13, lineHeight: 1.7, color: 'inherit' } },
          'QQ 桥接组件出错（已降级，不影响其他界面）：' + String(错 && 错.message || 错));
      }
      class 错误边界 extends react.Component {
        constructor(p) { super(p); this.state = { 错: null }; }
        static getDerivedStateFromError(e) { return { 错: e }; }
        componentDidCatch(e) { try { console.warn('[QQ桥接] 渲染出错，已降级：', e && e.message ? e.message : e); } catch { /* ignore */ } }
        render() {
          if (this.state && this.state.错) return h(错误边界_渲染, { 错: this.state.错 });
          return this.props ? this.props.children : null;
        }
      }

      function 面板() {
        const [配置, 设配置] = react.useState(null);
        const [模式, 设模式] = react.useState('onebot');
        // OneBot
        const [端点, 设端点] = react.useState('');
        const [令牌, 设令牌] = react.useState('');
        const [密钥, 设密钥] = react.useState('');
        const [目标类型, 设目标类型] = react.useState('private');
        const [目标, 设目标] = react.useState('');
        const [正文, 设正文] = react.useState('深鲸 QQ 桥接 · 测试消息');
        // 官方机器人
        const [官方APPID, 设官方APPID] = react.useState('');
        const [官方密钥, 设官方密钥] = react.useState('');
        const [沙箱, 设沙箱] = react.useState(false);
        const [自动连, 设自动连] = react.useState(false);
        const [官方状态, 设官方状态] = react.useState(null);
        const [官方目标类型, 设官方目标类型] = react.useState('c2c');
        const [官方目标, 设官方目标] = react.useState('');
        const [官方正文, 设官方正文] = react.useState('');
        const [官方回复号, 设官方回复号] = react.useState('');
        // 公共
        const [收件, 设收件] = react.useState({ 消息: [], 总数: 0, 上限: 1000 });
        const [审计, 设审计] = react.useState([]);
        const [忙, 设忙] = react.useState('');
        const [错, 设错] = react.useState('');
        const [提示, 设提示] = react.useState('');
        // 自动回复（v0.3）：开关 / 默认模板 / 规则文本 / 范围 / 间隔 / 上限 / 统计
        const [自动开关, 设自动开关] = react.useState(false);
        const [回复模板, 设回复模板] = react.useState('');
        const [规则文本, 设规则文本] = react.useState('');
        const [回复范围, 设回复范围] = react.useState('c2c');
        const [最小间隔秒, 设最小间隔秒] = react.useState(30);
        const [每小时上限, 设每小时上限] = react.useState(60);
        const [回复统计, 设回复统计] = react.useState(null);

        const 刷新官方状态 = async () => {
          try {
            const 状态 = await 取('/official/status');
            if (状态 && 状态.ok) 设官方状态(状态.状态 || null);
          } catch { /* 状态查询失败不打扰用户 */ }
        };

        const 载入 = async () => {
          设错(''); 设提示('');
          try {
            const c = await 取('/config');
            if (!c.ok) throw new Error(c.原因 || '配置读取失败');
            设配置(c.配置);
            设模式(c.配置.mode === 'official' ? 'official' : 'onebot');
            设端点(c.配置.endpoint || '');
            设官方APPID(c.配置.official_appid || '');
            设沙箱(!!c.配置.official_sandbox);
            设自动连(!!c.配置.official_auto_connect);
            if (c.配置.default_target) 设目标(c.配置.default_target);
            if (c.配置.default_target_type) 设目标类型(c.配置.default_target_type);
            const i = await 取('/inbox?limit=30');
            设收件(i.ok ? i : { 消息: [], 总数: 0, 上限: 1000 });
            const a = await 取('/audit?limit=30');
            设审计(a.记录 || []);
            try {
              const ar = await 取('/official/autoreply');
              if (ar && ar.ok && ar.配置) {
                设自动开关(!!ar.配置.official_auto_reply);
                设回复模板(ar.配置.official_reply_text || '');
                设规则文本(规则转文本(ar.配置.official_reply_rules));
                设回复范围(ar.配置.official_reply_scope === 'all' ? 'all' : 'c2c');
                设最小间隔秒(Math.max(0, Math.round((Number(ar.配置.official_reply_min_interval_ms) || 0) / 1000)));
                设每小时上限(Math.max(0, Math.floor(Number(ar.配置.official_reply_hourly_cap) || 0)));
                设回复统计(ar.统计 || null);
              }
            } catch { /* 自动回复配置读不到不影响其他区块 */ }
            await 刷新官方状态();
          } catch (e) { 设错(String(e && e.message || e)); }
        };
        react.useEffect(() => {
          载入();
          const 定时 = setInterval(() => { 刷新官方状态(); }, 5000);
          return function () { clearInterval(定时); };
        }, []);

        /* ── OneBot ── */
        const 保存 = async () => {
          设忙('保存中…'); 设错(''); 设提示('');
          try {
            const 体 = { mode: 'onebot', endpoint: 端点, default_target: 目标, default_target_type: 目标类型 };
            if (令牌.trim() !== '') 体.access_token = 令牌;
            if (密钥.trim() !== '') 体.hook_secret = 密钥;
            const r = await 发('/config', 体);
            if (!r.ok) throw new Error(r.原因 || '保存失败');
            设配置(r.配置);
            设令牌(''); 设密钥('');
            设提示('已保存到本机配置文件（token 不回显完整值）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 测试 = async () => {
          设忙('连接测试中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/test', { endpoint: 端点 });
            if (!r.ok) throw new Error(r.原因 || '连接失败');
            设提示('连接成功：' + (r.昵称 || '?') + '（' + (r.帐号 || '?') + '）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 发送 = async () => {
          设忙('发送中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/send', { mode: 'onebot', target: 目标, target_type: 目标类型, text: 正文 });
            if (!r.ok) throw new Error(r.原因 || '发送失败');
            设提示('已发送（message_id ' + (r.消息号 === null || r.消息号 === undefined ? '—' : r.消息号) + '）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 清令牌 = async () => {
          设忙('清除中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/config', { clear_token: true });
            if (!r.ok) throw new Error(r.原因 || '清除失败');
            设提示('已清除本机保存的 access_token');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        /* ── 官方机器人 ── */
        const 保存官方 = async () => {
          设忙('保存中…'); 设错(''); 设提示('');
          try {
            const 体 = {
              mode: 'official', official_appid: 官方APPID,
              official_sandbox: !!沙箱, official_auto_connect: !!自动连,
            };
            if (官方密钥.trim() !== '') 体.official_secret = 官方密钥;
            const r = await 发('/config', 体);
            if (!r.ok) throw new Error(r.原因 || '保存失败');
            设配置(r.配置);
            设官方密钥('');
            设提示('已保存官方机器人配置（AppSecret 只落本机 0600 文件，接口只回掩码）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 清除官方密钥 = async () => {
          设忙('清除中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/config', { clear_official_secret: true });
            if (!r.ok) throw new Error(r.原因 || '清除失败');
            设提示('已清除本机保存的 AppSecret');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 连接官方 = async () => {
          设忙('连接中…'); 设错(''); 设提示('');
          try {
            // 先把当前输入落盘（用户可能刚填 AppID 就点连接），再连
            const 体 = {
              mode: 'official', official_appid: 官方APPID,
              official_sandbox: !!沙箱, official_auto_connect: !!自动连,
            };
            if (官方密钥.trim() !== '') 体.official_secret = 官方密钥;
            const 存 = await 发('/config', 体);
            if (!存.ok) throw new Error(存.原因 || '保存失败');
            设配置(存.配置);
            设官方密钥('');
            const r = await 发('/official/connect', {});
            if (!r.ok) throw new Error(r.原因 || '连接失败');
            设官方状态(r.状态 || null);
            设提示('已发起连接：' + 状态说明(r.状态));
            const i = await 取('/inbox?limit=30');
            if (i.ok) 设收件(i);
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 断开官方 = async () => {
          设忙('断开中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/official/disconnect', {});
            if (!r.ok) throw new Error(r.原因 || '断开失败');
            设官方状态(r.状态 || null);
            设提示('已断开官方机器人通道');
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 回复某条 = (记录) => {
          设官方目标类型(记录.会话类型 === 'channel' ? 'channel' : (记录.会话类型 === 'dm' ? 'dm' : (记录.会话类型 === 'group' ? 'group' : 'c2c')));
          设官方目标(String(记录.group_openid || 记录.openid || 记录.channel_id || 记录.guild_id || ''));
          设官方回复号(String(记录.msg_id || ''));
          设官方正文('');
          设提示('已填好回复对象（' + 会话名(记录.会话类型) + ' ' + 尾号(记录.group_openid || 记录.openid || 记录.channel_id || 记录.guild_id) +
            (记录.msg_id ? '，被动回复 msg_id ' + 尾号(记录.msg_id) : '') + '），写完正文点发送');
        };

        const 回复最近 = () => {
          const 表 = (收件.消息 || []).filter((m) => m && m.来源通道 === 'official');
          if (!表.length) { 设错('还没有官方通道的入站消息，无法回复最近一条'); return; }
          回复某条(表[表.length - 1]);
        };

        const 发送官方 = async () => {
          设忙('发送中…'); 设错(''); 设提示('');
          try {
            const 体 = { mode: 'official', channel: 官方目标类型, text: 官方正文 };
            体[目标字段名(官方目标类型)] = String(官方目标).trim();
            if (官方回复号.trim() !== '') 体.msg_id = 官方回复号.trim();
            const r = await 发('/send', 体);
            if (!r.ok) throw new Error(r.原因 || '发送失败');
            设提示('已通过官方机器人发送（' + 会话名(r.会话类型 || 官方目标类型) + ' ' +
              (r.目标 || 尾号(官方目标)) + (r.消息号 ? '，id ' + r.消息号 : '') + '）');
            设官方正文('');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 保存自动回复 = async () => {
          设忙('保存中…'); 设错(''); 设提示('');
          try {
            const 秒 = Number(最小间隔秒);
            const 体 = {
              official_auto_reply: !!自动开关,
              official_reply_text: 回复模板,
              official_reply_rules: 文本转规则(规则文本),
              official_reply_scope: 回复范围,
              official_reply_min_interval_ms: Math.max(0, Math.round((Number.isFinite(秒) ? 秒 : 0) * 1000)),
              official_reply_hourly_cap: Math.max(0, Math.floor(Number(每小时上限) || 0)),
            };
            const r = await 发('/official/autoreply', 体);
            if (!r.ok) throw new Error(r.原因 || '保存失败');
            设回复统计(r.统计 || null);
            设提示('自动回复已保存并生效（' + (体.official_auto_reply ? '已开启，' + 体.official_reply_rules.length + ' 条规则' : '已关闭') + '）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        const 恢复自动回复按钮 = async () => {
          设忙('恢复中…'); 设错(''); 设提示('');
          try {
            const r = await 发('/official/autoreply', { 恢复: true });
            if (!r.ok) throw new Error(r.原因 || '恢复失败');
            设回复统计(r.统计 || null);
            设提示('已恢复自动回复（暂停与连续失败计数已清零）');
            载入();
          } catch (e) { 设错(String(e && e.message || e)); }
          finally { 设忙(''); }
        };

        /* ── 渲染 ── */
        const 令牌提示 = 配置 && 配置.has_token ? '已保存 ' + 配置.token_masked + '（留空不修改）' : '未保存（OneBot 未启用 token 可留空）';
        const 密钥提示 = 配置 && 配置.has_hook_secret ? '已保存 ' + 配置.hook_secret_masked + '（留空不修改）' : '未配置（上报入口不校验，建议配一个）';
        const 官方密钥提示 = 配置 && 配置.has_official_secret
          ? '已保存 ' + 配置.official_secret_masked + '（留空不修改）'
          : '未保存（在 q.qq.com 机器人「开发设置」里生成）';
        const 状态条 = 官方状态
          ? h('div', { key: 'st', style: { ...小字, color: 状态色(官方状态), marginBottom: 8 } },
            状态说明(官方状态)
            + (官方状态.bot_id ? ' · 机器人 ID ' + 官方状态.bot_id : '')
            + (官方状态.sandbox ? ' · 沙箱环境' : '')
            + (官方状态.heartbeat_interval ? ' · 心跳 ' + 官方状态.heartbeat_interval + 'ms' : '')
            + (官方状态.reconnects ? ' · 已重连 ' + 官方状态.reconnects + ' 次' : ''))
          : h('div', { key: 'st', style: { ...小字, marginBottom: 8 } }, '状态：未查询');

        const 官方入站 = (收件.消息 || []).filter((m) => m && m.来源通道 === 'official').slice(-30).reverse();

        return h('div', { style: { padding: '14px 16px', height: '100%', overflow: 'auto', color: 'inherit', background: 'transparent' } }, [
          h('div', { key: 'hd', style: { ...卡样式, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('div', { key: 'l' }, [
              h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, '深鲸 QQ 桥接'),
              h('div', { key: 's', style: 小字 }, 'QQ 官方机器人 / OneBot v11 二选一 · 发消息 / 收入站 / 全量审计 · v0.3 自动回复（关键词+模板，默认关）'),
            ]),
            h('div', { key: 'r', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
              忙 ? h('span', { key: 'b', style: 小字 }, 忙) : null,
              h('button', { key: 'rf', style: 按钮(true), onClick: 载入, disabled: !!忙 }, '刷新'),
            ]),
          ]),

          // 通道切换
          h('div', { key: 'mode', style: { ...卡样式, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
            h('span', { key: 'l', style: { ...小字, marginRight: 4 } }, '通道切换'),
            h('button', {
              key: 'o', style: 页签(模式 === 'official'),
              onClick: () => { 设模式('official'); 设错(''); 设提示('已切到官方机器人：填 AppID/AppSecret → 保存 → 连接'); },
            }, 'QQ 官方机器人'),
            h('button', {
              key: 'n', style: 页签(模式 === 'onebot'),
              onClick: () => { 设模式('onebot'); 设错(''); 设提示('已切到 OneBot v11：点「保存配置」生效'); },
            }, 'OneBot v11（本机框架）'),
            h('span', { key: 'hint', style: 小字 },
              '当前生效通道：' + (配置 && 配置.mode === 'official' ? '官方机器人' : 'OneBot v11') + '（在对应区域点保存后生效）'),
          ]),

          提示 ? h('div', { key: 'ok', style: { ...卡样式, borderColor: 好, color: 好 } }, 提示) : null,
          错 ? h('div', { key: 'e', style: { ...卡样式, borderColor: V.差, color: V.差, whiteSpace: 'pre-wrap' } }, 错) : null,

          // ── 官方机器人 ──
          模式 === 'official' ? h('div', { key: 'official', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...正字, fontWeight: 600, marginBottom: 4 } }, 'QQ 官方机器人（QQ 开放平台 WebSocket）'),
            h('div', { key: 'd', style: { ...小字, marginBottom: 8 } },
              '不需要本机 OneBot 框架：AppID + AppSecret 直接从 q.qq.com 走官方 WebSocket。'
              + 'AppSecret 只存在本机 ~/.dsh/qq-bridge.json（0600），面板/接口只回掩码。'),
            状态条,
            h('div', { key: 'a1', style: { ...小字, marginBottom: 4 } }, 'AppID'),
            h('input', {
              key: 'appid', value: 官方APPID, onChange: (e) => 设官方APPID(e.target.value),
              placeholder: '机器人 AppID（纯数字，q.qq.com 开发设置可见）', style: { ...输入, marginBottom: 8 }, autoComplete: 'off',
            }),
            h('div', { key: 'a2', style: { ...小字, marginBottom: 4 } }, 'AppSecret · ' + 官方密钥提示),
            h('input', {
              key: 'secret', type: 'password', value: 官方密钥, onChange: (e) => 设官方密钥(e.target.value),
              placeholder: '留空 = 不修改', style: { ...输入, marginBottom: 8 }, autoComplete: 'off',
            }),
            h('div', { key: 'chk', style: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8, ...小字 } }, [
              h('label', { key: 'sb', style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } }, [
                h('input', { key: 'i', type: 'checkbox', checked: !!沙箱, onChange: (e) => 设沙箱(!!e.target.checked) }),
                '沙箱环境',
              ]),
              h('label', { key: 'ac', style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' } }, [
                h('input', { key: 'i', type: 'checkbox', checked: !!自动连, onChange: (e) => 设自动连(!!e.target.checked) }),
                '随 DSH 启动自动连接',
              ]),
            ]),
            h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              h('button', { key: 'sv', style: 按钮(true), onClick: 保存官方, disabled: !!忙 }, '保存配置'),
              h('button', { key: 'cn', style: 按钮(false), onClick: 连接官方, disabled: !!忙 }, '连接'),
              h('button', { key: 'dc', style: 按钮(false), onClick: 断开官方, disabled: !!忙 }, '断开'),
              h('button', { key: 'rf', style: 按钮(false), onClick: 刷新官方状态, disabled: !!忙 }, '刷新状态'),
              配置 && 配置.has_official_secret
                ? h('button', { key: 'cl', style: 按钮(false), onClick: 清除官方密钥, disabled: !!忙 }, '清除 AppSecret')
                : null,
            ]),
            h('div', { key: 'warn', style: { ...小字, color: 警, marginTop: 8 } },
              '官方机器人只能收到「@它」的群消息和私聊；主动发消息有配额限制，被动回复请带 msg_id。'),
          ]) : null,

          // ── 官方发送区 ──
          模式 === 'official' ? h('div', { key: 'osend', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...小字, marginBottom: 6 } }, '发送（官方通道）· 先连接成功；正文 ≤4000'),
            h('div', { key: 'row', style: { display: 'flex', gap: 8, marginBottom: 8 } }, [
              h('select', {
                key: 'ch', value: 官方目标类型, onChange: (e) => 设官方目标类型(e.target.value), style: { ...输入, width: 120 },
              }, [
                h('option', { key: 'c', value: 'c2c' }, '私聊 c2c'),
                h('option', { key: 'g', value: 'group' }, '群 group'),
                h('option', { key: 'h', value: 'channel' }, '频道 channel'),
                h('option', { key: 'd', value: 'dm' }, '频道私信 dm'),
              ]),
              h('input', {
                key: 'tg', value: 官方目标, onChange: (e) => 设官方目标(e.target.value),
                placeholder: 目标字段名(官方目标类型) + '（可从下方入站消息点「回复」带入）',
                style: 输入,
              }),
            ]),
            h('div', { key: 'row2', style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } }, [
              h('input', {
                key: 'mid', value: 官方回复号, onChange: (e) => 设官方回复号(e.target.value),
                placeholder: 'msg_id（被动回复时自动填；主动消息留空）', style: { ...输入, flex: 1, minWidth: 260 },
              }),
              h('button', { key: 'last', style: { ...按钮(false), flex: '0 0 auto', whiteSpace: 'nowrap' }, onClick: 回复最近, disabled: !!忙 },
                '带入最近一条'),
            ]),
            h('textarea', {
              key: 'tx', value: 官方正文, onChange: (e) => 设官方正文(e.target.value), rows: 3,
              placeholder: '消息正文（≤4000 字符）',
              style: { ...输入, resize: 'vertical', minHeight: 60, marginBottom: 8 },
            }),
            h('button', {
              key: 'sd', style: 按钮(true), onClick: 发送官方,
              disabled: !!忙 || !String(官方目标).trim() || !String(官方正文).trim(),
            }, '发送'),
          ]) : null,

          // ── 自动回复（v0.3） ──
          模式 === 'official' ? h('div', { key: 'auto', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...正字, fontWeight: 600, marginBottom: 4 } }, '自动回复（关键词 + 模板）'),
            h('div', { key: 'd', style: 小字 },
              '收到私聊（开了「全部」还含群 @）消息后，先入队、再立刻用原消息 msg_id 被动回复 —— 平台窗口 5 分钟，'
              + '本地超过 4.5 分钟就不发。默认关闭，随时可关。'),
            h('label', { key: 'sw', style: { display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0', ...小字, cursor: 'pointer' } }, [
              h('input', { key: 'i', type: 'checkbox', checked: !!自动开关, onChange: (e) => 设自动开关(!!e.target.checked) }),
              '开启自动回复',
            ]),
            h('div', { key: 't1', style: { ...小字, marginBottom: 4 } }, '默认模板（没命中关键词时用；支持 {昵称} {内容} {时间}）'),
            h('textarea', {
              key: 'tpl', value: 回复模板, onChange: (e) => 设回复模板(e.target.value), rows: 2,
              placeholder: '收到～我是深鲸机器人，稍后回复你。',
              style: { ...输入, resize: 'vertical', minHeight: 48, marginBottom: 8 },
            }),
            h('div', { key: 't2', style: { ...小字, marginBottom: 4 } }, '关键词规则（每行：关键词1,关键词2=回复文本；可加「精确:」/「正则:」前缀，按行顺序命中第一条）'),
            h('textarea', {
              key: 'rules', value: 规则文本, onChange: (e) => 设规则文本(e.target.value), rows: 4,
              placeholder: '价格,多少钱=价格表发你了\n精确:你好=你好呀\n正则:^订单\d+$=这就查订单',
              style: { ...输入, resize: 'vertical', minHeight: 80, marginBottom: 8 },
            }),
            h('div', { key: 'row', style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } }, [
              h('select', { key: 'scope', value: 回复范围, onChange: (e) => 设回复范围(e.target.value), style: { ...输入, width: 170 } }, [
                h('option', { key: 'c', value: 'c2c' }, '只回私聊'),
                h('option', { key: 'a', value: 'all' }, '私聊 + 群 @'),
              ]),
              h('input', {
                key: 'iv', type: 'number', min: 0, max: 3600, value: 最小间隔秒,
                onChange: (e) => 设最小间隔秒(e.target.value), placeholder: '同会话最小间隔（秒）',
                style: { ...输入, width: 180 },
              }),
              h('input', {
                key: 'cap', type: 'number', min: 0, max: 10000, value: 每小时上限,
                onChange: (e) => 设每小时上限(e.target.value), placeholder: '每小时上限',
                style: { ...输入, width: 140 },
              }),
            ]),
            h('div', { key: 'stat', style: { ...小字, marginBottom: 8, color: 回复统计 && 回复统计.暂停 ? V.差 : 'inherit' } },
              回复统计
                ? ('今日已自动回复 ' + (回复统计.今日次数 || 0) + ' 次 · 本小时 ' + (回复统计.小时次数 || 0) + '/' + (回复统计.每小时上限 || 0)
                  + ' · 连续失败 ' + (回复统计.连续失败 || 0)
                  + (回复统计.暂停
                    ? ' · 已暂停：' + (回复统计.暂停原因 || '连续失败')
                    : (回复统计.上次回复 ? ' · 上次 ' + String(回复统计.上次回复).slice(11, 19) : ' · 还没自动回过')))
                : '统计未加载（点刷新）'),
            h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              h('button', { key: 'sv', style: 按钮(true), onClick: 保存自动回复, disabled: !!忙 }, '保存并生效'),
              h('button', { key: 'rs', style: 按钮(false), onClick: 恢复自动回复按钮, disabled: !!忙 }, '恢复自动回复'),
            ]),
            h('div', { key: 'warn', style: { ...小字, color: 警, marginTop: 8 } },
              '只做关键词/模板回复，不冒充人工；群消息只有被 @ 才会收到；连续 3 次发送失败会自动暂停，点「恢复自动回复」解除。'),
          ]) : null,

          // ── OneBot ──
          模式 === 'onebot' ? h('div', { key: 'help', style: 卡样式 }, [
            h('div', { key: 't', style: { ...正字, fontWeight: 600, marginBottom: 4 } }, '第一次用？QQ 登录不在这个面板里'),
            h('div', { key: 'b', style: 小字 },
              '本面板只负责「和 OneBot 说话」。要真正收发 QQ，先在 Mac 上装一个 OneBot v11 框架（例如 Lagrange.OneBot 或 NapCatQQ）：'
              + '① 在框架里登录 QQ（扫码/密码都行，用一个小号）；② 启动后它会监听 http://127.0.0.1:3000；'
              + '③ 回到这里填端点 → 保存配置 → 连接测试。收上报则把框架的事件上报地址指向 /dsh-qq-bridge/api/hook。'),
            h('div', { key: 'w', style: { ...小字, color: V.差, marginTop: 4 } },
              '如果你还没装任何框架，这里点「连接测试」必然失败（端口没人监听），不是插件坏了。也可以用上面的「QQ 官方机器人」通道，不需要本机框架。'),
          ]) : null,

          模式 === 'onebot' ? h('div', { key: 'cfg', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...小字, marginBottom: 6 } }, 'OneBot v11 HTTP API 端点（本机例：http://127.0.0.1:3000）'),
            h('input', { key: 'ep', value: 端点, onChange: (e) => 设端点(e.target.value), placeholder: 'http://127.0.0.1:3000', style: { ...输入, marginBottom: 8 } }),
            h('div', { key: 'h2', style: { ...小字, marginBottom: 4 } }, 'access_token · ' + 令牌提示),
            h('input', { key: 'tk', type: 'password', value: 令牌, onChange: (e) => 设令牌(e.target.value), placeholder: '留空 = 不修改', style: { ...输入, marginBottom: 8 }, autoComplete: 'off' }),
            h('div', { key: 'h3', style: { ...小字, marginBottom: 4 } }, '上报共享密钥（hook_secret）· ' + 密钥提示),
            h('input', { key: 'sk', type: 'password', value: 密钥, onChange: (e) => 设密钥(e.target.value), placeholder: '留空 = 不修改；用于校验 X-Signature', style: { ...输入, marginBottom: 8 }, autoComplete: 'off' }),
            h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
              h('button', { key: 'sv', style: 按钮(true), onClick: 保存, disabled: !!忙 }, '保存配置'),
              h('button', { key: 'ts', style: 按钮(false), onClick: 测试, disabled: !!忙 }, '连接测试'),
              配置 && 配置.has_token ? h('button', { key: 'cl', style: 按钮(false), onClick: 清令牌, disabled: !!忙 }, '清除 token') : null,
            ]),
          ]) : null,

          模式 === 'onebot' ? h('div', { key: 'send', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...小字, marginBottom: 6 } }, '发送消息（先保存配置；失败原因原样回报并写审计）'),
            h('div', { key: 'row', style: { display: 'flex', gap: 8, marginBottom: 8 } }, [
              h('select', { key: 'tt', value: 目标类型, onChange: (e) => 设目标类型(e.target.value), style: { ...输入, width: 110 } }, [
                h('option', { key: 'p', value: 'private' }, '私聊'),
                h('option', { key: 'g', value: 'group' }, '群聊'),
              ]),
              h('input', { key: 'tg', value: 目标, onChange: (e) => 设目标(e.target.value), placeholder: 目标类型 === 'group' ? '群号' : 'QQ 号', style: 输入 }),
            ]),
            h('textarea', {
              key: 'tx', value: 正文, onChange: (e) => 设正文(e.target.value), rows: 3,
              placeholder: '消息正文（≤4000 字符）',
              style: { ...输入, resize: 'vertical', minHeight: 60, marginBottom: 8 },
            }),
            h('button', { key: 'sd', style: 按钮(true), onClick: 发送, disabled: !!忙 || !目标.trim() || !正文.trim() }, '发送'),
          ]) : null,

          // ── 入站（两条通道共用队列） ──
          h('div', { key: 'inbox', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...小字, marginBottom: 6 } },
              '入站消息（最近 ' + (收件.消息 ? 收件.消息.length : 0) + ' 条 / 共 ' + (收件.总数 || 0) + ' 条，上限 ' + (收件.上限 || 1000) + '）'),
            ...(收件.消息 && 收件.消息.length
              ? 收件.消息.slice().reverse().map((m, i) => {
                const 是官方 = m.来源通道 === 'official';
                const 位 = 是官方
                  ? (m.会话类型 === 'group' ? '群 ' + 尾号(m.group_openid) : (m.会话类型 === 'c2c' ? '私聊 ' + 尾号(m.openid) : (m.会话类型 === 'channel' ? '频道 ' + 尾号(m.channel_id) : '私信 ' + 尾号(m.guild_id))))
                  : (m.message_type === 'group' ? '群 ' + m.group_id + ' / ' + (m.昵称 || m.user_id) : '私聊 ' + m.user_id);
                const 谁 = 是官方 ? (m.昵称 ? m.昵称 + ' · ' + 会话名(m.会话类型) : 会话名(m.会话类型)) : '';
                return h('div', { key: i, style: { ...小字, padding: '4px 0', borderTop: i ? '1px solid ' + V.边 : 'none' } }, [
                  h('div', { key: 'a', style: { ...等宽, display: 'flex', alignItems: 'center', flexWrap: 'wrap' } }, [
                    h('span', { key: 't' }, String(m.时刻 || '').replace('T', ' ').slice(0, 19) + ' · ' + (是官方 ? ('[官方] ' + m.事件类型) : ((m.post_type || '?') + (m.原始类型 ? ':' + m.原始类型 : '')))),
                    是官方 && m.msg_id ? h('button', { key: 'rp', style: 小按钮(), onClick: () => 回复某条(m) }, '回复') : null,
                  ]),
                  h('div', { key: 'b', style: { opacity: 0.9 } },
                    (是官方 ? 位 + '：' : 位 + '：') + String(m.文本 || '（非文本）').slice(0, 160)),
                ]);
              })
              : [h('div', { key: 'none', style: 小字 },
                '还没有收到入站消息。官方机器人连接成功后会自动入队；OneBot 需把上报地址指向 /dsh-qq-bridge/api/hook。')]),
          ]),

          h('div', { key: 'aud', style: 卡样式 }, [
            h('div', { key: 'h', style: { ...小字, marginBottom: 6 } }, '审计记录（最近 ' + 审计.length + ' 条；token / AppSecret 已脱敏）'),
            ...(审计.length
              ? 审计.slice().reverse().map((r, i) => h('div', { key: i, style: { ...小字, padding: '3px 0', borderTop: i ? '1px solid ' + V.边 : 'none' } },
                String(r.时刻 || '').slice(11, 19) + ' · ' + (r.动作 || '?') + ' · ' + (r.结果 || '?') +
                (r.通道 || r.来源 ? ' [' + (r.通道 || r.来源) + ']' : '') +
                (r.会话类型 ? ' ' + r.会话类型 : '') +
                (r.目标 ? ' → ' + r.目标 : '') +
                (r.错误 ? '（' + r.错误 + '）' : '') +
                (r.内容 ? ' · ' + String(r.内容).slice(0, 50) : '')))
              : [h('div', { key: 'none', style: 小字 }, '暂无审计')]),
          ]),

          h('div', { key: 'tip', style: 小字 },
            '安全边界：AppSecret / access_token 只存本机 ~/.dsh/qq-bridge.json（0600），面板与接口只回掩码；'
            + '官方通道只连 bots.qq.com / api.sgroup.qq.com（沙箱为 sandbox.api.sgroup.qq.com）；OneBot 只连你填的 http(s) 端点；'
            + '请求 10s 超时；审计递归脱敏；本插件不向任何第三方服务外发数据。'),
          h('div', { key: 'badge', style: { display: 'flex', justifyContent: 'flex-end' } }, [h('a', { key: 'a', href: 'https://deepwhale.org.cn', target: '_blank', rel: 'noopener', style: { display: 'inline-block', marginTop: 10 } },
            h('img', { src: API + '/badge', alt: 'powered by dwh', style: { height: '20px', width: '121px', display: 'block' } }))]),
        ]);
      }

      function 图标({ size = 18, active }) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: active ? 2 : 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, [
          h('path', { key: 'a', d: 'M21 11.4c0 4.2-4 7.6-9 7.6-1 0-2-.14-2.9-.4L4 20l1.3-3.3C4.2 15.4 3 13.6 3 11.4 3 7.2 7 3.8 12 3.8s9 3.4 9 7.6z' }),
          h('path', { key: 'b', d: 'M8.4 10.6h.01M12 10.6h.01M15.6 10.6h.01' }),
        ]);
      }

      function 安全面板(props) { return h(错误边界, null, h(面板, props)); }

      const inject = ['slots'];
      function apply(ctx) {
        try {
          if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
            try { console.warn('[QQ桥接] 宿主没有 slots 服务，跳过面板注册'); } catch { /* ignore */ }
            return;
          }
          ctx.slots.inject(SLOT_MAIN, function* () {
            try { yield ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, 安全面板); }
            catch (e) { try { console.warn('[QQ桥接] 主面板注册失败（已跳过）：', e && e.message ? e.message : e); } catch { /* ignore */ } }
          });
          ctx.slots.inject(SLOT_ICON, function* () {
            try { yield ctx.slots.register({ name: SLOT_ICON, id: PANEL_ID, order: 31, label: '深鲸 QQ 桥接' }, 图标); }
            catch (e) { try { console.warn('[QQ桥接] 侧栏图标注册失败（已跳过）：', e && e.message ? e.message : e); } catch { /* ignore */ } }
          });
        } catch (e) {
          try { console.warn('[QQ桥接] apply 出错，已整体跳过：', e && e.message ? e.message : e); } catch { /* ignore */ }
        }
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    } catch (e) {
      try { console.warn('[QQ桥接] 客户层加载失败，已降级为空插件：', e && e.message ? e.message : e); } catch { /* ignore */ }
      return { inject: [], apply() { /* 降级空实现 */ } };
    }
  },
});
