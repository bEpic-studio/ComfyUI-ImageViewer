"""
roto_raster.py — rasterize bEpic Viewer roto data into a MASK tensor.

The viewer's Roto tool serializes shapes as coordinates normalized against the
image — (0,0) its top-left, (1,1) its bottom-right — so the matte is resolution
independent.  This module turns that JSON into a float mask batch [N, H, W] at
the resolution of the node's input image.

Coordinates are NOT restricted to [0,1]: a vertex, tangent or feather point may
sit outside the image.  Such a shape is simply cropped to the frame (PIL clips
the scan-fill to the canvas), which keeps the true slope of every edge that
crosses the border — clamping the point onto the border instead would bend the
curve either side of it.

Design notes / approximations (documented so callers know the fidelity):
  * Bezier segments are tessellated to line segments then scan-filled by PIL.
  * Per-point feather handles build a second "feather" contour; the soft edge
    between the shape contour and the feather contour is produced with a
    distance-transform ramp when SciPy is available, otherwise a Gaussian
    fallback keyed off the mean feather offset.
  * dilate / erode use SciPy grey morphology when available, else PIL
    Max/Min filters.
  * Shapes combine in list order, each by its `mode` (union, plus, minus,
    intersection, xor — Nuke's ChannelMerge operations, see MODES; union
    by default).  Per-shape `invert`/`opacity` and a `global` block of
    invert/blur/dilate/feather are also honoured.

Everything is wrapped so a malformed payload yields a zero mask rather than
raising during a ComfyUI execution.
"""

import math
import os

import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFilter
except Exception:  # pragma: no cover - PIL always present in ComfyUI
    Image = ImageDraw = ImageFilter = None

try:
    from scipy import ndimage as _ndimage
except Exception:
    _ndimage = None


# ── small helpers ────────────────────────────────────────────────────────────

# How a shape combines with everything below it in the list — the operations of
# the Nuke ChannelMerge node in bepic_templates (bEpicChannelMerge), with the
# shape as A and what the shapes before it made as B, clamped to 0..1 after
# each one, as a chain of those nodes would be. Must match the viewer's
# ROTO_MODES (bEpicViewer_roto.js).
MODES = ("union", "plus", "minus", "intersection", "xor")


def _merge(mode, b, a):
    """B (what is there) combined with A (this shape's matte), in place in b."""
    if mode == "plus":
        np.add(b, a, out=b)
    elif mode == "minus":
        np.subtract(b, a, out=b)
    elif mode == "intersection":
        np.multiply(b, a, out=b)
    elif mode == "xor":
        b += a - 2.0 * a * b
    else:                                   # union
        b += a - a * b
    np.clip(b, 0.0, 1.0, out=b)


def layer_mode(layer):
    m = str(layer.get("mode") or "union").lower()
    return m if m in MODES else "union"


def _num(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


def _pt(obj, default=(0.0, 0.0)):
    """Read a normalized point-ish {x,y} dict."""
    if not isinstance(obj, dict):
        return default
    return (_num(obj.get("x"), default[0]), _num(obj.get("y"), default[1]))


def _lerp(a, b, t):
    return a + (b - a) * t


def _lerp_pt(a, b, t):
    return (_lerp(a[0], b[0], t), _lerp(a[1], b[1], t))


def _bezier(p0, c0, c1, p1, steps):
    """Cubic bezier from p0->p1 with control points c0 (out of p0), c1 (in of p1)."""
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1.0 - t
        a = mt * mt * mt
        b = 3 * mt * mt * t
        c = 3 * mt * t * t
        d = t * t * t
        out.append((
            a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0],
            a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1],
        ))
    return out


# ── cubic-bezier keyframe easing (mirrors bezierEase in bEpicViewer_roto.js) ──

def _bezier_axis(t, a1, a2):          # cubic coord with P0=0, P3=1
    mt = 1.0 - t
    return 3 * mt * mt * t * a1 + 3 * mt * t * t * a2 + t * t * t


