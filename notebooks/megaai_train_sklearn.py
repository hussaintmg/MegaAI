"""
MegaAI · train the models pack as standard .pkl files (scikit-learn).

Same three models and the same self-generated datasets as the rest of the
models pack — but trained with scikit-learn and saved with joblib as .pkl,
the standard Python model artifact. Load them anywhere Python runs (a
GitHub Actions runner, a small inference service, Colab) with:

    import joblib
    model = joblib.load("ui-purpose.pkl")
    model.predict(["tagbutton typesubmit checkout"])   # -> ['submit']

Run:  python megaai_train_sklearn.py
Out:  ./megaai-models-pkl/{ui-purpose.pkl, lead-scoring.pkl, error-triage.pkl,
      predict_demo.py, models_report.json, README.md}
      ./megaai-models-pkl.zip
"""

import json
import os
import sys
import zipfile

import joblib
from sklearn import __version__ as sklearn_version
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from megaai_train_colab import build_lead_dataset, build_triage_dataset, build_ui_dataset  # noqa: E402

UI_PER_LABEL = 400
LEAD_SAMPLES = 20000
TRIAGE_PER_LABEL = 400
OUT = "megaai-models-pkl"

DEMO = '''import joblib

ui = joblib.load("ui-purpose.pkl")
print("ui:", ui.predict(["tagbutton typesubmit checkout", "taga hrefurl home", "taginput typepassword password"]))

lead = joblib.load("lead-scoring.pkl")
print("lead:", lead.predict([[1, 1, 1, 1, 1, 1], [0.1, 0.1, 0.1, 0.1, 0, 0.1]]))

triage = joblib.load("error-triage.pkl")
print("triage:", triage.predict(["connection refused at server", "invalid api key", "cannot find module x"]))
'''

README = '''# MegaAI trained models (.pkl)

Standard scikit-learn pipelines saved with joblib (sklearn %s).

| File | Task | Input |
| --- | --- | --- |
| ui-purpose.pkl | UI element -> purpose (submit/search/delete/nav/...) | encoded element doc, e.g. "tagbutton typesubmit checkout" (tag/type tokens + visible text) |
| lead-scoring.pkl | lead -> hot/warm/cold | 6 numbers 0..1: [budget, companySize, engagement, responsiveness, decisionMaker, industryFit] |
| error-triage.pkl | error/log line -> category | raw text, e.g. "connection refused at server" |

Verify: `python predict_demo.py` (run inside this folder).
Held-out accuracies are in models_report.json.

These are trained on the same self-generated datasets as the JSON bundles the
MegaAI JS runtime loads — .pkl for Python (Actions runners, inference services,
Colab), JSON for in-process Node. Load with a scikit-learn close to the version
above.
'''


def fit_eval(name, pipeline, X, y):
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    pipeline.fit(Xtr, ytr)
    acc = float(pipeline.score(Xte, yte))
    joblib.dump(pipeline, os.path.join(OUT, name + ".pkl"))
    print("  trained %-14s %.1f%% held-out accuracy -> %s/%s.pkl" % (name, acc * 100, OUT, name))
    return acc


def main():
    os.makedirs(OUT, exist_ok=True)
    report = {"sklearn": sklearn_version, "models": {}}

    docs, labels = build_ui_dataset(UI_PER_LABEL)
    report["models"]["ui-purpose"] = fit_eval(
        "ui-purpose",
        Pipeline([("vec", CountVectorizer(token_pattern=r"[a-z0-9]+", lowercase=True)), ("clf", LogisticRegression(max_iter=2000))]),
        docs,
        labels,
    )

    X, y = build_lead_dataset(LEAD_SAMPLES)
    report["models"]["lead-scoring"] = fit_eval(
        "lead-scoring",
        Pipeline([("scale", StandardScaler()), ("clf", LogisticRegression(max_iter=2000))]),
        X,
        y,
    )

    docs, labels = build_triage_dataset(TRIAGE_PER_LABEL)
    report["models"]["error-triage"] = fit_eval(
        "error-triage",
        Pipeline([("vec", CountVectorizer(token_pattern=r"[a-z0-9]+", lowercase=True)), ("clf", MultinomialNB())]),
        docs,
        labels,
    )

    with open(os.path.join(OUT, "models_report.json"), "w") as fh:
        json.dump(report, fh, indent=2)
    with open(os.path.join(OUT, "predict_demo.py"), "w") as fh:
        fh.write(DEMO)
    with open(os.path.join(OUT, "README.md"), "w") as fh:
        fh.write(README % sklearn_version)

    with zipfile.ZipFile(OUT + ".zip", "w", zipfile.ZIP_DEFLATED) as zf:
        for name in os.listdir(OUT):
            zf.write(os.path.join(OUT, name), name)
    print("\nWrote %s/ and %s.zip" % (OUT, OUT))


if __name__ == "__main__":
    main()
