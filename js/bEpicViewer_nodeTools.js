// bEpicViewer_nodeTools.js
// Node-side glue for every node type that owns a viewer tab, and for the two
// that also carry an in-viewer tool.
//
//     bEpicSendToViewer              – plain passthrough preview
//     bEpicImageViewerRoto           – + roto_mask, then the input passed through
//     bEpicImageViewerSAM3Collector  – + SAM3 point / box prompts
//
// The two tool nodes carry hidden STRING widgets that the viewer's tools write:
//     roto_data          – serialized roto layers                  (JSON)
//     sam3_positive      – normalized points [{x,y},...]           (JSON)
//     sam3_negative      – normalized points [{x,y},...]           (JSON)
//     sam3_box_positive  – normalized boxes [{x1,y1,x2,y2},...]    (JSON)
//     sam3_box_negative  – normalized boxes [{x1,y1,x2,y2},...]    (JSON)
//
// Their outputs are fixed and present from the moment the node is created.
// These used to be optional slots on bEpicSendToViewer that appeared once a
// tool had been used; a node that *is* the matte has nothing to reveal on
// demand, and having the slot there up front means you can wire the graph
// before drawing a single point.

import { app } from "../../scripts/app.js";

export const BEPIC_SEND_NODE = "bEpicSendToViewer";
export const BEPIC_ROTO_NODE = "bEpicImageViewerRoto";
export const BEPIC_SAM3_NODE = "bEpicImageViewerSAM3Collector";

// Tool kind → node type. The SAM3 points and boxes tools share one collector.
export const TOOL_NODE_TYPES = { roto: BEPIC_ROTO_NODE, sam3: BEPIC_SAM3_NODE };
const TOOL_NODE_KINDS = { [BEPIC_ROTO_NODE]: "roto", [BEPIC_SAM3_NODE]: "sam3" };

// Every node type that pushes its input into a viewer tab.
const SOURCE_NODES = [BEPIC_SEND_NODE, BEPIC_ROTO_NODE, BEPIC_SAM3_NODE];

export const ROTO_WIDGET = "roto_data";
export const SAM3_POS_WIDGET = "sam3_positive";
export const SAM3_NEG_WIDGET = "sam3_negative";
export const SAM3_BOX_POS_WIDGET = "sam3_box_positive";
export const SAM3_BOX_NEG_WIDGET = "sam3_box_negative";

const TOOL_WIDGETS = {
    roto: [ROTO_WIDGET],
    sam3: [SAM3_POS_WIDGET, SAM3_NEG_WIDGET, SAM3_BOX_POS_WIDGET, SAM3_BOX_NEG_WIDGET],
};

// "save to ./output" toggle and the config widgets it shows/hides.
export const OUTPUT_TOGGLE = "save_to_output";
export const FORMAT_WIDGET = "file_format";
export const FPS_WIDGET    = "fps";
export const OUTPUT_CFG_WIDGETS = [FORMAT_WIDGET, FPS_WIDGET, "filename_prefix"];

export function isViewerSourceNode(node) {
    return !!node && SOURCE_NODES.includes(node.type);
}

/** "roto" | "sam3" for a tool node, else null. */
export function nodeToolKind(node) {
    return (node && TOOL_NODE_KINDS[node.type]) || null;
}

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

// Write a JSON-able value into a hidden widget.
export function writeToolStore(node, name, value) {
    const w = getToolWidget(node, name);
    if (!w) return;
    w.value = typeof value === "string" ? value : JSON.stringify(value);
    node.setDirtyCanvas?.(true, true);
}

// ── viewer tab keys ──────────────────────────────────────────────────────────

/** The viewer tab a source node writes into: { key, label }, or null.
 *
 * One scheme for all three source types. An explicit tab_name groups every node
 * sharing that name into one tab; an empty one gives the node a tab of its own,
 * labelled after whatever feeds it. This is the single definition — the viewer's
 * ingest, its stale-tab sweep and its tab tinting all read it from here, so a
 * new source node type only has to be listed in SOURCE_NODES. */