def _bezier_solve_t(x, p1x, p2x):
    t = x
    for _ in range(8):                # Newton-Raphson
        err = _bezier_axis(t, p1x, p2x) - x
        if abs(err) < 1e-5:
            return t
        d = 3 * (1 - t) * (1 - t) * p1x + 6 * (1 - t) * t * (p2x - p1x) + 3 * t * t * (1 - p2x)
        if abs(d) < 1e-6:
            break
        t -= err / d
    lo, hi, t = 0.0, 1.0, x           # bisection fallback
    for _ in range(24):
        xt = _bezier_axis(t, p1x, p2x)
        if abs(xt - x) < 1e-5:
            break
        if xt < x:
            lo = t
        else:
            hi = t
        t = (lo + hi) / 2.0
    return t


def _bezier_ease(x, p1x, p1y, p2x, p2y):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    return _bezier_axis(_bezier_solve_t(x, p1x, p2x), p1y, p2y)


def _key_tangent(layer, frame):
    """Per-keyframe ease control points (ox,oy = out, ix,iy = in). Absent →
    derived from the legacy scalar `ease` (0 linear .. 1 smooth)."""
    tans = layer.get("tangents")
    t = tans.get(str(frame)) if isinstance(tans, dict) else None
    if isinstance(t, dict):
        return (_num(t.get("ox"), 1 / 3.), _num(t.get("oy"), 1 / 3.),
                _num(t.get("ix"), 2 / 3.), _num(t.get("iy"), 2 / 3.))
    e = max(0.0, min(1.0, _num(layer.get("ease"), 0.0)))
    return (1 / 3., (1 - e) / 3., 2 / 3., 2 / 3. + e / 3.)


def _seg_ease(layer, lo, hi, x):
    """Eased interpolation parameter for the segment lo→hi at time fraction x.
    A `hold` key keeps its shape until the next key (a step), as in the viewer."""
    tans = layer.get("tangents")
    t_lo = tans.get(str(lo)) if isinstance(tans, dict) else None
    if isinstance(t_lo, dict) and t_lo.get("hold"):
        return 1.0 if x >= 1 else 0.0
    ox, oy, _ix, _iy = _key_tangent(layer, lo)
    _ox, _oy, ix, iy = _key_tangent(layer, hi)
    return _bezier_ease(x, ox, oy, ix, iy)


# ── keyframe resolution ──────────────────────────────────────────────────────

def _points_for_frame(layer, frame):
    """Return the list of point dicts for a given timeline frame.

    keyframes is {"<frame>": [points...]}. Missing / single keyframe falls back
    to the layer's static `points`.  Between two keyframes we linearly
    interpolate matching point indices (position + tangents + feather point).
    """
    kfs = layer.get("keyframes")
    if not isinstance(kfs, dict) or len(kfs) == 0:
        return layer.get("points") or []

    try:
        frames = sorted(int(k) for k in kfs.keys())
    except Exception:
        return layer.get("points") or []
    if not frames:
        return layer.get("points") or []

    if frame <= frames[0]:
        return kfs[str(frames[0])]
    if frame >= frames[-1]:
        return kfs[str(frames[-1])]

    lo = frames[0]
    hi = frames[-1]
    for f in frames:
        if f <= frame:
            lo = f
        if f >= frame:
            hi = f
            break
    if hi == lo:
        return kfs[str(lo)]

    a = kfs[str(lo)]
    b = kfs[str(hi)]
    if not isinstance(a, list) or not isinstance(b, list) or len(a) != len(b):
        # can't interpolate mismatched shapes; snap to nearest
        return a if (frame - lo) <= (hi - frame) else b

    # Per-keyframe ease (cubic-bezier tangents) — matches the viewer's curve editor.
    t = _seg_ease(layer, lo, hi, (frame - lo) / float(hi - lo))
    merged = []
    for pa, pb in zip(a, b):
        p = {
            "x": _lerp(_num(pa.get("x")), _num(pb.get("x")), t),
            "y": _lerp(_num(pa.get("y")), _num(pb.get("y")), t),
        }
        for key in ("cin", "cout"):
            if key in pa or key in pb:
                da = _pt(pa.get(key), (p["x"], p["y"]))
                db = _pt(pb.get(key), (p["x"], p["y"]))
                lp = _lerp_pt(da, db, t)
                p[key] = {"x": lp[0], "y": lp[1]}
        # feather: a nested point that may carry its own tangents (outer curve).
        if "feather" in pa or "feather" in pb:
            fa = pa.get("feather") if isinstance(pa.get("feather"), dict) else {"x": pa.get("x"), "y": pa.get("y")}
            fb = pb.get("feather") if isinstance(pb.get("feather"), dict) else {"x": pb.get("x"), "y": pb.get("y")}
            flp = _lerp_pt(_pt(fa, (p["x"], p["y"])), _pt(fb, (p["x"], p["y"])), t)
            fp = {"x": flp[0], "y": flp[1]}
            for key in ("cin", "cout"):
                if key in fa or key in fb:
                    da = _pt(fa.get(key), (fp["x"], fp["y"]))
                    db = _pt(fb.get(key), (fp["x"], fp["y"]))
                    lp = _lerp_pt(da, db, t)
                    fp[key] = {"x": lp[0], "y": lp[1]}
            p["feather"] = fp
        merged.append(p)
    return merged


