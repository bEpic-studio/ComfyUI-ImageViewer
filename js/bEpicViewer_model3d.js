// bEpicViewer_model3d.js
// The 3D view behind a model tab (glb / gltf / fbx / obj / stl / ply).
//
// It follows ComfyUI's own Load 3D / Save 3D Model viewer (frontend
// src/extensions/core/load3d): the same three.js revision (r180), the same
// six-light rig, a 20-unit grid, a 35° camera placed off the model's bounding
// box, orbit controls with damping, and the Original / Clay / Normal /
// Wireframe material modes. Background colour, grid and light intensity come
// from ComfyUI's Load 3D settings, so both viewers look alike.
//
// three.js is not bundled with this file: ComfyUI imports every .js under js/
// at startup, and a megabyte of it has no business loading for users who never
// open a model. It lives in vendor/three and is imported on first use.
//
// Rendering is on demand. A still model costs nothing once drawn; the loop only
// runs while the camera is settling or an animation plays.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { evaluate } from "./bEpicViewer_scene3d.js";

let _libsPromise = null;

function loadLibs() {
    if (!_libsPromise) {
        const base = api.apiURL("/bepic/lib/three/");
        const load = (name) => import(base + name);
        _libsPromise = Promise.all([
            load("three.module.min.js"), load("OrbitControls.js"), load("GLTFLoader.js"),
            load("FBXLoader.js"), load("OBJLoader.js"), load("STLLoader.js"), load("PLYLoader.js"),
            load("TransformControls.js"),
        ]).then(([THREE, orbit, gltf, fbx, obj, stl, ply, gizmo]) => ({
            THREE,
            OrbitControls: orbit.OrbitControls,
            TransformControls: gizmo.TransformControls,
            GLTFLoader: gltf.GLTFLoader,
            FBXLoader: fbx.FBXLoader,
            OBJLoader: obj.OBJLoader,
            STLLoader: stl.STLLoader,
            PLYLoader: ply.PLYLoader,
        })).catch((e) => { _libsPromise = null; throw e; });
    }
    return _libsPromise;
}

export const MODEL_FORMATS = ["glb", "gltf", "fbx", "obj", "stl", "ply"];
const _MODEL_RE = /\.(glb|gltf|fbx|obj|stl|ply)$/i;

/** The 3D format of a viewer frame, or "" when it isn't a model. */
export function modelFormatOf(frame) {
    if (!frame) return "";
    if (frame.kind === "model" && frame.format) return String(frame.format).toLowerCase();
    const m = _MODEL_RE.exec(frame.path || frame.name || frame.filename || "");
    return m ? m[1].toLowerCase() : (frame.kind === "model" ? "glb" : "");
}

// Resources a model names relative to itself (a .gltf's .bin, an fbx's
// textures) are requested under this prefix; the view's resolver maps them to
// a real URL next to the model.
const RES_PREFIX = "bepic-res/";

const MATERIAL_MODES = [
    ["original", "Original"], ["clay", "Clay"], ["normal", "Normal"], ["wireframe", "Wireframe"],
];

