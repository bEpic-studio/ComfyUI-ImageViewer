// bEpicViewer_mixinBrowser.js
// The file browser panel: a directory listing, a preview pane, and a drag
// source.
//
// It replaces the old "Open all images in folder" button, which shelled out to
// a tkinter dialog on the SERVER — so the dialog opened on whatever machine
// ComfyUI runs on (invisible over a remote session), it blocked the event loop
// while it was up, and it could only ever hand back a whole folder of stills.
// Listing directories over the API instead costs one request per folder, works
// the same locally and remotely, and lets a single file be picked out.
//
// Where it opens: ComfyUI's input directory, which the server reports rather
// than the client guessing at it.
//
// Dragging a row carries the same `application/x-bepic-history` payload a
// history thumbnail does, so both ends already built for that work unchanged:
//   • onto the ComfyUI graph → a path-based loader node (see mixinDnD part 2)
//   • onto the viewport      → the file opens in a new viewer tab
import { api } from "../../scripts/api.js";

// Containers a <video> will actually play. The rest are listed and can be
// dragged and opened like anything else — only the in-panel preview falls back
// to a poster frame for them, because nothing in the browser can decode them.
const _PLAYABLE_VIDEO = /\.(mp4|m4v|mov|webm|ogv)$/i;

const _KIND_GLYPH = { dir: "📁", image: "🖼", video: "🎬" };

// Preview pane height, in px, and the range the splitter allows.
const _PREVIEW_DEFAULT = 190;
const _PREVIEW_MIN     = 90;
const _PREVIEW_MAX     = 640;

