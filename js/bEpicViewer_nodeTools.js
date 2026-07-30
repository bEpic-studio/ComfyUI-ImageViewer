// bEpicViewer_nodeTools.js
// Node-side glue for the in-viewer tools (Roto + SAM3 points).
//
// The bEpicSendToViewer node carries hidden STRING widgets that the viewer's
// tools write into:
//     roto_data          – serialized roto layers        (JSON)
//     sam3_positive      – normalized points [{x,y},...]  (JSON)
//     sam3_negative      – normalized points [{x,y},...]  (JSON)
//     sam3_box_positive  – normalized boxes [{x1,y1,x2,y2},...] (JSON)
//     sam3_box_negative  – normalized boxes [{x1,y1,x2,y2},...] (JSON)
//
// Its Python RETURN_TYPES are fixed at:
//     0 image | 1 roto_mask | 2 positive_points | 3 negative_points
//   | 4 positive_bboxes | 5 negative_bboxes
// but we collapse the node to just `image` on creation and only *reveal* the
// optional outputs (contiguously, so backend indices stay aligned) once a tool
// has actually produced data — the "appear when used" behaviour.

import { app } from "../../scripts/app.js";

export const BEPIC_SEND_NODE = "bEpicSendToViewer";
export const ROTO_WIDGET = "roto_data";
export const SAM3_POS_WIDGET = "sam3_positive";
export const SAM3_NEG_WIDGET = "sam3_negative";
export const SAM3_BOX_POS_WIDGET = "sam3_box_positive";
export const SAM3_BOX_NEG_WIDGET = "sam3_box_negative";

// "save to ./output" toggle and the config widgets it shows/hides.
export const OUTPUT_TOGGLE = "save_to_output";
export const FORMAT_WIDGET = "file_format";
export const FPS_WIDGET    = "fps";
export const OUTPUT_CFG_WIDGETS = [FORMAT_WIDGET, FPS_WIDGET, "filename_prefix"];

// Which file_format values are encoded as video. The real list is
// file_writer.VIDEO_EXTS, carried on the fps input spec in INPUT_TYPES, so
// adding a container backend-side needs no change here; this literal only covers
// a frontend talking to a server too old to send it.
const VIDEO_FORMATS_FALLBACK = ["mp4", "mov", "webm"];

// Read it off the node DEFINITION rather than the built widget: /object_info
// ships INPUT_TYPES verbatim, whereas the frontend rebuilds widget.options from
// a fixed set of keys (min/max/step/precision) and drops anything else.
function videoFormatsFromDef(nodeData) {
    const req  = nodeData && nodeData.input && nodeData.input.required;
    const spec = req && req.fps;
    const list = Array.isArray(spec) && spec[1] ? spec[1].bepic_video_formats : null;
    return (Array.isArray(list) && list.length) ? list : VIDEO_FORMATS_FALLBACK;
}

const normExt = (v) => String(v || "").toLowerCase().replace(/^\./, "");

export function isVideoFormat(node, format) {
    const list = (node && Array.isArray(node._bepicVideoFormats))
        ? node._bepicVideoFormats
        : VIDEO_FORMATS_FALLBACK;
    const ext = normExt(format);
    return ext !== "" && list.some(v => normExt(v) === ext);
}

// Fully hide a widget while keeping it serializable (values still reach backend).
function hideWidget(node, widget) {
    if (!widget) return;
    if (widget._bepicHidden) return;
    widget._bepicHidden = true;
    widget.origType = widget.type;
    widget.origComputeSize = widget.computeSize;
    widget.computeSize = () => [0, -4]; // -4 cancels litegraph's per-widget gap
    widget.type = "bepic-hidden";
    widget.hidden = true;
    if (widget.element) {
        widget.element.style.display = "none";
        widget.element.style.visibility = "hidden";
    }
    if (Array.isArray(widget.linkedWidgets)) {
        for (const w of widget.linkedWidgets) hideWidget(node, w);
    }
}

export function getToolWidget(node, name) {
    if (!node || !node.widgets) return null;
    return node.widgets.find((w) => w.name === name) || null;
}

