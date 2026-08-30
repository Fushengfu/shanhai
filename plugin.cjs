"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/preload/plugin.ts
var plugin_exports = {};
module.exports = __toCommonJS(plugin_exports);
var import_electron = require("electron");
function readArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : void 0;
}
var windowType = "app";
var windowAppId = readArg("--shanhai-app-id=");
var hostBridge = {
  windowType,
  platform: process.platform,
  windowAppId,
  getPluginApp: (appId) => import_electron.ipcRenderer.invoke("plugin-app:get", appId),
  closeApp: (appId) => import_electron.ipcRenderer.invoke("window:closeApp", appId),
  minimizeWindow: () => import_electron.ipcRenderer.send("window:minimize"),
  toggleMaximizeWindow: () => import_electron.ipcRenderer.invoke("window:toggleMaximize"),
  /** 订阅主题变更（主进程 ui:theme 广播给所有窗口），返回取消订阅函数。插件窗口据此跟随内置应用亮/暗切换 */
  onThemeChange: (cb) => {
    const listener = (_e, theme) => cb(theme);
    import_electron.ipcRenderer.on("ui:theme", listener);
    return () => import_electron.ipcRenderer.removeListener("ui:theme", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("shanhai", hostBridge);
var invoke = (capability, ...args) => import_electron.ipcRenderer.invoke("plugin:invoke", capability, ...args);
var pluginBridge = {
  pluginAppId: windowAppId,
  getVersion: () => invoke("getVersion"),
  clipboardWriteText: (text) => invoke("clipboardWriteText", text),
  clipboardReadText: () => invoke("clipboardReadText"),
  speak: (text) => invoke("speak", text),
  selectDirectory: (defaultPath) => invoke("selectDirectory", defaultPath),
  listSessions: () => invoke("listSessions"),
  listMemory: (sessionId) => invoke("listMemory", sessionId),
  getUiState: () => invoke("getUiState"),
  closeApp: () => invoke("closeApp"),
  getWallpaper: () => invoke("getWallpaper"),
  getTokenStats: (sessionId) => invoke("getTokenStats", sessionId),
  invokePluginService: (name, ...rest) => invoke("invokePluginService", name, rest),
  modelCall: (input) => invoke("modelCall", input)
};
import_electron.contextBridge.exposeInMainWorld("shanhaiPlugin", pluginBridge);
//# sourceMappingURL=plugin.cjs.map