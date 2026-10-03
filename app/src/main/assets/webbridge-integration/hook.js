// WebBridge content script (M3 final): channel + login sentinel + SSE capture + input automation.
// Capture logic ported from dsh-webcode-bridge captureInit (fetch tee + self-heal guard);
// emit goes through the extension Port as JSON messages instead of a playwright binding.
(() => {
  const LOGIN_COMPOSER = "textarea.ds-scroll-area";
  const SEND_BUTTON = "div[role='button']:has(path[d^='M8.3125'])";
  const STOP_BUTTON = "div[role='button']:has(path[d^='M2 4.88'])";
  const TARGETS = ["/api/v0/chat/completion"];

  const port = browser.runtime.connectNative("dsha");
  const send = (o) => { try { port.postMessage(o); } catch (e) { /* port down: never break the page */ } };
  const emit = (id, phase, text) => send({ type: "wb-chunk", id, phase, text: text || "" });

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

  // ---- SSE capture: fetch tee (__wcCap marker + 500ms self-heal guard) ----
  const hit = (u) => TARGETS.some((t) => String(u || "").includes(t));
  function newId() { return "cap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }
  function installCapture() {
    if (!(window.fetch && window.fetch.__wcCap)) {
      const origFetch = window.fetch ? window.fetch.bind(window) : null;
      if (origFetch) {
        const wrapped = async function (input, init) {
          const resp = await origFetch(input, init);
          try {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
            if (method === "POST" && hit(url) && resp.ok && resp.body) {
              const id = newId();
              emit(id, "start", "");
              const [forPage, forCapture] = resp.body.tee();
              const reader = forCapture.getReader();
              const dec = new TextDecoder();
              (async () => {
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    emit(id, "chunk", dec.decode(value, { stream: true }));
                  }
                } catch (e) { /* still finalize on stream break */ }
                emit(id, "end", "");
              })();
              return new Response(forPage, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
            }
          } catch (e) { /* wrapper must never affect the page's own requests */ }
          return resp;
        };
        wrapped.__wcCap = true;
        window.fetch = wrapped;
      }
    }
  }
  installCapture();
  setInterval(installCapture, 500);

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
  port.onMessage.addListener((msg) => {
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
  send({ type: "wb-page", event: "script-start", url: location.href });
})();
