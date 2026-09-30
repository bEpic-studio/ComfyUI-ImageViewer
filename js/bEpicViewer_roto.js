// bEpicViewer_roto.js
// RotoMixin — the in-viewer Roto tool (modelled on Nuke's Roto node).
//
// Data model (serialized to the bEpicImageViewerRoto node's roto_data widget,
// consumed by roto_raster.py). All coordinates are normalized against the
// image, where (0,0) is its top-left and (1,1) its bottom-right — but they are
// NOT clamped to that range. A vertex, tangent or feather point may sit outside;
// the matte is simply cropped to the image resolution when it is rasterized
// (PIL clips the scan-fill, and the preview is cropped to the same rect in
// _rotoRenderComposite). Clamping instead would drag an outside vertex onto the
// border and visibly change the curve of the edges either side of it.
//   layer = {
//     id, name, visible, invert, feather, blur, dilate, opacity, closed:true,
//     mode: union | plus | minus | intersection | xor  — how it combines with
//       the shapes before it in the list (Nuke's ChannelMerge; ROTO_MODES),
//     transform:{tx,ty,rot,sx,sy,px,py},
//     points:[ {x,y, cin?:{x,y}, cout?:{x,y}, feather?:{x,y}} ],
//     keyframes?:{ "<frame>":[points] }
//   }
//   roto = { version:1, layers:[...], global:{invert,blur,dilate,feather} }
//
// Interaction is drawn in screen space via ToolsMixin's _normToDraw so shapes
// track zoom/pan/fit. Editing writes raw (untransformed) points; the shape
// transform + keyframe interpolation are applied for display and re-applied
// identically in Python at render time.

import { svgEl, toolHelp } from "./bEpicViewer_tools.js";
import { readToolStore, writeToolStore, ROTO_WIDGET } from "./bEpicViewer_nodeTools.js";

const HIT = 9;             // screen-px hit radius

// How a shape combines with the shapes before it in the list: the operations of
// the Nuke ChannelMerge node in bepic_templates, the shape as A, what the ones
// before made as B, clamped to 0..1 after each. roto_raster.py (MODES, _merge)
// renders the node's matte with the same formulas; keep the two identical.
export const ROTO_MODES = ["union", "plus", "minus", "intersection", "xor"];
const ROTO_MODE_TIPS = {
    union: "A + B − A·B: add this shape (the default)",
    plus: "A + B: add, doubling where soft edges overlap",
    minus: "B − A: cut this shape out of the ones above",
    intersection: "A · B: keep only where this shape and the ones above overlap",
    xor: "A + B − 2·A·B: where one or the other, not both",
};
const DEF_TF = () => ({ tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, px: 0.5, py: 0.5 });
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d = 0) => (isFinite(+v) ? +v : d);

// Standard OS cursors (the earlier custom data-URI SVG cursors didn't render
// reliably in Chrome, so we use plain CSS keywords).
const CUR_PEN = "crosshair";     // laying down a shape's points
const CUR_ROTATE = "grab";       // rotating a multi-point selection

// ── keyframe easing ───────────────────────────────────────────────────────────
// Per-keyframe ease is a cubic-bezier timing curve (like CSS cubic-bezier):
// the segment between key `lo` and key `hi` maps time-fraction x∈[0,1] → eased
// t via control points P1=(lo.out) and P2=(hi.in). Defaults are (1/3,1/3) and
// (2/3,2/3) → a straight line (linear). This exact math is mirrored in
// roto_raster.py's _seg_ease so the preview matches the rendered mask.
function bezierAxis(t, a1, a2) {          // cubic with P0=0, P3=1
    const mt = 1 - t;
    return 3 * mt * mt * t * a1 + 3 * mt * t * t * a2 + t * t * t;
}
function bezierSolveT(x, p1x, p2x) {
    let t = x;
    for (let i = 0; i < 8; i++) {          // Newton-Raphson
        const err = bezierAxis(t, p1x, p2x) - x;
        if (Math.abs(err) < 1e-5) return t;
        const d = 3 * (1 - t) * (1 - t) * p1x + 6 * (1 - t) * t * (p2x - p1x) + 3 * t * t * (1 - p2x);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
    }
    let lo = 0, hi = 1; t = x;             // bisection fallback
    for (let i = 0; i < 24; i++) {
        const xt = bezierAxis(t, p1x, p2x);
        if (Math.abs(xt - x) < 1e-5) break;
        if (xt < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
    }
    return t;
}
function bezierEase(x, p1x, p1y, p2x, p2y) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return bezierAxis(bezierSolveT(x, p1x, p2x), p1y, p2y);
}

let _rotoIdSeq = 1;

