// bEpicViewer_mixinParams.js
// Parameters panel: rendering node widgets, monitoring canvas selection.
import { app } from "../../scripts/app.js";

export const ParamsMixin = {

    _resolveFallbackParamNodeId() {
        try {
            const toExistingNodeId = (val) => {
                if (val === null || val === undefined) return null;
                const asNum = Number(val);
                if (Number.isFinite(asNum) && app?.graph?.getNodeById?.(asNum)) return String(asNum);
                const asStr = String(val);
                if (app?.graph?.getNodeById?.(asStr)) return asStr;
                return null;
            };

            if (this.activeTab && this.tabSourceNodeIds && Object.prototype.hasOwnProperty.call(this.tabSourceNodeIds, this.activeTab)) {
                const mapped = toExistingNodeId(this.tabSourceNodeIds[this.activeTab]);
                if (mapped) return mapped;
            }

            if (this.activeTab && this.activeTab.startsWith('send_')) {
                const direct = this.activeTab.replace('send_', '').trim();
                const id = toExistingNodeId(direct);
                if (id) return id;
            }

            if (this.viewerNode && this.viewerNode.id != null) {
                const id = toExistingNodeId(this.viewerNode.id);
                if (id) return id;
            }

            if (this.activeTab) {
                const id = toExistingNodeId(this.activeTab);
                if (id) return id;
            }
        } catch (e) { /* ignore */ }

        return null;
    },

    toggleParamsLock() {
        this.paramsLocked = !this.paramsLocked;
        if (this.paramsLockBtn) {
            this._setIcon(this.paramsLockBtn, this.paramsLocked ? 'icon-lock' : 'icon-unlock');
            this.paramsLockBtn.style.color = this.paramsLocked ? '#f60' : '';
            this.paramsLockBtn.title = this.paramsLocked
                ? 'Unlock – follow canvas selection'
                : 'Lock – freeze to currently selected node';
        }
    },

    // Sides and widths belong to the dock mixin — this just names the panel it
    // acts on. Kept as a method because the header button and the keymap call it.
    toggleParamsSide() {
        this.togglePanelSide("params");
    },

    applyToSelectedNodes(name, value) {
        if (!this.selectedNodeIds) return;
        this.selectedNodeIds.forEach(id => {
            const n = app.graph.getNodeById(id);
            if (n && n.widgets) {
                const w = n.widgets.find(x => x.name === name);
                if (w) { w.value = value; w.callback?.(w.value); }
            }
        });
        app.graph.setDirtyCanvas(true, true);
    },

    saveCurrentParamSizes() {
        if (!this.currentParamNodeId || !this.paramsContent) return;
        const nodeId = this.currentParamNodeId;
        const maxW   = this.paramsContent.clientWidth - 20;
        this.paramsContent.querySelectorAll('.param-row').forEach(r => {
            const name  = r.dataset.paramName;
            if (!name) return;
            const input = r.querySelector('textarea.param-input');
            if (!input) return;
            const rect = input.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            let wval = Math.round(rect.width);
            if (maxW && wval > maxW) wval = maxW;
            if (!this.paramTextSizes[nodeId]) this.paramTextSizes[nodeId] = {};
            this.paramTextSizes[nodeId][name] = { width: wval, height: Math.round(rect.height) };
        });
    },

    updateParamsHeader() {
        const node = app.graph.getNodeById(this.currentParamNodeId);
        if (!node) return;
        const title = node.title || node.type;
        if (this.selectedNodeIds && this.selectedNodeIds.length > 1) {
            this.paramsTitle.innerHTML = `${title} <span style="color:#f60;font-weight:bold;margin-left:5px;">[${this.selectedNodeIds.length}]</span>`;
        } else {
            this.paramsTitle.innerText = title;
        }
    },

    // ── Canvas selection monitor ─────────────────────────────────────────────
    // Uses rAF instead of setInterval so it runs at display rate and doesn't
    // compete with layout work during idle cycles.

    startParamMonitor() {
        let running = true;
        const tick  = () => {
            if (!running) return;
            requestAnimationFrame(tick);

            if (!this.isPanelDocked || !this.isPanelDocked("params")) return;
            if (this.paramsLocked) return;

            const selected = (app && app.canvas) ? app.canvas.selected_nodes : null;
            // If there's no canvas selection available (standalone viewer page),
            // try to fall back to the active tab or the last viewer node so
            // parameters are still displayed when opened via the /imageviewer URL.
            if ((!selected || Object.keys(selected).length === 0)) {
                const fallbackNodeId = this._resolveFallbackParamNodeId();

                if (!fallbackNodeId) {
                    if (this.currentParamNodeId !== null) {
                        this.saveCurrentParamSizes();
                        try { this.paramResizeObservers.forEach(o => o.disconnect()); } catch (e) {}
                        this.paramResizeObservers       = [];
                        this.currentParamNodeId         = null;
                        this.selectedNodeIds            = [];
                        this.paramsTitle.innerText      = "No Node Selected";
                        this.paramsContent.innerHTML    = "";
                    }
                    return;
                }

                // Simulate a single selection using the fallback node id
                const ids = [fallbackNodeId];
                const nodeId = ids[ids.length - 1];
                const prevCount = this.selectedNodeIds ? this.selectedNodeIds.length : 0;
                this.selectedNodeIds = ids;

                if (this.currentParamNodeId !== nodeId) {
                    this.currentParamNodeId = nodeId;
                    this.updateParamsPanel(true);
                } else if (ids.length !== prevCount) {
                    this.updateParamsHeader();
                }

                return;
            }

            const ids    = Object.keys(selected);
            const nodeId = ids[ids.length - 1];
            const prevCount = this.selectedNodeIds ? this.selectedNodeIds.length : 0;
            this.selectedNodeIds = ids;

            if (this.currentParamNodeId !== nodeId) {
                this.currentParamNodeId = nodeId;
                this.updateParamsPanel(true);
            } else if (ids.length !== prevCount) {
                this.updateParamsHeader();
            }
        };
        requestAnimationFrame(tick);
        // Expose a way to stop the monitor if ever needed
        this._stopParamMonitor = () => { running = false; };
    },

    // ── Panel rebuild ────────────────────────────────────────────────────────

    updateParamsPanel(fullRebuild = false) {
        const node = app.graph.getNodeById(this.currentParamNodeId);
        if (!node) return;

        this.updateParamsHeader();
        if (!fullRebuild) return;

        // Disconnect previous observers
        try { this.paramResizeObservers.forEach(o => o.disconnect()); } catch (e) {}
        this.paramResizeObservers = [];

        const frag = document.createDocumentFragment();
        if (node.widgets) {
            node.widgets.forEach(w => {
                if (w.type === "button") return;

                const row = document.createElement("div");
                row.className       = "param-row";
                row.dataset.paramName = w.name;

                const label = document.createElement("div");
                label.className  = "param-label";
                label.innerText  = w.name;
                row.appendChild(label);

                const isConnected = node.inputs && node.inputs.some(i => i.name === w.name && i.link != null);
                const input = this._buildParamInput(w, node, isConnected);

                // Restore saved size
                try {
                    const stored = this.paramTextSizes[node.id] && this.paramTextSizes[node.id][w.name];
                    if (stored) {
                        const maxW = this.paramsContent ? this.paramsContent.clientWidth - 20 : null;
                        if (stored.width > 0) {
                            let wval = stored.width;
                            if (maxW && wval > maxW) wval = maxW;
                            input.style.width = wval + "px";
                        }
                        if (input.tagName === 'TEXTAREA' && stored.height > 20) {
                            input.style.height = stored.height + "px";
                        }
                    }
                } catch (e) { /* ignore */ }

                // Observe resize on text controls
                const isTextControl = input.tagName === 'TEXTAREA' || input.type === 'text';
                if (isTextControl) {
                    try {
                        const ro = new ResizeObserver(entries => {
                            for (const ent of entries) {
                                const rect = ent.target.getBoundingClientRect();
                                if (rect.width <= 0 || rect.height <= 0) continue;
                                if (!this.paramTextSizes[node.id]) this.paramTextSizes[node.id] = {};
                                this.paramTextSizes[node.id][w.name] = { width: Math.round(rect.width), height: Math.round(rect.height) };
                            }
                        });
                        ro.observe(input);
                        this.paramResizeObservers.push(ro);
                    } catch (e) { /* ResizeObserver unavailable */ }

                    input.addEventListener('mouseup', () => {
                        const rect = input.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) return;
                        if (!this.paramTextSizes[node.id]) this.paramTextSizes[node.id] = {};
                        this.paramTextSizes[node.id][w.name] = { width: Math.round(rect.width), height: Math.round(rect.height) };
                    });
                }

                row.appendChild(input);
                frag.appendChild(row);
            });
        }

        this.paramsContent.innerHTML = '';
        this.paramsContent.appendChild(frag);
    },

    // Build the appropriate input element for a given widget
    _buildParamInput(w, node, isConnected) {
        let input;

        if (w.type === "toggle" || w.type === "BOOLEAN") {
            input = document.createElement("input");
            input.type    = "checkbox";
            input.checked = !!w.value;
            input.onchange = (e) => { this.applyToSelectedNodes(w.name, e.target.checked); };

        } else if (w.type === "combo" || (w.options && w.options.values)) {
            input = document.createElement("select");
            input.className = "param-input";
            const frag = document.createDocumentFragment();
            (w.options.values || []).forEach(o => {
                const opt = document.createElement("option");
                opt.value = o; opt.innerText = o;
                if (o === w.value) opt.selected = true;
                frag.appendChild(opt);
            });
            input.appendChild(frag);
            input.onchange = (e) => { this.applyToSelectedNodes(w.name, e.target.value); };

        } else if (w.type === "number" || typeof w.value === "number") {
            input = document.createElement("input");
            input.className = "param-input";
            input.type  = "number";
            input.value = w.value;
            if (w.options) {
                if (w.options.min  !== undefined) input.min  = w.options.min;
                if (w.options.max  !== undefined) input.max  = w.options.max;
                if (w.options.step !== undefined) input.step = w.options.step;
            }
            const intStep = w.options && Number.isInteger(w.options.step);
            input.oninput = (e) => {
                const val = intStep ? parseInt(e.target.value) : parseFloat(e.target.value);
                this.applyToSelectedNodes(w.name, val);
            };

        } else {
            // treat long strings or explicit multiline options as textarea
            const wantsMultiline = (w.options && w.options.multiline) ||
                                   (typeof w.value === 'string' &&
                                    (w.value.includes('\n') || w.value.length > 50));
            if (wantsMultiline) {
                input = document.createElement("textarea");
                input.rows = 4;
            } else {
                input = document.createElement("input");
                input.type = "text";
            }
            input.className = "param-input";
            input.value     = w.value != null ? w.value : "";
            input.oninput   = (e) => { this.applyToSelectedNodes(w.name, e.target.value); };

            // Auto-size for long strings
            if (typeof w.value === 'string') {
                const len = w.value.length;
                if (len > 100) {
                    const maxW   = this.paramsContent ? this.paramsContent.clientWidth - 20 : null;
                    let estWidth = Math.min(800, Math.max(200, len * 7));
                    if (maxW && estWidth > maxW) estWidth = maxW;
                    input.style.width = `${estWidth}px`;
                }
                if (input.tagName === 'TEXTAREA') {
                    input.rows = Math.min(10, Math.max(4, w.value.split("\n").length));
                }
            }
        }

        if (isConnected) {
            input.disabled    = true;
            input.title       = "Controlled by input connection";
            input.style.opacity = "0.5";
        }

        return input;
    },
};
