// bEpicViewer_keymap.js
// Every rebindable viewer hotkey lives in the one table below. It feeds three
// consumers: ComfyUI's command list (so the hotkeys appear in
// Settings → Keybinding and can be changed there), the viewer's own key handler,
// and the in-viewer help overlay — so a rebind shows up in all three at once.
import { app } from "../../scripts/app.js";

export const VIEWER_CMD_PREFIX = "bEpic.Viewer.";

// The host <bepic-viewer-panel> carries this id, and every default keybinding
// below names it as its target element. ComfyUI dispatches a targeted keybinding
// only when the keystroke landed inside that element, and the viewer's controls
// live in a shadow root — which `Element.contains()` never reaches into. So the
// defaults are listed and editable in the keybinding editor without ComfyUI ever
// firing them app-wide: the viewer keeps dispatching them itself, while hovered,
// exactly as it did before. A binding the user assigns in the editor carries no
// target element and therefore also works outside the viewer.
export const VIEWER_TARGET_ID = "bepic-viewer-panel";

const USER_BINDINGS_SETTING  = "Comfy.Keybinding.NewBindings";
const UNSET_BINDINGS_SETTING = "Comfy.Keybinding.UnsetBindings";

// Combos ComfyUI core claims for itself (frontend 1.45). Registering a default
// on a combo that is already bound makes ComfyUI raise a toast, so a colliding
// default is left unregistered instead. This list is only the fallback for when
// the live keybinding store can't be read — see `_keybindingStore`.
const CORE_CLAIMED = new Set([
    ..."rwnmapvh".split("").map(k => `${k.toUpperCase()}:false:false:false`),
    ...[".", "Escape", "Delete", "Backspace"].map(k => `${k.toUpperCase()}:false:false:false`),
    ...["Enter", "s", "o", "g", ",", "b", "m", "`", "a"].map(k => `${k.toUpperCase()}:true:false:false`),
    ...["Enter", "v", "e", "k"].map(k => `${k.toUpperCase()}:true:false:true`),
    ...["m", "µ", "=", "+", "-", "c"].map(k => `${k.toUpperCase()}:false:true:false`),
    ...["m", "+"].map(k => `${k.toUpperCase()}:false:true:true`),
    "ENTER:true:true:false",
]);

const KEY_LABELS = {
    " ": "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    Escape: "Esc", Enter: "Enter",
};

/** ComfyUI's KeyComboImpl.serialize() — the key both stores are indexed by. */
export function comboKey(combo) {
    if (!combo || !combo.key) return "";
    return `${String(combo.key).toUpperCase()}:${!!combo.ctrl}:${!!combo.alt}:${!!combo.shift}`;
}

/** Same, for a live KeyboardEvent. Meta counts as Ctrl, as it does in ComfyUI. */
export function comboKeyFromEvent(ev) {
    if (!ev || !ev.key) return "";
    return comboKey({ key: ev.key, ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey, shift: ev.shiftKey });
}

export function comboLabel(combo) {
    if (!combo || !combo.key) return "–";
    const parts = [];
    if (combo.ctrl)  parts.push("Ctrl");
    if (combo.alt)   parts.push("Alt");
    if (combo.shift) parts.push("Shift");
    let key = KEY_LABELS[combo.key] || String(combo.key);
    if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join("+");
}

// Whether a panel is showing is the dock's to answer (mixinDock), not something
// to re-derive from inline styles.
const _historyOpen = (p) => !!(p && p.isPanelDocked && p.isPanelDocked("history"));

