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
to the per-user folder. The file is re-read whenever it changes, so an edit
needs no restart.

The viewer's settings page edits the file too (/bepic/roots). That is the one
request that can widen the list, so it is fenced (`may_edit`): answered only
for a request from the ComfyUI machine itself, sent by ComfyUI's own page —
another site open in the browser can't — unless the admin allows remote
editing with BEPIC_VIEWER_ROOTS_REMOTE_EDIT=1, and never when
BEPIC_VIEWER_ROOTS_LOCKED=1. Folders in the environment variable are shown but
can't be removed from the page: whoever set the variable owns them.

Workflow execution is not affected: a node in a queued prompt still loads any
path it is given. This only governs what the viewer's own routes will touch.
"""

import ipaddress
import os
import string
import sys
from urllib.parse import urlsplit

import folder_paths

ROOTS_ENV  = "BEPIC_VIEWER_ROOTS"
ROOTS_FILE = os.path.join(folder_paths.base_path, "bepic_viewer_roots.txt")
LOCKED_ENV = "BEPIC_VIEWER_ROOTS_LOCKED"
REMOTE_EDIT_ENV = "BEPIC_VIEWER_ROOTS_REMOTE_EDIT"

_FILE_HEADER = """# Folders the bEpic Image Viewer may open, besides ComfyUI's input, output and
# temp folders. One per line; '#' starts a comment. Edited by hand or from
# ComfyUI's Settings -> bEpic Viewer -> Folders.
"""

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


def _env_entries():
    return [e.strip() for e in os.environ.get(ROOTS_ENV, "").split(os.pathsep) if e.strip()]


def file_entries():
    """The folders listed in the file, as written there."""
    try:
        with open(ROOTS_FILE, encoding="utf-8") as fh:
            return [line.strip() for line in fh
                    if line.strip() and not line.lstrip().startswith("#")]
    except FileNotFoundError:
        return []
    except Exception as e:
        print(f"[bEpicViewer] could not read {ROOTS_FILE}: {e}")
        return []


def expand(raw):
    """One entry as the folder it means (expanded, made absolute), or ""."""
    entry = os.path.expandvars(os.path.expanduser(str(raw).strip().strip('"')))
    if not entry:
        return ""
    # "W:" on its own means the current folder on W:, not the drive.
    if len(entry) == 2 and entry[1] == ":":
        entry += os.sep
    # Relative entries are taken from ComfyUI's folder, where the file sits.
    return os.path.abspath(os.path.join(folder_paths.base_path, entry))


def _configured():
    """The folders the user listed, as written (expanded, made absolute)."""
    return [p for p in (expand(e) for e in _env_entries() + file_entries()) if p]


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
            f"in ComfyUI's Settings → bEpic Viewer → Folders (or in that file) "
            f"to open it here.")


# ── Editing the list (the settings page) ─────────────────────────────────────

def _truthy(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _ip(text):
    try:
        ip = ipaddress.ip_address(str(text or "").split("%")[0])
    except ValueError:
        return None
    return getattr(ip, "ipv4_mapped", None) or ip


def _is_local(request):
    """True for a request made on the ComfyUI machine itself: over loopback, or
    to one of the machine's own addresses (ComfyUI run with --listen and opened
    by machine name), where the connection comes FROM the address it went TO."""
    remote = _ip(request.remote)
    if remote is None:
        return False
    if remote.is_loopback:
        return True
    try:
        sock = request.transport.get_extra_info("sockname")
        return sock is not None and _ip(sock[0]) == remote
    except Exception:
        return False


def may_edit(request):
    """(allowed, reason) for a request that would change the list, or look
    outside it.

    A browser always sends Origin on a POST; a page of another site carries its
    own, so it must name the host the request was sent to. A request with no
    Origin at all is not from a browser page.
    """
    if _truthy(LOCKED_ENV):
        return False, f"The folder list is locked ({LOCKED_ENV} is set). Edit {ROOTS_FILE} instead."
    origin = request.headers.get("Origin")
    if origin is not None:
        parts = urlsplit(origin)
        if origin == "null" or not parts.netloc or parts.netloc.lower() != (request.host or "").lower():
            return False, "Refused: the request did not come from ComfyUI's own page."
    if not _is_local(request) and not _truthy(REMOTE_EDIT_ENV):
        return False, (f"The folder list can only be changed from the ComfyUI machine itself "
                       f"(set {REMOTE_EDIT_ENV}=1 there to allow it from others), "
                       f"or by editing {ROOTS_FILE}.")
    return True, ""


def _status(path):
    if not path:
        return "invalid"
    try:
        return "ok" if os.path.isdir(path) else "missing"
    except OSError:
        return "missing"


def describe():
    """Everything the settings page shows about the list."""
    def row(e):
        p = expand(e)
        return {"entry": e, "path": p, "status": _status(p)}
    return {
        "file": ROOTS_FILE,
        "env_var": ROOTS_ENV,
        "comfy": [{"label": label, "path": path, "status": _status(path)}
                  for label, path in comfy_dirs()],
        "env": [row(e) for e in _env_entries()],
        "file_entries": [row(e) for e in file_entries()],
    }


def write_file_entries(entries):
    """Replace the folders listed in the file, keeping its comment lines.
    Raises ValueError for an entry that can't be a folder path."""
    clean, seen = [], set()
    for raw in entries:
        entry = str(raw or "").strip().strip('"')
        if not entry:
            continue
        if any(ch in entry for ch in "\r\n\0"):
            raise ValueError(f"not a folder path: {entry!r}")
        key = os.path.normcase(expand(entry))
        if key and key not in seen:
            seen.add(key)
            clean.append(entry)

    try:
        with open(ROOTS_FILE, encoding="utf-8") as fh:
            comments = [line.rstrip("\r\n") for line in fh if line.lstrip().startswith("#")]
    except FileNotFoundError:
        comments = _FILE_HEADER.rstrip("\n").split("\n")
    tmp = ROOTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(comments + clean) + "\n")
    os.replace(tmp, ROOTS_FILE)
    _cache["key"] = None
    return clean


def list_folders(path):
    """Sub-folders of `path` for the settings page's folder picker: names only,
    never files. No path: the drives (Windows) or "/". It looks outside the
    allowed folders by design, so it is only ever answered behind may_edit."""
    if not path:
        if sys.platform == "win32":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.isdir(f"{d}:\\")]
            return {"path": "", "parent": None, "dirs": [{"name": d, "path": d} for d in drives]}
        path = "/"
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        raise FileNotFoundError(path)
    dirs = []
    with os.scandir(path) as it:
        for e in it:
            try:
                if e.is_dir() and not e.name.startswith((".", "$")):
                    dirs.append({"name": e.name, "path": e.path})
            except OSError:
                continue
    dirs.sort(key=lambda d: d["name"].lower())
    parent = os.path.dirname(path)
    if parent == path:                      # at a drive root
        parent = "" if sys.platform == "win32" else None
    return {"path": path, "parent": parent, "dirs": dirs[:2000]}
