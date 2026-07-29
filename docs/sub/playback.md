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

Each clip is read into memory once and played from there, so the decoder never waits on the ComfyUI server mid-playback — which is what used to make looping and scrubbing hitch. Playback starts streaming immediately and switches to the in-memory copy as soon as it has finished loading, keeping its position and play state; you should only ever notice it getting smoother.

- The cache holds up to **1.5 GB** across clips, dropping the least recently used one to stay inside that. Clips larger than **512 MB** are streamed rather than cached.
- **Clear Cache** releases the cached clips along with the temp files they came from.
- If a clip can't be loaded into memory it simply keeps streaming — nothing fails.

### RAM Cache Toggle

The **memory-stick** button in the playback toolbar turns the cache on and off. It is **on** by default and lit orange; dimmed means off. The setting persists across reloads.

Turn it off when you would rather keep the memory than the smoothness — reviewing very large clips, or working alongside something else that needs the RAM. Switching it off releases everything held immediately, without interrupting whatever is playing; switching it back on pulls the clip on screen into memory straight away rather than waiting for the next one.

### Cached-Frame Bar

A thin green bar along the top of the timeline shows which part of the current media is held locally and will therefore scrub and play without going back to the server.

| Media | What the bar shows |
|---|---|
| Video | The browser's buffered ranges. A clip served from the RAM cache fills the whole bar almost at once; a streamed one fills in as it downloads, and can show gaps after seeking. |
| Image sequence | The frames decoded so far this session. It grows as you play or scrub through the sequence. |

The bar is hidden for single stills, where it would have nothing to say. It follows a locked sub-range, so it always describes the frames you can actually see.

> [!NOTE]
> For sequences this reflects what the viewer has requested and decoded. The browser is free to evict images from its own cache under memory pressure, so a very long sequence may occasionally re-fetch a frame the bar shows as green.

---


← [Image Comparison](comparison.md) | Next: [Channels & Exposure](channels-exposure.md)
