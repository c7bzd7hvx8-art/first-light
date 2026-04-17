# First Light — static deploy bundle (`betav2`)

This folder is a **self-contained copy** of the files needed to run the site (main app, Cull Diary, Deer School, legal pages, service worker, icons, Leaflet vendor, ES modules, question bank).

## Upload

1. Upload **the contents of this folder** (not the parent repo) to your host’s **web root** for the test URL, **or** to the document root of a dedicated subdomain (e.g. `beta.example.com` → files at `/`).
2. **HTTPS** is strongly recommended; service workers and many APIs require a secure context (localhost excepted).
3. **Do not** nest only part of the tree under a path like `/betav2/` unless you know the app’s relative URLs and SW scope still match — safest is **subdomain = root** or **whole site at domain root**.

## What’s included

- HTML: `index.html`, `diary.html`, `deerschool.html`, `privacy.html`, `terms.html`, `diary-guide.html`
- JS/CSS: `app.js`, `styles.css`, `diary.js`, `diary.css`, `deerschool.js`, `deerschool.css`, `questions.js`, `sw.js`
- Modules: `modules/*.mjs` + `lib/fl-pure.mjs` (required by the diary modules)
- PWA: `manifest.json`, `manifest-diary.json`, `icon-*.png`
- Maps: `vendor/leaflet/` (JS, CSS, default marker images)

## What’s excluded (not needed on the server)

- `tests/`, `scripts/`, `exports/`, `previews/`, `package.json`, CI, docs — dev/build only.

## After changing the live site

Regenerate this folder from the repo root (PowerShell):

```powershell
# Example: remove and recopy — adjust if you script this in repo
Remove-Item -Recurse -Force betav2 -ErrorAction SilentlyContinue
# Then re-run the same copy steps used to create betav2, or add a small script under scripts/.
```

Supabase keys and API URLs are **embedded in client code** as today; point staging Supabase in code before shipping a true staging build if needed.
