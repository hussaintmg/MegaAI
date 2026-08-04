# Training MegaAI's models

Two families of models, two ways to train them.

| Model | What it does | Notebook | Needs GPU |
| --- | --- | --- | --- |
| **`ui-detector`** | Looks at a **screenshot** and finds every UI element with a box | `megaai_train_ui_detector.ipynb` | yes |
| **`screen-classifier`** | What screen is this? login / checkout / dashboard / … | `megaai_train_screen_classifier.ipynb` | yes |
| **`ui-defect-detector`** | Is this UI broken, and how? overflow / overlap / cut-off / … | `megaai_train_defect_detector.ipynb` | yes |
| `ui-purpose`, `lead-scoring`, `error-triage` | Classical models the Node engine loads directly | `megaai_train_colab.ipynb` (JSON bundles) · `megaai_train_sklearn.py` (`.pkl`) | no |

---

## The deep models (M1–M3)

### Step 1 — generate the dataset (on your machine or any runner)

MegaAI **creates its own training data**. It renders synthetic pages in real
headless Chromium and reads every element's class and bounding box straight
from the DOM, so every label is exact and nothing is annotated by hand. The
same pass also labels each page's *kind* and any *defect* injected into it —
so one command produces the dataset for all three models.

```bash
npm run build                                        # once
node scripts/dataset/generate-ui-dataset.mjs --count 3000 --out dataset
zip -r dataset.zip dataset
```

Options: `--count` (images), `--seed` (reproducibility), `--defect-ratio`
(share of broken pages, default 0.35), `--val-split` (default 0.2).

You get:

```
dataset/
├── images/train/*.png   images/val/*.png
├── labels/train/*.txt   labels/val/*.txt     ← YOLO boxes (ui-detector)
├── data.yaml                                 ← ultralytics config
├── screens.csv                               ← page kind (screen-classifier)
└── defects.csv                               ← injected defect (defect-detector)
```

Start with `--count 300` to see it work end to end; use `--count 3000`+ for a
model you would actually ship. More images = better model, and it costs only
time — there is no dataset to buy or label.

### Step 2 — train on Colab

For each notebook:

1. https://colab.research.google.com → **File → Upload notebook** → pick the `.ipynb`.
2. **Runtime → Change runtime type → T4 GPU** (free tier is enough).
3. **Runtime → Run all** — it asks you to upload `dataset.zip`, then trains.
4. Each notebook prints **held-out** metrics (mAP for the detector, per-class
   accuracy for the classifiers) and downloads `.pt` + `.onnx` at the end.

Rough times on a free T4 with 3000 images: detector ~45–90 min, each
classifier ~15–25 min.

### Step 3 — send the `.onnx` files back

`.onnx` is the format the **Node engine** can run directly (via
onnxruntime) — same weights, no Python at inference. Once you have them, they
get wired into the vision and desktop engines so MegaAI can see UI elements
from pixels alone, know which screen it is on, and flag visual defects.

---

## The classical models

Already trained and shipping. Two equivalent outputs:

- **JSON bundles** (`megaai_train_colab.ipynb`) — what the Node engine loads.
  Download `megaai-models.zip`, then `unzip megaai-models.zip -d .megaai/models`.
- **`.pkl`** (`python notebooks/megaai_train_sklearn.py`) — standard
  scikit-learn/joblib artifacts for Python (Actions runners, inference
  services, Colab). Includes a `predict_demo.py` to verify them.

Both train on the same self-generated datasets, so predictions agree.

---

## Notes

- **OCR is not trained here.** Reading text from screenshots uses a
  pre-trained engine (PaddleOCR/Tesseract) — training our own would spend GPU
  time reproducing something that already exists at state-of-the-art quality.
- The notebooks are generated from `build_notebooks.py`, so the training code
  stays reviewable Python rather than JSON blobs. Edit that file and re-run
  `python notebooks/build_notebooks.py` to regenerate them.
