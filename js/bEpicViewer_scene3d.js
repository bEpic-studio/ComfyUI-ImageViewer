// bEpicViewer_scene3d.js
// The previz scene: what a 3D tab holds when it is more than one model.
//
// Plain data and pure functions only — no three.js, no DOM. The view
// (bEpicViewer_model3d.js) builds three objects from this, the node stores it
// as JSON, and a scene file is exactly this shape. Keeping it separate is what
// makes the animation testable without a browser.
//
// A scene is { fps, length, items[], activeCamera }. Every item — model,
// camera or group — carries a static transform plus optional animation
// `tracks`. A track is a sorted list of keyframes { f, v, ease }: `f` is a
// frame number on the viewer's own timeline, `v` the value at that frame
// ([x,y,z], or a number for fov), and `ease` how it leaves that key ("smooth"
// or "linear"). A property with no track holds its static value for the whole
// shot.
//
// TANGENTS
// A key may also carry `ti` and `to`: the slope of the curve coming in and
// going out, in value-units per frame, shaped like `v` (three numbers, or one
// for fov). They are what the curve editor's handles set, and they are
// OPTIONAL — a key without them behaves exactly as its `ease` says, because
// the ease shapes are the same cubic with the tangents those words imply:
// "smooth" is flat at both ends, "linear" is the straight line between the
// keys, "hold" is not a curve at all. So dragging a handle does not switch a
// scene into some other mode; it writes down the number the word was standing
// in for.
//
// THE PIVOT
// `pivot` is the point rotation and scale happen about, in the item's own
// space. It is a channel like any other — keyable, and on the curve editor's
// list — and the transform it stands for is
//     T(position) · T(pivot) · R · S · T(-pivot)
// which is what every DCC means by one: move the pivot and the object stays
// where it is, then turns around somewhere else.
//
// FROZEN TRANSFORMS
// `offset`, when present, is a 4x4 matrix (16 numbers, three.js column-major
// order) that sits under everything above:
//     T(position) · T(pivot) · R · S · T(-pivot) · offset
// Freeze Transformations is what writes it. Maya bakes a frozen transform into
// the vertices; a previz item points at a file it must not rewrite, so the
// transform is kept here instead, and the channels go back to zero with the
// item exactly where it was. It is not a channel and never animates.
//
// CAMERAS
// A camera's `resolution` is the [width, height] of the picture it takes. Its
// `fov` is the vertical field of view of THAT picture — the gate — whatever
// shape the viewport happens to be.
//
// THE HIERARCHY
// `items` stays a flat list — it is what a JSON widget, an undo snapshot and a
// diff all want — and the tree is carried by one field: `parent`, the id of the
// item this one hangs under, or null at the top. A transform is LOCAL to that
// parent, exactly as in USD or any DCC, so moving a group moves what is inside
// it and a child's numbers stay the numbers you typed. (Changing an item's
// parent in the outliner rewrites its numbers so it stays put in the world —
// that is the mixin's job, _previzKeepWorld; nothing here moves anything.) A `group` item is a
// transform and nothing else: it draws no geometry and exists to hold others,
// which is what a USD Xform or an assembly comes in as.
//
// Nothing here walks the tree to place an item — the view parents three.js
// objects the same way and lets the engine compose the matrices.

import { WORLD_KINDS, readWorldItem, referenceSettings, walkSettings, worldInfo } from "./bEpicViewer_worldData.js";

export const SCENE_VERSION = 1;
export const DEFAULT_RESOLUTION = [1920, 1080];

/** The picture a camera takes, as [width, height] — never missing, never zero. */
export function cameraResolution(item) {
    const r = item && Array.isArray(item.resolution) ? item.resolution : null;
    const ok = r && r.length === 2 && r.every((v) => Number.isFinite(Number(v)) && Number(v) >= 1);
    return ok ? r.map((v) => Math.round(Number(v))) : DEFAULT_RESOLUTION.slice();
}

// ── Render settings ───────────────────────────────────────────────────────────
// What the render dialog last used, kept on the scene so it travels with the
// workflow. `camera` is an item id, "" for the free view, or null for "the
// camera being looked through, else the first one"; `end` null is the last
// frame of the shot; `fps` null is the shot's own rate.
export const RENDER_FORMATS = ["mp4", "mov", "webm", "png"];
export const RENDER_DEFAULTS = {
    camera: null, useCameraRes: true, width: 1920, height: 1080, scale: 100,
    start: 0, end: null, fps: null,
    format: "mp4", quality: "high",
    shading: "original", background: "viewer", color: "#282828",
    aa: 2, grid: false, helpers: false, addNode: true,
};