const ACTION_DEFS = [
    { key: "StepBack",     label: "Step Back One Frame",     combo: { key: "ArrowLeft"  },
      run: (p) => p.step(-1) },
    { key: "StepForward",  label: "Step Forward One Frame",  combo: { key: "ArrowRight" },
      run: (p) => p.step(1) },
    { key: "FirstFrame",   label: "Go To First Frame",       combo: { key: "ArrowLeft",  ctrl: true },
      run: (p) => p.setFrame(p.getTimelineBounds().min) },
    { key: "LastFrame",    label: "Go To Last Frame",        combo: { key: "ArrowRight", ctrl: true },
      run: (p) => p.setFrame(p.getTimelineBounds().max) },
    { key: "PlayPause",    label: "Play / Pause",            combo: { key: " " },
      run: (p) => { p.isPlaying ? p.stop() : p.play(); } },

    // The history strip owns the vertical arrows, but only while it is open —
    // otherwise the keystroke is left alone for whatever else wants it.
    { key: "HistoryPrev",  label: "Previous History Snapshot", combo: { key: "ArrowUp" },
      enabled: _historyOpen, run: (p) => { if (typeof p.navigateHistory === "function") p.navigateHistory(-1); } },
    { key: "HistoryNext",  label: "Next History Snapshot",     combo: { key: "ArrowDown" },
      enabled: _historyOpen, run: (p) => { if (typeof p.navigateHistory === "function") p.navigateHistory(1); } },

    // Delete is one of ComfyUI's own, so no default binding is registered for it
    // (see viewerKeybindings) — but the viewer still answers it while hovered,
    // which is the only place it could mean "these snapshots" anyway. `enabled`
    // is what keeps it from swallowing the key when there is nothing to delete,
    // leaving it to ComfyUI's delete-selected-nodes behind the panel.
    { key: "HistoryDelete", label: "Delete Selected History Snapshots", combo: { key: "Delete" },
      enabled: (p) => _historyOpen(p) && typeof p.hasDeletableHistory === "function" && p.hasDeletableHistory(),
      run: (p) => p.deleteSelectedHistory() },

    { key: "FitView",      label: "Fit Image To Viewport",   combo: { key: "f" },
      run: (p) => p.fitView() },
    { key: "CycleCompare", label: "Cycle Compare Mode",      combo: { key: "c" },
      run: (p) => p.cycleCompareMode() },
    { key: "ChannelRed",   label: "Isolate Red Channel",     combo: { key: "r" },
      run: (p) => p.setChannelView(p.channelView === "red"   ? "all" : "red") },
    { key: "ChannelGreen", label: "Isolate Green Channel",   combo: { key: "g" },
      run: (p) => p.setChannelView(p.channelView === "green" ? "all" : "green") },
    { key: "ChannelBlue",  label: "Isolate Blue Channel",    combo: { key: "b" },
      run: (p) => p.setChannelView(p.channelView === "blue"  ? "all" : "blue") },
    { key: "ToggleShape",  label: "Toggle Tensor Shape Overlay", combo: { key: "s" },
      run: (p) => p.toggleShapeOverlay() },
    { key: "ToggleHelp",   label: "Toggle Hotkey Help",      combo: { key: "?", shift: true },
      run: (p) => p.toggleHelpOverlay() },
];

// Tabs 1–9, in the order they sit on the tab bar.
for (let i = 1; i <= 9; i++) {
    const idx = i - 1;
    ACTION_DEFS.push({
        key:   `SwitchTab${i}`,
        label: `Switch To Tab ${i}`,
        combo: { key: String(i) },
        helpGroup: "tabs",
        helpLabel: "Switch Tab",
        enabled: (p) => {
            const tabs = p.getTabOrderForHotkeys();
            return tabs.length > 1 && idx < tabs.length;
        },
        run: (p) => {
            const tabs = p.getTabOrderForHotkeys();
            if (tabs.length > 1 && idx < tabs.length) p.switchTab(tabs[idx]);
        },
    });
}

export const VIEWER_ACTIONS = ACTION_DEFS.map(def => ({ ...def, id: VIEWER_CMD_PREFIX + def.key }));

const _byId = new Map(VIEWER_ACTIONS.map(a => [a.id, a]));

export function viewerActionById(id) {
    return _byId.get(id) || null;
}

// ── ComfyUI registration ─────────────────────────────────────────────────────

/** Commands for `registerExtension({ commands })` — one per viewer action. */
export function viewerCommands(getPanel) {
    return VIEWER_ACTIONS.map(action => ({
        id:       action.id,
        label:    `bEpic Viewer: ${action.label}`,
        function: () => { runViewerAction(action, getPanel && getPanel()); },
    }));
}

/** Runs an action against a panel, honouring its `enabled` guard. */
export function runViewerAction(action, panel) {
    if (!action || !panel) return false;
    if (action.enabled && !action.enabled(panel)) return false;
    action.run(panel);
    return true;
}

// Best effort read of ComfyUI's keybinding store, used only to see whether a
// combo is already taken. `extensionManager` is the workspace store; pinia keeps
// every store in `_s` and hands each one a `_p` back-reference to the instance.
// That last hop is internal, hence the guards and the CORE_CLAIMED fallback.
function _keybindingStore() {
    try {
        const em = app && app.extensionManager;
        if (!em) return null;
        if (em.keybinding && typeof em.keybinding.getKeybinding === "function") return em.keybinding;
        const store = em._p && em._p._s && em._p._s.get("keybinding");
        return (store && typeof store.getKeybinding === "function") ? store : null;
    } catch (e) {
        return null;
    }
}

