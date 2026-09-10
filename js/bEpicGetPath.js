// Helper for adding the "Open in Explorer" button to bEpicGetPath nodes
import { api } from "../../scripts/api.js";

export function registerBepicGetPath(nodeType) {
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
        onNodeCreated?.apply(this, arguments);
        this.addWidget("button", "Open in Explorer", null, () => {
            const paths_id = this.widgets.find(w => w.name === "paths_id")?.value;
            const path_key = this.widgets.find(w => w.name === "path_key")?.value;
            const suffix = this.widgets.find(w => w.name === "suffix")?.value;
            console.log("[bEpicGetPath] explorer button clicked", {paths_id, path_key, suffix});
            const url = api.apiURL("/bepic/open_path");
            console.log("[bEpicGetPath] requesting", url);
            // POST only: the server no longer answers GET here, since opening a
            // folder is a side effect a stray link must not be able to set off.
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paths_id, path_key, suffix }),
            })
            .then(async res => {
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    console.warn("[bEpicGetPath] open_path refused:", data.error || res.status);
                }
            })
            .catch(console.error);
        });
    };
}
