three.js r180 — vendored, unmodified except where noted below.

Upstream: https://github.com/mrdoob/three.js, npm package `three@0.180.0`
(MIT, see LICENSE). The same revision ComfyUI's own frontend bundles.

| File | Copied from |
|---|---|
| `three.module.js`, `three.core.js` | `three@0.180.0/build/` — the **unminified** build, so the code here is the code upstream publishes and can be read and diffed |
| `OrbitControls.js`, `TransformControls.js`, `GLTFLoader.js`, `FBXLoader.js`, `OBJLoader.js`, `STLLoader.js`, `PLYLoader.js`, `ViewHelper.js`, `BufferGeometryUtils.js`, `NURBSCurve.js`, `NURBSUtils.js` | `three@0.180.0/examples/jsm/` |
| `HDRLoader.js`, `EXRLoader.js` | `three@0.180.0/examples/jsm/loaders/` (worlds: HDR skies) |
| `fflate.module.js` | `three@0.180.0/examples/jsm/libs/` (FBXLoader and EXRLoader need it) |
| `EffectComposer.js`, `Pass.js`, `ShaderPass.js`, `MaskPass.js`, `RenderPass.js`, `UnrealBloomPass.js`, `OutputPass.js` | `three@0.180.0/examples/jsm/postprocessing/` (worlds: bloom and tone mapping) |
| `CopyShader.js`, `LuminosityHighPassShader.js`, `OutputShader.js` | `three@0.180.0/examples/jsm/shaders/` (the passes above need them) |

The addons are copied flat, so their imports are rewritten: `'three'` →
`'./three.module.js'`, and `../utils/`, `../libs/`, `../curves/`, `../shaders/` → `./`. That
and the patch below are the only changes.

`TransformControls.js` carries one local patch, marked `bEpic patch` in the
source: with Local axes it used the object's own quaternion to convert a drag
back, while drawing its handles from the decomposed world matrix. The two
disagree whenever a scale is negative, so a mirrored object moved and rotated
against the mouse.

Kept outside `js/` on purpose: ComfyUI imports every `.js` under an extension's
web directory at startup, and this should only load when a 3D tab opens. Served
by `/bepic/lib/three/<file>` (viewer_api.py).

To refresh: `npm pack three@<version>`, copy the files above into place, redo
the import rewrites and the TransformControls patch.
