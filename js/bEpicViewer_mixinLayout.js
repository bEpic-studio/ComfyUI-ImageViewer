// bEpicViewer_mixinLayout.js
// Layout management: load/save/apply named and factory-default layouts.
import { api } from "../../scripts/api.js";

export const LayoutMixin = {

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
        const name = prompt("Enter a name for this layout:");
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
            if (this.paramsPanel) {
                const pStyles = window.getComputedStyle(this.paramsPanel);
                layoutData.params = {
                    visible: this.paramsPanel.style.display !== "none" && pStyles.display !== "none",
                    width: this.paramsPanel.style.width || `${Math.round(this.paramsPanel.getBoundingClientRect().width)}px`,
                    side: this.paramsSide || (this.paramsPanel.classList.contains('left') ? 'left' : 'right'),
                };
            }
            if (this.historyPanel) {
                const hStyles = window.getComputedStyle(this.historyPanel);
                layoutData.history = {
                    visible: this.historyPanel.style.display !== "none" && hStyles.display !== "none",
                    width: this.historyPanel.style.width || `${Math.round(this.historyPanel.getBoundingClientRect().width)}px`,
                };
            }
            if (this.browserPanel) {
                layoutData.browser = {
                    visible: this.isFileBrowserOpen(),
                    width: this.browserPanel.style.width || `${Math.round(this.browserPanel.getBoundingClientRect().width)}px`,
                    previewHeight: this._browserPreviewH || null,
                    side: this.browserSide || (this.browserPanel.classList.contains('left') ? 'left' : 'right'),
                };
            }
        } catch (e) { console.warn('Could not read panel states', e); }

        this.customLayouts[name] = layoutData;
        try {
            await api.storeUserData("bEpicViewer_layouts.json", this.customLayouts);
            this.refreshLayoutMenu();
            alert(`Layout '${name}' saved to ComfyUI user directory!`);
        } catch (e) {
            console.error("Error saving layout", e);
            alert("Failed to save layout to server.");
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
            if (this.paramsPanel) {
                const pStyles = window.getComputedStyle(this.paramsPanel);
                layoutData.params = {
                    visible: this.paramsPanel.style.display !== "none" && pStyles.display !== "none",
                    width: this.paramsPanel.style.width || `${Math.round(this.paramsPanel.getBoundingClientRect().width)}px`,
                    side: this.paramsSide || (this.paramsPanel.classList.contains('left') ? 'left' : 'right'),
                };
            }
            if (this.historyPanel) {
                const hStyles = window.getComputedStyle(this.historyPanel);
                layoutData.history = {
                    visible: this.historyPanel.style.display !== "none" && hStyles.display !== "none",
                    width: this.historyPanel.style.width || `${Math.round(this.historyPanel.getBoundingClientRect().width)}px`,
                };
            }
            if (this.browserPanel) {
                layoutData.browser = {
                    visible: this.isFileBrowserOpen(),
                    width: this.browserPanel.style.width || `${Math.round(this.browserPanel.getBoundingClientRect().width)}px`,
                    previewHeight: this._browserPreviewH || null,
                    side: this.browserSide || (this.browserPanel.classList.contains('left') ? 'left' : 'right'),
                };
            }
        } catch (e) { console.warn('Could not read panel states for factory default', e); }

        this.factoryDefaultLayout = layoutData;
        try {
            await api.storeUserData("bEpicViewer_factory_default.json", this.factoryDefaultLayout);
            alert("Factory default layout saved.");
            this.refreshLayoutMenu();
        } catch (e) {
            console.error("Error saving factory default layout", e);
            alert("Failed to save factory default layout.");
        }
    },

    applyFactoryDefault() {
        if (!this.factoryDefaultLayout) return;
        this._applyLayoutData(this.factoryDefaultLayout);
    },

    // ── Manage Panel ──────────────────────────────────────────────────────────

    openManagePanel() {
        if (!this.managePanel) this.createManagePanel();
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
        document.body.appendChild(panel);
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
                const newName = prompt("Enter new name for this layout:", k);
                if (!newName || newName === k) return;
                if (this.customLayouts[newName]) {
                    alert(`A layout named '${newName}' already exists.`);
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
                if (!confirm(`Delete layout '${k}'?`)) return;
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
            if (data.params && this.paramsPanel) {
                const p = data.params;
                this.paramsPanel.style.display = p.visible ? "flex" : "none";
                if (this.paramsBtn) this.paramsBtn.style.color = p.visible ? "#f60" : "#eee";
                if (this.paramsBtn) this.paramsBtn.classList.toggle('active', !!p.visible);
                if (p.width) this.paramsPanel.style.width = p.width;
                if (p.side) {
                    const parent = this.paramsPanel.parentNode;
                    if (p.side === 'left') {
                        this.paramsSide = 'left';
                        this.paramsPanel.classList.replace('right', 'left');
                        if (this.paramsDockBtn) this.paramsDockBtn.classList.add('left');
                        if (this.viewport && parent) {
                            parent.insertBefore(this.paramsPanel, this.viewport);
                            try { if (this.historyPanel) parent.appendChild(this.historyPanel); } catch (e) {}
                            if (this.historyPanel) { this.historyPanel.classList.remove('left'); this.historyPanel.classList.add('right'); }
                            if (data.history && this.historyPanel) this.historyPanel.style.width = data.history.width;
                        }
                    } else {
                        this.paramsSide = 'right';
                        this.paramsPanel.classList.replace('left', 'right');
                        if (this.paramsDockBtn) this.paramsDockBtn.classList.remove('left');
                        if (this.viewport && parent) {
                            try { if (this.historyPanel) parent.insertBefore(this.historyPanel, this.viewport); } catch (e) {}
                            parent.appendChild(this.paramsPanel);
                            if (this.historyPanel) { this.historyPanel.classList.remove('right'); this.historyPanel.classList.add('left'); }
                            if (data.history && this.historyPanel) this.historyPanel.style.width = data.history.width;
                        }
                    }
                }
                if (p.visible) this.updateParamsPanel(true);
            }

            if (data.history && this.historyPanel) {
                if (data.history.width) this.historyPanel.style.width = data.history.width;

                if (typeof data.history.visible === 'boolean') {
                    this.historyPanel.style.display = data.history.visible ? 'flex' : 'none';
                    if (data.history.visible) {
                        this._historyPanelSig = null;
                        this.renderHistoryPanel();
                    }
                    if (this._syncHistoryToggleState) this._syncHistoryToggleState();
                }
            }

            if (this.browserPanel) {
                const b = data.browser;
                if (b) {
                    // Only when the layout actually names a side. The built-in
                    // fallback deliberately does not, so a viewer with no saved
                    // layout keeps the side it was last left on rather than
                    // being dragged back across on every reload.
                    if (b.side === 'left' || b.side === 'right') this.browserSide = b.side;
                    if (b.width) this.browserPanel.style.width = b.width;
                    if (b.previewHeight) this._setBrowserPreviewHeight(b.previewHeight);
                }
                // Re-dock unconditionally and last: the params side may just
                // have moved, and either side changing repositions the browser.
                if (this._dockBrowserPanel) this._dockBrowserPanel();
                if (b && typeof b.visible === 'boolean') this.toggleFileBrowser(b.visible);
            }
        } catch (e) {
            console.warn('Could not restore panel states from layout data', e);
        }
    },
};
