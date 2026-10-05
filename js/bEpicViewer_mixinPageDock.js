// bEpicViewer_mixinPageDock.js    The viewer as a panel of the ComfyUI page
//
// Floating, the viewer sits over the canvas and covers whatever is under it.
// Docked to the page, it is a panel of its own beside the canvas: the canvas —
// and ComfyUI's sidebar, bottom panel and menus with it — get the rest of the
// window, so nothing is covered and every ComfyUI side panel still opens.
//
// (Not the same thing as bEpicViewer_mixinDock.js, which arranges the viewer's
// own inner panels, nor as "undock", which moves the viewer to another window.
// Everything here is named pageDock to keep the three apart.)
//
// How: ComfyUI's page is a grid — top, left, the canvas area, right, bottom —
// and the three outer cells are empty elements (#comfyui-body-left/-right/
// -bottom). A placeholder of the docked size goes into one of them, which is
// what makes the canvas area yield. The viewer itself is NOT moved into it: it
// stays where it is in the document, still position:fixed, and is kept exactly
// over the placeholder. Re-parenting it would pause a playing video (a media
// element is paused when it leaves the document) and re-run connectedCallback.
//
// Those cells are ComfyUI's page structure rather than an extension API. If one
// is missing — another frontend, a future redesign — docking is refused and the
// viewer simply stays floating.
import { PREF, pref, setPref } from "./bEpicViewer_settings.js";

const CELLS = { right: "comfyui-body-right", left: "comfyui-body-left", bottom: "comfyui-body-bottom" };
const SLOT_ID = "bepic-viewer-pagedock-slot";
const MIN_SIZE = 240;
// The resize handle that faces the canvas, per side: the only edge that moves.
const HANDLE = { right: "r-left", left: "r-right", bottom: "r-top" };
const FLOAT_KEYS = ["left", "top", "right", "bottom", "width", "height"];

export const PAGE_DOCK_SIDES = Object.keys(CELLS);

