// bEpicViewer_mixinHistory.js
// History panel: thumbnails, snapshots, folder loading, tab management.
import { api } from "../../scripts/api.js";

export const HistoryMixin = {

    // ── Per-node image update + history push ────────────────────────────────

    updateNodeImages(nodeId, images) {
        const processed = images.map(img => ({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
        }));
        let didPrepend = false;
        try {
            if (!this.history[nodeId]) this.history[nodeId] = [];
            const json = JSON.stringify(processed);
            if (this.history[nodeId].length === 0 || JSON.stringify(this.history[nodeId][0]) !== json) {
                this.history[nodeId].unshift(JSON.parse(json));
                if (this.history[nodeId].length > 20) this.history[nodeId].pop();
                didPrepend = true;
            }
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
            this.setFrame(this.currentFrame);
            this.updateTransform();
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
                if (this.pathBar)  this.pathBar.style.display = 'none';
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
