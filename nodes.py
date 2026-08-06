import os
import json
import uuid
from PIL import Image
import numpy as np
import torch
import folder_paths
from server import PromptServer

try:
    from comfy.comfy_types.node_typing import IO
except Exception:
    IO = None

try:
    from . import roto_raster
except Exception:
    roto_raster = None

try:
    from . import file_writer
except Exception:
    file_writer = None


_ANY = IO.ANY if IO is not None else "IMAGE"

# File formats offered by the "save to ./output" mode. Discovered from the
# installed writers when file_writer imports cleanly, else a safe static list.
_FILE_FORMATS = file_writer.FILE_FORMATS if file_writer is not None else [
    "png", "exr", "tiff", "jpg", "mp4", "mov", "webm"]
_DEFAULT_FORMAT = "png" if "png" in _FILE_FORMATS else _FILE_FORMATS[0]

# Which of those formats are actually encoded as video. Carried on the fps input
# spec below so the JS can hide fps for a still-image format without keeping its
# own copy of this list — it reads it out of /object_info, which ships INPUT_TYPES
# verbatim. See videoFormatsFromDef / bepicSyncOutputWidgets.
_VIDEO_FORMATS = file_writer.VIDEO_EXTS if file_writer is not None else ["mp4", "mov", "webm"]


def _dims_from_input(inp):
    """Return (N, H, W) from a ComfyUI IMAGE [B,H,W,C] / MASK [B,H,W] tensor, or
    a native VIDEO object."""
    try:
        if isinstance(inp, torch.Tensor):
            t = inp
            if t.ndim == 4:        # B,H,W,C
                return int(t.shape[0]), int(t.shape[1]), int(t.shape[2])
            if t.ndim == 3:        # B,H,W  (mask)
                return int(t.shape[0]), int(t.shape[1]), int(t.shape[2])
            if t.ndim == 2:        # H,W
                return 1, int(t.shape[0]), int(t.shape[1])
        # ComfyUI VIDEO object: read dims/count without materializing frames.
        if hasattr(inp, "get_dimensions") and hasattr(inp, "get_frame_count"):
            w, h = inp.get_dimensions()
            return int(inp.get_frame_count()), int(h), int(w)
    except Exception:
        pass
    return 1, 512, 512


def _points_prompt(json_str, label):
    """Build a SAM3_POINTS_PROMPT dict from a normalized [{x,y},...] JSON string."""
    pts, labels = [], []
    try:
        arr = json.loads(json_str) if json_str and json_str.strip() else []
    except Exception:
        arr = []
    if isinstance(arr, list):
        for p in arr:
            try:
                x = float(p["x"])
                y = float(p["y"])
            except Exception:
                continue
            pts.append([x, y])
            labels.append(label)
    return {"points": pts, "labels": labels}


def _boxes_prompt(json_str, positive):
    """Build a SAM3_BOXES_PROMPT dict from a normalized [{x1,y1,x2,y2},...] string.

    Boxes arrive already normalized to [0,1] (top-left / bottom-right). SAM3
    expects center format [cx, cy, w, h] plus a per-box boolean label
    (True = positive, False = negative), matching ComfyUI-SAM3's
    SAM3BBoxCollector output.
    """
    boxes, labels = [], []
    try:
        arr = json.loads(json_str) if json_str and json_str.strip() else []
    except Exception:
        arr = []
    if isinstance(arr, list):
        for b in arr:
            try:
                x1 = float(b["x1"]); y1 = float(b["y1"])
                x2 = float(b["x2"]); y2 = float(b["y2"])
            except Exception:
                continue
            lo_x, hi_x = min(x1, x2), max(x1, x2)
            lo_y, hi_y = min(y1, y2), max(y1, y2)
            w = hi_x - lo_x
            h = hi_y - lo_y
            if w <= 0 or h <= 0:
                continue
            boxes.append([(lo_x + hi_x) / 2.0, (lo_y + hi_y) / 2.0, w, h])
            labels.append(bool(positive))
    return {"boxes": boxes, "labels": labels}


