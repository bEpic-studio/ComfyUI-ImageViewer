// bEpicViewer_mixinReconnect.js
// "Reconnecting…" over the canvas while the viewer has lost ComfyUI, and
// getting it back without the user closing and re-undocking anything.
//
// There are two ways to lose it:
//
//  - The server goes away (restart, crash, the AYON session closing) while the
//    ComfyUI tab stays open. ComfyUI's api already retries its socket every
//    300 ms, so the viewer only has to say so — and to notice when it is back,
//    which takes more than listening for `reconnected`: ComfyUI's resetSocket()
//    reopens without announcing it, and while the viewer is undocked the tab is
//    usually hidden, where Chrome runs its timers late. So the overlay follows
//    the socket itself, and the popout's watchdog checks on it too.
//
//  - The ComfyUI tab itself goes away (reload, close) while the viewer is
//    undocked. The popout window survives, but every line of the viewer's code
//    lives in the tab's realm, and none of it runs once that realm is gone —
//    measured: a timer the tab had started in the popout stopped dead on
//    reload, while a script living in the popout's own realm kept ticking. So
//    the popout gets a small watchdog of its own (popoutWatchdog) that notices,
//    puts up the warning, and calls out on a BroadcastChannel until a freshly
//    loaded ComfyUI tab takes the window back (adoptOrphanPopout).
//
//    A reloaded tab gets the very same window back, found by name. A tab that
//    was closed can't: its replacement is opened from outside (AYON will not
//    relaunch while the old tab is open, then opens a new one), and Chrome's
//    name lookup never reaches past the tabs one was opened from. So the new
//    tab opens a fresh window where the old one sits and tells the old one to
//    close — by itself if pop-ups are allowed, else from one click on the
//    "Reconnect" button it puts up.
import { api } from "../../scripts/api.js";

// The popout is opened by name. That is what lets a reloaded tab find the
// window it left behind: window.open("", name) hands back the existing window
// instead of opening another one.
export const POPOUT_NAME = "bEpicViewer";

const CHANNEL = "bepic-viewer-popout";

// A name lookup only reaches windows in the opening tab's browsing context
// group, and a lookup that misses opens a new window instead. So only a tab
// that has just loaded is plausibly the one coming back, and only it tries.
const ADOPT_WINDOW_MS = 60000;
const HOST_LOADED_AT  = Date.now();

const HOST_TOKEN = (() => {
    // randomUUID only exists in secure contexts; ComfyUI served over plain
    // http on a LAN address isn't one.
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
})();

const socketOpen = () => !!(api.socket && api.socket.readyState === WebSocket.OPEN);

// Set at load, not at panel init: a popout opened before init has finished
// still has to find its tab alive, or it would give itself up at once.
// `socketOpen` is what the popout's watchdog reads to see through to ComfyUI's
// socket; a plain call works even while this tab's own timers are held back.
window.__bepicViewerHost = { token: HOST_TOKEN, socketOpen };

const TEXT = {
    server:        "Lost the connection to the ComfyUI server. Retrying…",
    serverBack:    "ComfyUI is back. Reconnecting…",
    tabAsleep:     "ComfyUI is back, but its tab is in the background and hasn't reconnected yet. Switch to the ComfyUI tab once to wake it up.",
    tabStuck:      "ComfyUI is back, but its tab hasn't reconnected. Reload the ComfyUI tab; this window will reconnect to it.",
    tabGone:       "The ComfyUI tab this window belongs to was reloaded or closed.",
    serverDown:    "The ComfyUI server isn't responding. Waiting for it to come back…",
    waitingForTab: "Waiting for ComfyUI to open again. Reload or reopen the ComfyUI tab and this viewer comes back.",
    clickToReconnect: "ComfyUI is open in a new tab. Click “Reconnect the bEpic Viewer window” at the top of that tab to bring this viewer back.",
};

// window.open features that put a new popout where `rect` says the old one was
// (inner size, screen position). Chrome may still keep it on the opener's screen.
function _popoutFeatures(rect) {
    const r = rect || {};
    const size = (v, d) => (Number.isFinite(v) && v > 100 ? Math.round(v) : d);
    const parts = [`width=${size(r.w, 800)}`, `height=${size(r.h, 600)}`];
    if (Number.isFinite(r.x) && Number.isFinite(r.y)) parts.push(`left=${Math.round(r.x)}`, `top=${Math.round(r.y)}`);
    return parts.join(",");
}

