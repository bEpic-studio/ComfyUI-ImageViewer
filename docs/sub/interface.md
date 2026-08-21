# Viewer Interface

← [Back to index](../index.md)

---

![viewer interface](../screenshots/screenshot_01.png)

## Panel Layout

![bEpic ImageViewer main interface](../screenshots/screenshot_01.png)

## Regions Explained

### Tab Bar

The topmost strip holds the tabs. The **active tab** is highlighted orange. Tabs appear automatically when a bEpicSendToViewer node runs or when you open files from the file browser panel. Change the name of the tabs by changing the `tab_name` in the **bEpic Send To Image Viewer** node.

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
| Toolbar icons | Shape toggle, Clear Cache, File Browser, Layouts, Undock, Help |

## Docking Panels

The history strip, the file browser and the parameters panel all live in one of two **rails**, left and right of the picture. A rail is a vertical stack, so panels can sit side by side *or* above one another.

Every panel wears a slim **title bar** across its top — a grip, the panel's name, and a **✕**. Drag the bar to move the panel; the ✕ puts it away, keeping its slot so showing it again brings it back where it was.

**Drag a panel by its title bar** to move it:

- Drop it on the **left or right edge of the picture** to send it to that rail.
- Drop it on the **top or bottom half of another panel** to place it above or below that one, in the same rail.
- Drop it in the **middle of the picture** — or press <kbd>Esc</kbd> — to cancel. An outline shows exactly where it will land before you let go.

**Resizing:**

- The bar between a rail and the picture sets that rail's width; everything in the rail shares it.
- The bar between two stacked panels sets how they split the height.
- Panels have minimums, so neither drag can squeeze one out of existence. In the file browser the *preview* gives up its height first, so the file list stays readable however short the panel gets.

### Saving an arrangement

**Store Current** in the layout menu saves the whole arrangement under a name — which rail each panel is in, in what order, the rail widths, how a stack splits its height, which panels are showing, and the viewer's own position and size. Picking that layout later puts all of it back.

**Make Current Layout default** does the same for how the viewer opens.

Between the two, the viewer opens with **whichever you set last**: save a default and it opens that way; drag a panel around afterwards and that is what comes back next time.

## Resizing & Moving the Panel

- **Resize** — drag any of the eight edge/corner handles around the viewer border.
- **Move** — drag an empty area of the tab bar to reposition the entire floating panel.

The panel remembers its position and size across page reloads.

---

← [Installation & Setup](getting-started.md) | Next: [Tabs & History](tabs-history.md)
