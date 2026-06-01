/**
 * Subtle map “mood” — CSS variables + dataset flags (animations respect agriPerf).
 */

/**
 * @param {object|null} wx
 * @param {number|undefined|null} meanStress 0–1 fusion stress if available
 * @returns {{ mood: string, hue: number, pulse: number }}
 */
export function computeMapAmbientMood(wx, meanStress) {
    const rh =
        wx?.current?.relative_humidity_2m ??
        (Array.isArray(wx?.hourly?.relative_humidity_2m) ? wx.hourly.relative_humidity_2m[0] : null);

    let mood = "clear";
    let hue = 152;
    let pulse = 0.32;

    if (typeof meanStress === "number" && meanStress >= 0.72) {
        mood = "stress";
        hue = 32;
        pulse = 0.62;
    } else if (typeof meanStress === "number" && meanStress >= 0.58) {
        mood = "watch";
        hue = 88;
        pulse = 0.48;
    }

    if (typeof rh === "number" && rh >= 82 && mood === "clear") {
        mood = "humid";
        hue = 168;
        pulse = 0.44;
    }

    return { mood, hue, pulse };
}

export function applyMapAmbientMood(wx, meanStress) {
    const { mood, hue, pulse } = computeMapAmbientMood(wx, meanStress);
    const root = document.documentElement;
    root.style.setProperty("--agri-map-mood-hue", String(hue));
    root.style.setProperty("--agri-ambient-pulse", String(pulse));
    root.dataset.agriMapMood = mood;
}

export function getMapMoodDataset() {
    return document.documentElement.dataset.agriMapMood || "clear";
}
