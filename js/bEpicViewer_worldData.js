// bEpicViewer_worldData.js
// The world item kinds, as data: what an environment, a terrain, a scatter
// and a depth mesh hold, their defaults, and how a stored one is made sane.
//
// Plain data and pure functions, like bEpicViewer_scene3d.js (which reads
// scenes through these) — no three.js, no DOM. The builder that writes worlds
// lives in its own repo (ComfyUI-bEpicWorlds); its SCHEMA.md and this file
// describe the same thing, and this file is what the viewer believes.
//
// Units are metres, Y is up, and a reference camera looks down -Z. A sun
// azimuth of 0 is straight ahead (-Z), +90 to the right (+X); elevation is
// degrees above the horizon.

export const WORLD_KINDS = ["environment", "terrain", "scatter", "depthmesh", "light"];
export const SCATTER_TYPES = ["pine", "tree", "bush", "grass", "rock", "column", "lamp", "model"];
export const TONE_CURVES = ["neutral", "aces", "agx", "linear"];
export const SKY_MODES = ["gradient", "panorama"];

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, d, lo = -Infinity, hi = Infinity) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const col = (v, d) => (typeof v === "string" && HEX.test(v) ? v : d);
const file = (v) => (v && typeof v === "object" && (v.path || v.url || v.filename) ? v : null);
const pair = (v, d, lo = -Infinity, hi = Infinity) => (Array.isArray(v) && v.length === 2
    ? [num(v[0], d[0], lo, hi), num(v[1], d[1], lo, hi)] : d.slice());

export function environmentSettings(item) {
    const it = item || {};
    const sky = it.sky || {}, sun = it.sun || {}, fog = it.fog || {}, amb = it.ambient || {}, ren = it.render || {};
    return {
        sky: {
            mode: SKY_MODES.includes(sky.mode) ? sky.mode : "gradient",
            top: col(sky.top, "#4a78b8"),
            horizon: col(sky.horizon, "#b9cde0"),
            bottom: col(sky.bottom, "#6d6a5e"),
            src: file(sky.src),
            // A high-dynamic-range panorama (.hdr / .exr, e.g. a photographed
            // HDRI): read at full range, and — with `lighting` — the light and
            // the reflections of the whole world, not just its backdrop.
            hdr: sky.hdr === true || /\.(hdr|exr)$/i.test(String((sky.src && (sky.src.path || sky.src.name || sky.src.filename)) || "")),
            lighting: sky.lighting === true,
            intensity: num(sky.intensity, 1, 0, 100),
        },
        sun: {
            azimuth: num(sun.azimuth, 150),
            elevation: num(sun.elevation, 35, -90, 90),
            color: col(sun.color, "#fff4e6"),
            intensity: num(sun.intensity, 2.6, 0, 50),
            shadows: sun.shadows !== false,
        },
        fog: { color: col(fog.color, "#c3cfd8"), density: num(fog.density, 0.004, 0, 1) },
        ambient: {
            sky: col(amb.sky, "#9fb8d6"), ground: col(amb.ground, "#5a5548"),
            intensity: num(amb.intensity, 0.9, 0, 20),
        },
        // How the world is drawn: tone curve, exposure on top of the viewer's
        // own, bloom strength, and reflections captured from the world itself.
        render: {
            tone: TONE_CURVES.includes(ren.tone) ? ren.tone : "linear",
            exposure: num(ren.exposure, 1, 0.01, 100),
            bloom: num(ren.bloom, 0, 0, 5),
            // "capture": taken from the world itself at the walk start; "sky":
            // the sky panorama's own (an HDRI that lights the world); "off".
            reflections: ["capture", "sky"].includes(ren.reflections) ? ren.reflections : "off",
            fill: num(ren.fill, 0.35, 0, 1),
        },
    };
}

/** A light: a point light, and the fixture it hangs in (a glowing tube or panel). */
export function lightSettings(item) {
    const l = (item && item.light) || {};
    const f = l.fixture || {};
    const size = Array.isArray(f.size) && f.size.length === 3 ? f.size.map((v) => num(v, 0.1, 0, 100)) : [1.2, 0.14, 0.05];
    return {
        type: "point",
        color: col(l.color, "#fff6e8"),
        intensity: num(l.intensity, 18, 0, 100000),
        distance: num(l.distance, 14, 0, 100000),
        decay: num(l.decay, 2, 0, 4),
        shadows: !!l.shadows,
        fixture: { shape: ["tube", "panel", "none"].includes(f.shape) ? f.shape : "tube", size,
                   emissive: num(f.emissive, 6, 0, 1000) },
    };
}