export const RotoMixin = {

    _rotoInit() {
        // One unified interaction (no draw/edit/transform mode switch): the
        // pointer's target decides the action. `drawing` holds the layer whose
        // outline is still being laid down; a multi-point `selPts` selection
        // shows a transform box.
        this._roto = {
            layers: [], global: { invert: false, blur: 0, dilate: 0, feather: 0 },
            selLayer: -1, selPts: new Set(), selAngle: 0,
            showMask: false, autokey: false, ease: "smooth",
            drawing: null, drag: null,
        };
    },

    _rotoClearState() {
        if (!this._roto) return;
        this._roto.layers = [];
        this._roto.global = { invert: false, blur: 0, dilate: 0, feather: 0 };
        this._roto.selLayer = -1;
        this._roto.selPts = new Set();
        this._roto.selAngle = 0;
        this._roto.drawing = null;
    },

    _rotoLoadFromNode(node) {
        this._rotoClearState();
        let raw = readToolStore(node, ROTO_WIDGET, "");
        if (!raw) { this._rotoRefreshPanel?.(); this._rotoRefreshKfInfo?.(); return; }
        try {
            const obj = JSON.parse(raw);
            if (obj && Array.isArray(obj.layers)) {
                this._roto.layers = obj.layers.map(normalizeLayer);
                if (obj.global) Object.assign(this._roto.global, obj.global);
                this._roto.selLayer = this._roto.layers.length ? 0 : -1;
            }
        } catch (e) { /* ignore malformed */ }
        this._rotoRefreshPanel?.();
        this._rotoRefreshKfInfo?.();
    },

    _rotoSave() {
        const node = this._toolState.node;
        if (!node) return;
        const payload = {
            version: 1,
            layers: this._roto.layers,
            global: this._roto.global,
        };
        writeToolStore(node, ROTO_WIDGET, payload);
    },

    // ── activation / panel ────────────────────────────────────────────────────
    _rotoActivate(panel) {
        this._rotoPanel = panel;
        this._rotoBuildPanel();
        // The shapes' curves have a dock panel of their own
        // (bEpicViewer_rotoCurves.js). It opens from the Roto Curves button
        // only — never by itself when the tool comes up.
        this._rotoRefreshKfInfo();
    },

    _rotoDeactivate() {
        this._rotoHideMask();
        this._roto.drawing = null;
        this._roto.drag = null;
        this._rotoRenderTimelineKeys();   // clears ticks
        this.rotoShowCurves?.(false);
    },

    _rotoCurLayer() {
        const i = this._roto.selLayer;
        return (i >= 0 && i < this._roto.layers.length) ? this._roto.layers[i] : null;
    },

    _rotoAddLayer() {
        const layer = normalizeLayer({
            id: "l" + (_rotoIdSeq++),
            name: "Shape " + (this._roto.layers.length + 1),
            points: [],
        });
        this._roto.layers.push(layer);
        this._roto.selLayer = this._roto.layers.length - 1;
        this._roto.selPts = new Set();
        this._roto.selAngle = 0;
        this._roto.drawing = layer;      // begin drawing this shape
        if (this._toolDraw) this._toolDraw.style.cursor = CUR_PEN;
        this._rotoRefreshPanel();
        this._toolRedraw();
    },

    _rotoDeleteLayer(i) {
        if (i < 0 || i >= this._roto.layers.length) return;
        this._roto.layers.splice(i, 1);
        if (this._roto.selLayer >= this._roto.layers.length) this._roto.selLayer = this._roto.layers.length - 1;
        this._roto.selPts = new Set();
        this._roto.drawing = null;
        this._rotoSave();
        this._rotoRefreshPanel();
        this._toolRedraw();
    },

    _rotoBuildPanel() {
        // The Tool dock panel can ask for a fill while it is still opening,
        // before _rotoActivate has handed the panel over.
        const p = this._rotoPanel || (this._rotoPanel = this._toolPanel);
        if (!p) return;
        p.innerHTML = "";
        // No title of its own: the Tool dock panel's bar says "Roto".

        if (!this._toolState.node) {
            this._toolMissingNodeBody(p, "roto");
            return;
        }

        // Which Roto node these shapes belong to. It is whichever one is
        // selected on the canvas, so it is not always the tab's own.
        const bound = this._toolBoundNodeRow?.();
        if (bound) p.appendChild(bound);

        // Layer list: each shape with its mode (how it combines with the ones above)
        this._rotoLayerList = el("div", "", "bepic-layer-list");
        p.appendChild(this._rotoLayerList);

        const layBtns = el("div", "", "row btns");
        const addB = el("button", "+ Shape", "bepic-act");
        addB.onclick = () => this._rotoAddLayer();
        const delB = el("button", "Delete", "bepic-act bepic-danger");
        delB.onclick = () => this._rotoDeleteLayer(this._roto.selLayer);
        layBtns.appendChild(addB); layBtns.appendChild(delB);
        p.appendChild(layBtns);

        // Per-shape sliders
        this._rotoShapeControls = el("div");
        p.appendChild(this._rotoShapeControls);

        // Keyframes: keyed with the buttons beside the timeline (Set Key, Delete
        // Key, Autokey, ease — the same ones previz uses), timed in the Roto
        // Curves panel.
        p.appendChild(el("h4", "Keyframes"));
        const kfRow = el("div", "", "row btns");
        const curvesB = el("button", "Roto Curves", "bepic-act");
        curvesB.title = "Show or hide the shapes' animation curves";
        curvesB.onclick = () => this.rotoToggleCurves?.();
        kfRow.appendChild(curvesB);
        p.appendChild(kfRow);
        p.appendChild(el("div",
            "Key with <b>+ × ○</b> and the ease menu beside the timeline; " +
            "drag the orange ticks to retime.",
            "bepic-tool-hint"));

        // Global controls
        p.appendChild(el("h4", "Global matte"));
        p.appendChild(slider("Feather", 0, 100, this._roto.global.feather, (v) => { this._roto.global.feather = v; this._rotoSave(); this._toolRedraw(); }));
        p.appendChild(slider("Blur", 0, 100, this._roto.global.blur, (v) => { this._roto.global.blur = v; this._rotoSave(); this._toolRedraw(); }));
        p.appendChild(slider("Dilate", -50, 50, this._roto.global.dilate, (v) => { this._roto.global.dilate = v; this._rotoSave(); this._toolRedraw(); }));
        this._rotoGlobalInvCb = checkbox("Invert all", this._roto.global.invert, (v) => { this._roto.global.invert = v; this._rotoSave(); this._toolRedraw(); });
        p.appendChild(this._rotoGlobalInvCb.row);

        // Preview toggle + hint
        this._rotoPreviewCb = checkbox("Show mask preview", this._roto.showMask, (v) => { this._roto.showMask = v; this._toolRedraw(); });
        p.appendChild(this._rotoPreviewCb.row);
        p.appendChild(toolHelp("How to draw",
            "<b>+ Shape</b>, then click to add points (drag to curve); click the first point to close. " +
            "After closing: drag a vertex to move it, single-click shows its tangents, " +
            "<b>Ctrl+drag</b> a vertex pulls out the feather (an outer curve with its own " +
            "<span style='color:#c98aff;'>tangents</span> you can drag). Right-click a vertex deletes, " +
            "Alt+click an edge inserts. Drag from empty space across points to select them, then drag inside " +
            "the box to move, corners to scale, outside to rotate. Middle-drag pans."));

        this._rotoRefreshLayerList();
        this._rotoRefreshShapeControls();
        this._rotoRefreshKfInfo();
    },

    _rotoRefreshPanel() {
        if (this._toolState.active === "roto" && this._rotoPanel) this._rotoBuildPanel();
    },

    _rotoRefreshLayerList() {
        const list = this._rotoLayerList;
        if (!list) return;
        list.innerHTML = "";
        if (this._roto.layers.length) {
            const head = el("div", "", "bepic-layer-head");
            head.appendChild(el("span", "Shape", "nm"));
            const mh = el("span", "Mode", "mode");
            mh.title = "How each shape combines with the shapes above it in the list — Nuke's ChannelMerge";
            head.appendChild(mh);
            head.appendChild(el("span", "", "del"));
            list.appendChild(head);
        }
        this._roto.layers.forEach((layer, i) => {
            const row = el("div", "", "bepic-layer-row" + (i === this._roto.selLayer ? " sel" : ""));
            const vis = el("span", layer.visible ? "◉" : "◎", "vis");
            vis.onclick = (e) => { e.stopPropagation(); layer.visible = !layer.visible; this._rotoSave(); this._rotoRefreshLayerList(); this._toolRedraw(); };
            const nm = el("span", layer.name || ("Shape " + (i + 1)), "nm");
            nm.ondblclick = (e) => {
                e.stopPropagation();
                // Undocked, a bare prompt() opens behind the popout — see
                // LayoutMixin._dlgWin for the whole story.
                const dlgWin = (this._viewerWindow && this._viewerWindow()) || window;
                const v = dlgWin.prompt("Shape name:", layer.name || "");
                if (v != null) { layer.name = v; this._rotoSave(); this._rotoRefreshLayerList(); }
            };
            const mode = el("select", null, "mode");
            for (const m of ROTO_MODES) {
                const o = el("option", m);
                o.value = m;
                o.title = ROTO_MODE_TIPS[m];
                mode.appendChild(o);
            }
            mode.value = layer.mode || "union";
            mode.title = ROTO_MODE_TIPS[mode.value];
            mode.onclick = (e) => e.stopPropagation();
            mode.onmousedown = (e) => e.stopPropagation();
            mode.onchange = () => {
                layer.mode = mode.value;
                mode.title = ROTO_MODE_TIPS[mode.value];
                this._rotoSave();
                this._toolRedraw();
            };
            const del = el("span", "✕", "del");
            del.onclick = (e) => { e.stopPropagation(); this._rotoDeleteLayer(i); };
            row.appendChild(vis); row.appendChild(nm); row.appendChild(mode); row.appendChild(del);
            row.onclick = () => {
                this._roto.selLayer = i; this._roto.selPts = new Set();
                this._roto.drawing = null;   // switching shapes ends any in-progress draw
                this._rotoRefreshLayerList(); this._rotoRefreshShapeControls();
                this._rotoRefreshKfInfo(); this._toolRedraw();
            };
            list.appendChild(row);
        });
    },

    _rotoRefreshShapeControls() {
        const box = this._rotoShapeControls;
        if (!box) return;
        box.innerHTML = "";
        const layer = this._rotoCurLayer();
        if (!layer) return;
        box.appendChild(el("h4", "Shape matte"));
        box.appendChild(slider("Feather", 0, 100, layer.feather, (v) => { layer.feather = v; this._rotoSave(); this._toolRedraw(); }));
        box.appendChild(slider("Blur", 0, 100, layer.blur, (v) => { layer.blur = v; this._rotoSave(); this._toolRedraw(); }));
        box.appendChild(slider("Dilate", -50, 50, layer.dilate, (v) => { layer.dilate = v; this._rotoSave(); this._toolRedraw(); }));
        box.appendChild(slider("Opacity", 0, 100, Math.round(layer.opacity * 100), (v) => { layer.opacity = v / 100; this._rotoSave(); this._toolRedraw(); }));
        const inv = checkbox("Invert shape", layer.invert, (v) => { layer.invert = v; this._rotoSave(); this._toolRedraw(); });
        box.appendChild(inv.row);

        box.appendChild(el("h4", "Transform"));
        box.appendChild(numRow("Rotate°", layer.transform.rot, 1, (v) => { layer.transform.rot = v; this._rotoSave(); this._toolRedraw(); }));
        box.appendChild(numRow("Scale", layer.transform.sx, 0.01, (v) => { layer.transform.sx = layer.transform.sy = v; this._rotoSave(); this._toolRedraw(); }));
        const resetT = el("button", "Reset transform", "bepic-act");
        resetT.onclick = () => { layer.transform = DEF_TF(); this._rotoSave(); this._rotoRefreshShapeControls(); this._toolRedraw(); };
        box.appendChild(resetT);
    },

    // Keyframes are surfaced as draggable orange ticks on the transport timeline
    // and in the collapsible curve editor above it (not as text in the panel).
    _rotoRefreshKfInfo() {
        this._rotoRenderTimelineKeys();
        this.rotoRefreshCurves?.();
        this.keyBarSync?.();
    },

    _rotoFrame() { return Math.max(0, Math.round(this.currentFrame || 0)); },

    // ── keyframe ticks on the timeline + curve editor ─────────────────────────
    _rotoKfTicksHost() { return this.container?.querySelector?.("#kf-ticks"); },

    _rotoTimelineBounds() {
        const b = this.getTimelineBounds ? this.getTimelineBounds() : { min: 0, max: 0 };
        return { min: b.min, max: b.max, total: Math.max(0, b.max - b.min) };
    },

    _rotoCurKeys(layer) {
        layer = layer || this._rotoCurLayer();
        if (!layer || !layer.keyframes) return [];
        return Object.keys(layer.keyframes).map(Number).filter((f) => isFinite(f)).sort((a, b) => a - b);
    },

    // Orange draggable keyframe ticks overlaid on the timeline.
    _rotoRenderTimelineKeys() {
        if (this._rotoTickDragging) return;   // don't yank the tick out from under a drag
        const host = this._rotoKfTicksHost();
        if (!host) return;
        host.innerHTML = "";
        host.dataset.owner = "roto";   // shared with previz's ticks; see _previzRenderTicks
        if (!this._toolState || this._toolState.active !== "roto") return;
        const layer = this._rotoCurLayer();
        const keys = this._rotoCurKeys(layer);
        if (!keys.length) return;
        const { min, total } = this._rotoTimelineBounds();
        const cur = this._rotoFrame();
        for (const f of keys) {
            const pct = total === 0 ? 0 : ((f - min) / total) * 100;
            const t = document.createElement("div");
            t.className = "kf-tick" + (f === cur ? " cur" : "");
            t.style.left = pct + "%";
            t.title = "Keyframe " + f + " — drag to retime · double-click to delete";
            t.onmousedown = (e) => this._rotoTickDown(e, layer, f);
            t.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); this._rotoDeleteKeyAt(layer, f); };
            host.appendChild(t);
        }
    },

    _rotoTickDown(e, layer, frame) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const tickEl = e.currentTarget;
        // Map against the ticks host (the ticks are positioned inside it). Using
        // the element's OWN document/window keeps drags working when the viewer
        // is popped out into a separate window.
        const host = tickEl.parentElement || this._rotoKfTicksHost();
        if (!host) return;
        const rect = host.getBoundingClientRect();
        if (!rect.width) return;
        const { min, total } = this._rotoTimelineBounds();
        const win = tickEl.ownerDocument.defaultView || window;
        this._rotoTickDragging = true;   // suppress tick re-render mid-drag
        let target = frame;
        const move = (ev) => {
            ev.preventDefault();
            const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            target = min + Math.round(pct * total);
            tickEl.style.left = (pct * 100) + "%";
            tickEl.title = "Keyframe " + target + " — drag to retime · double-click to delete";
        };
        const up = () => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            this._rotoTickDragging = false;
            if (target !== frame) this._rotoMoveKey(layer, frame, target);
            this._rotoRefreshKfInfo();
        };
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
    },

    // Retime a keyframe (rename its frame key). A collision overwrites; the
    // dragged key wins.
    _rotoMoveKey(layer, from, to) {
        if (!layer || !layer.keyframes || from === to) return;
        to = Math.max(0, Math.round(to));
        const kfs = layer.keyframes;
        if (!(String(from) in kfs)) return;
        kfs[to] = kfs[from];
        delete kfs[from];
        if (layer.tangents && String(from) in layer.tangents) {   // carry ease handles along
            layer.tangents[to] = layer.tangents[from];
            delete layer.tangents[from];
        }
        this._rotoSave();
        this._toolRedraw();
    },

    _rotoDeleteKeyAt(layer, frame) {
        if (!layer || !layer.keyframes) return;
        delete layer.keyframes[frame];
        if (layer.tangents) delete layer.tangents[frame];
        if (Object.keys(layer.keyframes).length === 0) delete layer.keyframes;
        this._rotoSave();
        this._rotoRefreshKfInfo();
        this._toolRedraw();
    },

    // ── keyframe helpers ──────────────────────────────────────────────────────
    _rotoRawPoints(layer, frame) {
        const kfs = layer.keyframes;
        if (!kfs || Object.keys(kfs).length === 0) return layer.points || [];
        const frames = Object.keys(kfs).map(Number).sort((a, b) => a - b);
        if (frame <= frames[0]) return kfs[frames[0]];
        if (frame >= frames[frames.length - 1]) return kfs[frames[frames.length - 1]];
        let lo = frames[0], hi = frames[frames.length - 1];
        for (const fr of frames) { if (fr <= frame) lo = fr; if (fr >= frame) { hi = fr; break; } }
        if (hi === lo) return kfs[lo];
        const a = kfs[lo], b = kfs[hi];
        if (a.length !== b.length) return (frame - lo) <= (hi - frame) ? a : b;
        const t = this._rotoSegEase(layer, lo, hi, (frame - lo) / (hi - lo));
        return a.map((pa, i) => interpPoint(pa, b[i], t));
    },

    // ── per-keyframe ease tangents ────────────────────────────────────────────
    // Tangent handles are stored per keyframe frame: { ox,oy (out control point),
    // ix,iy (in control point) } in the segment's normalized [0,1]² time/value
    // space. Absent → derived from the legacy scalar `ease` (0 linear .. 1 smooth).
    // `hold` on a key: the shape stays as it is until the next key (a step).
    _rotoKeyTangent(layer, frame) {
        const t = layer && layer.tangents && layer.tangents[String(frame)];
        if (t) return { ox: num(t.ox, 1 / 3), oy: num(t.oy, 1 / 3), ix: num(t.ix, 2 / 3), iy: num(t.iy, 2 / 3),
                        hold: !!t.hold };
        const e = Math.max(0, Math.min(1, +((layer || {}).ease) || 0));   // migrate old global ease
        return { ox: 1 / 3, oy: (1 - e) / 3, ix: 2 / 3, iy: 2 / 3 + e / 3, hold: false };
    },

    /**
     * The ease presets of the key bar's menu, as tangents on one key: how the
     * shape leaves the key and how it arrives at it. The same three names as
     * previz's keys, so the one menu means the same thing in both.
     */
    _rotoEasePreset(name) {
        if (name === "hold") return { hold: true };
        if (name === "linear") return { ox: 1 / 3, oy: 1 / 3, ix: 2 / 3, iy: 2 / 3, hold: false };
        return { ox: 1 / 3, oy: 0, ix: 2 / 3, iy: 1, hold: false };       // smooth: ease out and in
    },

    /** The menu's choice: for new keys, and for the key under the playhead if there is one. */
    _rotoApplyEase(name) {
        this._roto.ease = name || "smooth";
        const layer = this._rotoCurLayer();
        const f = this._rotoFrame();
        if (layer && layer.keyframes && String(f) in layer.keyframes) {
            layer.tangents = layer.tangents || {};
            layer.tangents[String(f)] = Object.assign(this._rotoKeyTangent(layer, f), this._rotoEasePreset(this._roto.ease));
            this._rotoSave();
            this._rotoRefreshKfInfo();
            this._toolRedraw();
        }
    },

    _rotoSetKeyTangent(layer, frame, patch) {
        layer.tangents = layer.tangents || {};
        layer.tangents[String(frame)] = Object.assign(this._rotoKeyTangent(layer, frame), patch);
    },

    // Eased parameter for the segment lo→hi at time fraction x (0..1).
    _rotoSegEase(layer, lo, hi, x) {
        const a = this._rotoKeyTangent(layer, lo), b = this._rotoKeyTangent(layer, hi);
        if (a.hold) return x >= 1 ? 1 : 0;
        return bezierEase(x, a.ox, a.oy, b.ix, b.iy);
    },

    // The array of raw points that edits should mutate for the current frame.
    _rotoEditablePoints(layer) {
        const f = this._rotoFrame();
        const animated = layer.keyframes && Object.keys(layer.keyframes).length > 0;
        if (animated) {
            if (!layer.keyframes[f]) layer.keyframes[f] = clonePoints(this._rotoRawPoints(layer, f));
            return layer.keyframes[f];
        }
        if (this._roto.autokey && f > 0) {
            layer.keyframes = layer.keyframes || {};
            layer.keyframes[f] = clonePoints(layer.points);
            // also anchor a key at 0 so interpolation has a start
            if (!layer.keyframes[0]) layer.keyframes[0] = clonePoints(layer.points);
            return layer.keyframes[f];
        }
        return layer.points;
    },

    _rotoSetKey() {
        const layer = this._rotoCurLayer();
        if (!layer) return;
        const f = this._rotoFrame();
        layer.keyframes = layer.keyframes || {};
        const fresh = !(String(f) in layer.keyframes);
        layer.keyframes[f] = clonePoints(this._rotoRawPoints(layer, f));
        // A new key eases the way the key bar's menu says; re-keying one keeps
        // the handles it has.
        if (fresh) {
            layer.tangents = layer.tangents || {};
            layer.tangents[String(f)] = Object.assign(this._rotoKeyTangent(layer, f),
                                                      this._rotoEasePreset(this._roto.ease));
        }
        this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
    },

    _rotoDelKey() {
        const layer = this._rotoCurLayer();
        if (!layer || !layer.keyframes) return;
        const f = this._rotoFrame();
        delete layer.keyframes[f];
        if (layer.tangents) delete layer.tangents[f];
        if (Object.keys(layer.keyframes).length === 0) delete layer.keyframes;
        this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
    },

    // ── transform (pixel-space, matches Python) ───────────────────────────────
    _rotoApplyTf(pt, tf) {
        const { w, h } = this._toolImgSize();
        if (!w || !h || !tf) return pt;
        let x = pt.x * w, y = pt.y * h;
        const px = tf.px * w, py = tf.py * h;
        let dx = (x - px) * tf.sx, dy = (y - py) * tf.sy;
        if (tf.rot) {
            const r = tf.rot * Math.PI / 180, ca = Math.cos(r), sa = Math.sin(r);
            [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
        }
        x = dx + px + tf.tx * w; y = dy + py + tf.ty * h;
        return { x: x / w, y: y / h };
    },

    _rotoInvTf(pt, tf) {
        const { w, h } = this._toolImgSize();
        if (!w || !h || !tf) return pt;
        let x = pt.x * w, y = pt.y * h;
        const px = tf.px * w, py = tf.py * h;
        let dx = x - px - tf.tx * w, dy = y - py - tf.ty * h;
        if (tf.rot) {
            const r = -tf.rot * Math.PI / 180, ca = Math.cos(r), sa = Math.sin(r);
            [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
        }
        dx /= (tf.sx || 1); dy /= (tf.sy || 1);
        return { x: (dx + px) / w, y: (dy + py) / h };
    },

    _rotoDisplayPoints(layer) {
        const raw = this._rotoRawPoints(layer, this._rotoFrame());
        const tf = layer.transform;
        return raw.map((p) => {
            const d = { ...this._rotoApplyTf({ x: p.x, y: p.y }, tf) };
            if (p.cin) d.cin = this._rotoApplyTf(p.cin, tf);
            if (p.cout) d.cout = this._rotoApplyTf(p.cout, tf);
            if (p.feather) {
                d.feather = { ...this._rotoApplyTf(p.feather, tf) };
                if (p.feather.cin) d.feather.cin = this._rotoApplyTf(p.feather.cin, tf);
                if (p.feather.cout) d.feather.cout = this._rotoApplyTf(p.feather.cout, tf);
            }
            return d;
        });
    },

    // ── rendering ─────────────────────────────────────────────────────────────
    _rotoRender() {
        const draw = this._toolDraw;

        // Mask preview: the shapes' mattes combined by their modes, as the node
        // will (see _rotoRenderComposite).
        if (this._roto.showMask) this._rotoRenderComposite();
        else this._rotoHideMask();

        // Outlines for every layer; handles only for the selected one.
        this._roto.layers.forEach((layer, li) => {
            if (!layer.visible && li !== this._roto.selLayer) return;
            const dpts = this._rotoDisplayPoints(layer);
            const isSel = li === this._roto.selLayer;
            const closed = !(this._roto.drawing === layer);
            const d = this._rotoPathD(dpts, closed);
            if (d) draw.appendChild(svgEl("path", {
                d, fill: "none",
                stroke: isSel ? "#ff8a00" : "rgba(255,255,255,.55)",
                "stroke-width": isSel ? 1.6 : 1.2,
                "stroke-dasharray": this._roto.drawing === layer ? "4 3" : "none",
            }));
            if (!isSel) return;

            // Outer feather curve: the editable spline the soft edge blends out to.
            if (dpts.some((p) => p.feather)) {
                const fd = this._rotoPathD(this._rotoFeatherPts(dpts, 1), true);
                if (fd) draw.appendChild(svgEl("path", {
                    d: fd, fill: "none", stroke: "#e6a9ff", "stroke-width": 1,
                    "stroke-dasharray": "4 3", opacity: 0.85,
                }));
            }

            // Tangent / feather handles only when a single point is selected, so a
            // click reveals its curve controls; a multi-selection shows the box.
            const showHandles = this._roto.selPts.size < 2 && this._roto.drawing !== layer;

            dpts.forEach((p, i) => {
                const scr = this._normToDraw(p.x, p.y);
                if (!scr) return;
                const selected = this._roto.selPts.has(i);

                if (selected && showHandles) {
                    for (const hk of ["cin", "cout"]) {
                        if (!p[hk]) continue;
                        const hs = this._normToDraw(p[hk].x, p[hk].y);
                        if (!hs) continue;
                        draw.appendChild(svgEl("line", { x1: scr.x, y1: scr.y, x2: hs.x, y2: hs.y, stroke: "#6cf", "stroke-width": 1 }));
                        draw.appendChild(svgEl("circle", { cx: hs.x, cy: hs.y, r: 3.5, fill: "#6cf", stroke: "#000", "stroke-width": 1, "data-h": hk, "data-i": i }));
                    }
                    if (p.feather) {
                        const fs = this._normToDraw(p.feather.x, p.feather.y);
                        if (fs) {
                            draw.appendChild(svgEl("line", { x1: scr.x, y1: scr.y, x2: fs.x, y2: fs.y, stroke: "#c9a", "stroke-width": 1, "stroke-dasharray": "3 2" }));
                            // feather tangent handles (outer-curve control points)
                            const fh = this._rotoFeatherHandles(p);
                            for (const hk of ["cin", "cout"]) {
                                if (!fh || !fh[hk]) continue;
                                const hs = this._normToDraw(fh[hk].x, fh[hk].y);
                                if (!hs) continue;
                                draw.appendChild(svgEl("line", { x1: fs.x, y1: fs.y, x2: hs.x, y2: hs.y, stroke: "#c9a", "stroke-width": 1 }));
                                draw.appendChild(diamond(hs.x, hs.y, 3, "#c98aff"));
                            }
                            draw.appendChild(diamond(fs.x, fs.y, 4, "#e6a9ff"));
                        }
                    }
                }

                const sq = svgEl("rect", {
                    x: scr.x - 3.5, y: scr.y - 3.5, width: 7, height: 7,
                    fill: selected ? "#ff8a00" : "#fff", stroke: "#000", "stroke-width": 1,
                });
                draw.appendChild(sq);
            });

            // Transform box around a multi-point selection.
            if (this._roto.selPts.size >= 2) {
                const box = this._rotoSelBox(dpts);
                if (box) this._rotoRenderSelBox(box);
            }
        });
    },

    // ── mask preview ──────────────────────────────────────────────────────────
    // The matte the node will make, on a canvas under the outlines: each shape
    // drawn on its own — the per-vertex feather as a ramp of concentric
    // contours between the shape and its feather curve (roto_raster.py's
    // distance ramp), Dilate as a round-joined stroke of the outline, the
    // Feather/Blur sliders as a Gaussian, then Invert and Opacity — and the
    // shapes combined in list order by their modes, exactly as roto_raster.py
    // combines them (ROTO_MODES). The global sliders are added to each shape's
    // own, as an approximation of the node's global pass; the global Invert and
    // the crop to the image are exact. Worked at up to ~0.9 Mpx and stretched
    // to the viewport.

    _rotoMaskCanvases(W, H) {
        const doc = this.viewport.ownerDocument;
        if (!this._rotoMaskCanvas) {
            const cv = doc.createElement("canvas");
            cv.className = "bepic-roto-mask";
            cv.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:41;";
            this.viewport.insertBefore(cv, this._toolDraw);
            this._rotoMaskCanvas = cv;
            this._rotoScratch = [doc.createElement("canvas"), doc.createElement("canvas")];
        }
        for (const c of [this._rotoMaskCanvas, ...this._rotoScratch]) {
            if (c.width !== W) c.width = W;
            if (c.height !== H) c.height = H;
        }
        return this._rotoScratch;
    },

    _rotoHideMask() {
        if (this._rotoMaskCanvas) this._rotoMaskCanvas.style.display = "none";
    },

    _rotoRenderComposite() {
        const frameD = this._rotoFrameRectD();
        // The viewport, not the draw layer's box: that svg keeps its default
        // 300x150 and draws the rest as overflow; both start at the viewport's
        // top-left, so the paths' coordinates hold on the canvas as they are.
        const cw = this.viewport.clientWidth, ch = this.viewport.clientHeight;
        if (!frameD || cw < 2 || ch < 2) { this._rotoHideMask(); return; }
        const k = Math.min(1, Math.sqrt(900000 / (cw * ch)));
        const W = Math.max(1, Math.round(cw * k)), H = Math.max(1, Math.round(ch * k));
        const [sa, sb] = this._rotoMaskCanvases(W, H);
        this._rotoMaskCanvas.style.width = cw + "px";
        this._rotoMaskCanvas.style.height = ch + "px";
        const g = this._roto.global;
        const spp = this._rotoScreenPerImgPx();
        const n = W * H;

        // The image rectangle: everything outside it is cropped off the matte.
        const inImage = this._rotoAlphaOf(sa, k, (ctx) => ctx.fill(new Path2D(frameD)));
        const acc = new Float32Array(n);
        for (const layer of this._roto.layers) {
            if (!layer.visible) continue;
            const a = this._rotoLayerAlpha(layer, sa, sb, k, spp, g);
            if (!a) {
                // Nothing drawn is A = 0 everywhere, which only intersection notices.
                if ((layer.mode || "union") === "intersection") acc.fill(0);
                continue;
            }
            rotoMerge(layer.mode || "union", acc, a);
        }
        const out = this._rotoMaskCanvas.getContext("2d", { willReadFrequently: true });
        const img = out.createImageData(W, H);
        const px = img.data;
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            let v = acc[i];
            if (g.invert) v = 1 - v;
            v *= inImage[i];
            px[j] = 255; px[j + 1] = 120; px[j + 2] = 0;
            px[j + 3] = Math.round(v * 0.45 * 255);
        }
        out.putImageData(img, 0, 0);
        this._rotoMaskCanvas.style.display = "block";
    },

    /** The alpha a draw callback leaves on a cleared canvas, 0..1 per pixel. */
    _rotoAlphaOf(canvas, k, draw) {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(k, 0, 0, k, 0, 0);
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#fff";
        draw(ctx);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const a = new Float32Array(canvas.width * canvas.height);
        for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j] / 255;
        return a;
    },

    /** One shape's matte as alpha (0..1, canvas pixels), or null when it draws nothing. */
    _rotoLayerAlpha(layer, sa, sb, k, spp, g) {
        const dpts = this._rotoDisplayPoints(layer);
        const coreD = dpts.length >= 3 ? this._rotoPathD(dpts, true) : null;
        if (!coreD) return null;
        const core = new Path2D(coreD);
        // Uniform softening and grow/shrink from the sliders, image px → screen px.
        const featherImg = (+layer.feather || 0) + (+g.feather || 0);
        const blurImg    = (+layer.blur || 0)    + (+g.blur || 0);
        const sigmaScr   = Math.min(80, (featherImg * 0.5 + blurImg) * spp);
        const dilImg     = (+layer.dilate || 0) + (+g.dilate || 0);
        const dilScr     = Math.min(60, Math.abs(dilImg) * spp);

        const shape = (ctx) => {
            // Per-vertex feather: nested contours from the feather curve in to
            // the shape, each adding just enough cover that it ramps 0 → 1 evenly.
            if (dpts.some((p) => p.feather)) {
                const BANDS = 6;
                let prev = 0;
                for (let j = 1; j <= BANDS; j++) {
                    const bd = this._rotoPathD(this._rotoFeatherPts(dpts, 1 - (j - 1) / BANDS), true);
                    const c = j / (BANDS + 1);
                    if (bd) {
                        ctx.globalAlpha = (c - prev) / (1 - prev);
                        ctx.fill(new Path2D(bd));
                    }
                    prev = c;
                }
                ctx.globalAlpha = 1;
            }
            ctx.fill(core);
            if (dilScr >= 0.5) {
                ctx.lineJoin = "round";
                ctx.lineWidth = 2 * dilScr;
                if (dilImg < 0) ctx.globalCompositeOperation = "destination-out";
                ctx.stroke(core);
                ctx.globalCompositeOperation = "source-over";
            }
        };
        let a;
        if (sigmaScr > 0.3) {
            // Drawn, then blurred onto the second canvas; filter lengths are in
            // canvas pixels, hence * k.
            this._rotoAlphaOf(sa, k, shape);
            a = this._rotoAlphaOf(sb, k, (ctx) => {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.filter = `blur(${(sigmaScr * k).toFixed(2)}px)`;
                ctx.drawImage(sa, 0, 0);
                ctx.filter = "none";
            });
        } else {
            a = this._rotoAlphaOf(sa, k, shape);
        }
        const op = Math.max(0, Math.min(1, layer.opacity == null ? 1 : +layer.opacity));
        if (layer.invert) for (let i = 0; i < a.length; i++) a[i] = (1 - a[i]) * op;
        else if (op !== 1) for (let i = 0; i < a.length; i++) a[i] *= op;
        return a;
    },

    // The outer-feather counterpart of a display vertex: its feather point plus
    // that point's OWN bezier tangents. When a feather tangent is absent it
    // falls back to the core tangent translated by the feather offset, so the
    // outer curve mirrors the shape until the user pulls the feather handle.
    _rotoFeatherHandles(p) {
        const f = p.feather;
        if (!f) return null;
        const off = { x: f.x - p.x, y: f.y - p.y };
        return {
            x: f.x, y: f.y,
            cout: f.cout || (p.cout ? { x: p.cout.x + off.x, y: p.cout.y + off.y } : undefined),
            cin: f.cin || (p.cin ? { x: p.cin.x + off.x, y: p.cin.y + off.y } : undefined),
        };
    },

    // Feather contour points at blend factor t (0 = inner roto curve, 1 = outer
    // feather curve). Position AND tangents blend, so the soft edge morphs from
    // the shape spline to the feather spline — mirrors _contour(use_feather=True).
    _rotoFeatherPts(dpts, t = 1) {
        return dpts.map((p) => {
            const inner = { x: p.x, y: p.y };
            if (p.cin) inner.cin = p.cin;
            if (p.cout) inner.cout = p.cout;
            const outer = this._rotoFeatherHandles(p);
            if (!outer) return inner;
            return interpHandled(inner, outer, t);
        });
    },

    // Drag the feather point itself — its tangents ride along so the outer curve
    // keeps its shape.
    _rotoDragFeather(e, layer, editPts, i) {
        const tf = layer.transform;
        this._roto.selPts = new Set([i]);
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                const f = editPts[i].feather;
                if (!f) return;
                const dx = rawM.x - f.x, dy = rawM.y - f.y;
                f.x = rawM.x; f.y = rawM.y;
                if (f.cin) { f.cin.x += dx; f.cin.y += dy; }
                if (f.cout) { f.cout.x += dx; f.cout.y += dy; }
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    // Drag a feather point's own tangent handle (materializing it from the
    // fallback if it didn't exist yet). Alt breaks the smooth mirror.
    _rotoDragFeatherHandle(e, layer, editPts, i, which) {
        const tf = layer.transform;
        const broken = e.altKey;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const f = editPts[i].feather;
                if (!f) return;
                const rawM = this._rotoInvTf(m, tf);
                f[which] = { x: rawM.x, y: rawM.y };
                if (!broken) {
                    const other = which === "cin" ? "cout" : "cin";
                    f[other] = { x: 2 * f.x - rawM.x, y: 2 * f.y - rawM.y };
                }
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    // Screen px per image px at the current zoom/fit.
    _rotoScreenPerImgPx() {
        const o = this._normToClient(0, 0), ex = this._normToClient(1, 0);
        const { w } = this._toolImgSize();
        return (o && ex && w > 0) ? (Math.hypot(ex.x - o.x, ex.y - o.y) / w) : 0;
    },

    // Screen-space path of the image rectangle (for inverted-matte previews and
    // the preview clip). Four corners rather than a rect so it follows whatever
    // transform the image frame carries.
    _rotoFrameRectD() {
        const c = [this._normToDraw(0, 0), this._normToDraw(1, 0), this._normToDraw(1, 1), this._normToDraw(0, 1)];
        if (c.some((p) => !p)) return null;
        return `M ${c[0].x} ${c[0].y} L ${c[1].x} ${c[1].y} L ${c[2].x} ${c[2].y} L ${c[3].x} ${c[3].y} Z`;
    },

    // Oriented box around the current multi-point selection. It carries the
    // selection's rotation (this._roto.selAngle) so the box turns with the shape,
    // and exposes its centre (centroid, in image px) + local axes so group
    // scale/rotate act along the box's own axes.
    _rotoSelBox(dpts) {
        const sel = [...this._roto.selPts].filter((i) => dpts[i]);
        if (sel.length < 2) return null;
        const { w, h } = this._toolImgSize();
        if (!w || !h) return null;

        let cx = 0, cy = 0;
        for (const i of sel) { cx += dpts[i].x * w; cy += dpts[i].y * h; }
        cx /= sel.length; cy /= sel.length;

        const ang = this._roto.selAngle || 0;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let minU = 1e9, minV = 1e9, maxU = -1e9, maxV = -1e9;
        for (const i of sel) {
            const dx = dpts[i].x * w - cx, dy = dpts[i].y * h - cy;
            const u =  dx * ca + dy * sa;   // project onto the box's local frame
            const v = -dx * sa + dy * ca;
            if (u < minU) minU = u; if (v < minV) minV = v;
            if (u > maxU) maxU = u; if (v > maxV) maxV = v;
        }
        const pad = 3;   // image-px slack so corner handles clear the vertices
        minU -= pad; minV -= pad; maxU += pad; maxV += pad;

        const toNorm = (u, v) => ({ x: (cx + u * ca - v * sa) / w, y: (cy + u * sa + v * ca) / h });
        const cornersNorm = [toNorm(minU, minV), toNorm(maxU, minV), toNorm(maxU, maxV), toNorm(minU, maxV)];
        const cornersScr = cornersNorm.map((c) => this._normToDraw(c.x, c.y));
        if (cornersScr.some((s) => !s)) return null;

        return {
            cornersNorm, cornersScr,
            centerNorm: { x: cx / w, y: cy / h },
            center: { x: cx, y: cy }, ca, sa, w, h,
            cornersLocal: [{ u: minU, v: minV }, { u: maxU, v: minV }, { u: maxU, v: maxV }, { u: minU, v: maxV }],
        };
    },

    _rotoRenderSelBox(box) {
        const scr = box.cornersScr;
        this._toolDraw.appendChild(svgEl("polygon", {
            points: scr.map((s) => `${s.x},${s.y}`).join(" "),
            fill: "rgba(255,138,0,.06)", stroke: "#ff8a00", "stroke-width": 1, "stroke-dasharray": "5 3",
        }));
        scr.forEach((s) => {
            this._toolDraw.appendChild(svgEl("rect", {
                x: s.x - 4, y: s.y - 4, width: 8, height: 8,
                fill: "#ffce85", stroke: "#000", "stroke-width": 1,
            }));
        });
    },

    // Build an SVG path (screen coords) from display points with bezier tangents.
    _rotoPathD(dpts, closed) {
        if (!dpts || dpts.length < 2) {
            if (dpts && dpts.length === 1) {
                const s = this._normToDraw(dpts[0].x, dpts[0].y);
                return s ? `M ${s.x} ${s.y}` : null;
            }
            return null;
        }
        const S = (p) => this._normToDraw(p.x, p.y);
        const n = dpts.length;
        const start = S(dpts[0]);
        if (!start) return null;
        let d = `M ${start.x} ${start.y}`;
        const segCount = closed ? n : n - 1;
        for (let i = 0; i < segCount; i++) {
            const p0 = dpts[i], p1 = dpts[(i + 1) % n];
            const a = S(p0), b = S(p1);
            if (!a || !b) continue;
            const c0 = p0.cout ? S(p0.cout) : null;
            const c1 = p1.cin ? S(p1.cin) : null;
            if (c0 && c1) d += ` C ${c0.x} ${c0.y} ${c1.x} ${c1.y} ${b.x} ${b.y}`;
            else if (c0) d += ` Q ${c0.x} ${c0.y} ${b.x} ${b.y}`;
            else if (c1) d += ` Q ${c1.x} ${c1.y} ${b.x} ${b.y}`;
            else d += ` L ${b.x} ${b.y}`;
        }
        if (closed) d += " Z";
        return d;
    },

    // ── pointer handling ──────────────────────────────────────────────────────
    // One unified handler: while a shape is being drawn, clicks lay down points;
    // otherwise the pointer's target (vertex / handle / box / empty) picks the
    // action (see _rotoEditDown).
    _rotoPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        if (this._roto.drawing) return this._rotoDrawDown(e, n);
        return this._rotoEditDown(e, n);
    },

    _rotoDrawDown(e, n) {
        if (e.button !== 0) return false;   // right-click → viewport zoom
        let layer = this._roto.drawing;
        if (!layer) {
            // start a fresh shape if none in progress
            this._rotoAddLayer();
            layer = this._roto.drawing;
        }
        const pts = layer.points;

        // Close the shape by clicking near the first point.
        if (pts.length >= 3) {
            const first = this._rotoApplyTf(pts[0], layer.transform);
            if (this._screenDist(n, first) <= HIT) {
                this._roto.drawing = null;
                this._rotoSetPivotToCenter(layer);
                this._rotoSave(); this._rotoRefreshKfInfo(); this._toolRedraw();
                return true;
            }
        }

        // Add a point; drag to pull out symmetric bezier handles. Coordinates are
        // deliberately not clamped to [0,1] — a vertex may sit outside the image
        // (see the note on the data model at the top of this file).
        const raw = this._rotoInvTf(n, layer.transform);
        const pt = { x: raw.x, y: raw.y };
        pts.push(pt);
        this._toolRedraw();

        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, layer.transform);
                pt.cout = { x: rawM.x, y: rawM.y };
                pt.cin = { x: 2 * pt.x - rawM.x, y: 2 * pt.y - rawM.y }; // mirror
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
        return true;
    },

    // Unified edit + transform. Target-driven: handle → drag handle; box corner →
    // group scale; vertex → move (Ctrl+drag = feather); inside box → move group;
    // outside box → rotate group; empty → marquee select. Right-click deletes a
    // vertex (else falls through to viewport zoom).
    _rotoEditDown(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return false;
        const tf = layer.transform;
        const dpts = this._rotoDisplayPoints(layer);
        const editPts = this._rotoEditablePoints(layer);

        // Right-click: delete a hit vertex, else let the viewport zoom.
        if (e.button === 2) {
            const hit = this._rotoHitPoint(dpts, n);
            if (hit >= 0) {
                editPts.splice(hit, 1);
                this._roto.selPts = new Set();
                this._rotoSave(); this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
            return false;
        }
        if (e.button !== 0) return false;

        // 1) tangent / feather handle of the selected point (only shown, and thus
        // grabbable, for a single selection — a multi-selection shows the box).
        if (this._roto.selPts.size < 2) {
            for (const i of this._roto.selPts) {
                const p = dpts[i];
                if (!p) continue;
                for (const hk of ["cin", "cout"]) {
                    if (p[hk] && this._screenDist(n, p[hk]) <= HIT) { this._rotoDragHandle(e, layer, editPts, i, hk); return true; }
                }
                if (p.feather) {
                    // outer-feather tangent handles, then the feather point itself
                    const fh = this._rotoFeatherHandles(p);
                    for (const hk of ["cout", "cin"]) {
                        if (fh && fh[hk] && this._screenDist(n, fh[hk]) <= HIT) { this._rotoDragFeatherHandle(e, layer, editPts, i, hk); return true; }
                    }
                    if (this._screenDist(n, p.feather) <= HIT) { this._rotoDragFeather(e, layer, editPts, i); return true; }
                }
            }
        }

        // 2) transform-box corner → scale the selected group
        const box = this._roto.selPts.size >= 2 ? this._rotoSelBox(dpts) : null;
        if (box) {
            const cur = this._normToDraw(n.x, n.y);
            for (let i = 0; i < 4; i++) {
                const c = box.cornersScr[i];
                if (cur && Math.hypot(cur.x - c.x, cur.y - c.y) <= HIT + 3) {
                    this._rotoGroupScale(e, layer, editPts, dpts, box, i);
                    return true;
                }
            }
        }

        // 3) vertex hit → feather (Ctrl) / toggle (Shift) / select + move
        const hitIdx = this._rotoHitPoint(dpts, n);
        if (hitIdx >= 0) {
            if (e.ctrlKey) {   // Ctrl+drag pulls a feather handle (Nuke-style)
                if (!this._roto.selPts.has(hitIdx)) { this._roto.selPts = new Set([hitIdx]); this._roto.selAngle = 0; this._rotoRefreshShapeControls?.(); }
                this._rotoDragFeatherCreate(e, layer, editPts, hitIdx);
                return true;
            }
            if (e.shiftKey) {
                if (this._roto.selPts.has(hitIdx)) this._roto.selPts.delete(hitIdx);
                else this._roto.selPts.add(hitIdx);
                this._roto.selAngle = 0;   // membership changed → fresh axis-aligned box
                this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
            if (!this._roto.selPts.has(hitIdx)) { this._roto.selPts = new Set([hitIdx]); this._roto.selAngle = 0; }
            this._rotoRefreshShapeControls?.();
            this._rotoDragPoints(e, layer, editPts, n);   // moves the whole selection
            return true;
        }

        // 4) with a box: inside → translate the group, outside → rotate / clear
        if (box) {
            if (pointInPoly(n, box.cornersNorm)) { this._rotoDragPoints(e, layer, editPts, n); return true; }
            this._rotoGroupRotate(e, layer, editPts, dpts, box, n);
            return true;
        }

        // 5) Alt+click on an edge inserts a point
        if (e.altKey) {
            const seg = this._rotoNearestSegment(dpts, n);
            if (seg && seg.dist <= HIT * 1.6) {
                const rawInsert = this._rotoInvTf(seg.point, tf);
                editPts.splice(seg.i + 1, 0, { x: rawInsert.x, y: rawInsert.y });
                this._roto.selPts = new Set([seg.i + 1]);
                this._roto.selAngle = 0;
                this._rotoSave(); this._rotoRefreshShapeControls?.(); this._toolRedraw();
                return true;
            }
        }

        // 6) empty space → rubber-band marquee select
        return this._rotoMarquee(e, layer, n);
    },

    _rotoHitPoint(dpts, n) {
        for (let i = dpts.length - 1; i >= 0; i--) {
            if (this._screenDist(n, dpts[i]) <= HIT) return i;
        }
        return -1;
    },

    // Context hint + cursor for whatever the pointer is over — mirrors the
    // dispatch order in _rotoEditDown so the hint matches what a click would do.
    _rotoHoverContext(e, n) {
        const layer = this._rotoCurLayer();
        if (!layer) return { status: "<b>+ Shape</b> to start a roto shape", cursor: "default" };

        // While drawing, clicks lay points (pen cursor).
        if (this._roto.drawing) {
            const pts = this._roto.drawing.points || [];
            if (pts.length >= 3) {
                const first = this._rotoApplyTf(pts[0], layer.transform);
                if (this._screenDist(n, first) <= HIT) return { status: "<b>Click</b> to close the shape", cursor: "pointer" };
            }
            return { status: "<b>Click</b> add point · <b>drag</b> to curve · click the first point to close", cursor: CUR_PEN };
        }

        const dpts = this._rotoDisplayPoints(layer);

        // Handle of a single selected point.
        if (this._roto.selPts.size < 2) {
            for (const i of this._roto.selPts) {
                const p = dpts[i]; if (!p) continue;
                for (const hk of ["cin", "cout"]) {
                    if (p[hk] && this._screenDist(n, p[hk]) <= HIT) return { status: "<b>Drag</b> tangent · <b>Alt+drag</b> break it", cursor: "move" };
                }
                if (p.feather) {
                    const fh = this._rotoFeatherHandles(p);
                    for (const hk of ["cout", "cin"]) {
                        if (fh && fh[hk] && this._screenDist(n, fh[hk]) <= HIT) return { status: "<b>Drag</b> feather-curve tangent · <b>Alt+drag</b> break it", cursor: "move" };
                    }
                    if (this._screenDist(n, p.feather) <= HIT) return { status: "<b>Drag</b> move the feather point", cursor: "move" };
                }
            }
        }

        // Multi-selection transform box.
        if (this._roto.selPts.size >= 2) {
            const box = this._rotoSelBox(dpts);
            if (box) {
                const cur = this._normToDraw(n.x, n.y);
                for (let i = 0; i < 4; i++) {
                    const c = box.cornersScr[i];
                    if (cur && Math.hypot(cur.x - c.x, cur.y - c.y) <= HIT + 3) {
                        return { status: "<b>Drag</b> scale selection · <b>Shift</b> uniform", cursor: i % 2 === 0 ? "nwse-resize" : "nesw-resize" };
                    }
                }
                if (this._rotoHitPoint(dpts, n) >= 0) return { status: "<b>Drag</b> move · <b>Ctrl+drag</b> feather · <b>Right-click</b> delete", cursor: "move" };
                if (pointInPoly(n, box.cornersNorm)) return { status: "<b>Drag</b> move selection", cursor: "move" };
                return { status: "<b>Drag</b> rotate selection (<b>Shift</b> 15°) · <b>click</b> to clear", cursor: CUR_ROTATE };
            }
        }

        // Vertex.
        if (this._rotoHitPoint(dpts, n) >= 0) {
            return { status: "<b>Drag</b> move · <b>Ctrl+drag</b> feather · <b>Right-click</b> delete", cursor: "move" };
        }

        // Edge (Alt inserts a point).
        const seg = this._rotoNearestSegment(dpts, n);
        if (seg && seg.dist <= HIT * 1.6) {
            return { status: "<b>Alt+click</b> insert point", cursor: e.altKey ? "copy" : "crosshair" };
        }

        // Empty space.
        return { status: "<b>Drag</b> to marquee-select points", cursor: "default" };
    },

    // Rubber-band select: pick every vertex inside the dragged rect. A click with
    // no drag clears the selection.
    _rotoMarquee(e, layer, startNorm) {
        const dpts = this._rotoDisplayPoints(layer);
        const rectEl = svgEl("rect", { fill: "rgba(108,180,255,.12)", stroke: "#6cf", "stroke-width": 1, "stroke-dasharray": "3 2" });
        this._toolDraw.appendChild(rectEl);
        let moved = false, cur = startNorm;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                cur = m;
                const a = this._normToDraw(startNorm.x, startNorm.y);
                const b = this._normToDraw(m.x, m.y);
                if (!a || !b) return;
                if (Math.hypot(b.x - a.x, b.y - a.y) > 3) moved = true;
                rectEl.setAttribute("x", Math.min(a.x, b.x));
                rectEl.setAttribute("y", Math.min(a.y, b.y));
                rectEl.setAttribute("width", Math.abs(b.x - a.x));
                rectEl.setAttribute("height", Math.abs(b.y - a.y));
            },
            () => {
                rectEl.remove();
                this._roto.selAngle = 0;   // new selection → axis-aligned box
                if (moved) {
                    const minX = Math.min(startNorm.x, cur.x), maxX = Math.max(startNorm.x, cur.x);
                    const minY = Math.min(startNorm.y, cur.y), maxY = Math.max(startNorm.y, cur.y);
                    const sel = new Set();
                    dpts.forEach((p, i) => { if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) sel.add(i); });
                    this._roto.selPts = sel;
                } else {
                    this._roto.selPts = new Set();
                }
                this._rotoRefreshShapeControls?.();
                this._toolRedraw();
            },
        );
        return true;
    },

    _rotoDragPoints(e, layer, editPts, startNorm) {
        const tf = layer.transform;
        const startRaw = this._rotoInvTf(startNorm, tf);
        const origin = {};
        for (const i of this._roto.selPts) origin[i] = clonePoint(editPts[i]);
        let moved = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                const dx = rawM.x - startRaw.x, dy = rawM.y - startRaw.y;
                moved = true;
                for (const i of this._roto.selPts) {
                    const o = origin[i]; if (!o) continue;
                    editPts[i].x = o.x + dx; editPts[i].y = o.y + dy;
                    for (const hk of ["cin", "cout"]) {
                        if (o[hk]) editPts[i][hk] = { x: o[hk].x + dx, y: o[hk].y + dy };
                    }
                    if (o.feather) {   // feather point + its own tangents ride along
                        const f = { x: o.feather.x + dx, y: o.feather.y + dy };
                        if (o.feather.cin) f.cin = { x: o.feather.cin.x + dx, y: o.feather.cin.y + dy };
                        if (o.feather.cout) f.cout = { x: o.feather.cout.x + dx, y: o.feather.cout.y + dy };
                        editPts[i].feather = f;
                    }
                }
                this._toolRedraw();
            },
            () => { if (moved) { this._rotoSave(); this._rotoRefreshKfInfo(); } this._toolRedraw(); },
        );
    },

    _rotoDragHandle(e, layer, editPts, i, hk) {
        const tf = layer.transform;
        const broken = e.altKey;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                editPts[i][hk] = { x: rawM.x, y: rawM.y };
                // smooth: mirror the opposite tangent unless broken
                if ((hk === "cin" || hk === "cout") && !broken) {
                    const other = hk === "cin" ? "cout" : "cin";
                    const a = editPts[i];
                    a[other] = { x: 2 * a.x - rawM.x, y: 2 * a.y - rawM.y };
                }
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    // Ctrl+drag a vertex to pull out (or move) its feather point. Existing
    // feather tangents ride along with the point rather than being discarded.
    _rotoDragFeatherCreate(e, layer, editPts, i) {
        const tf = layer.transform;
        this._roto.selPts = new Set([i]);
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const rawM = this._rotoInvTf(m, tf);
                const f = editPts[i].feather;
                if (f) {
                    const dx = rawM.x - f.x, dy = rawM.y - f.y;
                    f.x = rawM.x; f.y = rawM.y;
                    if (f.cin) { f.cin.x += dx; f.cin.y += dy; }
                    if (f.cout) { f.cout.x += dx; f.cout.y += dy; }
                } else {
                    editPts[i].feather = { x: rawM.x, y: rawM.y };
                }
                this._toolRedraw();
            },
            () => { this._rotoSave(); this._toolRedraw(); },
        );
    },

    // Group transforms edit the SELECTED points (not the layer transform). They
    // run in display-pixel space and invert the layer transform back to raw, so
    // the selection scales/rotates about the box centre exactly as drawn.
    _rotoGroupCapture(dpts) {
        const { w, h } = this._toolImgSize();
        const sel = [...this._roto.selPts].filter((i) => dpts[i]);
        const orig = {};
        for (const i of sel) {
            const p = dpts[i];
            const o = { a: { x: p.x * w, y: p.y * h } };
            for (const hk of ["cin", "cout"]) if (p[hk]) o[hk] = { x: p[hk].x * w, y: p[hk].y * h };
            if (p.feather) {
                o.feather = { x: p.feather.x * w, y: p.feather.y * h };
                if (p.feather.cin) o.featherCin = { x: p.feather.cin.x * w, y: p.feather.cin.y * h };
                if (p.feather.cout) o.featherCout = { x: p.feather.cout.x * w, y: p.feather.cout.y * h };
            }
            orig[i] = o;
        }
        return { w, h, sel, orig };
    },

    // Write a transformed display-pixel point set back to raw editable points.
    _rotoGroupApply(layer, editPts, cap, map) {
        const { w, h } = cap;
        const tf = layer.transform;
        const back = (px) => {
            const hn = this._rotoInvTf({ x: px.x / w, y: px.y / h }, tf);
            return { x: hn.x, y: hn.y };
        };
        for (const i of cap.sel) {
            const o = cap.orig[i]; if (!o) continue;
            const nn = back(map(o.a));
            editPts[i].x = nn.x; editPts[i].y = nn.y;
            for (const hk of ["cin", "cout"]) {
                if (o[hk]) editPts[i][hk] = back(map(o[hk]));
            }
            if (o.feather) {
                const f = back(map(o.feather));
                if (o.featherCin) f.cin = back(map(o.featherCin));
                if (o.featherCout) f.cout = back(map(o.featherCout));
                editPts[i].feather = f;
            }
        }
        this._toolRedraw();
    },

    // Corner drag scales the selection along the box's own axes about its centre
    // (Shift = uniform). Works in the oriented local frame so a rotated box
    // scales the way it looks.
    _rotoGroupScale(e, layer, editPts, dpts, box, cornerIdx) {
        const cap = this._rotoGroupCapture(dpts);
        if (!cap.w || !cap.h || cap.sel.length < 2) return;
        const bx = box.center.x, by = box.center.y, ca = box.ca, sa = box.sa;
        const cu0 = box.cornersLocal[cornerIdx].u || 1e-6;
        const cv0 = box.cornersLocal[cornerIdx].v || 1e-6;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                const mx = m.x * cap.w - bx, my = m.y * cap.h - by;
                const mu =  mx * ca + my * sa;   // mouse in box-local frame
                const mv = -mx * sa + my * ca;
                let fu = mu / (cu0 || 1e-6);
                let fv = mv / (cv0 || 1e-6);
                if (ev.shiftKey) {
                    const f = (mu * cu0 + mv * cv0) / ((cu0 * cu0 + cv0 * cv0) || 1e-6);
                    fu = fv = f;
                }
                if (Math.abs(fu) < 1e-3) fu = (fu < 0 ? -1 : 1) * 1e-3;
                if (Math.abs(fv) < 1e-3) fv = (fv < 0 ? -1 : 1) * 1e-3;
                this._rotoGroupApply(layer, editPts, cap, (q) => {
                    const dx = q.x - bx, dy = q.y - by;
                    const u = ( dx * ca + dy * sa) * fu;
                    const v = (-dx * sa + dy * ca) * fv;
                    return { x: bx + u * ca - v * sa, y: by + u * sa + v * ca };
                });
            },
            () => { this._rotoSave(); this._rotoRefreshKfInfo?.(); this._toolRedraw(); },
        );
    },

    // Drag outside the box rotates the selection about its centre (Shift snaps to
    // 15°) — the box orientation (selAngle) tracks it so the frame turns with the
    // shape. A click with no movement clears the selection.
    _rotoGroupRotate(e, layer, editPts, dpts, box, startNorm) {
        const cap = this._rotoGroupCapture(dpts);
        if (!cap.w || !cap.h || cap.sel.length < 2) return;
        const cx = box.center.x, cy = box.center.y;
        const a0 = Math.atan2(startNorm.y * cap.h - cy, startNorm.x * cap.w - cx);
        const angStart = this._roto.selAngle || 0;
        let moved = false;
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                moved = true;
                let da = Math.atan2(m.y * cap.h - cy, m.x * cap.w - cx) - a0;
                if (ev.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
                this._roto.selAngle = angStart + da;   // box turns with the shape
                const ca = Math.cos(da), sa = Math.sin(da);
                this._rotoGroupApply(layer, editPts, cap, (q) => ({
                    x: cx + (q.x - cx) * ca - (q.y - cy) * sa,
                    y: cy + (q.x - cx) * sa + (q.y - cy) * ca,
                }));
            },
            () => {
                if (moved) { this._rotoSave(); this._rotoRefreshKfInfo?.(); }
                else { this._roto.selPts = new Set(); this._roto.selAngle = 0; this._rotoRefreshShapeControls?.(); }
                this._toolRedraw();
            },
        );
    },

    _rotoSetPivotToCenter(layer) {
        const raw = layer.points;
        if (!raw || raw.length < 2) return;
        const tf = layer.transform;
        // moving the pivot only leaves the shape visually fixed for free when
        // the transform is still identity — do it right after drawing.
        if (tf.rot !== 0 || tf.sx !== 1 || tf.sy !== 1 || tf.tx !== 0 || tf.ty !== 0) return;
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const p of raw) {
            if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
        }
        tf.px = (minX + maxX) / 2;
        tf.py = (minY + maxY) / 2;
    },

    _rotoNearestSegment(dpts, n) {
        if (dpts.length < 2) return null;
        let best = null;
        for (let i = 0; i < dpts.length; i++) {
            const a = dpts[i], b = dpts[(i + 1) % dpts.length];
            const cand = projectToSeg(n, a, b);
            const dist = this._screenDist(n, cand);
            if (!best || dist < best.dist) best = { i, point: cand, dist };
        }
        return best;
    },
};

