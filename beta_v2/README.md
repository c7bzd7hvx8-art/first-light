# First Light — static app bundle

This folder is a **minimal deployable copy** of the First Light web app (Field Guide, Diary PWA, Deer School, legal pages, service worker, icons, and dependencies).

**Regenerate** from the main project (same content as `betav2/`):

```bash
node scripts/build-betav2.mjs beta_v2
```

Run that from the repository root. The script preserves this `README.md` across rebuilds.

Host on any static file server or GitHub Pages (site root = this folder).
