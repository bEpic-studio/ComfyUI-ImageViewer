// bEpicViewer_tools.js
// ToolsMixin — the in-viewer editing tools layer shared by the Roto and
// SAM3-points tools, plus the full SAM3 points tool implementation.
//
// Responsibilities:
//   * Build a tool overlay (an aligned <svg> for coordinate mapping + a
//     screen-space <svg> for drawing handles) and a small toolbar/panel.
//   * Map between normalized image coords ([0,1]) and screen coords using the
//     reference svg's getScreenCTM(), so zoom/pan/fit are handled for free.
//   * Bind the active tool to the node that stores its work, and load/save
//     through that node's hidden widgets.
//   * Implement the SAM3 points tool end-to-end.
//
// Each tool writes into its own node type — Roto into bEpicImageViewerRoto,
// both SAM3 tools into bEpicImageViewerSAM3Collector — and WHICH node of that
// type follows the canvas selection: select a Roto node and the tool edits its
// shapes, select the node whose picture you want to matte and pressing the tool
// button hangs a fresh one off it. With nothing useful selected the tab decides,
// so the toolbar still works from any tab. ensureToolNode in
// bEpicViewer_nodeTools.js holds the full order of precedence.
//
// The Roto tool lives in bEpicViewer_roto.js and plugs into the hooks here
// (_rotoActivate / _rotoDeactivate / _rotoRender / _rotoPointerDown / ...).

import {
    ensureToolNode,
    imageSourceForTab,
    selectedImageSource,
    toolNodeFromSelection,
    graphSelectionSignature,
    nodeInGraph,
    readToolStore,
    writeToolStore,
    SAM3_POS_WIDGET,
    SAM3_NEG_WIDGET,
    SAM3_BOX_POS_WIDGET,
    SAM3_BOX_NEG_WIDGET,
} from "./bEpicViewer_nodeTools.js";

// Which node kind each toolbar tool stores into. Annotation is absent on
// purpose: it is markup over whatever is on screen and needs no node at all.
const TOOL_NODE_KIND = { roto: "roto", sam3: "sam3", sam3box: "sam3" };

// How each tool names its node in the panel.
const TOOL_NODE_LABEL = { roto: "Roto", sam3: "SAM3 Collector", sam3box: "SAM3 Collector" };

const SVGNS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}

function elWith(tag, props, style) {
    const el = document.createElement(tag);
    if (props) Object.assign(el, props);
    if (style) Object.assign(el.style, style);
    return el;
}