# ── geometry ─────────────────────────────────────────────────────────────────

def _apply_transform_px(x, y, tf, W, H):
    """Apply a shape transform in pixel space (rotation is geometrically true)."""
    if not tf:
        return x, y
    px = _num(tf.get("px"), 0.5) * W
    py = _num(tf.get("py"), 0.5) * H
    sx = _num(tf.get("sx"), 1.0)
    sy = _num(tf.get("sy"), 1.0)
    rot = math.radians(_num(tf.get("rot"), 0.0))
    tx = _num(tf.get("tx"), 0.0) * W
    ty = _num(tf.get("ty"), 0.0) * H

    dx = (x - px) * sx
    dy = (y - py) * sy
    if rot:
        ca, sa = math.cos(rot), math.sin(rot)
        rx = dx * ca - dy * sa
        ry = dx * sa + dy * ca
        dx, dy = rx, ry
    return dx + px + tx, dy + py + ty


def _contour(points, W, H, tf, use_feather, steps):
    """Tessellate a list of normalized point dicts into a closed pixel polygon.

    use_feather: when True, each vertex is replaced by its feather point and the
    segment uses that feather point's OWN tangents (falling back to the vertex /
    its core tangent translated by the feather offset when absent), producing the
    outer feather contour that the soft edge blends out to.
    """
    if not isinstance(points, list) or len(points) < 2:
        return []

    def vert(p):
        if use_feather and isinstance(p.get("feather"), dict):
            base = _pt(p.get("feather"), _pt(p))
        else:
            base = _pt(p)
        return (base[0] * W, base[1] * H)

    def handle(p, which, fallback):
        # Outer contour: prefer the feather point's own tangent; else translate
        # the core tangent by the feather offset; else fall back to the anchor.
        if use_feather and isinstance(p.get("feather"), dict):
            f = p["feather"]
            fh = f.get(which)
            if isinstance(fh, dict):
                return (_num(fh.get("x")) * W, _num(fh.get("y")) * H)
            c = p.get(which)
            if isinstance(c, dict):
                px, py = _pt(p)
                fx, fy = _pt(f, (px, py))
                return ((_num(c.get("x")) + (fx - px)) * W, (_num(c.get("y")) + (fy - py)) * H)
            return fallback
        c = p.get(which)
        if isinstance(c, dict):
            return (_num(c.get("x")) * W, _num(c.get("y")) * H)
        return fallback

    poly = []
    n = len(points)
    for i in range(n):
        p0 = points[i]
        p1 = points[(i + 1) % n]
        a = vert(p0)
        b = vert(p1)
        c0 = handle(p0, "cout", a)
        c1 = handle(p1, "cin", b)
        poly.append(a)
        # only curve when tangents actually differ from the anchors
        if c0 != a or c1 != b:
            poly.extend(_bezier(a, c0, c1, b, steps))
        # (straight segment: next anchor appended on the following iteration)

    return [_apply_transform_px(x, y, tf, W, H) for (x, y) in poly]


def _fill_polygon(poly, w, h, ss=2, off=(0, 0)):
    """Anti-aliased fill of a polygon → float32 [h,w] in 0..1, for the region
    of the frame whose top-left corner is `off` (x, y) in frame pixels."""
    if Image is None or len(poly) < 3:
        return np.zeros((h, w), dtype=np.float32)
    ox, oy = off
    img = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(img)
    d.polygon([((x - ox) * ss, (y - oy) * ss) for (x, y) in poly], fill=255)
    if ss != 1:
        img = img.resize((w, h), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32) / 255.0


