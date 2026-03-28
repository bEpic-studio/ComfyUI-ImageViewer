import os
import random
from PIL import Image
import numpy as np
import torch
import folder_paths
from server import PromptServer

try:
    from comfy.comfy_types.node_typing import IO
except Exception:
    IO = None


class bEpicViewer:
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "viewer_control": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "images_1": ("IMAGE",),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "view"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def view(self, viewer_control=True, unique_id=None, **kwargs):
        if not viewer_control:
            return ()

        def process_batch(images, input_num):
            if images is None: 
                return []
            batch_results = []
            for i, tensor in enumerate(images):
                array = 255. * tensor.cpu().numpy()
                img = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
                filename = f"bEpic_V_{unique_id}_tab{input_num}_{i:04d}_{random.randint(1, 1000)}.png"
                img.save(os.path.join(self.output_dir, filename), compress_level=4)
                batch_results.append({"filename": filename, "subfolder": "", "type": self.type})
            return batch_results

        data_payload = {"tabs": {}}
        # Capture all dynamic inputs (images_1, images_2, etc.)
        for key, value in kwargs.items():
            if key.startswith("images_") and value is not None:
                tab_index = key.split("_")[-1]
                data_payload["tabs"][f"tab{tab_index}"] = process_batch(value, tab_index)

        PromptServer.instance.send_sync("bepic.viewer.update", {
            "tabs": data_payload["tabs"],
            "unique_id": unique_id 
        })
        return ()


class bEpicSendToViewer:
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "input": (IO.ANY, ) if IO is not None else (("IMAGE", "MASK"),),
                "tab_name": ("STRING", {"default": ""}),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "image/bEpic"

    def send(self, input, tab_name="", unique_id=None):
        # Pass-through node: returns the incoming image unchanged
        def process_batch(inp, label):
            if inp is None:
                return []
            batch_results = []

            try:
                samples = inp
                for i, tensor in enumerate(samples):
                    t = tensor
                    arr = t.cpu().numpy()

                    # Detect if this array contains 3 or 4 color channels on any axis
                    chan_axis = None
                    for ax, s in enumerate(arr.shape):
                        if s in (3, 4):
                            chan_axis = ax
                            break

                    if chan_axis is not None and arr.ndim >= 2:
                        try:
                            # Move channel axis to last to get H,W,C
                            if chan_axis != arr.ndim - 1:
                                img_arr = np.moveaxis(arr, chan_axis, -1)
                            else:
                                img_arr = arr

                            # If there's a leading batch dimension, squeeze it
                            if img_arr.ndim == 4 and img_arr.shape[0] == 1:
                                img_arr = img_arr[0]

                            array = 255.0 * img_arr
                            img = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
                            # Convert RGBA → RGB so PNG saves in full colour
                            if img.mode == 'RGBA':
                                img = img.convert('RGB')
                            safe_label = label if label else f"send"
                            filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}.png"
                            img.save(os.path.join(self.output_dir, filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, filename))
                            batch_results.append({"filename": filename, "subfolder": "", "type": self.type, "path": full})
                        except Exception:
                            continue
                    else:
                        try:
                            mask_arr = arr
                            if mask_arr.ndim == 3 and mask_arr.shape[0] == 1:
                                mask_arr = mask_arr[0]
                            if mask_arr.ndim == 3 and mask_arr.shape[-1] == 1:
                                mask_arr = mask_arr[..., 0]
                            mask_arr = (255.0 * mask_arr).astype(np.uint8)
                            mask_img = Image.fromarray(np.clip(mask_arr, 0, 255).astype(np.uint8)).convert('L')
                            safe_label = label if label else f"send"
                            mask_filename = f"bEpic_S_{unique_id}_{safe_label}_{i:04d}_{random.randint(1,1000)}_mask.png"
                            mask_img.save(os.path.join(self.output_dir, mask_filename), compress_level=4)
                            full = os.path.abspath(os.path.join(self.output_dir, mask_filename))
                            batch_results.append({"filename": mask_filename, "subfolder": "", "type": "mask", "path": full})
                        except Exception:
                            continue
            except Exception:
                return []
            return batch_results

        safe_label = tab_name.replace(" ", "_") if tab_name else "send"
        tabs = {"tab": process_batch(input, safe_label)}

        PromptServer.instance.send_sync("bepic.viewer.update", {
            "tabs": tabs,
            "unique_id": unique_id
        })

        return ()

# mapping dictionaries for external use (nodes.py imports these)

NODE_CLASS_MAPPINGS = {
    "bEpicViewer": bEpicViewer,
    "bEpicSendToViewer": bEpicSendToViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "bEpicViewer": "bEpic Image Viewer",
    "bEpicSendToViewer": "bEpic Send To Image Viewer",
}


