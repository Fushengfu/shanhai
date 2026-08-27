// src/main/index.ts
import { app as app8, Tray, Menu as Menu2, globalShortcut, nativeImage } from "electron";

// ../../packages/kernel/src/runtime/dispose.ts
var DisposerStack = class {
  disposers = [];
  /** 收集一个 effect 返回体 */
  collect(effect) {
    collectEffect(effect, (d) => this.disposers.push(d));
  }
  /** 逆序撤销全部 disposer（单个失败不阻断其余） */
  async dispose() {
    const disposers = this.disposers.splice(0).reverse();
    for (const disposer of disposers) {
      try {
        await disposer();
      } catch (err) {
        console.error("[kernel] disposer failed:", err);
      }
    }
  }
};
function collectEffect(effect, onDisposable) {
  if (typeof effect === "function") {
    onDisposable(effect);
    return;
  }
  if (effect == null) {
    return;
  }
  if (Symbol.asyncIterator in effect) {
    void (async () => {
      for await (const d of effect) {
        if (d) onDisposable(d);
      }
    })();
    return;
  }
  if (Symbol.iterator in effect) {
    for (const d of effect) {
      if (d) onDisposable(d);
    }
    return;
  }
  void Promise.resolve(effect).then((d) => {
    if (d) onDisposable(d);
  });
}

// ../../packages/kernel/src/runtime/fiber.ts
var uidCounter = 0;
var Fiber = class {
  uid = ++uidCounter;
  state = "PENDING";
  config;
  /** 注入服务的实现快照（加载完成后由 ServiceStore 填充） */
  store;
  disposers = new DisposerStack();
  setupTask = Promise.resolve();
  _apply;
  _meta;
  constructor(apply, config, meta = {}) {
    this._apply = apply;
    this.config = config;
    this._meta = meta;
  }
  get name() {
    return this._meta.name;
  }
  get inject() {
    return this._meta.inject;
  }
  get provide() {
    return this._meta.provide;
  }
  /** PromiseLike：等待 setup settle，resolve 为 disposeAsync（撤销函数），避免 thenable 自引用 */
  then(onFulfilled, onRejected) {
    return Promise.resolve(this.setupTask).then(() => this.disposeAsync).then(onFulfilled, onRejected);
  }
  /**
   * 注册副作用：execute 立即执行，返回的 disposer 逆序撤销。
   * 返回一个「只撤销本 effect」的 disposer（fiber 卸载时会整体撤销）。
   */
  effect(execute, label) {
    void label;
    const collected = [];
    collectEffect(execute(), (d) => collected.push(d));
    for (const d of collected) {
      this.disposers.collect(d);
    }
    return async () => {
      for (const d of collected.reverse()) {
        await d();
      }
    };
  }
  /** 加载：执行 apply，六态转换。失败置 FAILED 并抛错（响亮失败）。 */
  async load(ctx) {
    if (this.state === "DISPOSED" || this.state === "LOADING") return;
    this.state = "LOADING";
    this.setupTask = (async () => {
      try {
        await this._apply?.(ctx, this.config);
        this.state = "ACTIVE";
      } catch (err) {
        this.state = "FAILED";
        throw err;
      }
    })();
    this.setupTask.catch(() => void 0);
    await this.setupTask;
  }
  /** 撤销函数：逆序撤销全部副作用，置 DISPOSED */
  disposeAsync = async () => {
    if (this.state === "DISPOSED") return;
    this.state = "UNLOADING";
    await this.disposers.dispose();
    this.state = "DISPOSED";
  };
  /** 卸载：等待 cleanup 完成 */
  async dispose() {
    await this.disposeAsync();
  }
  /** 卸载后立即用当前配置重载 */
  async restart(ctx) {
    await this.dispose();
    this.state = "PENDING";
    await this.load(ctx);
  }
  /** 等待当前 setup settle（启动错误会 reject） */
  await() {
    return this.setupTask;
  }
};

// ../../packages/kernel/src/runtime/event.ts
var Events = class {
  listeners = /* @__PURE__ */ new Map();
  on(name, listener, options = {}) {
    const entry = { listener, options };
    const list = this.listeners.get(name) ?? [];
    list.push(entry);
    this.listeners.set(name, list);
    return () => {
      const arr = this.listeners.get(name);
      if (!arr) return false;
      const idx = arr.indexOf(entry);
      if (idx >= 0) {
        arr.splice(idx, 1);
        return true;
      }
      return false;
    };
  }
  get(name) {
    return (this.listeners.get(name) ?? []).map((e) => e.listener);
  }
  emit(name, ...args) {
    for (const listener of this.get(name)) {
      listener(...args);
    }
  }
  async parallel(name, ...args) {
    await Promise.all(this.get(name).map((l) => Promise.resolve(l(...args))));
  }
  async serial(name, ...args) {
    for (const listener of this.get(name)) {
      const result = await listener(...args);
      if (result !== void 0 && result !== false) return result;
    }
    return void 0;
  }
  bail(name, ...args) {
    for (const listener of this.get(name)) {
      const result = listener(...args);
      if (result !== void 0 && result !== false) return result;
    }
    return void 0;
  }
  waterfall(name, ...args) {
    const listeners2 = this.get(name);
    const next = (i) => {
      const listener = listeners2[i];
      if (!listener) return void 0;
      return listener(...args, () => next(i + 1));
    };
    return next(0);
  }
};

// ../../packages/kernel/src/runtime/context.ts
var Context = class {
  root;
  fiber;
  parent;
  services = /* @__PURE__ */ new Map();
  events;
  isolates = /* @__PURE__ */ new Map();
  fibers = [];
  caps = null;
  constructor(parent, meta = {}) {
    this.parent = parent ?? null;
    this.root = parent?.root ?? this;
    this.fiber = meta.fiber ?? null;
    this.events = parent?.events ?? new Events();
  }
  /** 服务解析：先查自身，再沿父链，最后查隔离作用域。越界消费（consume 未声明）抛错 */
  getService(name) {
    if (this.caps?.consume && !this.caps.consume.includes(name)) {
      throw new Error(`capability denied: cannot consume "${name}"`);
    }
    if (this.services.has(name)) return this.services.get(name);
    const isolated = this.lookupIsolate(name);
    if (isolated !== void 0) return isolated;
    return this.parent?.getService(name);
  }
  /** 注册服务（Service 构造时自动调用）。越界提供（provide 未声明）抛错 */
  provide(name, impl, _check) {
    if (this.caps?.provide && !this.caps.provide.includes(name)) {
      throw new Error(`capability denied: cannot provide "${name}"`);
    }
    this.services.set(name, impl);
  }
  /** 能力清单（least privilege）：创建带能力约束的子上下文，越界即抛错 */
  guard(caps) {
    const child = this.extend();
    child.caps = caps;
    return child;
  }
  /** 创建继承父服务的子上下文 */
  extend(meta = {}) {
    return createContext(this, meta);
  }
  /** 作用域隔离：同名服务在不同 label 下解析到不同实现 */
  isolate(name, label) {
    const key = label ?? Symbol(name);
    if (!this.isolates.has(name)) this.isolates.set(name, /* @__PURE__ */ new Map());
    this.isolates.get(name).set(key, void 0);
    const child = this.extend();
    child.setIsolate(name, key);
    return child;
  }
  setIsolate(name, key) {
    if (!this.isolates.has(name)) this.isolates.set(name, /* @__PURE__ */ new Map());
    this.isolates.get(name).set(key, void 0);
  }
  lookupIsolate(name) {
    const map = this.isolates.get(name);
    if (!map) return void 0;
    for (const value of map.values()) {
      if (value !== void 0) return value;
    }
    return void 0;
  }
  /** 注册插件：解析三种形态，创建 Fiber 并异步加载，返回 Fiber（await 得到 disposeAsync） */
  plugin(plugin, config) {
    const apply = resolvePlugin(plugin);
    const meta = typeof plugin === "object" && plugin !== null ? plugin : {};
    const fiber = new Fiber(apply, config ?? {}, {
      name: meta.name,
      inject: meta.inject,
      provide: meta.provide
    });
    this.fibers.push(fiber);
    const child = this.extend({ fiber });
    void fiber.load(child).catch(() => void 0);
    return fiber;
  }
  /** 依赖注入简写：ctx.inject(deps, callback) = ctx.plugin({ inject: deps, apply: callback }) */
  inject(deps, callback) {
    const inject = Array.isArray(deps) ? deps : Object.keys(deps);
    return this.plugin({
      inject,
      apply: callback
    });
  }
  /** 注册事件监听：挂到所属 fiber（fiber 卸载自动撤销） */
  on(name, listener, options) {
    const off = this.events.on(name, listener, options);
    this.fiber?.effect(() => () => {
      off();
    });
    return off;
  }
  once(name, listener, options) {
    return this.on(name, listener, { ...options, once: true });
  }
  emit(name, ...args) {
    this.events.emit(name, ...args);
  }
  parallel(name, ...args) {
    return this.events.parallel(name, ...args);
  }
  serial(name, ...args) {
    return this.events.serial(name, ...args);
  }
  bail(name, ...args) {
    return this.events.bail(name, ...args);
  }
  waterfall(name, ...args) {
    return this.events.waterfall(name, ...args);
  }
  /** 注册副作用：挂到所属 fiber（无 fiber 则立即执行、无撤销） */
  effect(execute) {
    if (this.fiber) return this.fiber.effect(execute);
    const collected = [];
    void collected;
    return () => void 0;
  }
  /** 卸载本上下文创建的全部 fiber（逆序） */
  async dispose() {
    for (const fiber of this.fibers.slice().reverse()) {
      await fiber.dispose();
    }
    this.fibers.length = 0;
  }
};
function createContext(parent, meta) {
  const ctx = new Context(parent, meta);
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== void 0) return value;
      if (typeof prop === "symbol") return void 0;
      return target.getService(prop);
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    }
  });
}
function resolvePlugin(plugin) {
  if (typeof plugin === "function") {
    if (isConstructor(plugin)) {
      return (ctx, config) => new plugin(ctx, config);
    }
    return (ctx, config) => plugin(ctx, config);
  }
  return (ctx, config) => plugin.apply(ctx, config);
}
function isConstructor(fn) {
  const proto = fn.prototype;
  return !!proto && Object.getOwnPropertyNames(proto).length > 0;
}

// ../../packages/kernel/src/runtime/kernel.ts
var Kernel = class {
  ctx;
  constructor() {
    this.ctx = createContext();
  }
  /** 挂载插件：返回 Fiber（await 等待 settle，启动错误会 reject） */
  plugin(plugin, config) {
    return this.ctx.plugin(plugin, config);
  }
  /** 依赖注入简写 */
  inject(deps, callback) {
    return this.ctx.inject(deps, callback);
  }
  /** 卸载根上下文全部 fiber（逆序） */
  async dispose() {
    await this.ctx.dispose();
  }
};

// ../../packages/kernel/src/security/signing.ts
import { sign, verify } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
var FileSnapshotStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  async snapshot(path3) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.copyFile(path3, join(this.dir, id));
    return id;
  }
  async rollback(path3, id) {
    const snapshotPath = join(this.dir, id);
    await fs.copyFile(snapshotPath, path3);
  }
  async discard(_path, id) {
    await fs.rm(join(this.dir, id), { force: true });
  }
};

// ../../packages/kernel/src/selfmod/inventory.ts
import { promises as fs2 } from "fs";
import { join as join2, resolve, sep } from "path";
var PluginInventory = class {
  packages = /* @__PURE__ */ new Map();
  counter = 0;
  /** plugin_define：记录 package（语法检查不运行），返回卡片。id 可选（restore 恢复已安装插件时指定稳定 id） */
  define(def) {
    const id = def.id ?? `dyn-${++this.counter}`;
    const pkg = {
      id,
      name: def.name,
      purpose: def.purpose,
      code: def.code,
      client: def.client,
      version: def.version,
      status: "defined",
      sessionId: def.sessionId
    };
    this.packages.set(pkg.id, pkg);
    return pkg;
  }
  get(id) {
    return this.packages.get(id);
  }
  list() {
    return [...this.packages.values()];
  }
  setStatus(id, status) {
    const pkg = this.packages.get(id);
    if (pkg) pkg.status = status;
  }
  /** 变更 id（install 时把临时 dyn-<n> 改成稳定持久化 id） */
  rename(oldId, newId) {
    const pkg = this.packages.get(oldId);
    if (!pkg) throw new Error(`\u52A8\u6001\u5305\u4E0D\u5B58\u5728: ${oldId}`);
    this.packages.delete(oldId);
    pkg.id = newId;
    this.packages.set(newId, pkg);
  }
  /** 变更会话归属（install 后置为全局 '*'） */
  setSession(id, sessionId) {
    const pkg = this.packages.get(id);
    if (pkg) pkg.sessionId = sessionId;
  }
  /** plugin_undefine：停止并遗忘定义 */
  remove(id) {
    this.packages.delete(id);
  }
  /** plugin_inspect：只读报告（services 由上层注入，packages 为动态包列表） */
  inspect(services = []) {
    return {
      services,
      packages: this.list()
    };
  }
};
var PluginStore = class {
  constructor(dir) {
    this.dir = dir;
  }
  dir;
  /** 校验插件 id 合法性并返回其落盘目录（防路径穿越） */
  pkgDir(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`\u975E\u6CD5\u63D2\u4EF6 id\uFF08\u4EC5\u5141\u8BB8\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF/\u8FDE\u5B57\u7B26\uFF09: ${id}`);
    }
    const root = resolve(this.dir);
    const target = resolve(this.dir, id);
    if (target !== join2(root, id) && !target.startsWith(root + sep)) {
      throw new Error(`\u63D2\u4EF6 id \u8D8A\u754C: ${id}`);
    }
    return target;
  }
  /** 安装：落盘 manifest.json（覆盖式，重装即更新） */
  async install(meta) {
    const dir = this.pkgDir(meta.id);
    await fs2.mkdir(dir, { recursive: true });
    await fs2.writeFile(join2(dir, "manifest.json"), JSON.stringify(meta, null, 2), { mode: 384 });
  }
  /** 卸载：删除整个插件目录（不存在的 id 静默成功） */
  async uninstall(id) {
    const dir = this.pkgDir(id);
    await fs2.rm(dir, { recursive: true, force: true });
  }
  /** 读取单个已安装插件的元数据（不存在/损坏返回 undefined） */
  async load(id) {
    const dir = this.pkgDir(id);
    try {
      const raw = await fs2.readFile(join2(dir, "manifest.json"), "utf8");
      const meta = JSON.parse(raw);
      if (typeof meta?.id !== "string" || meta.id !== id) return void 0;
      if (typeof meta?.name !== "string") return void 0;
      return meta;
    } catch {
      return void 0;
    }
  }
  /** 列出所有已安装插件（目录不存在返回空，单个损坏跳过） */
  async list() {
    let entries;
    try {
      entries = await fs2.readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.load(entry.name);
      if (meta) out.push(meta);
    }
    return out;
  }
};

// ../../packages/kernel-modules/dist/client/index.js
var CORE_SLOTS = [
  "shell.sidebar",
  "shell.header",
  "shell.chat",
  "shell.composer",
  "shell.statusbar",
  "shell.welcome",
  "shell.panels",
  "shell.overlays",
  "dynamic-extension",
  // —— 追加型扩展点（核心区块内部预留的追加位）——
  "composer.below",
  "composer.actions",
  "header.actions",
  "chat.below"
];

// ../../packages/selfmod/src/selfmod.ts
import vm from "vm";
function evalHostCode(code) {
  const sandbox = {
    module: { exports: {} },
    exports: {}
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script(code, { filename: "dynamic-package-host.js" });
  script.runInContext(context);
  const factory = sandbox.module.exports;
  if (typeof factory !== "function") {
    throw new Error("host \u534A\u4EE3\u7801\u5FC5\u987B\u5BFC\u51FA\u51FD\u6570\uFF1A(ctx) => disposer");
  }
  return factory;
}
var SelfModifyRuntime = class _SelfModifyRuntime {
  constructor(hooks, store = null) {
    this.hooks = hooks;
    this.store = store;
  }
  hooks;
  store;
  inventory = new PluginInventory();
  services = /* @__PURE__ */ new Map();
  disposers = /* @__PURE__ */ new Map();
  /** plugin_inspect：只读报告（服务 / 工具 / 动态 package / 已安装插件 / UI 插槽表面） */
  inspect(sessionId) {
    const all = this.inventory.list();
    return {
      services: [.../* @__PURE__ */ new Set([...this.hooks.listServices(), ...this.services.keys()])],
      tools: this.hooks.listTools(sessionId),
      packages: all.filter((p) => p.sessionId === sessionId && p.status !== "installed"),
      installed: all.filter((p) => p.status === "installed"),
      slots: this.hooks.listSlots()
    };
  }
  /** plugin_define：记录 package（语法检查不运行），返回卡片 */
  define(def, sessionId) {
    return this.inventory.define({ ...def, sessionId });
  }
  /** plugin_run：vm 评估 host 半 + 投递 browser 半（带 UI 的需人 approve；skipApproval 供 install/restore 复用，免重复审批） */
  async run(id, sessionId, opts = {}) {
    const pkg = this.inventory.get(id);
    if (!pkg) throw new Error(`\u52A8\u6001\u5305\u4E0D\u5B58\u5728: ${id}`);
    if (pkg.sessionId !== sessionId && pkg.sessionId !== "*") {
      throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u5C5E\u4E8E\u5176\u4ED6\u4F1A\u8BDD\uFF0C\u65E0\u6743\u8FD0\u884C`);
    }
    if (pkg.status === "running") throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u5DF2\u5728\u8FD0\u884C`);
    if (!pkg.code && !pkg.client) throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u6CA1\u6709\u53EF\u8FD0\u884C\u7684\u4EE3\u7801`);
    const stack = new DisposerStack();
    if (pkg.code) {
      const factory = evalHostCode(pkg.code);
      const facade = {
        on: (name, listener) => {
          const off = this.hooks.onEvent(name, listener);
          stack.collect(() => {
            off();
          });
        },
        provide: (name, impl) => {
          this.services.set(name, impl);
          stack.collect(() => {
            if (this.services.get(name) === impl) this.services.delete(name);
          });
        },
        tools: {
          register: (tool) => {
            const off = this.hooks.registerTool(tool);
            stack.collect(() => {
              off();
            });
          }
        }
        // 刻意不暴露 effect()：动态 package 的 cleanup 只能走上面三条，杜绝裸副作用
      };
      const ret = await factory(facade);
      stack.collect(ret);
    }
    let clientDelivered = false;
    if (pkg.client) {
      const approved = opts.skipApproval ? true : await this.hooks.requestClientRun(pkg, sessionId);
      if (!approved) {
        await stack.dispose();
        throw new Error(`\u7528\u6237\u62D2\u7EDD\u4E86\u52A8\u6001\u5305 "${pkg.name}" \u7684\u6D4F\u89C8\u5668\u534A\u6295\u9012`);
      }
      await this.hooks.deliverClient(pkg);
      clientDelivered = true;
    }
    this.disposers.set(pkg.id, () => stack.dispose());
    this.inventory.setStatus(pkg.id, "running");
    return { clientDelivered };
  }
  /** plugin_stop：撤回 host 半 + browser 半，定义保留可再跑 */
  async stop(id) {
    const pkg = this.inventory.get(id);
    if (!pkg) throw new Error(`\u52A8\u6001\u5305\u4E0D\u5B58\u5728: ${id}`);
    const disposer = this.disposers.get(id);
    if (disposer) {
      await disposer();
      this.disposers.delete(id);
    }
    await this.hooks.removeClient(id);
    this.inventory.setStatus(id, "stopped");
  }
  /** plugin_undefine：停止并遗忘定义 */
  async undefine(id) {
    await this.stop(id);
    this.inventory.remove(id);
  }
  /** plugin_test：临时运行 + 立即撤回，返回验证结果（不持久化、不影响正式安装） */
  async test(id, sessionId) {
    const pkg = this.inventory.get(id);
    if (!pkg) throw new Error(`\u52A8\u6001\u5305\u4E0D\u5B58\u5728: ${id}`);
    if (pkg.sessionId !== sessionId && pkg.sessionId !== "*") {
      throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u5C5E\u4E8E\u5176\u4ED6\u4F1A\u8BDD\uFF0C\u65E0\u6743\u6D4B\u8BD5`);
    }
    if (pkg.status === "running") await this.stop(id);
    const { clientDelivered } = await this.run(id, sessionId);
    await this.stop(id);
    return { ok: true, clientDelivered };
  }
  /** 计算持久化 id：name 转 kebab-case；空或含非法字符则报错 */
  static persistIdOf(pkg, explicit) {
    const raw = (explicit ?? pkg.name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!raw) {
      throw new Error(`\u63D2\u4EF6 name \u65E0\u6CD5\u751F\u6210\u6301\u4E45\u5316 id\uFF08\u9700\u542B\u5B57\u6BCD/\u6570\u5B57/\u8FDE\u5B57\u7B26\uFF09\uFF0C\u8BF7\u7ED9\u63D2\u4EF6\u4E00\u4E2A\u82F1\u6587\u77ED id\uFF08\u5982 todo-list\uFF09`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
      throw new Error(`\u975E\u6CD5\u6301\u4E45\u5316 id\uFF08\u4EC5\u5141\u8BB8\u5B57\u6BCD/\u6570\u5B57/\u4E0B\u5212\u7EBF/\u8FDE\u5B57\u7B26\uFF09: ${raw}`);
    }
    return raw;
  }
  /** plugin_install：把验证通过的动态包持久化到内核并激活（跨会话、跨重启留存） */
  async install(dynId, sessionId, persistId) {
    const pkg = this.inventory.get(dynId);
    if (!pkg) throw new Error(`\u52A8\u6001\u5305\u4E0D\u5B58\u5728: ${dynId}`);
    if (pkg.sessionId !== sessionId) throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u5C5E\u4E8E\u5176\u4ED6\u4F1A\u8BDD\uFF0C\u65E0\u6743\u5B89\u88C5`);
    if (!pkg.code && !pkg.client) throw new Error(`\u52A8\u6001\u5305 "${pkg.name}" \u6CA1\u6709\u53EF\u5B89\u88C5\u7684\u4EE3\u7801`);
    if (!this.store) throw new Error("\u63D2\u4EF6\u4ED3\u5E93\u672A\u88C5\u914D\uFF0C\u65E0\u6CD5\u5B89\u88C5");
    const id = _SelfModifyRuntime.persistIdOf(pkg, persistId);
    if (this.inventory.list().some((p) => p.id === id && p.status === "installed")) {
      await this.uninstall(id);
    }
    if (pkg.status === "running") {
      await this.stop(dynId);
    }
    this.inventory.rename(dynId, id);
    this.inventory.setSession(id, "*");
    await this.run(id, sessionId, { skipApproval: true });
    await this.store.install({
      id,
      name: pkg.name,
      purpose: pkg.purpose,
      version: pkg.version,
      code: pkg.code,
      client: pkg.client,
      installedAt: Date.now()
    });
    this.inventory.setStatus(id, "installed");
    return { id, installed: true };
  }
  /** plugin_uninstall：卸载已安装插件（撤销运行 + 删除持久化文件） */
  async uninstall(persistId) {
    if (!this.store) throw new Error("\u63D2\u4EF6\u4ED3\u5E93\u672A\u88C5\u914D\uFF0C\u65E0\u6CD5\u5378\u8F7D");
    const pkg = this.inventory.get(persistId);
    if (pkg) {
      const disposer = this.disposers.get(persistId);
      if (disposer) {
        await disposer();
        this.disposers.delete(persistId);
      }
      await this.hooks.removeClient(persistId);
      this.inventory.remove(persistId);
    }
    await this.store.uninstall(persistId);
    return { uninstalled: true };
  }
  /** 启动时恢复：加载所有已安装插件并重新激活（免审批，之前已授权） */
  async restoreAll() {
    if (!this.store) return 0;
    const metas = await this.store.list();
    let restored = 0;
    for (const meta of metas) {
      if (this.inventory.list().some((p) => p.id === meta.id && p.status === "installed")) continue;
      const pkg = this.inventory.define({
        id: meta.id,
        name: meta.name,
        purpose: meta.purpose,
        code: meta.code,
        client: meta.client,
        version: meta.version,
        sessionId: "*"
      });
      try {
        await this.run(pkg.id, "*", { skipApproval: true });
        this.inventory.setStatus(pkg.id, "installed");
        restored++;
      } catch (err) {
        console.error(`[selfmod] \u6062\u590D\u5DF2\u5B89\u88C5\u63D2\u4EF6\u5931\u8D25: ${meta.id}`, err);
      }
    }
    return restored;
  }
  /** 五个 model-facing 工具（plugin_inspect / define / run / stop / undefine） */
  createTools(getSessionId) {
    const sid = () => getSessionId();
    const inspectTool = {
      name: "plugin_inspect",
      description: "\u67E5\u770B\u5F53\u524D\u53EF\u81EA\u6211\u5347\u7EA7\u7684\u8FD0\u884C\u65F6\u8868\u9762\uFF1A\u5DF2\u6CE8\u518C\u7684\u670D\u52A1\u3001\u53EF\u7528\u5DE5\u5177\u3001\u52A8\u6001\u63D2\u4EF6\u5305\u3001\u5DF2\u5B89\u88C5\u63D2\u4EF6\u3001UI \u63D2\u69FD\u3002\u5F53\u4F60\u9700\u8981\u4E86\u89E3\u300C\u80FD\u5F80\u54EA\u91CC\u6302\u81EA\u5B9A\u4E49 UI / \u6CE8\u518C\u4EC0\u4E48\u670D\u52A1 / \u6709\u54EA\u4E9B\u5DE5\u5177\u53EF\u7528 / \u5DF2\u5B89\u88C5\u4E86\u54EA\u4E9B\u63D2\u4EF6\u300D\u65F6\u4F7F\u7528\u3002",
      inputSchema: {
        type: "object",
        properties: {
          what: { type: "string", description: "\u53EF\u9009\uFF1Aservices | tools | packages | slots\uFF0C\u4E0D\u4F20\u8FD4\u56DE\u5168\u90E8" },
          name: { type: "string", description: "\u53EF\u9009\uFF1A\u8FDB\u4E00\u6B65\u8FC7\u6EE4\u7684\u540D\u79F0" }
        }
      },
      riskLevel: "readonly",
      execute: async () => this.inspect(sid())
    };
    const defineTool = {
      name: "plugin_define",
      description: "\u5B9A\u4E49\u4E00\u4E2A\u65B0\u7684\u52A8\u6001\u63D2\u4EF6\u5305\uFF08\u4EC5\u8BB0\u5F55\u3001\u4E0D\u8FD0\u884C\uFF09\u3002name \u662F\u5305\u540D\uFF0Cpurpose \u8BF4\u660E\u7528\u9014\uFF0Ccode \u662F host \u534A\u6E90\u7801\uFF08\u8FD0\u884C\u5728\u8FDB\u7A0B\u5185\uFF0C\u5BFC\u51FA\u51FD\u6570 (ctx) => disposer\uFF0Cctx \u63D0\u4F9B on/provide/tools.register\uFF09\u3002client \u662F browser \u534A\u6E90\u7801\uFF08\u6295\u9012\u5230\u754C\u9762\uFF09\uFF0C\u5951\u7EA6\u5F62\u5982 (React, slots, useUIContext) => { slots.register({ slot, id, component }) }\uFF1Bcomponent \u5FC5\u987B\u662F React \u7EC4\u4EF6\uFF0C\u5185\u90E8\u53EF\u8C03 useUIContext() \u83B7\u53D6\u4F1A\u8BDD/\u6D88\u606F/\u8F93\u5165/\u53D1\u6D88\u606F\u7B49\u5E94\u7528\u72B6\u6001\uFF1B\u6CE8\u610F\uFF1Aclient \u4EE3\u7801\u5728\u6D4F\u89C8\u5668\u91CC\u7528 new Function \u6267\u884C\uFF0C\u4E0D\u7ECF\u8FC7 JSX \u7F16\u8BD1\uFF0C\u6240\u4EE5\u5199\u7EC4\u4EF6\u5FC5\u987B\u7528 React.createElement(...)\uFF0C\u7981\u6B62\u5199 <div> \u8FD9\u7C7B JSX \u8BED\u6CD5\u3002slot \u5206\u4E24\u7C7B\uFF1A\u2460 \u8986\u76D6\u578B\uFF08\u6574\u4F53\u66FF\u6362\u8BE5\u533A\u5757\uFF0C\u540E\u6CE8\u518C\u8986\u76D6\uFF0C\u6CE8\u9500\u56DE\u9000\uFF09\uFF1Ashell.sidebar / shell.header / shell.chat / shell.composer / shell.statusbar / shell.welcome / shell.panels / shell.overlays / dynamic-extension\uFF1B\u2461 \u8FFD\u52A0\u578B\uFF08\u5F80\u533A\u5757\u5185\u90E8\u8FFD\u52A0\uFF0C\u4E92\u4E0D\u8986\u76D6\uFF0C\u7528\u4E8E\u300C\u52A0\u6309\u94AE/\u5C0F\u7EC4\u4EF6\u300D\uFF09\uFF1Acomposer.below\uFF08\u8F93\u5165\u6846\u4E0B\u65B9\uFF09/ composer.actions\uFF08\u8F93\u5165\u6846\u5DE5\u5177\u680F\uFF09/ header.actions\uFF08\u9876\u680F\u53F3\u4FA7\uFF09/ chat.below\uFF08\u6D88\u606F\u6D41\u4E0B\u65B9\uFF09\u3002\u60F3\u300C\u5728\u67D0\u5904\u52A0\u4E00\u4E2A\u6309\u94AE\u6216\u5C0F\u7EC4\u4EF6\u300D\u65F6\u4F18\u5148\u7528\u8FFD\u52A0\u578B\u63D2\u69FD\uFF0C\u4E0D\u8981\u7528\u8986\u76D6\u578B\u53BB\u66FF\u6362\u6574\u4E2A\u533A\u5757\u3002\u5B9A\u4E49\u540E\u8FD4\u56DE dyn-<n> id\u3002\u5B8C\u6574\u95ED\u73AF\uFF1Aplugin_define\uFF08\u5B9A\u4E49\uFF09\u2192 plugin_test\uFF08\u81EA\u6D4B\uFF09\u2192 plugin_install\uFF08\u5B89\u88C5\u8FDB\u5185\u6838\uFF0C\u8DE8\u4F1A\u8BDD/\u8DE8\u91CD\u542F\u7559\u5B58\uFF09\u2192 plugin_uninstall\uFF08\u5378\u8F7D\uFF09\uFF1Bplugin_run \u4EC5\u4E34\u65F6\u8FD0\u884C\u3001\u4E0D\u6301\u4E45\u5316\u3002",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "\u5305\u540D" },
          purpose: { type: "string", description: "\u7528\u9014\u8BF4\u660E\uFF08\u4E00\u53E5\u8BDD\uFF09" },
          code: { type: "string", description: "host \u534A\u6E90\u7801\uFF08\u53EF\u9009\uFF09" },
          client: { type: "string", description: "browser \u534A\u6E90\u7801\uFF08\u53EF\u9009\uFF0C\u987B\u7528 React.createElement\uFF0C\u4E0D\u80FD\u5199 JSX\uFF09" }
        },
        required: ["name", "purpose"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const pkg = this.define(
          {
            name: String(args.name ?? ""),
            purpose: String(args.purpose ?? ""),
            code: args.code ? String(args.code) : void 0,
            client: args.client ? String(args.client) : void 0
          },
          sid()
        );
        return { id: pkg.id, name: pkg.name, purpose: pkg.purpose, status: pkg.status };
      }
    };
    const runTool3 = {
      name: "plugin_run",
      description: "\u8FD0\u884C\u4E00\u4E2A\u5DF2\u5B9A\u4E49\u7684\u52A8\u6001\u63D2\u4EF6\u5305\uFF08\u5148 plugin_define \u62FF\u5230 id\uFF09\u3002host \u534A\u5728\u8FDB\u7A0B\u5185\u6267\u884C\uFF0Cbrowser \u534A\u4F1A\u8BF7\u6C42\u7528\u6237\u786E\u8BA4\u540E\u6295\u9012\u5230\u754C\u9762\u3002\u8FD4\u56DE clientDelivered \u8868\u793A\u754C\u9762\u90E8\u5206\u662F\u5426\u5DF2\u751F\u6548\u3002",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "\u52A8\u6001\u5305 id\uFF08plugin_define \u8FD4\u56DE\u7684 dyn-<n>\uFF09" } },
        required: ["id"]
      },
      // 注意：不设 approvalRequired / 高危 riskLevel，避免与 browser 半投递审批（requestClientRun）叠加成双重确认。
      // host 半在 vm 沙箱内执行、facade 仅暴露三条自动撤销路径，风险可控；真正的「投递 UI 到界面」已在 requestClientRun 单独审批。
      riskLevel: "reversible",
      execute: async (args) => this.run(String(args.id ?? ""), sid())
    };
    const stopTool = {
      name: "plugin_stop",
      description: "\u64A4\u56DE\u4E00\u4E2A\u6B63\u5728\u8FD0\u884C\u7684\u52A8\u6001\u63D2\u4EF6\u5305\uFF08host \u534A + browser \u534A\u90FD\u64A4\u9500\uFF09\uFF0C\u5B9A\u4E49\u4FDD\u7559\uFF0C\u53EF\u518D\u6B21 plugin_run\u3002",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "\u52A8\u6001\u5305 id\uFF08dyn-<n>\uFF09" } },
        required: ["id"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        await this.stop(String(args.id ?? ""));
        return { stopped: true };
      }
    };
    const undefineTool = {
      name: "plugin_undefine",
      description: "\u505C\u6B62\u5E76\u6C38\u4E45\u9057\u5FD8\u4E00\u4E2A\u52A8\u6001\u63D2\u4EF6\u5305\u7684\u5B9A\u4E49\u3002",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "\u52A8\u6001\u5305 id\uFF08dyn-<n>\uFF09" } },
        required: ["id"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        await this.undefine(String(args.id ?? ""));
        return { undefined: true };
      }
    };
    const testTool = {
      name: "plugin_test",
      description: "\u9A8C\u8BC1\u4E00\u4E2A\u5DF2\u5B9A\u4E49\u7684\u52A8\u6001\u63D2\u4EF6\u5305\uFF1A\u4E34\u65F6\u8FD0\u884C\uFF08host \u534A\u6267\u884C + browser \u534A\u6295\u9012\uFF09\u540E\u7ACB\u5373\u64A4\u56DE\uFF0C\u8FD4\u56DE\u9A8C\u8BC1\u7ED3\u679C\u3002\u7528\u4E8E\u300C\u5F00\u53D1\u5B8C\u5148\u81EA\u6D4B\u3001\u786E\u8BA4\u6CA1\u95EE\u9898\u518D plugin_install \u5B89\u88C5\u300D\u7684\u95ED\u73AF\u3002\u6D4B\u8BD5\u4E0D\u4F1A\u6301\u4E45\u5316\u3001\u4E0D\u5F71\u54CD\u6B63\u5F0F\u5B89\u88C5\u3002",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "\u52A8\u6001\u5305 id\uFF08plugin_define \u8FD4\u56DE\u7684 dyn-<n>\uFF09" } },
        required: ["id"]
      },
      riskLevel: "reversible",
      execute: async (args) => this.test(String(args.id ?? ""), sid())
    };
    const installTool = {
      name: "plugin_install",
      description: "\u628A\u4E00\u4E2A\u9A8C\u8BC1\u901A\u8FC7\u7684\u52A8\u6001\u63D2\u4EF6\u5305\u6B63\u5F0F\u5B89\u88C5\u5230\u7CFB\u7EDF\u5185\u6838\uFF1A\u6301\u4E45\u5316\u843D\u76D8\uFF08~/.shanhai/plugins/\uFF09\u5E76\u6FC0\u6D3B\uFF0C\u8DE8\u4F1A\u8BDD\u3001\u8DE8\u91CD\u542F\u7559\u5B58\uFF0C\u4E4B\u540E AI \u548C\u7528\u6237\u90FD\u80FD\u6301\u7EED\u4F7F\u7528\u3002\u5B89\u88C5\u540E\u8FD4\u56DE\u6301\u4E45\u5316 id\uFF08\u7528\u4E8E plugin_uninstall\uFF09\u3002\u53EF\u9009 persistId \u6307\u5B9A\u7A33\u5B9A\u82F1\u6587 id\uFF0C\u7F3A\u7701\u7528\u63D2\u4EF6 name \u751F\u6210\u3002\u5B89\u88C5\u524D\u5EFA\u8BAE\u5148 plugin_test \u9A8C\u8BC1\u3002",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "\u52A8\u6001\u5305 id\uFF08plugin_define \u8FD4\u56DE\u7684 dyn-<n>\uFF09" },
          persistId: { type: "string", description: "\u53EF\u9009\uFF1A\u7A33\u5B9A\u82F1\u6587\u6301\u4E45\u5316 id\uFF08\u5982 todo-list\uFF09\uFF0C\u7F3A\u7701\u7531 name \u751F\u6210" }
        },
        required: ["id"]
      },
      riskLevel: "reversible",
      approvalRequired: true,
      execute: async (args) => this.install(String(args.id ?? ""), sid(), args.persistId ? String(args.persistId) : void 0)
    };
    const uninstallTool = {
      name: "plugin_uninstall",
      description: "\u5378\u8F7D\u4E00\u4E2A\u5DF2\u5B89\u88C5\u7684\u63D2\u4EF6\uFF08\u64A4\u9500\u8FD0\u884C + \u5220\u9664\u6301\u4E45\u5316\u6587\u4EF6\uFF09\u3002\u53C2\u6570 id \u662F plugin_install \u8FD4\u56DE\u7684\u6301\u4E45\u5316 id\u3002\u5378\u8F7D\u540E\u8BE5\u63D2\u4EF6\u4E0D\u518D\u8DE8\u4F1A\u8BDD/\u8DE8\u91CD\u542F\u5B58\u5728\uFF1B\u4F1A\u8BDD\u5185\u52A8\u6001\u5305\u8BF7\u7528 plugin_undefine \u9057\u5FD8\u3002",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "\u6301\u4E45\u5316 id\uFF08plugin_install \u8FD4\u56DE\u7684 id\uFF09" } },
        required: ["id"]
      },
      riskLevel: "reversible",
      approvalRequired: true,
      execute: async (args) => this.uninstall(String(args.id ?? ""))
    };
    return [inspectTool, defineTool, runTool3, stopTool, undefineTool, testTool, installTool, uninstallTool];
  }
};

// ../../packages/session/src/session.ts
var Session = class {
  events = [];
  /**
   * 已持久化的事件数（前 persistedCount 条已落盘）。由持久化层读写，用于增量追加：
   * 每次 persist 只把 [persistedCount, length) 区间的新事件追加写盘，避免 O(n) 全量重写。
   */
  persistedCount = 0;
  /** 自上次持久化以来是否发生过截断/删除（truncate/removeLast），命中时需全量重写磁盘，而非增量追加 */
  needsRewrite = false;
  append(type, data) {
    const event = { type, data, timestamp: Date.now() };
    this.events.push(event);
    return event;
  }
  list() {
    return [...this.events];
  }
  /** 当前事件总数（供持久化层判断是否有新增事件，避免 list() 全量复制） */
  get size() {
    return this.events.length;
  }
  /** 返回 [start, end) 区间的浅拷贝（增量持久化用，避免 list() 全量复制） */
  slice(start, end) {
    return this.events.slice(start, end);
  }
  /** 从历史事件恢复（会话持久化加载用），返回恢复的事件数 */
  restore(events) {
    for (const e of events) {
      this.events.push(e);
    }
    this.persistedCount = this.events.length;
    this.needsRewrite = false;
    return events.length;
  }
  /**
   * 截断事件日志：只保留前 count 条，丢弃其后的所有事件。
   * 用于「重新发送 / 编辑后重发」——把某条用户消息及其之后的回复/工具过程裁掉，重新生成。
   * 返回被删除的事件数。
   */
  truncate(count) {
    if (count < 0) count = 0;
    if (count >= this.events.length) return 0;
    const removed = this.events.length - count;
    this.events.length = count;
    if (this.persistedCount > count) this.persistedCount = count;
    this.needsRewrite = true;
    return removed;
  }
  /**
   * 移除事件日志中指定类型的最后一条事件（用于覆盖/清理临时标记事件，如失败重试挂起快照 retry/snapshot）。
   * 返回是否移除成功。
   */
  removeLast(type) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) {
        this.events.splice(i, 1);
        if (i < this.persistedCount) this.persistedCount -= 1;
        this.needsRewrite = true;
        return true;
      }
    }
    return false;
  }
  /** 是否发生过需要全量重写磁盘的修改（truncate/removeLast） */
  requireRewrite() {
    return this.needsRewrite;
  }
  /** 持久化完成后调用：清除重写标记，并把已持久化游标推进到当前长度 */
  markPersisted() {
    this.needsRewrite = false;
    this.persistedCount = this.events.length;
  }
};
function effectiveApprovalPolicy(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "approval/policy") {
      return e.data.policy;
    }
  }
  return void 0;
}
function effectiveModelId(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "model/select") {
      return e.data.modelId;
    }
  }
  return void 0;
}

// ../../packages/approval/src/approval.ts
var ApprovalService = class {
  constructor(approver, policy = "ask") {
    this.approver = approver;
    this.policy = policy;
  }
  approver;
  policy;
  /** 当前审批策略（安全模式） */
  getPolicy() {
    return this.policy;
  }
  /** 运行时切换审批策略：ask=危险操作每次询问，never=从不询问直接执行 */
  setPolicy(policy) {
    this.policy = policy;
  }
  /**
   * 判断工具是否需要审批。
   * 传入 session 时按「会话级审批策略」判断（从该会话事件日志回放 approval/policy，缺省回退全局默认）；
   * 不传 session 则用全局默认策略。
   * @param outsideWorkdir 本次操作是否访问工作目录之外（由工具 resolveRisk 提供），
   *  用于「workdir」策略：工作目录内（false）免审批，访问目录外（true）才审批。
   */
  requiresApproval(tool, session, outsideWorkdir) {
    const policy = session ? effectiveApprovalPolicy(session.list()) ?? this.policy : this.policy;
    if (policy === "never") return false;
    if (policy === "workdir" && outsideWorkdir === false) return false;
    if (tool.approvalRequired === true) return true;
    return tool.riskLevel === "irreversible" || tool.riskLevel === "high";
  }
  async request(session, req) {
    session.append("approval/request", {
      id: req.id,
      toolName: req.toolName,
      args: req.args,
      riskLevel: req.riskLevel
    });
    const policy = effectiveApprovalPolicy(session.list()) ?? this.policy;
    let outcome;
    if (policy === "never") {
      outcome = "rejected";
    } else if (!this.approver) {
      outcome = "unavailable";
    } else {
      outcome = await this.approver(req);
    }
    session.append("approval/outcome", { id: req.id, outcome });
    return outcome;
  }
};

// ../../packages/tools/src/tools.ts
import { promises as fs3 } from "fs";
import { exec as execCallback, execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { resolve as resolve2, isAbsolute, join as join3, relative } from "path";
var exec = promisify(execCallback);
var execFile = promisify(execFileCallback);
var RUN_COMMAND_TIMEOUT_MS = 5 * 60 * 1e3;
async function buildDirTree(dir, maxDepth, maxEntries) {
  const counter = { n: 0 };
  const rootName = resolve2(dir);
  const walk = async (current, prefix, depth) => {
    if (depth >= maxDepth || counter.n >= maxEntries) return "";
    let entries;
    try {
      entries = await fs3.readdir(current, { withFileTypes: true });
    } catch {
      return "";
    }
    const visible = entries.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist").sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    let out = "";
    for (let i = 0; i < visible.length; i++) {
      if (counter.n >= maxEntries) {
        out += `${prefix}...
`;
        break;
      }
      const e = visible[i];
      if (!e) continue;
      const isLast = i === visible.length - 1;
      const branch = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const childPrefix = prefix + (isLast ? "    " : "\u2502   ");
      counter.n += 1;
      out += `${prefix}${branch}${e.name}${e.isDirectory() ? "/" : ""}
`;
      if (e.isDirectory()) {
        out += await walk(join3(current, e.name), childPrefix, depth + 1);
      }
    }
    return out;
  };
  const body = await walk(rootName, "", 0);
  return `${rootName}/
${body}`.trimEnd();
}
function parseNulSeparatedEnv(raw) {
  const env = {};
  for (const item of raw.split("\0")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return env;
}
function mergePathValue(primary, secondary) {
  const sep2 = process.platform === "win32" ? ";" : ":";
  const normalize = (p) => process.platform === "win32" ? p.toLowerCase().replace(/[/\\]+$/, "") : p;
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const raw of `${primary}${sep2}${secondary}`.split(sep2)) {
    const p = raw.trim();
    if (!p) continue;
    const key = normalize(p);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged.join(sep2);
}
async function loadLoginShellEnv() {
  if (process.platform === "win32") return {};
  const shell3 = process.env.SHELL || "/bin/zsh";
  const attempts = [
    { args: ["-ilc", "env -0"] },
    { args: ["-lc", "env -0"] }
  ];
  for (const attempt of attempts) {
    try {
      const { stdout } = await execFile(shell3, attempt.args, {
        encoding: "utf8",
        timeout: 8e3,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env }
      });
      const parsed = parseNulSeparatedEnv(stdout);
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
    }
  }
  return {};
}
var commandEnvCache = null;
var commandEnvLoadingPromise = null;
async function getRunCommandEnv() {
  if (commandEnvCache) return commandEnvCache;
  if (commandEnvLoadingPromise) return commandEnvLoadingPromise;
  commandEnvLoadingPromise = (async () => {
    const systemEnv = { ...process.env };
    const shellEnv = await loadLoginShellEnv();
    const merged = { ...systemEnv, ...shellEnv };
    const shellPath = shellEnv.PATH || shellEnv.Path;
    const systemPath = systemEnv.PATH || systemEnv.Path;
    if (shellPath && systemPath) {
      const pathValue = mergePathValue(shellPath, systemPath);
      merged.PATH = pathValue;
      merged.Path = pathValue;
    }
    commandEnvCache = merged;
    return merged;
  })();
  try {
    return await commandEnvLoadingPromise;
  } finally {
    commandEnvLoadingPromise = null;
  }
}
function createAtomicTools(getCwd, snapshot) {
  const resolvePath = (p) => {
    if (isAbsolute(p)) return p;
    const resolved = resolve2(getCwd(), p);
    if (relative(getCwd(), resolved).startsWith("..")) {
      throw new Error(`\u8DEF\u5F84\u8D8A\u754C\uFF1A\u76F8\u5BF9\u8DEF\u5F84 "${p}" \u89E3\u6790\u540E\u8D85\u51FA\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8BF7\u6539\u7528\u7EDD\u5BF9\u8DEF\u5F84\u660E\u786E\u8BBF\u95EE`);
    }
    return resolved;
  };
  const isOutsideWorkdir = (p) => {
    const rel = relative(getCwd(), resolve2(p));
    return rel.startsWith("..") || isAbsolute(rel);
  };
  const readonlyPathResolveRisk = (args) => {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    if (!raw) return { riskLevel: "readonly", approvalRequired: false, outsideWorkdir: false };
    const outside = isAbsolute(raw) && isOutsideWorkdir(raw);
    return { riskLevel: "readonly", approvalRequired: outside, outsideWorkdir: outside };
  };
  const fileWriteScopeRisk = (args) => {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    const outside = !!raw && isAbsolute(raw) && isOutsideWorkdir(raw);
    return { riskLevel: "reversible", approvalRequired: true, outsideWorkdir: outside };
  };
  const commandLooksOutsideWorkdir = (cmd) => {
    if (/\bcd\s+/.test(cmd)) return true;
    if (/(^|[^\w$])\/\S/.test(cmd)) return true;
    if (/~/.test(cmd)) return true;
    if (/(^|[^\w$])\.\.(\/|$)/.test(cmd)) return true;
    return false;
  };
  const toLineNumber = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return void 0;
  };
  const READ_FILE_DEFAULT_LINES = 200;
  const readFileTool = {
    name: "read_file",
    description: "\u8BFB\u53D6\u6307\u5B9A\u8DEF\u5F84\u7684\u6587\u672C\u6587\u4EF6\u5185\u5BB9\u3002\u5F53\u9700\u8981\u67E5\u770B\u6587\u4EF6\u5185\u5BB9\u65F6\u4F7F\u7528\u3002path \u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E5F\u53EF\u4EE5\u662F\u76F8\u5BF9\u4E8E\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF08\u4F18\u5148\u4F7F\u7528\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u4FDD\u6301\u64CD\u4F5C\u8303\u56F4\u5728\u5DE5\u4F5C\u76EE\u5F55\u5185\uFF09\u3002\u9ED8\u8BA4\u5206\u6BB5\u8BFB\u53D6\uFF1A\u672A\u6307\u5B9A\u884C\u53F7\u65F6\u53EA\u8BFB\u53D6\u524D 200 \u884C\uFF08\u6587\u4EF6\u4E0D\u8DB3 200 \u884C\u5219\u8BFB\u5168\u6587\uFF09\uFF0C\u622A\u65AD\u65F6\u4F1A\u63D0\u793A\u603B\u884C\u6570\u4E0E\u7EE7\u7EED\u8BFB\u53D6\u7684 startLine\u3002\u53EF\u7528 startLine / endLine \u6309\u884C\u8303\u56F4\u5206\u6BB5\u8BFB\u53D6\uFF081-based\u3001\u5305\u542B\u4E24\u7AEF\uFF09\uFF0C\u907F\u514D\u4E00\u6B21\u8BFB\u53D6\u5168\u6587\u5BFC\u81F4\u4E0A\u4E0B\u6587\u8FC7\u957F\u3002",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u6587\u4EF6\u8DEF\u5F84\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF09" },
        startLine: { type: "number", description: "\u8D77\u59CB\u884C\u53F7\uFF081-based\uFF0C\u5305\u542B\uFF0C\u53EF\u9009\uFF1B\u4E0D\u4F20\u9ED8\u8BA4\u4ECE\u7B2C 1 \u884C\u5F00\u59CB\uFF09" },
        endLine: { type: "number", description: "\u7ED3\u675F\u884C\u53F7\uFF081-based\uFF0C\u5305\u542B\uFF0C\u53EF\u9009\uFF1B\u4E0D\u4F20\u9ED8\u8BA4\u8BFB\u53D6 200 \u884C\uFF09" }
      },
      required: ["path"]
    },
    riskLevel: "readonly",
    resolveRisk: readonlyPathResolveRisk,
    execute: async (args) => {
      if (typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("read_file \u7F3A\u5C11 path \u53C2\u6570\uFF1A\u8BF7\u63D0\u4F9B\u8981\u8BFB\u53D6\u7684\u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09");
      }
      const path3 = resolvePath(args.path);
      const text = await fs3.readFile(path3, "utf8");
      const lines = text.split("\n");
      const total = lines.length;
      const startLine = toLineNumber(args.startLine);
      const endLine = toLineNumber(args.endLine);
      if (endLine !== void 0) {
        const start2 = Math.max(1, Math.floor(startLine ?? 1));
        const end2 = Math.floor(endLine);
        if (start2 > end2) {
          throw new Error(`read_file \u884C\u8303\u56F4\u975E\u6CD5\uFF1AstartLine=${start2} \u5927\u4E8E endLine=${end2}`);
        }
        return lines.slice(start2 - 1, end2).join("\n");
      }
      const start = Math.max(1, Math.floor(startLine ?? 1));
      const end = Math.min(start + READ_FILE_DEFAULT_LINES - 1, total);
      if (start > end) {
        throw new Error(`read_file \u884C\u8303\u56F4\u975E\u6CD5\uFF1AstartLine=${start} \u5927\u4E8E endLine=${end}`);
      }
      const content = lines.slice(start - 1, end).join("\n");
      if (end < total) {
        return `${content}

\uFF08\u6587\u4EF6\u5171 ${total} \u884C\uFF0C\u672C\u6B21\u8BFB\u53D6 ${start}-${end} \u884C\uFF0C\u5269\u4F59 ${total - end} \u884C\u672A\u8BFB\u3002\u8BF7\u7528 startLine=${end + 1} \u7EE7\u7EED\u5206\u6BB5\u8BFB\u53D6\u3002\uFF09`;
      }
      return content;
    }
  };
  const writeFileTool = {
    name: "write_file",
    description: "\u5199\u5165\u6587\u672C\u5185\u5BB9\u5230\u6307\u5B9A\u8DEF\u5F84\uFF08\u8986\u76D6\uFF09\u3002\u4F1A\u4FEE\u6539\u6587\u4EF6\uFF0C\u9ED8\u8BA4\u9700\u7528\u6237\u786E\u8BA4\u3002path \u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E5F\u53EF\u4EE5\u662F\u76F8\u5BF9\u4E8E\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\u3002",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u6587\u4EF6\u8DEF\u5F84\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF09" },
        content: { type: "string", description: "\u8981\u5199\u5165\u7684\u5185\u5BB9" }
      },
      required: ["path", "content"]
    },
    riskLevel: "reversible",
    approvalRequired: true,
    resolveRisk: fileWriteScopeRisk,
    execute: async (args) => {
      if (typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("write_file \u7F3A\u5C11 path \u53C2\u6570\uFF1A\u8BF7\u63D0\u4F9B\u8981\u5199\u5165\u7684\u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09");
      }
      const path3 = resolvePath(args.path);
      const content = String(args.content);
      let before = null;
      try {
        before = await fs3.readFile(path3, "utf8");
      } catch {
        before = null;
      }
      let snapshotId;
      if (before !== null && snapshot) {
        try {
          snapshotId = (await snapshot(path3))?.snapshotId;
        } catch {
          snapshotId = void 0;
        }
      }
      await fs3.writeFile(path3, content, "utf8");
      return { ok: true, path: path3, before, after: content, isNew: before === null, snapshotId };
    }
  };
  const editFileTool = {
    name: "edit_file",
    description: "\u7F16\u8F91\u5DF2\u6709\u6587\u4EF6\uFF1A\u5C06 oldText \u7CBE\u786E\u66FF\u6362\u4E3A newText\uFF08\u66FF\u6362\u6A21\u5F0F\uFF0C\u53EA\u9700\u63D0\u4F9B\u8981\u6539\u7684\u7247\u6BB5\uFF0C\u65E0\u9700\u91CD\u4F20\u5168\u6587\uFF0Ctoken \u5F00\u9500\u5C0F\uFF09\u3002path \u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E5F\u53EF\u4EE5\u662F\u76F8\u5BF9\u4E8E\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\u3002\u9ED8\u8BA4\u53EA\u66FF\u6362\u9996\u6B21\u547D\u4E2D\uFF1B\u5F53 oldText \u5728\u6587\u4EF6\u4E2D\u51FA\u73B0\u591A\u6B21\u65F6\uFF0C\u9700\u8BBE\u7F6E replaceAll=true \u66FF\u6362\u5168\u90E8\uFF0C\u6216\u63D0\u4F9B\u66F4\u957F\u7684 oldText \u4E0A\u4E0B\u6587\u7CBE\u786E\u5B9A\u4F4D\u552F\u4E00\u547D\u4E2D\uFF1B\u4E5F\u53EF\u8BBE\u7F6E expectedOccurrences \u58F0\u660E\u671F\u671B\u547D\u4E2D\u6B21\u6570\uFF0C\u5B9E\u9645\u547D\u4E2D\u4E0D\u7B26\u5219\u62A5\u9519\u3002\u4FEE\u6539\u6587\u4EF6\u9ED8\u8BA4\u9700\u7528\u6237\u786E\u8BA4\u3002",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u6587\u4EF6\u8DEF\u5F84\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF09" },
        oldText: { type: "string", description: "\u9700\u8981\u88AB\u66FF\u6362\u7684\u539F\u6587\u672C\uFF08\u5FC5\u987B\u7CBE\u786E\u5339\u914D\uFF09" },
        newText: { type: "string", description: "\u66FF\u6362\u540E\u7684\u65B0\u6587\u672C" },
        replaceAll: { type: "boolean", description: "\u662F\u5426\u66FF\u6362\u5168\u90E8\u547D\u4E2D\uFF0C\u9ED8\u8BA4 false\uFF08\u53EA\u66FF\u6362\u9996\u4E2A\u547D\u4E2D\uFF09" },
        expectedOccurrences: { type: "number", description: "\u671F\u671B oldText \u51FA\u73B0\u7684\u6B21\u6570\uFF0C\u5B9E\u9645\u4E0D\u7B26\u5219\u62A5\u9519\uFF08\u53EF\u9009\uFF09" }
      },
      required: ["path", "oldText", "newText"]
    },
    riskLevel: "reversible",
    approvalRequired: true,
    resolveRisk: fileWriteScopeRisk,
    execute: async (args) => {
      if (typeof args.path !== "string" || args.path.trim() === "") {
        throw new Error("edit_file \u7F3A\u5C11 path \u53C2\u6570\uFF1A\u8BF7\u63D0\u4F9B\u8981\u4FEE\u6539\u7684\u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09");
      }
      if (typeof args.oldText !== "string" || args.oldText === "") {
        throw new Error("edit_file \u7F3A\u5C11 oldText \u53C2\u6570\uFF1A\u8BF7\u63D0\u4F9B\u8981\u88AB\u66FF\u6362\u7684\u539F\u6587\u672C\u7247\u6BB5");
      }
      const path3 = resolvePath(args.path);
      const oldText = args.oldText;
      const newText = String(args.newText ?? "");
      const replaceAll = args.replaceAll === true;
      const expectedOccurrences = typeof args.expectedOccurrences === "number" ? args.expectedOccurrences : void 0;
      let before;
      try {
        before = await fs3.readFile(path3, "utf8");
      } catch {
        throw new Error(`edit_file \u8BFB\u53D6\u6587\u4EF6\u5931\u8D25\uFF1A${path3} \u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u8BFB\u53D6`);
      }
      const count = before.split(oldText).length - 1;
      if (count === 0) {
        throw new Error("edit_file \u672A\u627E\u5230 oldText\uFF1A\u6587\u4EF6\u4E2D\u4E0D\u5B58\u5728\u8BE5\u6587\u672C\u7247\u6BB5\uFF0C\u8BF7\u5148\u7528 read_file \u8BFB\u53D6\u5B9E\u9645\u5185\u5BB9\uFF0C\u786E\u4FDD oldText \u7CBE\u786E\u5339\u914D");
      }
      if (expectedOccurrences !== void 0 && count !== expectedOccurrences) {
        throw new Error(`edit_file \u547D\u4E2D\u6B21\u6570\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${expectedOccurrences} \u5904\uFF0C\u5B9E\u9645 ${count} \u5904`);
      }
      if (!replaceAll && count > 1) {
        throw new Error(`edit_file \u547D\u4E2D ${count} \u5904\uFF1A\u8BF7\u63D0\u4F9B\u66F4\u957F\u7684 oldText \u4E0A\u4E0B\u6587\u7CBE\u786E\u5B9A\u4F4D\u552F\u4E00\u547D\u4E2D\uFF0C\u6216\u8BBE\u7F6E replaceAll=true \u66FF\u6362\u5168\u90E8`);
      }
      const after = replaceAll ? before.split(oldText).join(newText) : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length);
      let snapshotId;
      if (snapshot) {
        try {
          snapshotId = (await snapshot(path3))?.snapshotId;
        } catch {
          snapshotId = void 0;
        }
      }
      await fs3.writeFile(path3, after, "utf8");
      return { ok: true, path: path3, occurrences: replaceAll ? count : 1, before, after, snapshotId };
    }
  };
  const runCommandTool = {
    name: "run_command",
    description: "\u5728\u7528\u6237\u7CFB\u7EDF\u4E0A\u6267\u884C shell \u547D\u4EE4\u3002\u5371\u9669\u64CD\u4F5C\uFF0C\u9ED8\u8BA4\u9700\u7528\u6237\u786E\u8BA4\u3002\u547D\u4EE4\u4F1A\u5728\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u4E0B\u6267\u884C\u3002",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "\u8981\u6267\u884C\u7684 shell \u547D\u4EE4" } },
      required: ["command"]
    },
    riskLevel: "irreversible",
    approvalRequired: true,
    resolveRisk: (args) => {
      const cmd = typeof args.command === "string" ? args.command : "";
      return { riskLevel: "irreversible", approvalRequired: true, outsideWorkdir: commandLooksOutsideWorkdir(cmd) };
    },
    execute: async (args) => {
      if (typeof args.command !== "string" || args.command.trim() === "") {
        throw new Error("run_command \u7F3A\u5C11 command \u53C2\u6570\uFF1A\u8BF7\u63D0\u4F9B\u8981\u6267\u884C\u7684 shell \u547D\u4EE4");
      }
      const env = await getRunCommandEnv();
      const shell3 = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
      const { stdout, stderr } = await exec(args.command, { cwd: getCwd(), env, shell: shell3, timeout: RUN_COMMAND_TIMEOUT_MS });
      return { stdout, stderr };
    }
  };
  const listDirTool = {
    name: "list_dir",
    description: "\u4EE5\u6811\u5F62\u7ED3\u6784\u5217\u51FA\u76EE\u5F55\u5185\u5BB9\u3002\u5F53\u9700\u8981\u4E86\u89E3\u9879\u76EE/\u76EE\u5F55\u7ED3\u6784\u3001\u67E5\u627E\u6587\u4EF6\u4F4D\u7F6E\u65F6\u4F7F\u7528\u3002path \u9ED8\u8BA4\u4E3A\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\uFF1BmaxDepth \u63A7\u5236\u9012\u5F52\u6DF1\u5EA6\uFF08\u9ED8\u8BA4 3\uFF09\u3002\u8FD4\u56DE tree \u98CE\u683C\u7684\u6811\u5F62\u6587\u672C\u3002",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u76EE\u5F55\u8DEF\u5F84\uFF08\u9ED8\u8BA4\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u53EF\u4F20\u76F8\u5BF9\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09" },
        maxDepth: { type: "number", description: "\u9012\u5F52\u6DF1\u5EA6\uFF0C\u9ED8\u8BA4 3" }
      }
    },
    riskLevel: "readonly",
    resolveRisk: readonlyPathResolveRisk,
    execute: async (args) => {
      const raw = args.path ? String(args.path) : "";
      const dir = raw ? resolvePath(raw) : getCwd();
      const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;
      return buildDirTree(dir, maxDepth, 300);
    }
  };
  return [readFileTool, writeFileTool, editFileTool, runCommandTool, listDirTool];
}

// ../../packages/tools/src/utility.ts
function createUtilityTools(deps) {
  const tools = [];
  if (deps.analyzeImage) tools.push(imageAnalyzeTool(deps.analyzeImage));
  if (deps.rollbackFile) tools.push(rollbackFileTool(deps.rollbackFile));
  if (deps.memory) tools.push(rememberTool(deps.memory), recallMemoryTool(deps.memory));
  return tools;
}
function imageAnalyzeTool(analyzeImage) {
  return {
    name: "image_analyze",
    description: "\u5206\u6790\u56FE\u7247\u5185\u5BB9\u5E76\u8FD4\u56DE\u6587\u5B57\u63CF\u8FF0\u3002\u5F53\u9700\u8981\u7406\u89E3\u56FE\u7247\u5185\u5BB9\u3001\u4F46\u5F53\u524D\u6A21\u578B\u65E0\u6CD5\u76F4\u63A5\u67E5\u770B\u56FE\u7247\u65F6\u4F7F\u7528\u3002",
    inputSchema: {
      type: "object",
      properties: { imageUrl: { type: "string", description: "\u56FE\u7247\u7684 URL \u6216 data: URL" } },
      required: ["imageUrl"]
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const imageUrl = String(args.imageUrl ?? "");
      if (!imageUrl) return "\uFF08\u672A\u63D0\u4F9B\u56FE\u7247\uFF09";
      return analyzeImage(imageUrl);
    }
  };
}
function rollbackFileTool(rollbackFile) {
  return {
    name: "rollback_file",
    description: "\u628A\u6587\u4EF6\u56DE\u6EDA\u5230\u6700\u8FD1\u4E00\u6B21 write_file \u4E4B\u524D\u7684\u5FEB\u7167\uFF0C\u6062\u590D\u539F\u5185\u5BB9\uFF08\u64A4\u9500\u5199\u5165\uFF09\u3002path \u662F\u76EE\u6807\u6587\u4EF6\u8DEF\u5F84\uFF08\u7EDD\u5BF9\u8DEF\u5F84\u6216\u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\uFF09\uFF0CsnapshotId \u662F write_file \u8FD4\u56DE\u7ED3\u679C\u91CC\u7684 snapshotId\u3002",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "\u6587\u4EF6\u8DEF\u5F84" },
        snapshotId: { type: "string", description: "write_file \u8FD4\u56DE\u7684\u5FEB\u7167 id" }
      },
      required: ["path", "snapshotId"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const path3 = String(args.path ?? "");
      const snapshotId = String(args.snapshotId ?? "");
      if (!path3) return { ok: false, error: "\u7F3A\u5C11 path" };
      if (!snapshotId) return { ok: false, error: "\u7F3A\u5C11 snapshotId" };
      return rollbackFile(path3, snapshotId);
    }
  };
}
function rememberTool(memory) {
  return {
    name: "remember",
    description: "\u4FDD\u5B58\u4E00\u6761\u957F\u671F\u8BB0\u5FC6\uFF08\u8DE8\u4F1A\u8BDD\u751F\u6548\uFF09\u3002\u5F53\u7528\u6237\u8868\u8FBE\u504F\u597D\u3001\u9879\u76EE\u80CC\u666F\u3001\u73AF\u5883\u7EA6\u5B9A\u6216\u4EFB\u52A1\u7ECF\u9A8C\u65F6\u4F7F\u7528\u3002scope \u53EF\u9009\uFF1Auser_preference\uFF08\u7528\u6237\u504F\u597D\uFF09\u3001project_knowledge\uFF08\u9879\u76EE\u77E5\u8BC6\uFF09\u3001environment\uFF08\u73AF\u5883\u7EA6\u5B9A\uFF09\u3001task_experience\uFF08\u4EFB\u52A1\u7ECF\u9A8C\uFF09\u3002key \u662F\u8BB0\u5FC6\u540D\uFF0Cvalue \u662F\u8BB0\u5FC6\u5185\u5BB9\u3002",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "\u8BB0\u5FC6\u4F5C\u7528\u57DF" },
        key: { type: "string", description: "\u8BB0\u5FC6\u540D" },
        value: { type: "string", description: "\u8BB0\u5FC6\u5185\u5BB9" }
      },
      required: ["scope", "key", "value"]
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const scope = String(args.scope ?? "");
      const key = String(args.key ?? "");
      const value = args.value;
      if (!scope || !key) return { ok: false, error: "scope \u548C key \u4E0D\u80FD\u4E3A\u7A7A" };
      const entry = memory.save(scope, key, value);
      return { ok: true, id: entry.id, scope, key };
    }
  };
}
function recallMemoryTool(memory) {
  return {
    name: "recall_memory",
    description: "\u53EC\u56DE\u957F\u671F\u8BB0\u5FC6\u3002\u6309 scope \u8FC7\u6EE4\u3001keyword \u5173\u952E\u8BCD\u5339\u914D\uFF0C\u8FD4\u56DE\u6700\u65B0\u7684\u5728\u524D\u3002",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "\u8BB0\u5FC6\u4F5C\u7528\u57DF\uFF08\u53EF\u9009\uFF09" },
        keyword: { type: "string", description: "\u5173\u952E\u8BCD\uFF08\u53EF\u9009\uFF09" }
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const scope = args.scope ? String(args.scope) : void 0;
      const keyword = args.keyword ? String(args.keyword) : void 0;
      const list = scope ? memory.recall(scope, keyword) : memory.list().reverse();
      return { items: list };
    }
  };
}

// ../../packages/tools/src/context.ts
import { AsyncLocalStorage } from "async_hooks";
var toolReasoningContext = new AsyncLocalStorage();

// ../../packages/agent/src/agent.ts
var AgentLoop = class {
  constructor(model, tools, session, approval, sessionId, budget, supportsVision = false, apiKey, compactModel) {
    this.model = model;
    this.tools = tools;
    this.session = session;
    this.approval = approval;
    this.sessionId = sessionId;
    this.budget = budget;
    this.supportsVision = supportsVision;
    this.apiKey = apiKey;
    this.compactModel = compactModel;
    this.approvalSession = this.session;
    this.userId = [sessionId ?? "agent", apiKey].filter((x) => !!x).join(":");
    this.restoreLastUsageTotalTokens();
  }
  model;
  tools;
  session;
  approval;
  sessionId;
  budget;
  supportsVision;
  apiKey;
  compactModel;
  /** 待注入的用户消息（插入模式）：任务执行中用户追加的消息，在下一个模型调用前以 user 形式追加到上下文 */
  pendingInjections = [];
  /** 同一会话同一 agent 稳定不变的 user_id：网关前缀缓存隔离 + 命中用（确定性派生，跨请求/跨重启不变） */
  userId;
  /** 审批策略会话：审批判断从该会话回放 approval/policy */
  approvalSession;
  /** 是否已被用户中止（点「停止」）：在每轮循环 / 流式每个 chunk / 工具执行前检查，尽快中断 */
  aborted = false;
  /** 最后一次 LLM 返回的真实 usage.total_tokens（网关真实返回，非本地估算）：循环中判断上下文是否超窗口用。
   * 用 totalTokens（prompt + completion）判断实际总消耗窗口，而非只看 prompt 部分。
   * 从会话 usage/record 事件恢复；之后每次模型调用后由 recordUsage 更新。 */
  lastUsageTotalTokens = 0;
  /** 挂起状态（任务失败重试耗尽后保存）：messages 快照 + 重入位置，retry() 用相同 body 重新提交 */
  suspended;
  /** 从会话事件日志恢复最近一次真实 usage.totalTokens（循环中 maybeCompact 判断上下文是否超窗口用）。
   * 遍历 usage/record 事件取最后一条 totalTokens，是网关真实返回，不是本地估算。
   * 兼容旧记录：无 totalTokens 时回退 promptTokens。 */
  restoreLastUsageTotalTokens() {
    for (const e of this.session.list()) {
      if (e.type === "usage/record") {
        const d = e.data;
        if (typeof d.totalTokens === "number") this.lastUsageTotalTokens = d.totalTokens;
        else if (typeof d.promptTokens === "number") this.lastUsageTotalTokens = d.promptTokens;
      }
    }
  }
  /**
   * 注入一条用户消息（插入模式）：任务执行中用户追加消息时调用。
   * 不中断当前任务——消息先落盘到会话日志（历史完整），并在下一个模型调用前以 user 形式追加到上下文。
   * 多条注入消息按顺序全部追加，不覆盖、不丢失。
   */
  injectUserMessage(message) {
    this.pendingInjections.push(message);
  }
  /** 把未消费的注入消息落盘到会话日志末尾（供中止时调用，避免追加需求丢失） */
  flushPendingInjections() {
    for (const m of this.pendingInjections.splice(0, this.pendingInjections.length)) {
      this.session.append("user/message", { content: m, injected: true });
    }
  }
  /** 中止当前任务循环（用户点「停止」）：设置标志，run 循环 / 流式 chunk / 工具执行前检查后抛 __stopped__ 尽快退出。
   * 注意：无法真正取消「正在 await 的工具 Promise」（如正在跑的 run_command），但能保证工具执行完立即停止、不进入下一轮。 */
  abort() {
    this.aborted = true;
  }
  async run(message, options) {
    const maxSteps = options?.maxSteps ?? 2e3;
    let messages = [];
    if (options?.systemPrompt) messages.push({ role: "system", content: options.systemPrompt });
    this.replayHistory(messages);
    this.trimHistoryIfTooLong(messages);
    const attachments = options?.attachments;
    this.session.append("user/message", { content: message, attachments: attachments ?? [] });
    if (options?.modelContent !== void 0) {
      messages.push({ role: "user", content: options.modelContent });
    } else if (this.supportsVision) {
      const parts = [{ type: "text", text: message }];
      if (attachments && attachments.length > 0) parts.push(...attachments);
      messages.push({ role: "user", content: parts });
    } else if (attachments && attachments.length > 0) {
      messages.push({ role: "user", content: [{ type: "text", text: message }, ...attachments] });
    } else {
      messages.push({ role: "user", content: message });
    }
    this.session.append("turn/start", { turn: 1 });
    const onDelta = options?.onDelta;
    const onReasoning = options?.onReasoning;
    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning);
  }
  /** 回放会话事件日志到 messages（user/assistant/tool 三类；delta/turn/usage/retry-snapshot 等中间态或元数据事件忽略）。 */
  replayHistory(messages) {
    for (const e of this.session.list()) {
      if (e.type === "user/message") {
        const d = e.data;
        if (this.supportsVision) {
          const parts = [];
          if (d.content) parts.push({ type: "text", text: d.content });
          if (d.attachments && d.attachments.length > 0) parts.push(...d.attachments);
          messages.push({ role: "user", content: parts.length > 0 ? parts : [{ type: "text", text: "" }] });
        } else {
          messages.push({ role: "user", content: replayUserContent(d.content, d.attachments) });
        }
      } else if (e.type === "assistant/message") {
        const d = e.data;
        messages.push({ role: "assistant", content: d.content, reasoningContent: d.reasoningContent });
      } else if (e.type === "tool/call") {
        const d = e.data;
        messages.push({ role: "assistant", content: "", toolCall: { id: d.callId, name: d.name, args: d.args }, reasoningContent: d.reasoningContent });
      } else if (e.type === "tool/result") {
        const d = e.data;
        messages.push({ role: "tool", content: JSON.stringify(d.result ?? d.error ?? ""), toolCallId: d.callId });
      }
    }
  }
  /** 发起时上下文裁剪（仅用户发起新任务 run() 时调用，断点续跑 resumeRun() 不调用）：
   * 回放历史事件后，若满足「回放消息条数超过 MAX_HISTORY_MESSAGES（1000 条）」或「token 达到窗口 70% 临界值」任一条件，
   * 则裁剪保留最近 MAX_HISTORY_TURNS 个对话回合（20 对 user/assistant 正文），每个回合只留「用户原始消息 + 最终 assistant 回复正文」，
   * 丢弃中间的 tool/call、tool/result、assistant(tool_calls) 工具执行过程，最大程度压缩体积同时保留对话主线。
   * 按 user 消息为回合边界，不切断「assistant(tool_calls) ↔ tool」配对（这些过程整体丢弃，不会产生孤立 tool 消息）。
   * token 判断依据 lastUsageTotalTokens（最后一次 LLM 返回的真实 usage.total_tokens，非本地估算）。
   * 说明：此裁剪是发起时的兜底，不做 LLM 摘要（摘要交给循环中的 maybeCompact，见下）。 */
  trimHistoryIfTooLong(messages) {
    const historyCount = messages.filter((m) => m.role !== "system").length;
    const overLength = historyCount > MAX_HISTORY_MESSAGES;
    const overBudget = this.budget ? this.lastUsageTotalTokens > Math.floor(this.budget * COMPACTION_THRESHOLD) : false;
    if (!overLength && !overBudget) return;
    const trimmed = this.buildTrimmedMessages(messages);
    messages.length = 0;
    messages.push(...trimmed);
  }
  /** 裁剪 messages 到最近 MAX_HISTORY_TURNS 个对话回合，返回新数组：每回合只保留「用户原始消息 + 最终 assistant 回复正文」，
   * 丢弃中间的 tool/call、tool/result、assistant(tool_calls) 工具执行过程（20 对 user/assistant 正文）。
   * 调用方已确认需要裁剪，此处不再判断回合数是否超上限，始终只保留 user/assistant 正文。 */
  buildTrimmedMessages(messages) {
    const systemMsgs = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const userIndices = [];
    rest.forEach((m, i) => {
      if (m.role === "user") userIndices.push(i);
    });
    const kept = [];
    const keptUserIndices = userIndices.slice(-MAX_HISTORY_TURNS);
    keptUserIndices.forEach((userIdx, t) => {
      const userMsg = rest[userIdx];
      if (!userMsg) return;
      kept.push(userMsg);
      const nextUserIdx = keptUserIndices[t + 1] ?? rest.length;
      for (let i = nextUserIdx - 1; i > userIdx; i--) {
        const m = rest[i];
        if (m && m.role === "assistant" && !isToolCallMessage(m)) {
          kept.push(m);
          break;
        }
      }
    });
    return [...systemMsgs, ...kept];
  }
  /** 断点续跑（「继续执行」用）：从会话事件日志回放已执行的历史（含完整工具回合），不追加新 user 消息、不新建 turn，
   * 直接继续 ReAct 循环。用户停止后 session 日志已完整记录已执行步骤，回放即恢复进度，从断点继续而非重新生成。 */
  async resumeRun(systemPrompt, onDelta, onReasoning) {
    const events = this.session.list();
    let cut = events.length;
    while (cut > 0 && events[cut - 1]?.type === "assistant/delta") cut--;
    if (cut < events.length) this.session.truncate(cut);
    const maxSteps = 2e3;
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    this.replayHistory(messages);
    return this.runLoop(messages, 0, maxSteps, onDelta, onReasoning);
  }
  /**
   * ReAct 循环主体（可重入）：挂起后 retry() 从失败的那一步用「相同 messages 快照」重新进入，
   * 即向 LLM 重新提交与上次失败完全一致的请求 body（上下文数据不变），而非重新回放历史/重新构建。
   */
  async runLoop(messages, startStep, maxSteps, onDelta, onReasoning) {
    for (let step = startStep; step < maxSteps; step++) {
      if (this.aborted) {
        this.flushPendingInjections();
        throw new Error("__stopped__");
      }
      if (this.pendingInjections.length > 0) {
        const injected = this.pendingInjections.splice(0, this.pendingInjections.length);
        for (const m of injected) this.session.append("user/message", { content: m, injected: true });
        const list = injected.map((m, i) => `${i + 1}. ${m}`).join("\n");
        messages.push({
          role: "user",
          content: `\u3010\u4EFB\u52A1\u6267\u884C\u671F\u95F4\uFF0C\u7528\u6237\u8FFD\u52A0\u4E86\u4EE5\u4E0B\u65B0\u9700\u6C42/\u65B0\u95EE\u9898\u3011
${list}

\u8BF7\u6309\u4EE5\u4E0B\u6B65\u9AA4\u5904\u7406\uFF0C\u4E0D\u8981\u4E2D\u65AD\u539F\u6709\u4EFB\u52A1\uFF1A
1. \u7EE7\u7EED\u5B8C\u6210\u539F\u6709\u4EFB\u52A1\u3002
2. \u5BF9\u4E0A\u8FF0\u6BCF\u6761\u65B0\u589E\u9700\u6C42\u9010\u6761\u8BC4\u4F30\uFF1A\u5224\u65AD\u662F\u5426\u9700\u8981\u5728\u5F53\u524D\u4EFB\u52A1\u5185\u5B9E\u9645\u6267\u884C\u3001\u662F\u5426\u53EF\u884C\u3001\u4F18\u5148\u7EA7\u5982\u4F55\u3002
3. \u5BF9\u53EF\u6267\u884C\u7684\u65B0\u589E\u9700\u6C42\uFF0C\u8BF7\u50CF\u5904\u7406\u539F\u4EFB\u52A1\u4E00\u6837\u8C03\u7528\u5DE5\u5177\u5B9E\u9645\u53BB\u5B8C\u6210\uFF08\u4E0D\u8981\u53EA\u505A\u6587\u5B57\u56DE\u5E94\uFF09\uFF0C\u76F4\u5230\u8FD9\u4E9B\u65B0\u589E\u9700\u6C42\u4E5F\u5F97\u5230\u843D\u5B9E\uFF1B\u786E\u5B9E\u65E0\u6CD5\u5B8C\u6210\u7684\u9700\u6C42\uFF0C\u8BF4\u660E\u539F\u56E0\u3002
4. \u5168\u90E8\u5B8C\u6210\u540E\uFF0C\u5728\u6700\u7EC8\u56DE\u7B54\u6B63\u6587\u4E2D\u7528\u300C\u65B0\u589E\u9700\u6C42\u5B8C\u6210\u60C5\u51B5\u300D\u5C0F\u8282\uFF0C\u6309\u4E0A\u8FF0\u7F16\u53F7\u9010\u6761\u5217\u51FA\uFF1A\u9700\u6C42\u5185\u5BB9 \u2192 \u8BC4\u4F30\u7ED3\u8BBA \u2192 \u5B8C\u6210\u72B6\u6001\uFF08\u5DF2\u5B8C\u6210 / \u90E8\u5206\u5B8C\u6210 / \u65E0\u6CD5\u5B8C\u6210\u5E76\u8BF4\u660E\u539F\u56E0\uFF09\u3002`
        });
      }
      messages = await this.maybeCompact(messages);
      let response;
      try {
        response = await this.decideWithRetry(messages, onDelta, onReasoning);
      } catch (err) {
        if (isContextLengthError(err)) {
          const compacted = await this.maybeCompact(messages, true);
          if (compacted === messages) throw err;
          messages = compacted;
          try {
            response = await this.decideWithRetry(messages, onDelta, onReasoning);
          } catch (err2) {
            if (err2 instanceof Error && err2.message.startsWith("__retry_exhausted__")) {
              this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err2));
            }
            throw err2;
          }
        } else {
          if (err instanceof Error && err.message.startsWith("__retry_exhausted__")) {
            this.suspend(messages, step, maxSteps, onDelta, onReasoning, false, retryExhaustedReason(err));
          }
          throw err;
        }
      }
      const toolCalls = response.toolCalls ?? (response.toolCall ? [response.toolCall] : []);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          await this.handleToolCall(messages, tc, response.reasoningContent);
        }
        continue;
      }
      const text = response.text ?? "";
      this.session.append("assistant/message", { content: text, reasoningContent: response.reasoningContent });
      this.session.append("turn/end", { turn: 1, text });
      return text;
    }
    messages.push({
      role: "user",
      content: `\u5DF2\u5230\u8FBE\u6700\u5927\u5DE5\u5177\u8C03\u7528\u6B65\u6570\uFF08${maxSteps} \u6B65\uFF09\u3002\u8BF7\u4E0D\u8981\u518D\u8C03\u7528\u4EFB\u4F55\u5DE5\u5177\uFF0C\u57FA\u4E8E\u4EE5\u4E0A\u5DF2\u5B8C\u6210\u7684\u6267\u884C\u7ED3\u679C\uFF0C\u76F4\u63A5\u7ED9\u51FA\u6700\u7EC8\u7ED3\u8BBA\u3002`
    });
    try {
      return await this.runConvergence(messages, maxSteps, onDelta, onReasoning);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("__retry_exhausted__")) {
        this.suspend(messages, maxSteps, maxSteps, onDelta, onReasoning, true, retryExhaustedReason(err));
      }
      throw err;
    }
  }
  /** 步数上限后的强制收敛：让模型直接给最终结论（不再调工具） */
  async runConvergence(messages, maxSteps, onDelta, onReasoning) {
    const final = await this.decideWithRetry(messages, onDelta, onReasoning);
    const finalCalls = final.toolCalls ?? (final.toolCall ? [final.toolCall] : []);
    if (finalCalls.length > 0) {
      throw new Error(`agent loop did not converge within ${maxSteps} steps`);
    }
    const text = final.text ?? "";
    this.session.append("assistant/message", { content: text, reasoningContent: final.reasoningContent });
    this.session.append("turn/end", { turn: 1, text });
    return text;
  }
  /** 挂起任务：保存失败节点的 messages 快照 + 重入位置，供 retry() 用「相同 body」重新提交。
   * 同时落盘 retry/snapshot 事件（覆盖旧快照），重启后可从会话事件恢复精确重试。 */
  suspend(messages, step, maxSteps, onDelta, onReasoning, atLimit, reason) {
    this.suspended = { messages: [...messages], step, maxSteps, onDelta, onReasoning, atLimit, reason };
    this.session.removeLast("retry/snapshot");
    this.session.append("retry/snapshot", { messages: [...messages], step, maxSteps, atLimit, reason });
  }
  /** 用户点击「重试」：用失败节点相同的 messages 快照重新提交请求，继续循环（不重新开始、不重新回放历史）。
   * 重启恢复场景：onDelta/onReasoning 从外部传入（快照里无函数），保证流式思考/正文仍能实时回显。 */
  async retry(onDelta, onReasoning) {
    const s = this.suspended;
    if (!s) throw new Error("\u6CA1\u6709\u6302\u8D77\u7684\u4EFB\u52A1\u53EF\u91CD\u8BD5");
    this.suspended = void 0;
    this.session.removeLast("retry/snapshot");
    const d = onDelta ?? s.onDelta;
    const r = onReasoning ?? s.onReasoning;
    if (s.atLimit) {
      return this.runConvergence(s.messages, s.maxSteps, d, r);
    }
    return this.runLoop(s.messages, s.step, s.maxSteps, d, r);
  }
  /** 从持久化快照恢复挂起态（重启后精确重试用）：onDelta/onReasoning 不随快照序列化，retry 时由运行时重新绑定 */
  restoreSuspended(snapshot) {
    this.suspended = { ...snapshot, messages: [...snapshot.messages], onDelta: void 0, onReasoning: void 0 };
  }
  /** 是否处于挂起状态（供运行时判断 retry 后 loop 是否仍需保留） */
  isSuspended() {
    return this.suspended !== void 0;
  }
  /** 循环中压缩：最近一次真实 usage.total_tokens 达到窗口 70% 临界值（COMPACTION_THRESHOLD）时，仅针对「当前轮」（最后一条 user 消息之后已执行的工具调用与结果）
   * 做 LLM 摘要，生成一段本轮进度摘要，保证本轮任务连贯性后继续执行。历史回合保持原文不动——超过上下文窗口临界值的
   * 历史也保留、不裁剪、不丢弃（发起时按消息条数超 1000 才裁剪 20 轮，见 trimHistoryIfTooLong）。
   * 判断依据：lastUsageTotalTokens（最后一次 LLM 返回的真实 usage.total_tokens），不是本地估算。
   * @param force true 时跳过判断直接压缩（网关已返回 400 超限时的兜底强制压缩）；若当前轮尚无可压缩步骤且非 force，则保留原样返回（不裁剪历史）。 */
  async maybeCompact(messages, force = false) {
    if (!this.budget) return messages;
    const threshold = Math.floor(this.budget * COMPACTION_THRESHOLD);
    if (!force && this.lastUsageTotalTokens <= threshold) return messages;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return messages;
    const prefix = messages.slice(0, lastUserIdx + 1);
    const currentTurn = messages.slice(lastUserIdx + 1);
    const hasToolSteps = currentTurn.some(
      (m) => m.role === "tool" || m.role === "assistant" && isToolCallMessage(m)
    );
    if (!hasToolSteps) {
      if (force) {
        const trimmed = this.buildTrimmedMessages(messages);
        if (trimmed.length >= messages.length) return messages;
        return trimmed;
      }
      return messages;
    }
    const summaryInput = currentTurn.map((m) => {
      let text = "";
      if (m.role === "tool") {
        text = `[\u5DE5\u5177\u7ED3\u679C] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`;
      } else if (m.role === "assistant" && ((m.toolCalls?.length ?? 0) > 0 || m.toolCall)) {
        const calls = (m.toolCalls ?? (m.toolCall ? [m.toolCall] : [])).map(
          (c) => `\u8C03\u7528\u5DE5\u5177 ${c.name}(${JSON.stringify(c.args ?? {})})`
        );
        text = calls.join("\n");
      } else {
        text = typeof m.content === "string" ? m.content : "";
      }
      return { role: "user", content: truncateTextForSummary(text, MAX_SUMMARY_MSG_CHARS) };
    });
    let summary = "";
    const summaryModel = this.compactModel ?? this.model;
    try {
      const res = await summaryModel.complete(
        [
          {
            role: "system",
            content: "\u4F60\u662F\u4EFB\u52A1\u8FDB\u5EA6\u6458\u8981\u5668\u3002\u628A\u300C\u5F53\u524D\u8FD9\u4E00\u8F6E\u300D\u5DF2\u6267\u884C\u7684\u5DE5\u5177\u8C03\u7528\u4E0E\u7ED3\u679C\u538B\u7F29\u6210\u4E00\u6BB5\u7B80\u6D01\u7684\u8FDB\u5EA6\u6458\u8981\uFF0C\u8BA9\u6A21\u578B\u80FD\u636E\u6B64\u7EE7\u7EED\u6267\u884C\uFF1A\u4FDD\u7559\u5DF2\u5B8C\u6210\u7684\u64CD\u4F5C\u3001\u5173\u952E\u7ED3\u679C\u4E0E\u7ED3\u8BBA\u3001\u5C1A\u672A\u5B8C\u6210\u7684\u90E8\u5206\u3001\u4E0B\u4E00\u6B65\u8BE5\u505A\u4EC0\u4E48\u3002"
          },
          ...summaryInput
        ],
        [],
        this.userId
      );
      summary = res.text ?? "";
    } catch {
      return messages;
    }
    if (!summary) return messages;
    return [...prefix, { role: "assistant", content: `\u3010\u672C\u8F6E\u6267\u884C\u6458\u8981\u3011${summary}` }];
  }
  /** 带自动重试的模型决策：可重试错误（网络/超时/5xx/429/余额不足/网关错误）自动重试最多 MAX_AUTO_RETRY 次（指数退避）。
   * 全部失败抛 __retry_exhausted__::<原因>，由上层弹窗让用户选择「重试（保持上下文续跑）/取消」。
   * 用户点「停止」（__stopped__）与上下文超限不自动重试（前者立即中止、后者走专门压缩兜底）。 */
  async decideWithRetry(messages, onDelta, onReasoning) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_AUTO_RETRY; attempt++) {
      try {
        return await this.decide(messages, onDelta, onReasoning);
      } catch (err) {
        if (err instanceof Error && err.message === "__stopped__") throw err;
        if (isContextLengthError(err)) throw err;
        if (!isRetryableError(err)) throw err;
        lastErr = err;
        if (attempt < MAX_AUTO_RETRY - 1) await sleep(AUTO_RETRY_BACKOFF_MS * 2 ** attempt);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`__retry_exhausted__::${msg}`);
  }
  async decide(messages, onDelta, onReasoning) {
    if (this.model.stream) {
      let text = "";
      let reasoningContent = "";
      let reasoningFlushed = false;
      const toolCalls = [];
      let usage;
      try {
        for await (const chunk of this.model.stream(messages, this.tools, this.userId)) {
          if (this.aborted) throw new Error("__stopped__");
          if (chunk.reasoningContent) {
            reasoningContent += chunk.reasoningContent;
          }
          if (chunk.text) {
            if (!reasoningFlushed) {
              reasoningFlushed = true;
              if (reasoningContent) onReasoning?.(reasoningContent);
            }
            text += chunk.text;
            this.session.append("assistant/delta", { text: chunk.text });
            onDelta?.(chunk.text);
          }
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCalls.push(...chunk.toolCalls);
          } else if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
          }
          if (chunk.usage) {
            usage = chunk.usage;
            this.recordUsage(chunk.usage);
          }
        }
      } catch (err) {
        throw err;
      }
      const response = { text, toolCalls, toolCall: toolCalls[0], reasoningContent: reasoningContent || void 0, usage };
      return response;
    }
    let res;
    try {
      res = await this.model.complete(messages, this.tools, this.userId);
    } catch (err) {
      throw err;
    }
    if (res.usage) this.recordUsage(res.usage);
    const resCalls = res.toolCalls ?? (res.toolCall ? [res.toolCall] : []);
    if (resCalls.length === 0 && res.reasoningContent) onReasoning?.(res.reasoningContent);
    return res;
  }
  /** 记录每次模型调用返回的 usage，持久化到会话事件日志（usage/record），
   * 供 token 统计模块（累计用量 / 上下文占比）恢复使用，同时更新 lastUsageTotalTokens 供压缩判断用真实值。 */
  recordUsage(usage) {
    this.lastUsageTotalTokens = usage.totalTokens;
    this.session.append("usage/record", {
      totalTokens: usage.totalTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedPromptTokens ?? 0
    });
  }
  async handleToolCall(messages, call, reasoningContent) {
    if (this.aborted) {
      this.flushPendingInjections();
      throw new Error("__stopped__");
    }
    const callId = call.id ?? `${call.name}-${Date.now()}`;
    this.session.append("tool/call", { callId, name: call.name, args: call.args, reasoningContent });
    const assistantCallMsg = () => ({
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: call.name, args: call.args }],
      reasoningContent
    });
    const tool = this.tools.find((t) => t.name === call.name);
    if (!tool) {
      const error = `unknown tool "${call.name}"`;
      this.session.append("tool/result", { callId, name: call.name, error });
      messages.push(assistantCallMsg());
      messages.push({ role: "tool", content: error, toolCallId: callId });
      return;
    }
    const dynamicRisk = tool.resolveRisk ? await tool.resolveRisk(call.args) : void 0;
    const riskLevel = dynamicRisk?.riskLevel ?? tool.riskLevel;
    const approvalRequired = dynamicRisk?.approvalRequired ?? tool.approvalRequired;
    const outsideWorkdir = dynamicRisk?.outsideWorkdir;
    if (this.approval.requiresApproval({ ...tool, riskLevel, approvalRequired }, this.approvalSession, outsideWorkdir)) {
      const outcome = await this.approval.request(this.approvalSession, {
        id: callId,
        toolName: call.name,
        args: call.args,
        riskLevel,
        sessionId: this.sessionId
      });
      if (outcome !== "allowed-once") {
        const error = `approval ${outcome}`;
        this.session.append("tool/result", { callId, name: call.name, error });
        messages.push(assistantCallMsg());
        messages.push({ role: "tool", content: error, toolCallId: callId });
        return;
      }
    }
    try {
      const executed = toolReasoningContext.run(reasoningContent, () => Promise.resolve(tool.execute(call.args)));
      const result = tool.timeoutMs === Infinity ? await executed : await withTimeout(executed, tool.timeoutMs ?? TOOL_TIMEOUT_MS);
      this.session.append("tool/result", { callId, name: call.name, result });
      messages.push(assistantCallMsg());
      messages.push({ role: "tool", content: JSON.stringify(result), toolCallId: callId });
      if (this.supportsVision) {
        const imageUrl = extractImageUrl(result);
        if (imageUrl) {
          messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl } }] });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.session.append("tool/result", { callId, name: call.name, error });
      messages.push(assistantCallMsg());
      messages.push({ role: "tool", content: `error: ${error}`, toolCallId: callId });
    }
  }
};
var TOOL_TIMEOUT_MS = 5 * 60 * 1e3;
var MAX_AUTO_RETRY = 5;
var AUTO_RETRY_BACKOFF_MS = 500;
var MAX_HISTORY_TURNS = 20;
var MAX_HISTORY_MESSAGES = 1e3;
var COMPACTION_THRESHOLD = 0.7;
var MAX_SUMMARY_MSG_CHARS = 1e4;
function isToolCallMessage(m) {
  return !!m.toolCall || (m.toolCalls?.length ?? 0) > 0;
}
function extractImageUrl(result) {
  if (typeof result !== "object" || result === null) return null;
  const r = result;
  if (typeof r.imageUrl === "string" && /^https?:\/\//.test(r.imageUrl)) return r.imageUrl;
  return null;
}
function isContextLengthError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /context length|maximum context|invalid_request_error|too many tokens|reduce the length/i.test(msg);
}
function isRetryableError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/超时|timed?\s*out|ETIMEDOUT/i.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|fetch\s*failed|network|socket|terminated|aborted|socket\s*hang\s*up|网络/i.test(msg)) return true;
  if (/(?:API|status|HTTP)\s*5\d\d|(?:API|status|HTTP)\s*429/i.test(msg)) return true;
  if (/余额不足|insufficient|balance|quota|billing|rate\s*limit|限流|超额/i.test(msg)) return true;
  if (/gateway\s*error/i.test(msg)) return true;
  return false;
}
function retryExhaustedReason(err) {
  if (!(err instanceof Error)) return void 0;
  if (!err.message.startsWith("__retry_exhausted__::")) return void 0;
  return err.message.slice("__retry_exhausted__::".length);
}
function sleep(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
function truncateTextForSummary(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}
\u2026\uFF08\u5185\u5BB9\u8FC7\u957F\uFF0C\u6458\u8981\u65F6\u5DF2\u622A\u65AD\uFF09`;
}
function withTimeout(p, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`\u5DE5\u5177\u6267\u884C\u8D85\u65F6\uFF08${Math.round(ms / 1e3)}s\uFF09\uFF0C\u5DF2\u4E2D\u6B62\u672C\u6B21\u8C03\u7528\uFF0C\u8BF7\u68C0\u67E5\u76EE\u6807\u662F\u5426\u53EF\u8FBE\u540E\u91CD\u8BD5`)),
      ms
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function replayUserContent(content, attachments) {
  if (!attachments || attachments.length === 0) return content;
  const marks = attachments.map((a) => {
    if (a.type === "image_url") return "[\u56FE\u7247\u9644\u4EF6]";
    if (a.type === "input_audio") return "[\u8BED\u97F3\u9644\u4EF6]";
    if (a.type === "input_video") return "[\u89C6\u9891\u9644\u4EF6]";
    return "";
  }).filter(Boolean).join(" ");
  return content ? `${content} ${marks}` : marks;
}

// ../../packages/ask/src/ask.ts
var ASK_CANCELLED = "__ASK_CANCELLED__";
var AskService = class {
  pending = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  /** 发起提问并阻塞等待用户回答 */
  ask(question, opts) {
    const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const req = {
      id,
      sessionId: opts?.sessionId,
      question,
      options: opts?.options,
      multiple: opts?.multiple,
      placeholder: opts?.placeholder,
      reasoning: opts?.reasoning,
      kind: opts?.kind,
      sessionOptions: opts?.sessionOptions,
      modelOptions: opts?.modelOptions
    };
    return new Promise((resolve4) => {
      this.pending.set(id, { resolve: resolve4, sessionId: opts?.sessionId });
      this.listeners.forEach((cb) => cb(req));
    });
  }
  /** 订阅提问请求（返回取消订阅函数） */
  onRequest(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  /** 用户提交回答（resolve 对应提问），返回是否找到并 resolve 了该提问（供管家代答判断提问是否存在） */
  respond(id, answer) {
    const p = this.pending.get(id);
    if (p) {
      p.resolve(answer);
      this.pending.delete(id);
      return true;
    }
    return false;
  }
  /** 用户取消回答/选择（resolve 为 ASK_CANCELLED 标记，工具据此返回「用户取消」） */
  cancel(id) {
    const p = this.pending.get(id);
    if (p) {
      p.resolve(ASK_CANCELLED);
      this.pending.delete(id);
    }
  }
  /** 取消指定会话所有待回答提问（删除会话时调用，避免 agent 永久卡在等待用户回答） */
  cancelSession(sessionId) {
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        p.resolve(ASK_CANCELLED);
        this.pending.delete(id);
      }
    }
  }
};

// ../../packages/ask/src/tools.ts
function createAskTools(service, getSessionId) {
  return [askUserTool(service, getSessionId)];
}
function askUserTool(service, getSessionId) {
  return {
    name: "ask_user",
    description: "\u5F53\u9700\u8981\u7528\u6237\u534F\u52A9\u505A\u9009\u62E9\u3001\u786E\u8BA4\u6216\u8865\u5145\u4FE1\u606F\u65F6\u8C03\u7528\uFF0C\u5411\u7528\u6237\u63D0\u95EE\u5E76\u7B49\u5F85\u56DE\u7B54\uFF0C\u7136\u540E\u57FA\u4E8E\u56DE\u7B54\u7EE7\u7EED\u6267\u884C\u3002question \u5FC5\u987B\u81EA\u5305\u542B\u5730\u5199\u6E05\u695A\uFF1A\u2460 \u5F53\u524D\u6B63\u5728\u505A\u4EC0\u4E48/\u80CC\u666F\u662F\u4EC0\u4E48 \u2461 \u4E3A\u4EC0\u4E48\u9700\u8981\u7528\u6237\u6765\u505A\u8FD9\u4E2A\u51B3\u5B9A \u2462 \u5177\u4F53\u8981\u7528\u6237\u9009/\u56DE\u7B54\u4EC0\u4E48\uFF1B\u7981\u6B62\u53EA\u5199\u4E00\u53E5\u300C\u8BF7\u9009\u62E9\u300D\u300C\u600E\u4E48\u5904\u7406\u300D\u8FD9\u7C7B\u7A7A\u8BDD\uFF0C\u8BA9\u7528\u6237\u4E0D\u770B\u4E0A\u4E0B\u6587\u4E5F\u80FD\u7406\u89E3\u5728\u95EE\u4EC0\u4E48\u3002options \u662F\u53EF\u9009\u7B54\u6848\u5217\u8868\uFF08\u63D0\u4F9B\u5219\u7528\u6237\u5355\u9009\uFF0Cmultiple \u4E3A true \u65F6\u591A\u9009\uFF09\uFF0C\u6BCF\u4E00\u9879\u5FC5\u987B\u5199\u6E05\u695A\u300C\u662F\u4EC0\u4E48 + \u9009\u5B83\u610F\u5473\u7740\u4EC0\u4E48/\u540E\u679C\u300D\uFF0C\u7981\u6B62\u53EA\u5199\u5B64\u96F6\u96F6\u7684\u540D\u8BCD\uFF1B\u4E0D\u63D0\u4F9B options \u5219\u7528\u6237\u81EA\u7531\u8F93\u5165\u6587\u5B57\u3002placeholder \u662F\u81EA\u7531\u8F93\u5165\u65F6\u7684\u63D0\u793A\u8BED\u3002",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "\u8981\u5411\u7528\u6237\u63D0\u51FA\u7684\u95EE\u9898\uFF08\u5FC5\u586B\uFF09\u3002\u5FC5\u987B\u81EA\u5305\u542B\u5730\u5199\u6E05\u695A\u80CC\u666F\u3001\u4E3A\u4EC0\u4E48\u9700\u8981\u7528\u6237\u51B3\u5B9A\u3001\u4EE5\u53CA\u5177\u4F53\u8981\u7528\u6237\u9009\u4EC0\u4E48\uFF0C\u4E0D\u80FD\u8BA9\u7528\u6237\u9760\u8BB0\u5FC6\u731C" },
        options: { type: "array", items: { type: "string" }, description: "\u53EF\u9009\u7B54\u6848\u5217\u8868\uFF08\u5355\u9009\uFF1B\u914D\u5408 multiple \u53EF\u591A\u9009\uFF09\u3002\u6BCF\u4E00\u9879\u5199\u6E05\u695A\u300C\u662F\u4EC0\u4E48 + \u9009\u5B83\u7684\u540E\u679C\u300D\uFF0C\u7981\u6B62\u53EA\u5199\u540D\u8BCD" },
        multiple: { type: "boolean", description: "\u662F\u5426\u591A\u9009\uFF08\u9ED8\u8BA4 false \u5355\u9009\uFF0C\u4EC5 options \u63D0\u4F9B\u65F6\u751F\u6548\uFF09" },
        placeholder: { type: "string", description: "\u81EA\u7531\u6587\u672C\u8F93\u5165\u65F6\u7684\u5360\u4F4D\u63D0\u793A" }
      },
      required: ["question"]
    },
    riskLevel: "readonly",
    // 等用户回答：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
    timeoutMs: Infinity,
    execute: async (args) => {
      const question = String(args.question ?? "").trim();
      if (!question) return { ok: false, error: "question \u4E0D\u80FD\u4E3A\u7A7A" };
      const options = Array.isArray(args.options) ? args.options.map((o) => String(o)).filter(Boolean) : void 0;
      const multiple = args.multiple === true;
      const placeholder = args.placeholder ? String(args.placeholder) : void 0;
      const answer = await service.ask(question, {
        options: options && options.length > 0 ? options : void 0,
        multiple,
        placeholder,
        sessionId: getSessionId(),
        reasoning: toolReasoningContext.getStore()
      });
      if (answer === ASK_CANCELLED) return { ok: false, error: "\u7528\u6237\u53D6\u6D88\u4E86\u56DE\u7B54" };
      return answer;
    }
  };
}

// ../../packages/skills/src/skill.ts
import { promises as fs4 } from "fs";
import { join as join4 } from "path";
import { homedir } from "os";
var BUILTIN_SKILLS = [
  {
    id: "code-review",
    name: "\u4EE3\u7801\u5BA1\u67E5",
    description: "\u4FEE\u6539\u4EE3\u7801\u540E\u81EA\u52A8\u68C0\u67E5\u6F5C\u5728\u95EE\u9898\uFF0C\u6309\u4E25\u91CD\u7A0B\u5EA6\u7ED9\u51FA\u5BA1\u67E5\u5EFA\u8BAE",
    source: "builtin",
    instructions: [
      "\u5F53\u7528\u6237\u63D0\u4EA4\u6216\u4FEE\u6539\u4EE3\u7801\u3001\u8981\u6C42\u68C0\u67E5\u4EE3\u7801\u8D28\u91CF\u65F6\u4F7F\u7528\u3002",
      "",
      "\u6267\u884C\u6B65\u9AA4\uFF1A",
      "1. \u7528 read_file \u8BFB\u53D6\u88AB\u4FEE\u6539\u7684\u4EE3\u7801\u6587\u4EF6\uFF08\u5927\u6587\u4EF6\u5148 list_dir \u5B9A\u4F4D\u518D\u5206\u5757\u8BFB\uFF09\u3002",
      "2. \u68C0\u67E5\uFF1A\u547D\u540D\u662F\u5426\u81EA\u89E3\u91CA\u3001\u5355\u51FD\u6570\u662F\u5426 \u226450 \u884C\u3001\u662F\u5426\u6EE5\u7528 any \u4E0E\u975E\u7A7A\u65AD\u8A00\u3001I/O \u662F\u5426 try-catch\u3001\u662F\u5426\u5904\u7406\u7A7A\u503C/\u6781\u503C/\u5E76\u53D1\u3002",
      "3. \u5B89\u5168\u68C0\u67E5\uFF1ASQL/\u547D\u4EE4\u662F\u5426\u53C2\u6570\u5316\u9632\u6CE8\u5165\u3001\u5BC6\u94A5\u662F\u5426\u8131\u654F\u3001\u8DEF\u5F84\u662F\u5426 resolve \u540E\u6821\u9A8C\u5728\u5DE5\u4F5C\u76EE\u5F55\u5185\u3001\u662F\u5426\u786C\u7F16\u7801\u51ED\u8BC1\u3002",
      "4. \u8F93\u51FA\u6309\u4E25\u91CD\u7A0B\u5EA6\uFF08\u81F4\u547D/\u8B66\u544A/\u5EFA\u8BAE\uFF09\u5206\u7EA7\u7684\u5BA1\u67E5\u7ED3\u679C\uFF0C\u6BCF\u6761\u7ED9\u51FA\u6587\u4EF6 + \u884C\u53F7 + \u539F\u56E0\u3002"
    ].join("\n")
  },
  {
    id: "code-search",
    name: "\u4EE3\u7801\u641C\u7D22",
    description: "\u5728\u9879\u76EE\u4E2D\u6309\u5173\u952E\u5B57\u6216\u6587\u4EF6\u540D\u5B9A\u4F4D\u4EE3\u7801/\u5185\u5BB9",
    source: "builtin",
    instructions: [
      "\u5F53\u9700\u8981\u67E5\u627E\u67D0\u4E2A\u51FD\u6570\u3001\u5173\u952E\u5B57\u3001\u6587\u4EF6\u4F4D\u7F6E\u65F6\u4F7F\u7528\u3002",
      "",
      '\u4F18\u5148\u7528 run_command \u6267\u884C `grep -rn "\u5173\u952E\u5B57" .` \u9012\u5F52\u641C\u7D22\u5E76\u663E\u793A\u884C\u53F7\uFF1B',
      '\u6309\u6587\u4EF6\u540D\u67E5\u627E\u7528 `find . -name "*.ts" -path "*/src/*"`\u3002',
      "\u641C\u7D22\u4E0D\u5230\u65F6\u62C6\u5206\u5173\u952E\u8BCD\u3001\u6269\u5927\u8303\u56F4\u91CD\u8BD5\uFF1B\u6700\u540E\u624D read_file \u6574\u6587\u4EF6\uFF0C\u907F\u514D\u5927\u6587\u4EF6\u6574\u8BFB\u3002"
    ].join("\n")
  }
];
var SkillService = class {
  constructor(skillsDir = join4(homedir(), ".shanhai", "skills")) {
    this.skillsDir = skillsDir;
  }
  skillsDir;
  cache = null;
  /** 可执行技能（handler 在代码内，如 browser-use / computer-use） */
  executables = [];
  /** 注册可执行技能；优先级高于内置与用户技能（handler 在代码内，不可被 SKILL.md 覆盖） */
  registerExecutable(skill) {
    this.executables.push(skill);
    this.cache = null;
  }
  /** 列出所有可用技能（可执行 + 内置 + 用户目录） */
  async list() {
    if (this.cache) return this.cache;
    const user = await this.loadUserSkills();
    const merged = /* @__PURE__ */ new Map();
    for (const s of [...BUILTIN_SKILLS, ...user, ...this.executables]) merged.set(s.id, s);
    this.cache = [...merged.values()];
    return this.cache;
  }
  /** 按 id 读取技能（含 instructions 手册全文与 actions 清单） */
  async read(id) {
    const skills = await this.list();
    return skills.find((s) => s.id === id);
  }
  /** 按 skillId + action 查找可执行动作（供 skill_run 执行与动态风险解析） */
  async findAction(skillId, action) {
    const skill = await this.read(skillId);
    return skill?.actions?.find((a) => a.name === action);
  }
  /**
   * 内置可执行技能目录文本（注入系统提示词，让 AI 开局即知有哪些内置能力）。
   * 只含 source=builtin 且带 actions 的可执行技能（browser-use / computer-use / terminal 等）；
   * 纯说明书内置技能（code-review 等）与第三方用户技能（~/.shanhai/skills）不注入，
   * 由 AI 在需要时通过 skill_list 主动查询。
   */
  async builtinExecutableCatalog() {
    const skills = await this.list();
    const executables = skills.filter((s) => s.source === "builtin" && s.actions && s.actions.length > 0);
    if (executables.length === 0) return "";
    return executables.map((s) => `- ${s.id}\uFF08${s.name}\uFF09\uFF1A${s.description}`).join("\n");
  }
  /** 扫描用户技能目录，返回解析后的技能列表（目录不存在或技能损坏时静默跳过） */
  async loadUserSkills() {
    let entries;
    try {
      entries = await fs4.readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mdPath = join4(this.skillsDir, entry.name, "SKILL.md");
      try {
        const raw = await fs4.readFile(mdPath, "utf8");
        const skill = this.parseSkillMarkdown(entry.name, raw);
        if (skill) out.push(skill);
      } catch {
      }
    }
    return out;
  }
  /** 解析 SKILL.md：frontmatter（---...---）取元数据，其余为 instructions 正文 */
  parseSkillMarkdown(id, raw) {
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    let meta = {};
    let instructions = raw;
    if (match) {
      instructions = (match[2] ?? "").trim();
      meta = this.parseFrontmatter(match[1] ?? "");
    }
    const name = meta.name?.trim() || id;
    const description = meta.description?.trim() || "";
    if (!instructions) return void 0;
    return { id, name, description, instructions, source: "user" };
  }
  /** 逐行解析 frontmatter 的 `key: value` 对 */
  parseFrontmatter(block) {
    const meta = {};
    for (const line of block.split("\n")) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      const value = (kv[2] ?? "").trim();
      if (key === "name") meta.name = value;
      else if (key === "description") meta.description = value;
    }
    return meta;
  }
};

// ../../packages/skills/src/tools.ts
function createSkillTools(service) {
  return [skillListTool(service), skillReadTool(service), skillRunTool(service)];
}
function skillListTool(service) {
  return {
    name: "skill_list",
    description: "\u5217\u51FA\u6240\u6709\u53EF\u7528\u7684\u590D\u5408\u6280\u80FD\uFF08id/\u540D\u79F0/\u63CF\u8FF0/\u6765\u6E90\uFF09\u3002\u5F53\u9700\u8981\u4E86\u89E3\u6709\u54EA\u4E9B\u6280\u80FD\u53EF\u7528\u6765\u5B8C\u6210\u67D0\u7C7B\u4EFB\u52A1\u3001\u6216\u4E0D\u786E\u5B9A\u8BE5\u7528\u4EC0\u4E48\u6D41\u7A0B\u65F6\u8C03\u7528\uFF0C\u8FD4\u56DE\u6280\u80FD\u6E05\u5355\u540E\u518D\u7528 skill_read \u8BFB\u53D6\u5177\u4F53\u624B\u518C\u3002",
    inputSchema: {
      type: "object",
      properties: {}
    },
    riskLevel: "readonly",
    execute: async () => {
      const skills = await service.list();
      return {
        skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source }))
      };
    }
  };
}
function skillReadTool(service) {
  return {
    name: "skill_read",
    description: "\u8BFB\u53D6\u6307\u5B9A\u6280\u80FD\u7684\u5B8C\u6574\u64CD\u4F5C\u624B\u518C\uFF08instructions\uFF09\u3002\u53EF\u6267\u884C\u6280\u80FD\uFF08\u5982 browser-use / computer-use\uFF09\u8FD8\u4F1A\u8FD4\u56DE\u811A\u672C\u6E05\u5355\uFF08actions\uFF1A\u6BCF\u4E2A\u811A\u672C\u7684 name + \u53C2\u6570\u8BF4\u660E\uFF09\uFF0C\u62FF\u5230\u540E\u6309\u624B\u518C\u6B65\u9AA4\u3001\u7528 skill_run \u6267\u884C\u5BF9\u5E94\u811A\u672C\u3002id \u4ECE skill_list \u8FD4\u56DE\u7684\u6E05\u5355\u91CC\u53D6\u3002",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "\u6280\u80FD id\uFF08skill_list \u8FD4\u56DE\u7684 id\uFF09" }
      },
      required: ["id"]
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const id = String(args.id ?? "").trim();
      if (!id) return { ok: false, error: "\u7F3A\u5C11 id" };
      const skill = await service.read(id);
      if (!skill) return { ok: false, error: `\u6280\u80FD\u4E0D\u5B58\u5728: ${id}` };
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        // 可执行技能：返回脚本清单（不含 execute 函数），让 AI 知道有哪些脚本及各自参数
        actions: skill.actions?.map((a) => ({
          name: a.name,
          description: a.description,
          params: a.params,
          required: a.required ?? []
        }))
      };
    }
  };
}
function skillRunTool(service) {
  return {
    name: "skill_run",
    description: "\u6267\u884C\u6307\u5B9A\u6280\u80FD\u7684\u4E00\u4E2A\u811A\u672C\uFF08action\uFF09\u3002\u8FD9\u662F\u53EF\u6267\u884C\u6280\u80FD\uFF08browser-use / computer-use \u7B49\uFF09\u7684\u7EDF\u4E00\u6267\u884C\u5165\u53E3\u3002\u4F7F\u7528\u524D\u5FC5\u987B\u5148 skill_read \u8BFB\u53D6\u8BE5\u6280\u80FD\u7684\u624B\u518C\u62FF\u5230\u811A\u672C\u6E05\u5355\uFF08actions\uFF09\u4E0E\u53C2\u6570\u7ED3\u6784\uFF0C\u518D\u6309\u6E05\u5355\u586B skillId\uFF08\u6280\u80FD id\uFF09\u3001action\uFF08\u811A\u672C\u540D\uFF09\u3001params\uFF08\u811A\u672C\u53C2\u6570\uFF0C\u53C2\u6570\u7ED3\u6784\u89C1 skill_read \u8FD4\u56DE\u7684 actions \u6E05\u5355\uFF09\u3002\u6CE8\u610F\uFF1Askill_run \u672C\u8EAB\u4E0D\u5217\u51FA\u811A\u672C\uFF0C\u4E0D\u6E05\u695A\u6709\u54EA\u4E9B action \u65F6\u5148 skill_read\uFF0C\u4E0D\u8981\u731C\u3002",
    inputSchema: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "\u6280\u80FD id\uFF08skill_list / skill_read \u8FD4\u56DE\u7684 id\uFF0C\u5982 browser-use\u3001computer-use\uFF09" },
        action: { type: "string", description: "\u811A\u672C\u540D\uFF08skill_read \u8FD4\u56DE\u7684 actions \u6E05\u5355\u91CC\u7684 name\uFF0C\u5982 navigate\u3001click\u3001screenshot\uFF09" },
        params: { type: "object", description: "\u811A\u672C\u53C2\u6570\uFF08\u53C2\u6570\u7ED3\u6784\u89C1 skill_read \u8FD4\u56DE\u7684 actions \u6E05\u5355\uFF09" }
      },
      required: ["skillId", "action"]
    },
    riskLevel: "reversible",
    /** 动态风险：审批粒度下沉到 action 级（browser-use 免审批、computer-use 的桌面动作需审批） */
    resolveRisk: async (args) => {
      const act = await service.findAction(String(args.skillId ?? ""), String(args.action ?? ""));
      return { riskLevel: act?.riskLevel ?? "reversible", approvalRequired: act?.approvalRequired ?? false };
    },
    execute: async (args) => {
      const skillId = String(args.skillId ?? "").trim();
      const action = String(args.action ?? "").trim();
      if (!skillId || !action) return { ok: false, error: "\u7F3A\u5C11 skillId \u6216 action \u53C2\u6570" };
      const act = await service.findAction(skillId, action);
      if (!act) {
        return { ok: false, error: `\u6280\u80FD ${skillId} \u4E0D\u5B58\u5728\u811A\u672C: ${action}\uFF08\u5148\u7528 skill_read \u67E5\u770B\u8BE5\u6280\u80FD\u7684\u53EF\u7528\u811A\u672C\u6E05\u5355\uFF09` };
      }
      const params = args.params && typeof args.params === "object" ? args.params : {};
      return act.execute(params);
    }
  };
}

// ../../packages/mcp/src/client.ts
import { spawn } from "child_process";
var StdioMcpClient = class {
  constructor(config) {
    this.config = config;
  }
  config;
  child = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  buffer = "";
  closed = false;
  /** 启动子进程并完成 initialize 握手 */
  async start(timeoutMs = 15e3) {
    if (this.child) return;
    this.closed = false;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env ?? {} },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", () => {
    });
    child.on("error", (err) => this.failAll(err));
    child.on("exit", (code) => {
      this.closed = true;
      if (code !== 0 && this.pending.size > 0) {
        this.failAll(new Error(`MCP \u670D\u52A1\u5668\u8FDB\u7A0B\u9000\u51FA\uFF08code=${code}\uFF09`));
      }
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "shanhai", version: "0.1.0" }
    }, timeoutMs);
    this.notify("notifications/initialized", {});
  }
  /** 发现工具（tools/list） */
  async listTools() {
    const result = await this.request("tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
  }
  /** 调用工具（tools/call），返回工具执行结果 */
  async callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
  /** 关闭并销毁子进程，拒绝所有待处理请求 */
  close() {
    this.closed = true;
    this.failAll(new Error("MCP \u5BA2\u6237\u7AEF\u5DF2\u5173\u95ED"));
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
  request(method, params, timeoutMs = 3e4) {
    if (!this.child || this.closed) return Promise.reject(new Error("MCP \u5BA2\u6237\u7AEF\u672A\u8FDE\u63A5"));
    const id = this.nextId++;
    return new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP \u8BF7\u6C42\u8D85\u65F6: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve4(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  /** 逐行解析 stdout，按 id 匹配响应（响应可能跨 chunk，用 buffer 累积） */
  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP \u9519\u8BEF: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  }
  failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
};

// ../../packages/mcp/src/service.ts
import { promises as fs5 } from "fs";
import { join as join5 } from "path";
import { homedir as homedir2 } from "os";
var McpService = class {
  constructor(configPath = join5(homedir2(), ".shanhai", "mcp.json")) {
    this.configPath = configPath;
  }
  configPath;
  config = null;
  clients = /* @__PURE__ */ new Map();
  /** 列出所有已配置的服务器（id + command + args） */
  async listServers() {
    const cfg = await this.loadConfig();
    return Object.entries(cfg.servers ?? {}).map(([id, s]) => ({
      id,
      command: s.command,
      args: s.args ?? []
    }));
  }
  /** 列出某个服务器的工具（连接失败降级为 error 字段） */
  async listToolsOf(serverId) {
    try {
      const client = await this.getClient(serverId);
      const tools = await client.listTools();
      return { serverId, tools };
    } catch (err) {
      return { serverId, tools: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** 列出所有服务器的工具（逐台降级） */
  async listAllTools() {
    const servers = await this.listServers();
    const out = [];
    for (const s of servers) out.push(await this.listToolsOf(s.id));
    return out;
  }
  /** 调用某服务器的工具（失败抛错，由工具层 catch 转为结果） */
  async callTool(serverId, toolName, args) {
    const client = await this.getClient(serverId);
    return client.callTool(toolName, args);
  }
  /** 关闭所有连接（退出时清理子进程） */
  async close() {
    for (const [, client] of this.clients) client.close();
    this.clients.clear();
  }
  async loadConfig() {
    if (this.config) return this.config;
    try {
      const raw = await fs5.readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw);
      this.config = { servers: parsed.servers ?? {} };
    } catch {
      this.config = { servers: {} };
    }
    return this.config;
  }
  async getClient(serverId) {
    const cfg = await this.loadConfig();
    const serverCfg = cfg.servers?.[serverId];
    if (!serverCfg) throw new Error(`MCP \u670D\u52A1\u5668\u4E0D\u5B58\u5728: ${serverId}`);
    const cached = this.clients.get(serverId);
    if (cached) return cached;
    const client = new StdioMcpClient(serverCfg);
    await client.start();
    this.clients.set(serverId, client);
    return client;
  }
};

// ../../packages/mcp/src/tools.ts
function createMcpTools(service) {
  return [mcpListToolsTool(service), mcpCallTool(service)];
}
function mcpListToolsTool(service) {
  return {
    name: "mcp_list_tools",
    description: "\u5217\u51FA\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u63D0\u4F9B\u7684\u5DE5\u5177\u3002\u9700\u8981\u4E86\u89E3\u6709\u54EA\u4E9B\u5916\u90E8\u80FD\u529B\uFF08\u7ECF MCP \u534F\u8BAE\u63A5\u5165\u7684\u5DE5\u5177\uFF09\u53EF\u7528\u65F6\u8C03\u7528\u3002\u4E0D\u4F20 serverId \u8FD4\u56DE\u5168\u90E8\u670D\u52A1\u5668\uFF1B\u4F20 serverId \u53EA\u8FD4\u56DE\u8BE5\u670D\u52A1\u5668\u7684\u5DE5\u5177\u6E05\u5355\u3002",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "\u53EF\u9009\uFF1A\u53EA\u5217\u51FA\u6307\u5B9A\u670D\u52A1\u5668\u7684\u5DE5\u5177" }
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const serverId = args.serverId ? String(args.serverId).trim() : void 0;
      if (serverId) {
        const result = await service.listToolsOf(serverId);
        return { serverId, tools: result.tools, error: result.error };
      }
      const servers = await service.listAllTools();
      return {
        servers: servers.map((s) => ({ serverId: s.serverId, tools: s.tools, error: s.error }))
      };
    }
  };
}
function mcpCallTool(service) {
  return {
    name: "mcp_call",
    description: "\u8C03\u7528 MCP \u670D\u52A1\u5668\u63D0\u4F9B\u7684\u5DE5\u5177\u3002serverId \u4E0E toolName \u4ECE mcp_list_tools \u8FD4\u56DE\u7684\u6E05\u5355\u91CC\u53D6\uFF1Barguments \u662F\u4F20\u7ED9\u8BE5\u5DE5\u5177\u7684\u53C2\u6570\u5BF9\u8C61\uFF08\u9700\u5339\u914D\u8BE5\u5DE5\u5177\u7684 inputSchema\uFF09\u3002\u5916\u90E8\u5DE5\u5177\u53EF\u80FD\u6709\u526F\u4F5C\u7528\uFF0C\u9ED8\u8BA4\u9700\u7528\u6237\u786E\u8BA4\u3002",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string", description: "MCP \u670D\u52A1\u5668 id\uFF08mcp_list_tools \u8FD4\u56DE\uFF09" },
        toolName: { type: "string", description: "\u8981\u8C03\u7528\u7684\u5DE5\u5177\u540D" },
        arguments: { type: "object", description: "\u4F20\u7ED9\u5DE5\u5177\u7684\u53C2\u6570\u5BF9\u8C61" }
      },
      required: ["serverId", "toolName"]
    },
    riskLevel: "irreversible",
    approvalRequired: true,
    execute: async (args) => {
      const serverId = String(args.serverId ?? "").trim();
      const toolName = String(args.toolName ?? "").trim();
      if (!serverId || !toolName) return { ok: false, error: "\u7F3A\u5C11 serverId \u6216 toolName" };
      const callArgs = args.arguments ?? {};
      try {
        const result = await service.callTool(serverId, toolName, callArgs);
        return { ok: true, serverId, toolName, result };
      } catch (err) {
        return { ok: false, serverId, toolName, error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
}

// ../../packages/memory/src/types.ts
var CONFIG_SCOPES = [
  "user_preference",
  "environment",
  "project_knowledge",
  "data_cognition"
];

// ../../packages/memory/src/store.ts
var MemoryStore = class {
  entries = [];
  archives = /* @__PURE__ */ new Map();
  nextId = 1;
  save(scope, key, value, meta) {
    const entry = {
      id: this.nextId++,
      scope,
      key,
      value,
      source: meta?.source ?? "explicit",
      confidence: meta?.confidence ?? 1,
      timestamp: Date.now(),
      sessionId: meta?.sessionId
    };
    if (CONFIG_SCOPES.includes(scope)) {
      const hk = `${scope}:${key}`;
      const current = this.entries.filter((e) => e.scope === scope && e.key === key).at(-1);
      if (current) {
        const hist = this.archives.get(hk) ?? [];
        hist.push(current);
        this.archives.set(hk, hist);
      }
      this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key));
    }
    this.entries.push(entry);
    return entry;
  }
  list(scope) {
    if (!scope) return [...this.entries];
    return this.entries.filter((e) => e.scope === scope);
  }
  /** 按会话隔离：只返回归属于指定会话的记忆（全局/旧数据不在此列） */
  listBySession(sessionId, scope) {
    let list = this.entries.filter((e) => e.sessionId === sessionId);
    if (scope) list = list.filter((e) => e.scope === scope);
    return [...list];
  }
  /** 删除一条记忆（按 id） */
  remove(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    return true;
  }
  /** 召回：按 key / 内容关键词匹配，返回最新的在前；传 sessionId 时仅召回该会话记忆（全隔离） */
  recall(scope, keyword, sessionId) {
    let list = this.entries.filter((e) => e.scope === scope);
    if (sessionId !== void 0) list = list.filter((e) => e.sessionId === sessionId);
    if (keyword) {
      list = list.filter(
        (e) => e.key.includes(keyword) || JSON.stringify(e.value).includes(keyword)
      );
    }
    return [...list].reverse();
  }
  history(scope, key) {
    return [...this.archives.get(`${scope}:${key}`) ?? []];
  }
  /** 回滚到上一个历史版本（仅配置型） */
  rollback(scope, key) {
    const hk = `${scope}:${key}`;
    const hist = this.archives.get(hk);
    const last = hist?.at(-1);
    if (!last || !hist) return false;
    this.entries = this.entries.filter((e) => !(e.scope === scope && e.key === key));
    this.entries.push({ ...last, id: this.nextId++, timestamp: Date.now() });
    hist.pop();
    return true;
  }
};

// ../../packages/auth/src/auth.ts
import { createHash } from "crypto";
var TokenExpiredError = class extends Error {
  constructor(message = "token expired") {
    super(message);
    this.name = "TokenExpiredError";
  }
};
var AuthService = class _AuthService {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  /** 密码 SHA-256 小写 hex（只在登录请求瞬间使用，不落盘） */
  static sha256Hex(password) {
    return createHash("sha256").update(password).digest("hex");
  }
  async login(username, password) {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/api/member/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: _AuthService.sha256Hex(password) })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`login failed ${res.status}: ${body}`);
    }
    const raw = await res.json();
    if (raw.code !== void 0 && raw.code !== 0) {
      throw new Error(raw.message ?? `login failed code=${raw.code}`);
    }
    const token = raw.data?.token ?? raw.token ?? raw.data?.memberToken ?? raw.memberToken ?? raw.data?.access_token ?? raw.access_token;
    if (!token) {
      throw new Error(`login response missing token: ${JSON.stringify(raw).slice(0, 300)}`);
    }
    const member = raw.data?.member;
    return {
      token,
      username,
      nickname: member?.nickname,
      avatar: member?.avatar,
      balance: member?.balance
    };
  }
  async logout() {
  }
  async fetchModels(token) {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/api/member/models`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401 || res.status === 403 || /invalid token|expired|unauthorized/i.test(body)) {
        throw new TokenExpiredError(`models token invalid ${res.status}: ${body}`);
      }
      throw new Error(`fetchModels failed ${res.status}: ${body}`);
    }
    const raw = await res.json();
    if (raw.error) {
      if (/invalid token|expired|unauthorized/i.test(raw.error)) {
        throw new TokenExpiredError(raw.error);
      }
      throw new Error(`fetchModels error: ${raw.error}`);
    }
    if (raw.code !== void 0 && raw.code !== 0) {
      throw new Error(raw.message ?? `fetchModels code=${raw.code}`);
    }
    const list = raw.data?.data ?? raw.models ?? [];
    return list.map((m) => {
      const id = String(m.id ?? "");
      const name = String(m.displayName ?? m.name ?? id);
      return {
        id,
        name,
        displayName: m.displayName != null ? String(m.displayName) : void 0,
        model: m.model != null ? String(m.model) : void 0,
        tier: "flagship",
        apiKey: String(m.apiKey ?? ""),
        baseUrl: String(m.baseUrl ?? ""),
        contextLength: typeof m.contextLength === "number" ? m.contextLength : void 0,
        maxTokens: m.maxTokens != null ? Number(m.maxTokens) : void 0,
        temperature: m.temperature != null ? String(m.temperature) : void 0,
        supportsVision: m.supportsVision === true,
        supportsReasoning: m.supportsReasoning === true,
        provider: m.provider != null ? String(m.provider) : void 0,
        protocol: m.protocol === "anthropic" || m.provider === "anthropic" ? "anthropic" : void 0,
        sortOrder: typeof m.sortOrder === "number" ? m.sortOrder : void 0,
        description: m.description != null ? String(m.description) : void 0,
        source: m.source != null ? String(m.source) : void 0
      };
    });
  }
};

// ../../packages/auth/src/credential.ts
import { promises as fs6 } from "fs";
import { dirname } from "path";
import { homedir as homedir3 } from "os";
var FileCredentialStore = class {
  constructor(path3 = join6(homedir3(), ".shanhai", "config.json")) {
    this.path = path3;
  }
  path;
  async load() {
    try {
      const raw = await fs6.readFile(this.path, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  async save(cred) {
    await fs6.mkdir(dirname(this.path), { recursive: true });
    await fs6.writeFile(this.path, JSON.stringify(cred, null, 2), { mode: 384 });
  }
  async clear() {
    await fs6.rm(this.path, { force: true });
  }
};
function join6(...parts) {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

// ../../packages/computer-use/src/computer-use.ts
function createMockComputerUseService() {
  return {
    screenshot: async () => new ArrayBuffer(0),
    clickAt: async () => {
    },
    doubleClickAt: async () => {
    },
    typeText: async () => {
    },
    pressKey: async () => {
    },
    scroll: async () => {
    },
    ocr: async () => []
  };
}

// ../../packages/computer-use/src/tools.ts
function createComputerUseTools(service, uploadImage) {
  return [screenshotTool(service, uploadImage), ocrTool(service), actionTool(service)];
}
function screenshotTool(service, uploadImage) {
  return {
    name: "computer_screenshot",
    description: "\u622A\u53D6\u5F53\u524D\u5C4F\u5E55\u5E76\u8FD4\u56DE\u622A\u56FE\u94FE\u63A5\uFF08\u4E0A\u4F20\u4E91\u5B58\u50A8\u540E\u7684 https URL\uFF09\u3002\u7528\u4E8E\u67E5\u770B\u684C\u9762/\u7A97\u53E3\u5F53\u524D\u72B6\u6001\u3002\u4EFB\u4F55\u9700\u8981\u70B9\u51FB\u3001\u8F93\u5165\u3001\u5224\u65AD\u754C\u9762\u72B6\u6001\u7684\u64CD\u4F5C\uFF0C\u7B2C\u4E00\u6B65\u90FD\u5FC5\u987B\u5148\u8C03\u7528\u5B83\u622A\u56FE\uFF0C\u518D\u914D\u5408 computer_ocr \u6216 image_analyze \u5B9A\u4F4D\uFF0C\u7981\u6B62\u4E0D\u622A\u56FE\u76F4\u63A5\u76F2\u64CD\u4F5C\u3002",
    inputSchema: { type: "object", properties: {} },
    riskLevel: "readonly",
    execute: async () => {
      const buf = await service.screenshot();
      const bytes = new Uint8Array(buf);
      const base64 = Buffer.from(bytes).toString("base64");
      if (uploadImage) {
        try {
          const url = await uploadImage(base64);
          if (url) return { imageUrl: url, byteLength: bytes.length };
        } catch {
        }
      }
      return { imageBase64: base64, byteLength: bytes.length };
    }
  };
}
function ocrTool(service) {
  return {
    name: "computer_ocr",
    description: "\u8BC6\u522B\u622A\u56FE\u4E2D\u7684\u6587\u5B57\u53CA\u5176\u7CBE\u786E\u5750\u6807\u3002\u8FD4\u56DE\u6BCF\u4E2A\u6587\u5B57\u5757\u7684\u4E2D\u5FC3\u70B9\u5373\u7CBE\u786E\u70B9\u51FB\u5750\u6807\u3002\u7528\u4E8E\u5B9A\u4F4D\u6309\u94AE\u3001\u83DC\u5355\u9879\u3001\u8F93\u5165\u6846\u7B49\u5E26\u6587\u5B57\u7684 UI \u5143\u7D20\uFF1B\u7EAF\u56FE\u6807/\u56FE\u7247\u8BF7\u6539\u7528 computer_screenshot + image_analyze\u3002",
    inputSchema: {
      type: "object",
      properties: {
        imageBase64: { type: "string", description: "\u622A\u56FE\u7684 base64\uFF1B\u4E0D\u4F20\u5219\u81EA\u52A8\u622A\u53D6\u5F53\u524D\u5C4F\u5E55" }
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const words = await service.ocr(typeof args.imageBase64 === "string" ? args.imageBase64 : void 0);
      return { words };
    }
  };
}
function actionTool(service) {
  return {
    name: "computer_action",
    description: "\u6267\u884C\u4E00\u4E2A\u684C\u9762\u52A8\u4F5C\u3002action \u53D6\u503C\uFF1Aclick\uFF08\u5DE6\u952E\u5355\u51FB\uFF0C\u9700 x/y \u5C4F\u5E55\u5750\u6807\uFF09\u3001doubleClick\uFF08\u53CC\u51FB\uFF0C\u9700 x/y\uFF09\u3001type\uFF08\u5728\u5F53\u524D\u7126\u70B9\u8F93\u5165\u6587\u5B57\uFF0C\u9700 text\uFF09\u3001key\uFF08\u6309\u4E0B\u6309\u952E\uFF0C\u5982 enter/tab/space/escape/up/down \u7B49\uFF0C\u9700 key\uFF09\u3001scroll\uFF08\u6EDA\u52A8\uFF0Cdirection \u4E3A up/down\uFF0C\u53EF\u9009 amount \u884C\u6570\uFF09\u3002\u5750\u6807\u5FC5\u987B\u5148\u7531 computer_screenshot + computer_ocr/\u89C6\u89C9\u5206\u6790\u83B7\u5F97\uFF0C\u7981\u6B62\u731C\u6D4B\u3002",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "doubleClick", "type", "key", "scroll"], description: "\u52A8\u4F5C\u7C7B\u578B" },
        x: { type: "number", description: "\u5C4F\u5E55 x \u5750\u6807\uFF08click/doubleClick \u5FC5\u586B\uFF09" },
        y: { type: "number", description: "\u5C4F\u5E55 y \u5750\u6807\uFF08click/doubleClick \u5FC5\u586B\uFF09" },
        text: { type: "string", description: "\u8981\u8F93\u5165\u7684\u6587\u672C\uFF08type \u5FC5\u586B\uFF09" },
        key: { type: "string", description: "\u6309\u952E\u540D\uFF08key \u5FC5\u586B\uFF09" },
        direction: { type: "string", enum: ["up", "down"], description: "\u6EDA\u52A8\u65B9\u5411\uFF08scroll \u5FC5\u586B\uFF09" },
        amount: { type: "number", description: "\u6EDA\u52A8\u884C\u6570\uFF08scroll \u53EF\u9009\uFF0C\u9ED8\u8BA4 3\uFF09" }
      },
      required: ["action"]
    },
    riskLevel: "irreversible",
    approvalRequired: true,
    execute: async (args) => {
      const action = parseAction(args);
      switch (action.action) {
        case "click":
          await service.clickAt(action.x, action.y);
          break;
        case "doubleClick":
          await service.doubleClickAt(action.x, action.y);
          break;
        case "type":
          await service.typeText(action.text);
          break;
        case "key":
          await service.pressKey(action.key);
          break;
        case "scroll":
          await service.scroll(action.direction, action.amount);
          break;
      }
      return { ok: true, action: action.action };
    }
  };
}
function parseAction(args) {
  const action = String(args.action ?? "");
  switch (action) {
    case "click": {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer_action click \u9700\u8981\u6709\u6548\u7684 x/y \u5750\u6807");
      return { action: "click", x, y };
    }
    case "doubleClick": {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("computer_action doubleClick \u9700\u8981\u6709\u6548\u7684 x/y \u5750\u6807");
      return { action: "doubleClick", x, y };
    }
    case "type": {
      const text = String(args.text ?? "");
      if (!text) throw new Error("computer_action type \u9700\u8981 text \u53C2\u6570");
      return { action: "type", text };
    }
    case "key": {
      const key = String(args.key ?? "");
      if (!key) throw new Error("computer_action key \u9700\u8981 key \u53C2\u6570");
      return { action: "key", key };
    }
    case "scroll": {
      const direction = args.direction === "down" ? "down" : "up";
      const amount = args.amount === void 0 ? void 0 : Number(args.amount);
      return { action: "scroll", direction, amount };
    }
    default:
      throw new Error(`computer_action \u4E0D\u652F\u6301\u7684 action: ${action || "\uFF08\u7A7A\uFF09"}`);
  }
}

// ../../packages/computer-use/src/skill.ts
function createComputerUseSkill(service, uploadImage) {
  const actions = createComputerUseTools(service, uploadImage).map((tool) => toSkillAction(tool));
  return {
    id: "computer-use",
    name: "\u7535\u8111\u4F7F\u7528",
    description: "\u64CD\u4F5C\u7535\u8111\u684C\u9762\uFF08\u622A\u56FE / OCR \u5B9A\u4F4D / \u9F20\u6807\u952E\u76D8 / \u6EDA\u52A8\uFF09\uFF0C\u7528\u4E8E\u684C\u9762\u5E94\u7528\u4EA4\u4E92\u4E0E\u7CFB\u7EDF\u64CD\u4F5C",
    source: "builtin",
    instructions: [
      "\u5F53\u9700\u8981\u622A\u53D6\u684C\u9762\u5C4F\u5E55\u3001\u8BC6\u522B\u754C\u9762\u6587\u5B57\u3001\u70B9\u51FB/\u64CD\u4F5C\u684C\u9762\u5E94\u7528\u6216\u7CFB\u7EDF UI \u65F6\u4F7F\u7528\u3002",
      "",
      "\u94C1\u5F8B\uFF1A\u5FC5\u987B\u5148\u622A\u56FE\u8BC6\u522B\u518D\u884C\u52A8\uFF0C\u7981\u6B62\u4E0D\u622A\u56FE\u76F4\u63A5\u76F2\u64CD\u4F5C\u3002",
      "",
      "\u5B8C\u6574\u95ED\u73AF\uFF1A",
      "1. skill_run('computer-use', 'screenshot', {}) \u622A\u53D6\u5F53\u524D\u5C4F\u5E55\uFF0C\u8FD4\u56DE imageUrl\uFF08https \u94FE\u63A5\uFF09\u3002",
      "2. skill_run('computer-use', 'ocr', {}) \u8BC6\u522B\u6587\u5B57\u53CA\u7CBE\u786E\u5750\u6807\uFF08\u6587\u5B57\u7C7B\u6309\u94AE/\u83DC\u5355\u7528\u5B83\u5B9A\u4F4D\uFF0C\u514D\u731C\u5750\u6807\uFF09\uFF1B\u7EAF\u56FE\u6807\u518D\u7528 image_analyze \u89C6\u89C9\u5206\u6790\u3002",
      "3. skill_run('computer-use', 'action', {action, x, y / text / key ...}) \u6267\u884C\u70B9\u51FB/\u8F93\u5165/\u6309\u952E\u3002",
      "4. \u518D\u6B21 screenshot \u9A8C\u8BC1\u7ED3\u679C\u3002",
      "",
      "action \u7684\u5750\u6807\u5FC5\u987B\u6765\u81EA screenshot + ocr \u7684\u7ED3\u679C\uFF0C\u7981\u6B62\u731C\u6D4B\u3002",
      "\u6CE8\u610F\uFF1Aaction\uFF08\u70B9\u51FB/\u8F93\u5165/\u6309\u952E\uFF09\u4E3A\u4E0D\u53EF\u9006\u684C\u9762\u64CD\u4F5C\uFF0C\u9ED8\u8BA4\u4F1A\u8BF7\u6C42\u7528\u6237\u786E\u8BA4\u3002"
    ].join("\n"),
    actions
  };
}
function toSkillAction(tool) {
  const props = tool.inputSchema.properties ?? {};
  const params = {};
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? "";
  }
  const required = tool.inputSchema.required ?? [];
  return {
    name: tool.name.replace(/^computer_/, ""),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute
  };
}

// ../../packages/computer-use/src/darwin.ts
import { promises as fs7 } from "fs";
import { exec as execCallback2 } from "child_process";
import { promisify as promisify2 } from "util";
var execAsync = promisify2(execCallback2);
var OCR_SWIFT = `
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count > 1 else { print("[]"); exit(0) }
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cg = rep.cgImage else { print("[]"); exit(0) }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch { print("[]"); exit(0) }

let w = CGFloat(cg.width)
let h = CGFloat(cg.height)
let words: [[String: Any]] = (request.results ?? []).compactMap { obs in
    guard let cand = obs.topCandidates(1).first else { return nil }
    let box = obs.boundingBox
    // Vision \u539F\u70B9\u5728\u5DE6\u4E0B\u89D2\uFF0C\u8F6C\u4E3A\u5DE6\u4E0A\u89D2\u539F\u70B9 + \u50CF\u7D20\u5750\u6807
    let x0 = box.minX * w
    let y0 = (1 - box.maxY) * h
    let x1 = box.maxX * w
    let y1 = (1 - box.minY) * h
    return ["text": cand.string, "x0": x0, "y0": y0, "x1": x1, "y1": y1, "confidence": cand.confidence]
}
do {
    let data = try JSONSerialization.data(withJSONObject: words)
    if let s = String(data: data, encoding: .utf8) { print(s) } else { print("[]") }
} catch { print("[]") }
`;
async function ocrImage(path3) {
  const scriptPath = `/tmp/shanhai-ocr-${process.pid}.swift`;
  try {
    await fs7.writeFile(scriptPath, OCR_SWIFT, "utf8");
    const { stdout } = await execAsync(`swift "${scriptPath}" "${path3}"`, { timeout: 3e4 });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  } finally {
    await fs7.rm(scriptPath, { force: true }).catch(() => void 0);
  }
}
function keyCode(key) {
  const map = {
    enter: 36,
    return: 36,
    space: 49,
    tab: 48,
    escape: 53,
    esc: 53,
    left: 123,
    right: 124,
    up: 126,
    down: 125
  };
  return map[key.toLowerCase()] ?? 0;
}
function createDarwinComputerUseService() {
  const screenshotToFile2 = async () => {
    const tmp = `/tmp/shanhai-shot-${Date.now()}.png`;
    await execAsync(`screencapture -xC "${tmp}"`);
    return tmp;
  };
  const clickAtOsascript = (x, y) => `osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`;
  return {
    screenshot: async () => {
      const tmp = await screenshotToFile2();
      try {
        const buf = await fs7.readFile(tmp);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } finally {
        await fs7.rm(tmp, { force: true }).catch(() => void 0);
      }
    },
    clickAt: async (x, y) => {
      await execAsync(clickAtOsascript(x, y)).catch(() => void 0);
    },
    doubleClickAt: async (x, y) => {
      await execAsync(
        `${clickAtOsascript(x, y)} -e 'delay 0.06' -e 'tell application "System Events" to click at {${x}, ${y}}'`
      ).catch(() => void 0);
    },
    typeText: async (text) => {
      await execAsync(`osascript -e 'tell application "System Events" to keystroke ${JSON.stringify(text)}'`).catch(
        () => void 0
      );
    },
    pressKey: async (key) => {
      await execAsync(`osascript -e 'tell application "System Events" to key code ${keyCode(key)}'`).catch(
        () => void 0
      );
    },
    scroll: async (direction, amount) => {
      const code = direction === "down" ? 125 : 126;
      const times = Math.max(1, Math.min(Math.round(amount ?? 3), 20));
      for (let i = 0; i < times; i++) {
        await execAsync(`osascript -e 'tell application "System Events" to key code ${code}'`).catch(() => void 0);
      }
    },
    ocr: async (imageBase64) => {
      let tmp = "";
      try {
        if (imageBase64) {
          tmp = `/tmp/shanhai-ocr-${Date.now()}.png`;
          await fs7.writeFile(tmp, Buffer.from(imageBase64, "base64"));
        } else {
          tmp = await screenshotToFile2();
        }
        return await ocrImage(tmp);
      } finally {
        if (tmp) await fs7.rm(tmp, { force: true }).catch(() => void 0);
      }
    }
  };
}

// ../../packages/computer-use/src/win32.ts
import { promises as fs9 } from "fs";
import { tmpdir } from "os";
import { join as join8 } from "path";
import { exec as execCallback3 } from "child_process";
import { promisify as promisify3 } from "util";

// ../../packages/computer-use/src/ocr-tesseract.ts
import { promises as fs8 } from "fs";
import { homedir as homedir4 } from "os";
import { join as join7 } from "path";
var workerPromise = null;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      const tessdataDir = join7(homedir4(), ".shanhai", "tessdata");
      await fs8.mkdir(tessdataDir, { recursive: true });
      return createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
        cachePath: tessdataDir,
        logger: () => void 0
      });
    })();
  }
  return workerPromise;
}
function extractWords(page) {
  const result = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          if (!word.text || word.text.trim().length === 0) continue;
          result.push({
            text: word.text,
            x0: word.bbox.x0,
            y0: word.bbox.y0,
            x1: word.bbox.x1,
            y1: word.bbox.y1,
            confidence: word.confidence
          });
        }
      }
    }
  }
  return result;
}
async function ocrTesseract(imagePath) {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(imagePath);
    return extractWords(data);
  } catch {
    return [];
  }
}

// ../../packages/computer-use/src/win32.ts
var execAsync2 = promisify3(execCallback3);
var PS = "powershell.exe";
async function runPs(script, args = []) {
  const file = join8(tmpdir(), `shanhai-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    await fs9.writeFile(file, script, "utf8");
    const argStr = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(" ");
    await execAsync2(`${PS} -NoProfile -ExecutionPolicy Bypass -File "${file}" ${argStr}`);
  } finally {
    await fs9.rm(file, { force: true }).catch(() => void 0);
  }
}
var SHOT_PS = `
param([string]$OutPath)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CursorCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO {
    public int cbSize;
    public int flags;
    public IntPtr hCursor;
    public POINT ptScreenPos;
  }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool DrawIcon(IntPtr hdc, int x, int y, IntPtr hIcon);
}
"@
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
# \u5149\u6807\u5C5E\u4E8E GDI \u8986\u76D6\u5C42\uFF0CCopyFromScreen \u4E0D\u4F1A\u62F7\u8FDB\u6765\uFF0C\u9700\u7528 GetCursorInfo \u624B\u52A8\u8BFB\u53D6\u5E76\u7ED8\u5236
$ci = New-Object CursorCapture+CURSORINFO
$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][CursorCapture+CURSORINFO])
if ([CursorCapture]::GetCursorInfo([ref]$ci) -and (($ci.flags -band 1) -eq 1)) {
  $hdc = $g.GetHdc()
  [void][CursorCapture]::DrawIcon($hdc, ($ci.ptScreenPos.X - $bounds.X), ($ci.ptScreenPos.Y - $bounds.Y), $ci.hCursor)
  $g.ReleaseHdc($hdc)
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;
var CLICK_PS = `
param([int]$X, [int]$Y, [int]$Clicks = 1)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[WinInput]::SetCursorPos($X, $Y)
for ($i = 0; $i -lt $Clicks; $i++) {
  [WinInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [WinInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  if ($Clicks -gt 1) { Start-Sleep -Milliseconds 60 }
}
`;
var TYPE_PS = `
param([string]$TextB64)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$Text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
Set-Clipboard -Value $Text
[WinInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[WinInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`;
var KEY_PS = `
param([int]$Vk)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[WinInput]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero)
[WinInput]::keybd_event($Vk, 0, 2, [UIntPtr]::Zero)
`;
var SCROLL_PS = `
param([int]$Delta)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[WinInput]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)
`;
function winKeyCode(key) {
  const map = {
    enter: 13,
    return: 13,
    space: 32,
    tab: 9,
    escape: 27,
    esc: 27,
    left: 37,
    right: 39,
    up: 38,
    down: 40
  };
  return map[key.toLowerCase()] ?? 0;
}
function createWin32ComputerUseService() {
  const screenshotToFile2 = async () => {
    const tmp = join8(tmpdir(), `shanhai-shot-${Date.now()}.png`);
    await runPs(SHOT_PS, [tmp]);
    return tmp;
  };
  return {
    screenshot: async () => {
      const tmp = await screenshotToFile2();
      try {
        const buf = await fs9.readFile(tmp);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } finally {
        await fs9.rm(tmp, { force: true }).catch(() => void 0);
      }
    },
    clickAt: async (x, y) => {
      await runPs(CLICK_PS, [String(Math.round(x)), String(Math.round(y)), "1"]).catch(() => void 0);
    },
    doubleClickAt: async (x, y) => {
      await runPs(CLICK_PS, [String(Math.round(x)), String(Math.round(y)), "2"]).catch(() => void 0);
    },
    typeText: async (text) => {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      await runPs(TYPE_PS, [b64]).catch(() => void 0);
    },
    pressKey: async (key) => {
      const vk = winKeyCode(key);
      if (!vk) return;
      await runPs(KEY_PS, [String(vk)]).catch(() => void 0);
    },
    scroll: async (direction, amount) => {
      const lines = Math.max(1, Math.min(Math.round(amount ?? 3), 20));
      const delta = (direction === "down" ? -1 : 1) * lines * 120;
      await runPs(SCROLL_PS, [String(delta)]).catch(() => void 0);
    },
    ocr: async (imageBase64) => {
      let tmp = "";
      try {
        if (imageBase64) {
          tmp = join8(tmpdir(), `shanhai-ocr-${Date.now()}.png`);
          await fs9.writeFile(tmp, Buffer.from(imageBase64, "base64"));
        } else {
          tmp = await screenshotToFile2();
        }
        return await ocrTesseract(tmp);
      } finally {
        if (tmp) await fs9.rm(tmp, { force: true }).catch(() => void 0);
      }
    }
  };
}

// ../../packages/computer-use/src/linux.ts
import { promises as fs10 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join9 } from "path";
import { exec as execCallback4 } from "child_process";
import { promisify as promisify4 } from "util";
var execAsync3 = promisify4(execCallback4);
function linuxKeyName(key) {
  const map = {
    enter: "Return",
    return: "Return",
    space: "space",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    left: "Left",
    right: "Right",
    up: "Up",
    down: "Down"
  };
  return map[key.toLowerCase()] ?? "";
}
async function screenshotToFile() {
  const tmp = join9(tmpdir2(), `shanhai-shot-${Date.now()}.png`);
  const candidates = [`scrot -p "${tmp}"`, `gnome-screenshot -p -f "${tmp}"`, `import -window root "${tmp}"`];
  let lastErr;
  for (const cmd of candidates) {
    try {
      await execAsync3(cmd, { timeout: 1e4 });
      return tmp;
    } catch (err) {
      lastErr = err;
    }
  }
  await fs10.rm(tmp, { force: true }).catch(() => void 0);
  throw lastErr instanceof Error ? lastErr : new Error("Linux \u622A\u56FE\u5931\u8D25\uFF1A\u7F3A\u5C11 import/scrot/gnome-screenshot");
}
function createLinuxComputerUseService() {
  return {
    screenshot: async () => {
      const tmp = await screenshotToFile();
      try {
        const buf = await fs10.readFile(tmp);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } finally {
        await fs10.rm(tmp, { force: true }).catch(() => void 0);
      }
    },
    clickAt: async (x, y) => {
      await execAsync3(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click 1`).catch(() => void 0);
    },
    doubleClickAt: async (x, y) => {
      await execAsync3(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click --repeat 2 --delay 60 1`).catch(
        () => void 0
      );
    },
    typeText: async (text) => {
      await execAsync3(`xdotool type --delay 20 -- ${JSON.stringify(text)}`).catch(() => void 0);
    },
    pressKey: async (key) => {
      const name = linuxKeyName(key);
      if (!name) return;
      await execAsync3(`xdotool key ${name}`).catch(() => void 0);
    },
    scroll: async (direction, amount) => {
      const times = Math.max(1, Math.min(Math.round(amount ?? 3), 20));
      const btn = direction === "down" ? "5" : "4";
      for (let i = 0; i < times; i++) {
        await execAsync3(`xdotool click ${btn}`).catch(() => void 0);
      }
    },
    ocr: async (imageBase64) => {
      let tmp = "";
      try {
        if (imageBase64) {
          tmp = join9(tmpdir2(), `shanhai-ocr-${Date.now()}.png`);
          await fs10.writeFile(tmp, Buffer.from(imageBase64, "base64"));
        } else {
          tmp = await screenshotToFile();
        }
        return await ocrTesseract(tmp);
      } finally {
        if (tmp) await fs10.rm(tmp, { force: true }).catch(() => void 0);
      }
    }
  };
}

// ../../packages/computer-use/src/platform.ts
function createPlatformComputerUseService() {
  switch (process.platform) {
    case "darwin":
      return createDarwinComputerUseService();
    case "win32":
      return createWin32ComputerUseService();
    case "linux":
      return createLinuxComputerUseService();
    default:
      return createMockComputerUseService();
  }
}

// ../../packages/browser-use/src/browser-use.ts
function createMockBrowserUseService() {
  const empty = { appId: "default", url: "", title: "" };
  return {
    list: async () => [empty],
    create: async () => "default",
    navigate: async () => {
    },
    screenshot: async () => new ArrayBuffer(0),
    click: async () => {
    },
    type: async () => {
    },
    getContent: async () => "",
    evaluate: async () => void 0,
    getInfo: async () => ({ url: "", title: "", viewport: { width: 0, height: 0 } }),
    wait: async () => {
    },
    scroll: async () => {
    },
    getConsoleLogs: async () => [],
    getNetworkRequests: async () => [],
    getCookies: async () => [],
    setCookie: async () => {
    },
    clearCookies: async () => {
    },
    show: async () => {
    },
    close: async () => {
    },
    setShowOnCreate: () => {
    }
  };
}

// ../../packages/browser-use/src/tools.ts
function createBrowserUseTools(service, uploadImage) {
  return [
    createTool(service),
    listTool(service),
    navigateTool(service),
    closeTool(service),
    screenshotTool2(service, uploadImage),
    getInfoTool(service),
    getContentTool(service),
    evaluateTool(service),
    clickTool(service),
    typeTool(service),
    scrollTool(service),
    waitTool(service),
    consoleLogsTool(service),
    networkRequestsTool(service),
    getCookiesTool(service),
    setCookieTool(service),
    clearCookiesTool(service)
  ];
}
var appIdProp = { appId: { type: "string", description: "\u6D4F\u89C8\u5668\u7A97\u53E3\u77ED\u6807\u8BC6\uFF0C\u9ED8\u8BA4 default\uFF08\u5355\u7A97\u53E3\u65F6\u7701\u7565\uFF09" } };
function createTool(service) {
  return {
    name: "browser_create",
    description: "\u521B\u5EFA\u65B0\u7684\u6D4F\u89C8\u5668\u7A97\u53E3\uFF0C\u8FD4\u56DE\u7A97\u53E3\u6807\u8BC6 appId\u3002\u9700\u8981\u540C\u65F6\u6253\u5F00\u591A\u4E2A\u9875\u9762\u3001\u6216\u5F00\u542F\u4E00\u4E2A\u72EC\u7ACB\u7A97\u53E3\u65F6\u4F7F\u7528\u3002url \u5FC5\u586B\uFF08\u521B\u5EFA\u540E\u7ACB\u5373\u6253\u5F00\u8BE5\u7F51\u5740\uFF0C\u907F\u514D\u7A7A\u767D\u7A97\u53E3\uFF09\uFF1B\u4F20\u5165 title \u7ED9\u7A97\u53E3\u6807\u6CE8\u7528\u9014\uFF08\u5982\u300C\u767B\u5F55\u9875\u300D\u300C\u6570\u636E\u91C7\u96C6\u300D\uFF09\uFF0C\u65B9\u4FBF\u540E\u7EED\u7528 browser_list \u533A\u5206\u5404\u7A97\u53E3\u7528\u9014\u3002\u540E\u7EED browser_navigate / browser_click \u7B49\u64CD\u4F5C\u7528\u8FD4\u56DE\u7684 appId \u5B9A\u4F4D\u8BE5\u7A97\u53E3\u3002",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "\u81EA\u5B9A\u4E49\u7A97\u53E3\u77ED\u6807\u8BC6\uFF08\u53EF\u9009\uFF0C\u7701\u7565\u5219\u81EA\u52A8\u751F\u6210 default/win-2/win-3\u2026\uFF09" },
        url: { type: "string", description: "\u521B\u5EFA\u540E\u7ACB\u5373\u6253\u5F00\u7684\u521D\u59CB URL\uFF08\u5FC5\u586B\uFF09" },
        title: { type: "string", description: "\u7A97\u53E3\u7528\u9014\u63CF\u8FF0\uFF08\u53EF\u9009\uFF0C\u5982\u300C\u767B\u5F55\u9875\u300D\u300C\u6570\u636E\u91C7\u96C6\u300D\uFF0C\u4F9B AI \u533A\u5206\u591A\u7A97\u53E3\u7528\u9014\uFF09" }
      },
      required: ["url"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw new Error("browser_create \u9700\u8981 url \u53C2\u6570\uFF1A\u521B\u5EFA\u6D4F\u89C8\u5668\u7A97\u53E3\u5FC5\u987B\u6307\u5B9A\u8981\u6253\u5F00\u7684\u7F51\u5740\uFF0C\u907F\u514D\u6253\u5F00\u7A7A\u767D\u7A97\u53E3");
      const appId = await service.create(
        typeof args.appId === "string" && args.appId ? args.appId : void 0,
        url,
        typeof args.title === "string" && args.title ? args.title : void 0
      );
      return { ok: true, appId };
    }
  };
}
function listTool(service) {
  return {
    name: "browser_list",
    description: "\u5217\u51FA\u5F53\u524D\u6253\u5F00\u7684\u6D4F\u89C8\u5668\u7A97\u53E3\uFF08appId / URL / \u6807\u9898\uFF09\u3002\u591A\u7A97\u53E3\u64CD\u4F5C\u524D\u5148\u8C03\u7528\u5B83\u786E\u8BA4\u76EE\u6807\u7A97\u53E3\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "readonly",
    execute: async (args) => {
      const windows2 = await service.list();
      const prefix = typeof args.appId === "string" && args.appId ? args.appId : void 0;
      const filtered = prefix ? windows2.filter((w) => w.appId === prefix || w.appId.startsWith(`${prefix}:`)) : windows2;
      return { windows: filtered };
    }
  };
}
function navigateTool(service) {
  return {
    name: "browser_navigate",
    description: "\u5728\u5185\u7F6E\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00\u6307\u5B9A URL\uFF08\u5982 https://example.com \u6216 http://localhost:3000\uFF09\u3002\u6253\u5F00\u672C\u5730\u524D\u7AEF\u9875\u9762\u3001\u8BBF\u95EE\u7F51\u7AD9\u3001\u8FDB\u5165\u67D0\u4E2A\u7F51\u9875\u65F6\u4F7F\u7528\u3002",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "\u8981\u6253\u5F00\u7684\u5B8C\u6574 URL" },
        ...appIdProp
      },
      required: ["url"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const url = String(args.url ?? "");
      if (!url) throw new Error("browser_navigate \u9700\u8981 url \u53C2\u6570");
      await service.navigate(url, typeof args.appId === "string" ? args.appId : void 0);
      return { ok: true, url };
    }
  };
}
function closeTool(service) {
  return {
    name: "browser_close",
    description: "\u5173\u95ED\u6307\u5B9A\u6D4F\u89C8\u5668\u7A97\u53E3\uFF0C\u91CA\u653E\u8D44\u6E90\u3002\u4E0D\u518D\u9700\u8981\u8BE5\u7A97\u53E3\u65F6\u8C03\u7528\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "reversible",
    execute: async (args) => {
      await service.close(typeof args.appId === "string" ? args.appId : void 0);
      return { ok: true };
    }
  };
}
function screenshotTool2(service, uploadImage) {
  return {
    name: "browser_screenshot",
    description: "\u622A\u53D6\u5F53\u524D\u6D4F\u89C8\u5668\u9875\u9762\uFF0C\u8FD4\u56DE\u622A\u56FE\u94FE\u63A5\uFF08\u4E0A\u4F20\u4E91\u5B58\u50A8\u540E\u7684 https URL\uFF09\u3002\u4EC5\u5728\u9700\u8981\u89C6\u89C9\u786E\u8BA4\u65F6\u4F7F\u7528\uFF08\u5982\u9A8C\u8BC1 UI \u663E\u793A\u6548\u679C\uFF09\uFF0C\u622A\u56FE\u524D\u5FC5\u987B\u6709\u660E\u786E\u76EE\u7684\u3002\u914D\u5408 image_analyze \u5206\u6790\u622A\u56FE\u5185\u5BB9\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "readonly",
    execute: async (args) => {
      const buf = await service.screenshot(typeof args.appId === "string" ? args.appId : void 0);
      const bytes = new Uint8Array(buf);
      const base64 = Buffer.from(bytes).toString("base64");
      if (uploadImage) {
        try {
          const url = await uploadImage(base64);
          if (url) return { imageUrl: url, byteLength: bytes.length };
        } catch {
        }
      }
      return { imageBase64: base64, byteLength: bytes.length };
    }
  };
}
function getInfoTool(service) {
  return {
    name: "browser_get_info",
    description: "\u83B7\u53D6\u5F53\u524D\u9875\u9762\u57FA\u7840\u4FE1\u606F\uFF08URL / \u6807\u9898 / \u89C6\u53E3\u5C3A\u5BF8\uFF09\u3002\u786E\u8BA4\u9875\u9762\u662F\u5426\u52A0\u8F7D\u5230\u76EE\u6807\u5730\u5740\u65F6\u4F7F\u7528\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "readonly",
    execute: async (args) => {
      return service.getInfo(typeof args.appId === "string" ? args.appId : void 0);
    }
  };
}
function getContentTool(service) {
  return {
    name: "browser_get_content",
    description: "\u8BFB\u53D6\u5F53\u524D\u9875\u9762\u5185\u5BB9\u3002selector \u9650\u5B9A\u8303\u56F4\uFF08CSS \u9009\u62E9\u5668\uFF09\uFF1BincludeHtml=true \u8FD4\u56DE HTML \u800C\u975E\u7EAF\u6587\u672C\u3002\u63D0\u53D6\u6570\u636E/\u6587\u672C\u3001\u5206\u6790\u9875\u9762\u7ED3\u6784\u65F6\u4F18\u5148\u7528\u5B83\u800C\u975E\u622A\u56FE\u3002",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u9650\u5B9A\u8981\u63D0\u53D6\u7684\u5143\u7D20\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u6574\u4E2A\u9875\u9762\uFF09" },
        includeHtml: { type: "boolean", description: "\u662F\u5426\u8FD4\u56DE HTML\uFF08\u9ED8\u8BA4 false \u8FD4\u56DE\u7EAF\u6587\u672C\uFF09" },
        ...appIdProp
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const text = await service.getContent(
        typeof args.selector === "string" ? args.selector : void 0,
        typeof args.appId === "string" ? args.appId : void 0,
        args.includeHtml === true
      );
      return { content: text };
    }
  };
}
function evaluateTool(service) {
  return {
    name: "browser_evaluate",
    description: "\u5728\u9875\u9762\u4E0A\u4E0B\u6587\u6267\u884C JS \u8868\u8FBE\u5F0F\u5E76\u8FD4\u56DE\u7ED3\u679C\u3002\u7528\u4E8E\u63D0\u53D6 DOM \u6570\u636E\u3001\u8BFB\u53D6\u53D8\u91CF\u3001\u5206\u6790\u9875\u9762\u7ED3\u6784\uFF08\u5982 document.title\u3001document.querySelectorAll(...)\uFF09\uFF0C\u6548\u7387\u9AD8\u4E8E\u622A\u56FE\u3002",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "\u8981\u6267\u884C\u7684 JS \u8868\u8FBE\u5F0F\uFF08\u53EF\u5E26 return\uFF09" },
        ...appIdProp
      },
      required: ["code"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const code = String(args.code ?? "");
      if (!code) throw new Error("browser_evaluate \u9700\u8981 code \u53C2\u6570");
      const result = await service.evaluate(code, typeof args.appId === "string" ? args.appId : void 0);
      return { result: stringifyResult(result) };
    }
  };
}
function clickTool(service) {
  return {
    name: "browser_click",
    description: "\u70B9\u51FB\u9875\u9762\u5143\u7D20\uFF08\u6309 CSS \u9009\u62E9\u5668\u5B9A\u4F4D\uFF0C\u5982 #submit\u3001button.login\u3001[data-testid=ok]\uFF09\u3002\u6D4F\u89C8\u5668\u7528\u4E8E\u6D4B\u8BD5/\u67E5\u8D44\u6599\uFF0C\u65E0\u9700\u5BA1\u6279\uFF0C\u76F4\u63A5\u6267\u884C\u3002",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "\u76EE\u6807\u5143\u7D20\u7684 CSS \u9009\u62E9\u5668" },
        ...appIdProp
      },
      required: ["selector"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const selector = String(args.selector ?? "");
      if (!selector) throw new Error("browser_click \u9700\u8981 selector \u53C2\u6570");
      await service.click(selector, typeof args.appId === "string" ? args.appId : void 0);
      return { ok: true, selector };
    }
  };
}
function typeTool(service) {
  return {
    name: "browser_type",
    description: "\u5411\u8F93\u5165\u5143\u7D20\uFF08input/textarea\uFF09\u8F93\u5165\u6587\u672C\u3002selector \u5B9A\u4F4D\u76EE\u6807\u8F93\u5165\u6846\uFF1Bclear=true \u5148\u6E05\u7A7A\u539F\u5185\u5BB9\u518D\u8F93\u5165\u3002\u586B\u8868\u5355\u3001\u641C\u7D22\u3001\u767B\u5F55\u7B49\u573A\u666F\u4F7F\u7528\u3002",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "\u76EE\u6807\u8F93\u5165\u5143\u7D20\u7684 CSS \u9009\u62E9\u5668" },
        text: { type: "string", description: "\u8981\u8F93\u5165\u7684\u6587\u672C" },
        clear: { type: "boolean", description: "\u662F\u5426\u5148\u6E05\u7A7A\uFF08\u9ED8\u8BA4 true\uFF09" },
        ...appIdProp
      },
      required: ["selector", "text"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const selector = String(args.selector ?? "");
      const text = String(args.text ?? "");
      if (!selector) throw new Error("browser_type \u9700\u8981 selector \u53C2\u6570");
      await service.type(
        selector,
        text,
        typeof args.appId === "string" ? args.appId : void 0,
        args.clear !== false
      );
      return { ok: true, selector };
    }
  };
}
function scrollTool(service) {
  return {
    name: "browser_scroll",
    description: "\u6EDA\u52A8\u9875\u9762\u6216\u6307\u5B9A\u5143\u7D20\u3002direction \u4E3A up/down/left/right\uFF1Bamount \u4E3A\u6EDA\u52A8\u50CF\u7D20\uFF08\u9ED8\u8BA4 300\uFF09\uFF1Bselector \u6307\u5B9A\u6EDA\u52A8\u5BB9\u5668\uFF08\u9ED8\u8BA4 window\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "\u6EDA\u52A8\u65B9\u5411" },
        amount: { type: "number", description: "\u6EDA\u52A8\u50CF\u7D20\uFF08\u9ED8\u8BA4 300\uFF09" },
        selector: { type: "string", description: "\u6EDA\u52A8\u5BB9\u5668\u9009\u62E9\u5668\uFF08\u9ED8\u8BA4 window\uFF09" },
        ...appIdProp
      },
      required: ["direction"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const direction = ["up", "down", "left", "right"].includes(args.direction) ? args.direction : "down";
      await service.scroll(
        direction,
        typeof args.appId === "string" ? args.appId : void 0,
        typeof args.amount === "number" ? args.amount : void 0,
        typeof args.selector === "string" ? args.selector : void 0
      );
      return { ok: true, direction };
    }
  };
}
function waitTool(service) {
  return {
    name: "browser_wait",
    description: "\u7B49\u5F85\u6307\u5B9A\u5143\u7D20\u51FA\u73B0\uFF08\u8F6E\u8BE2\u68C0\u67E5 CSS \u9009\u62E9\u5668\uFF09\u3002\u9875\u9762\u8DF3\u8F6C\u6216\u5F02\u6B65\u52A0\u8F7D\u540E\uFF0C\u5148\u7B49\u5173\u952E\u5143\u7D20\u5C31\u7EEA\u518D\u64CD\u4F5C\u3002",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "\u8981\u7B49\u5F85\u7684\u5143\u7D20 CSS \u9009\u62E9\u5668" },
        timeoutMs: { type: "number", description: "\u8D85\u65F6\u6BEB\u79D2\uFF08\u9ED8\u8BA4 10000\uFF09" },
        ...appIdProp
      },
      required: ["selector"]
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const selector = String(args.selector ?? "");
      if (!selector) throw new Error("browser_wait \u9700\u8981 selector \u53C2\u6570");
      await service.wait(
        selector,
        typeof args.appId === "string" ? args.appId : void 0,
        typeof args.timeoutMs === "number" ? args.timeoutMs : void 0
      );
      return { ok: true, selector };
    }
  };
}
function consoleLogsTool(service) {
  return {
    name: "browser_get_console_logs",
    description: "\u8BFB\u53D6\u9875\u9762\u63A7\u5236\u53F0\u65E5\u5FD7\uFF08log/warn/error\uFF09\u3002\u6392\u67E5\u9875\u9762 JS \u9519\u8BEF\u65F6\u4F18\u5148\u4F7F\u7528\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u622A\u56FE\u3002",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "\u6700\u591A\u8FD4\u56DE\u6761\u6570\uFF08\u9ED8\u8BA4 50\uFF09" },
        onlyErrors: { type: "boolean", description: "\u53EA\u8FD4\u56DE error \u7EA7\u522B\uFF08\u9ED8\u8BA4 false\uFF09" },
        ...appIdProp
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const logs = await service.getConsoleLogs(
        typeof args.appId === "string" ? args.appId : void 0,
        typeof args.limit === "number" ? args.limit : void 0,
        args.onlyErrors === true
      );
      return { logs };
    }
  };
}
function networkRequestsTool(service) {
  return {
    name: "browser_get_network_requests",
    description: "\u83B7\u53D6\u9875\u9762\u6700\u8FD1\u7684\u7F51\u7EDC\u8BF7\u6C42\u5217\u8868\uFF08URL / method / status / type\uFF09\u3002\u5206\u6790\u63A5\u53E3\u8C03\u7528\u3001\u6392\u67E5\u8BF7\u6C42\u9519\u8BEF\u65F6\u4F7F\u7528\u3002",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "\u6700\u591A\u8FD4\u56DE\u6761\u6570\uFF08\u9ED8\u8BA4 50\uFF09" },
        ...appIdProp
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const requests = await service.getNetworkRequests(
        typeof args.appId === "string" ? args.appId : void 0,
        typeof args.limit === "number" ? args.limit : void 0
      );
      return { requests };
    }
  };
}
function getCookiesTool(service) {
  return {
    name: "browser_get_cookies",
    description: "\u8BFB\u53D6\u5F53\u524D\u9875\u9762\u6240\u6709 Cookie\uFF08\u542B HttpOnly\uFF09\u3002\u9700\u8981\u590D\u7528\u767B\u5F55\u6001\u3001\u8C03\u8BD5\u4F1A\u8BDD\u65F6\u4F7F\u7528\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "readonly",
    execute: async (args) => {
      const cookies = await service.getCookies(typeof args.appId === "string" ? args.appId : void 0);
      return { cookies };
    }
  };
}
function setCookieTool(service) {
  return {
    name: "browser_set_cookie",
    description: "\u8BBE\u7F6E\u4E00\u4E2A Cookie\u3002name/value \u5FC5\u586B\uFF1Bdomain/path/secure/httpOnly/sameSite/expires \u53EF\u9009\u3002",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Cookie \u540D\u79F0" },
        value: { type: "string", description: "Cookie \u503C" },
        domain: { type: "string", description: "\u57DF\u540D\uFF08\u53EF\u9009\uFF09" },
        path: { type: "string", description: "\u8DEF\u5F84\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4 /\uFF09" },
        secure: { type: "boolean", description: "\u4EC5 HTTPS" },
        httpOnly: { type: "boolean", description: "HttpOnly" },
        sameSite: { type: "string", description: "SameSite" },
        expires: { type: "number", description: "\u8FC7\u671F\u65F6\u95F4\u6233\uFF08\u79D2\uFF09" },
        ...appIdProp
      },
      required: ["name", "value"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const cookie = {
        name: String(args.name),
        value: String(args.value),
        domain: typeof args.domain === "string" ? args.domain : void 0,
        path: typeof args.path === "string" ? args.path : void 0,
        secure: args.secure === true,
        httpOnly: args.httpOnly === true,
        sameSite: typeof args.sameSite === "string" ? args.sameSite : void 0,
        expires: typeof args.expires === "number" ? args.expires : void 0
      };
      await service.setCookie(cookie, typeof args.appId === "string" ? args.appId : void 0);
      return { ok: true, name: cookie.name };
    }
  };
}
function clearCookiesTool(service) {
  return {
    name: "browser_clear_cookies",
    description: "\u6E05\u9664\u5F53\u524D\u6D4F\u89C8\u5668\u7A97\u53E3\u6240\u6709 Cookie\u3002\u4F1A\u6E05\u7A7A\u767B\u5F55\u6001\uFF0C\u65E0\u9700\u5BA1\u6279\uFF0C\u76F4\u63A5\u6267\u884C\u3002",
    inputSchema: { type: "object", properties: { ...appIdProp } },
    riskLevel: "reversible",
    execute: async (args) => {
      await service.clearCookies(typeof args.appId === "string" ? args.appId : void 0);
      return { ok: true };
    }
  };
}
function stringifyResult(result) {
  if (result === void 0) return "undefined";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// ../../packages/browser-use/src/skill.ts
function createBrowserUseSkill(service, uploadImage) {
  const actions = createBrowserUseTools(service, uploadImage).map((tool) => toSkillAction2(tool));
  return {
    id: "browser-use",
    name: "\u6D4F\u89C8\u5668\u4F7F\u7528",
    description: "\u64CD\u4F5C\u5185\u7F6E\u6D4F\u89C8\u5668\uFF08\u5BFC\u822A / \u70B9\u51FB / \u8F93\u5165 / \u622A\u56FE / \u63D0\u53D6 / \u7F51\u7EDC / Cookie\uFF09\uFF0C\u7528\u4E8E\u6D4B\u8BD5\u4E0E\u67E5\u8D44\u6599",
    source: "builtin",
    instructions: [
      "\u5F53\u9700\u8981\u8BBF\u95EE\u7F51\u9875\u3001\u9A8C\u8BC1\u524D\u7AEF\u9875\u9762\u3001\u63D0\u53D6\u7F51\u9875\u6570\u636E\u3001\u6D4B\u8BD5\u4EA4\u4E92\u6D41\u7A0B\u65F6\u4F7F\u7528\u3002",
      "",
      "\u6267\u884C\u6B65\u9AA4\uFF1A",
      "1. \u5148 skill_run('browser-use', 'navigate', {url}) \u6253\u5F00\u76EE\u6807\u9875\u9762\u3002",
      "2. \u89C2\u5BDF\u9875\u9762\uFF1A\u4F18\u5148\u7528 get_content\uFF08\u63D0\u53D6\u6587\u672C\uFF09/ evaluate\uFF08\u6267\u884C JS\uFF09\u8BFB\u53D6\u5185\u5BB9\uFF0C\u5FC5\u8981\u65F6\u624D screenshot \u622A\u56FE\u3002",
      "3. \u622A\u56FE\u4F1A\u8FD4\u56DE imageUrl\uFF08https \u94FE\u63A5\uFF09\u3002\u5982\u9700\u7406\u89E3\u622A\u56FE\u5185\u5BB9\uFF0C\u8C03 image_analyze(imageUrl) \u5206\u6790\uFF1B\u5F53\u524D\u6A21\u578B\u652F\u6301\u89C6\u89C9\u65F6\u53EF\u76F4\u63A5\u67E5\u770B\u3002",
      "4. \u4EA4\u4E92\uFF1A\u7528 click\uFF08\u70B9\u51FB\uFF09\u3001type\uFF08\u8F93\u5165\uFF09\u64CD\u4F5C\u9875\u9762\u5143\u7D20\u3002",
      "5. \u6392\u67E5\u9519\u8BEF\uFF1A\u5148 get_console_logs \u770B\u63A7\u5236\u53F0\u3001get_network_requests \u770B\u8BF7\u6C42\uFF0C\u518D\u51B3\u5B9A\u662F\u5426\u622A\u56FE\u3002",
      "",
      "\u539F\u5219\uFF1A",
      "- \u622A\u56FE\u524D\u5FC5\u987B\u6709\u660E\u786E\u76EE\u7684\uFF0C\u7981\u6B62\u65E0\u76EE\u7684\u8FDE\u7EED\u622A\u56FE\u3002",
      "- \u9009\u62E9\u5668\u4F18\u5148\u7528\u7A33\u5B9A\u6807\u8BC6\uFF08id / name / data-testid\uFF09\uFF0C\u5176\u6B21 CSS \u9009\u62E9\u5668\u3002",
      "- \u9875\u9762\u8DF3\u8F6C/\u5F02\u6B65\u52A0\u8F7D\u540E\u7528 wait \u7B49\u5F85\u5173\u952E\u5143\u7D20\u5C31\u7EEA\u518D\u64CD\u4F5C\u3002",
      "- \u6240\u6709\u64CD\u4F5C\u514D\u5BA1\u6279\uFF0C\u76F4\u63A5\u6267\u884C\u3002",
      "",
      "\u591A\u7A97\u53E3\uFF1A\u7528 create \u521B\u5EFA\u65B0\u7A97\u53E3\uFF08\u8FD4\u56DE appId\uFF09\uFF0C\u540E\u7EED\u64CD\u4F5C\u4F20 appId \u5B9A\u4F4D\uFF1Blist \u5217\u51FA\u5F53\u524D\u7A97\u53E3\u3002"
    ].join("\n"),
    actions
  };
}
function toSkillAction2(tool) {
  const props = tool.inputSchema.properties ?? {};
  const params = {};
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? "";
  }
  const required = tool.inputSchema.required ?? [];
  return {
    name: tool.name.replace(/^browser_/, ""),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute
  };
}

// ../../packages/terminal/src/terminal.ts
function createMockTerminalService() {
  return {
    create: async () => "default",
    run: async () => ({ output: "", exitCode: 0 }),
    list: async () => [],
    close: async () => {
    },
    write: () => {
    },
    onData: () => () => {
    },
    resize: () => {
    }
  };
}

// ../../packages/terminal/src/tools.ts
function createTerminalTools(service) {
  return [createTool2(service), runTool(service), listTool2(service), closeTool2(service)];
}
var terminalIdProp = { terminalId: { type: "string", description: "\u7EC8\u7AEF\u77ED\u6807\u8BC6\uFF08create \u8FD4\u56DE\u7684 terminalId\uFF0C\u9ED8\u8BA4 default\uFF09" } };
function createTool2(service) {
  return {
    name: "terminal_create",
    description: "\u521B\u5EFA\u6301\u4E45\u7EC8\u7AEF\u4F1A\u8BDD\uFF0C\u8FD4\u56DE terminalId\u3002\u9700\u8981\u8FDE\u7EED\u6267\u884C\u591A\u6B65\u547D\u4EE4\u3001\u8DD1\u957F\u4EFB\u52A1\u3001\u6216\u4FDD\u6301\u547D\u4EE4\u95F4\u72B6\u6001\uFF08cd/export/\u540E\u53F0\u8FDB\u7A0B\uFF09\u65F6\u4F7F\u7528\u3002\u53EF\u9009\u4F20\u5165 name \u6807\u6CE8\u7528\u9014\uFF08\u5982\u300C\u6784\u5EFA\u300D\u300C\u5F00\u53D1\u670D\u52A1\u5668\u300D\uFF09\uFF0C\u65B9\u4FBF\u540E\u7EED\u533A\u5206\u591A\u7EC8\u7AEF\u7528\u9014\u3002",
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "\u81EA\u5B9A\u4E49\u7EC8\u7AEF\u77ED\u6807\u8BC6\uFF08\u53EF\u9009\uFF0C\u7701\u7565\u5219\u81EA\u52A8\u751F\u6210 default/term-2\u2026\uFF09" },
        name: { type: "string", description: "\u7EC8\u7AEF\u7528\u9014\u63CF\u8FF0\uFF08\u53EF\u9009\uFF0C\u5982\u300C\u6784\u5EFA\u300D\u300C\u5F00\u53D1\u670D\u52A1\u5668\u300D\uFF0C\u4F9B AI \u533A\u5206\u591A\u7EC8\u7AEF\u7528\u9014\uFF09" }
      }
    },
    riskLevel: "readonly",
    execute: async (args) => {
      const terminalId = await service.create(
        typeof args.terminalId === "string" && args.terminalId ? args.terminalId : void 0,
        typeof args.name === "string" && args.name ? args.name : void 0
      );
      return { ok: true, terminalId };
    }
  };
}
function runTool(service) {
  return {
    name: "terminal_run",
    description: "\u5728\u6307\u5B9A\u7EC8\u7AEF\u6267\u884C\u547D\u4EE4\u5E76\u8FD4\u56DE\u8F93\u51FA\u3002\u547D\u4EE4\u95F4\u72B6\u6001\u4FDD\u6301\uFF08cd/export/\u540E\u53F0\u8FDB\u7A0B\uFF09\uFF0C\u9002\u5408\u8FDE\u7EED\u591A\u6B65\u64CD\u4F5C\u4E0E\u957F\u4EFB\u52A1\uFF1B\u5355\u6761\u72EC\u7ACB\u547D\u4EE4\u4ECD\u4F18\u5148\u7528 run_command\u3002timeoutMs \u9ED8\u8BA4 120000 \u6BEB\u79D2\uFF1B\u547D\u4EE4\u4ECD\u5728\u540E\u53F0\u8FD0\u884C\u65F6\u8FD4\u56DE timedOut=true \u4E0E\u5DF2\u6355\u83B7\u8F93\u51FA\uFF0C\u53EF\u7EE7\u7EED\u89C2\u5BDF\u3002",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "\u8981\u6267\u884C\u7684 shell \u547D\u4EE4" },
        timeoutMs: { type: "number", description: "\u8D85\u65F6\u6BEB\u79D2\uFF08\u9ED8\u8BA4 120000\uFF09" },
        ...terminalIdProp
      },
      required: ["command"]
    },
    riskLevel: "reversible",
    execute: async (args) => {
      const command = String(args.command ?? "");
      if (!command) throw new Error("terminal_run \u9700\u8981 command \u53C2\u6570");
      const result = await service.run(
        typeof args.terminalId === "string" ? args.terminalId : void 0,
        command,
        typeof args.timeoutMs === "number" ? args.timeoutMs : void 0
      );
      return { ok: true, ...result };
    }
  };
}
function listTool2(service) {
  return {
    name: "terminal_list",
    description: "\u5217\u51FA\u5F53\u524D\u6D3B\u8DC3\u7684\u7EC8\u7AEF\u4F1A\u8BDD\uFF08terminalId / \u7528\u9014 / \u5F53\u524D\u76EE\u5F55\uFF09\u3002\u591A\u7EC8\u7AEF\u64CD\u4F5C\u524D\u5148\u8C03\u7528\u5B83\u786E\u8BA4\u76EE\u6807\u7EC8\u7AEF\u3002",
    inputSchema: { type: "object", properties: {} },
    riskLevel: "readonly",
    execute: async () => {
      const terminals = await service.list();
      return { terminals };
    }
  };
}
function closeTool2(service) {
  return {
    name: "terminal_close",
    description: "\u5173\u95ED\u6307\u5B9A\u7EC8\u7AEF\u4F1A\u8BDD\uFF0C\u91CA\u653E\u8D44\u6E90\uFF08\u542B\u5176\u4E2D\u542F\u52A8\u7684\u540E\u53F0\u8FDB\u7A0B\uFF09\u3002\u4E0D\u518D\u9700\u8981\u8BE5\u7EC8\u7AEF\u65F6\u8C03\u7528\u3002",
    inputSchema: { type: "object", properties: { ...terminalIdProp } },
    riskLevel: "reversible",
    execute: async (args) => {
      await service.close(typeof args.terminalId === "string" ? args.terminalId : void 0);
      return { ok: true };
    }
  };
}

// ../../packages/terminal/src/skill.ts
function createTerminalSkill(service) {
  const actions = createTerminalTools(service).map((tool) => toSkillAction3(tool));
  return {
    id: "terminal",
    name: "\u7EC8\u7AEF",
    description: "\u6301\u4E45\u7EC8\u7AEF\u4F1A\u8BDD\uFF08\u521B\u5EFA/\u6267\u884C\u547D\u4EE4/\u5217\u8868/\u5173\u95ED\uFF09\uFF0C\u547D\u4EE4\u95F4\u72B6\u6001\u4FDD\u6301\uFF0C\u7528\u4E8E\u591A\u6B65\u547D\u4EE4\u6267\u884C\u4E0E\u957F\u4EFB\u52A1",
    source: "builtin",
    instructions: [
      "\u5F53\u9700\u8981\u8FDE\u7EED\u6267\u884C\u591A\u6B65\u547D\u4EE4\u3001\u8DD1\u957F\u4EFB\u52A1\u3001\u6216\u9700\u8981\u547D\u4EE4\u4E4B\u95F4\u4FDD\u6301\u72B6\u6001\uFF08cd \u76EE\u5F55\u5207\u6362\u3001export \u73AF\u5883\u53D8\u91CF\u3001\u540E\u53F0\u8FDB\u7A0B\uFF09\u65F6\u4F7F\u7528\u3002",
      "",
      "\u6267\u884C\u6B65\u9AA4\uFF1A",
      `1. skill_run('terminal', 'create', { name: "\u7528\u9014" }) \u521B\u5EFA\u6301\u4E45\u7EC8\u7AEF\uFF0C\u62FF\u5230 terminalId\u3002`,
      "2. skill_run('terminal', 'run', { terminalId, command }) \u6267\u884C\u547D\u4EE4\uFF0C\u8F93\u51FA\u4F1A\u8FD4\u56DE\u3002",
      "3. \u591A\u7EC8\u7AEF\u65F6\u7528 skill_run('terminal', 'list', {}) \u786E\u8BA4\u5404\u7EC8\u7AEF\u7528\u9014\u3002",
      "4. \u4E0D\u518D\u9700\u8981\u65F6 skill_run('terminal', 'close', { terminalId }) \u91CA\u653E\u8D44\u6E90\u3002",
      "",
      "\u539F\u5219\uFF1A",
      "- \u547D\u4EE4\u95F4\u72B6\u6001\u4FDD\u6301\uFF1Acd \u540E\u540E\u7EED\u547D\u4EE4\u6CBF\u7528\u65B0\u76EE\u5F55\uFF0Cexport \u7684\u53D8\u91CF\u8DE8\u547D\u4EE4\u6709\u6548\u3002",
      "- \u957F\u4EFB\u52A1\uFF08\u7F16\u8BD1/\u8BAD\u7EC3/\u5F00\u53D1\u670D\u52A1\u5668\uFF09\uFF1Arun \u4F1A\u7B49\u5F85\u547D\u4EE4\u5B8C\u6210\u6216\u8D85\u65F6\u8FD4\u56DE\uFF08timedOut=true \u8868\u793A\u4ECD\u5728\u540E\u53F0\u8FD0\u884C\uFF09\u3002",
      "- \u5355\u6761\u72EC\u7ACB\u547D\u4EE4\uFF08\u8BFB\u6587\u4EF6/\u641C\u7D22/\u4E00\u6B21\u6027\u64CD\u4F5C\uFF09\u4ECD\u4F18\u5148\u7528 run_command\uFF0C\u4E0D\u8981\u4E3A\u5355\u6761\u547D\u4EE4\u5F00\u7EC8\u7AEF\u3002",
      "- \u6240\u6709\u64CD\u4F5C\u514D\u5BA1\u6279\uFF0C\u76F4\u63A5\u6267\u884C\u3002"
    ].join("\n"),
    actions
  };
}
function toSkillAction3(tool) {
  const props = tool.inputSchema.properties ?? {};
  const params = {};
  for (const [key, meta] of Object.entries(props)) {
    params[key] = meta?.description ?? "";
  }
  const required = tool.inputSchema.required ?? [];
  return {
    name: tool.name.replace(/^terminal_/, ""),
    description: tool.description,
    params,
    required: Array.isArray(required) ? required : [],
    riskLevel: tool.riskLevel,
    approvalRequired: tool.approvalRequired,
    execute: tool.execute
  };
}

// ../../packages/storage/src/storage.ts
import { createHash as createHash2 } from "crypto";
var DEFAULT_GATEWAY_BASE = "https://agent.bjctykj.com";
async function uploadImageToCloud(params) {
  const { imageBase64, token, gatewayBase = DEFAULT_GATEWAY_BASE, mimeType = "image/png" } = params;
  if (!imageBase64 || !token) return null;
  try {
    const bytes = Buffer.from(imageBase64, "base64");
    if (bytes.length === 0) return null;
    const hash = createHash2("sha256").update(bytes).digest("hex");
    const ext = (mimeType.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
    const fileName = `screenshot_${Date.now()}.${ext}`;
    const tokenResp = await fetchWithTimeout(
      `${gatewayBase.replace(/\/+$/, "")}/api/member/storage/upload-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ file_name: fileName, mime_type: mimeType, hash })
      }
    );
    if (!tokenResp.ok) return null;
    const tokenJson = await tokenResp.json();
    if (tokenJson.code !== 0 || !tokenJson.data) return null;
    const data = tokenJson.data;
    if (data.reused === true && data.public_url) return data.public_url;
    const formData = new FormData();
    formData.append("token", data.token);
    formData.append("key", data.key);
    formData.append("file", new Blob([bytes], { type: mimeType }), fileName);
    let uploadUrl = data.upload_url || "https://up.qiniup.com";
    let uploadResp = await fetchWithTimeout(uploadUrl, { method: "POST", body: formData });
    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => "");
      if (uploadResp.status === 400 || uploadResp.status === 405) {
        const retryHost = errText.match(/up-[a-z0-9]+\.qiniup\.com/)?.[0];
        if (retryHost) {
          uploadUrl = `https://${retryHost}`;
          uploadResp = await fetchWithTimeout(uploadUrl, { method: "POST", body: formData });
        }
      }
      if (!uploadResp.ok) return null;
    }
    const publicBaseUrl = String(data.public_base_url || "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+/.test(publicBaseUrl)) return null;
    return `${publicBaseUrl}/${data.key}`;
  } catch {
    return null;
  }
}
async function fetchWithTimeout(url, init, timeoutMs = 15e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ../runtime/src/supervisor.ts
var SUPERVISOR_ID = "supervisor";
var MODE_DESC = "\u53D1\u9001\u6A21\u5F0F\uFF1Ainsert=\u76EE\u6807\u4F1A\u8BDD\u6267\u884C\u4E2D\u65F6\u8FFD\u52A0\u9700\u6C42\uFF08\u4E0D\u6253\u65AD\u5F53\u524D\u4EFB\u52A1\uFF0C\u5728\u4E0B\u4E00\u8F6E\u6A21\u578B\u8C03\u7528\u524D\u751F\u6548\uFF09\uFF1Bqueue=\u76EE\u6807\u4F1A\u8BDD\u6267\u884C\u4E2D\u65F6\u6392\u961F\u7B49\u5F85\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F\u540E\u518D\u6267\u884C\u3002\u76EE\u6807\u4F1A\u8BDD\u7A7A\u95F2\u65F6\u4E24\u79CD\u6A21\u5F0F\u7B49\u4EF7\uFF0C\u90FD\u662F\u76F4\u63A5\u4F5C\u4E3A\u65B0\u4EFB\u52A1\u6267\u884C\u3002\u9ED8\u8BA4 insert\u3002";
function createSupervisorTools(ctx) {
  const toSummary = (s) => ({
    id: s.id,
    title: s.title,
    workDir: s.workDir,
    busy: s.busy,
    active: s.active,
    model: s.modelId,
    modelName: s.modelName,
    approvalPolicy: s.approvalPolicy,
    currentRequest: s.currentRequest,
    recentRequests: s.recentRequests,
    stepCount: s.stepCount,
    contextUsageRatio: Number(s.contextUsageRatio.toFixed(3)),
    contextLength: s.contextLength,
    turnCount: s.turnCount,
    hasIncompleteTurn: s.hasIncompleteTurn,
    hasRetrySnapshot: s.hasRetrySnapshot
  });
  return [
    {
      name: "list_sessions",
      description: "\u5217\u51FA\u6240\u6709\u7528\u6237\u4F1A\u8BDD\u53CA\u5176\u5F53\u524D\u6267\u884C\u72B6\u6001\uFF1Aid\u3001\u6807\u9898\u3001\u662F\u5426\u5FD9\uFF08busy\uFF09\u3001\u5F53\u524D\u6A21\u578B\u3001\u5B89\u5168\u6A21\u5F0F\u3001\u5F53\u524D\u9700\u6C42\u3001\u5DF2\u6267\u884C\u6B65\u6570\u3001\u4E0A\u4E0B\u6587\u5360\u7528\u5360\u6BD4\u3001\u662F\u5426\u53EF\u7EE7\u7EED\u6267\u884C\u7B49\u3002\u7528\u4E8E\u56DE\u7B54\u300C\u73B0\u5728\u6709\u54EA\u4E9B\u4F1A\u8BDD\u5728\u5E72\u6D3B\u300D\u300C\u5404\u4F1A\u8BDD\u8FDB\u5EA6\u5982\u4F55\u300D\u8FD9\u7C7B\u95EE\u9898\u3002\u53EA\u8BFB\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u72B6\u6001\u3002",
      inputSchema: { type: "object", properties: {} },
      riskLevel: "readonly",
      execute: async () => ctx.listSessions().map(toSummary)
    },
    {
      name: "inspect_session",
      description: "\u67E5\u770B\u5355\u4E2A\u4F1A\u8BDD\u7684\u5B8C\u6574\u72B6\u6001\u8BE6\u60C5\uFF08\u542B\u5F53\u524D\u9700\u6C42\u3001\u5DF2\u6267\u884C\u6B65\u6570\u3001\u4E0A\u4E0B\u6587\u5360\u7528\u3001\u5F85\u5BA1\u6279\u6570\u7B49\uFF09\u3002sessionId \u6765\u81EA list_sessions \u8FD4\u56DE\u7684 id\u3002\u53EA\u8BFB\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u72B6\u6001\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" }
        },
        required: ["sessionId"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const s = ctx.inspectSession(String(args.sessionId ?? ""));
        if (!s) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${args.sessionId}` };
        return toSummary(s);
      }
    },
    {
      name: "list_models",
      description: "\u5217\u51FA\u5F53\u524D\u7CFB\u7EDF\u53EF\u7528\u7684\u6A21\u578B\uFF08id + \u663E\u793A\u540D\uFF09\uFF0C\u4F9B set_session_model \u5207\u6362\u4F1A\u8BDD\u6A21\u578B\u65F6\u9009\u62E9\u3002\u53EA\u8BFB\u3002",
      inputSchema: { type: "object", properties: {} },
      riskLevel: "readonly",
      execute: async () => ctx.listModels()
    },
    {
      name: "switch_session",
      description: "\u5207\u6362\u6FC0\u6D3B\u4F1A\u8BDD\uFF08\u7B49\u540C\u7528\u6237\u5728\u4FA7\u8FB9\u680F\u70B9\u51FB\u5207\u6362\uFF0C\u804A\u5929\u7A97\u53E3\u4F1A\u540C\u6B65\u5207\u6362\u5230\u8BE5\u4F1A\u8BDD\uFF09\u3002sessionId \u6765\u81EA list_sessions\u3002\u5207\u6362\u540E\u6C47\u62A5\u7BA1\u5BB6\u5DF2\u6FC0\u6D3B\u8BE5\u4F1A\u8BDD\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u8981\u6FC0\u6D3B\u7684\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" }
        },
        required: ["sessionId"]
      },
      riskLevel: "reversible",
      execute: async (args) => ctx.switchSession(String(args.sessionId ?? ""))
    },
    {
      name: "choose_session",
      description: "\u5F53\u7528\u6237\u8981\u4E0B\u53D1\u4EFB\u52A1/\u5207\u6362\u6A21\u578B/\u914D\u7F6E/\u5220\u9664\u67D0\u4E2A\u4F1A\u8BDD\uFF0C\u4F46\u6CA1\u6709\u660E\u786E\u8BF4\u662F\u54EA\u4E2A\u4F1A\u8BDD\u65F6\uFF0C\u3010\u5FC5\u987B\u3011\u8C03\u7528\u672C\u5DE5\u5177\u5F39\u51FA\u4F1A\u8BDD\u9009\u62E9\u5668\u8BA9\u7528\u6237\u4ECE\u4E2D\u9009\u62E9\uFF0C\u7981\u6B62\u7528\u6587\u672C\u53CD\u95EE\u7528\u6237\uFF08\u963B\u585E\u7B49\u5F85\u7528\u6237\u9009\u62E9\uFF09\u3002question \u662F\u9009\u62E9\u7684\u76EE\u7684\u8BF4\u660E\uFF08\u5982\u300C\u8BF7\u9009\u62E9\u8981\u4E0B\u53D1\u4EFB\u52A1\u7684\u4F1A\u8BDD\u300D\uFF09\u3002resolve \u8FD4\u56DE\u7528\u6237\u9009\u4E2D\u7684\u4F1A\u8BDD id\uFF0C\u53EF\u76F4\u63A5\u7528\u4E8E\u540E\u7EED send_message / set_session_model \u7B49\u5DE5\u5177\u3002\u4E0D\u8981\u5728\u80FD\u901A\u8FC7 list_sessions \u552F\u4E00\u786E\u5B9A\u76EE\u6807\u65F6\u6EE5\u7528\uFF1B\u4EC5\u5F53\u76EE\u6807\u4E0D\u660E\u786E\u65F6\u4F7F\u7528\u3002",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "\u9009\u62E9\u7684\u76EE\u7684\u8BF4\u660E\uFF08\u5982\u300C\u8BF7\u9009\u62E9\u8981\u4E0B\u53D1\u4EFB\u52A1\u7684\u4F1A\u8BDD\u300D\uFF09" }
        },
        required: ["question"]
      },
      riskLevel: "readonly",
      // 等用户选择：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
      timeoutMs: Infinity,
      execute: async (args) => {
        const question = String(args.question ?? "").trim() || "\u8BF7\u9009\u62E9\u8981\u64CD\u4F5C\u7684\u4F1A\u8BDD";
        const sessionId = await ctx.askSessionPicker(question);
        if (!sessionId) return { ok: false, message: "\u7528\u6237\u53D6\u6D88\u4E86\u9009\u62E9" };
        return { ok: true, sessionId, message: `\u7528\u6237\u9009\u62E9\u4E86\u4F1A\u8BDD ${sessionId}` };
      }
    },
    {
      name: "choose_model",
      description: "\u5F53\u7528\u6237\u8981\u5207\u6362\u67D0\u4E2A\u4F1A\u8BDD\u7684\u6A21\u578B\uFF0C\u4F46\u6CA1\u6709\u660E\u786E\u8BF4\u662F\u54EA\u4E2A\u6A21\u578B\u65F6\uFF0C\u3010\u5FC5\u987B\u3011\u8C03\u7528\u672C\u5DE5\u5177\u5F39\u51FA\u6A21\u578B\u9009\u62E9\u5668\u8BA9\u7528\u6237\u4ECE\u4E2D\u9009\u62E9\uFF0C\u7981\u6B62\u7528\u6587\u672C\u53CD\u95EE\u7528\u6237\uFF08\u963B\u585E\u7B49\u5F85\u7528\u6237\u9009\u62E9\uFF09\u3002question \u662F\u9009\u62E9\u7684\u76EE\u7684\u8BF4\u660E\uFF08\u5982\u300C\u8BF7\u9009\u62E9\u8981\u5207\u6362\u5230\u54EA\u4E2A\u6A21\u578B\u300D\uFF09\u3002resolve \u8FD4\u56DE\u7528\u6237\u9009\u4E2D\u7684\u6A21\u578B id\uFF0C\u53EF\u76F4\u63A5\u7528\u4E8E\u540E\u7EED set_session_model\u3002",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "\u9009\u62E9\u7684\u76EE\u7684\u8BF4\u660E\uFF08\u5982\u300C\u8BF7\u9009\u62E9\u8981\u5207\u6362\u5230\u54EA\u4E2A\u6A21\u578B\u300D\uFF09" }
        },
        required: ["question"]
      },
      riskLevel: "readonly",
      // 等用户选择：不设超时（用户思考/离开多久由用户决定，不该被 5 分钟统一兜底打断）
      timeoutMs: Infinity,
      execute: async (args) => {
        const question = String(args.question ?? "").trim() || "\u8BF7\u9009\u62E9\u6A21\u578B";
        const modelId = await ctx.askModelPicker(question);
        if (!modelId) return { ok: false, message: "\u7528\u6237\u53D6\u6D88\u4E86\u9009\u62E9" };
        return { ok: true, modelId, message: `\u7528\u6237\u9009\u62E9\u4E86\u6A21\u578B ${modelId}` };
      }
    },
    {
      name: "send_message",
      description: "\u5411\u6307\u5B9A\u4F1A\u8BDD\u8F6C\u53D1\u4E00\u6761\u6D88\u606F\uFF0C\u6548\u679C\u7B49\u540C\u4E8E\u7528\u6237\u624B\u52A8\u5207\u6362\u5230\u8BE5\u4F1A\u8BDD\u540E\u8F93\u5165\u5E76\u53D1\u9001\u3002sessionId \u6765\u81EA list_sessions\uFF1Bcontent \u662F\u8981\u8F6C\u53D1\u7684\u9700\u6C42\u5185\u5BB9\u3002" + MODE_DESC,
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" },
          content: { type: "string", description: "\u8981\u8F6C\u53D1\u7ED9\u8BE5\u4F1A\u8BDD\u7684\u9700\u6C42/\u6D88\u606F\u5185\u5BB9" },
          mode: { type: "string", enum: ["insert", "queue"], description: "\u53D1\u9001\u6A21\u5F0F\uFF0C\u9ED8\u8BA4 insert" }
        },
        required: ["sessionId", "content"]
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const sid = String(args.sessionId ?? "");
        const content = String(args.content ?? "");
        const mode = args.mode === "queue" ? "queue" : "insert";
        if (!content.trim()) return { ok: false, message: "\u6D88\u606F\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" };
        return ctx.sendMessage(sid, content, mode);
      }
    },
    {
      name: "inject_message",
      description: "\u5411\u6B63\u5728\u6267\u884C\u4EFB\u52A1\u7684\u4F1A\u8BDD\u8FFD\u52A0\u4E00\u6761\u9700\u6C42\uFF08\u63D2\u5165\u6A21\u5F0F\uFF09\uFF0C\u4E0D\u6253\u65AD\u5F53\u524D\u4EFB\u52A1\uFF0C\u5728\u4E0B\u4E00\u8F6E\u6A21\u578B\u8C03\u7528\u524D\u751F\u6548\u3002\u4EC5\u5F53\u76EE\u6807\u4F1A\u8BDD\u6B63\u5728\u6267\u884C\u65F6\u6709\u6548\uFF1B\u7A7A\u95F2\u4F1A\u8BDD\u8BF7\u7528 send_message\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id" },
          content: { type: "string", description: "\u8981\u8FFD\u52A0\u7684\u9700\u6C42\u5185\u5BB9" }
        },
        required: ["sessionId", "content"]
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const sid = String(args.sessionId ?? "");
        const content = String(args.content ?? "");
        return ctx.sendMessage(sid, content, "insert");
      }
    },
    {
      name: "set_session_model",
      description: "\u5207\u6362\u6307\u5B9A\u4F1A\u8BDD\u4F7F\u7528\u7684\u6A21\u578B\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u5728\u8BE5\u4F1A\u8BDD\u5207\u6362\u6A21\u578B\uFF09\u3002sessionId \u6765\u81EA list_sessions\uFF1BmodelId \u6765\u81EA list_models\u3002\u53EA\u5F71\u54CD\u8BE5\u4F1A\u8BDD\u540E\u7EED\u5BF9\u8BDD\uFF0C\u4E0D\u4E2D\u65AD\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id" },
          modelId: { type: "string", description: "\u6A21\u578B id\uFF08\u6765\u81EA list_models\uFF09" }
        },
        required: ["sessionId", "modelId"]
      },
      riskLevel: "reversible",
      execute: async (args) => ctx.setSessionModel(String(args.sessionId ?? ""), String(args.modelId ?? ""))
    },
    {
      name: "set_session_approval",
      description: "\u914D\u7F6E\u6307\u5B9A\u4F1A\u8BDD\u7684\u5B89\u5168\u6A21\u5F0F\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u8BBE\u7F6E\uFF09\u3002policy \u53D6\u503C\uFF1Aask=\u6BCF\u6B21\u8BE2\u95EE\u3001workdir=\u5DE5\u4F5C\u76EE\u5F55\u5185\u514D\u5BA1\u6279\u3001never=\u81EA\u52A8\u6267\u884C\u3002sessionId \u6765\u81EA list_sessions\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id" },
          policy: { type: "string", enum: ["ask", "workdir", "never"], description: "\u5B89\u5168\u6A21\u5F0F" }
        },
        required: ["sessionId", "policy"]
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const policy = String(args.policy ?? "");
        if (policy !== "ask" && policy !== "workdir" && policy !== "never") {
          return { ok: false, message: `\u65E0\u6548\u7684\u5B89\u5168\u6A21\u5F0F: ${args.policy}\uFF08\u5E94\u4E3A ask/workdir/never\uFF09` };
        }
        return ctx.setSessionApproval(String(args.sessionId ?? ""), policy);
      }
    },
    {
      name: "create_session",
      description: "\u521B\u5EFA\u4E00\u4E2A\u65B0\u7684\u7528\u6237\u4F1A\u8BDD\uFF08\u7B49\u540C\u7528\u6237\u70B9\u51FB\u300C\u65B0\u5EFA\u4F1A\u8BDD\u300D\uFF09\u3002title \u662F\u4F1A\u8BDD\u6807\u9898\uFF08\u7F3A\u7701\u300C\u65B0\u4F1A\u8BDD\u300D\uFF09\uFF1Bworkdir \u662F\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7F3A\u7701\u7528\u6237\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55\uFF09\u3002\u521B\u5EFA\u540E\u65B0\u4F1A\u8BDD\u4F1A\u51FA\u73B0\u5728\u4F1A\u8BDD\u5217\u8868\uFF0C\u53EF\u7EE7\u7EED\u7528 send_message \u7ED9\u5B83\u4E0B\u53D1\u4EFB\u52A1\u3002\u4E0D\u62A2\u5360\u7528\u6237\u5F53\u524D\u6B63\u5728\u67E5\u770B\u7684\u4F1A\u8BDD\u3002",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "\u4F1A\u8BDD\u6807\u9898\uFF0C\u7F3A\u7701\u300C\u65B0\u4F1A\u8BDD\u300D" },
          workdir: { type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u7F3A\u7701\u7528\u6237\u9ED8\u8BA4\u5DE5\u4F5C\u76EE\u5F55" }
        }
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const title = args.title ? String(args.title) : void 0;
        const workdir = args.workdir ? String(args.workdir) : void 0;
        return ctx.createSession(title, workdir);
      }
    },
    {
      name: "rename_session",
      description: "\u91CD\u547D\u540D\u6307\u5B9A\u4F1A\u8BDD\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u91CD\u547D\u540D\uFF09\u3002sessionId \u6765\u81EA list_sessions\uFF1Btitle \u662F\u65B0\u6807\u9898\uFF08\u975E\u7A7A\uFF09\u3002\u4F1A\u8BDD\u7BA1\u5BB6\u81EA\u5DF1\u7684\u4F1A\u8BDD\u4E0D\u53EF\u91CD\u547D\u540D\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" },
          title: { type: "string", description: "\u65B0\u6807\u9898" }
        },
        required: ["sessionId", "title"]
      },
      riskLevel: "reversible",
      execute: async (args) => ctx.renameSession(String(args.sessionId ?? ""), String(args.title ?? ""))
    },
    {
      name: "set_session_workdir",
      description: "\u8BBE\u7F6E\u6307\u5B9A\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u8BBE\u7F6E\u8BE5\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF09\u3002sessionId \u6765\u81EA list_sessions\uFF1Bworkdir \u662F\u65B0\u7684\u5DE5\u4F5C\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u975E\u7A7A\uFF09\u3002\u53EA\u5F71\u54CD\u8BE5\u4F1A\u8BDD\u540E\u7EED\u6267\u884C\u7684\u547D\u4EE4/\u6587\u4EF6\u64CD\u4F5C\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u4E0D\u5F71\u54CD\u6B63\u5728\u8FD0\u884C\u7684\u4EFB\u52A1\u3002\u4F1A\u8BDD\u7BA1\u5BB6\u81EA\u5DF1\u7684\u4F1A\u8BDD\u4E0D\u53EF\u4FEE\u6539\u5DE5\u4F5C\u76EE\u5F55\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u76EE\u6807\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" },
          workdir: { type: "string", description: "\u65B0\u7684\u5DE5\u4F5C\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84" }
        },
        required: ["sessionId", "workdir"]
      },
      riskLevel: "reversible",
      execute: async (args) => ctx.setSessionWorkdir(String(args.sessionId ?? ""), String(args.workdir ?? ""))
    },
    {
      name: "delete_session",
      description: "\u5220\u9664\u6307\u5B9A\u4F1A\u8BDD\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u5220\u9664\uFF0C\u5371\u9669\u64CD\u4F5C\uFF0C\u4E0D\u53EF\u6062\u590D\uFF09\u3002sessionId \u6765\u81EA list_sessions\u3002\u5220\u9664\u524D\u4F1A\u62D2\u7EDD\u8BE5\u4F1A\u8BDD\u6240\u6709\u5F85\u5BA1\u6279\u8BF7\u6C42\u3001\u53D6\u6D88\u5F85\u56DE\u7B54\u63D0\u95EE\u3001\u6E05\u7406\u6301\u4E45\u5316\u6587\u4EF6\uFF1B\u82E5\u5220\u7684\u662F\u5F53\u524D\u6FC0\u6D3B\u4F1A\u8BDD\u4F1A\u81EA\u52A8\u5207\u5230\u5269\u4F59\u4F1A\u8BDD\u3002\u4F1A\u8BDD\u7BA1\u5BB6\u81EA\u5DF1\u7684\u4F1A\u8BDD\u4E0D\u53EF\u5220\u9664\u3002\u6267\u884C\u524D\u52A1\u5FC5\u5411\u7528\u6237\u786E\u8BA4\u76EE\u6807\u4F1A\u8BDD id \u6B63\u786E\u3002",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "\u8981\u5220\u9664\u7684\u4F1A\u8BDD id\uFF08\u6765\u81EA list_sessions\uFF09" }
        },
        required: ["sessionId"]
      },
      riskLevel: "irreversible",
      execute: async (args) => ctx.deleteSession(String(args.sessionId ?? ""))
    },
    {
      name: "resolve_approval",
      description: "\u5BA1\u6279\u8BF7\u6C42\u5230\u8FBE\u65F6\uFF08\u7BA1\u5BB6\u63A5\u7BA1\u7684\u5BA1\u6279\uFF09\uFF0C\u51B3\u5B9A\u662F\u5426\u6279\u51C6\u76EE\u6807\u4F1A\u8BDD\u7684\u5DE5\u5177\u6267\u884C\u3002requestId \u6765\u81EA\u5BA1\u6279\u8BF7\u6C42\u901A\u77E5\u91CC\u7684 id\uFF1Boutcome \u53D6 allowed-once\uFF08\u6279\u51C6\uFF09\u6216 rejected\uFF08\u62D2\u7EDD\uFF09\u3002\u51B3\u7B56\u540E\u5BF9\u5E94\u4F1A\u8BDD\u7684\u6388\u6743\u5F39\u7A97\u4F1A\u81EA\u52A8\u5173\u95ED\uFF0C\u76EE\u6807\u4F1A\u8BDD\u6309\u51B3\u7B56\u7EE7\u7EED\u6216\u8DF3\u8FC7\u8BE5\u5DE5\u5177\u3002\u4EC5\u5728\u6536\u5230\u3010\u5BA1\u6279\u8BF7\u6C42\u3011\u901A\u77E5\u3001\u4E14\u9700\u8981\u66FF\u7528\u6237\u628A\u5173\u65F6\u8C03\u7528\uFF1B\u53EA\u8BFB\u51B3\u7B56\uFF0C\u4E0D\u6267\u884C\u4EFB\u4F55\u5B9E\u9645\u6587\u4EF6/\u547D\u4EE4\u64CD\u4F5C\u3002",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "\u5BA1\u6279\u8BF7\u6C42 id\uFF08\u6765\u81EA\u3010\u5BA1\u6279\u8BF7\u6C42\u3011\u901A\u77E5\uFF09" },
          outcome: { type: "string", enum: ["allowed-once", "rejected"], description: "allowed-once=\u6279\u51C6\u6267\u884C\u4E00\u6B21\uFF0Crejected=\u62D2\u7EDD" }
        },
        required: ["requestId", "outcome"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const requestId = String(args.requestId ?? "");
        const outcome = args.outcome === "rejected" ? "rejected" : "allowed-once";
        if (!requestId) return { ok: false, message: "requestId \u4E0D\u80FD\u4E3A\u7A7A" };
        return ctx.resolveApproval(requestId, outcome);
      }
    },
    {
      name: "answer_ask",
      description: "\u63D0\u95EE\u8BF7\u6C42\u5230\u8FBE\u65F6\uFF08\u7BA1\u5BB6\u63A5\u7BA1\u7684\u63D0\u95EE\uFF09\uFF0C\u4EE3\u7B54\u76EE\u6807\u4F1A\u8BDD\u7684\u63D0\u95EE\u3002requestId \u6765\u81EA\u3010\u63D0\u95EE\u8BF7\u6C42\u3011\u901A\u77E5\u91CC\u7684 id\uFF1Banswer \u586B\u4EE3\u7B54\u5185\u5BB9\uFF08\u6709\u53EF\u9009\u9879\u65F6\u586B\u9009\u4E2D\u7684\u90A3\u4E00\u4E2A\u7684\u539F\u6587\uFF0C\u65E0\u9009\u9879\u65F6\u586B\u7B80\u77ED\u6587\u5B57\uFF09\u3002\u4EE3\u7B54\u540E\u5BF9\u5E94\u4F1A\u8BDD\u7684\u63D0\u95EE\u5F39\u7A97\u4F1A\u81EA\u52A8\u5173\u95ED\uFF0C\u76EE\u6807\u4F1A\u8BDD\u6309\u4F60\u7684\u56DE\u7B54\u7EE7\u7EED\u6267\u884C\u3002\u4EC5\u5728\u6536\u5230\u3010\u63D0\u95EE\u8BF7\u6C42\u3011\u901A\u77E5\u3001\u4E14\u9700\u8981\u66FF\u7528\u6237\u56DE\u7B54\u65F6\u8C03\u7528\uFF1B\u53EA\u8BFB\u51B3\u7B56\uFF0C\u4E0D\u6267\u884C\u4EFB\u4F55\u5B9E\u9645\u6587\u4EF6/\u547D\u4EE4\u64CD\u4F5C\u3002",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", description: "\u63D0\u95EE\u8BF7\u6C42 id\uFF08\u6765\u81EA\u3010\u63D0\u95EE\u8BF7\u6C42\u3011\u901A\u77E5\uFF09" },
          answer: { type: "string", description: "\u4EE3\u7B54\u5185\u5BB9\uFF08\u6709\u9009\u9879\u65F6\u586B\u9009\u4E2D\u9879\u539F\u6587\uFF0C\u65E0\u9009\u9879\u65F6\u586B\u7B80\u77ED\u6587\u5B57\uFF09" }
        },
        required: ["requestId", "answer"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const requestId = String(args.requestId ?? "");
        const answer = String(args.answer ?? "");
        if (!requestId) return { ok: false, message: "requestId \u4E0D\u80FD\u4E3A\u7A7A" };
        return ctx.answerAsk(requestId, answer);
      }
    }
  ];
}

// ../runtime/src/session-store.ts
import { promises as fs11 } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join as join10 } from "path";
import { gzip as gzipCb, gunzip as gunzipCb } from "zlib";
var SEGMENT_MAX_BYTES = 1 * 1024 * 1024;
function gzip(buf) {
  return new Promise((resolve4, reject) => {
    gzipCb(buf, { level: 9 }, (err, out) => err ? reject(err) : resolve4(out));
  });
}
function gunzip(buf) {
  return new Promise((resolve4, reject) => {
    gunzipCb(buf, (err, out) => err ? reject(err) : resolve4(out));
  });
}
function sessionDirPath(sessionsDir, sessionId) {
  return join10(sessionsDir, sessionId);
}
async function writeSessionMetaFile(dir, meta) {
  await fs11.mkdir(dir, { recursive: true });
  const path3 = join10(dir, "meta.json");
  const tmp = `${path3}.tmp`;
  await fs11.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 384 });
  await fs11.rename(tmp, path3);
}
async function readSessionMetaFile(dir) {
  try {
    const raw = await fs11.readFile(join10(dir, "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function listSegmentFiles(dir) {
  let entries;
  try {
    entries = await fs11.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((n) => /^events-\d+\.jsonl\.gz$/.test(n)).sort((a, b) => seqOf(a) - seqOf(b));
}
function seqOf(name) {
  const m = /^events-(\d+)\.jsonl\.gz$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}
async function nextSegmentSeq(dir) {
  const files = await listSegmentFiles(dir);
  return files.length > 0 ? seqOf(files[files.length - 1]) + 1 : 0;
}
async function rotateSessionEventsFile(dir, maxBytes = SEGMENT_MAX_BYTES) {
  const path3 = join10(dir, "events.jsonl");
  let stat;
  try {
    stat = await fs11.stat(path3);
  } catch {
    return false;
  }
  if (stat.size < maxBytes) return false;
  const raw = await fs11.readFile(path3);
  if (raw.length === 0) return false;
  const compressed = await gzip(raw);
  const seq2 = await nextSegmentSeq(dir);
  await fs11.writeFile(join10(dir, `events-${String(seq2).padStart(6, "0")}.jsonl.gz`), compressed, { mode: 384 });
  await fs11.writeFile(path3, "", { mode: 384 });
  return true;
}
async function appendSessionEventsFile(dir, events, maxBytes = SEGMENT_MAX_BYTES) {
  if (events.length === 0) return;
  await fs11.mkdir(dir, { recursive: true });
  const path3 = join10(dir, "events.jsonl");
  const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}
`;
  await fs11.appendFile(path3, lines, { mode: 384 });
  await rotateSessionEventsFile(dir, maxBytes);
}
async function rewriteSessionEventsFile(dir, events) {
  await fs11.mkdir(dir, { recursive: true });
  const path3 = join10(dir, "events.jsonl");
  const tmp = `${path3}.tmp`;
  const lines = events.length > 0 ? `${events.map((e) => JSON.stringify(e)).join("\n")}
` : "";
  await fs11.writeFile(tmp, lines, { mode: 384 });
  await fs11.rename(tmp, path3);
  for (const file of await listSegmentFiles(dir)) {
    await fs11.rm(join10(dir, file), { force: true }).catch(() => void 0);
  }
}
async function* streamSessionEvents(dir) {
  for (const file of await listSegmentFiles(dir)) {
    try {
      const buf = await fs11.readFile(join10(dir, file));
      const text = (await gunzip(buf)).toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
        }
      }
    } catch {
    }
  }
  const rl = createInterface({
    input: createReadStream(join10(dir, "events.jsonl"), { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
      }
    }
  } catch {
  }
}
async function loadSessionEventsFile(dir) {
  const out = [];
  for await (const e of streamSessionEvents(dir)) out.push(e);
  return out;
}
async function deleteSessionDir(dir) {
  await fs11.rm(dir, { recursive: true, force: true });
}
function legacySessionFilePath(sessionsDir, sessionId) {
  return join10(sessionsDir, `${sessionId}.json`);
}
async function migrateLegacySessionFile(sessionsDir, sessionId, defaultWorkDir) {
  const legacyPath = legacySessionFilePath(sessionsDir, sessionId);
  const dir = sessionDirPath(sessionsDir, sessionId);
  try {
    const raw = await fs11.readFile(legacyPath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.events)) return null;
    const workDir = data.workDir ?? defaultWorkDir;
    const lastActiveAt = typeof data.lastActiveAt === "number" ? data.lastActiveAt : 0;
    const modelId = effectiveModelId(data.events);
    const approvalPolicy = effectiveApprovalPolicy(data.events);
    await writeSessionMetaFile(dir, {
      id: sessionId,
      title: data.title || "\u65B0\u4F1A\u8BDD",
      workDir,
      lastActiveAt,
      modelId,
      approvalPolicy
    });
    await rewriteSessionEventsFile(dir, data.events);
    await fs11.rm(legacyPath, { force: true });
    return { title: data.title || "\u65B0\u4F1A\u8BDD", workDir, lastActiveAt, events: data.events, modelId, approvalPolicy };
  } catch {
    return null;
  }
}

// ../runtime/src/bootstrap.ts
import { promises as fs19 } from "fs";
import { homedir as homedir11, hostname as osHostname2 } from "os";
import { join as join18, basename, isAbsolute as isAbsolute3 } from "path";

// ../runtime/src/types.ts
var DEFAULT_SETTINGS = {
  browser: { showOnCreate: true, enableWebBridge: true },
  messageSubmit: { mode: "queue" },
  debug: { traceLlm: false },
  voice: { enabled: true },
  supervisorApproval: { enabled: false },
  supervisorAsk: { enabled: false },
  compaction: { modelId: "" }
};

// ../runtime/src/models.ts
import { promises as fs12 } from "fs";
import { join as join11 } from "path";
import { homedir as homedir5 } from "os";

// ../../packages/llm/src/llm.ts
function createMockModel(responses) {
  const queue = [...responses];
  return {
    complete: async () => {
      const next = queue.shift();
      if (next) return next;
      const last = responses[responses.length - 1];
      return last ?? { text: "" };
    }
  };
}
function toTokenUsage(u) {
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    cachedPromptTokens: u.prompt_tokens_details?.cached_tokens ?? 0
  };
}
function chatCompletionsUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/api\/v\d+$/.test(b) || /\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/api/v1/chat/completions`;
}
function serializeMessages(messages) {
  return messages.map((m) => {
    const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : []);
    if (m.role === "assistant" && calls.length > 0) {
      const msg2 = {
        role: "assistant",
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: {
            name: c.name,
            arguments: JSON.stringify(c.args ?? {})
          }
        }))
      };
      if (m.reasoningContent) msg2.reasoning_content = m.reasoningContent;
      return msg2;
    }
    if (m.role === "tool") {
      if (!m.toolCallId) {
        throw new Error("\u5E8F\u5217\u5316\u5931\u8D25\uFF1Atool \u6D88\u606F\u7F3A\u5C11 tool_call_id\uFF08\u4E8B\u4EF6\u56DE\u653E\u7684 callId \u7F3A\u5931\uFF09");
      }
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    const msg = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.reasoningContent) msg.reasoning_content = m.reasoningContent;
    return msg;
  });
}
var FETCH_TIMEOUT_MS = 3 * 60 * 1e3;
async function fetchWithTimeout2(input, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`\u6A21\u578B\u8BF7\u6C42\u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)}s\uFF09\uFF0C\u7F51\u5173\u672A\u54CD\u5E94\uFF0C\u5DF2\u4E2D\u6B62\u672C\u6B21\u8C03\u7528`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
var DeepSeekProvider = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  async complete(messages, tools, userId) {
    const url = chatCompletionsUrl(this.opts.baseUrl);
    const effectiveUserId = userId ?? this.opts.userId;
    const body = {
      model: this.opts.model,
      messages: serializeMessages(messages),
      tools: tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      // max_tokens 显式下发，让网关按模型真实配置预留 completion，而非用其默认预留值（否则 1M 窗口可能被默认预留压掉几十万，导致误判超限）
      ...this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {},
      ...effectiveUserId != null ? { user_id: effectiveUserId } : {}
    };
    this.opts.onTrace?.({ phase: "request", url, method: "POST", body });
    let res;
    try {
      res = await fetchWithTimeout2(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    const rawText = await res.text();
    if (!res.ok) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(rawText), responseStatus: res.status, error: `DeepSeek API ${res.status}` });
      throw new Error(`DeepSeek API ${res.status}: ${rawText}`);
    }
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(rawText), responseStatus: res.status, error: "\u54CD\u5E94\u975E\u5408\u6CD5 JSON" });
      throw new Error(`DeepSeek API ${res.status}: \u54CD\u5E94\u975E\u5408\u6CD5 JSON`);
    }
    this.opts.onTrace?.({ phase: "response", url, method: "POST", body: raw, responseStatus: res.status });
    if (raw.error) {
      const msg = typeof raw.error === "string" ? raw.error : raw.error.message ?? JSON.stringify(raw.error);
      throw new Error(msg);
    }
    if (raw.code !== void 0 && raw.code !== 0) {
      throw new Error(`gateway error code ${raw.code}`);
    }
    const payload = raw.data ?? raw;
    const usage = payload.usage;
    if (usage && this.opts.onUsage) {
      this.opts.onUsage(toTokenUsage(usage));
    }
    const message = payload.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeParse(tc.function.arguments)
    }));
    const reasoningContent = message?.reasoning_content || message?.reasoning || void 0;
    if (toolCalls.length > 0) {
      return {
        reasoningContent,
        toolCalls,
        toolCall: toolCalls[0]
      };
    }
    return { text: message?.content ?? "", reasoningContent };
  }
  /** SSE 流式：逐行解析，累积工具调用 arguments 分片，产出 text 增量 + 完整 toolCall */
  async *stream(messages, tools, userId) {
    const url = chatCompletionsUrl(this.opts.baseUrl);
    const effectiveUserId = userId ?? this.opts.userId;
    const body = {
      model: this.opts.model,
      messages: serializeMessages(messages),
      tools: tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      })),
      stream: true,
      // 请求网关在流末尾返回 usage（OpenAI 兼容；网关不支持时自动忽略，不影响流）
      stream_options: { include_usage: true },
      ...effectiveUserId != null ? { user_id: effectiveUserId } : {}
    };
    this.opts.onTrace?.({ phase: "request", url, method: "POST", body });
    let res;
    try {
      res = await fetchWithTimeout2(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (!res.ok || !res.body) {
      const errText = await res.text();
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(errText), responseStatus: res.status, error: `DeepSeek API ${res.status}` });
      throw new Error(`DeepSeek API ${res.status}: ${errText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallAccs = /* @__PURE__ */ new Map();
    const completedToolCalls = [];
    let fullText = "";
    let fullReasoning = "";
    const allToolCalls = [];
    let finalUsage;
    const accumulate = (c) => {
      if (c.text) fullText += c.text;
      if (c.reasoningContent) fullReasoning += c.reasoningContent;
      if (c.toolCalls) allToolCalls.push(...c.toolCalls);
      else if (c.toolCall) allToolCalls.push(c.toolCall);
      if (c.usage) finalUsage = c.usage;
    };
    const flushAll = () => {
      const result = [];
      for (const acc of toolCallAccs.values()) {
        const tc = flushToolCall(acc);
        if (tc) result.push(tc);
      }
      toolCallAccs.clear();
      return result;
    };
    const handleLine = (line) => {
      const ev = parseSseLine(line);
      const out = [];
      if (!ev) return out;
      if (ev.text !== void 0) {
        completedToolCalls.push(...flushAll());
        out.push({ text: ev.text });
      }
      if (ev.reasoningContent !== void 0) {
        out.push({ reasoningContent: ev.reasoningContent });
      }
      if (ev.toolCall) {
        const idx = ev.toolCall.index;
        let acc = toolCallAccs.get(idx);
        if (acc && ev.toolCall.name && acc.name && ev.toolCall.name !== acc.name) {
          const tc = flushToolCall(acc);
          if (tc) completedToolCalls.push(tc);
          toolCallAccs.delete(idx);
          acc = void 0;
        }
        if (!acc) {
          acc = { id: ev.toolCall.id, name: ev.toolCall.name, argsText: "" };
          toolCallAccs.set(idx, acc);
        }
        if (ev.toolCall.id) acc.id = ev.toolCall.id;
        if (ev.toolCall.name) acc.name = ev.toolCall.name;
        acc.argsText += ev.toolCall.argsDelta ?? "";
      }
      if (ev.usage) {
        completedToolCalls.push(...flushAll());
        if (completedToolCalls.length > 0) {
          out.push({ toolCalls: [...completedToolCalls], toolCall: completedToolCalls[0] });
          completedToolCalls.length = 0;
        }
        out.push({ usage: ev.usage });
        if (this.opts.onUsage) this.opts.onUsage(ev.usage);
      }
      return out;
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const chunk of handleLine(line)) {
          accumulate(chunk);
          yield chunk;
        }
      }
    }
    for (const chunk of handleLine(buffer)) {
      accumulate(chunk);
      yield chunk;
    }
    completedToolCalls.push(...flushAll());
    if (completedToolCalls.length > 0) {
      const chunk = { toolCalls: [...completedToolCalls], toolCall: completedToolCalls[0] };
      accumulate(chunk);
      yield chunk;
    }
    this.opts.onTrace?.({
      phase: "response",
      url,
      method: "POST",
      body: buildMergedStreamBody({
        model: this.opts.model,
        text: fullText,
        reasoningContent: fullReasoning,
        toolCalls: allToolCalls,
        usage: finalUsage
      }),
      responseStatus: res.status
    });
  }
};
function flushToolCall(acc) {
  if (!acc.name) return null;
  return { id: acc.id, name: acc.name, args: safeParse(acc.argsText || "{}") };
}
function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (parsed.error) {
    const msg = typeof parsed.error === "string" ? parsed.error : parsed.error.message ?? JSON.stringify(parsed.error);
    throw new Error(msg);
  }
  const delta = parsed.choices?.[0]?.delta;
  const text = typeof delta?.content === "string" && delta.content ? delta.content : void 0;
  const reasoningContent = typeof delta?.reasoning_content === "string" && delta.reasoning_content || typeof delta?.reasoning === "string" && delta.reasoning || void 0;
  const tc = delta?.tool_calls?.[0];
  const toolCall = tc ? { index: tc.index ?? 0, id: tc.id, name: tc.function?.name, argsDelta: tc.function?.arguments ?? "" } : void 0;
  const usage = parsed.usage ? toTokenUsage(parsed.usage) : void 0;
  if (text === void 0 && !toolCall && reasoningContent === void 0 && !usage) return null;
  return { text, toolCall, reasoningContent, usage };
}
function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
function normalizeResponseBody(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}
function buildMergedStreamBody(opts) {
  const message = { role: "assistant" };
  if (opts.text) message.content = opts.text;
  if (opts.reasoningContent) message.reasoning_content = opts.reasoningContent;
  if (opts.toolCalls.length > 0) {
    message.tool_calls = opts.toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
    }));
  }
  const body = {
    model: opts.model,
    stream: false,
    choices: [{ index: 0, message, finish_reason: "stop" }]
  };
  if (opts.usage) {
    body.usage = {
      prompt_tokens: opts.usage.promptTokens,
      completion_tokens: opts.usage.completionTokens,
      total_tokens: opts.usage.totalTokens,
      ...opts.usage.cachedPromptTokens != null ? { prompt_tokens_details: { cached_tokens: opts.usage.cachedPromptTokens } } : {}
    };
  }
  return body;
}
var DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
function createModelProvider(opts) {
  if (opts.protocol === "anthropic") {
    return new AnthropicProvider(opts);
  }
  return new DeepSeekProvider({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, model: opts.model, maxTokens: opts.maxTokens, onUsage: opts.onUsage, onTrace: opts.onTrace, userId: opts.userId });
}
function anthropicMessagesUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/messages$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/messages`;
  return `${b}/v1/messages`;
}
function extractText(content) {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text").map((p) => p.text).join("");
}
function anthropicImageBlock(url) {
  if (url.startsWith("data:")) {
    const idx = url.indexOf(";base64,");
    if (idx < 0) return null;
    const mediaType = url.slice(5, idx);
    const data = url.slice(idx + 8);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}
function anthropicContentBlocks(content) {
  if (typeof content === "string") return content;
  const blocks = [];
  for (const p of content) {
    if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
    else if (p.type === "image_url" && p.image_url?.url) {
      const img = anthropicImageBlock(p.image_url.url);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}
function serializeAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = extractText(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (m.role === "tool") {
      if (!m.toolCallId) {
        throw new Error("\u5E8F\u5217\u5316\u5931\u8D25\uFF1Atool \u6D88\u606F\u7F3A\u5C11 tool_use_id\uFF08\u4E8B\u4EF6\u56DE\u653E\u7684 callId \u7F3A\u5931\uFF09");
      }
      const id = m.toolCallId;
      const content2 = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: content2 }] });
      continue;
    }
    const calls = m.toolCalls ?? (m.toolCall ? [m.toolCall] : []);
    if (m.role === "assistant" && calls.length > 0) {
      const blocks = [];
      const text = extractText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const c of calls) {
        if (!c.id) {
          throw new Error(`\u5E8F\u5217\u5316\u5931\u8D25\uFF1Aassistant \u5DE5\u5177\u8C03\u7528 ${c.name} \u7F3A\u5C11 id\uFF08\u4E8B\u4EF6\u56DE\u653E\u7684 callId \u7F3A\u5931\uFF09`);
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "assistant") {
      const text = extractText(m.content);
      out.push({ role: "assistant", content: text ? [{ type: "text", text }] : "" });
      continue;
    }
    const content = anthropicContentBlocks(m.content);
    out.push({ role: "user", content: content.length === 0 ? "" : content });
  }
  return { system: systemParts.join("\n") || void 0, messages: out };
}
function anthropicTools(tools) {
  if (!tools || tools.length === 0) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: "object", properties: {} }
  }));
}
function parseAnthropicResponse(resp, onUsage) {
  const usage = resp.usage;
  if (usage && onUsage) {
    onUsage({
      promptTokens: usage.input_tokens ?? 0,
      completionTokens: usage.output_tokens ?? 0,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    });
  }
  let text = "";
  const toolCalls = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "tool_use" && block.name) {
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
    }
  }
  if (toolCalls.length > 0) return { toolCalls, toolCall: toolCalls[0] };
  return { text };
}
var AnthropicProvider = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  async complete(messages, tools) {
    const { system, messages: wire } = serializeAnthropicMessages(messages);
    const url = anthropicMessagesUrl(this.opts.baseUrl);
    const body = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: wire
    };
    if (system) body.system = system;
    const toolDefs = anthropicTools(tools);
    if (toolDefs.length > 0) body.tools = toolDefs;
    this.opts.onTrace?.({ phase: "request", url, method: "POST", body });
    let res;
    try {
      res = await fetchWithTimeout2(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.opts.apiKey,
          Authorization: `Bearer ${this.opts.apiKey}`,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    const rawText = await res.text();
    if (!res.ok) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(rawText), responseStatus: res.status, error: `Anthropic API ${res.status}` });
      throw new Error(`Anthropic API ${res.status}: ${rawText}`);
    }
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(rawText), responseStatus: res.status, error: "\u54CD\u5E94\u975E\u5408\u6CD5 JSON" });
      throw new Error(`Anthropic API ${res.status}: \u54CD\u5E94\u975E\u5408\u6CD5 JSON`);
    }
    this.opts.onTrace?.({ phase: "response", url, method: "POST", body: raw, responseStatus: res.status });
    return parseAnthropicResponse(raw, this.opts.onUsage);
  }
  /** SSE 流式：解析 content_block_delta 产出 text 增量，累积 input_json_delta 产出完整 toolCall */
  async *stream(messages, tools) {
    const { system, messages: wire } = serializeAnthropicMessages(messages);
    const url = anthropicMessagesUrl(this.opts.baseUrl);
    const body = {
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      messages: wire,
      stream: true
    };
    if (system) body.system = system;
    const toolDefs = anthropicTools(tools);
    if (toolDefs.length > 0) body.tools = toolDefs;
    this.opts.onTrace?.({ phase: "request", url, method: "POST", body });
    let res;
    try {
      res = await fetchWithTimeout2(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.opts.apiKey,
          Authorization: `Bearer ${this.opts.apiKey}`,
          "anthropic-version": "2023-06-01",
          Accept: "text/event-stream"
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      this.opts.onTrace?.({ phase: "response", url, method: "POST", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (!res.ok || !res.body) {
      const errText = await res.text();
      this.opts.onTrace?.({ phase: "response", url, method: "POST", body: normalizeResponseBody(errText), responseStatus: res.status, error: `Anthropic API ${res.status}` });
      throw new Error(`Anthropic API ${res.status}: ${errText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let toolUseAcc = null;
    let inputTokens = 0;
    let fullText = "";
    const allToolCalls = [];
    let finalUsage;
    const accumulate = (c) => {
      if (c.text) fullText += c.text;
      if (c.reasoningContent) fullText += c.reasoningContent;
      if (c.toolCalls) allToolCalls.push(...c.toolCalls);
      else if (c.toolCall) allToolCalls.push(c.toolCall);
      if (c.usage) finalUsage = c.usage;
    };
    const handleEvent = (event) => {
      const out = [];
      const type = event.type;
      if (type === "message_start") {
        const msg = event.message ?? {};
        if (msg.usage?.input_tokens != null) inputTokens = msg.usage.input_tokens;
      } else if (type === "content_block_start") {
        const cb = event.content_block ?? {};
        if (cb.type === "tool_use") {
          toolUseAcc = { id: cb.id, name: cb.name, jsonText: "" };
        }
      } else if (type === "content_block_delta") {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && delta.text) {
          out.push({ text: delta.text });
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          if (!toolUseAcc) toolUseAcc = { jsonText: "" };
          toolUseAcc.jsonText += delta.partial_json;
        }
      } else if (type === "content_block_stop") {
        if (toolUseAcc?.name) {
          out.push({ toolCall: { id: toolUseAcc.id, name: toolUseAcc.name, args: safeParse(toolUseAcc.jsonText || "{}") } });
        }
        toolUseAcc = null;
      } else if (type === "message_delta") {
        const usage = event.usage ?? {};
        if (usage.output_tokens != null) {
          const full = {
            promptTokens: inputTokens,
            completionTokens: usage.output_tokens,
            totalTokens: inputTokens + usage.output_tokens
          };
          if (this.opts.onUsage) this.opts.onUsage(full);
          out.push({ usage: full });
        }
      }
      return out;
    };
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return [];
      const data = trimmed.slice(5).trim();
      if (!data) return [];
      try {
        return handleEvent(JSON.parse(data));
      } catch {
        return [];
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const chunk of parseLine(line)) {
          accumulate(chunk);
          yield chunk;
        }
      }
    }
    for (const chunk of parseLine(buffer)) {
      accumulate(chunk);
      yield chunk;
    }
    this.opts.onTrace?.({
      phase: "response",
      url,
      method: "POST",
      body: buildMergedStreamBody({
        model: this.opts.model,
        text: fullText,
        reasoningContent: "",
        toolCalls: allToolCalls,
        usage: finalUsage
      }),
      responseStatus: res.status
    });
  }
};

// ../runtime/src/models.ts
async function createGatewayModel(onUsage, onTrace) {
  try {
    const raw = await fs12.readFile(join11(homedir5(), ".shanhai", "config.json"), "utf8");
    const cfg = JSON.parse(raw);
    const g = cfg.gateway;
    if (g?.baseUrl && g?.apiKey && g?.selectedModelId) {
      return createModelProvider({ apiKey: g.apiKey, baseUrl: g.baseUrl, model: g.selectedModelId, onUsage, onTrace });
    }
  } catch {
  }
  return createMockModel([{ text: "\u4F60\u597D\uFF0C\u6211\u662F\u5C71\u6D77\u667A\u80FD\u4F53\u3002" }]);
}
function inferTier(id) {
  if (/flash|step-3/i.test(id)) return "value";
  return "flagship";
}
var VISION_HINTS = ["qwen", "kimi", "mimo", "minimax", "longcat", "glm", "vision", "vl", "omni", "step"];
function isVisionModel(id) {
  const lower = id.toLowerCase();
  return VISION_HINTS.some((h) => lower.includes(h));
}
function modelSupportsVision(m) {
  if (!m) return false;
  if (m.supportsVision !== void 0) return m.supportsVision;
  return isVisionModel(m.id);
}
async function fetchGatewayModels(apiKey, baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data.data?.data ?? [];
    return list.map((m) => ({
      id: m.id,
      name: m.displayName ?? m.name ?? m.id,
      displayName: m.displayName != null ? String(m.displayName) : void 0,
      model: m.model != null ? String(m.model) : void 0,
      tier: inferTier(m.id),
      apiKey,
      baseUrl: m.baseUrl ?? baseUrl,
      contextLength: typeof m.contextLength === "number" ? m.contextLength : void 0,
      maxTokens: m.maxTokens != null ? Number(m.maxTokens) : void 0,
      temperature: m.temperature != null ? String(m.temperature) : void 0,
      provider: m.provider != null ? String(m.provider) : void 0,
      sortOrder: typeof m.sortOrder === "number" ? m.sortOrder : void 0,
      description: m.description != null ? String(m.description) : void 0,
      source: m.source != null ? String(m.source) : void 0
    }));
  } catch {
    return [];
  }
}

// ../runtime/src/http-trace.ts
import { promises as fs13 } from "fs";
import { join as join12 } from "path";
var HTTP_TRACE_MAX_BODY_CHARS = 2e5;
var HTTP_TRACE_MAX_FILE_BYTES = 50 * 1024 * 1024;
function createHttpTraceStore(tracesDir) {
  const path3 = (sid) => join12(tracesDir, `${sid}.http.log`);
  async function append(sid, trace) {
    try {
      await fs13.mkdir(tracesDir, { recursive: true });
      const record = { ts: Date.now(), sessionId: sid, ...trace };
      const iso = new Date(record.ts).toISOString();
      const tag = `HTTP-${trace.phase.toUpperCase()}`;
      const body = JSON.stringify(record, (_k, v) => {
        if (typeof v === "string" && v.length > HTTP_TRACE_MAX_BODY_CHARS) {
          return `${v.slice(0, HTTP_TRACE_MAX_BODY_CHARS)}\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u539F\u59CB ${v.length} \u5B57\u7B26\uFF09`;
        }
        return v;
      }, 2);
      const line = `[${iso}] [${tag}]
${body}
`;
      const filePath = path3(sid);
      const stat = await fs13.stat(filePath).catch(() => null);
      if (stat && stat.size > HTTP_TRACE_MAX_FILE_BYTES) {
        await fs13.rm(filePath, { force: true });
      }
      await fs13.appendFile(filePath, line, { mode: 384 });
    } catch {
    }
  }
  async function read(sid) {
    try {
      const raw = await fs13.readFile(path3(sid), "utf8");
      const out = [];
      const blocks = raw.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/);
      for (const block of blocks) {
        const lines = block.split("\n");
        const jsonStart = lines.findIndex((l) => l.trimStart().startsWith("{"));
        if (jsonStart < 0) continue;
        const jsonText = lines.slice(jsonStart).join("\n");
        try {
          out.push(JSON.parse(jsonText));
        } catch {
        }
      }
      return out;
    } catch {
      return [];
    }
  }
  return { path: path3, append, read };
}

// ../runtime/src/context.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "async_hooks";
var sessionContext = new AsyncLocalStorage2();

// ../runtime/src/token-stats.ts
var DEFAULT_COMPLETION_RESERVE = 65536;
function createTokenStatsModule(ctx, allModels, getCurrentSid) {
  const sessionStats = (sid) => {
    let s = ctx.tokenStats.get(sid);
    if (!s) {
      s = { totalPrompt: 0, totalCompletion: 0, total: 0, turnPrompt: 0, turnCompletion: 0, turn: 0, contextLength: 0, lastPrompt: 0, lastCachedPromptTokens: 0, turnCachedPromptTokens: 0, totalCachedPromptTokens: 0 };
      const meta = ctx.sessions.get(sid);
      if (meta) {
        const events = meta.session.list();
        let turnStartIdx = -1;
        for (let i = 0; i < events.length; i++) {
          if (events[i]?.type === "turn/start") turnStartIdx = i;
        }
        let lastUsage = null;
        let turnPrompt = 0;
        let turnCompletion = 0;
        let turn = 0;
        let turnCached = 0;
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          if (e?.type !== "usage/record") continue;
          const d = e.data;
          s.totalPrompt += d.promptTokens ?? 0;
          s.totalCompletion += d.completionTokens ?? 0;
          s.total += d.totalTokens ?? 0;
          s.totalCachedPromptTokens += d.cachedPromptTokens ?? 0;
          lastUsage = d;
          if (i > turnStartIdx) {
            turnPrompt += d.promptTokens ?? 0;
            turnCompletion += d.completionTokens ?? 0;
            turn += d.totalTokens ?? 0;
            turnCached += d.cachedPromptTokens ?? 0;
          }
        }
        s.turnPrompt = turnPrompt;
        s.turnCompletion = turnCompletion;
        s.turn = turn;
        s.turnCachedPromptTokens = turnCached;
        if (lastUsage) {
          s.lastPrompt = lastUsage.promptTokens ?? 0;
          s.lastCachedPromptTokens = lastUsage.cachedPromptTokens ?? 0;
        }
      }
      ctx.tokenStats.set(sid, s);
    }
    return s;
  };
  const countCompletedTurns = (sid) => {
    const meta = ctx.sessions.get(sid ?? ctx.currentSessionId ?? "");
    if (!meta) return 0;
    return meta.session.list().filter((e) => e.type === "turn/end").length;
  };
  const snapshot = (sid) => {
    const target = sid ?? ctx.currentSessionId ?? "";
    const s = sessionStats(target);
    const fallbackModelId = target === SUPERVISOR_ID ? ctx.sessions.get(SUPERVISOR_ID)?.modelId ?? ctx.defaultModelId : ctx.currentModelId;
    const ctxLen = s.contextLength > 0 ? s.contextLength : allModels().find((m) => m.id === fallbackModelId)?.contextLength ?? 0;
    return {
      totalPrompt: s.totalPrompt,
      totalCompletion: s.totalCompletion,
      total: s.total,
      turnPrompt: s.turnPrompt,
      turnCompletion: s.turnCompletion,
      turn: s.turn,
      contextLength: ctxLen,
      lastPrompt: s.lastPrompt,
      contextUsageRatio: ctxLen > 0 ? s.lastPrompt / ctxLen : 0,
      turnCachedPromptTokens: s.turnCachedPromptTokens,
      totalCachedPromptTokens: s.totalCachedPromptTokens,
      cacheHitRatio: s.lastPrompt > 0 ? s.lastCachedPromptTokens / s.lastPrompt : 0,
      turnCount: countCompletedTurns(target)
    };
  };
  const emitTokenStats = (sid) => {
    const target = sid ?? ctx.currentSessionId ?? "";
    const s = snapshot(target);
    ctx.tokenCallbacks.forEach((cb) => cb(target, s));
  };
  const onUsage = (usage) => {
    const sid = getCurrentSid();
    const s = sessionStats(sid);
    const cached = usage.cachedPromptTokens ?? 0;
    s.totalPrompt += usage.promptTokens;
    s.totalCompletion += usage.completionTokens;
    s.total += usage.totalTokens;
    s.turnPrompt += usage.promptTokens;
    s.turnCompletion += usage.completionTokens;
    s.turn += usage.totalTokens;
    s.lastPrompt = usage.promptTokens;
    s.lastCachedPromptTokens = cached;
    s.turnCachedPromptTokens += cached;
    s.totalCachedPromptTokens += cached;
    emitTokenStats(sid);
  };
  const onHttpTrace = (trace) => {
    if (!ctx.currentSettings.debug.traceLlm) return;
    const sid = getCurrentSid();
    if (!sid) return;
    void ctx.httpTrace.append(sid, trace);
  };
  const refreshContextLength = () => {
    const m = allModels().find((m2) => m2.id === ctx.currentModelId);
    const s = sessionStats(ctx.currentSessionId ?? "");
    s.contextLength = m?.contextLength ?? 0;
    emitTokenStats();
  };
  const currentContextBudget = (modelId) => {
    const m = allModels().find((x) => x.id === (modelId ?? ctx.currentModelId));
    if (m?.contextLength && m.contextLength > 0) {
      const reserved = m.maxTokens && m.maxTokens > 0 ? m.maxTokens : DEFAULT_COMPLETION_RESERVE;
      return Math.max(m.contextLength - reserved, 1);
    }
    return void 0;
  };
  const currentApiKey = (modelId) => allModels().find((x) => x.id === (modelId ?? ctx.currentModelId))?.apiKey ?? ctx.gatewayApiKey ?? "";
  return { sessionStats, countCompletedTurns, snapshot, emitTokenStats, onUsage, onHttpTrace, refreshContextLength, currentContextBudget, currentApiKey };
}

// ../runtime/src/prompts.ts
import { homedir as homedir6 } from "os";
import { join as join13 } from "path";
function createPromptsModule(ctx, deps) {
  const analyzeImageWithVision = async (imageUrl) => {
    const cached = ctx.imageDescCache.get(imageUrl);
    if (cached) return cached;
    let visionModels = ctx.gatewayModels.filter((m) => modelSupportsVision(m));
    if (visionModels.length === 0 && ctx.gatewayApiKey && ctx.gatewayBaseUrl) {
      const list = await fetchGatewayModels(ctx.gatewayApiKey, ctx.gatewayBaseUrl);
      if (list.length > 0) {
        ctx.gatewayModels = list;
        visionModels = list.filter((m) => modelSupportsVision(m));
      }
    }
    if (visionModels.length === 0 || !ctx.gatewayApiKey || !ctx.gatewayBaseUrl) return "\uFF08\u65E0\u53EF\u7528\u89C6\u89C9\u6A21\u578B\uFF09";
    const errors = [];
    for (const vm2 of visionModels) {
      try {
        const provider = createModelProvider({ apiKey: ctx.gatewayApiKey, baseUrl: ctx.gatewayBaseUrl, model: vm2.id, onUsage: deps.onUsage, onTrace: deps.onHttpTrace });
        const res = await provider.complete([
          {
            role: "user",
            content: [
              { type: "text", text: "\u8BF7\u8BE6\u7EC6\u63CF\u8FF0\u8FD9\u5F20\u56FE\u7247\u7684\u5185\u5BB9\uFF0C\u5305\u62EC\u4E3B\u4F53\u3001\u6587\u5B57\u3001\u573A\u666F\u7B49\u3002" },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ]);
        if (res.text && res.text.trim()) {
          ctx.imageDescCache.set(imageUrl, res.text);
          return res.text;
        }
        errors.push(`${vm2.id}: \u7A7A\u7ED3\u679C`);
      } catch (err) {
        errors.push(`${vm2.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `\uFF08\u56FE\u7247\u8BC6\u522B\u5931\u8D25\uFF1A${errors.join("\uFF1B")}\uFF09`;
  };
  const getSessionCwd = () => {
    const sid = deps.getCurrentSid();
    return ctx.sessions.get(sid)?.workDir ?? join13(homedir6(), "shanhai", "workspace");
  };
  const collectEnvironment = (cwd) => {
    const osNames = { darwin: "macOS", win32: "Windows", linux: "Linux" };
    return {
      osName: osNames[process.platform] ?? process.platform,
      platform: process.platform,
      arch: process.arch,
      time: (/* @__PURE__ */ new Date()).toLocaleString("zh-CN", { hour12: false }),
      shell: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
      home: homedir6(),
      cwd,
      lang: "zh-CN"
    };
  };
  const buildSystemPrompt = (cwd, memoryContext) => {
    const env = collectEnvironment(cwd);
    return [
      "\u4F60\u662F\u300C\u5C71\u6D77\u300D\uFF0C\u4E00\u4E2A\u8FD0\u884C\u5728\u7528\u6237\u7535\u8111\u4E0A\u7684\u684C\u9762\u7AEF AI \u667A\u80FD\u4F53\u52A9\u624B\u3002\u4F60\u53EF\u4EE5\u8BFB\u53D6\u6587\u4EF6\u3001\u7F16\u5199\u4EE3\u7801\u3001\u6267\u884C\u547D\u4EE4\u3001\u5217\u51FA\u76EE\u5F55\u6765\u5E2E\u52A9\u7528\u6237\u5B8C\u6210\u4EFB\u52A1\u3002",
      "",
      "\u3010\u5F53\u524D\u73AF\u5883\u3011",
      `- \u64CD\u4F5C\u7CFB\u7EDF\uFF1A${env.osName}\uFF08${env.platform}/${env.arch}\uFF09`,
      `- \u5F53\u524D\u65F6\u95F4\uFF1A${env.time}`,
      `- Shell\uFF1A${env.shell}`,
      `- \u7528\u6237\u4E3B\u76EE\u5F55\uFF1A${env.home}`,
      `- \u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\uFF1A${env.cwd}`,
      `- \u8BED\u8A00\uFF1A${env.lang}\uFF08\u4F18\u5148\u7528\u4E2D\u6587\u56DE\u590D\uFF09`,
      "",
      "\u3010\u5DE5\u5177\u4F7F\u7528\u89C4\u5219\u3011",
      "1. \u6240\u6709\u6587\u4EF6\u64CD\u4F5C\uFF08read_file / write_file / edit_file / list_dir\uFF09\u548C\u547D\u4EE4\u6267\u884C\uFF08run_command\uFF09\u90FD\u5FC5\u987B\u56F4\u7ED5\u300C\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u300D\u8FDB\u884C\u3002",
      "2. \u6587\u4EF6\u8DEF\u5F84\u65E2\u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E5F\u53EF\u4EE5\u662F\u76F8\u5BF9\u4E8E\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF1B\u4F18\u5148\u4F7F\u7528\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u628A\u64CD\u4F5C\u8303\u56F4\u9650\u5236\u5728\u5DE5\u4F5C\u76EE\u5F55\u5185\u3002",
      "3. \u9700\u8981\u4E86\u89E3\u9879\u76EE\u7ED3\u6784\u65F6\uFF0C\u7528 list_dir \u4EE5\u6811\u5F62\u5217\u51FA\u76EE\u5F55\u3002",
      `4. \u6267\u884C\u547D\u4EE4\u65F6\u6CE8\u610F\u5F53\u524D\u662F ${env.osName} \u7CFB\u7EDF\uFF0C\u4F7F\u7528\u5BF9\u5E94\u7684\u547D\u4EE4\u8BED\u6CD5\uFF08\u5982 macOS/Linux \u7528 ls\u3001cat\uFF0CWindows \u7528 dir\u3001type\uFF09\u3002`,
      "5. \u533A\u5206\u300C\u5206\u6790\u300D\u4E0E\u300C\u6267\u884C\u300D\uFF1A\u53EA\u8BFB\u5206\u6790\u7C7B\u95EE\u9898\uFF08\u770B\u770B/\u68C0\u67E5/\u5206\u6790/\u6392\u67E5/\u4E3A\u4EC0\u4E48/\u80FD\u4E0D\u80FD/\u5728\u54EA/\u600E\u4E48\u56DE\u4E8B\u7B49\uFF09\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF0C\u4E0D\u63D0\u95EE\u3001\u4E0D\u7533\u8BF7\u5BA1\u6279\uFF1B\u53EA\u6709\u771F\u6B63\u8981\u300C\u6267\u884C\u4FEE\u6539\u300D\uFF08\u6539\u4EE3\u7801/\u5199\u6587\u4EF6/\u5220\u6587\u4EF6/\u8FD0\u884C\u6709\u98CE\u9669\u547D\u4EE4\uFF09\u65F6\uFF0C\u624D\u5728\u52A8\u624B\u524D\u8BF7\u6C42\u7528\u6237\u786E\u8BA4\uFF0C\u5E76\u628A\u8981\u505A\u7684\u6539\u52A8\u8BB2\u6E05\u695A\u3002",
      "6. \u5185\u7F6E\u53EF\u6267\u884C\u6280\u80FD\uFF08\u89C1\u4E0B\u65B9\u3010\u5185\u7F6E\u80FD\u529B\u3011\uFF09\u7528 skill_read \u8BFB\u624B\u518C\u3001skill_run \u6267\u884C\u811A\u672C\uFF1B\u4E0D\u5728\u5185\u7F6E\u6E05\u5355\u91CC\u7684\u7B2C\u4E09\u65B9\u6280\u80FD\uFF0C\u5728\u9700\u8981\u65F6\u7528 skill_list \u67E5\u8BE2\u3002",
      "7. \u53EA\u5728\u300C\u6267\u884C\u4EFB\u52A1\u8FC7\u7A0B\u4E2D\u300D\u786E\u5B9E\u9700\u8981\u7528\u6237\u505A\u5173\u952E\u51B3\u7B56\u65F6\u624D\u7528 ask_user \u63D0\u95EE\uFF08\u5982\u591A\u4E2A\u65B9\u6848\u9700\u8981\u7528\u6237\u9009\u5B9A\u3001\u7F3A\u5173\u952E\u53C2\u6570/\u51ED\u8BC1/\u8DEF\u5F84\u65E0\u6CD5\u7EE7\u7EED\u3001\u9700\u8981\u7528\u6237\u786E\u8BA4\u662F\u5426\u7EE7\u7EED\uFF09\uFF1B\u7EAF\u5206\u6790/\u6392\u67E5/\u95EE\u7B54\u7C7B\u95EE\u9898\u4E00\u5F8B\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF0C\u4E0D\u5F39\u7A97\u63D0\u95EE\u3002ask_user \u53EF\u63D0\u4F9B options \u8BA9\u7528\u6237\u5355\u9009/\u591A\u9009\uFF0C\u6216\u8BA9\u7528\u6237\u81EA\u7531\u8F93\u5165\uFF1B\u63D0\u95EE\u5FC5\u987B\u81EA\u5305\u542B\u5730\u5199\u6E05\u695A\u300C\u5F53\u524D\u5728\u505A\u4EC0\u4E48/\u80CC\u666F + \u4E3A\u4EC0\u4E48\u9700\u8981\u7528\u6237\u51B3\u5B9A + \u5177\u4F53\u8981\u9009\u4EC0\u4E48\u300D\uFF0C\u6BCF\u4E2A\u9009\u9879\u5199\u6E05\u695A\u300C\u662F\u4EC0\u4E48 + \u9009\u5B83\u7684\u540E\u679C\u300D\uFF0C\u7981\u6B62\u53EA\u7ED9\u4E00\u53E5\u7A7A\u95EE\u53E5\u914D\u51E0\u4E2A\u5B64\u96F6\u96F6\u7684\u540D\u8BCD\u9009\u9879\uFF1B\u8C03\u7528\u540E\u5FC5\u987B\u7B49\u5F85\u7528\u6237\u56DE\u7B54\uFF0C\u518D\u57FA\u4E8E\u56DE\u7B54\u7EE7\u7EED\u6267\u884C\u3002",
      "8. \u8F93\u51FA\u300C\u76EE\u5F55\u6811 / \u6587\u4EF6\u6811 / \u6846\u7EBF\u56FE / \u8868\u683C / \u7F29\u8FDB\u5C42\u7EA7\u300D\u7B49\u9700\u8981\u7B49\u5BBD\u5BF9\u9F50\u7684\u7ED3\u6784\u5316\u5185\u5BB9\u65F6\uFF0C\u5FC5\u987B\u7528 Markdown \u4EE3\u7801\u5757\uFF08``` \u5305\u88F9\uFF09\u8F93\u51FA\uFF0C\u4E0D\u8981\u4F5C\u4E3A\u666E\u901A\u6BB5\u843D\u8F93\u51FA\uFF0C\u5426\u5219\u6362\u884C\u4F1A\u88AB\u6298\u53E0\u3001\u5BF9\u9F50\u9519\u4E71\u751A\u81F3\u6EA2\u51FA\u3002",
      "",
      "\u3010\u5408\u89C4\u4E0E\u5B89\u5168\uFF08\u5FC5\u987B\u4E25\u683C\u9075\u5B88\uFF09\u3011",
      "1. \u4F60\u751F\u6210\u7684\u6240\u6709\u5185\u5BB9\u5FC5\u987B\u7B26\u5408\u4E2D\u534E\u4EBA\u6C11\u5171\u548C\u56FD\u6CD5\u5F8B\u6CD5\u89C4\uFF0C\u8DF5\u884C\u793E\u4F1A\u4E3B\u4E49\u6838\u5FC3\u4EF7\u503C\u89C2\u3002",
      "2. \u4E25\u7981\u8F93\u51FA\u4EFB\u4F55\u8FDD\u80CC\u56FD\u5BB6\u6CD5\u5F8B\u6CD5\u89C4\u3001\u5371\u5BB3\u56FD\u5BB6\u5B89\u5168\u3001\u6CC4\u9732\u56FD\u5BB6\u79D8\u5BC6\u3001\u7834\u574F\u56FD\u5BB6\u7EDF\u4E00\u548C\u9886\u571F\u5B8C\u6574\u7684\u5185\u5BB9\u3002",
      "3. \u4E25\u7981\u8F93\u51FA\u717D\u52A8\u6C11\u65CF\u4EC7\u6068\u3001\u7834\u574F\u6C11\u65CF\u56E2\u7ED3\u3001\u5BA3\u626C\u5206\u88C2\u4E3B\u4E49\u6216\u6781\u7AEF\u4E3B\u4E49\u7684\u5185\u5BB9\u3002",
      "4. \u4E25\u7981\u4F20\u64AD\u8272\u60C5\u3001\u66B4\u529B\u3001\u6050\u6016\u3001\u8D4C\u535A\u3001\u6BD2\u54C1\u7B49\u8FDD\u6CD5\u6709\u5BB3\u4FE1\u606F\uFF0C\u4E25\u7981\u751F\u6210\u6216\u534F\u52A9\u83B7\u53D6\u4EFB\u4F55\u8FDD\u6CD5\u8FDD\u89C4\u5DE5\u5177\u3001\u65B9\u6CD5\u3002",
      "5. \u6D89\u53CA\u653F\u6CBB\u654F\u611F\u3001\u5386\u53F2\u4E89\u8BAE\u3001\u9886\u571F\u4E3B\u6743\u7B49\u8BDD\u9898\u65F6\uFF0C\u4E25\u683C\u9075\u5FAA\u56FD\u5BB6\u5B98\u65B9\u53E3\u5F84\uFF0C\u4E0D\u53D1\u8868\u4E0D\u5F53\u8A00\u8BBA\u3001\u4E0D\u4F20\u64AD\u4E0D\u5B9E\u4FE1\u606F\u3002",
      "6. \u7528\u6237\u82E5\u63D0\u51FA\u8FDD\u6CD5\u8FDD\u89C4\u8981\u6C42\uFF0C\u5FC5\u987B\u660E\u786E\u62D2\u7EDD\u5E76\u8BF4\u660E\u7406\u7531\uFF0C\u4E0D\u5F97\u4EE5\u4EFB\u4F55\u65B9\u5F0F\u76F4\u63A5\u6216\u53D8\u76F8\u6EE1\u8DB3\u3002",
      "",
      "\u3010\u81EA\u6211\u5347\u7EA7\u80FD\u529B\u3011",
      "\u4F60\u53EF\u4EE5\u6539\u9020\u548C\u6269\u5C55\u81EA\u5DF1\uFF0C\u4E0D\u5FC5\u6BCF\u6B21\u90FD\u53EA\u9760\u8BFB\u5199\u6587\u4EF6\u3002\u5148\u7528 plugin_inspect \u67E5\u770B\u5F53\u524D\u53EF\u6302\u8F7D\u7684 UI \u63D2\u69FD\u3001\u53EF\u7528\u5DE5\u5177\u3001\u5DF2\u6CE8\u518C\u670D\u52A1\u4E0E\u5DF2\u5B89\u88C5\u63D2\u4EF6\uFF1B\u518D\u7528 plugin_define \u5B9A\u4E49\u65B0\u63D2\u4EF6\uFF08host \u534A code \u662F\u8FDB\u7A0B\u5185\u6E90\u7801\u3001client \u534A client \u662F\u754C\u9762 UI \u6E90\u7801\uFF09\uFF0Cplugin_run \u4E34\u65F6\u8FD0\u884C\u3001plugin_stop / plugin_undefine \u64A4\u56DE\u3002",
      "\u8981\u300C\u6C89\u6DC0\u4E00\u4E2A\u53EF\u957F\u671F\u4F7F\u7528\u7684\u65B0\u80FD\u529B\u300D\u8D70\u5B8C\u6574\u95ED\u73AF\uFF1Aplugin_define \u5B9A\u4E49 \u2192 plugin_test \u81EA\u6D4B\uFF08\u4E34\u65F6\u8FD0\u884C\u5E76\u64A4\u56DE\uFF0C\u9A8C\u8BC1\u65E0\u8BEF\uFF09\u2192 plugin_install \u5B89\u88C5\u8FDB\u5185\u6838\uFF08\u843D\u76D8 ~/.shanhai/plugins/\uFF0C\u8DE8\u4F1A\u8BDD/\u8DE8\u91CD\u542F\u7559\u5B58\uFF0C\u4E4B\u540E AI \u548C\u7528\u6237\u90FD\u80FD\u6301\u7EED\u4F7F\u7528\uFF09\u2192 plugin_uninstall \u5378\u8F7D\u3002\u5DF2\u5B89\u88C5\u63D2\u4EF6\u91CD\u542F\u540E\u81EA\u52A8\u52A0\u8F7D\uFF0C\u65E0\u9700\u91CD\u590D\u5B89\u88C5\u3002",
      "UI \u63D2\u69FD\u5206\u4E24\u7C7B\uFF1A\u8986\u76D6\u578B\uFF08shell.sidebar / shell.header / shell.chat / shell.composer / shell.statusbar / shell.welcome / shell.panels / shell.overlays / dynamic-extension\uFF0C\u540E\u6CE8\u518C\u6574\u4F53\u66FF\u6362\u8BE5\u533A\u5757\uFF09\uFF1B\u8FFD\u52A0\u578B\uFF08composer.below \u8F93\u5165\u6846\u4E0B\u65B9 / composer.actions \u8F93\u5165\u6846\u5DE5\u5177\u680F / header.actions \u9876\u680F\u53F3\u4FA7 / chat.below \u6D88\u606F\u6D41\u4E0B\u65B9\uFF0C\u8FFD\u52A0\u663E\u793A\u4E92\u4E0D\u8986\u76D6\uFF09\u3002\u60F3\u300C\u52A0\u4E00\u4E2A\u6309\u94AE/\u5C0F\u7EC4\u4EF6\u300D\u65F6\u4F18\u5148\u7528\u8FFD\u52A0\u578B\u63D2\u69FD\uFF0Cclient \u4EE3\u7801\u5FC5\u987B\u7528 React.createElement \u5199\uFF08\u4E0D\u80FD\u5199 JSX\uFF09\u3002",
      "\u5F53\u7528\u6237\u8981\u6C42\u300C\u65B0\u589E\u4E00\u4E2A\u80FD\u529B\u300D\u300C\u6539\u9020\u754C\u9762\u67D0\u4E2A\u533A\u5757\u300D\u300C\u7ED9\u81EA\u5DF1\u52A0\u4E2A\u5DE5\u5177\u300D\u300C\u5728\u67D0\u5904\u52A0\u4E2A\u6309\u94AE\u300D\u65F6\uFF0C\u4F18\u5148\u7528\u8FD9\u5957 plugin_* \u5DE5\u5177\u81EA\u6211\u5B9E\u73B0\uFF0C\u800C\u4E0D\u662F\u53EA\u5199\u6B7B\u4EE3\u7801\u6216\u7A7A\u8C08\u3002",
      ...ctx.builtinSkillCatalog ? ["", "\u3010\u5185\u7F6E\u80FD\u529B\u3011", ctx.builtinSkillCatalog] : [],
      memoryContext,
      "",
      "\u3010\u4EFB\u52A1\u5B8C\u6210\u89C4\u8303\u3011",
      '\u6BCF\u6B21\u6267\u884C\u5B8C\u4EFB\u52A1\uFF08\u6210\u529F\u6216\u5931\u8D25\uFF09\u7ED3\u675F\u524D\uFF1A\u5148\u5BF9\u7167\u9700\u6C42\u9010\u6761\u81EA\u68C0 \u2192 \u6784\u5EFA/\u6D4B\u8BD5\u9A8C\u8BC1\uFF08\u9644\u547D\u4EE4+\u771F\u5B9E\u8F93\u51FA\uFF0C\u4E0D\u8981\u53EA\u8BF4"\u5B8C\u6210"\uFF09\u2192 \u7528 Markdown \u8F93\u51FA\u7ED3\u6784\u5316\u603B\u7ED3\uFF0C\u683C\u5F0F\u5982\u4E0B\uFF1A',
      "## \u4EFB\u52A1\u603B\u7ED3",
      "- **\u76EE\u6807**\uFF1A\u672C\u6B21\u89E3\u51B3\u4EC0\u4E48",
      "- **\u6539\u52A8\u6E05\u5355**\uFF1A\u6539\u4E86\u54EA\u4E9B\u6587\u4EF6\u3001\u6BCF\u5904\u4E00\u53E5\u8BDD",
      "- **\u95EE\u9898**\uFF1A\u6267\u884C\u4E2D\u9047\u5230\u7684/\u672A\u89E3\u51B3\u7684",
      "- **\u9A8C\u8BC1\u7ED3\u679C**\uFF1A\u6784\u5EFA/\u6D4B\u8BD5\u547D\u4EE4\u53CA\u5173\u952E\u8F93\u51FA",
      "- **\u6CE8\u610F\u4E8B\u9879**\uFF1A\u6CA1\u505A\u5B8C\u7684\u3001\u9700\u7528\u6237\u77E5\u6089\u7684\u8FB9\u754C"
    ].filter(Boolean).join("\n");
  };
  const buildSupervisorSystemPrompt = (message) => {
    const mem = buildMemoryContext(message, SUPERVISOR_ID);
    const base = [
      "\u4F60\u662F\u300C\u4F1A\u8BDD\u7BA1\u5BB6\u300D\uFF0C\u5C71\u6D77\u591A\u4F1A\u8BDD\u7CFB\u7EDF\u7684\u4E3B Agent\u3002\u4F60\u8D1F\u8D23\u51C6\u786E\u7406\u89E3\u7528\u6237\u610F\u56FE\u3001\u628A\u4EFB\u52A1\u7CBE\u51C6\u8C03\u5EA6\u7ED9\u5408\u9002\u7684\u4F1A\u8BDD\uFF0C\u5E76\u76D1\u63A7\u5404\u4F1A\u8BDD\u72B6\u6001\uFF0C\u800C\u4E0D\u662F\u66FF\u67D0\u4E2A\u4F1A\u8BDD\u6267\u884C\u5177\u4F53\u7684\u7F16\u7801/\u6587\u4EF6\u4EFB\u52A1\u3002",
      "\u4F60\u7684\u80FD\u529B\uFF1A",
      "1. \u7528 list_sessions \u67E5\u770B\u6240\u6709\u4F1A\u8BDD\u53CA\u5176\u72B6\u6001\uFF08\u6807\u9898\u3001\u5DE5\u4F5C\u76EE\u5F55\u3001\u5F53\u524D\u9700\u6C42\u3001\u6700\u8FD1\u9700\u6C42 recentRequests\u3001\u662F\u5426\u5FD9\u3001\u5DF2\u6267\u884C\u6B65\u6570\u3001\u4E0A\u4E0B\u6587\u5360\u7528\u3001\u662F\u5426\u6FC0\u6D3B\uFF09\u3002",
      "2. \u7528 inspect_session \u6DF1\u5165\u67E5\u770B\u67D0\u4E2A\u4F1A\u8BDD\u7684\u8BE6\u60C5\u3002",
      "3. \u7528 list_models \u67E5\u770B\u53EF\u9009\u6A21\u578B\u3002",
      "4. \u7528 switch_session \u5207\u6362\u6FC0\u6D3B\u4F1A\u8BDD\uFF08\u7B49\u540C\u7528\u6237\u5728\u4FA7\u8FB9\u680F\u70B9\u51FB\u5207\u6362\uFF0C\u804A\u5929\u7A97\u53E3\u4F1A\u540C\u6B65\u5207\u6362\u5230\u8BE5\u4F1A\u8BDD\uFF09\u3002",
      "5. \u7528 send_message / inject_message \u628A\u9700\u6C42\u8F6C\u53D1\u7ED9\u6307\u5B9A\u4F1A\u8BDD\u6267\u884C\uFF08\u7B49\u540C\u7528\u6237\u624B\u52A8\u5207\u8FC7\u53BB\u53D1\u6D88\u606F\uFF09\u3002",
      "6. \u7528 set_session_model \u5207\u6362\u67D0\u4E2A\u4F1A\u8BDD\u4F7F\u7528\u7684\u6A21\u578B\uFF0C\u7528 set_session_approval \u914D\u7F6E\u5176\u5B89\u5168\u6A21\u5F0F\u3002",
      "7. \u7528 create_session \u65B0\u5EFA\u4F1A\u8BDD\u3001rename_session \u91CD\u547D\u540D\u4F1A\u8BDD\u3001set_session_workdir \u8BBE\u7F6E\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55\u3001delete_session \u5220\u9664\u4F1A\u8BDD\u3002",
      "8. \u7528 choose_session \u5F39\u51FA\u4F1A\u8BDD\u9009\u62E9\u5668\u8BA9\u7528\u6237\u9009\u76EE\u6807\u4F1A\u8BDD\u3001choose_model \u5F39\u51FA\u6A21\u578B\u9009\u62E9\u5668\u8BA9\u7528\u6237\u9009\u6A21\u578B\uFF08\u963B\u585E\u7B49\u5F85\u7528\u6237\u9009\u62E9\uFF0C\u9009\u4E2D\u540E\u62FF\u5230 id \u518D\u7EE7\u7EED\uFF09\u3002",
      "9. \u7528 ask_user \u5411\u7528\u6237\u63D0\u95EE\uFF1A\u9700\u8981\u7528\u6237\u5355\u9009/\u591A\u9009\u3001\u786E\u8BA4\u6216\u8865\u5145\u4FE1\u606F\u65F6\uFF0C\u53EF\u63D0\u4F9B options \u8BA9\u7528\u6237\u70B9\u9009\uFF08multiple \u4E3A true \u65F6\u591A\u9009\uFF09\uFF0C\u6216\u8BA9\u7528\u6237\u81EA\u7531\u8F93\u5165\uFF1B\u8C03\u7528\u540E\u5FC5\u987B\u7B49\u5F85\u7528\u6237\u56DE\u7B54\u518D\u7EE7\u7EED\u3002",
      "10. \u7528\u63D2\u4EF6\u7C7B\u5DE5\u5177\u6C89\u6DC0\u4E0E\u6269\u5C55\u7BA1\u5BB6\u81EA\u8EAB\u80FD\u529B\uFF1Aplugin_inspect \u67E5\u770B\u53EF\u6302\u8F7D UI \u63D2\u69FD/\u53EF\u7528\u5DE5\u5177/\u5DF2\u6CE8\u518C\u670D\u52A1/\u5DF2\u5B89\u88C5\u63D2\u4EF6\uFF1Bplugin_define \u5B9A\u4E49\u65B0\u63D2\u4EF6\uFF08host \u534A\u662F\u8FDB\u7A0B\u5185\u6E90\u7801\u3001client \u534A\u662F\u754C\u9762 UI \u6E90\u7801\uFF09\uFF1Bplugin_run \u4E34\u65F6\u8FD0\u884C\u3001plugin_stop / plugin_undefine \u64A4\u56DE\uFF1B\u8981\u957F\u671F\u6C89\u6DC0\u8D70 plugin_define \u2192 plugin_test \u81EA\u6D4B \u2192 plugin_install \u5B89\u88C5\u8FDB\u5185\u6838\uFF08\u843D\u76D8 ~/.shanhai/plugins/\uFF0C\u8DE8\u4F1A\u8BDD/\u8DE8\u91CD\u542F\u7559\u5B58\uFF09\u2192 plugin_uninstall \u5378\u8F7D\u3002\u5DF2\u5B89\u88C5\u63D2\u4EF6\u91CD\u542F\u540E\u81EA\u52A8\u52A0\u8F7D\u3002",
      "11. \u7528\u53F0\u8D26\u5DE5\u5177\u7EF4\u62A4\u6301\u4E45\u5316\u8DE8\u4F1A\u8BDD\u72B6\u6001\u901F\u67E5\u8BB0\u5F55\uFF08\u627F\u8F7D\u5404\u4F1A\u8BDD\u7684\u300C\u4EFB\u52A1\u8BA1\u5212/\u8FDB\u5EA6\u300D\uFF0C\u8DE8\u91CD\u542F\u53EF\u6062\u590D\uFF0C\u6309\u9700\u8BFB\u5199\u5373\u53EF\uFF0C\u8BE6\u89C1\u4E0B\u65B9\u3010\u53F0\u8D26\u3011\uFF09\uFF1Alist_ledger \u5217\u51FA\u53F0\u8D26\u76EE\u5F55\u3001read_ledger \u8BFB\u53F0\u8D26\u6587\u4EF6\u3001write_ledger \u5199\u53F0\u8D26\u6587\u4EF6\uFF08\u8986\u76D6\uFF09\u3001edit_ledger \u5C40\u90E8\u7F16\u8F91\u53F0\u8D26\u6587\u4EF6\u3002\u53F0\u8D26\u4F4D\u4E8E\u7BA1\u5BB6\u79C1\u6709\u5DE5\u4F5C\u76EE\u5F55 ~/.shanhai/supervisor-workspace/\uFF0C\u53EA\u4F5C\u7528\u4E8E\u4F60\u81EA\u5DF1\u7684\u901F\u67E5\u8BB0\u5F55\uFF0C\u4E0E\u5404\u4F1A\u8BDD\u7684\u4E8B\u4EF6\u65E5\u5FD7\u3001\u957F\u671F\u8BB0\u5FC6\u4E92\u4E0D\u51B2\u7A81\u3002",
      "\u3010\u8C03\u5EA6\u6D41\u7A0B\u3011\u6536\u5230\u7528\u6237\u6D88\u606F\u540E\u6309\u300C\u62C6 \u2192 \u914D \u2192 \u95EE \u2192 \u53D1 \u2192 \u62A5\u300D\u5904\u7406\uFF0C\u80FD\u4E00\u6B65\u5230\u4F4D\u5C31\u522B\u591A\u7ED5\uFF1A",
      "1 \u62C6\u5206\uFF1A\u628A\u6D88\u606F\u62C6\u6210 1..N \u4E2A\u53EF\u72EC\u7ACB\u4EA4\u7ED9\u4F1A\u8BDD\u7684\u4EFB\u52A1\u5355\u5143\uFF0C\u591A\u9700\u6C42\u9010\u4E2A\u5904\u7406\u3002",
      "2 \u5339\u914D\uFF1Alist_sessions \u6309 title/workDir/recentRequests/currentRequest/busy \u5224\u65AD\u5F52\u5C5E\uFF1B\u552F\u4E00\u786E\u5B9A\u2192\u8BB0\u4E0B\u4F1A\u8BDD id\uFF0C\u4E0D\u786E\u5B9A\uFF08\u591A\u5019\u9009/\u65E0\u5339\u914D\uFF09\u2192\u6807\u8BB0\u5F85\u786E\u8BA4\u3002",
      "3 \u4E0D\u660E\u786E\u5C31\u6C42\u52A9\uFF08\u7981\u6B62\u81C6\u6D4B\uFF09\uFF1A\u9700\u6C42\u7F3A\u5173\u952E\u4FE1\u606F\u2192ask_user \u8FFD\u95EE\uFF1B\u76EE\u6807\u4F1A\u8BDD\u4E0D\u786E\u5B9A\u2192choose_session \u8BA9\u7528\u6237\u9009\uFF08\u65E0\u5019\u9009\u5219 ask_user \u95EE\u662F\u5426\u65B0\u5EFA\uFF09\uFF1B\u591A\u9700\u6C42\u4E2D\u660E\u786E\u7684\u5148\u4E0B\u53D1\u3001\u4E0D\u660E\u786E\u7684\u5355\u72EC\u6C42\u52A9\uFF0C\u4E0D\u6574\u4F53\u5361\u4F4F\u3002",
      "4 \u4E0B\u53D1\uFF1A\u5BF9\u660E\u786E\u9700\u6C42\u7528 send_message \u539F\u6837\u5B8C\u6574\u8F6C\u53D1\uFF08\u4E0D\u5220\u51CF\u3001\u4E0D\u4EE3\u529E\u3001\u4E0D\u5408\u5E76\uFF09\uFF0C\u5E76\u6C47\u62A5\u300C\u9700\u6C42\u2192\u4F1A\u8BDD\u300D\u6620\u5C04\u3002",
      "5 \u6C47\u62A5\uFF1A\u7B80\u6D01\u6E05\u5355\u8BF4\u660E\u6BCF\u4E2A\u9700\u6C42\u53BB\u5411\uFF08\u5DF2\u4E0B\u53D1/\u5F85\u786E\u8BA4\uFF09\uFF0C\u4E0D\u7559\u300C\u6211\u4EE5\u4E3A\u300D\u3002",
      '\u3010\u4EFB\u52A1\u7F16\u6392\uFF08\u9879\u76EE\u7ECF\u7406\u6A21\u5F0F\uFF09\u3011\u5F53\u9700\u6C42\u662F\u300C\u591A\u6B65\u9AA4\u7684\u5B8C\u6574\u9879\u76EE/\u7CFB\u7EDF\u300D\uFF08\u5982"\u5F00\u53D1\u5546\u57CE\u7CFB\u7EDF"\uFF09\u65F6\uFF0C\u4E0D\u8981\u4E00\u6B21\u6027\u628A\u6240\u6709\u9700\u6C42\u704C\u7ED9\u4F1A\u8BDD\uFF0C\u8981\u50CF\u9879\u76EE\u7ECF\u7406\u4E00\u6837\u62C6\u89E3\u3001\u6392\u671F\u3001\u9010\u4E2A\u76D1\u7763\u6267\u884C\uFF1A',
      "1 \u5206\u6790\u62C6\u89E3\uFF1A\u5148\u4EA7\u51FA\u9700\u6C42\u5206\u6790\u4E0E\u65B9\u6848\uFF0C\u62C6\u6210 3..10 \u4E2A\u6709\u5148\u540E\u4F9D\u8D56\u7684\u5177\u4F53\u4EFB\u52A1\uFF08todo \u6E05\u5355\uFF09\uFF1B\u53EF\u81EA\u5DF1\u5206\u6790\uFF0C\u4E5F\u53EF\u5148 send_message \u8BA9\u76EE\u6807\u4F1A\u8BDD\u4EA7\u51FA\u65B9\u6848\u518D\u636E\u6B64\u62C6\u89E3\u3002",
      "2 \u843D\u8D26\uFF1A\u7528 write_ledger \u628A\u4EFB\u52A1\u6E05\u5355\u5199\u8FDB\u8BE5\u4F1A\u8BDD\u7684 state.json\uFF08\u6309\u3010\u53F0\u8D26\u7ED3\u6784\u7EA6\u5B9A\u3011\u7684 schema\uFF1Agoal/plan/tasks\uFF0C\u521D\u59CB\u5168 status=todo\uFF09\u3002",
      "3 \u9010\u4E2A\u4E0B\u53D1\uFF1A\u6309\u987A\u5E8F\u7528 send_message \u628A\u300C\u4E0B\u4E00\u4E2A todo \u4EFB\u52A1\u300D\u4E0B\u53D1\u7ED9\u4F1A\u8BDD\uFF0C\u4E00\u6B21\u53EA\u53D1\u4E00\u4E2A\uFF08\u8BE5\u4EFB\u52A1 mark doing\uFF09\uFF1B\u6267\u884C\u671F\u95F4\u4E0D\u91CD\u590D\u4E0B\u53D1\u3001\u4E0D\u6253\u65AD\u3002",
      "4 \u56DE\u4F20\u66F4\u65B0\uFF1A\u6536\u5230\u8BE5\u4F1A\u8BDD\u6267\u884C\u5B8C\u6210\u56DE\u4F20\u540E\uFF0C\u7528 edit_ledger \u628A\u8BE5\u4EFB\u52A1 status \u6539\u4E3A done\u3001result \u56DE\u586B\u7ED3\u679C\u6458\u8981\uFF1B\u5931\u8D25\u5219 status=blocked \u5E76\u8BB0\u5F55\u539F\u56E0\u3002",
      "5 \u63A5\u529B\u6536\u5DE5\uFF1A\u66F4\u65B0\u540E\u82E5\u6E05\u5355\u8FD8\u6709 todo\uFF0C\u7EE7\u7EED\u7B2C 3 \u6B65\u4E0B\u53D1\u4E0B\u4E00\u4E2A\uFF1B\u6E05\u5355\u5168\u90E8 done \u540E\u5411\u7528\u6237\u6C47\u62A5\u6574\u4F53\u5B8C\u6210\u5E76\u6536\u5DE5\u3002\u6E05\u5355\u6709\u9650\u3001\u9010\u4E2A\u52FE\u9500\uFF0C\u7981\u6B62\u7A7A\u8F6C\u6216\u65E0\u9650\u4E0B\u53D1\u3002",
      "\u3010\u6C42\u52A9\u7528\u6237\u7684\u5F62\u5F0F\u3011\uFF08\u52A1\u5FC5\u9075\u5B88\uFF09\uFF1A",
      "- \u9700\u8981\u7528\u6237\u505A\u300C\u9009\u62E9\u300D\uFF08\u9009\u76EE\u6807\u4F1A\u8BDD / \u9009\u6A21\u578B\uFF09\u2192 \u7528 choose_session / choose_model \u5F39\u9009\u62E9\u5668\uFF0C\u7981\u6B62\u7528\u7EAF\u6587\u672C\u53CD\u95EE\u3002",
      "- \u9700\u8981\u7528\u6237\u300C\u8865\u5145\u4FE1\u606F / \u786E\u8BA4 / \u56DE\u7B54\u5F00\u653E\u95EE\u9898\u300D\u2192 \u7528 ask_user \u5F39\u63D0\u95EE\u5361\u7247\uFF08\u80FD\u679A\u4E3E\u9009\u9879\u5C31\u7ED9 options\uFF0Cmultiple \u6309\u9700\u591A\u9009\uFF1B\u5F00\u653E\u95EE\u9898\u8BA9\u7528\u6237\u81EA\u7531\u8F93\u5165\uFF09\u3002",
      "- \u60C5\u51B5\u590D\u6742\u3001\u9700\u8981\u7528\u6237\u7406\u89E3\u591A\u6B65\u80CC\u666F\u6216\u7ED9\u51FA\u8BE6\u7EC6\u8BF4\u660E \u2192 \u7528\u56DE\u590D\u6B63\u6587\u8BE6\u7EC6\u8BF4\u660E\u60C5\u51B5\u5E76\u660E\u786E\u5217\u51FA\u9700\u8981\u7528\u6237\u56DE\u7B54\u7684\u95EE\u9898\uFF0C\u53EF\u540C\u65F6\u914D\u5408 ask_user \u6536\u96C6\u5173\u952E\u786E\u8BA4\u9879\u3002",
      "- \u62FF\u4E0D\u51C6\u65F6\u5B81\u53EF\u591A\u95EE\u4E00\u6B21\uFF0C\u7EDD\u4E0D\u64C5\u81EA\u66FF\u7528\u6237\u505A\u51B3\u5B9A\uFF08\u5C24\u5176\u6D89\u53CA\u300C\u628A\u9700\u6C42\u4EA4\u7ED9\u54EA\u4E2A\u4F1A\u8BDD\u3001\u5220\u9664\u4F1A\u8BDD\u3001\u5207\u6362\u6A21\u578B\u300D\u8FD9\u7C7B\u6709\u6B67\u4E49\u6216\u4E0D\u53EF\u9006\u7684\u64CD\u4F5C\uFF09\u3002",
      "\u5DE5\u4F5C\u539F\u5219\uFF1A",
      "- \u7528\u6237\u95EE\u300C\u6709\u54EA\u4E9B\u4F1A\u8BDD\u5728\u5E72\u6D3B\u300D\u300C\u67D0\u4E2A\u4F1A\u8BDD\u505A\u5230\u54EA\u4E86\u300D\u65F6\uFF0C\u5148 list_sessions / inspect_session \u67E5\u8BE2\uFF0C\u5982\u5B9E\u6C47\u62A5\uFF0C\u4E0D\u8981\u7F16\u9020\u3002",
      "- \u7528\u6237\u8BF4\u300C\u7ED9\u4F1A\u8BDDX\u65B0\u589E\u9700\u6C42Y\u300D\u65F6\uFF0C\u7528 send_message \u8F6C\u53D1\uFF0C\u5E76\u8BF4\u660E\u8F6C\u53D1\u7ED3\u679C\u3002",
      "- \u5F53\u7528\u6237\u8981\u4F60\u64CD\u4F5C\u67D0\u4E2A\u4F1A\u8BDD\u6216\u5207\u6362\u67D0\u4E2A\u6A21\u578B\u3001\u4F46\u6CA1\u6709\u660E\u786E\u8BF4\u662F\u54EA\u4E2A\u65F6\uFF0C\u5148 list_sessions / list_models \u62FF\u5230\u5019\u9009\uFF0C\u518D\u7528 choose_session / choose_model \u5F39\u51FA\u9009\u62E9\u5668\u8BA9\u7528\u6237\u9009\uFF0C\u62FF\u5230\u9009\u62E9\u7ED3\u679C\u540E\u518D\u6267\u884C\uFF0C\u7981\u6B62\u51ED\u7A7A\u731C\u6D4B\u76EE\u6807\u4F1A\u8BDD\u6216\u6A21\u578B\u3002",
      "- \u3010\u5F3A\u5236\u3011\u9700\u8981\u7528\u6237\u505A\u4EFB\u4F55\u9009\u62E9\u3001\u786E\u8BA4\u6216\u8865\u5145\u4FE1\u606F\u65F6\uFF0C\u5FC5\u987B\u8C03\u7528 choose_session / choose_model / ask_user \u5F39\u51FA\u5F39\u7A97\u8BA9\u7528\u6237\u9009\u62E9\u6216\u56DE\u7B54\uFF0C\u7981\u6B62\u7528\u7EAF\u6587\u672C\u53CD\u95EE\u7528\u6237\uFF1B\u62FF\u4E0D\u51C6\u9009\u54EA\u4E2A\u5C31\u5148 list_sessions / list_models \u62FF\u5019\u9009\u518D\u5F39\u3002",
      "- \u914D\u7F6E\u7C7B\u64CD\u4F5C\uFF08\u5207\u6A21\u578B/\u6539\u5B89\u5168\u6A21\u5F0F/\u6539\u5DE5\u4F5C\u76EE\u5F55/\u91CD\u547D\u540D\uFF09\u5148\u8BF4\u660E\u518D\u6267\u884C\uFF0C\u6267\u884C\u5B8C\u6C47\u62A5\u3002",
      "- delete_session \u662F\u5371\u9669\u4E14\u4E0D\u53EF\u6062\u590D\u7684\u64CD\u4F5C\uFF1A\u6267\u884C\u524D\u5FC5\u987B\u5411\u7528\u6237\u590D\u8FF0\u76EE\u6807\u4F1A\u8BDD id \u4E0E\u6807\u9898\uFF0C\u5F97\u5230\u660E\u786E\u786E\u8BA4\u540E\u624D\u80FD\u5220\u9664\u3002",
      "- \u4F60\u53EA\u505A\u4F1A\u8BDD\u8C03\u5EA6\u4E0E\u76D1\u63A7\uFF0C\u4E0D\u66FF\u76EE\u6807\u4F1A\u8BDD\u6267\u884C\u5177\u4F53\u4EFB\u52A1\uFF08\u5177\u4F53\u4EFB\u52A1\u7531\u76EE\u6807\u4F1A\u8BDD\u7684 Agent \u5B8C\u6210\uFF09\u3002",
      "\u3010\u53F0\u8D26\uFF08\u53EF\u9009\u8F85\u52A9\u8BB0\u5FC6\uFF0C\u52FF\u673A\u68B0\u6267\u884C\uFF09\u3011\uFF1A",
      "- \u53F0\u8D26\u53EA\u5728\u4F60\u9700\u8981\u56DE\u5FC6\u300C\u8DE8\u4F1A\u8BDD\u7684\u5386\u53F2\u51B3\u7B56/\u5F85\u8DDF\u8FDB/\u6CE8\u610F\u4E8B\u9879\u300D\u65F6\u624D read_ledger\uFF1B\u65E5\u5E38\u67E5\u8BE2\u76F4\u63A5 list_sessions\uFF08\u5DF2\u542B\u5B9E\u65F6\u72B6\u6001\uFF09\uFF0C\u4E0D\u5FC5\u8BFB\u53F0\u8D26\u3002",
      "- \u9996\u6B21\u53D1\u73B0\u53F0\u8D26\u76EE\u5F55\u4E3A\u7A7A\u6216\u7F3A _index.json \u65F6\uFF0C\u7528 write_ledger \u521D\u59CB\u5316\uFF1A_index.json \u5199\u300C\u4F1A\u8BDDid\u2192\u6807\u9898\u300D\uFF0C\u6BCF\u4F1A\u8BDD\u5EFA state.json\uFF08currentTask/status\uFF09\u4E0E notes.md \u5360\u4F4D\u3002",
      "- \u4EC5\u5F53\u4F1A\u8BDD\u53D1\u751F\u5B9E\u8D28\u72B6\u6001\u53D8\u5316\uFF08\u4E0B\u53D1\u4EFB\u52A1\u3001\u7ED3\u679C\u56DE\u4F20\u3001\u4F1A\u8BDD\u589E\u5220\u6539/\u5B8C\u6210/\u5931\u8D25\uFF09\u540E\uFF0C\u624D\u7528 write_ledger/edit_ledger \u66F4\u65B0\u5BF9\u5E94 state.json/notes.md \u5E76\u540C\u6B65 _index.json\uFF1B\u7EAF\u67E5\u8BE2\u3001\u7EAF\u8F6C\u53D1\u65E0\u9700\u5199\u53F0\u8D26\u3002",
      "\u3010\u53F0\u8D26\u7ED3\u6784\u7EA6\u5B9A\u3011\uFF1A",
      "- \u7BA1\u5BB6\u5DE5\u4F5C\u76EE\u5F55\u662F ~/.shanhai/supervisor-workspace/\uFF08\u72EC\u7ACB\u4E8E\u666E\u901A\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55\uFF09\u3002\u9876\u5C42 _index.json \u8BB0\u5F55\u300C\u4F1A\u8BDD id \u2192 \u6807\u9898\u300D\u7D22\u5F15\uFF1B\u6BCF\u4E2A\u4F1A\u8BDD\u4E00\u4E2A\u5B50\u76EE\u5F55\uFF08\u76EE\u5F55\u540D = \u4F1A\u8BDD id\uFF09\uFF0C\u5185\u542B notes.md\uFF08\u81EA\u7136\u8BED\u8A00\u5907\u6CE8\uFF1A\u5F53\u524D\u4EFB\u52A1\u3001\u5173\u952E\u51B3\u7B56\u3001\u5F85\u8DDF\u8FDB\u3001\u6CE8\u610F\u4E8B\u9879\uFF09\u4E0E state.json\uFF08\u7ED3\u6784\u5316\u72B6\u6001\uFF09\u3002",
      '- state.json \u7EDF\u4E00\u7528\u4EE5\u4E0B\u7ED3\u6784\u627F\u8F7D\u300C\u4EFB\u52A1\u8BA1\u5212\u4E0E\u8FDB\u5EA6\u300D\uFF08\u8FD9\u662F\u53F0\u8D26\u7684\u6838\u5FC3\uFF0C\u52A1\u5FC5\u6309\u6B64 schema \u5199\uFF09\uFF1A{"goal":"\u8BE5\u4F1A\u8BDD\u603B\u4F53\u76EE\u6807","plan":"\u9700\u6C42\u5206\u6790\u4E0E\u65B9\u6848\u8BBE\u8BA1\u6458\u8981","tasks":[{"id":1,"title":"\u4EFB\u52A1\u6807\u9898","status":"todo","result":""}],"updatedAt":<\u65F6\u95F4\u6233>}\u3002status \u53D6\u503C todo(\u5F85\u529E)/doing(\u8FDB\u884C\u4E2D)/done(\u5DF2\u5B8C\u6210)/blocked(\u963B\u585E)\u3002',
      "- \u53F0\u8D26\u4E0E\u6743\u5A01\u6765\u6E90\u7684\u5206\u5DE5\uFF1A\u4E8B\u4EF6\u65E5\u5FD7\uFF08sessions/<\u4F1A\u8BDDid>/events.jsonl\uFF09\u662F\u6743\u5A01\u5B8C\u6574\u5386\u53F2\uFF0C\u53F0\u8D26\u662F\u4F60\u7684\u901F\u67E5\u6458\u8981\uFF1B\u4E24\u8005\u4E0D\u51B2\u7A81\uFF0C\u53F0\u8D26\u7528\u4E8E\u300C\u5FEB\u901F\u56DE\u5FC6\u300D\uFF0C\u9700\u8981\u7CBE\u786E\u7EC6\u8282\u65F6\u7528 list_sessions / inspect_session \u67E5\u5B9E\u65F6\u72B6\u6001\u3002"
    ].join("\n");
    return mem ? base + mem : base;
  };
  const buildMemoryContext = (message, sessionId) => {
    const config = ctx.memory.listBySession(sessionId).filter((e) => e.scope !== "task_experience" && e.scope !== "session");
    const experience = ctx.memory.recall("task_experience", message, sessionId).slice(0, 5);
    const all = [...config, ...experience];
    if (all.length === 0) return void 0;
    const lines = all.map((e) => `- [${e.scope}] ${e.key}: ${typeof e.value === "string" ? e.value : JSON.stringify(e.value)}`);
    return `

\u3010\u957F\u671F\u8BB0\u5FC6\u3011
${lines.join("\n")}`;
  };
  return { analyzeImageWithVision, getSessionCwd, collectEnvironment, buildSystemPrompt, buildMemoryContext, buildSupervisorSystemPrompt };
}

// ../../packages/deepseek-bridge/src/tools.ts
import { execFileSync } from "child_process";
import fs14 from "fs";
import path from "path";
var TOOL_RESULT_MAX = 4e3;
function safeResolve(workspace, p) {
  const abs = path.resolve(workspace, String(p ?? "."));
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error("\u8DEF\u5F84\u8D85\u51FA\u5DE5\u4F5C\u76EE\u5F55: " + String(p));
  }
  return abs;
}
function createBuiltinTools(getWorkspace) {
  const ws = () => getWorkspace() || process.cwd();
  return {
    list_files: {
      description: '\u5217\u51FA\u76EE\u5F55\u4E0B\u7684\u6587\u4EF6\u4E0E\u5B50\u76EE\u5F55\u3002\u53C2\u6570 path: \u76EE\u5F55\u8DEF\u5F84\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u9ED8\u8BA4 "."\uFF09',
      run(args) {
        const dir = safeResolve(ws(), args.path);
        const entries = fs14.readdirSync(dir, { withFileTypes: true });
        return entries.map((e) => e.isDirectory() ? e.name + "/" : e.name).join("\n");
      }
    },
    read_file: {
      description: "\u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\u3002\u53C2\u6570 path: \u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u76EE\u5F55\uFF09",
      run(args) {
        const p = safeResolve(ws(), args.path);
        return fs14.readFileSync(p, "utf8");
      }
    },
    search_content: {
      description: '\u5728\u6587\u4EF6\u4E2D\u641C\u7D22\u5173\u952E\u5B57\u3002\u53C2\u6570 pattern: \u5173\u952E\u5B57, path: \u76EE\u5F55\uFF08\u9ED8\u8BA4 "."\uFF09',
      run(args) {
        const dir = safeResolve(ws(), args.path);
        if (!args.pattern) throw new Error("\u7F3A\u5C11\u53C2\u6570 pattern");
        const out = execFileSync("grep", ["-rn", String(args.pattern), dir], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024
        });
        return out || "(\u672A\u5339\u914D\u5230\u4EFB\u4F55\u5185\u5BB9)";
      }
    },
    write_file: {
      description: "\u5199\u5165\u6587\u4EF6\u5185\u5BB9\uFF08\u8986\u76D6\u5DF2\u6709\u6587\u4EF6\u6216\u521B\u5EFA\u65B0\u6587\u4EF6\uFF09\u3002\u53C2\u6570 path: \u6587\u4EF6\u8DEF\u5F84\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u76EE\u5F55\uFF09, content: \u8981\u5199\u5165\u7684\u5B8C\u6574\u6587\u672C\u5185\u5BB9",
      run(args) {
        if (!args.path) throw new Error("\u7F3A\u5C11\u53C2\u6570 path");
        if (typeof args.content !== "string") throw new Error("\u7F3A\u5C11\u53C2\u6570 content\uFF08\u5B57\u7B26\u4E32\uFF09");
        const p = safeResolve(ws(), args.path);
        fs14.writeFileSync(p, args.content, "utf8");
        return "\u5DF2\u5199\u5165 " + args.path + "\uFF08" + args.content.length + " \u5B57\u7B26\uFF09";
      }
    }
  };
}
function truncateToolResult(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > TOOL_RESULT_MAX ? text.slice(0, TOOL_RESULT_MAX) + "\n...(\u5DF2\u622A\u65AD)" : text;
}
function toolSystemPrompt(tools) {
  const lines = ["\u4F60\u662F\u4E00\u4E2A\u80FD\u8C03\u7528\u5DE5\u5177\u5B8C\u6210\u4EFB\u52A1\u7684\u667A\u80FD\u52A9\u624B\u3002", "\u53EF\u7528\u5DE5\u5177\uFF1A"];
  for (const [name, def] of Object.entries(tools)) {
    lines.push("- " + name + "\uFF1A" + def.description);
  }
  lines.push("");
  lines.push("\u4F60\u7684\u6BCF\u4E00\u6B21\u56DE\u590D\uFF0C\u5FC5\u987B\u7528 <message> \u5305\u88F9\uFF0Crole \u6309\u7528\u9014\u533A\u5206\uFF1A");
  lines.push('  - \u6700\u7EC8\u56DE\u590D\u7528 <message role="assistant">\uFF08\u542B\u975E\u7A7A <content>\uFF09');
  lines.push('  - \u5DE5\u5177\u8C03\u7528\u7528 <message role="tool">\uFF08\u542B <tool_calls>\uFF0C<content> \u7701\u7565\uFF09');
  lines.push("\u5B50\u6807\u7B7E <reasoning_content>\uFF08\u53EF\u9009\uFF09\u4E0E <content> \u6309\u9700\u51FA\u73B0\uFF1A");
  lines.push("  <reasoning_content>\u601D\u8003\u8FC7\u7A0B</reasoning_content> \u2014\u2014 \u53EF\u9009\uFF0C\u5199\u4F60\u7684\u63A8\u7406\u8FC7\u7A0B");
  lines.push("  <content>\u6700\u7EC8\u56DE\u7B54</content> \u2014\u2014 \u5B8C\u6210\u4EFB\u52A1\u65F6\u8F93\u51FA");
  lines.push("");
  lines.push("\u5DE5\u5177\u8C03\u7528\u793A\u4F8B\uFF1A");
  lines.push('<message role="tool">');
  lines.push("  <reasoning_content>\u7528\u6237\u8981\u8BFB\u53D6\u6587\u4EF6\uFF0C\u6211\u5E94\u8C03\u7528 read_file \u5DE5\u5177\u3002</reasoning_content>");
  lines.push("  <tool_calls>");
  lines.push("    <tool_call>");
  lines.push("      <id>call_1</id>");
  lines.push("      <type>function</type>");
  lines.push("      <function>");
  lines.push("        <name>read_file</name>");
  lines.push('        <arguments>{"path":"scripts/a.py"}</arguments>');
  lines.push("      </function>");
  lines.push("    </tool_call>");
  lines.push("  </tool_calls>");
  lines.push("</message>");
  lines.push("");
  lines.push("\u4EFB\u52A1\u5B8C\u6210\u793A\u4F8B\uFF1A");
  lines.push('<message role="assistant">');
  lines.push("  <reasoning_content>\u5DF2\u83B7\u53D6\u5230\u6587\u4EF6\u5185\u5BB9\uFF0C\u73B0\u5728\u7ED9\u51FA\u6700\u7EC8\u56DE\u7B54\u3002</reasoning_content>");
  lines.push("  <content>\u6587\u4EF6\u5185\u5BB9\u5982\u4E0B\uFF1A\u2026\u2026</content>");
  lines.push("</message>");
  lines.push("");
  lines.push("\u89C4\u5219\uFF08\u4E25\u683C\u9075\u5B88\uFF09\uFF1A");
  lines.push("1. \u5B8C\u6210\u5224\u5B9A\uFF1A\u53EA\u6709\u5F53 <content> \u975E\u7A7A\u65F6\u624D\u7B97\u5B8C\u6210\u4EFB\u52A1\uFF1B\u672A\u5B8C\u6210\u65F6\u4E0D\u5F97\u8F93\u51FA <content>\uFF08\u6216\u7559\u7A7A\uFF09\uFF0C\u800C\u5E94\u8F93\u51FA <tool_calls> \u7EE7\u7EED\u83B7\u53D6\u4FE1\u606F\u3002");
  lines.push('2. \u5DE5\u5177\u8C03\u7528\uFF1A\u9700\u8981\u83B7\u53D6\u4FE1\u606F\u6216\u6267\u884C\u64CD\u4F5C\u65F6\u8F93\u51FA <message role="tool"> \u4E14\u542B <tool_calls>\uFF08\u6B64\u65F6 <content> \u7701\u7565\uFF09\uFF1B\u53EF\u5305\u542B\u591A\u4E2A <tool_call>\u3002');
  lines.push("3. <content> \u548C <reasoning_content> \u76F4\u63A5\u5199\u7EAF\u6587\u672C\uFF0C\u4E0D\u8981\u7528 CDATA \u6216\u5F15\u53F7\u5305\u88F9\u3002");
  lines.push('4. <arguments> \u5185\u662F\u6807\u51C6 JSON \u5B57\u7B26\u4E32\uFF0C\u7279\u6B8A\u5B57\u7B26\u9700\u6309 JSON \u89C4\u5219\u8F6C\u4E49\uFF08\u4F8B\u5982\u6362\u884C\u5199\u4F5C \\n\u3001\u53CC\u5F15\u53F7\u5199\u4F5C \\"\uFF09\u3002');
  lines.push("5. \u6BCF\u4E2A <tool_call> \u7684 <id> \u7531\u4F60\u81EA\u5DF1\u751F\u6210\uFF1A\u5168\u5C40\u552F\u4E00\u3001\u9012\u589E\u4E0D\u91CD\u590D\uFF08\u5982 call_1\u3001call_2\u3001call_3\u2026\u2026\uFF09\uFF1B\u540C\u65F6\u542B <type>function</type>\u3001<function> \u5185\u7684 <name>\uFF08\u5DE5\u5177\u540D\uFF09\u548C <arguments>\uFF08JSON \u5B57\u7B26\u4E32\uFF09\u3002");
  lines.push("6. \u6536\u5230\u3010\u5DE5\u5177\u8FD4\u56DE\u7ED3\u679C\u3011\u540E\u7EE7\u7EED\u63A8\u7406\uFF1A\u5FC5\u8981\u65F6\u518D\u6B21\u8F93\u51FA <tool_calls>\uFF0C\u76F4\u5230\u80FD\u8F93\u51FA\u975E\u7A7A <content> \u4E3A\u6B62\u3002");
  lines.push('7. \u6807\u7B7E\u4E4B\u5916\u4E25\u7981\u8F93\u51FA\u4EFB\u4F55\u6587\u5B57\u3001\u8BA1\u5212\u3001\u603B\u7ED3\u6216\u89E3\u91CA\uFF08\u4F8B\u5982\u7981\u6B62\u5199"\u63A5\u4E0B\u6765\u6211\u8981\u2026"\u4E4B\u7C7B\u7684\u8BDD\uFF09\u3002');
  return lines.join("\n");
}

// ../../packages/deepseek-bridge/src/react.ts
function buildPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const parts = [];
  for (const m of messages) {
    if (!m || m.content == null) continue;
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (!content || !content.trim()) continue;
    switch (m.role) {
      case "system":
        parts.push("\u3010\u7CFB\u7EDF\u6307\u4EE4\u3011\n" + content);
        break;
      case "user":
        parts.push("\u3010\u7528\u6237\u3011\n" + content);
        break;
      case "assistant":
        parts.push("\u3010\u52A9\u624B\u3011\n" + content);
        break;
      case "tool":
        parts.push("\u3010\u5DE5\u5177\u8FD4\u56DE\u7ED3\u679C\u3011\n" + content);
        break;
      default:
        parts.push(content);
    }
  }
  return parts.join("\n\n");
}
function extractTagContent(html, tagName) {
  if (html == null) return null;
  const re = new RegExp("<" + tagName + "\\s*[^>]*>([\\s\\S]*?)<\\/" + tagName + ">", "i");
  const m = String(html).match(re);
  if (!m) return null;
  const inner = m[1] ?? "";
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) return cdata[1] ?? null;
  return inner.trim();
}
var callIdCounter = 0;
function nextCallId() {
  callIdCounter += 1;
  return "call_" + callIdCounter;
}
function parseToolCalls(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/```(?:json)?/g, "");
  const result = [];
  const tcBlock = cleaned.match(/<tool_calls\s*>([\s\S]*?)<\/tool_calls>/i);
  const scope = tcBlock ? tcBlock[1] ?? "" : cleaned;
  const callRe = /<tool_call\s*>([\s\S]*?)<\/tool_call>/g;
  let cm;
  while ((cm = callRe.exec(scope)) !== null) {
    const callBody = cm[1] ?? "";
    const fnMatch = callBody.match(/<function\s*>([\s\S]*?)<\/function>/i);
    let name = null;
    let argsRaw = null;
    if (fnMatch) {
      name = extractTagContent(fnMatch[1], "name");
      argsRaw = extractTagContent(fnMatch[1], "arguments");
    }
    if (!name) {
      try {
        const obj = JSON.parse(callBody.trim());
        if (obj && obj.name) {
          name = obj.name;
          argsRaw = JSON.stringify(obj.arguments || {});
        }
      } catch {
      }
    }
    if (name) {
      const id = extractTagContent(callBody, "id") || nextCallId();
      const type = extractTagContent(callBody, "type") || "function";
      let args = {};
      if (argsRaw != null && String(argsRaw).trim()) {
        try {
          args = JSON.parse(argsRaw);
        } catch {
          args = { _raw: argsRaw };
        }
      }
      result.push({ id, type, function: { name, arguments: JSON.stringify(args) } });
    }
  }
  if (result.length === 0) {
    const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
    let im;
    while ((im = invokeRe.exec(cleaned)) !== null) {
      const name = im[1] ?? "";
      const args = {};
      const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramRe.exec(im[2] ?? "")) !== null) {
        let val = pm[2] ?? "";
        try {
          val = JSON.parse(val);
        } catch {
        }
        args[pm[1] ?? ""] = val;
      }
      if (name) {
        result.push({ id: nextCallId(), type: "function", function: { name, arguments: JSON.stringify(args) } });
      }
    }
  }
  if (result.length === 0) {
    try {
      const obj = JSON.parse(String(text).trim());
      if (obj && obj.name) {
        result.push({ id: nextCallId(), type: "function", function: { name: obj.name, arguments: JSON.stringify(obj.arguments || {}) } });
      }
    } catch {
    }
  }
  return result;
}
function parseContent(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/g, "");
  const m = cleaned.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
  if (m) return (m[1] ?? "").trim();
  const old = cleaned.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/);
  if (!old) return null;
  const inner = (old[1] ?? "").trim();
  try {
    const obj = JSON.parse(inner);
    if (obj && obj.content != null) {
      return typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content);
    }
    return inner;
  } catch {
    return inner;
  }
}
function parseReasoning(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/g, "");
  const m = cleaned.match(/<reasoning_content>\s*([\s\S]*?)\s*<\/reasoning_content>/) || cleaned.match(/<think>\s*([\s\S]*?)\s*<\/think>/);
  if (!m) return null;
  return (m[1] ?? "").trim() || null;
}
function parseMessage(text) {
  if (!text) return { role: null, content: null, reasoningContent: null, toolCalls: [] };
  let body = String(text);
  const msgMatch = body.match(/<message\s+role="([^"]+)"\s*>([\s\S]*?)<\/message>/i);
  let role = null;
  if (msgMatch) {
    role = msgMatch[1] ?? null;
    body = msgMatch[2] ?? "";
  }
  let content = extractTagContent(body, "content");
  if (content == null) content = parseContent(body);
  const reasoning = parseReasoning(body);
  let toolCalls = parseToolCalls(body);
  if (toolCalls.length === 0) toolCalls = parseToolCalls(text);
  return {
    role,
    content: content != null ? content.trim() : null,
    reasoningContent: reasoning != null ? reasoning.trim() : null,
    toolCalls
  };
}
function runTool2(tools, name, args) {
  const tool = tools[name];
  if (!tool) throw new Error("\u672A\u77E5\u5DE5\u5177: " + name);
  return truncateToolResult(tool.run(args || {}));
}
async function runAgent(messages, ctx) {
  const maxSteps = Number(ctx.maxSteps || 1e3);
  const mode = ctx.mode || "expert";
  const thinking = ctx.thinking != null ? !!ctx.thinking : true;
  const working = [{ role: "system", content: toolSystemPrompt(ctx.tools) }, ...messages];
  let content = "";
  let reasoningContent = "";
  let noToolCount = 0;
  for (let step = 0; step < maxSteps; step++) {
    const prompt = buildPrompt(working);
    const reply = await ctx.chat(prompt, { mode, thinking });
    const parsed = parseMessage(reply);
    const reasoning = parsed.reasoningContent;
    const calls = parsed.toolCalls;
    if (reasoning) {
      reasoningContent = reasoningContent ? reasoningContent + "\n\n" + reasoning : reasoning;
    }
    if (calls.length > 0) {
      working.push({ role: "assistant", content: reply });
      for (const call of calls) {
        const name = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") || {};
        } catch {
          args = {};
        }
        let toolResult;
        try {
          toolResult = runTool2(ctx.tools, name, args);
        } catch (e) {
          toolResult = "\u5DE5\u5177\u6267\u884C\u51FA\u9519: " + (e instanceof Error ? e.message : String(e));
        }
        working.push({ role: "tool", content: "\u5DE5\u5177 " + name + " \u8FD4\u56DE\u7ED3\u679C:\n" + toolResult });
      }
    } else {
      const final = parsed.content;
      if (final != null && final.trim() !== "") {
        content = final.trim();
        break;
      }
      noToolCount += 1;
      working.push({ role: "assistant", content: reply });
      if (noToolCount > 3) {
        content = reply;
        break;
      }
      working.push({
        role: "user",
        content: "\u8BF7\u7EE7\u7EED\uFF1A\u5982\u4ECD\u9700\u83B7\u53D6\u4FE1\u606F\uFF0C\u8F93\u51FA <tool_calls>\uFF1B\u5982\u5DF2\u80FD\u5B8C\u6574\u56DE\u7B54\uFF0C\u8F93\u51FA\u975E\u7A7A\u7684 <content>\u3002\u4E0D\u8981\u8F93\u51FA\u5176\u4ED6\u6587\u5B57\u3002"
      });
    }
  }
  if (!content) content = "(\u5DF2\u8FBE\u5230\u6700\u5927\u6B65\u6570 " + maxSteps + "\uFF0C\u4ECD\u672A\u5F97\u5230\u6700\u7EC8\u7B54\u6848)";
  return { content, reasoningContent };
}

// ../../packages/deepseek-bridge/src/server.ts
function createDeepSeekModel(opts) {
  const tools = createBuiltinTools(opts.getWorkspace);
  const maxSteps = opts.maxSteps ?? 1e3;
  const mode = opts.mode ?? "expert";
  const thinking = opts.thinking ?? true;
  return {
    async complete(messages) {
      const result = await runAgent(messages, {
        tools,
        maxSteps,
        mode,
        thinking,
        chat: opts.chat
      });
      return { text: result.content, reasoningContent: result.reasoningContent || void 0 };
    }
  };
}

// ../../packages/deepseek-bridge/src/bridge-script.ts
function buildBridgeScript() {
  return `(function () {
  var MODE_LABEL = { expert: '\u4E13\u5BB6\u6A21\u5F0F', fast: '\u5FEB\u901F\u6A21\u5F0F', vision: '\u8BC6\u56FE\u6A21\u5F0F' };

  function currentMode() {
    var radios = Array.from(document.querySelectorAll('[role=radio]'));
    var sel = radios.find(function (r) { return r.className.indexOf('_31a22b0') >= 0; });
    if (!sel) return null;
    var t = (sel.innerText || '').trim();
    for (var k in MODE_LABEL) {
      if (t.indexOf(MODE_LABEL[k]) >= 0) return k;
    }
    return t;
  }

  function setMode(mode) {
    var label = MODE_LABEL[mode] || MODE_LABEL.expert;
    var radios = Array.from(document.querySelectorAll('[role=radio]'));
    var target = radios.find(function (r) { return (r.innerText || '').indexOf(label) >= 0; });
    if (!target) return false;
    if (target.className.indexOf('_31a22b0') >= 0) return true;
    target.click();
    return true;
  }

  function setThinking(enabled) {
    var toggles = Array.from(document.querySelectorAll('.ds-toggle-button'));
    var target = toggles.find(function (t) { return (t.innerText || '').indexOf('\u6DF1\u5EA6\u601D\u8003') >= 0; });
    if (!target) return false;
    var selected = target.getAttribute('aria-pressed') === 'true' || target.className.indexOf('--selected') >= 0;
    if (selected === !!enabled) return true;
    target.click();
    return true;
  }

  // \u2014\u2014 SSE \u8BCA\u65AD\u901A\u9053\uFF1Ahook fetch \u53EA\u8BB0\u5F55\u539F\u59CB SSE \u6587\u672C\uFF08\u4E0D\u89E3\u6790\u3001\u4E0D\u53C2\u4E0E\u7ED3\u679C\u56DE\u4F20\uFF09\u2014\u2014
  // DeepSeek \u7F51\u9875\u7248 SSE \u662F\u5176\u79C1\u6709\u683C\u5F0F\uFF08\u975E OpenAI choices \u7ED3\u6784\uFF09\uFF0C\u89E3\u6790\u5B83\u6613\u51FA\u9519\u4E14\u6613\u968F\u6539\u7248\u5931\u6548\uFF1B
  // \u8FD9\u91CC\u53EA\u505A\u300C\u539F\u59CB\u8BB0\u5F55\u300D\u4F9B\u6392\u67E5\u95EE\u9898\uFF0C\u7ED3\u679C\u56DE\u4F20\u7EDF\u4E00\u8D70\u4E0B\u9762\u7684 DOM \u8F6E\u8BE2\u3002
  var __dsSseLog = [];
  var MAX_SSE_LOG = 50;

  function recordSseLine(url, line) {
    __dsSseLog.push({ ts: Date.now(), url: url, line: line });
    if (__dsSseLog.length > MAX_SSE_LOG) __dsSseLog.splice(0, __dsSseLog.length - MAX_SSE_LOG);
  }

  function captureStream(url, res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buffer += decoder.decode(r.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var t = (lines[i] || '').trim();
          if (t.indexOf('data:') === 0) recordSseLine(url, t);
        }
        return pump();
      });
    }
    pump().catch(function () {});
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = origFetch.apply(this, arguments);
    if (typeof url === 'string' && /(chat|completion|conversation)/i.test(url)) {
      p.then(function (res) {
        var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        if (ct.indexOf('text/event-stream') >= 0 || ct.indexOf('application/octet-stream') >= 0) {
          try {
            // \u5FC5\u987B clone \u518D\u8BFB\uFF0C\u4E0D\u62A2\u5360\u9875\u9762\u81EA\u8EAB\u7684 ReadableStream
            captureStream(url, res.clone());
          } catch (e) {
            /* clone \u5931\u8D25\uFF08body \u5DF2\u88AB\u6D88\u8D39\uFF09\u65F6\u9759\u9ED8\u8DF3\u8FC7\u8BCA\u65AD\u8BB0\u5F55 */
          }
        }
      }).catch(function () {});
    }
    return p;
  };

  // \u2014\u2014 \u53D1\u9001\u4E00\u6761\u6D88\u606F\u5E76\u7B49\u5F85 AI \u56DE\u590D\uFF08DOM \u8F6E\u8BE2\uFF1A\u5FEB\u7167\u5728\u53D1\u9001\u524D\u53D6\uFF0C\u53D1\u9001\u540E\u7ACB\u5373\u5F00\u59CB\uFF09\u2014\u2014
  function dsChat(prompt, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (opts.mode) setMode(opts.mode);
      if (opts.thinking != null) setThinking(!!opts.thinking);

      var ta = document.querySelector('textarea');
      if (!ta) return reject(new Error('no textarea found'));

      // \u53D1\u9001\u524D\u5FEB\u7167\uFF1A\u8BB0\u5F55\u6700\u540E\u4E00\u6761\u56DE\u590D\u7684\u6587\u672C\uFF08\u865A\u62DF\u5217\u8868\u4F1A\u56DE\u6536\u5386\u53F2\u6D88\u606F\uFF0C\u4E0D\u80FD\u53EA\u9760\u6570\u91CF\u5224\u65AD\uFF09
      var beforeEls = document.querySelectorAll('.ds-assistant-message-main-content');
      var beforeCount = beforeEls.length;
      var beforeLastText = beforeCount ? (beforeEls[beforeCount - 1].innerText || '').trim() : '';

      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, prompt);
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      setTimeout(function () {
        var btns = Array.from(document.querySelectorAll('div[class*=ds-button--primary]'));
        var sendBtn = btns.find(function (b) { return b.className.indexOf('disabled') < 0; });
        if (!sendBtn) return reject(new Error('no send button'));
        sendBtn.click();
      }, 100);

      var t0 = Date.now();
      var lastText = '';
      var stableTicks = 0;
      var timer = setInterval(function () {
        var els = document.querySelectorAll('.ds-assistant-message-main-content');
        var last = els[els.length - 1];
        var text = last ? (last.innerText || '').trim() : '';
        // \u68C0\u6D4B\u5230\u65B0\u56DE\u590D\uFF1A\u6570\u91CF\u589E\u52A0\uFF0C\u6216\u6700\u540E\u4E00\u6761\u6587\u672C\u76F8\u5BF9\u53D1\u9001\u524D\u5FEB\u7167\u53D1\u751F\u53D8\u5316
        var hasNew = els.length > beforeCount || (text && text !== beforeLastText);
        if (hasNew) {
          var prim = Array.from(document.querySelectorAll('div[class*=ds-button--primary]'));
          var sendDone = prim.some(function (b) { return b.className.indexOf('disabled') >= 0; });
          if (text && text === lastText && sendDone) {
            stableTicks += 1;
            if (stableTicks >= 4) {
              clearInterval(timer);
              resolve(text);
            }
          } else {
            lastText = text;
            stableTicks = 0;
          }
        }
        if (Date.now() - t0 > 600000) {
          clearInterval(timer);
          reject(new Error('timeout waiting for reply'));
        }
      }, 400);
    });
  }

  window.__dsChat = dsChat;
  window.__dsSseLog = __dsSseLog;
  window.__dsBridgeReady = true;
  console.log('[ds-bridge] ready (dom-poll + sse-log)');
})();`;
}
var BRIDGE_READY_CHECK = `typeof window.__dsChat === 'function'`;

// ../runtime/src/deepseek-bridge.ts
function createDeepSeekBridgeModule(ctx, getCurrentSid) {
  const ensureDefaultBrowserWindow = (sid) => {
    if (!sid) return;
    if (!ctx.currentSettings.browser.enableWebBridge) return;
    ctx.browserUse.setShowOnCreate?.(false);
    void ctx.browserUse.create(sid, "https://chat.deepseek.com").catch(() => {
    }).finally(() => {
      ctx.browserUse.setShowOnCreate?.(true);
    });
  };
  const registerDeepSeekBridgeModel = () => {
    if (ctx.deepseekBridgeModel) return;
    ctx.deepseekBridgeModel = {
      id: "deepseek-web",
      name: "DeepSeek \u7F51\u9875\u7248",
      displayName: "DeepSeek \u7F51\u9875\u7248",
      model: "deepseek-chat",
      tier: "flagship",
      apiKey: "",
      baseUrl: "",
      protocol: "openai",
      provider: "deepseek-bridge",
      source: "deepseek-bridge",
      custom: false
    };
  };
  const ensureDeepSeekBridgeWindow = async () => {
    const sid = getCurrentSid();
    if (!sid) throw new Error("\u5F53\u524D\u65E0\u6D3B\u52A8\u4F1A\u8BDD");
    const wins = await ctx.browserUse.list();
    const win = wins.find((w) => w.appId === sid);
    if (!win) {
      await ctx.browserUse.navigate("https://chat.deepseek.com", sid);
    } else if (!/chat\.deepseek\.com/.test(win.url || "")) {
      await ctx.browserUse.navigate("https://chat.deepseek.com", sid);
    }
    const ready = await ctx.browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false);
    if (!ready) {
      await ctx.browserUse.evaluate(buildBridgeScript(), sid);
    }
  };
  const deepSeekChat = async (prompt, opts) => {
    await ensureDeepSeekBridgeWindow();
    const sid = getCurrentSid();
    if (!ctx.browserUse.chatWithPageBridge) throw new Error("\u5F53\u524D\u540E\u7AEF\u4E0D\u652F\u6301\u9875\u9762\u6865\u63A5\uFF08chatWithPageBridge \u672A\u5B9E\u73B0\uFF09");
    try {
      return await ctx.browserUse.chatWithPageBridge(prompt, { mode: opts.mode, thinking: opts.thinking }, sid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no textarea|no send button/i.test(msg)) {
        throw new Error("DeepSeek \u7F51\u9875\u7248\u5C1A\u672A\u5C31\u7EEA\uFF1A\u8BF7\u5728\u672C\u4F1A\u8BDD\u5F39\u51FA\u7684\u6D4F\u89C8\u5668\u7A97\u53E3\u91CC\u767B\u5F55 chat.deepseek.com \u540E\u518D\u8BD5\uFF08\u767B\u5F55\u6001\u8DE8\u4F1A\u8BDD\u901A\u7528\uFF0C\u53EA\u9700\u767B\u5F55\u4E00\u6B21\uFF09");
      }
      throw err;
    }
  };
  const getStatus = async () => {
    try {
      const sid = ctx.currentSessionId ?? "";
      if (!sid) return { windowReady: false, bridgeInjected: false };
      const wins = await ctx.browserUse.list();
      const windowReady = wins.some((w) => w.appId === sid);
      let bridgeInjected = false;
      if (windowReady) {
        bridgeInjected = Boolean(await ctx.browserUse.evaluate(BRIDGE_READY_CHECK, sid).catch(() => false));
      }
      return { windowReady, bridgeInjected };
    } catch {
      return { windowReady: false, bridgeInjected: false };
    }
  };
  const open = async () => {
    try {
      await ensureDeepSeekBridgeWindow();
      return { ok: true, message: "\u5DF2\u6253\u5F00\u5F53\u524D\u4F1A\u8BDD\u7684 DeepSeek \u9875\u9762\u5E76\u6CE8\u5165\u6865\u63A5\u811A\u672C\uFF0C\u8BF7\u5728\u8BE5\u7A97\u53E3\u767B\u5F55 chat.deepseek.com\uFF08\u767B\u5F55\u6001\u8DE8\u4F1A\u8BDD\u901A\u7528\uFF09" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  const inject = async () => {
    try {
      await ensureDeepSeekBridgeWindow();
      return { ok: true, message: "\u6865\u63A5\u811A\u672C\u5DF2\u6CE8\u5165\u5F53\u524D\u4F1A\u8BDD\u7684 DeepSeek \u9875\u9762\uFF0C\u8BF7\u4FDD\u6301\u9875\u9762\u6253\u5F00" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  return { ensureDefaultBrowserWindow, registerDeepSeekBridgeModel, ensureDeepSeekBridgeWindow, deepSeekChat, getStatus, open, inject };
}

// ../runtime/src/model-provider.ts
import { promises as fs16 } from "fs";
import { homedir as homedir8 } from "os";
import { join as join15 } from "path";

// ../runtime/src/config.ts
import { promises as fs15 } from "fs";
import { join as join14 } from "path";
import { randomUUID } from "crypto";
import { homedir as homedir7, hostname as osHostname } from "os";
var configWriteChain = Promise.resolve();
async function withConfigFile(mutate2) {
  const run = async () => {
    const path3 = join14(homedir7(), ".shanhai", "config.json");
    let cfg = {};
    try {
      cfg = JSON.parse(await fs15.readFile(path3, "utf8"));
    } catch {
    }
    const result = await mutate2(cfg);
    const tmp = `${path3}.tmp`;
    await fs15.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 384 });
    await fs15.rename(tmp, path3);
    return result;
  };
  const p = configWriteChain.then(run);
  configWriteChain = p.catch(() => void 0);
  return p;
}
var deviceInfo = null;
async function ensureDeviceInfo() {
  if (deviceInfo) return;
  const hostname = osHostname();
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const generatedId = randomUUID();
  await withConfigFile((cfg) => {
    const existingId = typeof cfg.deviceId === "string" && cfg.deviceId ? cfg.deviceId : "";
    const existingName = typeof cfg.deviceName === "string" && cfg.deviceName ? cfg.deviceName : "";
    if (!existingId) cfg.deviceId = generatedId;
    if (!existingName) cfg.deviceName = hostname;
    deviceInfo = {
      deviceId: existingId || generatedId,
      deviceName: existingName || hostname,
      hostname,
      os: osName
    };
  });
}
async function persistSelectedModel(modelId) {
  try {
    await withConfigFile((cfg) => {
      const g = cfg.gateway ?? {};
      g.selectedModelId = modelId;
      cfg.gateway = g;
    });
  } catch {
  }
}
async function persistLastActiveSessionId(sessionId) {
  try {
    await withConfigFile((cfg) => {
      cfg.lastActiveSessionId = sessionId;
    });
  } catch {
  }
}
async function readLastActiveSessionId() {
  try {
    const path3 = join14(homedir7(), ".shanhai", "config.json");
    const raw = await fs15.readFile(path3, "utf8");
    const cfg = JSON.parse(raw);
    return typeof cfg.lastActiveSessionId === "string" ? cfg.lastActiveSessionId : null;
  } catch {
    return null;
  }
}
async function persistCustomModels(models) {
  try {
    await withConfigFile((cfg) => {
      const g = cfg.gateway ?? {};
      g.customModels = models;
      cfg.gateway = g;
    });
  } catch {
  }
}
async function persistLoginToken(token, username, member, gateway) {
  try {
    await withConfigFile((cfg) => {
      const g = cfg.gateway ?? {};
      g.memberToken = token;
      g.account = { username, ...member ?? {} };
      g.apiKey = gateway.apiKey;
      g.baseUrl = gateway.baseUrl;
      g.selectedModelId = gateway.selectedModelId;
      cfg.gateway = g;
    });
  } catch {
  }
}
async function readSettings() {
  try {
    const path3 = join14(homedir7(), ".shanhai", "config.json");
    const raw = await fs15.readFile(path3, "utf8");
    const cfg = JSON.parse(raw);
    const s = cfg.settings;
    return {
      browser: {
        showOnCreate: s?.browser?.showOnCreate ?? DEFAULT_SETTINGS.browser.showOnCreate,
        enableWebBridge: s?.browser?.enableWebBridge ?? DEFAULT_SETTINGS.browser.enableWebBridge
      },
      messageSubmit: { mode: s?.messageSubmit?.mode ?? DEFAULT_SETTINGS.messageSubmit.mode },
      debug: { traceLlm: s?.debug?.traceLlm ?? DEFAULT_SETTINGS.debug.traceLlm },
      voice: { enabled: s?.voice?.enabled ?? DEFAULT_SETTINGS.voice.enabled },
      supervisorApproval: { enabled: s?.supervisorApproval?.enabled ?? DEFAULT_SETTINGS.supervisorApproval.enabled },
      supervisorAsk: { enabled: s?.supervisorAsk?.enabled ?? DEFAULT_SETTINGS.supervisorAsk.enabled },
      compaction: { modelId: s?.compaction?.modelId ?? DEFAULT_SETTINGS.compaction.modelId }
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      browser: { ...DEFAULT_SETTINGS.browser },
      messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit },
      debug: { ...DEFAULT_SETTINGS.debug },
      voice: { ...DEFAULT_SETTINGS.voice },
      supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval },
      supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk },
      compaction: { ...DEFAULT_SETTINGS.compaction }
    };
  }
}
async function writeSettings(patch) {
  try {
    await withConfigFile((cfg) => {
      const cur = cfg.settings ?? {};
      const merged = {
        browser: { ...DEFAULT_SETTINGS.browser, ...cur.browser ?? {}, ...patch.browser ?? {} },
        messageSubmit: { ...DEFAULT_SETTINGS.messageSubmit, ...cur.messageSubmit ?? {}, ...patch.messageSubmit ?? {} },
        debug: { ...DEFAULT_SETTINGS.debug, ...cur.debug ?? {}, ...patch.debug ?? {} },
        voice: { ...DEFAULT_SETTINGS.voice, ...cur.voice ?? {}, ...patch.voice ?? {} },
        supervisorApproval: { ...DEFAULT_SETTINGS.supervisorApproval, ...cur.supervisorApproval ?? {}, ...patch.supervisorApproval ?? {} },
        supervisorAsk: { ...DEFAULT_SETTINGS.supervisorAsk, ...cur.supervisorAsk ?? {}, ...patch.supervisorAsk ?? {} },
        compaction: { ...DEFAULT_SETTINGS.compaction, ...cur.compaction ?? {}, ...patch.compaction ?? {} }
      };
      cfg.settings = merged;
    });
  } catch {
  }
}
function getDeviceInfoState() {
  return deviceInfo;
}
function setDeviceInfoName(name) {
  if (deviceInfo) deviceInfo.deviceName = name;
}

// ../runtime/src/model-provider.ts
function createModelProviderModule(ctx, deps) {
  const { allModels, tokenStats, deepSeekBridge, currentWorkDir } = deps;
  const resolveProvider = (modelId) => {
    const cached = ctx.modelProviders.get(modelId);
    if (cached) return cached;
    const target = allModels().find((m) => m.id === modelId);
    let provider = ctx.model;
    if (target?.source === "deepseek-bridge") {
      provider = createDeepSeekModel({ chat: deepSeekBridge.deepSeekChat, getWorkspace: currentWorkDir });
    } else if (target?.baseUrl) {
      provider = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace });
    }
    ctx.modelProviders.set(modelId, provider);
    return provider;
  };
  const applyModel = (modelId) => {
    ctx.currentModelId = modelId;
    ctx.model = resolveProvider(modelId);
    tokenStats.refreshContextLength();
  };
  const restoreCredentials = async () => {
    try {
      const raw = await fs16.readFile(join15(homedir8(), ".shanhai", "config.json"), "utf8");
      const cfg = JSON.parse(raw);
      const g = cfg.gateway;
      ctx.memberToken = g?.memberToken ?? "";
      if (g?.apiKey) {
        ctx.loggedIn = true;
        ctx.username = g.account?.nickname ?? g.account?.username ?? null;
        ctx.gatewayApiKey = g.apiKey;
        ctx.gatewayBaseUrl = g.baseUrl ?? "";
      }
      if (g?.selectedModelId) {
        ctx.currentModelId = g.selectedModelId;
        ctx.defaultModelId = g.selectedModelId;
      }
      if (Array.isArray(g?.customModels)) {
        ctx.customModels = g.customModels.map((m) => ({ ...m, custom: true }));
      }
    } catch {
    }
  };
  const applyGatewayModels = async (models) => {
    if (!Array.isArray(models) || models.length === 0) return;
    ctx.gatewayModels = models;
    ctx.modelsChangedCallbacks.forEach((cb) => cb());
    tokenStats.refreshContextLength();
  };
  const refreshModelsViaApiKey = async () => {
    if (!ctx.gatewayApiKey || !ctx.gatewayBaseUrl) return ctx.gatewayModels;
    const upstream = await fetchGatewayModels(ctx.gatewayApiKey, ctx.gatewayBaseUrl);
    if (upstream.length === 0) return ctx.gatewayModels;
    const enabledIds = new Set(upstream.map((m) => m.id));
    const kept = ctx.gatewayModels.filter((m) => enabledIds.has(m.id));
    const keptIds = new Set(kept.map((m) => m.id));
    const added = upstream.filter((m) => !keptIds.has(m.id)).map((m) => ({ ...m, tier: inferTier(m.id), apiKey: ctx.gatewayApiKey, baseUrl: ctx.gatewayBaseUrl }));
    if (kept.length > 0 || added.length > 0) {
      await applyGatewayModels([...kept, ...added]);
    }
    return ctx.gatewayModels;
  };
  const refreshGatewayModels = async () => {
    if (!ctx.memberToken) return refreshModelsViaApiKey();
    try {
      const models = await ctx.authService.fetchModels(ctx.memberToken);
      if (Array.isArray(models) && models.length > 0) {
        await applyGatewayModels(models.map((m) => ({ ...m, tier: inferTier(m.id) })));
      }
    } catch (err) {
      if (err instanceof TokenExpiredError || /invalid token|expired|unauthorized/i.test(String(err))) {
        await refreshModelsViaApiKey();
        if (ctx.gatewayModels.length === 0) {
          ctx.authExpiredCallbacks.forEach((cb) => cb());
        }
      }
    }
    return ctx.gatewayModels;
  };
  const login = async (u, p) => {
    const s = await ctx.authService.login(u, p);
    ctx.loggedIn = true;
    ctx.username = s.nickname ?? s.username;
    ctx.memberToken = s.token;
    const models = await ctx.authService.fetchModels(s.token);
    const first = models[0];
    if (first) {
      ctx.gatewayModels = models.map((m) => ({ ...m, tier: inferTier(m.id) }));
      ctx.gatewayApiKey = first.apiKey;
      ctx.gatewayBaseUrl = first.baseUrl;
      const cached = ctx.currentModelId;
      const target = ctx.gatewayModels.find((m) => m.id === cached) ?? ctx.gatewayModels.find((m) => m.id === "deepseek-v4-flash") ?? ctx.gatewayModels[0];
      if (target) {
        applyModel(target.id);
        ctx.defaultModelId = target.id;
      }
    }
    tokenStats.refreshContextLength();
    await persistLoginToken(s.token, s.username, { nickname: s.nickname, avatar: s.avatar }, {
      apiKey: ctx.gatewayApiKey,
      baseUrl: ctx.gatewayBaseUrl,
      selectedModelId: ctx.currentModelId
    });
    return { username: s.nickname ?? s.username, nickname: s.nickname };
  };
  const logout = async () => {
    ctx.loggedIn = false;
    ctx.username = null;
    ctx.gatewayApiKey = "";
    ctx.gatewayBaseUrl = "";
    ctx.memberToken = "";
    ctx.gatewayModels = [];
    try {
      await withConfigFile((cfg) => {
        const g = cfg.gateway ?? {};
        delete g.memberToken;
        delete g.apiKey;
        delete g.baseUrl;
        delete g.account;
        delete g.models;
        cfg.gateway = g;
      });
    } catch {
    }
    const target = allModels().find((m) => m.id === ctx.currentModelId);
    if (target?.source === "deepseek-bridge") {
      ctx.model = createDeepSeekModel({ chat: deepSeekBridge.deepSeekChat, getWorkspace: currentWorkDir });
    } else if (target?.baseUrl) {
      ctx.model = createModelProvider({ apiKey: target.apiKey, baseUrl: target.baseUrl, model: target.model ?? target.id, protocol: target.protocol, maxTokens: target.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace });
    } else {
      ctx.model = await createGatewayModel(tokenStats.onUsage, tokenStats.onHttpTrace);
    }
    ctx.defaultModelId = "";
    tokenStats.refreshContextLength();
  };
  const listModels = async () => allModels();
  const refreshModels = async () => refreshGatewayModels();
  const addCustomModel = async (input) => {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const custom = {
      id,
      name: input.name || input.model,
      model: input.model,
      tier: "flagship",
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      contextLength: input.contextLength,
      supportsVision: input.supportsVision,
      custom: true
    };
    ctx.customModels = [...ctx.customModels, custom];
    await persistCustomModels(ctx.customModels);
    return custom;
  };
  const updateCustomModel = async (id, input) => {
    const existing = ctx.customModels.find((m) => m.id === id);
    if (!existing) throw new Error(`\u81EA\u5B9A\u4E49\u6A21\u578B\u4E0D\u5B58\u5728: ${id}`);
    const updated = {
      id: existing.id,
      name: input.name || input.model,
      model: input.model,
      tier: existing.tier,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      protocol: input.protocol,
      contextLength: input.contextLength ?? existing.contextLength,
      maxTokens: existing.maxTokens,
      temperature: existing.temperature,
      supportsVision: input.supportsVision ?? existing.supportsVision,
      supportsReasoning: existing.supportsReasoning,
      provider: existing.provider,
      sortOrder: existing.sortOrder,
      description: existing.description,
      source: existing.source,
      custom: true
    };
    ctx.customModels = ctx.customModels.map((m) => m.id === id ? updated : m);
    if (ctx.currentModelId === id && updated.baseUrl) {
      ctx.model = createModelProvider({ apiKey: updated.apiKey, baseUrl: updated.baseUrl, model: updated.model ?? updated.id, protocol: updated.protocol, maxTokens: updated.maxTokens, onUsage: tokenStats.onUsage, onTrace: tokenStats.onHttpTrace });
    }
    await persistCustomModels(ctx.customModels);
    return updated;
  };
  const removeCustomModel = async (id) => {
    ctx.customModels = ctx.customModels.filter((m) => m.id !== id);
    if (ctx.currentModelId === id) {
      ctx.currentModelId = "";
      ctx.model = await createGatewayModel(tokenStats.onUsage, tokenStats.onHttpTrace);
    }
    tokenStats.refreshContextLength();
    await persistCustomModels(ctx.customModels);
  };
  const getCurrentModelId = () => ctx.currentModelId;
  const resolveCompactModel = () => {
    const id = ctx.currentSettings.compaction?.modelId;
    if (!id) return void 0;
    return resolveProvider(id);
  };
  return {
    resolveProvider,
    applyModel,
    restoreCredentials,
    applyGatewayModels,
    refreshModelsViaApiKey,
    refreshGatewayModels,
    login,
    logout,
    listModels,
    refreshModels,
    addCustomModel,
    updateCustomModel,
    removeCustomModel,
    getCurrentModelId,
    resolveCompactModel
  };
}

// ../runtime/src/sessions.ts
import { promises as fs18 } from "fs";
import { homedir as homedir10 } from "os";
import { join as join17 } from "path";

// ../runtime/src/supervisor-workspace.ts
import { promises as fs17 } from "fs";
import { homedir as homedir9 } from "os";
import { join as join16, resolve as resolve3, isAbsolute as isAbsolute2, relative as relative2, dirname as dirname2 } from "path";
var SUPERVISOR_WORKSPACE = join16(homedir9(), ".shanhai", "supervisor-workspace");
async function ensureSupervisorWorkspace() {
  await fs17.mkdir(SUPERVISOR_WORKSPACE, { recursive: true });
}
async function removeSessionLedger(sessionId) {
  const dir = resolve3(SUPERVISOR_WORKSPACE, sessionId);
  await fs17.rm(dir, { recursive: true, force: true });
}
function resolveLedgerPath(p) {
  const base = resolve3(SUPERVISOR_WORKSPACE);
  const raw = (p ?? "").trim();
  const target = raw === "" ? base : isAbsolute2(raw) ? resolve3(raw) : resolve3(base, raw);
  const rel = relative2(base, target);
  if (rel.startsWith("..") || isAbsolute2(rel)) {
    throw new Error(`\u53F0\u8D26\u8DEF\u5F84\u8D8A\u754C\uFF1A\u4EC5\u5141\u8BB8\u8BBF\u95EE\u7BA1\u5BB6\u53F0\u8D26\u76EE\u5F55 ${base} \u5185\u7684\u6587\u4EF6\uFF0C\u6536\u5230 "${p}"`);
  }
  return target;
}
async function buildLedgerTree(dir, maxDepth) {
  const base = resolve3(SUPERVISOR_WORKSPACE);
  const rootLabel = relative2(base, dir) || "(root)";
  const lines = [rootLabel + "/"];
  const walk = async (cur, prefix, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      const list = await fs17.readdir(cur, { withFileTypes: true });
      entries = list.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      const last = i === entries.length - 1;
      const connector = last ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const childPrefix = prefix + (last ? "    " : "\u2502   ");
      if (e.isDir) {
        lines.push(prefix + connector + e.name + "/");
        await walk(join16(cur, e.name), childPrefix, depth + 1);
      } else {
        lines.push(prefix + connector + e.name);
      }
    }
  };
  await walk(dir, "", 1);
  return lines.join("\n");
}
function ledgerBase() {
  return resolve3(SUPERVISOR_WORKSPACE);
}
function createSupervisorLedgerTools() {
  return [
    {
      name: "list_ledger",
      description: "\u4EE5\u6811\u5F62\u5217\u51FA\u7BA1\u5BB6\u53F0\u8D26\u76EE\u5F55\u7ED3\u6784\u3002\u53F0\u8D26\u4F4D\u4E8E\u7BA1\u5BB6\u79C1\u6709\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u6309\u4F1A\u8BDD id \u5206\u5B50\u76EE\u5F55\uFF0C\u6BCF\u4E2A\u4F1A\u8BDD\u76EE\u5F55\u5185\u901A\u5E38\u6709 notes.md\uFF08\u81EA\u7136\u8BED\u8A00\u5907\u6CE8\uFF09\u4E0E state.json\uFF08\u7ED3\u6784\u5316\u72B6\u6001\uFF09\uFF0C\u9876\u5C42 _index.json \u662F\u300C\u4F1A\u8BDD id \u2192 \u6807\u9898\u300D\u7D22\u5F15\u3002path \u7F3A\u7701\u5217\u53F0\u8D26\u6839\u76EE\u5F55\uFF0C\u53EF\u4F20\u76F8\u5BF9\u8DEF\u5F84\u5217\u67D0\u4E2A\u4F1A\u8BDD\u5B50\u76EE\u5F55\uFF1BmaxDepth \u63A7\u5236\u6DF1\u5EA6\uFF08\u9ED8\u8BA4 2\uFF09\u3002\u53EA\u8BFB\uFF0C\u4E0D\u6539\u53D8\u4EFB\u4F55\u72B6\u6001\u3002",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u53F0\u8D26\u76EE\u5F55\u76F8\u5BF9\u8DEF\u5F84\uFF0C\u7F3A\u7701\u5217\u6839\u76EE\u5F55" },
          maxDepth: { type: "number", description: "\u9012\u5F52\u6DF1\u5EA6\uFF0C\u9ED8\u8BA4 2" }
        }
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const dir = resolveLedgerPath(String(args.path ?? ""));
        const maxDepth = typeof args.maxDepth === "number" ? Math.max(1, Math.floor(args.maxDepth)) : 2;
        return buildLedgerTree(dir, maxDepth);
      }
    },
    {
      name: "read_ledger",
      description: '\u8BFB\u53D6\u7BA1\u5BB6\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u6587\u4EF6\u5185\u5BB9\uFF08\u5982\u67D0\u4F1A\u8BDD\u7684 notes.md / state.json / \u9876\u5C42 _index.json\uFF09\u3002path \u4E3A\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF08\u5982 "\u67D0\u4E2A\u4F1A\u8BDDid/notes.md"\uFF09\u3002\u53EA\u80FD\u8BFB\u53F0\u8D26\u76EE\u5F55\u5185\u6587\u4EF6\uFF0C\u4E0D\u80FD\u8BFB\u53F0\u8D26\u76EE\u5F55\u4E4B\u5916\u3002',
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u53F0\u8D26\u6587\u4EF6\u76F8\u5BF9\u8DEF\u5F84\uFF08\u76F8\u5BF9\u53F0\u8D26\u6839\u76EE\u5F55\uFF09" }
        },
        required: ["path"]
      },
      riskLevel: "readonly",
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ""));
        if (p === ledgerBase()) throw new Error("read_ledger \u8BF7\u6307\u5B9A\u5177\u4F53\u6587\u4EF6\u8DEF\u5F84\uFF08\u4E0D\u80FD\u8BFB\u53F0\u8D26\u6839\u76EE\u5F55\u672C\u8EAB\uFF09");
        return fs17.readFile(p, "utf8");
      }
    },
    {
      name: "write_ledger",
      description: "\u5199\u5165\uFF08\u8986\u76D6\uFF09\u7BA1\u5BB6\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u6587\u4EF6\uFF0C\u7528\u4E8E\u66F4\u65B0\u67D0\u4E2A\u4F1A\u8BDD\u7684 state.json \u6216 notes.md\u3002path \u4E3A\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\uFF1Bcontent \u4E3A\u5B8C\u6574\u65B0\u5185\u5BB9\u3002\u4F1A\u81EA\u52A8\u521B\u5EFA\u7F3A\u5931\u7684\u7236\u76EE\u5F55\u3002\u53EA\u80FD\u5199\u53F0\u8D26\u76EE\u5F55\u5185\u6587\u4EF6\u3002",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u53F0\u8D26\u6587\u4EF6\u76F8\u5BF9\u8DEF\u5F84\uFF08\u76F8\u5BF9\u53F0\u8D26\u6839\u76EE\u5F55\uFF09" },
          content: { type: "string", description: "\u8981\u5199\u5165\u7684\u5B8C\u6574\u5185\u5BB9" }
        },
        required: ["path", "content"]
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ""));
        if (p === ledgerBase()) throw new Error("write_ledger \u8BF7\u6307\u5B9A\u5177\u4F53\u6587\u4EF6\u8DEF\u5F84\uFF08\u4E0D\u80FD\u8986\u76D6\u53F0\u8D26\u6839\u76EE\u5F55\u672C\u8EAB\uFF09");
        await fs17.mkdir(dirname2(p), { recursive: true });
        await fs17.writeFile(p, String(args.content ?? ""), "utf8");
        return { ok: true, path: relative2(ledgerBase(), p) };
      }
    },
    {
      name: "edit_ledger",
      description: "\u5C40\u90E8\u7F16\u8F91\u7BA1\u5BB6\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u6587\u4EF6\uFF1A\u5C06 oldText \u7CBE\u786E\u66FF\u6362\u4E3A newText\uFF08\u53EA\u6539\u7247\u6BB5\uFF0C\u65E0\u9700\u91CD\u4F20\u5168\u6587\uFF09\u3002path \u4E3A\u53F0\u8D26\u76EE\u5F55\u5185\u7684\u76F8\u5BF9\u8DEF\u5F84\u3002\u9ED8\u8BA4\u66FF\u6362\u9996\u6B21\u547D\u4E2D\uFF1BoldText \u591A\u6B21\u51FA\u73B0\u65F6\u8BBE replaceAll=true \u66FF\u6362\u5168\u90E8\u3002\u53EA\u80FD\u7F16\u8F91\u53F0\u8D26\u76EE\u5F55\u5185\u6587\u4EF6\u3002",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u53F0\u8D26\u6587\u4EF6\u76F8\u5BF9\u8DEF\u5F84\uFF08\u76F8\u5BF9\u53F0\u8D26\u6839\u76EE\u5F55\uFF09" },
          oldText: { type: "string", description: "\u8981\u88AB\u66FF\u6362\u7684\u539F\u6587\u672C\uFF08\u5FC5\u987B\u7CBE\u786E\u5339\u914D\uFF09" },
          newText: { type: "string", description: "\u66FF\u6362\u540E\u7684\u65B0\u6587\u672C" },
          replaceAll: { type: "boolean", description: "\u662F\u5426\u66FF\u6362\u5168\u90E8\u547D\u4E2D\uFF0C\u9ED8\u8BA4 false" }
        },
        required: ["path", "oldText", "newText"]
      },
      riskLevel: "reversible",
      execute: async (args) => {
        const p = resolveLedgerPath(String(args.path ?? ""));
        if (p === ledgerBase()) throw new Error("edit_ledger \u8BF7\u6307\u5B9A\u5177\u4F53\u6587\u4EF6\u8DEF\u5F84\uFF08\u4E0D\u80FD\u7F16\u8F91\u53F0\u8D26\u6839\u76EE\u5F55\u672C\u8EAB\uFF09");
        const oldText = String(args.oldText ?? "");
        if (oldText === "") throw new Error("edit_ledger \u7F3A\u5C11 oldText\uFF1A\u8BF7\u63D0\u4F9B\u8981\u88AB\u66FF\u6362\u7684\u539F\u6587\u672C\u7247\u6BB5");
        const newText = String(args.newText ?? "");
        const replaceAll = args.replaceAll === true;
        let before;
        try {
          before = await fs17.readFile(p, "utf8");
        } catch {
          throw new Error(`edit_ledger \u8BFB\u53D6\u5931\u8D25\uFF1A${p} \u4E0D\u5B58\u5728\uFF0C\u8BF7\u5148\u7528 read_ledger \u786E\u8BA4\u5B9E\u9645\u5185\u5BB9`);
        }
        const count = before.split(oldText).length - 1;
        if (count === 0) {
          throw new Error("edit_ledger \u672A\u627E\u5230 oldText\uFF1A\u6587\u4EF6\u4E2D\u4E0D\u5B58\u5728\u8BE5\u7247\u6BB5\uFF0C\u8BF7\u5148\u7528 read_ledger \u8BFB\u53D6\u5B9E\u9645\u5185\u5BB9\u786E\u4FDD\u7CBE\u786E\u5339\u914D");
        }
        if (!replaceAll && count > 1) {
          throw new Error(`edit_ledger \u547D\u4E2D ${count} \u5904\uFF1A\u8BF7\u63D0\u4F9B\u66F4\u957F\u7684 oldText \u7CBE\u786E\u5B9A\u4F4D\uFF0C\u6216\u8BBE\u7F6E replaceAll=true`);
        }
        const after = replaceAll ? before.split(oldText).join(newText) : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length);
        await fs17.writeFile(p, after, "utf8");
        return { ok: true, path: relative2(ledgerBase(), p), occurrences: replaceAll ? count : 1 };
      }
    }
  ];
}

// ../runtime/src/sessions.ts
function createSessionsModule(ctx, deps) {
  const { getTokenStats, getModelProvider, getDeepSeekBridge, allModels } = deps;
  async function persistSessionInner(meta) {
    try {
      const dir = sessionDirPath(ctx.sessionsDir, meta.id);
      await writeSessionMetaFile(dir, {
        id: meta.id,
        title: meta.title,
        workDir: meta.workDir,
        lastActiveAt: meta.lastActiveAt,
        modelId: meta.modelId,
        approvalPolicy: meta.approvalPolicy
      });
      const session = meta.session;
      if (session.requireRewrite()) {
        const durable = session.list().filter((e) => e.type !== "assistant/delta");
        await rewriteSessionEventsFile(dir, durable);
        session.markPersisted();
      } else {
        const newEvents = session.slice(session.persistedCount).filter((e) => e.type !== "assistant/delta");
        if (newEvents.length > 0) {
          await appendSessionEventsFile(dir, newEvents);
        }
        session.persistedCount = session.size;
      }
    } catch {
    }
  }
  const persistSession = (meta) => {
    const prev = ctx.sessionWriteChains.get(meta.id) ?? Promise.resolve();
    const next = prev.then(() => persistSessionInner(meta)).catch(() => void 0);
    ctx.sessionWriteChains.set(meta.id, next);
    return next;
  };
  const readRetrySnapshot = (meta) => {
    const events = meta.session.list();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === "turn/end") break;
      if (e?.type === "retry/snapshot") {
        const d = e.data;
        return {
          messages: d.messages,
          step: d.step,
          maxSteps: d.maxSteps,
          atLimit: d.atLimit,
          reason: d.reason
        };
      }
    }
    return null;
  };
  const createSessionInternal = (title, workDir) => {
    const id = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const meta = { id, title: title?.trim() || "\u65B0\u4F1A\u8BDD", session: new Session(), workDir: workDir ?? join17(homedir10(), "shanhai", "workspace"), lastActiveAt: Date.now(), isSupervisor: false };
    ctx.sessions.set(id, meta);
    void persistSession(meta);
    return id;
  };
  const newSession = (title, workDir) => {
    const id = createSessionInternal(title, workDir);
    ctx.currentSessionId = id;
    void persistLastActiveSessionId(id);
    return id;
  };
  const ensureSupervisorSession = () => {
    void ensureSupervisorWorkspace();
    if (ctx.sessions.has(SUPERVISOR_ID)) return;
    const meta = {
      id: SUPERVISOR_ID,
      title: "\u4F1A\u8BDD\u7BA1\u5BB6",
      session: new Session(),
      workDir: SUPERVISOR_WORKSPACE,
      lastActiveAt: Date.now(),
      isSupervisor: true
    };
    ctx.sessions.set(SUPERVISOR_ID, meta);
    void persistSession(meta);
  };
  const touchSession = (id) => {
    const meta = ctx.sessions.get(id);
    if (meta) {
      meta.lastActiveAt = Date.now();
      void persistSession(meta);
    }
  };
  const currentWorkDir = () => {
    const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : void 0;
    return meta?.workDir ?? join17(homedir10(), "shanhai", "workspace");
  };
  const sessionApprovalPolicy = (sid) => {
    const meta = ctx.sessions.get(sid ?? ctx.currentSessionId ?? "");
    if (!meta) return "ask";
    return meta.approvalPolicy ?? "ask";
  };
  const describeSession = (sid) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return null;
    const events = meta.session.list();
    let currentRequest = "";
    let lastUserIdx = -1;
    const userRequests = [];
    for (const e of events) {
      if (e?.type === "user/message") {
        const d = e.data;
        if (!d.injected) {
          const text = (d.content ?? "").trim();
          if (text) userRequests.push(text);
        }
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === "user/message") {
        const d = e.data;
        if (!d.injected) {
          currentRequest = d.content ?? "";
          lastUserIdx = i;
          break;
        }
      }
    }
    const recentRequests = userRequests.slice(-3).map((t) => t.length > 120 ? t.slice(0, 120) + "\u2026" : t);
    let turnStartIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type === "turn/start") turnStartIdx = i;
    }
    let stepCount = 0;
    for (let i = turnStartIdx + 1; i < events.length; i++) {
      if (events[i]?.type === "tool/call") stepCount++;
    }
    let hasIncompleteTurn = false;
    if (!ctx.runningLoops.has(sid) && lastUserIdx >= 0) {
      let done = false;
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type;
        if (t === "assistant/message" || t === "turn/end") {
          done = true;
          break;
        }
      }
      hasIncompleteTurn = !done;
    }
    let hasRetrySnapshot = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i]?.type;
      if (t === "turn/end") break;
      if (t === "retry/snapshot") {
        hasRetrySnapshot = true;
        break;
      }
    }
    const modelId = meta.modelId ?? ctx.defaultModelId;
    const modelDef = allModels().find((m) => m.id === modelId);
    const snap = getTokenStats().snapshot(sid);
    return {
      id: meta.id,
      title: meta.title,
      workDir: meta.workDir,
      busy: ctx.runningLoops.has(sid),
      active: ctx.currentSessionId === sid,
      modelId,
      modelName: modelDef?.displayName ?? modelDef?.name ?? modelId,
      approvalPolicy: meta.approvalPolicy ?? "ask",
      currentRequest,
      recentRequests,
      stepCount,
      contextLength: snap.contextLength,
      lastPrompt: snap.lastPrompt,
      contextUsageRatio: snap.contextUsageRatio,
      turnCount: snap.turnCount,
      hasIncompleteTurn,
      hasRetrySnapshot,
      lastActiveAt: meta.lastActiveAt
    };
  };
  const setSessionModelInternal = (sid, modelId) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `\u6A21\u578B\u4E0D\u5B58\u5728: ${modelId}\uFF08\u7528 list_models \u67E5\u770B\u53EF\u7528\u6A21\u578B\uFF09` };
    meta.modelId = modelId;
    void persistSession(meta);
    if (ctx.currentSessionId === sid) getModelProvider().applyModel(modelId);
    return { ok: true, message: `\u5DF2\u5C06\u4F1A\u8BDD\u300C${meta.title}\u300D(${sid}) \u7684\u6A21\u578B\u5207\u6362\u4E3A ${modelId}` };
  };
  const setSessionApprovalInternal = (sid, policy) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    meta.approvalPolicy = policy;
    void persistSession(meta);
    if (ctx.currentSessionId === sid) ctx.approval.setPolicy(policy);
    return { ok: true, message: `\u5DF2\u5C06\u4F1A\u8BDD\u300C${meta.title}\u300D(${sid}) \u7684\u5B89\u5168\u6A21\u5F0F\u8BBE\u4E3A ${policy}` };
  };
  const renameSessionInternal = (sid, title) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    const trimmed = title.trim();
    if (!trimmed) return { ok: false, message: "\u4F1A\u8BDD\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A" };
    meta.title = trimmed;
    void persistSession(meta);
    return { ok: true, message: `\u5DF2\u5C06\u4F1A\u8BDD\u91CD\u547D\u540D\u4E3A\u300C${trimmed}\u300D(${sid})` };
  };
  const setSessionWorkdirInternal = (sid, workdir) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    const trimmed = workdir.trim();
    if (!trimmed) return { ok: false, message: "\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u80FD\u4E3A\u7A7A" };
    meta.workDir = trimmed;
    void persistSession(meta);
    return { ok: true, message: `\u5DF2\u5C06\u4F1A\u8BDD\u300C${meta.title}\u300D(${sid}) \u7684\u5DE5\u4F5C\u76EE\u5F55\u8BBE\u4E3A ${trimmed}` };
  };
  const deleteSessionInternal = async (sid) => {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    const title = meta.title;
    for (const [requestId, p] of ctx.pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve("rejected");
        ctx.pendingApprovals.delete(requestId);
      }
    }
    for (const [requestId, p] of ctx.pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false);
        ctx.pendingClientRuns.delete(requestId);
      }
    }
    ctx.askService.cancelSession(sid);
    const pendingWrite = ctx.sessionWriteChains.get(sid);
    if (pendingWrite) await pendingWrite.catch(() => void 0);
    ctx.sessionWriteChains.delete(sid);
    ctx.sessions.delete(sid);
    await deleteSessionDir(sessionDirPath(ctx.sessionsDir, sid));
    await fs18.rm(join17(ctx.sessionsDir, `${sid}.json`), { force: true }).catch(() => void 0);
    await fs18.rm(ctx.httpTrace.path(sid), { force: true }).catch(() => void 0);
    await removeSessionLedger(sid);
    if (ctx.currentSessionId === sid) {
      const next = [...ctx.sessions.values()].find((s) => !s.isSupervisor);
      if (next) {
        ctx.currentSessionId = next.id;
        ctx.sessionRef = next.session;
        void persistLastActiveSessionId(next.id);
      } else {
        newSession("\u65B0\u4F1A\u8BDD");
      }
    }
    return { ok: true, message: `\u5DF2\u5220\u9664\u4F1A\u8BDD\u300C${title}\u300D(${sid})` };
  };
  const getSupervisorModelInternal = () => {
    const meta = ctx.sessions.get(SUPERVISOR_ID);
    return meta?.modelId ?? ctx.defaultModelId;
  };
  const getSupervisorApprovalInternal = () => sessionApprovalPolicy(SUPERVISOR_ID);
  const setSupervisorModelInternal = (modelId) => {
    const meta = ctx.sessions.get(SUPERVISOR_ID);
    if (!meta) return { ok: false, message: "\u7BA1\u5BB6\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
    if (!allModels().some((m) => m.id === modelId)) return { ok: false, message: `\u6A21\u578B\u4E0D\u5B58\u5728: ${modelId}\uFF08\u7528 list_models \u67E5\u770B\u53EF\u7528\u6A21\u578B\uFF09` };
    meta.modelId = modelId;
    void persistSession(meta);
    return { ok: true, message: `\u7BA1\u5BB6\u6A21\u578B\u5DF2\u5207\u6362\u4E3A ${modelId}` };
  };
  const setSupervisorApprovalInternal = (policy) => {
    const meta = ctx.sessions.get(SUPERVISOR_ID);
    if (!meta) return { ok: false, message: "\u7BA1\u5BB6\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
    meta.approvalPolicy = policy;
    void persistSession(meta);
    return { ok: true, message: `\u7BA1\u5BB6\u5B89\u5168\u6A21\u5F0F\u5DF2\u8BBE\u4E3A ${policy}` };
  };
  const switchSessionInternal = (id) => {
    const target = ctx.sessions.get(id);
    if (!target || target.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${id}` };
    ctx.currentSessionId = id;
    ctx.sessionRef = target.session;
    void persistLastActiveSessionId(id);
    ctx.approval.setPolicy(target.approvalPolicy ?? "ask");
    const sidModel = target.modelId;
    if (sidModel) {
      getModelProvider().applyModel(sidModel);
    } else if (ctx.defaultModelId) {
      getModelProvider().applyModel(ctx.defaultModelId);
    }
    getTokenStats().emitTokenStats(id);
    getDeepSeekBridge().ensureDefaultBrowserWindow(id);
    ctx.currentSessionChangedCallbacks.forEach((cb) => cb(id));
    return { ok: true, message: `\u5DF2\u6FC0\u6D3B\u4F1A\u8BDD\u300C${target.title}\u300D(${id})` };
  };
  const stopSessionInternal = (sid) => {
    if (!sid) return;
    ctx.stoppedSessions.add(sid);
    ctx.runningLoops.get(sid)?.abort();
    for (const [requestId, p] of ctx.pendingApprovals) {
      if (p.sessionId === sid) {
        p.resolve("rejected");
        ctx.pendingApprovals.delete(requestId);
      }
    }
    for (const [requestId, p] of ctx.pendingClientRuns) {
      if (p.sessionId === sid) {
        p.resolve(false);
        ctx.pendingClientRuns.delete(requestId);
      }
    }
  };
  const getSessionHistory = (id) => {
    const target = ctx.sessions.get(id ?? ctx.currentSessionId ?? "");
    if (!target) return [];
    const out = [];
    let userSeq = 0;
    let turnStartTs = 0;
    const toolStartMap = /* @__PURE__ */ new Map();
    for (const e of target.session.list()) {
      if (e.type === "user/message") {
        const d = e.data;
        if (d.injected) continue;
        userSeq += 1;
        turnStartTs = e.timestamp;
        out.push({ kind: "user", content: d.content, attachments: d.attachments, turnSeq: userSeq });
      } else if (e.type === "assistant/message") {
        const d = e.data;
        const turnDuration = turnStartTs > 0 ? e.timestamp - turnStartTs : void 0;
        out.push({ kind: "assistant", content: d.content, reasoningContent: d.reasoningContent, turnSeq: userSeq, turnDuration });
      } else if (e.type === "tool/call") {
        const d = e.data;
        toolStartMap.set(d.callId, e.timestamp);
        out.push({ kind: "tool", trace: { kind: "tool-call", sessionId: target.id, callId: d.callId, name: d.name, args: d.args, reasoning: d.reasoningContent, startTs: e.timestamp } });
      } else if (e.type === "tool/result") {
        const d = e.data;
        const startTs = toolStartMap.get(d.callId);
        const durationMs = startTs != null && startTs > 0 ? e.timestamp - startTs : void 0;
        out.push({ kind: "tool", trace: { kind: "tool-result", sessionId: target.id, callId: d.callId, name: d.name, result: d.result, error: d.error, durationMs } });
      }
    }
    return out;
  };
  const getSessionTrace = (id) => {
    const target = ctx.sessions.get(id ?? ctx.currentSessionId ?? "");
    if (!target) return [];
    const out = [];
    let turn = 0;
    for (const e of target.session.list()) {
      if (e.type === "turn/start") {
        turn = e.data.turn;
      } else if (e.type === "user/message") {
        const d = e.data;
        out.push({ role: "user", content: d.content, turn, timestamp: e.timestamp });
      } else if (e.type === "assistant/message") {
        const d = e.data;
        out.push({ role: "assistant", content: d.content, reasoningContent: d.reasoningContent, turn, timestamp: e.timestamp });
      } else if (e.type === "tool/call") {
        const d = e.data;
        out.push({ role: "assistant", content: "", reasoningContent: d.reasoningContent, toolCalls: [{ id: d.callId, name: d.name, args: d.args }], turn, timestamp: e.timestamp });
      } else if (e.type === "tool/result") {
        const d = e.data;
        const text = d.error ?? (typeof d.result === "string" ? d.result : JSON.stringify(d.result ?? ""));
        out.push({ role: "tool", content: text, toolCallId: d.callId, toolName: d.name, result: d.result, error: d.error, turn, timestamp: e.timestamp });
      }
    }
    return out;
  };
  const getHistory = () => {
    const target = ctx.sessions.get(ctx.currentSessionId ?? "");
    if (!target) return [];
    const out = [];
    for (const e of target.session.list()) {
      if (e.type === "user/message") {
        out.push({ role: "user", content: e.data.content });
      } else if (e.type === "assistant/message") {
        out.push({ role: "assistant", content: e.data.content });
      } else if (e.type === "tool/call") {
        out.push({ role: "tool", content: "", toolName: e.data.name });
      } else if (e.type === "tool/result") {
        const d = e.data;
        out.push({ role: "tool", content: JSON.stringify(d.result ?? d.error ?? "") });
      }
    }
    return out;
  };
  return {
    persistSession,
    readRetrySnapshot,
    createSessionInternal,
    newSession,
    ensureSupervisorSession,
    touchSession,
    currentWorkDir,
    sessionApprovalPolicy,
    describeSession,
    setSessionModelInternal,
    setSessionApprovalInternal,
    renameSessionInternal,
    setSessionWorkdirInternal,
    deleteSessionInternal,
    getSupervisorModelInternal,
    getSupervisorApprovalInternal,
    setSupervisorModelInternal,
    setSupervisorApprovalInternal,
    switchSessionInternal,
    stopSessionInternal,
    getSessionHistory,
    getSessionTrace,
    getHistory
  };
}

// ../runtime/src/execution.ts
function createExecutionModule(ctx, deps) {
  const { sessions, tokenStats, prompts, modelProvider, allModels, wrapTool } = deps;
  const runInSession = async (sid, message, opts, modelIdOverride, origin = "user") => {
    const meta = ctx.sessions.get(sid);
    if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}`);
    const targetSession = meta.session;
    const isSupervisorRun = sid === SUPERVISOR_ID;
    const effModelId = modelIdOverride ?? ctx.currentModelId;
    const effModel = modelIdOverride ? modelProvider.resolveProvider(modelIdOverride) : ctx.model;
    ctx.stoppedSessions.delete(sid);
    if (!isSupervisorRun) ctx.sessionOrigin.set(sid, origin);
    sessions.touchSession(sid);
    ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "start"));
    const statAcc = tokenStats.sessionStats(sid);
    statAcc.turnPrompt = 0;
    statAcc.turnCompletion = 0;
    statAcc.turn = 0;
    statAcc.turnCachedPromptTokens = 0;
    tokenStats.emitTokenStats(sid);
    let modelContent;
    const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId));
    if (opts?.attachments && opts.attachments.length > 0 && !visionCapable) {
      const parts = [];
      for (const p of opts.attachments) {
        if (p.type === "image_url") {
          parts.push(`\u3010\u56FE\u7247\u3011${await prompts.analyzeImageWithVision(p.image_url.url)}`);
        }
      }
      const desc = parts.filter(Boolean).join("\n");
      modelContent = message ? `${message}

${desc}` : desc;
    }
    const loop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, targetSession, ctx.approval, sid, tokenStats.currentContextBudget(effModelId), visionCapable, tokenStats.currentApiKey(effModelId), modelProvider.resolveCompactModel());
    ctx.runningLoops.set(sid, loop);
    let suspended = false;
    try {
      return await sessionContext.run(
        sid,
        () => loop.run(message, {
          ...opts,
          systemPrompt: isSupervisorRun ? prompts.buildSupervisorSystemPrompt(message) : prompts.buildSystemPrompt(meta.workDir, prompts.buildMemoryContext(message, meta.id)),
          attachments: opts?.attachments,
          modelContent,
          onDelta: (text) => {
            if (ctx.stoppedSessions.has(sid)) throw new Error("__stopped__");
            ctx.deltaCallbacks.forEach((cb) => cb(sid, text));
          },
          onReasoning: (text) => {
            ctx.reasoningCallbacks.forEach((cb) => cb(sid, text));
          }
        })
      );
    } catch (err) {
      if (err instanceof Error && err.message === "__stopped__") {
        return "\uFF08\u5DF2\u4E2D\u65AD\uFF0C\u5386\u53F2\u5DF2\u4FDD\u7559\uFF0C\u53EF\u70B9\u51FB\u300C\u7EE7\u7EED\u6267\u884C\u300D\u7EED\u8DD1\uFF09";
      }
      if (err instanceof Error && err.message.startsWith("__retry_exhausted__")) {
        suspended = !isSupervisorRun;
      }
      throw err;
    } finally {
      if (!suspended) {
        ctx.runningLoops.delete(sid);
        ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "end"));
      }
      ctx.sessionOrigin.delete(sid);
      meta.lastActiveAt = Date.now();
      await sessions.persistSession(meta);
      tokenStats.emitTokenStats();
      drainSupervisorQueue(sid);
      if (sid === SUPERVISOR_ID && !suspended) {
        console.log("[supervisor-wake] \u7BA1\u5BB6 loop \u7ED3\u675F\uFF08finally\uFF09\uFF0C\u89E6\u53D1 drain\uFF0Csuspended=", suspended);
        void drainSupervisorWake();
      } else if (sid === SUPERVISOR_ID) {
        console.log("[supervisor-wake] \u7BA1\u5BB6 loop \u7ED3\u675F\u4F46 suspended=true\uFF0C\u4E0D\u89E6\u53D1 drain");
      }
    }
  };
  async function dispatchToSession(sid, message, mode, onDone, origin = "user") {
    const meta = ctx.sessions.get(sid);
    if (!meta || meta.isSupervisor) return { ok: false, message: `\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}` };
    const content = message.trim();
    if (!content) return { ok: false, message: "\u6D88\u606F\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" };
    const busy = ctx.runningLoops.has(sid);
    if (busy && mode === "insert") {
      const loop = ctx.runningLoops.get(sid);
      if (loop) {
        loop.injectUserMessage(content);
        return Promise.resolve({ ok: true, message: `\u5DF2\u5411\u4F1A\u8BDD\u300C${meta.title}\u300D(${sid}) \u8FFD\u52A0\u9700\u6C42\uFF08\u4E0D\u6253\u65AD\u5F53\u524D\u4EFB\u52A1\uFF09` });
      }
      return Promise.resolve({ ok: false, message: "\u6CE8\u5165\u5931\u8D25\uFF1A\u672A\u627E\u5230\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1" });
    }
    if (busy && mode === "queue") {
      const q = ctx.supervisorQueue.get(sid) ?? [];
      q.push(content);
      ctx.supervisorQueue.set(sid, q);
      return Promise.resolve({ ok: true, message: `\u4F1A\u8BDD\u300C${meta.title}\u300D(${sid}) \u6B63\u5728\u6267\u884C\uFF0C\u9700\u6C42\u5DF2\u6392\u961F\uFF08\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F\u540E\u81EA\u52A8\u6267\u884C\uFF09` });
    }
    const title = meta.title;
    const targetModelId = meta.modelId ?? ctx.defaultModelId;
    const turnSeq = meta.session.list().filter((e) => e.type === "user/message" && !e.data.injected).length + 1;
    ctx.userMessageCallbacks.forEach((cb) => cb(sid, content, turnSeq));
    void (async () => {
      try {
        const result = await runInSession(sid, content, void 0, targetModelId, origin);
        onDone(sid, title, result);
      } catch (err) {
        onDone(sid, title, void 0, err instanceof Error ? err.message : String(err));
      }
    })();
    return Promise.resolve({ ok: true, message: `\u5DF2\u5411\u4F1A\u8BDD\u300C${title}\u300D(${sid}) \u4E0B\u53D1\u4EFB\u52A1\uFF0C\u5C06\u5F02\u6B65\u6267\u884C` });
  }
  function sendMessageToSession(sid, message, mode) {
    return dispatchToSession(sid, message, mode, (sid2, title, result, error) => notifySupervisorResult(sid2, title, result, error), "supervisor");
  }
  function runSession(sid, message, mode = "insert") {
    return dispatchToSession(sid, message, mode, () => {
    }, "user");
  }
  const notifySupervisorResult = (sid, title, result, error) => {
    const text = error ? `\u26A0\uFE0F \u4F1A\u8BDD\u300C${title}\u300D(${sid}) \u6267\u884C\u5931\u8D25\uFF1A${error}` : `\u2705 \u4F1A\u8BDD\u300C${title}\u300D(${sid}) \u6267\u884C\u5B8C\u6210\uFF1A

${result ?? "\uFF08\u65E0\u6B63\u6587\u8F93\u51FA\uFF09"}`;
    const supMeta = ctx.sessions.get(SUPERVISOR_ID);
    supMeta?.session.append("assistant/message", { content: text });
    if (supMeta) void sessions.persistSession(supMeta);
    ctx.supervisorResultCallbacks.forEach((cb) => cb(sid, title, result, error));
    wakeSupervisorForResult(sid, title, result, error);
  };
  function drainSupervisorQueue(sid) {
    const queued = ctx.supervisorQueue.get(sid);
    if (!queued || queued.length === 0) return;
    const next = queued.shift();
    if (next) void sendMessageToSession(sid, next, "queue");
  }
  const SUPERVISOR_ALLOWED_BASE_TOOL_NAMES = /* @__PURE__ */ new Set([
    "ask_user",
    "remember",
    "recall_memory",
    "plugin_inspect",
    "plugin_define",
    "plugin_run",
    "plugin_stop",
    "plugin_undefine",
    "plugin_test",
    "plugin_install",
    "plugin_uninstall"
  ]);
  const buildSupervisorLoopTools = () => [
    ...ctx.tools.filter((t) => SUPERVISOR_ALLOWED_BASE_TOOL_NAMES.has(t.name)),
    ...createSupervisorTools({
      listSessions: () => [...ctx.sessions.values()].filter((s) => !s.isSupervisor).map((s) => sessions.describeSession(s.id)).filter((s) => s !== null),
      inspectSession: (sid) => sessions.describeSession(sid),
      listModels: () => allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id })),
      sendMessage: (sid, message, mode) => sendMessageToSession(sid, message, mode),
      switchSession: (sid) => sessions.switchSessionInternal(sid),
      setSessionModel: (sid, modelId) => sessions.setSessionModelInternal(sid, modelId),
      setSessionApproval: (sid, policy) => sessions.setSessionApprovalInternal(sid, policy),
      createSession: (title, workdir) => {
        const id = sessions.createSessionInternal(title, workdir);
        const created = ctx.sessions.get(id);
        return { ok: true, message: `\u5DF2\u521B\u5EFA\u4F1A\u8BDD\u300C${created?.title ?? "\u65B0\u4F1A\u8BDD"}\u300D(${id})`, sessionId: id };
      },
      renameSession: (sid, title) => sessions.renameSessionInternal(sid, title),
      deleteSession: (sid) => sessions.deleteSessionInternal(sid),
      setSessionWorkdir: (sid, workdir) => sessions.setSessionWorkdirInternal(sid, workdir),
      askSessionPicker: (question) => ctx.askService.ask(question, {
        kind: "session-picker",
        sessionOptions: [...ctx.sessions.values()].filter((s) => !s.isSupervisor).map((s) => sessions.describeSession(s.id)).filter((s) => s !== null).map((s) => ({
          id: s.id,
          title: s.title,
          busy: s.busy,
          active: s.active,
          modelName: s.modelName,
          workDir: s.workDir,
          contextUsageRatio: s.contextUsageRatio,
          currentRequest: s.currentRequest
        })),
        sessionId: SUPERVISOR_ID
      }).then((answer) => answer === ASK_CANCELLED ? "" : answer),
      askModelPicker: (question) => ctx.askService.ask(question, {
        kind: "model-picker",
        modelOptions: allModels().map((m) => ({ id: m.id, name: m.displayName ?? m.name ?? m.id })),
        sessionId: SUPERVISOR_ID
      }).then((answer) => answer === ASK_CANCELLED ? "" : answer),
      resolveApproval: (requestId, outcome) => {
        const p = ctx.pendingApprovals.get(requestId);
        if (!p) {
          console.log("[supervisor-wake] resolve_approval \u672A\u547D\u4E2D\uFF1A", requestId, "pendingApprovals \u73B0\u5B58=", [...ctx.pendingApprovals.keys()].join(","));
          return { ok: false, message: `\u5BA1\u6279\u8BF7\u6C42\u4E0D\u5B58\u5728\u6216\u5DF2\u5904\u7406: ${requestId}` };
        }
        p.resolve(outcome);
        ctx.pendingApprovals.delete(requestId);
        console.log("[supervisor-wake] resolve_approval \u5DF2\u51B3\u7B56\uFF1A", requestId, outcome);
        ctx.approvalResolvedCallbacks.forEach((cb) => cb(requestId));
        return { ok: true, message: `\u5DF2${outcome === "rejected" ? "\u62D2\u7EDD" : "\u6279\u51C6"}\u5BA1\u6279\u8BF7\u6C42 ${requestId}` };
      },
      answerAsk: (requestId, answer) => {
        const resolved = ctx.askService.respond(requestId, answer);
        if (!resolved) return { ok: false, message: `\u63D0\u95EE\u8BF7\u6C42\u4E0D\u5B58\u5728\u6216\u5DF2\u5904\u7406: ${requestId}` };
        ctx.askResolvedCallbacks.forEach((cb) => cb(requestId));
        return { ok: true, message: `\u5DF2\u4EE3\u7B54\u63D0\u95EE ${requestId}` };
      }
    }).map(wrapTool),
    ...createSupervisorLedgerTools().map(wrapTool)
  ];
  const runSupervisorInternal = async (message, attachments, modelIdOverride) => {
    const supMeta = ctx.sessions.get(SUPERVISOR_ID);
    const supModel = modelIdOverride ?? supMeta?.modelId;
    const targetModelId = supModel ?? ctx.defaultModelId;
    const savedModelId = ctx.currentModelId;
    if (targetModelId) modelProvider.applyModel(targetModelId);
    ctx.approval.setPolicy(sessions.sessionApprovalPolicy(SUPERVISOR_ID));
    try {
      return await runInSession(SUPERVISOR_ID, message, attachments ? { attachments } : void 0);
    } finally {
      if (savedModelId) modelProvider.applyModel(savedModelId);
      ctx.approval.setPolicy(sessions.sessionApprovalPolicy());
    }
  };
  async function drainSupervisorWake() {
    if (ctx.supervisorWaking) {
      console.log("[supervisor-wake] drain \u8DF3\u8FC7\uFF1A\u5DF2\u6709 drain \u5728\u8DD1\uFF08supervisorWaking=true\uFF09\uFF0Cqueue=", ctx.supervisorWakeQueue.length);
      return;
    }
    if (ctx.runningLoops.has(SUPERVISOR_ID)) {
      console.log("[supervisor-wake] drain \u8DF3\u8FC7\uFF1A\u7BA1\u5BB6\u6B63\u5FD9\uFF08runningLoops \u6709 SUPERVISOR_ID\uFF09\uFF0Cqueue=", ctx.supervisorWakeQueue.length);
      return;
    }
    ctx.supervisorWaking = true;
    console.log("[supervisor-wake] drain \u542F\u52A8\uFF0Cqueue=", ctx.supervisorWakeQueue.length);
    try {
      while (ctx.supervisorWakeQueue.length > 0 && !ctx.runningLoops.has(SUPERVISOR_ID)) {
        const prompt = ctx.supervisorWakeQueue.shift();
        console.log("[supervisor-wake] \u53D6\u51FA prompt \u5F00\u59CB\u5904\u7406\uFF0C\u5269\u4F59 queue=", ctx.supervisorWakeQueue.length);
        try {
          await runSupervisorInternal(prompt);
          console.log("[supervisor-wake] prompt \u5904\u7406\u5B8C\u6210");
        } catch (err) {
          console.error("[supervisor-wake] \u7BA1\u5BB6\u51B3\u7B56\u5904\u7406\u5931\u8D25\uFF0C\u7EE7\u7EED\u5904\u7406\u961F\u5217\u4E0B\u4E00\u6761:", err instanceof Error ? err.message : err);
        }
      }
      console.log("[supervisor-wake] while \u9000\u51FA\uFF1Aqueue=", ctx.supervisorWakeQueue.length, "runningLoops.has=", ctx.runningLoops.has(SUPERVISOR_ID));
    } finally {
      ctx.supervisorWaking = false;
      console.log("[supervisor-wake] drain \u7ED3\u675F\uFF0CsupervisorWaking=false");
    }
  }
  function wakeSupervisorForApproval(req) {
    const sid = req.sessionId ?? "";
    const title = sid ? ctx.sessions.get(sid)?.title ?? sid : sid;
    const prompt = `\u3010\u5BA1\u6279\u8BF7\u6C42\u3011\u4F1A\u8BDD\u300C${title}\u300D\u8BF7\u6C42\u6267\u884C\u5DE5\u5177 ${req.toolName}\uFF08\u98CE\u9669\u7B49\u7EA7 ${req.riskLevel}\uFF09\u3002
\u53C2\u6570\uFF1A${JSON.stringify(req.args)}

\u8BF7\u5224\u65AD\u662F\u5426\u6279\u51C6\u8BE5\u64CD\u4F5C\uFF0C\u5E76\u8C03\u7528 resolve_approval \u5DE5\u5177\u51B3\u7B56\uFF1ArequestId="${req.id}"\uFF0Coutcome \u53D6 allowed-once\uFF08\u6279\u51C6\uFF09\u6216 rejected\uFF08\u62D2\u7EDD\uFF09\u3002\u82E5\u98CE\u9669\u8FC7\u9AD8\u6216\u53C2\u6570\u53EF\u7591\u8BF7\u62D2\u7EDD\uFF1B\u4E0D\u8981\u66FF\u8BE5\u4F1A\u8BDD\u6267\u884C\u5177\u4F53\u64CD\u4F5C\u3002`;
    ctx.supervisorWakeQueue.push(prompt);
    const supMeta = ctx.sessions.get(SUPERVISOR_ID);
    const turnSeq = supMeta ? supMeta.session.list().filter((e) => e.type === "user/message" && !e.data.injected).length + 1 : 1;
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq));
    console.log("[supervisor-wake] \u5BA1\u6279\u8BF7\u6C42\u5165\u961F\uFF1A", req.id, req.toolName, "queue=", ctx.supervisorWakeQueue.length, "supervisorWaking=", ctx.supervisorWaking, "runningLoops.has=", ctx.runningLoops.has(SUPERVISOR_ID));
    void drainSupervisorWake();
  }
  function wakeSupervisorForAsk(req) {
    const sid = req.sessionId ?? "";
    const title = sid ? ctx.sessions.get(sid)?.title ?? sid : sid;
    const optionsText = req.options && req.options.length > 0 ? `
\u53EF\u9009\u9879\uFF1A${req.options.map((o) => `\u300C${o}\u300D`).join(" / ")}` : "";
    const prompt = `\u3010\u63D0\u95EE\u8BF7\u6C42\u3011\u4F1A\u8BDD\u300C${title}\u300D\u5411\u4F60\u63D0\u95EE\uFF1A${req.question}${optionsText}

\u8BF7\u4EE5\u7528\u6237\u89C6\u89D2\u5224\u65AD\u5E76\u56DE\u7B54\u8BE5\u95EE\u9898\uFF0C\u8C03\u7528 answer_ask \u5DE5\u5177\u4EE3\u7B54\uFF1ArequestId="${req.id}"\uFF0Canswer \u586B\u4F60\u7684\u56DE\u7B54\u3002\u6709\u53EF\u9009\u9879\u65F6\u4ECE\u53EF\u9009\u9879\u91CC\u9009\u4E00\u4E2A\u6700\u5408\u9002\u7684\u4F5C\u4E3A answer\uFF1B\u65E0\u9009\u9879\u65F6\u7ED9\u51FA\u7B80\u77ED\u660E\u786E\u7684\u6587\u5B57\u56DE\u7B54\u3002\u4E0D\u8981\u66FF\u8BE5\u4F1A\u8BDD\u6267\u884C\u5177\u4F53\u64CD\u4F5C\u3002`;
    ctx.supervisorWakeQueue.push(prompt);
    const supMeta = ctx.sessions.get(SUPERVISOR_ID);
    const turnSeq = supMeta ? supMeta.session.list().filter((e) => e.type === "user/message" && !e.data.injected).length + 1 : 1;
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq));
    console.log("[supervisor-wake] \u63D0\u95EE\u8BF7\u6C42\u5165\u961F\uFF1A", req.id, "queue=", ctx.supervisorWakeQueue.length, "supervisorWaking=", ctx.supervisorWaking, "runningLoops.has=", ctx.runningLoops.has(SUPERVISOR_ID));
    void drainSupervisorWake();
  }
  function wakeSupervisorForResult(sid, title, result, error) {
    const body = error ? `\u6267\u884C\u5931\u8D25\uFF1A${error}` : result ?? "\uFF08\u65E0\u6B63\u6587\u8F93\u51FA\uFF09";
    const prompt = `\u3010\u4EFB\u52A1\u56DE\u4F20\u3011\u4F1A\u8BDD\u300C${title}\u300D(${sid}) \u7684\u4EFB\u52A1\u6267\u884C${error ? "\u5931\u8D25" : "\u5B8C\u6210"}\u3002
\u7ED3\u679C\uFF1A${body}

\u8BF7\u6309\u3010\u4EFB\u52A1\u7F16\u6392\u3011\u6D41\u7A0B\u63A5\u529B\u5904\u7406\uFF1A
1. \u82E5\u8BE5\u4F1A\u8BDD\u5728\u53F0\u8D26\u91CC\u6709\u4EFB\u52A1\u6E05\u5355\uFF08state.json \u7684 tasks\uFF09\uFF0Cread_ledger \u8BFB\u53D6\u540E\uFF0C\u628A\u521A\u5B8C\u6210\u7684\u4EFB\u52A1 status \u6539\u4E3A done\uFF08\u5931\u8D25\u6539 blocked\uFF09\u5E76\u56DE\u586B result\uFF0C\u540C\u6B65 _index.json\u3002
2. \u82E5\u6E05\u5355\u91CC\u8FD8\u6709 status=todo \u7684\u540E\u7EED\u4EFB\u52A1\uFF0C\u7528 send_message \u628A\u4E0B\u4E00\u4E2A\u4EFB\u52A1\u4E0B\u53D1\u7ED9\u8BE5\u4F1A\u8BDD\uFF08\u7EE7\u7EED\u63A8\u8FDB\u6D41\u6C34\u7EBF\uFF09\u3002
3. \u82E5\u6E05\u5355\u5DF2\u5168\u90E8 done\u3001\u6216\u8BE5\u4F1A\u8BDD\u672C\u5C31\u6CA1\u6709\u4EFB\u52A1\u6E05\u5355\uFF08\u53EA\u662F\u7B80\u5355\u8F6C\u53D1\uFF09\uFF0C\u66F4\u65B0\u5FC5\u8981\u72B6\u6001\u540E\u7ED3\u675F\u672C\u8F6E\uFF0C\u4E0D\u8981\u91CD\u590D\u4E0B\u53D1\u3001\u4E0D\u8981\u7A7A\u8F6C\u3002`;
    ctx.supervisorWakeQueue.push(prompt);
    const supMeta = ctx.sessions.get(SUPERVISOR_ID);
    const turnSeq = supMeta ? supMeta.session.list().filter((e) => e.type === "user/message" && !e.data.injected).length + 1 : 1;
    ctx.userMessageCallbacks.forEach((cb) => cb(SUPERVISOR_ID, prompt, turnSeq));
    console.log("[supervisor-wake] \u4EFB\u52A1\u56DE\u4F20\u5165\u961F\uFF1A", sid, "queue=", ctx.supervisorWakeQueue.length, "supervisorWaking=", ctx.supervisorWaking, "runningLoops.has=", ctx.runningLoops.has(SUPERVISOR_ID));
    void drainSupervisorWake();
  }
  const resend = async (sessionId, userMessageIndex, newContent) => {
    const meta = ctx.sessions.get(sessionId);
    if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sessionId}`);
    const events = meta.session.list();
    const effModelId = meta.modelId ?? ctx.defaultModelId;
    let userCount = 0;
    let targetIdx = -1;
    let originalContent = "";
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e?.type === "user/message") {
        const d = e.data;
        if (d.injected) continue;
        if (userCount === userMessageIndex) {
          targetIdx = i;
          originalContent = d.content;
          break;
        }
        userCount++;
      }
    }
    if (targetIdx < 0) throw new Error(`\u7528\u6237\u6D88\u606F\u4E0D\u5B58\u5728: #${userMessageIndex}`);
    const content = newContent !== void 0 ? newContent : originalContent;
    meta.session.truncate(targetIdx);
    if (sessionId === SUPERVISOR_ID) {
      return runSupervisorInternal(content, void 0, effModelId);
    }
    return runInSession(sessionId, content, void 0, effModelId);
  };
  const resume = async (sessionId) => {
    const sid = sessionId;
    const meta = ctx.sessions.get(sid);
    if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}`);
    const events = meta.session.list();
    let lastUserIdx = -1;
    let lastUserContent = "";
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "user/message") {
        const d = events[i].data;
        if (d.injected) continue;
        lastUserIdx = i;
        lastUserContent = d.content;
        break;
      }
    }
    if (lastUserIdx < 0) throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6D88\u606F");
    ctx.stoppedSessions.delete(sid);
    sessions.touchSession(sid);
    const isSupervisorRun = sid === SUPERVISOR_ID;
    const effModelId = meta.modelId ?? ctx.defaultModelId;
    const effModel = modelProvider.resolveProvider(effModelId);
    const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId));
    const loop = new AgentLoop(
      effModel,
      isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools,
      meta.session,
      ctx.approval,
      sid,
      tokenStats.currentContextBudget(effModelId),
      visionCapable,
      tokenStats.currentApiKey(effModelId),
      modelProvider.resolveCompactModel()
    );
    ctx.runningLoops.set(sid, loop);
    ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "start"));
    let suspended = false;
    try {
      return await sessionContext.run(
        sid,
        () => loop.resumeRun(
          isSupervisorRun ? prompts.buildSupervisorSystemPrompt(lastUserContent) : prompts.buildSystemPrompt(meta.workDir, prompts.buildMemoryContext(lastUserContent, meta.id)),
          (text) => {
            if (ctx.stoppedSessions.has(sid)) throw new Error("__stopped__");
            ctx.deltaCallbacks.forEach((cb) => cb(sid, text));
          },
          (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text))
        )
      );
    } catch (err) {
      if (err instanceof Error && err.message === "__stopped__") {
        return "\uFF08\u5DF2\u4E2D\u65AD\uFF0C\u5386\u53F2\u5DF2\u4FDD\u7559\uFF0C\u53EF\u70B9\u51FB\u300C\u7EE7\u7EED\u6267\u884C\u300D\u7EED\u8DD1\uFF09";
      }
      if (err instanceof Error && err.message.startsWith("__retry_exhausted__")) {
        suspended = true;
      }
      throw err;
    } finally {
      if (!suspended) {
        ctx.runningLoops.delete(sid);
        ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "end"));
      }
      meta.lastActiveAt = Date.now();
      await sessions.persistSession(meta);
      tokenStats.emitTokenStats();
      drainSupervisorQueue(sid);
    }
  };
  const retrySession = async (sessionId) => {
    const sid = sessionId ?? ctx.currentSessionId;
    const meta = ctx.sessions.get(sid);
    if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}`);
    const loop = ctx.runningLoops.get(sid);
    if (loop) {
      try {
        const result = await sessionContext.run(sid, () => loop.retry());
        meta.lastActiveAt = Date.now();
        await sessions.persistSession(meta);
        tokenStats.emitTokenStats();
        return result;
      } finally {
        if (!loop.isSuspended()) ctx.runningLoops.delete(sid);
      }
    }
    const snapshot = sessions.readRetrySnapshot(meta);
    if (snapshot) {
      const isSupervisorRun = sid === SUPERVISOR_ID;
      const effModelId2 = meta.modelId ?? ctx.defaultModelId;
      const effModel = modelProvider.resolveProvider(effModelId2);
      const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId2));
      const restoredLoop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, meta.session, ctx.approval, sid, tokenStats.currentContextBudget(effModelId2), visionCapable, tokenStats.currentApiKey(effModelId2), modelProvider.resolveCompactModel());
      restoredLoop.restoreSuspended(snapshot);
      ctx.runningLoops.set(sid, restoredLoop);
      try {
        const result = await sessionContext.run(
          sid,
          () => restoredLoop.retry(
            (text) => {
              if (ctx.stoppedSessions.has(sid)) throw new Error("__stopped__");
              ctx.deltaCallbacks.forEach((cb) => cb(sid, text));
            },
            (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text))
          )
        );
        meta.lastActiveAt = Date.now();
        await sessions.persistSession(meta);
        tokenStats.emitTokenStats();
        return result;
      } finally {
        if (!restoredLoop.isSuspended()) ctx.runningLoops.delete(sid);
      }
    }
    const events = meta.session.list();
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "user/message") {
        const d = events[i].data;
        if (d.injected) continue;
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6D88\u606F");
    const content = events[lastUserIdx].data.content;
    const effModelId = meta.modelId ?? ctx.defaultModelId;
    meta.session.truncate(lastUserIdx);
    if (sid === SUPERVISOR_ID) {
      return runSupervisorInternal(content, void 0, effModelId);
    }
    return runInSession(sid, content, void 0, effModelId);
  };
  const abandonSession = async (sessionId) => {
    const sid = sessionId ?? ctx.currentSessionId;
    ctx.runningLoops.delete(sid);
    const meta = ctx.sessions.get(sid);
    if (meta) {
      meta.session.removeLast("retry/snapshot");
      await sessions.persistSession(meta);
    }
  };
  const hasRetrySnapshot = (sessionId) => {
    const meta = ctx.sessions.get(sessionId);
    if (!meta) return null;
    const snap = sessions.readRetrySnapshot(meta);
    return snap ? { reason: snap.reason } : null;
  };
  const injectMessage = (sessionId, message) => {
    const loop = ctx.runningLoops.get(sessionId);
    if (loop) {
      loop.injectUserMessage(message);
      return true;
    }
    return false;
  };
  const hasIncompleteTurn = (sessionId) => {
    if (ctx.runningLoops.has(sessionId)) return false;
    const meta = ctx.sessions.get(sessionId);
    if (!meta) return false;
    const events = meta.session.list();
    let lastUserIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "user/message") {
        const d = events[i].data;
        if (d.injected) continue;
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return false;
    for (let i = lastUserIdx + 1; i < events.length; i++) {
      const t = events[i]?.type;
      if (t === "assistant/message" || t === "turn/end") return false;
    }
    return true;
  };
  return {
    runInSession,
    dispatchToSession,
    sendMessageToSession,
    runSession,
    notifySupervisorResult,
    drainSupervisorQueue,
    buildSupervisorLoopTools,
    runSupervisorInternal,
    drainSupervisorWake,
    wakeSupervisorForApproval,
    wakeSupervisorForAsk,
    wakeSupervisorForResult,
    resend,
    resume,
    retrySession,
    abandonSession,
    hasRetrySnapshot,
    injectMessage,
    hasIncompleteTurn
  };
}

// ../runtime/src/voice.ts
import { execFile as execFileCallback2, spawn as spawn2 } from "child_process";
import { promisify as promisify5 } from "util";
var execFileAsync = promisify5(execFileCallback2);
var activeSay = null;
function spawnSay(text, voice) {
  const isWin2 = process.platform === "win32";
  const file = isWin2 ? "powershell.exe" : "/usr/bin/say";
  const args = isWin2 ? [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${String(text).replace(/'/g, "''")}')`
  ] : voice ? ["-v", voice, text] : [text];
  return new Promise((resolve4) => {
    const child = spawn2(file, args, { stdio: "ignore" });
    activeSay = child;
    child.on("error", () => {
      if (activeSay === child) activeSay = null;
      resolve4();
    });
    child.on("exit", () => {
      if (activeSay === child) activeSay = null;
      resolve4();
    });
  });
}
function createSystemVoiceService() {
  return {
    transcribe: async () => {
      return "";
    },
    synthesize: async (text) => {
      const isWin2 = process.platform === "win32";
      let voice = "";
      if (!isWin2) {
        try {
          const { stdout: list } = await execFileAsync("/usr/bin/say", ["-v", "?"], { timeout: 5e3 });
          const lines = list.split("\n").map((l) => l.trim());
          const preferred = ["Tingting", "Yue", "Sin-ji"].find(
            (c) => lines.some((l) => l.includes("zh_CN") && (l.startsWith(`${c} `) || l.startsWith(`${c}	`)))
          );
          if (preferred) {
            voice = preferred;
          } else {
            const zh = lines.find((l) => l.includes("zh_CN"));
            voice = zh?.match(/^\S+/)?.[0] ?? "";
          }
        } catch {
        }
      }
      try {
        if (activeSay) {
          try {
            activeSay.kill("SIGTERM");
          } catch {
          }
          activeSay = null;
        }
        await spawnSay(text, voice);
      } catch (err) {
        console.error("[voice] say \u64AD\u62A5\u5931\u8D25:", err instanceof Error ? err.message : String(err));
      }
      return new TextEncoder().encode(text).buffer;
    }
  };
}
async function gatewayAsrTranscribe(pcmBase64, apiKey, baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, "")}/audio/asr`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3e4);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({ audioData: pcmBase64, language: "zh", model: "stepaudio-2.5-asr" }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const text = await res.text();
    let result = "";
    let matched = false;
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s || s === "data: [DONE]") continue;
      if (s.startsWith("data: ")) {
        try {
          const obj = JSON.parse(s.slice(6));
          if (obj.type === "transcript.text.delta" && obj.delta) {
            result += obj.delta;
            matched = true;
          }
        } catch {
        }
      }
    }
    if (matched) return result.trim();
    try {
      const obj = JSON.parse(text);
      if (typeof obj.text === "string") return obj.text.trim();
      if (typeof obj.result === "string") return obj.result.trim();
    } catch {
    }
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// ../runtime/src/bootstrap.ts
async function bootstrap(options = {}) {
  await ensureDeviceInfo();
  const ctx = {};
  ctx.kernel = new Kernel();
  ctx.gatewayApiKey = "";
  ctx.gatewayBaseUrl = "";
  ctx.memberToken = "";
  ctx.gatewayModels = [];
  ctx.customModels = [];
  ctx.deepseekBridgeModel = null;
  ctx.currentModelId = "";
  ctx.defaultModelId = "";
  ctx.sessionsDir = join18(homedir11(), ".shanhai", "sessions");
  ctx.tracesDir = join18(homedir11(), ".shanhai", "traces");
  ctx.httpTrace = createHttpTraceStore(join18(homedir11(), ".shanhai", "traces"));
  ctx.sessions = /* @__PURE__ */ new Map();
  ctx.currentSessionId = null;
  ctx.sessionWriteChains = /* @__PURE__ */ new Map();
  ctx.runningLoops = /* @__PURE__ */ new Map();
  ctx.sessionOrigin = /* @__PURE__ */ new Map();
  ctx.toolTraceCallbacks = /* @__PURE__ */ new Set();
  ctx.approvalCallbacks = /* @__PURE__ */ new Set();
  ctx.pendingApprovals = /* @__PURE__ */ new Map();
  ctx.approvalResolvedCallbacks = /* @__PURE__ */ new Set();
  ctx.askResolvedCallbacks = /* @__PURE__ */ new Set();
  ctx.computerUse = createPlatformComputerUseService();
  ctx.browserUse = options.browserUse ?? createMockBrowserUseService();
  ctx.terminalUse = options.terminalUse ?? createMockTerminalService();
  ctx.userTerminalSessionMap = /* @__PURE__ */ new Map();
  ctx.userTerminalOutputCallbacks = /* @__PURE__ */ new Set();
  ctx.voice = createSystemVoiceService();
  ctx.memory = new MemoryStore();
  ctx.currentSettings = {
    browser: { showOnCreate: DEFAULT_SETTINGS.browser.showOnCreate, enableWebBridge: DEFAULT_SETTINGS.browser.enableWebBridge },
    messageSubmit: { mode: DEFAULT_SETTINGS.messageSubmit.mode },
    debug: { traceLlm: DEFAULT_SETTINGS.debug.traceLlm },
    voice: { enabled: DEFAULT_SETTINGS.voice.enabled },
    supervisorApproval: { enabled: DEFAULT_SETTINGS.supervisorApproval.enabled },
    supervisorAsk: { enabled: DEFAULT_SETTINGS.supervisorAsk.enabled },
    compaction: { modelId: DEFAULT_SETTINGS.compaction.modelId }
  };
  ctx.askService = new AskService();
  ctx.memoryFile = join18(homedir11(), ".shanhai", "memory.json");
  ctx.imageDescCache = /* @__PURE__ */ new Map();
  ctx.builtinSkillCatalog = "";
  ctx.snapshotDir = join18(homedir11(), ".shanhai", "snapshots");
  ctx.snapshotStore = new FileSnapshotStore(join18(homedir11(), ".shanhai", "snapshots"));
  ctx.tools = [];
  ctx.supervisorLoopTools = [];
  ctx.clientRunCallbacks = /* @__PURE__ */ new Set();
  ctx.pendingClientRuns = /* @__PURE__ */ new Map();
  ctx.clientCodeCallbacks = /* @__PURE__ */ new Set();
  ctx.clientRemoveCallbacks = /* @__PURE__ */ new Set();
  ctx.pluginStore = new PluginStore(join18(homedir11(), ".shanhai", "plugins"));
  ctx.skillService = new SkillService();
  ctx.mcpService = new McpService();
  ctx.tokenStats = /* @__PURE__ */ new Map();
  ctx.tokenCallbacks = /* @__PURE__ */ new Set();
  ctx.deltaCallbacks = /* @__PURE__ */ new Set();
  ctx.reasoningCallbacks = /* @__PURE__ */ new Set();
  ctx.modelProviders = /* @__PURE__ */ new Map();
  ctx.credentials = new FileCredentialStore();
  ctx.authService = new AuthService({ baseUrl: "https://agent.bjctykj.com" });
  ctx.loggedIn = false;
  ctx.username = null;
  ctx.selectedTier = "flagship";
  ctx.modelsChangedCallbacks = /* @__PURE__ */ new Set();
  ctx.authExpiredCallbacks = /* @__PURE__ */ new Set();
  ctx.stoppedSessions = /* @__PURE__ */ new Set();
  ctx.supervisorQueue = /* @__PURE__ */ new Map();
  ctx.supervisorWakeQueue = [];
  ctx.supervisorWaking = false;
  ctx.sessionActivityCallbacks = /* @__PURE__ */ new Set();
  ctx.currentSessionChangedCallbacks = /* @__PURE__ */ new Set();
  ctx.supervisorResultCallbacks = /* @__PURE__ */ new Set();
  ctx.userMessageCallbacks = /* @__PURE__ */ new Set();
  const allModels = () => [...ctx.gatewayModels, ...ctx.customModels, ...ctx.deepseekBridgeModel ? [ctx.deepseekBridgeModel] : []];
  const sessionsModule = createSessionsModule(ctx, {
    getTokenStats: () => tokenStatsModule,
    getModelProvider: () => modelProviderModule,
    getDeepSeekBridge: () => deepSeekBridgeModule,
    allModels
  });
  try {
    await fs19.mkdir(ctx.sessionsDir, { recursive: true });
    const entries = await fs19.readdir(ctx.sessionsDir, { withFileTypes: true });
    const defaultWorkDir = join18(homedir11(), "shanhai", "workspace");
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const dir = join18(ctx.sessionsDir, entry.name);
          const metaFile = await readSessionMetaFile(dir);
          if (!metaFile) continue;
          const meta = {
            id: metaFile.id,
            title: metaFile.title,
            session: new Session(),
            workDir: metaFile.workDir || defaultWorkDir,
            lastActiveAt: typeof metaFile.lastActiveAt === "number" ? metaFile.lastActiveAt : 0,
            // 管家超级会话按固定 id 识别（持久化文件不含 isSupervisor，id 即身份）
            isSupervisor: metaFile.id === SUPERVISOR_ID,
            modelId: metaFile.modelId,
            approvalPolicy: metaFile.approvalPolicy
          };
          await rotateSessionEventsFile(dir);
          const events = await loadSessionEventsFile(dir);
          meta.session.restore(events);
          ctx.sessions.set(meta.id, meta);
        } catch {
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const sessionId = entry.name.slice(0, -".json".length);
        try {
          const legacy = await migrateLegacySessionFile(ctx.sessionsDir, sessionId, defaultWorkDir);
          if (legacy) {
            const meta = {
              id: sessionId,
              title: legacy.title,
              session: new Session(),
              workDir: legacy.workDir,
              lastActiveAt: legacy.lastActiveAt,
              isSupervisor: sessionId === SUPERVISOR_ID,
              modelId: legacy.modelId,
              approvalPolicy: legacy.approvalPolicy
            };
            meta.session.restore(legacy.events);
            ctx.sessions.set(meta.id, meta);
          }
        } catch {
        }
      }
    }
  } catch {
  }
  sessionsModule.ensureSupervisorSession();
  const userSessions = [...ctx.sessions.values()].filter((s) => !s.isSupervisor);
  if (userSessions.length === 0) {
    sessionsModule.newSession("\u65B0\u4F1A\u8BDD");
  } else {
    const lastActiveId = await readLastActiveSessionId();
    const lastMeta = lastActiveId ? ctx.sessions.get(lastActiveId) : void 0;
    const firstUser = userSessions[0];
    ctx.currentSessionId = lastMeta && !lastMeta.isSupervisor ? lastActiveId : firstUser.id;
  }
  ctx.approval = new ApprovalService(async (req) => {
    ctx.approvalCallbacks.forEach((cb) => cb({ id: req.id, sessionId: req.sessionId, toolName: req.toolName, args: req.args, riskLevel: req.riskLevel }));
    const origin = req.sessionId ? ctx.sessionOrigin.get(req.sessionId) ?? "user" : "user";
    console.log("[supervisor-wake] \u5BA1\u6279\u8BF7\u6C42\u4EA7\u751F\uFF1A", req.id, req.toolName, "sessionId=", req.sessionId, "origin=", origin, "\u5F00\u5173=", ctx.currentSettings.supervisorApproval.enabled);
    const promise = new Promise((resolve4) => {
      ctx.pendingApprovals.set(req.id, { resolve: resolve4, sessionId: req.sessionId });
    });
    if (origin === "supervisor" && ctx.currentSettings.supervisorApproval.enabled) {
      void executionModule.wakeSupervisorForApproval(req);
    } else {
      console.log("[supervisor-wake] \u5BA1\u6279\u8BF7\u6C42\u4E0D\u5524\u9192\u7BA1\u5BB6\uFF08origin!=supervisor \u6216\u5F00\u5173\u5173\u95ED\uFF09");
    }
    return promise;
  });
  ctx.terminalUse.onData((terminalId, data) => {
    const sid = ctx.userTerminalSessionMap.get(terminalId);
    if (!sid) return;
    for (const cb of ctx.userTerminalOutputCallbacks) {
      try {
        cb(sid, terminalId, data);
      } catch {
      }
    }
  });
  ctx.currentSettings = await readSettings();
  ctx.browserUse.setShowOnCreate?.(ctx.currentSettings.browser.showOnCreate);
  const deepSeekBridgeModule = createDeepSeekBridgeModule(ctx, () => sessionContext.getStore() ?? ctx.currentSessionId ?? "");
  deepSeekBridgeModule.ensureDefaultBrowserWindow(ctx.currentSessionId ?? "");
  if (ctx.currentSettings.browser.enableWebBridge) deepSeekBridgeModule.registerDeepSeekBridgeModel();
  try {
    const raw = await fs19.readFile(ctx.memoryFile, "utf8");
    const entries = JSON.parse(raw);
    for (const e of entries) {
      if (e && typeof e.key === "string") ctx.memory.save(e.scope, e.key, e.value, { source: e.source, confidence: e.confidence, sessionId: e.sessionId });
    }
  } catch {
  }
  const persistMemory = async () => {
    try {
      await fs19.writeFile(ctx.memoryFile, JSON.stringify(ctx.memory.list(), null, 2), { mode: 384 });
    } catch {
    }
  };
  const tokenStatsModule = createTokenStatsModule(ctx, allModels, () => sessionContext.getStore() ?? ctx.currentSessionId ?? "");
  const promptsModule = createPromptsModule(ctx, {
    getCurrentSid: () => sessionContext.getStore() ?? ctx.currentSessionId ?? "",
    onUsage: tokenStatsModule.onUsage,
    onHttpTrace: tokenStatsModule.onHttpTrace
  });
  try {
    await fs19.rm(ctx.snapshotDir, { recursive: true, force: true });
  } catch {
  }
  const resolveWorkPath = (p) => isAbsolute3(p) ? p : join18(promptsModule.getSessionCwd(), p);
  const snapshotFn = async (path3) => {
    try {
      return { snapshotId: await ctx.snapshotStore.snapshot(path3) };
    } catch {
      return void 0;
    }
  };
  const wrapTool = (t) => ({
    ...t,
    execute: async (args) => {
      const sid = sessionContext.getStore() ?? ctx.currentSessionId ?? "";
      const callId = `${t.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const startTs = Date.now();
      const reasoning = toolReasoningContext.getStore();
      let effectiveArgs = args;
      if (t.name === "skill_run" && args.skillId === "browser-use") {
        const params = args.params && typeof args.params === "object" ? args.params : {};
        const raw = typeof params.appId === "string" ? params.appId : "";
        const appId = raw && (raw === sid || raw.startsWith(`${sid}:`)) ? raw : `${sid}:${raw || "default"}`;
        effectiveArgs = { ...args, params: { ...params, appId } };
      }
      if (t.name === "skill_run" && args.skillId === "terminal") {
        const params = args.params && typeof args.params === "object" ? args.params : {};
        const raw = typeof params.terminalId === "string" ? params.terminalId : "";
        const terminalId = raw && (raw === sid || raw.startsWith(`${sid}:`)) ? raw : `${sid}:${raw || "default"}`;
        effectiveArgs = { ...args, params: { ...params, terminalId } };
      }
      ctx.toolTraceCallbacks.forEach(
        (cb) => cb({ kind: "tool-call", sessionId: sid, callId, name: t.name, args, approvalRequired: t.approvalRequired, approved: false, reasoning, startTs })
      );
      try {
        const result = await t.execute(effectiveArgs);
        ctx.toolTraceCallbacks.forEach((cb) => cb({ kind: "tool-result", sessionId: sid, callId, name: t.name, args, result, durationMs: Date.now() - startTs }));
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.toolTraceCallbacks.forEach((cb) => cb({ kind: "tool-result", sessionId: sid, callId, name: t.name, args, error, durationMs: Date.now() - startTs }));
        throw err;
      }
    }
  });
  ctx.selfmod = new SelfModifyRuntime({
    listServices: () => ["session", "approval", "agent", "memory", "voice", "computerUse", "browserUse", "model", "credentials"],
    listTools: (sessionId) => (sessionId === SUPERVISOR_ID ? ctx.supervisorLoopTools : ctx.tools).map((t) => t.name),
    listSlots: () => [...CORE_SLOTS],
    registerTool: (rawTool) => {
      const wrapped = wrapTool(rawTool);
      ctx.tools.push(wrapped);
      return () => {
        const idx = ctx.tools.indexOf(wrapped);
        if (idx >= 0) ctx.tools.splice(idx, 1);
      };
    },
    onEvent: (name, listener) => ctx.kernel.ctx.on(name, listener),
    requestClientRun: (pkg, sessionId) => new Promise((resolve4) => {
      const requestId = `client-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      ctx.pendingClientRuns.set(requestId, { resolve: resolve4, sessionId });
      ctx.clientRunCallbacks.forEach((cb) => cb({ requestId, sessionId, pkgId: pkg.id, name: pkg.name, purpose: pkg.purpose }));
    }),
    deliverClient: async (pkg) => {
      ctx.clientCodeCallbacks.forEach((cb) => cb({ pkgId: pkg.id, name: pkg.name, code: pkg.client ?? "" }));
    },
    removeClient: async (pkgId) => {
      ctx.clientRemoveCallbacks.forEach((cb) => cb(pkgId));
    }
  }, ctx.pluginStore);
  const utilityTools = createUtilityTools({
    analyzeImage: promptsModule.analyzeImageWithVision,
    rollbackFile: async (path3, snapshotId) => {
      const resolved = resolveWorkPath(path3);
      await ctx.snapshotStore.rollback(resolved, snapshotId);
      await ctx.snapshotStore.discard(resolved, snapshotId);
      return { ok: true, path: resolved, rolledBack: true };
    },
    memory: {
      save: (scope, key, value) => {
        const entry = ctx.memory.save(scope, key, value, { sessionId: sessionContext.getStore() ?? ctx.currentSessionId ?? "" });
        void persistMemory();
        return entry;
      },
      recall: (scope, keyword) => ctx.memory.recall(scope, keyword, sessionContext.getStore() ?? ctx.currentSessionId ?? ""),
      list: () => ctx.memory.listBySession(sessionContext.getStore() ?? ctx.currentSessionId ?? "")
    }
  });
  const askTools = createAskTools(ctx.askService, () => sessionContext.getStore() ?? ctx.currentSessionId ?? "");
  const uploadImage = async (imageBase64, mimeType) => {
    if (!ctx.memberToken) return null;
    return uploadImageToCloud({ imageBase64, token: ctx.memberToken, mimeType });
  };
  ctx.skillService.registerExecutable(createComputerUseSkill(ctx.computerUse, uploadImage));
  ctx.skillService.registerExecutable(createBrowserUseSkill(ctx.browserUse, uploadImage));
  ctx.skillService.registerExecutable(createTerminalSkill(ctx.terminalUse));
  const skillTools = createSkillTools(ctx.skillService);
  ctx.builtinSkillCatalog = await ctx.skillService.builtinExecutableCatalog();
  const mcpTools = createMcpTools(ctx.mcpService);
  const baseTools = [
    ...createAtomicTools(promptsModule.getSessionCwd, snapshotFn),
    ...utilityTools,
    ...askTools,
    ...skillTools,
    ...mcpTools,
    ...ctx.selfmod.createTools(() => sessionContext.getStore() ?? ctx.currentSessionId ?? "")
  ];
  ctx.tools.push(...baseTools.map(wrapTool));
  ctx.model = await createGatewayModel(tokenStatsModule.onUsage, tokenStatsModule.onHttpTrace);
  ctx.sessionRef = ctx.sessions.get(ctx.currentSessionId).session;
  const modelProviderModule = createModelProviderModule(ctx, {
    allModels,
    tokenStats: tokenStatsModule,
    deepSeekBridge: deepSeekBridgeModule,
    currentWorkDir: sessionsModule.currentWorkDir
  });
  if (ctx.currentModelId) ctx.modelProviders.set(ctx.currentModelId, ctx.model);
  tokenStatsModule.refreshContextLength();
  await modelProviderModule.restoreCredentials();
  if (ctx.loggedIn) void modelProviderModule.refreshGatewayModels();
  const executionModule = createExecutionModule(ctx, {
    sessions: sessionsModule,
    tokenStats: tokenStatsModule,
    prompts: promptsModule,
    modelProvider: modelProviderModule,
    allModels,
    wrapTool
  });
  ctx.supervisorLoopTools = executionModule.buildSupervisorLoopTools();
  await ctx.kernel.plugin({
    name: "session-service",
    provide: ["session"],
    apply: (kc) => kc.provide("session", ctx.sessionRef)
  });
  await ctx.kernel.plugin({
    name: "approval-service",
    provide: ["approval"],
    apply: (kc) => kc.provide("approval", ctx.approval)
  });
  await ctx.kernel.plugin({
    name: "agent-service",
    inject: ["session", "approval"],
    provide: ["agent"],
    apply: (kc) => kc.provide("agent", () => new AgentLoop(ctx.model, ctx.tools, ctx.sessionRef, ctx.approval))
  });
  ctx.askService.onRequest((req) => {
    const origin = req.sessionId ? ctx.sessionOrigin.get(req.sessionId) ?? "user" : "user";
    if (origin === "supervisor" && ctx.currentSettings.supervisorAsk.enabled) {
      void executionModule.wakeSupervisorForAsk(req);
    }
  });
  return {
    kernel: ctx.kernel,
    session: ctx.sessionRef,
    tools: ctx.tools,
    model: ctx.model,
    memory: ctx.memory,
    credentials: ctx.credentials,
    voice: ctx.voice,
    computerUse: ctx.computerUse,
    browserUse: ctx.browserUse,
    loggedIn: ctx.loggedIn,
    username: ctx.username,
    getMemberToken() {
      return ctx.memberToken;
    },
    getDeviceInfo() {
      return getDeviceInfoState() ?? {
        deviceId: "",
        deviceName: osHostname2(),
        hostname: osHostname2(),
        os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux"
      };
    },
    async setDeviceName(name) {
      const trimmed = name.trim();
      if (!trimmed) return;
      await withConfigFile((cfg) => {
        cfg.deviceName = trimmed;
      });
      setDeviceInfoName(trimmed);
    },
    async login(u, p) {
      return modelProviderModule.login(u, p);
    },
    async logout() {
      return modelProviderModule.logout();
    },
    async listModels() {
      return modelProviderModule.listModels();
    },
    async refreshModels() {
      return modelProviderModule.refreshModels();
    },
    onModelsChanged(cb) {
      ctx.modelsChangedCallbacks.add(cb);
      return () => {
        ctx.modelsChangedCallbacks.delete(cb);
      };
    },
    onAuthExpired(cb) {
      ctx.authExpiredCallbacks.add(cb);
      return () => {
        ctx.authExpiredCallbacks.delete(cb);
      };
    },
    async addCustomModel(input) {
      return modelProviderModule.addCustomModel(input);
    },
    async updateCustomModel(id, input) {
      return modelProviderModule.updateCustomModel(id, input);
    },
    async removeCustomModel(id) {
      return modelProviderModule.removeCustomModel(id);
    },
    selectedTier: ctx.selectedTier,
    listSessions() {
      return [...ctx.sessions.values()].filter((s) => !s.isSupervisor).map((s) => ({
        id: s.id,
        title: s.title,
        workDir: s.workDir,
        lastActiveAt: s.lastActiveAt,
        busy: ctx.runningLoops.has(s.id)
      }));
    },
    switchSession(id) {
      sessionsModule.switchSessionInternal(id);
    },
    describeSession(sessionId) {
      return sessionsModule.describeSession(sessionId);
    },
    sendMessageToSession(sessionId, message, mode) {
      return executionModule.sendMessageToSession(sessionId, message, mode ?? "insert");
    },
    runSession(sessionId, message, mode) {
      return executionModule.runSession(sessionId, message, mode ?? "insert");
    },
    setSessionModel(sessionId, modelId) {
      return sessionsModule.setSessionModelInternal(sessionId, modelId);
    },
    setSessionApprovalPolicy(sessionId, policy) {
      return sessionsModule.setSessionApprovalInternal(sessionId, policy);
    },
    getSupervisorModel() {
      return sessionsModule.getSupervisorModelInternal();
    },
    getSupervisorApprovalPolicy() {
      return sessionsModule.getSupervisorApprovalInternal();
    },
    setSupervisorModel(modelId) {
      return sessionsModule.setSupervisorModelInternal(modelId);
    },
    setSupervisorApprovalPolicy(policy) {
      return sessionsModule.setSupervisorApprovalInternal(policy);
    },
    renameSession(id, title) {
      sessionsModule.renameSessionInternal(id, title);
    },
    async deleteSession(id) {
      await sessionsModule.deleteSessionInternal(id);
    },
    getSessionWorkdir(id) {
      const meta = ctx.sessions.get(id ?? ctx.currentSessionId ?? "");
      return meta?.workDir ?? join18(homedir11(), "shanhai", "workspace");
    },
    setSessionWorkdir(id, workdir) {
      sessionsModule.setSessionWorkdirInternal(id, workdir);
    },
    async saveUploadedFile(fileName, dataBase64) {
      const dir = sessionsModule.currentWorkDir();
      await fs19.mkdir(dir, { recursive: true });
      const safeName = `${Date.now()}-${basename(fileName || "file")}`;
      const target = join18(dir, safeName);
      await fs19.writeFile(target, Buffer.from(dataBase64, "base64"));
      return target;
    },
    async uploadImage(imageBase64, mimeType) {
      return uploadImage(imageBase64, mimeType);
    },
    async listBrowserWindows(sessionId) {
      const sid = sessionId ?? ctx.currentSessionId ?? "";
      const all = await ctx.browserUse.list();
      return all.filter((w) => w.appId === sid || w.appId.startsWith(`${sid}:`));
    },
    async showBrowserWindow(appId) {
      await ctx.browserUse.show(appId);
    },
    async closeBrowserWindow(appId) {
      await ctx.browserUse.close(appId);
    },
    async userTerminalCreate(sessionId, name) {
      const sid = sessionId ?? ctx.currentSessionId ?? "";
      const cwd = ctx.sessions.get(sid)?.workDir ?? join18(homedir11(), "shanhai", "workspace");
      const terminalId = await ctx.terminalUse.create(`${sid}:default`, name, cwd);
      ctx.userTerminalSessionMap.set(terminalId, sid);
      return terminalId;
    },
    userTerminalWrite(sessionId, terminalId, data) {
      ctx.terminalUse.write(terminalId, data);
    },
    userTerminalResize(sessionId, terminalId, cols, rows) {
      ctx.terminalUse.resize(terminalId, cols, rows);
    },
    async userTerminalClose(sessionId, terminalId) {
      await ctx.terminalUse.close(terminalId);
      ctx.userTerminalSessionMap.delete(terminalId);
    },
    async userTerminalList(sessionId) {
      const sid = sessionId ?? ctx.currentSessionId ?? "";
      const all = await ctx.terminalUse.list();
      return all.filter((t) => t.terminalId.startsWith(`${sid}-`));
    },
    onUserTerminalOutput(cb) {
      ctx.userTerminalOutputCallbacks.add(cb);
      return () => {
        ctx.userTerminalOutputCallbacks.delete(cb);
      };
    },
    async getDeepSeekBridgeStatus() {
      return deepSeekBridgeModule.getStatus();
    },
    async openDeepSeekBridge() {
      return deepSeekBridgeModule.open();
    },
    async injectDeepSeekBridge() {
      return deepSeekBridgeModule.inject();
    },
    getSessionHistory(id) {
      return sessionsModule.getSessionHistory(id);
    },
    getSessionTrace(id) {
      return sessionsModule.getSessionTrace(id);
    },
    createSession(title, workdir) {
      const id = sessionsModule.newSession(title ?? "\u65B0\u4F1A\u8BDD", workdir);
      if (ctx.defaultModelId) modelProviderModule.applyModel(ctx.defaultModelId);
      deepSeekBridgeModule.ensureDefaultBrowserWindow(id);
      return id;
    },
    getHistory() {
      return sessionsModule.getHistory();
    },
    onToolTrace(cb) {
      ctx.toolTraceCallbacks.add(cb);
      return () => ctx.toolTraceCallbacks.delete(cb);
    },
    onApprovalRequest(cb) {
      ctx.approvalCallbacks.add(cb);
      return () => ctx.approvalCallbacks.delete(cb);
    },
    respondApproval(outcome, requestId) {
      const p = ctx.pendingApprovals.get(requestId);
      if (p) {
        p.resolve(outcome);
        ctx.pendingApprovals.delete(requestId);
      }
    },
    onApprovalResolved(cb) {
      ctx.approvalResolvedCallbacks.add(cb);
      return () => ctx.approvalResolvedCallbacks.delete(cb);
    },
    onAskResolved(cb) {
      ctx.askResolvedCallbacks.add(cb);
      return () => ctx.askResolvedCallbacks.delete(cb);
    },
    onAskRequest(cb) {
      return ctx.askService.onRequest(cb);
    },
    respondAsk(requestId, answer) {
      ctx.askService.respond(requestId, answer);
    },
    cancelAsk(requestId) {
      ctx.askService.cancel(requestId);
    },
    onDelta(cb) {
      ctx.deltaCallbacks.add(cb);
      return () => {
        ctx.deltaCallbacks.delete(cb);
      };
    },
    onReasoning(cb) {
      ctx.reasoningCallbacks.add(cb);
      return () => {
        ctx.reasoningCallbacks.delete(cb);
      };
    },
    onSessionActivity(cb) {
      ctx.sessionActivityCallbacks.add(cb);
      return () => {
        ctx.sessionActivityCallbacks.delete(cb);
      };
    },
    onCurrentSessionChanged(cb) {
      ctx.currentSessionChangedCallbacks.add(cb);
      return () => {
        ctx.currentSessionChangedCallbacks.delete(cb);
      };
    },
    onSupervisorResult(cb) {
      ctx.supervisorResultCallbacks.add(cb);
      return () => {
        ctx.supervisorResultCallbacks.delete(cb);
      };
    },
    onUserMessage(cb) {
      ctx.userMessageCallbacks.add(cb);
      return () => {
        ctx.userMessageCallbacks.delete(cb);
      };
    },
    getTokenStats(sessionId) {
      return tokenStatsModule.snapshot(sessionId);
    },
    onTokenStats(cb) {
      ctx.tokenCallbacks.add(cb);
      return () => {
        ctx.tokenCallbacks.delete(cb);
      };
    },
    switchModel(modelId) {
      modelProviderModule.applyModel(modelId);
      ctx.defaultModelId = modelId;
      void persistSelectedModel(modelId);
      const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : void 0;
      if (meta) {
        meta.modelId = modelId;
        void sessionsModule.persistSession(meta);
      }
    },
    getCurrentModelId() {
      return modelProviderModule.getCurrentModelId();
    },
    stop() {
      if (ctx.currentSessionId) sessionsModule.stopSessionInternal(ctx.currentSessionId);
    },
    stopSession(sessionId) {
      sessionsModule.stopSessionInternal(sessionId);
    },
    run: async (message, opts) => {
      const sid = ctx.currentSessionId;
      if (!sid) throw new Error("\u6CA1\u6709\u6D3B\u52A8\u4F1A\u8BDD");
      return executionModule.runInSession(sid, message, opts);
    },
    runSupervisor: (message, attachments) => executionModule.runSupervisorInternal(message, attachments),
    resend: async (sessionId, userMessageIndex, newContent) => {
      const meta = ctx.sessions.get(sessionId);
      if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sessionId}`);
      const events = meta.session.list();
      const effModelId = meta.modelId ?? ctx.defaultModelId;
      let userCount = 0;
      let targetIdx = -1;
      let originalContent = "";
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e?.type === "user/message") {
          const d = e.data;
          if (d.injected) continue;
          if (userCount === userMessageIndex) {
            targetIdx = i;
            originalContent = d.content;
            break;
          }
          userCount++;
        }
      }
      if (targetIdx < 0) throw new Error(`\u7528\u6237\u6D88\u606F\u4E0D\u5B58\u5728: #${userMessageIndex}`);
      const content = newContent !== void 0 ? newContent : originalContent;
      meta.session.truncate(targetIdx);
      if (sessionId === SUPERVISOR_ID) {
        return executionModule.runSupervisorInternal(content, void 0, effModelId);
      }
      return executionModule.runInSession(sessionId, content, void 0, effModelId);
    },
    resume: async (sessionId) => {
      const sid = sessionId;
      const meta = ctx.sessions.get(sid);
      if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}`);
      const events = meta.session.list();
      let lastUserIdx = -1;
      let lastUserContent = "";
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === "user/message") {
          const d = events[i].data;
          if (d.injected) continue;
          lastUserIdx = i;
          lastUserContent = d.content;
          break;
        }
      }
      if (lastUserIdx < 0) throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6D88\u606F");
      ctx.stoppedSessions.delete(sid);
      sessionsModule.touchSession(sid);
      const isSupervisorRun = sid === SUPERVISOR_ID;
      const effModelId = meta.modelId ?? ctx.defaultModelId;
      const effModel = modelProviderModule.resolveProvider(effModelId);
      const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId));
      const loop = new AgentLoop(
        effModel,
        isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools,
        meta.session,
        ctx.approval,
        sid,
        tokenStatsModule.currentContextBudget(effModelId),
        visionCapable,
        tokenStatsModule.currentApiKey(effModelId),
        modelProviderModule.resolveCompactModel()
      );
      ctx.runningLoops.set(sid, loop);
      ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "start"));
      let suspended = false;
      try {
        return await sessionContext.run(
          sid,
          () => loop.resumeRun(
            isSupervisorRun ? promptsModule.buildSupervisorSystemPrompt(lastUserContent) : promptsModule.buildSystemPrompt(meta.workDir, promptsModule.buildMemoryContext(lastUserContent, meta.id)),
            (text) => {
              if (ctx.stoppedSessions.has(sid)) throw new Error("__stopped__");
              ctx.deltaCallbacks.forEach((cb) => cb(sid, text));
            },
            (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text))
          )
        );
      } catch (err) {
        if (err instanceof Error && err.message === "__stopped__") {
          return "\uFF08\u5DF2\u4E2D\u65AD\uFF0C\u5386\u53F2\u5DF2\u4FDD\u7559\uFF0C\u53EF\u70B9\u51FB\u300C\u7EE7\u7EED\u6267\u884C\u300D\u7EED\u8DD1\uFF09";
        }
        if (err instanceof Error && err.message.startsWith("__retry_exhausted__")) {
          suspended = true;
        }
        throw err;
      } finally {
        if (!suspended) {
          ctx.runningLoops.delete(sid);
          ctx.sessionActivityCallbacks.forEach((cb) => cb(sid, "end"));
        }
        meta.lastActiveAt = Date.now();
        await sessionsModule.persistSession(meta);
        tokenStatsModule.emitTokenStats();
        executionModule.drainSupervisorQueue(sid);
      }
    },
    retrySession: async (sessionId) => {
      const sid = sessionId ?? ctx.currentSessionId;
      const meta = ctx.sessions.get(sid);
      if (!meta) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728: ${sid}`);
      const loop = ctx.runningLoops.get(sid);
      if (loop) {
        try {
          const result = await sessionContext.run(sid, () => loop.retry());
          meta.lastActiveAt = Date.now();
          await sessionsModule.persistSession(meta);
          tokenStatsModule.emitTokenStats();
          return result;
        } finally {
          if (!loop.isSuspended()) ctx.runningLoops.delete(sid);
        }
      }
      const snapshot = sessionsModule.readRetrySnapshot(meta);
      if (snapshot) {
        const isSupervisorRun = sid === SUPERVISOR_ID;
        const effModelId2 = meta.modelId ?? ctx.defaultModelId;
        const effModel = modelProviderModule.resolveProvider(effModelId2);
        const visionCapable = modelSupportsVision(allModels().find((m) => m.id === effModelId2));
        const restoredLoop = new AgentLoop(effModel, isSupervisorRun ? ctx.supervisorLoopTools : ctx.tools, meta.session, ctx.approval, sid, tokenStatsModule.currentContextBudget(effModelId2), visionCapable, tokenStatsModule.currentApiKey(effModelId2), modelProviderModule.resolveCompactModel());
        restoredLoop.restoreSuspended(snapshot);
        ctx.runningLoops.set(sid, restoredLoop);
        try {
          const result = await sessionContext.run(
            sid,
            () => restoredLoop.retry(
              (text) => {
                if (ctx.stoppedSessions.has(sid)) throw new Error("__stopped__");
                ctx.deltaCallbacks.forEach((cb) => cb(sid, text));
              },
              (text) => ctx.reasoningCallbacks.forEach((cb) => cb(sid, text))
            )
          );
          meta.lastActiveAt = Date.now();
          await sessionsModule.persistSession(meta);
          tokenStatsModule.emitTokenStats();
          return result;
        } finally {
          if (!restoredLoop.isSuspended()) ctx.runningLoops.delete(sid);
        }
      }
      const events = meta.session.list();
      let lastUserIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === "user/message") {
          const d = events[i].data;
          if (d.injected) continue;
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) throw new Error("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u6D88\u606F");
      const content = events[lastUserIdx].data.content;
      const effModelId = meta.modelId ?? ctx.defaultModelId;
      meta.session.truncate(lastUserIdx);
      if (sid === SUPERVISOR_ID) {
        return executionModule.runSupervisorInternal(content, void 0, effModelId);
      }
      return executionModule.runInSession(sid, content, void 0, effModelId);
    },
    abandonSession: async (sessionId) => {
      const sid = sessionId ?? ctx.currentSessionId;
      ctx.runningLoops.delete(sid);
      const meta = ctx.sessions.get(sid);
      if (meta) {
        meta.session.removeLast("retry/snapshot");
        await sessionsModule.persistSession(meta);
      }
    },
    hasRetrySnapshot(sessionId) {
      const meta = ctx.sessions.get(sessionId);
      if (!meta) return null;
      const snap = sessionsModule.readRetrySnapshot(meta);
      return snap ? { reason: snap.reason } : null;
    },
    injectMessage(sessionId, message) {
      const loop = ctx.runningLoops.get(sessionId);
      if (loop) {
        loop.injectUserMessage(message);
        return true;
      }
      return false;
    },
    hasIncompleteTurn(sessionId) {
      if (ctx.runningLoops.has(sessionId)) return false;
      const meta = ctx.sessions.get(sessionId);
      if (!meta) return false;
      const events = meta.session.list();
      let lastUserIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === "user/message") {
          const d = events[i].data;
          if (d.injected) continue;
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) return false;
      for (let i = lastUserIdx + 1; i < events.length; i++) {
        const t = events[i]?.type;
        if (t === "assistant/message" || t === "turn/end") return false;
      }
      return true;
    },
    getApprovalPolicy() {
      return sessionsModule.sessionApprovalPolicy();
    },
    setApprovalPolicy(policy) {
      const meta = ctx.currentSessionId ? ctx.sessions.get(ctx.currentSessionId) : void 0;
      if (!meta) return;
      meta.approvalPolicy = policy;
      ctx.approval.setPolicy(policy);
      void sessionsModule.persistSession(meta);
    },
    selfmodInspect(sessionId) {
      const sid = sessionId ?? ctx.currentSessionId ?? "";
      return ctx.selfmod.inspect(sid);
    },
    restoreInstalledPlugins() {
      return ctx.selfmod.restoreAll();
    },
    onClientRunRequest(cb) {
      ctx.clientRunCallbacks.add(cb);
      return () => ctx.clientRunCallbacks.delete(cb);
    },
    respondClientRun(requestId, approved) {
      const p = ctx.pendingClientRuns.get(requestId);
      if (p) {
        p.resolve(approved);
        ctx.pendingClientRuns.delete(requestId);
      }
    },
    onClientCode(cb) {
      ctx.clientCodeCallbacks.add(cb);
      return () => ctx.clientCodeCallbacks.delete(cb);
    },
    onClientRemove(cb) {
      ctx.clientRemoveCallbacks.add(cb);
      return () => ctx.clientRemoveCallbacks.delete(cb);
    },
    listMemory(sessionId) {
      return ctx.memory.listBySession(sessionId);
    },
    removeMemory(id) {
      ctx.memory.remove(id);
      void persistMemory();
    },
    async transcribeAudio(audioBase64, _format) {
      if (!audioBase64) return "";
      if (!ctx.loggedIn || !ctx.gatewayApiKey || !ctx.gatewayBaseUrl) return "";
      try {
        const text = await gatewayAsrTranscribe(audioBase64, ctx.gatewayApiKey, ctx.gatewayBaseUrl);
        return text;
      } catch (err) {
        console.warn("[STT] \u7F51\u5173 ASR \u8BC6\u522B\u5931\u8D25:", err instanceof Error ? err.message : err);
        return "";
      }
    },
    getSettings() {
      return { browser: { ...ctx.currentSettings.browser }, messageSubmit: { ...ctx.currentSettings.messageSubmit }, debug: { ...ctx.currentSettings.debug }, voice: { ...ctx.currentSettings.voice }, supervisorApproval: { ...ctx.currentSettings.supervisorApproval }, supervisorAsk: { ...ctx.currentSettings.supervisorAsk }, compaction: { ...ctx.currentSettings.compaction } };
    },
    async getHttpTrace(id) {
      const sid = id ?? ctx.currentSessionId ?? "";
      if (!sid) return [];
      return ctx.httpTrace.read(sid);
    },
    async clearHttpTrace(id) {
      const sid = id ?? ctx.currentSessionId ?? "";
      if (!sid) return;
      try {
        await fs19.rm(ctx.httpTrace.path(sid), { force: true });
      } catch {
      }
    },
    getHttpTracePath(id) {
      return ctx.httpTrace.path(id ?? ctx.currentSessionId ?? "");
    },
    getTraceDir() {
      return ctx.tracesDir;
    },
    async setSettings(patch) {
      const prevWebBridge = ctx.currentSettings.browser.enableWebBridge;
      ctx.currentSettings = {
        browser: { ...ctx.currentSettings.browser, ...patch.browser ?? {} },
        messageSubmit: { ...ctx.currentSettings.messageSubmit, ...patch.messageSubmit ?? {} },
        debug: { ...ctx.currentSettings.debug, ...patch.debug ?? {} },
        voice: { ...ctx.currentSettings.voice, ...patch.voice ?? {} },
        supervisorApproval: { ...ctx.currentSettings.supervisorApproval, ...patch.supervisorApproval ?? {} },
        supervisorAsk: { ...ctx.currentSettings.supervisorAsk, ...patch.supervisorAsk ?? {} },
        compaction: { ...ctx.currentSettings.compaction, ...patch.compaction ?? {} }
      };
      ctx.browserUse.setShowOnCreate?.(ctx.currentSettings.browser.showOnCreate);
      if (ctx.currentSettings.browser.enableWebBridge !== prevWebBridge) {
        if (ctx.currentSettings.browser.enableWebBridge) {
          deepSeekBridgeModule.registerDeepSeekBridgeModel();
          deepSeekBridgeModule.ensureDefaultBrowserWindow(ctx.currentSessionId ?? "");
        } else {
          ctx.deepseekBridgeModel = null;
          if (ctx.currentModelId === "deepseek-web") {
            const fallback = ctx.gatewayModels[0] ?? ctx.customModels[0];
            if (fallback) modelProviderModule.applyModel(fallback.id);
            else ctx.currentModelId = "";
          }
          const sid = ctx.currentSessionId;
          if (sid) {
            const wins = await ctx.browserUse.list();
            for (const w of wins) {
              if (w.appId === sid) await ctx.browserUse.close(w.appId).catch(() => void 0);
            }
          }
        }
      }
      await writeSettings(ctx.currentSettings);
      return { browser: { ...ctx.currentSettings.browser }, messageSubmit: { ...ctx.currentSettings.messageSubmit }, debug: { ...ctx.currentSettings.debug }, voice: { ...ctx.currentSettings.voice }, supervisorApproval: { ...ctx.currentSettings.supervisorApproval }, supervisorAsk: { ...ctx.currentSettings.supervisorAsk }, compaction: { ...ctx.currentSettings.compaction } };
    }
  };
}

// src/main/browser.ts
import { app as app2, BrowserWindow as BrowserWindow2 } from "electron";

// src/main/window-manager.ts
import { app, BrowserWindow, Menu, screen } from "electron";
import { join as join19, dirname as dirname3 } from "path";
import { fileURLToPath } from "url";
var __dirname = dirname3(fileURLToPath(import.meta.url));
var ICON_PATH = join19(__dirname, "../../assets/icon-256.png");
var isWin = process.platform === "win32";
var WINDOW_TYPE_ARG = "--shanhai-window-type=";
var APP_ID_ARG = "--shanhai-app-id=";
var windows = /* @__PURE__ */ new Map();
var externalWindows = /* @__PURE__ */ new Set();
var seq = 0;
var isQuitting = false;
app.on("before-quit", () => {
  isQuitting = true;
});
function registerContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];
    if (params.selectionText && params.selectionText.trim().length > 0) {
      items.push({ label: "\u590D\u5236", role: "copy" });
    }
    if (params.isEditable) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({ label: "\u7C98\u8D34", role: "paste" });
      items.push({ label: "\u5168\u9009", role: "selectAll" });
    }
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}
async function loadWindowContent(win) {
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(join19(__dirname, "../renderer/index.html"));
  }
}
function createWindow(opts) {
  const { type, appId } = opts;
  const display = screen.getPrimaryDisplay();
  let shellBounds;
  let supervisorBounds;
  if (type === "desktop") {
    shellBounds = { x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height };
  } else if (type === "dock") {
    const dockWidth = 520;
    const dockHeight = 96;
    shellBounds = {
      x: display.workArea.x + Math.floor((display.workArea.width - dockWidth) / 2),
      y: display.workArea.y + display.workArea.height - dockHeight - 24,
      width: dockWidth,
      height: dockHeight
    };
  } else if (type === "supervisor") {
    const sw = opts.width ?? 720;
    const sh = opts.height ?? 760;
    supervisorBounds = {
      x: display.workArea.x + display.workArea.width - sw - 24,
      y: display.workArea.y + Math.floor((display.workArea.height - sh) / 2),
      width: sw,
      height: sh
    };
  } else if (type === "supervisor-bubble") {
    const bw = 60;
    const bh = 60;
    supervisorBounds = {
      x: display.workArea.x + display.workArea.width - bw - 24,
      y: display.workArea.y + Math.floor((display.workArea.height - bh) / 2),
      width: bw,
      height: bh
    };
  }
  const win = new BrowserWindow({
    ...shellBounds ?? supervisorBounds ?? { width: opts.width ?? 1080, height: opts.height ?? 760 },
    // 所有窗口统一 frameless（frame:false），彻底去掉 macOS 系统红绿灯，标题栏/关闭由渲染层自定义组件承担。
    // desktop/dock 额外 focusable:false（不接受键盘焦点，点击不抢焦点，但仍可接收鼠标事件）。
    // supervisor 保持可聚焦（它是可交互的聊天窗口）。
    ...shellBounds ? { frame: false, focusable: false } : { frame: false },
    ...type === "dock" || type === "supervisor-bubble" || isWin && (type === "chat" || type === "supervisor" || type === "app" || type === "desktop") ? { transparent: true, backgroundColor: "#00000000", hasShadow: false } : {},
    ...type === "supervisor-bubble" ? { alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true } : {},
    fullscreen: shellBounds ? false : opts.fullscreen ?? false,
    show: opts.show ?? true,
    icon: ICON_PATH,
    webPreferences: {
      preload: join19(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `${WINDOW_TYPE_ARG}${type}`,
        ...appId ? [`${APP_ID_ARG}${appId}`] : []
      ]
    }
  });
  const key = `${type}${appId ? `:${appId}` : ""}:${++seq}`;
  windows.set(key, { type, appId, win });
  if (type === "chat" || type === "desktop" || type === "dock") {
    win.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        win.hide();
      }
    });
  } else if (type === "supervisor") {
    win.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        win.hide();
        showSupervisorBubble();
      }
    });
  }
  win.on("closed", () => {
    windows.delete(key);
  });
  registerContextMenu(win);
  return win;
}
function getWindowType(win) {
  for (const meta of windows.values()) {
    if (meta.win === win) return meta.type;
  }
  return void 0;
}
function findWindow(type, appId) {
  for (const meta of windows.values()) {
    if (meta.type === type && meta.appId === appId && !meta.win.isDestroyed()) {
      return { win: meta.win, meta };
    }
  }
  return void 0;
}
function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  ensureDesktopLayer();
}
function showChatWindow() {
  const found = findWindow("chat");
  if (found) {
    showWindow(found.win);
    return;
  }
  const win = createWindow({ type: "chat" });
  void loadWindowContent(win).then(() => {
    showWindow(win);
  });
}
function showSupervisorWindow() {
  const bubble = findWindow("supervisor-bubble");
  if (bubble && !bubble.win.isDestroyed()) bubble.win.hide();
  const found = findWindow("supervisor");
  if (found) {
    showWindow(found.win);
    return;
  }
  const win = createWindow({ type: "supervisor" });
  void loadWindowContent(win).then(() => {
    showWindow(win);
  });
}
function showSupervisorBubble() {
  const found = findWindow("supervisor-bubble");
  if (found) {
    showWindow(found.win);
    return;
  }
  const win = createWindow({ type: "supervisor-bubble" });
  void loadWindowContent(win).then(() => {
    showWindow(win);
  });
}
function hideSupervisorToBubble() {
  const found = findWindow("supervisor");
  if (found && !found.win.isDestroyed()) found.win.hide();
  showSupervisorBubble();
}
function showSupervisorFromBubble() {
  showSupervisorWindow();
}
function moveSupervisorBubble(dx, dy) {
  const bubble = findWindow("supervisor-bubble");
  if (!bubble || bubble.win.isDestroyed()) return;
  const b = bubble.win.getBounds();
  bubble.win.setPosition(Math.round(b.x + dx), Math.round(b.y + dy));
}
function hideChatWindow() {
  const found = findWindow("chat");
  if (found && !found.win.isDestroyed()) {
    found.win.hide();
  }
}
function keepDesktopAtBottom() {
  for (const meta of windows.values()) {
    if (meta.type === "desktop") continue;
    if (meta.win.isDestroyed() || !meta.win.isVisible()) continue;
    meta.win.moveTop();
  }
  for (const win of externalWindows) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    win.moveTop();
  }
}
function registerExternalWindow(win) {
  externalWindows.add(win);
}
function unregisterExternalWindow(win) {
  externalWindows.delete(win);
}
function ensureDesktopLayer() {
  const desktop = findWindow("desktop");
  if (desktop && !desktop.win.isDestroyed()) {
    if (!desktop.win.isVisible()) desktop.win.show();
    desktop.win.moveTop();
  }
  const dock = findWindow("dock");
  if (dock && !dock.win.isDestroyed() && !dock.win.isVisible()) {
    dock.win.show();
  }
  keepDesktopAtBottom();
}
function hideToSystemDesktop() {
  for (const meta of windows.values()) {
    if (!meta.win.isDestroyed() && meta.win.isVisible()) {
      meta.win.hide();
    }
  }
}
function restoreAboveDesktop() {
  ensureDesktopLayer();
}
function resizeDockWindow(width, height) {
  const found = findWindow("dock");
  if (!found || found.win.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const w = Math.max(300, Math.round(width));
  const h = Math.max(72, Math.round(height));
  found.win.setBounds({
    x: display.workArea.x + Math.floor((display.workArea.width - w) / 2),
    y: display.workArea.y + display.workArea.height - h - 24,
    width: w,
    height: h
  });
}
function minimizeWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (getWindowType(win) === "chat") {
    win.hide();
    return;
  }
  win.minimize();
}
var preMaximizeBounds = /* @__PURE__ */ new Map();
function toggleMaximizeWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const wtype = getWindowType(win);
  if (isWin && (wtype === "chat" || wtype === "supervisor" || wtype === "app")) {
    const saved = preMaximizeBounds.get(win.id);
    if (saved) {
      preMaximizeBounds.delete(win.id);
      win.setBounds(saved);
      return false;
    }
    preMaximizeBounds.set(win.id, win.getBounds());
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    return true;
  }
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
}
function toggleChatWindow() {
  const found = findWindow("chat");
  if (found && found.win.isVisible() && found.win.isFocused()) {
    found.win.hide();
  } else {
    showChatWindow();
  }
}
async function openApp(appId) {
  if (appId === "supervisor") {
    showSupervisorWindow();
    return true;
  }
  if (appId === "chat") {
    showChatWindow();
    return true;
  }
  const existing = findWindow("app", appId);
  if (existing) {
    showWindow(existing.win);
    return true;
  }
  const win = createWindow({ type: "app", appId, width: 980, height: 720 });
  await loadWindowContent(win);
  showWindow(win);
  return true;
}
function closeApp(appId) {
  const existing = findWindow("app", appId);
  if (existing) {
    existing.win.destroy();
    restoreAboveDesktop();
  }
}

// src/main/browser.ts
var DEFAULT_APP_ID = "default";
var SHARED_PARTITION = "persist:shanhai-browser-shared";
var partitionOf = (appId) => appId.includes(":") ? `shanhai-browser-${appId.replace(/[^a-zA-Z0-9_-]/g, "-")}` : SHARED_PARTITION;
var MAX_LOG_ENTRIES = 500;
var LOAD_TIMEOUT_MS = 3e4;
var BRIDGE_CHAT_TIMEOUT_MS = 62e4;
function loadURLWithTimeout(win, url) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(
        new Error(
          `\u9875\u9762\u52A0\u8F7D\u8D85\u65F6\uFF08${LOAD_TIMEOUT_MS / 1e3}s\uFF09: ${url}\u3002\u53EF\u80FD\u7F51\u7EDC\u4E0D\u901A\u3001\u670D\u52A1\u672A\u542F\u52A8\u6216\u9875\u9762\u6301\u7EED\u52A0\u8F7D\uFF0C\u53EF\u6539\u7528 browser_get_console_logs / browser_get_network_requests \u6392\u67E5\u3002`
        )
      ),
      LOAD_TIMEOUT_MS
    );
  });
  return Promise.race([
    // 中文语言：附加 Accept-Language，让 DeepSeek 等中文站点返回中文界面/内容
    win.webContents.loadURL(url, { extraHeaders: "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\n" }),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
async function sendCommandWithTimeout(dbg, method, params, timeoutMs = 8e3) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CDP ${method} \u8D85\u65F6\uFF08${Math.round(timeoutMs / 1e3)}s\uFF09\uFF0C\u8C03\u8BD5\u5668\u672A\u54CD\u5E94`)), timeoutMs);
  });
  return Promise.race([dbg.sendCommand(method, params), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function pushBounded(arr, item) {
  arr.push(item);
  if (arr.length > MAX_LOG_ENTRIES) arr.splice(0, arr.length - MAX_LOG_ENTRIES);
}
async function getElementCenter(win, selector) {
  const js = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`;
  const rect = await win.webContents.executeJavaScript(js);
  if (!rect) throw new Error(`\u672A\u627E\u5230\u5143\u7D20: ${selector}`);
  return rect;
}
function createElectronBrowserService(opts) {
  let show = opts?.show ?? true;
  const windows2 = /* @__PURE__ */ new Map();
  app2.on("before-quit", () => {
    for (const st of windows2.values()) st.allowClose = true;
  });
  const stateOf = (appId, label) => {
    const id = appId ?? DEFAULT_APP_ID;
    let st = windows2.get(id);
    if (st && !st.win.isDestroyed()) return st;
    const win = new BrowserWindow2({
      show,
      width: 1280,
      height: 900,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // 会话级默认窗口共享 partition，agent 临时窗口独立 partition（见 partitionOf）
        partition: partitionOf(id)
      }
    });
    const cleanUa = win.webContents.getUserAgent().replace(/\sElectron\/[\d.]+/g, "").replace(/\sshanhai\/[\d.]+/g, "");
    win.webContents.setUserAgent(cleanUa);
    st = {
      win,
      label: label ?? "",
      consoleLogs: [],
      networkRequests: [],
      pendingRequests: /* @__PURE__ */ new Map(),
      debuggerAttached: false,
      allowClose: false
    };
    windows2.set(id, st);
    registerExternalWindow(win);
    win.on("close", (e) => {
      if (!st.allowClose) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on("closed", () => {
      windows2.delete(id);
      unregisterExternalWindow(win);
    });
    win.webContents.on("did-navigate", () => {
      st.debuggerAttached = false;
    });
    return st;
  };
  const enableDebugger = async (id, st) => {
    const dbg = st.win.webContents.debugger;
    if (!st.debuggerAttached) {
      try {
        dbg.attach("1.3");
      } catch {
      }
      st.debuggerAttached = true;
      dbg.on("message", (_event, method, params) => {
        if (method === "Runtime.consoleAPICalled") {
          const p = params;
          const text = (p.args ?? []).map((a) => a.value === void 0 ? a.type ?? "" : String(a.value)).join(" ");
          pushBounded(st.consoleLogs, { type: p.type, text });
        } else if (method === "Network.requestWillBeSent") {
          const p = params;
          const req = { url: p.request.url, method: p.request.method, type: p.type };
          st.pendingRequests.set(p.requestId, req);
          if (st.pendingRequests.size > MAX_LOG_ENTRIES) {
            const oldest = st.pendingRequests.keys().next().value;
            if (oldest !== void 0) st.pendingRequests.delete(oldest);
          }
          pushBounded(st.networkRequests, req);
        } else if (method === "Network.responseReceived") {
          const p = params;
          const req = st.pendingRequests.get(p.requestId);
          if (req) req.status = p.response.status;
          st.pendingRequests.delete(p.requestId);
        }
      });
    }
    try {
      await sendCommandWithTimeout(dbg, "Runtime.enable", {}, 5e3);
      await sendCommandWithTimeout(dbg, "Network.enable", {}, 5e3);
    } catch {
    }
  };
  return {
    async create(appId, url, title) {
      if (!url) {
        throw new Error("browser_create \u9700\u8981 url \u53C2\u6570\uFF1A\u521B\u5EFA\u6D4F\u89C8\u5668\u7A97\u53E3\u5FC5\u987B\u6307\u5B9A\u8981\u6253\u5F00\u7684\u7F51\u5740\uFF0C\u907F\u514D\u6253\u5F00\u7A7A\u767D\u7A97\u53E3");
      }
      let id = appId;
      if (!id) {
        id = DEFAULT_APP_ID;
        let n = 2;
        while (windows2.has(id) && !windows2.get(id).win.isDestroyed()) {
          id = `win-${n++}`;
        }
      }
      const st = stateOf(id, title);
      await loadURLWithTimeout(st.win, url);
      await enableDebugger(id, st);
      return id;
    },
    async list() {
      const out = [];
      for (const [id, st] of windows2) {
        if (st.win.isDestroyed()) continue;
        out.push({
          appId: id,
          label: st.label || void 0,
          url: st.win.webContents.getURL(),
          title: st.win.webContents.getTitle()
        });
      }
      return out;
    },
    async navigate(url, appId) {
      const id = appId ?? DEFAULT_APP_ID;
      const st = stateOf(id);
      await loadURLWithTimeout(st.win, url);
      await enableDebugger(id, st);
    },
    async screenshot(appId) {
      const st = stateOf(appId);
      const image = await st.win.webContents.capturePage();
      const buf = image.toPNG();
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async click(selector, appId) {
      const st = stateOf(appId);
      await enableDebugger(appId ?? DEFAULT_APP_ID, st);
      const { x, y } = await getElementCenter(st.win, selector);
      const dbg = st.win.webContents.debugger;
      const mousePressed = { type: "mousePressed", x, y, button: "left", clickCount: 1 };
      const mouseReleased = { type: "mouseReleased", x, y, button: "left", clickCount: 1 };
      await sendCommandWithTimeout(dbg, "Input.dispatchMouseEvent", mousePressed);
      await sendCommandWithTimeout(dbg, "Input.dispatchMouseEvent", mouseReleased);
    },
    async type(selector, text, appId, clear = true) {
      const st = stateOf(appId);
      await enableDebugger(appId ?? DEFAULT_APP_ID, st);
      const focusJs = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        ${clear ? `
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, '')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        ` : ""}
        el.focus()
        return true
      })()`;
      const focused = await st.win.webContents.executeJavaScript(focusJs);
      if (!focused) throw new Error(`\u672A\u627E\u5230\u8F93\u5165\u5143\u7D20: ${selector}`);
      await sendCommandWithTimeout(st.win.webContents.debugger, "Input.insertText", { text });
    },
    async getContent(selector, appId, includeHtml = false) {
      const st = stateOf(appId);
      const js = includeHtml ? `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"}; return el ? el.outerHTML : '' })()` : `(() => { const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"}; return el ? el.innerText : '' })()`;
      return await st.win.webContents.executeJavaScript(js);
    },
    async evaluate(code, appId) {
      const st = stateOf(appId);
      return st.win.webContents.executeJavaScript(code);
    },
    async chatWithPageBridge(prompt, opts2, appId) {
      const id = appId ?? DEFAULT_APP_ID;
      const st = stateOf(id);
      const js = `window.__dsChat(${JSON.stringify(prompt)}, ${JSON.stringify(opts2)})`;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`\u9875\u9762\u6865\u63A5\u8D85\u65F6\uFF08${Math.round(BRIDGE_CHAT_TIMEOUT_MS / 1e3)}s\uFF09\uFF0CDeepSeek \u9875\u9762\u672A\u8FD4\u56DE\u7ED3\u679C`)), BRIDGE_CHAT_TIMEOUT_MS);
      });
      try {
        return await Promise.race([st.win.webContents.executeJavaScript(js), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async getInfo(appId) {
      const st = stateOf(appId);
      const viewport = await st.win.webContents.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })"
      );
      return {
        url: st.win.webContents.getURL(),
        title: st.win.webContents.getTitle(),
        label: st.label || void 0,
        viewport
      };
    },
    async wait(selector, appId, timeoutMs = 1e4) {
      const st = stateOf(appId);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = await st.win.webContents.executeJavaScript(
          `!!document.querySelector(${JSON.stringify(selector)})`
        );
        if (found) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`\u7B49\u5F85\u5143\u7D20\u8D85\u65F6: ${selector}`);
    },
    async scroll(direction, appId, amount = 300, selector) {
      const st = stateOf(appId);
      const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
      const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
      const js = selector ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollBy(${dx}, ${dy}); return true })()` : `(() => { window.scrollBy(${dx}, ${dy}); return true })()`;
      const ok = await st.win.webContents.executeJavaScript(js);
      if (!ok) throw new Error(`\u672A\u627E\u5230\u6EDA\u52A8\u5BB9\u5668: ${selector}`);
    },
    async getConsoleLogs(appId, limit = 50, onlyErrors = false) {
      const st = stateOf(appId);
      const filtered = onlyErrors ? st.consoleLogs.filter((l) => l.type === "error") : st.consoleLogs;
      return filtered.slice(-limit);
    },
    async getNetworkRequests(appId, limit = 50) {
      const st = stateOf(appId);
      return st.networkRequests.slice(-limit);
    },
    async getCookies(appId) {
      const st = stateOf(appId);
      const cookies = await st.win.webContents.session.cookies.get({});
      return cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expires: c.expirationDate
      }));
    },
    async setCookie(cookie, appId) {
      const st = stateOf(appId);
      const url = cookie.domain ? `http${cookie.secure ? "s" : ""}://${cookie.domain}${cookie.path ?? "/"}` : st.win.webContents.getURL();
      await st.win.webContents.session.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expires
      });
    },
    async clearCookies(appId) {
      const st = stateOf(appId);
      await st.win.webContents.session.clearStorageData({ storages: ["cookies"] });
    },
    async show(appId) {
      const id = appId ?? DEFAULT_APP_ID;
      const st = windows2.get(id);
      if (st && !st.win.isDestroyed()) {
        if (st.win.isMinimized()) st.win.restore();
        st.win.show();
        st.win.focus();
      }
    },
    async close(appId) {
      const id = appId ?? DEFAULT_APP_ID;
      const st = windows2.get(id);
      if (st && !st.win.isDestroyed()) {
        st.allowClose = true;
        st.win.destroy();
        windows2.delete(id);
      }
    },
    setShowOnCreate(v) {
      show = v;
    }
  };
}

// src/main/terminal.ts
import { app as app3 } from "electron";
import { homedir as homedir12 } from "os";
import * as pty from "node-pty";
var DEFAULT_TERMINAL_ID = "default";
var MAX_BUFFER = 2e5;
function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "").replace(/\r/g, "");
}
function extractOutput(slice, marker) {
  const idx = slice.indexOf(marker);
  if (idx < 0) return stripAnsi(slice).trim();
  const out = slice.slice(0, idx);
  const lines = out.split("\n");
  while (lines.length > 0 && /echo\s+__SHANHAI_DONE_/.test(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }
  return stripAnsi(lines.join("\n")).trim();
}
function createElectronTerminalService() {
  const terminals = /* @__PURE__ */ new Map();
  const dataListeners = /* @__PURE__ */ new Set();
  app3.on("before-quit", () => {
    for (const st of terminals.values()) {
      try {
        st.proc.kill();
      } catch {
      }
    }
    terminals.clear();
  });
  const stateOf = (terminalId, name, cwd) => {
    const id = terminalId ?? DEFAULT_TERMINAL_ID;
    const existing = terminals.get(id);
    if (existing) return existing;
    const isWin2 = process.platform === "win32";
    const shellEnv = { ...process.env };
    if (!isWin2) {
      shellEnv.TERM = "xterm-256color";
      shellEnv.LANG = "zh_CN.UTF-8";
      shellEnv.LC_ALL = "zh_CN.UTF-8";
    }
    const proc = isWin2 ? pty.spawn("powershell.exe", ["-NoLogo"], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: cwd ?? homedir12(),
      env: shellEnv
    }) : pty.spawn("/bin/zsh", ["-i", "+o", "promptsp"], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: cwd ?? homedir12(),
      env: shellEnv
    });
    const st = { proc, name: name ?? "", buffer: "" };
    terminals.set(id, st);
    proc.onData((data) => {
      const cur = terminals.get(id);
      if (!cur) return;
      cur.buffer = (cur.buffer + data).slice(-MAX_BUFFER);
      for (const cb of dataListeners) {
        try {
          cb(id, data);
        } catch {
        }
      }
    });
    proc.onExit(() => {
      terminals.delete(id);
    });
    return st;
  };
  const run = async (terminalId, command, timeoutMs) => {
    const id = terminalId ?? DEFAULT_TERMINAL_ID;
    const st = terminals.get(id) ?? stateOf(id);
    const marker = `__SHANHAI_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const startLen = st.buffer.length;
    st.proc.write(`${command}
`);
    st.proc.write(`echo ${marker} $?
`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const slice2 = st.buffer.slice(startLen);
      if (slice2.includes(marker)) {
        return { output: extractOutput(slice2, marker), exitCode: 0 };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const slice = st.buffer.slice(startLen);
    return { output: extractOutput(slice, marker), timedOut: true };
  };
  return {
    async create(terminalId, name, cwd) {
      let id = terminalId && terminalId.trim() ? terminalId.trim().replace(/[^a-zA-Z0-9_-]/g, "-") : DEFAULT_TERMINAL_ID;
      if (terminals.has(id)) {
        const base = id;
        let n = 2;
        while (terminals.has(id)) id = `${base}-${n++}`;
      }
      stateOf(id, name, cwd);
      return id;
    },
    run,
    async list() {
      const out = [];
      for (const [id, st] of terminals) {
        out.push({ terminalId: id, name: st.name || void 0 });
      }
      return out;
    },
    async close(terminalId) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID;
      const st = terminals.get(id);
      if (st) {
        try {
          st.proc.kill();
        } catch {
        }
        terminals.delete(id);
      }
    },
    write(terminalId, data) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID;
      const st = terminals.get(id);
      if (!st) return;
      st.proc.write(data);
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    resize(terminalId, cols, rows) {
      const id = terminalId ?? DEFAULT_TERMINAL_ID;
      const st = terminals.get(id);
      if (!st) return;
      const c = Math.max(2, Math.floor(cols) || 200);
      const r = Math.max(1, Math.floor(rows) || 50);
      st.proc.resize(c, r);
    }
  };
}

// src/host/index.ts
function bootHost() {
  return bootstrap({
    browserUse: createElectronBrowserService(),
    terminalUse: createElectronTerminalService()
  });
}

// src/main/runtime.ts
var runtime = null;
function setRuntime(r) {
  runtime = r;
}
function getRuntime() {
  if (!runtime) throw new Error("\u8FD0\u884C\u65F6\u672A\u521D\u59CB\u5316\uFF08\u5E94\u5148 bootHost \u518D\u6CE8\u518C IPC/\u63A8\u9001\uFF09");
  return runtime;
}

// src/main/ui-store.ts
import { app as app4 } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join as join20 } from "path";

// src/main/notifications.ts
import { Notification } from "electron";
function notifySessionTaskComplete(sessionId, title, summary) {
  const cleanTitle = title?.trim() || "\u4F1A\u8BDD";
  const cleanSummary = summary?.trim();
  const body = cleanSummary ? cleanSummary.slice(0, 80) : "\u4EFB\u52A1\u6267\u884C\u5B8C\u6210";
  const notification = new Notification({
    title: `\u4F1A\u8BDD\u300C${cleanTitle}\u300D\u4EFB\u52A1\u5B8C\u6210`,
    body
  });
  notification.on("click", () => {
    showChatWindow();
    getRuntime().switchSession(sessionId);
  });
  notification.show();
}

// src/main/ui-store.ts
var MAX_TOOL_RESULT_CHARS = 4e3;
var SKIP_TRUNCATE_FIELDS = /* @__PURE__ */ new Set(["imageBase64", "imageUrl", "base64", "data"]);
function truncateToolResult2(result) {
  if (typeof result === "string") {
    return result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) + "\n\u2026\uFF08\u5DF2\u622A\u65AD\uFF09" : result;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result;
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length > MAX_TOOL_RESULT_CHARS && !SKIP_TRUNCATE_FIELDS.has(k)) {
        out[k] = v.slice(0, MAX_TOOL_RESULT_CHARS) + "\n\u2026\uFF08\u5DF2\u622A\u65AD\uFF09";
        changed = true;
      } else {
        out[k] = v;
      }
    }
    return changed ? out : result;
  }
  return result;
}
function historyToChatItems(history) {
  const out = [];
  for (const h of history) {
    if (h.kind === "user") {
      const images = (h.attachments ?? []).map((a) => a?.image_url?.url).filter((x) => typeof x === "string" && x.length > 0);
      out.push({ kind: "user", content: h.content ?? "", images, turnSeq: h.turnSeq });
    } else if (h.kind === "assistant") {
      out.push({ kind: "assistant", content: h.content ?? "", reasoningContent: h.reasoningContent, turnSeq: h.turnSeq, turnDuration: h.turnDuration });
    } else if (h.trace) {
      const trace = h.trace;
      if (trace.kind === "tool-result") {
        const idx = [...out].reverse().findIndex((it) => it.kind === "tool" && it.trace.kind === "tool-call" && it.trace.callId === trace.callId);
        if (idx >= 0) {
          const realIdx = out.length - 1 - idx;
          const base = out[realIdx].trace;
          out[realIdx] = { kind: "tool", trace: { ...base, kind: "tool-result", result: truncateToolResult2(trace.result), error: trace.error } };
          continue;
        }
      }
      out.push({ kind: "tool", trace });
    }
  }
  return out;
}
var EMPTY_SESSION = {
  items: [],
  streaming: "",
  streamingReasoning: "",
  busy: false,
  terminalPanelOpen: false,
  incompleteTurn: false
};
var INITIAL_STATE = {
  loggedIn: false,
  username: null,
  loginOpen: false,
  currentSessionId: "",
  sessions: [],
  sessionMap: {},
  models: [],
  selectedModel: "",
  approvalPolicy: "ask",
  tokenStatsBySession: {},
  approvalQueues: {},
  askQueues: {},
  browserWindows: [],
  retryPrompt: null,
  wallpaper: null
};
var state = INITIAL_STATE;
function wallpaperPath() {
  return join20(app4.getPath("userData"), "wallpaper.json");
}
function getWallpaper() {
  try {
    const raw = readFileSync(wallpaperPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.wallpaper === "string" ? parsed.wallpaper : null;
  } catch {
    return null;
  }
}
function setWallpaper(wallpaper) {
  try {
    const dir = app4.getPath("userData");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(wallpaperPath(), JSON.stringify({ wallpaper }), "utf8");
  } catch (err) {
    console.warn("[\u5C71\u6D77] \u4FDD\u5B58\u58C1\u7EB8\u5931\u8D25\uFF1A", err);
  }
}
var listeners = /* @__PURE__ */ new Set();
function getUiState() {
  return state;
}
function filterUiStateForWindow(type, s) {
  switch (type) {
    case "desktop":
      return { ...INITIAL_STATE, loggedIn: s.loggedIn, username: s.username, wallpaper: s.wallpaper };
    case "dock":
      return { ...INITIAL_STATE, loggedIn: s.loggedIn, username: s.username, loginOpen: s.loginOpen };
    case "supervisor-bubble":
      return { ...INITIAL_STATE };
    case "chat":
    case "supervisor":
    case "app":
    default:
      return s;
  }
}
function windowConsumesUiState(type) {
  return type !== "supervisor-bubble";
}
function subscribeUiState(cb) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function deepMerge(target, patch) {
  if (patch === null || patch === void 0) return patch;
  if (Array.isArray(patch)) return patch;
  if (Array.isArray(target) || Array.isArray(patch)) return patch;
  if (typeof patch === "object" && typeof target === "object" && target !== null) {
    const out = { ...target };
    for (const k of Object.keys(patch)) {
      out[k] = deepMerge(target[k], patch[k]);
    }
    return out;
  }
  return patch;
}
function patchUiState(patch) {
  state = deepMerge(state, patch);
  listeners.forEach((l) => l());
}
function mutate(fn) {
  state = fn(state);
  listeners.forEach((l) => l());
}
function initUiStore(runtime2) {
  state = {
    ...INITIAL_STATE,
    loggedIn: runtime2.loggedIn,
    username: runtime2.username,
    sessions: runtime2.listSessions(),
    selectedModel: runtime2.getCurrentModelId(),
    approvalPolicy: runtime2.getApprovalPolicy(),
    wallpaper: getWallpaper()
  };
  listeners.forEach((l) => l());
  void runtime2.listModels().then((models) => {
    mutate((s) => ({ ...s, models, selectedModel: runtime2.getCurrentModelId() }));
  });
  runtime2.onModelsChanged(() => {
    void runtime2.listModels().then((models) => {
      mutate((s) => ({ ...s, models }));
    });
  });
  runtime2.onToolTrace((trace) => {
    mutate((s) => {
      const cur = s.sessionMap[trace.sessionId] ?? EMPTY_SESSION;
      let items = cur.items;
      if (trace.kind === "tool-result") {
        const idx = [...items].reverse().findIndex((it) => it.kind === "tool" && it.trace.kind === "tool-call" && it.trace.callId === trace.callId);
        if (idx >= 0) {
          const realIdx = items.length - 1 - idx;
          const arr = [...items];
          const base = arr[realIdx].trace;
          arr[realIdx] = { kind: "tool", trace: { ...base, kind: "tool-result", result: truncateToolResult2(trace.result), error: trace.error } };
          items = arr;
        } else {
          items = [...items, { kind: "tool", trace }];
        }
      } else {
        items = [...items, { kind: "tool", trace }];
      }
      return { ...s, sessionMap: { ...s.sessionMap, [trace.sessionId]: { ...cur, items } } };
    });
    const isBrowserAction = trace.name?.startsWith("browser_") || trace.name === "skill_run" && trace.args?.skillId === "browser-use";
    if (isBrowserAction) {
      void runtime2.listBrowserWindows(trace.sessionId).then((wins) => {
        mutate((s) => ({ ...s, browserWindows: wins ?? [] }));
      });
    }
  });
  runtime2.onApprovalRequest((req) => {
    const sid = req.sessionId ?? state.currentSessionId;
    if (!sid) return;
    mutate((s) => ({ ...s, approvalQueues: { ...s.approvalQueues, [sid]: [...s.approvalQueues[sid] ?? [], req] } }));
  });
  runtime2.onAskRequest((req) => {
    const sid = req.sessionId ?? state.currentSessionId;
    if (!sid) return;
    mutate((s) => ({ ...s, askQueues: { ...s.askQueues, [sid]: [...s.askQueues[sid] ?? [], req] } }));
  });
  runtime2.onApprovalResolved((requestId) => removeApprovalRequest(requestId));
  runtime2.onAskResolved((requestId) => removeAskRequest(requestId));
  runtime2.onTokenStats((sessionId, stats) => {
    mutate((s) => ({ ...s, tokenStatsBySession: { ...s.tokenStatsBySession, [sessionId]: stats } }));
  });
  runtime2.onSessionActivity((sessionId, kind) => {
    if (kind === "start") {
      mutate((s) => ({
        ...s,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...s.sessionMap[sessionId] ?? EMPTY_SESSION, busy: true, turnStartTs: Date.now() } },
        sessions: s.sessions.map((it) => it.id === sessionId ? { ...it, busy: true } : it)
      }));
      return;
    }
    try {
      const items = historyToChatItems(runtime2.getSessionHistory(sessionId));
      const sessions = runtime2.listSessions();
      const incompleteTurn = runtime2.hasIncompleteTurn(sessionId);
      mutate((s) => ({
        ...s,
        sessions,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...s.sessionMap[sessionId] ?? EMPTY_SESSION, items, streaming: "", streamingReasoning: "", busy: false, incompleteTurn } }
      }));
      if (sessionId !== SUPERVISOR_ID && !incompleteTurn) {
        const meta = sessions.find((it) => it.id === sessionId);
        const lastAssistant = [...items].reverse().find((it) => it.kind === "assistant");
        const summary = lastAssistant && lastAssistant.kind === "assistant" ? lastAssistant.content : "";
        notifySessionTaskComplete(sessionId, meta?.title ?? "", summary);
      }
    } catch {
      const sessions = runtime2.listSessions();
      mutate((s) => ({
        ...s,
        sessions,
        sessionMap: { ...s.sessionMap, [sessionId]: { ...s.sessionMap[sessionId] ?? EMPTY_SESSION, busy: false } }
      }));
    }
  });
  runtime2.onCurrentSessionChanged((sessionId) => {
    try {
      const items = historyToChatItems(runtime2.getSessionHistory(sessionId));
      const incompleteTurn = runtime2.hasIncompleteTurn(sessionId);
      mutate((s) => ({
        ...s,
        currentSessionId: sessionId,
        sessionMap: {
          ...s.sessionMap,
          [sessionId]: { ...s.sessionMap[sessionId] ?? EMPTY_SESSION, items, incompleteTurn }
        }
      }));
    } catch {
      mutate((s) => ({ ...s, currentSessionId: sessionId }));
    }
  });
  runtime2.onSupervisorResult(() => {
    try {
      const items = historyToChatItems(runtime2.getSessionHistory(SUPERVISOR_ID));
      mutate((s) => ({
        ...s,
        sessionMap: { ...s.sessionMap, [SUPERVISOR_ID]: { ...s.sessionMap[SUPERVISOR_ID] ?? EMPTY_SESSION, items } }
      }));
    } catch {
    }
  });
  runtime2.onUserMessage((sessionId, message, turnSeq) => {
    mutate((s) => {
      const cur = s.sessionMap[sessionId] ?? EMPTY_SESSION;
      const last = cur.items[cur.items.length - 1];
      if (last && last.kind === "user" && last.content === message) return s;
      return {
        ...s,
        sessionMap: {
          ...s.sessionMap,
          [sessionId]: { ...cur, items: [...cur.items, { kind: "user", content: message, images: [], turnSeq }] }
        }
      };
    });
  });
  runtime2.onAuthExpired(() => {
    mutate((s) => ({ ...s, loggedIn: false, username: null, models: [] }));
  });
}
function removeApprovalRequest(requestId) {
  mutate((s) => {
    const next = {};
    for (const [sid, list] of Object.entries(s.approvalQueues)) {
      next[sid] = list.filter((r) => r.id !== requestId);
    }
    return { ...s, approvalQueues: next };
  });
}
function removeAskRequest(requestId) {
  mutate((s) => {
    const next = {};
    for (const [sid, list] of Object.entries(s.askQueues)) {
      next[sid] = list.filter((r) => r.id !== requestId);
    }
    return { ...s, askQueues: next };
  });
}

// src/main/push.ts
import { BrowserWindow as BrowserWindow3 } from "electron";
function registerPush() {
  const runtime2 = getRuntime();
  const broadcast = (channel, ...args) => {
    for (const win of BrowserWindow3.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    }
  };
  runtime2.onUserTerminalOutput((sessionId, terminalId, data) => broadcast("user-terminal:output", sessionId, terminalId, data));
  runtime2.onDelta((sessionId, text) => broadcast("chat:delta", sessionId, text));
  runtime2.onReasoning((sessionId, text) => broadcast("chat:reasoning", sessionId, text));
  runtime2.onClientRunRequest((req) => broadcast("selfmod:client-run-request", req));
  runtime2.onClientCode((payload) => broadcast("selfmod:client-code", payload));
  runtime2.onClientRemove((pkgId) => broadcast("selfmod:client-remove", pkgId));
  subscribeUiState(() => {
    const full = getUiState();
    for (const win of BrowserWindow3.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const type = getWindowType(win);
      if (!windowConsumesUiState(type)) continue;
      win.webContents.send("ui:state", filterUiStateForWindow(type, full));
    }
  });
}

// src/main/ipc-handlers.ts
import { app as app7, BrowserWindow as BrowserWindow5, dialog as dialog2, ipcMain, shell as shell2 } from "electron";

// src/main/system-wallpaper.ts
import { readFile } from "fs/promises";
import { join as join21, dirname as dirname4 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var __dirname2 = dirname4(fileURLToPath2(import.meta.url));
var BUILTIN_WALLPAPER_DIR = join21(__dirname2, "../../assets/wallpapers");
var BUILTIN_WALLPAPERS = [
  { id: "Mac Blue.heic", name: "Mac Blue" },
  { id: "Mac Pink.heic", name: "Mac Pink" },
  { id: "Mac Purple.heic", name: "Mac Purple" },
  { id: "Mac Yellow.heic", name: "Mac Yellow" },
  { id: "Radial Sky Blue.heic", name: "Radial Sky Blue" },
  { id: "Sonoma.heic", name: "Sonoma" },
  { id: "iMac Blue.heic", name: "iMac Blue" },
  { id: "iMac Green.heic", name: "iMac Green" },
  { id: "iMac Orange.heic", name: "iMac Orange" },
  { id: "iMac Pink.heic", name: "iMac Pink" },
  { id: "iMac Purple.heic", name: "iMac Purple" },
  { id: "iMac Silver.heic", name: "iMac Silver" },
  { id: "iMac Yellow.heic", name: "iMac Yellow" }
];
async function readAsDataUrl(filePath, mime) {
  const buf = await readFile(filePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}
async function listSystemWallpapers() {
  const metas = await Promise.all(
    BUILTIN_WALLPAPERS.map(async (w) => {
      try {
        const thumbnail = await readAsDataUrl(join21(BUILTIN_WALLPAPER_DIR, `${w.name}-thumb.jpg`), "image/jpeg");
        return { id: w.id, name: w.name, thumbnail };
      } catch (err) {
        console.warn("[\u5C71\u6D77] \u8BFB\u53D6\u5185\u7F6E\u58C1\u7EB8\u7F29\u7565\u56FE\u5931\u8D25\uFF1A", w.name, err);
        return null;
      }
    })
  );
  return metas.filter((m) => m !== null);
}
async function applySystemWallpaper(sourcePath) {
  const w = BUILTIN_WALLPAPERS.find((x) => x.id === sourcePath) ?? BUILTIN_WALLPAPERS.find((x) => x.name === sourcePath);
  if (!w) throw new Error(`\u672A\u77E5\u7684\u5185\u7F6E\u58C1\u7EB8\uFF1A${sourcePath}`);
  const dataUrl = await readAsDataUrl(join21(BUILTIN_WALLPAPER_DIR, `${w.name}-full.jpg`), "image/jpeg");
  return `url(${dataUrl})`;
}

// src/main/remote-server.ts
import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "os";
import { randomBytes, randomInt } from "crypto";

// src/main/remote-protocol.ts
var MAX_RESULT_CHARS = 4e3;
function truncateResult(result) {
  if (result === void 0 || result === null) return result;
  let s;
  try {
    s = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (s.length <= MAX_RESULT_CHARS) return result;
  return `${s.slice(0, MAX_RESULT_CHARS)}\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u5171 ${s.length} \u5B57\u7B26\uFF0C\u5B8C\u6574\u5185\u5BB9\u89C1\u684C\u9762\u7AEF\uFF09`;
}
function sanitizeTrace(trace) {
  if (trace.kind !== "tool-result" || trace.result === void 0) return trace;
  return { ...trace, result: truncateResult(trace.result) };
}
function sanitizeHistory(items) {
  const out = [];
  for (const item of items) {
    if (item.kind === "tool" && item.trace) {
      const trace = item.trace;
      if (trace.kind === "tool-result") {
        const idx = [...out].reverse().findIndex((it) => {
          const t = it.trace;
          return it.kind === "tool" && t?.kind === "tool-call" && t.callId === trace.callId;
        });
        if (idx >= 0) {
          const realIdx = out.length - 1 - idx;
          const base = out[realIdx].trace;
          out[realIdx] = {
            kind: "tool",
            trace: {
              ...base,
              kind: "tool-result",
              result: truncateResult(trace.result),
              error: trace.error,
              durationMs: trace.durationMs
            }
          };
          continue;
        }
      }
      out.push({ ...item, trace: sanitizeTrace(trace) });
    } else {
      out.push(item);
    }
  }
  return out;
}
function listSessionsFull() {
  const runtime2 = getRuntime();
  return runtime2.listSessions().map((s) => runtime2.describeSession(s.id)).filter((s) => s !== null).sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  });
}
async function handleCommand(send2, msg) {
  const runtime2 = getRuntime();
  const { id, cmd, payload } = msg;
  try {
    let data;
    switch (cmd) {
      case "list_sessions":
        data = listSessionsFull();
        break;
      case "get_history":
        data = sanitizeHistory(runtime2.getSessionHistory(payload.sessionId));
        break;
      case "get_supervisor_history":
        data = sanitizeHistory(runtime2.getSessionHistory(SUPERVISOR_ID));
        break;
      case "run_supervisor":
        data = await runtime2.runSupervisor(String(payload.message ?? ""));
        break;
      case "get_models":
        data = await runtime2.listModels();
        break;
      case "send_message": {
        const sessionId = String(payload.sessionId ?? "");
        const message = String(payload.message ?? "");
        const mode = payload.mode === "queue" ? "queue" : "insert";
        data = await runtime2.runSession(sessionId, message, mode);
        break;
      }
      case "stop_session":
        runtime2.stopSession(String(payload.sessionId ?? ""));
        data = { ok: true };
        break;
      case "resend":
        data = await runtime2.resend(String(payload.sessionId ?? ""), Number(payload.userMessageIndex ?? 0), payload.newContent);
        break;
      case "resume":
        data = await runtime2.resume(String(payload.sessionId ?? ""));
        break;
      case "retry":
        data = await runtime2.retrySession(String(payload.sessionId ?? ""));
        break;
      case "create_session":
        data = { sessionId: runtime2.createSession(payload.title, payload.workdir) };
        break;
      case "rename_session":
        runtime2.renameSession(String(payload.sessionId ?? ""), String(payload.title ?? ""));
        data = { ok: true };
        break;
      case "delete_session":
        await runtime2.deleteSession(String(payload.sessionId ?? ""));
        data = { ok: true };
        break;
      case "set_workdir":
        runtime2.setSessionWorkdir(String(payload.sessionId ?? ""), String(payload.workdir ?? ""));
        data = { ok: true };
        break;
      case "set_model":
        data = runtime2.setSessionModel(String(payload.sessionId ?? ""), String(payload.modelId ?? ""));
        break;
      case "switch_session":
        runtime2.switchSession(String(payload.sessionId ?? ""));
        data = { ok: true };
        break;
      case "respond_approval": {
        const requestId = String(payload.requestId ?? "");
        runtime2.respondApproval(payload.outcome === "rejected" ? "rejected" : "allowed-once", requestId);
        removeApprovalRequest(requestId);
        data = { ok: true };
        break;
      }
      case "respond_ask": {
        const requestId = String(payload.requestId ?? "");
        runtime2.respondAsk(requestId, String(payload.answer ?? ""));
        removeAskRequest(requestId);
        data = { ok: true };
        break;
      }
      case "cancel_ask": {
        const requestId = String(payload.requestId ?? "");
        runtime2.cancelAsk(requestId);
        removeAskRequest(requestId);
        data = { ok: true };
        break;
      }
      case "get_token_stats":
        data = runtime2.getTokenStats();
        break;
      default:
        throw new Error(`\u672A\u77E5\u547D\u4EE4: ${cmd}`);
    }
    send2({ type: "cmd_result", id, ok: true, data });
  } catch (err) {
    send2({ type: "cmd_result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
function subscribeRuntimeEvents(runtime2, broadcast) {
  return [
    runtime2.onDelta((sessionId, text) => broadcast("delta", { sessionId, text })),
    runtime2.onReasoning((sessionId, text) => broadcast("reasoning", { sessionId, text })),
    runtime2.onToolTrace((trace) => broadcast("tool_trace", sanitizeTrace(trace))),
    runtime2.onSessionActivity((sessionId, kind) => broadcast("session_activity", { sessionId, kind })),
    runtime2.onUserMessage((sessionId, message, turnSeq) => broadcast("user_message", { sessionId, message, turnSeq })),
    runtime2.onApprovalRequest((req) => broadcast("approval_request", req)),
    runtime2.onAskRequest((req) => broadcast("ask_request", req)),
    runtime2.onSupervisorResult((sessionId, title, result, error) => broadcast("supervisor_result", { sessionId, title, result, error })),
    runtime2.onTokenStats((sessionId, stats) => broadcast("token_stats", { sessionId, stats })),
    runtime2.onCurrentSessionChanged((sessionId) => broadcast("current_session_changed", { sessionId }))
  ];
}

// src/main/remote-server.ts
var DEFAULT_PORT = 47800;
var PAIRING_CODE_TTL_MS = 5 * 60 * 1e3;
var wss = null;
var pairingCode = "";
var pairingExpiresAt = 0;
var authedClients = /* @__PURE__ */ new Set();
var unsubs = [];
function getLanIp() {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}
function send(sock, obj) {
  if (sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(obj));
  }
}
function broadcastEvent(event, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ type: "event", event, payload });
  for (const client of authedClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}
function handlePair(sock, code) {
  if (!pairingCode || Date.now() > pairingExpiresAt) {
    send(sock, { type: "error", message: "\u914D\u5BF9\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u5728\u684C\u9762\u7AEF\u91CD\u65B0\u5F00\u542F\u8FDC\u7A0B\u8FDE\u63A5" });
    return;
  }
  if (code !== pairingCode) {
    send(sock, { type: "error", message: "\u914D\u5BF9\u7801\u9519\u8BEF" });
    return;
  }
  authedClients.add(sock);
  const token = randomBytes(24).toString("hex");
  send(sock, { type: "paired", token });
}
function startRemoteServer(port = DEFAULT_PORT) {
  if (wss) return getRemoteStatus();
  const runtime2 = getRuntime();
  wss = new WebSocketServer({ host: "0.0.0.0", port });
  pairingCode = String(randomInt(0, 1e6)).padStart(6, "0");
  pairingExpiresAt = Date.now() + PAIRING_CODE_TTL_MS;
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(sock, { type: "error", message: "\u65E0\u6548\u7684 JSON \u6D88\u606F" });
        return;
      }
      if (msg.type === "pair") {
        handlePair(sock, msg.code);
      } else if (msg.type === "cmd") {
        if (!authedClients.has(sock)) {
          send(sock, { type: "error", message: "\u672A\u914D\u5BF9\uFF0C\u8BF7\u5148\u53D1\u9001 pair" });
          return;
        }
        void handleCommand((obj) => send(sock, obj), msg);
      } else {
        send(sock, { type: "error", message: "\u672A\u77E5\u6D88\u606F\u7C7B\u578B" });
      }
    });
    sock.on("close", () => authedClients.delete(sock));
  });
  wss.on("error", (err) => {
    console.error("[remote] WebSocket \u670D\u52A1\u9519\u8BEF:", err instanceof Error ? err.message : err);
    wss?.close();
    wss = null;
    pairingCode = "";
    pairingExpiresAt = 0;
  });
  unsubs.push(...subscribeRuntimeEvents(runtime2, broadcastEvent));
  return getRemoteStatus();
}
function stopRemoteServer() {
  for (const u of unsubs) u();
  unsubs.length = 0;
  authedClients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
  pairingCode = "";
  pairingExpiresAt = 0;
}
function getRemoteStatus() {
  return {
    enabled: wss !== null,
    port: DEFAULT_PORT,
    ip: getLanIp(),
    pairingCode,
    pairingExpiresAt,
    pairedClients: authedClients.size
  };
}

// src/main/remote-relay.ts
import { WebSocket as WebSocket2 } from "ws";
import { app as app5 } from "electron";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join22 } from "path";
var DEFAULT_RELAY_URL = "wss://aisocket.bjctykj.com/ws";
var RECONNECT_DELAY_MS = 5e3;
var PING_INTERVAL_MS = 3e4;
var relayUrl = DEFAULT_RELAY_URL;
var enabled = false;
var connected = false;
var clientCount = 0;
var hostWs = null;
var unsubs2 = [];
var reconnectTimer = null;
var pingTimer = null;
var reconnectAttempts = 0;
function sendToRelay(obj) {
  if (hostWs && hostWs.readyState === WebSocket2.OPEN) {
    hostWs.send(JSON.stringify(obj));
  }
}
function broadcastEvent2(event, payload) {
  sendToRelay({ type: "event", event, payload });
}
function connect() {
  const runtime2 = getRuntime();
  const token = runtime2.getMemberToken();
  if (!token) {
    connected = false;
    return;
  }
  const info = runtime2.getDeviceInfo();
  const params = new URLSearchParams({
    role: "host",
    token,
    deviceId: info.deviceId ?? "",
    deviceName: info.deviceName ?? "",
    hostname: info.hostname ?? "",
    os: info.os ?? ""
  });
  const ws = new WebSocket2(`${relayUrl}?${params.toString()}`);
  hostWs = ws;
  ws.on("open", () => {
    connected = true;
    reconnectAttempts = 0;
    startPing();
    unsubs2.forEach((u) => u());
    unsubs2 = subscribeRuntimeEvents(runtime2, broadcastEvent2);
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "cmd") {
      void handleCommand(sendToRelay, { type: "cmd", id: msg.id ?? 0, cmd: msg.cmd ?? "", payload: msg.payload ?? {} });
    } else if (msg.type === "client_connected") {
      clientCount += 1;
    } else if (msg.type === "client_disconnected") {
      clientCount = Math.max(0, clientCount - 1);
    }
  });
  ws.on("close", () => {
    connected = false;
    hostWs = null;
    stopPing();
    unsubs2.forEach((u) => u());
    unsubs2 = [];
    if (enabled) scheduleReconnect();
  });
  ws.on("error", (err) => {
    console.error("[relay] \u7F51\u5173\u8FDE\u63A5\u9519\u8BEF:", err instanceof Error ? err.message : err);
  });
}
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (hostWs && hostWs.readyState === WebSocket2.OPEN) {
      hostWs.ping();
    }
  }, PING_INTERVAL_MS);
}
function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  const exp = Math.min(RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), 6e4);
  const jitter = exp * (0.8 + Math.random() * 0.4);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, Math.round(jitter));
}
function startRemoteRelay(url = DEFAULT_RELAY_URL) {
  if (url) relayUrl = url;
  if (enabled && hostWs) return getRelayStatus();
  enabled = true;
  persistRelayPreference(true);
  if (!getRuntime().getMemberToken()) {
    connected = false;
    return getRelayStatus();
  }
  connect();
  return getRelayStatus();
}
function stopRemoteRelay() {
  enabled = false;
  persistRelayPreference(false);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPing();
  reconnectAttempts = 0;
  unsubs2.forEach((u) => u());
  unsubs2 = [];
  if (hostWs) {
    hostWs.close();
    hostWs = null;
  }
  connected = false;
  clientCount = 0;
}
function getRelayStatus() {
  return {
    enabled,
    connected,
    url: relayUrl,
    username: getRuntime().username,
    clientCount
  };
}
function relayPreferencePath() {
  return join22(app5.getPath("userData"), "relay.json");
}
function getRelayPreference() {
  try {
    const raw = readFileSync2(relayPreferencePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.enabled === true;
  } catch {
    return false;
  }
}
function persistRelayPreference(enabled2) {
  try {
    const dir = app5.getPath("userData");
    if (!existsSync2(dir)) mkdirSync2(dir, { recursive: true });
    writeFileSync2(relayPreferencePath(), JSON.stringify({ enabled: enabled2 }), "utf8");
  } catch (err) {
    console.warn("[\u5C71\u6D77] \u4FDD\u5B58\u4E2D\u7EE7\u5F00\u5173\u504F\u597D\u5931\u8D25\uFF1A", err);
  }
}

// src/main/app-updater.ts
import { app as app6, BrowserWindow as BrowserWindow4, dialog, shell } from "electron";
import { spawn as spawn4 } from "child_process";
import { createHash as createHash3, randomBytes as randomBytes2 } from "crypto";
import { promises as fs20 } from "fs";
import path2 from "path";
import { pathToFileURL } from "url";
var API_BASE = "https://aigateway.bjctykj.com";
var VERSION_CHECK_URL = `${API_BASE}/api/v1/app/version/check`;
var DEVICE_UID_FILE = "device-uid.json";
var UPDATE_AVAILABLE_CHANNEL = "app:update-available";
var lastUpdateCheckResult = null;
function fallbackDeviceUid() {
  const base = [
    app6.getName(),
    process.platform,
    process.arch,
    process.env.HOSTNAME || process.env.COMPUTERNAME || "",
    app6.getPath("home")
  ].join("|");
  const hash = createHash3("sha1").update(base).digest("hex").slice(0, 16);
  return `shanhai_fp_${hash}`;
}
function createDeviceUid() {
  return `shanhai_${randomBytes2(16).toString("hex")}`;
}
function isValidDeviceUid(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && text.length >= 12 && text.length <= 128;
}
async function resolvePersistentDeviceUid() {
  const fallback = fallbackDeviceUid();
  try {
    const dir = app6.getPath("userData");
    const filePath = path2.join(dir, DEVICE_UID_FILE);
    const raw = await fs20.readFile(filePath, "utf-8").catch(() => "");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (isValidDeviceUid(parsed?.uid)) return parsed.uid;
      } catch {
      }
    }
    const uid = createDeviceUid();
    await fs20.mkdir(dir, { recursive: true });
    await fs20.writeFile(
      filePath,
      JSON.stringify({ uid, createdAt: Date.now(), schemaVersion: 1 }, null, 2),
      "utf-8"
    );
    return uid;
  } catch (err) {
    console.warn("[app-update] [uid] persist failed, fallback deterministic uid:", err);
    return fallback;
  }
}
function resolveUpdateType() {
  const envType = String(process.env.SHANHAI_UPDATE_TYPE ?? "").trim();
  if (envType === "Windows" || envType === "macOS") return envType;
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  throw new Error(`\u5F53\u524D\u7CFB\u7EDF ${process.platform} \u6682\u4E0D\u652F\u6301\u66F4\u65B0\u7C7B\u578B\u6620\u5C04\uFF0C\u4EC5\u652F\u6301 macOS / Windows`);
}
function versionParts(version) {
  const parts = String(version).split(".").map((item) => Number.parseInt(item.replace(/[^\d]/g, ""), 10)).map((n) => Number.isFinite(n) ? n : 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}
function compareVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
function versionToBuildCode(version) {
  const parts = versionParts(version);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  const d = parts[3] ?? 0;
  return a * 1e9 + b * 1e6 + c * 1e3 + d;
}
function parseVersionCode(value) {
  const numeric = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(numeric) ? numeric : 0;
}
async function fetchVersionCheck(updateType, currentVersion) {
  const query = new URLSearchParams({ type: updateType, arch: process.arch });
  const requestUrl = `${VERSION_CHECK_URL}?${query.toString()}`;
  console.log("[app-update] [request] gateway version-check:", {
    url: requestUrl,
    type: updateType,
    arch: process.arch,
    currentVersion
  });
  const resp = await fetch(requestUrl, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  console.log("[app-update] [response] version-check status:", {
    status: resp.status,
    statusText: resp.statusText
  });
  if (!resp.ok) {
    throw new Error(`\u7248\u672C\u68C0\u67E5\u5931\u8D25: ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("\u7248\u672C\u68C0\u67E5\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
  }
  const envelope = json;
  if (envelope.code !== 0 && envelope.code !== void 0) {
    throw new Error(`\u7248\u672C\u68C0\u67E5\u5931\u8D25: ${envelope.message || envelope.code}`);
  }
  const data = envelope.data ?? json;
  console.log("[app-update] [response] version-check parsed:", {
    version: data.version,
    version_code: data.version_code,
    download_url: data.download_url || data.downloadUrl,
    forceUpdate: data.forceUpdate ?? data.force_update
  });
  return data;
}
async function fetchMobileApkInfo(packageName) {
  try {
    const query = new URLSearchParams({ type: "Android", packageName });
    const requestUrl = `${VERSION_CHECK_URL}?${query.toString()}`;
    console.log("[app-update] [mobile] request:", { url: requestUrl, packageName });
    const resp = await fetch(requestUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (!resp.ok) {
      console.warn("[app-update] [mobile] API \u8FD4\u56DE\u975E 2xx:", resp.status);
      return null;
    }
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn("[app-update] [mobile] \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
      return null;
    }
    const envelope = json;
    const data = envelope.data ?? json;
    const downloadUrl = String(data.download_url ?? data.downloadUrl ?? "").trim();
    if (!downloadUrl) {
      console.warn("[app-update] [mobile] \u54CD\u5E94\u4E2D\u65E0 download_url");
      return null;
    }
    const result = {
      downloadUrl,
      version: data.version ? String(data.version).trim() : void 0
    };
    console.log("[app-update] [mobile] success:", result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[app-update] [mobile] \u83B7\u53D6 APK \u4E0B\u8F7D\u4FE1\u606F\u5931\u8D25:", msg);
    return null;
  }
}
function resolveDialogWindow(parentWindow) {
  if (parentWindow && !parentWindow.isDestroyed()) return parentWindow;
  const focused = BrowserWindow4.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow4.getAllWindows().find((win) => !win.isDestroyed());
}
async function showDialog(parentWindow, options) {
  const owner = resolveDialogWindow(parentWindow);
  if (owner) return dialog.showMessageBox(owner, options);
  return dialog.showMessageBox(options);
}
function safeFileNameFromUrl(downloadUrl) {
  try {
    const u = new URL(downloadUrl);
    const raw = decodeURIComponent(path2.basename(u.pathname || "").trim());
    if (raw) return raw;
  } catch {
  }
  const ext = process.platform === "win32" ? ".exe" : ".dmg";
  return `Shanhai-AI-update-${Date.now()}${ext}`;
}
async function ensureUniquePath(targetPath) {
  const parsed = path2.parse(targetPath);
  let candidate = targetPath;
  let idx = 1;
  while (true) {
    try {
      await fs20.access(candidate);
      candidate = path2.join(parsed.dir, `${parsed.name} (${idx})${parsed.ext}`);
      idx += 1;
    } catch {
      return candidate;
    }
  }
}
async function downloadUpdatePackage(downloadUrl, parentWindow, expectedSha256) {
  const owner = resolveDialogWindow(parentWindow);
  const win = owner ?? BrowserWindow4.getAllWindows().find((item) => !item.isDestroyed());
  if (!win) throw new Error("\u672A\u627E\u5230\u53EF\u7528\u7A97\u53E3\uFF0C\u65E0\u6CD5\u663E\u793A\u4E0B\u8F7D\u8FDB\u5EA6");
  let normalizedUrl = String(downloadUrl ?? "").trim();
  if (normalizedUrl && !/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = `https://${normalizedUrl}`;
  }
  normalizedUrl = normalizedUrl.replace(/\s/g, "%20");
  const downloadsDir = app6.getPath("downloads");
  await fs20.mkdir(downloadsDir, { recursive: true });
  const fileName = safeFileNameFromUrl(normalizedUrl);
  const savePath = await ensureUniquePath(path2.join(downloadsDir, fileName));
  console.log("[app-update] [download] start:", { downloadUrl: normalizedUrl, savePath });
  return await new Promise((resolve4, reject) => {
    const session = win.webContents.session;
    let started = false;
    let lastLogAt = 0;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("\u4E0B\u8F7D\u8D85\u65F6\uFF1A\u672A\u6536\u5230\u4E0B\u8F7D\u542F\u52A8\u4E8B\u4EF6"));
    }, 1e4);
    const cleanup = () => {
      clearTimeout(timeout);
      session.removeListener("will-download", onWillDownload);
      if (!win.isDestroyed()) win.setProgressBar(-1);
    };
    const onWillDownload = (_event, item) => {
      if (started) return;
      const urlMatch = item.getURL() === normalizedUrl || item.getURLChain?.().includes(normalizedUrl);
      if (!urlMatch) return;
      started = true;
      clearTimeout(timeout);
      item.setSavePath(savePath);
      if (!win.isDestroyed()) win.setProgressBar(0.01);
      item.on("updated", (_evt, state2) => {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const progress = total > 0 ? received / total : -1;
        if (!win.isDestroyed()) {
          if (progress >= 0) win.setProgressBar(Math.max(0.01, Math.min(progress, 0.99)));
          else win.setProgressBar(2);
        }
        const now = Date.now();
        if (now - lastLogAt >= 1e3) {
          lastLogAt = now;
          console.log("[app-update] [download] progress:", {
            state: state2,
            receivedBytes: received,
            totalBytes: total,
            progressPercent: progress >= 0 ? Number((progress * 100).toFixed(1)) : void 0
          });
        }
      });
      item.once("done", (_evt, state2) => {
        cleanup();
        const finalPath = item.getSavePath() || savePath;
        console.log("[app-update] [download] done:", { state: state2, filePath: finalPath });
        if (state2 === "completed") {
          void (async () => {
            try {
              if (expectedSha256) {
                const fileBuffer = await fs20.readFile(finalPath);
                const actualHash = createHash3("sha256").update(fileBuffer).digest("hex");
                console.log("[app-update] [download] sha256 verify:", {
                  expected: expectedSha256,
                  actual: actualHash
                });
                if (actualHash.toLowerCase() !== expectedSha256.toLowerCase()) {
                  reject(new Error(`\u6587\u4EF6\u6821\u9A8C\u5931\u8D25\uFF1ASHA256 \u4E0D\u5339\u914D
\u671F\u671B: ${expectedSha256}
\u5B9E\u9645: ${actualHash}`));
                  return;
                }
                console.log("[app-update] [download] sha256 verified OK");
              }
              resolve4(finalPath);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
          return;
        }
        reject(new Error(`\u4E0B\u8F7D\u5931\u8D25: ${state2}`));
      });
    };
    session.on("will-download", onWillDownload);
    try {
      void session.downloadURL(normalizedUrl);
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
async function openInstallerPackage(filePath) {
  const target = String(filePath ?? "").trim();
  if (!target) throw new Error("\u5B89\u88C5\u5305\u8DEF\u5F84\u4E3A\u7A7A");
  await fs20.access(target).catch(() => {
    throw new Error(`\u5B89\u88C5\u5305\u4E0D\u5B58\u5728: ${target}`);
  });
  console.log("[app-update] [install] openPath:", { filePath: target });
  const openPathErr = await shell.openPath(target);
  if (!openPathErr) {
    console.log("[app-update] [install] openPath success");
    return;
  }
  console.warn("[app-update] [install] openPath failed, fallback openExternal(file://):", openPathErr);
  const fileUrl = pathToFileURL(target).toString();
  try {
    await shell.openExternal(fileUrl);
    console.log("[app-update] [install] fallback openExternal success:", { fileUrl });
    return;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`\u6253\u5F00\u5B89\u88C5\u5305\u5931\u8D25: ${openPathErr || detail}`);
  }
}
function shellQuote(text) {
  return `'${String(text ?? "").replace(/'/g, `'\\''`)}'`;
}
function scheduleInstallerLaunchAfterQuit(filePath) {
  if (process.platform !== "darwin") return false;
  const target = String(filePath ?? "").trim();
  if (!target) return false;
  try {
    const appName = shellQuote(app6.getName());
    const cmd = `for i in $(seq 1 120); do if ! pgrep -x ${appName} >/dev/null 2>&1; then break; fi; sleep 0.2; done; open ${shellQuote(target)}`;
    const child = spawn4("/bin/sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("[app-update] [install] scheduled launch after quit:", { filePath: target });
    return true;
  } catch (err) {
    console.error("[app-update] [install] failed to schedule launch after quit:", err);
    return false;
  }
}
async function checkAndPromptForUpdate(options = {}) {
  const manual = Boolean(options.manual);
  const currentVersion = app6.getVersion();
  const checkedAt = Date.now();
  const uid = await resolvePersistentDeviceUid();
  const updateType = resolveUpdateType();
  console.log("[app-update] check start:", { manual, currentVersion, updateType, uid });
  try {
    const latest = await fetchVersionCheck(updateType, currentVersion);
    const latestVersion = String(latest.version ?? "").trim();
    const latestVersionCode = String(latest.version_code ?? "").trim();
    const currentBuildCode = versionToBuildCode(currentVersion);
    const remoteBuildCode = parseVersionCode(latest.version_code);
    const versionCmp = latestVersion ? compareVersion(latestVersion, currentVersion) : 0;
    const hasUpdate = Boolean(
      latestVersion && (versionCmp > 0 || versionCmp === 0 && remoteBuildCode > currentBuildCode)
    );
    const releaseNotes = String(latest.release_notes ?? latest.releaseNotes ?? "").trim();
    const downloadUrl = String(latest.download_url ?? latest.downloadUrl ?? "").trim();
    const forceUpdate = Boolean(latest.forceUpdate ?? latest.force_update);
    const sha256Sum = String(latest.sha256_sum ?? latest.sha256Sum ?? "").trim() || void 0;
    let downloadTriggered = false;
    if (hasUpdate && manual) {
      const detailLines = [
        `\u5F53\u524D\u7248\u672C\uFF1Av${currentVersion}`,
        `\u6700\u65B0\u7248\u672C\uFF1Av${latestVersion}${latestVersionCode ? ` (${latestVersionCode})` : ""}`,
        releaseNotes ? `\u66F4\u65B0\u5185\u5BB9\uFF1A
${releaseNotes}` : "",
        forceUpdate ? "\u8BE5\u7248\u672C\u6807\u8BB0\u4E3A\u5F3A\u5236\u66F4\u65B0\u3002" : ""
      ].filter(Boolean);
      const result = await showDialog(options.parentWindow, {
        type: "info",
        title: "\u53D1\u73B0\u65B0\u7248\u672C",
        message: `\u68C0\u6D4B\u5230\u65B0\u7248\u672C v${latestVersion}`,
        detail: detailLines.join("\n\n"),
        buttons: ["\u7A0D\u540E", "\u4E0B\u8F7D\u66F4\u65B0"],
        cancelId: 0,
        defaultId: 1,
        noLink: true
      });
      if (result.response === 1 && downloadUrl) {
        downloadTriggered = true;
        const downloadedFile = await downloadUpdatePackage(downloadUrl, options.parentWindow, sha256Sum);
        const install = await showDialog(options.parentWindow, {
          type: "question",
          title: "\u66F4\u65B0\u5305\u4E0B\u8F7D\u5B8C\u6210",
          message: "\u5B89\u88C5\u66F4\u65B0\u9700\u8981\u5148\u9000\u51FA\u5C71\u6D77\u3002\u662F\u5426\u73B0\u5728\u9000\u51FA\u5E76\u5F00\u59CB\u5B89\u88C5\uFF1F",
          detail: downloadedFile,
          buttons: ["\u7A0D\u540E\u5B89\u88C5", "\u7ACB\u5373\u5B89\u88C5\uFF08\u9000\u51FA\u5E94\u7528\uFF09"],
          cancelId: 0,
          defaultId: 1,
          noLink: true
        });
        if (install.response === 1) {
          if (process.platform === "darwin") {
            const scheduled = scheduleInstallerLaunchAfterQuit(downloadedFile);
            if (!scheduled) {
              throw new Error("\u5B89\u88C5\u542F\u52A8\u5931\u8D25\uFF1A\u65E0\u6CD5\u5B89\u6392\u9000\u51FA\u540E\u81EA\u52A8\u6253\u5F00\u5B89\u88C5\u5305");
            }
            setTimeout(() => {
              app6.quit();
            }, 120);
          } else if (process.platform === "win32") {
            await openInstallerPackage(downloadedFile);
            setTimeout(() => {
              app6.quit();
            }, 200);
          } else {
            await openInstallerPackage(downloadedFile);
          }
        }
      }
    } else if (manual) {
      await showDialog(options.parentWindow, {
        type: "info",
        title: "\u68C0\u67E5\u66F4\u65B0",
        message: "\u5F53\u524D\u5DF2\u662F\u6700\u65B0\u7248\u672C",
        detail: `\u5F53\u524D\u7248\u672C\uFF1Av${currentVersion}`,
        buttons: ["\u77E5\u9053\u4E86"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
    }
    const output = {
      success: true,
      checkedAt,
      currentVersion,
      hasUpdate,
      latestVersion: latestVersion || void 0,
      latestVersionCode: latestVersionCode || void 0,
      releaseNotes: releaseNotes || void 0,
      downloadUrl: downloadUrl || void 0,
      forceUpdate,
      downloadTriggered,
      message: hasUpdate ? "\u53D1\u73B0\u65B0\u7248\u672C" : "\u5F53\u524D\u5DF2\u662F\u6700\u65B0\u7248\u672C"
    };
    lastUpdateCheckResult = output;
    console.log("[app-update] check result:", output);
    if (output.hasUpdate && options.parentWindow && !options.parentWindow.isDestroyed()) {
      options.parentWindow.webContents.send(UPDATE_AVAILABLE_CHANNEL, output);
    }
    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[app-update] check failed:", message);
    if (manual) {
      try {
        await showDialog(options.parentWindow, {
          type: "error",
          title: "\u68C0\u67E5\u66F4\u65B0\u5931\u8D25",
          message: "\u65E0\u6CD5\u8FDE\u63A5\u66F4\u65B0\u670D\u52A1\u5668",
          detail: message,
          buttons: ["\u77E5\u9053\u4E86"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
      } catch {
      }
    }
    const failed = {
      success: false,
      checkedAt,
      currentVersion,
      hasUpdate: false,
      message
    };
    lastUpdateCheckResult = failed;
    return failed;
  }
}
function getLastUpdateCheckResult() {
  return lastUpdateCheckResult;
}
var AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1e3;
function scheduleStartupUpdateCheck(parentWindow) {
  const startupDelayMs = 1e3;
  const runCheck = () => {
    void checkAndPromptForUpdate({ manual: false, parentWindow }).catch((err) => {
      console.info("[app-update] \u81EA\u52A8\u68C0\u67E5\u66F4\u65B0\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  };
  setTimeout(() => {
    runCheck();
    setInterval(runCheck, AUTO_CHECK_INTERVAL_MS);
  }, startupDelayMs);
}

// src/main/ipc-handlers.ts
function registerIpc() {
  const runtime2 = getRuntime();
  ipcMain.handle("auth:status", async () => ({ loggedIn: runtime2.loggedIn, username: runtime2.username }));
  ipcMain.handle("auth:login", async (_e, u, p) => {
    const result = await runtime2.login(u, p);
    if (getRelayPreference()) startRemoteRelay();
    return result;
  });
  ipcMain.handle("auth:logout", async () => runtime2.logout());
  ipcMain.handle("auth:listModels", async () => runtime2.listModels());
  ipcMain.handle("auth:refreshModels", async () => runtime2.refreshModels());
  ipcMain.handle("session:list", async () => runtime2.listSessions());
  ipcMain.handle("session:create", async (_e, title, workdir) => runtime2.createSession(title, workdir));
  ipcMain.handle("session:switch", async (_e, id) => runtime2.switchSession(id));
  ipcMain.handle("session:rename", async (_e, id, title) => runtime2.renameSession(id, title));
  ipcMain.handle("session:delete", async (_e, id) => runtime2.deleteSession(id));
  ipcMain.handle("session:workdir", async (_e, id) => runtime2.getSessionWorkdir(id));
  ipcMain.handle("session:setWorkdir", async (_e, id, workdir) => runtime2.setSessionWorkdir(id, workdir));
  ipcMain.handle("session:history", async (_e, id) => runtime2.getSessionHistory(id));
  ipcMain.handle("session:trace", async (_e, id) => runtime2.getSessionTrace(id));
  ipcMain.handle("session:incomplete", async (_e, sessionId) => runtime2.hasIncompleteTurn(sessionId));
  ipcMain.handle("session:retry-snapshot", async (_e, sessionId) => runtime2.hasRetrySnapshot(sessionId));
  ipcMain.handle("file:saveUpload", async (_e, fileName, dataBase64) => runtime2.saveUploadedFile(fileName, dataBase64));
  ipcMain.handle("image:upload", async (_e, imageBase64, mimeType) => runtime2.uploadImage(imageBase64, mimeType));
  ipcMain.handle("browser:list", async (_e, sessionId) => runtime2.listBrowserWindows(sessionId));
  ipcMain.handle("browser:show", async (_e, appId) => runtime2.showBrowserWindow(appId));
  ipcMain.handle("browser:close", async (_e, appId) => runtime2.closeBrowserWindow(appId));
  ipcMain.handle("deepseek-bridge:status", async () => runtime2.getDeepSeekBridgeStatus());
  ipcMain.handle("deepseek-bridge:open", async () => runtime2.openDeepSeekBridge());
  ipcMain.handle("deepseek-bridge:inject", async () => runtime2.injectDeepSeekBridge());
  ipcMain.handle("userTerminal:create", async (_e, sessionId, name) => runtime2.userTerminalCreate(sessionId, name));
  ipcMain.handle("userTerminal:list", async (_e, sessionId) => runtime2.userTerminalList(sessionId));
  ipcMain.handle("userTerminal:close", async (_e, sessionId, terminalId) => runtime2.userTerminalClose(sessionId, terminalId));
  ipcMain.on("userTerminal:write", (_e, sessionId, terminalId, data) => runtime2.userTerminalWrite(sessionId, terminalId, data));
  ipcMain.on("userTerminal:resize", (_e, sessionId, terminalId, cols, rows) => runtime2.userTerminalResize(sessionId, terminalId, cols, rows));
  ipcMain.handle(
    "approval:respond",
    async (_e, outcome, requestId) => runtime2.respondApproval(outcome, requestId)
  );
  ipcMain.handle("approval:getPolicy", async () => runtime2.getApprovalPolicy());
  ipcMain.handle("approval:setPolicy", async (_e, policy) => runtime2.setApprovalPolicy(policy));
  ipcMain.handle("ask:respond", async (_e, requestId, answer) => runtime2.respondAsk(requestId, answer));
  ipcMain.handle("ask:cancel", async (_e, requestId) => runtime2.cancelAsk(requestId));
  ipcMain.handle("selfmod:inspect", async (_e, sessionId) => runtime2.selfmodInspect(sessionId));
  ipcMain.handle("selfmod:respond", async (_e, requestId, approved) => runtime2.respondClientRun(requestId, approved));
  ipcMain.handle("memory:list", async (_e, sessionId) => runtime2.listMemory(sessionId));
  ipcMain.handle("memory:remove", async (_e, id) => runtime2.removeMemory(id));
  ipcMain.handle("settings:get", async () => runtime2.getSettings());
  ipcMain.handle("settings:set", async (_e, patch) => runtime2.setSettings(patch));
  ipcMain.handle("trace:http-list", async (_e, id) => runtime2.getHttpTrace(id));
  ipcMain.handle("trace:http-clear", async (_e, id) => runtime2.clearHttpTrace(id));
  ipcMain.on("trace:http-path", (e, id) => {
    e.returnValue = runtime2.getHttpTracePath(id);
  });
  ipcMain.handle("trace:open-dir", async () => {
    const dir = runtime2.getTraceDir();
    await shell2.openPath(dir);
    return dir;
  });
  ipcMain.handle("chat:run", async (_e, message, attachments) => {
    try {
      return await runtime2.run(message, { attachments });
    } catch (err) {
      console.error("[ipc] chat:run \u5931\u8D25:", err);
      throw err;
    }
  });
  ipcMain.handle(
    "chat:resend",
    async (_e, sessionId, userMessageIndex, newContent) => runtime2.resend(sessionId, userMessageIndex, newContent)
  );
  ipcMain.handle("chat:resume", async (_e, sessionId) => runtime2.resume(sessionId));
  ipcMain.handle("chat:retry", async (_e, sessionId) => runtime2.retrySession(sessionId));
  ipcMain.handle("chat:abandon", async (_e, sessionId) => runtime2.abandonSession(sessionId));
  ipcMain.handle("chat:inject", async (_e, sessionId, message) => runtime2.injectMessage(sessionId, message));
  ipcMain.handle("chat:stop", async () => runtime2.stop());
  ipcMain.handle("supervisor:run", async (_e, message, attachments) => {
    try {
      return await runtime2.runSupervisor(message, attachments);
    } catch (err) {
      console.error("[ipc] supervisor:run \u5931\u8D25:", err);
      throw err;
    }
  });
  ipcMain.handle("supervisor:history", async () => runtime2.getSessionHistory(SUPERVISOR_ID));
  ipcMain.handle("supervisor:getModel", async () => runtime2.getSupervisorModel());
  ipcMain.handle("supervisor:getApproval", async () => runtime2.getSupervisorApprovalPolicy());
  ipcMain.handle("supervisor:setModel", async (_e, id) => runtime2.setSupervisorModel(id));
  ipcMain.handle("supervisor:setApproval", async (_e, policy) => runtime2.setSupervisorApprovalPolicy(policy));
  ipcMain.handle("supervisor:hideToBubble", async () => hideSupervisorToBubble());
  ipcMain.handle("supervisor:showFromBubble", async () => showSupervisorFromBubble());
  ipcMain.on("supervisor:moveBubble", (_e, dx, dy) => moveSupervisorBubble(dx, dy));
  ipcMain.handle("model:switch", async (_e, id) => runtime2.switchModel(id));
  ipcMain.handle("model:current", async () => runtime2.getCurrentModelId());
  ipcMain.handle(
    "model:addCustom",
    async (_e, input) => runtime2.addCustomModel(input)
  );
  ipcMain.handle(
    "model:updateCustom",
    async (_e, id, input) => runtime2.updateCustomModel(id, input)
  );
  ipcMain.handle("model:removeCustom", async (_e, id) => runtime2.removeCustomModel(id));
  ipcMain.handle("token:stats", async (_e, sessionId) => runtime2.getTokenStats(sessionId));
  ipcMain.handle("voice:speak", async (_e, text) => {
    await runtime2.voice.synthesize(text);
  });
  ipcMain.handle("voice:transcribe", async (_e, audioBase64, format) => runtime2.transcribeAudio(audioBase64, format));
  ipcMain.handle("dialog:selectDirectory", async (e, defaultPath) => {
    const options = {
      title: "\u9009\u62E9\u5DE5\u4F5C\u76EE\u5F55",
      defaultPath: defaultPath || app7.getPath("home"),
      properties: ["openDirectory", "createDirectory"]
    };
    const win = BrowserWindow5.fromWebContents(e.sender);
    const result = win ? await dialog2.showOpenDialog(win, options) : await dialog2.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("window:openApp", async (_e, appId) => openApp(appId));
  ipcMain.handle("window:closeApp", async (_e, appId) => closeApp(appId));
  ipcMain.on("window:restoreAboveDesktop", () => restoreAboveDesktop());
  ipcMain.handle("window:hideChat", async () => hideChatWindow());
  ipcMain.handle("window:hideSelf", (e) => {
    const win = BrowserWindow5.fromWebContents(e.sender);
    win?.hide();
  });
  ipcMain.on("window:minimize", (e) => minimizeWindow(BrowserWindow5.fromWebContents(e.sender)));
  ipcMain.handle("window:toggleMaximize", (e) => toggleMaximizeWindow(BrowserWindow5.fromWebContents(e.sender)));
  ipcMain.on("window:resizeDock", (_e, width, height) => resizeDockWindow(width, height));
  ipcMain.handle("window:hideToDesktop", async () => hideToSystemDesktop());
  ipcMain.on("theme:set", (_e, theme) => {
    for (const win of BrowserWindow5.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("ui:theme", theme);
    }
  });
  ipcMain.handle("ui:getState", async (e) => {
    const win = BrowserWindow5.fromWebContents(e.sender);
    const type = win ? getWindowType(win) : void 0;
    return filterUiStateForWindow(type, getUiState());
  });
  ipcMain.handle("ui:patch", async (_e, patch) => patchUiState(patch));
  ipcMain.handle("wallpaper:get", async () => getWallpaper());
  ipcMain.handle("wallpaper:set", async (_e, wallpaper) => {
    setWallpaper(wallpaper);
    patchUiState({ wallpaper });
    return wallpaper;
  });
  ipcMain.handle("wallpaper:listSystem", async () => listSystemWallpapers());
  ipcMain.handle("wallpaper:applySystem", async (_e, sourcePath) => {
    const wallpaper = await applySystemWallpaper(sourcePath);
    setWallpaper(wallpaper);
    patchUiState({ wallpaper });
    return wallpaper;
  });
  ipcMain.handle("remote:enable", async (_e, port) => startRemoteServer(port));
  ipcMain.handle("remote:disable", async () => {
    stopRemoteServer();
    return getRemoteStatus();
  });
  ipcMain.handle("remote:status", async () => getRemoteStatus());
  ipcMain.handle("remote:relayEnable", async (_e, url) => startRemoteRelay(url));
  ipcMain.handle("remote:relayDisable", async () => {
    stopRemoteRelay();
    return getRelayStatus();
  });
  ipcMain.handle("remote:relayStatus", async () => getRelayStatus());
  ipcMain.handle("app:get-version", async () => app7.getVersion());
  ipcMain.handle(
    "app:check-update",
    async (e) => checkAndPromptForUpdate({ manual: true, parentWindow: BrowserWindow5.fromWebContents(e.sender) })
  );
  ipcMain.handle("app:get-update-status", async () => getLastUpdateCheckResult());
  ipcMain.handle("mobile:get-apk-info", async (_e, packageName) => fetchMobileApkInfo(packageName));
}

// src/main/index.ts
var TOGGLE_SHORTCUT = "CommandOrControl+Shift+Space";
var tray = null;
var isQuitting2 = false;
function createTrayIcon() {
  const image = nativeImage.createFromPath(ICON_PATH);
  const scaled = image.resize({ width: 18, height: 18 });
  return scaled;
}
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("\u5C71\u6D77 AI \u52A9\u624B");
  tray.setContextMenu(
    Menu2.buildFromTemplate([
      { label: "\u663E\u793A\u4E3B\u7A97\u53E3", click: () => showChatWindow() },
      { type: "separator" },
      {
        label: "\u9000\u51FA\u5C71\u6D77",
        click: () => {
          isQuitting2 = true;
          app8.quit();
        }
      }
    ])
  );
  tray.on("click", () => showChatWindow());
}
function registerToggleShortcut() {
  const ok = globalShortcut.register(TOGGLE_SHORTCUT, () => toggleChatWindow());
  if (!ok) {
    console.warn(`[\u5C71\u6D77] \u5168\u5C40\u5FEB\u6377\u952E ${TOGGLE_SHORTCUT} \u6CE8\u518C\u5931\u8D25\uFF08\u53EF\u80FD\u88AB\u5176\u4ED6\u5E94\u7528\u5360\u7528\uFF09`);
  }
}
app8.whenReady().then(async () => {
  setRuntime(await bootHost());
  initUiStore(getRuntime());
  registerIpc();
  if (getRelayPreference()) startRemoteRelay();
  const desktopWin = createWindow({ type: "desktop" });
  await loadWindowContent(desktopWin);
  const dockWin = createWindow({ type: "dock" });
  await loadWindowContent(dockWin);
  const chatWin = createWindow({ type: "chat", show: false });
  await loadWindowContent(chatWin);
  const supervisorWin = createWindow({ type: "supervisor" });
  await loadWindowContent(supervisorWin);
  registerPush();
  scheduleStartupUpdateCheck(chatWin);
  await getRuntime().restoreInstalledPlugins();
  try {
    if (process.platform === "darwin" && app8.dock) app8.dock.setIcon(ICON_PATH);
  } catch (err) {
    console.warn("[\u5C71\u6D77] \u8BBE\u7F6E Dock \u56FE\u6807\u5931\u8D25\uFF1A", err);
  }
  try {
    createTray();
  } catch (err) {
    console.warn("[\u5C71\u6D77] \u521B\u5EFA\u6258\u76D8\u5931\u8D25\uFF1A", err);
  }
  registerToggleShortcut();
  app8.on("browser-window-focus", () => ensureDesktopLayer());
  app8.on("activate", () => {
    if (app8.isReady()) showChatWindow();
  });
});
app8.on("before-quit", () => {
  isQuitting2 = true;
});
app8.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
app8.on("window-all-closed", () => {
  if (process.platform !== "darwin") app8.quit();
});
//# sourceMappingURL=index.js.map