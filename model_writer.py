"""3D inputs for bEpicSendToViewer: ComfyUI MESH and File3D objects.

Mirrors what core's "Save 3D Model" (SaveGLB, comfy_extras/nodes_save_3d.py)
does with the same inputs:

  • a MESH batch is written one .glb per item, through core's own GLB writer so
    UVs, colours, normals, textures and material overrides all survive;
  • a File3D (from a 3D API node, Load 3D, Create 3D File, ...) is written as
    the file it already is — an FBX stays an FBX. Nothing here converts
    between formats; ComfyUI has no FBX writer.

Saved files take SaveGLB's naming: `<prefix>_<counter:05>_.<ext>` under
ComfyUI's output folder. Previews that aren't saved go to the temp folder.
"""

import hashlib
import json
import os

import folder_paths

# Formats the viewer can open in a 3D tab. Splats and USDZ can be saved but not
# shown; they still land in ./output when saving is on.
VIEWABLE_EXTS = {"glb", "gltf", "fbx", "obj", "stl", "ply"}


def _core_save3d():
    """core's nodes_save_3d module, or None on a ComfyUI that predates it."""
    try:
        from comfy_extras import nodes_save_3d
        return nodes_save_3d
    except Exception:
        return None


def is_mesh(x):
    # Duck-typed so an older/newer comfy_api doesn't break the import.
    return (x is not None and hasattr(x, "vertices") and hasattr(x, "faces")
            and hasattr(x, "vertex_counts"))


def is_file3d(x):
    return (x is not None and hasattr(x, "save_to") and hasattr(x, "get_bytes")
            and hasattr(x, "format"))


def is_model_input(x):
    return is_mesh(x) or is_file3d(x)


def sniff_format(head):
    """Best guess at a 3D file's format from its first bytes."""
    if head[:4] == b"glTF":
        return "glb"
    if head[:18] == b"Kaydara FBX Binary":
        return "fbx"
    if head[:3] == b"ply":
        return "ply"
    text = head.lstrip()[:64].lower()
    if text.startswith(b"{") and b"asset" in head.lower():
        return "gltf"
    if text.startswith(b"; fbx"):
        return "fbx"
    if text.startswith(b"solid"):
        return "stl"
    return ""


def _metadata(prompt, extra_pnginfo):
    try:
        from comfy.cli_args import args
        if args.disable_metadata:
            return None
    except Exception:
        pass
    meta = {}
    if prompt is not None:
        meta["prompt"] = json.dumps(prompt)
    if extra_pnginfo is not None:
        for key in extra_pnginfo:
            meta[key] = json.dumps(extra_pnginfo[key])
    return meta or None


def _mesh_items(mesh, metadata):
    """[(glb bytes, "glb")] for each non-empty item of a MESH batch."""
    core = _core_save3d()
    if core is None:
        raise RuntimeError("this ComfyUI has no GLB writer (comfy_extras.nodes_save_3d)")
    out = []
    for i in range(int(mesh.vertices.shape[0])):
        glb = core.mesh_item_to_glb_bytes(mesh, i, metadata)
        if glb is None:
            print(f"[bEpicSendToViewer] skipping empty mesh at batch index {i}")
            continue
        out.append((glb, "glb"))
    return out


def _file3d_item(file3d):
    ext = (file3d.format or "").lower()
    if not ext or ext not in VIEWABLE_EXTS | {"usdz", "splat", "spz", "ksplat"}:
        try:
            data = file3d.get_bytes()
            ext = sniff_format(data[:256]) or ext or "glb"
        except Exception:
            ext = ext or "glb"
    return ext


def model_frame(path, ext=None):
    ext = (ext or os.path.splitext(path)[1].lstrip(".")).lower()
    return {
        "kind": "model",
        "format": ext,
        "path": os.path.abspath(path),
        "name": os.path.basename(path),
    }


def save_model_input(inp, filename_prefix, prompt=None, extra_pnginfo=None):
    """Write `inp` to ./output the way SaveGLB does.

    Returns (saved_paths, ui_results, frames): ui_results is SaveGLB's
    `ui["3d"]` list, frames are viewer frame dicts for the saved files.
    """
    out_root = folder_paths.get_output_directory()
    folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        filename_prefix, out_root)
    os.makedirs(folder, exist_ok=True)

    saved, results, frames = [], [], []
    if is_file3d(inp):
        ext = _file3d_item(inp)
        name = f"{filename}_{counter:05}_.{ext}"
        full = os.path.join(folder, name)
        inp.save_to(full)
        saved.append(full)
        results.append({"filename": name, "subfolder": subfolder, "type": "output"})
        frames.append(model_frame(full, ext))
    else:
        for data, ext in _mesh_items(inp, _metadata(prompt, extra_pnginfo)):
            name = f"{filename}_{counter:05}_.{ext}"
            full = os.path.join(folder, name)
            with open(full, "wb") as fh:
                fh.write(data)
            saved.append(full)
            results.append({"filename": name, "subfolder": subfolder, "type": "output"})
            frames.append(model_frame(full, ext))
            counter += 1
    return saved, results, frames


def preview_model_input(inp, out_dir, prefix, run_tag):
    """Write `inp` to the temp folder for viewing only. File names follow the
    run-token scheme in nodes.py (`<prefix><run_tag>_<index>.<ext>`), so the
    temp GC collects them with the rest of the node's runs."""
    os.makedirs(out_dir, exist_ok=True)
    frames = []
    if is_file3d(inp):
        ext = _file3d_item(inp)
        full = os.path.join(out_dir, f"{prefix}{run_tag}_0000.{ext}")
        if getattr(inp, "is_disk_backed", False):
            # Already a file somewhere: copy it rather than read it into memory.
            inp.save_to(full)
        else:
            with open(full, "wb") as fh:
                fh.write(inp.get_bytes())
        frames.append(model_frame(full, ext))
        return frames
    for i, (data, ext) in enumerate(_mesh_items(inp, None)):
        full = os.path.join(out_dir, f"{prefix}{run_tag}_{i:04d}.{ext}")
        with open(full, "wb") as fh:
            fh.write(data)
        frames.append(model_frame(full, ext))
    return frames


def thumb_cache_path(path):
    """Where the browser-rendered thumbnail of a model file is kept."""
    tmp = folder_paths.get_temp_directory()
    digest = hashlib.sha1(os.path.normcase(os.path.abspath(path))
                          .encode("utf-8", "replace")).hexdigest()[:16]
    stem = "".join(c for c in os.path.splitext(os.path.basename(path))[0]
                   if c.isalnum() or c in "-_")[:40] or "model"
    return os.path.join(tmp, f"bEpic_mthumb_{stem}_{digest}.png")


def cached_thumb(path):
    """The model's thumbnail if one is on disk and newer than the model."""
    dst = thumb_cache_path(path)
    try:
        if os.path.getmtime(dst) >= os.path.getmtime(path):
            return dst
    except OSError:
        pass
    return None
