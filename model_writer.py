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

Choosing a 3D format in the node's `file_format` converts on the way out
(`convert`): trimesh reads the input (a USD input through usd_io's GLB proxy)
and writes GLB, glTF (one file, buffers and textures embedded), OBJ (+ .mtl
and its textures beside it), PLY (texture baked to vertex colours), STL
(geometry only), or USD / USDA / USDC (meshes, normals, UVs, colours and a
UsdPreviewSurface with the base-colour texture). FBX has no writer here, so an
FBX stays an FBX and nothing converts to it. A conversion that fails saves the
input as it came instead of losing it.
"""

import hashlib
import io
import json
import os
import re

import folder_paths

# Formats the viewer can open in a 3D tab — Gaussian splats included (Spark
# draws them; a .ply is a splat when its header says so).
SPLAT_EXTS = {"spz", "splat", "ksplat", "sog"}
VIEWABLE_EXTS = {"glb", "gltf", "fbx", "obj", "stl", "ply",
                 "usd", "usda", "usdc", "usdz"} | SPLAT_EXTS


_USD_EXTS = ("usd", "usda", "usdc")
_TRIMESH_OUT = ("gltf", "obj", "ply", "stl")


def _has(module):
    try:
        __import__(module)
        return True
    except Exception:
        return False


def _model_formats():
    """The 3D formats the node can save to, in menu order: GLB always (core's
    writer, or the input's own bytes); the rest when trimesh (and pxr, for USD)
    are installed."""
    out = ["glb"]
    if _has("trimesh"):
        out += list(_TRIMESH_OUT)
        if _has("pxr"):
            out += list(_USD_EXTS)
    return out


# Computed once at import; nodes.py appends them to the file_format menu.
MODEL_FORMATS = _model_formats()


def is_model_format(file_format):
    return (file_format or "").lower().lstrip(".") in MODEL_FORMATS


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


def is_splat(x):
    """A gaussian splat still in memory (core's SPLAT: what TripoSplat, File3D
    to Splat and the splat transforms hand on)."""
    return (x is not None and not is_file3d(x) and hasattr(x, "positions") and hasattr(x, "scales")
            and hasattr(x, "rotations") and hasattr(x, "opacities") and hasattr(x, "sh"))


def splat_to_file3d(splat):
    """A SPLAT as a .ply File3D, written by core's own Create 3D File (from
    Splat) — the .ply keeps the full spherical harmonics."""
    from comfy_extras.nodes_gaussian_splat import SplatToFile3D
    out = SplatToFile3D.execute(splat, "ply")
    return out.result[0] if hasattr(out, "result") else out[0]


def is_splat_file(data, ext):
    """Whether a 3D file holds Gaussian splats: a splat format, or a .ply whose
    vertices carry a scale and a rotation (as the viewer decides it)."""
    ext = (ext or "").lower()
    if ext in SPLAT_EXTS:
        return True
    if ext != "ply" or not data:
        return False
    head = bytes(data[:65536])
    end = head.find(b"end_header")
    if not head.startswith(b"ply") or end < 0:
        return False
    props, in_vertex = set(), False
    for line in head[:end].decode("latin-1").splitlines():
        w = line.split()
        if w and w[0] == "element":
            in_vertex = len(w) > 1 and w[1] == "vertex"
        elif w and w[0] == "property" and in_vertex:
            props.add(w[-1])
    return {"scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"} <= props


def is_model_input(x):
    return is_mesh(x) or is_file3d(x) or is_splat(x)


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


# ── conversion ───────────────────────────────────────────────────────────────

def _load_scene(data, src_ext):
    """A trimesh Scene from a 3D file's bytes."""
    import trimesh
    if src_ext in _USD_EXTS:
        # usd_io flattens a stage into a GLB (its viewer proxy); read that.
        import tempfile
        from . import usd_io
        with tempfile.NamedTemporaryFile(suffix="." + src_ext, delete=False) as fh:
            fh.write(data)
            tmp = fh.name
        try:
            glb = usd_io.display_proxy(tmp)
            with open(glb, "rb") as fh:
                data, src_ext = fh.read(), "glb"
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
    if src_ext == "fbx":
        raise ValueError("FBX can't be read here (no FBX importer), so it isn't converted")
    return trimesh.load(io.BytesIO(data), file_type=src_ext, force="scene")


def _placed_meshes(scene):
    """[(name, Trimesh)] with every node's transform applied, meshes only."""
    import trimesh
    out = []
    for node in scene.graph.nodes_geometry:
        transform, geom_name = scene.graph[node]
        geom = scene.geometry.get(geom_name)
        if not isinstance(geom, trimesh.Trimesh) or len(geom.faces) == 0:
            continue
        mesh = geom.copy()
        mesh.apply_transform(transform)
        out.append((str(node), mesh))
    return out


def _base_color(mesh):
    """(PIL image or None, [r, g, b, a] factor or None) of a mesh's material."""
    vis = getattr(mesh, "visual", None)
    mat = getattr(vis, "material", None)
    if mat is None:
        return None, None
    image = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    factor = getattr(mat, "baseColorFactor", None)
    if factor is None and getattr(mat, "diffuse", None) is not None:
        factor = mat.diffuse
    if factor is not None:
        factor = [float(c) / (255.0 if max(factor) > 1 else 1.0) for c in list(factor)[:4]]
    return image, factor


def _write_usd(scene, path):
    """Meshes (points, triangles, normals, UVs, vertex colours) and a
    UsdPreviewSurface per mesh, base-colour textures as PNGs beside the stage."""
    from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, Vt
    stage = Usd.Stage.CreateNew(path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    root = UsdGeom.Xform.Define(stage, "/Model")
    stage.SetDefaultPrim(root.GetPrim())
    stem = os.path.splitext(os.path.basename(path))[0]
    tex_dir = os.path.join(os.path.dirname(path), f"{stem}_textures")
    written = [path]
    used = set()
    for i, (name, mesh) in enumerate(_placed_meshes(scene)):
        prim_name = re.sub(r"[^A-Za-z0-9_]", "_", name) or f"mesh_{i}"
        if prim_name[0].isdigit():
            prim_name = "m_" + prim_name
        while prim_name in used:
            prim_name += "_"
        used.add(prim_name)
        m = UsdGeom.Mesh.Define(stage, f"/Model/{prim_name}")
        m.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(mesh.vertices.astype("float32")))
        m.CreateFaceVertexCountsAttr(Vt.IntArray([3] * len(mesh.faces)))
        m.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(mesh.faces.astype("int32").ravel()))
        m.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        m.CreateNormalsAttr(Vt.Vec3fArray.FromNumpy(mesh.vertex_normals.astype("float32")))
        m.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
        pv = UsdGeom.PrimvarsAPI(m)
        vis = mesh.visual
        uv = getattr(vis, "uv", None)
        if uv is not None and len(uv) == len(mesh.vertices):
            pv.CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex) \
              .Set(Vt.Vec2fArray.FromNumpy(uv.astype("float32")))
        if getattr(vis, "kind", None) == "vertex":
            cols = vis.vertex_colors[:, :3].astype("float32") / 255.0
            pv.CreatePrimvar("displayColor", Sdf.ValueTypeNames.Color3fArray, UsdGeom.Tokens.vertex) \
              .Set(Vt.Vec3fArray.FromNumpy(cols))

        image, factor = _base_color(mesh)
        if image is None and factor is None:
            continue
        mat = UsdShade.Material.Define(stage, f"/Model/Looks/{prim_name}_mat")
        shader = UsdShade.Shader.Define(stage, f"/Model/Looks/{prim_name}_mat/Surface")
        shader.CreateIdAttr("UsdPreviewSurface")
        mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
        if factor is not None:
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*factor[:3]))
        if image is not None and uv is not None:
            os.makedirs(tex_dir, exist_ok=True)
            tex_path = os.path.join(tex_dir, f"{prim_name}_basecolor.png")
            image.save(tex_path)
            written.append(tex_path)
            reader = UsdShade.Shader.Define(stage, f"/Model/Looks/{prim_name}_mat/st")
            reader.CreateIdAttr("UsdPrimvarReader_float2")
            reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
            tex = UsdShade.Shader.Define(stage, f"/Model/Looks/{prim_name}_mat/baseColor")
            tex.CreateIdAttr("UsdUVTexture")
            tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(
                f"./{stem}_textures/{prim_name}_basecolor.png")
            tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(
                reader.ConnectableAPI(), "result")
            tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
            shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(
                tex.ConnectableAPI(), "rgb")
        UsdShade.MaterialBindingAPI.Apply(m.GetPrim()).Bind(mat)
    stage.GetRootLayer().Save()
    return written