// ── module-local helpers ──────────────────────────────────────────────────────

/** B combined with A by a shape's mode, in place in `b` — roto_raster._merge. */
function rotoMerge(mode, b, a) {
    const n = b.length;
    if (mode === "plus")              for (let i = 0; i < n; i++) b[i] = Math.min(1, b[i] + a[i]);
    else if (mode === "minus")        for (let i = 0; i < n; i++) b[i] = Math.max(0, b[i] - a[i]);
    else if (mode === "intersection") for (let i = 0; i < n; i++) b[i] = b[i] * a[i];
    else if (mode === "xor")          for (let i = 0; i < n; i++) b[i] = Math.min(1, Math.max(0, b[i] + a[i] - 2 * a[i] * b[i]));
    else                              for (let i = 0; i < n; i++) b[i] = Math.min(1, b[i] + a[i] - a[i] * b[i]);
}

function normalizeLayer(l) {
    return {
        id: l.id || ("l" + (_rotoIdSeq++)),
        name: l.name || "Shape",
        visible: l.visible !== false,
        invert: !!l.invert,
        feather: +l.feather || 0,
        blur: +l.blur || 0,
        dilate: +l.dilate || 0,
        opacity: l.opacity == null ? 1 : +l.opacity,
        mode: ROTO_MODES.includes(l.mode) ? l.mode : "union",
        ease: Math.max(0, Math.min(1, +l.ease || 0)),
        closed: true,
        transform: Object.assign(DEF_TF(), l.transform || {}),
        points: Array.isArray(l.points) ? l.points.map(clonePoint) : [],
        keyframes: l.keyframes && typeof l.keyframes === "object"
            ? Object.fromEntries(Object.entries(l.keyframes).map(([k, v]) => [k, (v || []).map(clonePoint)]))
            : undefined,
        tangents: l.tangents && typeof l.tangents === "object"
            ? Object.fromEntries(Object.entries(l.tangents)
                .filter(([, v]) => v && typeof v === "object")
                .map(([k, v]) => [k, { ox: num(v.ox, 1 / 3), oy: num(v.oy, 1 / 3), ix: num(v.ix, 2 / 3), iy: num(v.iy, 2 / 3) }]))
            : undefined,
    };
}