export function senderTabInfo(node) {
    if (!isViewerSourceNode(node)) return null;

    let explicit = "";
    try {
        const w = (node.widgets || []).find((w) => w.name === "tab_name");
        explicit = w ? (w.value || "") : "";
    } catch (e) {}

    if (explicit) {
        const safe = explicit.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "").trim();
        return { key: `send_label_${safe || ("node_" + node.id)}`, label: explicit };
    }

    let derived = "";
    try {
        const linked = (node.inputs || []).find((inp) => inp.link);
        const link = linked ? app.graph.links[linked.link] : null;
        if (link) {
            const origin = app.graph.getNodeById(link.origin_id);
            derived = origin ? (origin.title || origin.type || link.origin_id) : link.origin_id;
        }
    } catch (e) {}

    return { key: `send_${node.id}`, label: derived || `Send ${node.id}` };
}

// ── node registration ────────────────────────────────────────────────────────

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

/** Register bEpicSendToViewer. Call from beforeRegisterNodeDef. */
export function registerSendNode(nodeType, nodeData) {
    const videoFormats = videoFormatsFromDef(nodeData);
    const outCount = ((nodeData && nodeData.output) || []).length;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = onNodeCreated?.apply(this, arguments);
        this._bepicVideoFormats = videoFormats;
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

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
        const r = onConfigure?.apply(this, arguments);
        this._bepicVideoFormats = videoFormats;
        // Workflows saved before the tools moved out carry roto_mask / SAM3
        // slots this node no longer has. Litegraph restores whatever was
        // serialized, so drop the extras rather than leave slots that can never
        // be filled — their links are dead either way, and a stale slot would
        // misalign the backend's output indices.
        if (Array.isArray(this.outputs) && this.outputs.length > outCount) {
            console.warn(
                `[bEpicViewer] "${this.title || BEPIC_SEND_NODE}" was saved with ` +
                `roto/SAM3 outputs; those moved to the Image Viewer Roto and ` +
                `SAM3 Collector nodes, so they have been removed.`);
            for (let i = this.outputs.length - 1; i >= outCount; i--) this.removeOutput(i);
        }
        if (!Array.isArray(this.outputs) || this.outputs.length === 0) {
            const types = (nodeData && nodeData.output) || [];
            const names = (nodeData && nodeData.output_name) || [];
            if (types.length) this.addOutput(names[0] || types[0], types[0]);
        }
        // Idempotent — a node restored from a workflow may or may not have gone
        // through onNodeCreated first, depending on the frontend version.
        resyncOnChange(this, OUTPUT_TOGGLE);
        resyncOnChange(this, FORMAT_WIDGET);
        this.bepicSyncOutputWidgets?.();
        return r;
    };
}

/** Register a tool node (kind "roto" | "sam3"). Call from beforeRegisterNodeDef.
 *
 * All these need is their stores kept out of sight: the outputs come straight
 * from the definition and never change. */
export function registerToolNode(nodeType, nodeData, kind) {
    const names = TOOL_WIDGETS[kind] || [];
    const hideStores = function () {
        for (const n of names) hideWidget(this, getToolWidget(this, n));
        const sz = this.computeSize();
        this.setSize([Math.max(this.size[0], sz[0]), sz[1]]);
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const r = onNodeCreated?.apply(this, arguments);
        hideStores.call(this);
        return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
        const r = onConfigure?.apply(this, arguments);
        hideStores.call(this);
        return r;
    };
}

// ── resolving / creating the node behind a tab ───────────────────────────────

/** The graph node backing a viewer tab, whatever its type (null if the tab is a
 * folder / dropped-file tab, or its node is gone). */
export function resolveTabNode(panel, tabKey) {
    if (!panel || !tabKey) return null;
    const id = panel.tabSourceNodeIds ? panel.tabSourceNodeIds[tabKey] : null;
    if (id == null) return null;
    return app.graph.getNodeById(id) || null;
}

// The output slot carrying a picture. bEpicSendToViewer's passthrough is typed
// ANY, so name and wildcard both count before falling back to the first slot.
//
// `strict` drops that last fallback, and the canvas selection always asks for
// it: a tab's node is something the viewer already drew a picture from, but a
// selection is whatever the user happened to click, and slot 0 of a checkpoint
// loader is a MODEL. Wiring that into an IMAGE input fails and leaves an
// orphaned tool node sitting in the graph.
function imageOutputSlot(node, { strict = false } = {}) {
    const outs = (node && node.outputs) || [];
    let i = outs.findIndex((o) => String(o.type).toUpperCase() === "IMAGE");
    if (i < 0) i = outs.findIndex((o) => /^image$/i.test(o.name || ""));
    if (i < 0) i = outs.findIndex((o) => o.type === "*");
    if (i < 0 && !strict && outs.length) i = 0;
    return i;
}

