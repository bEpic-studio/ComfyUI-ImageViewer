# Playback Controls

← [Back to index](../index.md)

---

![Playback toolbar](../screenshots/screenshot_05.png)

---

## The Timeline

The timeline slider stretches across most of the playback toolbar. It shows major and minor tick marks as visual reference.

### Scrubbing

Click anywhere on the timeline to jump to that frame. Click and drag to scrub through frames interactively — the fastest way to review a long sequence.

### Selecting a Playback Sub-Range

Hold <kbd>Ctrl</kbd> while dragging on the timeline to define a sub-range. The selected region is highlighted in orange. Playback will loop only within this range.

To clear the sub-range and return to full-sequence playback, <kbd>Ctrl</kbd>+click outside the selection.

### Pulling a Frame Out onto the Graph

Hold <kbd>Shift</kbd> over the timeline and it turns blue: it is now a drag source for the frame on screen. Drag it onto the ComfyUI node graph and you get a **Load Image** node holding that one frame — VHS *Load Image (Path)* where VHS is installed, the native **LoadImage** otherwise. Drop it *onto* an existing loader node instead and that node's file is swapped, exactly as [dropping a history thumbnail](tabs-history.md#history-snapshots) does.

Where the frame comes from depends on what the tab holds:

| Tab | What happens | Where the file ends up |
|---|---|---|
| Image sequence | Nothing is written — that frame is already a file | stays where it is |
| `mp4` / `mov` / `webm` | The frame is decoded server-side and written as a PNG | **next to the clip**, named `<clip>_f00042.png` |
| A clip dropped in from Explorer | The frame is read out of the player itself — the server never had the file | `output/extracted_frames/` |

Notes:

- Extracting the same frame twice reuses the PNG already on disk rather than decoding again.
- A clip whose own folder can't be written (a read-only mount, media served off another machine) falls back to `output/extracted_frames/` too.
- Frames pulled from a clip in ComfyUI's `temp/` land in `temp/` beside it, and are cleaned up with the rest of it — the same as the clip the frame came from.
- Extraction needs a video decoder: `imageio-ffmpeg` (which the save-to-output video formats already use) or `opencv-python`. Without either, the viewer says so instead of dropping an empty node.

<kbd>Shift</kbd> is only borrowed while the cursor is over the timeline — scrubbing and <kbd>Ctrl</kbd>-drag range select are untouched.

---

## FPS Control

The **FPS** input box sets the playback speed (default: `25`). Click the number and type a new value, or scroll the mouse wheel over it.

---

## Loop Modes

| Mode | Behaviour |
|---|---|
| **Loop** | Wraps back to the first frame and continues playing. |
| **Ping-Pong** | Reverses direction at each end — plays forwards then backwards continuously. |
| **Once** | Stops at the last frame and pauses. |

---

## Video Playback

An `mp4`/`mov`/`webm` tab is decoded by the browser and driven by the same transport, timeline and zoom as an image sequence.

Clips **stream** from the ComfyUI server. The viewer asks the browser for the file's metadata up front and nothing more, so a clip you are merely looking at costs its header rather than its whole size; once it plays, the browser buffers ahead as it needs to and releases what is behind it.

The trade is that seeking goes back to the server, so scrubbing a long clip can hitch.

> [!NOTE]
> An earlier version read whole clips into memory and played them from there, which did make scrubbing smooth. That memory turned out not to be reliably reclaimable — a `<video>` element keeps a clip alive after the page has dropped every reference to it, and the browser holds a buffer of its own besides — so a long session ended up sitting on RAM the viewer had no way to hand back. The toggle and purge buttons that came with it are gone too; there is nothing left for them to manage.

### Odd frame sizes

h264 cannot encode a clip whose width or height is odd, and ComfyUI's video writer takes the stream size straight off the image tensor without adjusting it — so a clip at, say, 1593×1024 failed outright with `avcodec_open2("libx264")` / *width not divisible by 2*. This surfaced when adding **audio** to a stream, because audio is what makes ComfyUI hand the node a `VIDEO` object rather than a plain image batch, and only a `VIDEO` object reaches that encoder.

The node now retries such a clip with its frames edge-padded up to an even size, **keeping the audio and frame rate**. A clip that already has even dimensions is written by ComfyUI's own writer untouched, so nothing is re-encoded that did not have to be, and a failure that is not about frame size is still reported rather than swallowed. The padded size is logged:

```
[bEpicSendToViewer] 1593x1024 is not encodable by h264; padded to 1594x1024 (audio preserved)
```

---


← [Image Comparison](comparison.md) | Next: [Channels & Exposure](channels-exposure.md)
