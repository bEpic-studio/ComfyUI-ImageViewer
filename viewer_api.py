import os
import re
import base64
import traceback
import folder_paths
from server import PromptServer

try:
    from . import media_resolve
except Exception:  # pragma: no cover - viewer still works without the resolver
    media_resolve = None


def _file_response(path):
    """Serve an image/video file, swapping in a browser-renderable PNG proxy for
    formats an <img> can't decode (exr / tiff / dpx / ...).

    `no-cache` lets the browser keep the bytes but forces it to revalidate before
    reusing them, so an overwritten file is picked up immediately (via the ETag
    aiohttp already sends) while unchanged frames cost a 304 instead of a full
    re-download. That is what lets the viewer drop the per-request cache-buster
    it used to append, which was defeating its own frame-caching.
    """
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
                print(f"[bEpicGetPath] route register failed {method} {path}: {e}")

        async def _bepic_open_path(request):
            data = {}
            if request.method == "POST":
                try:
                    data = await request.json()
                except Exception:
                    data = {}
            else:
                data = dict(request.query)

            paths_id = data.get("paths_id", "")
            path_key = data.get("path_key", "")
            suffix = data.get("suffix", "")

            try:
                from . import nodes
                store = getattr(nodes, 'BEPIC_PATHS_STORE', {})
            except Exception:
                store = {}
            # look up the specific paths dict for this ID; fall back to empty if missing
            paths_to_use = store.get(paths_id, {})
            rel = f"{paths_to_use.get(path_key, '')}{suffix}"

            print(f"[bEpicGetPath] open_path called with paths_id={paths_id!r}, path_key={path_key!r}, suffix={suffix!r}")
            print(f"[bEpicGetPath] store lookup returned: {paths_to_use!r}")
            print(f"[bEpicGetPath] relative path computed: {rel!r}")
            try:
                base = folder_paths.get_output_directory()
            except Exception:
                try:
                    base = folder_paths.get_temp_directory()
                except Exception:
                    base = os.getcwd()
            full = os.path.abspath(os.path.join(base, rel))
            print(f"[bEpicGetPath] base directory: {base!r}, full path: {full!r}")

            if os.path.isdir(full):
                target_dir = full
            else:
                target_dir = os.path.dirname(full) or base
            try:
                os.makedirs(target_dir, exist_ok=True)
            except Exception:
                pass
            try:
                os.startfile(target_dir)
            except Exception as e:
                print(f"[bEpicGetPath] _bepic_open_path error: {e}")

            return web.json_response({"success": True})

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
                # External frames come from the folder picker / drag-drop and are
                # served by /bepic/view_file, which has no directory restriction —
                # so for those, existing on disk is the whole test.
                if external:
                    if not os.path.isfile(os.path.abspath(p)):
                        unreachable.append({"path": p, "reason": "gone"})
                    continue
                cand, allowed = _resolve_raw_path(p)
                if not allowed:
                    unreachable.append({"path": p, "reason": "denied"})
                elif not os.path.isfile(cand):
                    unreachable.append({"path": p, "reason": "gone"})

            return web.json_response({"unreachable": unreachable})

        async def _bepic_pick_folder(request):
            """Open a server-side folder picker dialog and return a sorted list of image files."""
            folder = None
            error = None
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                try:
                    root.wm_attributes('-topmost', 1)
                except Exception:
                    pass
                folder = filedialog.askdirectory(title="Select Folder to Open in Viewer")
                root.destroy()
            except Exception as e:
                error = str(e)

            if not folder:
                return web.json_response({"folder": None, "files": [], "error": error or "No folder selected"})

            image_extensions = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif'}
            files = []
            try:
                for fname in sorted(os.listdir(folder)):
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in image_extensions:
                        full_path = os.path.join(folder, fname)
                        if os.path.isfile(full_path):
                            files.append({"path": full_path, "name": fname})
            except Exception as e:
                return web.json_response({"folder": folder, "files": [], "error": str(e)})

            return web.json_response({"folder": folder, "files": files})

        async def _bepic_view_file(request):
            """Serve any absolute file path selected by the user (no directory restriction)."""
            params = dict(request.query)
            path = params.get('path') or params.get('filename')
            if not path:
                return web.Response(status=400, text="missing 'path' parameter")
            path = os.path.abspath(path)
            if not os.path.isfile(path):
                return web.Response(status=404, text="file not found")
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

            dataurl = data.get("dataurl") or ""
            prefix = str(data.get("filename_prefix") or "bEpic_annotation")
            # Keep only filesystem-safe characters in the prefix.
            prefix = "".join(c for c in prefix if c.isalnum() or c in ("_", "-")) or "bEpic_annotation"

            m = re.match(r"^data:image/(png|jpeg);base64,(.*)$", dataurl, re.DOTALL)
            if not m:
                return web.json_response({"error": "expected a data:image/png;base64 payload"}, status=400)
            ext = "png" if m.group(1) == "png" else "jpg"
            try:
                raw = base64.b64decode(m.group(2))
            except Exception as e:
                return web.json_response({"error": f"base64 decode failed: {e}"}, status=400)

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
                read; the PNG is written next to it (see media_resolve).
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
                m = re.match(r"^data:image/(png|jpeg);base64,(.*)$", dataurl, re.DOTALL)
                if not m:
                    return web.json_response(
                        {"error": "expected a data:image/png;base64 payload"}, status=400)
                try:
                    raw = base64.b64decode(m.group(2))
                except Exception as e:
                    return web.json_response({"error": f"base64 decode failed: {e}"}, status=400)
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
            path = media_resolve.resolve_path(raw_path, str(data.get("type") or ""))
            if not path or not os.path.isfile(path):
                return web.json_response(
                    {"error": f"could not find {raw_path!r} on disk"}, status=404)

            try:
                out = media_resolve.extract_frame(path, frame)
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
                    )
                else:
                    tabs = media_resolve.resolve(
                        value,
                        hint=str(data.get("hint") or ""),
                        ann_type=str(data.get("type") or ""),
                        skip=_int("skip"),
                        cap=_int("cap"),
                        every=_int("every", 1),
                    )
            except ValueError as e:
                return web.json_response({"error": str(e)}, status=404)
            except Exception as e:
                traceback.print_exc()
                return web.json_response({"error": str(e)}, status=500)

            payload = {"tabs": tabs}
            if missing:
                payload["warning"] = (
                    f"{len(missing)} file(s) referenced by the node are missing "
                    f"from ./input")
            return web.json_response(payload)

        async def _bepic_health(_request):
            return web.json_response({"ok": True, "service": "bepic_templates"})

        _safe_add("POST", "/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/bepic/open_path", _bepic_open_path)
        _safe_add("POST", "/api/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/api/bepic/open_path", _bepic_open_path)
        _safe_add("GET", "/bepic/raw_view", _bepic_raw_view)
        _safe_add("GET", "/api/bepic/raw_view", _bepic_raw_view)
        _safe_add("POST", "/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("POST", "/api/bepic/probe_paths", _bepic_probe_paths)
        _safe_add("GET", "/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/api/bepic/clear_cache", _bepic_clear_cache)
        _safe_add("GET", "/bepic/pick_folder", _bepic_pick_folder)
        _safe_add("GET", "/api/bepic/pick_folder", _bepic_pick_folder)
        _safe_add("GET", "/bepic/view_file", _bepic_view_file)
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
        print(f"[bEpicGetPath] could not register viewer routes: {e}")
        traceback.print_exc()
except ImportError:
    # aiohttp not available; skip route registration
    pass
