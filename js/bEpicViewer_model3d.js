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

let _libsPromise = null;

function loadLibs() {
    if (!_libsPromise) {
        const base = api.apiURL("/bepic/lib/three/");
        const load = (name) => import(base + name);
        _libsPromise = Promise.all([
            load("three.module.min.js"), load("OrbitControls.js"), load("GLTFLoader.js"),
            load("FBXLoader.js"), load("OBJLoader.js"), load("STLLoader.js"), load("PLYLoader.js"),
        ]).then(([THREE, orbit, gltf, fbx, obj, stl, ply]) => ({
            THREE,
            OrbitControls: orbit.OrbitControls,
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

        const controls = new OrbitControls(this.camera, canvas);
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
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.requestRender();
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
        if (this._mixer && this._playing) {
            this._mixer.update(dt);
            again = true;
        }
        // update() reports whether damping moved the camera; keep going until
        // it has settled.
        if (this.controls && this.controls.update(dt)) again = true;
        this.renderer.render(this.scene, this.camera);
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
                // Save 3D Model writes no normals unless the mesh carries them;
                // ComfyUI's viewer computes them, so a bare mesh shades smoothly.
                if (c.isMesh && c.geometry && !c.geometry.getAttribute("normal")) {
                    c.geometry.computeVertexNormals();
                }
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
                    size: size / 500, vertexColors: colors, color: colors ? 0xffffff : 0xcccccc,
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
    resetView() {
        if (!this.libs) return;
        const { THREE } = this.libs;
        const box = new THREE.Box3();
        if (this.model) box.setFromObject(this.model);
        if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const distance = (Math.max(size.x, size.z) || maxDim) * 2;

        this.camera.near = Math.min(0.01, maxDim / 1000);
        this.camera.far = Math.max(10000, maxDim * 100);
        this.camera.position.set(center.x + distance, center.y + maxDim, center.z + distance);
        this.camera.lookAt(center);
        this.camera.updateProjectionMatrix();

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
        if (this.model) this._clearModel();
        this._disposeRenderer();
        if (this.materials) Object.values(this.materials).forEach((m) => m.dispose());
        if (this.root) this.root.remove();
        this.root = null;
    }
}