// Reversibly collapse/restore a widget (unlike hideWidget, which is permanent).
// Collapsed widgets keep their value and serialize normally; they just take no
// space and don't draw.
function setWidgetVisible(node, widget, visible) {
    if (!widget) return;
    if (visible) {
        if (!widget._bepicCollapsed) return;
        widget._bepicCollapsed = false;
        widget.type        = widget._bepicOrigType;
        widget.computeSize = widget._bepicOrigComputeSize;
        widget.hidden      = false;
        if (widget.element) { widget.element.style.display = ""; widget.element.style.visibility = ""; }
    } else {
        if (widget._bepicCollapsed) return;
        widget._bepicCollapsed        = true;
        widget._bepicOrigType         = widget.type;
        widget._bepicOrigComputeSize  = widget.computeSize;
        widget.type        = "bepic-hidden";
        widget.computeSize = () => [0, -4];   // -4 cancels litegraph's per-widget gap
        widget.hidden      = true;            // litegraph's draw loop skips hidden widgets
        if (widget.element) { widget.element.style.display = "none"; widget.element.style.visibility = "hidden"; }
    }
}

export function readToolStore(node, name, fallback) {
    const w = getToolWidget(node, name);
    if (!w) return fallback;
    const v = w.value;
    if (v === undefined || v === null || v === "") return fallback;
    return v;
}

// Write a JSON-able value into a hidden widget and re-sync the node's outputs.
export function writeToolStore(node, name, value) {
    const w = getToolWidget(node, name);
    if (!w) return;
    w.value = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof node.bepicSyncToolOutputs === "function") node.bepicSyncToolOutputs();
    node.setDirtyCanvas?.(true, true);
}

// Does this node currently have roto / point data worth exposing an output for?
function storeHasRoto(node) {
    const raw = readToolStore(node, ROTO_WIDGET, "");
    if (!raw) return false;
    try {
        const obj = JSON.parse(raw);
        return !!(obj && Array.isArray(obj.layers) && obj.layers.length > 0);
    } catch (e) {
        return false;
    }
}

function storeHasPoints(node) {
    for (const name of [SAM3_POS_WIDGET, SAM3_NEG_WIDGET]) {
        const raw = readToolStore(node, name, "[]");
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) return true;
        } catch (e) {}
    }
    return false;
}

function storeHasBoxes(node) {
    for (const name of [SAM3_BOX_POS_WIDGET, SAM3_BOX_NEG_WIDGET]) {
        const raw = readToolStore(node, name, "[]");
        try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr) && arr.length > 0) return true;
        } catch (e) {}
    }
    return false;
}

// Build authoritative output specs from the node definition:
//   { image: {name,type}, optional: [{name,type}, ...] }  (every slot past 0)
function outputSpecsFromDef(nodeData) {
    const types = (nodeData && nodeData.output) || [];
    const names = (nodeData && nodeData.output_name) || [];
    const spec = (i) => ({ name: names[i] || types[i] || `out${i}`, type: types[i] });
    const optional = [];
    for (let i = 1; i < types.length; i++) optional.push(spec(i));
    return { image: spec(0), optional };
}

// Reveal at least `count` optional outputs (contiguous after the image slot).
// Grows only — never removes a slot the user may have wired.
function ensureOutputsAtLeast(node, count) {
    const specs = node._bepicOutputSpecs;
    if (!specs) return;
    const target = Math.min(specs.optional.length + 1, 1 + Math.max(0, count));
    // Guarantee the image slot at index 0 first.
    if (node.outputs.length === 0) node.addOutput(specs.image.name, specs.image.type);
    while (node.outputs.length < target) {
        const spec = specs.optional[node.outputs.length - 1];
        if (!spec) break;
        node.addOutput(spec.name, spec.type);
    }
    node.setDirtyCanvas?.(true, true);
}

// Re-run the widget-visibility sync after a widget's own callback. Wrapped once
// per node — litegraph replaces the callback wholesale, so chaining to whatever
// was there keeps the frontend's own handling intact.
function resyncOnChange(node, widgetName) {
    const w = getToolWidget(node, widgetName);
    if (!w || w._bepicResyncBound) return;
    w._bepicResyncBound = true;
    const origCb = w.callback;
    w.callback = function () {
        const cr = origCb ? origCb.apply(this, arguments) : undefined;
        node.bepicSyncOutputWidgets();
        return cr;
    };
}

