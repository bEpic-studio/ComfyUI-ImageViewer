"""Which folders the viewer's HTTP routes may read from and write to.

Every /bepic/* route that takes a path checks it here. Those routes answer
anything that can reach ComfyUI's port — another machine when ComfyUI runs with
--listen, or any page open in the user's own browser — so a path in a request
is a claim to be checked, never a permission.

Allowed, always: ComfyUI's input, output and temp folders. On top of those, the
user can allow more folders, e.g. a project drive:
  - one per line in bepic_viewer_roots.txt, beside ComfyUI's own
    extra_model_paths.yaml ('#' starts a comment), or
  - in the BEPIC_VIEWER_ROOTS environment variable, separated by ';' on Windows
    and ':' elsewhere — the form a launcher such as AYON can set.
Both live where ComfyUI's web API can't write — its userdata routes are confined
to the per-user folder — so no request can widen the list. The file is re-read
whenever it changes, so an edit needs no restart.

Workflow execution is not affected: a node in a queued prompt still loads any
path it is given. This only governs what the viewer's own routes will touch.
"""

import os

import folder_paths

ROOTS_ENV  = "BEPIC_VIEWER_ROOTS"
ROOTS_FILE = os.path.join(folder_paths.base_path, "bepic_viewer_roots.txt")

_cache = {"key": None, "roots": []}


def _real(path):
    """The one form paths are compared in: absolute, links resolved, case folded.
    Resolving links is what keeps a junction inside an allowed folder from
    reaching out of it."""
    return os.path.normcase(os.path.realpath(os.path.abspath(path)))


def _inside(real_path, real_root):
    try:
        return os.path.commonpath([real_path, real_root]) == real_root
    except ValueError:                  # different drives, or a malformed path
        return False


def within(path, root):
    """True when `path` lies inside `root` (or is it)."""
    try:
        return _inside(_real(path), _real(root))
    except Exception:
        return False


def comfy_dirs():
    """[(label, path)] for ComfyUI's own media folders."""
    out = []
    for label, get in (("Input",  folder_paths.get_input_directory),
                       ("Output", folder_paths.get_output_directory),
                       ("Temp",   folder_paths.get_temp_directory)):
        try:
            out.append((label, os.path.abspath(get())))
        except Exception:
            pass
    return out


def _configured():
    """The folders the user listed, as written (expanded, made absolute)."""
    entries = os.environ.get(ROOTS_ENV, "").split(os.pathsep)
    try:
        with open(ROOTS_FILE, encoding="utf-8") as fh:
            entries += [line for line in fh if not line.lstrip().startswith("#")]
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[bEpicViewer] could not read {ROOTS_FILE}: {e}")

    out = []
    for raw in entries:
        entry = os.path.expandvars(os.path.expanduser(raw.strip().strip('"')))
        if not entry:
            continue
        # "W:" on its own means the current folder on W:, not the drive.
        if len(entry) == 2 and entry[1] == ":":
            entry += os.sep
        # Relative entries are taken from ComfyUI's folder, where the file sits.
        out.append(os.path.abspath(os.path.join(folder_paths.base_path, entry)))
    return out


def roots():
    """[(label, path, real)] for every allowed folder, ComfyUI's own first."""
    try:
        mtime = os.path.getmtime(ROOTS_FILE)
    except OSError:
        mtime = None
    comfy = comfy_dirs()
    key = (os.environ.get(ROOTS_ENV, ""), mtime, tuple(comfy))
    if _cache["key"] != key:
        seen, out = set(), []
        for label, path in comfy + [(p, p) for p in _configured()]:
            real = _real(path)
            if real not in seen:
                seen.add(real)
                out.append((label, path, real))
        _cache.update(key=key, roots=out)
    return _cache["roots"]


def is_allowed(path):
    """True when `path` lies inside one of the allowed folders."""
    if not path:
        return False
    try:
        real = _real(path)
    except Exception:
        return False
    return any(_inside(real, root) for _, _, root in roots())


def in_comfy_dirs(path):
    """True when `path` lies inside ComfyUI's own input, output or temp folder —
    the only places the viewer writes files next to a source."""
    return any(within(path, p) for _, p in comfy_dirs())


def refusal(path):
    """What to tell the user when a path is out of bounds, and how to allow it."""
    return (f"{path} is outside the folders the viewer may open: ComfyUI's input, "
            f"output and temp folders, plus any listed in {ROOTS_FILE} (one per "
            f"line) or in the {ROOTS_ENV} environment variable. Add the folder "
            f"there to open it here.")
