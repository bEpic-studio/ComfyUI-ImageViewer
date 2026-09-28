import io
import os
import re
import base64
import sys
import traceback
import folder_paths
from server import PromptServer

from . import path_access

try:
    from . import media_resolve
except Exception:  # pragma: no cover - viewer still works without the resolver
    media_resolve = None

try:
    from . import model_writer
except Exception:  # pragma: no cover
    model_writer = None

try:
    from . import previz
except Exception:  # pragma: no cover
    previz = None

try:
    from . import abc_io
except Exception:  # pragma: no cover
    abc_io = None

try:
    from . import usd_io
except Exception:  # pragma: no cover
    usd_io = None

_MODEL_EXTS = {".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply",
               ".usd", ".usda", ".usdc", ".usdz", ".abc"}

# three.js and its loaders, for the viewer's 3D tabs. Outside js/ so ComfyUI
# doesn't import them at startup; served by /bepic/lib/three/<name> instead.
_THREE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "three")

# Stands in for a model's history tile until the browser has rendered one.
_MODEL_PLACEHOLDER_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" fill="#2a2a2a"/>'
    '<g fill="none" stroke="#9a9a9a" stroke-width="2" stroke-linejoin="round">'
    '<path d="M32 12 50 22v20L32 52 14 42V22z"/><path d="M14 22l18 10 18-10M32 32v20"/>'
    '</g></svg>')


def _decode_image_upload(dataurl, force_png=False):
    """(bytes, ext) to write for an uploaded data: URL.

    The upload is decoded and re-encoded rather than written as it came. That is
    the check: whatever lands on disk is an image PIL could read, with nothing
    riding along after the pixels. Raises ValueError with a message for the
    client.
    """
    m = re.match(r"^data:image/(png|jpeg);base64,(.*)$", dataurl or "", re.DOTALL)
    if not m:
        raise ValueError("expected a data:image/png or data:image/jpeg payload")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except Exception as e:
        raise ValueError(f"base64 decode failed: {e}")

    from PIL import Image
    try:
        with Image.open(io.BytesIO(raw)) as im:
            fmt = im.format
            if fmt not in ("PNG", "JPEG"):
                raise ValueError(f"expected a PNG or JPEG image, got {fmt or 'something else'}")
            im.load()
            if force_png:
                fmt = "PNG"
            if fmt == "JPEG" and im.mode not in ("RGB", "L", "CMYK"):
                im = im.convert("RGB")
            buf = io.BytesIO()
            if fmt == "PNG":
                im.save(buf, format="PNG", compress_level=4)
            else:
                im.save(buf, format="JPEG", quality=95)
    except ValueError:
        raise
    except Exception as e:              # a truncated file, a decompression bomb, ...
        raise ValueError(f"not a readable image: {e}")
    return buf.getvalue(), ("png" if fmt == "PNG" else "jpg")


def _usd_display_path(path, prim=None, frame=0):
    """The GLB standing in for a USD stage or an Alembic cache — or the path
    itself, when it is neither.

    The viewport speaks glTF; a stage or a cache is flattened once and reused.
    An Alembic cache is flattened at one sample, so `frame` picks which: a
    cache is geometry per frame, not a rig the viewport could play by itself.
    Failing to build it is reported to the log and the original path is
    returned, so the client gets a plain "can't read this" rather than a
    broken response.
    """
    try:
        if abc_io is not None and abc_io.is_abc(path):
            return abc_io.display_proxy(path, sample=frame, obj_path=prim) or path
        if usd_io is not None and usd_io.is_usd(path):
            return usd_io.display_proxy(path, prim) or path
    except Exception as e:
        print(f"[bEpicViewer] could not build a preview of {os.path.basename(path)}: {e}")
    return path


def _frame_arg(request):
    """The `frame` query, for a format that holds one picture per frame."""
    try:
        return max(0, int(request.query.get("frame") or 0))
    except (TypeError, ValueError):
        return 0


def _file_response(path, prim=None, frame=0):
    """Serve an image/video file, swapping in a browser-renderable PNG proxy for
    formats an <img> can't decode (exr / tiff / dpx / ...).

    `no-cache` lets the browser keep the bytes but forces it to revalidate before
    reusing them, so an overwritten file is picked up immediately (via the ETag
    aiohttp already sends) while unchanged frames cost a 304 instead of a full
    re-download. That is what lets the viewer drop the per-request cache-buster
    it used to append, which was defeating its own frame-caching.
    """
    path = _usd_display_path(path, prim, frame)
    if media_resolve is not None:
        try:
            proxy = media_resolve.proxy_for_display(path)
            if proxy:
                path = proxy
        except Exception as e:
            print(f"[bEpicViewer] display proxy failed for {path}: {e}")
    from aiohttp import web
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