/** The { node, slot } a tool node hung off `node` should be fed from.
 *
 * Normally that is whatever the node itself hands on. A tool node is the
 * exception: it emits a matte or a prompt, never a picture, so hanging a second
 * tool off a Roto node wires the new one to the same upstream image the Roto
 * node is looking at rather than to the Roto node's own output. */
export function imageSourceForNode(node, opts) {
    if (!node) return null;

    if (nodeToolKind(node)) {
        try {
            const linked = (node.inputs || []).find((inp) => inp.link != null);
            const link = linked ? app.graph.links[linked.link] : null;
            const origin = link ? app.graph.getNodeById(link.origin_id) : null;
            if (origin) return { node: origin, slot: link.origin_slot };
        } catch (e) {}
        return null;
    }

    const slot = imageOutputSlot(node, opts);
    return slot < 0 ? null : { node, slot };
}

/** The { node, slot } a new tool node for this tab should be fed from. */
export function imageSourceForTab(panel, tabKey) {
    return imageSourceForNode(resolveTabNode(panel, tabKey));
}

// ── what the canvas has selected ─────────────────────────────────────────────

/** The selected graph nodes, the one the user touched last leading.
 *
 * `selected_nodes` is keyed by node id and those keys are numeric strings, so
 * Object.values hands them back in id order rather than the order they were
 * picked. `current_node` is the one clicked most recently, which is the one
 * "selected" means when several are. It only ever reorders a selection that
 * already exists — on its own it can be a leftover from a node the pointer
 * merely passed over, and that must not bind a tool to anything. */
function selectedGraphNodes() {
    const canvas = app.canvas;
    const nodes = Object.values((canvas && canvas.selected_nodes) || {}).filter(Boolean);
    const cur = canvas && canvas.current_node;
    if (cur && nodes.includes(cur)) return [cur, ...nodes.filter((n) => n !== cur)];
    return nodes;
}

/** A tool node of this kind picked on the canvas, if the user has one selected. */
function selectedToolNode(kind) {
    const type = TOOL_NODE_TYPES[kind];
    if (!type) return null;
    return selectedGraphNodes().find((n) => n.type === type) || null;
}

/** Where a tool node created right now should hang from: the selection. */
export function selectedImageSource() {
    for (const n of selectedGraphNodes()) {
        const src = imageSourceForNode(n, { strict: true });
        if (src) return src;
    }
    return null;
}

/** A value that changes whenever the set of selected nodes does. */
export function graphSelectionSignature() {
    try {
        return Object.keys((app.canvas && app.canvas.selected_nodes) || {}).sort().join(",");
    } catch (e) { return ""; }
}

/** Whether this exact node is still in the graph (not deleted or replaced). */
export function nodeInGraph(node) {
    if (!node) return false;
    try { return app.graph.getNodeById(node.id) === node; } catch (e) { return false; }
}

/** Whether `node`'s first input is wired to the node with this id. */
function isFedBy(node, srcNodeId) {
    const inp = ((node && node.inputs) || [])[0];
    if (!inp || inp.link == null) return false;
    const link = app.graph.links[inp.link];
    return !!link && String(link.origin_id) === String(srcNodeId);
}

// An existing tool node of this kind already fed by `srcNodeId`, if any. Keeps
// turning a tool on and off from reseeding the graph with duplicates.
function findToolNodeFedBy(kind, srcNodeId) {
    const type = TOOL_NODE_TYPES[kind];
    const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
    for (const n of nodes) {
        if (n && n.type === type && isFedBy(n, srcNodeId)) return n;
    }
    return null;
}

// Park the node to the right of its source, stepping down past anything already
// sitting there so a Roto and a SAM3 node added from the same image don't land
// on top of each other.
function placeBeside(node, src) {
    const [sx, sy] = src.pos || [0, 0];
    const x = sx + (src.size?.[0] || 200) + 60;
    let y = sy;
    const nodes = (app.graph && (app.graph._nodes || app.graph.nodes)) || [];
    for (let guard = 0; guard < 40; guard++) {
        const clash = nodes.some((n) => n !== node && n.pos
            && Math.abs(n.pos[0] - x) < 120 && Math.abs(n.pos[1] - y) < 90);
        if (!clash) break;
        y += (src.size?.[1] || 90) + 40;
    }
    node.pos = [x, y];
}

