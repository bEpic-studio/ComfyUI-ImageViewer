// The input colourspace selector beside Exposure.
//
// The viewer shows sRGB. What a picture's numbers mean is the user's to say: the
// selector names the colourspace the picture is IN, and the server converts from
// it to sRGB as it serves the frame (color_io.py, `cs=` on the file routes). The
// output side is fixed, so "sRGB" is "leave it alone".
//
// Two selections are remembered, because two kinds of picture start from
// different places: anything a node sends (a ComfyUI tensor is display-referred,
// also when it was written into an EXR) starts on sRGB, and a scene-linear file
// opened from disk (exr / hdr / dpx in the file browser, a loader, a drop from a
// folder the server can read) starts on linear, which is how those were shown
// before there was a choice. The selector shows whichever applies to the
// picture that is up.

import { api } from "../../scripts/api.js";

const STORE_KEY  = "bepic.viewer.colorIn";
const LINEAR_RE  = /\.(exr|hdr|dpx)$/i;
// What the transform is applied to, and the part of it an <img> shows as it is.
const IMAGE_RE   = /\.(png|jpe?g|webp|bmp|tiff?|exr|dpx|tga|hdr)$/i;
const BROWSER_RE = /\.(png|jpe?g|webp|bmp)$/i;

const frameName = (o) => String((o && (o.path || o.filename)) || "");

export const ColorMixin = {

    async initColor() {
        const sel = this.colorInSel;
        this._colorChoice = { picture: null, linearFile: null };
        try {
            const kept = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
            if (kept && typeof kept === "object") {
                this._colorChoice.picture    = typeof kept.picture === "string" ? kept.picture : null;
                this._colorChoice.linearFile = typeof kept.linearFile === "string" ? kept.linearFile : null;
            }
        } catch (e) {}
        if (!sel) return;

        let info = null;
        try {
            const resp = await api.fetchApi("/bepic/colorspaces");
            if (resp.ok) info = await resp.json();
        } catch (e) {}
        if (!info || !Array.isArray(info.colorspaces) || !info.target) {
            sel.style.display = "none";      // a server from before the transform
            return;
        }
        this._colorNames = new Set(info.colorspaces.map((c) => c.name));
        this._colorFill(sel, info);
        sel.onchange = (e) => this.setColorIn(e.target.value);
        this._colorInfo = info;
        this.colorShow(this._colorFrame);
        // Frames drawn before the list arrived went out without a colourspace.
        if (this._colorFrame) this.refreshView();
    },

    // The short list first, then everything by family.
    _colorFill(sel, info) {
        const doc = sel.ownerDocument;
        const option = (name) => {
            const o = doc.createElement("option");
            o.value = name;
            o.textContent = name === info.target ? `${name}  (as is)` : name;
            return o;
        };
        const group = (label, names) => {
            if (!names.length) return;
            const g = doc.createElement("optgroup");
            g.label = label;
            names.forEach((n) => g.appendChild(option(n)));
            sel.appendChild(g);
        };
        sel.textContent = "";
        const common = (info.common || []).filter((n) => this._colorNames.has(n));
        group("Common", common);
        const families = new Map();
        for (const c of info.colorspaces) {
            if (common.includes(c.name)) continue;
            const fam = c.family || "Other";
            if (!families.has(fam)) families.set(fam, []);
            families.get(fam).push(c.name);
        }
        for (const [fam, names] of families) group(fam, names);
    },

    _colorKind(imgObj) {
        return (imgObj && imgObj.external && LINEAR_RE.test(frameName(imgObj))) ? "linearFile" : "picture";
    },

    /** The input colourspace in force for a frame, "" before the list is known. */
    colorOf(imgObj) {
        const info = this._colorInfo;
        if (!info) return "";
        const kind = this._colorKind(imgObj);
        const choice = this._colorChoice[kind];
        if (choice && this._colorNames.has(choice)) return choice;
        return kind === "linearFile" ? info.linear : info.target;
    },

    /** What a frame's URL carries as `cs`, "" for nothing: not a still picture
     *  the server can read, or one an <img> already shows right. */
    colorParam(imgObj) {
        if (!this._colorInfo || !imgObj || imgObj.url) return "";
        const name = frameName(imgObj);
        if (!IMAGE_RE.test(name)) return "";
        const cs = this.colorOf(imgObj);
        if (cs === this._colorInfo.target && BROWSER_RE.test(name)) return "";
        return cs;
    },

    /** Point the selector at the frame that is up. */
    colorShow(imgObj) {
        this._colorFrame = imgObj || null;
        const sel = this.colorInSel;
        if (!sel || !this._colorInfo) return;
        const usable = !!imgObj && !imgObj.url && IMAGE_RE.test(frameName(imgObj));
        sel.disabled = !usable;
        const cs = this.colorOf(imgObj);
        if (sel.value !== cs) sel.value = cs;
    },

    setColorIn(value) {
        if (!this._colorInfo || !this._colorNames.has(value)) return;
        this._colorChoice[this._colorKind(this._colorFrame)] = value;
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify(this._colorChoice));
        } catch (e) {}
        this.refreshView();
    },
};