# ── morphology / blur helpers ────────────────────────────────────────────────

def _gaussian(mask, radius):
    if radius <= 0:
        return mask
    if _ndimage is not None:
        return _ndimage.gaussian_filter(mask, sigma=max(radius, 0.01))
    if Image is None:
        return mask
    im = Image.fromarray(np.clip(mask * 255.0, 0, 255).astype(np.uint8))
    im = im.filter(ImageFilter.GaussianBlur(radius=radius))
    return np.asarray(im, dtype=np.float32) / 255.0


def _dilate_erode(mask, amount):
    """amount>0 dilate, <0 erode, in pixels."""
    if amount == 0:
        return mask
    r = int(round(abs(amount)))
    if r < 1:
        return mask
    if _ndimage is not None:
        if amount > 0:
            return _ndimage.grey_dilation(mask, size=(2 * r + 1, 2 * r + 1))
        return _ndimage.grey_erosion(mask, size=(2 * r + 1, 2 * r + 1))
    if Image is None:
        return mask
    im = Image.fromarray(np.clip(mask * 255.0, 0, 255).astype(np.uint8))
    size = 2 * r + 1
    im = im.filter(ImageFilter.MaxFilter(size) if amount > 0 else ImageFilter.MinFilter(size))
    return np.asarray(im, dtype=np.float32) / 255.0


def _feathered_matte(shape_poly, feather_poly, w, h, feather_px, off=(0, 0)):
    """Blend a shape contour toward its feather contour into a soft matte."""
    core = _fill_polygon(shape_poly, w, h, off=off)
    if not feather_poly or feather_poly == shape_poly:
        if feather_px > 0:
            return np.clip(_gaussian(core, feather_px * 0.5), 0.0, 1.0)
        return core

    outer = _fill_polygon(feather_poly, w, h, off=off)
    union = np.maximum(core, outer)

    if _ndimage is not None:
        # distance-transform ramp: 1 at/inside the shape edge, 0 at feather edge.
        band = (union > 0.5) & (core <= 0.5)
        if not band.any():
            return core
        d_in = _ndimage.distance_transform_edt(core <= 0.5)   # dist to shape
        d_out = _ndimage.distance_transform_edt(union > 0.5)   # dist to outside
        denom = d_in + d_out
        ramp = np.where(denom > 1e-6, d_out / denom, 0.0).astype(np.float32)
        out = np.where(core > 0.5, 1.0, np.where(band, ramp, 0.0)).astype(np.float32)
        return np.clip(out, 0.0, 1.0)

    # Fallback: soften the union by the mean feather distance.
    return np.clip(_gaussian(union, max(feather_px * 0.5, 1.0)), 0.0, 1.0)


# ── per-layer rasterization ──────────────────────────────────────────────────

def _mean_feather_px(points, W, H):
    if not isinstance(points, list):
        return 0.0
    total = 0.0
    count = 0
    for p in points:
        f = p.get("feather")
        if isinstance(f, dict):
            fx, fy = _pt(f)
            dx = (fx - _num(p.get("x"))) * W
            dy = (fy - _num(p.get("y"))) * H
            total += math.hypot(dx, dy)
            count += 1
    return (total / count) if count else 0.0


def _layer_plan(layer, W, H, frame):
    """Everything about one layer at one frame that decides its pixels — the
    outlines in frame pixels and the matte settings — or None when it draws
    nothing. Cheap (tessellation only), so a frame's plans double as its cache
    key: two frames with equal plans have equal mattes."""
    if not layer.get("visible", True):
        return None
    points = _points_for_frame(layer, frame)
    if not isinstance(points, list) or len(points) < 3:
        return None
    tf = layer.get("transform")
    steps = 16
    shape_poly = _contour(points, W, H, tf, use_feather=False, steps=steps)
    if len(shape_poly) < 3:
        return None
    per_shape_feather = _num(layer.get("feather"), 0.0)
    feather_poly, fpx = None, 0.0
    if any(isinstance(p.get("feather"), dict) for p in points):
        feather_poly = _contour(points, W, H, tf, use_feather=True, steps=steps)
        fpx = _mean_feather_px(points, W, H) + per_shape_feather
    return {
        "shape": shape_poly, "feather_poly": feather_poly, "fpx": fpx,
        "feather": per_shape_feather,
        "dilate": _num(layer.get("dilate"), 0.0), "blur": _num(layer.get("blur"), 0.0),
        "invert": bool(layer.get("invert")), "opacity": _num(layer.get("opacity"), 1.0),
        "mode": layer_mode(layer),
    }


