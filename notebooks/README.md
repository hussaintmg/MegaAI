# Training MegaAI models on Colab

MegaAI trains its models in-process (`megaai train`), but you can also train
them **harder on Colab** — bigger datasets, more epochs — and drop the result
straight back in. The notebook exports the *exact* JSON bundle format the
runtime loads, so there is no conversion step and no inference server.

## Steps

1. Open [Google Colab](https://colab.research.google.com/) → **File → Upload
   notebook** → choose `megaai_train_colab.ipynb` (or **New notebook** and
   paste `megaai_train_colab.py` into a cell).
2. **Runtime → Run all.** It trains the three models and prints held-out
   accuracy for each. (A GPU runtime isn't required — these are classical
   models; CPU is fine. Bump `UI_PER_LABEL` / `LEAD_SAMPLES` / `TRIAGE_PER_LABEL`
   at the top to train on more data.)
3. The last cell downloads **`megaai-models.zip`**.
4. In your MegaAI project, unzip it into the models directory:

   ```bash
   mkdir -p .megaai/models
   unzip ~/Downloads/megaai-models.zip -d .megaai/models
   ```

5. Restart the server (or re-run the CLI). The SDK loads the models on boot —
   the UI-purpose model backs vision + desktop element classification, and all
   three are reachable through the `model.predict` tool. You can confirm with:

   ```bash
   node apps/cli/dist/index.js status
   ```

That's it — the same three models, trained on more data, now serving the
running system.

## What the notebook produces

`megaai-models/` containing `manifest.json` plus one bundle per model
(`ui-purpose.json`, `lead-scoring.json`, `error-triage.json`), byte-compatible
with `saveRegistry()` / `loadRegistry()` in `@megaai/models`. The tokeniser,
feature encoding and maths mirror `packages/models/src`, so predictions are
identical in kind to the in-process models — just trained on a larger sample.

## About deep-vision models

A true pixel-level vision model (understanding a screenshot, OCR, visual
diffing) is a different shape: it can't run inside the Node runtime the way a
logistic-regression bundle can. The clean way to add one is a small Python
inference service behind the existing `PredictiveModel` seam — the runtime
already treats models as pluggable, so that service would register like any
other model without changing the rest of the system. Ask and this can be
scaffolded next. Today's vision testing uses **real headless Chromium** plus
the trained UI-purpose model, which covers responsive/console/a11y/performance
checks and element-purpose detection without a GPU.
