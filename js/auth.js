import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getAuth,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    GoogleAuthProvider,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged,
    signOut,
    updateProfile,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
    setPersistence,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    initializeFirestore,
    doc,
    setDoc,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    getStorage,
    ref,
    uploadBytesResumable,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ==========================================
// Firebase Config
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyD_MJ0w0G86yFxrp3yVyprEyN0QRfBjPvE",
  authDomain: "agritech-4d1ba.firebaseapp.com",
  projectId: "agritech-4d1ba",
  storageBucket: "agritech-4d1ba.firebasestorage.app",
  messagingSenderId: "1059596626185",
  appId: "1:1059596626185:web:42931ec9c49f5e26aa4bd8",
  measurementId: "G-05G03T03XE"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Brave / Opera / Edge with strict tracker blocking break Firestore's streaming
// WebChannel transport (firestore.googleapis.com). Auto-detect was unreliable
// in production — force long-polling so realtime listeners (onSnapshot) still
// deliver data on every browser. Slightly higher per-message overhead, but
// universally compatible.
export const db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
    useFetchStreams: false,
});

export const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

/** Incognito / private mode often rejects localStorage or IndexedDB-backed auth; chain fallbacks. */
export const authPersistenceReady = (async () => {
    try {
        await setPersistence(auth, browserLocalPersistence);
        return "local";
    } catch (e1) {
        console.warn("[auth] local persistence unavailable:", e1?.code || e1);
    }
    try {
        await setPersistence(auth, browserSessionPersistence);
        return "session";
    } catch (e2) {
        console.warn("[auth] session persistence unavailable:", e2?.code || e2);
    }
    try {
        await setPersistence(auth, inMemoryPersistence);
        return "memory";
    } catch (e3) {
        console.warn("[auth] in-memory persistence unavailable:", e3?.code || e3);
    }
    return "default";
})();

const AGRI_USER_KEY = "agri_user";
const MEM_PROFILE = "__agriUserProfile";

/** Safari private / locked-down browsers may throw on localStorage — fall back to session / memory. */
export function cacheAgriUserProfile(obj) {
    const s = JSON.stringify(obj);
    try {
        localStorage.setItem(AGRI_USER_KEY, s);
        return;
    } catch (_) {}
    try {
        sessionStorage.setItem(AGRI_USER_KEY, s);
        return;
    } catch (_) {}
    try {
        window[MEM_PROFILE] = obj;
    } catch (_) {}
}

export function getCachedAgriUserProfile() {
    try {
        const ls = localStorage.getItem(AGRI_USER_KEY);
        if (ls) return JSON.parse(ls);
    } catch (_) {}
    try {
        const ss = sessionStorage.getItem(AGRI_USER_KEY);
        if (ss) return JSON.parse(ss);
    } catch (_) {}
    return window[MEM_PROFILE] || null;
}

export function clearCachedAgriUserProfile() {
    try {
        localStorage.removeItem(AGRI_USER_KEY);
    } catch (_) {}
    try {
        sessionStorage.removeItem(AGRI_USER_KEY);
    } catch (_) {}
    try {
        delete window[MEM_PROFILE];
    } catch (_) {}
}

// Per-page scripts (profile.js, dashboard.js, etc.) each register their own
// onAuthStateChanged and handle routing.

/**
 * Wrap a Firebase write that *must not* block the auth flow.
 * Browsers like Brave can silently drop Firestore connections; we still want
 * to redirect the user even if the write is delayed/blocked.
 */
function fireAndForget(promise, label) {
    if (!promise || typeof promise.then !== "function") return;
    Promise.race([
        promise,
        new Promise((resolve) => setTimeout(resolve, 4000)),
    ]).catch((err) => {
        console.warn(`[auth] ${label} background write:`, err?.code || err?.message || err);
    });
}

/**
 * Detect Brave / Opera / strict-shield browsers where signInWithPopup is
 * unreliable due to partitioned storage. Falls back to redirect-based flow.
 */
async function isBraveBrowser() {
    try {
        if (navigator.brave && typeof navigator.brave.isBrave === "function") {
            return await navigator.brave.isBrave();
        }
    } catch (_) {}
    return false;
}

function isOperaBrowser() {
    const ua = navigator.userAgent || "";
    return /OPR\/|Opera/i.test(ua);
}

