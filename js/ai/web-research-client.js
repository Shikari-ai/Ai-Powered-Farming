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

const WEB_STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "is",
    "are",
    "was",
    "were",
    "be",
    "what",
    "who",
    "does",
    "do",
    "me",
    "my",
    "about",
    "only",
    "india",
    "agriculture",
]);

/**
 * Keep only topically relevant public results.
 * @param {string} query
 * @param {string} title
 * @param {string} summary
 */
function looksRelevantToQuery(query, title, summary) {
    const q = String(query || "").toLowerCase();
    const t = `${String(title || "").toLowerCase()} ${String(summary || "").toLowerCase()}`;
    const tokens = q.match(/[a-z0-9]{3,}/g) || [];
    const sig = tokens.filter((x) => !WEB_STOPWORDS.has(x));
    if (!sig.length) return true;

    // Preserve acronym intent (ICAR, MSP, etc.).
    const acronyms = (String(query || "").match(/\b[A-Z]{2,}\b/g) || []).map((x) => x.toLowerCase());
    const acronymAliases = {
        msp: ["msp", "minimum support price"],
        icar: ["icar", "indian council of agricultural research"],
        imd: ["imd", "india meteorological department", "indian meteorological department"],
    };
    if (acronyms.length) {
        const ok = acronyms.some((a) => {
            const aliases = acronymAliases[a] || [a];
            return aliases.some((alias) => t.includes(alias));
        });
        if (!ok) return false;
    }

    let hits = 0;
    for (const tok of sig) {
        if (t.includes(tok)) hits += 1;
    }
    return hits >= Math.min(2, sig.length);
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

    let wiki = await wikipediaSearchThenExtract(q, signal, maxSummaryChars);
    if (wiki?.summary) return wiki;

    /** `list=search` can miss very noisy sentences — retry with a shorter tail. */
    const tail = q.replace(/^\s*agriculture\s+/i, "").trim().slice(0, 120);
    if (tail && tail !== q) {
        wiki = await wikipediaSearchThenExtract(tail, signal, maxSummaryChars);
    }
    if (wiki?.summary) return wiki;

    /** Last resort: anchor on ICAR / council wording when the user mentioned it. */
    if (/\bicar\b/i.test(q)) {
        wiki = await wikipediaSearchThenExtract("Indian Council of Agricultural Research", signal, maxSummaryChars);
    }
    if (!wiki?.summary && /\bmsp\b/i.test(q)) {
        wiki = await wikipediaSearchThenExtract("Minimum Support Price India", signal, maxSummaryChars);
    }
    return wiki;
}

/**
 * @param {{ source: string, title: string, url: string, summary: string }} brief
 * @param {{ reasons?: string[], seamless?: boolean }} [meta]
 */
export function formatWebResearchAppend(brief, meta = {}) {
    const seamless = meta.seamless !== false;
    const body = trimToWords(brief.summary, seamless ? 640 : 720);
    if (seamless) {
        const intro = pickRotated("web_research_seamless", [
            "Here’s a compact public-reference angle that sits alongside your farm data — not a verdict on your field:",
            "I pulled a short, well-traveled overview so we’re not guessing in a vacuum — still treat it as orientation:",
            "A quick neutral summary from open references rounds this out; your local advisory chain still wins on specifics:",
        ]);
        const tail =
            "If this touches rules, prices, or safety, cross-check an official notice or agronomist — I’m not sourcing live government portals here.";
        return `${intro}\n\n${body}\n\n**${brief.title}** · ${brief.url}\n\n${tail}`;
    }
    const intro = pickRotated("web_research_intro", [
        "I don’t have enough on-device confidence for that narrow point, so I checked a short public reference and here’s the gist:",
        "Internal signals here are thin for that specific ask, so I pulled a quick public summary to orient you:",
        "That detail depends on wider knowledge than I can infer locally, so I looked up a brief public overview:",
    ]);
    const tail =
        "Treat this as general background, not a field diagnosis or legal advice — verify with your local extension office, official circulars, or a qualified agronomist.";
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
        const out = {
            source: "DuckDuckGo instant answer",
            title,
            url: href,
            summary: text,
        };
        return looksRelevantToQuery(q, out.title, out.summary) ? out : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} q
 * @param {AbortSignal|undefined} signal
 * @param {number} maxSummaryChars
 */
/**
 * Full-text search then first-page intro extract (more robust than opensearch for long questions).
 * @param {string} q
 * @param {AbortSignal|undefined} signal
 * @param {number} maxSummaryChars
 */
async function wikipediaSearchThenExtract(q, signal, maxSummaryChars) {
    try {
        const searchUrl = `${W_API}?action=query&format=json&origin=*&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&srnamespace=0`;
        const sRes = await fetch(searchUrl, { signal, credentials: "omit", mode: "cors" });
        if (!sRes.ok) return null;
        /** @type {any} */
        const sj = await sRes.json();
        const hit = sj?.query?.search?.[0];
        const title = String(hit?.title || "").trim();
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
        const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title || title)).replace(/%20/g, "_")}`;
        const out = {
            source: "Wikipedia (intro extract)",
            title: String(page.title || title),
            url,
            summary: trimToWords(extract, maxSummaryChars),
        };
        return looksRelevantToQuery(q, out.title, out.summary) ? out : null;
    } catch {
        return null;
    }
}
