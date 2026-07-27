// bEpicViewer.js    main entry point
// The ViewerPanel class is assembled from focused mixin modules so the
// overall codebase stays manageable while sharing one prototype chain.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { registerBepicGetPath } from "./bEpicGetPath.js";

import { LayoutMixin }   from "./bEpicViewer_mixinLayout.js";
import { HistoryMixin }  from "./bEpicViewer_mixinHistory.js";
import { PlaybackMixin } from "./bEpicViewer_mixinPlayback.js";
import { ParamsMixin }   from "./bEpicViewer_mixinParams.js";
import { UIMixin }       from "./bEpicViewer_mixinUI.js";
import { ToolsMixin }    from "./bEpicViewer_tools.js";
import { RotoMixin }     from "./bEpicViewer_roto.js";
import { AnnotateMixin } from "./bEpicViewer_annotate.js";
import { DnDMixin }      from "./bEpicViewer_mixinDnD.js";
import { SendFromNodeMixin, registerSendToViewerMenu } from "./bEpicViewer_sendFromNode.js";
import { registerSendNode } from "./bEpicViewer_nodeTools.js";

let globalViewerPanel = null;
const watchedNodeIds  = new Set();

// Tab keys the user opened by hand rather than ones mirroring a node in the
// graph: 📂 Open Folder, 📥 dropped files, and 🖼/🎬 "Send to Image Viewer".
// Nothing in the graph backs them, so the stale-tab sweep must leave them be.
const USER_TAB_PREFIXES = ["folder_", "dropped_", "loader_"];
let isViewerPanelToggledOn = false;
let _actionBarStateRetryTimer = null;