const DEFAULT_LAYERS = [
    { name: "ground", src: null, color: "#5f7a3c", tile: 9 },
    { name: "rock", src: null, color: "#7c776d", tile: 14 },
    { name: "cliff", src: null, color: "#4f4b45", tile: 20 },
    { name: "peak", src: null, color: "#eef1f5", tile: 20 },
];

export function terrainSettings(item) {
    const t = (item && item.terrain) || {};
    const layers = DEFAULT_LAYERS.map((d, i) => {
        const l = (Array.isArray(t.layers) && t.layers[i]) || {};
        return { name: typeof l.name === "string" ? l.name : d.name, src: file(l.src),
                 color: col(l.color, d.color), tile: num(l.tile, d.tile, 0.1, 10000),
                 // PBR: a normal map, a roughness map, and the roughness the
                 // surface was read as (used where there is no map).
                 normal: file(l.normal), rough: file(l.rough),
                 roughness: num(l.roughness, 0.9, 0.02, 1), normalScale: num(l.normalScale, 1, 0, 10),
                 // How much of the texture's own (photographed) light it keeps
                 // as glow, 0..1 — a ceiling lit by the picture's lamps.
                 baked: num(l.baked, 0, 0, 2) };
    });
    const r = t.rules || {};
    return {
        heightmap: file(t.heightmap),
        encoding: t.encoding === "rg16" ? "rg16" : "gray",
        splat: file(t.splat),
        seed: Math.round(num(t.seed, 0)),
        roughness: num(t.roughness, 0.5, 0.05, 0.95),
        size: pair(t.size, [200, 200], 1, 100000),
        height: num(t.height, 20, 0, 10000),
        segments: Math.round(num(t.segments, 256, 8, 512)),
        // A ceiling is a terrain turned over; you don't stand on it.
        walkable: t.walkable !== false,
        layers,
        rules: {
            rockSlope: pair(r.rockSlope, [24, 38], 0, 90),
            cliffSlope: pair(r.cliffSlope, [40, 56], 0, 90),
            peak: pair(r.peak, [0.9, 1.01], 0, 2),
        },
    };
}

// Areas a scatter leaves empty: circles {center: [x, z], radius}, or wedges
// {wedge: {apex: [x, z], yaw, half, range}} — the view a picture already
// covers, yaw 0 looking down -Z, `half` degrees either side.
function _clearList(v) {
    const list = Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
    const out = [];
    for (const c of list) {
        if (c && Array.isArray(c.center)) {
            out.push({ center: [num(c.center[0], 0), num(c.center[1], 0)], radius: num(c.radius, 5, 0) });
        } else if (c && c.wedge && Array.isArray(c.wedge.apex)) {
            const w = c.wedge;
            out.push({ wedge: { apex: [num(w.apex[0], 0), num(w.apex[1], 0)], yaw: num(w.yaw, 0),
                                half: num(w.half, 30, 0, 180), range: num(w.range, 100, 0) } });
        }
    }
    return out;
}

/** Whether world x, z lies in one of a scatter's clear areas. */
export function inClearArea(clear, x, z) {
    for (const c of clear || []) {
        if (c.center) {
            if (Math.hypot(x - c.center[0], z - c.center[1]) < c.radius) return true;
        } else if (c.wedge) {
            const w = c.wedge, dx = x - w.apex[0], dz = z - w.apex[1], d = Math.hypot(dx, dz);
            if (d > w.range) continue;
            // Angle from the wedge's axis (yaw 0 = -Z, +90 = +X).
            const ang = Math.atan2(dx, -dz) * 180 / Math.PI - w.yaw;
            const off = Math.abs(((ang + 540) % 360) - 180);
            if (off <= w.half) return true;
        }
    }
    return false;
}

