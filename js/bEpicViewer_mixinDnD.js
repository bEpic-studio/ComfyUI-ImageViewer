// bEpicViewer_mixinDnD.js
// Two drag-and-drop bridges:
//   1. Explorer → viewer:  drop OS files (images/videos) onto the viewport to
//      open them in a new tab. Files are shown straight from blob: URLs (no
//      upload, no on-disk path needed), so these tabs are ephemeral — they are
//      excluded from persisted state and their object URLs are revoked on close.
//   2. History → ComfyUI graph:  drag a history thumbnail onto the node graph to
//      create a path-based loader that references the ORIGINAL file on disk (no
//      upload / no duplicate copy):
//        • image           → VHS "Load Image (Path)"  (VHS_LoadImagePath),  `image`
//        • image sequence  → VHS "Load Images (Path)" (VHS_LoadImagesPath), `directory`
//        • video           → VHS "Load Video (Path)"  (VHS_LoadVideoPath),  `video`
//      Items with no on-disk path (dropped-from-Explorer blobs, or filename-only
//      frames), or when VHS isn't installed, fall back to a native upload loader:
//      image → LoadImage, video → LoadVideo (both copy the file into /input).
//      Dropping ONTO an existing loader node (VHS or native Load Image/Video)
//      replaces that node's media in place instead of adding a new node — the
//      node's wiring and position are kept, only the referenced file changes.
//      Dragging a thumbnail that is part of a history multi-selection carries the
//      whole selection, one loader per snapshot, cascaded from the drop point. A
//      batch never replaces a node in place: a loader holds one file, so there is
//      nothing to say which of them should win.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

const _IMG_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|svg|ico)$/i;
const _VID_RE = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;

// How far each node of a multi-item drop is stepped from the last, so a
// batch lands as a readable cascade instead of one unreachable pile.
const DROP_CASCADE = 28;

