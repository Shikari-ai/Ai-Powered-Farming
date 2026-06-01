/**
 * Web Speech API bridge: STT + TTS with interruption (copilot-safe).
 * Future: swap for streaming cloud voices; keep this API modality-agnostic.
 */

function pickCalmVoice(lang) {
    if (typeof speechSynthesis === "undefined") return null;
    const voices = speechSynthesis.getVoices() || [];
    const want = String(lang || "en-US");
    const short = want.slice(0, 2);
    const ranked = voices.filter((v) => v.lang && v.lang.startsWith(short));
    const prefer = ranked.find((v) => /Google|Microsoft|Natural|Samantha|Karen/i.test(v.name));
    return prefer || ranked[0] || voices[0] || null;
}

export function createCopilotVoice(options = {}) {
    const { onStatus } = options;

    let recognition = null;
    let listening = false;
    let selectedLang =
        options.lang ||
        (typeof navigator !== "undefined" && navigator.language) ||
        "en-US";

    function setLang(lang) {
        if (lang) selectedLang = lang;
    }

    function ensureVoicesLoaded() {
        return new Promise((resolve) => {
            if (typeof speechSynthesis === "undefined") {
                resolve();
                return;
            }
            const v = speechSynthesis.getVoices();
            if (v && v.length) {
                resolve();
                return;
            }
            speechSynthesis.onvoiceschanged = () => resolve();
            setTimeout(resolve, 400);
        });
    }

    function cancelSpeech() {
        try {
            if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
        } catch {
            /* ignore */
        }
    }

    /**
     * @param {string} text
     * @param {{ interrupt?: boolean }} opts
     */
    async function speak(text, opts = {}) {
        const interrupt = opts.interrupt !== false;
        if (!text || typeof speechSynthesis === "undefined") return;
        if (interrupt) cancelSpeech();
        await ensureVoicesLoaded();
        const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
        u.lang = selectedLang;
        u.rate = 0.9;
        u.pitch = 1;
        const v = pickCalmVoice(selectedLang);
        if (v) u.voice = v;
        u.onerror = () => onStatus?.("tts_error");
        speechSynthesis.speak(u);
    }

    function stopListening() {
        if (!recognition) return;
        try {
            recognition.stop();
        } catch {
            /* ignore */
        }
        listening = false;
    }

    /**
     * One-shot listen; call `cancelSpeech()` first so user can interrupt copilot.
     * @param {(transcript: string) => void} onFinal
     */
    function startListen(onFinal) {
        const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
        if (!SR) {
            onStatus?.("stt_unavailable");
            return;
        }
        cancelSpeech();
        stopListening();
        recognition = new SR();
        recognition.lang = selectedLang;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;
        listening = true;
        onStatus?.("listening");

        recognition.onresult = (ev) => {
            const t = ev.results?.[0]?.[0]?.transcript?.trim() || "";
            if (t) onFinal(t);
        };
        recognition.onerror = () => {
            listening = false;
            onStatus?.("stt_error");
        };
        recognition.onend = () => {
            listening = false;
            onStatus?.("idle");
        };
        try {
            recognition.start();
        } catch {
            listening = false;
            onStatus?.("stt_error");
        }
    }

    return {
        setLang,
        speak,
        cancelSpeech,
        startListen,
        stopListening,
        isListening() {
            return listening;
        },
    };
}
