// bEpicViewer_keymap.js
// Every rebindable viewer hotkey lives in the one table below. It feeds three
// consumers: ComfyUI's command list (so the hotkeys appear in
// Settings → Keybinding and can be changed there), the viewer's own key handler,
// and the in-viewer help overlay — so a rebind shows up in all three at once.
import { app } from "../../scripts/app.js";
import { PRIMITIVES } from "./bEpicViewer_scene3d.js";

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

// A 3D tab with a previz scene on it: where the gizmo keys mean something.
const _previz = (p) => !!(p && p.isPrevizTab && p.isPrevizTab());

// Any 3D tab, previz or a lone model. Exposure and channel isolation are
// darkroom controls for a picture; a rendered model has neither, so they step
// aside there — and the exposure slider hides with them (see the CSS).
const _picture = (p) => !(p && p._modelMode);

// A previz tab with something selected: what acts on the selection needs one,
// and without it the keystroke is left for whatever else wants it.
const _sel = (p) => _previz(p) && p.previzSelectedIds().length > 0;
const _hasItems = (p) => _previz(p) && !!(p.previzScene() && p.previzScene().items.length);

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

    // Shift+Delete, so a plain Delete aimed at graph nodes behind the panel can't
    // take snapshots with it. Only answered while the viewer is hovered (see
    // VIEWER_TARGET_ID); `enabled` keeps it from swallowing the key when there is
    // nothing to delete.
    { key: "HistoryDelete", label: "Delete Selected History Snapshots", combo: { key: "Delete", shift: true },
      enabled: (p) => _historyOpen(p) && typeof p.hasDeletableHistory === "function" && p.hasDeletableHistory(),
      run: (p) => p.deleteSelectedHistory() },

    // Maya's manipulator keys, and they only answer on a previz tab — which is
    // what lets R stay the red-channel key everywhere else (see effectiveMap:
    // a combo can carry more than one action, and the first one whose `enabled`
    // passes wins).
    { key: "GizmoSelect", label: "Previz: Select (no gizmo)", combo: { key: "q" },
      enabled: _previz, run: (p) => p.previzSetGizmoMode("none") },
    { key: "GizmoMove",   label: "Previz: Move Tool",         combo: { key: "w" },
      enabled: _previz, run: (p) => p.previzSetGizmoMode("translate") },
    { key: "GizmoRotate", label: "Previz: Rotate Tool",       combo: { key: "e" },
      enabled: _previz, run: (p) => p.previzSetGizmoMode("rotate") },
    { key: "GizmoScale",  label: "Previz: Scale Tool",        combo: { key: "r" },
      enabled: _previz, run: (p) => p.previzSetGizmoMode("scale") },
    { key: "GizmoSpace",  label: "Previz: Local / World Axes", combo: { key: "x" },
      enabled: _previz, run: (p) => p.previzToggleGizmoSpace() },
    // Maya's key for it, and the same meaning: the gizmo drags the pivot.
    { key: "PivotMode",   label: "Previz: Move the Pivot", combo: { key: "Insert" },
      enabled: _previz, run: (p) => p.previzTogglePivotMode() },
    // Ctrl+Z is ComfyUI's own, so it ships unregistered and answers only while
    // the viewer is hovered on a previz tab — where it means the shot, not the
    // graph behind it.
    { key: "PrevizUndo", label: "Previz: Undo", combo: { key: "z", ctrl: true },
      enabled: (p) => _previz(p) && p.previzCanUndo(), run: (p) => p.previzUndo() },
    { key: "PrevizRedo", label: "Previz: Redo", combo: { key: "z", ctrl: true, shift: true },
      enabled: (p) => _previz(p) && p.previzCanRedo(), run: (p) => p.previzRedo() },
    { key: "PrevizRedoY", label: "Previz: Redo (Ctrl+Y)", combo: { key: "y", ctrl: true },
      enabled: (p) => _previz(p) && p.previzCanRedo(), run: (p) => p.previzRedo() },

    // ── Everything else the 3D viewer can do ─────────────────────────────────
    // Each of these is a ComfyUI command, so any of them can be given a key in
    // Settings → Keybinding. Only the ones with an obvious, free key ship with
    // one; the rest are there to be bound. Ctrl+A, Ctrl+G and Delete belong to
    // ComfyUI, so — like Ctrl+Z above — they ship unregistered and answer only
    // while the viewer is hovered on a previz tab with something to act on.
    { key: "PrevizRename",    label: "Previz: Rename Selected",       combo: { key: "F2" },
      enabled: _sel, run: (p) => p.previzBeginRename() },
    { key: "PrevizSelectAll", label: "Previz: Select All",            combo: { key: "a", ctrl: true },
      enabled: _hasItems, run: (p) => p.previzSelectAll() },
    { key: "PrevizDuplicate", label: "Previz: Duplicate Selected",    combo: { key: "d", ctrl: true },
      enabled: _sel, run: (p) => p.previzDuplicate(p.previzSelectedIds()) },
    { key: "PrevizDelete",    label: "Previz: Delete Selected",       combo: { key: "Delete" },
      enabled: _sel, run: (p) => p.previzDelete(p.previzSelectedIds()) },
    { key: "PrevizGroup",     label: "Previz: Group Selected",        combo: { key: "g", ctrl: true },
      enabled: _sel, run: (p) => p.previzGroupSelection() },
    { key: "PrevizVisibility", label: "Previz: Show / Hide Selected",
      enabled: _sel, run: (p) => p.previzToggleVisibility() },
    { key: "PrevizCentrePivot", label: "Previz: Centre Pivot",
      enabled: _sel, run: (p) => p.previzCentrePivot() },
    { key: "PrevizFreeze", label: "Previz: Freeze Transformations",
      enabled: _sel, run: (p) => p.previzFreezeTransforms() },
    { key: "PrevizLookThrough", label: "Previz: Look Through Camera / Back To Free View",
      enabled: _previz, run: (p) => p.previzLookThroughSelected() },

    // Keying. Shift+W / E / R key one channel, as Maya's do.
    { key: "PrevizKey",       label: "Previz: Key Selected",
      enabled: _sel, run: (p) => p.previzKeyAll() },
    { key: "PrevizKeyMove",   label: "Previz: Key Translate",   combo: { key: "W", shift: true },
      enabled: _sel, run: (p) => p.previzKeyAll("position") },
    { key: "PrevizKeyRotate", label: "Previz: Key Rotate",      combo: { key: "E", shift: true },
      enabled: _sel, run: (p) => p.previzKeyAll("rotation") },
    { key: "PrevizKeyScale",  label: "Previz: Key Scale",       combo: { key: "R", shift: true },
      enabled: _sel, run: (p) => p.previzKeyAll("scale") },
    { key: "PrevizDeleteKey", label: "Previz: Delete Key At Playhead",
      enabled: _sel, run: (p) => p.previzDeleteKey() },
    { key: "PrevizAutokey",   label: "Previz: Toggle Autokey",
      enabled: _previz, run: (p) => p.previzToggleAutokey() },
    { key: "PrevizEaseSmooth", label: "Previz: Keys Ease Smooth",
      enabled: _previz, run: (p) => p.previzSetEase("smooth") },
    { key: "PrevizEaseLinear", label: "Previz: Keys Ease Linear",
      enabled: _previz, run: (p) => p.previzSetEase("linear") },
    { key: "PrevizEaseHold",  label: "Previz: Keys Ease Hold",
      enabled: _previz, run: (p) => p.previzSetEase("hold") },

    // Putting things in, and taking the shot out.
    { key: "PrevizNewScene",  label: "Previz: New Scene",
      enabled: _previz, run: (p) => p.previzNewScene() },
    { key: "PrevizAddModel",  label: "Previz: Add Model…",
      enabled: _previz, run: (p) => p.previzAddFromBrowser() },
    { key: "PrevizAddCamera", label: "Previz: Add Camera",
      enabled: _previz, run: (p) => p.previzAddCamera() },
    { key: "PrevizAddImagePlane", label: "Previz: Add Image Plane…",
      enabled: _previz, run: (p) => p.previzAddImagePlane() },
    { key: "PrevizAddGroup",  label: "Previz: Add Group",
      enabled: _previz, run: (p) => p.previzAddGroup() },
    ...PRIMITIVES.map((spec) => ({
        key: `PrevizAdd${spec.label}`, label: `Previz: Add ${spec.label}`,
        enabled: _previz, run: (p) => p.previzAddPrimitive(spec.type),
    })),
    // Worlds: only on a scene that has world items. While walking, the walk
    // owns the keyboard (W A S D, arrows, Shift, F, Esc) and these stand aside.
    { key: "WorldWalk", label: "World: Walk / Stop Walking", combo: { key: "J", shift: true },
      enabled: (p) => _previz(p) && !!(p.previzHasWorld && p.previzHasWorld()), run: (p) => p.previzWalkToggle() },
    { key: "WorldNote", label: "World: Pin a Note", combo: { key: "N", shift: true },
      enabled: (p) => _previz(p) && !!(p.previzHasWorld && p.previzHasWorld()), run: (p) => p.previzFeedbackPlace() },
    { key: "PrevizImportUsd", label: "Previz: Import USD…",
      enabled: _previz, run: (p) => p.previzImportUsd() },
    { key: "PrevizLoadScene", label: "Previz: Load Scene…",
      enabled: _previz, run: (p) => p.previzLoadSceneFile() },
    { key: "PrevizSaveScene", label: "Previz: Save Scene…",
      enabled: _previz, run: (p) => p.previzSaveSceneFile() },
    { key: "PrevizExportUsd", label: "Previz: Export USD…",
      enabled: _previz, run: (p) => p.previzExportUsd() },
    { key: "PrevizRender",    label: "Previz: Render…",
      enabled: _previz, run: (p) => p.previzRenderDialog() },

    // How the canvas looks, and what is open beside it.
    { key: "View3DOriginal",  label: "3D View: Original Materials",
      enabled: _previz, run: (p) => p.previzSetMaterialMode("original") },
    { key: "View3DClay",      label: "3D View: Clay",
      enabled: _previz, run: (p) => p.previzSetMaterialMode("clay") },
    { key: "View3DNormal",    label: "3D View: Normals",
      enabled: _previz, run: (p) => p.previzSetMaterialMode("normal") },
    { key: "View3DWireframe", label: "3D View: Wireframe",
      enabled: _previz, run: (p) => p.previzSetMaterialMode("wireframe") },
    { key: "View3DCycleLook", label: "3D View: Cycle Material Mode",
      enabled: _previz, run: (p) => p.previzCycleMaterialMode() },
    { key: "View3DGrid",      label: "3D View: Show / Hide Grid",
      enabled: _previz, run: (p) => p.previzToggleGrid() },
    { key: "View3DPrevizPanel", label: "3D View: Show / Hide Outliner",
      enabled: _previz, run: (p) => p.togglePanelDocked("previz") },
    { key: "View3DCurvesPanel", label: "3D View: Show / Hide Animation Curves",
      enabled: _previz, run: (p) => p.togglePanelDocked("curves") },
    { key: "View3DChannelBox", label: "3D View: Show / Hide Channel Box",
      enabled: _previz, run: (p) => p.togglePanelDocked("channels") },

    { key: "FitView",      label: "Fit Image To Viewport",   combo: { key: "f" },
      run: (p) => p.fitView() },
    { key: "CycleCompare", label: "Cycle Compare Mode",      combo: { key: "c" },
      run: (p) => p.cycleCompareMode() },
    { key: "ChannelRed",   label: "Isolate Red Channel",     combo: { key: "r" },
      enabled: _picture, run: (p) => p.setChannelView(p.channelView === "red"   ? "all" : "red") },
    { key: "ChannelGreen", label: "Isolate Green Channel",   combo: { key: "g" },
      enabled: _picture, run: (p) => p.setChannelView(p.channelView === "green" ? "all" : "green") },
    { key: "ChannelBlue",  label: "Isolate Blue Channel",    combo: { key: "b" },
      enabled: _picture, run: (p) => p.setChannelView(p.channelView === "blue"  ? "all" : "blue") },
    { key: "ToggleShape",  label: "Toggle Tensor Shape Overlay", combo: { key: "s" },
      run: (p) => p.toggleShapeOverlay() },
    { key: "TogglePageDock", label: "Dock Viewer as a Panel / Float", combo: { key: "d", shift: true },
      run: (p) => p.togglePageDock() },
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

