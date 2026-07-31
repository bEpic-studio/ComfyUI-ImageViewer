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

---


← [Image Comparison](comparison.md) | Next: [Channels & Exposure](channels-exposure.md)
