// bEpicViewer_world3d.js
// Worlds in the 3D view: sky, sun and fog; terrain; scattered vegetation and
// rocks that sway in the wind; a picture pushed into 3D by its depth map;
// walking; the reference picture over a camera's view; feedback pins.
//
// A mixin on Model3DView (Object.assign at the foot of bEpicViewer_model3d.js),
// so every method here shares the view's `this`: this.libs, this.scene,
// this._entries, this.hooks. The data these read is in bEpicViewer_worldData.js.
//
// Each world item is built from its settings into the item's `inner` group,
// and rebuilt when its key (the settings, as JSON) changes — a scatter's key
// includes its terrain's, so re-shaping the ground re-plants what grows on it.

import { api } from "../../scripts/api.js";
import {
    WORLD_KINDS, environmentSettings, terrainSettings, scatterSettings, depthMeshSettings,
    referenceSettings, walkSettings, worldInfo, inClearArea, lightSettings,
} from "./bEpicViewer_worldData.js";

// Bloom and tone mapping come from three's post-processing addons, loaded the
// first time a world asks for bloom (vendor/three, like the rest of three).
let _postPromise = null;
function loadPost() {
    if (!_postPromise) {
        const base = api.apiURL("/bepic/lib/three/");
        _postPromise = Promise.all(["EffectComposer.js", "RenderPass.js", "UnrealBloomPass.js", "OutputPass.js"]
            .map((n) => import(base + n)))
            .then(([ec, rp, ub, op]) => ({ EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass,
                                         UnrealBloomPass: ub.UnrealBloomPass, OutputPass: op.OutputPass }))
            .catch((e) => { _postPromise = null; throw e; });
    }
    return _postPromise;
}

// HDR panoramas (a photographed HDRI as the sky) are read by three's own
// loaders, fetched the first time a world has one.
let _hdrPromise = null;
function loadHdr() {
    if (!_hdrPromise) {
        const base = api.apiURL("/bepic/lib/three/");
        _hdrPromise = Promise.all(["HDRLoader.js", "EXRLoader.js"].map((n) => import(base + n)))
            .then(([hdr, exr]) => ({ HDRLoader: hdr.HDRLoader, EXRLoader: exr.EXRLoader }))
            .catch((e) => { _hdrPromise = null; throw e; });
    }
    return _hdrPromise;
}

// What each scatter shape is made of, unless the scatter says otherwise.
const ROUGHNESS = { pine: 0.85, tree: 0.8, bush: 0.85, grass: 0.9, rock: 0.8, column: 0.55, lamp: 0.4, model: null };

const DEG = Math.PI / 180;
const SKY_RADIUS = 4000;

// A small, fast, seeded generator — placement must be the same every time a
// world is opened, or feedback about "that tree" would point at another one.
function rng(seed) {
    let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Metres for a depth-map value from [d, z] pairs, interpolated in 1/z. */
function curveDepth(curve, d) {
    if (d <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
        const [d0, z0] = curve[i - 1], [d1, z1] = curve[i];
        if (d <= d1) {
            const t = (d - d0) / Math.max(d1 - d0, 1e-9);
            return 1 / ((1 - t) / z0 + t / z1);
        }
    }
    return curve[curve.length - 1][1];
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Value-noise fBm for a terrain with no heightmap: n x n, 0..1. */
function fbm(n, seed, roughness) {
    const out = new Float32Array(n * n);
    let amp = 1, total = 0;
    for (let o = 0, g = 3; o < 7 && g <= n; o++, g = g * 2) {
        const r = rng(seed * 131 + o * 7919);
        const grid = new Float32Array((g + 1) * (g + 1)).map(() => r());
        for (let y = 0; y < n; y++) {
            const fy = (y / (n - 1)) * g, y0 = Math.floor(fy), ty = fy - y0, y1 = Math.min(g, y0 + 1);
            const sy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < n; x++) {
                const fx = (x / (n - 1)) * g, x0 = Math.floor(fx), tx = fx - x0, x1 = Math.min(g, x0 + 1);
                const sx = tx * tx * (3 - 2 * tx);
                const a = grid[y0 * (g + 1) + x0], b = grid[y0 * (g + 1) + x1];
                const c = grid[y1 * (g + 1) + x0], d = grid[y1 * (g + 1) + x1];
                out[y * n + x] += ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy) * amp;
            }
        }
        total += amp;
        amp *= roughness;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < out.length; i++) { out[i] /= total; lo = Math.min(lo, out[i]); hi = Math.max(hi, out[i]); }
    // The same shaping as the builder: flat where you start, rising far and at the rim.
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const u = x / (n - 1), v = y / (n - 1), i = y * n + x;
            const h = (out[i] - lo) / Math.max(hi - lo, 1e-6);
            const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5));
            let s = h * 0.55 + smooth(0, 0.7, Math.max(0, 0.75 - v)) * 0.35 * (0.6 + 0.8 * h)
                  + smooth(0.34, 0.5, edge) * 0.55 * (0.7 + 0.6 * h);
            const d = Math.hypot(u - 0.5, v - 0.75);
            s = 0.25 * (1 - smooth(0.07, 0.175, d)) + s * smooth(0.07, 0.175, d);
            out[i] = s;
        }
    }
    lo = Infinity; hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / Math.max(hi - lo, 1e-6);
    return out;
}

