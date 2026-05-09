/**
 * One-time intro: slides → language → Firestore + redirect home.
 */
import { auth, db } from "./auth.js";
import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { LANGUAGES } from "./i18n.js";

const SLIDES = [
    {
        k: "s1",
        title: "AI for a better tomorrow",
        sub: "Smart Farming connects your fields to satellite intelligence, live weather, and predictive analytics — in one premium command center.",
        icon: "ri-earth-line",
    },
    {
        k: "s2",
        title: "Global farming network",
        sub: "Monitor crops, soil, and water from anywhere. Real-time overlays turn aerial insight into decisions you can act on today.",
        icon: "ri-radar-line",
    },
    {
        k: "s3",
        title: "Health, pests & irrigation",
        sub: "Crop health scores, pest radar, and irrigation intelligence work together so you catch risk early and use water with precision.",
        icon: "ri-leaf-line",
    },
    {
        k: "s4",
        title: "Markets & AI assistant",
        sub: "Yield signals, recommendations, and your voice-ready assistant — tuned for how you actually farm.",
        icon: "ri-sparkling-line",
    },
];

let audioCtx = null;
let soundEnabled = false;

function unlockAudio() {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") audioCtx.resume();
        soundEnabled = true;
    } catch (_) {}
}

/** Soft melodic chime (pentatonic) */
function playSlideChime() {
    if (!soundEnabled || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    const freqs = [392, 493.88, 587.33]; // G4, B4, D5
    freqs.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t0 + i * 0.05);
        gain.gain.setValueAtTime(0, t0 + i * 0.05);
        gain.gain.linearRampToValueAtTime(0.07, t0 + i * 0.05 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.05 + 0.55);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + i * 0.05);
        osc.stop(t0 + i * 0.05 + 0.6);
    });
}

function playConfirmTone() {
    if (!soundEnabled || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, t0 + i * 0.08);
        gain.gain.setValueAtTime(0, t0 + i * 0.08);
        gain.gain.linearRampToValueAtTime(0.06, t0 + i * 0.08 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.08 + 0.45);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t0 + i * 0.08);
        osc.stop(t0 + i * 0.08 + 0.5);
    });
}

function haptic(ms = 18) {
    if (navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {}
}

function goHome() {
    window.location.replace("index.html");
}

function renderSlide(idx) {
    const s = SLIDES[idx];
    const title = document.getElementById("ob-slide-title");
    const sub = document.getElementById("ob-slide-sub");
    const icon = document.getElementById("ob-slide-icon");
    if (title) title.textContent = s.title;
    if (sub) sub.textContent = s.sub;
    if (icon) icon.className = s.icon;

    document.querySelectorAll(".ob-dot").forEach((d, i) => {
        d.classList.toggle("active", i === idx);
    });

    const prog = document.getElementById("ob-progress");
    if (prog) prog.style.setProperty("--p", `${((idx + 1) / SLIDES.length) * 100}%`);

    const wrap = document.getElementById("ob-slide-wrap");
    if (wrap) {
        wrap.classList.remove("ob-fade-in");
        void wrap.offsetWidth;
        wrap.classList.add("ob-fade-in");
    }

    const nextBtn = document.getElementById("ob-next");
    if (nextBtn) {
        nextBtn.textContent = idx >= SLIDES.length - 1 ? "Choose language" : "Next";
    }

    playSlideChime();
    haptic(12);
}

function showLangPhase() {
    document.getElementById("ob-phase-slides")?.classList.add("hidden");
    document.getElementById("ob-phase-lang")?.classList.remove("hidden");
    playConfirmTone();
    haptic(22);
}

function wireLanguages(uid) {
    const grid = document.getElementById("ob-lang-grid");
    if (!grid) return;
    grid.innerHTML = "";
    let selected = localStorage.getItem("agri_lang") || "en";

    LANGUAGES.forEach((L) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ob-lang-card" + (L.code === selected ? " selected" : "");
        btn.innerHTML = `<span class="ob-lang-native">${L.native}</span><span class="ob-lang-en">${L.name}</span>`;
        btn.addEventListener("click", () => {
            unlockAudio();
            selected = L.code;
            grid.querySelectorAll(".ob-lang-card").forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
            playSlideChime();
            haptic(15);
        });
        grid.appendChild(btn);
    });

    const finish = document.getElementById("ob-finish");
    if (finish) {
        finish.onclick = async () => {
            unlockAudio();
            playConfirmTone();
            haptic(28);
            finish.disabled = true;
            try {
                localStorage.setItem("agri_lang", selected);
                if (window.i18n) window.i18n.setLanguage(selected);
                await setDoc(
                    doc(db, "users", uid),
                    {
                        langPreference: selected,
                        onboardingCompleted: true,
                        onboardingCompletedAt: serverTimestamp(),
                    },
                    { merge: true }
                );
                try {
                    localStorage.setItem(`agri_onboarding_done_${uid}`, "1");
                } catch (_) {}
            } catch (e) {
                console.warn("onboarding save:", e);
                finish.disabled = false;
                return;
            }
            goHome();
        };
    }
}

function initSlides() {
    let idx = 0;
    const next = document.getElementById("ob-next");
    const skip = document.getElementById("ob-skip");

    const goNext = () => {
        unlockAudio();
        if (idx < SLIDES.length - 1) {
            idx++;
            renderSlide(idx);
        } else {
            showLangPhase();
        }
    };

    if (next) next.addEventListener("click", goNext);
    if (skip) {
        skip.addEventListener("click", () => {
            unlockAudio();
            showLangPhase();
        });
    }

    document.querySelectorAll(".ob-dot").forEach((d, i) => {
        d.addEventListener("click", () => {
            unlockAudio();
            idx = i;
            renderSlide(idx);
        });
    });

    // Touch swipe
    const panel = document.getElementById("ob-touch-panel");
    if (!panel) return;
    let x0 = 0;
    let tracking = false;
    panel.addEventListener(
        "touchstart",
        (e) => {
            tracking = true;
            x0 = e.touches[0].clientX;
        },
        { passive: true }
    );
    panel.addEventListener(
        "touchend",
        (e) => {
            if (!tracking) return;
            tracking = false;
            const x1 = e.changedTouches[0].clientX;
            const dx = x1 - x0;
            if (Math.abs(dx) < 48) return;
            unlockAudio();
            if (dx < 0 && idx < SLIDES.length - 1) {
                idx++;
                renderSlide(idx);
            } else if (dx > 0 && idx > 0) {
                idx--;
                renderSlide(idx);
            }
        },
        { passive: true }
    );

    renderSlide(0);
}

async function bootOnboarding() {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) {
        window.location.replace("login.html");
        return;
    }

    const uref = doc(db, "users", user.uid);
    try {
        const snap = await getDoc(uref);
        if (snap.exists() && snap.data()?.onboardingCompleted === true) {
            goHome();
            return;
        }
    } catch (_) {}

    document.body.classList.add("ob-ready");

    const once = () => {
        unlockAudio();
        document.removeEventListener("touchstart", once);
        document.removeEventListener("click", once);
    };
    document.addEventListener("touchstart", once, { passive: true });
    document.addEventListener("click", once);

    wireLanguages(user.uid);
    initSlides();
}

bootOnboarding();
