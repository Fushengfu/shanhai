/**
 * DeepSeek 网页版桥接脚本（注入到 chat.deepseek.com 页面执行）。
 *
 * 复用页面自身的 PoW 求解与网络栈：通过 DOM 触发对话、轮询 DOM 读取 AI 回复文本。
 * 结果回传采用「DOM 轮询」（文本连续稳定 + 发送按钮复位判定完成）——这是 Taco 原版
 * bridge.js 验证过的可靠路径，不依赖 DeepSeek 私有 SSE 格式（该格式易变且非 OpenAI 结构）。
 *
 * SSE 监听独立成一条「诊断通道」：hook fetch 把对话请求的原始 SSE 文本记录到
 * window.__dsSseLog（环形，只记不解析），供排查问题时读取，不参与结果回传。
 *
 * 与主进程的通信：主进程通过 CDP Runtime.evaluate 直接调用页面里的
 * `window.__dsChat(prompt, opts)`（返回 Promise，CDP awaitPromise 拿到结果）。
 */

/**
 * 生成桥接脚本（IIFE）。无外部依赖、不依赖本地服务地址。
 */
export function buildBridgeScript(): string {
  return `(function () {
  var MODE_LABEL = { expert: '专家模式', fast: '快速模式', vision: '识图模式' };

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
    var target = toggles.find(function (t) { return (t.innerText || '').indexOf('深度思考') >= 0; });
    if (!target) return false;
    var selected = target.getAttribute('aria-pressed') === 'true' || target.className.indexOf('--selected') >= 0;
    if (selected === !!enabled) return true;
    target.click();
    return true;
  }

  // —— SSE 诊断通道：hook fetch 只记录原始 SSE 文本（不解析、不参与结果回传）——
  // DeepSeek 网页版 SSE 是其私有格式（非 OpenAI choices 结构），解析它易出错且易随改版失效；
  // 这里只做「原始记录」供排查问题，结果回传统一走下面的 DOM 轮询。
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
            // 必须 clone 再读，不抢占页面自身的 ReadableStream
            captureStream(url, res.clone());
          } catch (e) {
            /* clone 失败（body 已被消费）时静默跳过诊断记录 */
          }
        }
      }).catch(function () {});
    }
    return p;
  };

  // —— 发送一条消息并等待 AI 回复（DOM 轮询：快照在发送前取，发送后立即开始）——
  function dsChat(prompt, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (opts.mode) setMode(opts.mode);
      if (opts.thinking != null) setThinking(!!opts.thinking);

      var ta = document.querySelector('textarea');
      if (!ta) return reject(new Error('no textarea found'));

      // 发送前快照：记录最后一条回复的文本（虚拟列表会回收历史消息，不能只靠数量判断）
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
        // 检测到新回复：数量增加，或最后一条文本相对发送前快照发生变化
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
})();`
}

/** 判断页面是否已注入 bridge（宿主侧检测用） */
export const BRIDGE_READY_CHECK = `typeof window.__dsChat === 'function'`
