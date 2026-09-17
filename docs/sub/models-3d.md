# 3D Models

← [Back to index](../index.md)

---

The viewer shows 3D models in a tab of their own, the way ComfyUI's **Save 3D Model** / **Load 3D** nodes do: same lighting, grid, camera and material modes, and it follows ComfyUI's *Load 3D* settings for background colour, grid and light intensity.

Supported formats: **GLB**, **glTF**, **FBX**, **OBJ**, **STL** and **PLY** (meshes and point clouds).

## Getting a Model into the Viewer

| From | How |
|---|---|
| A 3D node's output | Wire a `MESH` or 3D-file output (`FILE_3D`, `FILE_3D_GLB`, `FILE_3D_FBX`, …) into **bEpic Send To Image Viewer** |
| Any node with a 3D output | Right-click it → **Send to Image Viewer (run branch)** |
| **Load 3D**, and other loaders naming a model file | Right-click → **Send to Image Viewer** |
| Disk | Open it from the [File Browser](other.md#file-browser) (🧊 rows), or drag it in from Explorer / Finder |

A mesh batch opens as one tab; the timeline steps through its models.

## Saving

Turn on **save_to_output** on the send node and the model is written the way **Save 3D Model** writes it:

- a `MESH` is saved as **GLB**, one file per batch item, with its UVs, colours, normals, textures and material;
- a 3D file keeps its own format, so an **FBX stays an FBX**. The viewer doesn't convert between formats; ComfyUI has no FBX writer.

Files are named `<filename_prefix>_00001_.glb` (use a prefix like `3d/ComfyUI` to land them in `output/3d`), carry the workflow in the GLB's metadata unless ComfyUI runs with `--disable-metadata`, and show up in ComfyUI's history and assets like Save 3D Model's. `file_format` and `fps` don't apply to models.

With **save_to_output** off, the model is only previewed from ComfyUI's temp folder.

## In the Viewer

| Action | How |
|---|---|
| Orbit | Left-drag |
| Pan | Right-drag |
| Zoom | Mouse wheel, or middle-drag |
| Frame the model again | **Reset view**, or <kbd>F</kbd> |
| Material | **Original**, **Clay**, **Normal** or **Wireframe** from the toolbar |
| Grid | **Grid** toggles it |
| Animation | FBX / glTF animations play on their own; the ▶ / ❚❚ button pauses them |
| Brightness | The [exposure slider](channels-exposure.md) and R/G/B isolation work on the render |
| Info | The shape overlay (toolbar button) shows vertex, triangle and point counts |

The first time a model is shown, the viewer keeps a snapshot of it as its history thumbnail. Until then the tile shows a cube.

Compare, contact sheet and the drawing tools don't apply to a model tab.

## Moving Models Onto the Graph

Drag a model's history thumbnail or browser row onto the graph and you get a **Load 3D** node holding it. Drop it onto an existing Load 3D node to swap that node's model. Load 3D reads from `input/3d`, so the file is copied there.

## Limits

- A glTF's `.bin` and textures and an FBX's external textures are looked up next to the model file. A model dropped in from the desktop has no folder, so it shows without them.
- OBJ files show their geometry only; an `.mtl` material file isn't read.
- Draco- and KTX2-compressed glTF files aren't supported yet.
- Gaussian splats and USDZ can be saved but not shown.
- three.js (r180, the version ComfyUI uses) ships with the node and only loads when a model tab first opens.

---

← [Other Features](other.md) | Next: [Node Reference](nodes.md)
