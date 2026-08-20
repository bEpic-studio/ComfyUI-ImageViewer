# Advanced Features

← [Back to index](../index.md)

---

## File Browser

A panel inside the viewer that browses the disk, previews what it finds, and hands files to the viewer or to the graph — no ComfyUI workflow needed. Click the **folder icon** in the playback toolbar to show or hide it.

It opens on **ComfyUI's input folder**, which the server reports, so it is the right folder even when ComfyUI runs on another machine.

### The panel

| Part | What it does |
|---|---|
| **↑** | Up one folder. <kbd>Backspace</kbd> does the same while the list has focus. |
| **Go to…** | Jump to Input, Output, Temp, your home folder, or any drive. |
| **⟳** | Re-read the folder — pick up files written since you last looked. |
| **Path field** | Shows where you are; type or paste a path and press <kbd>Enter</kbd> to go there. |
| **List** | Sub-folders and media files, ordered so `frame_2` comes before `frame_10`. Sizes on the right. <kbd>↑</kbd> <kbd>↓</kbd> walk it. |
| **Preview** | The selected file, at whatever size the pane is. Drag the bar above it to make it taller. |
| **Open in Viewer** | Opens the selection — or the whole folder when nothing is selected. |

Everything the viewer can display is listed, `exr`, `dpx`, `tiff` and `hdr` included; those are converted to a PNG proxy on the way to the preview, exactly as they are in the main viewport. Videos preview in place with their own transport. A container the browser has no decoder for (`mkv`, `avi`, `wmv`) says so and shows a poster frame instead — it still opens and drags like anything else.

### Getting files out of it

- **Double-click** a file to open it in the viewer, or a folder to go into it.
- **Drag a row onto the viewport** to open it there.
- **Drag a row onto the ComfyUI graph** to get a loader node pointing at the original file — the same drag the history strip offers. See [Dragging a snapshot onto the graph](tabs-history.md).
- **Select several** — <kbd>Ctrl</kbd>+click to add one, <kbd>Shift</kbd>+click for a range — and drag or open the lot in one go. Dragging a row that is part of the selection takes the whole selection; dragging any other row takes just that one.

### How they arrive

Images open as **one tab holding the whole sequence**, so the timeline scrubs the folder. Each video gets a tab of its own, since a video tab holds one clip, and arrives with its real frame rate and frame count rather than a guess. Tabs opened this way are ordinary tabs: <kbd>Shift</kbd>+click one to compare it against another, and they survive a reload.

### Path Bar Overlay

A **path bar** at the bottom of the viewport names whatever is currently on screen, for every tab — images and videos alike. Files loaded off disk and anything the viewer wrote show their full path; a workflow's own output shows its location under the ComfyUI folder (`output/subfolder/name.png`); a file dropped in from the OS shows its name, which is all the browser reveals. Click the bar to expand it and read the whole path — useful when comparing many similarly-named files.

---

## Send to Image Viewer