def _roto_mask(roto_data, N, H, W):
    """Rasterize a roto_data JSON string to a MASK batch [N,H,W].

    An empty / unparseable store, or a missing rasterizer, yields a black matte
    of the right shape rather than an error — an unused Roto node should be
    harmless to leave wired up."""
    roto_obj = None
    if roto_data and roto_data.strip():
        try:
            roto_obj = json.loads(roto_data)
        except Exception:
            roto_obj = None

    if roto_obj and roto_raster is not None:
        try:
            mask_np = roto_raster.rasterize(roto_obj, W, H, N)
        except Exception:
            mask_np = np.zeros((N, H, W), dtype=np.float32)
    else:
        mask_np = np.zeros((N, H, W), dtype=np.float32)
    return torch.from_numpy(np.ascontiguousarray(mask_np)).float()


# How much preview data one node/tab may keep in the temp dir before its older
# runs are deleted. Budgeting in megabytes rather than in frames tracks the
# resource actually being consumed and scales itself with resolution: 4 GB is
# roughly twenty 1080p stills or four 300-frame 1080p sequences, and a 4K
# sequence is bounded by the same number without anyone re-tuning it.
_TEMP_BUDGET_MB = max(1, int(os.environ.get("BEPIC_TEMP_BUDGET_MB", "4096")))

# ...and never more runs than the viewer's history strip can show anyway
# (HISTORY_LIMIT in bEpicViewer_mixinHistory.js). Without this a single-image
# workflow would keep thousands of tiny runs to fill the byte budget when only
# the newest 20 are reachable. Whichever limit binds first wins.
_TEMP_MAX_RUNS = max(1, int(os.environ.get("BEPIC_TEMP_MAX_RUNS", "20")))

# Hex characters in a run token. Fixed width so a token can be told apart from a
# tab label that happens to end in "_r".
_RUN_TAG_LEN = 8


def _sanitize(value, fallback):
    """Reduce a tab label / node id to characters that survive a filename and
    can't be confused with the separators the run-token scheme relies on."""
    out = "".join(c for c in str(value if value is not None else "")
                  if c.isalnum() or c in "-_")
    return out or fallback


def _run_group_prefix(unique_id, label):
    """Filename prefix shared by every frame this node has ever written for this
    tab. Everything after it is `<token>_<index>`, which is what makes a single
    execution identifiable — and therefore collectable — as a unit."""
    return f"bEpic_S_{_sanitize(unique_id, 'anon')}_{_sanitize(label, 'send')}_r"


def _run_tag_of(name, prefix):
    """The run token in `name`, or None when it doesn't belong to this group."""
    if not name.startswith(prefix):
        return None
    tag = name[len(prefix):len(prefix) + _RUN_TAG_LEN]
    if len(tag) != _RUN_TAG_LEN or not all(c in "0123456789abcdef" for c in tag):
        return None
    # Guard against a longer token being truncated into a false match.
    rest = name[len(prefix) + _RUN_TAG_LEN:]
    return tag if rest.startswith("_") else None


def _gc_temp_runs(out_dir, prefix, keep_tag, budget_mb=None, max_runs=None):
    """Delete this group's oldest runs once the newer ones exceed the budget.

    Runs are ordered newest-first by their most recent file. The run just written
    is always kept, whatever the budget, so a sequence too large for the budget
    still previews — it simply keeps no history behind it.

    Limits are resolved per call rather than bound as defaults, so the module
    attributes stay the single source of truth (and stay patchable in tests)."""
    budget = (_TEMP_BUDGET_MB if budget_mb is None else budget_mb) * 1024 * 1024
    run_cap = _TEMP_MAX_RUNS if max_runs is None else max_runs
    try:
        names = [n for n in os.listdir(out_dir) if n.startswith(prefix)]
    except Exception:
        return 0

    runs = {}
    for name in names:
        tag = _run_tag_of(name, prefix)
        if tag is None:
            continue
        try:
            st = os.stat(os.path.join(out_dir, name))
            mtime, size = st.st_mtime, st.st_size
        except Exception:
            mtime, size = 0.0, 0
        runs.setdefault(tag, []).append((name, mtime, size))

    if len(runs) <= 1:
        return 0

    newest_first = sorted(runs, key=lambda t: max(m for _, m, _s in runs[t]),
                          reverse=True)
    kept_bytes = 0
    kept_runs = 0
    removed = 0
    for tag in newest_first:
        files = runs[tag]
        run_bytes = sum(s for _n, _m, s in files)
        # Keep the current run unconditionally, and never collect everything —
        # the newest run always survives even when it alone blows the budget.
        within = kept_bytes + run_bytes <= budget and kept_runs < run_cap
        if tag == keep_tag or kept_runs == 0 or within:
            kept_bytes += run_bytes
            kept_runs += 1
            continue
        for name, _m, _s in files:
            try:
                os.remove(os.path.join(out_dir, name))
                removed += 1
            except Exception:
                continue
    return removed