// Runs inside the popout, in the popout's own realm, and that is the point: it
// is the one piece of the viewer still running once the tab that owns the rest
// has gone. It is injected as source text, so it must not refer to anything
// outside itself.
function popoutWatchdog(cfg) {
    const state = { phase: "attached", server: null, serverUpSince: 0 };
    const channel = (typeof BroadcastChannel === "function") ? new BroadcastChannel(cfg.channel) : null;

    // The owning tab is alive for as long as the window that opened this one
    // still carries its token. A reload swaps in a document with no token and
    // later a different one. A wrapper page that reloads (AYON loads ComfyUI in
    // an iframe) throws the opening frame away, and `opener` goes null.
    const hostAlive = () => {
        try {
            const o = window.opener;
            return !!(o && !o.closed && o.__bepicViewerHost && o.__bepicViewerHost.token === cfg.token);
        } catch (e) { return false; }
    };

    const overlay = () => document.getElementById("reconnect-overlay");
    const show = (text) => {
        const el = overlay();
        if (!el) return;
        const detail = el.querySelector(".reconnect-detail");
        if (detail) detail.textContent = text;
        el.classList.add("visible");
    };

    const probe = async () => {
        try {
            state.server = (await fetch(cfg.probeUrl, { cache: "no-store" })).ok;
        } catch (e) {
            state.server = false;
        }
        state.serverUpSince = state.server ? (state.serverUpSince || Date.now()) : 0;
    };

    const render = () => {
        if (state.phase !== "orphaned") return;
        show(state.server === false ? cfg.text.serverDown
           : state.prompted         ? cfg.text.clickToReconnect
           : state.server === true  ? cfg.text.waitingForTab
           :                          cfg.text.tabGone);
    };

    // A new ComfyUI tab that couldn't reach this window by name answers here:
    // it has opened a replacement ("replaced"), so this one can go, or it is
    // waiting for the click that lets it open one ("prompted").
    if (channel) channel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.id !== cfg.token || state.phase !== "orphaned") return;
        if (msg.type === "replaced") window.close();
        else if (msg.type === "prompted") { state.prompted = true; render(); }
    };

    // The tab is alive but lost its server, and put the warning up itself. It
    // takes it down again on `reconnected` — but that tab is usually hidden
    // behind this window, where Chrome runs its timers late or not at all. So
    // look through to its socket from here: take the warning down the moment
    // the socket is open, and until then say what the wait is for.
    const watchHost = async () => {
        const el = overlay();
        if (!el || !el.classList.contains("visible")) {
            state.serverUpSince = 0;
            return;
        }
        let open = false, hidden = false;
        try {
            const host = window.opener;
            open   = !!host.__bepicViewerHost.socketOpen();
            hidden = host.document.visibilityState === "hidden";
        } catch (e) {}
        if (open) {
            el.classList.remove("visible");
            state.serverUpSince = 0;
            return;
        }
        await probe();
        // The tab may have reconnected, or gone, while the probe was out.
        if (state.phase !== "attached" || !el.classList.contains("visible")) return;
        const waited = state.serverUpSince ? Date.now() - state.serverUpSince : 0;
        show(!state.server                            ? cfg.text.serverDown
           : hidden && waited > cfg.asleepAfterMs     ? cfg.text.tabAsleep
           : waited > cfg.stuckAfterMs                ? cfg.text.tabStuck
           :                                            cfg.text.serverBack);
    };

    let busy = false;
    const tick = async () => {
        if (busy) return;
        busy = true;
        try {
            if (state.phase === "attached") {
                if (!hostAlive()) orphan();
                else await watchHost();
                return;
            }
            if (state.phase !== "orphaned") return;
            await probe();
            if (state.phase !== "orphaned") return;   // taken over while the probe was out
            render();
            // No tab can load without a server, so there is nobody to call before
            // then. Where this window sits goes along, so a replacement can open
            // in the same place.
            if (state.server && channel) channel.postMessage({
                type: "orphan", id: cfg.token,
                rect: { x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight },
            });
        } finally {
            busy = false;
        }
    };

    function orphan() {
        if (state.phase !== "attached") return;
        state.phase = "orphaned";
        render();
        tick();     // a no-op when this came from inside a tick; the next one probes
    }

    window.__bepicWatchdog = {
        token: cfg.token,
        get phase() { return state.phase; },
        orphan,
        // The tab taking this window over calls this, and true means the window
        // is now that tab's. Windows that can reach each other by name are
        // same-origin and share one event loop, so two tabs can't both win.
        claim() {
            if (state.phase !== "orphaned") return false;
            state.phase = "claimed";
            return true;
        },
    };
    setInterval(tick, cfg.intervalMs);
}