// A point-ish {x,y} that may carry its own bezier tangents (used for both a
// vertex and its feather counterpart).
function cloneHandled(p) {
    const o = { x: +p.x, y: +p.y };
    if (p.cin) o.cin = { x: +p.cin.x, y: +p.cin.y };
    if (p.cout) o.cout = { x: +p.cout.x, y: +p.cout.y };
    return o;
}

function clonePoint(p) {
    const o = cloneHandled(p);
    if (p.feather) o.feather = cloneHandled(p.feather);   // outer-feather vertex + its tangents
    return o;
}

function clonePoints(arr) { return (arr || []).map(clonePoint); }

// Interpolate a handled point-ish (position + cin/cout) at t.
function interpHandled(a, b, t) {
    const o = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
    for (const hk of ["cin", "cout"]) {
        if (a[hk] || b[hk]) {
            const da = a[hk] || { x: a.x, y: a.y };
            const db = b[hk] || { x: b.x, y: b.y };
            o[hk] = { x: lerp(da.x, db.x, t), y: lerp(da.y, db.y, t) };
        }
    }
    return o;
}

function interpPoint(a, b, t) {
    const o = interpHandled(a, b, t);
    if (a.feather || b.feather) {
        const fa = a.feather || { x: a.x, y: a.y };
        const fb = b.feather || { x: b.x, y: b.y };
        o.feather = interpHandled(fa, fb, t);
    }
    return o;
}