// combo key -> [{ action, combo }], merged the same way ComfyUI merges its own
// stores: defaults, minus the ones the user unset, with the user's bindings
// laid over the top. A user binding pointing somewhere else takes the combo away
// from the viewer, so rebinding one of these keys to a ComfyUI command works.
//
// A combo can carry SEVERAL actions — R is the red channel on an image tab and
// the scale tool on a previz one. resolveViewerAction picks the first whose
// `enabled` guard passes, so at any moment only one of them can fire.
function effectiveMap() {
    const userBindings  = _setting(USER_BINDINGS_SETTING)  || [];
    const unsetBindings = _setting(UNSET_BINDINGS_SETTING) || [];
    if (_memo && _memo.user === userBindings && _memo.unset === unsetBindings) return _memo.map;

    const map = new Map();
    const add = (key, entry) => {
        const list = map.get(key);
        if (list) list.push(entry);
        else map.set(key, [entry]);
    };
    for (const action of VIEWER_ACTIONS) {
        if (action.combo) add(comboKey(action.combo), { action, combo: action.combo });
    }
    for (const binding of unsetBindings) {
        if (!binding) continue;
        const key = comboKey(binding.combo);
        const list = map.get(key);
        if (!list) continue;
        const left = list.filter((e) => e.action.id !== binding.commandId);
        if (left.length) map.set(key, left);
        else map.delete(key);
    }
    for (const binding of userBindings) {
        if (!binding) continue;
        const key = comboKey(binding.combo);
        if (!key) continue;
        const action = _byId.get(binding.commandId);
        // The user's binding replaces whatever the viewer had on that combo; a
        // binding naming something else takes the combo away from the viewer.
        if (action) map.set(key, [{ action, combo: binding.combo }]);
        else        map.delete(key);
    }

    _memo = { user: userBindings, unset: unsetBindings, map };
    return map;
}

/** The viewer action bound to this keystroke in the current state, or null. */
export function resolveViewerAction(ev, panel) {
    const hits = effectiveMap().get(comboKeyFromEvent(ev));
    if (!hits || hits.length === 0) return null;
    if (hits.length === 1) return hits[0].action;
    for (const hit of hits) {
        if (!hit.action.enabled || (panel && hit.action.enabled(panel))) return hit.action;
    }
    return hits[0].action;
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
    for (const hits of effectiveMap().values()) {
        for (const { action, combo } of hits) {
            if (!combosFor.has(action.id)) combosFor.set(action.id, []);
            combosFor.get(action.id).push(combo);
        }
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
        // An action nobody has given a key to has nothing to tell you here —
        // and there are dozens of them on the 3D side, waiting to be bound.
        if (!labels.length) continue;
        rows.push({ keys: _foldKeys(labels), label: action.label });
    }
    for (const row of groupRow.values()) {
        row.keys = _foldKeys(row._labels);
        delete row._labels;
    }
    return rows;
}
