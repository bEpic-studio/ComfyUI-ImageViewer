// bEpicViewer_sendFromNode.js
// Canvas context-menu bridge: right-click any loader node → "Send to Image Viewer".
//
// The entry appears on any node holding a media file in a widget — the VHS
// loaders (upload and "(Path)" variants), the native LoadImage / LoadVideo, and
// third-party loaders that name their widget something else — and is hidden on
// nodes with nothing to show, so it costs nothing on the rest of the graph.
//
// The media is resolved server-side (/bepic/resolve_media), which knows how to
// turn what the node holds into real files:
//   • "clip.mp4" / "sub/img.png [output]"  → looked up under ./input|output|temp
//   • an absolute OS path                  → used as-is (VHS "(Path)" loaders)
//   • a directory                          → expanded to the whole image
//     sequence, honouring the node's skip / cap / every-nth trim widgets
//   • an explicit file list                → the AYON container loaders, whose
//     media lives in a JSON blob rather than a path widget
// It hands back the same frame dicts bEpicSendToViewer pushes over the
// websocket, so the viewer displays them through its normal path.
//
// Nodes with no file of their own — a VAE Decode, an upscaler, a Save Image —
// take the other route: their upstream branch is queued once and the result is
// captured. See runBranchToViewer.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|exr|dpx|tga|hdr|svg|ico)$/i;
const VID_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|mpe?g|wmv|flv)$/i;

// Widget names loaders keep their media in, most specific first — a node with
// both `video` and `path` widgets should be read from `video`.
const MEDIA_WIDGETS = [
    "video", "video_path", "video_file", "image", "image_path", "images",
    "file", "file_path", "filepath", "path", "filename", "directory", "folder",
];

// Widgets whose value is a folder, not a file: any non-empty string qualifies
// (there is no extension to sanity-check).
const DIR_WIDGETS = new Set(["directory", "folder"]);

// VHS sequence-trimming widgets, mirrored so the viewer shows the same frames
// the node will actually load.
const TRIM_WIDGETS = { skip: "skip_first_images", cap: "image_load_cap", every: "select_every_nth" };

// The AYON (Ynput) container loaders keep their media in a JSON blob instead of
// a path widget:  { name, image_upload_info: [{name, subfolder}], ... }, every
// entry uploaded into ComfyUI's ./input.
const AYON_WIDGET      = "ayon_container_info";
const AYON_VIDEO_NODE  = "AYON Load Video";        // loads only the first entry
const AYON_SKIP_NODES  = new Set(["AYON Load 3D Model"]);   // nothing to show

// Slot types the viewer can display. A node carrying one of these can be sent
// even with no file of its own, by running the branch that feeds it.
const VIEWABLE_TYPES = new Set(["IMAGE", "MASK", "VIDEO"]);

// This extension's own node, used as a throwaway sink in the queued prompt.
const SEND_NODE = "bEpicSendToViewer";
let sinkSeq = 0;

// ComfyUI annotates combo filenames with their source dir: "mask.png [input]".
function stripAnnotation(value) {
    const m = /^(.*?)\s*\[(\w+)\]\s*$/.exec(value);
    return m ? { value: m[1].trim(), type: m[2].toLowerCase() }
             : { value: value.trim(), type: "" };
}

function widgetString(w) {
    return (w && typeof w.value === "string") ? w.value.trim() : "";
}

function looksLikeMedia(w) {
    const raw = widgetString(w);
    if (!raw) return false;
    if (DIR_WIDGETS.has(w.name)) return true;
    const { value } = stripAnnotation(raw);
    return IMG_EXT.test(value) || VID_EXT.test(value);
}

/** The widget holding this node's media, or null when it has none. */
export function findMediaWidget(node) {
    const widgets = (node && node.widgets) || [];
    for (const name of MEDIA_WIDGETS) {
        const w = widgets.find((x) => x && x.name === name);
        if (w && looksLikeMedia(w)) return w;
    }
    // Catch-all for loaders naming their widget something we don't know about.
    return widgets.find((w) => w && looksLikeMedia(w)) || null;
}