export function scatterSettings(item) {
    const s = (item && item.scatter) || {};
    const source = s.source || {};
    return {
        target: typeof s.target === "string" ? s.target : "terrain",
        source: { type: SCATTER_TYPES.includes(source.type) ? source.type : "tree", src: file(source.src) },
        count: Math.round(num(s.count, 500, 0, 200000)),
        seed: Math.round(num(s.seed, 1)),
        scale: pair(s.scale, [0.8, 1.4], 0.01, 100),
        layer: Math.round(num(s.layer, 0, -1, 3)),
        maxSlope: num(s.maxSlope, 32, 0, 90),
        color: col(s.color, "#3f6b2e"),
        wind: num(s.wind, 0.3, 0, 5),
        clear: _clearList(s.clear),
        // A regular layout [dx, dz] in metres (columns in a hall), or null for
        // random; and a stretch of the height alone (a column as tall as the room).
        grid: Array.isArray(s.grid) && s.grid.length >= 2 ? pair(s.grid.slice(0, 2), [8, 8], 0.2, 1000) : null,
        aspect: num(s.aspect, 1, 0.01, 1000),
        // Hung this far above the ground (lamps under a ceiling), glowing this
        // strongly (a lamp), and the surface's roughness (null: by type).
        lift: num(s.lift, 0, -1000, 1000),
        emissive: num(s.emissive, 0, 0, 1000),
        roughness: s.roughness == null ? null : num(s.roughness, 0.85, 0.02, 1),
    };
}

export function depthMeshSettings(item) {
    const d = (item && item.depthmesh) || {};
    return {
        src: file(d.src), depth: file(d.depth),
        // "rg16": 16 bits in red (high) and green (low), as heightmaps are
        // stored — a depth map needs them; "gray" is an ordinary picture.
        encoding: d.encoding === "rg16" ? "rg16" : "gray",
        fov: num(d.fov, 50, 1, 170),
        near: num(d.near, 2, 0.01), far: num(d.far, 100, 0.02),
        cut: num(d.cut, 0.12, 0, 5),
        invert: !!d.invert,
        // [d, metres] pairs, interpolated in inverse depth — how the builder
        // says "the fit holds here, stretch the rest"; null for plain near/far.
        curve: Array.isArray(d.curve) && d.curve.length >= 2
            ? d.curve.filter((p) => Array.isArray(p) && p.length === 2)
                .map((p) => [num(p[0], 0, 0, 1), num(p[1], 1, 0.01)]).sort((a, b) => a[0] - b[0])
            : null,
        segments: Math.round(num(d.segments, 256, 8, 1024)),
        // A loop of the picture moving (it starts and ends on the picture),
        // played where the mask is white; the rest stays the still picture.
        motion: d.motion && file(d.motion.src)
            ? { src: d.motion.src, mask: file(d.motion.mask) ? d.motion.mask : null } : null,
    };
}

export function referenceSettings(item) {
    const r = item && item.reference;
    if (!r || !file(r.src)) return null;
    return { src: r.src, opacity: num(r.opacity, 0.5, 0, 1), wipe: num(r.wipe, 1, 0, 1) };
}

export function walkSettings(scene) {
    const w = (scene && scene.walk) || {};
    const b = w.bounds || {};
    const sp = Array.isArray(w.spawn) && w.spawn.length === 3 ? w.spawn.map((v) => num(v, 0)) : null;
    return {
        spawn: sp, yaw: num(w.yaw, 0),
        eyeHeight: num(w.eyeHeight, 1.7, 0.1, 100),
        speed: num(w.speed, 5, 0.1, 500),
        bounds: b && Array.isArray(b.center)
            ? { center: [num(b.center[0], 0), num(b.center[1], 0)], radius: num(b.radius, 100, 1) } : null,
    };
}

export function worldInfo(scene) {
    const w = scene && scene.world;
    if (!w || typeof w !== "object" || typeof w.name !== "string" || !w.name) return null;
    return {
        name: w.name,
        version: Math.round(num(w.version, 1)),
        schema: Math.round(num(w.schema, 1)),
        feedback: (Array.isArray(w.feedback) ? w.feedback : [])
            .filter((f) => f && typeof f.text === "string")
            .map((f) => ({ id: String(f.id || ""), n: num(f.n, 0), text: f.text,
                           point: Array.isArray(f.point) && f.point.length === 3 ? f.point.map((v) => num(v, 0)) : null,
                           local: !!f.local })),
    };
}

