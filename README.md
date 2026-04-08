# ComfyUI Image Viewer — bEpic Viewer

An advanced image viewer panel for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with inspection tools, playback controls, image comparison, and it's own parameters panel.

---

![image viewer](docs/screenshots/screenshot_01.png)

## Core Features

- send any image or mask to the viewer using the **bEpic Send To Image Viewer** node
- view images from multiple nodes simultaneously in separate tabs

- supports Zoom / Pan 

- allows undocking into a separate browser window or tab (for two-monitor setups)

- each tab maintains a history of up to 20 snapshots automatically
- play image sequences as animations with configurable FPS
- select a sub-range on the timeline to loop only part of a sequence

- split-screen comparison mode with a draggable divider
- shift-click two tabs or two history items to compare them

- real-time exposure adjustment (-4 EV to +4 EV) for inspecting dark or bright areas
- isolate individual color channels: **Red**, **Green**, or **Blue**

- includes a parameters panel: displays the parameters of the currently selected node in the ComfyUI graph
- lock the panel to a specific node to keep its parameters visible while working elsewhere
- allows you to change parameters on all selected nodes

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

1. Add **bEpic Send To Image Viewer** node to your workflow.
2. Connect image outputs to it.
3. Click **"Toggle bEpic Image Viewer"** in the top bar to open the panel.
4. Run the workflow — generated images appear in the viewer automatically.

---

## License, contributing

Copyright © 2026 bEpic GmbH / Sebastian Zilius

**Free for personal and non-commercial use.**

- ✅ Personal projects, research, education, and non-commercial creative work
- ✅ Feel free to create your own fork and make updates - this is OpenSource, happy to include your Pull Requests if they're good!

- ❌ Commercial use of any kind is **prohibited** without explicit written permission from the author

Redistribution, modification, and use in source and binary forms are permitted **for non-commercial purposes only**, provided that this copyright notice is retained in all copies or substantial portions of the software.

For commercial licensing enquiries, contact the repository owner.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
