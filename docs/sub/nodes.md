# Node Reference

← [Back to index](../index.md)

---

## bEpic Send To Image Viewer

Sends images to the Image Viewer. Lay down the node in the canvas, connect an image / mask to the node's input, and set the tab_name to any name you want.
If you don't specify a name, the name of the connected node will be used.

Its only output is `image` — the input passed straight through.

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

## Adding the tool nodes from the viewer

You do not have to lay these down by hand. The **Roto** and **SAM3** buttons in the viewer are always available: press one over a tab that isn't already a tool tab and the matching node is added to the graph and wired to the image that tab is showing. Press it again later and you get the same node back rather than a second one.

Two details worth knowing:

- Doing this from a Roto tab wires the new node to the image feeding the Roto node, not to the Roto node itself — the tool nodes emit mattes and prompts, never pictures, so they can't be chained.
- A tab no node in the graph feeds — an opened folder, a dropped file — has nothing to wire to, and the tool panel says so instead of offering the button.

The new node gets a viewer tab of its own the next time the workflow runs — or right away, if you right-click it and choose [Send to Image Viewer](other.md#send-to-image-viewer): a tool node sends the picture feeding it, straight into that same tab.

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
