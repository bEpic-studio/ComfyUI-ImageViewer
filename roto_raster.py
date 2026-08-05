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
  * Shapes in a layer stack are unioned (max), matching Nuke's default union
    of roto shapes.  Per-shape `invert`/`opacity` and a `global` block of
    invert/blur/dilate/feather are also honoured.

Everything is wrapped so a malformed payload yields a zero mask rather than
raising during a ComfyUI execution.
"""

import math

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
    """Eased interpolation parameter for the segment lo→hi at time fraction x."""
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


def _fill_polygon(poly, W, H, ss=2):
    """Anti-aliased fill of a polygon → float32 [H,W] in 0..1."""
    if Image is None or len(poly) < 3:
        return np.zeros((H, W), dtype=np.float32)
    img = Image.new("L", (W * ss, H * ss), 0)
    d = ImageDraw.Draw(img)
    d.polygon([(x * ss, y * ss) for (x, y) in poly], fill=255)
    if ss != 1:
        img = img.resize((W, H), Image.BILINEAR)
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


def _feathered_matte(shape_poly, feather_poly, W, H, feather_px):
    """Blend a shape contour toward its feather contour into a soft matte."""
    core = _fill_polygon(shape_poly, W, H)
    if not feather_poly or feather_poly == shape_poly:
        if feather_px > 0:
            return np.clip(_gaussian(core, feather_px * 0.5), 0.0, 1.0)
        return core

    outer = _fill_polygon(feather_poly, W, H)
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


def _render_layer(layer, W, H, frame):
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
    has_pt_feather = any(isinstance(p.get("feather"), dict) for p in points)
    if has_pt_feather:
        feather_poly = _contour(points, W, H, tf, use_feather=True, steps=steps)
        fpx = _mean_feather_px(points, W, H) + per_shape_feather
        matte = _feathered_matte(shape_poly, feather_poly, W, H, fpx)
    else:
        matte = _fill_polygon(shape_poly, W, H)
        if per_shape_feather > 0:
            matte = np.clip(_gaussian(matte, per_shape_feather * 0.5), 0.0, 1.0)

    matte = _dilate_erode(matte, _num(layer.get("dilate"), 0.0))
    blur = _num(layer.get("blur"), 0.0)
    if blur > 0:
        matte = np.clip(_gaussian(matte, blur), 0.0, 1.0)

    if layer.get("invert"):
        matte = 1.0 - matte

    opacity = _num(layer.get("opacity"), 1.0)
    if opacity != 1.0:
        matte = matte * max(0.0, min(1.0, opacity))

    return matte.astype(np.float32)


# ── public entry point ───────────────────────────────────────────────────────

def rasterize(roto_data, W, H, frame_count=1):
    """Rasterize roto JSON into a float32 mask batch [N, H, W] in 0..1.

    frame_count is the input batch size; if any layer is keyframed we render a
    mask per frame, otherwise the single static matte is broadcast.
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

        def render_frame(frame):
            acc = np.zeros((H, W), dtype=np.float32)
            for layer in layers:
                try:
                    m = _render_layer(layer, W, H, frame)
                except Exception:
                    m = None
                if m is not None:
                    acc = np.maximum(acc, m)
            # global post
            acc = _dilate_erode(acc, _num(g.get("dilate"), 0.0))
            gf = _num(g.get("feather"), 0.0)
            if gf > 0:
                acc = np.clip(_gaussian(acc, gf * 0.5), 0.0, 1.0)
            gb = _num(g.get("blur"), 0.0)
            if gb > 0:
                acc = np.clip(_gaussian(acc, gb), 0.0, 1.0)
            if g.get("invert"):
                acc = 1.0 - acc
            return np.clip(acc, 0.0, 1.0)

        # Both branches write straight into the one output array. The obvious
        # spellings each carried a redundant full-size copy: np.stack over a list
        # of per-frame mattes holds every frame twice at the moment it allocates,
        # and `.astype(np.float32)` on an array that is already float32 still
        # copies (astype defaults to copy=True). At [N,H,W] float32 that is
        # gigabytes for a long sequence — 957 MB peak measured for a 477 MB matte.
        out = np.empty((N, H, W), dtype=np.float32)
        if animated and N > 1:
            for i in range(N):
                out[i] = render_frame(i)
            return out

        # Static roto: one matte broadcast across the batch, so it is rendered
        # once and assigned into every slice without an intermediate.
        out[...] = render_frame(0)
        return out
    except Exception:
        return np.zeros((N, H, W), dtype=np.float32)