/** The files an AYON container loader holds, or null when it isn't one. */
export function findAyonMedia(node) {
    if (!node || AYON_SKIP_NODES.has(node.type)) return null;
    const w = ((node.widgets) || []).find((x) => x && x.name === AYON_WIDGET);
    const raw = widgetString(w);
    if (!raw) return null;

    let container = null;
    try { container = JSON.parse(raw); } catch (_) { return null; }
    let infos = container && container.image_upload_info;
    if (!Array.isArray(infos) || infos.length === 0) return null;

    // "AYON Load Video" only ever loads the first entry, so show just that one.
    if (node.type === AYON_VIDEO_NODE) infos = infos.slice(0, 1);

    // Entries are ./input-relative {subfolder, name}, already forward-slashed.
    const files = infos
        .map((i) => [i && i.subfolder, i && i.name].filter(Boolean).join("/"))
        .filter(Boolean);
    if (files.length === 0) return null;

    // The product name reads far better on a tab than a hashed filename.
    return { files, type: "input", label: container.name || node.title || "" };
}

/** Where to capture a branch run from, or null when the node shows nothing.
 *
 * Normally the node's own first viewable output. Terminal nodes (Save Image,
 * Preview Image) have no output slots at all, so they fall back to the link
 * feeding their first viewable input — which shows what they would write.
 */
export function findViewableTarget(node) {
    const title = (node && (node.title || node.type)) || "node";
    const viewable = (t) => VIEWABLE_TYPES.has(String(t || "").toUpperCase());

    const outputs = (node && node.outputs) || [];
    for (let i = 0; i < outputs.length; i++) {
        if (outputs[i] && viewable(outputs[i].type)) {
            return { nodeId: node.id, slot: i, title };
        }
    }
    for (const input of (node && node.inputs) || []) {
        if (!input || input.link == null || !viewable(input.type)) continue;
        const link = app.graph && app.graph.links && app.graph.links[input.link];
        if (!link || link.origin_id == null) continue;
        return { nodeId: link.origin_id, slot: link.origin_slot || 0, title };
    }
    return null;
}

/** What this node has to show, in whichever shape it stores it, or null.
 *
 * A file the node already points at always wins over running the graph — it is
 * instant and can't fail — so branch execution is the last resort.
 */
function findMediaSource(node) {
    const ayon = findAyonMedia(node);
    if (ayon) return ayon;
    const widget = findMediaWidget(node);
    if (widget) return { widget };
    const target = findViewableTarget(node);
    return target ? { target } : null;
}

function trimValues(node) {
    const out = { skip: 0, cap: 0, every: 1 };
    const widgets = (node && node.widgets) || [];
    for (const [key, name] of Object.entries(TRIM_WIDGETS)) {
        const w = widgets.find((x) => x && x.name === name);
        const n = w ? parseInt(w.value, 10) : NaN;
        if (Number.isFinite(n)) out[key] = n;
    }
    return out;
}

// The request body + what to call the media in an error message, for either
// source shape (a path widget, or an AYON container's file list).
function resolveRequest(node, source) {
    if (source.files) {
        return {
            body:  { files: source.files, type: source.type || "input", label: source.label || "" },
            shown: source.label || source.files[0],
        };
    }
    const { value, type } = stripAnnotation(widgetString(source.widget));
    return {
        body:  { value, type, hint: source.widget.name || "", ...trimValues(node) },
        shown: value,
    };
}

// ── Branch execution (nodes with no file of their own) ───────────────────────

// Everything upstream of `rootId` in an API-format prompt. Queueing only this
// runs the branch feeding the node and nothing else — the workflow's other
// output nodes (Save Image, VHS Video Combine, …) are left out, so sending a
// node to the viewer never writes files as a side effect.
function pruneToUpstream(output, rootId) {
    const keep = new Set();
    const stack = [String(rootId)];
    while (stack.length) {
        const id = stack.pop();
        if (keep.has(id) || !output[id]) continue;
        keep.add(id);
        for (const value of Object.values(output[id].inputs || {})) {
            // API-format links are [originId, slotIndex]; widget values aren't.
            if (Array.isArray(value) && value.length === 2 &&
                typeof value[1] === "number" && output[String(value[0])]) {
                stack.push(String(value[0]));
            }
        }
    }
    const pruned = {};
    keep.forEach((id) => { pruned[id] = output[id]; });
    return pruned;
}

