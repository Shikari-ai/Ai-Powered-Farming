# Ai-Powered-Farming

Smart agriculture web app: Firebase auth, fields, weather, and crop intelligence.

## Production

- **Firebase Hosting:** [https://agritech-4d1ba.web.app](https://agritech-4d1ba.web.app) (login: [login.html](https://agritech-4d1ba.web.app/login.html))

Pushes to `main` deploy via [Firebase Hosting](.github/workflows/firebase-hosting-deploy.yml) when `FIREBASE_SERVICE_ACCOUNT` is configured in the repo secrets.

## Local checks

From the repo root (requires Node.js):

```bash
node scripts/verify.mjs
```

This validates all `js/i18n/*.json` files and runs `node --check` on every `js/*.js` module.

## Local preview

Serve the static root (Firebase `public` is `.`):

```bash
npx --yes serve -l 3000 .
```

Then open `http://localhost:3000/login.html` (or `index.html`). ES modules expect HTTP, not `file://`.
