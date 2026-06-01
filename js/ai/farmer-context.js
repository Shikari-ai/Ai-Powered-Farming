/**
 * Normalize realtime farmer state for AI engines (all data already scoped per authenticated user).
 */

export function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    return 0;
}

export function buildFarmerContext({
    userId,
    fields = [],
    scans = [],
    recs = [],
    weatherLogs = [],
    environmental = [],
}) {
    const sortedScans = scans.slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const sortedWeather = weatherLogs.slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt));

    const recentPestSignals = sortedScans.filter((s) => {
        const code = s.diagnosis?.code;
        return code === "pest_damage";
    });

    const recentFungalSignals = sortedScans.filter((s) => s.diagnosis?.code === "fungal_risk");

    return {
        userId,
        fields,
        scans: sortedScans,
        recs,
        weatherLogs: sortedWeather,
        environmental,
        latestScan: sortedScans[0] || null,
        latestWeatherLog: sortedWeather[0] || null,
        recentPestSignals,
        recentFungalSignals,
    };
}
