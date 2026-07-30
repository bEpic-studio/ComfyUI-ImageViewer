// bEpicViewer_annotate.js
// AnnotateMixin — the in-viewer Annotation tool. Unlike Roto / SAM3 (which
// persist vector data into a source node's widgets for a Python consumer), the
// Annotation tool is standalone markup: it draws freehand strokes, arrows,
// boxes and text over WHATEVER image the active tab is showing — including
// folder tabs and Explorer-dropped images that have no "Send to Viewer" node.
//
// "Export annotation" flattens the markup over the current image at native
// resolution into a PNG, saves it to ./output (via /bepic/save_annotation) and
// adds that file to the active tab's history strip, so it can be dragged onto
// the ComfyUI graph like any other history thumbnail.
//
// Annotations live in memory per tab for the session (this._annotStore[tabKey])
// and are intentionally NOT persisted — they are scratch markup until exported.
//
// Interaction is drawn in screen space via ToolsMixin's _normToDraw so shapes
// track zoom/pan/fit; items are stored in normalized [0,1] image coordinates.

import { svgEl } from "./bEpicViewer_tools.js";
import { api } from "../../scripts/api.js";

const ANNOT_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759",
                      "#00c7be", "#0a84ff", "#ffffff", "#000000"];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function el(tag, props) {
    const e = document.createElement(tag);
    if (props) for (const k in props) e[k] = props[k];
    return e;
}