Right-click a node on the canvas and choose **Send to Image Viewer**. Nodes that already point at a file open it straight away; nodes further down the graph offer **Send to Image Viewer (run branch)** instead and are described [below](#nodes-with-no-file-run-branch). The entry is hidden on nodes with nothing to show, so it stays out of the way everywhere else.

### On a Key

The same thing is available as a command, so it can be given a keyboard shortcut: open **Settings → Keybinding**, search for `bEpic`, and assign a combo to **bEpic Viewer: Send Selected Node To Image Viewer**. It ships without one — every unmodified key is already spoken for.

It acts on the canvas selection and behaves exactly as the menu entry would on each node: a loader opens its file, anything else runs its branch. Select several nodes and it sends all of them, skipping any with nothing to show; if none of them has anything, it says so in a toast rather than a dialog.

For a loader, it works with whatever the node keeps in its widget — no rewiring, no workflow run:

| Node kind | Widget holds | Opens as |
|---|---|---|
| VHS **Load Video (Path)** / **Load Image (Path)** | an absolute OS path | the original file on disk |
| VHS **Load Video** / native **Load Image**, **Load Video** | a filename under `./input` | that uploaded file |
| VHS **Load Images (Path)** and other folder loaders | a directory | the whole image sequence, on the timeline |
| **AYON Load Image** / **AYON Load Video** | a container JSON | the loaded representation, labelled with its product name |
| Third-party loaders | any widget naming a media file | resolved the same way |

Notes:

- Directory loaders honour the node's `skip_first_images` / `image_load_cap` / `select_every_nth` widgets, so the viewer shows exactly the frames the node will feed downstream.
- AYON containers open exactly what the node loads: a multi-frame **AYON Load Image** becomes one scrubbable sequence, **AYON Load Video** shows the first entry (the only one it uses), and **AYON Load 3D Model** gets no menu entry since there is nothing to display. If part of a container has not been uploaded to `./input`, the rest still opens and the console notes what was missing.
- Videos are probed for their real frame rate and length, so the timeline is frame-accurate.
- Sending again from the same node reuses that node's tab and pushes the previous media onto its [history strip](tabs-history.md#history-snapshots), rather than piling up tabs.
- Formats a browser can't display (`exr`, `tiff`, `dpx`, …) are converted to a PNG preview on the fly — only for the frames you actually look at, so long sequences open instantly.

### Nodes with no file: run branch

Any node carrying an `IMAGE`, `MASK` or `VIDEO` output — a VAE Decode, an upscaler, a mask op — can be viewed too. Since there is no file to read, choosing **Send to Image Viewer (run branch)** queues the branch feeding that node once through the normal ComfyUI queue and shows the result.

- **Only the branch runs.** The prompt is pruned to the node and its upstream dependencies, so the workflow's other output nodes are left out — viewing a node never writes files as a side effect.
- **Your graph is never touched.** The capture node is added to the queued prompt only, so node ids, wiring and undo history stay exactly as they were.
- **Terminal nodes work too.** Save Image and Preview Image have no output slots, so they show what feeds them — a preview of what they would write, without writing it.
- **Tool nodes show their input picture.** A **bEpic Image Viewer Roto** hands on a matte and a **SAM3 Collector** hands on prompts, so sending one shows the image feeding it instead — the thing you are about to draw over. It lands in that node's own tab, so the Roto / SAM3 tools attach to it immediately and running the workflow later refreshes the same tab. Where a loader feeds the node directly its file opens straight away, with no queue at all.
- Unchanged upstream nodes come from ComfyUI's cache, so a second run is usually instant.
- Re-running lands in the same tab and stacks the previous result in its history strip, which makes it easy to A/B a parameter change against the last one.

> [!NOTE]
> A muted or bypassed node isn't part of the prompt and can't be run — the viewer says so rather than queueing something that would fail.

---

## Undocking — Multi-Monitor Mode

Click the **Undock** button (detach icon, top-right of the viewer) to pop the viewer into its own dedicated browser window.

- All styles, CSS variables, and state are copied to the new window.
- Move the window to a second monitor for a full-screen image review experience.
- The button icon switches to a "dock" icon — click it in the popout to restore the viewer to the main panel.
- If you close the popout window manually, the viewer auto-restores to the main ComfyUI tab.
- Keyboard events in the popout are fully supported — all hotkeys work there too.

> [!NOTE]
> Some browsers block popups by default. If clicking Undock does nothing, check your browser's popup-blocker settings and allow popups from `localhost:8188` (or your ComfyUI address).

---

## Layout Presets

Layouts let you save and restore the viewer's panel configuration — position, size, panel visibility, and dock positions — with a single click.

### Saving a Layout

1. Arrange the viewer panels exactly as you want them.
2. Click the **Layouts** button in the toolbar (grid icon).
3. Choose *Save Layout* and give it a name.
4. The layout is stored in ComfyUI's user data directory as `bEpicViewer_layouts.json`.

### Applying a Layout

1. Click the **Layouts** button.
2. Select any saved layout from the dropdown list.
3. The viewer snaps to the saved configuration immediately.

### Factory Default

Designate one layout as the **Factory Default** — the configuration applied on first launch or after a reset. Click *Set as Factory Default* from the Layouts menu.

### Managing Layouts

The **Manage Panel** dialog (from the Layouts menu) lets you:

- **Rename** a layout.
- **Delete** a layout.
- View the saved configuration values.

---

## Cache Management

Every image received by bEpicSendToViewer nodes is saved as a temporary PNG in ComfyUI's `temp/` directory, prefixed with `bEpic_`.

### Automatic collection

All the frames written by one execution share a *run token*, which makes a whole render identifiable — and collectable — as a unit. After each execution the node deletes its own older runs once they exceed either limit below, so the temp directory settles at a bounded size instead of growing for as long as ComfyUI is up. Only frames written by that same node and tab are ever considered; another node's files are never touched, and the run just written is always kept even when it alone exceeds the budget.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `BEPIC_TEMP_BUDGET_MB` | `4096` | Megabytes of preview frames kept per node/tab. Roughly four 300-frame 1080p renders. |
| `BEPIC_TEMP_MAX_RUNS` | `20` | Renders kept per node/tab, matching the history strip's depth. Stops a single-image workflow keeping thousands of tiny runs. |

Whichever limit binds first wins. History entries whose frames get collected disappear from the strip on their own — the prune pass confirms with the server before removing anything, so nothing vanishes on a guess.

> Frames are named `bEpic_S_<node>_<tab>_r<token>_<index>.png`. Before this scheme each frame drew its own `random.randint(1, 1000)` suffix, so a re-run could silently overwrite a frame that history still pointed at — around 57 frames of a 300-frame sequence across a full 20-deep history.

### Clearing the Cache

1. Click the **Clear Cache** button in the playback toolbar (trash icon).
2. A confirmation dialog appears — this is irreversible.
3. Confirm to delete all `bEpic_*` temp files and wipe all history thumbnails.
4. The viewer resets to an empty state (all tabs closed, history cleared).

This clears everything at once, across all nodes, rather than waiting for the automatic collection above. It frees disk; it cannot free memory the browser has already spent on frames it downloaded, which no page is able to evict.

---

## Hotkey Help Overlay

Press the **?** button in the toolbar, or hover the viewer and press <kbd>?</kbd>, to display a full hotkey reference overlay directly inside the viewer. Click anywhere on the overlay to dismiss it.

The listed keys are read from the live keybindings rather than hard-coded, so anything you rebind in ComfyUI's keybinding editor shows up here as well. When a roto or SAM3 tool is active, that tool's own reference is appended below.

See also: [Keyboard Shortcuts](hotkeys.md) · [Changing the Hotkeys](hotkeys.md#changing-the-hotkeys)

---


← [Parameter Panel](params-panel.md) | Next: [Node Reference](nodes.md)