export const BrowserMixin = {

    // ── Bootstrap ────────────────────────────────────────────────────────────

    _initFileBrowser() {
        const sr = this.shadowRoot;

        this.browserPanel   = sr.getElementById("browser-panel");
        if (!this.browserPanel) return;

        this.browserList    = sr.getElementById("browser-list");
        this.browserPathIn  = sr.getElementById("browser-path");
        this.browserRootSel = sr.getElementById("browser-root-sel");
        this.browserPreview = sr.getElementById("browser-preview-stage");
        this.browserPrevImg = sr.getElementById("browser-preview-img");
        this.browserPrevVid = sr.getElementById("browser-preview-vid");
        this.browserPrevMsg = sr.getElementById("browser-preview-msg");
        this.browserMeta    = sr.getElementById("browser-preview-meta");
        this.browserOpenBtn = sr.getElementById("browser-open-btn");

        this.browserPanel.style.display = "none";
        this._browserDirs   = [];
        this._browserFiles  = [];
        this._browserSel    = new Set();   // indices into _browserFiles
        this._browserAnchor = null;        // for shift-range selection
        this._browserLoaded = false;
        this._browserDir    = this._browserDir || this._savedBrowserDir();
        // No side of its own yet → start where it used to live, beside the
        // params panel, so an existing setup opens looking the same as before.
        if (!this.browserSide) this.browserSide = this._savedBrowserSide() || this.paramsSide || "right";

        this._dockBrowserPanel();
        this._bindBrowserControls();
        this._setupBrowserResizing();
        this._setBrowserPreviewHeight(this._browserPreviewH || _PREVIEW_DEFAULT);
        this._renderBrowserPreview(null);
    },

    /** Flip the panel to the other side of the viewport. */
    toggleBrowserSide() {
        this.browserSide = (this.browserSide === "left") ? "right" : "left";
        this._dockBrowserPanel();
        this.queuePersistViewerState && this.queuePersistViewerState();
        // Both the picture and the compare layers are measured against the
        // viewport, which just changed width.
        if (this._afterViewportMoved) this._afterViewportMoved();
    },

    /**
     * Put the panel on its own side of the viewport.
     *
     * When it shares a side with the params panel, params keeps the outer edge
     * and the browser sits inboard of it — so the two never swap places as you
     * drag their widths. Called again whenever either side changes.
     */
    _dockBrowserPanel() {
        const panel = this.browserPanel;
        const parent = this.viewport && this.viewport.parentNode;
        if (!panel || !parent) return;
        const side = this.browserSide || this.paramsSide || "right";
        try {
            panel.classList.toggle("left", side === "left");
            panel.classList.toggle("right", side !== "left");
            const sharesWithParams = !!(this.paramsPanel &&
                this.paramsPanel.parentNode === parent &&
                (this.paramsSide || "right") === side);
            if (side === "left") {
                if (sharesWithParams) parent.insertBefore(panel, this.paramsPanel.nextSibling);
                else parent.insertBefore(panel, parent.firstChild);
            } else {
                if (sharesWithParams) parent.insertBefore(panel, this.paramsPanel);
                else parent.appendChild(panel);
            }
        } catch (e) { /* keep the panel wherever it already is */ }
        this._syncBrowserHistoryOffset();
        this._syncBrowserDockIcon();
    },

    /** Keep the browser clear of the history strip when they share a side.
     *
     * The strip is an absolute overlay pinned to one edge of the main area, so
     * whatever flex child sits at that edge is drawn underneath it. That child
     * is normally the viewport, which loses nothing but black — but the browser
     * becomes it the moment the two end up on the same side, and a list of
     * filenames hidden behind a column of thumbnails is no good to anyone.
     *
     * The strip always docks opposite the params panel, so this can only happen
     * when the browser has been moved off the params side.
     */
    _syncBrowserHistoryOffset() {
        const panel = this.browserPanel;
        if (!panel) return;
        const hp = this.historyPanel;
        const side = this.browserSide || this.paramsSide || "right";
        const open = !!(hp && hp.style.display !== "none" && hp.style.display !== "");
        const hSide = (hp && hp.classList.contains("right")) ? "right" : "left";
        const clash = open && hSide === side;
        let w = 0;
        if (clash) {
            try { w = Math.round(hp.getBoundingClientRect().width); } catch (e) { w = 0; }
        }
        panel.style.marginLeft  = (clash && side === "left")  ? `${w}px` : "";
        panel.style.marginRight = (clash && side === "right") ? `${w}px` : "";
    },

    /** The dock button shows which side the panel is on, as the params one does. */
    _syncBrowserDockIcon() {
        const btn = this.browserDockBtn;
        if (!btn || !this._setIcon) return;
        const side = this.browserSide || "right";
        this._setIcon(btn, side === "left" ? "icon-dock-left" : "icon-dock-right");
        btn.classList.toggle("left", side === "left");
    },

    /** The side this viewer was last left on, or null when it has no opinion. */
    _savedBrowserSide() {
        try {
            const raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            const side = parsed && parsed.browserSide;
            return (side === "left" || side === "right") ? side : null;
        } catch (e) { return null; }
    },

    /** The folder this viewer was last left in, or null for the server default. */
    _savedBrowserDir() {
        try {
            const raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            const dir = parsed && parsed.browserDir;
            return (typeof dir === "string" && dir) ? dir : null;
        } catch (e) { return null; }
    },

    _bindBrowserControls() {
        const sr = this.shadowRoot;

        const upBtn = sr.getElementById("browser-up-btn");
        if (upBtn) upBtn.onclick = () => { if (this._browserParent) this.browseTo(this._browserParent); };

        const refreshBtn = sr.getElementById("browser-refresh-btn");
        if (refreshBtn) refreshBtn.onclick = () => this.browseTo(this._browserDir, { force: true });

        if (this.browserRootSel) {
            this.browserRootSel.onchange = () => {
                const v = this.browserRootSel.value;
                this.browserRootSel.selectedIndex = 0;   // it is a jump menu, not a state
                if (v) this.browseTo(v);
            };
        }

        if (this.browserPathIn) {
            // Typing a path is the fastest way to a folder nothing links to; the
            // viewer's global hotkey handler already stands aside for <input>.
            this.browserPathIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); this.browseTo(this.browserPathIn.value.trim()); }
                else if (e.key === "Escape") { this.browserPathIn.blur(); this._showBrowserPath(this._browserDir); }
            });
        }

        if (this.browserOpenBtn) this.browserOpenBtn.onclick = () => this.openBrowserSelection();

        if (this.browserList) {
            this.browserList.addEventListener("keydown", (e) => this._onBrowserListKey(e));
            // A click on empty space below the rows clears the selection, the
            // same gesture the history strip uses.
            this.browserList.addEventListener("mousedown", (e) => {
                if (e.target === this.browserList) this._setBrowserSelection([]);
            });
        }

        this.browserDockBtn = sr.getElementById("browser-dock-btn");
        if (this.browserDockBtn) this.browserDockBtn.onclick = () => this.toggleBrowserSide();
        this._syncBrowserDockIcon();

        this.browserToggleBtn = sr.getElementById("browser-toggle-btn");
        if (this.browserToggleBtn) this.browserToggleBtn.onclick = () => this.toggleFileBrowser();

        this._syncBrowserToggleState();
    },

    // ── Show / hide ──────────────────────────────────────────────────────────

    toggleFileBrowser(force) {
        const panel = this.browserPanel;
        if (!panel) return;
        const visible = panel.style.display !== "none" && panel.style.display !== "";
        const next    = (force === undefined) ? !visible : !!force;
        panel.style.display = next ? "flex" : "none";
        // Nothing is listed until the panel is first opened, so that open has to
        // fetch — from the folder the last session left it in, when there was one.
        if (next && !this._browserLoaded) this.browseTo(this._browserDir, { force: true });
        else if (next) this._renderBrowserList();
        if (!next) this._stopBrowserPreview();
        this._syncBrowserHistoryOffset();
        this._syncBrowserToggleState();
        if (this._afterViewportMoved) this._afterViewportMoved();
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    _syncBrowserToggleState() {
        if (!this.browserToggleBtn) return;
        const panel = this.browserPanel;
        const visible = !!(panel && panel.style.display !== "none" && panel.style.display !== "");
        this.browserToggleBtn.classList.toggle("active", visible);
    },

    isFileBrowserOpen() {
        const p = this.browserPanel;
        return !!(p && p.style.display !== "none" && p.style.display !== "");
    },

    // ── Listing ──────────────────────────────────────────────────────────────

    /** Read `dir` (null → the server's default, ComfyUI's input folder) and draw it. */
    async browseTo(dir, { force = false } = {}) {
        if (!this.browserList) return;
        if (!force && dir && dir === this._browserDir) return;

        const token = (this._browseToken = (this._browseToken || 0) + 1);
        this._setBrowserStatus("Reading…");

        let data = null;
        try {
            const q = dir ? `?path=${encodeURIComponent(dir)}` : "";
            const res = await api.fetchApi(`/bepic/browse${q}`);
            data = await res.json();
        } catch (e) {
            if (token !== this._browseToken) return;
            this._setBrowserStatus(`Could not reach the server.\n${e.message || e}`);
            return;
        }
        if (token !== this._browseToken) return;   // a later navigation won

        // A folder that could not be read must NOT become the current one: the
        // path bar would show somewhere that does not exist, there would be no
        // parent to climb back out through, and the empty listing would read as
        // "this folder has no media in it" rather than "this is not a folder".
        // The roots still come back on a failure, so the jump menu can rescue it.
        if (!data || !data.path || data.error) {
            this._fillBrowserRoots(data && data.roots);
            const why = (data && data.error) || "Nothing came back.";
            this._setBrowserStatus([dir, why].filter(Boolean).join("\n"));
            return;
        }

        this._browserDir    = data.path;
        this._browserLoaded = true;
        this._browserParent = data.parent || null;
        this._browserDirs   = Array.isArray(data.dirs) ? data.dirs : [];
        this._browserFiles  = Array.isArray(data.files) ? data.files : [];
        this._browserTrunc  = !!data.truncated;
        this._browserSel    = new Set();
        this._browserAnchor = null;

        this._showBrowserPath(data.path);
        this._fillBrowserRoots(data.roots);
        this._renderBrowserList();
        this._renderBrowserPreview(null);
        this.queuePersistViewerState && this.queuePersistViewerState();
    },

    /** Put `dir` in the path field, scrolled to show the END of it.
     *
     * An <input> parks at the start of its text, which on a real project path
     * is a long prefix of drive and share names — the folder you are actually
     * in is the part that falls off the right edge.
     */
    _showBrowserPath(dir) {
        const el = this.browserPathIn;
        if (!el) return;
        el.value = dir || "";
        el.title = dir || "";
        if (el === el.ownerDocument.activeElement) return;   // don't fight the caret
        try { el.scrollLeft = el.scrollWidth; } catch (e) {}
    },

    _fillBrowserRoots(roots) {
        if (!this.browserRootSel || !Array.isArray(roots)) return;
        const sig = roots.map(r => r.path).join("|");
        if (sig === this._browserRootSig) return;   // the roots never move
        this._browserRootSig = sig;

        const frag = document.createDocumentFragment();
        const head = document.createElement("option");
        head.value = ""; head.textContent = "Go to…"; head.selected = true;
        frag.appendChild(head);
        roots.forEach((r) => {
            const o = document.createElement("option");
            o.value = r.path;
            o.textContent = r.label;
            o.title = r.path;
            frag.appendChild(o);
        });
        this.browserRootSel.innerHTML = "";
        this.browserRootSel.appendChild(frag);
    },

    _setBrowserStatus(text, { keepList = false } = {}) {
        if (!this.browserList) return;
        if (!keepList) this.browserList.innerHTML = "";
        const el = document.createElement("div");
        el.className = "browser-status";
        el.textContent = text;
        this.browserList.appendChild(el);
    },

    _renderBrowserList() {
        if (!this.browserList) return;
        const frag = document.createDocumentFragment();

        if (this._browserParent) {
            frag.appendChild(this._makeBrowserRow({
                glyph: _KIND_GLYPH.dir, name: "..", cls: "is-dir is-up",
                title: this._browserParent,
                onOpen: () => this.browseTo(this._browserParent),
            }));
        }

        this._browserDirs.forEach((d) => {
            frag.appendChild(this._makeBrowserRow({
                glyph: _KIND_GLYPH.dir, name: d.name, cls: "is-dir",
                title: d.path,
                onOpen: () => this.browseTo(d.path),
            }));
        });

        this._browserFiles.forEach((f, idx) => {
            const row = this._makeBrowserRow({
                glyph: _KIND_GLYPH[f.kind] || _KIND_GLYPH.image,
                name: f.name,
                cls: `is-file is-${f.kind}`,
                meta: this._formatBytes(f.size),
                title: `${f.path}\nClick to preview · double-click to open in the viewer\nDrag onto the graph for a loader node, or onto the viewer to open it\nCtrl+click to add to the selection, Shift+click for a range`,
                onOpen: () => this.openBrowserSelection([f]),
                onSelect: (e) => this._clickBrowserFile(idx, e),
            });
            row.dataset.idx = String(idx);
            if (this._browserSel.has(idx)) row.classList.add("selected");
            this._makeBrowserRowDraggable(row, idx);
            frag.appendChild(row);
        });

        this.browserList.innerHTML = "";
        this.browserList.appendChild(frag);

        if (this._browserDirs.length === 0 && this._browserFiles.length === 0) {
            this._setBrowserStatus("No images or videos in this folder.", { keepList: true });
        } else if (this._browserTrunc) {
            this._setBrowserStatus(`Showing the first ${this._browserFiles.length} files — this folder holds more.`,
                                   { keepList: true });
        }
        this._syncBrowserOpenButton();
    },

    _makeBrowserRow({ glyph, name, cls, meta, title, onOpen, onSelect }) {
        const row = document.createElement("div");
        row.className = `browser-row ${cls || ""}`.trim();
        if (title) row.title = title;

        const g = document.createElement("span");
        g.className = "b-glyph";
        g.textContent = glyph;
        row.appendChild(g);

        const n = document.createElement("span");
        n.className = "b-name";
        n.textContent = name;
        row.appendChild(n);

        if (meta) {
            const m = document.createElement("span");
            m.className = "b-meta";
            m.textContent = meta;
            row.appendChild(m);
        }

        // Don't preventDefault on mousedown — that kills the native drag start.
        row.addEventListener("mousedown", (e) => e.stopPropagation());
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (onSelect) onSelect(e);
        });
        row.addEventListener("dblclick", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (onOpen) onOpen();
        });
        return row;
    },

    // ── Selection ────────────────────────────────────────────────────────────

    _clickBrowserFile(idx, e) {
        if (e && (e.ctrlKey || e.metaKey)) {
            const sel = new Set(this._browserSel);
            if (sel.has(idx)) sel.delete(idx); else sel.add(idx);
            this._browserAnchor = idx;
            this._setBrowserSelection([...sel], { preview: idx });
            return;
        }
        if (e && e.shiftKey && this._browserAnchor != null) {
            const lo = Math.min(this._browserAnchor, idx);
            const hi = Math.max(this._browserAnchor, idx);
            const range = [];
            for (let i = lo; i <= hi; i++) range.push(i);
            this._setBrowserSelection(range, { preview: idx });
            return;
        }
        this._browserAnchor = idx;
        this._setBrowserSelection([idx], { preview: idx });
    },

    _setBrowserSelection(indices, { preview } = {}) {
        this._browserSel = new Set(indices.filter(i => this._browserFiles[i]));
        if (!this.browserList) return;
        this.browserList.querySelectorAll(".browser-row.is-file").forEach((row) => {
            row.classList.toggle("selected", this._browserSel.has(Number(row.dataset.idx)));
        });
        const pv = (preview != null) ? preview
                 : (this._browserSel.size === 1 ? [...this._browserSel][0] : null);
        this._renderBrowserPreview(pv != null ? this._browserFiles[pv] : null);
        this._syncBrowserOpenButton();
    },

    _selectedBrowserFiles() {
        return [...this._browserSel].sort((a, b) => a - b)
            .map(i => this._browserFiles[i]).filter(Boolean);
    },

    _syncBrowserOpenButton() {
        if (!this.browserOpenBtn) return;
        const n = this._browserSel.size;
        const total = this._browserFiles.length;
        this.browserOpenBtn.disabled = total === 0;
        this.browserOpenBtn.textContent = n > 0
            ? `Open ${n} in Viewer`
            : (total > 0 ? `Open all ${total} in Viewer` : "Nothing to open");
    },

    _onBrowserListKey(e) {
        const rows = this._browserFiles;
        if (e.key === "Backspace") {
            e.preventDefault(); e.stopPropagation();
            if (this._browserParent) this.browseTo(this._browserParent);
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault(); e.stopPropagation();
            this.openBrowserSelection();
            return;
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        if (rows.length === 0) return;
        e.preventDefault(); e.stopPropagation();

        const cur = this._browserAnchor != null ? this._browserAnchor
                  : (e.key === "ArrowDown" ? -1 : rows.length);
        const next = Math.max(0, Math.min(rows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        this._browserAnchor = next;
        this._setBrowserSelection([next], { preview: next });
        const row = this.browserList.querySelector(`.browser-row.is-file[data-idx="${next}"]`);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    },

    // ── Preview ──────────────────────────────────────────────────────────────

    _stopBrowserPreview() {
        const v = this.browserPrevVid;
        if (!v) return;
        try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {}
        v.style.display = "none";
    },

    _renderBrowserPreview(file) {
        if (!this.browserPreview) return;
        const img = this.browserPrevImg, vid = this.browserPrevVid, msg = this.browserPrevMsg;

        this._stopBrowserPreview();
        if (img) { img.style.display = "none"; img.removeAttribute("src"); }
        if (msg) msg.style.display = "none";
        this._browserPreviewPath = file ? file.path : null;

        if (!file) {
            if (msg) { msg.textContent = "Select a file to preview it"; msg.style.display = "block"; }
            if (this.browserMeta) this.browserMeta.textContent = "";
            return;
        }

        this._setBrowserMeta(file, "");
        const url = this.buildImgUrl({ path: file.path, external: true });

        if (file.kind === "video") {
            if (_PLAYABLE_VIDEO.test(file.name) && vid) {
                // metadata only, for the same reason the main player uses it: the
                // browser will otherwise pull the whole clip into memory that no
                // page can hand back. See _setVideoSrc.
                vid.preload = "metadata";
                vid.src = url;
                vid.style.display = "block";
                vid.onloadedmetadata = () => {
                    if (this._browserPreviewPath !== file.path) return;
                    this._setBrowserMeta(file, `${vid.videoWidth}×${vid.videoHeight} · ${this._formatDuration(vid.duration)}`);
                };
                vid.onerror = () => {
                    if (this._browserPreviewPath !== file.path) return;
                    this._showBrowserPoster(file, "This clip's codec isn't one the browser can decode.");
                };
            } else {
                this._showBrowserPoster(file, `${file.ext || "This format"} doesn't play in a browser.`);
            }
            return;
        }

        if (!img) return;
        img.decoding = "async";
        img.onload = () => {
            if (this._browserPreviewPath !== file.path) return;
            img.style.display = "block";
            this._setBrowserMeta(file, `${img.naturalWidth}×${img.naturalHeight}`);
        };
        img.onerror = () => {
            if (this._browserPreviewPath !== file.path) return;
            img.style.display = "none";
            if (msg) { msg.textContent = "This image could not be read."; msg.style.display = "block"; }
        };
        img.src = url;
    },

    /** Fall back to a server-extracted poster frame for a clip nothing can play. */
    async _showBrowserPoster(file, why) {
        const msg = this.browserPrevMsg;
        this._stopBrowserPreview();
        if (msg) { msg.textContent = `${why}\nFetching a poster frame…`; msg.style.display = "block"; }

        const frames = await this._browserFramesFor([file.path]);
        if (this._browserPreviewPath !== file.path) return;   // selection moved on
        const frame = frames[0];
        const img   = this.browserPrevImg;

        if (frame && frame.thumb && img) {
            img.onload = () => {
                if (this._browserPreviewPath !== file.path) return;
                img.style.display = "block";
                if (msg) msg.style.display = "none";
            };
            img.onerror = () => {
                if (this._browserPreviewPath !== file.path) return;
                if (msg) { msg.textContent = `${why}\nNo poster frame either — it still opens and drags.`; msg.style.display = "block"; }
            };
            img.src = this.thumbUrl(frame);
        } else if (msg) {
            msg.textContent = `${why}\nIt still opens and drags like any other file.`;
        }
        if (frame) {
            const bits = [];
            if (frame.frames) bits.push(`${frame.frames} frames`);
            if (frame.fps)    bits.push(`${Math.round(frame.fps * 100) / 100} fps`);
            this._setBrowserMeta(file, bits.join(" · "));
        }
    },

    _setBrowserMeta(file, extra) {
        if (!this.browserMeta) return;
        const bits = [file.name];
        if (extra) bits.push(extra);
        if (file.size) bits.push(this._formatBytes(file.size));
        this.browserMeta.textContent = bits.join("  ·  ");
        this.browserMeta.title = file.path;
    },

    _formatBytes(n) {
        if (!n || n < 0) return "";
        const u = ["B", "KB", "MB", "GB", "TB"];
        let i = 0, v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
        return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
    },

    _formatDuration(sec) {
        if (!Number.isFinite(sec) || sec <= 0) return "";
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    },

    // ── Drag out ─────────────────────────────────────────────────────────────

    /** One browsed file as the payload both drop targets already understand. */
    _browserDragItem(file) {
        if (!file || !file.path) return null;
        return {
            path: file.path, url: null,
            filename: file.name, subfolder: "", type: null,
            external: true, dropped: false,
            kind: file.kind === "video" ? "video" : "image",
            thumb: null, isSequence: false, seqDir: null, seqCount: 0,
        };
    },

    _makeBrowserRowDraggable(row, idx) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => {
            // Dragging a row inside the selection takes the whole selection;
            // dragging any other row takes just that one and leaves the
            // selection alone — the rule the history strip uses.
            const picked = this._browserSel.has(idx)
                ? this._selectedBrowserFiles()
                : [this._browserFiles[idx]];
            const items = picked.map(f => this._browserDragItem(f)).filter(Boolean);
            if (items.length === 0) { e.preventDefault(); return; }
            try {
                e.dataTransfer.setData("application/x-bepic-history", JSON.stringify({ items }));
                e.dataTransfer.effectAllowed = "copy";
            } catch (_) {}
        });
    },

    // ── Opening into the viewer ──────────────────────────────────────────────

    /** Frames for `paths`, from the server, so videos arrive with fps and a poster. */
    async _browserFramesFor(paths) {
        if (!paths || paths.length === 0) return [];
        let data = null;
        try {
            const res = await api.fetchApi("/bepic/browse_frames", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths }),
            });
            data = await res.json();
        } catch (e) {
            console.warn("[bEpicViewer] browse_frames failed", e);
            return [];
        }
        const frames = (data && Array.isArray(data.frames)) ? data.frames : [];
        // Line the answers back up with what was asked for: the server drops
        // anything it couldn't read, so position alone can't be trusted.
        const norm  = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
        const byPath = new Map(frames.map(f => [norm(f.path), f]));
        return paths.map(p => byPath.get(norm(p)) || null);
    },

    /** Open the current selection — or the whole folder when nothing is picked. */
    async openBrowserSelection(files) {
        const picked = files || this._selectedBrowserFiles();
        const list   = picked.length > 0 ? picked : this._browserFiles;
        if (list.length === 0) return;

        const label = this._browserDir
            ? (this._browserDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || this._browserDir)
            : "files";

        if (this.browserOpenBtn) this.browserOpenBtn.disabled = true;
        try {
            const frames = (await this._browserFramesFor(list.map(f => f.path))).filter(Boolean);
            if (frames.length === 0) {
                this._setBrowserStatus("None of those files could be read.", { keepList: true });
                return;
            }
            this.openExternalFramesInViewer(frames, list.length === 1 ? list[0].name : label);
        } finally {
            this._syncBrowserOpenButton();
        }
    },

    /**
     * Put ready-made frames on screen as viewer tabs.
     *
     * Images go into ONE tab as a sequence, so the timeline scrubs the folder —
     * which is what a viewer is for, and what the old folder tab only pretended
     * to do (it put the first image in the tab and every other one in its own
     * history entry, leaving a one-frame timeline). Each video gets a tab of its
     * own, because a video tab holds exactly one clip.
     *
     * Shared with the viewport drop target, so a file dropped in from the
     * browser lands the same way as one opened through the button.
     */
    openExternalFramesInViewer(frames, label) {
        if (!Array.isArray(frames) || frames.length === 0) return null;

        const images = frames.filter(f => f && !this._frameIsVideo(f));
        const videos = frames.filter(f => f &&  this._frameIsVideo(f));
        let firstKey = null;
        let seq = 0;

        if (images.length > 0) {
            const key = `folder_${Date.now()}_${++seq}`;
            this.allTabs[key]   = images;
            this.history[key]   = [images];
            this.tabLabels[key] = `📂 ${images.length > 1 ? `${label} (${images.length})` : (images[0].name || label)}`;
            firstKey = key;
        }
        for (const v of videos) {
            const key = `folder_${Date.now()}_${++seq}`;
            this.allTabs[key]   = [v];
            this.history[key]   = [[v]];
            this.tabLabels[key] = `📂 ${v.name || label}`;
            firstKey = firstKey || key;
        }

        const allKeys = Object.keys(this.allTabs);
        const known   = (this.tabOrder || []).filter(k => allKeys.includes(k));
        const added   = allKeys.filter(k => !known.includes(k));
        this.tabOrder = [...known, ...added];

        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        this._rebuildTabBar(null);
        if (firstKey) this.switchTab(firstKey);

        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
        return firstKey;
    },

    // ── Panel sizing ─────────────────────────────────────────────────────────

    _setBrowserPreviewHeight(px) {
        const h = Math.round(Math.max(_PREVIEW_MIN, Math.min(_PREVIEW_MAX, px)));
        this._browserPreviewH = h;
        if (this.browserPreview) this.browserPreview.style.height = `${h}px`;
    },

    _setupBrowserResizing() {
        const sr = this.shadowRoot;
        const win = () => (this.container && this.container.ownerDocument.defaultView) || window;

        // Width: drag the edge that faces the viewport.
        const edge = sr.getElementById("browser-resizer");
        if (edge) edge.onmousedown = (e) => {
            e.preventDefault();
            const w = win();
            const onMove = (ev) => {
                const r = this.browserPanel.getBoundingClientRect();
                const next = this.browserPanel.classList.contains("left")
                    ? ev.clientX - r.left
                    : r.right - ev.clientX;
                this.browserPanel.style.width = `${Math.round(Math.max(180, Math.min(720, next)))}px`;
            };
            const onUp = () => {
                w.removeEventListener("mousemove", onMove);
                w.removeEventListener("mouseup", onUp);
                if (this._afterViewportMoved) this._afterViewportMoved();
            };
            w.addEventListener("mousemove", onMove);
            w.addEventListener("mouseup", onUp);
        };

        // Height: drag the bar between the list and the preview.
        const split = sr.getElementById("browser-split");
        if (split) split.onmousedown = (e) => {
            e.preventDefault();
            const w = win();
            const startY = e.clientY;
            const startH = this._browserPreviewH || _PREVIEW_DEFAULT;
            const onMove = (ev) => this._setBrowserPreviewHeight(startH - (ev.clientY - startY));
            const onUp = () => {
                w.removeEventListener("mousemove", onMove);
                w.removeEventListener("mouseup", onUp);
            };
            w.addEventListener("mousemove", onMove);
            w.addEventListener("mouseup", onUp);
        };
    },
};
