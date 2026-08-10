"""Resolve a loader node's media widget value into viewer frames.

Backs the canvas context-menu action "Send to Image Viewer": the frontend hands
over the raw widget string of any VHS / native loader node and gets back ready-
made viewer tab descriptors — the same frame dicts bEpicSendToViewer pushes over
the websocket, so the viewer displays them with no special-casing.

Three widget shapes are covered:
  • a filename under ./input  ("clip.mp4", "sub/img.png", "img.png [output]")
    — native LoadImage / LoadVideo and the VHS upload loaders
  • an absolute OS path       — the VHS "(Path)" loaders
  • a directory               — VHS "Load Images (Path)" and friends, expanded
    to the whole image sequence so the viewer's timeline scrubs it
"""

import hashlib
import os
import re

import folder_paths

try:
    from . import file_writer
except Exception:  # pragma: no cover - file_writer is optional
    file_writer = None


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico",
              ".svg", ".tif", ".tiff", ".exr", ".dpx", ".tga", ".hdr"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi", ".mpg",
              ".mpeg", ".wmv", ".flv"}

# Formats an <img> renders directly. Everything else is transcoded to PNG on the
# fly by /bepic/view_file, so sequences stay lazy (only scrubbed frames convert).
BROWSER_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
                      ".ico", ".svg"}

# Scene-linear formats: shown without a display transform they look near-black.
_LINEAR_EXTS = {".exr", ".hdr", ".dpx"}

_ANNOTATION_RE = re.compile(r"^(.*?)\s*\[(\w+)\]\s*$")


def _strip_annotation(value):
    """Split ComfyUI's "name.png [output]" combo annotation into (name, type)."""
    m = _ANNOTATION_RE.match(value)
    if m:
        return m.group(1).strip(), m.group(2).lower()
    return value.strip(), ""


def _base_dirs(preferred=""):
    """ComfyUI's media roots, `preferred` (an annotation type) tried first."""
    getters = [
        ("input", folder_paths.get_input_directory),
        ("output", folder_paths.get_output_directory),
        ("temp", folder_paths.get_temp_directory),
    ]
    if preferred:
        getters.sort(key=lambda kv: kv[0] != preferred)
    dirs = []
    for _, get in getters:
        try:
            dirs.append(get())
        except Exception:
            continue
    return dirs


def resolve_path(raw, ann_type=""):
    """Absolute existing path for a widget value, or None.

    Absolute values are used as-is; relative ones are looked up under ComfyUI's
    input/output/temp roots (the annotated type first) and finally the cwd.
    """
    if not raw:
        return None
    value, ann = _strip_annotation(str(raw).strip().strip('"'))
    if not value:
        return None
    value = os.path.expandvars(os.path.expanduser(value))

    candidates = []
    if os.path.isabs(value):
        candidates.append(value)
    else:
        for d in _base_dirs(ann or ann_type):
            candidates.append(os.path.join(d, value))
        candidates.append(value)

    for cand in candidates:
        try:
            full = os.path.abspath(cand)
        except Exception:
            continue
        if os.path.exists(full):
            return full
    return None


# ── Display proxies for formats a browser can't render ───────────────────────
#
# exr / tiff / dpx / ... are transcoded to a PNG in the temp dir the first time
# they are actually requested, so opening a 500-frame EXR sequence costs nothing
# up front — only the frames the user scrubs to are converted, and the proxy is
# reused until the source file changes.

def needs_proxy(path):
    ext = os.path.splitext(path)[1].lower()
    return ext in IMAGE_EXTS and ext not in BROWSER_IMAGE_EXTS


def _cache_path(src, kind="proxy"):
    """Deterministic temp-dir PNG path for a derivative of `src`, so the same
    source file reuses one cache entry instead of piling up copies. The bEpic_
    prefix keeps these collectable by the viewer's Clear Cache button."""
    tmp = folder_paths.get_temp_directory()
    os.makedirs(tmp, exist_ok=True)
    digest = hashlib.sha1(os.path.normcase(src).encode("utf-8", "replace")).hexdigest()[:16]
    stem = "".join(c for c in os.path.splitext(os.path.basename(src))[0]
                   if c.isalnum() or c in "-_")[:40] or "img"
    return os.path.join(tmp, f"bEpic_{kind}_{stem}_{digest}.png")


