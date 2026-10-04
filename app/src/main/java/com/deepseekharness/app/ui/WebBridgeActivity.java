package com.deepseekharness.app.ui;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

/**
 * WebBridge automation session page: owns a GeckoSession dedicated to the
 * web-bridge plugin's automation.
 *
 * Shares the same GeckoRuntime (= same profile) as the preview pages, so the
 * DeepSeek login cookie is shared for free. The session outlives Activity
 * destruction via the static Retained holder, so login state survives.
 *
 * HttpShellService /browser/* routes reach this page through current() /
 * showLogin(); all Gecko work is posted to the main thread. Events (SSE chunks /
 * eval results / login sentinel) go into a ring buffer drained by the node side
 * through /browser/events long polling.
 */
public class WebBridgeActivity extends Activity {

    private static final class Retained {
        GeckoSession session;
        WebExtension.Port port;
    }
    private static final Retained retained = new Retained();
    private static volatile WebBridgeActivity instance;
    private static final Handler main = new Handler(Looper.getMainLooper());

    // ---- login mode (M2) ----
    private static volatile Boolean lastLoginState = null;   // null = unknown
    private static volatile boolean loginMode = false;

    // ---- event ring buffer (M3) ----
    private static final class Ev { final long seq; final String json; Ev(long s, String j) { seq = s; json = j; } }
    private static final java.util.ArrayDeque<Ev> events = new java.util.ArrayDeque<>();
    private static long eventSeq = 0;
    private static final Object EV_LOCK = new Object();

    private GeckoView view;

    /** For bridge routes; null when the Activity is not alive (routes relaunch it). */
    public static WebBridgeActivity current() { return instance; }

    public static Boolean loginState() { return lastLoginState; }

    public static boolean portConnected() { return retained.port != null; }

    public static void runOnMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else main.post(r);
    }

    private static void pushEvent(String json) {
        synchronized (EV_LOCK) {
            events.addLast(new Ev(++eventSeq, json));
            while (events.size() > 4000) events.removeFirst();
            EV_LOCK.notifyAll();
        }
    }

    /** Events after since; blocks up to waitMs when empty (long polling). */
    public static String takeEvents(long since, long waitMs) {
        long deadline = System.currentTimeMillis() + Math.max(0, waitMs);
        synchronized (EV_LOCK) {
            for (;;) {
                StringBuilder sb = new StringBuilder("[");
                boolean any = false;
                long lastSeq = since;
                for (Ev e : events) {
                    if (e.seq <= since) continue;
                    if (any) sb.append(',');
                    if (e.json.length() > 2) {
                        sb.append("{\"seq\":").append(e.seq).append(',')
                          .append(e.json, 1, e.json.length() - 1).append('}');
                    } else {
                        sb.append("{\"seq\":").append(e.seq).append(",\"raw\":")
                          .append(org.json.JSONObject.quote(e.json)).append('}');
                    }
                    any = true;
                    lastSeq = e.seq;
                }
                sb.append(']');
                if (any || System.currentTimeMillis() >= deadline)
                    return "{\"events\":" + sb + ",\"lastSeq\":" + lastSeq + "}";
                try {
                    EV_LOCK.wait(Math.max(1, deadline - System.currentTimeMillis()));
                } catch (InterruptedException ie) {
                    return "{\"events\":[],\"lastSeq\":" + since + ",\"interrupted\":true}";
                }
            }
        }
    }

    /** From HttpShellService: launch in login mode (foreground, visible). */
    public static void showLogin(android.content.Context ctx) {
        loginMode = true;
        android.content.Intent i = new android.content.Intent(ctx, WebBridgeActivity.class);
        i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        i.putExtra("url", "https://chat.deepseek.com/");
        i.putExtra("login", true);
        ctx.startActivity(i);
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        view = new GeckoView(this);
        setContentView(view);
        instance = this;

        GeckoRuntime runtime = GeckoRuntime.getDefault(this);
        if (retained.session == null) retained.session = new GeckoSession();
        if (!retained.session.isOpen()) retained.session.open(runtime);
        view.setSession(retained.session);

        runtime.getWebExtensionController()
                .ensureBuiltIn("resource://android/assets/webbridge-integration/", "dsha-webbridge@dsh.client")
                .accept(this::attachPort, e -> {
                    android.util.Log.w("DSHA", "webbridge extension register failed: " + e);
                });

        String url = getIntent() != null ? getIntent().getStringExtra("url") : null;
        if (url != null && !url.isEmpty()) retained.session.loadUri(url);
    }

    private void attachPort(WebExtension extension) {
        retained.session.getWebExtensionController().setMessageDelegate(extension,
                new WebExtension.MessageDelegate() {
                    @Override public void onConnect(WebExtension.Port port) {
                        retained.port = port;
                        port.setDelegate(new WebExtension.PortDelegate() {
                            @Override public void onPortMessage(Object message, WebExtension.Port source) {
                                android.util.Log.i("DSHA", "[webbridge] " + message);
                                try {
                                    if (message instanceof org.json.JSONObject) {
                                        org.json.JSONObject o = (org.json.JSONObject) message;
                                        pushEvent(o.toString());
                                        if ("wb-login".equals(o.optString("type"))) {
                                            lastLoginState = o.optBoolean("loggedIn", false);
                                            if (loginMode && Boolean.TRUE.equals(lastLoginState)) {
                                                loginMode = false;
                                                runOnMain(() -> {
                                                    android.widget.Toast.makeText(WebBridgeActivity.this,
                                                        "Login ok, moving to background",
                                                        android.widget.Toast.LENGTH_SHORT).show();
                                                    moveTaskToBack(true);
                                                });
                                            }
                                        }
                                    }
                                } catch (Throwable ignored) { }
                            }
                            @Override public void onDisconnect(WebExtension.Port source) {
                                if (retained.port == source) retained.port = null;
                            }
                        });
                    }
                }, "dsha");
    }

    public void openUrl(String url) {
        runOnMain(() -> {
            if (retained.session != null && retained.session.isOpen()) retained.session.loadUri(url);
        });
    }

    /** Post a command to the page Port (wb-send / wb-click / wb-eval / wb-check-login). */
    public void postToPage(String type, org.json.JSONObject payload) {
        runOnMain(() -> {
            WebExtension.Port p = retained.port;
            if (p == null) {
                android.util.Log.w("DSHA", "[webbridge] postToPage failed: Port not connected");
                return;
            }
            try {
                payload.put("type", type);
                p.postMessage(payload);
            } catch (org.json.JSONException e) {
                android.util.Log.w("DSHA", "[webbridge] message build failed: " + e);
            }
        });
    }

    public void evalJs(String id, String js) {
        try {
            postToPage("wb-eval", new org.json.JSONObject().put("id", id).put("js", js));
        } catch (org.json.JSONException e) {
            android.util.Log.w("DSHA", "[webbridge] eval args invalid: " + e);
        }
    }

    public void hideToBack() {
        runOnMain(() -> moveTaskToBack(true));
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (instance == this) instance = null;
        // Deliberately do NOT close the session: static holder keeps login state alive.
    }
}
