/**
 * Create (or confirm) an email/password QA user on the production Firebase project.
 * Uses the same Web API key as the client (public). Does not commit secrets.
 *
 * Usage:
 *   set AGRI_TEST_EMAIL=your-qa@example.com
 *   set AGRI_TEST_PASSWORD=your-strong-password
 *   node scripts/create-test-user.mjs
 *
 * Defaults are for a shared disposable-inbox QA identity (change if you prefer).
 */
const apiKey =
  process.env.FIREBASE_WEB_API_KEY || "AIzaSyD_MJ0w0G86yFxrp3yVyprEyN0QRfBjPvE";

const email =
  process.env.AGRI_TEST_EMAIL || "agritech.e2e.qa@mailinator.com";
const password = process.env.AGRI_TEST_PASSWORD;

if (!password || password.length < 8) {
  console.error(
    "Set AGRI_TEST_PASSWORD (min 8 chars). Example (PowerShell):\n" +
      "  $env:AGRI_TEST_PASSWORD='YourStrongPass123!'\n" +
      "  node scripts/create-test-user.mjs"
  );
  process.exit(1);
}

const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email,
    password,
    returnSecureToken: true,
  }),
});

const data = await res.json();

if (data.error) {
  const code = data.error?.message;
  if (code === "EMAIL_EXISTS") {
    console.log("Account already exists (EMAIL_EXISTS). Sign in at:");
    console.log("  https://agritech-4d1ba.web.app/login.html");
    console.log("  Email:", email);
    process.exit(0);
  }
  console.error("Firebase error:", code, data.error);
  process.exit(1);
}

console.log("Created QA Auth user.");
console.log("  localId (UID):", data.localId);
console.log("  email:", email);
console.log("Sign in: https://agritech-4d1ba.web.app/login.html");
console.log(
  "(Firestore user doc is created when you use Sign Up in the app or save profile.)"
);
