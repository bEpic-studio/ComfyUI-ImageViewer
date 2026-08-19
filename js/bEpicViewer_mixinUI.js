// bEpicViewer_mixinUI.js
// UI interactions: zoom/pan, compare slider, panel dragging/resizing,
// undocking, hotkeys, tab highlights, compare mode, slider modes.
import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";
import { resolveViewerAction, viewerHelpRows } from "./bEpicViewer_keymap.js";
import { isViewerSourceNode, senderTabInfo } from "./bEpicViewer_nodeTools.js";

export const UIMixin = {

    // ── Exposure ─────────────────────────────────────────────────────────────

    setExposure(value) {
        const parsed = Number.isFinite(value) ? value : 0;
        this.exposure = Math.max(-4, Math.min(4, parsed));

        if (this.exposureSlider) this.exposureSlider.value = String(this.exposure);
        if (this.exposureValue) this.exposureValue.textContent = `${this.exposure.toFixed(1)} EV`;

        this.applyExposure();
    },

    resetExposure() {
        this.setExposure(0);
    },

    setChannelView(mode) {
        const allowed = new Set(['all', 'red', 'green', 'blue']);
        const next = allowed.has(mode) ? mode : 'all';
        this.channelView = next;
        if (this.rgbChannelSel && this.rgbChannelSel.value !== next) this.rgbChannelSel.value = next;
        this.applyExposure();
    },

    applyExposure() {
        const factor = Math.pow(2, Number.isFinite(this.exposure) ? this.exposure : 0);
        let channelFilter = '';
        if (this.channelView === 'red') channelFilter = 'url(#bepic-channel-red)';
        else if (this.channelView === 'green') channelFilter = 'url(#bepic-channel-green)';
        else if (this.channelView === 'blue') channelFilter = 'url(#bepic-channel-blue)';

        const exposureFilter = `brightness(${factor.toFixed(3)})`;
        const filter = channelFilter ? `${channelFilter} ${exposureFilter}` : exposureFilter;
        if (this.imgBase) this.imgBase.style.filter = filter;
        if (this.imgCompare) this.imgCompare.style.filter = filter;
        if (this.videoBase) this.videoBase.style.filter = filter;
    },

    // ── Hotkeys ──────────────────────────────────────────────────────────────

    // Every hotkey below the exposure modifier comes out of the keymap table, so
    // whatever the user has set in Settings → Keybinding is what the viewer
    // answers to. Bound as a capture-phase listener (see bEpicViewer.js) so a
    // keystroke the viewer claims can be stopped before ComfyUI's own global
    // handler — which sits on window in the bubble phase — ever sees it.
    handleKeyDown(e) {
        const target   = e.composedPath()[0];
        const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
        if (isTyping) return;

        if (e.key === 'e' || e.key === 'E') {
            this.isExposureModifierActive = true;
            return;
        }

        if (!this.isHovered || !this.isViewerVisible()) return;

        // Ctrl/Cmd+Enter queues a prompt (matching ComfyUI). In the docked panel
        // ComfyUI's own global shortcut already fires, so only handle it here for
        // the undocked popout (which has no such shortcut) to avoid queuing the
        // prompt twice.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            const fromPopout = !!(this.popoutWindow && !this.popoutWindow.closed &&
                e.target && e.target.ownerDocument === this.popoutWindow.document);
            if (fromPopout) { e.preventDefault(); app.queuePrompt(0); }
            return;
        }

        const action = resolveViewerAction(e);
        if (!action) return;
        if (action.enabled && !action.enabled(this)) return;

        // While the viewer is hovered it owns its own hotkeys: stop here so the
        // same keystroke doesn't also trigger a ComfyUI command behind the panel.
        e.preventDefault();
        e.stopImmediatePropagation();
        action.run(this, e);
    },

    // Hover alone isn't enough to claim a keystroke — hiding the panel under the
    // cursor never fires mouseleave, so `isHovered` can outlive it being on screen.
    isViewerVisible() {
        if (this.popoutWindow && !this.popoutWindow.closed) return true;
        return !!this.isConnected && this.style.display !== 'none';
    },

    handleKeyUp(e) {
        if (e.key === 'e' || e.key === 'E') {
            this.isExposureModifierActive = false;
            this.isExposureDragging = false;
        }
    },

    getTabOrderForHotkeys() {
        const container = this.tabsContainer || this.tabBar;
        if (container) {
            const domOrder = Array.from(container.querySelectorAll('.tab[data-tab]'))
                .map(el => el.dataset.tab)
                .filter(k => !!k && !!this.allTabs[k]);
            if (domOrder.length > 0) return domOrder;
        }

        if (Array.isArray(this.tabOrder) && this.tabOrder.length > 0) {
            const known = this.tabOrder.filter(k => !!this.allTabs[k]);
            if (known.length > 0) return known;
        }

        return Object.keys(this.allTabs);
    },

    // ── Overlays ─────────────────────────────────────────────────────────────

    toggleShapeOverlay() {
        this.showShape = !this.showShape;
        if (this.shapeOverlay) this.shapeOverlay.style.display = this.showShape ? "block" : "none";
        if (this.shapeBtn) this.shapeBtn.classList.toggle('active', this.showShape);
        this.updateShapeInfo();
    },

    toggleHelpOverlay(force) {
        if (!this.helpOverlay) return;
        // Closed is the stylesheet's default, so the inline style is empty until
        // the overlay has been opened once — ask for the computed value instead.
        const view   = this.helpOverlay.ownerDocument.defaultView || window;
        const isOpen = view.getComputedStyle(this.helpOverlay).display !== "none";
        const show   = (force === undefined) ? !isOpen : !!force;
        if (!show) { this.helpOverlay.style.display = "none"; return; }

        // Reveal the tool-specific section only for the tool that's active, so the
        // help matches the current context.
        const active = this._toolState ? this._toolState.active : "none";
        const section = (sel, on) => {
            const el = this.helpOverlay.querySelector(sel);
            if (el) el.style.display = on ? "block" : "none";
        };
        section('#help-roto',    active === "roto");
        section('#help-sam3',    active === "sam3");
        section('#help-sam3box', active === "sam3box");

        this.renderHelpKeys();
        this.helpOverlay.style.display = "flex";
    },

    // The listed keys are whatever is bound right now, not the shipped defaults,
    // so the overlay stays honest after a rebind in Settings → Keybinding.
    renderHelpKeys() {
        const host = this.helpOverlay && this.helpOverlay.querySelector('#help-keys');
        if (!host) return;
        const frag = document.createDocumentFragment();
        for (const row of viewerHelpRows()) {
            const line = document.createElement('div');
            const key  = document.createElement('b');
            key.textContent = `${row.keys}:`;
            line.appendChild(key);
            line.appendChild(document.createTextNode(` ${row.label}`));
            frag.appendChild(line);
        }
        host.innerHTML = '';
        host.appendChild(frag);
    },

    // ── Undock / re-dock ─────────────────────────────────────────────────────

    // The window the viewer's DOM is currently living in: the ComfyUI tab while
    // docked, the popout while undocked. Anything realm-bound — ResizeObserver,
    // requestAnimationFrame — has to be taken from here rather than from the
    // module's own `window`, which goes on pointing at the ComfyUI tab either way
    // (and stops painting altogether once the popout covers it).
    _viewerWindow() {
        try {
            const doc = this.container && this.container.ownerDocument;
            if (doc && doc.defaultView) return doc.defaultView;
        } catch (e) {}
        return window;
    },

    // Re-derive everything measured against the viewport box, after the container
    // has been moved between windows. The move itself resizes that box — the
    // popout opens at its own size — and it happens while the old watcher is
    // still attached to the document being left behind, so nothing else notices.
    _afterViewportMoved() {
        // A frame queued in the window just left will never run, and the guard
        // would then block every later sync.
        this._compareSyncRaf = null;
        const run = () => {
            this.updateImageFrame && this.updateImageFrame();
            this.updateToolOverlay && this.updateToolOverlay();
            this._syncCompareLayout && this._syncCompareLayout();
        };
        run();
        // Once more after the new window has laid the container out: a popout that
        // has only just been created reports its real size a frame late.
        const win = this._viewerWindow();
        if (win && win.requestAnimationFrame) win.requestAnimationFrame(run);
        else if (win && win.setTimeout) win.setTimeout(run, 0);
        // The ticker holds a frame callback from the window being left behind.
        if (this.isComparing) this._startCompareTicker();
    },

    toggleUndock() {
        if (this.popoutWindow && !this.popoutWindow.closed) {
            this.popoutWindow.onbeforeunload = null;
            this.popoutWindow.close();
            this.restoreDock();
        } else {
            this.popoutWindow = window.open("", "bEpicViewer", "width=800,height=600");
            if (!this.popoutWindow) return;

            this.popoutWindow.document.title = "bEpic Viewer";
            this.shadowRoot.querySelectorAll('style').forEach(s => this.popoutWindow.document.head.appendChild(s.cloneNode(true)));
            this.popoutWindow.document.body.appendChild(this.container);
            Object.assign(this.popoutWindow.document.body.style, { margin: "0", overflow: "hidden", backgroundColor: "#222" });

            try {
                const hostFont = window.getComputedStyle(this).fontFamily || 'sans-serif';
                this.popoutWindow.document.body.style.fontFamily = hostFont;
                this.container.style.fontFamily = hostFont;
            } catch (e) { console.warn('bEpicViewer: failed to copy font to popout', e); }

            // Copy CSS custom properties (icon sprites etc.) so mask-image vars work
            try {
                const computed = window.getComputedStyle(this);
                const iconProps = [
                    '--icon-play','--icon-pause','--icon-skip-start','--icon-skip-end','--icon-prev','--icon-next',
                    '--icon-fit','--icon-shape','--icon-rotate-slider','--icon-close','--icon-undock','--icon-layout',
                    '--icon-history','--icon-params','--icon-range','--icon-refresh','--icon-folder','--icon-delete',
                    '--icon-help','--icon-dock-left','--icon-dock-right','--icon-lock','--icon-unlock'
                ];

                iconProps.forEach(p => {
                    const v = computed.getPropertyValue(p);
                    if (v && v.trim() !== '') {
                        // set on popout document root so selectors referencing vars resolve
                        this.popoutWindow.document.documentElement.style.setProperty(p, v);
                        // also set on the container element as a fallback
                        this.container.style.setProperty(p, v);
                    }
                });
            } catch (e) {
                console.warn('bEpicViewer: failed to copy CSS variables to popout', e);
            }

            this.container.style.width  = "100vw";
            this.container.style.height = "100vh";
            this._setIcon(this.undockBtn, 'icon-dock');
            this.undockBtn.title        = "Dock to main window";
            this.style.display          = 'none';

            this.popoutWindow.onbeforeunload = () => this.restoreDock();
            this.popoutWindow.addEventListener('keydown', (e) => this.handleKeyDown(e), true);
            this.popoutWindow.addEventListener('keyup', (e) => this.handleKeyUp(e));
            this.bindClearButton();
            // The viewport now belongs to the popout's document, so whatever
            // watches it for size changes has to be rebuilt there — otherwise
            // resizing or maximising the popout resizes the picture but never
            // rescales the compare layer or the frame outline against it.
            this._watchViewportResize && this._watchViewportResize();
            this._afterViewportMoved && this._afterViewportMoved();
        }
    },

    restoreDock() {
        this.shadowRoot.appendChild(this.container);
        this.popoutWindow               = null;
        this._setIcon(this.undockBtn, 'icon-undock');
        this.undockBtn.title            = "Undock to separate window";
        this.container.style.width      = "";
        this.container.style.height     = "";
        this.container.style.fontFamily = "";
        this.style.display              = 'flex';
        this.bindClearButton();
        this._watchViewportResize && this._watchViewportResize();
        this._afterViewportMoved && this._afterViewportMoved();
    },

    // ── Clear-cache button (window-agnostic) ─────────────────────────────────

    bindClearButton() {
        const clearBtn = this.container ? this.container.querySelector('#clear-cache-btn') : null;
        if (!clearBtn) return;
        clearBtn.onclick = null;
        clearBtn.onclick = async () => {
            const dlgWin = clearBtn.ownerDocument?.defaultView || window;
            if (!dlgWin.confirm('Clear bEpic temp files? This will permanently delete viewer cache images.')) return;

            const envApi   = (dlgWin.opener && dlgWin.opener.api)   ? dlgWin.opener.api   : api;
            const envFetch = (dlgWin.opener && dlgWin.opener.fetch) ? dlgWin.opener.fetch.bind(dlgWin.opener) : fetch;
            const url = envApi.apiURL('/bepic/clear_cache');

            try {
                const res = await envFetch(url);
                if (!res.ok) throw new Error('Request failed');
                const js = await res.json();
                dlgWin.alert(`Cleared ${js.deleted || 0} files from bEpic temp cache.`);
                try {
                    this.history        = {};
                    this.previewBackup  = null;
                    this.isViewingHistory = false;
                    const panel = this.historyPanel || this.shadowRoot.getElementById('history-panel');
                    if (panel) panel.style.display = 'none';
                    if (this._syncHistoryToggleState) this._syncHistoryToggleState();
                    if (this.historyStrip) this.historyStrip.innerHTML = '';
                    this.queuePersistViewerState();
                } catch (e) { console.warn('Failed to clear viewer history', e); }
            } catch (e) {
                console.error('clear cache failed', e);
                dlgWin.alert('Failed to clear cache: ' + e.message);
            }
        };
    },

    // ── Tab switch and highlights ─────────────────────────────────────────────

    captureTabViewState(key) {
        if (!key) return;
        if (!this.tabViewState || typeof this.tabViewState !== 'object') this.tabViewState = {};

        const prev = this.tabViewState[key] || {};
        const state = {
            frame: Number.isFinite(this.currentFrame) ? this.currentFrame : (Number.isFinite(prev.frame) ? prev.frame : 0),
            historyIndex: Number.isInteger(this.currentHistoryIndex) && this.currentHistoryKey === key
                ? this.currentHistoryIndex
                : (Number.isInteger(prev.historyIndex) ? prev.historyIndex : null),
            viewingHistory: !!(this.isViewingHistory && this.currentHistoryKey === key && Number.isInteger(this.currentHistoryIndex)),
        };

        this.tabViewState[key] = state;
    },

    getTabViewState(key) {
        if (!key || !this.tabViewState || typeof this.tabViewState !== 'object') return null;
        const s = this.tabViewState[key];
        return (s && typeof s === 'object') ? s : null;
    },

    switchTab(k) {
        const prevTab = this.activeTab;
        if (prevTab && prevTab !== k) this.captureTabViewState(prevTab);

        try {
            if (this.activeTab !== k && this.isViewingHistory && this.previewBackup && this.activeTab && this.allTabs[this.activeTab]) {
                this.allTabs[this.activeTab] = JSON.parse(JSON.stringify(this.previewBackup));
                this.previewBackup     = null;
                this.isViewingHistory  = false;
            }
        } catch (e) {}

        this.activeTab = k;
        this.tabBar.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === k);
        });
        this.updateTabHighlights();

        if (!this.isInputRangeLocked) this.playbackRange = null;
        this.updateRangeOverlay();
        if (this.isInputRangeLocked) this.syncInputRange();

        const imgs = this.allTabs[k];
        const tabState = this.getTabViewState(k);
        let restoredByHistory = false;

        if (tabState && Number.isInteger(tabState.historyIndex)) {
            const stack = this.history[k] || [];
            if (stack.length > 0) {
                const safeIdx = Math.max(0, Math.min(tabState.historyIndex, stack.length - 1));
                this.currentHistoryKey = k;
                this.currentHistoryIndex = safeIdx;

                if (tabState.viewingHistory) {
                    this.historyCompare = null;
                    this.openHistorySnapshot(k, safeIdx);
                    restoredByHistory = true;
                }
            }
        }

        if (imgs && imgs.length > 0) {
            if (!restoredByHistory) {
                this.applyTimelineBounds(imgs.length);
                const bounds = this.getTimelineBounds(imgs.length);
                const preferredFrame = tabState && Number.isFinite(tabState.frame) ? tabState.frame : this.currentFrame;
                const nextFrame = (preferredFrame >= bounds.min && preferredFrame <= bounds.max) ? preferredFrame : bounds.min;
                this.setFrame(nextFrame);
            }
        } else {
            if (this._exitVideoMode) this._exitVideoMode();
            this.imgBase.src = "";
            this._updatePathBar(null);
            // Nothing on screen has no shape; without this the overlay keeps
            // reporting the media of the tab we just left.
            if (this.updateShapeInfo) this.updateShapeInfo();
            this.applyTimelineBounds(0);
            this.timeline.value = 0;
            this.container.querySelector('#cur-f').innerText = 0;
        }
        this.captureTabViewState(k);
        this._historyPanelSig = null;
        this.renderHistoryPanel();
        this.queuePersistViewerState();
        if (this._bindToolsToActiveTab) this._bindToolsToActiveTab();
        if (this.updateToolOverlay) this.updateToolOverlay();
    },

    updateTabHighlights() {
        if (!this.tabBar) return;
        this.tabBar.querySelectorAll('.tab').forEach(t => {
            if (this.historyCompare) { t.classList.remove('compare'); return; }
            t.classList.toggle('compare', !!(this.isComparing && t.dataset.tab === this.compareTab));
        });
    },

    // ── Tab colors ───────────────────────────────────────────────────────────
    // A user can right-click a tab and assign it a color. The color tints the
    // tab button and propagates to every "Send to Viewer" node that writes to
    // that tab (there can be several when they share a tab_name).

    // Quick-pick palette shown in the color menu.
    _tabColorPalette() {
        return ['#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085',
                '#2980b9', '#5b6ee1', '#8e44ad', '#d64f9b', '#7f8c8d'];
    },

    _parseHexColor(hex) {
        if (typeof hex !== 'string') return null;
        let h = hex.trim().replace(/^#/, '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
        return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    },

    _darkenHex(hex, factor) {
        const c = this._parseHexColor(hex);
        if (!c) return hex;
        const f = Math.max(0, Math.min(1, factor));
        const to2 = (v) => Math.round(v * f).toString(16).padStart(2, '0');
        return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
    },

    // Black or white text, whichever reads better on the given background.
    _readableTextColor(hex) {
        const c = this._parseHexColor(hex);
        if (!c) return '#fff';
        const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
        return lum > 0.6 ? '#111' : '#fff';
    },

    // Apply (or clear) the stored color on a single tab button element.
    _applyTabColor(btn, key) {
        if (!btn) return;
        const color = this.tabColors ? this.tabColors[key] : null;
        if (color && this._parseHexColor(color)) {
            btn.classList.add('has-color');
            btn.style.setProperty('--tab-color', color);
            btn.style.setProperty('--tab-fg', this._readableTextColor(color));
        } else {
            btn.classList.remove('has-color');
            btn.style.removeProperty('--tab-color');
            btn.style.removeProperty('--tab-fg');
        }
    },

    // Every graph node that writes to the given tab key.
    _nodesForTabKey(key) {
        const out = [];
        const graph = (typeof app !== 'undefined') ? app.graph : null;
        if (!graph) return out;
        const nodes = graph._nodes || graph.nodes || [];
        nodes.forEach(n => {
            if (!n) return;
            if (isViewerSourceNode(n)) {
                const info = senderTabInfo(n);
                if (info && info.key === key) out.push(n);
            } else if (n.type === 'bEpicViewer' && key.startsWith('tab') && Array.isArray(n.inputs)) {
                // Legacy multi-input viewer: tint the node feeding that input.
                const idx = parseInt(key.replace('tab', ''), 10) - 1;
                const inp = n.inputs[idx];
                if (inp && inp.link != null) {
                    const link = graph.links[inp.link];
                    const origin = link ? graph.getNodeById(link.origin_id) : null;
                    if (origin) out.push(origin);
                }
            }
        });
        return out;
    },

    // Tint (color != null) or reset (color == null) every node for this tab.
    _applyColorToTabNodes(key, color) {
        const nodes = this._nodesForTabKey(key);
        if (!nodes.length) return;
        nodes.forEach(n => {
            if (color && this._parseHexColor(color)) {
                n.bgcolor = color;
                n.color   = this._darkenHex(color, 0.5);
            } else {
                delete n.bgcolor;
                delete n.color;
            }
            if (typeof n.setDirtyCanvas === 'function') n.setDirtyCanvas(true, true);
        });
        try {
            if (app.graph)  app.graph.setDirtyCanvas(true, true);
            if (app.canvas) app.canvas.setDirty(true, true);
        } catch (e) {}
    },

    // Assign/clear a tab color and push it through to button + nodes + storage.
    setTabColor(key, color) {
        if (!this.tabColors) this.tabColors = {};
        if (color && this._parseHexColor(color)) this.tabColors[key] = color;
        else { color = null; delete this.tabColors[key]; }

        const container = this.tabsContainer || this.tabBar;
        const btn = container && container.querySelector(`[data-tab="${CSS.escape(key)}"]`);
        if (btn) this._applyTabColor(btn, key);

        this._applyColorToTabNodes(key, color);
        if (typeof this.queuePersistViewerState === 'function') this.queuePersistViewerState();
    },

    // Did this event start inside `menu`?
    //
    // The dismiss listener sits on the document, and while docked the menu lives
    // in the viewer's shadow root — so by the time the event reaches the document
    // its `target` has been retargeted to the shadow HOST, and `menu.contains()`
    // says no for a click on the menu's own swatch. The menu then closed on
    // pointerdown, before the swatch's click could fire, and picking a color did
    // nothing while docked (undocked, the popout has no shadow root, which is why
    // it worked there). composedPath() keeps the real, pre-retargeting path.
    _eventHitsMenu(ev, menu) {
        if (!ev || !menu) return false;
        if (typeof ev.composedPath === 'function') {
            const path = ev.composedPath();
            if (path && path.length) return path.indexOf(menu) !== -1;
        }
        return menu.contains(ev.target);
    },

    _closeTabColorMenu() {
        if (this._tabColorMenuEl) { this._tabColorMenuEl.remove(); this._tabColorMenuEl = null; }
        if (this._tabColorMenuDismiss) {
            const doc = this._tabColorMenuDoc || document;
            const win = doc.defaultView || window;
            doc.removeEventListener('pointerdown', this._tabColorMenuDismiss, true);
            win.removeEventListener('blur', this._tabColorMenuDismiss, true);
            doc.removeEventListener('keydown', this._tabColorMenuKey, true);
            this._tabColorMenuDismiss = null;
            this._tabColorMenuKey = null;
            this._tabColorMenuDoc = null;
        }
    },

    // Swatch menu anchored at the cursor. Mirrors showThumbContextMenu: it is
    // appended to this.container (position:relative) and positioned absolutely
    // against its rect — a proven pattern in this shadow DOM. Critical layout
    // styles are set inline so a stale/missing stylesheet can't hide the menu.
    _openTabColorMenu(key, x, y) {
        this._closeTabColorMenu();

        const host = this.container || this.shadowRoot || this;
        const doc  = (host.ownerDocument) ? host.ownerDocument : document;

        const menu = doc.createElement('div');
        menu.className = 'tab-color-menu';
        menu.style.cssText = 'position:absolute;z-index:2147483647;background:#1b1b1b;' +
            'border:1px solid #444;border-radius:8px;padding:8px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,0.6);user-select:none;font-size:12px;';

        const swatches = doc.createElement('div');
        swatches.className = 'tcm-swatches';
        swatches.style.cssText = 'display:grid;grid-template-columns:repeat(5,20px);gap:6px;';
        this._tabColorPalette().forEach(col => {
            const s = doc.createElement('button');
            s.className = 'tcm-swatch';
            s.type = 'button';
            s.style.cssText = 'width:20px;height:20px;border-radius:4px;cursor:pointer;padding:0;' +
                'border:1px solid rgba(255,255,255,0.25);background:' + col + ';';
            s.title = col;
            if (this.tabColors && this.tabColors[key] &&
                this.tabColors[key].toLowerCase() === col.toLowerCase()) {
                s.classList.add('sel');
                s.style.boxShadow = '0 0 0 2px #fff';
            }
            s.onclick = () => { this.setTabColor(key, col); this._closeTabColorMenu(); };
            swatches.appendChild(s);
        });
        menu.appendChild(swatches);

        const row = doc.createElement('div');
        row.className = 'tcm-row';
        row.style.cssText = 'display:flex;gap:6px;margin-top:8px;';

        const mkItem = (label) => {
            const b = doc.createElement('button');
            b.className = 'tcm-item';
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = 'flex:1;background:#2a2a2a;color:#ddd;border:1px solid #444;' +
                'border-radius:5px;padding:4px 8px;cursor:pointer;font-size:12px;';
            return b;
        };

        const custom = mkItem('Custom…');
        custom.onclick = () => {
            const picker = doc.createElement('input');
            picker.type = 'color';
            picker.value = (this.tabColors && this.tabColors[key]) || '#5b6ee1';
            picker.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;opacity:0;';
            host.appendChild(picker);
            const finish = () => {
                this.setTabColor(key, picker.value);
                picker.remove();
                this._closeTabColorMenu();
            };
            picker.addEventListener('change', finish);
            picker.addEventListener('input', () => this.setTabColor(key, picker.value));
            picker.click();
        };
        row.appendChild(custom);

        const clear = mkItem('Clear');
        clear.classList.add('tcm-clear');
        clear.onclick = () => { this.setTabColor(key, null); this._closeTabColorMenu(); };
        row.appendChild(clear);

        menu.appendChild(row);
        host.appendChild(menu);

        // Position relative to the container, clamped so it stays inside it.
        const hostRect = host.getBoundingClientRect();
        let px = x - hostRect.left;
        let py = y - hostRect.top;
        px = Math.max(4, Math.min(px, hostRect.width  - menu.offsetWidth  - 4));
        py = Math.max(4, Math.min(py, hostRect.height - menu.offsetHeight - 4));
        menu.style.left = px + 'px';
        menu.style.top  = py + 'px';

        this._tabColorMenuEl = menu;
        this._tabColorMenuDoc = doc;
        this._tabColorMenuDismiss = (ev) => {
            if (ev && ev.type === 'pointerdown' && this._eventHitsMenu(ev, menu)) return;
            this._closeTabColorMenu();
        };
        this._tabColorMenuKey = (ev) => { if (ev.key === 'Escape') this._closeTabColorMenu(); };
        // Defer so the opening right-click doesn't immediately dismiss it.
        setTimeout(() => {
            const win = doc.defaultView || window;
            doc.addEventListener('pointerdown', this._tabColorMenuDismiss, true);
            win.addEventListener('blur', this._tabColorMenuDismiss, true);
            doc.addEventListener('keydown', this._tabColorMenuKey, true);
        }, 0);
    },

    // ── Compare mode ─────────────────────────────────────────────────────────

    // Cycle the "c" hotkey through the compare modes, mirroring the compare
    // (rotate) button's slider-mode cycle but adding an OFF state so the hotkey
    // can also exit: off → split (vertical) → split (horizontal) → contact → off.
    cycleCompareMode() {
        if (!this.isComparing) { this.toggleCompare(); return; }   // off → vertical
        if (this.sliderMode === 'vertical')        this.setSliderMode('horizontal');
        else if (this.sliderMode === 'horizontal') this.setSliderMode('contact');
        else                                       this.toggleCompare();   // contact → off
    },

    toggleCompare() {
        this.isComparing = !this.isComparing;
        if (this.isComparing) {
            // A history-snapshot compare supplies its own second image, so don't
            // grab an unrelated tab as the compare source underneath it.
            if (!this.compareTab && !this.historyCompare) {
                const candidates = Object.keys(this.allTabs).filter(k => k !== this.activeTab);
                if (candidates.length > 0) this.compareTab = candidates[0];
            }
            this.rotateBtn.style.display   = "block";
            this.imgCompare.style.display  = "block";
            this.sliderMode                = 'vertical';
            this.slider.className          = 'slider-v';
            Object.assign(this.slider.style, { top: '0', bottom: '0', left: '', right: '', width: '2px', height: 'auto', display: 'block' });
            this.viewport.classList.remove('contact-mode');
            if (this.contactContainer) { this.contactContainer.style.transform = ''; this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.setFrame(this.currentFrame);
            // The compare layer carries the shared zoom/pan plus its aspect-match
            // scale. Without this it keeps whatever transform it had when compare
            // was last off — usually none — and renders at the wrong size.
            this.updateTransform();
            this.updateCompareVisuals();
            this._scheduleCompareSync();
            this._startCompareTicker();
        } else {
            this.rotateBtn.style.display          = "none";
            this.imgCompare.style.display         = "none";
            if (this._hideCompareVideo) this._hideCompareVideo();
            if (this.videoCompare) this.videoCompare.dataset.key = "";
            this.slider.style.display             = "none";
            this.imgCompare.style.clipPath        = "none";
            this.viewport.classList.remove('contact-mode');
            this.viewport.style.transform         = '';
            if (this.contactContainer) { this.contactContainer.style.transform = ''; this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.resetContactImageSizing();
            if (this.sliderMode === 'contact') { this.sliderMode = 'vertical'; this.slider.className = 'slider-v'; }
            this.updateTransform();
            this.fitView();
            this._stopCompareTicker();
        }
        this.updateTabHighlights();
    },

    // ── Slider modes ─────────────────────────────────────────────────────────

    toggleSliderOrientation() { this.cycleSliderMode(); },

    cycleSliderMode() {
        if (this.sliderMode === 'vertical')   this.setSliderMode('horizontal');
        else if (this.sliderMode === 'horizontal') this.setSliderMode('contact');
        else this.setSliderMode('vertical');
    },

    setSliderMode(mode) {
        this.sliderMode = mode;
        if (mode === 'contact') {
            // Fit against the 2-wide combined canvas once both frames are decoded
            // (resizeContactContainer clears this after the fit).
            this._contactNeedsFit = true;
            this.slider.style.display         = 'none';
            this._activeCompareEl().style.display = 'block';
            this.imgCompare.style.clipPath    = 'none';
            if (this.videoCompare) this.videoCompare.style.clipPath = 'none';
            this.resizeContactContainer();
        } else {
            this.slider.style.display = 'block';
            if (this.contactContainer) { this.contactContainer.style.width = ''; this.contactContainer.style.height = ''; }
            this.resetContactImageSizing();
            if (mode === 'vertical') {
                this.slider.className = 'slider-v';
                Object.assign(this.slider.style, { top: '0', bottom: '0', left: '', right: '', width: '2px', height: 'auto' });
            } else {
                this.slider.className = 'slider-h';
                Object.assign(this.slider.style, { left: '0', right: '0', top: '', bottom: '', height: '2px', width: 'auto' });
            }
        }
        this.applyContactClass();
        // Transform first: the wipe seam is measured against the compare layer's
        // resulting on-screen box, so that box has to be current before the seam
        // is placed against it.
        this.updateTransform();
        this.fitView();
        this.updateCompareVisuals();
        // Re-resolve which compare layer shows (img vs video) and re-seek it.
        if (this.isComparing) this._updateCompareFrame(this.currentFrame);
        this._scheduleCompareSync();
    },

    applyContactClass() {
        if (this.sliderMode === 'contact') {
            this.viewport.classList.add('contact-mode');
            this.resizeContactContainer();
        } else {
            this.viewport.classList.remove('contact-mode');
            this.resetContactImageSizing();
        }
    },

    resetContactImageSizing() {
        this.imgBase.style.width = '';
        this.imgBase.style.height = '';
        this.imgCompare.style.width = '';
        this.imgCompare.style.height = '';
        if (this.videoBase)    { this.videoBase.style.width = '';    this.videoBase.style.height = ''; }
        if (this.videoCompare) { this.videoCompare.style.width = ''; this.videoCompare.style.height = ''; }
    },

    // Is the compare source a video (routed to the compare <video> instead of the
    // <img>)? Reads _compareFrames so it is right for a history-snapshot compare
    // too, not just a compare tab — measuring the wrong (hidden) element here
    // yields a zero-sized rect and a clip-path that hides the compare layer.
    _compareIsVideo() {
        if (!this.isComparing) return false;
        const c = this._compareFrames ? this._compareFrames() : null;
        return !!(c && c.length && this._frameIsVideo && this._frameIsVideo(c[0]));
    },

    // The compare layer element that is actually showing (video or img).
    _activeCompareEl() {
        return (this._compareIsVideo() && this.videoCompare) ? this.videoCompare : this.imgCompare;
    },

    // The base layer element that is actually showing (video or img).
    _activeBaseEl() {
        return (this._videoMode && this.videoBase) ? this.videoBase : this.imgBase;
    },

    // Natural pixel size of the compare media, whether it's an image or a video.
    _compareMediaSize() {
        if (this._compareIsVideo() && this.videoCompare)
            return { w: this.videoCompare.videoWidth || 0, h: this.videoCompare.videoHeight || 0 };
        return { w: this.imgCompare.naturalWidth || 0, h: this.imgCompare.naturalHeight || 0 };
    },

    // Natural pixel size of the base media, whether it's an image or a video. A
    // video base hides imgBase (no naturalWidth), so the <video> must be read.
    _baseMediaSize() {
        if (this._videoMode && this.videoBase)
            return { w: this.videoBase.videoWidth || 0, h: this.videoBase.videoHeight || 0 };
        return { w: this.imgBase.naturalWidth || 0, h: this.imgBase.naturalHeight || 0 };
    },

    // Both layers get object-fit:contain against the same box, so each letterboxes
    // itself independently and media of a different resolution or aspect ratio end
    // up at different sizes. This returns the per-axis scale that stretches the
    // compare frame onto the base's frame EXACTLY — same rectangle, aspect ratio
    // deliberately broken when they differ.
    //
    // That is the point: every pixel of the wipe then has picture on both sides of
    // the seam. Fitting the compare inside the base instead (the previous rule)
    // keeps its shape but leaves bars where there is nothing to compare against,
    // and a 480x832 clip against a 1920x1080 plate becomes a narrow band down the
    // middle. Matching only the seam's own axis (the rule before that) lined up
    // two edges and let the other run away entirely.
    //
    // Returns null when either size is not decoded yet — callers must treat that
    // as "leave it alone", not as a scale of 1.
    _compareFitScale() {
        if (!this.isComparing || this.sliderMode === 'contact') return null;
        // Base decoded size (a video base hides imgBase, so read the <video>).
        const base = this._baseMediaSize();
        const cmp  = this._compareMediaSize();
        if (!base.w || !base.h || !cmp.w || !cmp.h) return null;
        const box = this.viewport.getBoundingClientRect();
        if (!box.width || !box.height) return null;
        // Rendered size of each, letterboxed into the shared box by object-fit.
        const bFit = Math.min(box.width / base.w, box.height / base.h);
        const cFit = Math.min(box.width / cmp.w,  box.height / cmp.h);
        const x = (base.w * bFit) / (cmp.w * cFit);
        const y = (base.h * bFit) / (cmp.h * cFit);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
        return { x, y };
    },

    // Apply the shared zoom/pan to the compare layers, plus the per-axis stretch
    // that puts the compare frame on the base's frame in wipe/split modes.
    _applyCompareTransform() {
        if (this.sliderMode === 'contact') return;   // contact positions via flex
        const f  = this._compareFitScale();
        const sx = f ? f.x : 1, sy = f ? f.y : 1;
        const tc = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom * sx}, ${this.zoom * sy})`;
        this.imgCompare.style.transform = tc;
        if (this.videoCompare) this.videoCompare.style.transform = tc;
    },

    // Everything the compare layout is derived from. Cheap to build: three reads
    // of already-decoded sizes plus one rect.
    _compareLayoutSig() {
        const b = this._baseMediaSize(), c = this._compareMediaSize();
        const r = this.viewport.getBoundingClientRect();
        return [b.w, b.h, c.w, c.h, Math.round(r.width), Math.round(r.height),
                this.zoom, this.panX, this.panY, this.sliderMode, this.sliderPos].join(',');
    },

    // While compare mode is on, the layout is kept honest by a frame ticker rather
    // than by resize notifications alone.
    //
    // The layout depends on the viewport box, and the events that report that box
    // changing have proved unreliable in the places this viewer runs: a
    // ResizeObserver stops delivering once undocking moves its target into the
    // popout's document, and the ComfyUI tab stops painting altogether once the
    // popout covers it. The failure is not cosmetic — the compare and the base
    // drift to different sizes as the window grows and the wipe stops lining up,
    // which is exactly the bug this replaced.
    //
    // A tick is a signature comparison; styles are written only when something
    // actually moved, so a compare that is sitting still costs one cheap callback
    // per frame and nothing else. It stops as soon as compare mode is switched off.
    _startCompareTicker() {
        this._stopCompareTicker();
        const win = this._viewerWindow();
        if (!win || !win.requestAnimationFrame) return;
        const tick = () => {
            if (!this.isComparing) { this._compareTicker = null; return; }
            try {
                const sig = this._compareLayoutSig();
                if (sig !== this._compareLayoutLastSig) {
                    this._compareLayoutLastSig = sig;
                    this._syncCompareLayout();
                    this.updateImageFrame && this.updateImageFrame();
                }
            } catch (e) { /* never let a bad frame kill the loop */ }
            this._compareTicker = win.requestAnimationFrame(tick);
        };
        this._compareLayoutLastSig = null;
        this._compareTicker = win.requestAnimationFrame(tick);
    },

    _stopCompareTicker() {
        if (!this._compareTicker) return;
        const win = this._viewerWindow();
        try { win && win.cancelAnimationFrame && win.cancelAnimationFrame(this._compareTicker); } catch (e) {}
        this._compareTicker = null;
        this._compareLayoutLastSig = null;
    },

    // Re-derive everything about the compare layer that depends on the two media
    // sizes: the side-by-side layout, the aspect-match scale and the wipe seam.
    //
    // Both decoded sizes arrive asynchronously and in either order, so anything
    // that learns a new one (an image load, a video's metadata/resize, a new
    // compare source, a viewport resize) calls this instead of recomputing a
    // subset. Note this deliberately does NOT go through updateTransform: that
    // skips no-op zoom/pan signatures, which is exactly the case here — the media
    // changed size, the zoom didn't.
    _syncCompareLayout() {
        if (!this.isComparing) return;
        if (this.sliderMode === 'contact') this.resizeContactContainer();
        this._applyCompareTransform();
        this.updateCompareVisuals();
    },

    // Same thing, once more after the browser has laid the frame out. Entering
    // compare and switching seam orientation both derive the layout from whatever
    // is measurable at that instant, and everything else here is driven by media
    // events; this covers the case where the sizes were readable but no event was
    // left to hang the re-derive on. It rewrites the identical transform when
    // nothing changed, so it costs one rAF and is otherwise invisible.
    _scheduleCompareSync() {
        if (this._compareSyncRaf) return;
        // The viewer's own window, not the host element's: while undocked those
        // differ, and the ComfyUI tab's frames stop arriving once the popout is in
        // front of it — which is exactly when the popout is being used.
        const view = this._viewerWindow();
        if (!view || !view.requestAnimationFrame) { this._syncCompareLayout(); return; }
        this._compareSyncRaf = view.requestAnimationFrame(() => {
            this._compareSyncRaf = null;
            this._syncCompareLayout();
        });
    },

    getContactLayout() {
        const base  = this._baseMediaSize();
        const baseW = base.w;
        const baseH = base.h;
        const comp  = this._compareMediaSize();
        const compW = comp.w;
        const compH = comp.h;

        if (!baseW || !baseH || !compW || !compH) return null;

        const targetH = Math.min(baseH, compH);
        const baseScale = baseH > targetH ? (targetH / baseH) : 1;
        const compScale = compH > targetH ? (targetH / compH) : 1;

        const baseDrawW = Math.max(1, Math.round(baseW * baseScale));
        const baseDrawH = Math.max(1, Math.round(baseH * baseScale));
        const compDrawW = Math.max(1, Math.round(compW * compScale));
        const compDrawH = Math.max(1, Math.round(compH * compScale));

        return {
            baseDrawW,
            baseDrawH,
            compDrawW,
            compDrawH,
            contW: baseDrawW + compDrawW,
            contH: Math.max(baseDrawH, compDrawH),
        };
    },

    resizeContactContainer() {
        if (!this.contactContainer) return;
        const layout = this.getContactLayout();
        if (!layout) {
            this.contactContainer.style.width = '';
            this.contactContainer.style.height = '';
            this.resetContactImageSizing();
            return;
        }

        this.contactContainer.style.width  = layout.contW + 'px';
        this.contactContainer.style.height = layout.contH + 'px';

        const baseEl = this._activeBaseEl();
        baseEl.style.width = layout.baseDrawW + 'px';
        baseEl.style.height = layout.baseDrawH + 'px';
        const compEl = this._activeCompareEl();
        compEl.style.width = layout.compDrawW + 'px';
        compEl.style.height = layout.compDrawH + 'px';

        // The combined side-by-side size is only known once BOTH frames have
        // decoded. If a fit was requested before then (entering contact while the
        // compare frame was still loading), do it now against the real 2-wide
        // canvas so it isn't left cropped at a single-frame zoom.
        if (this._contactNeedsFit && this.sliderMode === 'contact') {
            this._contactNeedsFit = false;
            this.fitView();
        }
    },

    // ── Compare slider drag ───────────────────────────────────────────────────

    setupCompareSlider() {
        this.slider.onmousedown = (e) => {
            this.isDraggingSlider = true;
            e.preventDefault();
            e.stopPropagation();
            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                if (!this.isDraggingSlider) return;
                const rect    = this.viewport.getBoundingClientRect();
                const val     = this.sliderMode === "vertical"
                    ? (evt.clientX - rect.left)  / rect.width
                    : (evt.clientY - rect.top)   / rect.height;
                this.sliderPos = Math.max(0, Math.min(100, val * 100));
                this.updateCompareVisuals();
            };
            const onUp = () => {
                this.isDraggingSlider = false;
                win.removeEventListener('mousemove', onMove);
                win.removeEventListener('mouseup',   onUp);
            };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    updateCompareVisuals() {
        if (!this.isComparing) return;
        this.updateTabHighlights();
        const viewRect = this.viewport.getBoundingClientRect();
        // Clip is applied to the compare layer, so measure the wipe seam against
        // that layer's own on-screen box — it can be scaled differently from the
        // base (aspect-match scale), so the base rect would place the seam wrong.
        const compRect = this._activeCompareEl().getBoundingClientRect();
        let clip;
        if (this.sliderMode === "contact") {
            clip = "none";
        } else if (this.sliderMode === "vertical") {
            this.slider.style.left        = `${this.sliderPos}%`;
            this.slider.style.top         = "0";
            const sliderScreenX = (this.sliderPos / 100) * viewRect.width;
            const relX          = sliderScreenX - (compRect.left - viewRect.left);
            clip = `inset(0 0 0 ${(relX / compRect.width) * 100}%)`;
        } else {
            this.slider.style.top  = `${this.sliderPos}%`;
            this.slider.style.left = "0";
            const sliderScreenY = (this.sliderPos / 100) * viewRect.height;
            const relY          = sliderScreenY - (compRect.top - viewRect.top);
            clip = `inset(${(relY / compRect.height) * 100}% 0 0 0)`;
        }
        // Apply to both compare layers; the inactive one is display:none anyway.
        this.imgCompare.style.clipPath = clip;
        if (this.videoCompare) this.videoCompare.style.clipPath = clip;
    },

    // ── Transform / zoom ─────────────────────────────────────────────────────

    updateTransform() {
        // Skip no-op updates to reduce style invalidation. isComparing is part of
        // the signature because entering compare has to push a transform onto the
        // compare layer even when zoom/pan haven't moved.
        const sig = `${this.panX},${this.panY},${this.zoom},${this.sliderMode},${this.isComparing}`;
        if (sig === this._lastTransformSig) return;
        this._lastTransformSig = sig;

        const t = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        if (this.sliderMode === 'contact' && this.contactContainer) {
            const contW    = this.contactContainer.offsetWidth;
            const contH    = this.contactContainer.offsetHeight;
            const viewRect = this.viewport.getBoundingClientRect();
            const tx = viewRect.width  / 2 - this.zoom * contW / 2 + this.panX;
            const ty = viewRect.height / 2 - this.zoom * contH / 2 + this.panY;
            this.contactContainer.style.transform = `translate(${tx}px, ${ty}px) scale(${this.zoom})`;
            this.viewport.style.transform  = '';
            this.imgBase.style.transform   = '';
            this.imgCompare.style.transform = '';
            if (this.videoBase) this.videoBase.style.transform = '';
            if (this.videoCompare) this.videoCompare.style.transform = '';
        } else {
            if (this.contactContainer) this.contactContainer.style.transform = '';
            this.viewport.style.transform   = '';
            this.imgBase.style.transform    = t;
            // Video shares the image zoom/pan transform so it scrubs, zooms and
            // pans exactly like an image sequence.
            if (this.videoBase) this.videoBase.style.transform = t;
            // Compare layers add an aspect-match scale on top of the shared zoom.
            this._applyCompareTransform();
        }
        this.updateImageFrame();
        this.updateCompareVisuals();
        this.updateTabHighlights();
        this.updateToolOverlay && this.updateToolOverlay();
    },

    updateImageFrame() {
        if (!this.imgFrame || !this.imgBase || !this.viewport) return;
        if (this.sliderMode === 'contact' || !this.imgBase.naturalWidth || !this.imgBase.naturalHeight) {
            this.imgFrame.style.display = 'none';
            return;
        }

        const elW = this.imgBase.clientWidth;
        const elH = this.imgBase.clientHeight;
        if (!elW || !elH) {
            this.imgFrame.style.display = 'none';
            return;
        }

        const fitScale = Math.min(elW / this.imgBase.naturalWidth, elH / this.imgBase.naturalHeight);
        const drawW = Math.max(1, this.imgBase.naturalWidth * fitScale);
        const drawH = Math.max(1, this.imgBase.naturalHeight * fitScale);
        const left = (elW - drawW) * 0.5;
        const top = (elH - drawH) * 0.5;

        this.imgFrame.style.left = `${left}px`;
        this.imgFrame.style.top = `${top}px`;
        this.imgFrame.style.width = `${drawW}px`;
        this.imgFrame.style.height = `${drawH}px`;
        this.imgFrame.style.transform = this.imgBase.style.transform || '';
        this.imgFrame.style.display = 'block';
    },

    // ── Zoom & pan ────────────────────────────────────────────────────────────

    // Zoom while keeping the image point under (clientX, clientY) fixed, so the
    // cursor position acts as the zoom anchor instead of the image centre.
    _zoomAt(newZoom, clientX, clientY) {
        newZoom = Math.max(0.05, Math.min(newZoom, 20.0));
        // Contact mode uses a different transform origin; fall back to plain zoom.
        if (this.sliderMode === 'contact') { this.zoom = newZoom; this.updateTransform(); return; }
        const rect = this.viewport.getBoundingClientRect();
        if (!rect.width || !rect.height) { this.zoom = newZoom; this.updateTransform(); return; }
        const sx = clientX - rect.left, sy = clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const ratio = newZoom / (this.zoom || 1);
        // screen(p) = C + zoom*(p-C) + pan  →  solve pan so the cursor point stays put
        this.panX = sx - cx - ratio * (sx - cx - this.panX);
        this.panY = sy - cy - ratio * (sy - cy - this.panY);
        this.zoom = newZoom;
        this.updateTransform();
    },

    // UI that lives inside the viewport and owns its own mouse events — pan/zoom
    // must keep its hands off, or it steals the drag from sliders and buttons.
    _overViewportChrome(e) {
        const t = e.target;
        return !!(t && t.closest && t.closest(
            '#exposure-control, .bepic-toolbar, .bepic-tool-panel'));
    },

    setupZoomAndPan() {
        this.viewport.oncontextmenu = (e) => e.preventDefault();
        this.viewport.onwheel       = (e) => {
            if (this._overViewportChrome(e)) return;
            e.preventDefault();
            this._zoomAt(this.zoom + (e.deltaY > 0 ? -0.1 : 0.1), e.clientX, e.clientY);
        };

        this.viewport.onmousedown = (e) => {
            if (e.target.id === 'compare-slider') return;
            if (this._overViewportChrome(e)) return;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            if (this.isExposureModifierActive) {
                this.isExposureDragging = true;
                e.preventDefault();
            } else if (e.button === 2) {
                this.isZooming = true;
                // Anchor the scrub-zoom at the point where the drag started.
                this._zoomAnchorX = e.clientX;
                this._zoomAnchorY = e.clientY;
                e.preventDefault();
            } else if (e.button === 1) {
                // Middle-button always pans (works even when a tool has taken
                // over left-drag).
                this.isPanning = true;
                e.preventDefault();
            } else if (e.button === 0) {
                this.isPanning = true;
                e.preventDefault();
            }

            const win = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                if (this.isExposureDragging) {
                    this.setExposure(this.exposure + (evt.clientX - this.lastMouseX) * 0.02);
                }
                if (this.isZooming) {
                    const nz = this.zoom + (evt.clientX - this.lastMouseX) * 0.005 * this.zoom;
                    this._zoomAt(nz, this._zoomAnchorX, this._zoomAnchorY);
                }
                if (this.isPanning) {
                    this.panX += evt.clientX - this.lastMouseX;
                    this.panY += evt.clientY - this.lastMouseY;
                    this.updateTransform();
                }
                this.lastMouseX = evt.clientX;
                this.lastMouseY = evt.clientY;
            };
            const onUp = (evt) => {
                if (evt.button === 2) this.isZooming = false;
                if (evt.button === 0 || evt.button === 1) this.isPanning = false;
                this.isExposureDragging = false;
                if (!this.isZooming && !this.isPanning && !this.isExposureDragging) {
                    win.removeEventListener('mousemove', onMove);
                    win.removeEventListener('mouseup',   onUp);
                }
            };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── Panel resize handles ─────────────────────────────────────────────────

    setupResizing() {
        let activeR = null;
        this.shadowRoot.querySelectorAll('.resizer').forEach(r => {
            r.onmousedown = (e) => { activeR = e.target.className; e.preventDefault(); };
        });
        window.addEventListener('mousemove', (e) => {
            if (!activeR) return;
            const rect = this.getBoundingClientRect();
            if (activeR.includes('r-right')  || activeR.includes('r-br') || activeR.includes('r-tr')) { const w = e.clientX - rect.left;   if (w > 200) this.style.width  = `${w}px`; }
            if (activeR.includes('r-bottom') || activeR.includes('r-br') || activeR.includes('r-bl')) { const h = e.clientY - rect.top;    if (h > 200) this.style.height = `${h}px`; }
            if (activeR.includes('r-left')   || activeR.includes('r-bl') || activeR.includes('r-tl')) { const delta = rect.left - e.clientX; const nw = rect.width  + delta; if (nw > 200) { this.style.left = `${e.clientX}px`; this.style.width  = `${nw}px`; } }
            if (activeR.includes('r-top')    || activeR.includes('r-tr') || activeR.includes('r-tl')) { const delta = rect.top  - e.clientY; const nh = rect.height + delta; if (nh > 200) { this.style.top  = `${e.clientY}px`; this.style.height = `${nh}px`; } }
        });
        window.addEventListener('mouseup', () => { activeR = null; });
    },

    // ── History panel resize ─────────────────────────────────────────────────

    setupHistoryResizing() {
        if (!this.historyResizer || !this.historyPanel) return;
        this.historyResizer.onmousedown = (e) => {
            e.preventDefault();
            const startX     = e.clientX;
            const startWidth = this.historyPanel.getBoundingClientRect().width;
            const win        = this.container.ownerDocument.defaultView || window;

            const onMove = (evt) => {
                try {
                    const panelRect = this.historyPanel.getBoundingClientRect();
                    const newWidth  = this.historyPanel.classList.contains('right')
                        ? Math.round(Math.max(60, Math.min(600, panelRect.right - evt.clientX)))
                        : Math.round(Math.max(60, Math.min(600, evt.clientX - panelRect.left)));
                    this.historyPanel.style.width = `${newWidth}px`;
                } catch (e) { /* ignore */ }
            };
            const onUp = () => { win.removeEventListener('mousemove', onMove); win.removeEventListener('mouseup', onUp); };
            win.addEventListener('mousemove', onMove);
            win.addEventListener('mouseup',   onUp);
        };
    },

    // ── Panel dragging ────────────────────────────────────────────────────────

    setupPanelDragging() {
        const startDrag = (e) => {
            if (e.target.closest('.tab'))                return;
            if (e.target.closest('button, select, input')) return;
            const rect = this.getBoundingClientRect();
            if (e.clientY - rect.top > 40)               return;

            this.isDraggingPanel = true;
            this.dragStartX      = e.clientX - rect.left;
            this.dragStartY      = e.clientY - rect.top;

            this.style.bottom = "auto"; this.style.right  = "auto";
            this.style.width  = `${rect.width}px`;
            this.style.height = `${rect.height}px`;
            this.style.left   = `${rect.left}px`;
            this.style.top    = `${rect.top}px`;
            e.preventDefault();
        };

        this.tabBar.onmousedown       = startDrag;
        this.container.onmousedown    = startDrag;

        window.addEventListener('mousemove', (e) => {
            if (!this.isDraggingPanel) return;
            this.style.left = `${e.clientX - this.dragStartX}px`;
            this.style.top  = `${e.clientY - this.dragStartY}px`;
        });
        window.addEventListener('mouseup', () => { this.isDraggingPanel = false; });
    },
};
