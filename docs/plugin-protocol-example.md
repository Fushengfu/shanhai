# 山海插件脚手架模板（复制即用）

> 配合《山海插件协议规范（权威版）》使用。下面每个示例都是**完整、可直接复制**的 host 半 / client 半代码。
> 开发新插件时：先读 `docs/plugin-protocol.md` 理解契约，再从本文复制最接近的骨架改。
>
> ⚠️ 通用规则：client 半在浏览器里 `new Function` 编译，**不经过 JSX 编译**，组件一律用 `React.createElement(...)`，禁止写 `<div>`。

---

## 示例 1：UI 插槽形态 —— 往聊天窗口输入框下方加一个小组件

**效果**：在输入框下方（`composer.below`）追加一个「会话徽标」小组件，实时显示当前会话 id 与输入框字数。

**host 半（可选，本例不需要，留空）**

**client 半（`client` 参数）**：

```js
function (React, slots, useUIContext) {
  // 1) 定义组件（可在组件内用 useUIContext() 读框架状态）—— 可改这里
  function SessionBadge() {
    var ctx = useUIContext()
    var text = ctx.input || ''
    return React.createElement(
      'div',
      {
        style: {
          padding: '8px 14px',
          margin: '8px 0 0',
          borderRadius: 8,
          background: 'var(--bg-panel)',
          color: 'var(--text-muted)',
          fontSize: 12,
          border: '1px solid var(--border)',
        },
      },
      '会话: ' + (ctx.currentSessionId || '(无)') + ' · 输入框 ' + text.length + ' 字'
    )
  }
  // 2) 挂到追加型插槽 composer.below（可改成 header.actions / chat.below / composer.actions）
  slots.register({ slot: 'composer.below', id: 'session-badge', component: SessionBadge })
  // 3) 可选：返回 disposer（卸载时调用）
  return function () {
    console.log('session-badge 已卸载')
  }
}
```

**`plugin_define` 参数**：

```json
{
  "name": "会话徽标",
  "purpose": "在输入框下方追加一个显示当前会话与字数的徽标",
  "client": "<上面 client 半代码>"
}
```

**可改点**：
- `slot`：换追加型插槽名（`composer.below` / `composer.actions` / `header.actions` / `chat.below`）；换覆盖型插槽名（`shell.statusbar` 等）则整体替换该区块。
- `component`：换成你的组件；组件内 `useUIContext()` 可读 `input` / `currentSessionId` / `cur.items` / `models` / `send` 等（完整字段见 `ui-context.tsx` 的 `UIContextValue`）。

---

## 示例 2：窗口应用形态 —— 开独立窗口 + client 半渲染内容

**效果**：安装后弹出独立窗口，窗口内容由 client 半渲染，带一个「关闭」按钮；卸载时窗口自动关闭。

**host 半（`code` 参数）**：

```js
module.exports = function (ctx) {
  // 打开本插件的独立窗口（appId 缺省 = 插件 id；install 时即开窗）
  ctx.openWindow()
  // 返回 disposer：撤销（stop/uninstall）时自动关闭窗口（openWindow 已自动注册关闭）
  return function () {
    // 可在此做额外清理（可选）
  }
}
```

**client 半（`client` 参数）**：

```js
function (React, helpers) {
  // 必须 return 一个组件函数（不能 return 对象 / 箭头函数返回对象）
  return function DockDemoWindow() {
    return React.createElement(
      'div',
      { style: { padding: 32, fontFamily: 'system-ui, sans-serif', color: 'var(--text)' } },
      React.createElement('h1', { style: { fontSize: 20, margin: '0 0 12px' } }, 'Dock 图标测试成功'),
      React.createElement('p', { style: { color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 } },
        '这是「窗口应用形态」插件的独立窗口，client 半已正常渲染。'),
      React.createElement('p', { style: { color: 'var(--text-faint)', fontSize: 12 } },
        'appId = ' + helpers.appId + ' · name = ' + helpers.name),
      React.createElement(
        'button',
        {
          onClick: helpers.close,
          style: {
            marginTop: 16,
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-panel)',
            color: 'var(--text)',
            cursor: 'pointer',
          },
        },
        '关闭窗口（helpers.close）'
      )
    )
  }
}
```

**`plugin_define` 参数**：

```json
{
  "name": "Dock 图标测试",
  "purpose": "打开独立窗口验证窗口插件通道",
  "code": "<上面 host 半代码>",
  "client": "<上面 client 半代码>"
}
```

**可改点**：
- 窗口标题文案：改 `React.createElement('h1', ...)` 的文字。
- 开窗时机：若不想 install 时立即弹窗（改「点 Dock 图标才开」），**删掉 host 半里的 `ctx.openWindow()`**，开窗交给 Dock 图标点击触发的 `openApp`。
- 关闭按钮：`helpers.close` 调用 `window.shanhai.closeApp(helpers.appId)`，卸载时也会自动关闭。

---

## 完整闭环（两个示例通用）

```
plugin_define（定义，拿 dyn-<n>）
  → plugin_test（自测：临时运行 + 撤回，验证无误）
  → plugin_install（安装进内核，跨会话/跨重启留存，拿持久化 id）
  → plugin_uninstall（卸载：撤销运行 + 删落盘 + 关窗口）
```

- `plugin_run` 仅临时运行、不持久化；`plugin_stop` 撤回但保留定义。
- 安装落盘到 `~/.shanhai/plugins/<persistId>/manifest.json`，重启后自动恢复（免审批）。
