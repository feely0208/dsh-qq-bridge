#!/usr/bin/env node
/**
 * 客户端插件 bundle 预检（2026-10-27 事故后新增）
 *
 * 为什么必须有：宿主 web 启动时，**任何一个客户端插件 entry 激活失败**
 * 都会抛 `web boot: N entries did not activate` → 整页显 "Failed to load plugins"，
 * 用户看到的就是白屏（辉光背景 + 空白）。2026-10-15 与随后的「深鲸记忆 0.5.8」
 * 都是这一类。判据必须在**发布前**跑，而不是等用户看到白屏。
 *
 * 它模拟宿主做四件事，任何一步抛错即失败（退出码 1）：
 *   ① 用假的 __ModuleLoader__ 捕获模块，校验 factory 返回插件对象
 *   ② 假 require('react')，用最小 createElement/useState/useEffect 驱动
 *   ③ 假 ctx.slots：inject 立即驱动 generator；register 校验 name/id/key
 *   ④ 把注册到的每个组件渲染一遍（同步 createElement），抓渲染期抛错
 *
 * 用法：node check-client-bundle.mjs <插件目录> [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const dir = process.argv[2];
if (!dir) { console.error('用法: node check-client-bundle.mjs <插件目录>'); process.exit(2); }
const verbose = process.argv.includes('--verbose');
const file = join(dir, 'lib', 'client.js');
if (!existsSync(file)) { console.error('× 没有 lib/client.js：' + file); process.exit(1); }

const problems = [];
const notes = [];
const fail = (m) => { problems.push(m); };

let loaded = null;
const sandbox = {
  window: { __ModuleLoader__: { load(o) { loaded = o; } } },
  document: {
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, classList: { add() {} } }),
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    documentElement: { dataset: {} },
    body: { appendChild() {} },
  },
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  fetch: async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }),
  location: { href: 'http://127.0.0.1/', reload() {} },
  navigator: { userAgent: 'preflight' },
  URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Event,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
} catch (e) { fail('模块顶层执行抛错：' + (e && e.message || e)); }

if (!loaded) fail('没有调用 window.__ModuleLoader__.load —— 宿主会当作无效 bundle');
if (loaded && !loaded.id) fail('load() 缺少 id');
if (loaded && typeof loaded.factory !== 'function') fail('load() 缺少 factory');

let mod = null;
const 额外依赖 = new Set();
const 空桩 = () => new Proxy(function () {}, {
  get(_t, k) { if (k === 'then') return undefined; if (k === Symbol.toPrimitive) return () => ''; return 空桩(); },
  apply() { return undefined; }, construct() { return {}; },
});
const 空模块桩 = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : 空模块桩()), apply() { return {}; }, construct() { return {}; } });
if (loaded && typeof loaded.factory === 'function') {
  class Component { constructor(p) { this.props = p || {}; this.state = {}; } setState() {} forceUpdate() {} }
  const react = {
    Component, PureComponent: Component,
    Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : c ? [f(c)] : []), toArray: (c) => (Array.isArray(c) ? c : c ? [c] : []), only: (c) => c },
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (v) => [v, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
    useCallback: (f) => f, useContext: () => ({}), createContext: (v) => ({ _v: v, Provider: 'P', Consumer: 'C' }),
    memo: (c) => c, forwardRef: (c) => c, startTransition: (f) => f(), useId: () => 'preflight-id', useDeferredValue: (v) => v, useTransition: () => [false, (f) => f()], useSyncExternalStore: (s, g) => g(),
  };
  try {
    mod = loaded.factory((name) => {
      if (name === 'react') return react;
      额外依赖.add(String(name));
      return new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : 空模块桩()), apply() { return {}; }, construct() { return {}; } });
    });
  } catch (e) { fail('factory() 抛错：' + (e && e.message || e)); }
  if (!mod || typeof mod !== 'object') fail('factory 没有返回插件对象（返回 undefined 会让宿主报 invalid plugin）');
  if (mod && typeof mod.apply !== 'function') fail('插件对象没有 apply()');
}

const registered = [];
if (mod && typeof mod.apply === 'function') {
  const baseCtx = {
    slots: {
      inject(name, gen) {
        if (typeof name !== 'string' || name === '') throw new Error('slots.inject: 空槽位名');
        const g = typeof gen === 'function' ? gen() : undefined;
        if (g && typeof g.next === 'function') {           // 立即把 generator 驱动一遍（宿主也是这样激活）
          let r = g.next();
          if (r.done === false && r.value === undefined) throw new Error('slots.inject: generator 没有 yield');
        }
      },
      register(cfg, comp) {
        if (!cfg || typeof cfg !== 'object') throw new Error('slots.register: 配置缺失');
        if (typeof cfg.name !== 'string' || cfg.name === '') throw new Error('slots.register: 缺少 name');
        if (!cfg.id && !cfg.key) throw new Error('slots.register: 缺少 id/key');
        if (typeof comp !== 'function' && (typeof comp !== 'object' || comp === null)) throw new Error('slots.register: 组件不是函数/对象');
        registered.push({ cfg, comp });
        return {};
      },
    },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined; },
    logger: { info() {}, warn() {}, error() {} },
    commands: { register() {} },
    webServer: { register() { return () => {}; } },
    skills: { register() {} },
    locale: { register() {}, get() { return (k) => k; }, t: (k) => k },
    shortcuts: { register() {} },
    storage: { get() { return undefined; }, set() {}, delete() {} },
    config: { get() { return undefined; }, set() {} },
    events: { on() { return () => {}; }, emit() {} },
    sessions: { get() { return undefined; }, list() { return []; } },
    commands: { register() {} },
    theme: { get() { return {}; }, on() { return () => {}; } },
  };
  // 未模拟的服务一律给「可调用、可取值」的空实现，避免把「我们没 mock」误判成「插件会白屏」；
  // 真正的插件自身异常（apply 抛错 / factory 返回 undefined / 渲染抛错）仍然会被抓到。
  const ctx = new Proxy(baseCtx, {
    get(t, k) { return k in t ? t[k] : 空桩(); },
  });
  try { mod.apply(ctx); } catch (e) { fail('apply() 抛错（会直接让整页 Failed to load plugins）：' + (e && e.message || e)); }
  // 插件若导出 inject 依赖，宿主会先等这些服务；这里只提示不判失败
  if (Array.isArray(mod.inject)) notes.push('inject 依赖: ' + mod.inject.join(', '));
}

for (const { cfg, comp } of registered) {
  if (typeof comp !== 'function') continue;
  try {
    // 宿主会把 hooks/服务作为 props 注入组件（如 useSessions）；未知 prop 给可调用空桩，
    // 避免把「宿主注入的服务」误判成插件缺陷。
    const 道具桩 = new Proxy({ size: 18, active: true, sessionId: 'preflight' }, {
      get(t, k) { return k in t ? t[k] : 空桩(); },
    });
    comp(道具桩);
    comp(道具桩);
  } catch (e) {
    const where = cfg.name + ':' + (cfg.id || cfg.key);
    if (额外依赖.size > 0) {
      notes.push('组件渲染依赖宿主 client 包（' + [...额外依赖].join(', ') + '），离线无法完全验证：' + where);
    } else {
      fail('组件渲染抛错（' + where + '）：' + (e && e.message || e));
    }
  }
}

console.log((problems.length ? '× ' : '✓ ') + dir);
for (const n of notes) if (verbose) console.log('  · ' + n);
console.log('  槽位: ' + (registered.map((r) => r.cfg.name + ':' + (r.cfg.id || r.cfg.key)).join(', ') || '（无）'));
for (const p of problems) console.log('  × ' + p);
process.exit(problems.length ? 1 : 0);