function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        const hit = ((yi > p.y) !== (yj > p.y)) &&
            (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-12) + xi);
        if (hit) inside = !inside;
    }
    return inside;
}

function projectToSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: a.x + abx * t, y: a.y + aby * t };
}

// small DOM builders
function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) { if (/[<>]/.test(text) && tag !== "button") e.innerHTML = text; else e.textContent = text; }
    return e;
}

function diamond(x, y, r, fill) {
    return svgEl("polygon", {
        points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`,
        fill, stroke: "#000", "stroke-width": 1,
    });
}

// A value row: name, slider, and the number itself — typed into as well as
// dragged, as the Channel Box's fields are.
function slider(label, min, max, value, onInput) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const rng = document.createElement("input");
    rng.type = "range"; rng.min = min; rng.max = max; rng.value = value;
    const num = document.createElement("input");
    num.type = "number"; num.value = value; num.step = "1";
    rng.oninput = () => { num.value = rng.value; onInput(parseFloat(rng.value)); };
    num.onchange = () => {
        const v = Math.max(+min, Math.min(+max, parseFloat(num.value) || 0));
        num.value = v; rng.value = v; onInput(v);
    };
    row.appendChild(rng); row.appendChild(num);
    return row;
}

function numRow(label, value, step, onChange) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const num = document.createElement("input");
    num.type = "number"; num.step = step; num.value = value;
    num.onchange = () => onChange(parseFloat(num.value) || 0);
    row.appendChild(num);
    return row;
}

function checkbox(label, checked, onChange) {
    const row = el("div", "", "row");
    row.appendChild(el("label", label));
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!checked;
    cb.onchange = () => onChange(cb.checked);
    row.appendChild(cb);
    return { row, cb };
}
