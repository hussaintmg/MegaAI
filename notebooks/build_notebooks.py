"""
Generates the MegaAI deep-vision Colab notebooks.

Keeping the notebooks generated from this one file means the training code
lives as reviewable Python (not JSON blobs), and every notebook shares the
same conventions: upload dataset.zip -> train -> report held-out metrics ->
export .pt and .onnx -> download.

    python notebooks/build_notebooks.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def md(*lines):
    return {"cell_type": "markdown", "metadata": {}, "source": [l + "\n" for l in lines]}


def code(body):
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [l + "\n" for l in body.strip("\n").split("\n")],
    }


def notebook(cells):
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3"},
            "accelerator": "GPU",
            "colab": {"provenance": []},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


CANONICAL_CLASSES = "['button','input','link','checkbox','radio','select','textarea','image','heading','nav']"

# Downloads a public detection dataset and folds it into ours. Source class
# names differ per dataset, so everything is normalised onto our canonical
# list; anything that has no sensible equivalent is dropped rather than guessed.
ROBOFLOW_CELL = '''
# ── Optional: add a public dataset on top of our generated one ───────────────
#
# Our synthetic pages give perfect labels; real-world screenshots add the messy
# variety no generator invents (real fonts, ads, photos, odd layouts). Training
# on BOTH is what makes the detector generalise.
#
# To use this: make a free roboflow.com account -> Settings -> API key, paste it
# below. Leave ROBOFLOW_API_KEY empty to train on our dataset alone.

ROBOFLOW_API_KEY = ""          # <-- paste your key here (stays in your Colab session)
ROBOFLOW_WORKSPACE = "roboflow-gw7yv"
ROBOFLOW_PROJECT   = "website-screenshots"
ROBOFLOW_VERSION   = 1

# Map a source dataset's class names onto ours. Unlisted names are dropped.
ALIASES = {
    "button":   ["button", "btn", "submit", "action bar", "actionbar"],
    "input":    ["input", "field", "edittext", "textfield", "text field", "searchbar", "search bar", "search"],
    "link":     ["link", "anchor", "hyperlink"],
    "checkbox": ["checkbox", "check box", "tick box", "switch", "toggle"],
    "radio":    ["radio", "radiobutton", "radio button"],
    "select":   ["select", "dropdown", "drop down", "spinner", "combobox", "picker"],
    "textarea": ["textarea", "text area", "multiline"],
    "image":    ["image", "img", "icon", "picture", "photo", "thumbnail", "iframe", "video", "logo"],
    "heading":  ["heading", "title", "header", "h1", "h2"],
    "nav":      ["nav", "navbar", "navigation", "menu", "toolbar", "tab bar", "tabbar", "multitab", "tabs", "breadcrumb"],
}

def to_canonical(name):
    """Source class name -> our class index, or None to drop it."""
    n = str(name).strip().lower().replace("_", " ").replace("-", " ")
    for canon, words in ALIASES.items():
        if n in words:
            return CLASSES.index(canon)
    for canon, words in ALIASES.items():
        if any(w in n for w in words):
            return CLASSES.index(canon)
    return None

if ROBOFLOW_API_KEY:
    import shutil, glob, subprocess, sys, yaml
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "roboflow"], check=False)
    from roboflow import Roboflow

    rf = Roboflow(api_key=ROBOFLOW_API_KEY)
    project = rf.workspace(ROBOFLOW_WORKSPACE).project(ROBOFLOW_PROJECT)
    extra = project.version(ROBOFLOW_VERSION).download("yolov8", location="/content/extra")

    src_root = extra.location
    src_names = yaml.safe_load(open(os.path.join(src_root, "data.yaml")))["names"]
    if isinstance(src_names, dict):
        src_names = [src_names[k] for k in sorted(src_names)]
    print("source classes:", src_names)

    remap = {i: to_canonical(n) for i, n in enumerate(src_names)}
    kept = {src_names[i]: CLASSES[v] for i, v in remap.items() if v is not None}
    dropped = [src_names[i] for i, v in remap.items() if v is None]
    print("mapped :", kept)
    print("dropped:", dropped)

    added = 0
    for split in ["train", "valid", "val", "test"]:
        img_dir = os.path.join(src_root, split, "images")
        lab_dir = os.path.join(src_root, split, "labels")
        if not os.path.isdir(img_dir):
            continue
        target = "val" if split in ("valid", "val") else "train"
        for img_path in glob.glob(os.path.join(img_dir, "*")):
            base = os.path.splitext(os.path.basename(img_path))[0]
            lab_path = os.path.join(lab_dir, base + ".txt")
            if not os.path.exists(lab_path):
                continue
            lines = []
            for line in open(lab_path):
                p = line.split()
                if len(p) < 5:
                    continue
                new_id = remap.get(int(p[0]))
                if new_id is None:
                    continue
                lines.append(" ".join([str(new_id)] + p[1:5]))
            if not lines:          # nothing of interest survived the remap
                continue
            name = "rf_" + base
            shutil.copy(img_path, os.path.join(root, "images", target,
                                               name + os.path.splitext(img_path)[1]))
            open(os.path.join(root, "labels", target, name + ".txt"), "w").write("\\n".join(lines) + "\\n")
            added += 1
    print(f"\\nmerged {added} real-world images into the dataset")
    print("train:", len(os.listdir(os.path.join(root, "images/train"))),
          "| val:", len(os.listdir(os.path.join(root, "images/val"))))
else:
    print("No Roboflow key set — training on our generated dataset only (this works fine).")
'''

UPLOAD_CELL = '''
# Upload the dataset.zip produced by:
#   node scripts/dataset/generate-ui-dataset.mjs --count 3000 --out dataset
#   zip -r dataset.zip dataset
import os, zipfile

if not os.path.exists("dataset"):
    try:
        from google.colab import files
        print("Choose your dataset.zip …")
        up = files.upload()
        name = list(up.keys())[0]
    except Exception:
        name = "dataset.zip"          # running locally: put dataset.zip beside the notebook
    with zipfile.ZipFile(name) as z:
        z.extractall(".")

# The zip may contain dataset/ at the root or one level down — find data.yaml.
root = None
for base, dirs, fs in os.walk("."):
    if "data.yaml" in fs and "images" in dirs:
        root = os.path.abspath(base)
        break
assert root, "Could not find the dataset (no data.yaml with an images/ folder)"

import yaml
_cfg = yaml.safe_load(open(os.path.join(root, "data.yaml")))
_names = _cfg["names"]
CLASSES = [_names[i] for i in sorted(_names)] if isinstance(_names, dict) else list(_names)

# Ultralytics resolves a relative `path` against its own datasets_dir, and the
# absolute one baked in at generation time points at another machine — so pin
# it to where the dataset actually landed here.
_cfg["path"] = root
yaml.safe_dump(_cfg, open(os.path.join(root, "data.yaml"), "w"), sort_keys=False)

print("dataset root:", root)
print("classes     :", CLASSES)
print("train images:", len(os.listdir(os.path.join(root, "images/train"))))
print("val images:  ", len(os.listdir(os.path.join(root, "images/val"))))
'''

CHECK_GPU = '''
import torch
print("torch", torch.__version__, "| CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
else:
    print("No GPU — in Colab use Runtime -> Change runtime type -> T4 GPU (training will be slow otherwise).")
'''

# ------------------------------------------------------------------ #
# 1. ui-detector (YOLO)
# ------------------------------------------------------------------ #

UI_DETECTOR = notebook([
    md(
        "# MegaAI · M1 — `ui-detector` (YOLO)",
        "",
        "Trains the model that **looks at a screenshot and finds every UI element** — button, input,",
        "link, checkbox, radio, select, textarea, image, heading, nav — with a bounding box for each.",
        "This is pixel-level vision: it needs no DOM, so it also works on screenshots of native apps.",
        "",
        "**Before you start:** `Runtime → Change runtime type → T4 GPU`.",
        "",
        "**Dataset:** generated by MegaAI itself — synthetic pages rendered in headless Chromium with",
        "boxes read straight from the DOM, so every label is exact and there is no manual annotation.",
        "",
        "**Output:** `ui-detector.pt` (PyTorch) and `ui-detector.onnx` (runs in the Node engine).",
    ),
    code(CHECK_GPU),
    code("!pip install -q ultralytics onnx onnxruntime"),
    md("## 1. Load the dataset"),
    code(UPLOAD_CELL),
    md("## 2. Sanity-check the labels", "", "Draws boxes on one training image — they should sit exactly on the elements."),
    code('''
import os, random
from PIL import Image, ImageDraw

colors = ["#ff3b30","#34c759","#007aff","#ff9500","#af52de","#00c7be","#ffcc00","#ff2d55","#5856d6","#8e8e93"]

f = random.choice(os.listdir(os.path.join(root, "images/train")))
im = Image.open(os.path.join(root, "images/train", f)).convert("RGB")
d = ImageDraw.Draw(im); W, H = im.size
for line in open(os.path.join(root, "labels/train", f.replace(".png", ".txt"))):
    p = line.split()
    if len(p) != 5: continue
    c = int(p[0]); cx, cy, w, h = map(float, p[1:])
    d.rectangle([(cx-w/2)*W, (cy-h/2)*H, (cx+w/2)*W, (cy+h/2)*H], outline=colors[c % len(colors)], width=3)
    d.text(((cx-w/2)*W+3, max(0,(cy-h/2)*H-11)), CLASSES[c], fill=colors[c % len(colors)])
print(f, "|", CLASSES)
im
'''),
    md(
        "## 3. Optional — mix in a real-world dataset",
        "",
        "Our generated pages give perfect labels; public screenshots add the messy variety a",
        "generator never invents. Training on **both** is what makes the detector generalise to",
        "real websites. Paste a free Roboflow API key below, or skip this cell entirely.",
    ),
    code(ROBOFLOW_CELL),
    md("## 4. Train", "", "`epochs` and `imgsz` are the knobs: raise epochs for accuracy, lower imgsz for speed."),
    code('''
from ultralytics import YOLO

EPOCHS = 60          # 60 is a good start; 100+ if you generated a large dataset
IMGSZ  = 640
MODEL  = "yolo11n.pt"   # nano = fast. yolo11s.pt / yolo11m.pt are stronger and slower.

model = YOLO(MODEL)
results = model.train(
    data=os.path.join(root, "data.yaml"),
    epochs=EPOCHS,
    imgsz=IMGSZ,
    batch=16,
    patience=15,
    project="megaai",
    name="ui-detector",
    seed=42,
)
'''),
    md("## 5. Evaluate on the held-out split"),
    code('''
metrics = model.val()
print("mAP50    :", round(float(metrics.box.map50), 4))
print("mAP50-95 :", round(float(metrics.box.map), 4))
print("precision:", round(float(metrics.box.mp), 4))
print("recall   :", round(float(metrics.box.mr), 4))
print("\\nPer class:")
for i, name in enumerate(CLASSES):
    try:
        print(f"  {name:10s} mAP50={float(metrics.box.ap50[i]):.3f}")
    except Exception:
        pass
'''),
    md("## 6. See it predict", "", "Runs the trained model on a validation image it never trained on."),
    code('''
import random
val_dir = os.path.join(root, "images/val")
sample = os.path.join(val_dir, random.choice(os.listdir(val_dir)))
pred = model.predict(sample, conf=0.35, verbose=False)[0]
print(f"{len(pred.boxes)} elements detected in {os.path.basename(sample)}")
Image.fromarray(pred.plot()[:, :, ::-1])
'''),
    md("## 7. Export and download", "", "`.onnx` is what the Node engine loads — same weights, no Python needed at inference."),
    code('''
best = "megaai/ui-detector/weights/best.pt"
model = YOLO(best)
onnx_path = model.export(format="onnx", imgsz=IMGSZ, opset=12)

import shutil
shutil.copy(best, "ui-detector.pt")
shutil.copy(str(onnx_path), "ui-detector.onnx")
print("ready:", os.path.getsize("ui-detector.pt")//1024, "KB .pt |", os.path.getsize("ui-detector.onnx")//1024, "KB .onnx")

try:
    from google.colab import files
    files.download("ui-detector.pt")
    files.download("ui-detector.onnx")
except Exception as e:
    print("Not on Colab — the files are in the working directory.", e)
'''),
    md(
        "---",
        "Send `ui-detector.onnx` back and it gets wired into the vision + desktop engines,",
        "so MegaAI can find UI elements from pixels alone.",
    ),
])

# ------------------------------------------------------------------ #
# Shared image-classifier training code (screen kind / defect kind)
# ------------------------------------------------------------------ #

def classifier_cells(title, blurb, csv_name, label_col, out_name, extra_md):
    train_code = f'''
import os, csv, random
import torch, torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights
from PIL import Image

CSV = os.path.join(root, "{csv_name}")
rows = list(csv.DictReader(open(CSV)))
LABELS = sorted({{r["{label_col}"] for r in rows}})
label_to_idx = {{l: i for i, l in enumerate(LABELS)}}
print(len(rows), "images |", len(LABELS), "classes:", LABELS)

IMG = 224
train_tf = transforms.Compose([
    transforms.Resize((IMG, IMG)),
    transforms.ColorJitter(brightness=0.15, contrast=0.15),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])
eval_tf = transforms.Compose([
    transforms.Resize((IMG, IMG)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
])

class ScreenDataset(Dataset):
    def __init__(self, split, tf):
        self.rows = [r for r in rows if r["split"] == split]
        self.tf = tf
    def __len__(self):
        return len(self.rows)
    def __getitem__(self, i):
        r = self.rows[i]
        path = os.path.join(root, "images", r["split"], r["file"])
        return self.tf(Image.open(path).convert("RGB")), label_to_idx[r["{label_col}"]]

train_ds, val_ds = ScreenDataset("train", train_tf), ScreenDataset("val", eval_tf)
print("train", len(train_ds), "| val", len(val_ds))
train_dl = DataLoader(train_ds, batch_size=32, shuffle=True, num_workers=2)
val_dl = DataLoader(val_ds, batch_size=32, num_workers=2)

device = "cuda" if torch.cuda.is_available() else "cpu"
model = efficientnet_b0(weights=EfficientNet_B0_Weights.IMAGENET1K_V1)
model.classifier[1] = nn.Linear(model.classifier[1].in_features, len(LABELS))
model = model.to(device)

EPOCHS = 12
opt = torch.optim.AdamW(model.parameters(), lr=3e-4)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)
loss_fn = nn.CrossEntropyLoss()
best_acc = 0.0

for epoch in range(EPOCHS):
    model.train()
    for x, y in train_dl:
        x, y = x.to(device), y.to(device)
        opt.zero_grad()
        loss = loss_fn(model(x), y)
        loss.backward()
        opt.step()
    sched.step()

    model.eval()
    correct = total = 0
    with torch.no_grad():
        for x, y in val_dl:
            x, y = x.to(device), y.to(device)
            correct += (model(x).argmax(1) == y).sum().item()
            total += y.numel()
    acc = correct / max(1, total)
    if acc > best_acc:
        best_acc = acc
        torch.save({{"state_dict": model.state_dict(), "labels": LABELS}}, "{out_name}.pt")
    print(f"epoch {{epoch+1:2d}}/{{EPOCHS}}  val accuracy {{acc*100:5.1f}}%")

print(f"\\nbest held-out accuracy: {{best_acc*100:.1f}}%  ->  {out_name}.pt")
'''

    report_code = f'''
from collections import defaultdict
import torch

ckpt = torch.load("{out_name}.pt", map_location=device)
model.load_state_dict(ckpt["state_dict"]); model.eval()

hits, totals = defaultdict(int), defaultdict(int)
with torch.no_grad():
    for x, y in val_dl:
        pred = model(x.to(device)).argmax(1).cpu()
        for p, t in zip(pred, y):
            totals[LABELS[t]] += 1
            if p == t: hits[LABELS[t]] += 1

print("per-class accuracy on the held-out split")
for label in LABELS:
    n = totals[label]
    print(f"  {{label:16s}} {{(hits[label]/n*100 if n else 0):5.1f}}%   ({{hits[label]}}/{{n}})")
'''

    export_code = f'''
import torch
dummy = torch.randn(1, 3, IMG, IMG, device=device)
torch.onnx.export(model, dummy, "{out_name}.onnx",
                  input_names=["image"], output_names=["logits"],
                  dynamic_axes={{"image": {{0: "batch"}}, "logits": {{0: "batch"}}}}, opset_version=12)

import json
json.dump({{"labels": LABELS, "imgSize": IMG}}, open("{out_name}.labels.json", "w"), indent=2)
print("exported {out_name}.pt / .onnx / .labels.json")

try:
    from google.colab import files
    files.download("{out_name}.pt")
    files.download("{out_name}.onnx")
    files.download("{out_name}.labels.json")
except Exception as e:
    print("Not on Colab — files are in the working directory.", e)
'''

    return notebook([
        md(*([f"# MegaAI · {title}", ""] + blurb + ["", "**Before you start:** `Runtime → Change runtime type → T4 GPU`."] + extra_md)),
        code(CHECK_GPU),
        code("!pip install -q torch torchvision onnx onnxruntime pyyaml"),
        md("## 1. Load the dataset"),
        code(UPLOAD_CELL),
        md("## 2. Train"),
        code(train_code),
        md("## 3. Per-class results on the held-out split"),
        code(report_code),
        md("## 4. Export and download"),
        code(export_code),
    ])


SCREEN_CLASSIFIER = classifier_cells(
    "M2 — `screen-classifier`",
    [
        "Trains the model that answers **“what screen am I looking at?”** — login, signup, checkout,",
        "cart, product-list, dashboard, contact-form, article, error, settings.",
        "",
        "Desktop automation uses this to know where it is before it clicks anything.",
    ],
    "screens.csv",
    "kind",
    "screen-classifier",
    ["", "**Output:** `screen-classifier.pt`, `.onnx` and a labels file."],
)

DEFECT_DETECTOR = classifier_cells(
    "M3 — `ui-defect-detector`",
    [
        "Trains the model that answers **“is this UI broken, and how?”** — overflow, overlap, cut-off",
        "content, broken images, tiny text, low contrast, or clean.",
        "",
        "This is the pixel-level upgrade to vision testing: it catches what a DOM check cannot see.",
        "The dataset is entirely our own — clean pages are re-rendered with a deliberate CSS defect",
        "injected, so the label comes free and no public dataset is needed.",
    ],
    "defects.csv",
    "defect",
    "ui-defect-detector",
    ["", "**Output:** `ui-defect-detector.pt`, `.onnx` and a labels file."],
)


def main():
    targets = {
        "megaai_train_ui_detector.ipynb": UI_DETECTOR,
        "megaai_train_screen_classifier.ipynb": SCREEN_CLASSIFIER,
        "megaai_train_defect_detector.ipynb": DEFECT_DETECTOR,
    }
    for name, nb in targets.items():
        path = os.path.join(HERE, name)
        with open(path, "w") as fh:
            json.dump(nb, fh, indent=1)
        json.load(open(path))  # fail loudly if we ever emit invalid JSON
        print(f"wrote {name} ({len(nb['cells'])} cells)")


if __name__ == "__main__":
    main()
