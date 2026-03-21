# 🦌 First Light

**UK deer seasons, legal hours & stalking guide**

A free, offline-capable Progressive Web App for UK deer stalkers.

## Features

- **Legal shooting hours** — sunrise/sunset ±1hr, calculated for your GPS location
- **Live countdown** — time until legal window opens or closes
- **All 6 UK species** — Red, Fallow, Roe, Sika, Muntjac, Chinese Water Deer
- **Season status** — open/closed per species, England/Wales/Scotland
- **7-day forecast** — legal start/end times for the week ahead
- **Deer activity forecast** — moon phase + rut calendar + time of day
- **Field guide** — shot placement, deer ID, legal calibres, stalking safety, DSC reference
- **Fully offline** — works without signal once loaded

## Install as an App (iOS)

1. Open the link in **Safari**
2. Tap the **Share** button
3. Tap **Add to Home Screen**
4. Tap **Add**

The app installs with its icon and runs fullscreen — no browser chrome.

## Install as an App (Android)

1. Open the link in **Chrome**
2. Tap the **three-dot menu**
3. Tap **Add to Home Screen**

## Live App

👉 **[Open First Light](https://c7bzd7hvx8-art.github.io/first-light/)**

## Deploy Your Own

1. Fork this repo
2. Go to **Settings → Pages**
3. Set source to **main branch**, root folder
4. Your app will be live at `https://YOUR-USERNAME.github.io/REPO-NAME/`

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire app — all HTML, CSS and JS in one file |
| `manifest.json` | PWA manifest — name, icons, display mode |
| `sw.js` | Service worker — offline caching |
| `icon-*.png` | App icons for home screen |

## Legal

Times are calculated using astronomical formulae and are approximate. Always verify legal shooting hours with current legislation. The Wildlife and Countryside Act 1981, Deer Act 1991, and Deer (Scotland) Act 1996 apply. This app is a reference tool only — the developer accepts no liability for errors.

## Licence

MIT — free to use, modify and distribute.
