import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getAuth,
    signInWithPopup,
    GoogleAuthProvider,
    OAuthProvider,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getFirestore,
    doc,
    setDoc,
    enableIndexedDbPersistence,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    getStorage,
    ref,
    uploadBytesResumable,
    getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ==========================================
// ⚠️ ACTION REQUIRED: ADD YOUR FIREBASE KEYS
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
export const db = getFirestore(app);
export const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

// Offline persistence (production-grade caching). Safe to ignore if unavailable (e.g. private mode / multiple tabs).
enableIndexedDbPersistence(db).catch((err) => {
    console.warn("Firestore persistence unavailable:", err?.code || err);
});

// Per-page scripts (profile.js, dashboard.js, etc.) each register their own
// onAuthStateChanged and handle routing. No shared redirect listener here —
// it caused post-logout bounce because Firebase's IndexedDB cache briefly
// reports user as signed-in even after signOut.

// Persist a /users/{uid} doc but never block auth on it. If Firestore is
// unreachable or rules reject the write, log + continue — the auth account
// already exists and the user shouldn't be locked out.
async function saveUserDocSafely(uid, data) {
    try {
        await setDoc(doc(db, "users", uid), data, { merge: true });
    } catch (err) {
        console.warn("[auth] Firestore user-doc write failed (non-fatal):", err?.code || err?.message || err);
    }
}

// 1. Google Auth
export const loginWithGoogle = async () => {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    await saveUserDocSafely(user.uid, {
        name: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        lastLogin: serverTimestamp(),
        authProvider: 'google'
    });
    localStorage.setItem('agri_user', JSON.stringify({ name: user.displayName || "Farmer", email: user.email }));
    window.location.replace("index.html");
};

// 1b. Apple Auth
export const loginWithApple = async () => {
    const result = await signInWithPopup(auth, appleProvider);
    const user = result.user;
    await saveUserDocSafely(user.uid, {
        name: user.displayName || "Farmer",
        email: user.email,
        lastLogin: serverTimestamp(),
        authProvider: 'apple'
    });
    localStorage.setItem('agri_user', JSON.stringify({ name: user.displayName || "Farmer", email: user.email || '' }));
    window.location.replace("index.html");
};

// 2. Email / Password Sign Up
export const signUpWithEmail = async (email, password, name) => {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    const user = result.user;
    try { await updateProfile(user, { displayName: name }); } catch (_) {}
    await saveUserDocSafely(user.uid, {
        name: name,
        email: email,
        farmLocation: "",
        cropsGrown: [],
        createdAt: serverTimestamp(),
        authProvider: 'email'
    });
    localStorage.setItem('agri_user', JSON.stringify({ name: name, email: email }));
    window.location.replace("index.html");
};

// 3. Email / Password Login
export const loginWithEmailPwd = async (email, password) => {
    const user = (await signInWithEmailAndPassword(auth, email, password)).user;
    localStorage.setItem('agri_user', JSON.stringify({ name: user.displayName || email.split('@')[0], email: user.email }));
    window.location.replace("index.html");
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
    try {
        const result = await window.confirmationResult.confirm(code);
        const user = result.user;

        await setDoc(doc(db, "users", user.uid), {
            phone: user.phoneNumber,
            lastLogin: serverTimestamp(),
            authProvider: 'phone'
        }, { merge: true });

        localStorage.setItem('agri_user', JSON.stringify({name: "Farmer", phone: user.phoneNumber}));
        window.location.replace("index.html");
    } catch (error) {
        alert("Invalid OTP code");
    }
};

// 5. Logout
export const logoutUser = async () => {
    try {
        localStorage.removeItem('agri_user');  // cleared BEFORE signOut so auth guard won't bounce back
        await signOut(auth);
        window.location.replace("login.html"); // replace() so back-button can't return to app
    } catch (error) {
        alert("Logout Error: " + error.message);
    }
};
