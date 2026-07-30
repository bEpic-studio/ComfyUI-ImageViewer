// bEpicViewer_mixinPlayback.js
// Playback, timeline, frame navigation, zoom helpers, image URL builder.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// ── Video RAM cache ──────────────────────────────────────────────────────────
// Streaming an mp4 off the ComfyUI server means a range request every time the
// decoder runs low on data, and a fresh one after every loop, scrub and seek.
// Those round-trips share an event loop with prompt execution, so they arrive
// late in bursts and the playhead visibly hitches. Pulling the file into memory
// once and playing from a blob: URL takes the server out of the playback path
// altogether — after the first read the decoder never waits on I/O again.

const VIDEO_RAM_BUDGET   = 1536 * 1024 * 1024;   // total bytes held across clips
const VIDEO_RAM_MAX_FILE = 512  * 1024 * 1024;   // stream anything bigger
const RAM_CACHE_PREF_KEY = "bEpicViewer:ramCache:v1";

const _videoRam        = new Map();   // url -> {blobUrl, bytes}; insertion order = LRU
const _videoRamPending = new Map();   // url -> in-flight fetch promise
// Clips purged while their download was still running. The job checks this when
// it lands so a clip the user just dropped isn't quietly cached again.
const _videoRamAbandoned = new Set();

// Revoking a blob: URL only drops the NAME. A <video> that already loaded from it
// keeps the data alive, so freeing memory means handing that element back its
// streaming URL first — otherwise the cache reports the clip as gone while the
// bytes are still resident, which is what made purging look like it did nothing.
// Panels register how to do that here, so every revoke path (eviction, purge,
// targeted drop, Clear Cache) goes through the same step.
const _detachHooks = new Set();

export function registerVideoDetachHook(fn) {
    _detachHooks.add(fn);
    return () => _detachHooks.delete(fn);
}

function _detachBlob(blobUrl) {
    for (const fn of _detachHooks) { try { fn(blobUrl); } catch (e) {} }
}

function _revokeEntry(entry) {
    if (!entry) return;
    _detachBlob(entry.blobUrl);
    try { URL.revokeObjectURL(entry.blobUrl); } catch (e) {}
}

function _videoRamGet(url) {
    const hit = _videoRam.get(url);
    if (!hit) return null;
    _videoRam.delete(url);            // re-insert so it counts as most-recently used
    _videoRam.set(url, hit);
    return hit.blobUrl;
}

// Drop least-recently-used clips until the cache is back inside its budget. The
// LRU entry can be the one on screen, so this has to go through _revokeEntry or
// the budget becomes fiction: the map shrinks and the memory stays.
function _videoRamEvict() {
    let total = 0;
    for (const entry of _videoRam.values()) total += entry.bytes;
    for (const [url, entry] of _videoRam) {
        if (total <= VIDEO_RAM_BUDGET) break;
        _revokeEntry(entry);
        _videoRam.delete(url);
        total -= entry.bytes;
    }
}

function _videoRamFetch(url) {
    const inFlight = _videoRamPending.get(url);
    if (inFlight) return inFlight;
    const job = (async () => {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers.get("content-length") || 0);
        if (declared > VIDEO_RAM_MAX_FILE) throw new Error("clip too large to cache");
        const blob = await res.blob();
        if (blob.size > VIDEO_RAM_MAX_FILE) throw new Error("clip too large to cache");
        const blobUrl = URL.createObjectURL(blob);
        // Purged mid-download: hand the memory straight back rather than filling
        // the cache the user just emptied.
        if (_videoRamAbandoned.delete(url)) {
            try { URL.revokeObjectURL(blobUrl); } catch (e) {}
            throw new Error("clip purged while downloading");
        }
        _videoRam.set(url, { blobUrl, bytes: blob.size });
        _videoRamEvict();
        return blobUrl;
    })();
    _videoRamPending.set(url, job);
    job.catch(() => {}).then(() => _videoRamPending.delete(url));
    return job;
}

// Frame URLs the browser has decoded at least once this session. Those come back
// from its image cache (a 304 at worst) instead of a full re-download, which is
// what the timeline's green bar reports for sequences.
const _loadedFrameUrls = new Set();
// Bumped whenever that set grows, so the timeline can tell in O(1) whether a
// rescan of the current sequence could possibly produce a different answer.
let _loadedEpoch = 0;

function _markFrameLoaded(url) {
    if (!url || _loadedFrameUrls.has(url)) return false;
    _loadedFrameUrls.add(url);
    _loadedEpoch++;
    return true;
}

// Release every cached clip. Called by Clear Cache, which deletes the temp files
// these blobs were read from.
export function clearVideoRamCache() {
    for (const url of _videoRamPending.keys()) _videoRamAbandoned.add(url);
    for (const entry of _videoRam.values()) _revokeEntry(entry);
    _videoRam.clear();
    _videoRamPending.clear();
    _loadedFrameUrls.clear();
    _loadedEpoch++;          // invalidates every timeline's cached-frame scan
}

// How much memory the clip cache is holding, for the purge button's label.
export function videoRamStats() {
    let bytes = 0;
    for (const entry of _videoRam.values()) bytes += entry.bytes;
    return { clips: _videoRam.size, bytes, budget: VIDEO_RAM_BUDGET };
}

// Release specific clips — the ones behind history entries or tabs that just went
// away. Anything not cached is skipped, so passing image URLs (thumbnails, still
// frames) simply drops them from the decoded-frames set that feeds the timeline's
// green bar. Callers must re-point any live <video> off these blobs FIRST; see
// _dropRamForUrls.
export function dropVideoRamUrls(urls) {
    let bytes = 0, clips = 0, frames = 0;
    for (const url of urls) {
        const hit = _videoRam.get(url);
        if (hit) {
            _revokeEntry(hit);
            _videoRam.delete(url);
            bytes += hit.bytes;
            clips++;
        }
        if (_videoRamPending.has(url)) _videoRamAbandoned.add(url);
        if (_loadedFrameUrls.delete(url)) frames++;
    }
    if (clips || frames) _loadedEpoch++;   // the cached-frame bar has to rescan
    return { clips, bytes, frames };
}

