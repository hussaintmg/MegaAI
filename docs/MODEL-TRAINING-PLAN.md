# MegaAI — deep model training plan

The definitive list of models MegaAI needs, what each one is for, which
dataset it trains on (a good public dataset **plus** our own generated data),
and what you run on Colab. For every model below, a ready-to-run Colab
notebook will live in `notebooks/` — you open it, Runtime → Run all (GPU),
and download the trained weights.

## The roster

### M1 · `ui-detector` — the eyes (YOLO)
**What:** looks at a raw SCREENSHOT and finds every UI element with a bounding
box: button, text input, link, checkbox, radio, dropdown, image, icon, text.
This is the pixel-level "screen dekh kar batao buttons kahan hain" model —
today's desktop engine reads the DOM; this one needs only pixels, so it will
also work on native apps later.

- **Architecture:** YOLO11n / YOLOv8s (ultralytics), fine-tuned.
- **Public dataset:** VINS (annotated mobile UI screenshots) and/or a
  Roboflow "website screenshots" detection dataset (already in YOLO format);
  RICO (66k app screens) for pretraining variety.
- **Our own dataset (auto-labeled):** the repo will include a generator that
  renders thousands of synthetic pages in headless Chromium and extracts
  perfect bounding boxes **from the DOM** — unlimited, self-labeled YOLO
  training data, zero manual annotation.
- **Export:** `.pt` (PyTorch) + `.onnx` (so the Node engine can run it with
  onnxruntime — same weights, no Python needed at inference).
- **Colab:** GPU runtime, ~1–2 hours.

### M2 · `screen-classifier` — what screen is this?
**What:** classifies a screenshot: login / signup / checkout / cart /
product-list / form / dashboard / article / error page. Desktop automation
uses it to know where it is before acting.

- **Architecture:** EfficientNet-B0 or MobileNetV3 (transfer learning).
- **Public dataset:** RICO screens (topic labels) + curated web screenshots.
- **Our own dataset:** the same synthetic generator renders each page *type*
  from templates — labels come free.
- **Export:** `.pt` + `.onnx`. **Colab:** GPU, ~30–60 min.

### M3 · `ui-defect-detector` — is the UI broken?
**What:** looks at a screenshot and flags visual defects: overlapping text,
cut-off elements, horizontal overflow, broken images, misalignment. This is
the vision-testing upgrade — pixel-level QA, not just DOM checks.

- **Dataset:** 100% our own — take clean generated pages, deliberately inject
  CSS bugs (negative margins, fixed widths, hidden overflow, broken img
  URLs), render both versions; labels come free (clean vs each defect type).
  No public dataset exists for this — ours is the dataset.
- **Architecture:** EfficientNet-B0, multi-label head.
- **Export:** `.pt` + `.onnx`. **Colab:** GPU, ~30–60 min.

### M4 · `error-triage-bert` (optional upgrade)
**What:** upgrade of the classical error-triage model: DistilBERT fine-tuned
on real-world logs (LogHub public log datasets) + our synthetic error lines →
category routing with much better generalisation.
- **Export:** `.pt` (+ ONNX). **Colab:** GPU, ~30 min.

### OCR — no training needed
Reading text from screenshots uses a pre-trained OCR engine (PaddleOCR or
Tesseract). Training our own OCR would burn GPU time to reproduce something
that already exists at state-of-the-art quality — we integrate, not train.

### Already trained (classical, shipping today)
`ui-purpose`, `lead-scoring`, `error-triage` — scikit-learn `.pkl` +
JSON bundles the Node engine loads; they keep serving until the deep models
above replace/extend them.

## Division of work

| Step | Who | Status |
| --- | --- | --- |
| Synthetic page generator + DOM→YOLO auto-labeler | MegaAI | ✅ `scripts/dataset/generate-ui-dataset.mjs` |
| One Colab notebook per model (train + evaluate + export `.pt`/`.onnx`) | MegaAI | ✅ `notebooks/megaai_train_{ui_detector,screen_classifier,defect_detector}.ipynb` |
| Run the notebooks on Colab GPU, download weights | **You** | ⏳ |
| Wire `.onnx` weights into the vision/desktop engines (onnxruntime-node) | MegaAI | ⏳ waiting on weights |

## How to run it

```bash
npm run dataset -- --count 3000 --out dataset    # generates images + labels
zip -r dataset.zip dataset
```

Then upload `dataset.zip` into each notebook on Colab (T4 GPU) and Run all.
Full instructions: [`notebooks/README.md`](../notebooks/README.md).

## Order

1. **M1 ui-detector** — biggest capability jump (pixel-level element vision).
2. **M3 ui-defect-detector** — unique dataset, big value for vision testing.
3. **M2 screen-classifier** — quick win, same dataset.
4. **M4 error-triage-bert** — optional polish.
