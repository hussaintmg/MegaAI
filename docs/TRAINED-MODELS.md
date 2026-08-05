# MegaAI trained models

Every model here was trained on datasets MegaAI generated itself — synthetic
pages rendered in real headless Chromium with labels read straight from the
DOM. No corpus was downloaded and nothing was annotated by hand.

## Deep vision models

Trained on 3,000 generated pages (38,952 labelled element boxes) across 10
page kinds and 5 viewports.

| Model | Task | Held-out result | Size |
| --- | --- | --- | --- |
| `ui-detector` | Screenshot → every UI element with a box (button, input, link, checkbox, radio, select, textarea, image, heading, nav) | **mAP50 0.936**, mAP50-95 0.749, precision 0.93, recall 0.90 | 10 MB onnx |
| `screen-classifier` | Screenshot → page kind (login, signup, checkout, cart, product-list, dashboard, contact-form, article, error, settings) | **99.0%** top-1 | 6 MB onnx |
| `ui-defect-detector` | Screenshot → visual defect (clean, overflow, overlap, cutoff, broken-image, tiny-text, low-contrast) | **88.4%** top-1 | 6 MB onnx |

`ui-detector` is the one that matters most: it finds UI elements from **pixels
alone**, with no DOM — which is what will let the same automation drive
interfaces this process cannot introspect.

### Per-class results

**screen-classifier** (580 held-out images)

```
article 100.0%   cart 100.0%   dashboard 100.0%   error 100.0%   settings 100.0%
signup   98.4%   contact-form 98.4%   product-list 98.2%   checkout 98.1%   login 96.2%
```

**ui-defect-detector** (473 held-out images)

```
broken-image 98.1%   low-contrast 94.4%   cutoff 94.3%   tiny-text 92.2%
overflow     88.1%   overlap      85.7%   clean  80.3%
```

`clean` at 80.3% is a deliberate trade: the model leans toward flagging a
suspicious page rather than passing a broken one, which is the right bias for
a QA tool.

## Two dataset bugs the training exposed

Worth recording, because both were invisible in the headline metric.

**1. An unlearnable label.** The first defect detector scored 86.9% overall but
**3.8% on `broken-image`** (24 of 26 predicted `clean`). The defect was being
injected into pages that contain no `<img>` at all, where it renders
identically to a clean page — the label was impossible by construction. The
generator now schedules `broken-image` only onto pages that actually have
images. That single fix took the class from **3.8% → 98.1%**.

**2. Imbalance hiding behind a good-looking number.** With six defect kinds
sampled uniformly, each was a small minority of a mostly-clean set, so the
model learned to answer "clean": `overlap` sat at 50%, `tiny-text` at 69%. The
generator now builds a balanced schedule up front. After rebalancing, overall
accuracy *dropped* from 86.9% to 88.4% on a much harder split — while every
defect class improved substantially.

## A preprocessing bug the verification exposed

The exported `screen-classifier.onnx` scored 94.1% while its PyTorch
checkpoint reported 99.0%. The weights were fine; the preprocessing was not.
Measured across the full held-out split:

```
letterbox            546/580 = 94.1%
stretch-resize       571/580 = 98.4%
resize+centre-crop   575/580 = 99.1%   <- matches the checkpoint
```

Ultralytics classification models train with a short-side resize plus a centre
crop, so `OnnxClassifier` uses that. Detection keeps letterboxing, which is
correct there — box geometry has to survive the transform.

## Using them

**Nothing to install — they ship in the repository.** The `.onnx` weights and
their labels files live in `models/`, so a fresh checkout (a CI runner, a new
machine) has working vision immediately.

The SDK searches two directories in order:

1. `.megaai/models/` — machine-local weights, which win if present
2. `models/` — the ones committed to the repository

To try your own weights, drop them into `.megaai/models/` and they take
precedence:

```bash
unzip megaai-onnx.zip -d .megaai/models
```

Nothing is required: with the weights absent, or `onnxruntime-node` not
installed, everything falls back to the existing DOM-based path.

The classical models are cheap enough to rebuild rather than ship, so
`megaai train` runs before every cloud goal (a couple of seconds) and writes
them to `.megaai/models/`.

```ts
const screen = await megaai.desktop.observe({ url }, { pixels: true });
// screen.source === 'pixels', each element carries a confidence
```

Agents reach the same capability through `desktop.observe` with `pixels: true`.

`vision.audit` and `app.preview` also run them: every page they load is
screenshotted and passed to the screen classifier, the defect detector and the
element detector, so the report says what the rendered page *looks* like
alongside what its DOM says. A defect the detector is at least 60% sure of is
raised as an issue with a severity; below that it is reported as a raw guess
and nothing more.

```jsonc
"visual": { "screenKind": "product-list", "screenConfidence": 0.94,
            "defect": "overflow", "defectConfidence": 0.83, "elementsDetected": 21 }
```

### When they are not running

`onnxruntime-node` is an optional dependency, so a failed download of its
native binary is skipped **silently** — and every audit then falls back to DOM
analysis with nothing to say it did. That is now reported rather than hidden:

- `loadDeepModels()` returns an `unavailable` string explaining exactly what is
  missing (no weights / no runtime / no `pngjs` / a session that would not open)
- the cloud executor posts it as a `vision` event at the start of every run
- `vision.audit` puts it in `visual.note`
- CI prints the verdict on every build

```bash
npm install onnxruntime-node   # the usual fix
```

## Reproducing or improving them

```bash
npm run dataset -- --count 3000 --out dataset      # generate (about 20 min)
python scripts/train/train_classifier.py --data dataset --task screens
python scripts/train/train_classifier.py --data dataset --task defects
```

The detector wants a GPU — use `notebooks/megaai_train_ui_detector.ipynb` on
Colab, which also offers to merge in a public Roboflow dataset for real-world
variety. These models were trained CPU-only, so a GPU run with more epochs and
a larger `imgsz` should beat every number above.

## Classical models

`ui-purpose` (99%), `lead-scoring` (87%), `error-triage` (94%) — pure-JS
softmax logistic regression and naive Bayes that the Node engine trains and
runs directly. See `notebooks/README.md`.
