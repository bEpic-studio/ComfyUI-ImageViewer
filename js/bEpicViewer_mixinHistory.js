// bEpicViewer_mixinHistory.js
// History panel: thumbnails, snapshots, folder loading, tab management.
import { api } from "../../scripts/api.js";

// Snapshots kept per tab. With clip caching on, this is also how many videos can
// be held in RAM by history alone, so falling off the end has to release them.
const HISTORY_LIMIT = 20;

// Collapse the burst of failures a rebuilt strip produces into one probe.
const PRUNE_DEBOUNCE_MS = 300;
// Gap before re-asking about a path the server just called unreachable. A
// snapshot can be pushed a beat before the file it names is fully on disk, and
// deleting on that race would throw away a perfectly good entry.
const PRUNE_CONFIRM_MS  = 1500;

export const HistoryMixin = {

    // ── History stack ────────────────────────────────────────────────────────

    // Prepend a snapshot, skipping an exact repeat of the newest one. Returns
    // whether anything was added. Every history push goes through here so the cap
    // is applied — and paid for — in one place.
    pushHistorySnapshot(key, snapshot) {
        const stack = this.history[key] || (this.history[key] = []);
        const json  = JSON.stringify(snapshot);
        if (stack.length > 0 && JSON.stringify(stack[0]) === json) return false;
        stack.unshift(JSON.parse(json));
        this.trimHistory(key);
        return true;
    },

    // Drop snapshots past the cap.
    trimHistory(key) {
        const stack = this.history[key];
        if (!Array.isArray(stack)) return;
        while (stack.length > HISTORY_LIMIT) stack.pop();
    },

    // ── Pruning snapshots whose files are gone ───────────────────────────────
    //
    // History outlives the files it points at: a temp dir that got cleaned, an
    // output root belonging to another machine. Those entries used to sit in the
    // strip as broken thumbnails that failed again on every redraw — and the
    // server logged a line for each one. They're now dropped silently instead.
    //
    // Nothing is removed on a guess. A file counts as gone only when the server
    // says so twice, so a request that fails outright (server restarting, offline)
    // or a snapshot that landed a beat ahead of its file leaves history intact.

    _probeSeen() {
        if (!this._probeGood) this._probeGood = new Set();
        if (!this._probeDead) this._probeDead = new Set();
        return { good: this._probeGood, dead: this._probeDead };
    },

    // Forget what was verified, so the next pass re-checks everything. Called when
    // a load actually fails: a path that probed healthy earlier clearly isn't now.
    resetHistoryProbeCache() {
        this._probeGood = new Set();
        this._probeDead = new Set();
    },

    // A media element failed to load. Re-verify rather than trust the cache, then
    // let the normal pass decide whether anything should actually go.
    noteMediaLoadFailed() {
        this.resetHistoryProbeCache();
        this.scheduleHistoryPrune();
    },

    scheduleHistoryPrune() {
        if (this._historyPruneTimer) return;
        this._historyPruneTimer = setTimeout(() => {
            this._historyPruneTimer = null;
            this.pruneMissingHistory();
        }, PRUNE_DEBOUNCE_MS);
    },

    // Walk every snapshot in history, handing each to `visit`.
    _eachSnapshot(visit) {
        for (const key of Object.keys(this.history || {})) {
            const stack = this.history[key];
            if (!Array.isArray(stack)) continue;
            for (const snapshot of stack) {
                if (Array.isArray(snapshot) && snapshot.length > 0) visit(snapshot, key);
            }
        }
    },

    // Frames without a `path` (a workflow's own SaveImage output, served by
    // ComfyUI's /view) and blob-backed dropped files aren't ours to judge, so
    // they're never probed and never pruned.
    _probeEntry(fr) {
        if (!fr || fr.url || !fr.path) return null;
        return { path: fr.path, external: !!fr.external };
    },

    _dedupeEntries(entries) {
        const { good, dead } = this._probeSeen();
        const seen = new Set();
        const out  = [];
        for (const e of entries) {
            if (!e || seen.has(e.path) || good.has(e.path) || dead.has(e.path)) continue;
            seen.add(e.path);
            out.push(e);
        }
        return out;
    },

    // The opening pass asks about the FIRST frame of each snapshot only. Probing
    // every frame would stat a whole sequence per snapshot — tens of thousands of
    // files across a full history, which is slow enough to notice on network
    // storage. Files disappear a directory at a time, so the first frame is a
    // reliable suspect; the frames behind it are only checked once it fails.
    _historyPathsToProbe() {
        const out = [];
        this._eachSnapshot((snapshot) => {
            const e = this._probeEntry(snapshot[0]);
            if (e) out.push(e);
        });
        return this._dedupeEntries(out);
    },

    // Every frame of the snapshots whose lead frame came back unreachable. This is
    // what makes "the whole snapshot is gone" the actual test rather than a guess
    // from one file.
    _pathsBehind(leadPaths) {
        const out = [];
        this._eachSnapshot((snapshot) => {
            const lead = this._probeEntry(snapshot[0]);
            if (!lead || !leadPaths.has(lead.path)) return;
            for (const fr of snapshot) {
                const e = this._probeEntry(fr);
                if (e) out.push(e);
            }
        });
        // Suspect paths are deliberately re-asked here, so skip the seen-cache.
        const seen = new Set();
        return out.filter(e => (seen.has(e.path) ? false : (seen.add(e.path), true)));
    },

    // Ask the server which of these it can't serve. Returns a Set of paths, or
    // null when the question couldn't be put — which is not the same answer as
    // "all fine", and callers must not treat it as one.
    async _probePaths(entries) {
        if (!entries || entries.length === 0) return new Set();
        try {
            const res = await fetch(api.apiURL('/bepic/probe_paths'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ paths: entries }),
            });
            if (!res.ok) return null;      // older server without the route
            const data = await res.json();
            const list = Array.isArray(data && data.unreachable) ? data.unreachable : [];
            return new Set(list.map(e => (e && typeof e === 'object') ? e.path : e).filter(Boolean));
        } catch (e) {
            return null;
        }
    },

    async pruneMissingHistory() {
        if (this._historyPruneInFlight) return;
        const entries = this._historyPathsToProbe();
        if (entries.length === 0) return;
        this._historyPruneInFlight = true;
        try {
            const { good, dead } = this._probeSeen();

            const missing = await this._probePaths(entries);
            if (!missing) return;
            for (const e of entries) if (!missing.has(e.path)) good.add(e.path);
            if (missing.size === 0) return;

            await new Promise(r => setTimeout(r, PRUNE_CONFIRM_MS));
            const suspects  = this._pathsBehind(missing);
            const confirmed = await this._probePaths(suspects);
            if (!confirmed || confirmed.size === 0) return;
            for (const e of suspects) {
                if (confirmed.has(e.path)) dead.add(e.path);
                else good.add(e.path);
            }

            this._removeHistoryEntriesFor(confirmed);
        } finally {
            this._historyPruneInFlight = false;
        }
    },

    _removeHistoryEntriesFor(missing) {
        let removed = 0;
        for (const key of Object.keys(this.history || {})) {
            const stack = this.history[key];
            if (!Array.isArray(stack)) continue;
            // Back to front: removeHistoryItem re-indexes everything after `idx`,
            // and it is what keeps the selection, the pinned compare pair and the
            // RAM cache consistent with the shortened stack.
            for (let idx = stack.length - 1; idx >= 0; idx--) {
                if (!this._snapshotIsDead(stack[idx], missing)) continue;
                this.removeHistoryItem(key, idx);
                removed++;
            }
        }
        if (removed > 0) {
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        return removed;
    },

    // A snapshot goes only when there is nothing left behind it. A sequence that
    // lost some of its frames still opens, so it stays.
    _snapshotIsDead(snapshot, missing) {
        if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
        for (const fr of snapshot) {
            if (!fr || fr.url || !fr.path) return false;
            if (!missing.has(fr.path)) return false;
        }
        return true;
    },

    // ── Per-node image update + history push ────────────────────────────────

    updateNodeImages(nodeId, images) {
        const processed = images.map(img => ({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
        }));
        let didPrepend = false;
        try {
            didPrepend = this.pushHistorySnapshot(nodeId, processed);
        } catch (e) { console.warn('bEpicViewer history push failed', e); }

        if (didPrepend) this.onHistoryPrepended(nodeId);

        this.allTabs[nodeId] = processed;

        if (didPrepend) {
            this.currentHistoryKey = nodeId;
            this.currentHistoryIndex = 0;
            if (this.activeTab === nodeId) {
                this.isViewingHistory = false;
                this.previewBackup = null;
                this.historyCompare = null;
                this._historyCompareEntered = false;
                this.currentFrame = this.getTimelineBounds(processed.length).min;
            }
        }

        if (this.activeTab === nodeId) {
            if (didPrepend) this.refreshView();
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this.queuePersistViewerState();
    },

    isHistorySelectionPinned(key) {
        if (this.historyCompare && this.historyCompare.key === key) return true;
        if (this.isViewingHistory && this.currentHistoryKey === key) return true;
        if (this.isComparing && (this.activeTab === key || this.compareTab === key)) return true;
        return false;
    },

    onHistoryPrepended(key) {
        const stack = this.history[key] || [];

        if (this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)) {
            this.currentHistoryIndex = Math.min(this.currentHistoryIndex + 1, Math.max(0, stack.length - 1));
        }

        if (this.historyCompare && this.historyCompare.key === key) {
            this.historyCompare.baseIdx = Math.min(this.historyCompare.baseIdx + 1, Math.max(0, stack.length - 1));
            this.historyCompare.otherIdx = Math.min(this.historyCompare.otherIdx + 1, Math.max(0, stack.length - 1));
        }
    },

    // ── History compare helpers ──────────────────────────────────────────────

    // Pin two snapshots of one tab against each other. Both layers are fed from
    // `historyCompare` by _baseFrames / _compareFrames, so this only has to put
    // the viewer into compare mode and let the normal setFrame path load, scale
    // and clip them — the same code that drives a two-tab compare, video
    // snapshots included.
    enterHistoryCompare() {
        if (!this.historyCompare) return;
        // Only the first entry records what to restore. Re-pinning the second
        // snapshot calls straight back in here, and without this guard it would
        // overwrite the saved state with the compare mode we just switched on —
        // leaving compare stuck on after exiting.
        if (!this._historyCompareEntered) {
            this._historyCompareEntered = true;
            this._savedComparing  = this.isComparing;
            this._savedCompareTab = this.compareTab;
        }
        // The compare layer belongs to the snapshot now, not to a tab.
        this.compareTab = null;

        if (!this.isComparing) {
            this.toggleCompare();          // ends in setFrame + updateTransform
        } else {
            // Zoom/pan don't change when only the pinned pair does, so
            // updateTransform would skip its no-op signature — the compare layer's
            // own scale and clip have to be re-derived directly.
            this.setFrame(this.currentFrame);
            this.updateTransform();
            this._syncCompareLayout();
        }
        this.updateTabHighlights();
        this.renderHistoryPanel();
    },

    exitHistoryCompare() {
        if (!this.historyCompare) return;
        this.historyCompare = null;
        this._historyCompareEntered = false;
        this.compareTab = this._savedComparing ? this._savedCompareTab : null;
        if (!this._savedComparing && this.isComparing) {
            this.toggleCompare();
        } else {
            // Rebuild both layers from the live tab now that the snapshots are
            // no longer the source.
            this.refreshView();
            this.updateTransform();
        }
        this.updateTabHighlights();
        this.renderHistoryPanel();
    },

    // ── Render thumbnail strip ───────────────────────────────────────────────

    renderHistoryPanel() {
        if (!this.historyStrip) return;
        const key   = this.activeTab;
        const stack = this.history[key] || [];

        // Normalise selection pointer
        if (stack.length > 0 && (this.currentHistoryKey !== key || this.currentHistoryIndex == null || this.currentHistoryIndex < 0 || this.currentHistoryIndex >= stack.length)) {
            this.currentHistoryKey   = key;
            this.currentHistoryIndex = 0;
        }

        // --- fast-path: skip full DOM rebuild if nothing changed ---
        const newSig = JSON.stringify({ key, len: stack.length, sel: this.currentHistoryIndex, cmp: this.historyCompare });
        if (newSig === this._historyPanelSig) return;
        this._historyPanelSig = newSig;

        const frag = document.createDocumentFragment();

        stack.forEach((snapshot, idx) => {
            const imgObj    = (snapshot && snapshot.length > 0) ? snapshot[0] : null;
            const thumb     = document.createElement('div');
            thumb.className = 'history-thumb';

            const imgEl = document.createElement('img');
            if (imgObj) {
                // An image snapshot has no separate poster, so this <img> points at
                // the full-resolution render — and a decoded bitmap stays resident
                // for as long as the element is attached. Twenty of those per tab,
                // one more with every render, was the memory that kept climbing.
                // Lazy means only the thumbnails actually scrolled into view pay
                // for a decode; the rest cost nothing until you look at them.
                imgEl.loading  = 'lazy';
                imgEl.decoding = 'async';
                // A thumbnail is only a hint that something is wrong — a video's
                // poster is a separate temp file, so it can be gone while the clip
                // itself is fine. The prune pass checks the real media before
                // anything is removed.
                imgEl.onerror = () => this.noteMediaLoadFailed();
                try { imgEl.src = this.thumbUrl(imgObj); } catch (e) { /* ignore */ }
            }
            thumb.appendChild(imgEl);
            thumb.title = `History ${idx + 1}`;
            // Drag source: drop onto the ComfyUI graph to make a loader node. The
            // whole snapshot is passed so multi-image sequences map to a sequence
            // loader (see _makeHistoryThumbDraggable / _sequenceDirForSnapshot).
            if (imgObj && this._makeHistoryThumbDraggable) this._makeHistoryThumbDraggable(thumb, imgObj, snapshot);

            const isSelected = (this.currentHistoryKey === key && this.currentHistoryIndex === idx);
            if (isSelected) {
                thumb.classList.add('selected');
                thumb.style.border = '2px solid #f60';
            }

            if (this.historyCompare && this.historyCompare.key === key) {
                if (idx === this.historyCompare.baseIdx)  thumb.classList.add('base');
                if (idx === this.historyCompare.otherIdx) thumb.classList.add('compare');
            }

            // Don't preventDefault here — that would block the native drag start
            // used to drop thumbnails onto the graph. stopPropagation still keeps
            // the mousedown from reaching any parent panel handler.
            thumb.onmousedown  = ev => ev.stopPropagation();
            thumb.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); this.showThumbContextMenu(ev, imgObj, key, idx); };
            thumb.onclick = (ev) => {
                ev.stopPropagation();

                if (ev.shiftKey && this.isViewingHistory && this.currentHistoryKey === key) {
                    if (!this.historyCompare) {
                        this.historyCompare = { key, baseIdx: this.currentHistoryIndex, otherIdx: idx };
                        this.enterHistoryCompare();
                    } else if (this.historyCompare.key === key && (idx === this.historyCompare.baseIdx || idx === this.historyCompare.otherIdx)) {
                        this.exitHistoryCompare();
                    } else {
                        this.historyCompare.otherIdx = idx;
                        this.enterHistoryCompare();
                    }
                    return;
                }

                // Unpin first so toggleCompare acts on tab state rather than on
                // the snapshot compare we are leaving (exitHistoryCompare already
                // turns compare off when it wasn't on beforehand).
                if (this.historyCompare) this.exitHistoryCompare();
                if (this.isComparing) this.toggleCompare();

                if (this.isViewingHistory && this.currentHistoryKey === key && this.currentHistoryIndex === idx) {
                    this.restoreHistoryView();
                } else {
                    this.historyCompare      = null;
                    this.openHistorySnapshot(key, idx);
                    this.currentHistoryKey   = key;
                    this.currentHistoryIndex = idx;
                }
            };

            frag.appendChild(thumb);
        });

        // Replace strip contents in one operation
        this.historyStrip.innerHTML = '';
        this.historyStrip.appendChild(frag);

        // Only reached when the signature changed, so this rides on real rebuilds
        // — a restore from localStorage, a new output, a tab switch — rather than
        // on every call. Paths already verified are skipped, so a settled session
        // sends nothing.
        this.scheduleHistoryPrune();

        let totalHistory = 0;
        Object.values(this.history).forEach(arr => { totalHistory += arr?.length || 0; });
        const canClear = key ? stack.length > 0 : totalHistory > 0;
        if (this.historyClearBtn) this.historyClearBtn.disabled = !canClear;
    },

    openHistorySnapshot(key, index) {
        if (!this.history[key] || !this.history[key][index]) return;
        if (!this.previewBackup) this.previewBackup = this.allTabs[key] ? JSON.parse(JSON.stringify(this.allTabs[key])) : null;
        this.allTabs[key]        = JSON.parse(JSON.stringify(this.history[key][index]));
        this.isViewingHistory    = true;
        this.currentHistoryKey   = key;
        this.currentHistoryIndex = index;
        if (this.activeTab !== key) this.switchTab(key);
        else this.refreshView();
        if (typeof this.captureTabViewState === 'function') this.captureTabViewState(key);
        // Invalidate signature so the strip actually rebuilds
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    /**
     * Move the current history selection up/down by the given delta.
     * Positive delta moves forward (down arrow), negative moves backward.
     */
    navigateHistory(delta) {
        const key = this.activeTab;
        const stack = this.history[key] || [];
        if (stack.length === 0) return;
        if (this.currentHistoryKey !== key || !Number.isInteger(this.currentHistoryIndex)) {
            this.currentHistoryKey = key;
            this.currentHistoryIndex = 0;
        }
        let newIdx = this.currentHistoryIndex + delta;
        newIdx = Math.min(Math.max(newIdx, 0), stack.length - 1);
        if (newIdx === this.currentHistoryIndex) return;
        this.currentHistoryIndex = newIdx;
        this.openHistorySnapshot(key, newIdx);
        // after rendering ensure the selected thumb is visible
        try {
            const panel = this.historyStrip || (this.historyPanel && this.historyPanel.querySelector('.history-strip'));
            const sel = panel && panel.querySelector('.history-thumb.selected');
            if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (e) { /* ignore */ }
    },

    // ── Thumbnail context menu ───────────────────────────────────────────────

    showThumbContextMenu(ev, imgObj, key, idx) {
        const doc = (this.container && this.container.ownerDocument) ? this.container.ownerDocument : document;
        const existing = this.container ? this.container.querySelector('#thumb-ctx-menu') : null;
        if (existing) existing.remove();

        let copyPath = '';
        if (imgObj && imgObj.path) {
            copyPath = imgObj.path;
        } else if (imgObj && imgObj.filename) {
            copyPath = imgObj.subfolder ? `${imgObj.subfolder}/${imgObj.filename}` : imgObj.filename;
        }

        const menu = doc.createElement('div');
        menu.id = 'thumb-ctx-menu';
        menu.className = 'thumb-ctx-menu';

        const item = doc.createElement('div');
        item.className = 'thumb-ctx-item';
        item.textContent = '📋 Copy image path';
        item.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            // Synchronous fallback first (still within user-activation window)
            try {
                const ta = doc.createElement('textarea');
                ta.value = copyPath;
                ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;pointer-events:none;';
                doc.body.appendChild(ta);
                ta.focus({ preventScroll: true });
                ta.setSelectionRange(0, copyPath.length);
                doc.execCommand('copy');
                doc.body.removeChild(ta);
            } catch (err) { console.warn('bEpicViewer: execCommand copy failed', err); }
            const nav = (doc.defaultView && doc.defaultView.navigator) ? doc.defaultView.navigator : navigator;
            if (nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(copyPath).catch(() => {});
        };
        menu.appendChild(item);

        const removeItem = doc.createElement('div');
        removeItem.className = 'thumb-ctx-item';
        removeItem.textContent = '🗑 Remove from history';
        removeItem.onclick = (e) => {
            e.stopPropagation();
            menu.remove();
            this.removeHistoryItem(key, idx);
        };
        menu.appendChild(removeItem);

        const panelRect = this.container.getBoundingClientRect();
        menu.style.left = `${ev.clientX - panelRect.left}px`;
        menu.style.top  = `${ev.clientY - panelRect.top}px`;
        this.container.appendChild(menu);

        const dismiss = () => { menu.remove(); this.container.removeEventListener('click', dismiss, true); };
        setTimeout(() => this.container.addEventListener('click', dismiss, true), 0);
    },

    removeHistoryItem(key, index) {
        const stack = this.history[key];
        if (!Array.isArray(stack) || index < 0 || index >= stack.length) return;

        if (this.isViewingHistory && this.currentHistoryKey === key && this.currentHistoryIndex === index) {
            this.restoreHistoryView();
        }

        stack.splice(index, 1);

        if (this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)) {
            if (this.currentHistoryIndex > index) {
                this.currentHistoryIndex -= 1;
            } else if (this.currentHistoryIndex >= stack.length) {
                this.currentHistoryIndex = stack.length > 0 ? stack.length - 1 : null;
            }
            if (this.currentHistoryIndex == null) this.currentHistoryKey = null;
        }

        if (this.historyCompare && this.historyCompare.key === key) {
            const baseWasDeleted = this.historyCompare.baseIdx === index;
            const otherWasDeleted = this.historyCompare.otherIdx === index;

            if (baseWasDeleted || otherWasDeleted || stack.length < 2) {
                this.exitHistoryCompare();
            } else {
                if (this.historyCompare.baseIdx > index) this.historyCompare.baseIdx -= 1;
                if (this.historyCompare.otherIdx > index) this.historyCompare.otherIdx -= 1;
            }
        }

        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    },

    restoreHistoryView() {
        if (!this.previewBackup || !this.activeTab) return;
        this.allTabs[this.activeTab] = JSON.parse(JSON.stringify(this.previewBackup));
        this.previewBackup           = null;
        this.isViewingHistory        = false;
        this.currentHistoryKey       = null;
        this.currentHistoryIndex     = null;
        this._historyPanelSig        = null;
        this.refreshView();
        this.renderHistoryPanel();
        if (typeof this.captureTabViewState === 'function') this.captureTabViewState(this.activeTab);
        this.queuePersistViewerState();
    },

    /**
     * Clicking an empty area of the history strip returns the viewer to the
     * newest snapshot that's actually VISIBLE in the panel (index 0), rather
     * than restoring the saved live-view backup. That backup can be stale —
     * e.g. after removing the first history item, the live view still holds
     * the removed snapshot, so restoring it would resurrect the deleted item.
     */
    jumpToLatestVisibleHistory() {
        const key   = this.activeTab;
        const stack = this.history[key] || [];
        if (stack.length === 0) { this.restoreHistoryView(); return; }
        // Drop any stale backup, then show the newest visible snapshot.
        this.previewBackup = null;
        this.openHistorySnapshot(key, 0);
        // Anchor the live-view backup to that newest snapshot so a later click
        // on the selected thumb returns here, not to a removed item.
        this.previewBackup = this.history[key][0]
            ? JSON.parse(JSON.stringify(this.history[key][0]))
            : null;
    },

    // ── Open Folder ──────────────────────────────────────────────────────────

    async openFolderPicker() {
        console.debug('bEpicViewer.openFolderPicker invoked');
        try {
            this.openFolderBtn.disabled = true;
            this.openFolderBtn.title    = 'Opening folder picker…';
            const res  = await fetch(api.apiURL('/bepic/pick_folder'));
            const data = await res.json();
            if (!data.folder || !data.files || data.files.length === 0) {
                if (data.error && data.error !== 'No folder selected') {
                    alert(`bEpicViewer – Open Folder error:\n${data.error}`);
                }
                return;
            }
            this.loadFolderImages(data.folder, data.files);
        } catch (e) {
            console.error('bEpicViewer openFolderPicker error:', e);
            alert(`bEpicViewer – Could not open folder picker.\n${e.message || e}`);
        } finally {
            this.openFolderBtn.disabled = false;
            this.openFolderBtn.title    = 'Open all images in folder';
        }
    },

    loadFolderImages(folder, files) {
        const folderName = folder.replace(/\\/g, '/').split('/').pop() || folder;
        const tabKey     = `folder_${Date.now()}`;

        this.allTabs[tabKey]   = [];
        this.tabLabels[tabKey] = `📂 ${folderName}`;
        this.history[tabKey]   = files.map(f => [{ path: f.path, name: f.name, external: true }]);

        if (files.length > 0) {
            this.allTabs[tabKey] = [{ path: files[0].path, name: files[0].name, external: true }];
        }

        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = 'flex';

        this.refreshFolderTab(tabKey, folderName);
        this.switchTab(tabKey);

        const panel = this.historyPanel || this.shadowRoot.getElementById('history-panel');
        if (panel) {
            panel.style.display = 'flex';
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this.queuePersistViewerState();
    },

    refreshFolderTab(tabKey, folderName) {
        if (!this.tabsContainer) return;
        const existing = this.tabsContainer.querySelector(`[data-tab="${tabKey}"]`);
        if (existing) existing.remove();

        const btn = this._makeTabButton(tabKey, `📂 ${folderName}`);
        btn.onclick = (e) => {
            if (e.shiftKey) { this.selectedNodeIds = [tabKey]; return; }
            this.switchTab(tabKey);
        };

        const closeX = document.createElement('span');
        closeX.className = 'tab-close';
        closeX.title = 'Close this folder tab';
        this._setIcon(closeX, 'icon-close');
        closeX.onclick = (e) => { e.stopPropagation(); this.closeTab(tabKey); };
        btn.appendChild(closeX);

        this.tabsContainer.appendChild(btn);
    },

    // ── Tab helpers ──────────────────────────────────────────────────────────

    saveTabOrder() {
        const container = this.tabsContainer || this.tabBar;
        if (!container) return;
        this.tabOrder = Array.from(container.querySelectorAll('.tab[data-tab]')).map(el => el.dataset.tab);
        this.queuePersistViewerState();
    },

    closeTab(key) {
        if (this._revokeDroppedTab) this._revokeDroppedTab(key);   // free blob: URLs of dropped files
        this.tabOrder = this.tabOrder.filter(k => k !== key);
        delete this.allTabs[key];
        delete this.tabLabels[key];
        delete this.customLayouts[key];
        const container = this.tabsContainer || this.tabBar;
        const btn = container && container.querySelector(`[data-tab="${key}"]`);
        if (btn) btn.remove();
        if (this.activeTab === key) {
            const remaining = Object.keys(this.allTabs);
            if (remaining.length > 0) {
                this.switchTab(remaining[0]);
            } else {
                this.activeTab = null;
                if (this.imgBase)  this.imgBase.src = '';
                this._updatePathBar(null);
                this.applyTimelineBounds(0);
            }
            this._historyPanelSig = null;
            this.renderHistoryPanel();
        }
        this.queuePersistViewerState();
    },

    // ── Private: create a draggable tab button element ───────────────────────
    _makeTabButton(key, labelText) {
        const btn = document.createElement('div');
        btn.className  = 'tab';
        btn.dataset.tab = key;
        btn.title       = labelText;

        const span = document.createElement('span');
        span.textContent = labelText;
        btn.appendChild(span);

        // User-assigned tab color (right-click → pick), applied via CSS custom
        // properties so hover/active styling keeps working.
        if (typeof this._applyTabColor === 'function') this._applyTabColor(btn, key);
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof this._openTabColorMenu === 'function') this._openTabColorMenu(key, e.clientX, e.clientY);
        });

        btn.draggable = true;
        btn.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', key);
            btn.classList.add('dragging');
        });
        btn.addEventListener('dragend', () => {
            btn.classList.remove('dragging');
            (this.tabsContainer || this.tabBar).querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
        });
        btn.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            (this.tabsContainer || this.tabBar).querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
            btn.classList.add('drag-over');
        });
        btn.addEventListener('dragleave', () => { btn.classList.remove('drag-over'); });
        btn.addEventListener('drop', (e) => {
            e.preventDefault();
            btn.classList.remove('drag-over');
            const fromKey = e.dataTransfer.getData('text/plain');
            if (fromKey === key) return;
            const container = this.tabsContainer || this.tabBar;
            const fromBtn   = container.querySelector(`[data-tab="${CSS.escape(fromKey)}"]`);
            if (!fromBtn) return;
            const rect = btn.getBoundingClientRect();
            container.insertBefore(fromBtn, e.clientX < rect.left + rect.width / 2 ? btn : btn.nextSibling);
            this.saveTabOrder();
        });

        return btn;
    },
};
