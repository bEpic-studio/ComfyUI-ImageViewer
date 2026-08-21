# Node Reference

← [Back to index](../index.md)

---

## bEpic Send To Image Viewer

Sends images to the Image Viewer. Lay down the node in the canvas, connect an image / mask to the node's input, and set the tab_name to any name you want.
If you don't specify a name, the name of the connected node will be used.

Its only output is `image` — the input passed straight through.

Turn on **save_to_output** and the frames are also written to ComfyUI's output directory in the format you pick (png, exr, tiff, jpg, dpx, mp4, mov, webm, ...) rather than only reaching the viewer as temp files.

Saved PNGs carry the ComfyUI workflow in their text chunks, exactly as SaveImage writes it, so dropping one back onto the canvas rebuilds the graph that made it. A video container can't hold that, so video outputs get it in a same-named companion PNG — which doubles as the clip's thumbnail in the viewer's history. Starting ComfyUI with `--disable-metadata` switches this off, the same as it does for the standard save nodes.

---

## bEpic Image Viewer Roto

Gives the viewer's **Roto** tool somewhere to put its matte.

| | |
|---|---|
| Input | `image` — the picture to roto over |
| Outputs | `roto_mask` (MASK)<br>`image` — the input passed straight through |

It opens a tab exactly like Send To Image Viewer, so the frames you are drawing over are the frames the mask is rasterized against. The shapes themselves are stored on the node, in a widget the viewer keeps hidden, which means they travel with the workflow.

The `roto_mask` output is there from the moment you drop the node in, so you can wire the graph up before drawing anything. An empty node yields a black matte at the input's resolution.

---

## bEpic Image Viewer SAM3 Collector

Gives the viewer's **SAM3 points** and **SAM3 boxes** tools somewhere to put their prompts. One node carries both kinds.

| | |
|---|---|
| Input | `image` — the picture to place prompts on |
| Outputs | `positive_points`, `negative_points` (SAM3_POINTS_PROMPT)<br>`positive_bboxes`, `negative_bboxes` (SAM3_BOXES_PROMPT) |

Shaped to match ComfyUI-SAM3's own collectors, so they drop straight into a SAM3 graph. All four outputs exist from the start; one you never touch is simply an empty prompt, which SAM3 reads as "no hint of this kind". It carries no image output of its own — the prompts are all it is for, and the picture is already on screen.

---

## Which node a tool edits

**Whatever you have selected on the graph canvas.** Select a Roto node and the viewer's Roto tool reads and writes that node's shapes; select a SAM3 Collector and the SAM3 tools read and write its prompts. Select a different one and the tool moves with you — the panel names the node it is on, above the controls.

You do not have to lay these nodes down by hand. Select the node whose picture you want to work on and press the **Roto** or **SAM3** button: the matching node is added to the graph, wired to it, and left selected so the tool is already pointing at it. Press the button again and you get that same node back rather than a second one.

With nothing useful selected, the tab you are looking at decides — so the buttons still work when you have not touched the graph at all, or when the viewer is undocked and the graph is behind another window. In order, a tool binds to:

1. a node of its kind that is selected;
2. one already fed by the selected node;
3. a new one hung off the selected node — button press only;
4. the tab's own node, when the tab came from a node of that kind;
5. one already fed by the tab's image;
6. a new one hung off the tab's image — button press only.

Nodes are only ever added by pressing the button. Switching tabs and changing the selection rebind the tool but never grow the graph.

Three details worth knowing:

- Adding a tool from a Roto or SAM3 node wires the new node to the image feeding *that* node, not to its output — the tool nodes emit mattes and prompts, never pictures, so they can't be chained.
- Selecting something with no picture to offer — a checkpoint loader, a KSampler — is not about the tool at all: it stays where it is rather than snapping elsewhere mid-shape. So does clicking empty canvas. Deleting the node you are editing does move it.
- With nothing selected and a tab no node in the graph feeds — an opened folder, a dropped file — there is nothing to wire to, and the tool panel says so instead of offering the button.

A node added this way gets a viewer tab of its own the next time the workflow runs — or right away, if you right-click it and choose [Send to Image Viewer](other.md#send-to-image-viewer): a tool node sends the picture feeding it, straight into that same tab.

---

## Backend API Endpoints

The extension registers the following HTTP routes on the ComfyUI server. These are used internally by the viewer frontend but can also be called directly.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/bepic/open_path` | Open a folder path in the OS file explorer |
| GET | `/bepic/raw_view?path=…` | Serve a bEpic temp PNG securely |
| GET | `/bepic/view_file?path=…` | Serve an external image file |
| GET | `/bepic/browse?path=…` | List one directory's sub-folders and media files (no path → ComfyUI's input folder) |
| POST | `/bepic/browse_frames` | Turn browsed paths into viewer frames — fps, frame count and poster for videos |
| GET | `/bepic/clear_cache` | Delete all `bEpic_*` temp files |
| POST | `/bepic/extract_frame` | Write one frame of a clip out as a PNG beside it, and report where it landed |
| GET | `/bepic/viewer` | Standalone viewer-only HTML page |
| GET | `/bepic/health` | Health check — returns 200 if running |

---

← [Advanced Features](advanced.md) | Next: [Keyboard Shortcuts](hotkeys.md)