// Run the branch feeding `target` once through the ComfyUI queue and show the
// result. A bEpicSendToViewer sink is added to the *queued prompt only* — never
// to the graph — so the user's workflow, undo history and node ids are
// untouched, and the sink's own id keys the update back to this request.
async function runBranchToViewer(node, target, ctx) {
    const panel = ctx.getPanel && ctx.getPanel();
    if (!panel) { console.warn("[bEpicViewer] viewer panel not ready"); return; }

    let prompt = null;
    try {
        prompt = await app.graphToPrompt();
    } catch (e) {
        console.error("[bEpicViewer] graphToPrompt failed", e);
        alert(`bEpic Viewer – could not read the workflow.\n${e.message || e}`);
        return;
    }

    const output = (prompt && prompt.output) || {};
    const rootId = String(target.nodeId);
    if (!output[rootId]) {
        alert(`bEpic Viewer – "${target.title}" is not part of the prompt.\n` +
              `It may be muted, bypassed, or a node that never executes.`);
        return;
    }

    const pruned = pruneToUpstream(output, rootId);
    // Non-numeric, so it can never collide with a graph node id; the counter
    // keeps two clicks in the same millisecond apart.
    const sinkId = `bepic_view_${Date.now()}_${++sinkSeq}`;
    pruned[sinkId] = {
        class_type: SEND_NODE,
        _meta: { title: "bEpic Send To Image Viewer" },
        inputs: {
            input:           [rootId, target.slot],
            tab_name:        "",
            save_to_output:  false,
            file_format:     "png",
            fps:             24.0,
            filename_prefix: "bEpic",
        },
    };

    panel.registerInlineSend(sinkId, { sourceNodeId: node.id, label: target.title });
    if (ctx.showPanel) ctx.showPanel();

    try {
        await api.queuePrompt(0, { output: pruned, workflow: prompt.workflow });
    } catch (e) {
        panel.cancelInlineSend(sinkId);
        const detail = e?.response?.error?.message || e?.response?.error ||
                       e?.message || e;
        console.error("[bEpicViewer] branch run failed", e);
        alert(`bEpic Viewer – could not run the branch feeding "${target.title}":\n${detail}`);
    }
}

async function sendNodeToViewer(node, source, ctx) {
    if (source.target) return runBranchToViewer(node, source.target, ctx);

    const panel = ctx.getPanel && ctx.getPanel();
    if (!panel) { console.warn("[bEpicViewer] viewer panel not ready"); return; }

    const { body, shown } = resolveRequest(node, source);
    if (!shown) return;

    let data = null;
    try {
        const resp = await api.fetchApi("/bepic/resolve_media", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(body),
        });
        data = await resp.json();
    } catch (e) {
        console.error("[bEpicViewer] resolve_media failed", e);
        alert(`bEpic Viewer – could not reach the server.\n${e.message || e}`);
        return;
    }

    if (!data || data.error || !Array.isArray(data.tabs) || data.tabs.length === 0) {
        const msg = (data && data.error) || "nothing to show";
        console.warn("[bEpicViewer] send to viewer:", msg);
        alert(`bEpic Viewer – could not open "${shown}":\n${msg}`);
        return;
    }
    // A partly-uploaded container still opens — say so rather than silently
    // showing fewer frames than the node will load.
    if (data.warning) console.warn("[bEpicViewer]", data.warning);

    if (ctx.showPanel) ctx.showPanel();
    panel.openNodeMedia(node, data.tabs);
}

/** Add the menu entry to a node type. Call from beforeRegisterNodeDef. */
export function registerSendToViewerMenu(nodeType, ctx) {
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        const r = getExtraMenuOptions?.apply(this, arguments);
        try {
            const source = findMediaSource(this);
            if (source && Array.isArray(options)) {
                options.push({
                    // Say so when picking this will queue work, so a heavy
                    // branch never runs as a surprise.
                    content:  source.target ? "Send to Image Viewer (run branch)"
                                            : "Send to Image Viewer",
                    callback: () => sendNodeToViewer(this, source, ctx),
                });
            }
        } catch (e) {
            console.warn("[bEpicViewer] could not build the node menu entry", e);
        }
        return r;
    };
}

