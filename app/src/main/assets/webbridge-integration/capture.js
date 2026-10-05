// WebBridge page-world capture: wraps the REAL page fetch and relays the SSE
// reply chunks to the isolated-world content script via window.postMessage.
// Installed either by manifest content_scripts world:MAIN (preferred) or by
// hook.js injecting this source as an inline <script> (fallback).
(() => {
  const IS_PAGE_WORLD = typeof window.wrappedJSObject === "undefined";
  if (!IS_PAGE_WORLD) return; // isolated world: wrapping fetch here is useless
  if (window.__dshaWbCap) return;
  window.__dshaWbCap = true;

  const TARGETS = ["/api/v0/chat/completion"];
  const hit = (u) => TARGETS.some((t) => String(u || "").includes(t));
  const relay = (o) => { try { window.postMessage(Object.assign({ __dshaWb: 1 }, o), "*"); } catch (e) {} };
  const newId = () => "cap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;
  const wrapped = async function (input, init) {
    const resp = await origFetch(input, init);
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method === "POST" && hit(url) && resp.ok && resp.body) {
        const id = newId();
        relay({ id: id, phase: "start", text: "" });
        const teed = resp.body.tee();
        const reader = teed[1].getReader();
        const dec = new TextDecoder();
        (async () => {
          try {
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              relay({ id: id, phase: "chunk", text: dec.decode(r.value, { stream: true }) });
            }
          } catch (e) { /* still finalize on stream break */ }
          relay({ id: id, phase: "end", text: "" });
        })();
        return new Response(teed[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      }
    } catch (e) { /* wrapper must never affect the page's own requests */ }
    return resp;
  };
  wrapped.__wcCap = true;
  window.fetch = wrapped;
  relay({ phase: "cap-ready", text: "" });
})();
