/**
 * CI / offline: same panel regression test without Firebase (localhost + ?e2e_panels=1).
 */
process.env.AGRI_TEST_LOCAL = "1";
await import("./profile-panels-playwright.mjs");
