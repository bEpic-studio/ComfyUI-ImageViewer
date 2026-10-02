# Channels & Exposure

← [Back to index](../index.md)

---

![Exposure slider and channel selector](../screenshots/screenshot_07.png)

![The red channel on its own, with the exposure lifted](../screenshots/viewer_2d_channels.jpg)
*The exposure bar centred at the top of the viewport — slider, EV readout, and channel dropdown.*

## Exposure Control

The exposure slider ranges from **−4 EV** to **+4 EV** and adjusts display brightness using a CSS `brightness()` filter — the underlying image data is **never modified**.

These are controls for a picture. On a [3D tab](models-3d.md) the bar is hidden and <kbd>R</kbd> / <kbd>G</kbd> / <kbd>B</kbd> and the <kbd>E</kbd> drag do nothing, so those keys reach ComfyUI (and, in previz, the tools they belong to there).

### Using the Slider

Drag the slider knob or click on the track to set an EV value. The readout on the right updates in real time (e.g. `+1.5 EV`).

### Interactive E-Drag

Hold <kbd>E</kbd> while dragging the mouse **horizontally** anywhere over the viewer to scrub exposure interactively. Release <kbd>E</kbd> to lock the value in place.

### Resetting Exposure

**Right-click** the exposure control (slider or label) to instantly reset to **0.0 EV**.

---

## Channel Isolation

The channel selector dropdown (to the right of the EV readout) switches the viewport between to display only the Red - Green - Blue channels. 

---


← [Playback Controls](playback.md) | Next: [Parameter Panel](params-panel.md)

## Input Colourspace

The menu at the right end of the exposure bar says which colourspace the picture is **in**. The viewer always shows sRGB: the picture is converted from the colourspace you pick to sRGB as its frames are served, and picking sRGB itself (marked *as is*) leaves it alone.

- The list is your OpenColorIO config — the one `$OCIO` points at, else the config built into PyOpenColorIO. The usual ones (the working linear space, ACEScg, linear sRGB, Raw) are at the top, the rest follows by family.
- The sRGB it converts to is the config's own sRGB output: `Output - sRGB` of an ACES 1.x config (with its tone curve), the sRGB display and its default view of an OCIO v2 config.
- **What a node sends starts on sRGB.** A ComfyUI image is display-referred, also when it was saved as EXR, so it is shown as it is until you say otherwise.
- **A scene-linear file opened from disk** (exr, hdr, dpx — from the file browser, a loader node, a dropped path) **starts on the config's working linear space**, which is how those were shown before there was a choice.
- The two are remembered separately, in this browser. The menu shows whichever applies to the picture that is up.
- It works on any still picture the server can read, a PNG included. It is greyed out for videos, 3D tabs and files dropped straight from the desktop.

Exposure and the channel view are applied after the conversion, on the sRGB picture.

Without PyOpenColorIO the menu offers two entries, sRGB and Linear.
