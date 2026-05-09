# Testing

## Production host

Use the live Firebase Hosting site (not a local server):

**https://agritech-4d1ba.web.app**

Example entry: [login.html](https://agritech-4d1ba.web.app/login.html)

Deploys run from `main` via GitHub Actions when [`firebase-hosting-deploy.yml`](.github/workflows/firebase-hosting-deploy.yml) is configured with `FIREBASE_SERVICE_ACCOUNT`.

## Static checks (local machine)

```bash
node scripts/verify.mjs
node scripts/production-smoke.mjs
```

`production-smoke.mjs` requests the real `agritech-4d1ba.web.app` HTML and checks key profile markers.

## QA test account (email / password)

Shared convention for manual and future automated sign-in tests:

| Field | Value |
|--------|--------|
| **Email** | `agritech.e2e.qa@mailinator.com` |
| **Firebase Auth UID** | `13B2ruFWmDSdbztz2JBBFK8voY92` |
| **Password** | Chosen when the account was created via `create-test-user.mjs` (never commit it). Rotate in [Firebase Console](https://console.firebase.google.com/) → Authentication if needed. |

Create or verify the Auth user against **production** Firebase:

```powershell
$env:AGRI_TEST_EMAIL = "agritech.e2e.qa@mailinator.com"
$env:AGRI_TEST_PASSWORD = "<strong password you choose>"
node scripts/create-test-user.mjs
```

If you see `EMAIL_EXISTS`, the account is already registered—sign in with that email and password at the production login page.

Optional: override API key with `FIREBASE_WEB_API_KEY` if you use a different Firebase Web app.

## CI

- **Verify:** [`.github/workflows/verify.yml`](.github/workflows/verify.yml) runs `node scripts/verify.mjs`.
- Add `node scripts/production-smoke.mjs` to that workflow if you want every push to hit production (can be flaky if the site is down).
