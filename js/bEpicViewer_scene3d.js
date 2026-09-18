// bEpicViewer_scene3d.js
// The previz scene: what a 3D tab holds when it is more than one model.
//
// Plain data and pure functions only — no three.js, no DOM. The view
// (bEpicViewer_model3d.js) builds three objects from this, the node stores it
// as JSON, and a scene file is exactly this shape. Keeping it separate is what
// makes the animation testable without a browser.
//
// A scene is { fps, length, items[], activeCamera }. Every item — model or
// camera — carries a static transform plus optional animation `tracks`. A track
// is a sorted list of keyframes { f, v, ease }: `f` is a frame number on the
// viewer's own timeline, `v` the value at that frame ([x,y,z], or a number for
// fov), and `ease` how it leaves that key ("smooth" or "linear"). A property
// with no track holds its static value for the whole shot.

export const SCENE_VERSION = 1;
export const DEFAULT_FPS = 24;
export const DEFAULT_LENGTH = 120;
export const TRACKS = ["position", "rotation", "scale", "fov"];

let _seq = 0;

export function newId(prefix = "i") {
    _seq += 1;
    return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

export function makeScene(patch = {}) {
    return {
        version: SCENE_VERSION,
        fps: DEFAULT_FPS,
        length: DEFAULT_LENGTH,
        items: [],
        activeCamera: null,      // item id, or null for the free camera
        ...patch,
    };
}

export function makeModelItem(src, name) {
    return {
        id: newId("m"),
        kind: "model",
        name: name || (src && (src.name || src.filename)) || "model",
        src: src || null,
        position: [0, 0, 0],
        rotation: [0, 0, 0],     // degrees, XYZ order
        scale: [1, 1, 1],
        visible: true,
        tracks: {},
    };
}

export function makeCameraItem(name, patch = {}) {
    return {
        id: newId("c"),
        kind: "camera",
        name: name || "Camera",
        position: [5, 5, 5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        fov: 35,
        visible: true,
        tracks: {},
        ...patch,
    };
}

export function itemById(scene, id) {
    if (!scene || !id) return null;
    return (scene.items || []).find((it) => it && it.id === id) || null;
}

export function cameras(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "camera");
}

export function models(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "model");
}

/** A name no other item carries, so the outliner never shows two the same. */
export function uniqueName(scene, wanted) {
    const taken = new Set((scene.items || []).map((it) => it.name));
    if (!taken.has(wanted)) return wanted;
    const base = wanted.replace(/\s+\d+$/, "");
    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// ── Keyframes ────────────────────────────────────────────────────────────────

const _clone = (v) => (Array.isArray(v) ? v.slice() : v);

/** Keyframes of one property, oldest first. Never null. */
export function track(item, prop) {
    const t = item && item.tracks && item.tracks[prop];
    return Array.isArray(t) ? t : [];
}

export function isAnimated(item, prop) {
    return track(item, prop).length > 0;
}

/** Every frame this item has a key on, sorted, without duplicates. */
export function keyframeFrames(item) {
    const out = new Set();
    for (const prop of TRACKS) for (const k of track(item, prop)) out.add(k.f);
    return [...out].sort((a, b) => a - b);
}

/**
 * Put a key on `prop` at `frame`. Replacing an existing key at that frame keeps
 * its easing unless a new one is given. Returns the scene item for chaining.
 */
export function setKeyframe(item, prop, frame, value, ease) {
    if (!item || !TRACKS.includes(prop)) return item;
    const f = Math.round(frame);
    if (!item.tracks) item.tracks = {};
    const list = Array.isArray(item.tracks[prop]) ? item.tracks[prop] : [];
    const at = list.findIndex((k) => k.f === f);
    const key = { f, v: _clone(value), ease: ease || (at >= 0 ? list[at].ease : "smooth") };
    if (at >= 0) list[at] = key;
    else list.push(key);
    list.sort((a, b) => a.f - b.f);
    item.tracks[prop] = list;
    return item;
}

/** Drop the key at `frame` (all properties when `prop` is omitted). */
export function removeKeyframe(item, frame, prop) {
    if (!item || !item.tracks) return item;
    const f = Math.round(frame);
    for (const p of prop ? [prop] : TRACKS) {
        const list = item.tracks[p];
        if (!Array.isArray(list)) continue;
        const left = list.filter((k) => k.f !== f);
        if (left.length) item.tracks[p] = left;
        else delete item.tracks[p];
    }
    return item;
}

/** Forget an item's animation, leaving it wherever it is at `frame`. */
export function clearTracks(item, frame) {
    if (!item) return item;
    if (frame !== undefined) {
        const at = evaluate(item, frame);
        item.position = at.position;
        item.rotation = at.rotation;
        item.scale = at.scale;
        if (item.kind === "camera") item.fov = at.fov;
    }
    item.tracks = {};
    return item;
}

// Ease shapes the segment AFTER a key: "linear" holds a constant speed,
// "smooth" (the default) eases out of it and into the next, and "hold" keeps
// the value until the next key, for stepped moves.
function _shape(t, ease) {
    if (ease === "linear") return t;
    if (ease === "hold") return 0;
    return t * t * (3 - 2 * t);           // smoothstep
}

// Rotations are kept in degrees, and two keys 350° apart really mean 10° the
// other way. Without this a turn would spin the long way round.
function _lerpAngle(a, b, t) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return a + d * t;
}

