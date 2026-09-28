# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A ComfyUI custom node pack whose real product is a **frontend viewer panel**: a floating, dockable image/video/3D viewer with tabs, history, comparison, playback, a file browser, drawing tools and a 3D previz tool. Python here is the thin half — four nodes and a set of `/bepic/*` HTTP routes; the JavaScript in `js/` is the thick half.

`__init__.py` exports the nodes, imports `viewer_api` (which registers the routes as a side effect of import), and sets `WEB_DIRECTORY = "js"`, which is how ComfyUI serves the frontend from `/extensions/ComfyUI-ImageViewer/`.

## Running and testing

There is **no test suite in the repository** and nothing to build: the JS is plain ES modules served as-is, and Python needs no compilation step. Two things stand in for a test runner, and both are worth rebuilding when you change anything non-trivial.

Use ComfyUI's own interpreter, never a bare `python`:

```bash
D:/ai/comfyui/.venv/Scripts/python.exe -s <script>      # -s: ignore user site-packages
node --check js/bEpicViewer_model3d.js                  # the only "lint" the JS has
D:/ai/comfyui/.venv/Scripts/python.exe -m py_compile viewer_api.py
```

**Python-side checks** run the real modules with ComfyUI stubbed, in a scratch directory (not in the repo). The pattern each such script follows:

```python
sys.path.insert(0, r"D:\ai\comfyui")          # for folder_paths and comfy_extras
import folder_paths
folder_paths.set_output_directory(tmp); folder_paths.set_input_directory(...)   # scratch dirs
sys.modules["server"] = <module exposing PromptServer.instance.app + send_sync>
sys.modules["bepic"] = <module whose __path__ is this repo>                     # relative imports
importlib.import_module("bepic.viewer_api")   # registers routes onto the aiohttp app
```
Routes are then driven over real HTTP with `aiohttp.test_utils.TestServer/TestClient`. Nodes are exercised by calling their `FUNCTION` directly.

**Frontend checks** run the real modules in a page: a small aiohttp server serves `js/` plus stubs for ComfyUI's `scripts/app.js` and `scripts/api.js`, and a test script is injected as `<script type="module">`, writing results to a `window.__*` object that is then read out of the page. Two pitfalls: modules are cached hard (hard-reload, or `fetch(url, {cache: "reload"})` before reloading), and a backgrounded tab throttles timers and stalls `requestAnimationFrame`, which makes anything waiting on a frame appear to hang.

## Architecture

### The panel is one Web Component assembled from mixins

