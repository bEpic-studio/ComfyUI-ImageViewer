# Keyboard Shortcuts

All hotkeys are active only when the mouse cursor is **hovering over the viewer panel** (except <kbd>E</kbd>-drag). Typing in an input or textarea field inside the parameter panel temporarily suspends hotkeys.

Every key on this page can be changed — see [Changing the Hotkeys](#changing-the-hotkeys).

← [Back to index](../index.md)

> [!TIP]
> Press `?` while hovering the viewer to open the built-in hotkey overlay without leaving the browser. It lists the keys that are bound **right now**, so it stays correct after you rebind anything.

---

## Frame Navigation

| Key | Action |
|---|---|
| <kbd>←</kbd> | Step back one frame |
| <kbd>→</kbd> | Step forward one frame |
| <kbd>Ctrl</kbd>+<kbd>←</kbd> | Jump to first frame (Rewind) |
| <kbd>Ctrl</kbd>+<kbd>→</kbd> | Jump to last frame (End) |
| <kbd>Space</kbd> | Play / Pause |

## History

| Key / Interaction | Action |
|---|---|
| <kbd>↑</kbd> | Go to previous history snapshot (newer) |
| <kbd>↓</kbd> | Go to next history snapshot (older) |
| <kbd>Delete</kbd> | Remove the selected snapshots, or the one currently open |
| <kbd>Shift</kbd>+click thumbnail | Select two history items for side-by-side comparison |
| <kbd>Ctrl</kbd>+click thumbnail | Add / remove a snapshot from the selection |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+click thumbnail | Select a range of snapshots |
| Right-click thumbnail | Context menu — Copy Path / Remove snapshot(s) |

See [Selecting Several Snapshots](tabs-history.md#selecting-several-snapshots) for what a selection can then do. <kbd>Delete</kbd> is one of ComfyUI's own keys, so it ships unregistered and works only while the viewer is hovered.

## Tabs

| Key / Interaction | Action |
|---|---|
| <kbd>1</kbd>–<kbd>9</kbd> | Switch to tab 1–9 (in display order) |
| <kbd>Shift</kbd>+click tab | Select tab as comparison source; Shift-click another to open split view |

## Viewport

| Key | Action |
|---|---|
| <kbd>F</kbd> | Toggle fit-to-screen zoom |
| <kbd>S</kbd> | Toggle tensor shape overlay |
| <kbd>C</kbd> | Toggle compare / split-view mode |

## Channels & Exposure

| Key / Interaction | Action |
|---|---|
| <kbd>R</kbd> | Isolate Red channel (press again to return to RGB) |
| <kbd>G</kbd> | Isolate Green channel |
| <kbd>B</kbd> | Isolate Blue channel |
| <kbd>E</kbd>+drag | Hold E and drag horizontally to scrub exposure (−4 EV to +4 EV) |
| Right-click exposure control | Reset exposure to 0.0 EV |

## Timeline

| Key / Interaction | Action |
|---|---|
| Click timeline | Jump to frame at that position |
| Drag timeline | Scrub through frames |
| <kbd>Ctrl</kbd>+drag timeline | Define a playback sub-range (highlighted in orange) |

## Workflow

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Queue prompt (run ComfyUI workflow) — works from the undocked popout window, where ComfyUI's own shortcut can't reach |
| <kbd>?</kbd> | Open / close the in-viewer hotkey help overlay |

## Mouse Interactions

| Interaction | Action |
|---|---|
| Drag viewport | Pan image (when zoomed beyond fit-to-screen) |
| Drag compare divider | Adjust the split position in comparison mode |
| Drag panel edge / corner | Resize the viewer panel |
| Drag tab bar (empty area) | Move the entire viewer panel |
| Drag parameter panel edge | Resize the parameter panel width |
| Drag history strip edge | Resize the history strip |

---

## Hotkey Conditions

| Condition | Effect on hotkeys |
|---|---|
| Mouse outside viewer panel | Viewer hotkeys disabled (except <kbd>E</kbd>, and any combo you assigned yourself — see below) |
| Viewer closed or hidden | Viewer hotkeys disabled, even if the cursor was over the panel when it disappeared |
| Cursor inside an input / textarea | Hotkeys suspended while typing |
| Viewer undocked to popout window | Hotkeys active in the popout window |

While the viewer is hovered it takes the key for itself, so a viewer hotkey no longer also triggers the ComfyUI command on the same key behind the panel.

---

## Changing the Hotkeys

Viewer hotkeys are registered as ComfyUI commands, so they live in ComfyUI's own editor:

1. Open **Settings** (gear icon) → **Keybinding**.
2. Search for `bEpic` — every viewer action is listed as *bEpic Viewer: …*, with the key it currently answers to.
3. Double-click a row (or use the pencil button) and press the combo you want. Add a second combo with **+**, drop one with the trash button, or undo your change with the reset arrow.

Notes:

- **A combo you assign works anywhere**, not only over the viewer — it acts on the panel as long as the panel is open. The shipped defaults stay hover-scoped, so plain keys like <kbd>Space</kbd>, <kbd>F</kbd> and <kbd>1</kbd>–<kbd>9</kbd> don't interfere with the canvas.
- **The tab keys are nine separate rows** (*Switch To Tab 1* … *9*), so you can rebind them individually.
- <kbd>E</kbd>-drag for exposure is a held modifier rather than a command, so it isn't rebindable.
- **Toggle bEpic Image Viewer** is in the same list, so you can put opening the panel on a key too.

### Keys Another Extension Already Owns

Two commands can't share a combo, and ComfyUI hands each combo out on a first-come basis. When something else has already claimed one of the viewer's defaults, that row appears in the editor **without** a keybinding — plain <kbd>R</kbd>, for instance, belongs to ComfyUI's own *Refresh Node Definitions*, and node packs such as KJNodes claim plain letters like <kbd>F</kbd> and <kbd>S</kbd> for canvas commands.

The key still works in the viewer while the panel is hovered, and the viewer now takes it for itself there, so the other extension's command no longer fires behind the panel. To get a row you can edit, either:

- assign your own combo to it in the editor, or
- remove the other command's binding and reload — the viewer re-checks at startup and registers its default if the combo has become free.

Every skipped default is reported in the browser console when the page loads, naming the key and the action, so you can see exactly which ones are affected on your install.

---

← [Node Reference](nodes.md) | [Back to index](../index.md)