def convert(data, src_ext, dst_ext, path):
    """Write the 3D file `data` (format `src_ext`) to `path` as `dst_ext`.
    Returns the files written, the model itself first (OBJ and USD bring their
    materials and textures along beside it)."""
    dst_ext = dst_ext.lower()
    scene = _load_scene(data, src_ext.lower())
    if dst_ext in _USD_EXTS:
        return _write_usd(scene, path)
    import trimesh
    if dst_ext == "glb":
        blob = scene.export(file_type="glb")
    elif dst_ext == "gltf":
        # One self-contained file: buffers and textures embedded as data URIs.
        files = trimesh.exchange.gltf.export_gltf(scene, embed_buffers=True)
        blob = files.get("model.gltf") or next(iter(files.values()))
    elif dst_ext == "obj":
        stem = os.path.splitext(os.path.basename(path))[0]
        text, extras = trimesh.exchange.obj.export_obj(
            scene, include_texture=True, return_texture=True, mtl_name=f"{stem}.mtl")
        written = [path]
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        # trimesh names the textures material_0.png …; in a shared output
        # folder the next OBJ would overwrite them. They take the model's name,
        # and the .mtl is pointed at the new names.
        extras = dict(extras or {})
        mtl_name = f"{stem}.mtl"
        renames = {n: f"{stem}_{n}" for n in extras if n != mtl_name}
        if mtl_name in extras and renames:
            mtl = extras[mtl_name].decode("utf-8", "replace")
            for old, new in renames.items():
                mtl = re.sub(rf"(?<![\w.-]){re.escape(old)}(?![\w.-])", new, mtl)
            extras[mtl_name] = mtl.encode("utf-8")
        for fname, blob in extras.items():
            extra = os.path.join(os.path.dirname(path), renames.get(fname, fname))
            with open(extra, "wb") as fh:
                fh.write(blob)
            written.append(extra)
        return written
    elif dst_ext in ("ply", "stl"):
        meshes = [m for _n, m in _placed_meshes(scene)]
        if not meshes:
            raise ValueError("no mesh geometry to write")
        if dst_ext == "ply":
            # PLY has no texture: keep the look as vertex colours.
            for m in meshes:
                if getattr(m.visual, "kind", None) == "texture":
                    try:
                        m.visual = m.visual.to_color()
                    except Exception:
                        pass
        mesh = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
        blob = mesh.export(file_type=dst_ext)
    else:
        raise ValueError(f"no writer for .{dst_ext}")
    with open(path, "wb") as fh:
        fh.write(blob if isinstance(blob, (bytes, bytearray)) else blob.encode("utf-8"))
    return [path]