/** Read one stored world item's own block into `item` (parseScene's helper). */
export function readWorldItem(item, raw) {
    if (item.kind === "environment") Object.assign(item, environmentSettings(raw));
    else if (item.kind === "light") item.light = lightSettings(raw);
    else if (item.kind === "terrain") item.terrain = terrainSettings(raw);
    else if (item.kind === "scatter") item.scatter = scatterSettings(raw);
    else if (item.kind === "depthmesh") item.depthmesh = depthMeshSettings(raw);
    return item;
}

const base = (id, kind, name) => ({
    id, kind, name, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    pivot: [0, 0, 0], visible: true, tracks: {}, parent: null,
});

export function makeEnvironmentItem(id) {
    return Object.assign(base(id, "environment", "Environment"), environmentSettings({}));
}

export function makeTerrainItem(id) {
    return Object.assign(base(id, "terrain", "Terrain"), { terrain: terrainSettings({}) });
}

export function makeScatterItem(id, type = "tree", target = "terrain") {
    const s = scatterSettings({ scatter: { source: { type }, target } });
    if (type === "grass") Object.assign(s, { count: 6000, scale: [0.6, 1.2], wind: 0.6, color: "#6f9a44" });
    if (type === "rock") Object.assign(s, { count: 200, scale: [0.4, 1.8], wind: 0, layer: -1, maxSlope: 60, color: "#7c776d" });
    if (type === "pine") Object.assign(s, { count: 1200, color: "#2f5226" });
    if (type === "column") Object.assign(s, { count: 400, scale: [1, 1], wind: 0, layer: -1, maxSlope: 90,
                                              color: "#e6e4df", grid: [8.5, 8.5], aspect: 3 });
    if (type === "lamp") Object.assign(s, { count: 2000, scale: [1, 1], wind: 0, layer: -1, maxSlope: 90,
                                            color: "#fff6e8", grid: [8.5, 4.25], lift: 3, emissive: 6 });
    const label = { pine: "Pines", tree: "Trees", bush: "Bushes", grass: "Grass", rock: "Rocks",
                    column: "Columns", lamp: "Lamps", model: "Scatter" }[type];
    return Object.assign(base(id, "scatter", label), { scatter: s });
}

export function makeLightItem(id) {
    return Object.assign(base(id, "light", "Lamp"), { position: [0, 3, 0], light: lightSettings({}) });
}

export function makeDepthMeshItem(id, src, depth) {
    return Object.assign(base(id, "depthmesh", "Depth mesh"),
                         { depthmesh: depthMeshSettings({ depthmesh: { src, depth } }) });
}

/**
 * What the channel box shows for each world kind: a path into the item, a
 * label, and how to edit it. Numbers are not keyable — these are the world's
 * settings, not its animation.
 */