function _lerp(a, b, t, angles) {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.map((v, i) => (angles ? _lerpAngle(v, b[i], t) : v + (b[i] - v) * t));
    }
    return a + (b - a) * t;
}

/** The value of one property at `frame`, animated or not. */
export function valueAt(item, prop, frame) {
    const keys = track(item, prop);
    const stat = prop === "fov" ? (item.fov ?? 35) : _clone(item[prop]);
    if (keys.length === 0) return stat;
    if (frame <= keys[0].f) return _clone(keys[0].v);
    const last = keys[keys.length - 1];
    if (frame >= last.f) return _clone(last.v);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.f - a.f;
    const t = span > 0 ? _shape((frame - a.f) / span, a.ease) : 0;
    return _lerp(a.v, b.v, t, prop === "rotation");
}

/** Everything the view needs to place one item at `frame`. */
export function evaluate(item, frame) {
    return {
        position: valueAt(item, "position", frame),
        rotation: valueAt(item, "rotation", frame),
        scale: valueAt(item, "scale", frame),
        fov: item.kind === "camera" ? valueAt(item, "fov", frame) : undefined,
    };
}

/** Frames where anything in the scene has a key — the timeline's tick marks. */
export function sceneKeyframes(scene) {
    const out = new Set();
    for (const it of (scene && scene.items) || []) for (const f of keyframeFrames(it)) out.add(f);
    return [...out].sort((a, b) => a - b);
}

export function isAnimatedScene(scene) {
    return sceneKeyframes(scene).length > 0;
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * A scene read from a file, a node widget or an older viewer state, with
 * everything missing filled in. Anything unreadable comes back as an empty
 * scene rather than throwing, so a damaged widget can't take the viewer down.
 */
export function parseScene(raw) {
    let data = raw;
    if (typeof raw === "string") {
        if (!raw.trim()) return makeScene();
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.warn("[bEpicViewer] could not read the scene", e);
            return makeScene();
        }
    }
    if (!data || typeof data !== "object") return makeScene();

    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)))
        ? v.map(Number) : d.slice());

    const items = [];
    for (const raw of Array.isArray(data.items) ? data.items : []) {
        if (!raw || typeof raw !== "object") continue;
        const isCam = raw.kind === "camera";
        const item = {
            id: typeof raw.id === "string" && raw.id ? raw.id : newId(isCam ? "c" : "m"),
            kind: isCam ? "camera" : "model",
            name: typeof raw.name === "string" && raw.name ? raw.name : (isCam ? "Camera" : "model"),
            position: vec(raw.position, [0, 0, 0]),
            rotation: vec(raw.rotation, [0, 0, 0]),
            scale: vec(raw.scale, [1, 1, 1]),
            visible: raw.visible !== false,
            tracks: {},
        };
        if (isCam) item.fov = num(raw.fov, 35);
        else item.src = raw.src && typeof raw.src === "object" ? raw.src : null;

        const tracks = raw.tracks && typeof raw.tracks === "object" ? raw.tracks : {};
        for (const prop of TRACKS) {
            const list = Array.isArray(tracks[prop]) ? tracks[prop] : null;
            if (!list) continue;
            const keys = [];
            for (const k of list) {
                if (!k || !Number.isFinite(Number(k.f))) continue;
                const v = prop === "fov" ? num(k.v, item.fov ?? 35) : vec(k.v, item[prop]);
                keys.push({ f: Math.round(Number(k.f)), v, ease: k.ease === "linear" || k.ease === "hold" ? k.ease : "smooth" });
            }
            if (keys.length) {
                keys.sort((a, b) => a.f - b.f);
                item.tracks[prop] = keys;
            }
        }
        // A model with no file left to point at is dropped: it would show as an
        // invisible row the user can't fix.
        if (!isCam && !item.src) continue;
        items.push(item);
    }

    const scene = makeScene({
        fps: Math.max(0.1, num(data.fps, DEFAULT_FPS)),
        length: Math.max(1, Math.round(num(data.length, DEFAULT_LENGTH))),
        items,
        activeCamera: typeof data.activeCamera === "string" ? data.activeCamera : null,
    });
    if (scene.activeCamera && !itemById(scene, scene.activeCamera)) scene.activeCamera = null;
    return scene;
}

export function serializeScene(scene) {
    return JSON.stringify(scene || makeScene());
}
