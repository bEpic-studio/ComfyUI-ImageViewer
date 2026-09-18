"""Previz: scene files and rendered shots for the viewer's 3D scenes.

The scene itself is browser-side data (js/bEpicViewer_scene3d.js) kept on the
bEpic 3D Scene node. This module only deals with what has to live on disk:

  • scene files, under `output/3d_scenes/<name>.json`, for reusing a setup
    across workflows;
  • rendered frames, under `output/previz/<name>/frame_0000.png`, written one
    at a time by the viewer as it plays the shot back through a camera. The
    node then reads that folder as its IMAGE output.

Both folders sit inside ComfyUI's output directory on purpose: nothing here
writes anywhere the viewer's other routes wouldn't (see path_access.py).
"""

import json
import os
import re

import folder_paths

SCENES_DIRNAME = "3d_scenes"
RENDERS_DIRNAME = "previz"
FRAME_RE = re.compile(r"^frame_(\d+)\.png$")


def _safe_name(name, fallback="scene"):
    """A file/folder name from user text: no separators, no surprises."""
    out = "".join(c for c in str(name or "") if c.isalnum() or c in "-_ ").strip()
    out = out.replace(" ", "_")
    return out[:64] or fallback


def scenes_dir(create=False):
    path = os.path.join(folder_paths.get_output_directory(), SCENES_DIRNAME)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def renders_dir(name=None, create=False):
    path = os.path.join(folder_paths.get_output_directory(), RENDERS_DIRNAME)
    if name:
        path = os.path.join(path, _safe_name(name))
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def scene_path(name):
    return os.path.join(scenes_dir(), f"{_safe_name(name)}.json")


def list_scenes():
    try:
        names = os.listdir(scenes_dir())
    except OSError:
        return []
    out = []
    for n in sorted(names):
        if not n.lower().endswith(".json"):
            continue
        full = os.path.join(scenes_dir(), n)
        try:
            st = os.stat(full)
        except OSError:
            continue
        out.append({"name": n[:-5], "path": full, "mtime": st.st_mtime, "size": st.st_size})
    return out


def save_scene(name, scene):
    """Write a scene as JSON. `scene` is already-parsed data, not a string."""
    os.makedirs(scenes_dir(), exist_ok=True)
    path = scene_path(name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(scene, fh, indent=1)
    return path


def load_scene(name):
    with open(scene_path(name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def frame_path(name, index):
    return os.path.join(renders_dir(name), f"frame_{int(index):04d}.png")


def clear_render(name):
    """Drop the frames of a previous take, so a shorter one can't leave a tail
    of stale frames behind it. Only ever removes `frame_####.png`."""
    folder = renders_dir(name)
    removed = 0
    try:
        names = os.listdir(folder)
    except OSError:
        return 0
    for n in names:
        if not FRAME_RE.match(n):
            continue
        try:
            os.remove(os.path.join(folder, n))
            removed += 1
        except OSError:
            continue
    return removed


def render_frames(name):
    """The rendered frames of `name`, in order."""
    folder = renders_dir(name)
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    numbered = []
    for n in names:
        m = FRAME_RE.match(n)
        if m:
            numbered.append((int(m.group(1)), os.path.join(folder, n)))
    numbered.sort()
    return [p for _i, p in numbered]


def load_render(name):
    """The rendered shot as an IMAGE tensor [N,H,W,3], or None when there is
    nothing rendered yet. Frames of differing sizes are refused rather than
    silently cropped — that only happens if the folder was rendered twice at
    different resolutions."""
    paths = render_frames(name)
    if not paths:
        return None
    import numpy as np
    import torch
    from PIL import Image

    frames = []
    size = None
    for p in paths:
        with Image.open(p) as im:
            im = im.convert("RGB")
            if size is None:
                size = im.size
            elif im.size != size:
                raise ValueError(
                    f"the rendered frames in {os.path.basename(os.path.dirname(p))} are not all "
                    f"{size[0]}x{size[1]} — render the shot again to replace them")
            frames.append(np.asarray(im, dtype=np.float32) / 255.0)
    return torch.from_numpy(np.stack(frames))