// The render dialog's starting point for a shot that has never been rendered,
// from Settings → bEpic Viewer. Only the look-and-output fields: range and
// camera belong to the shot.
const _RENDER_FACTORY = { ...RENDER_DEFAULTS };
export function setRenderDefaults(patch = {}) {
    Object.assign(RENDER_DEFAULTS, _RENDER_FACTORY);     // a bad value falls back to the factory's
    const merged = renderSettings({ render: { ..._RENDER_FACTORY, ...patch } });
    for (const k of ["format", "quality", "scale", "aa", "background", "color"]) RENDER_DEFAULTS[k] = merged[k];
}

/** The scene's render settings, every field present and sane. */
export function renderSettings(scene) {
    const raw = (scene && scene.render && typeof scene.render === "object") ? scene.render : {};
    const d = RENDER_DEFAULTS;
    const int = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);
    const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
    return {
        camera: typeof raw.camera === "string" ? raw.camera : null,
        useCameraRes: raw.useCameraRes !== false,
        width: int(raw.width, 16, 8192, d.width),
        height: int(raw.height, 16, 8192, d.height),
        scale: int(raw.scale, 10, 400, d.scale),
        start: int(raw.start, 0, 99999, d.start),
        end: raw.end === null || raw.end === undefined ? null : int(raw.end, 0, 99999, null),
        fps: raw.fps === null || raw.fps === undefined || !(Number(raw.fps) > 0) ? null : Number(raw.fps),
        format: pick(raw.format, RENDER_FORMATS, d.format),
        quality: pick(raw.quality, ["high", "medium", "low"], d.quality),
        shading: pick(raw.shading, ["original", "clay", "normal", "wireframe"], d.shading),
        background: pick(raw.background, ["viewer", "color", "transparent"], d.background),
        color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : d.color,
        aa: pick(Number(raw.aa), [1, 2, 4], d.aa),
        grid: !!raw.grid,
        helpers: !!raw.helpers,
        addNode: raw.addNode !== false,
    };
}

/** A valid frozen-transform matrix, or null (none, or not 16 finite numbers). */
export function offsetOf(item) {
    const m = item && item.offset;
    return Array.isArray(m) && m.length === 16 && m.every((v) => Number.isFinite(Number(v)))
        ? m.map(Number) : null;
}
export const DEFAULT_FPS = 24;
export const DEFAULT_LENGTH = 120;

// What a NEW shot and a new camera start with — the DEFAULT_* above stay what a
// saved scene missing a field is read as. Set from Settings → bEpic Viewer
// (setNewSceneDefaults); this module itself stays free of ComfyUI.
const NEW_SCENE = { fps: DEFAULT_FPS, length: DEFAULT_LENGTH, resolution: DEFAULT_RESOLUTION.slice() };

export function setNewSceneDefaults({ fps, length, resolution } = {}) {
    NEW_SCENE.fps = Number(fps) > 0 ? Number(fps) : DEFAULT_FPS;
    NEW_SCENE.length = Number(length) >= 1 ? Math.round(Number(length)) : DEFAULT_LENGTH;
    NEW_SCENE.resolution = Array.isArray(resolution) && resolution.length === 2 && resolution.every((v) => v > 0)
        ? resolution.map((v) => Math.round(v)) : DEFAULT_RESOLUTION.slice();
}
export const TRACKS = ["position", "rotation", "scale", "pivot", "fov"];

// Blocking shapes the viewer can make on its own — no file, no loader. Each is
// built at unit size and placed by its transform, so the gizmo's scale handles
// are also its size handles. `scale` is the default the item is created with.
export const PRIMITIVES = [
    { type: "box",      label: "Box",      scale: [1, 1, 1] },
    { type: "sphere",   label: "Sphere",   scale: [1, 1, 1] },
    { type: "plane",    label: "Plane",    scale: [10, 1, 10] },   // lies flat, as a floor
    { type: "cylinder", label: "Cylinder", scale: [1, 1, 1] },
    { type: "cone",     label: "Cone",     scale: [1, 1, 1] },
    { type: "torus",    label: "Torus",    scale: [1, 1, 1] },
];

const PRIMITIVE_TYPES = new Set(PRIMITIVES.map((p) => p.type));
export const DEFAULT_COLOR = "#9a9a9a";