export const WORLD_FIELDS = {
    environment: [
        { path: "sky.mode", label: "Sky", type: "select", options: SKY_MODES },
        { path: "sky.top", label: "Sky top", type: "color" },
        { path: "sky.horizon", label: "Sky horizon", type: "color" },
        { path: "sky.bottom", label: "Below horizon", type: "color" },
        { path: "sun.azimuth", label: "Sun azimuth", type: "number", step: 5 },
        { path: "sun.elevation", label: "Sun elevation", type: "number", step: 2, min: -90, max: 90 },
        { path: "sun.color", label: "Sun colour", type: "color" },
        { path: "sun.intensity", label: "Sun intensity", type: "number", step: 0.1, min: 0 },
        { path: "sun.shadows", label: "Shadows", type: "bool" },
        { path: "fog.color", label: "Fog colour", type: "color" },
        { path: "fog.density", label: "Fog density", type: "number", step: 0.001, min: 0 },
        { path: "ambient.intensity", label: "Ambient", type: "number", step: 0.05, min: 0 },
        { path: "render.tone", label: "Tone curve", type: "select", options: TONE_CURVES },
        { path: "render.exposure", label: "Exposure ×", type: "number", step: 0.05, min: 0.01 },
        { path: "render.bloom", label: "Bloom", type: "number", step: 0.05, min: 0, max: 5 },
        { path: "render.reflections", label: "Reflections", type: "select", options: ["capture", "off"] },
    ],
    light: [
        { path: "light.color", label: "Colour", type: "color" },
        { path: "light.intensity", label: "Intensity (cd)", type: "number", step: 1, min: 0 },
        { path: "light.distance", label: "Reach", type: "number", step: 1, min: 0 },
        { path: "light.shadows", label: "Shadows", type: "bool" },
        { path: "light.fixture.emissive", label: "Glow", type: "number", step: 0.5, min: 0 },
    ],
    terrain: [
        { path: "terrain.height", label: "Height", type: "number", step: 1, min: 0 },
        { path: "terrain.size.0", label: "Size X", type: "number", step: 10, min: 1 },
        { path: "terrain.size.1", label: "Size Z", type: "number", step: 10, min: 1 },
        { path: "terrain.seed", label: "Seed", type: "number", step: 1, rebuild: true },
        { path: "terrain.roughness", label: "Roughness", type: "number", step: 0.05, min: 0.05, max: 0.95 },
        { path: "terrain.segments", label: "Segments", type: "number", step: 32, min: 8, max: 512 },
        { path: "terrain.layers.0.color", label: "Ground", type: "color" },
        { path: "terrain.layers.0.roughness", label: "Ground rough", type: "number", step: 0.05, min: 0.02, max: 1 },
        { path: "terrain.layers.0.normalScale", label: "Ground relief", type: "number", step: 0.1, min: 0 },
        { path: "terrain.layers.1.color", label: "Rock", type: "color" },
        { path: "terrain.layers.2.color", label: "Cliff", type: "color" },
        { path: "terrain.layers.3.color", label: "Peak", type: "color" },
    ],
    scatter: [
        { path: "scatter.source.type", label: "Type", type: "select", options: SCATTER_TYPES },
        { path: "scatter.count", label: "Count", type: "number", step: 100, min: 0, max: 200000 },
        { path: "scatter.seed", label: "Seed", type: "number", step: 1 },
        { path: "scatter.scale.0", label: "Scale min", type: "number", step: 0.1, min: 0.01 },
        { path: "scatter.scale.1", label: "Scale max", type: "number", step: 0.1, min: 0.01 },
        { path: "scatter.layer", label: "On layer", type: "number", step: 1, min: -1, max: 3 },
        { path: "scatter.maxSlope", label: "Max slope", type: "number", step: 1, min: 0, max: 90 },
        { path: "scatter.color", label: "Colour", type: "color" },
        { path: "scatter.wind", label: "Wind", type: "number", step: 0.05, min: 0 },
        { path: "scatter.aspect", label: "Height ×", type: "number", step: 0.1, min: 0.01 },
        { path: "scatter.roughness", label: "Roughness", type: "number", step: 0.05, min: 0.02, max: 1 },
        { path: "scatter.lift", label: "Lift", type: "number", step: 0.1 },
        { path: "scatter.emissive", label: "Glow", type: "number", step: 0.5, min: 0 },
        { path: "scatter.grid.0", label: "Grid X", type: "number", step: 0.5, min: 0.2, needs: "scatter.grid" },
        { path: "scatter.grid.1", label: "Grid Z", type: "number", step: 0.5, min: 0.2, needs: "scatter.grid" },
    ],
    depthmesh: [
        { path: "depthmesh.fov", label: "FOV", type: "number", step: 1, min: 1, max: 170 },
        { path: "depthmesh.near", label: "Near", type: "number", step: 0.5, min: 0.01 },
        { path: "depthmesh.far", label: "Far", type: "number", step: 5, min: 0.02 },
        { path: "depthmesh.cut", label: "Edge cut", type: "number", step: 0.01, min: 0 },
        { path: "depthmesh.invert", label: "Invert depth", type: "bool" },
    ],
    camera: [
        { path: "reference.opacity", label: "Ref opacity", type: "number", step: 0.05, min: 0, max: 1, needs: "reference" },
        { path: "reference.wipe", label: "Ref wipe", type: "number", step: 0.05, min: 0, max: 1, needs: "reference" },
    ],
};

export function getPath(obj, path) {
    let cur = obj;
    for (const p of String(path).split(".")) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

export function setPath(obj, path, value) {
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts.slice(0, -1)) {
        if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
}
