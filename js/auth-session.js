/**
 * Central authentication & session management for Smart Farming (Firebase Web).
 * - Protected routes: gate until user + ID token valid; realtime auth + token listeners.
 * - Public routes: bounce signed-in users to the dashboard.
 * - Logout / token loss / invalid session: clean listeners, clear sensitive storage, redirect to login.
 *
 * Import this module FIRST on every HTML entry (before dashboard.js, fields.js, etc.).
 */
import "./runtime-profile.js?v=28";
import { auth, clearSensitiveLocalStorage } from "./auth.js?v=28";
import {
  onAuthStateChanged,
  onIdTokenChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const PUBLIC_PAGES = new Set([
  "login.html",
  "signup.html",
  "email-login.html",
  "phone-login.html",
  "googlee2af47a0969bd619.html",
]);

function getCurrentPageName() {
  const path = (location.pathname || "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  let name = parts.pop() || "";
  if (!name.includes(".")) name = "index.html";
  return name.toLowerCase();
}

export function isPublicRoute() {
  return PUBLIC_PAGES.has(getCurrentPageName());
}

export function isProtectedRoute() {
  return !isPublicRoute();
}

const cleanups = new Set();
let redirectLocked = false;
let unlinkAuthListeners = null;

/** Register a teardown (e.g. unsubscribe Firestore). Called on logout / session loss. */
export function registerAuthCleanup(fn) {
  if (typeof fn === "function") cleanups.add(fn);
}

export function runAllAuthCleanups() {
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch (_) {}
  });
  cleanups.clear();
}

globalThis.__agriRunAuthCleanups = runAllAuthCleanups;

function loginUrl() {
  try {
    return new URL("login.html", location.href).href;
  } catch (_) {
    return "login.html";
  }
}

function injectStylesheet() {
  if (document.querySelector('link[data-agri-auth-shell="1"]')) return;
  const href = new URL("../css/auth-shell.css", import.meta.url).href;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.agriAuthShell = "1";
  (document.head || document.documentElement).appendChild(link);
}

function ensureAuthShell(statusText) {
  injectStylesheet();
  if (document.getElementById("agri-auth-shell")) {
    const st = document.querySelector(".agri-auth-shell__status");
    if (st && statusText) st.textContent = statusText;
    return;
  }
  const wrap = document.createElement("div");
  wrap.id = "agri-auth-shell";
  wrap.innerHTML = `
    <div class="agri-auth-shell__noise"></div>
    <div class="agri-auth-shell__orb"></div>
    <div class="agri-auth-shell__particles" aria-hidden="true"></div>
    <div class="agri-auth-shell__card" role="status" aria-live="polite">
      <div class="agri-auth-shell__logo" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C7 6 4 10 4 14c0 3 2.5 5 5 5 .5 0 1-.05 1.5-.15C8.5 17 7 14.5 7 12c0-2.8 2.2-6.2 5-9.5V2h0zm2 0v.5C17.8 5.8 20 9.2 20 12c0 2.5-1.5 5-3.5 6.85.5.1 1 .15 1.5.15 2.5 0 5-2 5-5 0-4-3-8-8-12z" fill="#34d399"/></svg></div>
      <div class="agri-auth-shell__title">Smart Farming</div>
      <div class="agri-auth-shell__status">${statusText || ""}</div>
      <div class="agri-auth-shell__bar"><span></span></div>
    </div>
  `;
  const particles = wrap.querySelector(".agri-auth-shell__particles");
  if (particles) {
    const low = document.documentElement.dataset.agriPerf === "low";
    const count = low ? 4 : 10;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("div");
      p.className = "agri-auth-shell__particle";
      p.style.left = `${6 + Math.random() * 88}%`;
      p.style.animationDelay = `${Math.random() * 6}s`;
      p.style.animationDuration = `${6 + Math.random() * 5}s`;
      particles.appendChild(p);
    }
  }
  (document.body || document.documentElement).appendChild(wrap);
}

function setShellStatus(msg) {
  const st = document.querySelector(".agri-auth-shell__status");
  if (st) st.textContent = msg;
}

function removeAuthShell() {
  const sh = document.getElementById("agri-auth-shell");
  if (!sh) return;
  sh.classList.add("agri-auth-shell--out");
  document.documentElement.classList.remove("agri-auth-locked");
  document.body?.classList.remove("agri-auth-locked");
  setTimeout(() => {
    try {
      sh.remove();
    } catch (_) {}
  }, 440);
}

function lockChrome() {
  document.documentElement.classList.add("agri-auth-locked");
  document.body?.classList.add("agri-auth-locked");
}