def _resolve_raw_path(path):
    """Resolve a /bepic/raw_view path and say whether it may be served.

    Returns (abs_path, allowed). Split out of the route so /bepic/probe_paths can
    answer the same question without having to provoke the 403/404 it would
    otherwise take to find out.
    """
    try:
        temp_base = folder_paths.get_temp_directory()
    except Exception:
        temp_base = None
    try:
        out_base = folder_paths.get_output_directory()
    except Exception:
        out_base = None

    cand = path
    if not os.path.isabs(cand):
        if temp_base:
            cand = os.path.abspath(os.path.join(temp_base, cand))
        elif out_base:
            cand = os.path.abspath(os.path.join(out_base, cand))
        else:
            cand = os.path.abspath(path)
    else:
        cand = os.path.abspath(cand)

    norm_cand = os.path.normcase(cand)
    for base in (temp_base, out_base):
        if not base:
            continue
        norm_base = os.path.normcase(os.path.abspath(base))
        try:
            if os.path.commonpath([norm_base, norm_cand]).startswith(norm_base):
                return cand, True
        except Exception:
            # commonpath raises across drives / on malformed input; fall back to a
            # plain prefix test rather than treating the path as denied outright.
            if norm_cand.startswith(norm_base):
                return cand, True
    return cand, False

def _resolve_comfy_ref(filename, type_name, subfolder):
    """Absolute path for ComfyUI's own {filename, type, subfolder} addressing.

    The same triple /view takes, resolved against the same roots, so a thumbnail
    can be asked for by the only name a node run gives its outputs. Confined to
    those roots on purpose: unlike a user-picked path, this triple arrives from
    the page, so it is checked rather than trusted. Returns None when it does not
    land inside the root it named.
    """
    name = (filename or "").strip()
    if not name:
        return None
    try:
        base = folder_paths.get_directory_by_type(type_name or "output")
    except Exception:
        base = None
    if not base:
        return None
    base = os.path.abspath(base)
    cand = os.path.abspath(os.path.join(base, (subfolder or "").strip(), name))
    # Containment check, not a string prefix: "..\..\secrets" normalises away
    # here, and a sibling directory whose name merely starts with the root's does
    # not pass.
    try:
        inside = os.path.commonpath([os.path.normcase(base),
                                     os.path.normcase(cand)])
        if inside != os.path.normcase(base):
            return None
    except Exception:
        return None
    return cand


# One directory listing is meant to be read, not scrolled forever; a frame
# request costs a probe per video, so it is capped harder.
_BROWSE_FILE_CAP = 3000
_BROWSE_FRAME_CAP = 500


def _browse_exts():
    """(images, videos) the browser will list, from the resolver when present."""
    if media_resolve is not None:
        return media_resolve.IMAGE_EXTS, media_resolve.VIDEO_EXTS
    return ({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".ico",
             ".svg", ".tif", ".tiff", ".exr", ".dpx", ".tga", ".hdr"},
            {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".avi", ".mpg",
             ".mpeg", ".wmv", ".flv"})


def _browse_sort_key(name):
    """frame_2.png before frame_10.png, as everywhere else in the viewer."""
    if media_resolve is not None:
        try:
            return media_resolve._natural_key(name)
        except Exception:
            pass
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r"(\d+)", name)]


def _browse_default_dir():
    """Where the browser opens: ComfyUI's input directory."""
    try:
        d = folder_paths.get_input_directory()
        if d and os.path.isdir(d):
            return d
    except Exception:
        pass
    for _, path, _ in path_access.roots():
        if os.path.isdir(path):
            return path
    return os.path.abspath(os.getcwd())


def _browse_parent(path):
    """The directory above `path`, or None at a filesystem root or at the edge
    of the folders the viewer may open."""
    parent = os.path.dirname(os.path.abspath(path))
    if not parent or parent == path or not path_access.is_allowed(parent):
        return None
    return parent


def _browse_roots():
    """Shortcut destinations for the browser's jump menu: exactly the folders it
    may open."""
    return [{"label": label, "path": path}
            for label, path, _ in path_access.roots() if os.path.isdir(path)]