def _cached(dst, src):
    """True when `dst` already holds an up-to-date derivative of `src`."""
    try:
        return os.path.isfile(dst) and os.path.getmtime(dst) >= os.path.getmtime(src)
    except Exception:
        return False


def _write_proxy_pil(src, dst):
    from PIL import Image
    import numpy as np
    with Image.open(src) as im:
        # PIL's convert() can't map high-bit-depth single-channel modes to 8-bit,
        # so those are rescaled by hand: integer modes from their 16-bit range,
        # float modes from whatever range the file actually uses.
        if im.mode.startswith("I") or im.mode == "F":
            arr = np.asarray(im).astype("float32")
            scale = 65535.0 if im.mode.startswith("I") else max(float(arr.max()), 1.0)
            arr = np.clip(arr / scale, 0.0, 1.0)
            Image.fromarray((arr * 255.0).astype("uint8")).convert("RGB").save(
                dst, compress_level=4)
        else:
            (im if im.mode == "RGB" else im.convert("RGB")).save(dst, compress_level=4)


def _write_proxy_oiio(src, dst):
    import OpenImageIO as oiio
    import numpy as np
    from PIL import Image
    buf = oiio.ImageBuf(src)
    if buf.has_error:
        raise RuntimeError(buf.geterror())
    try:
        # Scene-linear formats (exr/hdr) look near-black shown raw.
        converted = oiio.ImageBufAlgo.colorconvert(buf, "linear", "sRGB")
        if converted is not None and not converted.has_error:
            buf = converted
    except Exception:
        pass
    arr = np.asarray(buf.get_pixels(oiio.FLOAT), dtype="float32")
    if arr.ndim == 2:
        arr = arr[:, :, None]
    arr = arr[:, :, :3]
    if arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=2)
    Image.fromarray((np.clip(arr, 0.0, 1.0) * 255.0).astype("uint8"), "RGB").save(
        dst, compress_level=4)


def proxy_for_display(path):
    """A browser-renderable stand-in for `path`, or None when it needs none (or
    when no decoder on this install can read it — the caller then serves the
    original and the browser shows a broken image rather than an error)."""
    try:
        if not needs_proxy(path):
            return None
    except Exception:
        return None

    try:
        dst = _cache_path(path, "proxy")
    except Exception:
        return None
    if _cached(dst, path):
        return dst

    # PIL covers tiff/tga and is always installed; the scene-linear formats need
    # OpenImageIO's colour conversion to not come out near-black, so they try it
    # first and fall back to PIL only if OIIO is missing.
    writers = ((_write_proxy_oiio, _write_proxy_pil)
               if os.path.splitext(path)[1].lower() in _LINEAR_EXTS
               else (_write_proxy_pil, _write_proxy_oiio))
    for writer in writers:
        try:
            writer(path, dst)
            return dst
        except Exception:
            continue
    print(f"[bEpicViewer] no decoder for {path} — serving it unconverted")
    return None


def _natural_key(name):
    """Sort key that orders frame_2.png before frame_10.png."""
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r"(\d+)", name)]


def _list_dir(path):
    """(images, videos) in `path`, each naturally sorted. Not recursive."""
    images, videos = [], []
    try:
        names = os.listdir(path)
    except Exception:
        return images, videos
    for name in sorted(names, key=_natural_key):
        full = os.path.join(path, name)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(name)[1].lower()
        if ext in IMAGE_EXTS:
            images.append(full)
        elif ext in VIDEO_EXTS:
            videos.append(full)
    return images, videos


def _trim(files, skip=0, cap=0, every=1):
    """Apply the VHS sequence-trimming widgets in the order VHS applies them, so
    the viewer shows exactly the frames the node will load."""
    if skip > 0:
        files = files[skip:]
    if every and every > 1:
        files = files[::every]
    if cap and cap > 0:
        files = files[:cap]
    return files


