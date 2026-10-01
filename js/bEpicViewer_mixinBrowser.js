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
import { pref, prefKinds, setPref, PREF } from "./bEpicViewer_settings.js";

// Containers a <video> will actually play. The rest are listed and can be
// dragged and opened like anything else — only the in-panel preview falls back
// to a poster frame for them, because nothing in the browser can decode them.
const _PLAYABLE_VIDEO = /\.(mp4|m4v|mov|webm|ogv)$/i;

const _KIND_GLYPH = { dir: "📁", image: "🖼", video: "🎬", model: "🧊", other: "📄" };

/** The kinds this viewer can actually open. Everything else is along to be seen. */
const _OPENABLE = new Set(["image", "video", "model"]);

// A numbered file: everything before the frame number, the number (the last
// run of digits, right before the extension), and the extension.
const _SEQ_NAME = /^(.*?)(\d+)(\.[^.]+)$/;

// The kind menu's extra entry that flips sequence folding rather than
// choosing a kind (see _syncBrowserFoldOption).
const _FOLD_OPTION = "__fold";

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
        this.browserFilterIn = sr.getElementById("browser-filter");
        this.browserKindSel  = sr.getElementById("browser-kind-sel");

        this.browserPanel.style.display = "none";
        this._browserDirs   = [];
        this._browserFiles  = [];
        this._browserEntries = [];         // what the list shows: a file, or a folded sequence
        this._browserSel    = new Set();   // indices into _browserEntries
        this._browserAnchor = null;        // for shift-range selection
        this._browserLoaded = false;
        // A start folder set in Settings → bEpic Viewer wins over the one the
        // last session was left in.
        this._browserDir    = this._browserDir || String(pref(PREF.browserStart) || "").trim()
                              || this._savedBrowserDir();
        // The filter belongs to the browser, not to the folder: looking for
        // *.exr, walking into the next folder and being shown everything again
        // is not what a filter is for.
        const saved = this._savedBrowserFilter();
        this._browserFilter = saved.text;
        // Kinds and folding are settings (Settings → bEpic Viewer) the controls
        // write back to. What this browser kept from before is taken over once,
        // while the setting is still at its default.
        if (saved.kinds && !prefKinds()) setPref(PREF.browserKinds, saved.kinds);
        if (saved.fold && !pref(PREF.browserFold)) setPref(PREF.browserFold, true);
        this._browserKinds  = prefKinds();
        this._browserFold   = !!pref(PREF.browserFold);
        if (this.browserFilterIn) this.browserFilterIn.value = this._browserFilter;
        this._syncBrowserFoldOption();
        if (this.browserKindSel) this.browserKindSel.value = this._browserKinds;

        // Fill the path field straight away rather than leaving it blank until
        // the first listing lands — an empty address bar reads as "broken", and
        // it is the first thing you look at.
        this._showBrowserPath(this._browserDir);

        this._bindBrowserControls();
        this._setupBrowserResizing();
        this._setBrowserPreviewHeight(this._browserPreviewH || _PREVIEW_DEFAULT);
        this._renderBrowserPreview(null);
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

    _savedBrowserFilter() {
        try {
            const raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            const parsed = raw ? JSON.parse(raw) : null;
            const f = (parsed && parsed.browserFilter) || {};
            return {
                text: typeof f.text === "string" ? f.text : "",
                kinds: typeof f.kinds === "string" ? f.kinds : "",
                fold: !!f.foldSequences,
            };
        } catch (e) { return { text: "", kinds: "", fold: false }; }
    },

    /**
     * The fold switch lives in the kind menu, as its last entry. A <select>
     * holds one value, so the entry is a command rather than a choice: picking
     * it flips folding and the menu goes straight back to the kind it showed.
     */
    _syncBrowserFoldOption() {
        const sel = this.browserKindSel;
        if (!sel) return;
        let opt = sel.querySelector(`option[value="${_FOLD_OPTION}"]`);
        if (!opt) {
            const sep = sel.ownerDocument.createElement("option");
            sep.disabled = true;
            sep.textContent = "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500";
            opt = sel.ownerDocument.createElement("option");
            opt.value = _FOLD_OPTION;
            sel.append(sep, opt);
        }
        opt.textContent = `${this._browserFold ? "\u2611" : "\u2610"} Fold image sequences`;
        opt.title = "Show a numbered run of images (shot.1001.exr, shot.1002.exr, \u2026) as one entry";
    },

    toggleBrowserFold(on = !this._browserFold) {
        this._browserFold = !!on;
        setPref(PREF.browserFold, this._browserFold);
        this._syncBrowserFoldOption();
        if (this.queuePersistViewerState) this.queuePersistViewerState();
        this._browserBuildEntries();
        this._browserSel = new Set();
        this._browserAnchor = null;
        this._renderBrowserList();
        this._renderBrowserPreview(null);
    },

    /**
     * What the list shows, from the folder's files: each file on its own, or —
     * with folding on — every numbered run of two or more images of one name
     * and extension as a single entry, where its first frame stood.
     */
    _browserBuildEntries() {
        const files = this._browserFiles || [];
        if (!this._browserFold) { this._browserEntries = files.map((f) => ({ file: f })); return; }
        const groups = new Map();
        files.forEach((f) => {
            const m = f.kind === "image" && _SEQ_NAME.exec(f.name);
            if (!m) return;
            const key = `${m[1]}\u0000${m[3].toLowerCase()}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ f, prefix: m[1], digits: m[2], ext: m[3] });
        });
        const inSeq = new Map();
        for (const members of groups.values()) {
            if (members.length < 2) continue;
            members.sort((a, b) => Number(a.digits) - Number(b.digits));
            const first = Number(members[0].digits), last = Number(members[members.length - 1].digits);
            const pad = Math.min(...members.map((x) => x.digits.length));
            const seq = {
                name: `${members[0].prefix}${"#".repeat(Math.max(1, pad))}${members[0].ext}`,
                files: members.map((x) => x.f),
                first, last,
                gaps: last - first + 1 !== members.length,
                size: members.reduce((n, x) => n + (x.f.size || 0), 0),
            };
            seq.path = members[0].f.path.replace(/[^\\/]*$/, "") + seq.name;
            for (const x of members) inSeq.set(x.f, seq);
        }
        const out = [], placed = new Set();
        for (const f of files) {
            const seq = inSeq.get(f);
            if (!seq) { out.push({ file: f }); continue; }
            if (placed.has(seq)) continue;
            placed.add(seq);
            out.push({ seq });
        }
        this._browserEntries = out;
    },

    /** The files behind one list entry. */
    _browserEntryFiles(entry) {
        return !entry ? [] : entry.seq ? entry.seq.files : [entry.file];
    },

    /** What the two filter controls say, as the query the route takes. */
    browserFilterQuery() {
        const parts = [];
        if (this._browserFilter) parts.push(`filter=${encodeURIComponent(this._browserFilter)}`);
        if (this._browserKinds) parts.push(`kinds=${encodeURIComponent(this._browserKinds)}`);
        return parts;
    },

    /** Re-read the folder through the filter, without racing the typing. */
    _browserFilterChanged({ now = false } = {}) {
        this._browserFilter = this.browserFilterIn ? this.browserFilterIn.value.trim() : "";
        this._browserKinds = this.browserKindSel ? this.browserKindSel.value : "";
        setPref(PREF.browserKinds, this._browserKinds || "all");
        if (this.queuePersistViewerState) this.queuePersistViewerState();
        const win = this._viewerWindow();
        if (this._browserFilterTimer) win.clearTimeout(this._browserFilterTimer);
        const run = () => {
            this._browserFilterTimer = null;
            this.browseTo(this._browserDir, { force: true });
        };
        // Typing "*.exr" is five keystrokes and would be five listings; a short
        // wait turns it into one.
        if (now) run(); else this._browserFilterTimer = win.setTimeout(run, 220);
    },

    _bindBrowserControls() {
        const sr = this.shadowRoot;

        const upBtn = sr.getElementById("browser-up-btn");
        if (upBtn) upBtn.onclick = () => { if (this._browserParent) this.browseTo(this._browserParent); };

        if (this.browserFilterIn) {
            this.browserFilterIn.addEventListener("input", () => this._browserFilterChanged());
            this.browserFilterIn.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); this._browserFilterChanged({ now: true }); }
                else if (e.key === "Escape") {
                    e.preventDefault();
                    this.browserFilterIn.value = "";
                    this._browserFilterChanged({ now: true });
                }
                e.stopPropagation();          // the viewer's own hotkeys are not wanted here
            });
        }
        if (this.browserKindSel) {
            this.browserKindSel.onchange = () => {
                if (this.browserKindSel.value === _FOLD_OPTION) {
                    this.browserKindSel.value = this._browserKinds;
                    this.toggleBrowserFold();
                    return;
                }
                this._browserFilterChanged({ now: true });
            };
        }
        const clearBtn = sr.getElementById("browser-filter-clear");
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (this.browserFilterIn) this.browserFilterIn.value = "";
                if (this.browserKindSel) this.browserKindSel.value = "";
                this._browserFilterChanged({ now: true });
            };
        }

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

        this.browserToggleBtn = sr.getElementById("browser-toggle-btn");
        if (this.browserToggleBtn) this.browserToggleBtn.onclick = () => this.toggleFileBrowser();

        this._syncBrowserToggleState();
    },

    // ── Show / hide ──────────────────────────────────────────────────────────

    toggleFileBrowser(force) {
        if (!this.browserPanel) return;
        const next = (force === undefined) ? !this.isFileBrowserOpen() : !!force;
        // Filling the panel in is _onPanelShown's job (mixinDock) — it fires for
        // every route that reveals a panel, not just this one.
        this.setPanelDocked("browser", next);
        if (!next) this._stopBrowserPreview();
        this._syncBrowserToggleState();
    },

    _syncBrowserToggleState() {
        if (!this.browserToggleBtn) return;
        this.browserToggleBtn.classList.toggle("active", this.isFileBrowserOpen());
    },

    isFileBrowserOpen() {
        return !!(this.isPanelDocked && this.isPanelDocked("browser"));
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
            const parts = dir ? [`path=${encodeURIComponent(dir)}`] : [];
            parts.push(...this.browserFilterQuery());
            const q = parts.length ? `?${parts.join("&")}` : "";
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
            // The folder the last session was left in can be gone by the next
            // one — a temp dir that was cleaned, a share not mounted yet. On the
            // FIRST listing, fall back to the server's default (ComfyUI's input
            // folder) rather than opening on an error. Once something has been
            // listed, a bad path is the user's own typing and gets reported
            // instead of silently jumping somewhere else.
            if (dir && !this._browserLoaded) {
                this.browseTo(null, { force: true });
                return;
            }
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
        this._browserFiltered = !!data.filtered;
        this._browserBuildEntries();
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
            const row = this._makeBrowserRow({
                glyph: _KIND_GLYPH.dir, name: d.name, cls: "is-dir",
                title: d.path,
                onOpen: () => this.browseTo(d.path),
            });
            row.addEventListener("contextmenu", (e) => this._browserContextMenu(e, [d.path]));
            frag.appendChild(row);
        });

        const hint = "Click to preview · double-click to open in the viewer\nDrag onto the graph for a loader node, or onto the viewer to open it\nCtrl+click to add to the selection, Shift+click for a range · right-click to copy the path";
        this._browserEntries.forEach((entry, idx) => {
            const f = entry.file, seq = entry.seq;
            const row = seq ? this._makeBrowserRow({
                glyph: "\ud83c\udf9e",                               // 🎞
                name: seq.name,
                cls: "is-file is-image is-seq",
                meta: `${seq.first}\u2013${seq.last}${seq.gaps ? "*" : ""} \u00b7 ${seq.files.length}`,
                title: `${seq.path}\n${seq.files.length} frames, ${seq.first}\u2013${seq.last}` +
                       (seq.gaps ? " (with gaps)" : "") + ` \u00b7 ${this._formatBytes(seq.size)}\n${hint}`,
                onOpen: () => this.openBrowserSelection(seq.files),
                onSelect: (e) => this._clickBrowserFile(idx, e),
            }) : this._makeBrowserRow({
                glyph: _KIND_GLYPH[f.kind] || _KIND_GLYPH.image,
                name: f.name,
                cls: `is-file is-${f.kind}`,
                meta: this._formatBytes(f.size),
                title: `${f.path}\n${hint}`,
                onOpen: () => this.openBrowserSelection([f]),
                onSelect: (e) => this._clickBrowserFile(idx, e),
            });
            row.addEventListener("contextmenu", (e) => {
                // Inside the selection it copies all of it; outside, just this row.
                const picked = this._browserSel.has(idx) ? [...this._browserSel].sort((a, b) => a - b) : [idx];
                this._browserContextMenu(e, picked.map((i) => this._browserEntryPath(this._browserEntries[i])));
            });
            row.dataset.idx = String(idx);
            if (this._browserSel.has(idx)) row.classList.add("selected");
            this._makeBrowserRowDraggable(row, idx);
            frag.appendChild(row);
        });

        this.browserList.innerHTML = "";
        this.browserList.appendChild(frag);

        if (this._browserDirs.length === 0 && this._browserEntries.length === 0) {
            this._setBrowserStatus(this._browserFiltered
                ? "Nothing here matches the filter."
                : "This folder is empty.", { keepList: true });
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
        this._browserSel = new Set(indices.filter(i => this._browserEntries[i]));
        if (!this.browserList) return;
        this.browserList.querySelectorAll(".browser-row.is-file").forEach((row) => {
            row.classList.toggle("selected", this._browserSel.has(Number(row.dataset.idx)));
        });
        const pv = (preview != null) ? preview
                 : (this._browserSel.size === 1 ? [...this._browserSel][0] : null);
        const entry = pv != null ? this._browserEntries[pv] : null;
        this._renderBrowserPreview(entry ? this._browserEntryFiles(entry)[0] : null, entry && entry.seq);
        this._syncBrowserOpenButton();
    },

    _selectedBrowserFiles() {
        return [...this._browserSel].sort((a, b) => a - b)
            .flatMap(i => this._browserEntryFiles(this._browserEntries[i]));
    },

    /** The path a list entry stands for: a folded sequence's is its #### pattern. */
    _browserEntryPath(entry) {
        return !entry ? "" : entry.seq ? entry.seq.path : entry.file.path;
    },

    // ── Right-click ──────────────────────────────────────────────────────────

    /** The history strip's menu, for the browser's rows: copy the path(s). */
    _browserContextMenu(e, paths) {
        e.preventDefault();
        e.stopPropagation();
        paths = paths.filter(Boolean);
        if (!paths.length || !this.container) return;
        const doc = this.container.ownerDocument;
        this.container.querySelector("#thumb-ctx-menu")?.remove();
        const menu = doc.createElement("div");
        menu.id = "thumb-ctx-menu";
        menu.className = "thumb-ctx-menu";
        const item = doc.createElement("div");
        item.className = "thumb-ctx-item";
        item.textContent = paths.length > 1 ? `\ud83d\udccb Copy ${paths.length} paths` : "\ud83d\udccb Copy path";
        item.onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            this.copyTextToClipboard(paths.join("\n"));
        };
        menu.appendChild(item);
        const panelRect = this.container.getBoundingClientRect();
        menu.style.left = `${e.clientX - panelRect.left}px`;
        menu.style.top  = `${e.clientY - panelRect.top}px`;
        this.container.appendChild(menu);
        const dismiss = () => { menu.remove(); this.container.removeEventListener("click", dismiss, true); };
        setTimeout(() => this.container.addEventListener("click", dismiss, true), 0);
    },

    /**
     * Put text on the clipboard from a click. The synchronous copy goes first,
     * while the click still counts as a user gesture; the async API follows
     * where it exists. Uses the viewer's own document, which a popout moves.
     */
    copyTextToClipboard(text) {
        const doc = (this.container && this.container.ownerDocument) || document;
        try {
            const ta = doc.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;pointer-events:none;";
            doc.body.appendChild(ta);
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(0, text.length);
            doc.execCommand("copy");
            doc.body.removeChild(ta);
        } catch (err) { console.warn("bEpicViewer: execCommand copy failed", err); }
        const nav = (doc.defaultView && doc.defaultView.navigator) || navigator;
        if (nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).catch(() => {});
    },

    _syncBrowserOpenButton() {
        if (!this.browserOpenBtn) return;
        // Counted over what the viewer can open: a folder of a hundred JSONs
        // and one PNG offers to open one thing, not a hundred and one.
        // Counted in list entries, so a folded sequence is one thing to open.
        const openable = (en) => !!en && (en.seq ? true : _OPENABLE.has(en.file.kind));
        const n = [...this._browserSel].filter((i) => openable(this._browserEntries[i])).length;
        const total = this._browserEntries.filter(openable).length;
        this.browserOpenBtn.disabled = total === 0 && n === 0;
        this.browserOpenBtn.textContent = n > 0
            ? `Open ${n} in Viewer`
            : (total > 0 ? `Open all ${total} in Viewer` : "Nothing to open");
    },

    _onBrowserListKey(e) {
        const rows = this._browserEntries;
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

    _renderBrowserPreview(file, seq = null) {
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

        this._setBrowserMeta(file, "", seq);
        const url = this.buildImgUrl({ path: file.path, external: true });

        if (!_OPENABLE.has(file.kind)) {
            // Listed, but not something the viewer can show: say which and stop
            // there rather than firing a request that can only fail.
            if (msg) {
                msg.textContent = `${(file.ext || "This file").replace(/^\./, "").toUpperCase()} — ` +
                                  "nothing this viewer can display.";
                msg.style.display = "block";
            }
            return;
        }

        if (file.kind === "model") {
            // The tile the viewer rendered last time this model was opened, or a
            // placeholder. A second WebGL view just for the preview isn't worth it.
            if (msg) { msg.textContent = "Double-click to view this model in 3D."; msg.style.display = "block"; }
            if (img) {
                img.onload = () => {
                    if (this._browserPreviewPath !== file.path) return;
                    img.style.display = "block";
                };
                img.onerror = null;
                img.src = this.thumbUrl({ kind: "model", path: file.path });
            }
            return;
        }

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
            this._setBrowserMeta(file, `${img.naturalWidth}×${img.naturalHeight}`, seq);
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

    _setBrowserMeta(file, extra, seq = null) {
        if (!this.browserMeta) return;
        // A folded sequence previews its first frame, and says it is a sequence.
        const bits = [seq ? seq.name : file.name];
        if (seq) bits.push(`${seq.files.length} frames, ${seq.first}\u2013${seq.last}`);
        if (extra) bits.push(extra);
        const size = seq ? seq.size : file.size;
        if (size) bits.push(this._formatBytes(size));
        this.browserMeta.textContent = bits.join("  ·  ");
        this.browserMeta.title = seq ? seq.path : file.path;
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
        // A loader node for a text file would be a node that cannot run.
        if (!_OPENABLE.has(file.kind)) return null;
        return {
            path: file.path, url: null,
            filename: file.name, subfolder: "", type: null,
            external: true, dropped: false,
            kind: file.kind === "video" || file.kind === "model" ? file.kind : "image",
            thumb: null, isSequence: false, seqDir: null, seqCount: 0,
        };
    },

    /** A folded sequence as the payload: its folder, for a sequence loader. */
    _browserSeqDragItem(seq) {
        const first = seq.files[0];
        return {
            ...this._browserDragItem(first),
            isSequence: true,
            seqDir: first.path.replace(/[\\/][^\\/]*$/, ""),
            seqCount: seq.files.length,
        };
    },

    _makeBrowserRowDraggable(row, idx) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => {
            // Dragging a row inside the selection takes the whole selection;
            // dragging any other row takes just that one and leaves the
            // selection alone — the rule the history strip uses.
            const picked = this._browserSel.has(idx)
                ? [...this._browserSel].sort((a, b) => a - b).map((i) => this._browserEntries[i])
                : [this._browserEntries[idx]];
            const items = picked.filter(Boolean)
                .map((en) => (en.seq ? this._browserSeqDragItem(en.seq) : this._browserDragItem(en.file)))
                .filter(Boolean);
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
        const all    = picked.length > 0 ? picked : this._browserFiles;
        const list   = all.filter((f) => _OPENABLE.has(f.kind));
        if (list.length === 0) {
            if (all.length) {
                this._setBrowserStatus(all.length === 1
                    ? "There is nothing to show for that file."
                    : "None of those are files this viewer can open.", { keepList: true });
            }
            return;
        }

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

    // Only the preview's height. The panel's WIDTH is the rail's business now
    // (mixinDock), since every panel in a rail shares one.
    _setupBrowserResizing() {
        const sr = this.shadowRoot;
        const win = () => (this.container && this.container.ownerDocument.defaultView) || window;

        // Drag the bar between the list and the preview.
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