def _temp_frames(inp, label, unique_id, out_dir, temp_type):
    """Write every frame of `inp` to a temp PNG and return viewer frame dicts.

    Colour images and single-channel masks are told apart by looking for an axis
    of 3 or 4, so a MASK batch previews as greyscale instead of failing.

    Every frame of one execution shares a run token. That is what stops a re-run
    from colliding with the frames still referenced by history — the old scheme
    drew a fresh `random.randint(1, 1000)` per frame, so at 300 frames and a full
    history roughly 57 frames were silently overwritten by a later render — and
    it is what lets `_gc_temp_runs` collect a whole execution at once."""
    if inp is None:
        return []
    batch_results = []
    prefix = _run_group_prefix(unique_id, label)
    run_tag = uuid.uuid4().hex[:_RUN_TAG_LEN]

    try:
        samples = inp
        for i, tensor in enumerate(samples):
            t = tensor
            arr = t.cpu().numpy()

            # Detect if this array contains 3 or 4 color channels on any axis
            chan_axis = None
            for ax, s in enumerate(arr.shape):
                if s in (3, 4):
                    chan_axis = ax
                    break

            if chan_axis is not None and arr.ndim >= 2:
                try:
                    # Move channel axis to last to get H,W,C
                    if chan_axis != arr.ndim - 1:
                        img_arr = np.moveaxis(arr, chan_axis, -1)
                    else:
                        img_arr = arr

                    # If there's a leading batch dimension, squeeze it
                    if img_arr.ndim == 4 and img_arr.shape[0] == 1:
                        img_arr = img_arr[0]

                    array = 255.0 * img_arr
                    img = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
                    # Convert RGBA → RGB so PNG saves in full colour
                    if img.mode == 'RGBA':
                        img = img.convert('RGB')
                    filename = f"{prefix}{run_tag}_{i:04d}.png"
                    img.save(os.path.join(out_dir, filename), compress_level=4)
                    full = os.path.abspath(os.path.join(out_dir, filename))
                    batch_results.append({"filename": filename, "subfolder": "", "type": temp_type, "path": full})
                except Exception:
                    continue
            else:
                try:
                    mask_arr = arr
                    if mask_arr.ndim == 3 and mask_arr.shape[0] == 1:
                        mask_arr = mask_arr[0]
                    if mask_arr.ndim == 3 and mask_arr.shape[-1] == 1:
                        mask_arr = mask_arr[..., 0]
                    mask_arr = (255.0 * mask_arr).astype(np.uint8)
                    mask_img = Image.fromarray(np.clip(mask_arr, 0, 255).astype(np.uint8)).convert('L')
                    mask_filename = f"{prefix}{run_tag}_{i:04d}_mask.png"
                    mask_img.save(os.path.join(out_dir, mask_filename), compress_level=4)
                    full = os.path.abspath(os.path.join(out_dir, mask_filename))
                    batch_results.append({"filename": mask_filename, "subfolder": "", "type": "mask", "path": full})
                except Exception:
                    continue
    except Exception:
        return []

    # Collect older runs only after this one is safely on disk, so a failure
    # above never costs the frames the viewer is currently showing.
    _gc_temp_runs(out_dir, prefix, run_tag)
    return batch_results