def probe_video(path):
    """(fps, frame_count) for a video file — best effort, (0.0, 0) when unknown.

    The viewer falls back to the <video> element's own duration when either is
    missing, so an install without imageio/cv2 still plays the clip; only the
    frame-accurate timeline needs these numbers.
    """
    fps, frames = 0.0, 0
    try:
        import imageio
        reader = imageio.get_reader(path)
        try:
            meta = reader.get_meta_data() or {}
            fps = float(meta.get("fps") or 0)
            count = meta.get("nframes")
            if isinstance(count, (int, float)) and count == count and count not in (float("inf"),):
                frames = int(count) if count > 0 else 0
            if not frames:
                duration = float(meta.get("duration") or 0)
                if duration > 0 and fps > 0:
                    frames = int(round(duration * fps))
        finally:
            reader.close()
    except Exception:
        pass

    if fps <= 0 or frames <= 0:
        try:
            import cv2
            cap = cv2.VideoCapture(path)
            try:
                if fps <= 0:
                    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
                if frames <= 0:
                    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            finally:
                cap.release()
        except Exception:
            pass

    return (fps if fps > 0 else 0.0), max(0, frames)


# ── Single-frame extraction ──────────────────────────────────────────────────
#
# Pulling one frame out of a clip the viewer is playing, so it can be handed to
# the graph as a still. The PNG is written NEXT TO the video it came from — that
# is where the rest of that shot's media already lives, and it keeps the frame
# addressable by a path loader rather than buried in a cache — falling back to
# ./output/extracted_frames only when the video's own folder can't be written
# (a read-only mount, or media served off another machine).

_EXTRACT_DIR = "extracted_frames"


def _decode_video_frame(video_path, index):
    """Frame `index` of a video as an [H,W,3] uint8 array, or None.

    imageio first — it is the decoder this extension already encodes with — then
    OpenCV, which some installs have instead. Same order as probe_video.
    """
    import numpy as np
    try:
        import imageio
        reader = imageio.get_reader(video_path)
        try:
            return np.asarray(reader.get_data(int(index)))[:, :, :3]
        finally:
            reader.close()
    except Exception:
        pass
    try:
        import cv2
        cap = cv2.VideoCapture(video_path)
        try:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = cap.read()
        finally:
            cap.release()
        if ok and frame is not None:
            return np.asarray(frame)[:, :, ::-1]        # OpenCV hands back BGR
    except Exception:
        pass
    return None


def extract_dir_fallback():
    """./output/extracted_frames — where frames go when they can't sit beside
    their source (and where frames of a browser-only clip always go)."""
    return os.path.join(folder_paths.get_output_directory(), _EXTRACT_DIR)


def _extract_targets(video_path, name):
    """Where an extracted frame may be written, best first."""
    targets = []
    folder = os.path.dirname(video_path)
    if folder:
        targets.append(os.path.join(folder, name))
    try:
        targets.append(os.path.join(extract_dir_fallback(), name))
    except Exception:
        pass
    return targets


def extract_frame_name(video_path, index):
    """Filename an extracted frame is given: the clip's own name plus the frame
    number, so a folder of extracts still says which clip each came from."""
    stem = os.path.splitext(os.path.basename(video_path))[0]
    return f"{stem}_f{int(index):05d}.png"


def extract_frame(video_path, index):
    """Write frame `index` of `video_path` out as a PNG and return its path.

    A frame already extracted is handed back as it stands rather than decoded
    again, so dragging the same one out twice costs nothing. Raises ValueError
    with a user-facing message when the clip can't be decoded or written.
    """
    from PIL import Image

    index = max(0, int(index))
    targets = _extract_targets(video_path, extract_frame_name(video_path, index))
    if not targets:
        raise ValueError("nowhere to write the extracted frame")
    for dst in targets:
        if _cached(dst, video_path):
            return dst

    arr = _decode_video_frame(video_path, index)
    if arr is None:
        raise ValueError(
            f"could not decode frame {index} of {os.path.basename(video_path)} "
            f"— this install has neither imageio-ffmpeg nor opencv-python, or "
            f"the clip is shorter than that")

    img = Image.fromarray(arr)
    last = None
    for dst in targets:
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            img.save(dst, compress_level=4)
            return dst
        except Exception as e:
            last = e
    raise ValueError(f"could not write the extracted frame: {last}")


