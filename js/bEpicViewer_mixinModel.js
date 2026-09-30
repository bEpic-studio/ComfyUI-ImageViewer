// bEpicViewer_mixinModel.js
// 3D tabs. A frame is a model when it says kind:"model" or names a
// glb/gltf/fbx/obj/stl/ply file. Such a frame is shown by a Model3DView laid
// over the viewport instead of the image layers, the same way a video frame is
// shown by the <video> — see setFrame in bEpicViewer_mixinPlayback.js.
//
// A tab holding several models (a MESH batch) scrubs between them on the
// timeline. Compare, contact sheet and the drawing tools don't apply to a
// model and stay out of the way while one is on screen.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { Model3DView, modelFormatOf } from "./bEpicViewer_model3d.js";

// History tile for a model with no server copy (dropped from the desktop).
const MODEL_TILE = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" fill="#2a2a2a"/>' +
    '<g fill="none" stroke="#9a9a9a" stroke-width="2" stroke-linejoin="round">' +
    '<path d="M32 12 50 22v20L32 52 14 42V22z"/><path d="M14 22l18 10 18-10M32 32v20"/>' +
    '</g></svg>');

const _fmtCount = (n) => Number(n || 0).toLocaleString("en-US");

export const ModelMixin = {

    _frameIsModel(o) {
        return !!modelFormatOf(o);
    },

    _modelView() {
        if (!this._model3d) {
            this._model3d = new Model3DView(this.viewport, {
                resolveResource: (name, frame) => this._modelResourceUrl(name, frame),
                onLoaded: () => this.updateShapeInfo(),
                onError: () => this.updateShapeInfo(),
                onThumbnail: (frame, dataUrl) => this._storeModelThumbnail(frame, dataUrl),
                // Previz: the scene owns where everything is, so each move the
                // view makes is handed back to it instead of kept in three.
                srcUrl: (src) => this.buildImgUrl(src),
                onPick: (id, add) => this.previzSelect(id, { add }),
                // `props` arrives when the view knows which ones it changed —
                // moving a pivot writes the position too.
                onTransform: (id, transform, live, props) =>
                    this.previzApplyTransform(id, transform, props || null, { live }),
                onTransformEnd: () => { this.previzEndDrag(); this.previzChanged(); },
                onCameraMoved: (id, transform, live) =>
                    this.previzApplyTransform(id, transform, ["position", "rotation"], { live }),
                onPanelToggle: (id) => this.togglePanelDocked(id),
                setIcon: (el, key) => this._setIcon(el, key),
                // Which frame a scene's thumbnail belongs to: the tab's first
                // model, which is what the history strip has a tile for.
                thumbFrame: () => (this.allTabs[this.activeTab] || [])
                    .find((f) => this._frameIsModel(f)) || null,
                onClipFrames: (id, frames) => this.previzFitClipLength(frames),
                // Worlds (bEpicViewer_previzWorld.js).
                onWalkChange: (on) => this._onWalkChange(on),
                onFeedbackRequest: (point, seen) => this._previzFeedbackSubmit(point, seen),
                onPinClick: (pin) => this._previzPinClicked(pin),
            });
        }
        return this._model3d;
    },

    /** The 3D toolbar's two panel toggles, lit from the dock. */
    _syncModelPanelButtons() {
        if (!this._model3d || !this._model3d.setPanelStates) return;
        this._model3d.setPanelStates({
            previz: this.isPanelDocked("previz"),
            curves: this.isPanelDocked("curves"),
            channels: this.isPanelDocked("channels"),
        });
    },

    /**
     * Show the 3D view for this tab.
     *
     * Every 3D tab is a scene. A model opened on its own is a scene with one
     * item in it — same outliner, same gizmo, same timeline — so there is no
     * mode to be in and nothing to switch. A tab that has not been made into
     * one yet is built here, once, from the models it holds.
     */
    _enterModelMode(frame) {
        this._exitVideoMode();
        const view = this._modelView();
        if (!this._modelMode) {
            this._modelMode = true;
            this.viewport.classList.add("model-mode");
            // The drawing tools' panels have nothing to do on a 3D tab.
            this._toolShowDock?.(false);
            // Put away, and brought back on the way out only if it was open.
            this._rotoCurvesWereOpen = !!this.isPanelDocked?.("rotoCurves");
            this.rotoShowCurves?.(false);
        }
        this._applyModelLook();

        const scene = this.previzScene() || this._previzBuildForTab();
        if (!scene) return;                  // being built; setFrame will be back
        // The scene decides what is on screen, not the tab's own frame.
        // Scrubbing comes through here every frame, so the scene is only
        // re-reconciled when it is a different one — applyFrame does the
        // per-frame work (see the previz branch of setFrame).
        if (view.scene3d !== scene || !view.reveal()) {
            // reveal() only handles a view that already exists, which is the
            // common case of switching tabs and back; otherwise setScene builds.
            view.setScene(scene, Math.round(this.currentFrame || 0));
            view.select(this._previzSelection);
        }
        this._previzRenderPanel();
        this._syncModelPanelButtons();
        this._updatePathBar(null);
        this.updateShapeInfo();
    },

    _exitModelMode() {
        if (!this._modelMode) return;
        this._modelMode = false;
        this.viewport.classList.remove("model-mode");
        // ...and come back with the picture, for a tool that is still on.
        const tool = this._toolState && this._toolState.active;
        if (tool && tool !== "none") {
            this._toolShowDock?.(true);
            if (tool === "roto" && this._toolState.node && this._rotoCurvesWereOpen) this.rotoShowCurves?.(true);
        }
        if (this._model3d) this._model3d.hide();
        // The scene's keyframe ticks sit on the shared timeline strip; an image
        // tab has none of them, and nothing else would take them down.
        if (this._previzRenderTicks) this._previzRenderTicks();
        // The previz panel is a docked panel now, so it no longer disappears
        // along with the 3D view — it has to be told the picture has changed.
        if (this._previzRenderPanel) this._previzRenderPanel();
    },

    // A 3D tab has no exposure and no channels: the picture is a render, not a
    // photograph, and the controls for those hide with the image layers (the
    // slider by CSS, the keys by their `enabled` guards in the keymap). The
    // render is therefore always shown as it is.
    _applyModelLook() {
        if (!this._model3d) return;
        this._model3d.setLook(0, "");
    },

    _modelInfoText() {
        const v = this._model3d;
        if (!v || !v.stats) return "";
        const s = v.stats;
        const bits = s.format === "scene"
            ? [`Scene · ${s.objects} object${s.objects === 1 ? "" : "s"}`,
               `${s.cameras} camera${s.cameras === 1 ? "" : "s"}`]
            : [`${(s.format || "3D").toUpperCase()} model`];
        if (s.triangles) bits.push(`${_fmtCount(s.vertices)} vertices`, `${_fmtCount(s.triangles)} triangles`);
        if (s.points) bits.push(`${_fmtCount(s.points)} points`);
        if (s.meshes > 1) bits.push(`${s.meshes} meshes`);
        if (s.animations) bits.push(`${s.animations} animation${s.animations > 1 ? "s" : ""}`);
        return bits.join(" · ");
    },

    // A file the model names relative to itself (a .gltf's .bin, an fbx's
    // textures). Only for models the server can reach; a dropped file has no
    // folder to look in.
    _modelResourceUrl(name, frame) {
        if (!frame || frame.url) return null;
        const rel = String(name).replace(/\\/g, "/").replace(/^\.\//, "");
        if (frame.path) {
            const dir = frame.path.replace(/[\\/][^\\/]*$/, "");
            // An absolute path baked into the file points at the author's
            // machine; the file next to the model is the best guess.
            const leaf = /^([a-zA-Z]:|\/)/.test(rel) ? rel.split("/").pop() : rel;
            const sep = frame.path.includes("\\") ? "\\" : "/";
            const full = dir + sep + leaf.split("/").join(sep);
            return api.apiURL(`/bepic/view_file?path=${encodeURIComponent(full)}`);
        }
        if (frame.filename) {
            const sub = [frame.subfolder, rel.split("/").slice(0, -1).join("/")].filter(Boolean).join("/");
            let q = `?filename=${encodeURIComponent(rel.split("/").pop())}`;
            q += `&type=${encodeURIComponent(frame.type || "output")}`;
            if (sub) q += `&subfolder=${encodeURIComponent(sub)}`;
            return api.apiURL(`/view${q}`);
        }
        return null;
    },

    _modelThumbUrl(frame) {
        return frame && frame.url ? MODEL_TILE : null;
    },

    // Keep the first rendering of each model as its history tile. The server
    // answers /bepic/thumb for the model with it from then on.
    async _storeModelThumbnail(frame, dataUrl) {
        if (!frame || !frame.path || frame.url || frame.dropped) return;
        const done = this._modelThumbsSent || (this._modelThumbsSent = new Set());
        if (done.has(frame.path)) return;
        done.add(frame.path);
        try {
            const res = await fetch(api.apiURL("/bepic/model_thumb"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: frame.path, dataurl: dataUrl }),
            });
            if (!res.ok) return;
        } catch (e) {
            return;
        }
        // Re-point the tiles showing the placeholder; the URL is unchanged, so
        // bump it.
        const needle = encodeURIComponent(frame.path);
        const root = this.shadowRoot;
        const docs = [root, this.container && this.container.ownerDocument].filter(Boolean);
        for (const d of docs) {
            d.querySelectorAll && d.querySelectorAll("img").forEach((img) => {
                const src = img.getAttribute("src") || "";
                if (src.includes("/bepic/thumb?") && src.includes(`path=${needle}`)) {
                    img.src = src.replace(/&v=\d+$/, "") + `&v=${Date.now()}`;
                }
            });
        }
    },

    // ── Drag to graph ────────────────────────────────────────────────────────

    // A model dropped on the graph becomes core's Load 3D node, which reads from
    // ./input/3d — so the file is copied there. Dropped onto an existing Load 3D
    // node, it replaces that node's model.
    async _dropModelOntoGraph(payload, e, offset, target) {
        const url = this._frameFetchUrl(payload);
        if (!url) return false;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const blob = await res.blob();
        const name = this._basename(payload.filename || payload.path || "model.glb");
        const body = new FormData();
        body.append("image", new File([blob], name, { type: "application/octet-stream" }), name);
        body.append("subfolder", "3d");
        body.append("type", "input");
        body.append("overwrite", "true");
        const up = await api.fetchApi("/upload/image", { method: "POST", body });
        if (up.status !== 200) throw new Error(`upload ${up.status}`);
        const data = await up.json();
        const value = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;

        let node = target && (target.widgets || []).some((w) => w && w.name === "model_file") ? target : null;
        if (!node) {
            const LG = window.LiteGraph;
            node = LG && LG.createNode ? LG.createNode("Load3D") : null;
            if (!node) { console.warn("[bEpicViewer] could not create a Load 3D node"); return false; }
            app.graph.add(node);
            const pos = this._dropPosition(e, offset);
            if (pos) node.pos = [pos[0] - (node.size?.[0] || 0) / 2, pos[1] - 20];
        }
        const w = (node.widgets || []).find((x) => x && x.name === "model_file");
        if (w) {
            if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(value)) {
                w.options.values.push(value);
            }
            this._setWidget(w, value);
        }
        this._afterNodeMediaChange(node);
        return true;
    },
};