export const DnDMixin = {

    // ── 1. Explorer → viewer ─────────────────────────────────────────────────

    setupExplorerDrop() {
        const vp = this.viewport;
        if (!vp || this._explorerDropBound) return;
        this._explorerDropBound = true;
        this._dropSeq = 0;

        const hasFiles = (e) => {
            try { return Array.from(e.dataTransfer?.types || []).includes("Files"); }
            catch (_) { return false; }
        };
        const hint = (on) => { try { vp.classList.toggle("bepic-drop-hover", on); } catch (_) {} };

        vp.addEventListener("dragenter", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation(); hint(true);
        });
        vp.addEventListener("dragover", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation();
            try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            hint(true);
        });
        vp.addEventListener("dragleave", (e) => {
            // Only clear when the pointer actually leaves the viewport, not when
            // it crosses onto a child element inside it.
            if (!e.relatedTarget || !vp.contains(e.relatedTarget)) hint(false);
        });
        vp.addEventListener("drop", (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault(); e.stopPropagation(); hint(false);
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length) this._addDroppedFiles(files);
        });
    },

    _frameForDroppedFile(file, isVideo) {
        const url = URL.createObjectURL(file);
        (this._droppedObjectUrls || (this._droppedObjectUrls = [])).push(url);
        // A unique, stable filename keys the frame (used as the video-mode key so
        // scrubbing doesn't reload, and so two same-named clips don't collide).
        const frame = {
            url,
            name: file.name,
            filename: `drop${++this._dropSeq}_${file.name}`,
            external: true,
            dropped: true,
        };
        if (isVideo) {
            frame.kind = "video"; frame.fps = this.fps || 24;
        } else {
            // Images show their name in the path bar; videos key off `filename`
            // instead (see _enterVideoMode) so leave `path` unset for them.
            frame.path = file.name;
        }
        return frame;
    },

    _addDroppedFiles(files) {
        const images = [], videos = [];
        for (const f of files) {
            const isVid = (f.type && f.type.startsWith("video/")) || _VID_RE.test(f.name);
            const isImg = (f.type && f.type.startsWith("image/")) || _IMG_RE.test(f.name);
            if (isVid) videos.push(f);
            else if (isImg) images.push(f);
        }
        if (!images.length && !videos.length) return;

        let firstKey = null;

        // All dropped images share one browsable tab (mirrors "Open Folder":
        // each image is its own history entry, the tab shows one at a time).
        if (images.length) {
            const key = `dropped_${Date.now()}_${++this._dropSeq}`;
            const frames = images.map((f) => this._frameForDroppedFile(f, false));
            this.allTabs[key]   = [frames[0]];
            this.history[key]   = frames.map((fr) => [fr]);
            this.tabLabels[key] = images.length > 1 ? `📥 ${images.length} images` : `📥 ${images[0].name}`;
            firstKey = firstKey || key;
        }

        // A video tab holds a single video, so each dropped clip gets its own tab.
        for (const f of videos) {
            const key   = `dropped_${Date.now()}_${++this._dropSeq}`;
            const frame = this._frameForDroppedFile(f, true);
            this.allTabs[key]   = [frame];
            this.history[key]   = [[frame]];
            this.tabLabels[key] = `📥 ${f.name}`;
            firstKey = firstKey || key;
            // <img> can't render a video file — extract a poster frame for the strip.
            this._generateDroppedVideoPoster(frame);
        }

        const allKeys = Object.keys(this.allTabs);
        const known   = this.tabOrder.filter((k) => allKeys.includes(k));
        const added   = allKeys.filter((k) => !known.includes(k));
        this.tabOrder = [...known, ...added];

        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        this._rebuildTabBar(null);
        if (firstKey) this.switchTab(firstKey);

        const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
        if (panel) { panel.style.display = "flex"; this._historyPanelSig = null; this.renderHistoryPanel(); }
        this._syncHistoryToggleState && this._syncHistoryToggleState();
    },

    // Grab a poster frame from a dropped video (blob: URL, same-origin so the
    // canvas isn't tainted) and stash it on the frame as an inline data: URL so
    // the history strip's <img> has something to show.
    _generateDroppedVideoPoster(frame) {
        if (!frame || !frame.url) return;
        let done = false;
        const v = document.createElement("video");
        v.muted = true; v.preload = "auto"; v.crossOrigin = "anonymous";
        const cleanup = () => { try { v.removeAttribute("src"); v.load(); } catch (_) {} };
        const draw = () => {
            if (done) return; done = true;
            try {
                const w = v.videoWidth || 160, h = v.videoHeight || 90;
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                c.getContext("2d").drawImage(v, 0, 0, w, h);
                frame.thumb = c.toDataURL("image/jpeg", 0.6);
                this._historyPanelSig = null;
                if (this.renderHistoryPanel) this.renderHistoryPanel();
            } catch (_) {}
            cleanup();
        };
        v.addEventListener("loadedmetadata", () => {
            try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (_) { draw(); }
        }, { once: true });
        v.addEventListener("seeked", draw, { once: true });
        v.addEventListener("error", () => { done = true; cleanup(); }, { once: true });
        try { v.src = frame.url; } catch (_) {}
    },

    // Revoke a dropped tab's object URLs when it is closed (called from closeTab).
    _revokeDroppedTab(key) {
        try {
            const seen = new Set();
            const scan = (arr) => (arr || []).forEach((fr) => {
                if (fr && fr.dropped && fr.url && !seen.has(fr.url)) { seen.add(fr.url); URL.revokeObjectURL(fr.url); }
            });
            scan(this.allTabs[key]);
            (this.history[key] || []).forEach(scan);
        } catch (_) {}
    },

    // ── 2. History → ComfyUI graph ───────────────────────────────────────────

    // Make a history-strip thumbnail a drag source for the node graph. `snapshot`
    // is the full frame array behind the thumbnail — a length>1 image snapshot is
    // an image sequence and maps to a directory-based sequence loader.
    _makeHistoryThumbDraggable(thumb, imgObj, snapshot, key, idx) {
        if (!thumb || !imgObj) return;
        thumb.draggable = true;
        const img = thumb.querySelector("img");
        if (img) img.draggable = false;   // let the container own the drag, not the <img>
        thumb.addEventListener("dragstart", (e) => {
            // Dragging a thumb that is part of a multi-selection takes the whole
            // selection in one go; dragging any other thumb takes just that one
            // and leaves the selection where it was.
            const picked = this.isHistoryItemSelected?.(key, idx)
                ? this.selectedHistorySnapshots(key)
                : [{ imgObj, snapshot }];
            const items = picked
                .map((p) => this._historyDragItem(p.imgObj, p.snapshot))
                .filter(Boolean);
            if (items.length === 0) return;
            try {
                e.dataTransfer.setData("application/x-bepic-history", JSON.stringify({ items }));
                e.dataTransfer.effectAllowed = "copy";
                if (img && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(img, 20, 20);
            } catch (_) {}
        });
    },

    /** One history frame, flattened into what the graph-drop side needs. */
    _historyDragItem(imgObj, snapshot) {
        if (!imgObj) return null;
        const seq = this._sequenceDirForSnapshot(snapshot, imgObj);
        return {
            path:      imgObj.path || null,
            url:       imgObj.url || null,
            filename:  imgObj.filename || imgObj.name || null,
            subfolder: imgObj.subfolder || "",
            type:      imgObj.type || null,
            external:  !!imgObj.external,
            dropped:   !!imgObj.dropped,
            kind:      imgObj.kind || (this._frameIsVideo(imgObj) ? "video" : "image"),
            thumb:     imgObj.thumb || null,
            isSequence: !!(seq && seq.dir),
            seqDir:     seq ? seq.dir : null,
            seqCount:   seq ? seq.count : 0,
        };
    },

    // A history snapshot with >1 image frame is an image sequence. If every frame
    // is a real on-disk image living in ONE directory, return {dir, count} so the
    // drop can create a directory-based sequence loader. Videos, single images,
    // dropped blobs, or frames spanning multiple folders → null (not a sequence).
    _sequenceDirForSnapshot(snapshot, imgObj) {
        if (!Array.isArray(snapshot) || snapshot.length < 2) return null;
        if (imgObj && (imgObj.kind === "video" || this._frameIsVideo(imgObj))) return null;
        let dir = null;
        for (const fr of snapshot) {
            if (!fr || fr.dropped || fr.kind === "video" || this._frameIsVideo(fr)) return null;
            const p = fr.path || "";
            if (!/^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(p)) return null;   // need a real abs path
            const d = this._dirname(p);
            if (dir === null) dir = d;
            else if (d !== dir) return null;   // frames span folders — not one sequence dir
        }
        return dir ? { dir, count: snapshot.length } : null;
    },

    // Directory portion of a path, preserving the original separator style.
    _dirname(p) {
        const s = String(p || "");
        const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return i >= 0 ? s.slice(0, i) : s;
    },

    _dragHasHistoryPayload(e) {
        try { return Array.from(e.dataTransfer?.types || []).includes("application/x-bepic-history"); }
        catch (_) { return false; }
    },

    setupGraphDropTarget() {
        if (this._graphDropBound) return;
        const attach = () => {
            const cv = (app.canvas && app.canvas.canvas) ||
                       app.canvasEl ||
                       document.getElementById("graph-canvas") ||
                       document.querySelector("canvas.litegraph");
            if (!cv) return false;
            this._graphDropBound = true;
            cv.addEventListener("dragover", (e) => {
                if (!this._dragHasHistoryPayload(e)) return;   // let ComfyUI handle its own drops
                e.preventDefault();
                try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
            });
            cv.addEventListener("drop", (e) => {
                if (!this._dragHasHistoryPayload(e)) return;
                e.preventDefault(); e.stopPropagation();
                let payload = null;
                try { payload = JSON.parse(e.dataTransfer.getData("application/x-bepic-history")); } catch (_) {}
                if (!payload) return;
                // {items:[…]} is what a drag sends; a bare item is tolerated so a
                // drag that began before a reload cannot land as nothing.
                this._dropHistoryOntoGraph(
                    Array.isArray(payload.items) ? payload.items : [payload], e);
            });
            return true;
        };
        if (attach()) return;
        // The graph canvas may not exist yet at viewer init — retry briefly.
        let tries = 0;
        const timer = setInterval(() => { if (attach() || ++tries > 40) clearInterval(timer); }, 250);
    },

    // Build a fetchable URL for a history payload (mirrors buildImgUrl, no cache-bust).
    _frameFetchUrl(p) {
        if (p.url) return p.url;
        if (p.path) {
            const endpoint = p.external ? "/bepic/view_file" : "/bepic/raw_view";
            return api.apiURL(`${endpoint}?path=${encodeURIComponent(p.path)}`);
        }
        if (p.filename) {
            let q = `?filename=${encodeURIComponent(p.filename)}`;
            if (p.type)      q += `&type=${p.type}`;
            if (p.subfolder) q += `&subfolder=${encodeURIComponent(p.subfolder)}`;
            return api.apiURL(`/view${q}`);
        }
        return "";
    },

    _basename(p) {
        return String(p || "").replace(/\\/g, "/").split("/").pop() || "image.png";
    },

    async _dropHistoryOntoGraph(items, e) {
        const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
        if (list.length === 0) return;
        try {
            // Dropped onto an existing loader node whose widget matches the dragged
            // media type → swap that node's file in place (keeps its wiring/position)
            // rather than spawning a new node. Falls through to node-creation when
            // the drop misses, hits an unrelated node, or the media types differ.
            // Only for a single item: a node has one file, so a batch has nothing
            // to say about which of them should replace it.
            if (list.length === 1) {
                const payload = list[0];
                const target = this._nodeUnderEvent(e);
                if (target) {
                    const isVideo = payload.kind === "video";
                    const widget = this._loaderWidgetFor(target, isVideo ? "video" : "image", payload);
                    if (widget && await this._replaceLoaderMedia(target, widget, payload, isVideo)) return;
                }
            }

            // Cascade, so a batch does not land as one pile with only the last
            // node reachable.
            let offset = [0, 0];
            for (const payload of list) {
                await this._createLoaderForPayload(payload, e, offset);
                offset = [offset[0] + DROP_CASCADE, offset[1] + DROP_CASCADE];
            }
        } catch (err) {
            console.error("[bEpicViewer] drop-to-graph failed", err);
        }
    },

    /** The right loader node for one dragged item, placed at the drop point. */
    async _createLoaderForPayload(payload, e, offset) {
        const isVideo = payload.kind === "video";

        // Image sequence → a directory-based loader that reads the whole
        // sequence. VHS "Load Images (Path)" takes an arbitrary directory.
        if (payload.isSequence && payload.seqDir) {
            if (this._nodeTypeAvailable("VHS_LoadImagesPath")) {
                this._createPathLoaderNode("VHS_LoadImagesPath", "directory", payload.seqDir, e, offset);
                return;
            }
            // ComfyUI core has no arbitrary-path folder loader (the native
            // LoadImageDataSetFromFolder only accepts input-dir subfolders),
            // so without VHS fall through to a single-image loader below.
        }

        const absPath = this._absPathForPayload(payload);

        // Preferred path: a VHS "(Path)" loader that references the ORIGINAL
        // file on disk — no upload, no duplicate copy in /input.
        if (absPath) {
            const type   = isVideo ? "VHS_LoadVideoPath" : "VHS_LoadImagePath";
            const widget = isVideo ? "video" : "image";
            if (this._nodeTypeAvailable(type)) {
                this._createPathLoaderNode(type, widget, absPath, e, offset);
                return;
            }
            // VHS not installed → fall through to the native upload loader.
        }

        // Fallback: upload a copy to /input and use a native loader that reads
        // from there — image → LoadImage, video → LoadVideo (both accept
        // uploads). Also covers dropped-from-Explorer blobs that have no path.
        await this._dropViaUpload(payload, e, isVideo, offset);
    },

    // Where a node dropped by this event goes, in graph space. `offset` steps a
    // batch apart; null when the canvas can't map the event.
    _dropPosition(e, offset) {
        try {
            const pos = app.canvas && app.canvas.convertEventToCanvasOffset(e);
            if (pos) return [pos[0] + ((offset && offset[0]) || 0), pos[1] + ((offset && offset[1]) || 0)];
        } catch (_) {}
        return null;
    },

    // Absolute on-disk path for a history payload, or null when there isn't one
    // (dropped blob items, or filename/type-only frames without a real path).
    _absPathForPayload(p) {
        if (!p || p.dropped) return null;
        const path = p.path || "";
        return /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(path) ? path : null;
    },

    _nodeTypeAvailable(type) {
        const LG = window.LiteGraph;
        return !!(LG && LG.registered_node_types && LG.registered_node_types[type]);
    },

    _createPathLoaderNode(type, widgetName, absPath, e, offset) {
        const LG = window.LiteGraph;
        if (!LG || !LG.createNode) { console.warn("[bEpicViewer] LiteGraph unavailable"); return; }
        const node = LG.createNode(type);
        if (!node) { console.warn("[bEpicViewer] could not create node", type); return; }
        app.graph.add(node);

        const pos = this._dropPosition(e, offset);
        if (pos) node.pos = [pos[0] - (node.size?.[0] || 0) / 2, pos[1] - 20];

        const w = node.widgets && (
            node.widgets.find((x) => x.name === widgetName) ||
            node.widgets.find((x) => x.name === "video" || x.name === "image" || x.name === "directory")
        );
        if (w) this._setWidget(w, absPath);                          // OS abs path (VHS validates it server-side)
        this._afterNodeMediaChange(node);
    },

    // Fallback for items without an absolute path (dropped blobs, filename-only
    // frames) or when VHS isn't installed: upload a copy to /input and drop a
    // native loader that reads from there.
    //   image → LoadImage (widget "image"),  video → LoadVideo (widget "file").
    async _dropViaUpload(payload, e, isVideo, offset) {
        const uploaded = await this._uploadPayloadToInput(payload, isVideo);
        if (!uploaded) throw new Error("upload failed");

        if (isVideo) this._createNativeLoaderNode("LoadVideo", "file",  uploaded, e, offset);
        else         this._createNativeLoaderNode("LoadImage", "image", uploaded, e, offset);
    },

    // Fetch a history payload's bytes and upload a copy to /input, returning the
    // { path, name, subfolder, type } descriptor (or null). Shared by the native
    // upload loader and in-place replacement of a combo/upload loader node.
    async _uploadPayloadToInput(payload, isVideo) {
        const fetchUrl = this._frameFetchUrl(payload);
        if (!fetchUrl) return null;
        let fname = this._basename(payload.filename || payload.path || (isVideo ? "video.mp4" : "image.png"));
        const resp = await fetch(fetchUrl);
        if (!resp.ok) throw new Error(`fetch ${resp.status}`);
        const blob = await resp.blob();
        if (isVideo) {
            if (!/\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i.test(fname)) fname += ".mp4";
        } else {
            if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(fname)) fname += ".png";
        }
        const file = new File([blob], fname, { type: blob.type || (isVideo ? "video/mp4" : "image/png") });
        return await this._uploadFileToInput(file);
    },

    // ComfyUI's /upload/image saves any uploaded file (image OR video) to /input.
    async _uploadFileToInput(file) {
        const body = new FormData();
        body.append("image", file, file.name);
        body.append("overwrite", "true");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body });
        if (resp.status !== 200) return null;
        const data = await resp.json();
        let path = data.name;
        if (data.subfolder) path = `${data.subfolder}/${path}`;
        return { path, name: data.name, subfolder: data.subfolder || "", type: data.type || "input" };
    },

    _createNativeLoaderNode(type, widgetName, uploaded, e, offset) {
        const LG = window.LiteGraph;
        if (!LG || !LG.createNode) { console.warn("[bEpicViewer] LiteGraph unavailable"); return; }
        const node = LG.createNode(type);
        if (!node) { console.warn("[bEpicViewer] could not create node", type, "(is it installed?)"); return; }
        app.graph.add(node);

        const pos = this._dropPosition(e, offset);
        if (pos) node.pos = [pos[0] - (node.size?.[0] || 0) / 2, pos[1] - 20];

        const w = node.widgets && (
            node.widgets.find((x) => x.name === widgetName) ||
            node.widgets.find((x) => x.type === "combo")
        );
        if (w) {
            if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(uploaded.path)) {
                w.options.values.push(uploaded.path);
            }
            this._setWidget(w, uploaded.path);
        }
        this._afterNodeMediaChange(node);
    },

    // ── In-place replacement (drop onto an existing loader node) ──────────────

    // The loader node under the drop point, or null. Uses litegraph hit-testing
    // in graph space (convertEventToCanvasOffset already maps the event there).
    _nodeUnderEvent(e) {
        try {
            const pos = app.canvas && app.canvas.convertEventToCanvasOffset(e);
            if (!pos) return null;
            const g = app.graph;
            if (!g) return null;
            if (typeof g.getNodeOnPos === "function") return g.getNodeOnPos(pos[0], pos[1], g._nodes, 2) || null;
            const nodes = g._nodes || [];
            for (let i = nodes.length - 1; i >= 0; i--) {
                const n = nodes[i];
                if (n && typeof n.isPointInside === "function" && n.isPointInside(pos[0], pos[1])) return n;
            }
        } catch (_) {}
        return null;
    },

    // The widget on `node` that should receive dragged media of the given kind, or
    // null when the node has no matching input (so a mismatched drop — e.g. a video
    // onto a Load Image node — falls through to creating a fresh node instead).
    //   image → "image" / "directory"   video → "video" / "file"
    // Covers native (LoadImage `image`, LoadVideo `file`) and VHS (`image`,
    // `video`, `directory`) loaders alike, since both name their widgets this way.
    _loaderWidgetFor(node, kind, payload) {
        const ws = (node && node.widgets) || [];
        const byName = (n) => ws.find((w) => w && w.name === n);
        if (kind === "video") return byName("video") || byName("file") || null;
        if (payload && payload.isSequence && payload.seqDir) {
            const d = byName("directory");
            if (d) return d;
        }
        return byName("image") || byName("directory") || null;
    },

    // Point an existing loader node's widget at the dragged media. Path-style
    // widgets (VHS "(Path)" loaders, `directory`) take the OS path directly;
    // combo/upload widgets (native LoadImage/LoadVideo, VHS upload loaders) need
    // the file copied into /input first. Returns true when the swap was applied.
    async _replaceLoaderMedia(node, widget, payload, isVideo) {
        const isCombo = widget.type === "combo" ||
                        !!(widget.options && Array.isArray(widget.options.values));

        // Sequence directory target: set the folder path straight through.
        if (widget.name === "directory" && payload.isSequence && payload.seqDir) {
            this._setWidget(widget, payload.seqDir);
            this._afterNodeMediaChange(node);
            return true;
        }

        // Path-style loader with a real on-disk path → reference the original file.
        const absPath = this._absPathForPayload(payload);
        if (!isCombo && absPath) {
            this._setWidget(widget, absPath);
            this._afterNodeMediaChange(node);
            return true;
        }

        // Combo/upload loader, or a path loader fed a blob with no on-disk path →
        // upload a copy to /input and point the widget at it.
        const uploaded = await this._uploadPayloadToInput(payload, isVideo);
        if (!uploaded) return false;
        if (widget.options && Array.isArray(widget.options.values) &&
            !widget.options.values.includes(uploaded.path)) {
            widget.options.values.push(uploaded.path);
        }
        this._setWidget(widget, uploaded.path);
        this._afterNodeMediaChange(node);
        return true;
    },

    // Assign a widget value and fire its callback (loads previews / revalidates).
    _setWidget(w, value) {
        try {
            w.value = value;
            if (typeof w.callback === "function") w.callback(value);
        } catch (_) {}
    },

    // Redraw + reselect after a loader node's media changed.
    _afterNodeMediaChange(node) {
        try { node.onResize?.(node.size); } catch (_) {}
        try { app.graph.setDirtyCanvas(true, true); } catch (_) {}
        try { if (app.canvas && app.canvas.selectNode) app.canvas.selectNode(node); } catch (_) {}
    },
};
