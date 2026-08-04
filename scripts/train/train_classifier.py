"""
Train an image classifier on the generated dataset (screen kind or defect kind).

Uses Ultralytics' classification models — the same toolchain as the detector,
so there is one dependency, pretrained backbones, and a built-in ONNX export
that the Node engine can load.

    python scripts/train/train_classifier.py --data dataset --task screens
    python scripts/train/train_classifier.py --data dataset --task defects

Ultralytics classification expects folders (`split/class/image.png`), so the
CSV labels the generator emits are materialised into that layout first —
hard-linked where possible, so it costs no extra disk.

Writes <out>/<name>.pt, <name>.onnx and <name>.labels.json, and prints
per-class held-out accuracy with the most common confusions.
"""

import argparse
import csv
import json
import os
import shutil
from collections import defaultdict

TASKS = {
    "screens": {"csv": "screens.csv", "col": "kind", "name": "screen-classifier"},
    "defects": {"csv": "defects.csv", "col": "defect", "name": "ui-defect-detector"},
}


def materialise(data_root, task, work_dir):
    """CSV labels -> split/class/image.png folders Ultralytics can read."""
    rows = list(csv.DictReader(open(os.path.join(data_root, task["csv"]))))
    labels = sorted({r[task["col"]] for r in rows})
    if os.path.isdir(work_dir):
        shutil.rmtree(work_dir)
    counts = defaultdict(int)
    for row in rows:
        split, label, file = row["split"], row[task["col"]], row["file"]
        src = os.path.join(data_root, "images", split, file)
        if not os.path.exists(src):
            continue
        dst_dir = os.path.join(work_dir, split, label)
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, file)
        try:
            os.link(src, dst)          # same filesystem: free
        except OSError:
            shutil.copy(src, dst)
        counts[(split, label)] += 1
    # Ultralytics wants every class present in both splits.
    for label in labels:
        for split in ("train", "val"):
            os.makedirs(os.path.join(work_dir, split, label), exist_ok=True)
    return labels, counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dataset")
    ap.add_argument("--task", choices=list(TASKS), required=True)
    ap.add_argument("--model", default="yolo11n-cls.pt")
    ap.add_argument("--img", type=int, default=224)
    ap.add_argument("--epochs", type=int, default=15)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--out", default="models")
    ap.add_argument("--work", default=None, help="where to materialise the folder layout")
    args = ap.parse_args()

    from ultralytics import YOLO

    task = TASKS[args.task]
    work_dir = args.work or os.path.join(os.path.dirname(os.path.abspath(args.data)), f"cls_{args.task}")
    labels, counts = materialise(args.data, task, work_dir)
    train_n = sum(v for (s, _), v in counts.items() if s == "train")
    val_n = sum(v for (s, _), v in counts.items() if s == "val")
    print(f"task={args.task}  classes={len(labels)}: {labels}")
    print(f"train={train_n}  val={val_n}  layout={work_dir}")

    model = YOLO(args.model)
    model.train(
        data=work_dir,
        epochs=args.epochs,
        imgsz=args.img,
        batch=args.batch,
        workers=args.workers,
        device=args.device,
        seed=42,
        project=os.path.join(args.out, "runs"),
        name=task["name"],
        exist_ok=True,
        plots=False,
        verbose=True,
    )

    metrics = model.val(data=work_dir, imgsz=args.img, device=args.device, verbose=False)
    top1 = float(metrics.top1)
    print(f"\nheld-out top-1 accuracy: {top1*100:.1f}%")

    # Per-class accuracy + confusions, computed from predictions on the val split.
    hits, totals = defaultdict(int), defaultdict(int)
    confusion = defaultdict(lambda: defaultdict(int))
    names = model.names
    for label in labels:
        d = os.path.join(work_dir, "val", label)
        files = [os.path.join(d, f) for f in os.listdir(d)] if os.path.isdir(d) else []
        for i in range(0, len(files), 64):
            for result in model.predict(files[i : i + 64], imgsz=args.img, device=args.device, verbose=False):
                pred = names[int(result.probs.top1)]
                totals[label] += 1
                confusion[label][pred] += 1
                if pred == label:
                    hits[label] += 1

    print("per-class accuracy:")
    for label in labels:
        n = totals[label]
        print(f"  {label:16s} {(hits[label]/n*100 if n else 0):5.1f}%   ({hits[label]}/{n})")
    pairs = [(t, p, c) for t, row in confusion.items() for p, c in row.items() if t != p]
    if pairs:
        print("most common confusions:")
        for t, p, c in sorted(pairs, key=lambda x: -x[2])[:6]:
            print(f"  {t} -> {p}: {c}")

    os.makedirs(args.out, exist_ok=True)
    best = os.path.join(args.out, "runs", task["name"], "weights", "best.pt")
    pt_path = os.path.join(args.out, task["name"] + ".pt")
    shutil.copy(best, pt_path)

    exported = YOLO(best).export(format="onnx", imgsz=args.img, opset=12)
    onnx_path = os.path.join(args.out, task["name"] + ".onnx")
    shutil.copy(str(exported), onnx_path)

    json.dump(
        {"labels": labels, "imgSize": args.img, "model": args.model, "accuracy": top1},
        open(os.path.join(args.out, task["name"] + ".labels.json"), "w"),
        indent=2,
    )
    print(f"\nwrote {pt_path}, {onnx_path} and {task['name']}.labels.json")


if __name__ == "__main__":
    main()