def _push_tab(inp, tab_name, unique_id, node_label):
    """Show `inp` in its own viewer tab, as a preview only.

    This is the tool nodes' whole viewer story: they never persist anything, so
    a native VIDEO is decoded to a playable temp file and everything else lands
    as temp PNGs. Saving frames to ./output stays bEpicSendToViewer's job."""
    out_dir = folder_paths.get_temp_directory()
    label = tab_name.replace(" ", "_") if tab_name else "send"

    frames = None
    if file_writer is not None and file_writer.is_video_input(inp):
        try:
            _saved, frames = file_writer.write_video_input(
                inp, False, "bEpic", "mp4", 24.0)
        except Exception as e:
            print(f"\033[91m[{node_label}] video input failed: {e}\033[0m")
            frames = None
    if not frames:
        frames = _temp_frames(inp, label, unique_id, out_dir, "temp")

    PromptServer.instance.send_sync("bepic.viewer.update", {
        "tabs": {"tab": frames},
        "unique_id": unique_id,
    })


def _history_images(saved_paths):
    """Turn absolute ./output file paths (from file_writer) into ComfyUI history
    image dicts {filename, subfolder, type:"output"}.

    Returning these under a node's `ui.images` records the saved files in
    ComfyUI's prompt history, so they show up in the frontend's outputs/assets
    panel and can be queried by other nodes via /history — the same convention
    SaveImage uses. Paths outside the output dir are skipped."""
    if not saved_paths:
        return []
    try:
        out_dir = os.path.abspath(folder_paths.get_output_directory())
    except Exception:
        return []
    images = []
    for p in saved_paths:
        try:
            rel = os.path.relpath(os.path.abspath(p), out_dir)
        except Exception:
            continue
        if rel.startswith(".."):
            continue  # outside ComfyUI's output dir — not history-addressable
        images.append({
            "filename": os.path.basename(rel),
            "subfolder": os.path.dirname(rel).replace("\\", "/"),
            "type": "output",
        })
    return images