function setting(id, fallback) {
    try {
        const v = app.extensionManager.setting.get(id);
        return v === undefined || v === null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

export class Model3DView {
    /**
     * @param {HTMLElement} host   the viewport the view is laid over
     * @param {object} hooks
     *   resolveResource(name, frame) → URL for a file the model references
     *   onLoaded(frame, stats), onError(frame, message), onThumbnail(frame, dataUrl)
     */
    constructor(host, hooks = {}) {
        this.host = host;
        this.hooks = hooks;
        this.root = null;
        this.libs = null;
        this.model = null;
        this.frame = null;
        this.stats = null;
        this.materialMode = "original";
        this.showGrid = !!setting("Comfy.Load3D.ShowGrid", true);
        this.exposure = 1;
        this.channelFilter = "";
        this._loadId = 0;
        this._raf = 0;
        this._mixer = null;
        this._playing = false;
        this._originals = new Map();
        // Previz scene: item id -> { item, root, key, mixer, clips, camera, helper }
        this._entries = new Map();
        this.scene3d = null;          // the scene data this view is showing
        this.sceneFrame = 0;          // where the timeline is (frames, not a media frame)
        this.selected = null;
        this.gizmoMode = "translate";
    }

    get doc() { return this.host.ownerDocument; }
    get win() { return this.doc.defaultView || window; }

    // ── DOM ──────────────────────────────────────────────────────────────────

    _buildDom() {
        const d = this.doc;
        const el = (tag, cls, text) => {
            const n = d.createElement(tag);
            if (cls) n.className = cls;
            if (text !== undefined) n.textContent = text;
            return n;
        };
        const root = el("div", "model-view");
        root.id = "model-view";

        const bar = el("div", "model-toolbar");
        const modeSel = el("select", "model-mode");
        modeSel.title = "Material";
        for (const [value, label] of MATERIAL_MODES) {
            const o = el("option", "", label);
            o.value = value;
            modeSel.appendChild(o);
        }
        modeSel.onchange = () => this.setMaterialMode(modeSel.value);

        const gridBtn = el("button", "model-btn", "Grid");
        gridBtn.title = "Show / hide the grid";
        gridBtn.onclick = () => this.setGrid(!this.showGrid);

        const resetBtn = el("button", "model-btn", "Reset view");
        resetBtn.title = "Frame the model again (F)";
        resetBtn.onclick = () => this.resetView();

        const animBtn = el("button", "model-btn", "❚❚");
        animBtn.title = "Play / pause the model's animation";
        animBtn.style.display = "none";
        animBtn.onclick = () => this.setAnimationPlaying(!this._playing);

        bar.append(modeSel, gridBtn, resetBtn, animBtn);
        const status = el("div", "model-status");

        root.append(bar, status);
        this.root = root;
        this.ui = { modeSel, gridBtn, resetBtn, animBtn, status };
        this._syncToolbar();
        this.host.appendChild(root);
    }

    _syncToolbar() {
        if (!this.ui) return;
        this.ui.modeSel.value = this.materialMode;
        this.ui.gridBtn.classList.toggle("active", this.showGrid);
        const hasAnim = !!this._mixer;
        this.ui.animBtn.style.display = hasAnim ? "" : "none";
        this.ui.animBtn.textContent = this._playing ? "❚❚" : "▶";
    }

    _setStatus(text, isError = false) {
        if (!this.ui) return;
        this.ui.status.textContent = text || "";
        this.ui.status.classList.toggle("error", !!isError);
        this.ui.status.style.display = text ? "block" : "none";
    }

    // ── Renderer ─────────────────────────────────────────────────────────────

    _initScene() {
        const { THREE } = this.libs;
        const scene = new THREE.Scene();

        // ComfyUI's LightingManager rig, intensities scaled by its setting.
        const intensity = Number(setting("Comfy.Load3D.LightIntensity", 3)) || 3;
        this.lights = [];
        const add = (light, mult, pos) => {
            if (pos) light.position.set(...pos);
            light.userData.mult = mult;
            light.intensity = intensity * mult;
            scene.add(light);
            this.lights.push(light);
        };
        add(new THREE.AmbientLight(0xffffff), 0.5);
        add(new THREE.DirectionalLight(0xffffff), 0.8, [0, 10, 10]);
        add(new THREE.DirectionalLight(0xffffff), 0.5, [0, 10, -10]);
        add(new THREE.DirectionalLight(0xffffff), 0.3, [-10, 0, 0]);
        add(new THREE.DirectionalLight(0xffffff), 0.3, [10, 0, 0]);
        add(new THREE.DirectionalLight(0xffffff), 0.2, [0, -10, 0]);

        this.grid = new THREE.GridHelper(20, 20);
        this.grid.visible = this.showGrid;
        scene.add(this.grid);

        this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
        this.camera.position.set(10, 10, 10);
        this.camera.lookAt(0, 0, 0);
        this.scene = scene;

        this.materials = {
            clay: new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0, roughness: 0.9, side: THREE.DoubleSide }),
            normal: new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }),
            wireframe: new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }),
            // What STL and face-less PLY geometry is drawn with; neither format
            // carries a material of its own.
            plain: new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0.1, roughness: 0.8, side: THREE.DoubleSide }),
        };
        this.clock = new THREE.Clock();
    }

    // The canvas and everything bound to it. Rebuilt after the viewer moves
    // between windows: WebGL, rAF and ResizeObserver all belong to one document.
    _initRenderer() {
        const { THREE, OrbitControls } = this.libs;
        const canvas = this.doc.createElement("canvas");
        canvas.className = "model-canvas";
        this.root.insertBefore(canvas, this.root.firstChild);

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        renderer.setPixelRatio(this.win.devicePixelRatio || 1);
        // Linear tone mapping at exposure 1 is the same picture as none at all,
        // and it is what lets the viewer's exposure slider work on a model.
        renderer.toneMapping = THREE.LinearToneMapping;
        renderer.toneMappingExposure = this.exposure;
        const bg = String(setting("Comfy.Load3D.BackgroundColor", "282828")).replace(/^#/, "");
        renderer.setClearColor(new THREE.Color("#" + bg));
        this.renderer = renderer;
        this.canvas = canvas;
        canvas.style.filter = this.channelFilter;

        canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
        canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));

        const controls = new OrbitControls(this.activeCameraObject(), canvas);
        controls.enableDamping = true;
        if (this._target) controls.target.copy(this._target);
        controls.addEventListener("change", () => this.requestRender());
        controls.update();
        this.controls = controls;

        const RO = this.win.ResizeObserver;
        if (RO) {
            this._ro = new RO(() => this._resize());
            this._ro.observe(this.root);
        }
        this._resize();
    }

    // Click to select, drag to orbit: the difference is whether the pointer
    // moved between down and up.
    _onPointerDown(e) {
        this._downAt = { x: e.clientX, y: e.clientY, button: e.button };
    }

    _onPointerUp(e) {
        const d = this._downAt;
        this._downAt = null;
        if (!d || d.button !== 0 || !this.scene3d) return;
        if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) return;
        if (this.gizmo && this.gizmo.dragging) return;
        const hit = this._pick(e);
        if (this.hooks.onPick) this.hooks.onPick(hit);
    }

    /** The scene item under the pointer, or null. */
    _pick(e) {
        if (!this.libs || !this.canvas) return null;
        const { THREE } = this.libs;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        const roots = [];
        for (const entry of this._entries.values()) {
            if (entry.object) roots.push(entry.root);
            // A camera has no geometry; its frustum lines are what you click.
            if (entry.helper && entry.helper.visible) roots.push(entry.helper);
        }
        ray.params.Line.threshold = 0.05 * (this.activeCameraObject().position.length() || 1);
        const hits = ray.intersectObjects(roots, true);
        if (!hits.length) return null;
        let node = hits[0].object;
        while (node && !node.userData.bepicItemId) node = node.parent;
        return node ? node.userData.bepicItemId : null;
    }

    _disposeRenderer() {
        if (this._raf && this._rafWin) {
            try { this._rafWin.cancelAnimationFrame(this._raf); } catch (e) {}
        }
        this._raf = 0;
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this.controls) {
            this._target = this.controls.target.clone();
            this.controls.dispose();
            this.controls = null;
        }
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        if (this.canvas) { this.canvas.remove(); this.canvas = null; }
    }

    _resize() {
        if (!this.renderer || !this.root) return;
        const w = Math.max(1, this.root.clientWidth);
        const h = Math.max(1, this.root.clientHeight);
        this.renderer.setSize(w, h, false);
        for (const cam of [this.camera, ...this._sceneCameraObjects()]) {
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
        }
        this.requestRender();
    }

    _sceneCameraObjects() {
        const out = [];
        for (const e of this._entries.values()) if (e.camera) out.push(e.camera);
        return out;
    }

    /** The camera the viewport renders from: a scene camera, or the free one. */
    activeCameraObject() {
        const id = this.scene3d && this.scene3d.activeCamera;
        const entry = id ? this._entries.get(id) : null;
        return (entry && entry.camera) || this.camera;
    }

    requestRender() {
        if (this._raf || !this.renderer) return;
        this._rafWin = this.win;
        this._raf = this._rafWin.requestAnimationFrame(() => this._tick());
    }

    _tick() {
        this._raf = 0;
        if (!this.renderer) return;
        const dt = this.clock.getDelta();
        let again = false;
        // A lone model's own clip runs in real time; in a scene the timeline
        // owns the clock, so clips are set to the frame instead (see applyFrame).
        if (this._mixer && this._playing) {
            this._mixer.update(dt);
            again = true;
        }
        // update() reports whether damping moved the camera; keep going until
        // it has settled.
        if (this.controls && this.controls.update(dt)) again = true;
        this.renderer.render(this.scene, this.activeCameraObject());
        if (again) this.requestRender();
    }

    async ensure() {
        if (!this.root) this._buildDom();
        this.root.style.display = "block";
        if (!this.libs) {
            this._setStatus("Loading the 3D viewer…");
            this.libs = await loadLibs();
            this._setStatus("");
            this._initScene();
        }
        if (!this.renderer) this._initRenderer();
    }

    /** Re-create the canvas in whatever document the host now lives in. */
    rebind() {
        if (!this.root) return;
        if (!this.renderer) return;
        this._disposeRenderer();
        this._initRenderer();
    }

    hide() {
        if (!this.root) return;
        this.root.style.display = "none";
        this.setAnimationPlaying(false);
    }

    get visible() {
        return !!(this.root && this.root.style.display !== "none");
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    /** Show `frame` (a viewer frame dict) fetched from `url`. */
    async show(frame, url) {
        const key = frame.path || frame.url || frame.filename || url;
        await this.ensure();
        if (this.frame && this._key === key && this.model) { this.requestRender(); return; }

        const id = ++this._loadId;
        this._key = key;
        this.frame = frame;
        const format = modelFormatOf(frame);
        this._setStatus(`Loading ${frame.name || format.toUpperCase()}…`);
        try {
            const object = await this._load(frame, url, format);
            if (id !== this._loadId) { this._disposeObject(object.object); return; }
            this._setModel(object.object, object.animations);
            this._setStatus("");
            this.requestRender();
            if (this.hooks.onLoaded) this.hooks.onLoaded(frame, this.stats);
            this._captureThumbnailSoon(frame, id);
        } catch (e) {
            if (id !== this._loadId) return;
            console.warn("[bEpicViewer] could not load 3D model", e);
            this._clearModel();
            const msg = (e && e.message) ? e.message : String(e);
            this._setStatus(`Could not load this ${format.toUpperCase()} file.\n${msg}`, true);
            this.requestRender();
            if (this.hooks.onError) this.hooks.onError(frame, msg);
        }
    }

    async _load(frame, url, format) {
        const { THREE, GLTFLoader, FBXLoader, OBJLoader, STLLoader, PLYLoader } = this.libs;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`the server answered ${res.status}`);

        const manager = new THREE.LoadingManager();
        manager.setURLModifier((u) => {
            if (!u.startsWith(RES_PREFIX)) return u;
            const name = decodeURIComponent(u.slice(RES_PREFIX.length));
            return (this.hooks.resolveResource && this.hooks.resolveResource(name, frame)) || u;
        });

        if (format === "obj") {
            const group = new OBJLoader(manager).parse(await res.text());
            return { object: group, animations: [] };
        }
        const buffer = await res.arrayBuffer();
        if (format === "glb" || format === "gltf") {
            const gltf = await new GLTFLoader(manager).parseAsync(buffer, RES_PREFIX);
            gltf.scene.traverse((c) => {
                // A GLB without normals (Save 3D Model writes none unless the mesh
                // has them) is shaded flat, as glTF requires and ComfyUI shows it.
                if (c.isSkinnedMesh) c.frustumCulled = false;
            });
            return { object: gltf.scene, animations: gltf.animations || [] };
        }
        if (format === "fbx") {
            const fbx = new FBXLoader(manager).parse(buffer, RES_PREFIX);
            fbx.traverse((c) => { if (c.isSkinnedMesh) c.frustumCulled = false; });
            return { object: fbx, animations: fbx.animations || [] };
        }
        if (format === "stl") {
            const geom = new STLLoader(manager).parse(buffer);
            geom.computeVertexNormals();
            const group = new THREE.Group();
            group.add(new THREE.Mesh(geom, this.materials.plain));
            return { object: group, animations: [] };
        }
        if (format === "ply") {
            const geom = new PLYLoader(manager).parse(buffer);
            const group = new THREE.Group();
            const colors = !!geom.getAttribute("color");
            if (geom.index) {
                if (!geom.getAttribute("normal")) geom.computeVertexNormals();
                const mat = colors
                    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })
                    : this.materials.plain;
                group.add(new THREE.Mesh(geom, mat));
            } else {
                // A point cloud. Point size follows the cloud's extent.
                geom.computeBoundingBox();
                const size = geom.boundingBox.getSize(new THREE.Vector3()).length() || 1;
                group.add(new THREE.Points(geom, new THREE.PointsMaterial({
                    size: size / 200, vertexColors: colors, color: colors ? 0xffffff : 0xcccccc,
                })));
            }
            return { object: group, animations: [] };
        }
        throw new Error(`.${format} files can't be shown`);
    }

    _setModel(object, animations) {
        const { THREE } = this.libs;
        this._clearModel();
        this.model = object;
        this.scene.add(object);

        this._originals.clear();
        let vertices = 0, triangles = 0, points = 0, meshes = 0;
        object.traverse((c) => {
            if (c.isMesh) {
                this._originals.set(c, c.material);
                meshes++;
                const pos = c.geometry && c.geometry.getAttribute("position");
                if (pos) {
                    vertices += pos.count;
                    triangles += Math.floor((c.geometry.index ? c.geometry.index.count : pos.count) / 3);
                }
            } else if (c.isPoints) {
                const pos = c.geometry && c.geometry.getAttribute("position");
                if (pos) points += pos.count;
            }
        });
        this.stats = { vertices, triangles, points, meshes, format: modelFormatOf(this.frame) };

        if (animations && animations.length) {
            this._mixer = new THREE.AnimationMixer(object);
            this._mixer.clipAction(animations[0]).play();
            this._playing = true;
            this.stats.animations = animations.length;
        }
        this.setMaterialMode(this.materialMode);
        this.resetView();
        this._syncToolbar();
    }

    _clearModel() {
        if (this._mixer) {
            this._mixer.stopAllAction();
            this._mixer = null;
        }
        this._playing = false;
        if (this.model) {
            this.scene.remove(this.model);
            this._disposeObject(this.model);
        }
        this.model = null;
        this.stats = null;
        this._originals.clear();
        this._syncToolbar();
    }

    /**
     * A stand-in object spanning everything in the scene that has geometry, so
     * resetView can frame the lot. resetView measures with Box3.setFromObject,
     * which reads geometry — hence a box mesh rather than an empty group.
     */
    _sceneBoundsSubject() {
        const { THREE } = this.libs;
        const box = new THREE.Box3();
        let any = false;
        for (const entry of this._entries.values()) {
            if (!entry.object) continue;
            box.expandByObject(entry.root);
            any = true;
        }
        if (!any || box.isEmpty()) return null;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(
            Math.max(size.x, 1e-6), Math.max(size.y, 1e-6), Math.max(size.z, 1e-6)));
        mesh.position.copy(center);
        mesh.updateMatrixWorld(true);
        return mesh;
    }

    _disposeObject(object) {
        const shared = new Set(Object.values(this.materials || {}));
        object.traverse((c) => {
            if (c.geometry) c.geometry.dispose();
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            for (const m of mats) {
                if (!m || shared.has(m)) continue;
                for (const v of Object.values(m)) {
                    if (v && v.isTexture) v.dispose();
                }
                m.dispose();
            }
        });
    }

    // ── View controls ────────────────────────────────────────────────────────

    /** Frame the model the way ComfyUI's CameraManager.setupForModel does. */
    resetView(subject) {
        if (!this.libs) return;
        const { THREE } = this.libs;
        const box = new THREE.Box3();
        const target = subject || this.model || this._sceneBoundsSubject();
        if (target) box.setFromObject(target);
        if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const distance = (Math.max(size.x, size.z) || maxDim) * 2;

        const cam = this.activeCameraObject();
        cam.near = Math.min(0.01, maxDim / 1000);
        cam.far = Math.max(10000, maxDim * 100);
        cam.position.set(center.x + distance, center.y + maxDim, center.z + distance);
        cam.lookAt(center);
        cam.updateProjectionMatrix();
        // Reframing through a scene camera moves that camera, so the scene has
        // to hear about it.
        if (cam !== this.camera && this.hooks.onCameraMoved) {
            this.hooks.onCameraMoved(this.scene3d.activeCamera, this.readTransform(cam));
        }

        // ComfyUI's grid is a fixed 20 units. Scaled by powers of ten here, so a
        // model in millimetres or kilometres still sits on a readable grid.
        const scale = Math.pow(10, Math.round(Math.log10(maxDim / 5)));
        this.grid.scale.setScalar(Number.isFinite(scale) && scale > 0 ? scale : 1);

        this._target = center.clone();
        if (this.controls) {
            this.controls.target.copy(center);
            this.controls.update();
        }
        this.requestRender();
    }

    setMaterialMode(mode) {
        this.materialMode = MATERIAL_MODES.some(([v]) => v === mode) ? mode : "original";
        for (const [mesh, original] of this._originals) {
            mesh.material = this.materialMode === "original"
                ? original : this.materials[this.materialMode];
        }
        this._syncToolbar();
        this.requestRender();
    }

    setGrid(on) {
        this.showGrid = !!on;
        if (this.grid) this.grid.visible = this.showGrid;
        this._syncToolbar();
        this.requestRender();
    }

    setAnimationPlaying(on) {
        this._playing = !!(on && this._mixer);
        if (this.clock) this.clock.getDelta();
        this._syncToolbar();
        this.requestRender();
    }

    /** The viewer's exposure (EV) and channel filter, applied to the render. */
    setLook(ev, channelFilter) {
        this.exposure = Math.pow(2, Number.isFinite(ev) ? ev : 0);
        this.channelFilter = channelFilter || "";
        if (this.renderer) this.renderer.toneMappingExposure = this.exposure;
        if (this.canvas) this.canvas.style.filter = this.channelFilter;
        this.requestRender();
    }

    // ── Previz scene ─────────────────────────────────────────────────────────
    //
    // setScene is a reconcile, not a rebuild: items already on screen keep
    // their loaded geometry, new ones are fetched, removed ones are disposed.
    // That is what lets the outliner, the gizmo and the timeline all just hand
    // the scene back after every edit.

    async setScene(scene, frame = this.sceneFrame) {
        await this.ensure();
        this.scene3d = scene;
        this.sceneFrame = frame;

        const wanted = new Set();
        const pending = [];
        for (const item of scene.items || []) {
            wanted.add(item.id);
            const entry = this._entries.get(item.id);
            if (!entry) {
                pending.push(this._addEntry(item));
                continue;
            }
            entry.item = item;
            // A model whose file changed is reloaded; everything else is a
            // transform, which applyFrame picks up.
            if (item.kind === "model" && entry.key !== this._srcKey(item.src)) {
                this._disposeEntry(entry, false);
                pending.push(this._loadEntry(entry, item));
            }
        }
        for (const [id, entry] of [...this._entries]) {
            if (wanted.has(id)) continue;
            this._disposeEntry(entry, true);
            this._entries.delete(id);
        }

        this.applyFrame(frame);
        this._syncSelection();
        this.requestRender();
        await Promise.all(pending);
        this.applyFrame(this.sceneFrame);
        this._updateSceneStats();
        this.requestRender();
    }

    _srcKey(src) {
        if (!src) return "";
        return src.path || src.url || [src.type, src.subfolder, src.filename].filter(Boolean).join("/");
    }

    async _addEntry(item) {
        const { THREE } = this.libs;
        // A camera IS its own root, so the gizmo and the orbit controls move the
        // camera itself and its transform is the one the scene stores.
        const root = item.kind === "camera"
            ? new THREE.PerspectiveCamera(item.fov || 35, this._aspect(), 0.1, 10000)
            : new THREE.Group();
        root.name = item.name;
        root.userData.bepicItemId = item.id;
        this.scene.add(root);
        const entry = { item, root, key: "", mixer: null, clips: [], camera: null, helper: null, stats: null };
        this._entries.set(item.id, entry);

        if (item.kind === "camera") {
            entry.camera = root;
            // Every camera but the one being looked through is drawn as its own
            // frustum, so a shot can be lined up from outside it — and clicked.
            entry.helper = new THREE.CameraHelper(root);
            entry.helper.userData.bepicItemId = item.id;
            this.scene.add(entry.helper);
            return entry;
        }
        await this._loadEntry(entry, item);
        return entry;
    }

    async _loadEntry(entry, item) {
        const url = this.hooks.srcUrl && this.hooks.srcUrl(item.src);
        entry.key = this._srcKey(item.src);
        if (!url) return entry;
        const format = modelFormatOf(item.src) || "glb";
        try {
            const loaded = await this._load(item.src, url, format);
            // The scene may have moved on while this was in flight.
            if (!this._entries.has(item.id)) { this._disposeObject(loaded.object); return entry; }
            entry.root.add(loaded.object);
            entry.object = loaded.object;
            entry.stats = this._statsOf(loaded.object, format);
            loaded.object.traverse((c) => { if (c.isMesh) this._originals.set(c, c.material); });
            if (loaded.animations && loaded.animations.length) {
                const { THREE } = this.libs;
                entry.mixer = new THREE.AnimationMixer(loaded.object);
                entry.clips = loaded.animations;
                entry.mixer.clipAction(loaded.animations[0]).play();
            }
            this.setMaterialMode(this.materialMode);
        } catch (e) {
            console.warn(`[bEpicViewer] could not load ${item.name}`, e);
            entry.error = (e && e.message) || String(e);
            if (this.hooks.onError) this.hooks.onError(item.src, entry.error);
        }
        return entry;
    }

    _disposeEntry(entry, full) {
        if (entry.mixer) { entry.mixer.stopAllAction(); entry.mixer = null; }
        if (entry.object) {
            entry.root.remove(entry.object);
            this._disposeObject(entry.object);
            for (const mesh of [...this._originals.keys()]) {
                if (!mesh.parent) this._originals.delete(mesh);
            }
            entry.object = null;
            entry.stats = null;
        }
        if (!full) return;
        if (entry.helper) { this.scene.remove(entry.helper); entry.helper.dispose(); entry.helper = null; }
        if (this.gizmo && this.gizmo.object === entry.root) this.gizmo.detach();
        this.scene.remove(entry.root);
    }

    _aspect() {
        const w = this.root ? this.root.clientWidth : 1;
        const h = this.root ? this.root.clientHeight : 1;
        return (w && h) ? w / h : 1;
    }

    /** Place every item as it stands at `frame`, animation included. */
    applyFrame(frame) {
        if (!this.scene3d || !this.libs) return;
        this.sceneFrame = frame;
        const { THREE } = this.libs;
        const D = Math.PI / 180;
        const activeId = this.scene3d.activeCamera;
        const fps = this.scene3d.fps || 24;
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (!entry) continue;
            const at = evaluate(item, frame);
            entry.root.position.set(...at.position);
            entry.root.rotation.set(at.rotation[0] * D, at.rotation[1] * D, at.rotation[2] * D);
            entry.root.scale.set(...at.scale);
            entry.root.visible = item.visible !== false;
            if (entry.camera) {
                entry.camera.fov = at.fov || 35;
                entry.camera.aspect = this._aspect();
                entry.camera.updateProjectionMatrix();
                // Drawing the camera you are looking through would put its own
                // frustum lines across the shot.
                const active = item.id === activeId;
                if (entry.helper) {
                    entry.helper.visible = !active && item.visible !== false;
                    entry.helper.update();
                }
            }
            // Clips are scrubbed, not played, so a frame always looks the same
            // whether it was reached by playing or by dragging the timeline.
            if (entry.mixer) entry.mixer.setTime(Math.max(0, frame / fps));
        }
        if (this.gizmo && this.gizmo.object) this.gizmo.updateMatrixWorld();
        this.requestRender();
    }

    _statsOf(object, format) {
        let vertices = 0, triangles = 0, points = 0, meshes = 0;
        object.traverse((c) => {
            if (c.isMesh) {
                meshes++;
                const pos = c.geometry && c.geometry.getAttribute("position");
                if (pos) {
                    vertices += pos.count;
                    triangles += Math.floor((c.geometry.index ? c.geometry.index.count : pos.count) / 3);
                }
            } else if (c.isPoints) {
                const pos = c.geometry && c.geometry.getAttribute("position");
                if (pos) points += pos.count;
            }
        });
        return { vertices, triangles, points, meshes, format };
    }

    _updateSceneStats() {
        if (!this.scene3d) return;
        const total = { vertices: 0, triangles: 0, points: 0, meshes: 0, objects: 0, cameras: 0, format: "scene" };
        for (const entry of this._entries.values()) {
            if (entry.camera) { total.cameras++; continue; }
            total.objects++;
            if (!entry.stats) continue;
            total.vertices += entry.stats.vertices;
            total.triangles += entry.stats.triangles;
            total.points += entry.stats.points;
            total.meshes += entry.stats.meshes;
        }
        this.stats = total;
        if (this.hooks.onLoaded) this.hooks.onLoaded(null, total);
    }

    // ── Selection and the gizmo ──────────────────────────────────────────────

    select(id) {
        this.selected = id || null;
        this._syncSelection();
        this.requestRender();
    }

    setGizmoMode(mode) {
        this.gizmoMode = ["translate", "rotate", "scale"].includes(mode) ? mode : "translate";
        if (this.gizmo) this.gizmo.setMode(this.gizmoMode);
        this.requestRender();
    }

    _ensureGizmo() {
        if (this.gizmo || !this.libs || !this.renderer) return;
        const { TransformControls } = this.libs;
        const gizmo = new TransformControls(this.activeCameraObject(), this.canvas);
        gizmo.setMode(this.gizmoMode);
        gizmo.addEventListener("change", () => this.requestRender());
        // The orbit controls and the gizmo both want the drag; the gizmo wins
        // while one of its handles is held.
        gizmo.addEventListener("dragging-changed", (e) => {
            if (this.controls) this.controls.enabled = !e.value;
            if (!e.value && this.hooks.onTransformEnd) this.hooks.onTransformEnd(this.selected);
        });
        gizmo.addEventListener("objectChange", () => {
            const entry = this.selected && this._entries.get(this.selected);
            if (entry && this.hooks.onTransform) this.hooks.onTransform(this.selected, this.readTransform(entry.root));
            if (entry && entry.helper) entry.helper.update();
            this.requestRender();
        });
        const helper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
        helper.name = "GizmoTransformControls";
        this.scene.add(helper);
        this.gizmo = gizmo;
        this.gizmoHelper = helper;
    }

    _syncSelection() {
        const entry = this.selected ? this._entries.get(this.selected) : null;
        // No scene, or nothing selected: no gizmo to show.
        if (!entry || !this.scene3d) {
            if (this.gizmo) this.gizmo.detach();
            return;
        }
        this._ensureGizmo();
        if (!this.gizmo) return;
        this.gizmo.camera = this.activeCameraObject();
        // You cannot drag the camera you are looking through — there would be
        // no handles on screen to grab.
        if (entry.item.kind === "camera" && entry.item.id === this.scene3d.activeCamera) this.gizmo.detach();
        else this.gizmo.attach(entry.root);
    }

    /** The transform of a three object, in the scene's own units (degrees). */
    readTransform(object) {
        const R = 180 / Math.PI;
        return {
            position: object.position.toArray(),
            rotation: [object.rotation.x * R, object.rotation.y * R, object.rotation.z * R],
            scale: object.scale.toArray(),
        };
    }

    /** Where the free camera is now — for "add a camera from this view". */
    viewTransform() {
        const R = 180 / Math.PI;
        const cam = this.activeCameraObject();
        return {
            position: cam.position.toArray(),
            rotation: [cam.rotation.x * R, cam.rotation.y * R, cam.rotation.z * R],
            fov: cam.isPerspectiveCamera ? cam.fov : 35,
        };
    }

    /**
     * Look through a scene camera (or the free one when `id` is null). Orbiting
     * then drives that camera, and every move is reported so the scene keeps it.
     */
    setActiveCamera(id) {
        if (!this.scene3d) return;
        this.scene3d.activeCamera = id || null;
        const cam = this.activeCameraObject();
        if (this.controls) {
            this.controls.object = cam;
            // Looking through a camera, the orbit pivot sits in front of it, so
            // dragging turns the shot rather than swinging it around the origin.
            if (id) {
                const dir = new this.libs.THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new this.libs.THREE.Quaternion()));
                const at = cam.getWorldPosition(new this.libs.THREE.Vector3()).add(dir.multiplyScalar(5));
                this.controls.target.copy(at);
            }
            this.controls.update();
        }
        this.applyFrame(this.sceneFrame);
        this._syncSelection();
        this.requestRender();
    }

    /** Frame the selected item, or the whole scene when nothing is selected. */
    frameSelected() {
        const entry = this.selected ? this._entries.get(this.selected) : null;
        this.resetView(entry && entry.object ? entry.root : null);
    }

    // ── Thumbnail ────────────────────────────────────────────────────────────

    _captureThumbnailSoon(frame, id) {
        if (!this.hooks.onThumbnail) return;
        this.win.setTimeout(() => {
            if (id !== this._loadId || !this.renderer || !this.visible) return;
            const url = this.captureThumbnail(256);
            if (url) this.hooks.onThumbnail(frame, url);
        }, 300);
    }

    /** A square PNG data URL of the current view, `size` px wide. */
    captureThumbnail(size = 256) {
        if (!this.renderer) return null;
        try {
            this.renderer.render(this.scene, this.camera);
            const src = this.canvas;
            const out = this.doc.createElement("canvas");
            out.width = out.height = size;
            const ctx = out.getContext("2d");
            ctx.fillStyle = "#" + String(setting("Comfy.Load3D.BackgroundColor", "282828")).replace(/^#/, "");
            ctx.fillRect(0, 0, size, size);
            // Centre square crop of the viewport.
            const side = Math.min(src.width, src.height);
            ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
            return out.toDataURL("image/png");
        } catch (e) {
            return null;
        }
    }

    dispose() {
        this._loadId++;
        for (const [id, entry] of [...this._entries]) { this._disposeEntry(entry, true); this._entries.delete(id); }
        if (this.gizmo) { this.gizmo.dispose(); this.gizmo = null; }
        if (this.model) this._clearModel();
        this._disposeRenderer();
        if (this.materials) Object.values(this.materials).forEach((m) => m.dispose());
        if (this.root) this.root.remove();
        this.root = null;
    }
}