function _ensureActionBarActiveStyle() {
    const styleId = "bepic-viewer-actionbar-active-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
        [title="Toggle bEpic Image Viewer"].bepic-viewer-actionbar-active,
        button[title="Toggle bEpic Image Viewer"].bepic-viewer-actionbar-active {
            color: #f60 !important;
        }
    `;
    document.head.appendChild(style);
}

function _updateActionBarButtonState() {
    _ensureActionBarActiveStyle();
    try {
        const nodes = Array.from(document.querySelectorAll('[title="Toggle bEpic Image Viewer"]'));
        if (nodes.length > 0) {
            nodes.forEach((node) => {
                node.classList.toggle('bepic-viewer-actionbar-active', isViewerPanelToggledOn);
            });
            if (_actionBarStateRetryTimer) {
                clearTimeout(_actionBarStateRetryTimer);
                _actionBarStateRetryTimer = null;
            }
        } else if (!_actionBarStateRetryTimer) {
            _actionBarStateRetryTimer = setTimeout(() => {
                _actionBarStateRetryTimer = null;
                _updateActionBarButtonState();
            }, 200);
        }
    } catch (e) {
        if (_actionBarStateRetryTimer) {
            clearTimeout(_actionBarStateRetryTimer);
            _actionBarStateRetryTimer = null;
        }
    }
}

function _setViewerPanelToggle(nextState, { syncDisplay = true } = {}) {
    isViewerPanelToggledOn = !!nextState;
    if (!globalViewerPanel) return;
    globalViewerPanel.setViewerToggleState(isViewerPanelToggledOn, { syncDisplay });
    _updateActionBarButtonState();
}

function _toggleViewerPanelFromUi() {
    _setViewerPanelToggle(!isViewerPanelToggledOn, { syncDisplay: true });
}

// Preload CSS + HTML + icon skin in parallel so they are ready before the first
// element is connected to the DOM.
const timestamp    = Date.now();
const cssPromise   = fetch(new URL(`./bEpicViewer.css?v=${timestamp}`,            import.meta.url)).then(r => r.text());
const htmlPromise  = fetch(new URL(`./bEpicViewer.html?v=${timestamp}`,           import.meta.url)).then(r => r.text());
const iconsPromise = fetch(new URL(`./bEpicViewer_iconsUIsvg.json?v=${timestamp}`, import.meta.url)).then(r => r.json());

/**
 * Icon-to-button mapping.  Each entry maps a DOM id (or special key)
 * to the icon key in the JSON skin file.
 */
const ICON_MAP = {
    'play':              'icon-play',
    's-start':           'icon-skip-start',
    's-end':             'icon-skip-end',
    's-prev':            'icon-prev',
    's-next':            'icon-next',
    'fit-btn':           'icon-fit',
    'shape-btn':         'icon-shape',
    'rotate-btn':        'icon-rotate-slider',
    'close-panel-btn':   'icon-close',
    'undock-btn':        'icon-undock',
    'layout-btn':        'icon-layout',
    'history-toggle-btn':'icon-history',
    'params-btn':        'icon-params',
    'range-btn':         'icon-range',
    'refresh':           'icon-refresh',
    'open-folder-btn':   'icon-folder',
    'clear-cache-btn':   'icon-delete',
    'history-clear-btn': 'icon-delete',
    'help-btn':          'icon-help',
    'params-dock-btn':   'icon-dock-right',
    'params-lock-btn':   'icon-unlock',
};

// 
class ViewerPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        //  State 
        this.allTabs             = {};
        this.activeTab           = null;
        this.compareTab          = null;
        this.isComparing         = false;
        this.showShape           = true;
        this.customLayouts       = {};
        this.tabLabels           = {};
        this.tabColors           = {};
        this.sliderPos           = 50;
        this.isDraggingSlider    = false;
        this.sliderMode          = "vertical";
        this.currentFrame        = 0;
        this.isPlaying           = false;
        this.direction           = 1;
        this.fps                 = 25;
        this.exposure            = 0;
        this.channelView         = 'all';
        this.isExposureModifierActive = false;
        this.isExposureDragging  = false;
        this.loopMode            = "loop";
        this.zoom                = 1.0;
        this.panX                = 0;
        this.panY                = 0;
        this.isDraggingPanel     = false;
        this.dragStartX          = 0;
        this.dragStartY          = 0;
        this.isHovered           = false;
        this.playbackRange       = null;
        this.isSelectingRange    = false;
        this.isInputRangeLocked  = false;
        this.lockedTimelineRange = null;
        this.originalNodeValues  = new Map();
        this.popoutWindow        = null;
        this.paramsSide          = "right";
        this.selectedNodeIds     = [];
        this.history             = {};
        this.tabViewState        = {};
        this.isViewingHistory    = false;
        this.previewBackup       = null;
        this.tabOrder            = [];
        this.paramsLocked        = false;
        this.tabSourceNodeIds    = {};
        this.paramTextSizes      = {};
        this.paramResizeObservers = [];
        // Mixin optimisation: fast-path skip signatures
        this._historyPanelSig    = null;
        this._lastTransformSig   = null;
        this._persistTimer       = null;
        this._isRestoringViewerState = false;
        this._beforeUnloadHandler = null;
        this.viewerToggleEnabled = false;

        this.init();
    }

    setViewerToggleState(enabled, { syncDisplay = true } = {}) {
        this.viewerToggleEnabled = !!enabled;
        if (!syncDisplay) return;
        if (this.viewerToggleEnabled) {
            if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
        } else {
            if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "none";
        }
    }

    requestPanelOpen() {
        if (!this.viewerToggleEnabled) return;
        if (!this.popoutWindow || this.popoutWindow.closed) this.style.display = "flex";
    }

    connectedCallback() {
        if (!this._beforeUnloadHandler) {
            this._beforeUnloadHandler = () => this.persistViewerState();
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }
    }

    disconnectedCallback() {
        this.persistViewerState();
        if (this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
    }

    _getViewerStateStorageKey() {
        let path = 'default';
        try { path = (window?.location?.pathname || 'default'); } catch (e) {}
        return `bEpicViewer:state:v1:${path}`;
    }

    queuePersistViewerState() {
        if (this._isRestoringViewerState) return;
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            this.persistViewerState();
        }, 150);
    }

    persistViewerState() {
        if (this._isRestoringViewerState) return;
        try {
            // Dropped-file tabs live on blob: URLs that die on reload — never
            // persist them (they would restore as broken images).
            const keepKey = (k) => !String(k).startsWith('dropped_');
            const pick = (obj) => {
                const out = {};
                Object.keys(obj || {}).forEach((k) => { if (keepKey(k)) out[k] = obj[k]; });
                return out;
            };
            const activeTab = keepKey(this.activeTab) ? (this.activeTab || null) : null;
            const payload = {
                version: 1,
                allTabs: pick(this.allTabs),
                history: pick(this.history),
                tabViewState: pick(this.tabViewState),
                tabLabels: pick(this.tabLabels),
                tabColors: pick(this.tabColors),
                tabOrder: (Array.isArray(this.tabOrder) ? this.tabOrder : []).filter(keepKey),
                activeTab,
                savedAt: Date.now(),
            };
            window.localStorage.setItem(this._getViewerStateStorageKey(), JSON.stringify(payload));
        } catch (e) {
            console.warn('bEpicViewer persist state failed', e);
        }
    }

    restoreViewerState() {
        let raw = null;
        let parsed = null;
        try {
            raw = window.localStorage.getItem(this._getViewerStateStorageKey());
            if (!raw) return false;
            parsed = JSON.parse(raw);
        } catch (e) {
            console.warn('bEpicViewer restore state parse failed', e);
            return false;
        }

        if (!parsed || typeof parsed !== 'object') return false;

        const restoredTabs = (parsed.allTabs && typeof parsed.allTabs === 'object') ? parsed.allTabs : {};
        const restoredHistory = (parsed.history && typeof parsed.history === 'object') ? parsed.history : {};
        const restoredTabViewState = (parsed.tabViewState && typeof parsed.tabViewState === 'object') ? parsed.tabViewState : {};
        const restoredLabels = (parsed.tabLabels && typeof parsed.tabLabels === 'object') ? parsed.tabLabels : {};
        const restoredColors = (parsed.tabColors && typeof parsed.tabColors === 'object') ? parsed.tabColors : {};
        const restoredOrder = Array.isArray(parsed.tabOrder) ? parsed.tabOrder : [];
        const restoredActive = typeof parsed.activeTab === 'string' ? parsed.activeTab : null;

        const keys = Object.keys(restoredTabs);
        if (keys.length === 0 && Object.keys(restoredHistory).length === 0) return false;

        this._isRestoringViewerState = true;
        try {
            this.allTabs = JSON.parse(JSON.stringify(restoredTabs));
            this.history = JSON.parse(JSON.stringify(restoredHistory));
            this.tabViewState = JSON.parse(JSON.stringify(restoredTabViewState));
            this.tabLabels = JSON.parse(JSON.stringify(restoredLabels));
            this.tabColors = JSON.parse(JSON.stringify(restoredColors));

            const known = restoredOrder.filter(k => !!this.allTabs[k]);
            const added = Object.keys(this.allTabs).filter(k => !known.includes(k));
            this.tabOrder = [...known, ...added];

            if (restoredActive && this.allTabs[restoredActive]) this.activeTab = restoredActive;
            else this.activeTab = this.tabOrder[0] || Object.keys(this.allTabs)[0] || null;

            this.previewBackup = null;
            this.isViewingHistory = false;
            this.currentHistoryKey = null;
            this.currentHistoryIndex = null;

            this._historyPanelSig = null;
            this._rebuildTabBar(null);
            this.renderHistoryPanel();

            return true;
        } catch (e) {
            console.warn('bEpicViewer restore state apply failed', e);
            return false;
        } finally {
            this._isRestoringViewerState = false;
        }
    }

    //  Async init 
    async init() {
        const [css, html, icons] = await Promise.all([cssPromise, htmlPromise, iconsPromise]);

        // Store the icon skin so dynamic swaps (play/pause, lock/unlock, etc.)
        // can look up SVG strings at runtime.
        this._iconSkin = icons;

        const style = document.createElement('style');
        style.textContent = css + `
            .img-layer {
                top:0; left:0; right:0; bottom:0; margin:auto;
                width:auto; height:auto;
                max-width:100%; max-height:100%;
            }
            .tab, .history-thumb { user-select:none; }
            .history-thumb.selected { border:1px solid #f60; }
            .history-thumb[draggable="true"] { cursor: grab; }
            #viewport.bepic-drop-hover { outline: 2px dashed #f60; outline-offset: -6px; }
            #viewport.bepic-drop-hover::after {
                content: "Drop images or videos to open";
                position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
                background: rgba(20,20,20,0.85); color: #f60; font-size: 12px;
                padding: 4px 10px; border-radius: 4px; pointer-events: none; z-index: 40;
            }
        `;
        this.shadowRoot.appendChild(style);

        this.container           = document.createElement('div');
        this.container.className = 'panel-container';
        this.container.innerHTML = html;
        this.shadowRoot.appendChild(this.container);

        this.container.onmouseenter = () => { this.isHovered = true;  };
        // mousemove bubbles up from the canvas and every child, so hover stays
        // correct even when onmouseenter was missed (panel shown under the
        // cursor) — otherwise hotkeys silently die while over the canvas.
        this.container.onmousemove  = () => { if (!this.isHovered) this.isHovered = true; };
        this.container.onmouseleave = () => { this.isHovered = false; };
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));

        this._cacheElements();
        this._initParamsPanel();
        this._initHistoryPanel();
        this._initToolbarButtons();
        this._applyIconSkin();          // inject inline SVGs from the JSON skin

        await this.loadFactoryDefault();
        await this.loadLayouts();
        this.applyFactoryDefault();
        // Layout menu population can mutate nearby controls in some browsers,
        // so re-assert icon skin once layouts are ready.
        this._applyIconSkin();

        this._bindToolbarHandlers();

        this.setupZoomAndPan();
        this.setupResizing();
        this.setupCompareSlider();
        this.setupPanelDragging();
        this.setupTimelineEvents();
        this._initTools();
        this.setupExplorerDrop();      // OS files → viewport
        this.setupGraphDropTarget();   // history thumb → ComfyUI graph

        this.currentParamNodeId  = null;
        this.currentHistoryKey   = null;
        this.currentHistoryIndex = null;
        this.historyCompare      = null;
        this.restoreViewerState();
        this.startParamMonitor();
    }

    //  Element reference cache 
    _cacheElements() {
        const sr = this.shadowRoot;
        this.imgBase          = sr.getElementById('img-base');
        this.imgCompare       = sr.getElementById('img-compare');
        this.videoBase        = sr.getElementById('video-base');
        this.videoCompare     = sr.getElementById('video-compare');
        this.imgFrame         = sr.getElementById('img-frame');
        this.contactContainer = sr.getElementById('contact-container');
        this.slider           = sr.getElementById('compare-slider');
        this.timeline         = sr.getElementById('timeline');
        this.playBtn          = sr.getElementById('play');
        this.viewport         = sr.getElementById('viewport');
        this.rotateBtn        = sr.getElementById('rotate-btn');
        this.tabBar           = sr.getElementById('tab-bar');
        this.tabsContainer    = sr.getElementById('tabs-container');
        this.closeBtn         = sr.getElementById('close-panel-btn');
        this.shapeBtn         = sr.getElementById('shape-btn');
        this.shapeOverlay     = sr.getElementById('shape-overlay');
        this.layoutSel        = sr.getElementById('layout-sel');
        this.refreshBtn       = sr.getElementById('refresh');
        this.helpBtn          = sr.getElementById('help-btn');
        this.helpOverlay      = sr.getElementById('hotkey-help');
        this.exposureControl  = sr.getElementById('exposure-control');
        this.exposureSlider   = sr.getElementById('exposure-slider');
        this.exposureValue    = sr.getElementById('exposure-value');
        this.rgbChannelSel    = sr.getElementById('rgb-channel-sel');
    }

    /** Set inline SVG icon on an element from the loaded skin. */
    _setIcon(el, iconKey) {
        if (!el || !this._iconSkin) return;
        const svg = this._iconSkin[iconKey];
        if (svg) el.innerHTML = svg;
    }

    /** Inject SVG icons into all .sprite-icon buttons based on ICON_MAP. */
    _applyIconSkin() {
        const sr = this.shadowRoot;
        for (const [id, iconKey] of Object.entries(ICON_MAP)) {
            const el = sr.getElementById(id);
            if (el) this._setIcon(el, iconKey);
        }
    }

    _syncHistoryToggleState() {
        if (!this.historyToggleBtn) return;
        const panel = this.historyPanel || this.shadowRoot?.getElementById('history-panel');
        const visible = !!(panel && panel.style.display !== 'none' && panel.style.display !== '');
        this.historyToggleBtn.classList.toggle('active', visible);
    }

    //  Parameters panel bootstrap 
    _initParamsPanel() {
        const sr = this.shadowRoot;

        this.paramsPanel = sr.getElementById('params-panel');

        if (!this.paramsPanel) {
            const mainArea     = document.createElement("div");
            mainArea.className = "main-area";
            if (this.viewport && this.viewport.parentNode) {
                this.viewport.parentNode.insertBefore(mainArea, this.viewport);
                mainArea.appendChild(this.viewport);
            }
            this.paramsPanel              = document.createElement("div");
            this.paramsPanel.id           = "params-panel";
            this.paramsPanel.className    = "params-panel right";
            this.paramsPanel.innerHTML    = `
                <div class="panel-resizer" id="panel-resizer"></div>
                <div class="params-header">
                    <button id="params-dock-btn" title="Switch Side"></button>
                    <span id="params-title">No Node Selected</span>
                    <button id="params-lock-btn" title="Lock  freeze to currently selected node"></button>
                </div>
                <div id="params-content" class="params-content"></div>
            `;
            mainArea.appendChild(this.paramsPanel);
        }

        // Robustness: ensure required child elements exist in cached HTML
        if (!this.paramsPanel.classList.contains('right') && !this.paramsPanel.classList.contains('left')) {
            this.paramsPanel.classList.add('right');
        }
        const pq = (id) => this.paramsPanel.querySelector(`#${id}`);
        if (!pq('panel-resizer')) {
            const r = document.createElement('div'); r.className = 'panel-resizer'; r.id = 'panel-resizer';
            this.paramsPanel.appendChild(r);
        }
        const header = this.paramsPanel.querySelector('.params-header');
        if (header && !header.querySelector('#params-dock-btn')) {
            const b = document.createElement('button'); b.id = 'params-dock-btn'; b.title = 'Switch Side'; b.innerText = '';
            header.insertBefore(b, header.firstChild);
        }
        if (header && !header.querySelector('#params-lock-btn')) {
            const b = document.createElement('button'); b.id = 'params-lock-btn'; b.title = 'Lock  freeze to currently selected node'; b.textContent = '';
            header.appendChild(b);
        }

        this.paramsContent  = sr.getElementById('params-content')  || pq('params-content');
        this.paramsTitle    = sr.getElementById('params-title')     || pq('params-title');
        this.paramsDockBtn  = sr.getElementById('params-dock-btn')  || pq('params-dock-btn');
        this.paramsLockBtn  = sr.getElementById('params-lock-btn')  || pq('params-lock-btn');
        this.panelResizer   = sr.getElementById('panel-resizer')    || pq('panel-resizer');

        this.paramsBtn = sr.getElementById('params-btn');
        if (!this.paramsBtn) {
            this.paramsBtn           = document.createElement("button");
            this.paramsBtn.id        = "params-btn";
            this.paramsBtn.innerText = "";
            this.paramsBtn.title     = "Toggle Parameters Panel";
            const histBtn = sr.getElementById('history-toggle-btn');
            if (histBtn && histBtn.parentNode) histBtn.parentNode.insertBefore(this.paramsBtn, histBtn.nextSibling);
            else if (this.refreshBtn && this.refreshBtn.parentNode) this.refreshBtn.parentNode.insertBefore(this.paramsBtn, this.refreshBtn);
        }

        this.paramsPanel.style.display = "none";
        this.paramsBtn.style.color     = "#eee";

        if (this.paramsDockBtn) this.paramsDockBtn.onclick = () => {
            this.toggleParamsSide();
            this.paramsDockBtn.classList.toggle('left', this.paramsSide === 'left');
        };
        if (this.paramsLockBtn) this.paramsLockBtn.onclick = () => {
            this.toggleParamsLock();
            this.paramsLockBtn.classList.toggle('locked', this.paramsLocked);
        };
        this.setupParamsResizing();

        this.paramsBtn.onclick = () => {
            if (!this.paramsPanel) return;
            const isHidden = this.paramsPanel.style.display === "none" || this.paramsPanel.style.display === "";
            this.paramsPanel.style.display = isHidden ? "flex" : "none";
            this.paramsBtn.style.color     = isHidden ? "#f60" : "#eee";
            this.paramsBtn.classList.toggle('active', isHidden);
            if (isHidden) this.updateParamsPanel(true);
        };
    }

    //  History panel bootstrap 
    _initHistoryPanel() {
        const sr = this.shadowRoot;

        this.historyStrip   = sr.getElementById('history-strip');
        this.historyClearBtn = sr.getElementById('history-clear-btn');
        this.historyPanel   = sr.getElementById('history-panel');
        this.historyResizer = sr.getElementById('history-resizer');

        if (this.historyPanel) this.historyPanel.style.display = 'none';

        try {
            const parent = this.viewport && this.viewport.parentNode;
            const hp     = this.historyPanel;
            if (hp && parent) {
                if (this.paramsSide === 'left') {
                    hp.classList.remove('left');  hp.classList.add('right');
                    parent.appendChild(hp);
                } else {
                    hp.classList.remove('right'); hp.classList.add('left');
                    parent.insertBefore(hp, this.viewport);
                }
                hp.style.left = ''; hp.style.right = '';
            }
        } catch (e) {}

        if (this.historyClearBtn) {
            this.historyClearBtn.disabled = true;
            if (this.historyPanel) this.historyPanel.style.position = 'relative';
            Object.assign(this.historyClearBtn.style, {
                position: 'absolute', top: '6px', left: '6px', right: '6px',
                width: 'calc(100% - 12px)', zIndex: '20',
                background: 'rgba(30,30,30,0.9)', color: '#fff', border: '1px solid #444',
                padding: '6px', textAlign: 'center', cursor: 'pointer',
            });
            this.historyClearBtn.addEventListener('click', (ev) => ev.stopPropagation());
            this.historyClearBtn.onclick = () => {
                const dlgWin = this.historyClearBtn.ownerDocument?.defaultView || window;
                const key = this.activeTab;
                if (!key) {
                    if (!dlgWin.confirm('Clear all in-memory history for all tabs?')) return;
                    this.history = {};
                } else {
                    if (!dlgWin.confirm(`Clear history for ${key}?`)) return;
                    delete this.history[key];
                }
                this.previewBackup       = null;
                this.isViewingHistory    = false;
                this._historyPanelSig    = null;
                if (this.historyStrip)   this.historyStrip.innerHTML = '';
                // Keep the history panel open after clearing — just refresh its (now empty) strip.
                if (this.renderHistoryPanel) this.renderHistoryPanel();
                this._syncHistoryToggleState();
                if (this.historyClearBtn) this.historyClearBtn.disabled = true;
                this.currentHistoryKey   = null;
                this.currentHistoryIndex = null;
                this.queuePersistViewerState();
            };
        }

        this.historyToggleBtn = sr.getElementById('history-toggle-btn');
        if (this.historyToggleBtn) {
            this.historyToggleBtn.onclick = () => {
                const panel = this.historyPanel || sr.getElementById('history-panel');
                if (!panel) return;
                const isHidden = panel.style.display === 'none' || panel.style.display === '';
                panel.style.display = isHidden ? 'flex' : 'none';
                if (isHidden) { this._historyPanelSig = null; this.renderHistoryPanel(); }
                this._syncHistoryToggleState();
            };
        }

        this._syncHistoryToggleState();

        if (this.historyPanel) {
            this.historyPanel.addEventListener('click', (e) => {
                if (this.historyCompare) { this.exitHistoryCompare(); return; }
                if (this.isComparing)    { this.toggleCompare(); return; }
                if (!this.isViewingHistory) return;
                if (e.target && e.target.closest &&
                    (e.target.closest('.history-thumb') || e.target.closest('.history-path') || e.target.closest('.history-thumb-wrapper'))) return;
                this.jumpToLatestVisibleHistory();
            });
        }

        this.setupHistoryResizing();
    }

    //  Toolbar: dynamic button creation 
    _initToolbarButtons() {
        const sr = this.shadowRoot;

        this.undockBtn = sr.getElementById('undock-btn');
        if (!this.undockBtn) {
            this.undockBtn           = document.createElement("button");
            this.undockBtn.id        = "undock-btn";
            this.undockBtn.className = "sprite-icon";
            this.undockBtn.innerText = "";
            this.undockBtn.title     = "Undock to separate window";
            if (this.closeBtn) this.closeBtn.parentNode.insertBefore(this.undockBtn, this.closeBtn);
        }
        this.undockBtn.onclick = () => this.toggleUndock();

        this.rangeBtn           = document.createElement("button");
        this.rangeBtn.id        = "range-btn";
        this.rangeBtn.className = "sprite-icon";
        this.rangeBtn.title     = "Sync Input Range to Selection";
        this.rangeBtn.onclick   = () => { this.toggleInputRange(); };
        const sEndBtn = sr.getElementById('s-end');
        if (sEndBtn && sEndBtn.parentNode) sEndBtn.parentNode.insertBefore(this.rangeBtn, sEndBtn.nextSibling);
        else if (this.refreshBtn) this.refreshBtn.parentNode.insertBefore(this.rangeBtn, this.refreshBtn);

        this.openFolderBtn              = document.createElement('button');
        this.openFolderBtn.id           = 'open-folder-btn';
        this.openFolderBtn.className    = 'sprite-icon';
        this.openFolderBtn.title        = 'Open all images in folder';
        this.openFolderBtn.onclick      = () => this.openFolderPicker();
        const clearCacheBtn = sr.getElementById('clear-cache-btn');
        if (clearCacheBtn && clearCacheBtn.parentNode) clearCacheBtn.parentNode.insertBefore(this.openFolderBtn, clearCacheBtn);
        else if (this.historyToggleBtn && this.historyToggleBtn.parentNode) {
            this.historyToggleBtn.parentNode.insertBefore(this.openFolderBtn, this.historyToggleBtn.nextSibling);
        }

        // layout-sel doesn't exist in HTML — create it as an invisible overlay
        // on top of the layout button so native dropdown behavior stays intact.
        const layoutBtn = sr.getElementById('layout-btn');
        if (layoutBtn) {
            layoutBtn.classList.add('sprite-icon');
            this._setIcon(layoutBtn, 'icon-layout');

            if (!sr.getElementById('layout-sel')) {
                const wrap = document.createElement('div');
                wrap.className = 'layout-picker-wrap';
                layoutBtn.parentNode.insertBefore(wrap, layoutBtn);
                wrap.appendChild(layoutBtn);

                const sel = document.createElement('select');
                sel.id = 'layout-sel';
                sel.title = 'Panel Layout';
                wrap.appendChild(sel);
                this.layoutSel = sel;
            } else {
                this.layoutSel = sr.getElementById('layout-sel');
            }
        }
    }

    //  Toolbar handler wiring 
    _bindToolbarHandlers() {
        const sr = this.shadowRoot;

        this.helpBtn.onclick      = () => {
            // Reveal the tool-specific section only for the tool that's active, so
            // the help matches the current context.
            const active = this._toolState ? this._toolState.active : "none";
            const rotoSec = this.helpOverlay.querySelector('#help-roto');
            const sam3Sec = this.helpOverlay.querySelector('#help-sam3');
            const sam3boxSec = this.helpOverlay.querySelector('#help-sam3box');
            if (rotoSec) rotoSec.style.display = active === "roto" ? "block" : "none";
            if (sam3Sec) sam3Sec.style.display = active === "sam3" ? "block" : "none";
            if (sam3boxSec) sam3boxSec.style.display = active === "sam3box" ? "block" : "none";
            this.helpOverlay.style.display = "flex";
        };
        this.helpOverlay.onclick  = () => { this.helpOverlay.style.display = "none"; };

        if (this.layoutSel) this.layoutSel.onchange = async (e) => {
            const val = e.target.value;
            if      (val === "__store__")        this.storeCurrentLayout();
            else if (val === "__make_default__") this.storeFactoryDefault();
            else if (val === "__manage__")       this.openManagePanel();
            else                                 this.applyLayout(val);
            this.layoutSel.value = "";
            this.layoutSel.blur();
        };

        this.shapeBtn.classList.toggle('active', this.showShape);
        this.updateShapeInfo();
        this.playBtn.onclick      = () => {
            this.isPlaying ? this.stop() : this.play();
            this.playBtn.classList.toggle('playing', this.isPlaying);
        };
        sr.getElementById('s-start').onclick  = () => this.setFrame(this.getTimelineBounds().min);
        sr.getElementById('s-end').onclick    = () => this.setFrame(this.getTimelineBounds().max);
        sr.getElementById('s-prev').onclick   = () => this.step(-1);
        sr.getElementById('s-next').onclick   = () => this.step(1);
        sr.getElementById('fit-btn').onclick  = () => this.fitView();
        sr.getElementById('loop-sel').onchange = (e) => { this.loopMode = e.target.value; };
        this.refreshBtn.onclick   = () => { this.refreshBtn.classList.add('running'); app.queuePrompt(0); };
        this.bindClearButton();

        this.rotateBtn.onclick = () => this.cycleSliderMode();
        if (this.closeBtn) this.closeBtn.onclick = () => { this.style.display = 'none'; };
        this.shapeBtn.onclick  = () => {
            this.showShape                  = !this.showShape;
            this.shapeOverlay.style.display = this.showShape ? "block" : "none";
            this.shapeBtn.classList.toggle('active', this.showShape);
            this.updateShapeInfo();
        };

        sr.getElementById('fps-in').oninput = (e) => {
            let val = parseInt(e.target.value);
            if (!val || val < 1) val = 1;
            this.fps = val;
            if (this._videoMode) {
                // Re-time the <video> live (no restart needed) instead of driving
                // a frame interval.
                this._applyVideoPlaybackRate();
            } else if (this.isPlaying) {
                this.stop(); this.play();
            }
        };
        sr.getElementById('zoom-sel').onchange = (e) => {
            // "Fit" is relative to the viewport; the % presets are relative to the
            // media's actual pixel size (see setPixelZoom).
            if (e.target.value === "fit") this.fitView();
            else this.setPixelZoom(parseFloat(e.target.value));
            e.target.selectedIndex = 0;
        };
        this.timeline.oninput = (e) => { this.stop(); this.setFrame(parseInt(e.target.value)); };

        if (this.exposureSlider) {
            this.exposureSlider.oninput = (e) => this.setExposure(parseFloat(e.target.value));
            this.setExposure(parseFloat(this.exposureSlider.value || '0'));
        } else {
            this.applyExposure();
        }

        if (this.rgbChannelSel) {
            this.rgbChannelSel.onchange = (e) => this.setChannelView(e.target.value);
            this.setChannelView(this.rgbChannelSel.value || 'all');
        }

        if (this.exposureControl) {
            this.exposureControl.oncontextmenu = (e) => {
                e.preventDefault();
                this.resetExposure();
            };
            this.exposureControl.onmousedown = (e) => {
                if (e.button !== 0) return;
                if (e.target === this.exposureSlider) return;
                this.resetExposure();
            };
        }

        this.imgBase.onload = () => {
            if (!this.imgBase.naturalWidth && this.imgBase.src) return;
            if (this.zoom === 1.0 && this.panX === 0 && this.panY === 0) this.fitView();
            this.updateShapeInfo();
        };

        this.pathBar               = document.createElement('div');
        this.pathBar.className     = 'path-bar';
        this.pathBar.style.display = 'none';
        this.pathBar.addEventListener('mousedown', e => e.stopPropagation());
        this.viewport.appendChild(this.pathBar);
    }

    // 
    // Node registration + data ingestion
    // 

    registerNode(nodeId) {
        if (!this.container) return;
        if (!this.allTabs[nodeId]) this.allTabs[nodeId] = [];
        this.requestPanelOpen();
        this.scrapeNodeImages(nodeId);
        this.refreshTabs();
        if (!this.activeTab) this.switchTab(nodeId);
        this.queuePersistViewerState();
    }

    unregisterNode(nodeId) {
        if (!this.container) return;
        delete this.allTabs[nodeId];
        delete this.history[nodeId];
        if (this.activeTab === nodeId) {
            const keys = Object.keys(this.allTabs);
            if (keys.length > 0) this.switchTab(keys[0]);
            else { this.activeTab = null; this.imgBase.src = ""; }
        }
        this.refreshTabs();
        this.queuePersistViewerState();
    }

    // Lightweight tab-bar rebuild used when nodes are added/removed without new data.
    refreshTabs() {
        if (!this.container) return;
        const allKeys = Object.keys(this.allTabs);
        const known   = this.tabOrder.filter(k => allKeys.includes(k));
        const added   = allKeys.filter(k => !known.includes(k));
        this.tabOrder = [...known, ...added];
        this._rebuildTabBar(null);
        this.updateTabHighlights();
        this.queuePersistViewerState();
    }

    scrapeNodeImages(nodeId) {
        const node = app.graph.getNodeById(nodeId);
        if (!node || !node.imgs || node.imgs.length === 0) return;
        const scrapped = [];
        node.imgs.forEach(imgObj => {
            try {
                const url    = new URL(imgObj.src, window.location.href);
                const params = new URLSearchParams(url.search);
                if (params.has("filename")) {
                    scrapped.push({
                        filename:  params.get("filename"),
                        subfolder: params.get("subfolder") || "",
                        type:      params.get("type") || "input",
                    });
                }
            } catch (e) { console.error("bEpic: Failed to parse image URL", imgObj.src); }
        });
        if (scrapped.length > 0) this.allTabs[nodeId] = scrapped;
    }

    updateData(data, node) {
        if (!this.container || !data.tabs) return;

        this.viewerNode  = node || null;
        const senderNode = node || app.graph.getNodeById(data.unique_id);

        Object.keys(data.tabs).forEach(k => {
            let finalKey = k;
            if (senderNode && senderNode.type === "bEpicSendToViewer") {
                // Explicit tab_name keeps grouping behavior. Empty tab_name creates
                // one tab per SendToViewer node/input, while label comes from origin.
                let explicitLabel = '';
                try {
                    const w = senderNode.widgets.find(w => w.name === 'tab_name');
                    explicitLabel = w ? (w.value || '') : '';
                } catch (e) {}

                if (explicitLabel) {
                    const safe = explicitLabel.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '').trim();
                    finalKey = `send_label_${safe || ('node_' + senderNode.id)}`;
                    this.tabLabels[finalKey] = explicitLabel;
                } else {
                    let derivedLabel = '';
                    const linkedInput = senderNode.inputs.find(inp => inp.link);
                    if (linkedInput) {
                        const link = app.graph.links[linkedInput.link];
                        if (link) {
                            const originNode = app.graph.getNodeById(link.origin_id);
                            derivedLabel = originNode ? (originNode.title || originNode.type || link.origin_id) : link.origin_id;
                        }
                    }
                    finalKey = `send_${senderNode.id}`;
                    this.tabLabels[finalKey] = derivedLabel || `Send ${senderNode.id}`;
                }
                this.tabSourceNodeIds[finalKey] = senderNode.id;
            }

            if (!this.tabSourceNodeIds[finalKey]) {
                if (k.startsWith('tab') && node && node.inputs) {
                    const inputIdx = parseInt(k.replace('tab', ''), 10) - 1;
                    const linkId = node.inputs[inputIdx]?.link;
                    const link = linkId != null ? app.graph.links[linkId] : null;
                    if (link && link.origin_id != null) this.tabSourceNodeIds[finalKey] = link.origin_id;
                    else if (node && node.id != null) this.tabSourceNodeIds[finalKey] = node.id;
                } else if (node && node.id != null) {
                    this.tabSourceNodeIds[finalKey] = node.id;
                }
            }

            // History push
            let didPrepend = false;
            try {
                const newSnapshot = data.tabs[k];
                if (!this.history[finalKey]) this.history[finalKey] = [];
                const newJson = JSON.stringify(newSnapshot);
                if (this.history[finalKey].length === 0 || JSON.stringify(this.history[finalKey][0]) !== newJson) {
                    this.history[finalKey].unshift(JSON.parse(newJson));
                    if (this.history[finalKey].length > 20) this.history[finalKey].pop();
                    didPrepend = true;
                }
            } catch (e) { console.warn('bEpicViewer history capture failed', e); }

            if (didPrepend && typeof this.onHistoryPrepended === 'function') {
                this.onHistoryPrepended(finalKey);
            }

            const keepPinnedSelection = (typeof this.isHistorySelectionPinned === 'function')
                ? this.isHistorySelectionPinned(finalKey)
                : false;

            // Merge incoming tab entries into any existing entries for this finalKey.
            try {
                const incoming = Array.isArray(data.tabs[k]) ? data.tabs[k] : [];
                if (!(keepPinnedSelection && this.activeTab === finalKey)) {
                    this.allTabs[finalKey] = incoming.slice();
                }
            } catch (e) {
                if (!(keepPinnedSelection && this.activeTab === finalKey)) {
                    this.allTabs[finalKey] = Array.isArray(data.tabs[k]) ? data.tabs[k].slice() : [];
                }
            }

            if (!keepPinnedSelection && this.activeTab === finalKey) {
                this.currentHistoryKey = finalKey;
                this.currentHistoryIndex = 0;
                this.isViewingHistory = false;
                this.previewBackup = null;
                this.historyCompare = null;
            }
        });

        // Remove stale keys. User-opened tabs (Open Folder, dropped files,
        // "Send to Image Viewer") aren't backed by a node in the graph, so they
        // are user-managed and never auto-removed.
        const expected = new Set();
        app.graph.nodes.forEach(n => {
            if (n.type === 'bEpicSendToViewer') {
                try {
                    const w           = n.widgets.find(w => w.name === 'tab_name');
                    const val         = w ? (w.value || '') : '';
                    if (val) {
                        const safe = val.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '').trim();
                        expected.add(`send_label_${safe || ('node_' + n.id)}`);
                    } else {
                        expected.add(`send_${n.id}`);
                    }
                } catch (e) {}
            }
            if (n.type === 'bEpicViewer') {
                n.inputs.forEach((inp, idx) => { if (inp.link) expected.add(`tab${idx + 1}`); });
            }
        });
        Object.keys(this.allTabs).forEach(existingKey => {
            if (USER_TAB_PREFIXES.some(p => existingKey.startsWith(p))) return;
            if (!expected.has(existingKey) && !(data.tabs && Object.values(data.tabs).some(arr => arr === this.allTabs[existingKey]))) {
                delete this.allTabs[existingKey];
                delete this.tabLabels[existingKey];
                delete this.tabSourceNodeIds[existingKey];
            }
        });

        // Maintain ordered tab list
        {
            const allKeys = Object.keys(this.allTabs);
            const known   = this.tabOrder.filter(k => allKeys.includes(k));
            const added   = allKeys.filter(k => !known.includes(k));
            this.tabOrder = [...known, ...added];
        }

        this._rebuildTabBar(node);

        this._historyPanelSig = null;
        this.requestPanelOpen();
        this.renderHistoryPanel();
        this.queuePersistViewerState();
    }

    // Build the tab-bar DOM from this.tabOrder.
    // Called by updateData, refreshTabs, and loadFolderImages.
    _rebuildTabBar(node) {
        const container = this.tabsContainer || this.tabBar;
        if (!container) return;
        container.innerHTML = "";

        const frag = document.createDocumentFragment();

        this.tabOrder.forEach(k => {
            if (k.startsWith('folder_')) {
                const folderName = (this.tabLabels[k] || k).replace(/^\s*/, '');
                this.refreshFolderTab(k, folderName);
                return;
            }

            const btn = this._makeTabButton(k, this._resolveTabLabel(k, node));
            btn.classList.toggle('active', this.activeTab === k);

            btn.onclick = (ev) => {
                if (this.historyCompare) this.exitHistoryCompare();

                if (ev.shiftKey) {
                    if (this.isComparing && this.compareTab === k) {
                        this.toggleCompare();
                        this.updateTabHighlights();
                        return;
                    }
                    if (this.activeTab && this.activeTab !== k) {
                        this.compareTab = k;
                        if (!this.isComparing) this.toggleCompare();
                        else this.setFrame(this.currentFrame);
                        this.updateTabHighlights();
                        return;
                    }
                }

                if (this.isComparing) this.toggleCompare();
                this.switchTab(k);
                this.updateTabHighlights();
            };

            const closeX       = document.createElement('span');
            closeX.className   = 'tab-close';
            closeX.title       = 'Close tab';
            this._setIcon(closeX, 'icon-close');
            closeX.onclick     = (e) => { e.stopPropagation(); this.closeTab(k); };
            btn.appendChild(closeX);

            frag.appendChild(btn);
        });

        container.appendChild(frag);

        if (!this.activeTab || !this.allTabs[this.activeTab]) {
            if (this.tabOrder.length > 0) this.switchTab(this.tabOrder[0]);
        } else {
            this.switchTab(this.activeTab);
        }
        this.updateTabHighlights();

        // Keep the "Send to Viewer" nodes tinted to match their tab color even
        // after nodes are (re)added or state is restored on a fresh graph.
        if (this.tabColors && typeof this._applyColorToTabNodes === 'function') {
            Object.keys(this.tabColors).forEach(k => this._applyColorToTabNodes(k, this.tabColors[k]));
        }
    }

    _resolveTabLabel(k, node) {
        if (this.tabLabels[k]) return this.tabLabels[k];
        if (k.startsWith("tab")) {
            let label = k.replace("tab", "Input ");
            if (node) {
                const inputIdx = parseInt(k.replace("tab", "")) - 1;
                const link     = node.inputs[inputIdx]?.link;
                if (link) {
                    const originNode = app.graph.getNodeById(app.graph.links[link].origin_id);
                    if (originNode) label = originNode.title || originNode.type;
                }
            }
            return label;
        }
        const n = app.graph.getNodeById(k);
        return n ? (n.title || n.type) : `Node ${k}`;
    }
}

