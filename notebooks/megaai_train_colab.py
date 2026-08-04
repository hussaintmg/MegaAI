"""
MegaAI · train the models pack on Colab (or any Python + numpy environment).

This trains the SAME three models the in-repo `@megaai/models` pack ships —
ui-purpose, lead-scoring, error-triage — but on much larger, self-generated
datasets, and exports them in the EXACT JSON bundle format the TypeScript
runtime loads. No format conversion, no inference server: the files this
writes drop straight into `.megaai/models/` and the SDK picks them up on boot.

Why Colab: bigger datasets + more training than a quick in-process run. The
maths (softmax logistic regression, multinomial naive Bayes) matches
`packages/models/src/core.ts`, and the tokeniser / feature encoding matches
`packages/models/src/models.ts`, so predictions are identical in kind — just
trained harder.

Run:  python megaai_train_colab.py
Out:  ./megaai-models/{manifest.json,ui-purpose.json,lead-scoring.json,error-triage.json}
      ./megaai-models.zip   (download this, unzip into .megaai/models/)

Deep-vision note: a true pixel-level vision model (screenshot -> understanding)
is a different shape — it can't run inside the JS runtime and would need a
small Python inference service behind the existing `PredictiveModel` seam.
This script covers the classical models the runtime loads directly.
"""

import json
import math
import os
import re
import zipfile
import numpy as np

# Bigger than the in-process defaults — tune freely on Colab.
UI_PER_LABEL = 400
LEAD_SAMPLES = 20000
TRIAGE_PER_LABEL = 400
SEED = 42

rng = np.random.default_rng(SEED)

# ------------------------------------------------------------------ #
# Tokeniser + feature encoding (must match packages/models/src)
# ------------------------------------------------------------------ #

