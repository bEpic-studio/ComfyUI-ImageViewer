# ComfyUI Image Viewer — bEpic Viewer

An advanced image viewer panel for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with professional-grade inspection tools, playback controls, image comparison, and more.

---

## Features

### Multi-Tab Display
- View images from multiple nodes simultaneously in separate tabs
- Name tabs freely using the **bEpic Send To Image Viewer** node
- Drag tabs to reorder them

### Image History
- Each tab maintains a history of up to 20 snapshots automatically
- Navigate through past generations with the history thumbnail strip
- Pin two history snapshots side by side for comparison

### Playback & Timeline
- Play image sequences as animations with configurable FPS
- Step forward/backward one frame at a time
- Select a sub-range on the timeline to loop only part of a sequence
- Loop modes: **Loop**, **Ping-Pong**, and **Once**

### Image Comparison
- Split-screen comparison mode with a draggable divider
- Shift-click two tabs or two history items to compare them

### Exposure & Channel Controls
- Real-time exposure adjustment (-4 EV to +4 EV) for inspecting dark or bright areas
- Isolate individual color channels: **Red**, **Green**, or **Blue**

### Tensor Shape Overlay
- Display the image resolution and channel count directly on the viewer

### Parameter Panel
- See the parameters of the currently selected node in the ComfyUI graph
- Lock the panel to a specific node to keep its parameters visible while working elsewhere
- Dock the panel to the left or right side of the viewer

### Layout Management
- Save and reload named panel layouts
- Set any layout as the default
- Restore the built-in factory default at any time

### File Browser
- Open a native OS folder picker to load an external image sequence into the viewer
- Open any image or folder in the OS file explorer

### Cache Management
- Clear all temporary bEpic images from the ComfyUI temp folder with a single click

### Undocking
- Pop the viewer out into a separate browser window

### Zoom & Pan
- Fit-to-screen, 100%, 75%, and 50% zoom presets
- Pan the image freely when zoomed in

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Step one frame back / forward |
| `Ctrl + ←` / `Ctrl + →` | Jump to first / last frame |
| `↑` / `↓` | Navigate history items |
| `Space` | Play / Pause |
| `Alt + Enter` | Queue prompt (run ComfyUI) |
| `F` | Toggle fit-to-screen zoom |
| `C` | Toggle compare mode |
| `R` | Toggle Red channel view |
| `G` | Toggle Green channel view |
| `B` | Toggle Blue channel view |
| `E + Drag` | Adjust exposure |
| `Shift + Click tab` | Select tab for comparison |
| `Shift + Click history` | Select history item for comparison |
| `Ctrl + Drag timeline` | Select playback range |

---

## Nodes

### bEpic Image Viewer
**Category:** `image/bEpic`

A terminal (output) node that displays images inside the viewer panel.

| Input | Type | Description |
|-------|------|-------------|
| `viewer_control` | BOOLEAN | Enable or disable the viewer output |
| `images_1` … `images_N` | IMAGE | One or more image batches to display, each in its own tab |

Connect any number of image outputs to this node. Each input appears as a separate tab in the viewer.

---

### bEpic Send To Image Viewer
**Category:** `image/bEpic`

A pass-through routing node that sends a single image or mask to the viewer under a custom tab name.

| Input | Type | Description |
|-------|------|-------------|
| `input` | IMAGE / MASK | The image or mask tensor to display |
| `tab_name` | STRING | Label shown on the viewer tab |

Use this node to give descriptive names to individual tabs and to route images from anywhere in the graph to the viewer.

---

## Installation

### Method 1 — ComfyUI Manager (recommended)
1. Open the **ComfyUI Manager** panel inside ComfyUI.
2. Search for **ComfyUI-ImageViewer** and click **Install**.
3. Restart ComfyUI.

### Method 2 — Manual installation
1. Navigate to your ComfyUI custom nodes folder:
   ```
   ComfyUI/custom_nodes/
   ```
2. Clone or copy this repository into that folder:
   ```bash
   git clone https://github.com/szprivate/ComfyUI-ImageViewer.git
   ```
3. Install Python dependencies:
   ```bash
   pip install -r ComfyUI-ImageViewer/requirements.txt
   ```
4. Restart ComfyUI.

After installation a **"Toggle bEpic Image Viewer"** button appears in the ComfyUI action bar. Click it to show or hide the viewer panel.

---

## Usage

1. Add a **bEpic Image Viewer** or **bEpic Send To Image Viewer** node to your workflow.
2. Connect image outputs to it.
3. Click **"Toggle bEpic Image Viewer"** in the top bar to open the panel.
4. Run the workflow — generated images appear in the viewer automatically.

---

## License

Copyright © 2024 szprivate

**Free for personal and non-commercial use.**

- ✅ Personal projects, research, education, and non-commercial creative work
- ❌ Commercial use of any kind is **prohibited** without explicit written permission from the author

Redistribution, modification, and use in source and binary forms are permitted **for non-commercial purposes only**, provided that this copyright notice is retained in all copies or substantial portions of the software.

For commercial licensing enquiries, contact the repository owner.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
