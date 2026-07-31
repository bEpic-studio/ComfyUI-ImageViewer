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

The **memory-stick** button in the playback toolbar turns the cache on and off. It is **off** by default — trading memory for smoothness is your call, not the viewer's. Lit orange means on, dimmed means off, and the setting persists across reloads.

Turn it on when you are reviewing a clip repeatedly and want scrubbing to stop hitting the server. Turn it off when you would rather keep the memory — large clips, or working alongside something else that needs the RAM.

Switching it **off releases everything the viewer is holding**, immediately and without interrupting whatever is playing — the same full release the purge button performs (see below). Switching it back on pulls the clip on screen into memory straight away rather than waiting for the next one.

Off also stops the **browser** buffering whole clips of its own accord: clips are then loaded metadata-first and read in pieces as they play. That is the memory you were trying not to spend, so it is the point — but it also means scrubbing a streamed clip goes back to the server, which is exactly what caching exists to avoid.

### Purge Viewer Memory

The **memory-stick with an ✕** button next to it hands back everything without turning caching off — the next clip you load is cached again as usual. Hover it to see what is resident right now; it sits dimmed when there is nothing to purge. A short confirmation reports what was freed, so a purge that finds nothing says so rather than looking broken.

Three separate things accumulate, and both the purge button and switching the toggle off release all three:

| What | Why it adds up |
|---|---|
| Cached clips | Whole video files held as in-memory copies |
| The browser's video pre-buffer | Set aside for the clips currently on screen |
| Decoded history thumbnails | One full-resolution image per snapshot, up to 20 per tab — this is what grows with every render |

Purging never interrupts playback: a clip playing from memory is pointed back at its streaming URL first, keeping its position and play state. It then keeps streaming rather than immediately re-reading the whole file — otherwise the memory would come straight back.

History thumbnails load **lazily**, so only the ones actually scrolled into view decode at all, and the rest cost nothing until you look at them. After a purge the strip stays exactly as it was; the images simply decode again as you scroll.

> [!IMPORTANT]
> One thing no page can hand back is the **browser's own HTTP cache** of frames it has already downloaded. If memory keeps climbing while the purge button reports nothing held, that is what you are looking at, and only reloading the page (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) clears it. The button's tooltip is the honest measure of what the viewer itself is holding.

### Clips Released Automatically

Cached clips are also handed back as soon as nothing refers to them, so a long session doesn't accumulate memory you can't see:

| When | What is released |
|---|---|
| A history snapshot is removed (right-click → *Remove from history*) | That snapshot's clip |
| A snapshot falls off the end of the 20-deep history stack | The evicted snapshot's clip |
| **Clear History** (this tab, or all tabs) | Every clip those snapshots referenced |
| A tab is closed, or its node is deleted | That tab's clip |

A file that something else still points at — the live tab, or another snapshot — is always kept, so releasing memory can never cost you a clip you can still open. That means closing a tab whose history you kept releases nothing; use the purge button if you want the memory back regardless.

### Cached-Frame Bar

A thin green bar along the top of the timeline shows which part of the current media is held locally and will therefore scrub and play without going back to the server.

The bar reports what the **RAM cache** is holding, so it is hidden entirely while the cache is switched off — a lit bar over an empty cache would say the opposite of what the toggle does.

| Media | What the bar shows |
|---|---|
| Video | The browser's buffered ranges. A clip served from the RAM cache fills the whole bar almost at once; a streamed one fills in as it downloads, and can show gaps after seeking. |
| Image sequence | The frames decoded so far this session. It grows as you play or scrub through the sequence. |

The bar is hidden for single stills, where it would have nothing to say. It follows a locked sub-range, so it always describes the frames you can actually see.

> [!NOTE]
> For sequences this reflects what the viewer has requested and decoded. The browser is free to evict images from its own cache under memory pressure, so a very long sequence may occasionally re-fetch a frame the bar shows as green.

---


← [Image Comparison](comparison.md) | Next: [Channels & Exposure](channels-exposure.md)