export const PageDockMixin = {

    _initPageDock() {
        this._pageDock = { side: "", float: null, drag: null, lastVisible: null };

        // The viewer is shown and hidden from many places (the toggle, the close
        // button, the popout); watching its own style is what catches them all.
        try {
            this._pageDockStyleWatch = new MutationObserver(() => this._pageDockVisibilityChanged());
            this._pageDockStyleWatch.observe(this, { attributes: true, attributeFilter: ["style"] });
        } catch (e) { /* no observer: the sync on resize still runs */ }

        // The cell moves and resizes with the page: the window, the top menu
        // wrapping onto a second row, ComfyUI's own panels.
        const sync = () => this._pageDockSync();
        window.addEventListener("resize", sync);
        try {
            this._pageDockSizeWatch = new ResizeObserver(sync);
            this._pageDockSizeWatch.observe(document.body);
            const area = document.getElementById("graph-canvas-container");
            if (area) this._pageDockSizeWatch.observe(area);
        } catch (e) { /* resize events will do */ }

        // Docked, one edge resizes — and it resizes the cell, not the viewer.
        // Captured ahead of the floating resizers' own handler.
        this.shadowRoot.addEventListener("mousedown", (e) => this._pageDockGrab(e), true);
        window.addEventListener("mousemove", (e) => this._pageDockDrag(e));
        window.addEventListener("mouseup", () => this._pageDockDrop());

        const saved = String(pref(PREF.dockSide) || "");
        if (PAGE_DOCK_SIDES.includes(saved)) this.setPageDock(saved, { save: false });
        this._pageDockSyncButton();
    },

    /** "" while floating, else the side the viewer is docked to. */
    pageDockSide() {
        return (this._pageDock && this._pageDock.side) || "";
    },

    /** Dock to the last side used (right, the first time), or float again. */
    togglePageDock() {
        if (this.pageDockSide()) return this.setPageDock("");
        const last = String(pref(PREF.dockLastSide) || "right");
        return this.setPageDock(PAGE_DOCK_SIDES.includes(last) ? last : "right");
    },

    /** Dock to `side` ("right" | "left" | "bottom"), or float with "". */
    setPageDock(side, { save = true } = {}) {
        const st = this._pageDock;
        if (!st) return false;
        side = PAGE_DOCK_SIDES.includes(side) ? side : "";
        if (side && !document.getElementById(CELLS[side])) {
            console.warn(`[bEpicViewer] this ComfyUI page has no #${CELLS[side]} to dock into; staying floating.`);
            side = "";
        }
        if (side === st.side) return true;

        if (side && !st.side) {
            // Where it floated, to go back to.
            st.float = Object.fromEntries(FLOAT_KEYS.map((k) => [k, this.style[k]]));
        }
        st.side = side;
        this.classList.toggle("page-docked", !!side);
        if (side) this.dataset.pageDock = side; else delete this.dataset.pageDock;

        if (!side) {
            this._pageDockRemoveSlot();
            this._pageDockStack(null);
            if (st.float) for (const k of FLOAT_KEYS) this.style[k] = st.float[k] || "";
            st.float = null;
        }
        this._pageDockSync();
        this._pageDockSyncButton();
        if (save) {
            setPref(PREF.dockSide, side);
            if (side) setPref(PREF.dockLastSide, side);
        }
        this._pageDockLaidOut();
        return true;
    },

    // ── The placeholder in ComfyUI's grid ────────────────────────────────────

    _pageDockSize(side) {
        const horizontal = side !== "bottom";
        const want = Number(pref(horizontal ? PREF.dockWidth : PREF.dockHeight)) || (horizontal ? 520 : 360);
        const room = horizontal ? window.innerWidth : window.innerHeight;
        return Math.round(Math.max(MIN_SIZE, Math.min(want, room * 0.8)));
    },

    _pageDockSlot(side, size) {
        const cell = document.getElementById(CELLS[side]);
        if (!cell) return null;
        let slot = document.getElementById(SLOT_ID);
        if (!slot) {
            slot = document.createElement("div");
            slot.id = SLOT_ID;
        }
        if (slot.parentElement !== cell) cell.appendChild(slot);
        const horizontal = side !== "bottom";
        const px = `${size == null ? this._pageDockSize(side) : size}px`;
        Object.assign(slot.style, {
            flex: "none", boxSizing: "border-box", pointerEvents: "none",
            width: horizontal ? px : "100%", height: horizontal ? "100%" : px,
        });
        return slot;
    },

    _pageDockRemoveSlot() {
        const slot = document.getElementById(SLOT_ID);
        if (slot) slot.remove();
    },

    _pageDockVisible() {
        if (this.popoutWindow && !this.popoutWindow.closed) return false;
        if (document.body.classList.contains("bepic-viewer-only")) return false;
        return this.style.display !== "none" && this.style.display !== "";
    },

    _pageDockVisibilityChanged() {
        const st = this._pageDock;
        if (!st || !st.side) return;
        const visible = this._pageDockVisible();
        if (visible === st.lastVisible) return;
        this._pageDockSync();
        this._pageDockLaidOut();
    },

    /** Put the viewer over the placeholder — or give the space back while the
     *  viewer is hidden or in its own window. */
    _pageDockSync() {
        const st = this._pageDock;
        if (!st || !st.side) return;
        const visible = this._pageDockVisible();
        st.lastVisible = visible;
        if (!visible) { this._pageDockRemoveSlot(); return; }
        const slot = this._pageDockSlot(st.side, st.drag ? st.drag.size : null);
        if (!slot) { this.setPageDock("", { save: false }); return; }
        const r = slot.getBoundingClientRect();
        const want = { left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`,
                       width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px`,
                       right: "auto", bottom: "auto" };
        // Only what differs: every write here wakes the style watcher above.
        for (const k of FLOAT_KEYS) if (this.style[k] !== want[k]) this.style[k] = want[k];
        this._pageDockStack(slot.parentElement);
    },

    /** Stay above the cell the viewer is docked over. The cell is a positioned
     *  element with a z-index of its own, and ComfyUI's bottom one (1000) is
     *  higher than the viewer's (500): it lay on top and took every click, so
     *  docked to the bottom nothing in the viewer answered. Read off the cell
     *  rather than known per side, so a frontend that raises another one is
     *  covered too. */
    _pageDockStack(cell) {
        let z = "";
        if (cell) {
            const own = parseInt(getComputedStyle(this).zIndex, 10);
            const base = Number.isFinite(own) && !this.style.zIndex ? own : 500;
            const cellZ = parseInt(getComputedStyle(cell).zIndex, 10);
            if (Number.isFinite(cellZ) && cellZ >= base) z = String(cellZ + 1);
        }
        if (this.style.zIndex !== z) this.style.zIndex = z;
    },

    /** The canvas area changed size: ComfyUI's canvas and the viewer's own
     *  measured layers both need telling. */
    _pageDockLaidOut() {
        try { window.dispatchEvent(new Event("resize")); } catch (e) { /* old engines */ }
        this._afterViewportMoved && this._afterViewportMoved();
    },

    // ── Resizing the docked panel ────────────────────────────────────────────

    _pageDockGrab(e) {
        const side = this.pageDockSide();
        if (!side) return;
        const handle = e.target && e.target.closest && e.target.closest(".resizer");
        if (!handle) return;
        // A docked panel has one edge; the others are hidden, and none of them
        // may start the floating resize.
        e.stopPropagation();
        e.preventDefault();
        if (!handle.classList.contains(HANDLE[side])) return;
        this._pageDock.drag = { size: this._pageDockSize(side) };
    },

    _pageDockDrag(e) {
        const st = this._pageDock;
        if (!st || !st.drag || !st.side) return;
        const slot = document.getElementById(SLOT_ID);
        if (!slot) return;
        const r = slot.getBoundingClientRect();
        const horizontal = st.side !== "bottom";
        const raw = st.side === "right" ? r.right - e.clientX
                  : st.side === "left"  ? e.clientX - r.left
                  :                       r.bottom - e.clientY;
        const room = horizontal ? window.innerWidth : window.innerHeight;
        st.drag.size = Math.round(Math.max(MIN_SIZE, Math.min(raw, room * 0.8)));
        this._pageDockSync();
    },

    _pageDockDrop() {
        const st = this._pageDock;
        if (!st || !st.drag) return;
        const size = st.drag.size;
        const horizontal = st.side !== "bottom";
        setPref(horizontal ? PREF.dockWidth : PREF.dockHeight, size);
        st.drag = null;
        this._pageDockSync();
        this._pageDockLaidOut();
    },

    // ── The header button ────────────────────────────────────────────────────

    _pageDockSyncButton() {
        const btn = this.pageDockBtn;
        if (!btn) return;
        const side = this.pageDockSide();
        btn.classList.toggle("active", !!side);
        btn.title = side ? "Float the viewer over the canvas again"
                         : "Dock the viewer as a panel beside the canvas";
    },
};