def _video_thumb(path):
    """Temp PNG poster for a video (an <img> in the history strip can't show the
    clip itself), cached per source file. None when no decoder is available."""
    if file_writer is None:
        return None
    try:
        dst = _cache_path(path, "poster")
    except Exception:
        dst = None
    if dst and _cached(dst, path):
        return dst
    try:
        made = file_writer._thumb_from_video_file(
            path, os.path.splitext(os.path.basename(path))[0])
        if made and dst:
            os.replace(made, dst)
            return dst
        return made
    except Exception:
        return None


def _image_frame(path):
    return {"path": path, "name": os.path.basename(path), "external": True}


def _video_frame(path):
    fps, frames = probe_video(path)
    frame = {
        "kind": "video",
        "path": path,
        "name": os.path.basename(path),
        "external": True,
        "fps": fps if fps > 0 else 24.0,
    }
    if frames > 0:
        frame["frames"] = frames
    thumb = _video_thumb(path)
    if thumb:
        frame["thumb"] = thumb
    return frame


def resolve(raw, hint="", ann_type="", skip=0, cap=0, every=1):
    """Turn a loader widget value into viewer tab descriptors.

    Returns a list of {label, kind, frames} — one entry per tab to open. Raises
    ValueError with a user-facing message when nothing can be shown.
    """
    path = resolve_path(raw, ann_type)
    if not path:
        raise ValueError(f"could not find {raw!r} on disk "
                         f"(looked in ./input, ./output, ./temp and as an absolute path)")

    if os.path.isdir(path):
        images, videos = _list_dir(path)
        folder = os.path.basename(path.rstrip("\\/")) or path
        if images:
            images = _trim(images, skip, cap, every)
            if not images:
                raise ValueError(f"the trim widgets skip every image in {folder!r}")
            return [{
                "label": f"{folder} ({len(images)})",
                "kind": "sequence",
                "frames": [_image_frame(p) for p in images],
            }]
        if videos:
            # A folder of clips: one tab each, since a video tab holds one video.
            return [{
                "label": os.path.basename(p),
                "kind": "video",
                "frames": [_video_frame(p)],
            } for p in videos]
        raise ValueError(f"no images or videos in {folder!r}")

    ext = os.path.splitext(path)[1].lower()
    name = os.path.basename(path)
    if ext in VIDEO_EXTS:
        return [{"label": name, "kind": "video", "frames": [_video_frame(path)]}]
    if ext in IMAGE_EXTS:
        return [{"label": name, "kind": "image", "frames": [_image_frame(path)]}]

    # Unknown extension — the widget hint decides whether to try it as a video.
    if "video" in (hint or "").lower():
        return [{"label": name, "kind": "video", "frames": [_video_frame(path)]}]
    raise ValueError(f"{name!r} is not a supported image or video format")


def resolve_files(files, ann_type="input", label=""):
    """Turn an explicit list of media files into viewer tab descriptors.

    For container-style loaders (AYON) that keep their media in a JSON blob
    rather than a path widget: the caller has already picked the files the node
    loads, in load order, each relative to ./input. Several images are one
    sequence — that is how the node batches them — while videos get a tab each.

    Returns (tabs, missing) so a partly-uploaded container still shows what it
    can instead of failing outright.
    """
    resolved, missing = [], []
    for entry in files or []:
        path = resolve_path(entry, ann_type or "input")
        if path and os.path.isfile(path):
            resolved.append(path)
        else:
            missing.append(str(entry))

    if not resolved:
        shown = ", ".join(missing[:3]) + ("…" if len(missing) > 3 else "")
        raise ValueError(f"none of the container's files are on disk: {shown}")

    images = [p for p in resolved if os.path.splitext(p)[1].lower() in IMAGE_EXTS]
    videos = [p for p in resolved if os.path.splitext(p)[1].lower() in VIDEO_EXTS]

    if images:
        name = label or os.path.basename(images[0])
        if len(images) == 1:
            tabs = [{"label": name, "kind": "image",
                     "frames": [_image_frame(images[0])]}]
        else:
            tabs = [{"label": f"{name} ({len(images)})", "kind": "sequence",
                     "frames": [_image_frame(p) for p in images]}]
    elif videos:
        tabs = [{"label": label or os.path.basename(p), "kind": "video",
                 "frames": [_video_frame(p)]} for p in videos]
    else:
        raise ValueError("nothing viewable in the container — 3D models and "
                         "other non-image formats can't be shown")
    return tabs, missing
