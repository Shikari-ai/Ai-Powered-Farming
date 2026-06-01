/**
 * Classifies in-app signals for ambient delivery (not pushFCM — platform-agnostic).
 */

/**
 * @param {{
 *   notificationType?: string,
 *   healthScore?: number|null,
 *   severityLevel?: string,
 *   fieldId?: string|null,
 * }} ctx
 * @param {ReturnType<import("./attention-memory.js").getAmbientAttentionPrefs>} prefs
 */
export function classifyAmbientPriority(ctx, prefs) {
    const { notificationType, healthScore, severityLevel } = ctx;
    let tier = "reminder";
    let score = 45;
    let suppressInterruption = false;

    const crit = severityLevel === "critical";

    if (notificationType === "scan_saved") {
        if (crit || (typeof healthScore === "number" && healthScore < 40)) {
            tier = "elevated";
            score = 78;
        } else if (typeof healthScore === "number" && healthScore < 58) {
            tier = "reminder";
            score = 56;
        } else {
            tier = "passive";
            score = 22;
            suppressInterruption = true;
        }
    } else if (notificationType === "field_added") {
        tier = "reminder";
        score = 40;
    } else if (notificationType === "field_updated") {
        tier = "passive";
        score = 18;
        suppressInterruption = true;
    } else {
        tier = "reminder";
        score = 44;
    }

    const fm = prefs?.focusMode || "balanced";
    if (fm === "calm") {
        if (tier === "reminder") {
            tier = "passive";
            suppressInterruption = true;
            score = Math.min(score, 28);
        }
        if (tier === "elevated") score = Math.min(score, 68);
    } else if (fm === "active") {
        score = Math.min(100, score + 8);
    }

    const sens = prefs?.interruptionSensitivity || "standard";
    if (sens === "low") {
        if (tier !== "elevated") {
            suppressInterruption = true;
            tier = "passive";
        }
        score = Math.max(0, score - 14);
    } else if (sens === "high") {
        score = Math.min(100, score + 10);
        suppressInterruption = false;
    }

    if (crit && notificationType === "scan_saved") {
        tier = "elevated";
        score = Math.max(score, 80);
        suppressInterruption = false;
    }

    return { tier, score, suppressInterruption };
}