// ── Panel side ───────────────────────────────────────────────────────────────

export const SendFromNodeMixin = {

    // Open the tabs resolved from a loader node. Keyed by node id, so sending
    // again after pointing the node at another file refreshes the same tab and
    // stacks the previous media in its history strip instead of piling up tabs.
    openNodeMedia(node, tabs) {
        if (!Array.isArray(tabs) || tabs.length === 0) return;

        let firstKey = null;
        tabs.forEach((tab, i) => {
            const frames = Array.isArray(tab.frames) ? tab.frames : [];
            if (frames.length === 0) return;
            const key = tabs.length > 1 ? `loader_${node.id}_${i}` : `loader_${node.id}`;

            if (this.pushHistorySnapshot(key, frames)) this.onHistoryPrepended?.(key);

            this.allTabs[key]           = frames;
            this.tabLabels[key]         = this._nodeMediaLabel(tab);
            this.tabSourceNodeIds[key]  = node.id;
            if (!firstKey) {
                firstKey = key;
                // Show the media just sent, not wherever the history strip was.
                this.currentHistoryKey   = key;
                this.currentHistoryIndex = 0;
                this.isViewingHistory    = false;
                this.previewBackup       = null;
                this.historyCompare      = null;
            }
        });
        if (!firstKey) return;

        const allKeys = Object.keys(this.allTabs);
        const known   = this.tabOrder.filter((k) => allKeys.includes(k));
        const added   = allKeys.filter((k) => !known.includes(k));
        this.tabOrder = [...known, ...added];

        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        this._rebuildTabBar(null);
        this.switchTab(firstKey);

        const panel = this.historyPanel || this.shadowRoot.getElementById("history-panel");
        if (panel) {
            panel.style.display   = "flex";
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this._syncHistoryToggleState?.();
        this.queuePersistViewerState();
    },

    _nodeMediaLabel(tab) {
        const icon = tab.kind === "video" ? "🎬" : (tab.kind === "sequence" ? "🎞" : "🖼");
        return `${icon} ${tab.label || "media"}`;
    },

    // ── Branch runs in flight ────────────────────────────────────────────────
    // A queued branch run reports back through the normal bepic.viewer.update
    // websocket message, keyed by the sink node's id. That sink only ever
    // existed inside the queued prompt, so these entries are what tells the
    // viewer which graph node the result belongs to.

    registerInlineSend(sinkId, info) {
        const pending = this._inlineSends || (this._inlineSends = {});
        // A branch that errored out never reports back; drop stale entries so
        // they don't accumulate over a long session.
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [id, entry] of Object.entries(pending)) {
            if (!entry || entry.at < cutoff) delete pending[id];
        }
        pending[String(sinkId)] = { ...info, at: Date.now() };
    },

    cancelInlineSend(sinkId) {
        if (this._inlineSends) delete this._inlineSends[String(sinkId)];
    },

    /** Claim a viewer update produced by a branch run. True when it was ours,
     *  so the caller skips the normal graph-node mirroring for a sink that has
     *  no node in the graph to mirror. */
    consumeInlineSend(detail) {
        const key = String(detail && detail.unique_id);
        const pending = this._inlineSends && this._inlineSends[key];
        if (!pending) return false;
        delete this._inlineSends[key];

        const frames = [];
        Object.values((detail && detail.tabs) || {}).forEach((arr) => {
            if (Array.isArray(arr)) frames.push(...arr);
        });
        if (frames.length === 0) return true;   // ours, but nothing came back

        const kind = frames[0] && frames[0].kind === "video" ? "video"
                   : (frames.length > 1 ? "sequence" : "image");
        this.openNodeMedia({ id: pending.sourceNodeId },
                           [{ label: pending.label, kind, frames }]);
        return true;
    },
};
