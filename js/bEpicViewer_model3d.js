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
import { evaluate, cameraResolution, offsetOf, planeSettings } from "./bEpicViewer_scene3d.js";
import { WorldViewMixin } from "./bEpicViewer_world3d.js";
import { WorldMatchMixin } from "./bEpicViewer_worldMatch.js";

let _libsPromise = null;

function loadLibs() {
    if (!_libsPromise) {
        const base = api.apiURL("/bepic/lib/three/");
        const load = (name) => import(base + name);
        _libsPromise = Promise.all([
            load("three.module.js"), load("OrbitControls.js"), load("GLTFLoader.js"),
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

// Gaussian splats: drawn by Spark (World Labs, MIT; vendor/three/spark.module.js),
// fetched the first time a scene has one. A .ply can be either a splat or a
// mesh / point cloud; its header decides (isSplatPly).
let _sparkPromise = null;
function loadSpark() {
    if (!_sparkPromise) {
        _sparkPromise = import(api.apiURL("/bepic/lib/three/spark.module.js"))
            .catch((e) => { _sparkPromise = null; throw e; });
    }
    return _sparkPromise;
}

export const SPLAT_FORMATS = ["spz", "splat", "ksplat", "sog"];
export const MODEL_FORMATS = ["glb", "gltf", "fbx", "obj", "stl", "ply",
                               "usd", "usda", "usdc", "usdz", "abc", ...SPLAT_FORMATS];
const _MODEL_RE = /\.(glb|gltf|fbx|obj|stl|ply|usda|usdc|usdz|usd|abc|spz|splat|ksplat|sog)$/i;

/**
 * Whether a .ply holds Gaussian splats rather than a mesh or a point cloud:
 * its vertices carry a scale and a rotation per point — the rule ComfyUI's own
 * 3D viewer uses (isGaussianSplatPLY), so a file opens the same way in both.
 */
export function isSplatPly(buffer) {
    const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
    const text = new TextDecoder("latin1").decode(head);
    const end = text.indexOf("end_header");
    if (!text.startsWith("ply") || end < 0) return false;
    const props = new Set();
    let inVertex = false;
    for (const line of text.slice(0, end).split(/\r?\n/)) {
        const w = line.trim().split(/\s+/);
        if (w[0] === "element") inVertex = w[1] === "vertex";
        else if (w[0] === "property" && inVertex) props.add(w[w.length - 1]);
    }
    return ["scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"].every((p) => props.has(p));
}

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
        this.stats = null;
        this.materialMode = "original";
        this.showGrid = !!setting("Comfy.Load3D.ShowGrid", true);
        this.exposure = 1;
        this.channelFilter = "";
        this._loadId = 0;
        this._raf = 0;
        this._originals = new Map();
        // Previz scene: item id -> { item, root, key, mixer, clips, camera, helper }
        this._entries = new Map();
        this.scene3d = null;          // the scene data this view is showing
        this.sceneFrame = 0;          // where the timeline is (frames, not a media frame)
        this.selected = null;
        this._thumbId = 0;
        this.gizmoMode = "translate";
        // Local by default: a shape you have turned should move along its own
        // axes, which is what "forward" means once something is placed.
        this.gizmoSpace = "local";
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

        // Two rows, at the top of the canvas beside the scene's own read-out:
        // what the view looks like, then what the mouse does in it.
        const bar = el("div", "model-toolbar");
        const look = el("div", "model-toolbar-row");
        const tools = el("div", "model-toolbar-row");
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

        // The two previz panels are toggled from here rather than from the
        // playback bar: they describe this canvas, and there is nothing they
        // can say about a picture.
        const panelBtn = el("button", "model-btn model-panel-btn", "▣");
        panelBtn.title = "Show / hide the Previz panel";
        panelBtn.onclick = () => { if (this.hooks.onPanelToggle) this.hooks.onPanelToggle("previz"); };
        if (this.hooks.setIcon) this.hooks.setIcon(panelBtn, "icon-previz");

        const curvesBtn = el("button", "model-btn model-panel-btn", "∿");
        curvesBtn.title = "Show / hide the Animation Curves";
        curvesBtn.onclick = () => { if (this.hooks.onPanelToggle) this.hooks.onPanelToggle("curves"); };
        if (this.hooks.setIcon) this.hooks.setIcon(curvesBtn, "icon-curves");

        const channelsBtn = el("button", "model-btn model-panel-btn", "≡");
        channelsBtn.title = "Show / hide the Channel Box";
        channelsBtn.onclick = () => { if (this.hooks.onPanelToggle) this.hooks.onPanelToggle("channels"); };
        if (this.hooks.setIcon) this.hooks.setIcon(channelsBtn, "icon-channelbox");

        look.append(modeSel, gridBtn, resetBtn, panelBtn, channelsBtn, curvesBtn);

        // The gizmo tools. They used to sit in the previz panel, a rail away
        // from the object they act on; here they are over the canvas, beside
        // the view controls, and they follow the same keys (W / E / R / X).
        const toolBtns = {};
        for (const [mode, label, key, icon] of [
            ["translate", "Move", "W", "icon-move"],
            ["rotate", "Rotate", "E", "icon-rotate3d"],
            ["scale", "Scale", "R", "icon-scale3d"],
        ]) {
            const b = el("button", "model-btn model-icon-btn", label);
            b.title = `${label} the selected item (${key})`;
            b.onclick = () => this.setGizmoMode(mode);
            if (this.hooks.setIcon) this.hooks.setIcon(b, icon);
            toolBtns[mode] = b;
            tools.append(b);
        }
        const spaceBtn = el("button", "model-btn model-icon-btn", "World");
        spaceBtn.onclick = () => this.setGizmoSpace(this.gizmoSpace === "local" ? "world" : "local");
        tools.append(spaceBtn);

        bar.append(look, tools);
        const status = el("div", "model-status");

        // The resolution gate: the picture the camera you are looking through
        // actually takes, with the rest of the view dimmed around it — Maya's
        // gate mask. Four shades and a frame; none of it takes the mouse.
        const gate = el("div", "model-gate");
        const shades = ["top", "bottom", "left", "right"].map((side) => {
            const n = el("div", `model-gate-shade ${side}`);
            gate.append(n);
            return n;
        });
        const gateFrame = el("div", "model-gate-frame");
        const gateLabel = el("div", "model-gate-label");
        gateFrame.append(gateLabel);
        gate.append(gateFrame);

        root.append(gate, bar, status);
        this.root = root;
        this.ui = { modeSel, gridBtn, resetBtn, panelBtn, channelsBtn, curvesBtn, toolBtns, spaceBtn, status,
                    gate, shades, gateFrame, gateLabel };
        this._syncToolbar();
        this.host.appendChild(root);
    }

    _syncToolbar() {
        if (!this.ui) return;
        this.ui.modeSel.value = this.materialMode;
        this.ui.gridBtn.classList.toggle("active", this.showGrid);
        for (const [mode, btn] of Object.entries(this.ui.toolBtns || {})) {
            btn.classList.toggle("active", mode === this.gizmoMode);
        }
        const space = this.ui.spaceBtn;
        if (space) {
            const local = this.gizmoSpace === "local";
            space.textContent = local ? "Local" : "World";
            space.classList.toggle("active", local);
            space.title = local
                ? "Gizmo axes: the item's own — click for the world's (X)"
                : "Gizmo axes: the world's — click for the item's own (X)";
            if (this.hooks.setIcon) this.hooks.setIcon(space, local ? "icon-globe-off" : "icon-globe");
        }
    }

    /** Light the panel buttons from the dock, which is what actually knows. */
    setPanelStates(states) {
        if (!this.ui) return;
        this.ui.panelBtn.classList.toggle("active", !!(states && states.previz));
        this.ui.curvesBtn.classList.toggle("active", !!(states && states.curves));
        if (this.ui.channelsBtn) this.ui.channelsBtn.classList.toggle("active", !!(states && states.channels));
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

        // alpha: a render can be asked for with a transparent background. The
        // clear colour is opaque otherwise, so the view looks the same.
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
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
        this._ensureSpark();               // splats already in the scene need one for this renderer

        // Alt+RMB is a navigation drag, not a place to open a menu.
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        // Capture phase: the orbit controls also listen for pointerdown, and
        // which of them may have the drag is decided here first.
        canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e), true);
        canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
        canvas.addEventListener("pointermove", (e) => this._tumbleMove(e));
        canvas.addEventListener("pointercancel", (e) => this._tumbleEnd(e));
        // Alt can be pressed or let go while the pointer just sits there.
        canvas.addEventListener("pointermove", (e) => {
            if (!!e.altKey !== this.root.classList.contains("navigating")) this._applyNavButtons(e.altKey);
        });

        const controls = new OrbitControls(this.activeCameraObject(), canvas);
        controls.enableDamping = true;
        if (this._target) controls.target.copy(this._target);
        // Navigating while looking through a scene camera IS moving that camera.
        // The scene takes every step of it (`live`, so the panel's numbers
        // follow the tumble) and the full update — panel, node widget, saved
        // state — lands once the drag ends.
        const reportCamera = (live) => {
            const id = this.scene3d && this.scene3d.activeCamera;
            if (!id || !this.hooks.onCameraMoved) return;
            const entry = this._entries.get(id);
            this.hooks.onCameraMoved(id, this.readTransform(this.activeCameraObject(),
                                                            entry && entry.item), live);
        };
        this._reportCamera = reportCamera;
        controls.addEventListener("change", () => {
            if (this._navigating) reportCamera(true);
            this.requestRender();
        });
        controls.addEventListener("start", () => { this._navigating = true; });
        controls.addEventListener("end", () => {
            this._navigating = false;
            reportCamera(false);
        });
        controls.update();
        this.controls = controls;
        this._applyNavButtons(false);

        const RO = this.win.ResizeObserver;
        if (RO) {
            this._ro = new RO(() => this._resize());
            this._ro.observe(this.root);
        }
        this._resize();
    }

    /**
     * Maya's navigation: nothing moves the camera unless Alt is held, and then
     *   Alt + left   tumbles (orbit)
     *   Alt + middle tracks  (pan)
     *   Alt + right  dollies (zoom)
     * The wheel always zooms, as it does everywhere.
     *
     * With Alt up, the left button belongs to the scene — picking an object and
     * dragging the gizmo — so orbiting is Alt+left, as in Maya. Every 3D tab is
     * a scene, so there is no second mapping to remember.
     */
    _applyNavButtons(alt) {
        // Alt is the navigation modifier, so it is also what turns the pointer
        // into a hand; without it the pointer picks and drags like any other.
        if (this.root) this.root.classList.toggle("navigating", !!alt);
        if (!this.controls || !this.libs) return;
        const { THREE } = this.libs;
        const M = THREE.MOUSE;
        if (alt) {
            // Tumbling is done here rather than by the orbit controls, which
            // can only turn around the point they look at (see _tumbleStart).
            this.controls.mouseButtons = { LEFT: null, MIDDLE: M.PAN, RIGHT: M.DOLLY };
            this.controls.enabled = true;
            return;
        }
        this.controls.mouseButtons = {
            // Nothing: the left button picks, and drags the gizmo. Orbiting is
            // Alt+left, as in Maya — the same everywhere, on one model or fifty.
            LEFT: null,
            MIDDLE: M.PAN,
            RIGHT: M.PAN,
        };
        this.controls.enabled = true;
    }

    // Click to select, drag to navigate: which one is decided by Alt, and a
    // click only counts as a pick when the pointer stayed put.
    _onPointerDown(e) {
        this._applyNavButtons(e.altKey);
        this._downAt = { x: e.clientX, y: e.clientY, button: e.button, alt: e.altKey };
        if (e.altKey && e.button === 0) this._tumbleStart(e);
    }

    // ── Tumbling about what is under the cursor ──────────────────────────────

    /**
     * Maya's "tumble on object": Alt+left turns the camera about the point of
     * the object under the cursor, so whatever you pressed on stays where it
     * is on screen while the view swings around it. Pressed on empty space, it
     * turns about the orbit centre as before.
     *
     * Orbit controls can only circle the point they look at, and making them
     * look at the object would jerk the view over to it. So the camera is
     * turned here, rigidly about the pivot: a yaw about the world's up axis and
     * a pitch about the camera's own right, both through the pivot — the view
     * never rolls. The orbit centre is moved onto the view axis at the
     * object's depth, which changes nothing on screen and means a dolly
     * afterwards heads for the object too. Works on the free camera and on
     * any scene camera you are looking through.
     */
    _tumbleStart(e) {
        if (!this.controls || !this.libs || !this.canvas) return;
        const { THREE } = this.libs;
        const cam = this.activeCameraObject();
        const hit = this._surfaceUnder(e);
        const pos = cam.getWorldPosition(new THREE.Vector3());
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
        let pivot;
        if (hit) {
            pivot = hit.clone();
            // The orbit centre onto the view axis, at the hit's depth: nothing
            // on screen moves, and the controls stay consistent.
            const depth = Math.max(1e-3, pivot.clone().sub(pos).dot(fwd));
            this.controls.target.copy(pos).addScaledVector(fwd, depth);
        } else {
            pivot = this.controls.target.clone();
        }
        this._tumble = { pivot, x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
        try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    }

    /** The world point of visible geometry under the pointer, or null. */
    _surfaceUnder(e) {
        const { THREE } = this.libs;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        const roots = [];
        for (const entry of this._entries.values()) {
            if (entry.object && entry.root.visible) roots.push(entry.root);
        }
        const shown = (node) => {
            for (let n = node; n; n = n.parent) if (n.visible === false) return false;
            return true;
        };
        for (const hit of ray.intersectObjects(roots, true)) {
            if ((hit.object.isMesh || hit.object.isPoints) && shown(hit.object)) return hit.point;
        }
        return null;
    }

    _tumbleMove(e) {
        const t = this._tumble;
        if (!t || e.pointerId !== t.id || !this.libs) return;
        const dx = e.clientX - t.x, dy = e.clientY - t.y;
        if (!dx && !dy) return;
        t.x = e.clientX; t.y = e.clientY;
        const { THREE } = this.libs;
        const cam = this.activeCameraObject();
        const h = Math.max(1, this.canvas.clientHeight);
        // The same rate as the orbit controls: a drag the height of the view
        // is a full turn.
        const yaw = -2 * Math.PI * dx / h * this.controls.rotateSpeed;
        let pitch = -2 * Math.PI * dy / h * this.controls.rotateSpeed;

        const up = new THREE.Vector3(0, 1, 0);
        const q = cam.quaternion;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        // Stop short of looking straight up or down, where "up" stops meaning
        // anything and the view would flip.
        const polar = Math.acos(Math.min(1, Math.max(-1, fwd.dot(up))));
        const LIMIT = 0.01;
        pitch = Math.min(Math.max(pitch, -(polar - LIMIT)), Math.PI - LIMIT - polar);
        const turn = new THREE.Quaternion().setFromAxisAngle(up, yaw)
            .multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));

        const about = (p) => p.sub(t.pivot).applyQuaternion(turn).add(t.pivot);
        about(cam.position);
        cam.quaternion.premultiply(turn);
        about(this.controls.target);
        cam.updateMatrixWorld();
        if (!t.moved) { t.moved = true; this._navigating = true; }
        if (this._reportCamera) this._reportCamera(true);
        this.requestRender();
    }

    _tumbleEnd(e) {
        const t = this._tumble;
        if (!t || (e && e.pointerId !== t.id)) return;
        this._tumble = null;
        try { this.canvas.releasePointerCapture(t.id); } catch (_) { /* gone */ }
        if (t.moved) {
            this._navigating = false;
            if (this._reportCamera) this._reportCamera(false);
        }
    }

    _onPointerUp(e) {
        this._tumbleEnd(e);
        const d = this._downAt;
        this._downAt = null;
        if (!d || d.button !== 0 || d.alt || !this.scene3d) return;
        if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) return;
        if (this.gizmo && this.gizmo.dragging) return;
        if (this._walk) return;
        const pin = this.pickFeedbackPin(e);
        if (pin && this.hooks.onPinClick) { this.hooks.onPinClick(pin); return; }
        if (this._placingNote && this.hooks.onFeedbackRequest) {
            this._placingNote = false;
            this.root.classList.remove("placing-note");
            this.hooks.onFeedbackRequest(this.worldPointAt(e), this.feedbackView());
            return;
        }
        const hit = this._pick(e);
        // Shift adds to the selection rather than replacing it — the scene's
        // own modifier, clear of Alt, which is navigation's.
        if (this.hooks.onPick) this.hooks.onPick(hit, !!e.shiftKey);
    }

    /** Why an item has nothing on screen, or "" when it is fine. */
    itemError(id) {
        const entry = this._entries.get(id);
        return (entry && entry.error) || "";
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
        // Walking is bound to this canvas and its document; a rebuilt one
        // starts standing still.
        if (this._walk) this.walkExit();
        if (this._raf && this._rafWin) {
            try { this._rafWin.cancelAnimationFrame(this._raf); } catch (e) {}
        }
        this._raf = 0;
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        // The gizmo listens on the canvas. Keeping it across a rebuild left its
        // handles bound to a canvas that no longer exists — they drew, and
        // dragging them did nothing. It is rebuilt by _syncSelection below.
        if (this.gizmo) {
            this.gizmo.detach();
            this.gizmo.dispose();
            this.gizmo = null;
        }
        if (this.gizmoHelper) {
            this.scene.remove(this.gizmoHelper);
            this.gizmoHelper = null;
        }
        // Spark's renderer belongs to the WebGL renderer it was made with; the
        // rebuilt one gets its own (_ensureSpark, from _initRenderer).
        if (this._spark) {
            this.scene.remove(this._spark);
            this._spark = null;
        }
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
        this._worldResize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        // A scene camera's lens depends on the viewport too, when you are
        // looking through it: the gate is fitted inside, and the view around it.
        for (const entry of this._entries.values()) {
            if (entry.camera) this._applyLens(entry, evaluate(entry.item, this.sceneFrame).fov);
        }
        this._syncGate();
        this.requestRender();
    }

    _sceneCameraObjects() {
        const out = [];
        for (const e of this._entries.values()) if (e.camera) out.push(e.camera);
        return out;
    }

    /**
     * Point the orbit controls and the gizmo at whatever camera the viewport is
     * rendering through.
     *
     * Binding this once, when the camera is chosen, was not enough: a camera
     * added and looked through in the same breath has no 3D object yet, so the
     * controls fell back to the free camera and stayed there — tumbling moved a
     * camera nobody was looking through, and the scene camera never changed.
     * Checked whenever the scene or the frame changes; it is an identity test.
     */
    _syncControlsCamera() {
        if (!this.controls) return;
        const cam = this.activeCameraObject();
        if (this.controls.object === cam) return;
        const target = this.controls.target.clone();
        this.controls.object = cam;
        this.controls.target.copy(target);
        this.controls.update();
        if (this.gizmo) this.gizmo.camera = cam;
    }

    /** The camera the viewport renders from: a scene camera, or the free one. */
    activeCameraObject() {
        if (this._walk) return this.camera;
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
        // Clips are not played here: the timeline owns the clock and applyFrame
        // sets each mixer to the frame, so scrubbing and playing agree.
        // update() reports whether damping moved the camera; keep going until
        // it has settled.
        if (this.controls && this.controls.enabled && this.controls.update(dt)) again = true;
        // Wind and walking run the loop for as long as they last.
        if (this._worldTick(dt)) again = true;
        this._worldRender(this.activeCameraObject());
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
        this._syncSelection();
    }

    hide() {
        if (!this.root) return;
        this.root.style.display = "none";
    }

    /**
     * Put an already-built view back on screen after hide() — coming back to a
     * 3D tab whose scene hasn't changed, so there is nothing to load. The
     * viewport may have been resized while this was hidden, and a hidden canvas
     * is never painted, so it is measured and drawn again here.
     */
    reveal() {
        if (!this.root || !this.renderer) return false;
        this.root.style.display = "block";
        this._resize();
        this.requestRender();
        return true;
    }

    get visible() {
        return !!(this.root && this.root.style.display !== "none");
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    async _load(frame, url, format) {
        const { THREE, GLTFLoader, FBXLoader, OBJLoader, STLLoader, PLYLoader } = this.libs;
        // A USD stage is composed on the server — layers, references, payloads
        // and all — and handed over as a GLB. three.js has no USD crate reader
        // (its USDCParser is a stub), so this is the only honest way to show one.
        // Both arrive as a GLB the server flattened for us.
        if (format.startsWith("usd") || format === "abc") format = "glb";
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
        if (SPLAT_FORMATS.includes(format) || (format === "ply" && isSplatPly(buffer))) {
            return this._loadSplat(buffer, frame, format);
        }
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

    /**
     * A Gaussian splat, as an ordinary object in the scene: Spark draws it
     * (one SparkRenderer per view, added with the first splat), sorted
     * together with every other splat and mixed with the meshes. Turned over
     * about X the way ComfyUI's 3D viewer turns it — splat files are mostly in
     * OpenCV's axes, Y down. A hidden box the size of the splat stands beside
     * it: framing and picking measure geometry, which a splat has none of in
     * three's sense, so the box is what they see.
     */
    async _loadSplat(buffer, frame, format) {
        const { THREE } = this.libs;
        this._sparkLib = await loadSpark();
        const { SplatMesh } = this._sparkLib;
        this._ensureSpark();
        const name = (frame && (frame.name || frame.filename || frame.path)) || `splat.${format}`;
        const splat = new SplatMesh({ fileBytes: new Uint8Array(buffer), fileName: String(name).split(/[\\/]/).pop() });
        await splat.initialized;
        splat.quaternion.set(1, 0, 0, 0);
        splat.userData.bepicSplat = true;
        const group = new THREE.Group();
        group.add(splat);
        const box = splat.getBoundingBox(false);
        if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3());
            const bounds = new THREE.Mesh(
                new THREE.BoxGeometry(Math.max(size.x, 1e-6), Math.max(size.y, 1e-6), Math.max(size.z, 1e-6)),
                new THREE.MeshBasicMaterial({ visible: false }));
            box.getCenter(bounds.position);
            bounds.position.applyQuaternion(splat.quaternion);
            bounds.quaternion.copy(splat.quaternion);
            bounds.name = "splatbounds";
            bounds.userData.bepicSplatBounds = true;
            group.add(bounds);
        }
        this.requestRender();
        return { object: group, animations: [] };
    }

    /** The view's SparkRenderer, once Spark is loaded and there is a renderer. */
    _ensureSpark() {
        if (this._spark || !this._sparkLib || !this.renderer) return;
        this._spark = new this._sparkLib.SparkRenderer({ renderer: this.renderer });
        this._spark.name = "bepic-spark";
        this.scene.add(this._spark);
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
            if (!entry.object || entry.item.kind === "scatter") continue;
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
            if (c.userData && c.userData.bepicSplat && c.dispose) { c.dispose(); return; }
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
        const target = subject || this._sceneBoundsSubject();
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
            const moved = this._entries.get(this.scene3d.activeCamera);
            this.hooks.onCameraMoved(this.scene3d.activeCamera,
                                     this.readTransform(cam, moved && moved.item));
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
        // An image plane keeps its picture: clay or normals would show
        // something that is not the picture, which is the whole point of it.
        for (const [mesh, original] of this._originals) {
            // A splat's bounds box stays unseen whatever the look.
            if (mesh.name === "imageplane" || mesh.name === "splatbounds") continue;
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

    /** The viewer's exposure (EV) and channel filter, applied to the render. */
    setLook(ev, channelFilter) {
        this.exposure = Math.pow(2, Number.isFinite(ev) ? ev : 0);
        this.channelFilter = channelFilter || "";
        if (this.renderer) this.renderer.toneMappingExposure = this.exposure;
        this._worldSyncRender();
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
            this._reparent(entry);
            // A model whose file changed is reloaded; everything else is a
            // transform, which applyFrame picks up.
            if (item.kind === "model" && entry.key !== this._srcKey(item.src)) {
                this._disposeEntry(entry, false);
                pending.push(this._loadEntry(entry, item));
            } else if (this._isWorldKind(item)) {
                // A world item rebuilds when its settings change; a scatter
                // also when the ground it grows on does.
                if (entry.key !== this._worldKey(item)) {
                    this._worldDispose(entry);
                    pending.push(this._worldBuild(entry, item));
                }
            } else if (item.kind === "primitive") {
                const type = (item.primitive && item.primitive.type) || "box";
                if (entry.key !== type) {
                    this._disposeEntry(entry, false);
                    this._buildPrimitive(entry, item);
                } else if (entry.material && entry.color !== item.color) {
                    entry.material.color.set(item.color || "#9a9a9a");
                    entry.color = item.color;
                }
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
        // Children can arrive before their parents; one pass once they are all
        // here puts every object under the right one.
        this._reparentAll();
        this._syncControlsCamera();          // the active camera's object exists now
        this.syncFeedbackPins();
        this._worldSyncStudio();
        // The world is complete: take its reflections now, not piece by piece.
        if (this._envDirty) this._worldCaptureEnv();
        this.applyFrame(this.sceneFrame);
        this._updateSceneStats();
        this._captureThumbnailSoon(this.hooks.thumbFrame && this.hooks.thumbFrame());
        this.requestRender();
    }

    _srcKey(src) {
        if (!src) return "";
        const base = src.path || src.url || [src.type, src.subfolder, src.filename].filter(Boolean).join("/");
        return src.prim ? `${base}|${src.prim}` : base;
    }

    /**
     * Geometry for a built-in shape, at unit size: a 1-unit box, a half-unit
     * radius, a 1×1 plane lying flat. Size is the item's scale, so the gizmo's
     * scale handles are the shape's size handles.
     */
    _primitiveGeometry(type) {
        const { THREE } = this.libs;
        switch (type) {
            case "sphere":   return new THREE.SphereGeometry(0.5, 32, 16);
            case "plane":    return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
            case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
            case "cone":     return new THREE.ConeGeometry(0.5, 1, 32);
            case "torus":    return new THREE.TorusGeometry(0.35, 0.15, 16, 48);
            default:         return new THREE.BoxGeometry(1, 1, 1);
        }
    }

    _buildPrimitive(entry, item) {
        const { THREE } = this.libs;
        const type = (item.primitive && item.primitive.type) || "box";
        const geometry = this._primitiveGeometry(type);
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(item.color || "#9a9a9a"),
            roughness: 0.85, metalness: 0.0,
            // A plane has no back, and a previz floor is looked at from below
            // often enough that a single-sided one reads as a hole.
            side: type === "plane" ? THREE.DoubleSide : THREE.FrontSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        const group = new THREE.Group();
        group.add(mesh);
        this._bodyOf(entry).add(group);
        entry.object = group;
        entry.material = material;
        entry.color = item.color;
        entry.key = type;
        entry.stats = this._statsOf(group, type);
        this._originals.set(mesh, material);
        return entry;
    }

    /**
     * Hang an entry's object where the item says it belongs.
     *
     * Groups and geometry are parented in three, so the engine composes the
     * matrices and moving a group moves everything under it. A camera is the
     * exception: it stays at the top of the 3D scene and gets its world
     * transform written into it (see applyFrame), because OrbitControls and
     * TransformControls both treat the camera they drive as living in world
     * space — under a moved group, tumbling would fight the parent.
     */
    _reparent(entry) {
        const item = entry.item;
        const wanted = (item.kind !== "camera" && item.parent && this._entries.get(item.parent))
            ? this._bodyOf(this._entries.get(item.parent))
            : this.scene;
        if (entry.root.parent !== wanted) wanted.add(entry.root);
    }

    /** Place every entry — after an add, or when a parent has changed. */
    _reparentAll() {
        for (const entry of this._entries.values()) this._reparent(entry);
    }

    /**
     * The matrix the item's parent imposes, or null at the top. Only a camera
     * needs it: everything else is parented, so three has already applied it.
     */
    _parentWorld(item) {
        const parent = item && item.parent ? this._entries.get(item.parent) : null;
        if (!parent) return null;
        const body = this._bodyOf(parent);
        body.updateWorldMatrix(true, false);
        return body.matrixWorld;
    }

    /**
     * Where an entry's geometry and children hang.
     *
     * An item's transform is T(position)*T(pivot)*R*S*T(-pivot) — the pivot is
     * the point it turns about — so the root carries position+pivot, R and S,
     * and everything inside it sits in a body node offset by -pivot. Children
     * go in the body too, so a parent turning about its pivot carries them
     * round with it rather than about some other point.
     */
    _bodyOf(entry) {
        return (entry && entry.inner) || (entry && entry.body) || (entry && entry.root) || null;
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
        // A camera IS its root, so it has no body to offset; nothing hangs
        // inside one anyway.
        if (item.kind !== "camera") {
            entry.body = new THREE.Group();
            entry.body.name = "body";
            root.add(entry.body);
            // Under the body sits the frozen transform (scene3d's `offset`),
            // and under that everything the item holds — geometry and
            // children alike. The body itself stays the pivot's space, which
            // is what the pivot maths reads.
            entry.inner = new THREE.Group();
            entry.inner.name = "offset";
            entry.inner.matrixAutoUpdate = false;
            entry.body.add(entry.inner);
        }
        this._entries.set(item.id, entry);
        this._reparent(entry);

        if (item.kind === "group") {
            // Something to see and to grab: a small set of axes, the size of
            // the grid's cell, shown only while the group is selected.
            const axes = new THREE.AxesHelper(0.75);
            axes.visible = false;
            axes.userData.bepicItemId = item.id;
            entry.body.add(axes);
            entry.axes = axes;
            return entry;
        }

        if (item.kind === "primitive") {
            this._buildPrimitive(entry, item);
            return entry;
        }

        if (item.kind === "imageplane") {
            await this._buildImagePlane(entry, item);
            return entry;
        }

        if (this._isWorldKind(item)) {
            await this._worldBuild(entry, item);
            return entry;
        }

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

    /**
     * An image plane: a card showing a picture.
     *
     * One unit tall and as wide as the picture is — the shape of the image is
     * the card's, so scaling the item keeps it. The picture is drawn as it is
     * (no tone mapping, no lighting) unless the item asks to be lit, which is
     * what makes it usable as a backplate behind a lit set.
     */
    async _buildImagePlane(entry, item) {
        const { THREE } = this.libs;
        const url = this.hooks.srcUrl && this.hooks.srcUrl(item.src);
        entry.key = this._srcKey(item.src);
        const opts = planeSettings(item);
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: opts.opacity,
            side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
            toneMapped: !!opts.lit, depthWrite: opts.opacity >= 1,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.bepicItemId = item.id;
        mesh.name = "imageplane";
        this._bodyOf(entry).add(mesh);
        entry.object = mesh;
        entry.plane = mesh;
        entry.stats = { meshes: 1, vertices: 4, triangles: 2 };
        if (!url) {
            entry.error = "this image plane has no picture to show";
            return entry;
        }
        try {
            const texture = await this._loadTexture(url);
            if (!this._entries.has(item.id)) { texture.dispose(); return entry; }
            texture.colorSpace = THREE.SRGBColorSpace;
            material.map = texture;
            material.needsUpdate = true;
            const w = texture.image && (texture.image.width || texture.image.videoWidth) || 1;
            const h = texture.image && (texture.image.height || texture.image.videoHeight) || 1;
            // The card takes the picture's shape: a unit tall, as wide as it is.
            mesh.scale.set(w / h, 1, 1);
            entry.error = "";
        } catch (e) {
            entry.error = (e && e.message) || "that picture could not be loaded";
        }
        this.requestRender();
        return entry;
    }

    _loadTexture(url) {
        const { THREE } = this.libs;
        return new Promise((resolve, reject) => {
            new THREE.TextureLoader().load(
                url, resolve, undefined,
                () => reject(new Error("that picture could not be loaded")));
        });
    }

    /** Re-read an image plane's own settings (opacity, lighting, sides). */
    syncImagePlane(item) {
        const entry = this._entries.get(item.id);
        const mesh = entry && entry.plane;
        if (!mesh) return;
        const { THREE } = this.libs;
        const opts = planeSettings(item);
        mesh.material.opacity = opts.opacity;
        mesh.material.transparent = true;
        mesh.material.depthWrite = opts.opacity >= 1;
        mesh.material.side = opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
        mesh.material.toneMapped = !!opts.lit;
        mesh.material.needsUpdate = true;
        this.requestRender();
    }

    /** True for an item whose geometry is a cache: one shape per frame. */
    _isCache(item) {
        const src = (item && item.src) || null;
        if (!src) return false;
        return String(src.format || "").toLowerCase() === "abc"
            || /\.abc$/i.test(String(src.path || src.name || ""));
    }

    /**
     * The URL an item's geometry comes from. A cache names the frame it is
     * wanted at; everything else is the same file whatever the playhead says.
     */
    _srcUrlFor(item) {
        if (!this.hooks.srcUrl || !item.src) return null;
        if (!this._isCache(item)) return this.hooks.srcUrl(item.src);
        const frame = Math.max(0, Math.round(this.sceneFrame || 0));
        return this.hooks.srcUrl({ ...item.src, frame });
    }

    /**
     * Re-read a cache's geometry for the frame now showing.
     *
     * Coalesced, because scrubbing walks a lot of frames and each one is a
     * request and a parse; the server keeps the frames it has already built,
     * so a second pass over the same range is quick.
     */
    _queueCacheReload(entry, item) {
        const frames = this._cacheReload || (this._cacheReload = new Map());
        frames.set(item.id, item);
        if (this._cacheTimer) this.win.clearTimeout(this._cacheTimer);
        this._cacheTimer = this.win.setTimeout(async () => {
            this._cacheTimer = null;
            const wanted = [...frames.values()];
            frames.clear();
            for (const one of wanted) {
                const e = this._entries.get(one.id);
                if (!e || e.cacheFrame === Math.round(this.sceneFrame || 0)) continue;
                if (e.object) {
                    this._bodyOf(e).remove(e.object);
                    this._disposeObject(e.object);
                    e.object = null;
                }
                await this._loadEntry(e, one);
            }
            this.applyFrame(this.sceneFrame);
        }, 140);
    }

    async _loadEntry(entry, item) {
        const url = this._srcUrlFor(item);
        entry.key = this._srcKey(item.src);
        entry.cacheFrame = this._isCache(item) ? Math.max(0, Math.round(this.sceneFrame || 0)) : null;
        if (!url) return entry;
        const format = modelFormatOf(item.src) || "glb";
        try {
            const loaded = await this._load(item.src, url, format);
            // The scene may have moved on while this was in flight.
            if (!this._entries.has(item.id)) { this._disposeObject(loaded.object); return entry; }
            this._bodyOf(entry).add(loaded.object);
            entry.object = loaded.object;
            entry.stats = this._statsOf(loaded.object, format);
            loaded.object.traverse((c) => { if (c.isMesh) this._originals.set(c, c.material); });
            if (loaded.animations && loaded.animations.length) {
                const { THREE } = this.libs;
                entry.mixer = new THREE.AnimationMixer(loaded.object);
                entry.clips = loaded.animations;
                entry.mixer.clipAction(loaded.animations[0]).play();
                // A clip has a length of its own, and the timeline is what plays
                // it now: the shot is told, and decides whether to grow.
                const fps = (this.scene3d && this.scene3d.fps) || 24;
                const frames = Math.ceil(loaded.animations[0].duration * fps);
                if (frames > 1 && this.hooks.onClipFrames) this.hooks.onClipFrames(item.id, frames);
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
        if (entry.worldExtras || entry.envApplied || entry.terrain || entry.motion) this._worldDispose(entry);
        if (entry.object) {
            this._bodyOf(entry).remove(entry.object);
            this._disposeObject(entry.object);
            for (const mesh of [...this._originals.keys()]) {
                if (!mesh.parent) this._originals.delete(mesh);
            }
            entry.object = null;
            entry.stats = null;
            entry.material = null;      // a shape's own material went with it
        }
        if (!full) return;
        if (entry.axes) { this._bodyOf(entry).remove(entry.axes); entry.axes.dispose && entry.axes.dispose(); entry.axes = null; }
        if (entry.helper) { this.scene.remove(entry.helper); entry.helper.dispose(); entry.helper = null; }
        if (this.gizmo && this.gizmo.object === entry.root) this.gizmo.detach();
        // It may hang under a group rather than at the top of the scene.
        if (entry.root.parent) entry.root.parent.remove(entry.root);
        else this.scene.remove(entry.root);
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
        this._syncControlsCamera();
        const { THREE } = this.libs;
        const D = Math.PI / 180;
        const activeId = this.scene3d.activeCamera;
        const fps = this.scene3d.fps || 24;
        for (const item of this.scene3d.items || []) {
            const entry = this._entries.get(item.id);
            if (!entry) continue;
            const at = evaluate(item, frame);
            // The root sits at position+pivot — which IS where the pivot point
            // ends up, whatever R and S do — and the body takes it back off.
            const pv = at.pivot || [0, 0, 0];
            if (entry.body) entry.body.position.set(-pv[0], -pv[1], -pv[2]);
            if (entry.inner) {
                const off = offsetOf(item);
                if (off) entry.inner.matrix.fromArray(off);
                else entry.inner.matrix.identity();
                entry.inner.matrixWorldNeedsUpdate = true;
            }
            entry.root.position.set(at.position[0] + pv[0], at.position[1] + pv[1], at.position[2] + pv[2]);
            entry.root.rotation.set(at.rotation[0] * D, at.rotation[1] * D, at.rotation[2] * D);
            entry.root.scale.set(...at.scale);
            // A camera is not parented in three, so its own transform is
            // composed with its parents' here instead.
            if (entry.camera && item.parent) {
                const parentWorld = this._parentWorld(item);
                if (parentWorld) {
                    const local = new THREE.Matrix4().compose(
                        entry.root.position.clone(),
                        entry.root.quaternion.clone(),
                        entry.root.scale.clone());
                    local.premultiply(parentWorld);
                    local.decompose(entry.root.position, entry.root.quaternion, entry.root.scale);
                }
            }
            entry.root.visible = item.visible !== false && this._visibleInTree(item);
            if (entry.camera) {
                this._applyLens(entry, at.fov);
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
            // A cache holds a different shape per frame, so it is re-read.
            if (this._isCache(item) && entry.cacheFrame !== Math.round(frame)) {
                this._queueCacheReload(entry, item);
            }
        }
        // The gizmo is a controller, not an object; its handles live in the
        // helper, which has to be told the item moved under it.
        if (this.gizmoHelper && this.gizmo && this.gizmo.object) this.gizmoHelper.updateMatrixWorld();
        this._refreshAlsoBoxes();
        this._syncPivotMark();
        this._syncGate();
        this.requestRender();
    }

    // ── Cameras: the lens and the gate ───────────────────────────────────────

    /**
     * Where the gate sits in the viewport, in CSS pixels, when looking through
     * `item`: the camera's picture, fitted inside with a margin around it so
     * the edges of the shot can be seen — Maya's overscan.
     */
    _gateRect(item) {
        const w = Math.max(1, this.root ? this.root.clientWidth : 1);
        const h = Math.max(1, this.root ? this.root.clientHeight : 1);
        const [rw, rh] = cameraResolution(item);
        const ar = rw / rh;
        const OVERSCAN = 1.15;
        const gh = Math.min(h, w / ar) / OVERSCAN;
        const gw = gh * ar;
        return { x: (w - gw) / 2, y: (h - gh) / 2, w: gw, h: gh, vw: w, vh: h };
    }

    /**
     * A scene camera's projection. `fov` is the vertical field of view of the
     * camera's own picture, so:
     *   - looking through it, the view is wider than the shot by the overscan,
     *     and the gate drawn over it is exactly what renders;
     *   - otherwise it has the shape of its picture, so the frustum drawn for
     *     it in the scene is the shot's.
     * Rendering sets its own lens (renderToDataURL).
     */
    _applyLens(entry, fov) {
        const cam = entry.camera;
        if (!cam || this._sizeBackup) return;
        const item = entry.item;
        const f = fov || 35;
        const active = this.scene3d && this.scene3d.activeCamera === item.id;
        if (active) {
            const g = this._gateRect(item);
            const half = Math.tan((f * Math.PI / 180) / 2) * (g.vh / g.h);
            cam.fov = 2 * Math.atan(half) * 180 / Math.PI;
            cam.aspect = g.vw / g.vh;
        } else {
            const [rw, rh] = cameraResolution(item);
            cam.fov = f;
            cam.aspect = rw / rh;
        }
        cam.updateProjectionMatrix();
        if (entry.helper) entry.helper.update();
    }

    /** Show the gate while looking through a camera, and only then. */
    _syncGate() {
        const ui = this.ui;
        if (!ui || !ui.gate) return;
        const id = this.scene3d && this.scene3d.activeCamera;
        const entry = id && !this._walk ? this._entries.get(id) : null;
        if (!entry || !entry.camera) {
            ui.gate.style.display = "none";
            this._syncReference(null, null);
            return;
        }
        const g = this._gateRect(entry.item);
        this._syncReference(entry, g);
        const [rw, rh] = cameraResolution(entry.item);
        const px = (v) => `${Math.round(v)}px`;
        ui.gate.style.display = "block";
        const [top, bottom, left, right] = ui.shades;
        Object.assign(top.style, { left: "0", top: "0", width: "100%", height: px(g.y) });
        Object.assign(bottom.style, { left: "0", top: px(g.y + g.h), width: "100%", height: px(g.vh - g.y - g.h) });
        Object.assign(left.style, { left: "0", top: px(g.y), width: px(g.x), height: px(g.h) });
        Object.assign(right.style, { left: px(g.x + g.w), top: px(g.y), width: px(g.vw - g.x - g.w), height: px(g.h) });
        Object.assign(ui.gateFrame.style, { left: px(g.x), top: px(g.y), width: px(g.w), height: px(g.h) });
        ui.gateLabel.textContent = `${entry.item.name}  ${rw} × ${rh}`;
    }

    // ── The pivot ────────────────────────────────────────────────────────────

    /**
     * Move the pivot instead of the object.
     *
     * Maya's Insert key. The gizmo then drags the pivot point, and the item's
     * position is adjusted so that nothing on screen moves: a pivot is where a
     * thing turns, not where it is.
     */
    setPivotMode(on) {
        this.pivotMode = !!on;
        this._syncSelection();
        this._syncPivotMark();
        this._syncToolbar();
        this.requestRender();
    }

    /** The object the gizmo drags while the pivot is being moved. */
    _pivotHandle(entry) {
        const { THREE } = this.libs;
        if (!this._pivotHandleObj) {
            this._pivotHandleObj = new THREE.Object3D();
            this._pivotHandleObj.name = "PivotHandle";
        }
        const handle = this._pivotHandleObj;
        const parent = entry.root.parent || this.scene;
        if (handle.parent !== parent) parent.add(handle);
        handle.position.copy(entry.root.position);
        handle.quaternion.identity();
        handle.scale.setScalar(1);
        handle.userData.bepicItemId = entry.item.id;
        return handle;
    }

    /** The little cross that says where the pivot is, on the selected item. */
    _syncPivotMark() {
        if (!this.libs) return;
        const { THREE } = this.libs;
        const entry = this.selected ? this._entries.get(this.selected) : null;
        const want = !!(this.pivotMode && entry && !entry.camera);
        if (want && !this._pivotMark) {
            const mark = new THREE.AxesHelper(0.6);
            mark.name = "PivotMark";
            this._pivotMark = mark;
            this.scene.add(mark);
        }
        if (!this._pivotMark) return;
        this._pivotMark.visible = want;
        if (!want) return;
        entry.root.updateWorldMatrix(true, false);
        // The root's own origin is the pivot point: position+pivot, which R and
        // S leave alone.
        this._pivotMark.position.setFromMatrixPosition(entry.root.matrixWorld);
        this._pivotMark.quaternion.identity();
    }

    /**
     * Where the pivot would go to sit in the middle of the item, and the
     * position that keeps the item where it is once it does.
     */
    pivotCentre(id) {
        const entry = this._entries.get(id);
        if (!entry || !this.libs || !entry.body) return null;
        const { THREE } = this.libs;
        const box = new THREE.Box3();
        let any = false;
        entry.body.traverse((c) => {
            if (!c.isMesh && !c.isPoints) return;
            const b = new THREE.Box3().setFromObject(c);
            if (b.isEmpty()) return;
            if (any) box.union(b); else box.copy(b);
            any = true;
        });
        if (!any) return null;
        // Into the item's own space, which is what the pivot is written in.
        const centre = box.getCenter(new THREE.Vector3());
        entry.body.updateWorldMatrix(true, false);
        centre.applyMatrix4(new THREE.Matrix4().copy(entry.body.matrixWorld).invert());
        const at = evaluate(entry.item, this.sceneFrame);
        const pv = at.pivot || [0, 0, 0];
        return this._pivotShiftLocal(at, centre.clone().sub(new THREE.Vector3(...pv)));
    }

    /** R*S for an item's values — the part of its transform that isn't a move. */
    _rotScale(at) {
        const { THREE } = this.libs;
        const D = Math.PI / 180;
        return new THREE.Matrix4().compose(
            new THREE.Vector3(),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(
                at.rotation[0] * D, at.rotation[1] * D, at.rotation[2] * D, "XYZ")),
            new THREE.Vector3(...at.scale));
    }

    /**
     * position and pivot after shifting the pivot by `e` in the ITEM's own
     * space, with the item left exactly where it was.
     *
     * An item's placement is T(position + pivot - R*S*pivot)*R*S, so moving the
     * pivot by e and the position by R*S*e - e leaves that expression alone —
     * the object does not budge, only the point it turns about.
     */
    _pivotShiftLocal(at, e) {
        const pv = at.pivot || [0, 0, 0];
        const moved = e.clone().applyMatrix4(this._rotScale(at)).sub(e);
        return {
            pivot: [pv[0] + e.x, pv[1] + e.y, pv[2] + e.z],
            position: [at.position[0] + moved.x, at.position[1] + moved.y, at.position[2] + moved.z],
        };
    }

    /**
     * The same, for a drag of `d` in the item's PARENT space — which is where
     * the gizmo works, and where the pivot marker has to follow the pointer.
     *
     * The marker sits at position+pivot, so it moves by d exactly when the
     * pivot moves by (R*S)^-1 * d in the item's own space.
     */
    _pivotShiftWorld(at, d) {
        const { THREE } = this.libs;
        const inv = new THREE.Matrix4().copy(this._rotScale(at)).invert();
        return this._pivotShiftLocal(at, d.clone().applyMatrix4(inv));
    }

    /**
     * A hidden group hides what it holds. three does this for parented objects
     * on its own; a camera is not parented, so it is asked here — and the
     * answer is the same either way, which keeps the two in step.
     */
    _visibleInTree(item) {
        let node = item;
        const seen = new Set();
        while (node && node.parent && !seen.has(node.id)) {
            seen.add(node.id);
            const parent = this._entries.get(node.parent);
            node = parent ? parent.item : null;
            if (node && node.visible === false) return false;
        }
        return true;
    }

    _statsOf(object, format) {
        let vertices = 0, triangles = 0, points = 0, meshes = 0, splats = 0;
        object.traverse((c) => {
            if (c.userData && c.userData.bepicSplat) {
                splats += c.numSplats || (c.packedSplats && c.packedSplats.numSplats) || 0;
            } else if (c.userData && c.userData.bepicSplatBounds) {
                // not a mesh anyone made
            } else if (c.isMesh) {
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
        return { vertices, triangles, points, meshes, splats, format };
    }

    _updateSceneStats() {
        if (!this.scene3d) return;
        const total = { vertices: 0, triangles: 0, points: 0, meshes: 0, splats: 0, objects: 0, cameras: 0, shapes: 0, format: "scene" };
        for (const entry of this._entries.values()) {
            if (entry.camera) { total.cameras++; continue; }
            if (entry.item && entry.item.kind === "group") continue;
            if (entry.item && entry.item.kind === "primitive") total.shapes++;
            total.objects++;
            if (!entry.stats) continue;
            total.vertices += entry.stats.vertices;
            total.triangles += entry.stats.triangles;
            total.points += entry.stats.points;
            total.splats += entry.stats.splats || 0;
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

    /**
     * The rest of a multiple selection.
     *
     * The gizmo belongs to one object — three's TransformControls takes one —
     * so the others are outlined instead. That is enough to see what a Group
     * is about to swallow, which is what selecting several is for.
     */
    setAlsoSelected(ids) {
        const wanted = new Set(ids || []);
        wanted.delete(this.selected);
        if (!this.libs) { this._alsoWanted = wanted; return; }
        const { THREE } = this.libs;
        if (!this._alsoBoxes) this._alsoBoxes = new Map();
        for (const [id, box] of [...this._alsoBoxes]) {
            if (wanted.has(id) && this._entries.has(id)) continue;
            this.scene.remove(box);
            box.geometry && box.geometry.dispose();
            this._alsoBoxes.delete(id);
        }
        for (const id of wanted) {
            const entry = this._entries.get(id);
            if (!entry || this._alsoBoxes.has(id)) continue;
            const box = new THREE.BoxHelper(entry.root, 0xff8a00);
            box.userData.bepicItemId = id;
            this.scene.add(box);
            this._alsoBoxes.set(id, box);
        }
        this._refreshAlsoBoxes();
        this.requestRender();
    }

    _refreshAlsoBoxes() {
        if (!this._alsoBoxes) return;
        for (const [id, box] of this._alsoBoxes) {
            const entry = this._entries.get(id);
            if (!entry) continue;
            box.setFromObject(entry.root);
            box.visible = entry.root.visible;
        }
    }

    setGizmoMode(mode) {
        this.gizmoMode = ["translate", "rotate", "scale"].includes(mode) ? mode : "translate";
        if (this.gizmo) this.gizmo.setMode(this.gizmoMode);
        this._syncToolbar();
        this.requestRender();
    }

    /**
     * Whether the gizmo's handles follow the world axes or the item's own.
     * three always scales along the item's axes, so "world" there is a no-op —
     * the same as every other 3D app.
     */
    setGizmoSpace(space) {
        this.gizmoSpace = space === "world" ? "world" : "local";
        if (this.gizmo) this.gizmo.setSpace(this.gizmoSpace);
        this._syncToolbar();
        this.requestRender();
    }

    _ensureGizmo() {
        if (this.gizmo || !this.libs || !this.renderer) return;
        const { TransformControls } = this.libs;
        const gizmo = new TransformControls(this.activeCameraObject(), this.canvas);
        gizmo.setMode(this.gizmoMode);
        gizmo.setSpace(this.gizmoSpace || "local");
        gizmo.addEventListener("change", () => this.requestRender());
        // The orbit controls and the gizmo both want the drag; the gizmo wins
        // while one of its handles is held.
        gizmo.addEventListener("dragging-changed", (e) => {
            if (this.controls) this.controls.enabled = !e.value;
            // Where the pivot drag started. The scene is only told the numbers
            // mid-drag — nothing re-places the objects until it ends — so the
            // handle has to be measured against the state it set off from, or
            // every mouse move would add the whole journey again.
            const entry = this.selected && this._entries.get(this.selected);
            this._pivotDragFrom = (e.value && entry && this.pivotMode && entry.body)
                ? { root: entry.root.position.clone(), at: evaluate(entry.item, this.sceneFrame) }
                : null;
            if (!e.value && this.hooks.onTransformEnd) this.hooks.onTransformEnd(this.selected);
        });
        gizmo.addEventListener("objectChange", () => {
            const entry = this.selected && this._entries.get(this.selected);
            // Pivot mode: the handle moved, so the pivot moves with it and the
            // position takes up the slack.
            if (entry && this.pivotMode && this._pivotHandleObj && gizmo.object === this._pivotHandleObj) {
                const from = this._pivotDragFrom
                    || { root: entry.root.position.clone(), at: evaluate(entry.item, this.sceneFrame) };
                const at = from.at;
                const d = this._pivotHandleObj.position.clone().sub(from.root);
                if (this.hooks.onTransform) {
                    this.hooks.onTransform(this.selected, this._pivotShiftWorld(at, d), true,
                                           ["position", "pivot"]);
                }
                this._syncPivotMark();
                this.requestRender();
                return;
            }
            // `live`: the object is already where the gizmo put it, so the scene
            // only has to take the numbers — rebuilding the panel and rewriting
            // the node's widget on every mouse move is what that would cost.
            if (entry && this.hooks.onTransform) {
                this.hooks.onTransform(this.selected, this.readTransform(entry.root, entry.item), true);
            }
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
        // A group has nothing to draw, so its axes stand in for it — and only
        // while it is the thing being moved.
        for (const e of this._entries.values()) {
            if (e.axes) e.axes.visible = (e === entry);
        }
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
        else if (this.pivotMode && entry.body) {
            // A stand-in at the pivot point: dragging the item's own root would
            // move the item, which is the one thing moving a pivot must not do.
            this.gizmo.setMode("translate");
            this.gizmo.attach(this._pivotHandle(entry));
        } else {
            this.gizmo.setMode(this.gizmoMode);
            this.gizmo.attach(entry.root);
        }
    }

    /** The transform of a three object, in the scene's own units (degrees). */
    readTransform(object, item = null) {
        const R = 180 / Math.PI;
        // The root sits at position+pivot (see applyFrame), so what the scene
        // stores is what the gizmo left MINUS the pivot. Without this the item
        // jumps by its pivot the moment anything is dragged.
        const entry = item ? this._entries.get(item.id) : null;
        if (entry && entry.body && object === entry.root) {
            const pv = evaluate(item, this.sceneFrame).pivot || [0, 0, 0];
            return {
                position: [object.position.x - pv[0], object.position.y - pv[1], object.position.z - pv[2]],
                rotation: [object.rotation.x * R, object.rotation.y * R, object.rotation.z * R],
                scale: object.scale.toArray(),
            };
        }
        // A camera inside a group is driven in world space (see _reparent), so
        // what the scene stores has to be taken back out of its parent.
        const parentWorld = (item && item.kind === "camera") ? this._parentWorld(item) : null;
        if (parentWorld) {
            const { THREE } = this.libs;
            const world = new THREE.Matrix4().compose(
                object.position.clone(), object.quaternion.clone(), object.scale.clone());
            const local = new THREE.Matrix4().copy(parentWorld).invert().multiply(world);
            const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
            local.decompose(p, q, s);
            const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
            return {
                position: p.toArray(),
                rotation: [e.x * R, e.y * R, e.z * R],
                scale: s.toArray(),
            };
        }
        return {
            position: object.position.toArray(),
            rotation: [object.rotation.x * R, object.rotation.y * R, object.rotation.z * R],
            scale: object.scale.toArray(),
        };
    }

    /** The point the view is looking at — where a new shape should land. */
    viewFocus() {
        if (!this.controls) return null;
        return this.controls.target.toArray();
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
            if (this.gizmo) this.gizmo.camera = cam;
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

    /**
     * A tile for the history strip, taken once the scene has settled.
     *
     * It used to be captured when a lone model finished loading. A scene has no
     * such moment — items arrive one at a time — so it is asked for after a
     * reconcile and coalesced: the last call within the delay wins, and a view
     * that is off screen (a hidden tab paints nothing) is skipped.
     */
    _captureThumbnailSoon(frame) {
        if (!this.hooks.onThumbnail || !frame) return;
        const id = ++this._thumbId;
        this.win.setTimeout(() => {
            if (id !== this._thumbId || !this.renderer || !this.visible) return;
            const url = this.captureThumbnail(256);
            if (url) this.hooks.onThumbnail(frame, url);
        }, 400);
    }

    // ── Rendering a shot ─────────────────────────────────────────────────────
    //
    // beginRender(opts) → renderFrame(frame, w, h) per frame → endRender().
    // Between the first and the last the view is set up for the picture, not
    // for working in: the camera chosen, the helpers hidden, the shading and
    // background asked for. endRender puts every one of them back.

    /**
     * Set the view up for a render.
     *   camera     scene camera id, "" for the free view, undefined for the
     *              camera being looked through (the viewport's own)
     *   shading    "original" | "clay" | "normal" | "wireframe"
     *   background "viewer" | "color" | "transparent", with `color` for "color"
     *   grid       keep the grid in the picture
     *   helpers    keep camera frustums, group axes and the like
     *   aa         supersampling factor: 1, 2 or 4
     */
    beginRender(opts = {}) {
        if (!this.renderer || !this.canvas || this._rendering) return false;
        const { THREE } = this.libs;
        const r = this._rendering = { opts, restore: [] };
        const keep = (obj, key) => { if (obj) r.restore.push([obj, key, obj[key]]); };

        let cam = this.activeCameraObject();
        let item = null;
        if (opts.camera === "") cam = this.camera;
        else if (opts.camera) {
            const entry = this._entries.get(opts.camera);
            if (entry && entry.camera) { cam = entry.camera; item = entry.item; }
        } else {
            const id = this.scene3d && this.scene3d.activeCamera;
            const entry = id ? this._entries.get(id) : null;
            if (entry && entry.camera === cam) item = entry.item;
        }
        r.cam = cam;
        r.item = item;
        keep(cam, "fov"); keep(cam, "aspect");

        this._sizeBackup = { w: this.canvas.width, h: this.canvas.height, ratio: this.renderer.getPixelRatio() };
        r.clear = this.renderer.getClearColor(new THREE.Color());
        r.clearAlpha = this.renderer.getClearAlpha();
        r.material = this.materialMode;
        if (opts.shading && opts.shading !== this.materialMode) this.setMaterialMode(opts.shading);
        if (opts.background === "transparent") this.renderer.setClearColor(r.clear, 0);
        else if (opts.background === "color" && opts.color) this.renderer.setClearColor(new THREE.Color(opts.color), 1);
        this._renderHideOverlays();
        return true;
    }

    /** Everything that is there to work with rather than to be looked at. */
    _renderHideOverlays() {
        const r = this._rendering;
        if (!r) return;
        const hide = (obj) => { if (obj && obj.visible) { r.restore.push([obj, "visible", true]); obj.visible = false; } };
        if (!r.opts.grid) hide(this.grid);
        hide(this.gizmoHelper);
        hide(this._pivotMark);
        hide(this._pinGroup);           // feedback pins are notes, not part of the shot
        for (const box of (this._alsoBoxes || new Map()).values()) hide(box);
        if (!r.opts.helpers) {
            for (const entry of this._entries.values()) {
                hide(entry.helper);
                hide(entry.axes);
            }
        }
    }

    /**
     * One frame, `width` x `height`, as a PNG data URL. Rendered `aa` times
     * as large and scaled down, which is what smooths the edges of a still
     * that will be looked at far longer than a viewport ever is.
     */
    renderFrame(frame, width, height) {
        const r = this._rendering;
        if (!r) return null;
        if (frame !== undefined && frame !== null) this.applyFrame(frame);
        // applyFrame shows the helpers again as it places things.
        this._renderHideOverlays();
        const cam = r.cam;
        const max = (this.renderer.capabilities && this.renderer.capabilities.maxTextureSize) || 8192;
        let aa = Math.max(1, Math.min(4, Math.round(r.opts.aa || 1)));
        while (aa > 1 && Math.max(width, height) * aa > max) aa--;
        const W = Math.round(width * aa), H = Math.round(height * aa);
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(W, H, false);
        cam.aspect = width / height;
        // A scene camera renders its gate: its own fov, not the overscanned
        // one the viewport shows around it.
        if (r.item) cam.fov = evaluate(r.item, this.sceneFrame).fov || 35;
        cam.updateProjectionMatrix();
        // Rendered as the viewport draws it: bloom and tone mapping included.
        this._worldResize(W, H);
        this._worldRender(cam);
        try {
            if (aa === 1) return this.canvas.toDataURL("image/png");
            const out = this.doc.createElement("canvas");
            out.width = width; out.height = height;
            const ctx = out.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(this.canvas, 0, 0, W, H, 0, 0, width, height);
            return out.toDataURL("image/png");
        } catch (e) {
            console.warn("[bEpicViewer] could not read the render back", e);
            return null;
        }
    }

    /** Put the view back the way it was before beginRender. */
    endRender() {
        const r = this._rendering;
        if (!r) return;
        this._rendering = null;
        for (let i = r.restore.length - 1; i >= 0; i--) {
            const [obj, key, value] = r.restore[i];
            obj[key] = value;
        }
        if (r.cam && r.cam.updateProjectionMatrix) r.cam.updateProjectionMatrix();
        this.renderer.setClearColor(r.clear, r.clearAlpha);
        if (r.material !== this.materialMode) this.setMaterialMode(r.material);
        this.restoreSize();
        this.applyFrame(this.sceneFrame);
    }

    /**
     * Render the current frame at an exact size through the viewport's camera
     * and hand back a PNG data URL — one frame of what beginRender sets up.
     * restoreSize() (or endRender) puts the view back.
     */
    renderToDataURL(width, height) {
        if (!this._rendering && !this.beginRender({ grid: true, helpers: true })) return null;
        return this.renderFrame(null, width, height);
    }

    /** Undo renderToDataURL's resize. */
    restoreSize() {
        if (this._rendering) { this.endRender(); return; }
        if (!this._sizeBackup || !this.renderer) return;
        const b = this._sizeBackup;
        this._sizeBackup = null;
        this.renderer.setPixelRatio(b.ratio);
        this._resize();
        this.requestRender();
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
        if (this._walk) this.walkExit();
        for (const [id, entry] of [...this._entries]) { this._disposeEntry(entry, true); this._entries.delete(id); }
        if (this.gizmo) { this.gizmo.dispose(); this.gizmo = null; }
        this._disposeRenderer();
        if (this.materials) Object.values(this.materials).forEach((m) => m.dispose());
        if (this.root) this.root.remove();
        this.root = null;
    }
}

// Worlds (bEpicViewer_world3d.js). Copied as descriptors, not with
// Object.assign, because the mixin has a getter (`walking`).
Object.defineProperties(Model3DView.prototype, Object.getOwnPropertyDescriptors(WorldViewMixin));
Object.assign(Model3DView.prototype, WorldMatchMixin);