`js/bEpicViewer.js` defines `<bepic-viewer-panel>` (Shadow DOM, so ComfyUI's CSS cannot reach it), loads `bEpicViewer.html` / `.css` / the icon JSON by `fetch`, and `Object.assign`s every mixin onto the class prototype. Each `bEpicViewer_mixin*.js` / feature file is therefore **one flat object of methods sharing one `this`** — there is no inheritance and no module boundary at runtime. Consequences worth knowing before editing:

- a method name collides across mixins silently; the last `Object.assign` wins,
- `this.container` is the `.panel-container` inside the shadow root — reach elements through it (or `this.shadowRoot`), never `document`,
- the panel can be **undocked into another browser window**: use `this._viewerWindow()` and the element's `ownerDocument` rather than the globals, or timers and observers fire in the wrong realm.

State that must survive a reload goes through `queuePersistViewerState()` into `localStorage`; a previz scene additionally lives on its node's hidden `scene_data` widget (see below).

### The 3D side

- `bEpicViewer_scene3d.js` — the scene **data model only**: plain objects, no DOM, no three.js. Items are a flat list with a `parent` id; transforms are `T(position)·T(pivot)·R·S·T(-pivot)·offset`; keyframes are cubic Hermite with per-key easing. Because it is pure data it can be unit-tested under plain `node`.
- `bEpicViewer_model3d.js` — turns that model into three.js objects and owns the viewport (camera, gizmo, grid, picking, Maya-style navigation, rendering a shot). Each item becomes `root → body → inner(offset) → geometry/children`; the split matters: pivot maths reads *body* space, frozen transforms live on *inner*.
- `bEpicViewer_mixinPreviz.js` + `previzChannels` / `previzCurves` / `previzRender` / `previzUndo` — the panels and the edits (outliner, channel box, curve editor, render dialog, undo stack).
- three.js is **vendored in `vendor/three/`, deliberately outside `js/`**, so ComfyUI does not serve or import it at startup; it is fetched on demand through `/bepic/lib/three/<name>`.

### Server side

- `viewer_api.py` — all `/bepic/*` routes, registered at import. Everything taking a path is filtered through `path_access.py`, which confines reads to ComfyUI's input/output/temp plus folders the user allows (`bepic_viewer_roots.txt` or `BEPIC_VIEWER_ROOTS`). Routes with side effects are POST only. **No route may start a process on the host** — the Explorer-opening routes were removed for exactly this reason, and the ComfyUI registry rejected the repo while they existed.
- `usd_io.py` / `abc_io.py` — USD stages and Alembic caches. The viewport speaks glTF only, so both are flattened server-side into a cached GLB "display proxy" and served through the ordinary file route. `abc_io.py` reads the Ogawa container itself (no Alembic bindings exist on PyPI); an Alembic cache is geometry per frame, so its proxy is keyed by `frame`.
- `file_writer.py` / `model_writer.py` / `previz.py` / `roto_raster.py` — saving frames in VFX formats, saving meshes, previz render folders, rasterising roto shapes.
- A MESH / 3D-file input to `bEpicSendToViewer` is saved in the 3D format picked in `file_format` (glb, gltf, obj, ply, stl, usd/usda/usdc — `model_writer.MODEL_FORMATS`, appended after the image and video formats): `model_writer.convert` reads it with trimesh (USD through `usd_io.display_proxy`) and writes it, USD by its own pxr writer. An image or video format on a 3D input keeps the input's own format; a 3D format on an image falls back to png. FBX has no writer here.
- `nodes.py` — `bEpicSendToViewer`, `bEpicImageViewerRoto`, `bEpicImageViewerSAM3Collector`, `bEpicScene3D`. Node → viewer is a `bepic.viewer.update` websocket message; the nodes also return a `ui` dict so their files appear in ComfyUI's history and Assets panel (the frontend suppresses the inline node preview instead of the node withholding `ui`).

### Worlds (branch `worlds`)

Walkable worlds built from reference images. The viewer only *shows* them; they are *made* by a separate repo,
`ComfyUI-bEpicWorlds` (sibling folder in custom_nodes; library, nodes, `/bepic_worlds/*` routes, MCP server, CLI).
The contract is the scene schema — `SCHEMA.md` there, `bEpicViewer_worldData.js` here.

- `bEpicViewer_worldData.js` — the world item kinds (environment, terrain, scatter, depthmesh), camera `reference`,
  scene `walk` / `world`, as pure data; `parseScene` reads them through it.
- `bEpicViewer_world3d.js` — a mixin on Model3DView (installed with `defineProperties`: it has a getter): sky/sun/fog
  replacing the studio rig, terrain, instanced scatter with wind, depth mesh, walking, reference overlay, feedback pins.
  World items rebuild when `_worldKey` (their settings as JSON) changes.
- `bEpicViewer_previzWorld.js` — the panel side: Add → World, channel-box rows from `WORLD_FIELDS`, Walk/Note buttons,
  notes POSTed to `/bepic_worlds/feedback` (kept in the scene only when that route is missing).
- A world arrives as a normal `bepic.viewer.update` with `scene_replace` (replace the tab's scene), `tab_label` and
  `focus_tab`; tab keys start `world:` and survive the stale-tab sweep.
- A world built around a whole-picture model has it as an ordinary `model` item with id `scene` (placed by the pack's
  `set_scene_model`), so the World tab is the only 3D view. An HDR sky (`sky.hdr`, `.hdr`/`.exr`) is read by the
  vendored `HDRLoader` / `EXRLoader` from `/bepic/view_file?…&raw=1` (`raw` skips the PNG display proxy, which would
  clip it); with `sky.lighting` it is also the world's PMREM environment, and `render.reflections: "sky"` keeps the
  cube capture from replacing it (`_worldSkyLight` / `_worldDropSkyLight`).

### Keys and curves (previz and roto)

- One key bar in the transport (Set Key, Delete Key, Autokey, ease menu), built in `previzEnsureKeyBar`; `_keyBarContext()` decides whether a press keys the previz scene or the roto tool's shapes, and `keyBarSync()` shows it for whichever is up.
- The drawing tools' options (Roto, SAM3 points/boxes, Annotate) live in the **Parameters** panel: while a tool is on, `_toolShowDock` puts it in `tool-mode` (header names the tool, lock hidden, node widgets hidden, the selection monitor paused via `_paramsToolMode`) and each tool fills `this._toolPanel`, a sibling of `#params-content`. The panel opens with the tool, closes after it only if it was closed before, and goes back to the node on 3D tabs. Nothing floats over the picture but the toolbar.
- Roto and SAM3 follow the canvas selection: selecting a Roto / SAM3 Collector node brings its tool up, selecting anything else puts a tool brought up that way away again (`_toolFollowSelection`, called from the params monitor's tick; the params lock holds it). Their toolbar buttons only create a node (`createToolNode`, left selected) — the selection does the rest. Annotate has no node and still toggles.
- Two dock panels, one look: previz's **Animation Curves** (`bEpicViewer_previzCurves.js`, value graphs) and **Roto Curves** (`bEpicViewer_rotoCurves.js`, a shape's timing between keys). Both are built from `bEpicViewer_curveUI.js` (panel skeleton, list/graph splitter, tangent arms), which stays plain functions so the two mixins can't collide.
- **Node parameters** can be keyed too, on nodes that declare an optional `animation` STRING input whose spec lists `bepic_animatable` names (the bEpic image nodes in `bepic_templates`: Transform, Grade, ColorCorrect, Blur, Merge, Constant, Crop, Retime). The keys are JSON in that hidden widget — a real input, so a changed curve re-runs the node. `bEpicViewer_paramAnimData.js` is the format and the maths (pure); `bepic_templates/bepic_anim.py` renders it and **must interpolate identically** (compare the two on random tracks after any change). `bEpicViewer_paramAnim.js` puts key toggles on the Parameters rows (Nuke rules: an animated value keys itself when edited; Alt-click drops a track, leaving the widget at the frame's value), and makes the key bar's third context, `params`; `bEpicViewer_paramCurves.js` is the **Parameter Curves** panel (dock id `paramCurves`, opened by ∿ in the Parameters header).
- A roto key's `tangents[frame]` carries `{ox, oy, ix, iy, hold}`; `roto_raster.py` must interpolate exactly as `_rotoSegEase` does, or the mask a node renders won't match the viewer.
- `roto_raster.rasterize` stays fast by working each layer only inside the box its outline + feather/dilate/blur can reach, reusing the mask of any frame whose outlines equal an earlier one's, and rendering the rest on a thread pool (`BEPIC_ROTO_THREADS` caps it). A change to the matte maths must keep the box margin wide enough (3σ per blur, the dilate radius) or it clips; compare its output against the old renderer's pixel for pixel.
- Anything that moves the frame must call `_toolsFrameChanged()` (image sequences in `setFrame`, videos in its video branch and `_videoOnTimeUpdate`), or the roto overlay lags until the next unrelated redraw.

### Hotkeys

`bEpicViewer_keymap.js` is the single table feeding three consumers: ComfyUI's command list (so every action is rebindable in Settings → Keybinding), the panel's own key handler (which answers while the viewer is hovered), and the in-viewer help overlay. Add actions there, not ad-hoc listeners. A combo ComfyUI already owns ships unregistered and still works while hovered.

## Publishing

`.github/workflows/publish.yml` publishes to the Comfy registry **on any push to `master` that touches `pyproject.toml`**, and only from `szprivate/ComfyUI-ImageViewer`. So: bumping `version` in `pyproject.toml` *is* publishing. Push other changes freely; touch that file only when a release is intended.

Remotes: `upstream` = szprivate (dev, and the one that publishes), `origin` = bEpic-studio (org).
