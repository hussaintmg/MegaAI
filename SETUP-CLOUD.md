# MegaAI Cloud — setup (one time, ~15 minutes)

The cloud platform is a **Next.js app** (`apps/web`) on Vercel + **MongoDB**
for data + **GitHub Actions** as the execution engine. You open the dashboard
from anywhere, enter your API keys once, submit goals — the runner executes
them with the full MegaAI engine and the dashboard shows live progress.
Nothing runs on your machine.

```
Browser ── Vercel (Next.js dashboard + API) ── MongoDB Atlas
                     │  submit goal                 ▲
                     ▼                              │ status / report
             GitHub Actions runner ── runs the MegaAI engine
```

## 1. MongoDB Atlas (free)

1. https://cloud.mongodb.com → create a **free M0 cluster**.
2. Database Access → add a database user (username + password).
3. Network Access → **Allow access from anywhere** (`0.0.0.0/0`) — required for
   Vercel's serverless IPs.
4. Copy the connection string, e.g.
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/megaai`
   → this is **MONGODB_URI**.

## 2. Generate three secrets

Run this three times (or use any long random strings):

```bash
openssl rand -hex 32
```

→ **AUTH_SECRET** (session signing), **ENCRYPTION_SECRET** (API-key
encryption), **EXECUTOR_TOKEN** (platform ↔ runner auth).

## 3. GitHub token (lets the platform start runs)

GitHub → Settings → Developer settings → **Fine-grained personal access
tokens** → Generate new token:
- Repository access: **Only select repositories** → `hussaintmg/megaai`
- Permissions → Repository permissions → **Actions: Read and write**

→ this is **GITHUB_TOKEN** for Vercel.

## 4. Import the project in Vercel

Vercel dashboard → **Add New… → Project** → import `hussaintmg/megaai`:

- **Root Directory:** `apps/web`  ← important
- Framework: Next.js (auto-detected)
- **Environment variables:**

| Name | Value |
| --- | --- |
| `MONGODB_URI` | from step 1 |
| `AUTH_SECRET` | from step 2 |
| `ENCRYPTION_SECRET` | from step 2 |
| `EXECUTOR_TOKEN` | from step 2 |
| `GITHUB_TOKEN` | from step 3 |
| `GITHUB_REPO` | `hussaintmg/megaai` |
| `GITHUB_BRANCH` | branch with the workflows (`main` after merge, otherwise the working branch name) |
| `ADMIN_EMAIL` | your login email |
| `ADMIN_PASSWORD` | your login password (min 8 chars) |

Deploy. Your platform URL will be like `https://megaai-….vercel.app`.

## 5. GitHub Actions secrets (lets the runner report back)

GitHub repo → Settings → Secrets and variables → **Actions** → New repository
secret:

| Name | Value |
| --- | --- |
| `PLATFORM_URL` | your Vercel URL (e.g. `https://megaai-xyz.vercel.app`) |
| `EXECUTOR_TOKEN` | same value as in Vercel |

> Note: the `run-goal.yml` / `schedule-tick.yml` workflows must exist on the
> branch `GITHUB_BRANCH` points at. If you haven't merged to `main` yet, set
> `GITHUB_BRANCH` to the working branch.

## 6. Sign in and go

1. Open your Vercel URL → sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
   (the first login creates the admin account — there is no public signup).
2. **Settings** → paste your Gemini / OpenRouter / Groq keys → Save.
   Keys are AES-256 encrypted before they reach MongoDB.
3. **Dashboard** → type a goal → **Run goal**. Watch live events; the report
   and file list appear when the runner finishes. The complete workspace is
   attached to the Actions run as an artifact.
4. **Users** → add access for anyone else (you set their password; you can
   reset or remove them any time).
5. **Schedules** → recurring goals (the `schedule-tick.yml` cron drives them).

## Troubleshooting

- **Goal stuck on `error` right after submit** → the dashboard shows the
  dispatch error: usually `GITHUB_TOKEN` missing/expired, wrong
  `GITHUB_REPO`, or `GITHUB_BRANCH` pointing at a branch without the
  workflow file.
- **Goal stuck on `dispatched`** → open the repo's Actions tab; the run log
  will show why the runner failed before pickup (usually missing
  `PLATFORM_URL` / `EXECUTOR_TOKEN` repo secrets).
- **`invalid email or password` on first login** → `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` env vars in Vercel must match exactly what you typed; they
  seed the admin only while no users exist yet.
- **Keys not used by runs** → check Settings shows the provider as
  `configured`, and its checkbox is ON, and it appears in the fallback order.