export const WorldViewMixin = {

    // ── Plumbing ─────────────────────────────────────────────────────────────

    /** Something worth knowing about an item that isn't an error. */
    itemNote(id) {
        const entry = this._entries.get(id);
        return (entry && entry.note) || "";
    },

    _isWorldKind(item) {
        return !!item && WORLD_KINDS.includes(item.kind);
    },

    /** What decides a rebuild: an item's settings, and for a scatter its ground's. */
    _worldKey(item) {
        if (item.kind === "environment") {
            const e = environmentSettings(item);
            return JSON.stringify([e, this._worldExtent()]);
        }
        if (item.kind === "terrain") return JSON.stringify(terrainSettings(item));
        if (item.kind === "scatter") {
            const s = scatterSettings(item);
            const target = this.scene3d && (this.scene3d.items || []).find((i) => i.id === s.target);
            return JSON.stringify([s, target ? terrainSettings(target) : null,
                                   target ? [target.position, target.rotation, target.scale] : null]);
        }
        if (item.kind === "depthmesh") return JSON.stringify(depthMeshSettings(item));
        if (item.kind === "light") return JSON.stringify(lightSettings(item));
        return "";
    },

    /** How far the world reaches — what the sun's shadows have to cover. */
    _worldExtent() {
        let r = 60;
        for (const it of (this.scene3d && this.scene3d.items) || []) {
            if (it.kind === "terrain") {
                const t = terrainSettings(it);
                r = Math.max(r, Math.hypot(t.size[0], t.size[1]) / 2);
            }
        }
        return Math.round(r);
    },

    _worldTime() {
        if (!this._worldClock) this._worldClock = { value: 0 };
        return this._worldClock;
    },

    async _worldBuild(entry, item) {
        entry.key = this._worldKey(item);
        entry.worldReady = (async () => {
            try {
                if (item.kind === "environment") this._buildEnvironment(entry, item);
                else if (item.kind === "terrain") await this._buildTerrain(entry, item);
                else if (item.kind === "scatter") await this._buildScatter(entry, item);
                else if (item.kind === "depthmesh") await this._buildDepthMesh(entry, item);
                else if (item.kind === "light") this._buildLight(entry, item);
                entry.error = "";
            } catch (e) {
                console.warn(`[bEpicViewer] could not build ${item.name}`, e);
                entry.error = (e && e.message) || String(e);
                if (this.hooks.onError) this.hooks.onError(item, entry.error);
            }
            this._worldSyncStudio();
            // What the world looks like changed: its reflections are stale.
            this._envDirty = true;
            this.requestRender();
        })();
        await entry.worldReady;
        return entry;
    },

    _worldDispose(entry) {
        this._stopMotion(entry);
        if (entry.worldExtras) {
            for (const obj of entry.worldExtras) {
                if (obj.parent) obj.parent.remove(obj);
                if (obj.isLight && obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
                this._disposeObject(obj);
            }
            entry.worldExtras = null;
        }
        if (entry.envApplied) {
            this.scene.fog = null;
            if (this.scene.background && this.scene.background.isTexture) this.scene.background.dispose();
            this.scene.background = null;
            this.scene.backgroundIntensity = 1;
            this._worldDropSkyLight();
            entry.envApplied = false;
        }
        if (entry.object) {
            this._bodyOf(entry).remove(entry.object);
            this._disposeObject(entry.object);
            entry.object = null;
        }
        entry.terrain = null;
        entry.key = "";
        this._worldSyncStudio();
    },

    /**
     * ComfyUI's studio lights and the grid belong to a model on a turntable,
     * not to a landscape: while a world has an environment, its sun and sky
     * light it instead, and while it has a terrain the grid would cut through
     * the ground.
     */
    _worldSyncStudio() {
        let env = false, ground = false;
        for (const e of this._entries.values()) {
            if (e.item.kind === "environment" && e.envApplied && e.item.visible !== false) env = true;
            if (e.item.kind === "terrain" && e.terrain) ground = true;
        }
        for (const light of this.lights || []) light.visible = !env;
        if (this.renderer) {
            this.renderer.shadowMap.enabled = env;
        }
        if (this.grid) this.grid.visible = this.showGrid && !ground;
        this._worldSyncRender();
    },

    /** The environment's render settings, or null when there is no world. */
    _worldRenderSettings() {
        for (const e of this._entries.values()) {
            if (e.item.kind === "environment" && e.envApplied && e.item.visible !== false) {
                return environmentSettings(e.item).render;
            }
        }
        return null;
    },

    /**
     * Tone curve, exposure and bloom, from the environment's `render` block.
     * Without a world the viewer's plain linear look stays, so a model tab is
     * drawn as it always was.
     */
    _worldSyncRender() {
        if (!this.renderer || !this.libs) return;
        const { THREE } = this.libs;
        const r = this._worldRenderSettings();
        const curve = { neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping,
                        agx: THREE.AgXToneMapping, linear: THREE.LinearToneMapping };
        this.renderer.toneMapping = r ? curve[r.tone] : THREE.LinearToneMapping;
        this.renderer.toneMappingExposure = this.exposure * (r ? r.exposure : 1);
        const want = !!(r && r.bloom > 0);
        if (!want) {
            if (this._composer) { this._composer.dispose && this._composer.dispose(); this._composer = null; }
            this._bloomPass = null;
            return;
        }
        if (this._composer) {
            this._bloomPass.strength = r.bloom;
            return;
        }
        if (this._postLoading) return;
        this._postLoading = true;
        loadPost().then((P) => {
            this._postLoading = false;
            if (!this.renderer || !this._worldRenderSettings()) return;
            const size = this.renderer.getSize(new THREE.Vector2());
            const composer = new P.EffectComposer(this.renderer);
            composer.setPixelRatio(this.renderer.getPixelRatio());
            composer.setSize(size.x, size.y);
            this._renderPass = new P.RenderPass(this.scene, this.activeCameraObject());
            this._bloomPass = new P.UnrealBloomPass(size.clone(), (this._worldRenderSettings() || {}).bloom || 0.3, 0.45, 0.9);
            composer.addPass(this._renderPass);
            composer.addPass(this._bloomPass);
            composer.addPass(new P.OutputPass());
            this._composer = composer;
            this.requestRender();
        }).catch((e) => {
            this._postLoading = false;
            console.warn("[bEpicViewer] bloom unavailable", e);
        });
    },

    /** Draw a frame: through bloom and tone mapping when the world has them. */
    _worldRender(camera) {
        if (this._envDirty) this._worldCaptureEnv();
        if (this._composer && this._renderPass) {
            this._renderPass.camera = camera;
            this._composer.render();
            return;
        }
        this.renderer.render(this.scene, camera);
    },

    /** The composer follows the canvas's size. */
    _worldResize(w, h) {
        if (this._composer) {
            this._composer.setPixelRatio(this.renderer.getPixelRatio());
            this._composer.setSize(w, h);
        }
    },

    /**
     * Reflections and image-based light from the world itself: a cube map
     * taken where the reference camera (or the walk) stands, filtered for
     * rough and smooth surfaces alike. A glossy floor then reflects the
     * picture's own lamps and columns, not a sky it doesn't have.
     */
    _worldCaptureEnv() {
        this._envDirty = false;
        const { THREE } = this.libs;
        const r = this._worldRenderSettings();
        if (r && r.reflections === "sky" && this._skyEnvRT) {
            // The sky panorama lights the world and gives its reflections.
            if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
            this.scene.environment = this._skyEnvRT.texture;
            this._worldScaleFill(r.fill);
            return;
        }
        if (!r || r.reflections !== "capture" || !this.renderer) {
            if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
            if (this.scene.environment && this.scene.environment.userData && this.scene.environment.userData.bepicCapture) {
                this.scene.environment = null;
            }
            this._worldScaleFill(1);
            return;
        }
        const walk = walkSettings(this.scene3d);
        const refcam = (this.scene3d.items || []).find((i) => i.id === "refcam");
        const at = walk.spawn || (refcam && refcam.position) || [0, 1.7, 0];
        const cube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
        const cam = new THREE.CubeCamera(0.05, SKY_RADIUS * 2, cube);
        cam.position.set(at[0], at[1], at[2]);
        const hidden = [];
        const hide = (o) => { if (o && o.visible) { o.visible = false; hidden.push(o); } };
        hide(this.grid); hide(this.gizmoHelper); hide(this._pinGroup); hide(this._pivotMark);
        for (const e of this._entries.values()) { hide(e.helper); hide(e.axes); }
        this.scene.environment = null;
        this._worldScaleFill(1);
        this.scene.add(cam);
        cam.update(this.renderer, this.scene);
        this.scene.remove(cam);
        for (const o of hidden) o.visible = true;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const rt = pmrem.fromCubemap(cube.texture);
        pmrem.dispose();
        cube.dispose();
        if (this._envRT) this._envRT.dispose();
        this._envRT = rt;
        rt.texture.userData.bepicCapture = true;
        this.scene.environment = rt.texture;
        // The captured world already carries much of the fill light: the
        // hemisphere light keeps only the share the world asks for.
        this._worldScaleFill(r.fill);
    },

    /** Forget the light an HDR sky gave (its filtered map), if it gave one. */
    _worldDropSkyLight() {
        if (!this._skyEnvRT) return;
        if (this.scene.environment === this._skyEnvRT.texture) this.scene.environment = null;
        this.scene.environmentIntensity = 1;
        this._skyEnvRT.dispose();
        this._skyEnvRT = null;
    },

    /**
     * The sky panorama as the world's image light: filtered once for rough
     * and smooth surfaces (PMREM), then used by everything that reflects or
     * is lit by the sky.
     */
    _worldSkyLight(tex, intensity) {
        const { THREE } = this.libs;
        this._worldDropSkyLight();
        if (!this.renderer) return;
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this._skyEnvRT = pmrem.fromEquirectangular(tex);
        pmrem.dispose();
        this._skyEnvRT.texture.userData.bepicSky = true;
        this.scene.environmentIntensity = intensity;
        this._envDirty = true;
    },

    _worldScaleFill(k) {
        for (const e of this._entries.values()) {
            if (e.item.kind !== "environment" || !e.worldExtras) continue;
            for (const o of e.worldExtras) {
                if (o.isHemisphereLight) o.intensity = environmentSettings(e.item).ambient.intensity * k;
            }
        }
    },

    // ── Environment ──────────────────────────────────────────────────────────

    _buildEnvironment(entry, item) {
        const { THREE } = this.libs;
        const e = environmentSettings(item);
        const extras = [];

        // The sky: a gradient dome, or the panorama as the background.
        if (e.sky.mode === "panorama" && e.sky.src && this.hooks.srcUrl) {
            const key = this._worldKey(item);
            const load = e.sky.hdr
                ? loadHdr().then((L) => {
                    const src = e.sky.src;
                    const exr = /\.exr$/i.test(String(src.path || src.name || src.filename || ""));
                    return new (exr ? L.EXRLoader : L.HDRLoader)().loadAsync(this.hooks.srcUrl({ ...src, raw: true }));
                })
                : this._loadTexture(this.hooks.srcUrl(e.sky.src));
            load.then((tex) => {
                if (entry.key !== key || !entry.envApplied) { tex.dispose(); return; }
                tex.mapping = THREE.EquirectangularReflectionMapping;
                if (!e.sky.hdr) tex.colorSpace = THREE.SRGBColorSpace;
                if (this.scene.background && this.scene.background.isTexture) this.scene.background.dispose();
                this.scene.background = tex;
                this.scene.backgroundIntensity = e.sky.intensity;
                if (e.sky.lighting) this._worldSkyLight(tex, e.sky.intensity);
                this.requestRender();
            }).catch((err) => { entry.error = err.message; });
        } else {
            const dome = new THREE.Mesh(
                new THREE.SphereGeometry(SKY_RADIUS, 48, 24),
                new THREE.ShaderMaterial({
                    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
                    uniforms: {
                        top: { value: new THREE.Color(e.sky.top) },
                        horizon: { value: new THREE.Color(e.sky.horizon) },
                        bottom: { value: new THREE.Color(e.sky.bottom) },
                    },
                    vertexShader: `varying vec3 vDir;
                        void main() { vDir = normalize(position);
                          vec4 p = modelViewMatrix * vec4(position, 1.0);
                          gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
                    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
                        void main() { float y = vDir.y;
                          vec3 c = y > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.6, y), 0.7))
                                           : mix(horizon, bottom, smoothstep(0.0, 0.08, -y));
                          gl_FragColor = vec4(c, 1.0);
                          #include <colorspace_fragment>
                        }`,
                }));
            dome.name = "worldsky";
            dome.frustumCulled = false;
            dome.renderOrder = -1000;
            dome.userData.worldSky = true;
            this.scene.add(dome);
            extras.push(dome);
        }

        // The sun, and the light the sky gives everything else.
        const el = e.sun.elevation * DEG, az = e.sun.azimuth * DEG;
        const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
        const sun = new THREE.DirectionalLight(new THREE.Color(e.sun.color), e.sun.intensity * (e.sun.elevation > -4 ? 1 : 0.15));
        const reach = this._worldExtent();
        sun.position.copy(dir.clone().multiplyScalar(reach * 1.5));
        sun.target.position.set(0, 0, 0);
        sun.castShadow = e.sun.shadows && e.sun.elevation > 0;
        if (sun.castShadow) {
            sun.shadow.mapSize.set(4096, 4096);
            const cam = sun.shadow.camera;
            cam.left = -reach; cam.right = reach; cam.top = reach; cam.bottom = -reach;
            cam.near = 1; cam.far = reach * 4;
            sun.shadow.bias = -0.0004;
            sun.shadow.normalBias = 0.6;
        }
        const hemi = new THREE.HemisphereLight(new THREE.Color(e.ambient.sky), new THREE.Color(e.ambient.ground),
                                               e.ambient.intensity);
        this.scene.add(sun, sun.target, hemi);
        extras.push(sun, sun.target, hemi);

        this.scene.fog = e.fog.density > 0 ? new THREE.FogExp2(new THREE.Color(e.fog.color), e.fog.density) : null;
        if (this.renderer) {
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.renderer.shadowMap.needsUpdate = true;
        }
        entry.worldExtras = extras;
        entry.envApplied = true;
        entry.stats = { format: "environment" };
    },

    // ── Terrain ──────────────────────────────────────────────────────────────

    /** Pixels of an image the server serves, as RGBA bytes. */
    async _worldPixels(src, maxSize = 1024) {
        const url = this.hooks.srcUrl && this.hooks.srcUrl(src);
        if (!url) throw new Error("no image to read");
        const res = await fetch(url);
        if (!res.ok) throw new Error(`the server answered ${res.status} for ${src.name || "an image"}`);
        const bitmap = await this.win.createImageBitmap(await res.blob());
        const s = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
        const canvas = this.doc.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close && bitmap.close();
        return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
    },

    _sample(px, u, v, decode) {
        const x = Math.min(px.width - 1, Math.max(0, u * (px.width - 1)));
        const y = Math.min(px.height - 1, Math.max(0, v * (px.height - 1)));
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const x1 = Math.min(px.width - 1, x0 + 1), y1 = Math.min(px.height - 1, y0 + 1);
        const fx = x - x0, fy = y - y0;
        const at = (xx, yy) => decode(px.data, (yy * px.width + xx) * 4);
        return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
    },

    async _buildTerrain(entry, item) {
        const { THREE } = this.libs;
        const t = terrainSettings(item);
        const seg = t.segments, n = seg + 1;
        const heights = new Float32Array(n * n);
        if (t.heightmap) {
            const px = await this._worldPixels(t.heightmap, 1024);
            const decode = t.encoding === "rg16"
                ? (d, i) => (d[i] * 256 + d[i + 1]) / 65535
                : (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 765;
            for (let y = 0; y < n; y++) {
                for (let x = 0; x < n; x++) heights[y * n + x] = this._sample(px, x / seg, y / seg, decode);
            }
        } else {
            heights.set(fbm(n, t.seed, t.roughness));
        }

        const geom = new THREE.PlaneGeometry(t.size[0], t.size[1], seg, seg).rotateX(-Math.PI / 2);
        const pos = geom.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i] * t.height);
        geom.computeVertexNormals();

        // Which layer shows where: from a splat image, or from slope and height.
        const weights = new Float32Array(pos.count * 4);
        const nrm = geom.attributes.normal;
        let splat = null;
        if (t.splat) splat = await this._worldPixels(t.splat, 1024);
        const R = t.rules;
        for (let i = 0; i < pos.count; i++) {
            let w;
            if (splat) {
                const u = (i % n) / seg, v = Math.floor(i / n) / seg;
                w = [0, 1, 2, 3].map((c) => this._sample(splat, u, v, (d, k) => d[k + c] / 255));
            } else {
                const slope = Math.acos(Math.min(1, Math.max(-1, nrm.getY(i)))) / DEG;
                const peak = smooth(R.peak[0], R.peak[1], heights[i]);
                const cliff = smooth(R.cliffSlope[0], R.cliffSlope[1], slope);
                const rock = smooth(R.rockSlope[0], R.rockSlope[1], slope) * (1 - cliff);
                const flatPeak = peak * (1 - cliff);
                w = [Math.max(0, 1 - rock - cliff - flatPeak), rock, cliff, flatPeak];
            }
            weights.set(w, i * 4);
        }
        geom.setAttribute("aSplat", new THREE.BufferAttribute(weights, 4));

        const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        white.needsUpdate = true;
        const loadMap = async (src, srgb) => {
            if (!src || !this.hooks.srcUrl) return null;
            try {
                const tex = await this._loadTexture(this.hooks.srcUrl(src));
                tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.anisotropy = this.renderer ? this.renderer.capabilities.getMaxAnisotropy() : 1;
                return tex;
            } catch (e) { return null; }
        };
        const [maps, normals, roughs] = await Promise.all([
            Promise.all(t.layers.map((l) => loadMap(l.src, true))),
            Promise.all(t.layers.map((l) => loadMap(l.normal, false))),
            Promise.all(t.layers.map((l) => loadMap(l.rough, false))),
        ]);
        const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
        flat.needsUpdate = true;
        const uniforms = {
            uMap0: { value: maps[0] || white }, uMap1: { value: maps[1] || white },
            uMap2: { value: maps[2] || white }, uMap3: { value: maps[3] || white },
            uColor0: { value: new THREE.Color(t.layers[0].color) }, uColor1: { value: new THREE.Color(t.layers[1].color) },
            uColor2: { value: new THREE.Color(t.layers[2].color) }, uColor3: { value: new THREE.Color(t.layers[3].color) },
            uTile: { value: new THREE.Vector4(...t.layers.map((l) => l.tile)) },
            uNrm0: { value: normals[0] || flat }, uNrm1: { value: normals[1] || flat },
            uNrm2: { value: normals[2] || flat }, uNrm3: { value: normals[3] || flat },
            uRgh0: { value: roughs[0] || white }, uRgh1: { value: roughs[1] || white },
            uRgh2: { value: roughs[2] || white }, uRgh3: { value: roughs[3] || white },
            uHasR: { value: new THREE.Vector4(...roughs.map((m) => (m ? 1 : 0))) },
            uRough: { value: new THREE.Vector4(...t.layers.map((l) => l.roughness)) },
            uNScale: { value: new THREE.Vector4(...t.layers.map((l, i) => (normals[i] ? l.normalScale : 0))) },
            uBake: { value: new THREE.Vector4(...t.layers.map((l) => l.baked)) },
        };
        const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
        // A key per program: without it, three reuses one compiled shader for
        // every terrain, and the first one's patch is the only one it runs.
        material.customProgramCacheKey = () => "bepic-terrain-pbr";
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\nattribute vec4 aSplat;\nvarying vec4 vSplat;\nvarying vec2 vGround;\nvarying vec3 vTanV;\nvarying vec3 vBitV;")
                .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSplat = aSplat;\nvGround = position.xz;\n"
                         + "vTanV = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));\nvBitV = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));");
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", `#include <common>
                    uniform sampler2D uMap0; uniform sampler2D uMap1; uniform sampler2D uMap2; uniform sampler2D uMap3;
                    uniform vec3 uColor0; uniform vec3 uColor1; uniform vec3 uColor2; uniform vec3 uColor3;
                    uniform vec4 uTile; varying vec4 vSplat; varying vec2 vGround;
                    uniform sampler2D uNrm0; uniform sampler2D uNrm1; uniform sampler2D uNrm2; uniform sampler2D uNrm3;
                    uniform sampler2D uRgh0; uniform sampler2D uRgh1; uniform sampler2D uRgh2; uniform sampler2D uRgh3;
                    uniform vec4 uHasR; uniform vec4 uRough; uniform vec4 uNScale; uniform vec4 uBake;
                    varying vec3 vTanV; varying vec3 vBitV;
                    vec2 layerN(sampler2D m, float tile) { return texture2D(m, vGround / tile).xy * 2.0 - 1.0; }
                    float layerR(sampler2D m, float tile) { return texture2D(m, vGround / tile).r; }
                    // Two scales of the same texture, so a repeat doesn't read as a grid.
                    vec3 layerTex(sampler2D m, float tile) {
                        vec3 a = texture2D(m, vGround / tile).rgb;
                        vec3 b = texture2D(m, vGround / (tile * 4.3) + 0.37).rgb;
                        return mix(a, b, 0.35);
                    }`)
                .replace("#include <map_fragment>", `
                    vec4 sw = vSplat / max(dot(vSplat, vec4(1.0)), 1e-4);
                    vec3 ground = uColor0 * layerTex(uMap0, uTile.x) * sw.x + uColor1 * layerTex(uMap1, uTile.y) * sw.y
                                + uColor2 * layerTex(uMap2, uTile.z) * sw.z + uColor3 * layerTex(uMap3, uTile.w) * sw.w;
                    diffuseColor.rgb *= ground;`)
                // Roughness: each layer's map, or its measured value, blended.
                .replace("#include <roughnessmap_fragment>", `
                    vec4 rs = vec4(mix(uRough.x, layerR(uRgh0, uTile.x), uHasR.x), mix(uRough.y, layerR(uRgh1, uTile.y), uHasR.y),
                                   mix(uRough.z, layerR(uRgh2, uTile.z), uHasR.z), mix(uRough.w, layerR(uRgh3, uTile.w), uHasR.w));
                    float roughnessFactor = clamp(dot(sw, rs), 0.04, 1.0);`)
                // Relief: the layers' normal maps, blended, bent onto the ground.
                .replace("#include <normal_fragment_maps>", `
                    vec2 nd = layerN(uNrm0, uTile.x) * uNScale.x * sw.x + layerN(uNrm1, uTile.y) * uNScale.y * sw.y
                            + layerN(uNrm2, uTile.z) * uNScale.z * sw.z + layerN(uNrm3, uTile.w) * uNScale.w * sw.w;
                    normal = normalize(normal + (vTanV * nd.x + vBitV * nd.y) * faceDirection);`)
                // Light the picture already had on this surface, kept as glow.
                .replace("#include <emissivemap_fragment>", `
                    #include <emissivemap_fragment>
                    totalEmissiveRadiance += diffuseColor.rgb * dot(sw, uBake);`);
        };
        const mesh = new THREE.Mesh(geom, material);
        mesh.name = "terrain";
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.userData.bepicItemId = item.id;
        this._bodyOf(entry).add(mesh);
        entry.object = mesh;
        this._originals.set(mesh, material);
        entry.terrain = { heights, seg, size: t.size, height: t.height, weights, normals: nrm.array, mesh, uniforms };
        entry.stats = { meshes: 1, vertices: pos.count, triangles: seg * seg * 2 };
    },

    /** Ground height (world Y) under world x, z on one terrain entry, or null. */
    _terrainHeightAt(entry, x, z) {
        const T = entry && entry.terrain;
        if (!T) return null;
        const { THREE } = this.libs;
        const body = this._bodyOf(entry);
        body.updateMatrixWorld(true);
        const p = body.worldToLocal(new THREE.Vector3(x, 0, z));
        const u = p.x / T.size[0] + 0.5, v = p.z / T.size[1] + 0.5;
        if (u < 0 || u > 1 || v < 0 || v > 1) return null;
        const n = T.seg + 1;
        const fx = u * T.seg, fy = v * T.seg;
        const x0 = Math.min(T.seg - 1, Math.floor(fx)), y0 = Math.min(T.seg - 1, Math.floor(fy));
        const tx = fx - x0, ty = fy - y0, H = T.heights;
        const h = (H[y0 * n + x0] * (1 - tx) + H[y0 * n + x0 + 1] * tx) * (1 - ty)
                + (H[(y0 + 1) * n + x0] * (1 - tx) + H[(y0 + 1) * n + x0 + 1] * tx) * ty;
        p.y = h * T.height;
        return body.localToWorld(p).y;
    },

    /**
     * The ground under x, z: the highest walkable terrain surface there — or,
     * with `below`, the highest one not above that height (so a bridge or an
     * upper floor over you isn't where your feet go). Null when there is none.
     */
    groundAt(x, z, below = Infinity) {
        let best = null;
        for (const entry of this._entries.values()) {
            if (!entry.terrain || entry.item.visible === false) continue;
            if (!terrainSettings(entry.item).walkable) continue;
            const y = this._terrainHeightAt(entry, x, z);
            if (y != null && y <= below && (best == null || y > best)) best = y;
        }
        return best;
    },

    // ── Scatter ──────────────────────────────────────────────────────────────

    /** Unit-height shapes for the built-in scatter types: [{geometry, part, height}]. */
    _scatterParts(type) {
        const { THREE } = this.libs;
        const cache = this._scatterGeoms || (this._scatterGeoms = {});
        if (cache[type]) return cache[type];
        const jitter = (geo, amount, seed) => {
            const r = rng(seed), p = geo.attributes.position;
            for (let i = 0; i < p.count; i++) {
                p.setXYZ(i, p.getX(i) * (1 + (r() - 0.5) * amount), p.getY(i) * (1 + (r() - 0.5) * amount),
                         p.getZ(i) * (1 + (r() - 0.5) * amount));
            }
            geo.computeVertexNormals();
            return geo;
        };
        const merge = (list) => {
            // A few non-indexed pieces into one geometry (positions + normals).
            const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
            let count = 0;
            for (const g of parts) count += g.attributes.position.count;
            const posArr = new Float32Array(count * 3), nrmArr = new Float32Array(count * 3);
            let at = 0;
            for (const g of parts) {
                g.computeVertexNormals();
                posArr.set(g.attributes.position.array, at * 3);
                nrmArr.set(g.attributes.normal.array, at * 3);
                at += g.attributes.position.count;
            }
            const out = new THREE.BufferGeometry();
            out.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
            out.setAttribute("normal", new THREE.BufferAttribute(nrmArr, 3));
            return out;
        };
        let parts;
        if (type === "pine") {
            const trunk = new THREE.CylinderGeometry(0.12, 0.2, 2.2, 6).translate(0, 1.1, 0);
            const crown = merge([
                new THREE.ConeGeometry(1.7, 3.2, 8).translate(0, 2.8, 0),
                new THREE.ConeGeometry(1.3, 2.8, 8).translate(0, 4.2, 0),
                new THREE.ConeGeometry(0.85, 2.4, 8).translate(0, 5.6, 0),
            ]);
            parts = [{ geometry: trunk, part: "trunk", height: 7 }, { geometry: crown, part: "crown", height: 7 }];
        } else if (type === "tree") {
            const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3, 6).translate(0, 1.5, 0);
            const crown = merge([
                jitter(new THREE.IcosahedronGeometry(1.9, 1), 0.25, 3).translate(0, 4.2, 0),
                jitter(new THREE.IcosahedronGeometry(1.3, 1), 0.3, 5).translate(0.9, 3.6, 0.4),
                jitter(new THREE.IcosahedronGeometry(1.2, 1), 0.3, 7).translate(-0.8, 3.7, -0.3),
            ]);
            parts = [{ geometry: trunk, part: "trunk", height: 6 }, { geometry: crown, part: "crown", height: 6 }];
        } else if (type === "bush") {
            parts = [{ geometry: jitter(new THREE.IcosahedronGeometry(0.8, 1), 0.35, 11).scale(1.2, 0.8, 1.2).translate(0, 0.55, 0),
                       part: "crown", height: 1.2 }];
        } else if (type === "grass") {
            // A clump of blades: thin triangles leaning out from the middle.
            const r = rng(17), pts = [];
            for (let b = 0; b < 9; b++) {
                const a = r() * Math.PI * 2, lean = 0.15 + r() * 0.25, h = 0.35 + r() * 0.35, w = 0.035;
                const ox = Math.cos(a) * 0.12 * r(), oz = Math.sin(a) * 0.12 * r();
                const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
                pts.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz,
                         ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
            g.computeVertexNormals();
            // Blades are lit from above, whichever way they face.
            const nrm = g.attributes.normal;
            for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
            parts = [{ geometry: g, part: "grass", height: 0.7 }];
        } else if (type === "lamp") {
            // A strip light: a thin glowing tube along X, hung under the ceiling.
            parts = [{ geometry: new THREE.BoxGeometry(1.25, 0.05, 0.12).translate(0, -0.025, 0), part: "lamp", height: 0.05 }];
        } else if (type === "column") {
            // A column one unit tall with a flared head, as in a car park or a
            // hall; the scatter's `aspect` stretches it to the room's height.
            const shaft = new THREE.CylinderGeometry(0.3, 0.3, 0.86, 16).translate(0, 0.43, 0);
            const head = new THREE.CylinderGeometry(0.75, 0.3, 0.14, 16).translate(0, 0.93, 0);
            parts = [{ geometry: merge([shaft, head]), part: "column", height: 1 }];
        } else {                                            // rock
            parts = [{ geometry: jitter(new THREE.IcosahedronGeometry(0.7, 1), 0.45, 23).scale(1.3, 0.75, 1.1).translate(0, 0.25, 0),
                       part: "rock", height: 0.8 }];
        }
        cache[type] = parts;
        return parts;
    },

    /** Parts of a model file used as a scatter source. */
    async _scatterModelParts(src) {
        const { THREE } = this.libs;
        const url = this.hooks.srcUrl && this.hooks.srcUrl(src);
        if (!url) throw new Error("this scatter's model has no file");
        const loaded = await this._load(src, url, (src.format || String(src.path || src.name || "").split(".").pop() || "glb").toLowerCase());
        loaded.object.updateMatrixWorld(true);
        const parts = [];
        const box = new THREE.Box3().setFromObject(loaded.object);
        const height = Math.max(0.01, box.max.y - box.min.y);
        loaded.object.traverse((c) => {
            if (!c.isMesh) return;
            const g = c.geometry.clone().applyMatrix4(c.matrixWorld).translate(0, -box.min.y, 0);
            parts.push({ geometry: g, part: "model", height, material: c.material });
        });
        return parts;
    },

    _windMaterial(material, wind, height) {
        if (!(wind > 0)) return material;
        const time = this._worldTime();
        material.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = time;
            shader.uniforms.uWind = { value: wind };
            shader.uniforms.uH = { value: height };
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\nuniform float uTime; uniform float uWind; uniform float uH;")
                .replace("#include <begin_vertex>", `#include <begin_vertex>
                    #ifdef USE_INSTANCING
                    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
                    #else
                    vec3 ip = vec3(0.0);
                    #endif
                    float hn = clamp(position.y / uH, 0.0, 1.0);
                    float ph = ip.x * 0.37 + ip.z * 0.29;
                    float gust = 0.6 + 0.4 * sin(uTime * 0.31 + ip.x * 0.05);
                    transformed.x += sin(uTime * 1.9 + ph) * uWind * hn * hn * 0.25 * uH * gust;
                    transformed.z += cos(uTime * 1.4 + ph * 1.3) * uWind * hn * hn * 0.15 * uH * gust;`);
        };
        material.customProgramCacheKey = () => "bepic-wind";
        return material;
    },

    async _buildScatter(entry, item) {
        const { THREE } = this.libs;
        entry.note = "";
        const s = scatterSettings(item);
        const targetEntry = this._entries.get(s.target);
        if (targetEntry && targetEntry.worldReady) await targetEntry.worldReady;
        const T = targetEntry && targetEntry.terrain;
        if (!T) throw new Error(`nothing to grow on — no terrain '${s.target}'`);

        const parts = s.source.type === "model" && s.source.src
            ? await this._scatterModelParts(s.source.src)
            : this._scatterParts(s.source.type === "model" ? "tree" : s.source.type);

        // Where things go, in the terrain's own space, then into the world.
        const r = rng(s.seed * 7 + 1);
        const tbody = this._bodyOf(targetEntry);
        tbody.updateMatrixWorld(true);
        const sbody = this._bodyOf(entry);
        sbody.updateMatrixWorld(true);
        const toScatter = new THREE.Matrix4().copy(sbody.matrixWorld).invert().multiply(tbody.matrixWorld);
        const n = T.seg + 1;
        const matrices = [];
        const q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
        const world = new THREE.Vector3();
        const m = new THREE.Matrix4();
        // Where to try: a regular grid (offset by the seed), or random spots.
        const spots = [];
        if (s.grid) {
            const ox = r() * s.grid[0], oz = r() * s.grid[1];
            for (let z = -T.size[1] / 2 + oz; z < T.size[1] / 2; z += s.grid[1]) {
                for (let x = -T.size[0] / 2 + ox; x < T.size[0] / 2; x += s.grid[0]) {
                    spots.push([x / T.size[0] + 0.5, z / T.size[1] + 0.5]);
                }
            }
            // Middle out, so a count that doesn't cover the grid trims the rim
            // rather than leaving one half of the room bare.
            spots.sort((a, b) => Math.hypot(a[0] - 0.5, a[1] - 0.5) - Math.hypot(b[0] - 0.5, b[1] - 0.5));
        }
        const maxTries = s.grid ? spots.length : s.count * 8;
        for (let tries = 0; matrices.length < s.count && tries < maxTries; tries++) {
            const [u, v] = s.grid ? spots[tries] : [r() * 0.98 + 0.01, r() * 0.98 + 0.01];
            if (u < 0.005 || u > 0.995 || v < 0.005 || v > 0.995) continue;
            const gx = Math.round(u * T.seg), gy = Math.round(v * T.seg), vi = gy * n + gx;
            const ny = T.normals[vi * 3 + 1];
            const slope = Math.acos(Math.min(1, Math.max(-1, ny))) / DEG;
            if (slope > s.maxSlope) continue;
            if (s.layer >= 0) {
                const w = T.weights, sum = w[vi * 4] + w[vi * 4 + 1] + w[vi * 4 + 2] + w[vi * 4 + 3] || 1;
                if (r() > w[vi * 4 + s.layer] / sum) continue;
            }
            p.set((u - 0.5) * T.size[0], 0, (v - 0.5) * T.size[1]);
            // Height by the same bilinear read the walk uses, so nothing floats.
            const fx = u * T.seg, fy = v * T.seg, x0 = Math.min(T.seg - 1, Math.floor(fx)), y0 = Math.min(T.seg - 1, Math.floor(fy));
            const tx = fx - x0, ty = fy - y0, H = T.heights;
            p.y = ((H[y0 * n + x0] * (1 - tx) + H[y0 * n + x0 + 1] * tx) * (1 - ty)
                 + (H[(y0 + 1) * n + x0] * (1 - tx) + H[(y0 + 1) * n + x0 + 1] * tx) * ty) * T.height - 0.05 + s.lift;
            world.copy(p).applyMatrix4(tbody.matrixWorld);
            if (inClearArea(s.clear, world.x, world.z)) continue;
            const size = s.scale[0] + (s.scale[1] - s.scale[0]) * r();
            const tilt = s.source.type === "rock" ? 0.4 : (s.source.type === "grass" ? 0.15
                       : (s.source.type === "column" || s.source.type === "lamp" ? 0 : 0.05));
            // Lamps hang in rows, all one way; everything else turns at random.
            e.set((r() - 0.5) * tilt, s.source.type === "lamp" ? 0 : r() * Math.PI * 2, (r() - 0.5) * tilt);
            q.setFromEuler(e);
            const vary = s.source.type === "column" ? 1 : 0.85 + r() * 0.3;
            sc.set(size, size * vary * s.aspect, size);
            m.compose(p, q, sc).premultiply(toScatter);
            matrices.push(m.clone());
        }

        const group = new THREE.Group();
        group.name = "scatter";
        const base = new THREE.Color(s.color);
        const trunkColor = new THREE.Color("#5b4636");
        const cr = rng(s.seed * 13 + 5);
        const tints = matrices.map(() => 0.82 + cr() * 0.3);
        for (const part of parts) {
            const flat = part.part === "rock" || part.part === "crown";
            // (a column is smooth-shaded: it is round)
            const rough = s.roughness != null ? s.roughness
                : (part.part === "trunk" ? 0.9 : (ROUGHNESS[s.source.type] ?? 0.85));
            let material = part.material && part.part === "model" ? part.material.clone()
                : new THREE.MeshStandardMaterial({
                    color: part.part === "trunk" ? trunkColor : 0xffffff,
                    roughness: rough, metalness: 0, flatShading: flat,
                    side: part.part === "grass" ? THREE.DoubleSide : THREE.FrontSide,
                });
            if (part.part === "lamp" || s.emissive > 0) {
                // Glows by itself (and blooms), whatever the light around it.
                material.emissive = new THREE.Color(s.color);
                material.emissiveIntensity = s.emissive || 6;
            }
            if (part.part !== "trunk" && part.part !== "model" && part.part !== "column") {
                material = this._windMaterial(material, s.wind, part.height);
            }
            if (part.part === "model" && s.wind > 0) material = this._windMaterial(material, s.wind * 0.5, part.height);
            const mesh = new THREE.InstancedMesh(part.geometry, material, Math.max(1, matrices.length));
            mesh.count = matrices.length;
            matrices.forEach((mat, i) => {
                mesh.setMatrixAt(i, mat);
                if (part.part !== "trunk" && part.part !== "model") {
                    mesh.setColorAt(i, base.clone().multiplyScalar(tints[i]));
                }
            });
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.computeBoundingSphere();
            mesh.castShadow = part.part !== "grass" && part.part !== "lamp";
            mesh.receiveShadow = true;
            mesh.userData.bepicItemId = item.id;
            mesh.userData.sharedGeometry = !part.material;       // built-in shapes are cached
            group.add(mesh);
            this._originals.set(mesh, material);
        }
        this._bodyOf(entry).add(group);
        entry.object = group;
        entry.stats = { meshes: parts.length, instances: matrices.length };
        if (matrices.length < s.count) {
            entry.note = `${matrices.length} of ${s.count} placed — the rest had no ground that fits (layer, slope, clearings)`;
        }
    },

    // ── Lights ───────────────────────────────────────────────────────────────

    /** A point light and the fixture it hangs in, glowing in the light's colour. */
    _buildLight(entry, item) {
        const { THREE } = this.libs;
        const l = lightSettings(item);
        const group = new THREE.Group();
        group.name = "light";
        const light = new THREE.PointLight(new THREE.Color(l.color), l.intensity, l.distance, l.decay);
        light.castShadow = l.shadows;
        if (l.shadows) { light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.002; }
        group.add(light);
        if (l.fixture.shape !== "none") {
            const [len, wid, th] = l.fixture.size;
            const geo = l.fixture.shape === "panel"
                ? new THREE.BoxGeometry(Math.max(len, 0.05), Math.max(th, 0.01), Math.max(len, 0.05))
                : new THREE.BoxGeometry(Math.max(len, 0.05), Math.max(th, 0.01), Math.max(wid, 0.02));
            const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(l.color),
                                                         emissiveIntensity: l.fixture.emissive, roughness: 0.4 });
            const fixture = new THREE.Mesh(geo, mat);
            fixture.position.y = Math.max(th, 0.01) / 2;
            fixture.userData.bepicItemId = item.id;
            group.add(fixture);
            this._originals.set(fixture, mat);
        }
        group.traverse((c) => { c.userData.bepicItemId = item.id; });
        this._bodyOf(entry).add(group);
        entry.object = group;
        entry.stats = { format: "light" };
    },

    // ── Depth mesh ───────────────────────────────────────────────────────────

    async _buildDepthMesh(entry, item) {
        const { THREE } = this.libs;
        const d = depthMeshSettings(item);
        if (!d.src || !d.depth) throw new Error("a depth mesh needs a picture and a depth map");
        const [tex, px] = await Promise.all([
            this._loadTexture(this.hooks.srcUrl(d.src)),
            this._worldPixels(d.depth, 1024),
        ]);
        tex.colorSpace = THREE.SRGBColorSpace;
        const aspect = (tex.image.width || px.width) / (tex.image.height || px.height);
        const sx = aspect >= 1 ? d.segments : Math.max(8, Math.round(d.segments * aspect));
        const sy = aspect >= 1 ? Math.max(8, Math.round(d.segments / aspect)) : d.segments;
        const tanV = Math.tan((d.fov * DEG) / 2), tanH = tanV * aspect;
        const decode = d.encoding === "rg16"
            ? (arr, i) => (arr[i] * 256 + arr[i + 1]) / 65535
            : (arr, i) => (arr[i] + arr[i + 1] + arr[i + 2]) / 765;
        const cols = sx + 1, rows = sy + 1;
        const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2), dist = new Float32Array(cols * rows);
        const sky = new Uint8Array(cols * rows);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const u = x / sx, v = y / sy, i = y * cols + x;
                let disp = this._sample(px, u, v, decode);
                if (d.invert) disp = 1 - disp;
                // Depth models give the sky (nothing there) a depth of zero. As
                // geometry that is a painted wall at `far`, hiding the world's own
                // sky and hills; it is left out instead.
                sky[i] = disp < 0.0015 ? 1 : 0;
                // Depth maps store inverse depth: 1 is `near`, 0 is `far` —
                // or the builder's curve, where the map isn't one straight line.
                const z = d.curve ? curveDepth(d.curve, disp) : 1 / (disp / d.near + (1 - disp) / d.far);
                dist[i] = z;
                pos.set([(u - 0.5) * 2 * tanH * z, (0.5 - v) * 2 * tanV * z, -z], i * 3);
                uv.set([u, 1 - v], i * 2);
            }
        }
        // Tear where depth jumps: a foreground edge and the background behind
        // it are not one surface, and a skin stretched between them is the
        // most obvious sign of a 2.5D picture.
        const index = [];
        for (let y = 0; y < sy; y++) {
            for (let x = 0; x < sx; x++) {
                const a = y * cols + x, b = a + 1, c = a + cols, e = c + 1;
                if (sky[a] || sky[b] || sky[c] || sky[e]) continue;
                const zs = [dist[a], dist[b], dist[c], dist[e]];
                if (Math.max(...zs) / Math.min(...zs) - 1 > d.cut) continue;
                index.push(a, c, b, b, c, e);
            }
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        geom.setIndex(index);
        // Where the picture's ground lies on the terrain's (it is calibrated to),
        // the two would fight pixel by pixel; the picture wins.
        const material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false, fog: false,
                                                       polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 });
        if (d.motion) await this._depthMotion(entry, material, d.motion);
        const mesh = new THREE.Mesh(geom, material);
        mesh.name = "imageplane";          // keeps its picture in clay/normal modes, like an image plane
        mesh.userData.bepicItemId = item.id;
        this._bodyOf(entry).add(mesh);
        entry.object = mesh;
        this._originals.set(mesh, material);
        entry.stats = { meshes: 1, vertices: cols * rows, triangles: index.length / 3 };
    },

    /**
     * Ambient motion on the depth mesh: a looping video of the picture, mixed
     * in where the mask is white. The video starts and ends on the picture, so
     * outside the moving parts nothing changes and the loop has no jump.
     */
    async _depthMotion(entry, material, motion) {
        const { THREE } = this.libs;
        // In the panel's own document: an undocked viewer lives in another window.
        const video = this.doc.createElement("video");
        Object.assign(video, { loop: true, muted: true, playsInline: true, crossOrigin: "anonymous", preload: "auto" });
        // Mixed in only once there are frames: until then (a slow file, or a
        // background tab, where Chrome doesn't load media at all) the still
        // picture shows, never a black hole.
        const on = { value: 0 };
        video.addEventListener("loadeddata", () => { on.value = 1; video.play().catch(() => {}); this.requestRender(); });
        video.addEventListener("error", () => console.warn("[bEpicViewer] motion video did not load", motion.src));
        video.src = this.hooks.srcUrl(motion.src);
        video.play().catch(() => {});
        const vtex = new THREE.VideoTexture(video);
        vtex.colorSpace = THREE.SRGBColorSpace;
        const mtex = motion.mask ? await this._loadTexture(this.hooks.srcUrl(motion.mask)) : null;
        const uniforms = { uMotion: { value: vtex }, uMotionOn: on };
        if (mtex) uniforms.uMotionMask = { value: mtex };
        material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            shader.fragmentShader = shader.fragmentShader
                .replace("void main() {", `uniform sampler2D uMotion;\nuniform float uMotionOn;\n${mtex ? "uniform sampler2D uMotionMask;\n" : ""}void main() {`)
                .replace("#include <map_fragment>", `#include <map_fragment>
                    {
                        float motionAmount = uMotionOn * ${mtex ? "texture2D(uMotionMask, vMapUv).r" : "1.0"};
                        diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uMotion, vMapUv).rgb, motionAmount);
                    }`);
        };
        material.customProgramCacheKey = () => (mtex ? "depthmotion-mask" : "depthmotion");
        material.needsUpdate = true;
        entry.motion = { video, uniforms, textures: [vtex, mtex].filter(Boolean) };
    },

    _stopMotion(entry) {
        if (!entry.motion) return;
        const { video, textures } = entry.motion;
        video.pause();
        video.removeAttribute("src");
        video.load();
        for (const t of textures) t.dispose();
        entry.motion = null;
    },

    // ── Animation ────────────────────────────────────────────────────────────

    /** Called every frame from _tick. True while something moves by itself. */
    _worldTick(dt) {
        let windy = false;
        for (const e of this._entries.values()) {
            if (e.item.kind === "scatter" && e.object && e.item.visible !== false
                && scatterSettings(e.item).wind > 0) { windy = true; break; }
        }
        if (windy && !this._rendering) this._worldTime().value += Math.min(dt, 0.1);
        if (this._walk) this._walkStep(Math.min(dt, 0.1));
        let moving = false;
        for (const e of this._entries.values()) {
            if (e.motion && e.object && e.item.visible !== false) { moving = true; break; }
        }
        return (windy || moving || !!this._walk) && this.visible;
    },

    // ── Walking ──────────────────────────────────────────────────────────────

    get walking() { return !!this._walk; },

    /**
     * First-person walking on the free camera: mouse to look (pointer lock,
     * or drag when the browser won't lock), W A S D or the arrows to walk,
     * Shift to run, F to leave a note where you look, Esc to stop. Feet follow
     * the ground; the walk stays inside the world's bounds.
     */
    walkEnter() {
        if (this._walk || !this.canvas || !this.libs) return false;
        const { THREE } = this.libs;
        const walk = walkSettings(this.scene3d);
        const cam = this.camera;
        const prev = { active: this.scene3d ? this.scene3d.activeCamera : null,
                       position: cam.position.clone(), quaternion: cam.quaternion.clone(),
                       target: this.controls ? this.controls.target.clone() : null };
        // Walking moves the free camera, never a shot camera.
        const from = this.activeCameraObject();
        let pos = from.position.clone(), yaw;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(from.quaternion);
        yaw = Math.atan2(-fwd.x, -fwd.z);
        if (walk.spawn && !this._walkedHere) {
            pos = new THREE.Vector3(...walk.spawn);
            yaw = -walk.yaw * DEG;
        }
        this._walkedHere = true;
        if (this.scene3d) this.scene3d.activeCamera = null;
        this._walk = { prev, yaw, pitch: 0, keys: new Set(), settings: walk, pos, vy: 0, drag: null };
        cam.near = 0.05;
        cam.far = SKY_RADIUS * 2.5;
        cam.fov = 60;
        cam.updateProjectionMatrix();
        if (this.controls) this.controls.enabled = false;
        if (this.gizmo) this.gizmo.enabled = false;
        const W = this._walk;
        W.onKey = (ev) => {
            if (!this._walk) return;
            const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
            const mine = ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift", "f", "Escape"];
            if (!mine.includes(k)) return;
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.type === "keydown") {
                if (k === "Escape") { this.walkExit(); return; }
                if (k === "f" && !ev.repeat) { this._walkNote(); return; }
                W.keys.add(k);
            } else {
                W.keys.delete(k);
            }
        };
        W.onMove = (ev) => {
            const locked = this.doc.pointerLockElement === this.canvas;
            if (!locked && !W.drag) return;
            const dx = locked ? ev.movementX : ev.clientX - W.drag.x;
            const dy = locked ? ev.movementY : ev.clientY - W.drag.y;
            if (!locked) W.drag = { x: ev.clientX, y: ev.clientY };
            W.yaw -= dx * 0.0022;
            W.pitch = Math.max(-1.45, Math.min(1.45, W.pitch - dy * 0.0022));
            this.requestRender();
        };
        W.onDown = (ev) => {
            if (this.doc.pointerLockElement !== this.canvas) {
                W.drag = { x: ev.clientX, y: ev.clientY };
                try { this.canvas.requestPointerLock(); } catch (e) { /* drag to look instead */ }
            }
        };
        W.onUp = () => { W.drag = null; };
        W.onLock = () => {
            // Esc releases the pointer first; that alone doesn't end the walk,
            // so the notes prompt (which also releases it) can come back.
            this._setStatus(this.doc.pointerLockElement === this.canvas
                ? "" : "Walking — click to look around · W A S D to move · Shift run · F note · Esc stop");
        };
        const win = this.win;
        win.addEventListener("keydown", W.onKey, true);
        win.addEventListener("keyup", W.onKey, true);
        this.doc.addEventListener("mousemove", W.onMove);
        this.canvas.addEventListener("mousedown", W.onDown);
        this.doc.addEventListener("mouseup", W.onUp);
        this.doc.addEventListener("pointerlockchange", W.onLock);
        W.blur = () => W.keys.clear();
        win.addEventListener("blur", W.blur);
        try { this.canvas.requestPointerLock(); } catch (e) { /* drag to look */ }
        this.root.classList.add("walking");
        this._setStatus("Walking — click to look around · W A S D to move · Shift run · F note · Esc stop");
        this._walkStep(0);
        this._syncGate();
        this._syncSelection && this._syncSelection();
        if (this.hooks.onWalkChange) this.hooks.onWalkChange(true);
        this.requestRender();
        return true;
    },

    walkExit() {
        const W = this._walk;
        if (!W) return;
        const win = this.win;
        win.removeEventListener("keydown", W.onKey, true);
        win.removeEventListener("keyup", W.onKey, true);
        win.removeEventListener("blur", W.blur);
        this.doc.removeEventListener("mousemove", W.onMove);
        this.canvas && this.canvas.removeEventListener("mousedown", W.onDown);
        this.doc.removeEventListener("mouseup", W.onUp);
        this.doc.removeEventListener("pointerlockchange", W.onLock);
        if (this.doc.pointerLockElement) { try { this.doc.exitPointerLock(); } catch (e) {} }
        this._walk = null;
        // Leave the orbit camera where the walk ended, looking where you looked.
        const { THREE } = this.libs;
        const cam = this.camera;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        if (this.controls) {
            this.controls.target.copy(cam.position).addScaledVector(fwd, 10);
            this.controls.enabled = true;
            this.controls.update();
        }
        cam.fov = 35;
        cam.updateProjectionMatrix();
        if (this.scene3d && W.prev.active) this.scene3d.activeCamera = W.prev.active;
        if (this.gizmo) this.gizmo.enabled = true;
        this.root && this.root.classList.remove("walking");
        this._setStatus("");
        this._syncGate();
        this._syncSelection && this._syncSelection();
        if (this.hooks.onWalkChange) this.hooks.onWalkChange(false);
        this.requestRender();
    },

    walkToggle() {
        return this._walk ? (this.walkExit(), false) : this.walkEnter();
    },

    _walkStep(dt) {
        const W = this._walk;
        if (!W) return;
        const { THREE } = this.libs;
        const k = W.keys;
        const run = k.has("Shift") ? 2.6 : 1;
        const f = (k.has("w") || k.has("ArrowUp") ? 1 : 0) - (k.has("s") || k.has("ArrowDown") ? 1 : 0);
        const s = (k.has("d") || k.has("ArrowRight") ? 1 : 0) - (k.has("a") || k.has("ArrowLeft") ? 1 : 0);
        const speed = W.settings.speed * run * dt;
        const sin = Math.sin(W.yaw), cos = Math.cos(W.yaw);
        const nx = W.pos.x + (-sin * f + cos * s) * speed;
        const nz = W.pos.z + (-cos * f - sin * s) * speed;
        const b = W.settings.bounds;
        if (b) {
            const dx = nx - b.center[0], dz = nz - b.center[1], d = Math.hypot(dx, dz);
            if (d > b.radius) { W.pos.x = b.center[0] + dx / d * b.radius; W.pos.z = b.center[1] + dz / d * b.radius; }
            else { W.pos.x = nx; W.pos.z = nz; }
        } else {
            W.pos.x = nx; W.pos.z = nz;
        }
        // Feet go to the ground below the eyes (a step up is fine), never onto
        // something overhead.
        const ground = this.groundAt(W.pos.x, W.pos.z, W.pos.y - W.settings.eyeHeight + 0.6);
        if (ground != null) {
            const want = ground + W.settings.eyeHeight;
            // Up a step at once, down a slope gently — no floating off ledges.
            W.pos.y = want > W.pos.y ? want : Math.max(want, W.pos.y - Math.max(0.5, 9.8 * dt * 2));
        }
        const cam = this.camera;
        cam.position.copy(W.pos);
        cam.quaternion.setFromEuler(new THREE.Euler(W.pitch, W.yaw, 0, "YXZ"));
        cam.updateMatrixWorld(true);
    },

    /** F while walking: a note about what is in the middle of the view. */
    _walkNote() {
        const { THREE } = this.libs;
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
        const point = this._worldHitPoint(ray);
        if (this.doc.pointerLockElement) { try { this.doc.exitPointerLock(); } catch (e) {} }
        this._walk && this._walk.keys.clear();
        if (this.hooks.onFeedbackRequest) this.hooks.onFeedbackRequest(point, this.feedbackView());
    },

    // ── Feedback ─────────────────────────────────────────────────────────────

    /** The point a ray first meets on anything solid, or 30 m along it. */
    _worldHitPoint(ray) {
        const roots = [];
        for (const e of this._entries.values()) if (e.object && e.item.kind !== "environment") roots.push(e.root);
        const hits = ray.intersectObjects(roots, true);
        const p = hits.length ? hits[0].point : ray.ray.at(30, new this.libs.THREE.Vector3());
        return [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100);
    },

    /** The point under a mouse event, for a note placed by clicking. */
    worldPointAt(ev) {
        const { THREE } = this.libs;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1,
                                      -((ev.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        return this._worldHitPoint(ray);
    },

    /** Where the user is looking from, and what they see — kept with a note. */
    feedbackView() {
        const { THREE } = this.libs;
        const cam = this.activeCameraObject();
        const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "YXZ");
        const view = {
            position: cam.position.toArray().map((v) => Math.round(v * 100) / 100),
            yaw: Math.round(-e.y / DEG * 10) / 10, pitch: Math.round(e.x / DEG * 10) / 10,
            fov: Math.round(cam.fov * 10) / 10,
        };
        let snapshot = null;
        try {
            // Rendered and read in one go: the canvas keeps no copy of the frame.
            const pins = this._pinGroup, pinsVisible = pins && pins.visible;
            if (pins) pins.visible = false;
            this._worldRender(cam);              // as seen: bloom and tone mapping included
            if (pins) pins.visible = pinsVisible;
            const src = this.renderer.domElement;
            const s = Math.min(1, 960 / Math.max(src.width, src.height));
            const out = this.doc.createElement("canvas");
            out.width = Math.round(src.width * s); out.height = Math.round(src.height * s);
            out.getContext("2d").drawImage(src, 0, 0, out.width, out.height);
            snapshot = out.toDataURL("image/jpeg", 0.85);
        } catch (err) { console.warn("[bEpicViewer] no snapshot for the note", err); }
        this.requestRender();
        return { camera: view, snapshot };
    },

    /** Numbered pins for a world's open notes. */
    syncFeedbackPins() {
        if (!this.libs || !this.scene) return;
        const { THREE } = this.libs;
        const info = worldInfo(this.scene3d);
        const pins = (info && info.feedback.filter((f) => f.point)) || [];
        const sig = JSON.stringify(pins);
        if (sig === this._pinSig) return;
        this._pinSig = sig;
        if (this._pinGroup) {
            this.scene.remove(this._pinGroup);
            this._pinGroup.traverse((c) => { if (c.material) { c.material.map && c.material.map.dispose(); c.material.dispose(); } });
        }
        this._pinGroup = null;
        if (!pins.length) { this.requestRender(); return; }
        const group = new THREE.Group();
        group.name = "feedback-pins";
        for (const f of pins) {
            const c = this.doc.createElement("canvas");
            c.width = c.height = 64;
            const g = c.getContext("2d");
            g.fillStyle = f.local ? "#8a8a8a" : "#ff6600";
            g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fill();
            g.lineWidth = 4; g.strokeStyle = "#fff"; g.stroke();
            g.fillStyle = "#fff"; g.font = "bold 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
            g.fillText(String(f.n || "?"), 32, 34);
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, toneMapped: false, fog: false }));
            sprite.scale.set(0.045, 0.045, 1);
            sprite.position.set(f.point[0], f.point[1] + 0.3, f.point[2]);
            sprite.renderOrder = 1000;
            sprite.userData.feedback = f;
            group.add(sprite);
        }
        this.scene.add(group);
        this._pinGroup = group;
        this.requestRender();
    },

    /** The note under the pointer, if a pin was clicked. */
    pickFeedbackPin(e) {
        if (!this._pinGroup || !this.libs) return null;
        const { THREE } = this.libs;
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1,
                                      -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.activeCameraObject());
        const hit = ray.intersectObjects(this._pinGroup.children, false)[0];
        return hit ? hit.object.userData.feedback : null;
    },

    // ── The reference over a camera's view ───────────────────────────────────

    /**
     * Looking through a camera that has a reference picture: the picture sits
     * on the gate at its opacity, covering `wipe` of the width from the left —
     * drag the wipe from 1 to 0 and the world is uncovered behind it.
     */
    _syncReference(entry, gate) {
        const ref = entry && entry.item && entry.item.kind === "camera" ? referenceSettings(entry.item) : null;
        let img = this._refImg;
        if (!ref || this._walk || !gate) { if (img) img.style.display = "none"; return; }
        if (!img) {
            img = this.doc.createElement("img");
            img.className = "model-reference";
            img.draggable = false;
            Object.assign(img.style, { position: "absolute", pointerEvents: "none", zIndex: "2", objectFit: "fill" });
            this.root.insertBefore(img, this.ui && this.ui.gate ? this.ui.gate : null);
            this._refImg = img;
        }
        const url = this.hooks.srcUrl && this.hooks.srcUrl(ref.src);
        if (url && img.dataset.url !== url) { img.src = url; img.dataset.url = url; }
        const px = (v) => `${Math.round(v)}px`;
        Object.assign(img.style, {
            display: "block", left: px(gate.x), top: px(gate.y), width: px(gate.w), height: px(gate.h),
            opacity: String(ref.opacity), clipPath: `inset(0 ${Math.round((1 - ref.wipe) * 1000) / 10}% 0 0)`,
        });
    },
};