let _seq = 0;

export function newId(prefix = "i") {
    _seq += 1;
    return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

/** An empty transform others hang under: a USD Xform, or a folder you made. */
export function makeGroupItem(name) {
    return {
        id: newId("g"),
        kind: "group",
        name: name || "Group",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

export function makeScene(patch = {}) {
    return {
        version: SCENE_VERSION,
        fps: NEW_SCENE.fps,
        length: NEW_SCENE.length,
        items: [],
        activeCamera: null,      // item id, or null for the free camera
        // Whether the length above was chosen rather than defaulted. A model's
        // own clip may stretch a shot nobody has set a length for; once it has
        // been set — here, or by a stage that carries a range — it stands.
        lengthSet: false,
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
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

export function makePrimitiveItem(type, name) {
    const spec = PRIMITIVES.find((p) => p.type === type) || PRIMITIVES[0];
    return {
        id: newId("p"),
        kind: "primitive",
        name: name || spec.label,
        primitive: { type: spec.type },
        color: DEFAULT_COLOR,
        position: [0, spec.type === "plane" ? 0 : 0.5, 0],   // sitting on the grid
        rotation: [0, 0, 0],
        scale: spec.scale.slice(),
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

/**
 * A picture standing in the scene: a card showing an image.
 *
 * It is a scene item like any other — moved, parented, keyed — and its
 * geometry is a unit-height card whose width comes from the picture, so a
 * scale of 1 means "one unit tall". Parent one to a camera and it becomes
 * that camera's backplate; stand one behind the set and it is a matte
 * painting; put one beside the model and it is the reference you are
 * matching.
 */
export function makeImagePlaneItem(src, name) {
    return {
        id: newId("ip"),
        kind: "imageplane",
        name: name || (src && (src.name || src.filename)) || "Image plane",
        src: src || null,
        plane: { opacity: 1, lit: false, doubleSided: true },
        position: [0, 0.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
    };
}

/** An image plane's own settings, every field present and sane. */
export function planeSettings(item) {
    const raw = (item && item.plane && typeof item.plane === "object") ? item.plane : {};
    const opacity = Number(raw.opacity);
    return {
        opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
        lit: !!raw.lit,
        doubleSided: raw.doubleSided !== false,
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
        resolution: NEW_SCENE.resolution.slice(),
        pivot: [0, 0, 0],
        visible: true,
        tracks: {},
        parent: null,
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

/** Everything that is drawn: loaded files and built-in shapes alike. */
export function geometry(scene) {
    return (scene.items || []).filter((it) => it && it.kind !== "camera" && it.kind !== "group");
}

export function groups(scene) {
    return (scene.items || []).filter((it) => it && it.kind === "group");
}

/** The items hanging directly under `id` (or at the top, for null), in order. */
export function childrenOf(scene, id) {
    return (scene.items || []).filter((it) => it && (it.parent || null) === (id || null));
}

/** Everything under `id`, at any depth — what deleting a group takes with it. */
export function descendantsOf(scene, id) {
    const out = [];
    const walk = (parentId) => {
        for (const child of childrenOf(scene, parentId)) {
            out.push(child);
            walk(child.id);
        }
    };
    walk(id);
    return out;
}

/** How deep an item sits, for the outliner's indent. */
export function depthOf(scene, item) {
    let depth = 0;
    let node = item;
    const seen = new Set();
    while (node && node.parent && !seen.has(node.id)) {
        seen.add(node.id);
        node = itemById(scene, node.parent);
        if (node) depth += 1;
    }
    return depth;
}

/**
 * May `id` be moved under `parentId`? Not into itself, and not into its own
 * descendants — that would cut the branch off the tree and lose it.
 */
export function canParent(scene, id, parentId) {
    if (!id || id === parentId) return false;
    if (!parentId) return true;
    const target = itemById(scene, parentId);
    if (!target) return false;
    let node = target;
    const seen = new Set();
    while (node && !seen.has(node.id)) {
        if (node.id === id) return false;
        seen.add(node.id);
        node = node.parent ? itemById(scene, node.parent) : null;
    }
    return true;
}

/**
 * Put `id` under `parentId` (null for the top), keeping the flat list in tree
 * order: an item sits directly after its parent, ahead of the next branch. The
 * order matters — the outliner reads the list as it stands, and so does an
 * export.
 */
export function setParent(scene, id, parentId) {
    const item = itemById(scene, id);
    if (!item || !canParent(scene, id, parentId)) return false;
    item.parent = parentId || null;
    const moving = [item, ...descendantsOf(scene, id)];
    const rest = (scene.items || []).filter((it) => !moving.includes(it));
    const at = parentId ? rest.findIndex((it) => it.id === parentId) + 1 : rest.length;
    rest.splice(at, 0, ...moving);
    scene.items = rest;
    return true;
}

/**
 * Put `id` under `parentId` (null for the top) and among its new siblings
 * just before `beforeId` — or last, when `beforeId` is null or isn't one of
 * them. Its descendants come along. The flat list stays in tree order, so
 * the outliner, an export and a reload all see the same order.
 */
export function moveItem(scene, id, parentId, beforeId = null) {
    const item = itemById(scene, id);
    if (!item || !canParent(scene, id, parentId)) return false;
    const moving = [item, ...descendantsOf(scene, id)];
    if (beforeId && moving.some((it) => it.id === beforeId)) return false;
    item.parent = parentId || null;
    const rest = (scene.items || []).filter((it) => !moving.includes(it));
    const before = beforeId ? rest.find((it) => it.id === beforeId) : null;
    let at;
    if (before && (before.parent || null) === (parentId || null)) {
        at = rest.indexOf(before);
    } else if (parentId) {
        // Last child: after the parent and everything already under it.
        const tail = [itemById(scene, parentId), ...descendantsOf(scene, parentId)]
            .filter((it) => rest.includes(it));
        at = Math.max(...tail.map((it) => rest.indexOf(it))) + 1;
    } else {
        at = rest.length;
    }
    rest.splice(at, 0, ...moving);
    scene.items = rest;
    return true;
}

/** A name no other item carries, so the outliner never shows two the same. */
export function uniqueName(scene, wanted, exceptId = null) {
    // `exceptId` is the item being renamed: its own current name is not in
    // the way, or keeping a name would turn "Box" into "Box 2".
    const taken = new Set((scene.items || [])
        .filter((it) => it.id !== exceptId).map((it) => it.name));
    if (!taken.has(wanted)) return wanted;
    const base = wanted.replace(/\s+\d+$/, "");
    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

// ── Keyframes ────────────────────────────────────────────────────────────────

const _clone = (v) => (Array.isArray(v) ? v.slice() : v);

/** Read one component of a key's value or tangent — vec3 or a lone number. */
export function componentOf(value, axis) {
    return Array.isArray(value) ? value[axis] : value;
}

/** Write one component back, in whatever shape the value has. */
function _withComponent(value, axis, x) {
    if (!Array.isArray(value)) return x;
    const out = value.slice();
    out[axis] = x;
    return out;
}

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
    // Moving a key keeps the shape its handles were given; only the editor's
    // tangent drag rewrites those.
    if (at >= 0 && list[at].ti !== undefined) key.ti = _clone(list[at].ti);
    if (at >= 0 && list[at].to !== undefined) key.to = _clone(list[at].to);
    if (at >= 0) list[at] = key;
    else list.push(key);
    list.sort((a, b) => a.f - b.f);
    item.tracks[prop] = list;
    return item;
}

/**
 * Set one component of a key's tangent.
 *
 * `side` is "in" or "out". Handles are unified unless `broken` says otherwise:
 * a curve with a kink in it is something you ask for, not something a drag
 * gives you by accident.
 */
export function setTangent(item, prop, frame, axis, slope, { side = "out", broken = false } = {}) {
    const key = track(item, prop).find((k) => k.f === Math.round(frame));
    if (!key) return null;
    const blank = Array.isArray(key.v) ? key.v.map(() => 0) : 0;
    const put = (which) => {
        const base = key[which] !== undefined ? key[which] : _clone(blank);
        key[which] = _withComponent(base, axis, slope);
    };
    put(side === "in" ? "ti" : "to");
    if (!broken) put(side === "in" ? "to" : "ti");
    return key;
}

/** Back to what the key's ease says — the handles stop being hand-set. */
export function clearTangents(item, prop, frame) {
    const key = track(item, prop).find((k) => k.f === Math.round(frame));
    if (!key) return null;
    delete key.ti;
    delete key.to;
    return key;
}

/**
 * The slope a key actually has on one side, hand-set or implied by its ease.
 * What the editor draws its handles from.
 */
export function tangentAt(item, prop, frame, axis, side = "out") {
    const keys = track(item, prop);
    const i = keys.findIndex((k) => k.f === Math.round(frame));
    if (i < 0) return 0;
    const key = keys[i];
    const own = side === "in" ? key.ti : key.to;
    if (own !== undefined) return componentOf(own, axis);
    // Implied: read it off the segment this side of the key.
    const other = side === "in" ? keys[i - 1] : keys[i + 1];
    if (!other) return 0;
    const [from, to] = side === "in" ? [other, key] : [key, other];
    const span = to.f - from.f;
    const ease = from.ease;
    return _autoSlope(ease, componentOf(from.v, axis), componentOf(to.v, axis), span);
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
//
// Written as the tangents each word means, so one cubic draws every case and a
// hand-set handle is the same curve with a different number in it:
//   smooth → flat at both ends (which IS smoothstep)
//   linear → the straight line's own slope at both ends
function _autoSlope(ease, from, to, span) {
    if (ease === "linear" && span > 0) return (to - from) / span;
    return 0;
}

/**
 * One component of a segment, as a cubic Hermite.
 * `t` is 0..1 across the segment; the tangents are in value-units per frame,
 * so they are scaled by the segment's length to become the Hermite's.
 */
function _hermite(p0, p1, m0, m1, t, span) {
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p0
         + (t3 - 2 * t2 + t) * span * m0
         + (-2 * t3 + 3 * t2) * p1
         + (t3 - t2) * span * m1;
}

// Rotations are kept in degrees, and two keys 350° apart really mean 10° the
// other way. Without this a turn would spin the long way round.
function _angleDelta(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
}

function _lerpAngle(a, b, t) {
    return a + _angleDelta(a, b) * t;
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
    // A scene written before pivots existed simply has none, which is the
    // same thing as one at the origin.
    const stat = prop === "fov" ? (item.fov ?? 35)
               : prop === "pivot" ? _clone(item.pivot || [0, 0, 0])
               : _clone(item[prop]);
    if (keys.length === 0) return stat;
    if (frame <= keys[0].f) return _clone(keys[0].v);
    const last = keys[keys.length - 1];
    if (frame >= last.f) return _clone(last.v);
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].f <= frame) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.f - a.f;
    if (a.ease === "hold" || span <= 0) return _clone(a.v);
    const t = (frame - a.f) / span;
    const angles = prop === "rotation";
    const each = (axis) => {
        const p0 = componentOf(a.v, axis);
        // The short way round for angles: the segment is drawn to the nearer
        // turn, so 350° to 10° is 20° rather than 340°.
        const p1 = angles ? p0 + _angleDelta(p0, componentOf(b.v, axis))
                          : componentOf(b.v, axis);
        const m0 = a.to !== undefined ? componentOf(a.to, axis) : _autoSlope(a.ease, p0, p1, span);
        const m1 = b.ti !== undefined ? componentOf(b.ti, axis) : _autoSlope(a.ease, p0, p1, span);
        return _hermite(p0, p1, m0, m1, t, span);
    };
    return Array.isArray(a.v) ? a.v.map((_, axis) => each(axis)) : each(0);
}

/** Everything the view needs to place one item at `frame`. */
export function evaluate(item, frame) {
    return {
        position: valueAt(item, "position", frame),
        rotation: valueAt(item, "rotation", frame),
        scale: valueAt(item, "scale", frame),
        pivot: valueAt(item, "pivot", frame),
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
        const isPrim = raw.kind === "primitive";
        const isGroup = raw.kind === "group";
        const isPlane = raw.kind === "imageplane";
        // Worlds (bEpicViewer_worldData.js): an environment, a terrain, a
        // scatter or a depth mesh carries its own settings block and no src.
        const isWorld = WORLD_KINDS.includes(raw.kind);
        const item = {
            id: typeof raw.id === "string" && raw.id ? raw.id
                : newId(isCam ? "c" : isPrim ? "p" : isGroup ? "g" : isPlane ? "ip" : "m"),
            kind: isCam ? "camera" : isPrim ? "primitive" : isGroup ? "group"
                : isPlane ? "imageplane" : isWorld ? raw.kind : "model",
            name: typeof raw.name === "string" && raw.name ? raw.name
                : (isCam ? "Camera" : isPrim ? "Shape" : isGroup ? "Group"
                   : isPlane ? "Image plane" : isWorld ? raw.kind : "model"),
            parent: typeof raw.parent === "string" && raw.parent ? raw.parent : null,
            position: vec(raw.position, [0, 0, 0]),
            rotation: vec(raw.rotation, [0, 0, 0]),
            scale: vec(raw.scale, [1, 1, 1]),
            pivot: vec(raw.pivot, [0, 0, 0]),
            visible: raw.visible !== false,
            tracks: {},
        };
        if (isCam) {
            item.fov = num(raw.fov, 35);
            item.resolution = cameraResolution(raw);
            // The picture this camera's view has to match (a world's reference).
            const ref = referenceSettings(raw);
            if (ref) item.reference = ref;
        } else if (offsetOf(raw)) {
            item.offset = offsetOf(raw);
        }
        if (isCam) {
            // (the camera's fields are read above)
        } else if (isGroup) {
            // A group is its transform. Nothing else to read.
        } else if (isWorld) {
            readWorldItem(item, raw);
        } else if (isPrim) {
            const type = raw.primitive && PRIMITIVE_TYPES.has(raw.primitive.type)
                ? raw.primitive.type : "box";
            item.primitive = { type };
            item.color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color)
                ? raw.color : DEFAULT_COLOR;
        } else if (isPlane) {
            item.src = raw.src && typeof raw.src === "object" ? raw.src : null;
            item.plane = planeSettings(raw);
        } else {
            item.src = raw.src && typeof raw.src === "object" ? raw.src : null;
        }

        const tracks = raw.tracks && typeof raw.tracks === "object" ? raw.tracks : {};
        for (const prop of TRACKS) {
            const list = Array.isArray(tracks[prop]) ? tracks[prop] : null;
            if (!list) continue;
            const keys = [];
            for (const k of list) {
                if (!k || !Number.isFinite(Number(k.f))) continue;
                const v = prop === "fov" ? num(k.v, item.fov ?? 35) : vec(k.v, item[prop]);
                const key = { f: Math.round(Number(k.f)), v,
                              ease: k.ease === "linear" || k.ease === "hold" ? k.ease : "smooth" };
                // Hand-set tangents, in the same shape as the value. Anything
                // else is left off, and the ease speaks for the key again.
                const zero = prop === "fov" ? 0 : [0, 0, 0];
                for (const side of ["ti", "to"]) {
                    if (k[side] === undefined) continue;
                    const t = prop === "fov" ? num(k[side], undefined) : vec(k[side], zero);
                    if (prop === "fov" ? Number.isFinite(t) : Array.isArray(t)) key[side] = t;
                }
                keys.push(key);
            }
            if (keys.length) {
                keys.sort((a, b) => a.f - b.f);
                item.tracks[prop] = keys;
            }
        }
        // A model (or an image plane) with no file left to point at is
        // dropped: it would show as an invisible row the user can't fix. A
        // shape carries its own geometry, so it has nothing to lose.
        if (!isCam && !isPrim && !isGroup && !isWorld && !item.src) continue;
        items.push(item);
    }

    const scene = makeScene({
        fps: Math.max(0.1, num(data.fps, DEFAULT_FPS)),
        length: Math.max(1, Math.round(num(data.length, DEFAULT_LENGTH))),
        lengthSet: !!data.lengthSet,
        items,
        activeCamera: typeof data.activeCamera === "string" ? data.activeCamera : null,
    });
    if (data.render && typeof data.render === "object") scene.render = renderSettings(data);
    // A world: where walking starts, and which world (and version) this is.
    if (data.walk && typeof data.walk === "object") scene.walk = walkSettings(data);
    const world = worldInfo(data);
    if (world) scene.world = world;
    if (scene.activeCamera && !itemById(scene, scene.activeCamera)) scene.activeCamera = null;
    repairTree(scene);
    return scene;
}

/**
 * Make the tree true: a parent that isn't there, or a loop made by hand-editing
 * a widget, would otherwise hide items from the outliner for good. Both are
 * fixed by lifting the item back to the top rather than dropping it.
 */
export function repairTree(scene) {
    const byId = new Map((scene.items || []).map((it) => [it.id, it]));
    for (const item of scene.items || []) {
        if (item.parent && !byId.has(item.parent)) item.parent = null;
    }
    for (const item of scene.items || []) {
        const seen = new Set([item.id]);
        let node = item.parent ? byId.get(item.parent) : null;
        while (node) {
            if (seen.has(node.id)) { item.parent = null; break; }
            seen.add(node.id);
            node = node.parent ? byId.get(node.parent) : null;
        }
    }
    return scene;
}

export function serializeScene(scene) {
    return JSON.stringify(scene || makeScene());
}