def _plan_key(plan):
    if plan is None:
        return None
    r = lambda poly: tuple((round(x, 2), round(y, 2)) for (x, y) in poly) if poly else None
    return (r(plan["shape"]), r(plan["feather_poly"]), round(plan["fpx"], 3), plan["feather"],
            plan["dilate"], plan["blur"], plan["invert"], plan["opacity"], plan["mode"])


def _region(polys, W, H, pad):
    """The part of the frame a layer can touch: the box around its outlines,
    grown by how far its feather, dilate and blur reach. None if off-frame."""
    xs = [x for poly in polys if poly for (x, _y) in poly]
    ys = [y for poly in polys if poly for (_x, y) in poly]
    if not xs:
        return None
    x0 = max(0, int(math.floor(min(xs) - pad)))
    y0 = max(0, int(math.floor(min(ys) - pad)))
    x1 = min(W, int(math.ceil(max(xs) + pad)) + 1)
    y1 = min(H, int(math.ceil(max(ys) + pad)) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _render_plan(plan, W, H):
    """One layer's matte, worked out only inside the region it can reach.

    Returns (matte, (x0, y0, x1, y1)); the region is the whole frame for an
    inverted layer, which is everything outside the shape. Everything outside
    the region is exactly zero — the margin is wide enough that no blur tail or
    dilation is cut off (3 sigma for a Gaussian, the full radius for dilate),
    and the filters see the same zeros past the region's edge as they did past
    it in the full frame."""
    reach = (abs(plan["dilate"]) + 1
             + 3.0 * max(plan["blur"], 0.0)
             + 3.0 * max(plan["feather"] * 0.5, plan["fpx"] * 0.5 if plan["feather_poly"] is None else 0.0)
             + 4)
    box = _region([plan["shape"], plan["feather_poly"]], W, H, reach)
    if box is None:
        matte = None
    else:
        x0, y0, x1, y1 = box
        w, h, off = x1 - x0, y1 - y0, (x0, y0)
        if plan["feather_poly"] is not None:
            matte = _feathered_matte(plan["shape"], plan["feather_poly"], w, h, plan["fpx"], off)
        else:
            matte = _fill_polygon(plan["shape"], w, h, off=off)
            if plan["feather"] > 0:
                matte = np.clip(_gaussian(matte, plan["feather"] * 0.5), 0.0, 1.0)
        matte = _dilate_erode(matte, plan["dilate"])
        if plan["blur"] > 0:
            matte = np.clip(_gaussian(matte, plan["blur"]), 0.0, 1.0)

    if plan["invert"]:
        full = np.zeros((H, W), dtype=np.float32)
        if matte is not None:
            full[y0:y1, x0:x1] = matte
        matte, box = 1.0 - full, (0, 0, W, H)
    if matte is None:
        return None, None
    if plan["opacity"] != 1.0:
        matte = matte * max(0.0, min(1.0, plan["opacity"]))
    return matte.astype(np.float32, copy=False), box


def _render_layer(layer, W, H, frame):
    """A layer's full-frame matte (kept for callers that want one)."""
    plan = _layer_plan(layer, W, H, frame)
    if plan is None:
        return None
    matte, box = _render_plan(plan, W, H)
    if matte is None:
        return None
    out = np.zeros((H, W), dtype=np.float32)
    x0, y0, x1, y1 = box
    out[y0:y1, x0:x1] = matte
    return out


def _nonzero_box(a, pad, W, H):
    rows = np.flatnonzero(a.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(a.any(axis=0))
    return (max(0, int(cols[0] - pad)), max(0, int(rows[0] - pad)),
            min(W, int(cols[-1] + pad + 1)), min(H, int(rows[-1] + pad + 1)))


# ── public entry point ───────────────────────────────────────────────────────

def _workers():
    try:
        n = int(os.environ.get("BEPIC_ROTO_THREADS", "0"))
    except ValueError:
        n = 0
    return n if n > 0 else max(1, min(16, (os.cpu_count() or 4)))


def rasterize(roto_data, W, H, frame_count=1):
    """Rasterize roto JSON into a float32 mask batch [N, H, W] in 0..1.

    frame_count is the input batch size; if any layer is keyframed we render a
    mask per frame, otherwise the single static matte is broadcast.

    Speed: each layer is worked out only inside the region its outline,
    feather, dilate and blur can reach (the full-frame distance transforms and
    blurs were ~75% of the time); a frame whose outlines equal an earlier
    frame's reuses its mask (before the first key, after the last, on Hold);
    and the frames left are rendered on a thread pool — the fill, the distance
    transforms and the blurs run in C with the GIL released. Set
    BEPIC_ROTO_THREADS to cap the pool.
    """
    W = int(max(1, W))
    H = int(max(1, H))
    N = int(max(1, frame_count))

    try:
        layers = roto_data.get("layers") if isinstance(roto_data, dict) else None
        if not layers:
            return np.zeros((N, H, W), dtype=np.float32)

        animated = any(
            isinstance(l.get("keyframes"), dict) and len(l.get("keyframes")) > 1
            for l in layers
        )
        g = roto_data.get("global") if isinstance(roto_data.get("global"), dict) else {}
        g_dilate = _num(g.get("dilate"), 0.0)
        g_feather = _num(g.get("feather"), 0.0)
        g_blur = _num(g.get("blur"), 0.0)
        g_reach = abs(g_dilate) + 1 + 3.0 * max(g_blur, g_feather * 0.5, 0.0) + 4

        def plans_for(frame):
            out = []
            for layer in layers:
                try:
                    out.append(_layer_plan(layer, W, H, frame))
                except Exception:
                    out.append(None)
            return out

        def render_frame(plans, dst):
            acc = dst
            acc[...] = 0.0
            for plan in plans:
                if plan is None:
                    continue
                try:
                    m, box = _render_plan(plan, W, H)
                except Exception:
                    m = None
                mode = plan["mode"]
                if m is None:
                    # Nothing drawn: A is 0 everywhere, which only intersection notices.
                    if mode == "intersection":
                        acc[...] = 0.0
                    continue
                x0, y0, x1, y1 = box
                if mode == "intersection":
                    # A is 0 outside the shape's region: everything there goes.
                    inside = acc[y0:y1, x0:x1] * m
                    acc[...] = 0.0
                    acc[y0:y1, x0:x1] = inside
                else:
                    # Outside the region A is 0, and union, plus, minus and xor
                    # all leave B as it is there.
                    _merge(mode, acc[y0:y1, x0:x1], m)
            # global post, over the part of the frame that has anything in it
            if g_dilate or g_feather > 0 or g_blur > 0:
                box = _nonzero_box(acc, g_reach, W, H)
                if box is not None:
                    x0, y0, x1, y1 = box
                    region = acc[y0:y1, x0:x1]
                    region = _dilate_erode(region, g_dilate)
                    if g_feather > 0:
                        region = np.clip(_gaussian(region, g_feather * 0.5), 0.0, 1.0)
                    if g_blur > 0:
                        region = np.clip(_gaussian(region, g_blur), 0.0, 1.0)
                    acc[y0:y1, x0:x1] = region
            if g.get("invert"):
                np.subtract(1.0, acc, out=acc)
            np.clip(acc, 0.0, 1.0, out=acc)

        # Every frame writes straight into the one output array — no per-frame
        # full-size copies (see the note that used to sit here: np.stack over a
        # list held every frame twice).
        out = np.empty((N, H, W), dtype=np.float32)
        if not (animated and N > 1):
            render_frame(plans_for(0), out[0])
            out[1:] = out[0]
            return out

        # Frames whose outlines match an earlier frame's reuse its mask.
        first_of = {}
        todo, copies = [], []
        for i in range(N):
            plans = plans_for(i)
            key = tuple(_plan_key(p) for p in plans)
            if key in first_of:
                copies.append((i, first_of[key]))
            else:
                first_of[key] = i
                todo.append((i, plans))

        workers = min(_workers(), len(todo))
        if workers > 1:
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(lambda job: render_frame(job[1], out[job[0]]), todo))
        else:
            for i, plans in todo:
                render_frame(plans, out[i])
        for i, j in copies:
            out[i] = out[j]
        return out
    except Exception:
        return np.zeros((N, H, W), dtype=np.float32)