// 
// Apply all mixins onto the prototype
// 
Object.assign(
    ViewerPanel.prototype,
    LayoutMixin,
    HistoryMixin,
    PlaybackMixin,
    ParamsMixin,
    UIMixin,
    ToolsMixin,
    RotoMixin,
    AnnotateMixin,
    DnDMixin,
    SendFromNodeMixin,
);

if (!customElements.get("bepic-viewer-panel")) {
    customElements.define("bepic-viewer-panel", ViewerPanel);
}

export function mountStandaloneViewer(target = document.body) {
    if (!target) return null;
    let panel = target.querySelector("bepic-viewer-panel") || document.querySelector("bepic-viewer-panel");
    if (!panel) {
        panel = document.createElement("bepic-viewer-panel");
        target.appendChild(panel);
    }
    panel.setViewerToggleState(true, { syncDisplay: true });
    return panel;
}

function _isViewerOnlyMode() {
    try {
        const sp = new URLSearchParams(window.location.search || "");
        return sp.has("bepic_viewer_only");
    } catch (e) {
        return false;
    }
}

function _applyViewerOnlyMode(panel) {
    if (!panel) return;
    const styleId = "bepic-viewer-only-style";
    if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            body.bepic-viewer-only > *:not(bepic-viewer-panel) {
                display: none !important;
            }
            body.bepic-viewer-only bepic-viewer-panel {
                position: fixed !important;
                inset: 0 !important;
                display: flex !important;
                width: 100vw !important;
                height: 100vh !important;
                z-index: 2147483647 !important;
                margin: 0 !important;
            }
        `;
        document.head.appendChild(style);
    }

    document.body.classList.add("bepic-viewer-only");
    panel.style.display = "flex";
}

// 
// ComfyUI extension registration
// 
try {
app.registerExtension({
    name: "bEpic.Viewer",
    commands: [
        {
            id:    "bEpic.toggleViewer",
            label: "Toggle bEpic Image Viewer",
            function: () => {
                _toggleViewerPanelFromUi();
            },
        },
    ],
    menuCommands: [
        { path: ["Extensions", "bEpic"], commands: ["bEpic.toggleViewer"] },
    ],
    actionBarButtons: [
        {
            icon:    "pi pi-eye",
            label:   "bEpic Viewer",
            tooltip: "Toggle bEpic Image Viewer",
            onClick: () => {
                _toggleViewerPanelFromUi();
            },
        },
    ],

    async setup() {
        globalViewerPanel = document.createElement("bepic-viewer-panel");
        document.body.appendChild(globalViewerPanel);
        _setViewerPanelToggle(false, { syncDisplay: true });
        _updateActionBarButtonState();

        if (_isViewerOnlyMode()) {
            _applyViewerOnlyMode(globalViewerPanel);
            _setViewerPanelToggle(true, { syncDisplay: false });
            _updateActionBarButtonState();
        }

        api.addEventListener("executed", (e) => {
            if (globalViewerPanel && globalViewerPanel.refreshBtn) {
                globalViewerPanel.refreshBtn.classList.remove('running');
            }
            if (!e.detail || !e.detail.node) return;
            const nodeId = e.detail.node.toString();
            if (watchedNodeIds.has(nodeId) && e.detail.output && e.detail.output.images) {
                globalViewerPanel.updateNodeImages(nodeId, e.detail.output.images);
            }
        });

        api.addEventListener("bepic.viewer.update", (e) => {
            const node = app.graph.getNodeById(e.detail.unique_id);
            globalViewerPanel.updateData(e.detail, node);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "bEpicViewer") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated?.apply(this, arguments);
                this.addWidget("button", "Add Image Input",   null, () => { this.addInput(`images_${this.inputs.length + 1}`, "IMAGE"); });
                this.addWidget("button", "Remove Last Input", null, () => { if (this.inputs.length > 1) this.removeInput(this.inputs.length - 1); });
                this.addWidget("button", "Toggle Viewer",     null, () => { _toggleViewerPanelFromUi(); });
                this.setSize([240, 140]);
            };
        }

        if (nodeData.name === "bEpicGetPath") {
            registerBepicGetPath(nodeType);
        }

        if (nodeData.name === "bEpicSendToViewer") {
            registerSendNode(nodeType, nodeData);
        }

        // Right-click → "Send to Image Viewer" on any node holding a media file
        // (VHS + native loaders alike). The entry hides itself on nodes without
        // one, so this is safe to register for every node type.
        registerSendToViewerMenu(nodeType, {
            getPanel:  () => globalViewerPanel,
            showPanel: () => _setViewerPanelToggle(true, { syncDisplay: true }),
        });
    },
});
} catch (e) {
    console.warn("bEpic viewer standalone mode: extension registration skipped", e);
}
