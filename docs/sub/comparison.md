# Image Comparison

← [Back to index](../index.md)

---

![Vertical split comparison mode](../screenshots/screenshot_02.png)

## Starting a Comparison

### Compare Two Tabs

1. Make sure both tabs you want to compare are open and contain images.
2. <kbd>Shift</kbd>+click the **first** tab to mark it as the base image (a cyan highlight appears on the tab).
3. <kbd>Shift</kbd>+click the **second** tab — the viewer enters split-view immediately.

### Compare Two History Snapshots

1. Navigate to the tab whose history you want to compare.
2. <kbd>Shift</kbd>+click one thumbnail in the history strip to select it as base.
3. <kbd>Shift</kbd>+click another thumbnail — split-view opens.

> [!TIP]
> Press <kbd>C</kbd> while hovering the viewer to toggle comparison mode on/off without losing your comparison pair selection.

---

## The Compare Divider

In split-view, a bright white divider line separates the two images. Drag it left/right (vertical split) or up/down (horizontal split) to reveal more of either image. The divider position is remembered per session.

---

## Orientation Modes

The **Rotate** button in the toolbar cycles through three modes:

| Mode | Description |
|---|---|
| **Vertical Split** (default) | Left/right division — classic A/B wipe. Drag divider horizontally. |
| **Horizontal Split** | Top/bottom division. Drag divider vertically. |
| **Contact Sheet** | Both images stacked vertically in full — no divider, scroll to compare. |

### Sources of Different Resolution

You can compare media that don't share a resolution or aspect ratio — a 1080p render against a 720p one, or a portrait clip against a landscape one. The second source is scaled to line up with the first along the axis the divider travels across:

| Mode | Matched | Why |
|---|---|---|
| **Vertical Split** | Heights | The divider slides left/right, so both frames must share a top and bottom edge. |
| **Horizontal Split** | Widths | The divider slides up/down, so both frames must share a left and right edge. |

Switching orientation re-derives the match, so the pair stays aligned as you cycle modes. Sources that already render at the same size are left untouched. **Contact Sheet** doesn't scale anything this way — it scales both to a shared height and lays them out side by side.

The match is re-derived whenever either side's size becomes known or changes — a clip whose dimensions arrive late, a second source swapped in with <kbd>Shift</kbd>+click, a resized panel. It applies the same way to two tabs and to two pinned history snapshots; snapshots of the same tab usually share a resolution, so there is nothing to correct there.

---

## Exiting Comparison Mode

Press <kbd>C</kbd> while hovering the viewer, or click a tab without holding <kbd>Shift</kbd>. The viewer returns to single-image display on the last active tab.

---

## Comparison with Playback

Comparison mode works simultaneously with the playback timeline — both the base and compare image update as you scrub or play frames. This is useful for comparing animated sequences frame-by-frame at the same timestamp.

> [!NOTE]
> When comparing two tabs with different frame counts, the shorter sequence will loop or hold on its last frame depending on the loop mode setting.

---

← [Tabs & History](tabs-history.md) | Next: [Playback Controls](playback.md)
