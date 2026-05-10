/** Month bucket for seasonal labeling (privacy-safe, local clock). */
export function monthKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