def _source_items(inp, metadata):
    """[(bytes, ext)] — the input as the file(s) it is, before any conversion."""
    if is_file3d(inp):
        return [(inp.get_bytes(), _file3d_item(inp))]
    return _mesh_items(inp, metadata)


def save_model_input(inp, filename_prefix, prompt=None, extra_pnginfo=None, file_format=None):
    """Write `inp` to ./output the way SaveGLB does — as `file_format` when that
    is a 3D format (converted when it isn't already), else as it came.

    Returns (saved_paths, ui_results, frames): ui_results is SaveGLB's
    `ui["3d"]` list, frames are viewer frame dicts for the saved models (the
    materials and textures an OBJ or USD brings along are in saved_paths only).
    """
    if is_splat(inp):
        inp = splat_to_file3d(inp)
    out_root = folder_paths.get_output_directory()
    folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        filename_prefix, out_root)
    os.makedirs(folder, exist_ok=True)
    want = (file_format or "").lower().lstrip(".")
    want = want if want in MODEL_FORMATS else None
    if want and is_file3d(inp):
        ext = _file3d_item(inp)
        head = inp.get_bytes()[:65536] if ext == "ply" else b""
        if is_splat_file(head, ext):
            # A mesh format would keep the points and lose the splats.
            print(f"\033[93m[bEpicSendToViewer] a gaussian splat can't be saved as .{want}; "
                  f"saving the .{ext} it came as\033[0m")
            want = None

    saved, results, frames = [], [], []
    if is_file3d(inp) and want is None:
        # As it came, straight from its own file: no read into memory.
        ext = _file3d_item(inp)
        name = f"{filename}_{counter:05}_.{ext}"
        full = os.path.join(folder, name)
        inp.save_to(full)
        saved.append(full)
        results.append({"filename": name, "subfolder": subfolder, "type": "output"})
        frames.append(model_frame(full, ext))
        return saved, results, frames

    for data, ext in _source_items(inp, _metadata(prompt, extra_pnginfo)):
        target = want or ext
        name = f"{filename}_{counter:05}_.{target}"
        full = os.path.join(folder, name)
        written = None
        if target != ext:
            try:
                written = convert(data, ext, target, full)
            except Exception as e:
                print(f"\033[93m[bEpicSendToViewer] could not save as .{target} ({e}); "
                      f"saving the .{ext} it came as instead\033[0m")
                target = ext
                name = f"{filename}_{counter:05}_.{ext}"
                full = os.path.join(folder, name)
        if written is None:
            with open(full, "wb") as fh:
                fh.write(data)
            written = [full]
        saved.extend(written)
        results.append({"filename": name, "subfolder": subfolder, "type": "output"})
        frames.append(model_frame(full, target))
        counter += 1
    return saved, results, frames


def preview_model_input(inp, out_dir, prefix, run_tag):
    """Write `inp` to the temp folder for viewing only. File names follow the
    run-token scheme in nodes.py (`<prefix><run_tag>_<index>.<ext>`), so the
    temp GC collects them with the rest of the node's runs."""
    os.makedirs(out_dir, exist_ok=True)
    frames = []
    if is_splat(inp):
        inp = splat_to_file3d(inp)
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
