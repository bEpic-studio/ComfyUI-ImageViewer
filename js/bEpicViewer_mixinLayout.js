// bEpicViewer_mixinLayout.js
// Layout management: load/save/apply named and factory-default layouts.
import { api } from "../../scripts/api.js";

export const LayoutMixin = {

    /**
     * The window to raise a dialog in.
     *
     * Undocking moves the panel's container into the popout document, but this
     * module still runs in the page that loaded it — so a bare prompt() or
     * alert() opens on the ComfyUI tab behind the popout, where Chrome may
     * defer it and the user certainly cannot see it. That is why Store Layout
     * looked like it did nothing while undocked: the name prompt was up on the
     * other window. _viewerWindow follows the container.
     */
    _dlgWin() {
        return (this._viewerWindow && this._viewerWindow()) || window;
    },

    async loadLayouts() {
        try {
            const res = await api.getUserData("bEpicViewer_layouts.json");
            if (res.status === 200) {
                this.customLayouts = await res.json();
                this.refreshLayoutMenu();
            }
        } catch (e) {
            console.log("bEpicViewer: No saved layouts found in user folder.");
        }
    },

    refreshLayoutMenu() {
        // Build the entire select content in one shot with a fragment to avoid
        // repeated reflows from individual appendChild calls.
        const frag = document.createDocumentFragment();

        const mkOpt = (value, text, disabled = false, selected = false) => {
            const o = document.createElement("option");
            o.value = value;
            o.innerText = text;
            if (disabled) o.disabled = true;
            if (selected) o.selected = true;
            return o;
        };

        frag.appendChild(mkOpt("", "", true, true));
        frag.appendChild(mkOpt("__factory__", "Factory Default"));
        frag.appendChild(mkOpt("__make_default__", "🛠 Make Current Layout default"));

        const customKeys = Object.keys(this.customLayouts);
        if (customKeys.length > 0) {
            frag.appendChild(mkOpt("", "──────────", true));
            customKeys.forEach(k => frag.appendChild(mkOpt(`custom:${k}`, k)));
        }

        frag.appendChild(mkOpt("", "──────────", true));
        frag.appendChild(mkOpt("__manage__", "⚙️ Manage Layouts…"));
        frag.appendChild(mkOpt("__store__", "➕ Store Current"));

        this.layoutSel.innerHTML = "";
        this.layoutSel.appendChild(frag);
    },

    async storeCurrentLayout() {
        const win = this._dlgWin();
        const name = win.prompt("Enter a name for this layout:");
        if (!name) return;

        const styles = window.getComputedStyle(this);
        const layoutData = {
            top: this.style.top || styles.top,
            left: this.style.left || styles.left,
            right: this.style.right || styles.right,
            bottom: this.style.bottom || styles.bottom,
            width: this.style.width || styles.width,
            height: this.style.height || styles.height,
        };
        try {
            // One object covers all three panels: which rail each is in, in what
            // order, how tall, and whether it is showing. See mixinDock.
            layoutData.dock = this.serializeDock ? this.serializeDock() : null;
            layoutData.browserPreviewHeight = this._browserPreviewH || null;
        } catch (e) { console.warn('Could not read panel states', e); }

        this.customLayouts[name] = layoutData;
        try {
            await api.storeUserData("bEpicViewer_layouts.json", this.customLayouts);
            this.refreshLayoutMenu();
            win.alert(`Layout '${name}' saved to ComfyUI user directory!`);
        } catch (e) {
            console.error("Error saving layout", e);
            win.alert("Failed to save layout to server.");
        }
    },

    async loadFactoryDefault() {
        try {
            const res = await api.getUserData("bEpicViewer_factory_default.json");
            if (res.status === 200) {
                this.factoryDefaultLayout = await res.json();
            }
        } catch (e) {
            console.log("bEpicViewer: no saved factory default layout found");
        }
        if (!this.factoryDefaultLayout) {
            this.factoryDefaultLayout = {
                top: "60px", left: "60px",
                width: "50vw", height: "50vh",
                params: { visible: true, width: "300px", side: "right" },
                history: { visible: false, width: "80px" },
                browser: { visible: false, width: "300px" },
                // Deliberately no `dock` key: the legacy block above is read
                // through dockLayoutFromLegacy, which lands on the same
                // arrangement and keeps one description of the default.
            };
        }
    },

    async storeFactoryDefault() {
        const styles = window.getComputedStyle(this);
        const layoutData = {
            top: this.style.top || styles.top,
            left: this.style.left || styles.left,
            right: this.style.right || styles.right,
            bottom: this.style.bottom || styles.bottom,
            width: this.style.width || styles.width,
            height: this.style.height || styles.height,
        };
        try {
            // One object covers all three panels: which rail each is in, in what
            // order, how tall, and whether it is showing. See mixinDock.
            layoutData.dock = this.serializeDock ? this.serializeDock() : null;
            layoutData.browserPreviewHeight = this._browserPreviewH || null;
        } catch (e) { console.warn('Could not read panel states for factory default', e); }

        // Stamped so startup can tell it apart from the arrangement the last
        // session happened to be left in — see restoreViewerState.
        layoutData.savedAt = Date.now();

        this.factoryDefaultLayout = layoutData;
        const win = this._dlgWin();
        try {
            await api.storeUserData("bEpicViewer_factory_default.json", this.factoryDefaultLayout);
            win.alert("Factory default layout saved.");
            this.refreshLayoutMenu();
        } catch (e) {
            console.error("Error saving factory default layout", e);
            win.alert("Failed to save factory default layout.");
        }
    },

    applyFactoryDefault() {
        if (!this.factoryDefaultLayout) return;
        this._applyLayoutData(this.factoryDefaultLayout);
    },

    // ── Manage Panel ──────────────────────────────────────────────────────────

    openManagePanel() {
        if (!this.managePanel) this.createManagePanel();
        // It is position:fixed in whichever document it lives in, so after a
        // dock or undock it has to move to the one now on screen — otherwise it
        // opens, correctly, on a window nobody is looking at.
        const doc = this._dlgWin().document;
        if (this.managePanel.ownerDocument !== doc) doc.body.appendChild(this.managePanel);
        this.renderManagePanel();
        this.managePanel.style.display = 'flex';
    },

    closeManagePanel() {
        if (this.managePanel) this.managePanel.style.display = 'none';
    },

    createManagePanel() {
        const panel = document.createElement('div');
        panel.id = 'layout-manage-panel';
        panel.style.cssText = [
            'position:fixed', 'top:50%', 'left:50%',
            'width:35vw', 'height:35vh',
            'transform:translate(-50%,-50%)',
            'background:#222', 'border:1px solid #444', 'border-radius:6px',
            'display:none', 'flex-direction:column', 'padding:12px',
            'z-index:2147483647', 'color:#eee', 'min-width:320px', 'min-height:220px',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        const title = document.createElement('span');
        title.innerText = 'Manage Layouts';
        const closeBtn = document.createElement('button');
        closeBtn.innerText = '✖';
        closeBtn.style.cssText = 'background:#444;color:#eee;border:none;padding:4px 8px;cursor:pointer;';
        closeBtn.onclick = () => this.closeManagePanel();
        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.id = 'layout-manage-list';
        list.style.cssText = 'flex:1;overflow-y:auto;margin-top:8px;';
        panel.appendChild(list);

        this.managePanel = panel;
        this._dlgWin().document.body.appendChild(panel);
    },

    renderManagePanel() {
        if (!this.managePanel) return;
        const list = this.managePanel.querySelector('#layout-manage-list');
        const keys = Object.keys(this.customLayouts);
        if (keys.length === 0) {
            list.innerHTML = '<div style="padding:8px">No custom layouts saved.</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        keys.forEach(k => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;';
            const name = document.createElement('span');
            name.innerText = k;
            const btns = document.createElement('div');
            btns.style.cssText = 'display:flex;gap:4px;';
            const apply = document.createElement('button');
            apply.innerText = 'Apply';
            apply.onclick = () => { this.applyLayout(`custom:${k}`); this.closeManagePanel(); };
            const rename = document.createElement('button');
            rename.innerText = 'Rename';
            rename.onclick = async () => {
                const win = this._dlgWin();
                const newName = win.prompt("Enter new name for this layout:", k);
                if (!newName || newName === k) return;
                if (this.customLayouts[newName]) {
                    win.alert(`A layout named '${newName}' already exists.`);
                    return;
                }
                // move data to new key
                this.customLayouts[newName] = this.customLayouts[k];
                delete this.customLayouts[k];
                try { await api.storeUserData('bEpicViewer_layouts.json', this.customLayouts); } catch (e) { console.error(e); }
                this.refreshLayoutMenu();
                this.renderManagePanel();
            };
            const del = document.createElement('button');
            del.innerText = 'Delete';
            del.onclick = async () => {
                if (!this._dlgWin().confirm(`Delete layout '${k}'?`)) return;
                delete this.customLayouts[k];
                try { await api.storeUserData('bEpicViewer_layouts.json', this.customLayouts); } catch (e) { console.error(e); }
                this.refreshLayoutMenu();
                this.renderManagePanel();
            };
            btns.appendChild(apply);
            btns.appendChild(rename);
            btns.appendChild(del);
            row.appendChild(name);
            row.appendChild(btns);
            frag.appendChild(row);
        });
        list.innerHTML = '';
        list.appendChild(frag);
    },

    applyLayout(mode) {
        this.style.bottom = "auto"; this.style.right = "auto";
        this.style.top = "auto"; this.style.left = "auto";
        this.style.transform = "none";

        if (mode === "__factory__") { this.applyFactoryDefault(); return; }
        if (mode === "__make_default__") { this.storeFactoryDefault(); return; }

        if (mode.startsWith("custom:")) {
            const data = this.customLayouts[mode.split(":")[1]];
            if (data) this._applyLayoutData(data);
            return;
        }

        // legacy built-in presets
        switch (mode) {
            case "top":
                this.style.top = "60px"; this.style.left = "0";
                this.style.width = "calc(100vw - 60px)"; this.style.height = "35vh";
                break;
            case "bottom":
                this.style.bottom = "0"; this.style.left = "0";
                this.style.width = "calc(100vw - 60px)"; this.style.height = "35vh";
                break;
            case "left":
                this.style.top = "60px"; this.style.left = "0";
                this.style.width = "35vw"; this.style.height = "calc(100vh - 60px)";
                break;
            case "right":
                this.style.top = "60px"; this.style.right = "60px";
                this.style.width = "35vw"; this.style.height = "calc(100vh - 60px)";
                break;
        }
    },

    // ── Internal helper shared by applyFactoryDefault + applyLayout ──────────

    _applyLayoutData(data) {
        if (data.top) this.style.top = data.top;
        if (data.left) this.style.left = data.left;
        if (data.right && data.right !== "auto") this.style.right = data.right;
        if (data.bottom && data.bottom !== "auto") this.style.bottom = data.bottom;
        if (data.width) this.style.width = data.width;
        if (data.height) this.style.height = data.height;

        try {
            // Layouts saved before docking existed carry params/history/browser
            // blocks instead; those are converted rather than dropped, because
            // they live in the user's ComfyUI folder and outlive this change.
            const dock = data.dock || (this.dockLayoutFromLegacy && this.dockLayoutFromLegacy(data));
            if (dock && this.applyDockData) this.applyDockData(dock);

            const ph = data.browserPreviewHeight ||
                       (data.browser && data.browser.previewHeight) || null;
            if (ph && this._setBrowserPreviewHeight) this._setBrowserPreviewHeight(ph);

            // Toggle lights and waking each panel up are both applyDockLayout's
            // to do — see _syncPanelToggleButtons and _onPanelShown.
        } catch (e) {
            console.warn('Could not restore panel states from layout data', e);
        }
    },
};
