import os
import json
import random
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
            "optional": {
                # Hidden (via JS) stores written by the in-viewer tools. Kept as
                # widgets so their values serialize into the workflow and reach
                # the backend on execute.
                "roto_data":     ("STRING", {"default": "", "multiline": False}),
                "sam3_positive": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_negative": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_box_positive": ("STRING", {"default": "[]", "multiline": False}),
                "sam3_box_negative": ("STRING", {"default": "[]", "multiline": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    # image passthrough + roto matte + SAM3 point prompts. The JS only reveals
    # the optional output slots once the corresponding viewer tool is used, but
    # the tuple returned here always matches this fixed order/length so ComfyUI
    # can map outputs by index.
    RETURN_TYPES = (_ANY, "MASK", "SAM3_POINTS_PROMPT", "SAM3_POINTS_PROMPT",
                    "SAM3_BOXES_PROMPT", "SAM3_BOXES_PROMPT")
    RETURN_NAMES = ("image", "roto_mask", "positive_points", "negative_points",
                    "positive_bboxes", "negative_bboxes")
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def send(self, input, tab_name="", save_to_output=False,
             file_format="png", fps=24.0, filename_prefix="bEpic",
             roto_data="", sam3_positive="[]", sam3_negative="[]",
             sam3_box_positive="[]", sam3_box_negative="[]",
             unique_id=None, prompt=None, extra_pnginfo=None):
        # ── 1. Save incoming tensors to temp PNGs and push to the viewer ──────
        def process_batch(inp, label):
            if inp is None:
                return []
            batch_results = []

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
                            safe_label = label if label else f"send"
                            filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}.png"
                            img.save(os.path.join(self.output_dir, filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, filename))
                            batch_results.append({"filename": filename, "subfolder": "", "type": self.type, "path": full})
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
                            safe_label = label if label else f"send"
                            mask_filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}_mask.png"
                            mask_img.save(os.path.join(self.output_dir, mask_filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, mask_filename))
                            batch_results.append({"filename": mask_filename, "subfolder": "", "type": "mask", "path": full})
                        except Exception:
                            continue
            except Exception:
                return []
            return batch_results

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
            tab_frames = process_batch(input, safe_label)

        tabs = {"tab": tab_frames}

        PromptServer.instance.send_sync("bepic.viewer.update", {
            "tabs": tabs,
            "unique_id": unique_id
        })

        # ── 2. Build the tool outputs ────────────────────────────────────────
        N, H, W = _dims_from_input(input)

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
        roto_mask = torch.from_numpy(np.ascontiguousarray(mask_np)).float()

        positive_points = _points_prompt(sam3_positive, 1)
        negative_points = _points_prompt(sam3_negative, 0)
        positive_bboxes = _boxes_prompt(sam3_box_positive, True)
        negative_bboxes = _boxes_prompt(sam3_box_negative, False)

        # ── 3. Passthrough + tool outputs ────────────────────────────────────
        result = (input, roto_mask, positive_points, negative_points,
                  positive_bboxes, negative_bboxes)

        # When save_to_output persisted files to ./output, record them in
        # ComfyUI's prompt history (like SaveImage) so they appear in the
        # frontend's outputs/assets panel and are queryable by other nodes.
        ui_images = _history_images(saved_paths)
        if ui_images:
            return {"ui": {"images": ui_images}, "result": result}
        return result


# mapping dictionaries for external use (nodes.py imports these)

NODE_CLASS_MAPPINGS = {
    "bEpicSendToViewer": bEpicSendToViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "bEpicSendToViewer": "bEpic Send To Image Viewer",
}
