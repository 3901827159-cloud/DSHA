// WebBridge content script v3: channel + login sentinel + input automation +
// page-world capture relay. The fetch tee moved OUT of this file on purpose:
// content scripts live in an ISOLATED world, so wrapping window.fetch here
// could never see the page's own traffic (that is why sends worked but no
// reply chunk ever came back). capture.js wraps the real page fetch (manifest
// world:MAIN, or the inline fallback below) and posts chunks back to us.
(() => {
  const LOGIN_COMPOSER = "textarea.ds-scroll-area";
  const SEND_BUTTON = "div[role='button']:has(path[d^='M8.3125'])";
  const STOP_BUTTON = "div[role='button']:has(path[d^='M2 4.88'])";

  // ---- resilient port (v2): the native delegate may register AFTER page load;
  //      reconnect on drop and retry on failure (2s backoff). ----
  let port = null;
  const send = (o) => { try { if (port) port.postMessage(o); } catch (e) { /* port down: never break the page */ } };

  // ---- login judgement (site declaration: guest page = /sign_in without textarea;
  //      logged-in page has a visible textarea.ds-scroll-area) ----
  function judgeLoggedIn() {
    if (/sign|login/i.test(location.pathname)) return false;
    const el = document.querySelector(LOGIN_COMPOSER);
    return Boolean(el && el.offsetParent !== null);
  }
  let lastLogin = null;
  const reportLogin = (force) => {
    const now = judgeLoggedIn();
    if (force || now !== lastLogin) { lastLogin = now; send({ type: "wb-login", loggedIn: now, url: location.href }); }
  };
  setInterval(() => reportLogin(false), 1500);
  document.addEventListener("DOMContentLoaded", () => reportLogin(true));

  // ---- capture relay: capture.js (page world) posts SSE chunks here;
  //      forward them over the port with the unchanged wb-chunk contract. ----
  let capReady = false;
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.__dshaWb !== 1) return;
    if (d.phase === "cap-ready") { capReady = true; return; }
    send({ type: "wb-chunk", id: d.id, phase: d.phase, text: d.text || "" });
  });

  // ---- inline fallback: engines that ignore manifest world:MAIN run capture.js
  //      in the isolated world (it no-ops there), so after 4s without a
  //      cap-ready handshake we inject the same source as an inline page-world
  //      script. window.__dshaWbCap (page world, visible via X-ray) prevents a
  //      double wrap. Result is reported once as a wb-capture event so the
  //      terminal stats can show which mode ended up installed. ----
  const CAP_SOURCE = "// WebBridge page-world capture: wraps the REAL page fetch and relays the SSE\n// reply chunks to the isolated-world content script via window.postMessage.\n// Installed either by manifest content_scripts world:MAIN (preferred) or by\n// hook.js injecting this source as an inline <script> (fallback).\n(() => {\n  const IS_PAGE_WORLD = typeof window.wrappedJSObject === \"undefined\";\n  if (!IS_PAGE_WORLD) return; // isolated world: wrapping fetch here is useless\n  if (window.__dshaWbCap) return;\n  window.__dshaWbCap = true;\n\n  const TARGETS = [\"/api/v0/chat/completion\"];\n  const hit = (u) => TARGETS.some((t) => String(u || \"\").includes(t));\n  const relay = (o) => { try { window.postMessage(Object.assign({ __dshaWb: 1 }, o), \"*\"); } catch (e) {} };\n  const newId = () => \"cap-\" + Date.now().toString(36) + \"-\" + Math.random().toString(36).slice(2);\n\n  const origFetch = window.fetch ? window.fetch.bind(window) : null;\n  if (!origFetch) return;\n  const wrapped = async function (input, init) {\n    const resp = await origFetch(input, init);\n    try {\n      const url = typeof input === \"string\" ? input : (input && input.url) || \"\";\n      const method = String((init && init.method) || (input && input.method) || \"GET\").toUpperCase();\n      if (method === \"POST\" && hit(url) && resp.ok && resp.body) {\n        const id = newId();\n        relay({ id: id, phase: \"start\", text: \"\" });\n        const teed = resp.body.tee();\n        const reader = teed[1].getReader();\n        const dec = new TextDecoder();\n        (async () => {\n          try {\n            for (;;) {\n              const r = await reader.read();\n              if (r.done) break;\n              relay({ id: id, phase: \"chunk\", text: dec.decode(r.value, { stream: true }) });\n            }\n          } catch (e) { /* still finalize on stream break */ }\n          relay({ id: id, phase: \"end\", text: \"\" });\n        })();\n        return new Response(teed[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });\n      }\n    } catch (e) { /* wrapper must never affect the page's own requests */ }\n    return resp;\n  };\n  wrapped.__wcCap = true;\n  window.fetch = wrapped;\n  relay({ phase: \"cap-ready\", text: \"\" });\n})();\n";
  function injectInline() {
    try {
      if (window.__dshaWbCap) return true;
      const s = document.createElement("script");
      s.textContent = CAP_SOURCE;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      return Boolean(window.__dshaWbCap);
    } catch (e) { return false; }
  }
  setTimeout(() => {
    if (capReady) return;
    const ok = injectInline();
    setTimeout(() => {
      send({ type: "wb-capture", installed: capReady || ok, mode: capReady ? "main" : (ok ? "inline" : "none"), url: location.href });
    }, 1500);
  }, 4000);

  // ---- input automation: React-controlled textarea needs prototype setter + input event ----
  function typeInto(el, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  }
  function clickFirst(sel) {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }

  // ---- commands from the native side ----
  function bindPort(p) {
    port = p;
    p.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "wb-eval") {
      let result = null, error = null;
      try {
        const v = (0, eval)(msg.js);
        result = v === undefined ? "undefined" : JSON.stringify(v) ?? String(v);
      } catch (e) { error = String(e && e.message || e); }
      send({ type: "wb-eval-result", id: msg.id, result, error, url: location.href });
    } else if (msg.type === "wb-check-login") {
      send({ type: "wb-login", loggedIn: judgeLoggedIn(), url: location.href, reply: msg.id });
    } else if (msg.type === "wb-send") {
      const el = document.querySelector(LOGIN_COMPOSER);
      if (!el) { send({ type: "wb-send-result", id: msg.id, ok: false, error: "composer missing (not logged in?)" }); return; }
      typeInto(el, String(msg.text || ""));
      setTimeout(() => {
        const clicked = clickFirst(SEND_BUTTON);
        send({ type: "wb-send-result", id: msg.id, ok: clicked, error: clicked ? null : "send button not found" });
      }, 300);
    } else if (msg.type === "wb-click") {
      const sel = msg.what === "stop" ? STOP_BUTTON : SEND_BUTTON;
      send({ type: "wb-click-result", id: msg.id, ok: clickFirst(sel) });
    }
    });
    p.onDisconnect.addListener(() => { if (port === p) { port = null; setTimeout(connect, 2000); } });
    send({ type: "wb-page", event: "script-start", url: location.href });
    reportLogin(true);
  }
  function connect() {
    try { bindPort(browser.runtime.connectNative("dsha")); }
    catch (e) { setTimeout(connect, 2000); }
  }
  connect();
})();