// Register the node-side behaviour. Call from beforeRegisterNodeDef.
export function registerSendNode(nodeType, nodeData) {
    const specs = outputSpecsFromDef(nodeData);
    const videoFormats = videoFormatsFromDef(nodeData);

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = onNodeCreated?.apply(this, arguments);

        this._bepicOutputSpecs = specs;
        this._bepicVideoFormats = videoFormats;
        // Collapse to just the image output; optional slots appear on demand.
        if (Array.isArray(this.outputs)) {
            for (let i = this.outputs.length - 1; i >= 1; i--) this.removeOutput(i);
            if (this.outputs.length === 0) this.addOutput(specs.image.name, specs.image.type);
        }

        // Hide the tool storage widgets.
        hideWidget(this, getToolWidget(this, ROTO_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_POS_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_NEG_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_BOX_POS_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_BOX_NEG_WIDGET));

        // Re-sync the save-to-output config widgets whenever the toggle flips —
        // and whenever the format changes, since that decides whether fps means
        // anything.
        resyncOnChange(this, OUTPUT_TOGGLE);
        resyncOnChange(this, FORMAT_WIDGET);
        this.bepicSyncOutputWidgets();

        return r;
    };

    // Show file_format / fps / filename_prefix only while save_to_output is on,
    // then reflow the node to the new widget layout. fps is narrower still: it
    // sets the encoder's frame rate, so a still-image format has nothing for it
    // to do and it stays hidden there.
    nodeType.prototype.bepicSyncOutputWidgets = function () {
        const toggle = getToolWidget(this, OUTPUT_TOGGLE);
        const saving = !!(toggle && toggle.value);
        const fmt    = getToolWidget(this, FORMAT_WIDGET);
        const showFps = saving && isVideoFormat(this, fmt && fmt.value);
        for (const name of OUTPUT_CFG_WIDGETS) {
            const show = (name === FPS_WIDGET) ? showFps : saving;
            setWidgetVisible(this, getToolWidget(this, name), show);
        }
        const sz = this.computeSize();
        this.setSize([Math.max(this.size[0], sz[0]), sz[1]]);
        this.setDirtyCanvas?.(true, true);
    };

    // Reveal outputs to match the current stores (grow-only).
    nodeType.prototype.bepicSyncToolOutputs = function () {
        let desired = 0;
        if (storeHasRoto(this)) desired = Math.max(desired, 1);
        if (storeHasPoints(this)) desired = Math.max(desired, 3);
        if (storeHasBoxes(this)) desired = Math.max(desired, 5);
        if (desired > 0) ensureOutputsAtLeast(this, desired);
    };

    // After a workflow load, re-hide widgets, guarantee the image output, and
    // reconcile the optional outputs with the stored tool data.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
        const r = onConfigure?.apply(this, arguments);
        this._bepicOutputSpecs = specs;
        this._bepicVideoFormats = videoFormats;
        // Old workflows saved the node with no outputs — make sure `image` is
        // present so the passthrough is always wirable.
        if (!Array.isArray(this.outputs) || this.outputs.length === 0) {
            this.addOutput(specs.image.name, specs.image.type);
        }
        hideWidget(this, getToolWidget(this, ROTO_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_POS_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_NEG_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_BOX_POS_WIDGET));
        hideWidget(this, getToolWidget(this, SAM3_BOX_NEG_WIDGET));
        // Idempotent — a node restored from a workflow may or may not have gone
        // through onNodeCreated first, depending on the frontend version.
        resyncOnChange(this, OUTPUT_TOGGLE);
        resyncOnChange(this, FORMAT_WIDGET);
        this.bepicSyncToolOutputs?.();
        this.bepicSyncOutputWidgets?.();
        return r;
    };
}

// Resolve the bEpicSendToViewer node that feeds a given viewer tab key.
export function resolveSendNodeForTab(panel, tabKey) {
    if (!panel || !tabKey) return null;
    const id = panel.tabSourceNodeIds ? panel.tabSourceNodeIds[tabKey] : null;
    if (id == null) return null;
    const node = app.graph.getNodeById(id);
    if (node && node.type === BEPIC_SEND_NODE) return node;
    return null;
}