// Distance from point (px,py) to segment (x1,y1)-(x2,y2), all in screen px.
function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export const AnnotateMixin = {

    // ── bootstrap ────────────────────────────────────────────────────────────
    _annotInit() {
        this._annotStore = {};   // { [tabKey]: item[] }
        this._annot = {
            tool: "pen", color: ANNOT_COLORS[0],
            size: 6, textSize: 42, userSized: false, includeImage: true,
            draft: null, textInput: null, textAnchor: null, textTabKey: null,
        };
        this._annotInjectStyles();
    },

    _annotInjectStyles() {
        if (this.shadowRoot.getElementById("bepic-annot-style")) return;
        const s = document.createElement("style");
        s.id = "bepic-annot-style";
        s.textContent = `
            .bepic-annot-row { display:flex; gap:4px; margin:5px 0; }
            .bepic-annot-row button { flex:1; }
            .bepic-annot-tool { background:#2a2a2a; color:#ddd; border:1px solid #555;
                border-radius:4px; cursor:pointer; padding:4px 0; font-size:14px; line-height:1; }
            .bepic-annot-tool:hover { background:#3a3a3a; }
            .bepic-annot-tool.active { color:#f60; border-color:#f60; }
            .bepic-annot-swatches { display:flex; gap:5px; flex-wrap:wrap; align-items:center; margin:6px 0; }
            .bepic-annot-swatch { width:18px; height:18px; border-radius:4px; padding:0;
                border:1px solid rgba(255,255,255,.3); cursor:pointer; }
            .bepic-annot-swatch.sel { box-shadow:0 0 0 2px #fff; }
            .bepic-annot-text-input { position:absolute; z-index:62; background:rgba(0,0,0,.4);
                border:1px dashed rgba(255,255,255,.8); padding:0 3px; outline:none;
                line-height:1.15; white-space:pre; }
        `;
        this.shadowRoot.appendChild(s);
    },

    // ── activation (called from ToolsMixin.setActiveTool) ─────────────────────
    _annotActivate(panel) {
        this._annotPanel = panel;
        this._annotBuildPanel();
        this._updateToolCursor();
    },

    _annotDeactivate() {
        this._annotCommitText();
        this._annot.draft = null;
    },

    // ── per-tab item store ────────────────────────────────────────────────────
    _annotItems(create = true) {
        const key = this.activeTab;
        if (!key) return create ? [] : null;
        if (!this._annotStore[key]) {
            if (!create) return null;
            this._annotStore[key] = [];
        }
        return this._annotStore[key];
    },

    _annotAfterChange() {
        this._toolRedraw();
        this._annotUpdateInfo();
    },

    // Screen px per image px (uniform — fit preserves aspect ratio).
    _annotScale() {
        const { w } = this._toolImgSize();
        if (!w) return 1;
        const a = this._normToClient(0, 0);
        const b = this._normToClient(1, 0);
        if (!a || !b) return 1;
        return Math.hypot(b.x - a.x, b.y - a.y) / w;
    },

    // ── rendering (screen-space SVG on ToolsMixin's _toolDraw) ────────────────
    _annotRender() {
        const scale = this._annotScale();
        const items = this._annotItems(false);
        if (items) for (const it of items) this._annotRenderItem(it, scale);
        if (this._annot && this._annot.draft) this._annotRenderItem(this._annot.draft, scale);
    },

    _annotRenderItem(it, scale) {
        const color = it.color || "#ff3b30";
        if (it.type === "text") {
            const d = this._normToDraw(it.x, it.y);
            if (!d) return;
            const fs = Math.max(6, (it.size || 42) * scale);
            const t = svgEl("text", {
                x: d.x, y: d.y, fill: color,
                "font-family": "sans-serif", "font-size": fs,
                "dominant-baseline": "hanging", "paint-order": "stroke",
                stroke: "#000", "stroke-width": Math.max(1, fs * 0.06),
            });
            t.textContent = it.text || "";
            this._toolDraw.appendChild(t);
            return;
        }
        const lw = Math.max(1, (it.width || 6) * scale);
        if (it.type === "pen") {
            const pts = it.pts.map((p) => this._normToDraw(p.x, p.y)).filter(Boolean);
            if (pts.length < 2) return;
            const d = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
            this._toolDraw.appendChild(svgEl("path", {
                d, fill: "none", stroke: color, "stroke-width": lw,
                "stroke-linecap": "round", "stroke-linejoin": "round",
            }));
            return;
        }
        const a = this._normToDraw(it.a.x, it.a.y);
        const b = this._normToDraw(it.b.x, it.b.y);
        if (!a || !b) return;
        if (it.type === "rect") {
            this._toolDraw.appendChild(svgEl("rect", {
                x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
                fill: "none", stroke: color, "stroke-width": lw,
            }));
            return;
        }
        if (it.type === "arrow") {
            this._toolDraw.appendChild(svgEl("line", {
                x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                stroke: color, "stroke-width": lw, "stroke-linecap": "round",
            }));
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const head = Math.max(8, lw * 3.2);
            const wing = Math.PI / 7;
            const hx1 = b.x - head * Math.cos(ang - wing), hy1 = b.y - head * Math.sin(ang - wing);
            const hx2 = b.x - head * Math.cos(ang + wing), hy2 = b.y - head * Math.sin(ang + wing);
            this._toolDraw.appendChild(svgEl("polygon", {
                points: `${b.x},${b.y} ${hx1},${hy1} ${hx2},${hy2}`, fill: color,
            }));
            return;
        }
    },

    // ── pointer (dispatched from ToolsMixin) ──────────────────────────────────
    _annotPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        const tool = this._annot.tool;

        // Right-click deletes the topmost annotation under the cursor; on empty
        // space it falls through so the viewport can zoom.
        if (e.button === 2) {
            const hit = this._annotHitTest(n);
            if (hit >= 0) { this._annotItems().splice(hit, 1); this._annotAfterChange(); return true; }
            return false;
        }

        if (tool === "text") { this._annotBeginText(n); return true; }

        const color = this._annot.color;
        if (tool === "pen") {
            const it = { type: "pen", color, width: this._annot.size,
                         pts: [{ x: clamp01(n.x), y: clamp01(n.y) }] };
            this._annot.draft = it;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev); if (!m) return;
                    it.pts.push({ x: clamp01(m.x), y: clamp01(m.y) });
                    this._toolRedraw();
                },
                () => {
                    this._annot.draft = null;
                    if (it.pts.length > 1) { this._annotItems().push(it); this._annotAfterChange(); }
                    else this._toolRedraw();
                },
            );
            return true;
        }
        if (tool === "arrow" || tool === "rect") {
            const it = { type: tool, color, width: this._annot.size,
                         a: { x: clamp01(n.x), y: clamp01(n.y) },
                         b: { x: clamp01(n.x), y: clamp01(n.y) } };
            this._annot.draft = it;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev); if (!m) return;
                    it.b = { x: clamp01(m.x), y: clamp01(m.y) };
                    this._toolRedraw();
                },
                () => {
                    this._annot.draft = null;
                    if (this._screenDist(it.a, it.b) > 4) { this._annotItems().push(it); this._annotAfterChange(); }
                    else this._toolRedraw();
                },
            );
            return true;
        }
        return false;
    },

    _annotHoverContext(e, n) {
        if (this._annotHitTest(n) >= 0) {
            return { status: "<b>Right-click</b> to delete this annotation", cursor: "pointer" };
        }
        const msg = {
            pen:   "<b>Drag</b> to draw freehand",
            arrow: "<b>Drag</b> to draw an arrow",
            rect:  "<b>Drag</b> to draw a box",
            text:  "<b>Click</b> to add text",
        }[this._annot.tool] || "";
        return {
            status: msg + " · <b>Right-click</b> deletes · <b>Middle-drag</b> pans",
            cursor: this._annot.tool === "text" ? "text" : "crosshair",
        };
    },

    // Index of the topmost annotation near normalized point n, else -1.
    _annotHitTest(n) {
        const c = this._normToClient(n.x, n.y);
        if (!c) return -1;
        const scale = this._annotScale();
        const items = this._annotItems(false) || [];
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            const th = it.type === "text" ? 6 : Math.max(9, (it.width || 6) * scale * 0.5 + 5);
            if (this._annotItemDist(it, c.x, c.y, scale) <= th) return i;
        }
        return -1;
    },

    _annotItemDist(it, cx, cy, scale) {
        if (it.type === "text") {
            const p = this._normToClient(it.x, it.y);
            if (!p) return Infinity;
            const fs = (it.size || 42) * scale;
            const w = Math.max(fs, (it.text || "").length * fs * 0.55);
            if (cx >= p.x - 4 && cx <= p.x + w + 4 && cy >= p.y - 4 && cy <= p.y + fs + 4) return 0;
            return Math.hypot(cx - p.x, cy - p.y);
        }
        if (it.type === "pen") {
            let best = Infinity;
            for (let i = 1; i < it.pts.length; i++) {
                const a = this._normToClient(it.pts[i - 1].x, it.pts[i - 1].y);
                const b = this._normToClient(it.pts[i].x, it.pts[i].y);
                if (a && b) best = Math.min(best, segDist(cx, cy, a.x, a.y, b.x, b.y));
            }
            return best;
        }
        const a = this._normToClient(it.a.x, it.a.y);
        const b = this._normToClient(it.b.x, it.b.y);
        if (!a || !b) return Infinity;
        if (it.type === "arrow") return segDist(cx, cy, a.x, a.y, b.x, b.y);
        if (it.type === "rect") {
            const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
            const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
            return Math.min(
                segDist(cx, cy, x1, y1, x2, y1), segDist(cx, cy, x2, y1, x2, y2),
                segDist(cx, cy, x2, y2, x1, y2), segDist(cx, cy, x1, y2, x1, y1));
        }
        return Infinity;
    },

    // ── text entry ────────────────────────────────────────────────────────────
    _annotBeginText(n) {
        this._annotCommitText();
        const d = this._normToDraw(n.x, n.y);
        if (!d) return;
        const scale = this._annotScale();
        const inp = el("input", { type: "text", className: "bepic-annot-text-input" });
        inp.style.left = d.x + "px";
        inp.style.top = d.y + "px";
        inp.style.color = this._annot.color;
        inp.style.font = Math.max(9, this._annot.textSize * scale) + "px sans-serif";
        inp.style.minWidth = "40px";
        // Keep the input's own mouse/keys from reaching the tool + viewer hotkeys.
        inp.addEventListener("mousedown", (ev) => ev.stopPropagation());
        inp.addEventListener("keydown", (ev) => {
            ev.stopPropagation();
            if (ev.key === "Enter") { ev.preventDefault(); this._annotCommitText(); }
            else if (ev.key === "Escape") { ev.preventDefault(); this._annotDiscardText(); }
        });
        inp.addEventListener("blur", () => this._annotCommitText());
        this.viewport.appendChild(inp);
        this._annot.textInput = inp;
        this._annot.textAnchor = { x: clamp01(n.x), y: clamp01(n.y) };
        this._annot.textTabKey = this.activeTab;
        setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
    },

    _annotCommitText() {
        const inp = this._annot.textInput;
        if (!inp) return;
        const val = inp.value.trim();
        const anchor = this._annot.textAnchor;
        const tabKey = this._annot.textTabKey;
        this._annot.textInput = null;
        this._annot.textAnchor = null;
        this._annot.textTabKey = null;
        try { inp.remove(); } catch (_) {}
        if (val && anchor && tabKey) {
            const arr = this._annotStore[tabKey] || (this._annotStore[tabKey] = []);
            arr.push({ type: "text", color: this._annot.color, size: this._annot.textSize,
                       x: anchor.x, y: anchor.y, text: val });
        }
        this._annotAfterChange();
    },

    _annotDiscardText() {
        const inp = this._annot.textInput;
        this._annot.textInput = null;
        this._annot.textAnchor = null;
        this._annot.textTabKey = null;
        if (inp) try { inp.remove(); } catch (_) {}
    },

    // ── panel ─────────────────────────────────────────────────────────────────
    _annotAutoSize() {
        if (this._annot.userSized) return;
        const { w, h } = this._toolImgSize();
        const m = Math.min(w || 0, h || 0);
        if (!m) return;
        this._annot.size = Math.max(2, Math.min(24, Math.round(m / 300)));
        this._annot.textSize = Math.max(14, Math.min(160, Math.round(m / 18)));
    },

    _annotBuildPanel() {
        const p = this._annotPanel;
        p.innerHTML = "";
        p.appendChild(el("h4", { textContent: "Annotate" }));

        // Sub-tool row.
        this._annotToolBtns = {};
        const toolRow = el("div", { className: "bepic-annot-row" });
        const addTool = (t, glyph, title) => {
            const b = el("button", { className: "bepic-annot-tool", title, textContent: glyph });
            b.onclick = () => this._annotSetTool(t);
            toolRow.appendChild(b);
            this._annotToolBtns[t] = b;
        };
        addTool("pen", "✎", "Freehand pen");
        addTool("arrow", "↗", "Arrow");
        addTool("rect", "▭", "Rectangle");
        addTool("text", "T", "Text");
        p.appendChild(toolRow);

        // Colour swatches + custom picker.
        this._annotAutoSize();
        const sw = el("div", { className: "bepic-annot-swatches" });
        this._annotSwatches = [];
        ANNOT_COLORS.forEach((col) => {
            const s = el("button", { className: "bepic-annot-swatch", title: col });
            s.style.background = col;
            s.onclick = () => this._annotSetColor(col);
            sw.appendChild(s);
            this._annotSwatches.push([s, col]);
        });
        const custom = el("input", { type: "color", title: "Custom colour", value: this._annot.color });
        custom.style.cssText = "width:24px;height:20px;padding:0;border:1px solid #555;background:#111;cursor:pointer;";
        custom.oninput = () => this._annotSetColor(custom.value);
        this._annotCustomColor = custom;
        sw.appendChild(custom);
        p.appendChild(sw);

        // Stroke size.
        const sizeRow = el("div", { className: "row" });
        sizeRow.appendChild(el("label", { textContent: "Size" }));
        const sizeIn = el("input", { type: "range", min: "1", max: "40", step: "1", value: this._annot.size });
        const sizeNum = el("input", { type: "number", min: "1", max: "200", value: this._annot.size });
        const syncSize = (v) => {
            v = Math.max(1, Math.min(200, Math.round(+v || 1)));
            this._annot.size = v; this._annot.userSized = true;
            sizeIn.value = Math.min(40, v); sizeNum.value = v;
        };
        sizeIn.oninput = () => syncSize(sizeIn.value);
        sizeNum.oninput = () => syncSize(sizeNum.value);
        sizeRow.appendChild(sizeIn); sizeRow.appendChild(sizeNum);
        p.appendChild(sizeRow);

        // Text size.
        const tsRow = el("div", { className: "row" });
        tsRow.appendChild(el("label", { textContent: "Text" }));
        const tsIn = el("input", { type: "range", min: "8", max: "200", step: "1", value: this._annot.textSize });
        const tsNum = el("input", { type: "number", min: "8", max: "400", value: this._annot.textSize });
        const syncTs = (v) => {
            v = Math.max(8, Math.min(400, Math.round(+v || 8)));
            this._annot.textSize = v; this._annot.userSized = true;
            tsIn.value = Math.min(200, v); tsNum.value = v;
            if (this._annot.textInput) this._annot.textInput.style.font =
                Math.max(9, v * this._annotScale()) + "px sans-serif";
        };
        tsIn.oninput = () => syncTs(tsIn.value);
        tsNum.oninput = () => syncTs(tsNum.value);
        tsRow.appendChild(tsIn); tsRow.appendChild(tsNum);
        p.appendChild(tsRow);

        // Include-image toggle for the export.
        const incRow = el("label", { className: "row" });
        incRow.style.cursor = "pointer";
        incRow.appendChild(el("span", { textContent: "Include image" }));
        const inc = el("input", { type: "checkbox", checked: this._annot.includeImage });
        inc.onchange = () => { this._annot.includeImage = inc.checked; };
        incRow.appendChild(inc);
        p.appendChild(incRow);

        // Undo / Clear.
        const ucRow = el("div", { className: "bepic-annot-row" });
        const undo = el("button", { className: "bepic-act", textContent: "Undo" });
        undo.onclick = () => { const a = this._annotItems(false); if (a && a.length) { a.pop(); this._annotAfterChange(); } };
        const clr = el("button", { className: "bepic-act bepic-danger", textContent: "Clear" });
        clr.onclick = () => { this._annotStore[this.activeTab] = []; this._annotAfterChange(); };
        ucRow.appendChild(undo); ucRow.appendChild(clr);
        p.appendChild(ucRow);

        // Export.
        const exp = el("button", { className: "bepic-act", textContent: "Export annotation" });
        exp.style.cssText += "background:#3a2a10;border-color:#a60;color:#fff;font-weight:600;margin-top:6px;";
        exp.onclick = () => this._annotExport();
        this._annotExportBtn = exp;
        p.appendChild(exp);

        // Info + hint.
        this._annotInfoEl = el("div", { className: "bepic-tool-hint" });
        p.appendChild(this._annotInfoEl);
        p.appendChild(el("div", {
            className: "bepic-tool-hint",
            innerHTML: "Pen / Arrow / Box: <b>drag</b>. Text: <b>click</b> &amp; type (Enter sets).<br>"
                     + "Right-click an annotation to delete.<br>"
                     + "Export saves a PNG to <b>./output</b> and adds it to History — then drag it onto the graph.",
        }));

        this._annotSetTool(this._annot.tool);
        this._annotSetColor(this._annot.color);
        this._annotUpdateInfo();
    },

    _annotSetTool(t) {
        this._annot.tool = t;
        if (this._annotToolBtns)
            for (const k in this._annotToolBtns) this._annotToolBtns[k].classList.toggle("active", k === t);
        if (t !== "text") this._annotCommitText();
        this._updateToolCursor();
    },

    _annotSetColor(col) {
        this._annot.color = col;
        if (this._annotSwatches)
            this._annotSwatches.forEach(([s, c]) =>
                s.classList.toggle("sel", c.toLowerCase() === String(col).toLowerCase()));
        if (this._annotCustomColor && /^#[0-9a-f]{6}$/i.test(col)) this._annotCustomColor.value = col;
        if (this._annot.textInput) this._annot.textInput.style.color = col;
    },

    _annotUpdateInfo() {
        if (!this._annotInfoEl) return;
        const n = (this._annotItems(false) || []).length;
        this._annotInfoEl.textContent = n === 1 ? "1 annotation" : `${n} annotations`;
    },

    // ── export → PNG → ./output → history ─────────────────────────────────────
    async _annotExport() {
        if (this._videoMode) { this._toolSetStatus("<b>Annotate:</b> export works on images, not video"); return; }
        const img = this.imgBase;
        const w = img && img.naturalWidth, h = img && img.naturalHeight;
        if (!w || !h) { this._toolSetStatus("<b>Annotate:</b> no image to export"); return; }

        this._annotCommitText();
        const items = this._annotItems(false) || [];

        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (this._annot.includeImage) {
            try { ctx.drawImage(img, 0, 0, w, h); }
            catch (e) { console.warn("[annot] drawImage failed", e); }
        }
        for (const it of items) this._annotDrawItemToCtx(ctx, it, w, h);

        let dataurl;
        try { dataurl = canvas.toDataURL("image/png"); }
        catch (e) { this._toolSetStatus("<b>Annotate:</b> image is cross-origin — can't export"); return; }

        const btn = this._annotExportBtn;
        if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
        try {
            const resp = await api.fetchApi("/bepic/save_annotation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dataurl, filename_prefix: "bEpic_annotation" }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || data.error) throw new Error(data.error || ("HTTP " + resp.status));
            this._annotAddToHistory(data);
            this._toolSetStatus("<b>Annotate:</b> saved to History — drag the new thumbnail onto the graph");
        } catch (e) {
            console.error("[annot] export failed", e);
            this._toolSetStatus("<b>Annotate:</b> save failed — see console");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Export annotation"; }
        }
    },

    _annotDrawItemToCtx(ctx, it, w, h) {
        const color = it.color || "#ff3b30";
        ctx.save();
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        if (it.type === "text") {
            const size = it.size || 42;
            ctx.font = `${size}px sans-serif`;
            ctx.textBaseline = "top";
            ctx.lineWidth = Math.max(1, size * 0.12);
            ctx.strokeStyle = "#000";
            try { ctx.strokeText(it.text || "", it.x * w, it.y * h); } catch (_) {}
            ctx.fillStyle = color;
            ctx.fillText(it.text || "", it.x * w, it.y * h);
            ctx.restore(); return;
        }
        ctx.strokeStyle = color; ctx.fillStyle = color;
        ctx.lineWidth = Math.max(1, it.width || 6);
        if (it.type === "pen") {
            if (it.pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(it.pts[0].x * w, it.pts[0].y * h);
                for (let i = 1; i < it.pts.length; i++) ctx.lineTo(it.pts[i].x * w, it.pts[i].y * h);
                ctx.stroke();
            }
            ctx.restore(); return;
        }
        const ax = it.a.x * w, ay = it.a.y * h, bx = it.b.x * w, by = it.b.y * h;
        if (it.type === "rect") {
            ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
            ctx.restore(); return;
        }
        if (it.type === "arrow") {
            ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
            const ang = Math.atan2(by - ay, bx - ax);
            const head = Math.max(10, (it.width || 6) * 3.2);
            const wing = Math.PI / 7;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx - head * Math.cos(ang - wing), by - head * Math.sin(ang - wing));
            ctx.lineTo(bx - head * Math.cos(ang + wing), by - head * Math.sin(ang + wing));
            ctx.closePath(); ctx.fill();
        }
        ctx.restore();
    },

    _annotAddToHistory(saved) {
        const key = this.activeTab;
        if (!key || !saved || !saved.filename) return;
        const frame = {
            filename: saved.filename,
            subfolder: saved.subfolder || "",
            type: saved.type || "output",
            path: saved.path || null,
            name: saved.filename,
        };
        if (!this.history[key]) this.history[key] = [];
        // Always a new entry (each save writes its own file), so this doesn't go
        // through pushHistorySnapshot's de-dupe — but the cap still has to release
        // whatever falls off the end.
        this.history[key].unshift([frame]);
        this.trimHistory(key);

        const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
        if (panel) panel.style.display = "flex";
        if (this._syncHistoryToggleState) this._syncHistoryToggleState();
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        if (this.queuePersistViewerState) this.queuePersistViewerState();
    },
};