export const ToolsMixin = {

    // ── bootstrap ────────────────────────────────────────────────────────────
    _initTools() {
        this._toolState = { active: "none", node: null };
        this._sam3 = { pos: [], neg: [], drag: null, hover: null };
        this._sam3box = { pos: [], neg: [], drag: null, hover: null };

        this._injectToolStyles();
        this._buildToolOverlay();
        this._buildToolbar();
        this._wireToolPointer();

        // Roto mixin one-time setup (state containers).
        this._rotoInit?.();
        // Annotation mixin one-time setup (per-tab item store + styles).
        this._annotInit?.();

        try { this._watchViewportResize(); } catch (e) { /* never abort init over this */ }

        this.setActiveTool("none");
    },

    // Keep the overlay, the white image-frame outline and the compare layout
    // aligned when the viewport resizes — a side panel is toggled, or the
    // undocked popout window is dragged or maximised. updateImageFrame recomputes
    // #img-frame from the image's new client size; _syncCompareLayout re-derives
    // the compare scale and the wipe seam, both measured against the viewport box.
    //
    // Re-callable, and it has to be. A ResizeObserver only reports targets that
    // live in its OWN document, so the moment undocking moves the container into
    // the popout's document, an observer built in the ComfyUI window stops
    // delivering — measured: zero notifications for a popout resize that took the
    // element from 500 to 934px. Undock and re-dock rebuild this in whichever
    // realm the container has landed in.
    _watchViewportResize() {
        try { this._toolResizeObs && this._toolResizeObs.disconnect(); } catch (e) {}
        this._toolResizeObs = null;
        try { this._viewportResizeOff && this._viewportResizeOff(); } catch (e) {}
        this._viewportResizeOff = null;
        if (!this.viewport) return;

        const redraw = () => {
            this.updateImageFrame && this.updateImageFrame();
            this.updateToolOverlay && this.updateToolOverlay();
            this._syncCompareLayout && this._syncCompareLayout();
        };

        // Read the realm off the observed element itself rather than through a
        // helper on another mixin: this runs during startup, and a throw here
        // would take the rest of _initTools down with it.
        let win = window;
        try {
            const doc = this.viewport.ownerDocument;
            if (doc && doc.defaultView) win = doc.defaultView;
        } catch (e) {}

        try {
            const RO = win.ResizeObserver || ResizeObserver;
            this._toolResizeObs = new RO(redraw);
            this._toolResizeObs.observe(this.viewport);
        } catch (e) {}

        // Belt and braces while undocked. The observer above catches resizes that
        // come from inside the layout (a side panel toggling); this catches the
        // user dragging or maximising the popout itself, without depending on how
        // the browser treats an observer whose target was adopted into another
        // document.
        try {
            if (win !== window && win.addEventListener) {
                const onResize = () => redraw();
                win.addEventListener('resize', onResize);
                this._viewportResizeOff = () => {
                    try { win.removeEventListener('resize', onResize); } catch (e) {}
                };
            }
        } catch (e) {}

        // Undocking is also what strands the selection poll's timer in a
        // backgrounded window, and this is the hook that says the container has
        // moved. Only restart a poll that is already running — an idle toolbar
        // has nothing to watch.
        if (this._toolSelTimer) this._toolWatchSelection();
    },

    _injectToolStyles() {
        if (this.shadowRoot.getElementById("bepic-tool-style")) return;
        const s = document.createElement("style");
        s.id = "bepic-tool-style";
        s.textContent = `
            #bepic-tool-ref { position:absolute; top:0; left:0; pointer-events:none;
                z-index:40; overflow:visible; opacity:0; }
            #bepic-tool-draw { position:absolute; inset:0; z-index:41;
                pointer-events:none; overflow:visible; }
            #bepic-tool-draw.active { pointer-events:auto; }
            /* While a tool is on, stop the viewport's grab/grabbing hand from
               bleeding through (esp. the :active grabbing cursor during drags). */
            .viewport.bepic-tool-on, .viewport.bepic-tool-on:active { cursor:default; }
            .bepic-toolbar { position:absolute; top:44px; left:8px; z-index:60;
                display:flex; flex-direction:column; gap:4px; }
            .bepic-toolbar button { width:30px; height:30px; border:1px solid #444;
                background:rgba(24,24,24,.9); color:#ccc; border-radius:4px;
                cursor:pointer; font-size:15px; line-height:1; padding:0;
                display:flex; align-items:center; justify-content:center; }
            .bepic-toolbar button:hover { background:#333; color:#fff; }
            .bepic-toolbar button.active { color:#f60; border-color:#f60; }
            .bepic-tool-panel { position:absolute; top:44px; left:46px; z-index:60;
                min-width:190px; max-width:230px; background:rgba(20,20,20,.94);
                border:1px solid #444; border-radius:6px; padding:8px;
                color:#ddd; font-family:sans-serif; font-size:12px; display:none; }
            .bepic-tool-panel.show { display:block; }
            .bepic-tool-panel h4 { margin:0 0 6px; font-size:12px; color:#f60;
                text-transform:uppercase; letter-spacing:.4px; }
            .bepic-tool-panel .row { display:flex; align-items:center;
                justify-content:space-between; gap:6px; margin:4px 0; }
            .bepic-tool-panel .row label { color:#aaa; flex:0 0 auto; }
            .bepic-tool-panel input[type=range] { flex:1; min-width:0; }
            .bepic-tool-panel input[type=number] { width:52px; background:#111;
                color:#0ce; border:1px solid #444; border-radius:3px; }
            .bepic-tool-panel button.bepic-act { width:100%; margin-top:4px;
                padding:5px; background:#2a2a2a; color:#ddd; border:1px solid #555;
                border-radius:4px; cursor:pointer; }
            .bepic-tool-panel button.bepic-act:hover { background:#3a3a3a; }
            .bepic-tool-panel button.bepic-danger:hover { background:#5a2020;
                border-color:#a33; color:#fff; }
            .bepic-tool-hint { color:#888; font-size:11px; margin-top:6px;
                line-height:1.35; }
            /* Which node the tool is reading and writing — it follows the canvas
               selection, so it has to be visible. */
            .bepic-tool-node { display:flex; align-items:baseline; gap:5px;
                margin:-2px 0 7px; padding-bottom:6px; font-size:11px;
                border-bottom:1px solid #333; }
            .bepic-tool-node .lbl { color:#f60; font-size:9px; letter-spacing:.5px;
                text-transform:uppercase; flex:0 0 auto; }
            .bepic-tool-node .nm { color:#ddd; flex:1; min-width:0; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
            .bepic-tool-node .id { color:#666; flex:0 0 auto; }
            .bepic-tool-disabled { opacity:.45; }
            .bepic-layer-list { max-height:150px; overflow:auto; margin:4px 0;
                border:1px solid #333; border-radius:4px; }
            .bepic-layer-row { display:flex; align-items:center; gap:4px;
                padding:3px 5px; cursor:pointer; border-bottom:1px solid #262626; }
            .bepic-layer-row.sel { background:#3a2a10; }
            .bepic-layer-row .nm { flex:1; overflow:hidden; text-overflow:ellipsis;
                white-space:nowrap; }
            .bepic-layer-row .vis { cursor:pointer; opacity:.85; }
            .bepic-layer-row .del { cursor:pointer; color:#c66; }
            /* Context hint that tracks what the cursor is over (bottom-left,
               above the full-width path bar). */
            .bepic-tool-status { position:absolute; left:8px; bottom:30px; z-index:55;
                max-width:calc(100% - 16px); background:rgba(20,20,20,.9); color:#cfcfcf;
                border:1px solid #444; border-radius:4px; padding:4px 9px; font-size:11px;
                font-family:sans-serif; pointer-events:none; display:none; white-space:nowrap;
                overflow:hidden; text-overflow:ellipsis; }
            .bepic-tool-status b { color:#f60; font-weight:600; }
        `;
        this.shadowRoot.appendChild(s);
    },

    _buildToolOverlay() {
        // Reference svg (aligned to the drawn image) used only for coord mapping.
        this._toolRef = svgEl("svg", { id: "bepic-tool-ref", preserveAspectRatio: "none" });
        // Inner <g> lives in the viewBox (image-pixel) coordinate system; its
        // getScreenCTM() unambiguously includes the viewBox transform.
        this._toolRefG = svgEl("g");
        this._toolRef.appendChild(this._toolRefG);
        // Screen-space svg where all handles/shapes are drawn.
        this._toolDraw = svgEl("svg", { id: "bepic-tool-draw" });
        this.viewport.appendChild(this._toolRef);
        this.viewport.appendChild(this._toolDraw);
        this._toolDrawRect = null;

        // Hover feedback: a context hint + cursor that reflect what's under the
        // pointer. Only fires while a tool owns the draw layer (pointer-events).
        this._toolDraw.addEventListener("mousemove", (e) => this._onToolPointerMove(e));
        this._toolDraw.addEventListener("mouseleave", () => this._toolSetStatus(""));
    },

    _buildToolbar() {
        const bar = elWith("div", { className: "bepic-toolbar" });
        const mk = (tool, glyph, title) => {
            const b = elWith("button", { title, textContent: glyph });
            b.dataset.tool = tool;
            b.onclick = () => this.setActiveTool(this._toolState.active === tool ? "none" : tool);
            bar.appendChild(b);
            return b;
        };
        this._toolBtns = {
            roto: mk("roto", "✎", "Roto tool"),
            sam3: mk("sam3", "◉", "SAM3 points tool"),
            sam3box: mk("sam3box", "⬚", "SAM3 boxes tool"),
            annotate: mk("annotate", "✐", "Annotate (draw & text)"),
        };
        this.viewport.appendChild(bar);
        this._toolbar = bar;

        this._toolPanel = elWith("div", { className: "bepic-tool-panel" });
        this.viewport.appendChild(this._toolPanel);

        // Context hint that updates from what the cursor is over (see
        // _onToolPointerMove). Hidden unless a tool is active.
        this._toolStatusEl = elWith("div", { className: "bepic-tool-status" });
        this.viewport.appendChild(this._toolStatusEl);
    },

    // Update (or hide, when text is empty) the context hint line.
    _toolSetStatus(text) {
        if (!this._toolStatusEl) return;
        if (text) { this._toolStatusEl.innerHTML = text; this._toolStatusEl.style.display = "block"; }
        else this._toolStatusEl.style.display = "none";
    },

    // ── geometry / mapping ────────────────────────────────────────────────────
    _toolImgSize() {
        const w = this.imgBase?.naturalWidth || 0;
        const h = this.imgBase?.naturalHeight || 0;
        return { w, h };
    },

    // Keep the reference svg aligned to the drawn image (mirrors #img-frame).
    updateToolOverlay() {
        const ref = this._toolRef, draw = this._toolDraw, f = this.imgFrame;
        if (!ref || !draw) return;
        const { w, h } = this._toolImgSize();
        const usable = f && f.style.display !== "none" && w > 0 && h > 0
            && this.sliderMode !== "contact";
        if (!usable) {
            ref.style.display = "none";
            if (this._toolState.active !== "none") this._toolClearDraw();
            return;
        }
        ref.style.display = "block";
        ref.style.left = f.style.left;
        ref.style.top = f.style.top;
        ref.style.width = f.style.width;
        ref.style.height = f.style.height;
        ref.style.transform = f.style.transform || "";
        ref.setAttribute("viewBox", `0 0 ${w} ${h}`);

        this._toolDrawRect = draw.getBoundingClientRect();
        this._toolRedraw();
    },

    _refCTM() {
        try { return this._toolRefG.getScreenCTM(); } catch (e) { return null; }
    },

    // normalized [0,1] -> client px
    _normToClient(nx, ny) {
        const ctm = this._refCTM();
        const { w, h } = this._toolImgSize();
        if (!ctm || !w || !h) return null;
        const p = this._toolRef.createSVGPoint();
        p.x = nx * w; p.y = ny * h;
        const s = p.matrixTransform(ctm);
        return { x: s.x, y: s.y };
    },

    // client px -> normalized [0,1]
    _clientToNorm(cx, cy) {
        const ctm = this._refCTM();
        const { w, h } = this._toolImgSize();
        if (!ctm || !w || !h) return null;
        const p = this._toolRef.createSVGPoint();
        p.x = cx; p.y = cy;
        const u = p.matrixTransform(ctm.inverse());
        return { x: u.x / w, y: u.y / h };
    },

    // normalized -> local coords of the draw svg (for placing elements)
    _normToDraw(nx, ny) {
        const c = this._normToClient(nx, ny);
        if (!c) return null;
        const r = this._toolDrawRect || (this._toolDrawRect = this._toolDraw.getBoundingClientRect());
        return { x: c.x - r.left, y: c.y - r.top };
    },

    _eventToNorm(e) {
        return this._clientToNorm(e.clientX, e.clientY);
    },

    // Screen-px distance between two normalized points.
    _screenDist(nA, nB) {
        const a = this._normToClient(nA.x, nA.y);
        const b = this._normToClient(nB.x, nB.y);
        if (!a || !b) return Infinity;
        return Math.hypot(a.x - b.x, a.y - b.y);
    },

    // ── tool activation ───────────────────────────────────────────────────────
    _toolActive() {
        if (this._toolState.active === "none") return false;
        if (this.isComparing || this.sliderMode === "contact") return false;
        // Annotation is standalone markup over whatever image is shown, so it
        // needs no bound "Send to Viewer" node (works on folder / dropped tabs).
        if (this._toolState.active === "annotate") return true;
        return !!this._toolState.node;
    },

    setActiveTool(tool) {
        const prev = this._toolState.active;
        if (prev === "roto" && tool !== "roto") this._rotoDeactivate?.();
        if (prev === "annotate" && tool !== "annotate") this._annotDeactivate?.();
        this._toolState.active = tool;

        for (const k in this._toolBtns) this._toolBtns[k].classList.toggle("active", k === tool);
        this._toolDraw.classList.toggle("active", tool !== "none");
        this._updateToolCursor();

        // Pressing a tool button is the one moment we may add a node to the
        // graph: the user asked for this tool here, so give them somewhere to
        // draw. Plain rebinds (tab switches, selection changes) never create.
        this._bindActiveTool({ create: tool !== "none" });
        if (TOOL_NODE_KIND[tool]) this._toolWatchSelection();
        else this._toolUnwatchSelection();

        // Panel content
        this._toolPanel.classList.toggle("show", tool !== "none");
        if (tool === "sam3") this._sam3BuildPanel();
        else if (tool === "sam3box") this._sam3boxBuildPanel();
        else if (tool === "roto") this._rotoActivate?.(this._toolPanel);
        else if (tool === "annotate") this._annotActivate?.(this._toolPanel);
        else this._toolPanel.innerHTML = "";
        if (tool === "none") this._toolSetStatus("");

        this.updateToolOverlay();
    },

    // Cursor while a tool is active: arrow for roto (all modes), crosshair for
    // point placing. The bepic-tool-on class also suppresses the viewport grab.
    _updateToolCursor() {
        const active = this._toolState.active;
        this.viewport.classList.toggle("bepic-tool-on", active !== "none");
        let c = "default";
        if (active === "sam3" || active === "sam3box") c = "crosshair";
        else if (active === "annotate") c = (this._annot && this._annot.tool === "text") ? "text" : "crosshair";
        this._toolDraw.style.cursor = c;
    },

    // Point the active tool at the node that stores its work, and load what is
    // already in there. Only the active tool is bound: the tools no longer share
    // one node, so there is nothing to load for the others until they're picked
    // — and picking one comes back through here.
    //
    // Which node that is comes from ensureToolNode, which reads the canvas
    // selection first and the active tab second.
    _bindActiveTool(opts = {}) {
        const kind = TOOL_NODE_KIND[this._toolState.active] || null;
        const node = kind ? ensureToolNode(this, this.activeTab, kind, opts) : null;
        this._toolState.node = node;

        this._sam3 = { pos: [], neg: [], drag: null, hover: null };
        this._sam3box = { pos: [], neg: [], drag: null, hover: null };
        if (kind === "sam3" && node) {
            this._sam3Load(node);
            this._sam3boxLoad(node);
        }
        if (kind === "roto") {
            if (node) this._rotoLoadFromNode?.(node);
            else this._rotoClearState?.();
        }

        // Reflect availability. Annotation needs no node, so its panel stays live
        // on every tab; refresh its per-tab annotation count on rebind.
        const disabled = !node && this._toolState.active !== "annotate";
        this._toolPanel.classList.toggle("bepic-tool-disabled", disabled);
        if (this._toolState.active === "annotate") this._annotUpdateInfo?.();
        this._toolRedraw();
    },

    // Rebuild whichever tool panel is showing (after a node appears, say).
    _toolRefreshPanel() {
        const t = this._toolState.active;
        if (t === "sam3") this._sam3BuildPanel();
        else if (t === "sam3box") this._sam3boxBuildPanel();
        else if (t === "roto") this._rotoBuildPanel?.();
    },

    // Panel body for a tool with nowhere to store its work. Where there is an
    // image we can wire to — the selected node's, or failing that the tab's —
    // that is one button away; where there isn't (a folder or dropped-file tab
    // with nothing selected) say so plainly instead of offering a button that
    // would do nothing.
    _toolMissingNodeBody(panel, tool) {
        const label = TOOL_NODE_LABEL[tool] || "tool";
        const src = selectedImageSource() || imageSourceForTab(this, this.activeTab);
        if (!src) {
            panel.appendChild(elWith("div", {
                className: "bepic-tool-hint",
                textContent: `Nothing to attach a ${label} node to. Select the node whose image you want on the graph canvas, or switch to a tab a node produced.`,
            }));
            return;
        }
        const from = src.node.title || src.node.type || `node ${src.node.id}`;
        const add = elWith("button", { className: "bepic-act", textContent: `Add ${label} node` });
        add.onclick = () => {
            this._bindActiveTool({ create: true });
            this._toolRefreshPanel();
        };
        panel.appendChild(add);
        panel.appendChild(elWith("div", {
            className: "bepic-tool-hint",
            textContent: `Adds a ${label} node fed from "${from}" and edits that. It gets its own tab the next time the workflow runs. To edit an existing ${label} node instead, select it on the graph canvas.`,
        }));
    },

    // A line naming the node the tool is bound to, for the top of its panel.
    // Which node that is now depends on what is selected on the canvas, so
    // saying it out loud is the difference between "my shapes vanished" and
    // "I am editing a different node".
    _toolBoundNodeRow() {
        const node = this._toolState.node;
        if (!node) return null;
        const row = elWith("div", { className: "bepic-tool-node" });
        row.innerHTML = `<span class="lbl">editing</span><span class="nm"></span><span class="id"></span>`;
        // textContent, not innerHTML: a node title is the user's own string.
        row.querySelector(".nm").textContent = node.title || node.type;
        row.querySelector(".id").textContent = `#${node.id}`;
        row.title = "The tool reads and writes this node. Select another one on the graph canvas to edit that instead.";
        return row;
    },

    // ── canvas selection → the node the tool edits ───────────────────────────
    // The tools follow what is selected on the graph canvas (see ensureToolNode),
    // and litegraph offers no selection event that can be relied on across
    // frontend versions — the parameters panel polls for the same reason. A
    // timer rather than a rAF, though: a selection change is a human action, so
    // a fifth of a second of latency on the rebind is invisible, where a
    // per-frame poll would not be free.
    //
    // The timer comes from whichever window the viewer is in. Undocked, the
    // ComfyUI tab that loaded this module is in the background, where timers are
    // throttled to about once a second and rAF stops altogether.
    _toolWatchSelection() {
        this._toolUnwatchSelection();
        const win = (this._viewerWindow && this._viewerWindow()) || window;
        this._toolSelSig = this._toolSelectionSig();
        this._toolSelWin = win;
        this._toolSelTimer = win.setInterval(() => {
            const sig = this._toolSelectionSig();
            if (sig === this._toolSelSig) return;
            this._toolSelSig = sig;
            this._onGraphSelectionChanged();
        }, 220);
    },

    _toolUnwatchSelection() {
        if (this._toolSelTimer) {
            try { (this._toolSelWin || window).clearInterval(this._toolSelTimer); } catch (e) {}
        }
        this._toolSelTimer = null;
        this._toolSelWin = null;
    },

    // What is selected, plus whether the bound node is still there — deleting
    // the node being edited has to rebind too, and that need not change the
    // selection at all.
    _toolSelectionSig() {
        const bound = this._toolState && this._toolState.node;
        const alive = bound ? (nodeInGraph(bound) ? bound.id : "gone") : "-";
        return `${graphSelectionSignature()}|${alive}`;
    },

    _onGraphSelectionChanged() {
        const kind = TOOL_NODE_KIND[this._toolState.active];
        if (!kind) return;
        const bound = this._toolState.node;
        // Two things move the tool: a selection that names a node of this kind,
        // and the node it is on being deleted. Anything else — a KSampler, empty
        // canvas — is not about this tool and leaves it alone, because rebinding
        // reloads the tool's state and would throw away a shape still being drawn.
        const stale = !!bound && !nodeInGraph(bound);
        if (!stale && !toolNodeFromSelection(kind)) return;
        // Resolve first: where the tool actually lands is ensureToolNode's call,
        // not the selection's alone, and if that is where it already is there is
        // nothing to reload.
        const next = ensureToolNode(this, this.activeTab, kind);   // never creates
        if (next === bound) return;
        this._bindActiveTool();
        this._toolRefreshPanel();
    },

    _toolClearDraw() {
        while (this._toolDraw.firstChild) this._toolDraw.removeChild(this._toolDraw.firstChild);
    },

    _toolRedraw() {
        this._toolClearDraw();
        if (!this._toolActive()) return;
        this._toolDrawRect = this._toolDraw.getBoundingClientRect();
        if (this._toolState.active === "sam3") this._sam3Render();
        else if (this._toolState.active === "sam3box") this._sam3boxRender();
        else if (this._toolState.active === "roto") this._rotoRender?.();
        else if (this._toolState.active === "annotate") this._annotRender?.();
    },

    // ── pointer dispatch (integrates with existing pan/zoom) ──────────────────
    _wireToolPointer() {
        const origDown = this.viewport.onmousedown;
        this.viewport.onmousedown = (e) => {
            // Route left AND right buttons to the active tool (middle stays pan,
            // E-held stays exposure). The tool decides whether it consumes the
            // event; unconsumed right-clicks fall through to viewport zoom.
            if (this._toolActive() && !this.isExposureModifierActive
                && (e.button === 0 || e.button === 2)) {
                if (e.target && e.target.closest && e.target.closest(
                    ".bepic-toolbar,.bepic-tool-panel,#exposure-control,#compare-slider")) {
                    return origDown ? origDown.call(this.viewport, e) : undefined;
                }
                const consumed = this._onToolPointerDown(e);
                if (consumed) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
            }
            return origDown ? origDown.call(this.viewport, e) : undefined;
        };
    },

    _onToolPointerDown(e) {
        this.updateToolOverlay();
        if (this._toolState.active === "sam3") return this._sam3PointerDown(e);
        if (this._toolState.active === "sam3box") return this._sam3boxPointerDown(e);
        if (this._toolState.active === "roto") return this._rotoPointerDown?.(e);
        if (this._toolState.active === "annotate") return this._annotPointerDown?.(e);
        return false;
    },

    // Hover feedback: set the context hint + cursor from what the pointer is over.
    // Skipped while a drag is in progress or over tool chrome.
    _onToolPointerMove(e) {
        if (!this._toolActive() || this._toolDragging) return;
        if (e.target && e.target.closest && e.target.closest(
            ".bepic-toolbar,.bepic-tool-panel,#exposure-control,#compare-slider")) {
            this._toolSetStatus("");
            return;
        }
        const n = this._eventToNorm(e);
        if (!n) return;
        let ctx = null;
        if (this._toolState.active === "roto") ctx = this._rotoHoverContext?.(e, n);
        else if (this._toolState.active === "sam3") ctx = this._sam3HoverContext(e, n);
        else if (this._toolState.active === "sam3box") ctx = this._sam3boxHoverContext(e, n);
        else if (this._toolState.active === "annotate") ctx = this._annotHoverContext?.(e, n);
        if (!ctx) return;
        this._toolSetStatus(ctx.status);
        this._toolDraw.style.cursor = ctx.cursor || "default";
    },

    _sam3HoverContext(e, n) {
        if (this._sam3HitTest(n.x, n.y)) {
            return { status: "<b>Drag</b> move · <b>Right-click</b> delete", cursor: "move" };
        }
        return {
            status: e.shiftKey ? "<b>Click</b> add negative point" : "<b>Click</b> positive · <b>Shift+click</b> negative",
            cursor: "crosshair",
        };
    },

    // Attach a window-level drag loop; onMove/onUp receive the raw event.
    _toolDrag(onMove, onUp) {
        const win = this.container.ownerDocument.defaultView || window;
        this._toolDragging = true;
        const move = (ev) => { ev.preventDefault(); onMove(ev); };
        const up = (ev) => {
            win.removeEventListener("mousemove", move);
            win.removeEventListener("mouseup", up);
            this._toolDragging = false;
            onUp && onUp(ev);
        };
        win.addEventListener("mousemove", move);
        win.addEventListener("mouseup", up);
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  SAM3 POINTS TOOL
    // ═══════════════════════════════════════════════════════════════════════
    _sam3Load(node) {
        const parse = (name) => {
            try {
                const arr = JSON.parse(readToolStore(node, name, "[]"));
                return Array.isArray(arr)
                    ? arr.filter((p) => p && isFinite(p.x) && isFinite(p.y))
                          .map((p) => ({ x: +p.x, y: +p.y }))
                    : [];
            } catch (e) { return []; }
        };
        this._sam3 = {
            pos: parse(SAM3_POS_WIDGET),
            neg: parse(SAM3_NEG_WIDGET),
            drag: null, hover: null,
        };
    },

    _sam3Save() {
        const node = this._toolState.node;
        if (!node) return;
        writeToolStore(node, SAM3_POS_WIDGET, this._sam3.pos);
        writeToolStore(node, SAM3_NEG_WIDGET, this._sam3.neg);
        this._sam3UpdateCount();
    },

    _sam3HitTest(nx, ny) {
        const th = 9; // screen px
        const scan = (arr, type) => {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (this._screenDist({ x: nx, y: ny }, arr[i]) <= th) return { type, i };
            }
            return null;
        };
        return scan(this._sam3.pos, "pos") || scan(this._sam3.neg, "neg");
    },

    _sam3PointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        const hit = this._sam3HitTest(n.x, n.y);
        const isDelete = (e.button === 2 || e.ctrlKey);

        // Right-click / ctrl-click on a point removes it.
        if (hit && isDelete) {
            (hit.type === "pos" ? this._sam3.pos : this._sam3.neg).splice(hit.i, 1);
            this._sam3Save(); this._toolRedraw();
            return true;
        }
        // Right-click on empty space: let the viewport handle zoom.
        if (isDelete) return false;

        if (hit) {
            // Begin dragging an existing point (left button).
            this._sam3.drag = hit;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev);
                    if (!m) return;
                    const arr = hit.type === "pos" ? this._sam3.pos : this._sam3.neg;
                    arr[hit.i] = { x: clamp01(m.x), y: clamp01(m.y) };
                    this._toolRedraw();
                },
                () => { this._sam3.drag = null; this._sam3Save(); this._toolRedraw(); },
            );
            return true;
        }

        // Add a new point. Shift = negative, else positive.
        const p = { x: clamp01(n.x), y: clamp01(n.y) };
        if (e.shiftKey) this._sam3.neg.push(p);
        else this._sam3.pos.push(p);
        this._sam3Save();
        this._toolRedraw();
        return true;
    },

    _sam3Render() {
        const draw = (arr, color) => {
            for (const pt of arr) {
                const d = this._normToDraw(pt.x, pt.y);
                if (!d) continue;
                const c = svgEl("circle", {
                    cx: d.x, cy: d.y, r: 6, fill: color,
                    stroke: "#000", "stroke-width": 1.5,
                });
                this._toolDraw.appendChild(c);
            }
        };
        draw(this._sam3.pos, "#28d17c");
        draw(this._sam3.neg, "#e5484d");
    },

    _sam3BuildPanel() {
        const p = this._toolPanel;
        p.innerHTML = "";
        p.appendChild(elWith("h4", { textContent: "SAM3 Points" }));

        if (!this._toolState.node) {
            this._toolMissingNodeBody(p, "sam3");
            return;
        }

        const boundS = this._toolBoundNodeRow();
        if (boundS) p.appendChild(boundS);

        this._sam3CountEl = elWith("div", { className: "bepic-tool-hint" });
        p.appendChild(this._sam3CountEl);

        const clearBtn = elWith("button", { className: "bepic-act bepic-danger", textContent: "Clear points" });
        clearBtn.onclick = () => {
            this._sam3.pos = []; this._sam3.neg = [];
            this._sam3Save(); this._toolRedraw();
        };
        p.appendChild(clearBtn);

        p.appendChild(elWith("div", {
            className: "bepic-tool-hint",
            innerHTML: "L-click: <b style='color:#28d17c'>positive</b><br>Shift+click: <b style='color:#e5484d'>negative</b><br>R-click / Ctrl+click a dot: delete<br>Drag a dot to move. Middle-drag pans.",
        }));
        this._sam3UpdateCount();
    },

    _sam3UpdateCount() {
        if (this._sam3CountEl) {
            this._sam3CountEl.textContent =
                `${this._sam3.pos.length} positive · ${this._sam3.neg.length} negative`;
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    //  SAM3 BOXES TOOL
    //  Drag out a bounding box (positive = green, Shift = negative/red). Drag a
    //  corner to resize, drag the body to move, right-click / Ctrl+click to
    //  delete. Boxes are stored normalized as {x1,y1,x2,y2} and emitted as
    //  SAM3_BOXES_PROMPT (center format), matching ComfyUI-SAM3's BBoxCollector.
    // ═══════════════════════════════════════════════════════════════════════
    _sam3boxLoad(node) {
        const parse = (name) => {
            try {
                const arr = JSON.parse(readToolStore(node, name, "[]"));
                return Array.isArray(arr)
                    ? arr.filter((b) => b && isFinite(b.x1) && isFinite(b.y1) && isFinite(b.x2) && isFinite(b.y2))
                          .map((b) => ({ x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2 }))
                    : [];
            } catch (e) { return []; }
        };
        this._sam3box = {
            pos: parse(SAM3_BOX_POS_WIDGET),
            neg: parse(SAM3_BOX_NEG_WIDGET),
            drag: null, hover: null,
        };
    },

    _sam3boxSave() {
        const node = this._toolState.node;
        if (!node) return;
        writeToolStore(node, SAM3_BOX_POS_WIDGET, this._sam3box.pos);
        writeToolStore(node, SAM3_BOX_NEG_WIDGET, this._sam3box.neg);
        this._sam3boxUpdateCount();
    },

    // Normalize a box in place so x1<x2 and y1<y2.
    _sam3boxNormalize(b) {
        const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2);
        const y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
        b.x1 = x1; b.x2 = x2; b.y1 = y1; b.y2 = y2;
        return b;
    },

    // Hit-test: corners (resize) first, then body (move). Returns
    // { type:'pos'|'neg', i, part:'nw'|'ne'|'sw'|'se'|'body' } or null.
    _sam3boxHitTest(nx, ny) {
        const cur = { x: nx, y: ny };
        const th = 9;   // screen px for a corner grab
        const corners = (b) => ({
            nw: { x: Math.min(b.x1, b.x2), y: Math.min(b.y1, b.y2) },
            ne: { x: Math.max(b.x1, b.x2), y: Math.min(b.y1, b.y2) },
            sw: { x: Math.min(b.x1, b.x2), y: Math.max(b.y1, b.y2) },
            se: { x: Math.max(b.x1, b.x2), y: Math.max(b.y1, b.y2) },
        });
        // Corners across both lists (positive drawn on top → tested first).
        for (const type of ["pos", "neg"]) {
            const arr = this._sam3box[type];
            for (let i = arr.length - 1; i >= 0; i--) {
                const c = corners(arr[i]);
                for (const part of ["nw", "ne", "sw", "se"]) {
                    if (this._screenDist(cur, c[part]) <= th) return { type, i, part };
                }
            }
        }
        // Bodies.
        for (const type of ["pos", "neg"]) {
            const arr = this._sam3box[type];
            for (let i = arr.length - 1; i >= 0; i--) {
                const b = arr[i];
                const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2);
                const y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
                if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2) return { type, i, part: "body" };
            }
        }
        return null;
    },

    _sam3boxPointerDown(e) {
        const n = this._eventToNorm(e);
        if (!n) return false;
        const isDelete = (e.button === 2 || e.ctrlKey);
        const hit = this._sam3boxHitTest(n.x, n.y);

        // Right-click / ctrl-click on a box removes it.
        if (hit && isDelete) {
            this._sam3box[hit.type].splice(hit.i, 1);
            this._sam3boxSave(); this._toolRedraw();
            return true;
        }
        if (isDelete) return false;   // right-click empty → viewport zoom

        // Resize by dragging a corner (the opposite corner stays anchored).
        if (hit && hit.part !== "body") {
            const b = this._sam3boxNormalize(this._sam3box[hit.type][hit.i]);
            const anchor = {
                nw: { x: b.x2, y: b.y2 }, ne: { x: b.x1, y: b.y2 },
                sw: { x: b.x2, y: b.y1 }, se: { x: b.x1, y: b.y1 },
            }[hit.part];
            this._sam3box.drag = hit;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev);
                    if (!m) return;
                    const mx = clamp01(m.x), my = clamp01(m.y);
                    b.x1 = Math.min(anchor.x, mx); b.x2 = Math.max(anchor.x, mx);
                    b.y1 = Math.min(anchor.y, my); b.y2 = Math.max(anchor.y, my);
                    this._toolRedraw();
                },
                () => { this._sam3box.drag = null; this._sam3boxSave(); this._toolRedraw(); },
            );
            return true;
        }

        // Move the whole box.
        if (hit && hit.part === "body") {
            const b = this._sam3boxNormalize(this._sam3box[hit.type][hit.i]);
            const start = { x: n.x, y: n.y };
            const orig = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
            this._sam3box.drag = hit;
            this._toolDrag(
                (ev) => {
                    const m = this._eventToNorm(ev);
                    if (!m) return;
                    let dx = m.x - start.x, dy = m.y - start.y;
                    dx = Math.max(-orig.x1, Math.min(1 - orig.x2, dx));
                    dy = Math.max(-orig.y1, Math.min(1 - orig.y2, dy));
                    b.x1 = orig.x1 + dx; b.x2 = orig.x2 + dx;
                    b.y1 = orig.y1 + dy; b.y2 = orig.y2 + dy;
                    this._toolRedraw();
                },
                () => { this._sam3box.drag = null; this._sam3boxSave(); this._toolRedraw(); },
            );
            return true;
        }

        // Otherwise: draw a new box from here. Shift = negative.
        const arr = e.shiftKey ? this._sam3box.neg : this._sam3box.pos;
        const box = { x1: clamp01(n.x), y1: clamp01(n.y), x2: clamp01(n.x), y2: clamp01(n.y) };
        arr.push(box);
        this._sam3box.drag = { type: e.shiftKey ? "neg" : "pos", i: arr.length - 1, part: "se" };
        this._toolDrag(
            (ev) => {
                const m = this._eventToNorm(ev);
                if (!m) return;
                box.x2 = clamp01(m.x); box.y2 = clamp01(m.y);
                this._toolRedraw();
            },
            () => {
                this._sam3box.drag = null;
                // Drop boxes too small to be meaningful.
                const tiny = this._screenDist({ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y2 }) < 6;
                if (tiny || box.x1 === box.x2 || box.y1 === box.y2) arr.pop();
                else this._sam3boxNormalize(box);
                this._sam3boxSave(); this._toolRedraw();
            },
        );
        return true;
    },

    _sam3boxRender() {
        const drawBoxes = (arr, color) => {
            for (const b of arr) {
                const p1 = this._normToDraw(Math.min(b.x1, b.x2), Math.min(b.y1, b.y2));
                const p2 = this._normToDraw(Math.max(b.x1, b.x2), Math.max(b.y1, b.y2));
                if (!p1 || !p2) continue;
                this._toolDraw.appendChild(svgEl("rect", {
                    x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y,
                    fill: color, "fill-opacity": 0.1, stroke: color, "stroke-width": 2,
                }));
                for (const c of [[p1.x, p1.y], [p2.x, p1.y], [p1.x, p2.y], [p2.x, p2.y]]) {
                    this._toolDraw.appendChild(svgEl("rect", {
                        x: c[0] - 4, y: c[1] - 4, width: 8, height: 8,
                        fill: "#000", stroke: color, "stroke-width": 1.5,
                    }));
                }
            }
        };
        drawBoxes(this._sam3box.pos, "#28d17c");
        drawBoxes(this._sam3box.neg, "#e5484d");
    },

    _sam3boxHoverContext(e, n) {
        const hit = this._sam3boxHitTest(n.x, n.y);
        if (hit && hit.part !== "body") {
            const cur = (hit.part === "nw" || hit.part === "se") ? "nwse-resize" : "nesw-resize";
            return { status: "<b>Drag</b> resize · <b>Right-click</b> delete", cursor: cur };
        }
        if (hit && hit.part === "body") {
            return { status: "<b>Drag</b> move · <b>Right-click</b> delete", cursor: "move" };
        }
        return {
            status: e.shiftKey ? "<b>Drag</b> out a negative box"
                               : "<b>Drag</b> out a positive box · <b>Shift</b> negative",
            cursor: "crosshair",
        };
    },

    _sam3boxBuildPanel() {
        const p = this._toolPanel;
        p.innerHTML = "";
        p.appendChild(elWith("h4", { textContent: "SAM3 Boxes" }));

        if (!this._toolState.node) {
            this._toolMissingNodeBody(p, "sam3box");
            return;
        }

        const boundB = this._toolBoundNodeRow();
        if (boundB) p.appendChild(boundB);

        this._sam3boxCountEl = elWith("div", { className: "bepic-tool-hint" });
        p.appendChild(this._sam3boxCountEl);

        const clearBtn = elWith("button", { className: "bepic-act bepic-danger", textContent: "Clear boxes" });
        clearBtn.onclick = () => {
            this._sam3box.pos = []; this._sam3box.neg = [];
            this._sam3boxSave(); this._toolRedraw();
        };
        p.appendChild(clearBtn);

        p.appendChild(elWith("div", {
            className: "bepic-tool-hint",
            innerHTML: "Drag out a box: <b style='color:#28d17c'>positive</b><br>Shift+drag: <b style='color:#e5484d'>negative</b><br>Corner: resize · body: move<br>R-click / Ctrl+click a box: delete. Middle-drag pans.",
        }));
        this._sam3boxUpdateCount();
    },

    _sam3boxUpdateCount() {
        if (this._sam3boxCountEl) {
            this._sam3boxCountEl.textContent =
                `${this._sam3box.pos.length} positive · ${this._sam3box.neg.length} negative`;
        }
    },
};

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