class bEpicSendToViewer:
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "input": (IO.ANY, ) if IO is not None else (("IMAGE", "MASK"),),
                "tab_name": ("STRING", {"default": ""}),
                # "save to ./output" mode. When off (default) the node behaves
                # exactly as before — temp PNGs pushed to the viewer only. When
                # on, the incoming frames are ALSO persisted to ComfyUI's output
                # dir in `file_format`. The JS hides the three config widgets
                # below while this is off.
                "save_to_output": ("BOOLEAN", {"default": False}),
                "file_format": (_FILE_FORMATS, {"default": _DEFAULT_FORMAT}),
                # Only reaches an encoder when file_format is a video container;
                # the JS hides it for still-image formats, driven by the format
                # list carried here.
                "fps": ("FLOAT", {"default": 24.0, "min": 0.01, "max": 1000.0,
                                  "step": 0.01,
                                  "bepic_video_formats": _VIDEO_FORMATS}),
                "filename_prefix": ("STRING", {"default": "bEpic"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    # Straight passthrough. The in-viewer tools used to hang their outputs off
    # this node; they now live on bEpicImageViewerRoto and
    # bEpicImageViewerSAM3Collector, which carry their own image input and tab.
    RETURN_TYPES = (_ANY, )
    RETURN_NAMES = ("image", )
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def send(self, input, tab_name="", save_to_output=False,
             file_format="png", fps=24.0, filename_prefix="bEpic",
             unique_id=None, prompt=None, extra_pnginfo=None):
        safe_label = tab_name.replace(" ", "_") if tab_name else "send"

        # Three source kinds feed the viewer tab:
        #   • a ComfyUI VIDEO object   → decoded to a playable file and shown as
        #     a <video> (always, even with the toggle off — it can't preview as
        #     temp PNGs); persisted to ./output when the toggle is on.
        #   • save-to-output on        → frames persisted in the chosen format
        #     (mp4/exr/tiff/...) and those files shown in the viewer.
        #   • otherwise                → the temp-PNG preview path used forever.
        # write_output/write_video_input return viewer frame dicts (saved files
        # for video and browser images, temp PNG proxies for exr/tiff/...).
        tab_frames = None
        saved_paths = []
        if file_writer is not None and file_writer.is_video_input(input):
            try:
                saved_paths, tab_frames = file_writer.write_video_input(
                    input, save_to_output, filename_prefix, file_format, fps,
                    prompt, extra_pnginfo)
            except Exception as e:
                print(f"\033[91m[bEpicSendToViewer] video input failed: {e}\033[0m")
                tab_frames = None
        elif save_to_output and file_writer is not None:
            try:
                saved_paths, tab_frames = file_writer.write_output(
                    input, filename_prefix, file_format, fps,
                    prompt, extra_pnginfo)
            except Exception as e:
                print(f"\033[91m[bEpicSendToViewer] save to output failed: {e}\033[0m")
                tab_frames = None
        if tab_frames is None:
            tab_frames = _temp_frames(input, safe_label, unique_id,
                                      self.output_dir, self.type)

        tabs = {"tab": tab_frames}

        PromptServer.instance.send_sync("bepic.viewer.update", {
            "tabs": tabs,
            "unique_id": unique_id
        })

        result = (input, )

        # When save_to_output persisted files to ./output, record them in
        # ComfyUI's prompt history (like SaveImage) so they appear in the
        # frontend's outputs/assets panel and are queryable by other nodes.
        ui_images = _history_images(saved_paths)
        if ui_images:
            return {"ui": {"images": ui_images}, "result": result}
        return result


class bEpicImageViewerRoto:
    """Roto matte drawn in the viewer.

    Shows its input in a viewer tab of its own, exactly as bEpicSendToViewer
    does, and hands back the matte the viewer's Roto tool drew over that tab.
    The input picture comes back out untouched alongside it, so the node can sit
    inline in a chain instead of hanging off a branch.

    `image` is second, behind `roto_mask`: slots are linked by index, so putting
    it first would silently re-wire every workflow already using this node.

    `roto_data` is written by the viewer, not by hand — the JS keeps the widget
    hidden. It stays a widget so the shapes serialize into the workflow and
    travel with it."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": (IO.ANY, ) if IO is not None else (("IMAGE", "MASK"),),
                "tab_name": ("STRING", {"default": ""}),
            },
            "optional": {
                "roto_data": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("MASK", _ANY)
    RETURN_NAMES = ("roto_mask", "image")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def run(self, image, tab_name="", roto_data="", unique_id=None):
        _push_tab(image, tab_name, unique_id, "bEpicImageViewerRoto")
        N, H, W = _dims_from_input(image)
        return (_roto_mask(roto_data, N, H, W), image)


class bEpicImageViewerSAM3Collector:
    """SAM3 point and box prompts placed in the viewer.

    Shows its input in a viewer tab of its own and hands back the prompts the
    viewer's SAM3 tools placed over that tab, shaped for ComfyUI-SAM3. All four
    outputs exist from the moment the node is created; an untouched one is
    simply an empty prompt, which SAM3 treats as "no hint of this kind".

    Like the Roto node it has no image output, and its four stores are written
    by the viewer through hidden widgets."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": (IO.ANY, ) if IO is not None else (("IMAGE", "MASK"),),
                "tab_name": ("STRING", {"default": ""}),
            },
            "optional": {
                "sam3_positive": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_negative": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_box_positive": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_box_negative": ("STRING", {"default": "[]", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("SAM3_POINTS_PROMPT", "SAM3_POINTS_PROMPT",
                    "SAM3_BOXES_PROMPT", "SAM3_BOXES_PROMPT")
    RETURN_NAMES = ("positive_points", "negative_points",
                    "positive_bboxes", "negative_bboxes")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def run(self, image, tab_name="", sam3_positive="[]", sam3_negative="[]",
            sam3_box_positive="[]", sam3_box_negative="[]", unique_id=None):
        _push_tab(image, tab_name, unique_id, "bEpicImageViewerSAM3Collector")
        return (
            _points_prompt(sam3_positive, 1),
            _points_prompt(sam3_negative, 0),
            _boxes_prompt(sam3_box_positive, True),
            _boxes_prompt(sam3_box_negative, False),
        )


# mapping dictionaries for external use (nodes.py imports these)

NODE_CLASS_MAPPINGS = {
    "bEpicSendToViewer": bEpicSendToViewer,
    "bEpicImageViewerRoto": bEpicImageViewerRoto,
    "bEpicImageViewerSAM3Collector": bEpicImageViewerSAM3Collector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "bEpicSendToViewer": "bEpic Send To Image Viewer",
    "bEpicImageViewerRoto": "bEpic Image Viewer Roto",
    "bEpicImageViewerSAM3Collector": "bEpic Image Viewer SAM3 Collector",
}