// 1. Google Auth (popup + automatic redirect fallback for Brave/Opera)
export const loginWithGoogle = async () => {
    const persistMode = await authPersistenceReady;

    const writeProfile = (user) => {
        fireAndForget(
            setDoc(doc(db, "users", user.uid), {
                name: user.displayName,
                email: user.email,
                photoURL: user.photoURL,
                lastLogin: serverTimestamp(),
                authProvider: 'google'
            }, { merge: true }),
            "google profile"
        );
    };

    const useRedirect =
        persistMode === "memory" ||
        (await isBraveBrowser()) ||
        isOperaBrowser();

    if (useRedirect) {
        // Tell index.html / login.html we expect a returning user, so they
        // show a loading state instead of bouncing back.
        try { sessionStorage.setItem('agri_pending_redirect', '1'); } catch (_) {}
        try {
            await signInWithRedirect(auth, googleProvider);
        } catch (error) {
            alert("Google Login Error: " + error.message);
            throw error;
        }
        return;
    }

    try {
        const result = await signInWithPopup(auth, googleProvider);
        const user = result.user;
        writeProfile(user);
        cacheAgriUserProfile({ name: user.displayName || "Farmer", email: user.email });
        window.location.replace("index.html");
    } catch (error) {
        const code = error?.code || "";
        // Popup blocked / closed / unsupported → fall back to redirect.
        if (
            code === "auth/popup-blocked" ||
            code === "auth/popup-closed-by-user" ||
            code === "auth/cancelled-popup-request" ||
            code === "auth/operation-not-supported-in-this-environment" ||
            code === "auth/web-storage-unsupported"
        ) {
            try {
                try { sessionStorage.setItem('agri_pending_redirect', '1'); } catch (_) {}
                await signInWithRedirect(auth, googleProvider);
                return;
            } catch (redirErr) {
                alert("Google Login Error: " + redirErr.message);
                throw redirErr;
            }
        }
        alert("Google Login Error: " + error.message);
        throw error;
    }
};

/**
 * Resolve a pending Google redirect sign-in. Call this once when login.html
 * (or any auth-aware page) loads. Resolves with the signed-in user or null.
 */
export const resolveGoogleRedirect = async () => {
    await authPersistenceReady;
    try {
        const result = await getRedirectResult(auth);
        if (!result || !result.user) return null;
        const user = result.user;
        fireAndForget(
            setDoc(doc(db, "users", user.uid), {
                name: user.displayName,
                email: user.email,
                photoURL: user.photoURL,
                lastLogin: serverTimestamp(),
                authProvider: 'google'
            }, { merge: true }),
            "google profile (redirect)"
        );
        cacheAgriUserProfile({ name: user.displayName || "Farmer", email: user.email });
        try { sessionStorage.removeItem('agri_pending_redirect'); } catch (_) {}
        return user;
    } catch (err) {
        try { sessionStorage.removeItem('agri_pending_redirect'); } catch (_) {}
        console.warn("[auth] redirect resolve:", err?.code || err?.message || err);
        return null;
    }
};

// 2. Email / Password Sign Up
export const signUpWithEmail = async (email, password, name) => {
    await authPersistenceReady;
    try {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        const user = result.user;

        // Update Firebase Auth Profile
        await updateProfile(user, { displayName: name });

        // Cache locally and redirect *immediately* — Firestore write runs in
        // the background so a blocked Firestore connection (Brave/Opera) does
        // not freeze the login button.
        cacheAgriUserProfile({ name, email });

        fireAndForget(
            setDoc(doc(db, "users", user.uid), {
                name,
                email,
                farmLocation: "",
                cropsGrown: [],
                createdAt: serverTimestamp(),
                authProvider: 'email'
            }),
            "signup profile"
        );

        window.location.replace("index.html");
    } catch (error) {
        alert("Sign Up Error: " + error.message);
        throw error;
    }
};

// 3. Email / Password Login
export const loginWithEmailPwd = async (email, password) => {
    await authPersistenceReady;
    try {
        const user = (await signInWithEmailAndPassword(auth, email, password)).user;
        cacheAgriUserProfile({ name: user.displayName || email.split('@')[0], email: user.email });

        // Update lastLogin in background — never block redirect on it.
        fireAndForget(
            setDoc(doc(db, "users", user.uid), {
                lastLogin: serverTimestamp(),
            }, { merge: true }),
            "login lastSeen"
        );

        window.location.replace("index.html");
    } catch (error) {
        alert("Login Error: " + error.message);
        throw error;
    }
};

// 4. Phone OTP Login
export const setupRecaptcha = (buttonId) => {
    window.recaptchaVerifier = new RecaptchaVerifier(auth, buttonId, {
        'size': 'invisible',
        'callback': (response) => {
            // reCAPTCHA solved
        }
    });
};

export const sendOTP = async (phoneNumber) => {
    await authPersistenceReady;
    try {
        const appVerifier = window.recaptchaVerifier;
        const confirmationResult = await signInWithPhoneNumber(auth, phoneNumber, appVerifier);
        window.confirmationResult = confirmationResult;
        return true;
    } catch (error) {
        alert("SMS Error: " + error.message);
        return false;
    }
};

export const verifyOTP = async (code) => {
    await authPersistenceReady;
    try {
        const result = await window.confirmationResult.confirm(code);
        const user = result.user;

        cacheAgriUserProfile({ name: "Farmer", phone: user.phoneNumber });

        fireAndForget(
            setDoc(doc(db, "users", user.uid), {
                phone: user.phoneNumber,
                lastLogin: serverTimestamp(),
                authProvider: 'phone'
            }, { merge: true }),
            "phone profile"
        );

        window.location.replace("index.html");
    } catch (error) {
        alert("Invalid OTP code");
    }
};

// 5. Logout
export const logoutUser = async () => {
    try {
        clearCachedAgriUserProfile(); // cleared BEFORE signOut so auth guard won't bounce back
        await signOut(auth);
        window.location.replace("login.html"); // replace() so back-button can't return to app
    } catch (error) {
        alert("Logout Error: " + error.message);
    }
};