/** The tool node of `kind` the selection names, directly or through the node it
 * feeds — with no fallback to the tab and nothing created.
 *
 * This is the question the selection watcher asks. ensureToolNode below answers
 * a wider one, and the difference matters: clicking a KSampler has nothing to do
 * with roto, so it must leave the tool where it is rather than send it back to
 * whatever the tab holds, halfway through a shape. */
export function toolNodeFromSelection(kind) {
    const picked = selectedToolNode(kind);
    if (picked) return picked;
    const src = selectedImageSource();
    return src ? findToolNodeFedBy(kind, src.node.id) : null;
}

/** The tool node of `kind` that the viewer's tool reads and writes.
 *
 * The canvas selection leads. Select a Roto node and the tool edits that node's
 * shapes; select the node whose picture you want to matte and pressing the tool
 * button hangs a fresh Roto node off it. Only with nothing useful selected does
 * the tab decide — which is the case when you never touched the graph, or when
 * the viewer is undocked and the graph is behind another window. The SAM3
 * collector follows the same rule; the tools differ in what they store, not in
 * which node they store it in.
 *
 * In order:
 *   1. a tool node of this kind is selected              -> edit it
 *   2. one is already fed by the selected node           -> edit that
 *   3. `create` and a node is selected                   -> add one, hung off it
 *   4. the tab came from a tool node of this kind        -> edit it
 *   5. one is already fed by the tab's image             -> edit that
 *   6. `create`                                          -> add one, hung off
 *      the tab's image
 *
 * Steps 2 and 5 are what stop turning a tool on and off from reseeding the graph
 * with duplicates. Creation stays tied to the button press: binding also runs on
 * every tab switch and on every change of selection, and a viewer that quietly
 * grew a node each time you clicked around the graph would be a nasty surprise.
 *
 * Step 3 sits above the tab on purpose, and only when creating. Pressing the
 * button is a deliberate "put a tool on THAT node", so it acts on the selection
 * and nothing else — where a passive rebind that found nothing would rather show
 * the tab's own tool than an empty panel. */
export function ensureToolNode(panel, tabKey, kind, { create = false } = {}) {
    const type = TOOL_NODE_TYPES[kind];
    if (!type) return null;

    const picked = selectedToolNode(kind);
    if (picked) return picked;

    const tabNode = resolveTabNode(panel, tabKey);
    const tabIsTool = !!(tabNode && tabNode.type === type);

    const selSrc = selectedImageSource();
    if (selSrc) {
        // The tab's own node goes first among the nodes fed by the selection:
        // with two Roto nodes hanging off one image, selecting that image must
        // not swap you off the one you are looking at.
        if (tabIsTool && isFedBy(tabNode, selSrc.node.id)) return tabNode;
        const fed = findToolNodeFedBy(kind, selSrc.node.id);
        if (fed) return fed;
        if (create) return addToolNode(type, selSrc);
    }

    if (tabIsTool) return tabNode;

    const tabSrc = imageSourceForTab(panel, tabKey);
    if (tabSrc) {
        const fed = findToolNodeFedBy(kind, tabSrc.node.id);
        if (fed) return fed;
        if (create) return addToolNode(type, tabSrc);
    }

    return null;
}

/** Add a tool node to the graph, wired to `src` and left selected. */
function addToolNode(type, src) {
    const LG = window.LiteGraph;
    if (!LG || !LG.createNode) { console.warn("[bEpicViewer] LiteGraph unavailable"); return null; }
    const node = LG.createNode(type);
    if (!node) { console.warn("[bEpicViewer] could not create node", type); return null; }

    app.graph.add(node);
    placeBeside(node, src.node);
    try {
        src.node.connect(src.slot, node, 0);
    } catch (e) {
        console.warn("[bEpicViewer] could not connect the new tool node", e);
    }
    // Leave the new node selected. The rule is "the tool edits the node you have
    // selected", so the one just created has to become that node — otherwise the
    // next look at the selection would bind straight back to whatever was
    // selected before, and the drawing would go somewhere the user cannot see.
    try { app.canvas?.selectNode?.(node); } catch (e) {}
    app.graph.setDirtyCanvas?.(true, true);
    return node;
}
