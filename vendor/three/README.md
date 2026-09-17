three.js r180 (npm `three@0.180.0`, MIT, see LICENSE): the same revision ComfyUI's
frontend bundles. Used by the viewer's 3D tabs (`js/bEpicViewer_model3d.js`).

Kept outside `js/` on purpose: ComfyUI imports every `.js` under an extension's
web directory at startup, and this should only load when a 3D tab opens. Served
by `/bepic/lib/three/<file>` (viewer_api.py).

The addons are copied flat from `examples/jsm/` with their imports rewritten:
`'three'` → `'./three.module.min.js'`, and `../utils/`, `../libs/`, `../curves/`
→ `./`.
