# Viewer Interface

← [Back to index](../index.md)

---

![viewer interface](../screenshots/screenshot_01.png)

## Panel Layout

![bEpic ImageViewer main interface](../screenshots/screenshot_01.png)

## Regions Explained

### Tab Bar

The topmost strip holds the tabs. The **active tab** is highlighted orange. Tabs appear automatically when a bEpicSendToViewer node runs or when you open a folder via the file browser. Change the name of the tabs by changing the `tab_name` in the **bEpic Send To Image Viewer** node.

| Action | How |
|---|---|
| Switch tab | Click the tab, or press <kbd>1</kbd>–<kbd>9</kbd> |
| Reorder tabs | Drag a tab left/right along the tab bar |
| Close tab | Click the **×** on the tab |
| Select for comparison | <kbd>Shift</kbd>+click (see [Image Comparison](comparison.md)) |

### History Strip

A vertical thumbnail panel on the left side of the viewport. Every time a new image is generated for the active tab, a snapshot thumbnail is added here (up to 20 per tab). The selected snapshot has an orange border.

- Navigate with <kbd>↑</kbd> / <kbd>↓</kbd> while hovering the viewer.
- Click any thumbnail to jump directly to it.
- Right-click a thumbnail for **Copy Path** / **Remove** options.

### Viewport

The central image display area. Supports:

- **Pan** — click and drag when zoomed in.
- **Zoom** — choose a preset (Fit, 100%, 75%, 50%) from the dropdown, or press <kbd>F</kbd> to toggle fit-to-screen.

### Tensor Shape Overlay

A small cyan label in the top-left of the viewport displays the tensor dimensions of the current image or sequence. Toggle visibility with the **Shape** button or press <kbd>S</kbd>.

### Exposure & Channel Bar

Centred near the top of the viewport, this semi-transparent bar houses:

- An **Exposure** slider (−4 EV to +4 EV).
- An EV readout label (right-click to reset to 0).
- A **channel selector** dropdown: RGB / R / G / B.

See [Channels & Exposure](channels-exposure.md) for detailed usage.

### Parameter Panel

The right-side panel mirrors the widget values of whichever ComfyUI node is currently selected on the canvas. Fields are live-editable.

- Resize horizontally by dragging its left edge.
- Lock to a specific node with the padlock button.
- Switch to the left side with the dock button.

See [Parameter Panel](params-panel.md).

### Timeline & Playback Toolbar

The bottom bar contains (left to right):

| Control | Function |
|---|---|
| ⏮ Rewind | Jump to first frame |
| ◁ Step Back | Go back one frame |
| ▶ / ⏸ Play/Pause | Start or stop playback (<kbd>Space</kbd>) |
| ▷ Step Forward | Advance one frame |
| ⏭ End | Jump to last frame |
| Timeline slider | Scrub to any frame; <kbd>Ctrl</kbd>+drag to set a sub-range |
| FPS input | Set playback speed (default 25 fps) |
| Loop mode | Loop / Ping-Pong / Once |
| Toolbar icons | Shape toggle, Clear Cache, Open Folder, Layouts, Undock, Help |

## Resizing & Moving the Panel

- **Resize** — drag any of the eight edge/corner handles around the viewer border.
- **Move** — drag an empty area of the tab bar to reposition the entire floating panel.

The panel remembers its position and size across page reloads.

---

← [Installation & Setup](getting-started.md) | Next: [Tabs & History](tabs-history.md)