function _isBlankPopout(win) {
    try {
        return win.location.href === "about:blank" && !win.__bepicWatchdog &&
               !!win.document.body && win.document.body.childElementCount === 0;
    } catch (e) {
        return false;
    }
}

export const ReconnectMixin = {

    // Runs last in init: taking a popout over re-runs the undock, which needs
    // the rest of the viewer in place, restored state included.
    _initReconnect() {
        this._adoptTried = new Set();
        this.reconnectOverlay = this.container && this.container.querySelector("#reconnect-overlay");

        api.addEventListener("reconnecting", () => this._showReconnecting(TEXT.server));
        api.addEventListener("reconnected",  () => this._hideReconnecting());
        // `reconnected` isn't the only way back: resetSocket() opens its fresh
        // socket as a first connection, which announces nothing. The server's
        // first message on every new socket is a status, though, so a real
        // status means connected. (A null one is ComfyUI saying it lost it.)
        api.addEventListener("status", (e) => { if (e.detail) this._hideReconnecting(); });

        // Tell the popout the moment this tab goes, rather than on its next tick.
        window.addEventListener("pagehide", () => {
            try {
                const wd = this.popoutWindow && !this.popoutWindow.closed && this.popoutWindow.__bepicWatchdog;
                if (wd) wd.orphan();
            } catch (e) {}
        });

        if (typeof BroadcastChannel === "function") {
            this._reconnectChannel = new BroadcastChannel(CHANNEL);
            this._reconnectChannel.onmessage = (e) => {
                const msg = e.data || {};
                if (msg.type === "orphan") this.adoptOrphanPopout(msg);
            };
        }
        this._reconnectReady = true;
    },

    _showReconnecting(detail) {
        const el = this.reconnectOverlay;
        if (!el) return;
        const d = el.querySelector(".reconnect-detail");
        if (d) d.textContent = detail;
        el.classList.add("visible");
        // And should both events slip by, the socket itself says when it's back.
        if (!this._reconnectPoll) {
            this._reconnectPoll = setInterval(() => {
                if (socketOpen()) this._hideReconnecting();
            }, 1000);
        }
    },

    _hideReconnecting() {
        if (this._reconnectPoll) {
            clearInterval(this._reconnectPoll);
            this._reconnectPoll = null;
        }
        if (this.reconnectOverlay) this.reconnectOverlay.classList.remove("visible");
    },

    // Give a popout the viewer has just moved into its own watchdog.
    _armPopoutWatchdog(win) {
        try {
            const cfg = {
                token:      HOST_TOKEN,
                channel:    CHANNEL,
                // Absolute: about:blank resolves relative URLs against the tab
                // that created it, and that tab is exactly what may be gone.
                probeUrl:   new URL(api.apiURL("/prompt"), window.location.href).href,
                intervalMs: 1000,
                // How long the server may be back before the tab not having
                // reconnected is worth mentioning: hidden, then at all.
                asleepAfterMs: 5000,
                stuckAfterMs:  20000,
                text:       TEXT,
            };
            const script = win.document.createElement("script");
            script.textContent = `(${popoutWatchdog.toString()})(${JSON.stringify(cfg)});`;
            win.document.head.appendChild(script);
        } catch (e) {
            console.warn("bEpicViewer: could not arm the popout watchdog", e);
        }
        // The viewer has a window again, so an orphan waiting on this tab can go.
        if (this._pendingOrphan) {
            if (this._reconnectChannel) this._reconnectChannel.postMessage({ type: "replaced", id: this._pendingOrphan });
            this._pendingOrphan = null;
            this._removeReconnectOffer();
        }
    },

    // Make `win` an empty about:blank the viewer can move into. A window found
    // by name may still hold a viewer: the frozen one a reloaded tab left
    // behind. That is cleared by loading a fresh document rather than by
    // emptying the DOM, because the old viewer also left listeners and
    // observers on the window itself, and each of them keeps the dead tab's
    // whole frontend in memory for as long as the window stays open.
    async _freshPopoutDocument(win) {
        if (_isBlankPopout(win)) return true;
        let old = null;
        try { old = win.document; } catch (e) {}
        try { win.location.replace("about:blank"); } catch (e) { return false; }
        const started = Date.now();
        while (Date.now() - started < 3000) {
            await new Promise(r => setTimeout(r, 10));
            if (win.closed) return false;
            try {
                if (win.document !== old && win.document.readyState === "complete" && win.document.body) return true;
            } catch (e) {}
        }
        return false;
    },

    // A popout calling out on the channel has lost its tab. If this tab has only
    // just loaded, it is most likely that tab's successor, so it takes the
    // viewer back: into the same window when it can reach it (a reload), into a
    // new one where the old one was when it can't (a tab closed and reopened).
    async adoptOrphanPopout(msg) {
        const id = msg && msg.id;
        if (!id || !this._reconnectReady || this._undocking) return;   // the next call-out retries
        if (this.popoutWindow && !this.popoutWindow.closed) return;
        if (Date.now() - HOST_LOADED_AT > ADOPT_WINDOW_MS) return;
        if (this._adoptTried.has(id)) return;
        this._adoptTried.add(id);

        const features = _popoutFeatures(msg.rect);
        let win = null;
        try { win = window.open("", POPOUT_NAME, features); } catch (e) {}
        if (!win) {
            // Out of reach, and the pop-up blocker won't let a tab open a window
            // on its own. It will on a click, so ask for one.
            this._offerPopoutReconnect(id, features);
            return;
        }
        let wd = null;
        try { wd = win.__bepicWatchdog || null; } catch (e) {}
        if (wd) {
            // Found by name: the orphan itself — or another live tab's popout,
            // which won't let itself be claimed.
            if (wd.claim() && await this._undockInto(win)) {
                this.dispatchEvent(new CustomEvent("bepic-popout-adopted"));
            }
            return;
        }
        // Out of reach, and pop-ups are allowed, so the lookup opened a new
        // window instead. That is the replacement.
        if (_isBlankPopout(win)) await this._replaceOrphan(win, id);
    },

    // Move the viewer into `win`, a new window standing in for the orphan `id`.
    // The orphan is told to close once the viewer is in (_armPopoutWatchdog).
    async _replaceOrphan(win, id) {
        this._pendingOrphan = id;
        if (!(await this._undockInto(win))) return false;
        this.dispatchEvent(new CustomEvent("bepic-popout-adopted"));
        return true;
    },

    // The one-click way back when pop-ups are blocked: a button at the top of
    // the ComfyUI page, and the orphan told to point at it. Undocking by hand
    // answers it just as well.
    _offerPopoutReconnect(id, features) {
        this._pendingOrphan = id;
        if (this._reconnectChannel) this._reconnectChannel.postMessage({ type: "prompted", id });
        if (this._reconnectOffer) return;

        const bar = document.createElement("div");
        Object.assign(bar.style, {
            position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
            zIndex: "2147483646", display: "flex", alignItems: "center", gap: "6px",
            padding: "4px", background: "rgba(20,20,20,0.95)", border: "1px solid #f60",
            borderRadius: "6px", boxShadow: "0 4px 14px rgba(0,0,0,0.6)",
            fontFamily: "'Segoe UI', sans-serif", fontSize: "13px",
        });
        const btn = document.createElement("button");
        btn.textContent = "↻ Reconnect the bEpic Viewer window";
        btn.title = "The undocked viewer lost its ComfyUI tab. Click to bring it back in a window of its own. " +
                    "Allowing pop-ups for this site does this without the click.";
        Object.assign(btn.style, {
            background: "#f60", color: "#111", border: "none", borderRadius: "4px",
            padding: "5px 12px", fontWeight: "600", cursor: "pointer",
        });
        const close = document.createElement("button");
        close.textContent = "×";
        close.title = "Dismiss";
        Object.assign(close.style, {
            background: "transparent", color: "#aaa", border: "none",
            fontSize: "16px", cursor: "pointer", padding: "0 6px",
        });

        btn.onclick = async () => {
            let win = null;
            try { win = window.open("", POPOUT_NAME, features); } catch (e) {}
            if (win && _isBlankPopout(win)) await this._replaceOrphan(win, id);
        };
        close.onclick = () => this._removeReconnectOffer();
        bar.append(btn, close);
        document.body.appendChild(bar);
        this._reconnectOffer = bar;
    },

    _removeReconnectOffer() {
        if (this._reconnectOffer) this._reconnectOffer.remove();
        this._reconnectOffer = null;
    },
};