try:
    from aiohttp import web

    def register_routes():
        ps = PromptServer.instance
        if not ps or not getattr(ps, "app", None):
            raise RuntimeError("PromptServer.instance.app is not ready yet")
        router = ps.app.router

        def _safe_add(method, path, handler):
            try:
                router.add_route(method, path, handler)
            except Exception as e:
                print(f"[bEpicViewer] route register failed {method} {path}: {e}")

        async def _bepic_raw_view(request):
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' or 'filename' parameter")

            cand, allowed = _resolve_raw_path(path)

            # Both refusals are answered silently. The viewer's history outlives
            # the files it names — a cleaned temp dir, an output root belonging to
            # another machine — and printing here put one line in the ComfyUI log
            # per dead entry per redraw of the history strip. The client asks
            # /bepic/probe_paths instead and drops those entries from the panel.
            if not allowed:
                return web.Response(status=403, text="access denied")

            if not os.path.exists(cand):
                return web.Response(status=404, text="file not found")

            return _file_response(cand)

        async def _bepic_probe_paths(request):
            """Report which of the given paths this server can no longer serve.

            Body: {"paths": [{"path": ..., "external": bool}, ...]}; a bare string
            is treated as a non-external path. Answers with one entry per
            unreachable path and why, so the history panel can prune the snapshots
            pointing at them without guessing from a failed image load.
            """
            try:
                data = await request.json()
            except Exception:
                data = {}
            entries = data.get("paths") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                entries = []

            unreachable = []
            for item in entries:
                if isinstance(item, dict):
                    p = item.get("path")
                    external = bool(item.get("external"))
                else:
                    p = item
                    external = False
                if not p or not isinstance(p, str):
                    continue
                # External frames come from the file browser, a loader node or
                # drag-drop and are served by /bepic/view_file. One outside the
                # allowed folders is left out of the answer entirely: reporting it
                # would get it pruned from history before the user has had a
                # chance to allow its folder, and answering "gone" or not for it
                # would tell any caller which files exist.
                if external:
                    if not path_access.is_allowed(p):
                        continue
                    if not os.path.isfile(os.path.abspath(p)):
                        unreachable.append({"path": p, "reason": "gone"})
                    continue
                cand, allowed = _resolve_raw_path(p)
                if not allowed:
                    unreachable.append({"path": p, "reason": "denied"})
                elif not os.path.isfile(cand):
                    unreachable.append({"path": p, "reason": "gone"})

            return web.json_response({"unreachable": unreachable})

        def _browse_matcher(pattern):
            """A name test from what the user typed in the filter box.

            Globs if it looks like one — `*.exr`, `frame_??.png`, `{png,jpg}`
            are all fnmatch — and a plain substring otherwise, because typing
            "hero" and being told a folder is empty is not what anyone means by
            a filter. Several patterns can be separated by spaces, commas or
            semicolons, and a match on any of them is a match.
            """
            import fnmatch

            parts = [p for p in re.split(r"[\s,;]+", (pattern or "").strip()) if p]
            if not parts:
                return None
            tests = []
            for part in parts:
                low = part.lower()
                if any(ch in low for ch in "*?["):
                    tests.append(lambda name, pat=low: fnmatch.fnmatch(name, pat))
                else:
                    tests.append(lambda name, needle=low: needle in name)
            return lambda name: any(test(name.lower()) for test in tests)

        async def _bepic_browse(request):
            """List one directory for the viewer's file browser panel.

            No path → ComfyUI's input directory, which is where the browser opens.

            Confined to the allowed folders (path_access). Everything inside
            them is listed — a folder with a .json beside its .png is a folder
            with a .json in it, and a browser that hides half of what is there
            is a browser you cannot trust. Each file says what kind it is, and
            "other" is the viewer's way of saying it has nothing to show for
            it: no preview, nothing to open, nothing to drag onto the graph.
            """
            raw = (request.query.get("path") or "").strip()
            if not raw:
                raw = _browse_default_dir()
            path = os.path.abspath(os.path.expanduser(raw))

            # Before any look at the disk, so a refusal says nothing about
            # whether the folder exists.
            if not path_access.is_allowed(path):
                return web.json_response({
                    "path": path, "parent": None, "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False,
                    "error": path_access.refusal(path),
                }, status=403)

            if not os.path.isdir(path):
                return web.json_response({
                    "path": path, "parent": None, "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False,
                    "error": "not a directory",
                }, status=404)

            image_exts, video_exts = _browse_exts()
            # Filtering happens HERE, not in the page: the listing is capped, so
            # a filter applied afterwards would search the first few hundred
            # names of a big folder rather than the folder.
            matches = _browse_matcher(request.query.get("filter"))
            kinds = {k for k in (request.query.get("kinds") or "").split(",") if k}
            dirs, files, truncated = [], [], False
            try:
                names = os.listdir(path)
            except Exception as e:
                return web.json_response({
                    "path": path, "parent": _browse_parent(path), "roots": _browse_roots(),
                    "dirs": [], "files": [], "truncated": False, "error": str(e),
                }, status=403)

            for name in sorted(names, key=_browse_sort_key):
                full = os.path.join(path, name)
                try:
                    is_dir = os.path.isdir(full)
                except OSError:
                    continue                      # a dead junction / permission wall
                if is_dir:
                    dirs.append({"name": name, "path": full})
                    continue
                ext = os.path.splitext(name)[1].lower()
                if ext in image_exts:
                    kind = "image"
                elif ext in video_exts:
                    kind = "video"
                elif ext in _MODEL_EXTS:
                    kind = "model"
                else:
                    kind = "other"
                if kinds and kind not in kinds:
                    continue
                if matches and not matches(name):
                    continue
                if len(files) >= _BROWSE_FILE_CAP:
                    truncated = True
                    continue
                try:
                    st = os.stat(full)
                    size, mtime = st.st_size, st.st_mtime
                except OSError:
                    size, mtime = 0, 0
                files.append({"name": name, "path": full, "kind": kind,
                              "ext": ext, "size": size, "mtime": mtime})

            return web.json_response({
                "path": path,
                "parent": _browse_parent(path),
                "roots": _browse_roots(),
                "dirs": dirs,
                "files": files,
                "truncated": truncated,
                # So the page can say "nothing matches" rather than "empty".
                "filtered": bool(matches or kinds),
            })

        async def _bepic_browse_frames(request):
            """Turn browsed paths into viewer frames.

            Body: {"paths": [abs path, ...]}. Answers with one frame dict per
            readable file — the same shape the resolver hands the viewer for a
            loader node, so a video arrives with its fps, frame count and a
            cached poster instead of the viewer having to guess at them.

            Kept apart from the listing above because this is the expensive half:
            every video costs a probe and a poster decode, and a folder of them
            would stall the panel that is only trying to draw a list of names.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = {}
            paths = data.get("paths") if isinstance(data, dict) else None
            if not isinstance(paths, list):
                paths = []

            image_exts, video_exts = _browse_exts()
            frames, missing = [], []
            for raw in paths[:_BROWSE_FRAME_CAP]:
                if not raw or not isinstance(raw, str):
                    continue
                p = os.path.abspath(raw)
                if not path_access.is_allowed(p) or not os.path.isfile(p):
                    missing.append(raw)
                    continue
                ext = os.path.splitext(p)[1].lower()
                try:
                    if ext in _MODEL_EXTS:
                        frames.append(media_resolve._model_frame(p))
                    elif ext in video_exts:
                        frames.append(media_resolve._video_frame(p))
                    elif ext in image_exts:
                        frames.append(media_resolve._image_frame(p))
                except Exception as e:
                    print(f"[bEpicViewer] browse_frames failed for {p}: {e}")
                    missing.append(raw)

            return web.json_response({"frames": frames, "missing": missing})

        async def _bepic_view_file(request):
            """Serve a file by absolute path, from inside the allowed folders."""
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' parameter")
            path = os.path.abspath(path)
            if not path_access.is_allowed(path):
                return web.Response(status=403, text=path_access.refusal(path))
            if not os.path.isfile(path):
                return web.Response(status=404, text="file not found")
            # `raw` is the file itself, never a browser-friendly stand-in: a
            # world's HDR sky is read by three's HDR/EXR loaders, and a PNG
            # proxy would throw away exactly the range it is there for.
            if params.get("raw"):
                return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
            # `prim` narrows a USD stage (or an Alembic cache) to one subtree —
            # how a layout arrives as separate items the viewer can place; a
            # cache also takes `frame`, since it holds geometry per frame.
            return _file_response(path, params.get("prim"), _frame_arg(request))

        async def _bepic_thumb(request):
            """Serve a small cached stand-in for an image, for the thumbnail strips.

            Falls back to the original file whenever a thumbnail cannot be made —
            already small enough, a vector, no decoder — so the client never has to
            know which happened and a tile always shows a picture.

            Reach is deliberately the same as /bepic/view_file — the allowed
            folders: this hands back a SHRUNK version of bytes that endpoint would
            give in full, so it widens nothing.
            """
            params = dict(request.query)
            path = params.get('path')
            if not path:
                # A node run hands the viewer {filename, subfolder, type} and no
                # path at all — that is how ComfyUI's own /view addresses a file,
                # and it is the SHAPE THE HISTORY STRIP ACTUALLY USES. Resolving it
                # here is what makes this endpoint reachable for generated images
                # rather than only for files opened by path.
                path = _resolve_comfy_ref(params.get('filename'),
                                          params.get('type'),
                                          params.get('subfolder'))
                if path is None:
                    return web.Response(status=400,
                                        text="missing 'path', or an unresolvable filename")
            path = os.path.abspath(path)
            if not path_access.is_allowed(path):
                return web.Response(status=403, text=path_access.refusal(path))
            if not os.path.isfile(path):
                return web.Response(status=404, text="file not found")

            if os.path.splitext(path)[1].lower() in _MODEL_EXTS:
                # A model's tile is rendered by the browser (/bepic/model_thumb);
                # until then, a generic cube. Neither may be cached for long:
                # the real one replaces the placeholder under the same URL.
                thumb = model_writer.cached_thumb(path) if model_writer else None
                if thumb:
                    return web.FileResponse(thumb, headers={"Cache-Control": "no-cache"})
                return web.Response(text=_MODEL_PLACEHOLDER_SVG, content_type="image/svg+xml",
                                    headers={"Cache-Control": "no-store"})

            if media_resolve is not None:
                try:
                    size = params.get('max')
                    thumb = (media_resolve.thumb_for(path, size) if size
                             else media_resolve.thumb_for(path))
                    if thumb and os.path.isfile(thumb):
                        # Cache hard: a thumbnail is keyed on the source's mtime, so
                        # a changed source lands on a different cache entry rather
                        # than needing this one revalidated.
                        return web.FileResponse(
                            thumb, headers={"Cache-Control": "public, max-age=31536000"})
                except Exception as e:
                    print(f"[bEpicViewer] thumb failed for {path}: {e}")
            return _file_response(path)

        async def _bepic_clear_cache(request):
            try:
                temp_base = folder_paths.get_temp_directory()
            except Exception:
                temp_base = None
            deleted = 0
            if not temp_base:
                return web.json_response({"deleted": 0})

            try:
                for fname in os.listdir(temp_base):
                    if not fname.startswith('bEpic_'):
                        continue
                    fpath = os.path.join(temp_base, fname)
                    try:
                        if os.path.isfile(fpath):
                            os.remove(fpath)
                            deleted += 1
                    except Exception:
                        continue
            except Exception as e:
                print(f"[bEpicClearCache] error scanning temp dir: {e}")
                return web.json_response({"deleted": deleted})

            return web.json_response({"deleted": deleted})

        async def _bepic_viewer_page(request):
            """Open the regular ComfyUI app in viewer-only mode.

            The viewer extension depends on ComfyUI's full frontend runtime,
            so we redirect to root with a query flag and let JS collapse the
            UI to only the bEpic viewer panel.
            """
            raise web.HTTPFound('/?bepic_viewer_only=1')

        async def _bepic_save_annotation(request):
            """Save a PNG produced by the in-viewer Annotation tool to ./output.

            Body: JSON { dataurl: "data:image/png;base64,...", filename_prefix }.
            Returns { filename, subfolder, type:"output", path } so the viewer can
            add the saved file to its history strip (and drag it onto the graph).
            """
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"error": "invalid JSON body"}, status=400)

            prefix = str(data.get("filename_prefix") or "bEpic_annotation")
            # Keep only filesystem-safe characters in the prefix.
            prefix = "".join(c for c in prefix if c.isalnum() or c in ("_", "-")) or "bEpic_annotation"

            try:
                raw, ext = _decode_image_upload(data.get("dataurl"))
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)

            try:
                out_dir = folder_paths.get_output_directory()
                # Store annotations under ./output/annotations/ (get_save_image_path
                # honours a subfolder embedded in the prefix and reports it back).
                full_output_folder, filename, counter, subfolder, _ = \
                    folder_paths.get_save_image_path(
                        os.path.join("annotations", prefix), out_dir)
                os.makedirs(full_output_folder, exist_ok=True)
                fname = f"{filename}_{counter:05d}_.{ext}"
                fpath = os.path.join(full_output_folder, fname)
                with open(fpath, "wb") as fh:
                    fh.write(raw)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            return web.json_response({
                "filename": fname,
                "subfolder": subfolder or "",
                "type": "output",
                "path": os.path.abspath(fpath),
            })

        async def _bepic_extract_frame(request):
            """Write one frame of a clip out as a PNG file and say where it landed.

            Backs shift-dragging a frame off the viewer's timeline onto the node
            graph. Two body shapes, matching the two kinds of clip the viewer can
            be playing:
              { path | filename+subfolder+type, frame } — a video the server can
                read, inside the allowed folders. The PNG is written next to it
                when it sits in ComfyUI's input, output or temp folder, and in
                ./output/extracted_frames otherwise: this route writes files, so
                it never writes outside ComfyUI's own folders.
              { dataurl, name } — a clip that exists only in the browser (dropped
                in from Explorer), whose frame the viewer grabbed off the <video>
                itself. There is no original for it to sit beside, so those land
                in ./output/extracted_frames.

            Returns { path, filename } — an absolute path, so the caller can point
            a path-based loader straight at it.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)
            try:
                data = await request.json()
            except Exception:
                return web.json_response({"error": "invalid JSON body"}, status=400)

            try:
                frame = max(0, int(data.get("frame") or 0))
            except Exception:
                frame = 0

            dataurl = data.get("dataurl") or ""
            if dataurl:
                try:
                    raw, _ = _decode_image_upload(dataurl, force_png=True)
                except ValueError as e:
                    return web.json_response({"error": str(e)}, status=400)
                stem = os.path.splitext(os.path.basename(str(data.get("name") or "clip")))[0]
                stem = "".join(c for c in stem if c.isalnum() or c in ("_", "-")) or "clip"
                try:
                    folder = media_resolve.extract_dir_fallback()
                    os.makedirs(folder, exist_ok=True)
                    # Same naming as a server-side extract, so a folder of frames
                    # reads the same however they got there.
                    fpath = os.path.join(folder,
                                         media_resolve.extract_frame_name(stem, frame))
                    with open(fpath, "wb") as fh:
                        fh.write(raw)
                except Exception as e:
                    traceback.print_exc()
                    return web.json_response({"error": str(e)}, status=500)
                return web.json_response({"path": os.path.abspath(fpath),
                                          "filename": os.path.basename(fpath)})

            raw_path = data.get("path") or data.get("filename") or ""
            try:
                path = media_resolve.resolve_path(raw_path, str(data.get("type") or ""),
                                                  allow=path_access.is_allowed)
            except PermissionError as e:
                return web.json_response({"error": path_access.refusal(e.args[0])}, status=403)
            if not path or not os.path.isfile(path):
                return web.json_response(
                    {"error": f"could not find {raw_path!r} on disk"}, status=404)

            try:
                out = media_resolve.extract_frame(
                    path, frame, beside=path_access.in_comfy_dirs(path))
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=422)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            return web.json_response({"path": os.path.abspath(out),
                                      "filename": os.path.basename(out)})

        async def _bepic_resolve_media(request):
            """Resolve a loader node's media into viewer tabs.

            Two body/query forms, matching how loaders store their media:
              { value, hint, type, skip, cap, every } — `value` is a raw widget
                string (a ./input filename, an absolute OS path, or a directory)
                and `hint` is the widget's name.
              { files: [...], type, label } — an explicit list of files the node
                loads, used by container-style loaders (AYON) whose media lives
                in a JSON blob instead of a path widget.

            Returns { tabs: [{label, kind, frames}] } — frames are viewer frame
            dicts — or { error } with a message to show the user.
            """
            if media_resolve is None:
                return web.json_response(
                    {"error": "media resolver unavailable on this install"}, status=500)

            if request.method == "POST":
                try:
                    data = await request.json()
                except Exception:
                    data = {}
            else:
                data = dict(request.query)

            def _int(key, default=0):
                try:
                    return int(data.get(key, default) or default)
                except Exception:
                    return default

            files = data.get("files")
            if isinstance(files, str):          # GET form: comma-separated
                files = [f for f in files.split(",") if f.strip()]
            value = str(data.get("value") or "").strip()
            if not value and not files:
                return web.json_response({"error": "no media value given"}, status=400)

            missing = []
            try:
                if files:
                    tabs, missing = media_resolve.resolve_files(
                        files,
                        ann_type=str(data.get("type") or "input"),
                        label=str(data.get("label") or ""),
                        allow=path_access.is_allowed,
                    )
                else:
                    tabs = media_resolve.resolve(
                        value,
                        hint=str(data.get("hint") or ""),
                        ann_type=str(data.get("type") or ""),
                        skip=_int("skip"),
                        cap=_int("cap"),
                        every=_int("every", 1),
                        allow=path_access.is_allowed,
                    )
            except PermissionError as e:
                return web.json_response({"error": path_access.refusal(e.args[0])}, status=403)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=404)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            payload = {"tabs": tabs}
            if missing:
                payload["warning"] = (
                    f"{len(missing)} file(s) referenced by the node are missing "
                    f"from ./input, or outside the folders the viewer may open")
            return web.json_response(payload)

        async def _bepic_health(_request):
            return web.json_response({"ok": True, "service": "bepic_templates"})

        async def _bepic_three(request):
            name = request.match_info.get("name", "")
            try:
                allowed = set(os.listdir(_THREE_DIR))
            except OSError:
                allowed = set()
            if name not in allowed or not name.endswith(".js"):
                return web.Response(status=404, text="not found")
            return web.FileResponse(os.path.join(_THREE_DIR, name), headers={
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "max-age=86400",
            })

        async def _bepic_model_thumb(request):
            """Keep the browser's rendering of a model as its history tile."""
            if model_writer is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("path"), str):
                return web.json_response({"error": "bad request"}, status=400)
            path = os.path.abspath(data["path"])
            if os.path.splitext(path)[1].lower() not in _MODEL_EXTS:
                return web.json_response({"error": "not a 3D model"}, status=400)
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "file not found"}, status=404)
            dataurl = data.get("dataurl")
            if not isinstance(dataurl, str) or len(dataurl) > 3 * 1024 * 1024:
                return web.json_response({"error": "thumbnail missing or too large"}, status=400)
            try:
                raw, _ext = _decode_image_upload(dataurl, force_png=True)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            dst = model_writer.thumb_cache_path(path)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "wb") as fh:
                    fh.write(raw)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True})

        async def _bepic_scene_list(_request):
            """Saved previz scenes (output/3d_scenes)."""
            if previz is None:
                return web.json_response({"scenes": []})
            return web.json_response({"scenes": [
                {"name": s["name"], "mtime": s["mtime"]} for s in previz.list_scenes()]})

        async def _bepic_scene_load(request):
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            name = request.query.get("name", "")
            if not name:
                return web.json_response({"error": "missing name"}, status=400)
            try:
                return web.json_response({"name": name, "scene": previz.load_scene(name)})
            except FileNotFoundError:
                return web.json_response({"error": "no such scene"}, status=404)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)

        async def _bepic_scene_save(request):
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("scene"), dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "scene"
            try:
                path = previz.save_scene(name, data["scene"])
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "name": previz._safe_name(name), "path": path})

        async def _bepic_previz_frame(request):
            """One rendered frame of a shot, straight from the viewer's canvas.

            Like every other upload here the PNG is decoded and re-encoded, so
            what lands in ./output/previz is an image and nothing else."""
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "shot"
            try:
                index = int(data.get("index", 0))
            except (TypeError, ValueError):
                return web.json_response({"error": "bad frame index"}, status=400)
            if index < 0 or index > 99999:
                return web.json_response({"error": "frame index out of range"}, status=400)
            if data.get("first"):
                previz.clear_render(name)          # a new take replaces the old one
            try:
                raw, _ext = _decode_image_upload(data.get("dataurl"), force_png=True)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            previz.renders_dir(name, create=True)
            path = previz.frame_path(name, index)
            try:
                with open(path, "wb") as fh:
                    fh.write(raw)
            except OSError as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "path": path,
                                      "dir": os.path.dirname(path)})

        async def _bepic_previz_encode(request):
            """Encode a finished take into output/previz/<name>.<format>."""
            if previz is None:
                return web.json_response({"error": "unavailable"}, status=500)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict):
                return web.json_response({"error": "bad request"}, status=400)
            name = data.get("name") or "shot"
            try:
                fps = float(data.get("fps", 24.0)) or 24.0
            except (TypeError, ValueError):
                fps = 24.0
            fmt = str(data.get("format") or "mp4").lower()
            if fmt not in previz.VIDEO_FORMATS:
                return web.json_response({"error": f"unknown format: {fmt}"}, status=400)
            quality = str(data.get("quality") or "high").lower()
            if quality not in previz.VIDEO_QUALITY:
                return web.json_response({"error": f"unknown quality: {quality}"}, status=400)
            try:
                path = previz.encode_render(name, fps, fmt, quality)
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=400)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
            return web.json_response({"ok": True, "path": path,
                                      "name": previz._safe_name(name)})

        async def _bepic_usd_export(request):
            """Write a previz scene out as a USD stage."""
            if usd_io is None or not usd_io.available():
                return web.json_response({"error": "this install has no USD (pip install usd-core)"},
                                         status=501)
            try:
                data = await request.json()
            except Exception:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("scene"), dict):
                return web.json_response({"error": "bad request"}, status=400)

            target = data.get("path")
            if target:
                target = os.path.abspath(str(target))
                if not path_access.is_allowed(target):
                    return web.json_response({"error": path_access.refusal(target)}, status=403)
                if not usd_io.is_usd(target):
                    return web.json_response({"error": "that name is not a USD file"}, status=400)
            else:
                name = previz._safe_name(data.get("name") or "previz") if previz else "previz"
                ext = "usdc" if str(data.get("format", "")).lower() == "usdc" else "usda"
                folder = previz.scenes_dir(create=True) if previz else folder_paths.get_output_directory()
                target = os.path.join(folder, f"{name}.{ext}")
            try:
                written = usd_io.export_scene(data["scene"], target)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            return web.json_response({"ok": True, "path": written,
                                      "name": os.path.basename(written)})

        async def _bepic_usd_import(request):
            """Read a USD stage — or an Alembic cache — into a previz scene."""
            raw_path = request.query.get("path") or ""
            if abc_io is not None and abc_io.is_abc(raw_path):
                target = os.path.abspath(raw_path)
                if not path_access.is_allowed(target):
                    return web.json_response({"error": path_access.refusal(target)}, status=403)
                if not os.path.isfile(target):
                    return web.json_response({"error": "no such file"}, status=404)
                try:
                    scene = abc_io.import_scene(target)
                except Exception as e:
                    return web.json_response({"error": str(e)}, status=400)
                return web.json_response({"ok": True, "scene": scene,
                                          "name": os.path.basename(target)})
            if usd_io is None or not usd_io.available():
                return web.json_response({"error": "this install has no USD (pip install usd-core)"},
                                         status=501)
            raw = request.query.get("path") or ""
            if not raw:
                return web.json_response({"error": "missing path"}, status=400)
            path = os.path.abspath(raw)
            if not path_access.is_allowed(path):
                return web.json_response({"error": path_access.refusal(path)}, status=403)
            if not os.path.isfile(path):
                return web.json_response({"error": "no such stage"}, status=404)
            try:
                scene = usd_io.import_scene(path)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=400)
            return web.json_response({"ok": True, "path": path, "scene": scene})

        async def _bepic_usd_stages(_request):
            """USD stages sitting in output/3d_scenes, for the Load menu."""
            if previz is None:
                return web.json_response({"stages": []})
            folder = previz.scenes_dir()
            out = []
            try:
                names = os.listdir(folder)
            except OSError:
                names = []
            for n in sorted(names):
                if os.path.splitext(n)[1].lower() in (usd_io.USD_EXTS if usd_io else set()):
                    out.append({"name": n, "path": os.path.join(folder, n)})
            return web.json_response({"stages": out, "dir": folder,
                                      "available": bool(usd_io and usd_io.available())})

        # Routes that change something on the machine — writing a render,
        # deleting cache files — are POST only. A GET can be set off by a link
        # or an <img> on any page the user has open; a JSON POST from another
        # origin can't get past the browser without a CORS preflight.
        _safe_add("GET", "/bepic/lib/three/{name}", _bepic_three)
        _safe_add("GET", "/api/bepic/lib/three/{name}", _bepic_three)
        _safe_add("POST", "/bepic/model_thumb", _bepic_model_thumb)
        _safe_add("GET", "/bepic/scenes", _bepic_scene_list)
        _safe_add("GET", "/api/bepic/scenes", _bepic_scene_list)
        _safe_add("GET", "/bepic/scene", _bepic_scene_load)
        _safe_add("GET", "/api/bepic/scene", _bepic_scene_load)
        _safe_add("POST", "/bepic/scene", _bepic_scene_save)
        _safe_add("POST", "/api/bepic/scene", _bepic_scene_save)
        _safe_add("POST", "/bepic/previz_frame", _bepic_previz_frame)
        _safe_add("POST", "/api/bepic/previz_frame", _bepic_previz_frame)
        _safe_add("POST", "/bepic/previz_encode", _bepic_previz_encode)
        _safe_add("POST", "/api/bepic/previz_encode", _bepic_previz_encode)
        _safe_add("POST", "/bepic/usd_export", _bepic_usd_export)
        _safe_add("POST", "/api/bepic/usd_export", _bepic_usd_export)
        _safe_add("GET", "/bepic/usd_import", _bepic_usd_import)
        _safe_add("GET", "/api/bepic/usd_import", _bepic_usd_import)
        _safe_add("GET", "/bepic/usd_stages", _bepic_usd_stages)
        _safe_add("GET", "/api/bepic/usd_stages", _bepic_usd_stages)
        _safe_add("POST", "/api/bepic/model_thumb", _bepic_model_thumb)
        _safe_add("GET", "/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/api/bepic/raw_view", _bepic_raw_view)
        _safe_add("POST", "/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("POST", "/api/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("POST", "/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("POST", "/api/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/bepic/browse", _bepic_browse)
        _safe_add("GET", "/api/bepic/browse", _bepic_browse)
        _safe_add("POST", "/bepic/browse_frames", _bepic_browse_frames)
        _safe_add("POST", "/api/bepic/browse_frames", _bepic_browse_frames)
        _safe_add("GET", "/bepic/view_file", _bepic_view_file)
        _safe_add("GET", "/bepic/thumb", _bepic_thumb)
        _safe_add("GET", "/api/bepic/thumb", _bepic_thumb)
        _safe_add("GET", "/api/bepic/view_file", _bepic_view_file)
        _safe_add("POST", "/bepic/save_annotation", _bepic_save_annotation)
        _safe_add("POST", "/api/bepic/save_annotation", _bepic_save_annotation)
        _safe_add("POST", "/bepic/extract_frame", _bepic_extract_frame)
        _safe_add("POST", "/api/bepic/extract_frame", _bepic_extract_frame)
        _safe_add("POST", "/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("POST", "/api/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/api/bepic/resolve_media", _bepic_resolve_media)
        _safe_add("GET", "/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/api/bepic/viewer", _bepic_viewer_page)
        _safe_add("GET", "/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/api/imageviewer", _bepic_viewer_page)
        _safe_add("GET", "/bepic/health", _bepic_health)
        _safe_add("GET", "/api/bepic/health", _bepic_health)

    try:
        register_routes()
    except Exception as e:
        print(f"[bEpicViewer] could not register viewer routes: {e}")
        traceback.print_exc()
except ImportError:
    # aiohttp not available; skip route registration
    pass