def tokenize(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def ui_doc(f):
    structural = ["tag" + f["tag"]]
    if f.get("type"):
        structural.append("type" + f["type"])
    if f.get("role"):
        structural.append("role" + f["role"])
    if f.get("href"):
        structural.append("hrefanchor" if f["href"].startswith("#") else "hrefurl")
    free = " ".join([f.get(k, "") for k in ("text", "ariaLabel", "id", "name", "classes") if f.get(k)])
    return (" ".join(structural) + " " + free).strip()


class Vectorizer:
    def __init__(self):
        self.vocab = {}

    def fit(self, texts, min_count=1, max_features=None):
        doc_freq = {}
        for t in texts:
            for tok in set(tokenize(t)):
                doc_freq[tok] = doc_freq.get(tok, 0) + 1
        entries = [(tok, c) for tok, c in doc_freq.items() if c >= min_count]
        entries.sort(key=lambda kv: (-kv[1], kv[0]))
        if max_features:
            entries = entries[:max_features]
        self.vocab = {tok: i for i, (tok, _) in enumerate(entries)}
        return self

    def transform(self, text):
        vec = np.zeros(len(self.vocab), dtype=np.float64)
        for tok in tokenize(text):
            idx = self.vocab.get(tok)
            if idx is not None:
                vec[idx] += 1.0
        return vec

    def transform_all(self, texts):
        return np.vstack([self.transform(t) for t in texts]) if texts else np.zeros((0, len(self.vocab)))


class Standardizer:
    def __init__(self):
        self.mean = None
        self.std = None

    def fit(self, X):
        self.mean = X.mean(axis=0)
        std = X.std(axis=0)
        std[std == 0] = 1.0
        self.std = std
        return self

    def transform(self, X):
        return (X - self.mean) / self.std


# ------------------------------------------------------------------ #
# Softmax logistic regression (full-batch GD) + multinomial NB
# ------------------------------------------------------------------ #

def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def train_logistic(X, y, epochs=400, lr=0.5, l2=1e-4):
    labels = sorted(set(y))
    idx = {l: i for i, l in enumerate(labels)}
    yi = np.array([idx[v] for v in y])
    n, f = X.shape
    c = len(labels)
    Y = np.zeros((n, c))
    Y[np.arange(n), yi] = 1.0
    W = np.zeros((c, f))
    b = np.zeros(c)
    for _ in range(epochs):
        probs = softmax(X @ W.T + b)
        err = probs - Y                     # (n, c)
        gW = err.T @ X / n + l2 * W          # (c, f)
        gb = err.mean(axis=0)                # (c,)
        W -= lr * gW
        b -= lr * gb
    return labels, W, b


def predict_logistic(labels, W, b, X):
    probs = softmax(X @ W.T + b)
    return [labels[i] for i in probs.argmax(axis=1)]


def train_nb(X, y, alpha=1.0):
    labels = sorted(set(y))
    idx = {l: i for i, l in enumerate(labels)}
    n, f = X.shape
    c = len(labels)
    class_count = np.zeros(c)
    feat_count = np.zeros((c, f))
    for i in range(n):
        ci = idx[y[i]]
        class_count[ci] += 1
        feat_count[ci] += X[i]
    class_total = feat_count.sum(axis=1)
    log_prior = np.log(np.maximum(class_count, 1) / n)
    log_like = np.log((feat_count + alpha) / (class_total[:, None] + alpha * f))
    return labels, log_prior, log_like


def predict_nb(labels, log_prior, log_like, X):
    scores = X @ log_like.T + log_prior
    return [labels[i] for i in scores.argmax(axis=1)]


def accuracy(pred, actual):
    return sum(1 for p, a in zip(pred, actual) if p == a) / max(1, len(pred))


# ------------------------------------------------------------------ #
# Datasets (specs mirror packages/models/src/models.ts)
# ------------------------------------------------------------------ #

UI_CLASSES = [
    ("submit", [{"tag": "button"}, {"tag": "button", "type": "submit"}, {"tag": "input", "type": "submit"}],
     ["submit", "save", "confirm", "continue", "checkout", "pay now", "place order", "sign up", "register", "send", "apply", "proceed", "complete order", "save changes", "update"]),
    ("cancel", [{"tag": "button"}, {"tag": "a"}], ["cancel", "close", "dismiss", "go back", "not now", "discard", "back"]),
    ("delete", [{"tag": "button"}, {"tag": "a"}], ["delete", "remove", "trash", "clear all", "erase", "remove item", "delete account"]),
    ("login", [{"tag": "button"}, {"tag": "a"}, {"tag": "button", "type": "submit"}], ["login", "log in", "sign in", "signin", "access account", "member login"]),
    ("logout", [{"tag": "button"}, {"tag": "a"}], ["logout", "log out", "sign out", "signout"]),
    ("search", [{"tag": "button"}, {"tag": "input", "type": "search"}, {"tag": "input", "type": "text"}], ["search", "find", "look up", "search products", "search here", "search the store"]),
    ("navigation", [{"tag": "a"}, {"tag": "button"}], ["home", "about", "contact", "products", "catalog", "menu", "dashboard", "profile", "settings", "pricing", "blog", "faq", "shop", "categories"]),
    ("link", [{"tag": "a"}], ["read more", "learn more", "documentation", "terms of service", "privacy policy", "view details", "see all", "details", "help center"]),
    ("action", [{"tag": "button"}, {"tag": "a"}], ["add to cart", "buy", "add", "like", "share", "follow", "subscribe", "download", "upload", "edit", "refresh", "filter", "sort", "add to wishlist", "compare"]),
    ("input", [{"tag": "input", "type": "text"}, {"tag": "textarea"}], ["full name", "address", "city", "company", "comment", "message", "quantity", "your name", "phone number", "notes", "title", "description"]),
    ("email-input", [{"tag": "input", "type": "email"}, {"tag": "input", "type": "text"}], ["email", "email address", "your email", "work email", "enter email"]),
    ("password-input", [{"tag": "input", "type": "password"}], ["password", "confirm password", "current password", "new password", "enter password"]),
    ("toggle", [{"tag": "input", "type": "checkbox"}, {"tag": "input", "type": "radio"}], ["remember me", "subscribe to newsletter", "i agree", "accept terms", "enable notifications", "yes", "no"]),
]

DISTRACTORS = ["btn", "ui-control", "el", "item", "field", "primary", "lg"]


def build_ui_dataset(per_label):
    docs, labels = [], []
    for label, tags, phrases in UI_CLASSES:
        for _ in range(per_label):
            tag_spec = tags[rng.integers(len(tags))]
            phrase = phrases[rng.integers(len(phrases))]
            f = {"tag": tag_spec["tag"], "type": tag_spec.get("type")}
            slot = int(rng.integers(10))
            slug = phrase.replace(" ", "-")
            if slot < 6:
                f["text"] = phrase
            elif slot < 7:
                f["ariaLabel"] = phrase
            elif slot < 8:
                f["id"] = slug
            elif slot < 9:
                f["name"] = slug
            else:
                f["classes"] = slug + " control"
            if rng.random() < 0.3:
                f["classes"] = (f.get("classes", "") + " " + DISTRACTORS[rng.integers(len(DISTRACTORS))]).strip()
            docs.append(ui_doc(f))
            labels.append(label)
    return docs, labels


def build_lead_dataset(n):
    X, labels = [], []
    for _ in range(n):
        budget = rng.random()
        company = rng.random()
        engagement = rng.random()
        responsiveness = rng.random()
        decision = 1.0 if rng.random() < 0.5 else 0.0
        industry = rng.random()
        latent = (2.2 * budget + 1.5 * engagement + 1.3 * responsiveness + 1.0 * industry
                  + 0.8 * decision + 0.6 * company + rng.normal(0, 0.3))
        band = "hot" if latent > 4.6 else "warm" if latent > 3.2 else "cold"
        X.append([budget, company, engagement, responsiveness, decision, industry])
        labels.append(band)
    return np.array(X), labels


TRIAGE_CLASSES = [
    ("network", ["connection refused", "econnrefused", "network timeout", "dns lookup failed", "socket hang up", "fetch failed", "host unreachable", "connection reset", "could not resolve host"]),
    ("auth", ["invalid credentials", "unauthorized", "401 unauthorized", "token expired", "authentication failed", "invalid api key", "login failed", "session expired", "bad token"]),
    ("database", ["deadlock detected", "connection pool exhausted", "duplicate key value", "constraint violation", "relation does not exist", "query timeout", "sql syntax error", "unique constraint failed", "database is locked"]),
    ("validation", ["invalid input", "required field missing", "must be a string", "schema validation failed", "value out of range", "malformed json", "expected number", "field is required", "invalid email format"]),
    ("timeout", ["operation timed out", "deadline exceeded", "request timeout", "timed out after 30s", "etimedout", "gateway timeout", "execution timeout"]),
    ("permission", ["permission denied", "access denied", "forbidden", "403 forbidden", "eacces", "not allowed", "insufficient privileges", "operation not permitted"]),
    ("ratelimit", ["rate limit exceeded", "429 too many requests", "too many requests", "quota exceeded", "throttled", "api rate limit reached"]),
    ("build", ["compilation failed", "type error", "module not found", "cannot find module", "build failed", "unexpected token", "syntax error", "missing semicolon", "import error"]),
]
TRIAGE_NOISE = ["at", "in", "file", "line", "service", "handler", "worker", "process", "request", "job", "task", "step", "module", "server", "retrying", "failed"]


def build_triage_dataset(per_label):
    docs, labels = [], []
    for label, phrases in TRIAGE_CLASSES:
        for _ in range(per_label):
            parts = [phrases[rng.integers(len(phrases))]]
            for _ in range(int(rng.integers(3))):
                parts.insert(int(rng.integers(len(parts) + 1)), TRIAGE_NOISE[rng.integers(len(TRIAGE_NOISE))])
            docs.append(" ".join(parts))
            labels.append(label)
    return docs, labels


def split(n, test_frac=0.2):
    order = rng.permutation(n)
    cut = int(round(n * test_frac))
    return order[cut:], order[:cut]


# ------------------------------------------------------------------ #
# Train + export in the exact @megaai/models bundle format
# ------------------------------------------------------------------ #

def train_ui():
    docs, labels = build_ui_dataset(UI_PER_LABEL)
    tr, te = split(len(docs))
    vec = Vectorizer().fit([docs[i] for i in tr], min_count=1, max_features=600)
    Xtr = vec.transform_all([docs[i] for i in tr])
    ytr = [labels[i] for i in tr]
    lbls, W, b = train_logistic(Xtr, ytr, epochs=400, lr=0.5)
    Xte = vec.transform_all([docs[i] for i in te])
    acc = accuracy(predict_logistic(lbls, W, b, Xte), [labels[i] for i in te])
    bundle = {
        "name": "ui-purpose", "kind": "ui-purpose", "labels": lbls, "accuracy": acc, "samples": len(docs),
        "data": {"vectorizer": {"vocab": vec.vocab}, "classifier": {"labels": lbls, "weights": W.tolist(), "bias": b.tolist(), "featureCount": len(vec.vocab)}},
    }
    return bundle, acc


def train_lead():
    X, labels = build_lead_dataset(LEAD_SAMPLES)
    tr, te = split(len(labels))
    scaler = Standardizer().fit(X[tr])
    Xtr = scaler.transform(X[tr])
    ytr = [labels[i] for i in tr]
    lbls, W, b = train_logistic(Xtr, ytr, epochs=500, lr=0.5, l2=1e-3)
    Xte = scaler.transform(X[te])
    acc = accuracy(predict_logistic(lbls, W, b, Xte), [labels[i] for i in te])
    bundle = {
        "name": "lead-scoring", "kind": "lead-scoring", "labels": lbls, "accuracy": acc, "samples": len(labels),
        "data": {"scaler": {"mean": scaler.mean.tolist(), "std": scaler.std.tolist()}, "classifier": {"labels": lbls, "weights": W.tolist(), "bias": b.tolist(), "featureCount": 6}},
    }
    return bundle, acc


def train_triage():
    docs, labels = build_triage_dataset(TRIAGE_PER_LABEL)
    tr, te = split(len(docs))
    vec = Vectorizer().fit([docs[i] for i in tr], min_count=1)
    Xtr = vec.transform_all([docs[i] for i in tr])
    ytr = [labels[i] for i in tr]
    lbls, log_prior, log_like = train_nb(Xtr, ytr)
    Xte = vec.transform_all([docs[i] for i in te])
    acc = accuracy(predict_nb(lbls, log_prior, log_like, Xte), [labels[i] for i in te])
    bundle = {
        "name": "error-triage", "kind": "error-triage", "labels": lbls, "accuracy": acc, "samples": len(docs),
        "data": {"vectorizer": {"vocab": vec.vocab}, "classifier": {"labels": lbls, "featureCount": len(vec.vocab), "logPrior": log_prior.tolist(), "logLikelihood": log_like.tolist()}},
    }
    return bundle, acc


def main():
    out = "megaai-models"
    os.makedirs(out, exist_ok=True)
    bundles = []
    for train in (train_ui, train_lead, train_triage):
        bundle, acc = train()
        with open(os.path.join(out, bundle["name"] + ".json"), "w") as fh:
            json.dump(bundle, fh)
        bundles.append(bundle)
        print("  trained %-14s %.1f%% held-out accuracy  (%d samples, %d labels)" % (bundle["name"], acc * 100, bundle["samples"], len(bundle["labels"])))
    manifest = {"version": 1, "models": [{"name": b["name"], "kind": b["kind"], "accuracy": b["accuracy"], "samples": b["samples"], "labels": b["labels"]} for b in bundles]}
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    with zipfile.ZipFile("megaai-models.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        for name in os.listdir(out):
            zf.write(os.path.join(out, name), name)
    print("\nWrote %s/ and megaai-models.zip — unzip into your project's .megaai/models/" % out)


if __name__ == "__main__":
    main()