export const PlaybackMixin = {

    // ── Image URL builder ────────────────────────────────────────────────────

    // Frames served by our own routes get a STABLE url — those routes send
    // `Cache-Control: no-cache` plus an ETag, so the browser revalidates and
    // still picks up an overwritten file, while an unchanged frame costs a 304
    // instead of a full re-decode. A per-call timestamp here would defeat
    // _setImgSrcCached and re-fetch every frame on each pass through a sequence,
    // which is what made playback and wipe-compare stutter.
    //
    // The /view fallback is ComfyUI's own route and sends no Cache-Control, so it
    // keeps the cache-buster rather than risk a stale frame. Only path-less
    // frames (a workflow's own SaveImage output) land there, so nothing the
    // viewer itself writes pays that cost.
    buildImgUrl(imgObj) {
        if (!imgObj) return '';
        // Dropped OS files are served straight from an in-memory blob: URL — it is
        // already unique per file, so never rewrite it.
        if (imgObj.url) return imgObj.url;
        if (imgObj.path) {
            const endpoint = imgObj.external ? '/bepic/view_file' : '/bepic/raw_view';
            return api.apiURL(`${endpoint}?path=${encodeURIComponent(imgObj.path)}`);
        }
        let params = `?filename=${encodeURIComponent(imgObj.filename || '')}`;
        if (imgObj.type)     params += `&type=${imgObj.type}`;
        if (imgObj.subfolder) params += `&subfolder=${encodeURIComponent(imgObj.subfolder)}`;
        params += `&t=${Date.now()}`;
        return api.apiURL(`/view${params}`);
    },

    // Point a <video> at `url`, preferring the in-RAM copy. A clip that isn't
    // cached yet streams exactly as before and swaps over to the blob the moment
    // the download lands — keeping its position and play state — so playback
    // starts instantly and turns smooth rather than stalling on a full download.
    _setVideoSrc(v, url) {
        if (!v || !url) return;
        // Bound here rather than at setup so it is impossible for this panel to be
        // holding a cached clip the cache can't hand back before revoking it.
        this._bindVideoDetachHook();
        v.dataset.srcKey = url;

        // Caching turned off in the toolbar — always stream. (Read through the
        // accessor so a panel that never loaded the preference still defaults on.)
        if (!this.isVideoRamCacheEnabled()) {
            // preload="auto" tells the browser to pull the whole file into ITS
            // memory, which is the thing the toggle is supposed to stop. Asking
            // for metadata only is what actually keeps a clip out of RAM; the
            // cost is the range requests that caching exists to avoid.
            v.preload = "metadata";
            if (v.src !== url) v.src = url;
            return;
        }
        v.preload = "auto";

        const cached = _videoRamGet(url);
        if (cached) { if (v.src !== cached) v.src = cached; return; }

        if (v.src !== url) v.src = url;
        _videoRamFetch(url).then((blobUrl) => {
            if (!blobUrl) return;
            this._syncPurgeRamButton();   // the cache just grew — keep the readout live
            // Bail if the element moved on to another clip, or caching was turned
            // off, while we were downloading.
            if (!this.isVideoRamCacheEnabled()) return;
            if (v.dataset.srcKey !== url || v.src === blobUrl) return;
            this._reSourceVideo(v, blobUrl, () => {
                // The blob wouldn't decode here (an undocked popout resolving a
                // blob from another document, say) — go back to streaming.
                if (v.dataset.srcKey === url) v.src = url;
            });
        }).catch(() => { /* keep streaming — the direct URL is already playing */ });
    },

    // Re-point a <video> at another URL for the SAME clip without losing where it
    // was. `onFail` runs if the new source won't load.
    _reSourceVideo(v, url, onFail) {
        const resumeAt   = v.currentTime;
        const wasPlaying = !v.paused;
        // Tells _videoOnMeta this is the same clip re-sourced, not a new one, so
        // it doesn't re-fit the view and throw away the user's zoom/pan.
        v._bepicRamSwap = true;
        const settle = (ok) => {
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("error", onErr);
            v._bepicRamSwap = false;
            if (!ok) { if (onFail) onFail(); return; }
            try { v.currentTime = resumeAt; } catch (e) {}
            if (wasPlaying) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
        };
        const onMeta = () => settle(true);
        const onErr  = () => settle(false);
        v.addEventListener("loadedmetadata", onMeta);
        v.addEventListener("error", onErr);
        v.src = url;
    },

    // ── RAM cache toggle ─────────────────────────────────────────────────────

    isVideoRamCacheEnabled() { return this.videoRamCacheEnabled !== false; },

    loadVideoRamCachePref() {
        let on = true;
        try {
            const raw = window.localStorage.getItem(RAM_CACHE_PREF_KEY);
            if (raw !== null) on = raw === "1";
        } catch (e) {}
        this.videoRamCacheEnabled = on;
        this._syncRamCacheButton();
    },

    _syncRamCacheButton() {
        const btn = this.ramCacheBtn;
        if (btn) {
            const on = this.isVideoRamCacheEnabled();
            btn.classList.toggle("active", on);
            btn.title = on
                ? "Video RAM cache: on — clips play from memory (click to stream instead)"
                : "Video RAM cache: off — clips stream from the server (click to cache in RAM)";
        }
        this._syncPurgeRamButton();
    },

    // The purge button doubles as the readout for how much is resident, so it is
    // refreshed wherever the cache changes size.
    _syncPurgeRamButton() {
        const btn = this.purgeRamBtn;
        if (!btn) return;
        const { clips, bytes, budget } = videoRamStats();
        btn.classList.toggle("empty", clips === 0);
        btn.title = clips === 0
            ? "Purge video RAM cache — nothing cached right now"
            : `Purge video RAM cache — ${clips} clip${clips === 1 ? "" : "s"}, ` +
              `${this._formatRamBytes(bytes)} of ${this._formatRamBytes(budget)}`;
    },

    toggleVideoRamCache() {
        this.videoRamCacheEnabled = !this.isVideoRamCacheEnabled();
        try { window.localStorage.setItem(RAM_CACHE_PREF_KEY, this.videoRamCacheEnabled ? "1" : "0"); }
        catch (e) {}
        this._syncRamCacheButton();

        if (!this.videoRamCacheEnabled) {
            const before = videoRamStats();
            // Stop the browser pre-buffering the clips that are already loaded —
            // dropping our copy while it keeps slurping the whole file into its own
            // buffer is why turning this off looked like it changed nothing.
            [this.videoBase, this.videoCompare].forEach((v) => { if (v) v.preload = "metadata"; });
            this._releaseVideoRam();
            this._notify(before.clips
                ? `Video RAM cache off — ${this._formatRamBytes(before.bytes)} released`
                : "Video RAM cache off — clips now stream from the server");
        } else {
            // Re-run the source setup for whatever is on screen so the current
            // clips get pulled into RAM straight away instead of only the next one.
            [this.videoBase, this.videoCompare].forEach((v) => {
                if (v && v.dataset && v.dataset.srcKey && v.style.display !== "none") {
                    this._setVideoSrc(v, v.dataset.srcKey);
                }
            });
        }
        this._invalidateCacheBar();
        this.updateCacheBar();
    },

    // Hand the memory back. The cache re-points any live <video> off a blob before
    // revoking it, through the detach hook registered below, so this is just the
    // clear — and so eviction and targeted drops get the same protection.
    _releaseVideoRam() {
        clearVideoRamCache();
    },

    // Called by the cache for each blob about to be revoked. A <video> still
    // holding that blob keeps its bytes alive, so it has to be handed back its
    // streaming URL — and told not to immediately re-buffer the whole file, which
    // would put back the memory the purge just reclaimed.
    _detachFromBlob(blobUrl) {
        [this.videoBase, this.videoCompare].forEach((v) => {
            if (!v || v.src !== blobUrl) return;
            const stream = v.dataset && v.dataset.srcKey;
            if (!stream || stream === blobUrl) return;
            v.preload = "metadata";
            this._reSourceVideo(v, stream);
        });
    },

    _bindVideoDetachHook() {
        if (this._videoDetachUnhook) return;
        this._videoDetachUnhook = registerVideoDetachHook((blobUrl) => this._detachFromBlob(blobUrl));
    },

    // Short confirmation for actions whose whole point is the thing you can't see.
    // ComfyUI's toast when it's reachable, the console otherwise.
    _notify(text) {
        try {
            const toast = app && app.extensionManager && app.extensionManager.toast;
            if (toast && typeof toast.add === "function") {
                toast.add({ severity: "success", summary: "bEpic Viewer", detail: text, life: 2500 });
                return;
            }
        } catch (e) {}
        console.info(`[bEpicViewer] ${text}`);
    },

    // ── Purging the RAM cache ─────────────────────────────────────────────────
    // The cache holds whole clips, so a long session can accumulate more than the
    // user wants resident even under the LRU budget. Two ways out: the toolbar's
    // purge button (everything), and dropping a clip's copy when the history entry
    // or tab that referenced it goes away.

    videoRamUsage() { return videoRamStats(); },

    _formatRamBytes(bytes) {
        const mb = (bytes || 0) / (1024 * 1024);
        if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    },

    // Toolbar button: drop every cached clip, keeping playback alive.
    purgeVideoRam() {
        const before = videoRamStats();
        this._releaseVideoRam();
        this._invalidateCacheBar();
        this.updateCacheBar();
        this._syncRamCacheButton();
        this._notify(before.clips
            ? `Purged ${before.clips} clip${before.clips === 1 ? "" : "s"} — ${this._formatRamBytes(before.bytes)} freed`
            : "Nothing was cached — no video memory to free");
        return before;
    },

    // Every URL a frame array refers to, posters included — a video's thumbnail is
    // a separate temp file and counts towards what the timeline reports as local.
    _framesToUrls(frames) {
        const out = [];
        const push = (fr) => {
            if (!fr) return;
            if (Array.isArray(fr)) { fr.forEach(push); return; }   // a whole history stack
            try { const u = this.buildImgUrl(fr); if (u) out.push(u); } catch (e) {}
            if (fr.thumb && !/^(data:|blob:)/.test(fr.thumb)) {
                try { out.push(this.buildImgUrl({ path: fr.thumb, type: "temp" })); } catch (e) {}
            }
        };
        push(frames);
        return out;
    },

    // Files still referenced by a tab, by a remaining history entry, or by the
    // backup of a tab being previewed. Purging one of these would throw away a
    // copy that is still in use, so they're excluded from a targeted drop.
    _ramUrlsStillInUse() {
        const keep = new Set();
        const add  = (frames) => { for (const u of this._framesToUrls(frames)) keep.add(u); };
        for (const key of Object.keys(this.allTabs || {})) add(this.allTabs[key]);
        for (const key of Object.keys(this.history || {})) add(this.history[key]);
        if (this.previewBackup) add(this.previewBackup);
        return keep;
    },

    // Release the cached copies behind `frames`. Call it AFTER removing the entry
    // from this.history / this.allTabs, so the in-use scan no longer sees it.
    purgeRamForFrames(frames) {
        const urls = this._framesToUrls(frames);
        if (urls.length === 0) return { clips: 0, bytes: 0, frames: 0 };
        const keep = this._ramUrlsStillInUse();
        return this._dropRamForUrls(urls.filter(u => !keep.has(u)));
    },

    _dropRamForUrls(urls) {
        if (!urls || urls.length === 0) return { clips: 0, bytes: 0, frames: 0 };
        // A clip playing from one of these blobs is re-pointed by the detach hook
        // before its blob is revoked, so nothing here has to guard for that.
        const freed = dropVideoRamUrls(new Set(urls));
        if (freed.clips || freed.frames) {
            this._invalidateCacheBar();
            this.updateCacheBar();
            this._syncRamCacheButton();
        }
        return freed;
    },

    // Thumbnail URL for a frame. Video frames carry an extracted `thumb` PNG
    // because an <img> (history strip) can't render the video file itself.
    thumbUrl(imgObj) {
        if (imgObj && imgObj.thumb) {
            // A dropped video's poster is an inline data:/blob: URL, not a temp path.
            if (/^(data:|blob:)/.test(imgObj.thumb)) return imgObj.thumb;
            return this.buildImgUrl({ path: imgObj.thumb, type: "temp" });
        }
        return this.buildImgUrl(imgObj);
    },

    // ── Shape info overlay ───────────────────────────────────────────────────

    updateShapeInfo() {
        if (!this.showShape) { this.shapeOverlay.style.display = "none"; return; }
        if (this.imgBase.naturalWidth) {
            this.shapeOverlay.style.display = "block";
            const batchSize = this.getImgCount();
            const { naturalWidth: w, naturalHeight: h } = this.imgBase;
            let text = `Tensor Shape: [${batchSize}, ${h}, ${w}, 3]`;
            if (batchSize === 1) text += " [Still Frame]";
            this.shapeOverlay.innerText = text;
        } else {
            this.shapeOverlay.style.display = "none";
        }
    },

    // ── Tab / image count helpers ────────────────────────────────────────────

    getImgCount() {
        // A video tab holds a single frame dict but scrubs over many frames.
        if (this._videoMode && this._videoFrames > 0) return this._videoFrames;
        return (this._baseFrames() || []).length;
    },

    getActiveTabNode() {
        const key = this.activeTab;
        if (!key) return null;
        if (key.startsWith('send_')) return app.graph.getNodeById(key.slice(5)) || null;
        if (key.startsWith('tab')) {
            const idx = parseInt(key.replace('tab', '')) - 1;
            const vn  = this.viewerNode;
            if (!vn || !vn.inputs) return null;
            const inp = vn.inputs[idx];
            if (!inp || inp.link == null) return null;
            const link = app.graph.links[inp.link];
            if (!link) return null;
            return app.graph.getNodeById(link.origin_id) || null;
        }
        return null;
    },

    // ── Timeline bounds / range ──────────────────────────────────────────────

    getTimelineBounds(imgCount = this.getImgCount()) {
        if (this.isInputRangeLocked && this.lockedTimelineRange) {
            const start = Math.max(0, Math.floor(this.lockedTimelineRange.start));
            const end   = Math.max(start, Math.floor(this.lockedTimelineRange.end));
            return { min: start, max: end };
        }
        return { min: 0, max: Math.max(0, imgCount - 1) };
    },

    isShowingTrimmedSequence(imgCount = this.getImgCount()) {
        if (!this.isInputRangeLocked || !this.playbackRange) return false;
        const start = Math.max(0, Math.floor(this.playbackRange.start));
        const end   = Math.max(start, Math.floor(this.playbackRange.end));
        return imgCount <= Math.max(1, end - start + 1);
    },

    displayFrameToImageIndex(displayFrame, imgCount = this.getImgCount()) {
        if (imgCount <= 0) return 0;
        if (this.isInputRangeLocked && this.playbackRange && this.isShowingTrimmedSequence(imgCount)) {
            const start       = Math.max(0, Math.floor(this.playbackRange.start));
            const clampedDisp = Math.max(start, Math.min(Math.floor(displayFrame), this.playbackRange.end));
            return Math.max(0, Math.min(clampedDisp - start, imgCount - 1));
        }
        return Math.max(0, Math.min(Math.floor(displayFrame), imgCount - 1));
    },

    imageIndexToDisplayFrame(imgIndex, imgCount = this.getImgCount()) {
        if (this.isInputRangeLocked && this.playbackRange && this.isShowingTrimmedSequence(imgCount)) {
            return Math.max(0, Math.floor(this.playbackRange.start)) + imgIndex;
        }
        return imgIndex;
    },

    applyTimelineBounds(imgCount = this.getImgCount()) {
        const bounds           = this.getTimelineBounds(imgCount);
        this.timeline.min      = bounds.min;
        this.timeline.max      = bounds.max;
        this.container.querySelector('#total-f').innerText = bounds.max;
        this.updateTicks(Math.max(0, bounds.max - bounds.min));
        this.updateRangeOverlay(imgCount);
        this._invalidateCacheBar();        // segment percentages are bounds-relative
        this.updateCacheBar();
        // Keep roto keyframe ticks + curve editor aligned to new timeline bounds.
        if (this._toolState && this._toolState.active === 'roto') {
            this._rotoRenderTimelineKeys && this._rotoRenderTimelineKeys();
            this._rotoRefreshKfEditor && this._rotoRefreshKfEditor();
        }
        return bounds;
    },

    updateRangeOverlay(imgCount = this.getImgCount()) {
        const rangeEl = this.container.querySelector('#timeline-range');
        if (!rangeEl || !this.playbackRange) { if (rangeEl) rangeEl.style.display = 'none'; return; }

        const bounds      = this.getTimelineBounds(imgCount);
        const totalFrames = Math.max(0, bounds.max - bounds.min);
        const start = Math.max(bounds.min, Math.min(bounds.max, this.playbackRange.start));
        const end   = Math.max(start, Math.min(bounds.max, this.playbackRange.end));
        const leftPct  = totalFrames === 0 ? 0   : ((start - bounds.min) / totalFrames) * 100;
        const widthPct = totalFrames === 0 ? 100 : ((end - start) / totalFrames) * 100;

        rangeEl.style.display = 'block';
        rangeEl.style.left    = `${leftPct}%`;
        rangeEl.style.width   = `${widthPct}%`;
    },

    // ── Ticks ────────────────────────────────────────────────────────────────

    updateTicks(count) {
        const ticksContainer = this.container.querySelector('#timeline-ticks');
        if (!ticksContainer) return;

        // Fast-path: skip if tick count hasn't changed
        if (ticksContainer.dataset.lastCount === String(count)) return;
        ticksContainer.dataset.lastCount = String(count);

        if (count <= 0) { ticksContainer.innerHTML = ''; return; }

        const step = count > 500 ? Math.ceil(count / 500) : 1;
        const frag = document.createDocumentFragment();
        for (let i = 0; i <= count; i += step) {
            const tick = document.createElement('div');
            tick.className = 'tick' + ((i % 5 === 0) ? ' major' : '');
            frag.appendChild(tick);
        }
        ticksContainer.innerHTML = '';
        ticksContainer.appendChild(frag);
    },

    // ── Timeline event setup ─────────────────────────────────────────────────

    setupTimelineEvents() {
        const container = this.shadowRoot.getElementById('timeline-container');
        const rangeEl   = this.shadowRoot.getElementById('timeline-range');

        container.onmousedown = (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            e.stopPropagation();

            this.isSelectingRange = true;
            const rect        = container.getBoundingClientRect();
            const bounds      = this.getTimelineBounds();
            const totalFrames = Math.max(0, bounds.max - bounds.min);
            const startX      = e.clientX - rect.left;
            const startPct    = Math.max(0, Math.min(1, startX / rect.width));
            const startFrame  = bounds.min + Math.round(startPct * totalFrames);

            this.playbackRange = { start: startFrame, end: startFrame };
            rangeEl.style.display = 'block';
            rangeEl.style.left    = `${totalFrames === 0 ? 0 : ((startFrame - bounds.min) / totalFrames) * 100}%`;
            rangeEl.style.width   = '0%';

            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                const currentPct   = Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width));
                const currentFrame = bounds.min + Math.round(currentPct * totalFrames);
                const min = Math.min(startFrame, currentFrame);
                const max = Math.max(startFrame, currentFrame);
                this.playbackRange = { start: min, end: max };
                const leftPct  = totalFrames === 0 ? 0 : ((min - bounds.min) / totalFrames) * 100;
                const widthPct = totalFrames === 0 ? 0 : ((max - min) / totalFrames) * 100;
                rangeEl.style.left  = `${leftPct}%`;
                rangeEl.style.width = `${widthPct}%`;
            };

            const onUp = () => {
                win.removeEventListener('mousemove', onMove);
                win.removeEventListener('mouseup',   onUp);
                this.isSelectingRange = false;
                if (this.playbackRange.start === this.playbackRange.end) {
                    this.playbackRange = null;
                    rangeEl.style.display = 'none';
                }
                if (this.isInputRangeLocked) { this.applyTimelineBounds(); this.syncInputRange(); }
            };

            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── View refresh ─────────────────────────────────────────────────────────

    refreshView() {
        const imgs = this._baseFrames();
        if (!imgs) return;
        this.applyTimelineBounds(imgs.length);
        const bounds    = this.getTimelineBounds(imgs.length);
        const safeFrame = Math.max(bounds.min, Math.min(this.currentFrame, bounds.max));
        this.setFrame(safeFrame);
    },

    // ── Frame display ─────────────────────────────────────────────────────────

    // Frames driving the base layer: the pinned snapshot while comparing two
    // history items, otherwise the active tab.
    _baseFrames() {
        const hc = this.historyCompare;
        if (hc) return (this.history[hc.key] && this.history[hc.key][hc.baseIdx]) || null;
        return this.allTabs[this.activeTab] || null;
    },

    // Frames driving the compare layer: the second pinned snapshot while
    // comparing history items, otherwise the compare tab. Having both sources
    // resolve here is what lets history compare reuse the whole tab-compare
    // path — video routing, aspect matching and the wipe seam included.
    _compareFrames() {
        const hc = this.historyCompare;
        if (hc) return (this.history[hc.key] && this.history[hc.key][hc.otherIdx]) || null;
        if (!this.compareTab) return null;
        return this.allTabs[this.compareTab] || null;
    },

    setFrame(idx) {
        const imgs = this._baseFrames();
        if (!imgs || imgs.length === 0) { this._exitVideoMode(); this.updateCacheBar(); return; }

        // Video tab: a single {kind:"video"} entry scrubbed through the <video>.
        // Still refresh the compare slot so a video base shows the second tab in
        // the wipe (the early return used to skip the compare update below).
        if (this._frameIsVideo(imgs[0])) {
            this._videoSeek(idx, imgs[0]);
            this._updateCompareFrame(this.currentFrame);
            return;
        }
        this._exitVideoMode();

        const imgIdx = this.displayFrameToImageIndex(idx, imgs.length);
        if (!imgs[imgIdx]) return;
        this.currentFrame = this.imageIndexToDisplayFrame(imgIdx, imgs.length);

        const i       = imgs[imgIdx];
        const baseUrl = this.buildImgUrl(i);

        // Only update src when URL actually changes (avoids re-decode flicker)
        this._setImgSrcCached(this.imgBase, baseUrl, () => {
            if (this.updateImageFrame) this.updateImageFrame();
            if (this.updateShapeInfo) this.updateShapeInfo();
            if (this.updateToolOverlay) this.updateToolOverlay();
            // The aspect-match scale is derived from BOTH media sizes, so the
            // base decoding last has to re-derive it too — otherwise whichever
            // layer loaded first keeps a scale computed against a missing size.
            this._syncCompareLayout();
        });

        // Path bar
        if (this.pathBar) {
            if (i.external && i.path) {
                this.pathBar.textContent = i.path;
                this.pathBar.title       = i.path;
                this.pathBar.style.display = 'block';
            } else {
                this.pathBar.style.display = 'none';
            }
        }

        this._updateCompareFrame(this.currentFrame);

        this.timeline.value = this.currentFrame;
        this.container.querySelector('#cur-f').innerText = this.currentFrame;
        if (this.imgBase.naturalWidth) this.updateShapeInfo();
        // Roto keyframes are frame-dependent — refresh the overlay on scrub/play.
        if (this._toolState && this._toolState.active === "roto") {
            this._rotoRefreshKfInfo && this._rotoRefreshKfInfo();
            this._toolRedraw && this._toolRedraw();
        }
    },

    // Load the compare source's frame into the compare slot. Called from both the
    // image and video base paths so either base still fills the wipe/split/contact
    // with the second media. Images go to the compare <img>; a video is routed to
    // the dedicated compare <video> (an <img> can't decode a video).
    _updateCompareFrame(displayFrame) {
        if (!this.isComparing) { this._hideCompareVideo(); return; }
        const compImgs = this._compareFrames();
        if (!compImgs || compImgs.length === 0) { this._hideCompareVideo(); return; }

        // Video compare tab → drive the compare <video>.
        if (this._frameIsVideo(compImgs[0])) { this._compareVideoSync(displayFrame, compImgs[0]); return; }

        // Image compare tab → drive the compare <img>, hide the compare video.
        this._hideCompareVideo();
        if (this.imgCompare) this.imgCompare.style.display = "block";
        const compIdx = this.displayFrameToImageIndex(displayFrame, compImgs.length);
        const o = compImgs[compIdx];
        if (!o) return;
        this._setImgSrcCached(this.imgCompare, this.buildImgUrl(o), () => {
            if (this.updateImageFrame) this.updateImageFrame();
            // Compare image size is known now → align its frame to the base's and
            // re-derive the wipe seam against the aligned box.
            this._syncCompareLayout();
        });
    },

    // Show the compare tab's video in the compare <video>, seeking it to the same
    // frame index as the base. While playing it runs natively (rate matched to the
    // base fps) for smoothness; when paused/scrubbing it seeks by currentTime.
    _compareVideoSync(displayFrame, vObj) {
        const v = this.videoCompare;
        if (!v) return;
        const key = vObj.path || vObj.filename || "";
        const keyChanged = v.dataset.key !== key;
        if (keyChanged) {
            v.dataset.key = key;
            v.loop  = true;
            v.muted = true;
            if (!v._cmpHandlersBound) {
                v.addEventListener("loadedmetadata", () => {
                    if (!this.isComparing) return;
                    if (!(this._compareVideoFrames > 0) && v.duration) {
                        this._compareVideoFrames = Math.max(1, Math.round(v.duration * (this._compareVideoFps || 24)));
                    }
                    // videoWidth/Height are known now → recompute the aspect-match
                    // scale and re-derive the wipe seam against the new box.
                    this._syncCompareLayout();
                    // Re-seek: a currentTime set before metadata loaded is ignored.
                    this._updateCompareFrame(this.currentFrame);
                });
                // A <video> fires `resize` whenever its intrinsic size becomes
                // known or changes — including a swap to the RAM-cached copy, which
                // doesn't necessarily re-run the metadata path above. This is the
                // one signal that can't be missed, whatever order the two layers
                // decode in, so the aspect match can't be left computed against a
                // size of 0.
                v.addEventListener("resize", () => this._syncCompareLayout());
                v._cmpHandlersBound = true;
            }
            this._setVideoSrc(v, this.buildImgUrl(vObj));
            this._compareVideoFps    = (vObj.fps && vObj.fps > 0) ? vObj.fps : (this.fps || 24);
            this._compareVideoFrames = (vObj.frames && vObj.frames > 0) ? vObj.frames : 0;
        }

        // Reveal the compare video, hide the compare <img>. Sync its transform +
        // clip on reveal and whenever the clip itself changes — a different clip
        // means a different aspect-match scale, and swapping between two already
        // decoded compare tabs fires no load event to recompute it. Ongoing
        // changes flow through updateTransform / the slider drag, so scrubbing and
        // playback don't re-run layout every frame.
        const wasHidden = v.style.display === "none";
        if (this.imgCompare) this.imgCompare.style.display = "none";
        v.style.display = "block";
        if (wasHidden || keyChanged) this._syncCompareLayout();

        const fps = this._compareVideoFps || 24;
        if (this.isPlaying) {
            this._compareVideoEnsurePlaying();
            let wantT = displayFrame / fps;
            // Keep the target inside the compare clip's own timeline so a shorter,
            // looping compare video isn't seeked past its end (which fights the
            // native loop and stutters).
            if (v.loop && v.duration) wantT = ((wantT % v.duration) + v.duration) % v.duration;
            // Once it's playing natively at a matched rate, correct only genuine
            // drift. Nudging every timeupdate makes the freely-running compare video
            // stutter, so tolerate ~0.5s before re-seeking.
            if (Math.abs((v.currentTime || 0) - wantT) > 0.5) { try { v.currentTime = wantT; } catch (e) {} }
        } else {
            try { v.pause(); } catch (e) {}
            let frame = Math.floor(displayFrame);
            if (this._compareVideoFrames > 0) frame = Math.max(0, Math.min(frame, this._compareVideoFrames - 1));
            try { v.currentTime = frame / fps; } catch (e) {}
        }
    },

    // Play the compare video in lockstep with the base: rate = base fps / native
    // fps so one base frame advances one compare frame in real time.
    _compareVideoEnsurePlaying() {
        const v = this.videoCompare;
        if (!v) return;
        const native = this._compareVideoFps || 24;
        let rate = (this.fps || native) / native;
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        rate = Math.max(0.0625, Math.min(16, rate));
        try { v.playbackRate = rate; } catch (e) {}
        if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },

    _hideCompareVideo() {
        const v = this.videoCompare;
        if (!v) return;
        try { v.pause(); } catch (e) {}
        v.style.display = "none";
    },

    // Only assign src when it has actually changed, to prevent redundant decodes.
    _setImgSrcCached(imgEl, url, onLoadCallback) {
        // The frame won't load — moved output, cleaned temp, a path this server
        // doesn't serve. Hand it to the history prune, which verifies with the
        // server before dropping anything, so a transient failure costs nothing.
        imgEl.onerror = () => { if (this.noteMediaLoadFailed) this.noteMediaLoadFailed(); };
        imgEl.onload = () => {
            // A frame that decoded once is in the browser's image cache — record
            // it so the timeline can show which part of a sequence is local.
            _markFrameLoaded(url);
            if (this.updateCacheBar) this.updateCacheBar();
            if (onLoadCallback) onLoadCallback();
        };
        if (imgEl.src !== url) { imgEl.src = url; return; }
        // Unchanged src means no load event fires, so record it — and run the
        // callback anyway. The layer is already decoded, so whatever the caller
        // derives from its size (aspect match, wipe seam, side-by-side layout) is
        // computable right now, and skipping it left the compare layer scaled for
        // the media it replaced. URLs are stable for path-based frames, so this is
        // the normal case when re-showing a frame, not a rare one.
        if (imgEl.complete && imgEl.naturalWidth) {
            _markFrameLoaded(url);
            if (onLoadCallback) onLoadCallback();
        }
    },

    // ── Cached-frame indicator ────────────────────────────────────────────────

    // Which parts of the current media are held locally, as [firstFrame, lastFrame]
    // pairs in display-frame space. For a video this is the browser's own buffered
    // ranges — a clip served from the RAM cache reports its full duration almost
    // at once. For a sequence it is the frames already decoded this session.
    _cachedSegments() {
        const segs = [];
        if (this._videoMode && this.videoBase) {
            const fps = this._videoFps || 24;
            let ranges = null;
            try { ranges = this.videoBase.buffered; } catch (e) { return segs; }
            if (!ranges) return segs;
            for (let i = 0; i < ranges.length; i++) {
                let a, b;
                try { a = ranges.start(i); b = ranges.end(i); } catch (e) { continue; }
                segs.push([Math.floor(a * fps), Math.ceil(b * fps) - 1]);
            }
            return segs;
        }

        const imgs = this._baseFrames();
        if (!imgs || imgs.length === 0) return segs;
        // Walk the sequence and coalesce runs of decoded frames into segments.
        let runStart = -1;
        for (let i = 0; i < imgs.length; i++) {
            const local = _loadedFrameUrls.has(this.buildImgUrl(imgs[i]));
            if (local && runStart < 0) runStart = i;
            if (!local && runStart >= 0) {
                segs.push([this.imageIndexToDisplayFrame(runStart, imgs.length),
                           this.imageIndexToDisplayFrame(i - 1, imgs.length)]);
                runStart = -1;
            }
        }
        if (runStart >= 0) {
            segs.push([this.imageIndexToDisplayFrame(runStart, imgs.length),
                       this.imageIndexToDisplayFrame(imgs.length - 1, imgs.length)]);
        }
        return segs;
    },

    // Force the next updateCacheBar to recompute from scratch. Called whenever
    // the media or the timeline bounds change under the bar.
    _invalidateCacheBar() {
        this._cacheBarSig = null;
        this._cacheBarGuard = null;
    },

    updateCacheBar() {
        const bar = this.cacheBar;
        if (!bar) return;
        const imgCount = this.getImgCount();
        const bounds   = this.getTimelineBounds(imgCount);
        const span     = bounds.max - bounds.min;

        // A single still has no timeline to speak of — the bar would just be a
        // full-width block that says nothing.
        if (imgCount <= 1 || span <= 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

        // Scanning a sequence costs a URL build per frame, and this runs on every
        // played frame — so for sequences, bail unless something that could change
        // the answer actually moved. A video's buffered ranges are a handful of
        // entries that grow on their own, so those always recompute.
        if (this._videoMode) {
            this._cacheBarGuard = null;
        } else {
            const hc = this.historyCompare;
            const source = hc ? `${hc.key}:${hc.baseIdx}` : String(this.activeTab);
            const guard = `${_loadedEpoch}|${source}|${bounds.min}-${bounds.max}|${imgCount}`;
            if (guard === this._cacheBarGuard) return;
            this._cacheBarGuard = guard;
        }

        const parts = [];
        for (const [from, to] of this._cachedSegments()) {
            const a = Math.max(bounds.min, Math.min(bounds.max, from));
            const b = Math.max(bounds.min, Math.min(bounds.max, to));
            if (b < a) continue;
            // Frames are points on the slider, but each covers a slot on screen, so
            // the last one is drawn a whole frame wide instead of collapsing to 0%.
            const left  = ((a - bounds.min) / span) * 100;
            const width = ((b - a + 1) / span) * 100;
            parts.push([left, Math.min(width, 100 - left)]);
        }

        const sig = parts.map(p => `${p[0].toFixed(3)}:${p[1].toFixed(3)}`).join('|');
        if (sig === this._cacheBarSig) return;      // nothing moved, skip the rebuild
        this._cacheBarSig = sig;

        if (parts.length === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
        const frag = document.createDocumentFragment();
        for (const [left, width] of parts) {
            const seg = document.createElement('i');
            seg.style.left  = `${left}%`;
            seg.style.width = `${width}%`;
            frag.appendChild(seg);
        }
        bar.innerHTML = '';
        bar.appendChild(frag);
        bar.style.display = 'block';
    },

    // ── Video playback ────────────────────────────────────────────────────────
    // A "save to ./output" node writing mp4/mov/webm sends the viewer a single
    // {kind:"video", fps, frames} entry. The <video> element decodes it and is
    // driven by the same transport (play/timeline/step) and zoom/pan as images.

    _frameIsVideo(o) {
        return !!(o && (o.kind === "video" ||
            /\.(mp4|m4v|mov|webm|mkv)$/i.test(o.path || o.filename || "")));
    },

    _enterVideoMode(imgObj) {
        const v = this.videoBase;
        if (!v) return;
        // Key on the stable path, not the cache-busted URL — otherwise every
        // scrub would look like a new source and reload the whole video.
        const key = imgObj.path || imgObj.filename || "";
        if (this._videoMode && this._videoKey === key) return;   // already showing
        const wasVideo = this._videoMode;
        const url = this.buildImgUrl(imgObj);

        this._videoMode   = true;
        this._videoKey    = key;
        this._invalidateCacheBar();   // different clip -> different buffered ranges
        this._videoFps    = (imgObj.fps && imgObj.fps > 0) ? imgObj.fps : (this.fps || 24);
        this._videoFrames = (imgObj.frames && imgObj.frames > 0) ? imgObj.frames : 0;

        // The FPS field reflects the video's rate while it plays; remember the
        // user's setting (once, on the image→video transition) so switching to
        // another history item / image restores it.
        if (!wasVideo) this._savedFps = this.fps;
        this._setFpsUi(this._videoFps);

        if (this.imgBase)    this.imgBase.style.display = "none";
        // Keep the compare overlay up when comparing — the video is the base layer
        // and the compare <img> wipes over it.
        if (this.imgCompare) this.imgCompare.style.display = this.isComparing ? "block" : "none";
        if (this.imgFrame)   this.imgFrame.style.display = "none";
        v.style.display = "block";
        v.loop  = (this.loopMode === "loop" || this.loopMode === "ping-pong");
        v.muted = false;

        if (!this._videoHandlersBound) {
            v.addEventListener("timeupdate",     () => this._videoOnTimeUpdate());
            v.addEventListener("loadedmetadata", () => this._videoOnMeta());
            v.addEventListener("ended",          () => this._videoOnEnded());
            // The base's decoded size feeds the compare layer's aspect match, and
            // `resize` is the one event that always fires when it becomes known —
            // including on a RAM-cache swap, and when the clip was already loaded
            // before compare mode was switched on.
            v.addEventListener("resize",         () => this._syncCompareLayout());
            // `progress` is how the browser reports buffering advancing — the only
            // signal that grows the green bar while a clip downloads.
            v.addEventListener("progress",       () => this.updateCacheBar());
            v.addEventListener("suspend",        () => this.updateCacheBar());
            // A clip the server won't serve any more fails here rather than in an
            // <img>. Skipped during a RAM swap: that failure is about the blob, not
            // about the file, and _reSourceVideo already falls back to streaming.
            v.addEventListener("error", () => {
                if (v._bepicRamSwap || !this._videoMode) return;
                if (v.getAttribute("src") && this.noteMediaLoadFailed) this.noteMediaLoadFailed();
            });
            this._videoHandlersBound = true;
        }
        this._setVideoSrc(v, url);
        this._applyVideoPlaybackRate();

        this.updateTransform();
        if (this.setImageFilter) this.setImageFilter();
        if (this.pathBar && imgObj.path) {
            this.pathBar.textContent = imgObj.path;
            this.pathBar.title       = imgObj.path;
            this.pathBar.style.display = "block";
        }
        if (this._videoFrames > 0) this.applyTimelineBounds(this._videoFrames);
    },

    _exitVideoMode() {
        if (!this._videoMode) return;
        this._videoMode = false;
        this._videoKey  = null;
        this._videoFrames = 0;
        this._invalidateCacheBar();
        const v = this.videoBase;
        if (v) {
            try { v.pause(); } catch (e) {}
            v.removeAttribute("src");
            v.dataset.srcKey = "";      // cancels any in-flight RAM-cache swap
            try { v.load(); } catch (e) {}
            v.style.display = "none";
        }
        if (this.imgBase)    this.imgBase.style.display = "";
        if (this.imgCompare) this.imgCompare.style.display = this.isComparing ? "block" : "none";
        // Restore the FPS field to the user's setting from before the video.
        if (this._savedFps != null) { this._setFpsUi(this._savedFps); this._savedFps = null; }
    },

    // Set the playback fps and reflect it in the #fps-in field.
    _setFpsUi(value) {
        this.fps = value;
        const el = this.shadowRoot && this.shadowRoot.getElementById("fps-in");
        if (el) el.value = Number.isInteger(value) ? value : Math.round(value * 1000) / 1000;
    },

    _videoSeek(idx, imgObj) {
        this._enterVideoMode(imgObj);
        const fps = this._videoFps || 24;
        let frame = Math.floor(idx);
        frame = this._videoFrames > 0 ? Math.max(0, Math.min(frame, this._videoFrames - 1))
                                      : Math.max(0, frame);
        this.currentFrame = frame;
        try { this.videoBase.currentTime = frame / fps; } catch (e) {}
        if (this.timeline) this.timeline.value = frame;
        const curEl = this.container && this.container.querySelector("#cur-f");
        if (curEl) curEl.innerText = frame;
    },

    _videoOnMeta() {
        const v = this.videoBase;
        if (!this._videoMode || !v) return;
        if (!(this._videoFrames > 0)) {
            this._videoFrames = Math.max(1, Math.round((v.duration || 0) * (this._videoFps || 24)));
        }
        this.applyTimelineBounds(this._videoFrames);
        // A RAM-cache swap re-fires loadedmetadata for the clip already on screen;
        // re-fitting there would yank the user's zoom/pan back mid-playback.
        if (!v._bepicRamSwap) this.fitView();
        this._applyVideoPlaybackRate();
        if (this.timeline) this.timeline.value = this.currentFrame || 0;
        // The base video's decoded size is known only now. The compare aspect-match
        // scale (and the side-by-side layout) both depend on it, so a compare frame
        // that decoded before the base would otherwise stay mis-scaled — one media
        // rendered larger than the other. Recompute them against the real base size.
        if (this.isComparing) {
            this._syncCompareLayout();
            this._updateCompareFrame && this._updateCompareFrame(this.currentFrame);
        }
    },

    _videoOnTimeUpdate() {
        const v = this.videoBase;
        if (!this._videoMode || !v) return;
        const fps = this._videoFps || 24;

        // Region playback (ctrl-drag selection on the timeline): keep the <video>
        // inside the selected range instead of playing the whole clip.
        if (this.isPlaying && this.playbackRange) {
            const startT = this.playbackRange.start / fps;
            const endT   = (this.playbackRange.end + 1) / fps;
            if (v.currentTime >= endT - 1e-3 || v.currentTime < startT - 1e-3) {
                if (this.loopMode === "once") {
                    this.stop();
                    try { v.currentTime = Math.max(startT, endT - 1 / fps); } catch (e) {}
                } else {
                    // loop + ping-pong both restart at the region start (a <video>
                    // can't scrub backwards smoothly, so ping-pong loops forward).
                    try { v.currentTime = startT; } catch (e) {}
                }
            }
        }

        const frame = Math.round((v.currentTime || 0) * fps);
        this.currentFrame = frame;
        if (this.timeline) this.timeline.value = frame;
        const curEl = this.container && this.container.querySelector("#cur-f");
        if (curEl) curEl.innerText = frame;
        this.updateCacheBar();
        // Native <video> playback doesn't go through setFrame, so advance the
        // compare overlay here to keep the wipe in sync while the video plays.
        this._updateCompareFrame(frame);
    },

    // Fired when the <video> plays past its end. If a region is active in a
    // looping mode the wrap in _videoOnTimeUpdate usually fires first, but when
    // the region ends on the last frame the clip can end naturally — restart it.
    _videoOnEnded() {
        const v = this.videoBase;
        if (!v) return;
        if (this._videoMode && this.isPlaying && this.playbackRange && this.loopMode !== "once") {
            const fps = this._videoFps || 24;
            try {
                v.currentTime = this.playbackRange.start / fps;
                const p = v.play();
                if (p && p.catch) p.catch(() => {});
            } catch (e) {}
            return;
        }
        if (!v.loop) this.stop();
    },

    // Drive <video> playback speed from the FPS field: rate = wanted / native, so
    // changing FPS re-times the clip (e.g. a 30-fps video at 60 plays 2× faster)
    // while the frame counter still maps through the native rate.
    _applyVideoPlaybackRate() {
        const v = this.videoBase;
        if (!v || !this._videoMode) return;
        const native = this._videoFps || 24;
        const want   = this.fps || native;
        let rate = want / native;
        if (!Number.isFinite(rate) || rate <= 0) rate = 1;
        rate = Math.max(0.0625, Math.min(16, rate));   // browsers reject extreme rates anyway
        try { v.playbackRate = rate; } catch (e) {}
    },

    // ── Playback ──────────────────────────────────────────────────────────────

    play() {
        this.stop();
        const count = this.getImgCount();
        if (count === 0) return;

        // Video tabs play through the browser's decoder; the timeline follows
        // via the <video>'s timeupdate events (see _enterVideoMode).
        if (this._videoMode && this.videoBase) {
            this.isPlaying = true;
            this._setIcon(this.playBtn, 'icon-pause');
            const v = this.videoBase;
            const fps = this._videoFps || 24;
            if (this.playbackRange) {
                // Region playback: manage looping manually (see _videoOnTimeUpdate),
                // and jump into the region if we're currently outside it.
                v.loop = false;
                const startT = this.playbackRange.start / fps;
                const endT   = (this.playbackRange.end + 1) / fps;
                if (v.currentTime < startT - 1e-3 || v.currentTime >= endT - 1e-3) {
                    try { v.currentTime = startT; } catch (e) {}
                }
            } else {
                v.loop = (this.loopMode === 'loop' || this.loopMode === 'ping-pong');
            }
            this._applyVideoPlaybackRate();
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
            // Kick the compare video now instead of waiting for the base's first
            // timeupdate (~250ms later), so a compared video pair starts together
            // rather than leaving the second clip frozen until the base ticks.
            if (this.isComparing) this._updateCompareFrame(this.currentFrame);
            return;
        }

        this.isPlaying        = true;
        this._setIcon(this.playBtn, 'icon-pause');

        const bounds = this.getTimelineBounds(count);
        let min = bounds.min;
        let max = bounds.max;

        if (this.playbackRange) {
            min = this.playbackRange.start;
            max = this.playbackRange.end;
            if (this.currentFrame < min || this.currentFrame > max) this.setFrame(min);
        }

        this.playbackInterval = setInterval(() => {
            let next = this.currentFrame + this.direction;
            if (this.loopMode === "ping-pong") {
                if (next >= max || next <= min) {
                    this.direction *= -1;
                    next = Math.max(min, Math.min(max, this.currentFrame + this.direction));
                }
            } else {
                if (next > max) {
                    if (this.loopMode === "loop") next = min; else { this.stop(); return; }
                } else if (next < min) {
                    if (this.loopMode === "loop") next = max; else { this.stop(); return; }
                }
            }
            this.setFrame(next);
        }, 1000 / this.fps);
    },

    stop() {
        this.isPlaying = false;
        this._setIcon(this.playBtn, 'icon-play');
        if (this.playbackInterval) clearInterval(this.playbackInterval);
        if (this._videoMode && this.videoBase) { try { this.videoBase.pause(); } catch (e) {} }
        if (this.videoCompare) { try { this.videoCompare.pause(); } catch (e) {} }
    },

    step(n) {
        this.stop();
        const c = this.getImgCount();
        if (!c) return;
        const bounds   = this.getTimelineBounds(c);
        const span     = Math.max(1, bounds.max - bounds.min + 1);
        const offset   = this.currentFrame - bounds.min;
        const wrapped  = ((offset + n) % span + span) % span;
        this.setFrame(bounds.min + wrapped);
    },

    // ── Fit view ──────────────────────────────────────────────────────────────

    fitView() {
        // Video tab: fit using the decoded video dimensions.
        if (this._videoMode && this.videoBase) {
            const vw = this.videoBase.videoWidth, vh = this.videoBase.videoHeight;
            if (!vw || !vh) return;
            try {
                const viewRect = this.viewport.getBoundingClientRect();
                const availW   = Math.max(10, viewRect.width  - 2);
                const availH   = Math.max(10, viewRect.height - 2);
                // Contact side-by-side fits the combined 2-wide canvas (both frames
                // scaled to a shared height), not just the base video — otherwise the
                // pair overflows and is cropped.
                const contactLayout = (this.sliderMode === 'contact' && this.getContactLayout) ? this.getContactLayout() : null;
                if (contactLayout) {
                    this.zoom = Math.max(0.05, Math.min(20.0, Math.min(availW / contactLayout.contW, availH / contactLayout.contH)));
                } else {
                    const contain  = Math.min(availW / vw, availH / vh);
                    const dispW = Math.max(1, vw * contain), dispH = Math.max(1, vh * contain);
                    const targetZoom = (availW / availH >= vw / vh) ? (availH / dispH) : (availW / dispW);
                    this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
                }
            } catch (e) { this.zoom = 1.0; }
            this.panX = 0; this.panY = 0;
            this.updateTransform();
            return;
        }
        if (!this.imgBase.naturalWidth) return;
        try {
            const viewRect = this.viewport.getBoundingClientRect();
            const availW   = Math.max(10, viewRect.width  - 2);
            const availH   = Math.max(10, viewRect.height - 2);

            const cmp = this._compareMediaSize ? this._compareMediaSize() : { w: this.imgCompare.naturalWidth, h: this.imgCompare.naturalHeight };
            const contactLayout = (this.sliderMode === 'contact' && this.getContactLayout) ? this.getContactLayout() : null;
            if (contactLayout) {
                // Side-by-side fits the whole combined canvas (both frames scaled to
                // a shared height, laid out in one row). Its width is ~2x a single
                // frame, so the fit zoom must be derived from that NEW resolution or
                // the pair overflows and gets cropped left/right.
                this.zoom = Math.max(0.05, Math.min(20.0, Math.min(availW / contactLayout.contW, availH / contactLayout.contH)));
            } else if (this.sliderMode === 'contact' && cmp.w) {
                const groupW     = this.imgBase.naturalWidth  + cmp.w;
                const groupH     = Math.max(this.imgBase.naturalHeight, cmp.h);
                this.zoom        = Math.max(0.05, Math.min(20.0, Math.min(availW / groupW, availH / groupH)));
            } else {
                const imgW = this.imgBase.naturalWidth;
                const imgH = this.imgBase.naturalHeight;

                const viewAspect = availW / availH;
                const imgAspect  = imgW / imgH;

                const containScale   = Math.min(availW / imgW, availH / imgH);
                const baseDisplayedW = Math.max(1, imgW * containScale);
                const baseDisplayedH = Math.max(1, imgH * containScale);

                const fitByHeight = viewAspect >= imgAspect;
                const targetZoom  = fitByHeight
                    ? (availH / baseDisplayedH)
                    : (availW / baseDisplayedW);

                this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
            }
            this.panX = 0;
            this.panY = 0;
            this.updateTransform();
        } catch (e) {
            this.panX = 0; this.panY = 0; this.zoom = 1.0; this.updateTransform();
        }
    },

    // Set zoom so the media displays at `fraction` of its ACTUAL pixel size
    // (1.0 = 100% = one image pixel per screen pixel, e.g. a 1920×1080 clip fills
    // 1920 screen px). Unlike fitView (relative to the viewport), this is relative
    // to the media's native resolution. Used by the zoom menu's 100/75/50% items.
    setPixelZoom(fraction) {
        if (!Number.isFinite(fraction) || fraction <= 0) fraction = 1;

        // Contact-compare packs two images into a container with its own transform
        // origin; "actual size" isn't well-defined there, so apply plainly.
        if (this.sliderMode === 'contact') {
            this.zoom = Math.max(0.05, Math.min(20.0, fraction));
            this.panX = 0; this.panY = 0; this.updateTransform();
            return;
        }

        let natW = 0, natH = 0;
        if (this._videoMode && this.videoBase) {
            natW = this.videoBase.videoWidth; natH = this.videoBase.videoHeight;
        } else if (this.imgBase) {
            natW = this.imgBase.naturalWidth; natH = this.imgBase.naturalHeight;
        }

        if (natW && natH && this.viewport) {
            const viewRect = this.viewport.getBoundingClientRect();
            const availW   = Math.max(10, viewRect.width  - 2);
            const availH   = Math.max(10, viewRect.height - 2);
            // The <img>/<video> uses max-width/height:100% (.img-layer) so at
            // zoom=1 it renders at min(natural, contain) — CSS never upscales.
            const containScale = Math.min(availW / natW, availH / natH);
            const renderScale  = Math.min(1, containScale);
            const targetZoom   = fraction / renderScale;   // displayed px = natural px × fraction
            this.zoom = Math.max(0.05, Math.min(20.0, targetZoom));
        } else {
            this.zoom = Math.max(0.05, Math.min(20.0, fraction));
        }
        this.panX = 0; this.panY = 0;
        this.updateTransform();
    },

    // ── Input range sync ─────────────────────────────────────────────────────

    toggleInputRange() {
        this.isInputRangeLocked = !this.isInputRangeLocked;
        this.rangeBtn?.classList.toggle("active", this.isInputRangeLocked);
        if (this.isInputRangeLocked) {
            const currentBounds = { min: 0, max: Math.max(0, this.getImgCount() - 1) };
            this.lockedTimelineRange = { start: currentBounds.min, end: currentBounds.max };
            if (!this.playbackRange) this.playbackRange = { start: currentBounds.min, end: currentBounds.max };
            this.applyTimelineBounds();
            this.updateRangeOverlay();
            this.syncInputRange();
        } else {
            this.restoreInputRange();
            this.lockedTimelineRange = null;
            this.applyTimelineBounds();
            this.updateRangeOverlay();
        }
    },

    restoreInputRange() {
        this.originalNodeValues.forEach((vals, id) => {
            const n = app.graph.getNodeById(id);
            if (n && n.widgets) {
                const s = n.widgets.find(w => w.name === "skip_first_frames");
                const c = n.widgets.find(w => w.name === "frame_load_cap");
                if (s) s.value = vals.skip;
                if (c) c.value = vals.cap;
                n.onResize?.(n.size);
            }
        });
        this.originalNodeValues.clear();
        app.graph.setDirtyCanvas(true, true);
    },

    syncInputRange() {
        if (!this.isInputRangeLocked) return;
        const nodes = app.graph._nodes.filter(n => {
            if (!n.widgets) return false;
            const hasSkip = n.widgets.some(w => w.name === "skip_first_frames");
            const hasCap  = n.widgets.some(w => w.name === "frame_load_cap");
            const isLoader = (n.type && n.type.toLowerCase().includes("loadvideo")) || (n.title && n.title.toLowerCase().includes("load video"));
            return hasSkip && hasCap && isLoader;
        });

        const start = this.playbackRange ? this.playbackRange.start : 0;
        const cap   = this.playbackRange ? this.playbackRange.end - this.playbackRange.start + 1 : 0;

        nodes.forEach(n => {
            const skipW = n.widgets.find(w => w.name === "skip_first_frames");
            const capW  = n.widgets.find(w => w.name === "frame_load_cap");
            if (!this.originalNodeValues.has(n.id)) {
                this.originalNodeValues.set(n.id, { skip: skipW ? skipW.value : 0, cap: capW ? capW.value : 0 });
            }
            if (skipW) skipW.value = start;
            if (capW)  capW.value  = cap;
            n.onResize?.(n.size);
        });
        app.graph.setDirtyCanvas(true, true);
    },
};
