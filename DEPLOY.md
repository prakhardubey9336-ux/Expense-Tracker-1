# Deploying SmartSpend

> **Short version.** SmartSpend is a **Node.js + Express + SQLite** application.
> **GitHub Pages cannot run it** — Pages only serves static files, so there is no
> `/api` and no database, and the dashboard will always be empty there.
> Host it on a platform that runs Node (Render, Railway, Fly.io, Koyeb, a VPS) —
> or keep GitHub for the source code and run it locally for the viva.

---

## 1. Why GitHub Pages "nothing works" (the honest explanation)

| What GitHub Pages does | What SmartSpend needs | Result on Pages |
|---|---|---|
| Serves HTML/CSS/JS files | a Node process running `server.js` | the files load, but nothing is running |
| No `/api/*` routes | `GET /api/summary`, `POST /api/transactions`, … | every request → the host's own **404** page |
| No filesystem | a real `expense-tracker.db` file | there is nowhere to store a transaction |
| Project sites live at `/<repo>/` | the app asked for `/js/app.js`, `/login.html` | absolute paths 404 → **dead buttons** (fixed in 2.2: all paths are relative now) |

So the correct mental model is:

```
GitHub (the repository)  →  source code, version history, screenshots, docs
GitHub Pages             →  can only ever be a static showcase, never the app
Render / Railway / Fly   →  the actual running application
```

A page that *looks* fine but has dead buttons is worse than an honest one, so in 2.2 the
frontend tells the truth on a static host: the login page still renders and Supabase sign-in
still works, but the dashboard shows a single banner — *"No backend here … /api cannot answer"*
— instead of one error toast per request.

---

## 2. Option A — run it on a free Node host (recommended)

### Render (has a ready-made blueprint)

1. Push the project to GitHub (any branch, e.g. `main`).
2. <https://dashboard.render.com> → **New** → **Blueprint** → pick the repository.
   Render reads `render.yaml` from this folder and creates a **Web Service**.
3. Wait for the build (`npm install` compiles `better-sqlite3`, ~1–2 minutes).
4. Open `https://<your-service>.onrender.com` — you should land on `/login.html`.

`render.yaml` sets:

| Variable | Value | Meaning |
|---|---|---|
| `NODE_VERSION` | `20` | matches the tested runtime |
| `SMARTSPEND_SEED_DEMO` | `1` | fills an **empty** database with the demo rows on boot |
| `SMARTSPEND_DB` | `/opt/render/project/src/expense-tracker.db` | where the SQLite file lives |

**The free plan wipes the disk on every deploy/restart.** That is why the seed flag exists: a
published demo link always has data. For data that survives, attach a persistent disk (paid plan),
set `SMARTSPEND_DB=/var/data/expense-tracker.db`, and mount the disk at `/var/data`.

### Railway / Fly.io / Koyeb / any Docker host

A `Dockerfile` is included, so the same project deploys anywhere that accepts a container:

```bash
docker build -t smartspend .
docker run -p 3000:3000 -v smartspend-data:/data smartspend
# → http://localhost:3000
```

On a container host, mount a volume at `/data` (the image already points
`SMARTSPEND_DB` there) and set `SMARTSPEND_SEED_DEMO=1` if you want demo data on first boot.

### After the first deploy, do these two things

1. **Supabase → Authentication → URL Configuration**
   * Site URL: `https://<your-service>.onrender.com`
   * Redirect URLs: `https://<your-service>.onrender.com/*`
   Without this, the "confirm your email" and "reset password" links point at `localhost`
   and fail.
2. **Run `supabase/schema.sql` once** in the Supabase SQL editor (see `docs/SUPABASE.md` §2) if
   you have not already. Until then Settings says *"schema not installed"*.

---

## 3. Option B — GitHub Pages as a showcase only

Useful if the submission requires a public link. Keep the app running locally (or on Render)
and let Pages hold a description, screenshots and the demo link.

GitHub Pages settings: **Settings → Pages → Source: Deploy from a branch → `/docs`**.
That option needs a landing page inside `docs/`; this repository does not ship one yet — say the
word and it can be added (`docs/index.html` with the screenshots and a link to the live demo).

Do **not** point Pages at `/public`: the app would load with no API and no session, which is
exactly the confusing state this document exists to avoid.

---

## 4. Option C — localhost (what the viva needs)

```bash
npm install
npm start          # http://localhost:3000
```

No internet required: the login page offers **Continue without an account** (local mode), and
every feature works against the local SQLite file. This is the configuration used for all 380
automated checks (240 backend + 140 browser).

---

## 4b. Prove the static-host behaviour yourself

```bash
node tests-ui/statictest.js      # 11 checks, needs no server
```

It serves `public/` the way GitHub Pages would (a sub-folder, no API) and checks that every asset
still loads, that the login form works, and that the dashboard shows **one** honest
*"No backend here"* banner with empty figures instead of a wall of failed requests. The screenshots
it saves are in `tests-ui/out/static/`.

---

## 5. Deployment checklist

- [ ] Repository contains the project (not the zip inside the repository)
- [ ] `npm install` succeeds on the host (build tools available for `better-sqlite3`)
- [ ] `GET /api/health` returns `{"status":"ok"}` on the deployed URL
- [ ] `/login.html` loads and **app.js is not 404** (check DevTools → Network)
- [ ] Supabase Site URL + Redirect URLs point at the deployed domain
- [ ] `supabase/schema.sql` has been run (Settings → Account & cloud says *connected*)
- [ ] Decide about data: seeded demo (`SMARTSPEND_SEED_DEMO=1`) or a persistent disk
- [ ] **Say in the report that the finance data lives in SQLite on the server**, not in Supabase

---

## 6. Common deployment failures

| Symptom | Cause | Fix |
|---|---|---|
| Build fails on `better-sqlite3` / `node-gyp` | no compiler or a Node version without prebuilt binaries | use Node 20, or the provided `Dockerfile` (installs python3/make/g++) |
| Deployed page loads but buttons do nothing | you are looking at GitHub Pages, or `app.js` 404s | use `/login.html` on the Node host; check the Network tab |
| Dashboard empty, banner says "No backend here" | static hosting | deploy on Node (Option A) |
| Everything empty after a redeploy | free plan's ephemeral disk | `SMARTSPEND_SEED_DEMO=1`, or attach a disk |
| Sign-in works, confirmation email link 404s | Supabase redirect URLs still point at localhost | update Site URL / Redirect URLs |
| `Cannot reach the SmartSpend server` on a *working* server | the page is embedded in a cross-origin frame without CORS | 2.2 sends CORS headers; make sure you deployed 2.2 or newer |