/** Default keybindings for `registerExtension({ keybindings })`. */
export function viewerKeybindings() {
    const store = _keybindingStore();
    const isTaken = (key) => {
        if (store) {
            // getKeybinding() only ever calls serialize() on what it is handed.
            try { return !!store.getKeybinding({ serialize: () => key }); } catch (e) { /* fall through */ }
        }
        return CORE_CLAIMED.has(key);
    };

    const out = [];
    for (const action of VIEWER_ACTIONS) {
        if (!action.combo) continue;
        if (isTaken(comboKey(action.combo))) {
            console.info(
                `[bEpicViewer] ${comboLabel(action.combo)} is already bound in ComfyUI, so ` +
                `"${action.label}" is listed without a keybinding. It still works while the ` +
                `viewer is hovered; assign your own combo in Settings → Keybinding to change it.`
            );
            continue;
        }
        out.push({
            commandId:       action.id,
            combo:           { ...action.combo },
            targetElementId: VIEWER_TARGET_ID,
        });
    }
    return out;
}

// ── Effective bindings ───────────────────────────────────────────────────────

function _setting(id) {
    try {
        const value = app.extensionManager.setting.get(id);
        return Array.isArray(value) ? value : null;
    } catch (e) {
        return null;
    }
}

let _memo = null;

// combo key -> { action, combo }, merged the same way ComfyUI merges its own
// stores: defaults, minus the ones the user unset, with the user's bindings
// laid over the top. A user binding pointing somewhere else takes the combo away
// from the viewer, so rebinding one of these keys to a ComfyUI command works.
function effectiveMap() {
    const userBindings  = _setting(USER_BINDINGS_SETTING)  || [];
    const unsetBindings = _setting(UNSET_BINDINGS_SETTING) || [];
    if (_memo && _memo.user === userBindings && _memo.unset === unsetBindings) return _memo.map;

    const map = new Map();
    for (const action of VIEWER_ACTIONS) {
        if (action.combo) map.set(comboKey(action.combo), { action, combo: action.combo });
    }
    for (const binding of unsetBindings) {
        if (!binding) continue;
        const key = comboKey(binding.combo);
        const hit = map.get(key);
        if (hit && hit.action.id === binding.commandId) map.delete(key);
    }
    for (const binding of userBindings) {
        if (!binding) continue;
        const key = comboKey(binding.combo);
        if (!key) continue;
        const action = _byId.get(binding.commandId);
        if (action) map.set(key, { action, combo: binding.combo });
        else        map.delete(key);
    }

    _memo = { user: userBindings, unset: unsetBindings, map };
    return map;
}

/** The viewer action bound to this keystroke, or null. */
export function resolveViewerAction(ev) {
    const hit = effectiveMap().get(comboKeyFromEvent(ev));
    return hit ? hit.action : null;
}

/** Forget the cached merge — for tests, and whenever the settings are replaced. */
export function invalidateKeymapCache() {
    _memo = null;
}

// ── Help overlay ─────────────────────────────────────────────────────────────

function _foldKeys(labels) {
    if (labels.length === 0) return "–";
    if (labels.length <= 2) return labels.join(" / ");
    const contiguous = labels.every((l, i) =>
        l.length === 1 && (i === 0 || l.charCodeAt(0) === labels[i - 1].charCodeAt(0) + 1));
    return contiguous ? `${labels[0]}–${labels[labels.length - 1]}` : labels.join(" / ");
}

/**
 * Rows for the in-viewer help overlay: `[{ keys, label }]`, showing the bindings
 * that are actually in effect rather than the shipped defaults.
 */
export function viewerHelpRows() {
    const combosFor = new Map();
    for (const { action, combo } of effectiveMap().values()) {
        if (!combosFor.has(action.id)) combosFor.set(action.id, []);
        combosFor.get(action.id).push(combo);
    }

    const rows = [];
    const groupRow = new Map();
    for (const action of VIEWER_ACTIONS) {
        const labels = (combosFor.get(action.id) || []).map(comboLabel);
        if (action.helpGroup) {
            let row = groupRow.get(action.helpGroup);
            if (!row) {
                row = { keys: "", label: action.helpLabel || action.label, _labels: [] };
                groupRow.set(action.helpGroup, row);
                rows.push(row);
            }
            row._labels.push(...labels);
            continue;
        }
        rows.push({ keys: _foldKeys(labels), label: action.label });
    }
    for (const row of groupRow.values()) {
        row.keys = _foldKeys(row._labels);
        delete row._labels;
    }
    return rows;
}