async function validateIdToken(user, forceRefresh) {
  if (!user) throw new Error("no-user");
  const ms = 14_000;
  const tokenTask = user.getIdToken(forceRefresh);
  const timeout = new Promise((_, rej) => {
    setTimeout(() => rej(new Error("auth-timeout")), ms);
  });
  return Promise.race([tokenTask, timeout]);
}

async function cinematicRedirect(toUrl, opts = {}) {
  if (redirectLocked) return;
  redirectLocked = true;
  const { signOutFirst = true } = opts;

  lockChrome();
  ensureAuthShell(opts.status || "Securing session…");
  setShellStatus(opts.status || "Redirecting securely…");

  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));

  if (signOutFirst) {
    try {
      if (auth.currentUser) await signOut(auth);
    } catch (_) {}
  }

  await new Promise((r) => setTimeout(r, opts.delayMs ?? 200));
  location.replace(toUrl);
}

export async function forceSessionEnd(reason) {
  if (redirectLocked) return;
  runAllAuthCleanups();
  clearSensitiveLocalStorage();
  const msg = reason === "offline"
    ? "You’re offline. Reconnect to continue."
    : "Session ended. Signing you out safely…";
  await cinematicRedirect(loginUrl(), { status: msg, signOutFirst: true, delayMs: 260 });
}

async function redirectToLoginSoft() {
  if (redirectLocked) return;
  redirectLocked = true;
  runAllAuthCleanups();
  clearSensitiveLocalStorage();
  lockChrome();
  ensureAuthShell("Sign in to continue…");
  setShellStatus("Taking you to the sign-in gate…");
  await new Promise((r) => setTimeout(r, 220));
  location.replace(loginUrl());
}

let idTokenValidationLock = false;

function attachRealtimeGuards() {
  if (unlinkAuthListeners) {
    try {
      unlinkAuthListeners();
    } catch (_) {}
    unlinkAuthListeners = null;
  }

  const unsubs = [];

  unsubs.push(
    onAuthStateChanged(auth, (user) => {
      if (!isProtectedRoute() || redirectLocked) return;
      if (!user) {
        redirectToLoginSoft();
      }
    })
  );

  unsubs.push(
    onIdTokenChanged(auth, async (user) => {
      if (!isProtectedRoute() || redirectLocked) return;
      if (!user) {
        await forceSessionEnd("signed-out");
        return;
      }
      if (idTokenValidationLock) return;
      idTokenValidationLock = true;
      try {
        await validateIdToken(user, false);
      } catch (e) {
        const off = typeof navigator !== "undefined" && navigator.onLine === false;
        if (off) {
          setShellStatus("Offline — reconnect to refresh your session.");
          window.addEventListener("online", () => location.reload(), { once: true });
          return;
        }
        await forceSessionEnd("invalid-token");
      } finally {
        idTokenValidationLock = false;
      }
    })
  );

  unlinkAuthListeners = () => {
    unsubs.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
  };
}

async function runProtectedGate() {
  injectStylesheet();
  lockChrome();
  ensureAuthShell("Verifying your secure session…");

  try {
    await auth.authStateReady();
  } catch (_) {}

  const user = auth.currentUser;
  if (!user) {
    await redirectToLoginSoft();
    return;
  }

  try {
    await validateIdToken(user, false);
  } catch (e) {
    const off = typeof navigator !== "undefined" && navigator.onLine === false;
    if (off) {
      setShellStatus("No network. Connect, then we’ll verify your session.");
      window.addEventListener("online", () => location.reload(), { once: true });
      return;
    }
    setShellStatus("Your session could not be verified. Signing you out…");
    await forceSessionEnd("invalid-token");
    return;
  }

  setShellStatus("Welcome back — loading your farm…");
  attachRealtimeGuards();

  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
  removeAuthShell();
}

async function runPublicGate() {
  try {
    await auth.authStateReady();
  } catch (_) {}

  const user = auth.currentUser;
  if (!user) return;

  lockChrome();
  ensureAuthShell("Restoring your session…");

  try {
    await validateIdToken(user, false);
  } catch (_) {
    removeAuthShell();
    try {
      await signOut(auth);
    } catch (_) {}
    return;
  }

  setShellStatus("Opening your dashboard…");
  await new Promise((r) => setTimeout(r, 160));
  try {
    location.replace(new URL("index.html", location.href).href);
  } catch (_) {
    location.replace("index.html");
  }
}

function boot() {
  if (isProtectedRoute()) {
    runProtectedGate().catch(() => {
      if (!redirectLocked) forceSessionEnd("boot-error");
    });
  } else {
    runPublicGate().catch(() => {});
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

window.addEventListener("storage", (e) => {
  if (e.key === "agri_force_logout_v1" && e.newValue) {
    if (isProtectedRoute() && !redirectLocked) {
      forceSessionEnd("other-tab");
    }
  }
});
