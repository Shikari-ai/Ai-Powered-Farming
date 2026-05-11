/**
 * Lightweight **public** lookups from the browser (no API keys).
 * Wikipedia (CORS-friendly with `origin=*`) + optional DuckDuckGo instant answer when reachable.
 * Framed as supplementary — never a substitute for extension pathologists or official advisories.
 */
import { pickRotated } from "./conversation-naturals.js?v=48";

const W_API = "https://en.wikipedia.org/w/api.php";

/** @param {string} s @param {number} max */
function trimToWords(s, max) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const i = cut.lastIndexOf(" ");
    return (i > max * 0.55 ? cut.slice(0, i) : cut).trim() + "…";
}

/**
 * @param {string} query
 * @param {{ signal?: AbortSignal, maxSummaryChars?: number }} [opts]
 * @returns {Promise<{ source: string, title: string, url: string, summary: string } | null>}
 */
export async function fetchPublicAgriBrief(query, opts = {}) {
    const { signal, maxSummaryChars = 620 } = opts;
    const q = String(query || "").trim().slice(0, 240);
    if (!q) return null;

    const ddg = await tryDuckDuckGoInstant(q, signal);
    if (ddg?.summary) return ddg;

    return wikipediaOpenSearchThenExtract(q, signal, maxSummaryChars);
}

/**
 * @param {{ source: string, title: string, url: string, summary: string }} brief
 * @param {{ reasons?: string[] }} [_meta]
 */
export function formatWebResearchAppend(brief, _meta = {}) {
    const intro = pickRotated("web_research_intro", [
        "I don’t have enough on-device confidence for that narrow point, so I checked a short public reference and here’s the gist:",
        "Internal signals here are thin for that specific ask, so I pulled a quick public summary to orient you:",
        "That detail depends on wider knowledge than I can infer locally, so I looked up a brief public overview:",
    ]);
    const tail =
        "Treat this as general background, not a field diagnosis or legal advice — verify with your local extension office, official circulars, or a qualified agronomist.";
    const body = trimToWords(brief.summary, 720);
    return `${intro}\n\n${body}\n\nSource (${brief.source}): **${brief.title}** — ${brief.url}\n\n${tail}`;
}

/**
 * @param {string} q
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ source: string, title: string, url: string, summary: string } | null>}
 */
async function tryDuckDuckGoInstant(q, signal) {
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url, { signal, credentials: "omit", mode: "cors" });
        if (!res.ok) return null;
        const j = await res.json();
        const text = String(j.AbstractText || "").trim();
        const href = String(j.AbstractURL || "").trim();
        if (!text || !href) return null;
        const title = String(j.Heading || q).trim() || q;
        return {
            source: "DuckDuckGo instant answer",
            title,
            url: href,
            summary: text,
        };
    } catch {
        return null;
    }
}

/**
 * @param {string} q
 * @param {AbortSignal|undefined} signal
 * @param {number} maxSummaryChars
 */
async function wikipediaOpenSearchThenExtract(q, signal, maxSummaryChars) {
    try {
        const osUrl = `${W_API}?action=opensearch&format=json&origin=*&search=${encodeURIComponent(q)}&limit=2&namespace=0`;
        const osRes = await fetch(osUrl, { signal, credentials: "omit", mode: "cors" });
        if (!osRes.ok) return null;
        /** @type {any} */
        const os = await osRes.json();
        const titles = Array.isArray(os[1]) ? os[1] : [];
        const urls = Array.isArray(os[3]) ? os[3] : [];
        const title = String(titles[0] || "").trim();
        if (!title) return null;

        const exUrl = `${W_API}?action=query&format=json&origin=*&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}`;
        const exRes = await fetch(exUrl, { signal, credentials: "omit", mode: "cors" });
        if (!exRes.ok) return null;
        /** @type {any} */
        const ex = await exRes.json();
        const pages = ex?.query?.pages || {};
        const page = Object.values(pages)[0];
        if (!page || page.missing) return null;
        const extract = String(page.extract || "").trim();
        if (!extract) return null;
        const url = String(urls[0] || "").trim() || `https://en.wikipedia.org/wiki/${encodeURIComponent(title).replace(/%20/g, "_")}`;
        return {
            source: "Wikipedia (intro extract)",
            title: String(page.title || title),
            url,
            summary: trimToWords(extract, maxSummaryChars),
        };
    } catch {
        return null;
    }
}
