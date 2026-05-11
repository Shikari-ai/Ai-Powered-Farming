// App Logic
console.log("AgriTech AI Core Initialized");

// Legacy auth functions removed. Refer to js/auth.js and page modules (e.g. fields.js) for Firebase usage.



// --- 2. CLOUD DATA LOADING ---
function loadSavedScans() {
    const scansList = document.getElementById('saved-scans-list');
    if(!scansList) return;
    
    const scans = JSON.parse(localStorage.getItem('agri_scans') || '[]');
    
    if (scans.length === 0) {
        scansList.innerHTML = '<p class="text-muted" style="font-size:13px; text-align:center; padding: 10px;">No data saved yet. Scan a crop to start building your farm history!</p>';
        return;
    }
    
    scansList.innerHTML = '';
    // Show newest first
    scans.slice().reverse().forEach(scan => {
        const date = new Date(scan.date).toLocaleDateString();
        scansList.innerHTML += `
            <div class="saved-item glass-panel" style="display:flex; align-items:center; gap: 12px; padding: 12px; margin-bottom: 10px;">
                <div style="background: rgba(59, 130, 246, 0.2); width:40px; height:40px; border-radius:8px; display:flex; align-items:center; justify-content:center; color: var(--accent-blue);">
                    <i class="ri-history-line" style="font-size: 20px;"></i>
                </div>
                <div class="scan-details" style="flex:1;">
                    <h4 style="font-size:14px; margin-bottom:2px;">${scan.disease}</h4>
                    <p style="font-size:12px; color:var(--text-muted);">${date} • Health: <span style="color:var(--accent-orange)">${scan.health}%</span></p>
                </div>
            </div>
        `;
    });
}

// --- 3. SCANNER & AI LOGIC ---
let _scannerCameraHandle = null;

async function initCamera() {
    const videoElement = document.getElementById('videoElement');
    if (!videoElement) return;

    try {
        const { attachPremiumCamera } = await import('./camera-engine.js?v=1');
        if (_scannerCameraHandle && typeof _scannerCameraHandle.stop === 'function') {
            _scannerCameraHandle.stop();
            _scannerCameraHandle = null;
        }
        _scannerCameraHandle = await attachPremiumCamera(videoElement, {
            feedRoot: document.getElementById('camera-feed') || videoElement.parentElement,
        });
        window.__agriCamera = _scannerCameraHandle;
    } catch (err) {
        console.warn("Camera access denied or unavailable, using fallback image.", err);
        window.__agriCamera = null;
        videoElement.style.display = 'none';
    }
}

// NOTE: Production rule — no simulated scan/AI results.
// Scanner behavior is implemented in `js/scanner-db.js` and only reflects real user inputs + saved data.

// --- 4. GEOLOCATION & WEATHER ---
async function refreshLocationAndWeather() {
    const locElement = document.querySelector('.location');
    if (locElement) {
        locElement.innerHTML = `<i class="ri-loader-4-line spin" style="display:inline-block"></i> Syncing…`;
    }

    try {
        const mod = await import('./weather-location.js');
        const loc = await mod.resolveWeatherLocation();
        mod.persistLocationDetails(loc);

        if (locElement) {
            if (loc.source === 'insecure-context') {
                locElement.innerHTML = `<i class="ri-map-pin-line" style="color:var(--accent-orange)"></i> Need HTTPS for GPS`;
                const aiAlert = document.querySelector('.ai-alert');
                if (aiAlert) {
                    aiAlert.innerHTML = `<i class="ri-error-warning-line"></i> AI: This page must be served over <strong>HTTPS</strong> for location (e.g. Firebase Hosting at <code>*.web.app</code>). Plain <code>http://</code> blocks GPS in the browser.`;
                    aiAlert.style.display = 'block';
                    aiAlert.style.color = "var(--accent-orange)";
                }
            } else if (loc.source === 'fallback') {
                locElement.innerHTML = `<i class="ri-map-pin-line" style="color:var(--accent-orange)"></i> ${loc.city} (approx.)`;
                const aiAlert = document.querySelector('.ai-alert');
                if (aiAlert) {
                    aiAlert.innerHTML = `<i class="ri-error-warning-line"></i> AI: Allow location for this site in your browser, then open the app again.`;
                    aiAlert.style.display = 'block';
                    aiAlert.style.color = "var(--accent-orange)";
                }
            } else {
                const aiAlert = document.querySelector('.ai-alert');
                if (aiAlert) aiAlert.style.display = 'none';
                locElement.innerHTML = `<i class="ri-map-pin-fill" style="color:var(--accent-green)"></i> ${loc.city}`;
            }
        }

        try {
            const { auth, db } = await import('./auth.js?v=32');
            const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
            if (auth.currentUser) {
                await setDoc(doc(db, "users", auth.currentUser.uid), {
                    village: loc.city,
                    locationDetails: {
                        city: loc.city,
                        district: loc.district || '',
                        state: loc.state || '',
                        country: loc.country || '',
                        lat: loc.lat,
                        lon: loc.lon,
                        accuracyM: loc.accuracyM ?? null,
                        source: loc.source,
                    },
                    updatedAt: serverTimestamp(),
                }, { merge: true });
            }
        } catch (firebaseErr) {
            console.error("Could not sync location to Firestore", firebaseErr);
        }

        updateWeatherForLocation(loc.city, loc.lat, loc.lon);
    } catch (e) {
        console.error(e);
        if (locElement) locElement.innerHTML = `<i class="ri-map-pin-line"></i> Location error`;
    }
}

window.refreshLocationAndWeather = refreshLocationAndWeather;

let _weatherFetched = false;
function checkLocationPrompt() {
    if (_weatherFetched) return;
    _weatherFetched = true;
    refreshLocationAndWeather();
}

function closeLocationModal() {
    document.getElementById('location-modal').classList.add('hidden');
    localStorage.setItem('agri_location_asked_date', new Date().toDateString());
    localStorage.setItem('agri_location_granted', 'false');
}

function acceptLocationRequest() {
    document.getElementById('location-modal').classList.add('hidden');
    localStorage.setItem('agri_location_asked_date', new Date().toDateString());
    localStorage.setItem('agri_location_granted', 'true');
    
    // Triggers the actual browser OS location permission popup
    requestLocation();
}

function saveLocationDetails(details) {
    try {
        localStorage.setItem("agri_location_details", JSON.stringify(details));
    } catch {}
}

async function requestLocation() {
    await refreshLocationAndWeather();
}

function getWeatherDescription(code) {
    if (code === 0) return "Clear Sky";
    if (code === 1 || code === 2 || code === 3) return "Mainly Clear / Partly Cloudy";
    if (code === 45 || code === 48) return "Foggy Conditions";
    if (code >= 51 && code <= 55) return "Light Drizzle";
    if (code >= 61 && code <= 65) return "Rain Showers";
    if (code >= 71 && code <= 77) return "Snow Fall";
    if (code >= 80 && code <= 82) return "Heavy Rain Showers";
    if (code >= 95) return "Thunderstorm Alert";
    return "Variable Weather";
}

/** Home weather card: solar time phase for sky / sun / moon (uses API local dates). */
function computeWcardTimePhase(nowMs, sunriseIso, sunsetIso) {
    if (!sunriseIso || !sunsetIso) return "midday";
    const sr = new Date(sunriseIso).getTime();
    const ss = new Date(sunsetIso).getTime();
    if (!(sr < ss) || !Number.isFinite(sr) || !Number.isFinite(ss)) return "midday";
    const m = 60 * 1000;
    const dawnEnd = sr + 55 * m;
    const eveningStart = ss - 85 * m;
    const duskEnd = ss + 42 * m;
    if (nowMs < sr - 30 * m) return "night";
    if (nowMs < dawnEnd) return "dawn";
    if (nowMs < eveningStart) {
        const noonPoint = sr + (ss - sr) * 0.42;
        return nowMs < noonPoint ? "morning" : "afternoon";
    }
    if (nowMs < ss) return "evening";
    if (nowMs < duskEnd) return "dusk";
    return "night";
}

function wcardPhaseLabel(phase) {
    const map = {
        night: "Night",
        dawn: "Dawn",
        morning: "Morning",
        afternoon: "Afternoon",
        evening: "Evening",
        dusk: "Dusk",
        midday: "Midday",
    };
    return map[phase] || "Now";
}

/** Sun position as % left / % top within the card (arc across the sky). */
function wcardSunPosition(nowMs, srMs, ssMs) {
    if (nowMs < srMs - 20 * 60 * 1000 || nowMs > ssMs + 15 * 60 * 1000) {
        return { left: 14, top: 88, show: false };
    }
    const t = Math.max(0, Math.min(1, (nowMs - srMs) / (ssMs - srMs)));
    const left = 6 + t * 78;
    const top = 78 - Math.sin(t * Math.PI) * 52;
    return { left, top: Math.max(14, top), show: true };
}

function applyWcardTimeOfDay(wCard, phase, nowMs, sunriseIso, sunsetIso, isDayApi) {
    if (!wCard) return;
    const phases = ["wc-td-night", "wc-td-dawn", "wc-td-morning", "wc-td-afternoon", "wc-td-evening", "wc-td-dusk", "wc-td-midday"];
    phases.forEach((c) => wCard.classList.remove(c));
    let p = phase;
    if (isDayApi === 0 && ["dawn", "morning", "afternoon", "midday"].includes(p)) p = "night";
    if (isDayApi === 1 && p === "night" && sunriseIso && sunsetIso) {
        const sr = new Date(sunriseIso).getTime();
        const ss = new Date(sunsetIso).getTime();
        if (nowMs > sr && nowMs < ss) p = "afternoon";
    }
    wCard.classList.add(`wc-td-${p}`);

    const srMs = sunriseIso ? new Date(sunriseIso).getTime() : 0;
    const ssMs = sunsetIso ? new Date(sunsetIso).getTime() : 0;
    const sun = srMs && ssMs ? wcardSunPosition(nowMs, srMs, ssMs) : { left: 50, top: 30, show: false };

    const sunWrap = document.getElementById("wc-day-celestial");
    const moonWrap = document.getElementById("wc-moon-celestial");
    if (sunWrap) {
        sunWrap.style.setProperty("--wc-sun-left", `${sun.left}%`);
        sunWrap.style.setProperty("--wc-sun-top", `${sun.top}%`);
        if (p === "dusk") sunWrap.style.opacity = "0.32";
        else sunWrap.style.opacity = sun.show && p !== "night" ? "1" : "0";
    }
    let moonOp = 0;
    let ml = 74;
    let mt = 16;
    if (p === "night") {
        moonOp = 1;
        ml = 76;
        mt = 14;
    } else if (p === "dusk") {
        moonOp = 0.9;
        ml = 82;
        mt = 20;
    } else if (p === "evening") {
        moonOp = 0.5;
        ml = 90;
        mt = 22;
    } else if (p === "dawn") {
        moonOp = 0.28;
        ml = 68;
        mt = 18;
    }
    if (moonWrap) {
        moonWrap.style.setProperty("--wc-moon-left", `${ml}%`);
        moonWrap.style.setProperty("--wc-moon-top", `${mt}%`);
        moonWrap.style.opacity = String(moonOp);
    }

    const pill = document.getElementById("wcard-phase-pill");
    if (pill) {
        pill.textContent = wcardPhaseLabel(p);
        pill.hidden = false;
    }

    const nightSky = document.getElementById("wc-night-sky");
    if (nightSky) {
        if (p === "night") nightSky.style.opacity = "1";
        else if (p === "dusk") nightSky.style.opacity = "0.55";
        else if (p === "evening") nightSky.style.opacity = "0.25";
        else if (p === "dawn") nightSky.style.opacity = "0.12";
        else nightSky.style.opacity = "0";
    }
}

let currentWeatherCache = null;
/** Invalidates in-flight IP/GPS home weather when the user pins or reloads. */
let homeWeatherLoadGen = 0;

async function updateWeatherForLocation(city, lat, lon) {
    const weatherHeader = document.querySelector('.weather-header h3');
    const aiAlert = document.querySelector('.ai-alert');
    const remarkElement = document.querySelector('.weather-remark');
    
    if (weatherHeader) weatherHeader.innerHTML = `Weather Intelligence <i class="ri-arrow-right-s-line" style="font-size: 14px; color: var(--text-muted); margin-left: 4px;"></i>`;
    
    try {
        // Fetching real Meteorological Data (Current + Hourly + Daily) with Advanced Params
        const weatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,surface_pressure,visibility,is_day&hourly=temperature_2m,precipitation_probability,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max&timezone=auto`);
        if (!weatherResponse.ok) {
            throw new Error(`Weather API HTTP ${weatherResponse.status}`);
        }
        const weatherData = await weatherResponse.json();
        if (!weatherData || weatherData.error || !weatherData.current) {
            throw new Error(weatherData?.reason || "Weather API returned no current conditions");
        }

        currentWeatherCache = { city, data: weatherData };
        const current = weatherData.current;
        const desc = getWeatherDescription(current.weather_code);
        
        // Support both legacy IDs and new premium dashboard IDs
        const wTemp = document.getElementById('wcard-temp') || document.getElementById('w-temp');
        const wHum = document.getElementById('wcard-hum') || document.getElementById('w-hum');
        const wWind = document.getElementById('wcard-wind') || document.getElementById('w-wind');
        const wDesc = document.getElementById('wcard-cond') || document.getElementById('w-desc');
        const wRain = document.getElementById('wcard-rain') || document.getElementById('w-rain');
        const wSunrise = document.getElementById('wcard-sunrise') || document.getElementById('w-sunrise');

        if (wTemp) wTemp.textContent = `${Math.round(current.temperature_2m)}°C`;
        if (wHum) wHum.textContent = `${Math.round(current.relative_humidity_2m)}%`;
        if (wWind) wWind.textContent = `${Math.round(current.wind_speed_10m)} km/h`;
        if (wDesc) wDesc.textContent = desc;

        // Update weather emoji icon and card background class
        const wIcon = document.getElementById('wcard-wi');
        const wCard = document.getElementById('wcard');
        const code = current.weather_code || 0;
        const nowDate = current.time ? new Date(current.time) : new Date();
        const nowMs = nowDate.getTime();
        const sr0 = weatherData.daily?.sunrise?.[0];
        const ss0 = weatherData.daily?.sunset?.[0];
        let phase = computeWcardTimePhase(nowMs, sr0, ss0);
        let isDayApi = 1;
        if (current.is_day === 0 || current.is_day === 1) isDayApi = current.is_day;
        else isDayApi = (weatherData.hourly?.is_day?.[0] ?? 1) === 1 ? 1 : 0;

        let emoji = "🌤️";
        let wxClass = "wc-sunny";
        if (code === 0) {
            emoji = "☀️";
            wxClass = "wc-sunny";
        } else if (code <= 3) {
            emoji = "🌤️";
            wxClass = "wc-cloudy";
        } else if (code <= 48) {
            emoji = "🌫️";
            wxClass = "wc-fog";
        } else if (code <= 67) {
            emoji = "🌧️";
            wxClass = "wc-rainy";
        } else if (code <= 77) {
            emoji = "❄️";
            wxClass = "wc-snow";
        } else if (code <= 82) {
            emoji = "⛈️";
            wxClass = "wc-rainy";
        } else {
            emoji = "⛈️";
            wxClass = "wc-rainy";
        }

        const nastyWx = wxClass === "wc-rainy" || wxClass === "wc-snow" || wxClass === "wc-fog";
        if (!nastyWx && phase === "night") wxClass = "wc-night";

        if (phase === "night" || phase === "dusk") {
            if (code <= 3) emoji = "🌙";
        } else if (phase === "evening") {
            if (code <= 3) emoji = "🌆";
        } else if (phase === "dawn") {
            if (code <= 3) emoji = "🌅";
        }

        if (wIcon) wIcon.textContent = emoji;
        if (wCard) {
            wCard.classList.remove("wc-sunny", "wc-cloudy", "wc-rainy", "wc-night", "wc-fog", "wc-snow");
            wCard.classList.add(wxClass);
            applyWcardTimeOfDay(wCard, phase, nowMs, sr0, ss0, isDayApi);
        }

        // Rain probability: closest hourly slot (icon is in parent HTML — set text only)
        try {
            const hourly = weatherData.hourly;
            if (hourly && hourly.time && hourly.precipitation_probability && wRain) {
                const nowIso = current.time || getLocalISOString(new Date());
                let idx = hourly.time.indexOf(nowIso);
                if (idx < 0) {
                    idx = hourly.time.findIndex(t => t >= nowIso);
                    if (idx < 0) idx = 0;
                }
                const prob = hourly.precipitation_probability[idx];
                if (typeof prob === "number") {
                    // wcard-rain is a <b> inside a span that already has the rain icon
                    wRain.textContent = `${Math.round(prob)}%`;
                }
            }
        } catch {}

        // Sunrise (daily[0]) — wcard-sunrise already has icon in HTML, update last text node
        try {
            if (weatherData.daily?.sunrise?.[0] && wSunrise) {
                const sr = new Date(weatherData.daily.sunrise[0]);
                const timeStr = sr.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                const moonish = phase === "night" || phase === "dusk";
                const riIcon = moonish ? "ri-moon-clear-line" : "ri-sun-fill";
                wSunrise.innerHTML = `<i class="${riIcon}"></i> Sunrise ${timeStr}`;
            }
        } catch {}

        // Persist a lightweight weather log for realtime analytics (rate-limited to hourly doc id).
        try {
            const { auth, db } = await import('./auth.js?v=32');
            const { doc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
            const u = auth.currentUser;
            if (u) {
                const hourKey = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
                const logId = `${u.uid}_${hourKey}`;
                const hourly = weatherData.hourly || {};
                const daily = weatherData.daily || {};
                const r3 = (hourly.precipitation_probability || []).slice(0, 3).reduce((a, b) => a + (b || 0), 0) / 3;
                const soilEst = Math.max(0, Math.min(100, Math.round(
                    current.relative_humidity_2m * 0.45 + r3 * 0.4 + (24 - Math.min(24, current.temperature_2m)) * 1.1 - current.wind_speed_10m * 0.6,
                )));
                await setDoc(doc(db, "weather_logs", logId), {
                    userId: u.uid,
                    city,
                    geo: { lat, lon },
                    fetchedAt: serverTimestamp(),
                    current: weatherData.current || null,
                    derived: { soilMoistureEstimate: soilEst },
                    today: {
                        sunrise: daily.sunrise ? daily.sunrise[0] : null,
                        sunset: daily.sunset ? daily.sunset[0] : null,
                        tMax: daily.temperature_2m_max ? daily.temperature_2m_max[0] : null,
                        tMin: daily.temperature_2m_min ? daily.temperature_2m_min[0] : null,
                        uvMax: daily.uv_index_max ? daily.uv_index_max[0] : null,
                    },
                    nextHours: (() => {
                        if (!hourly.time || !hourly.precipitation_probability) return [];
                        const nowIso = (weatherData.current && weatherData.current.time) ? weatherData.current.time : getLocalISOString(new Date());
                        let start = hourly.time.findIndex(t => t >= nowIso);
                        if (start < 0) start = 0;
                        return hourly.time.slice(start, start + 6).map((t, i) => ({
                            time: t,
                            precipProb: hourly.precipitation_probability[start + i],
                            temp: hourly.temperature_2m ? hourly.temperature_2m[start + i] : null,
                            code: hourly.weather_code ? hourly.weather_code[start + i] : null,
                        }));
                    })(),
                    schemaVersion: 1,
                }, { merge: true });

                try {
                    const { syncWeatherDerivedAlerts } = await import("./services/entity-sync.js");
                    const nh = (() => {
                        if (!hourly.time || !hourly.precipitation_probability) return [];
                        const nowIso = (weatherData.current && weatherData.current.time)
                            ? weatherData.current.time
                            : getLocalISOString(new Date());
                        let start = hourly.time.findIndex((t) => t >= nowIso);
                        if (start < 0) start = 0;
                        return hourly.time.slice(start, start + 8).map((_, i) => ({
                            precipProb: hourly.precipitation_probability[start + i],
                        }));
                    })();
                    await syncWeatherDerivedAlerts(db, u.uid, {
                        current: weatherData.current || {},
                        today: {
                            tMax: daily.temperature_2m_max ? daily.temperature_2m_max[0] : null,
                            imdForecast: null,
                        },
                        nextHours: nh,
                    });
                } catch (wxA) {
                    console.warn("Weather-derived alerts skipped:", wxA?.code || wxA);
                }
            }
        } catch (e) {
            // Non-fatal: UI still uses live API response
            console.warn("Weather log sync skipped:", e?.code || e);
        }
        
        // Show human readable remark
        if (remarkElement) {
            remarkElement.innerHTML = `<i class="ri-cloud-windy-line"></i> Currently: ${desc}`;
            remarkElement.style.display = 'block';
        }
        
        // AI Logic based on REAL data
        if (aiAlert) {
            if (current.relative_humidity_2m > 70) {
                aiAlert.innerHTML = `<i class="ri-error-warning-line"></i> AI: High humidity (${Math.round(current.relative_humidity_2m)}%). Fungal risk increased.`;
                aiAlert.style.color = "var(--accent-orange)";
                aiAlert.style.borderColor = "rgba(245, 158, 11, 0.3)";
                aiAlert.style.background = "rgba(245, 158, 11, 0.1)";
            } else {
                aiAlert.innerHTML = `<i class="ri-sparkling-line"></i> AI: Optimal conditions. Real-time meteorological sync active.`;
                aiAlert.style.color = "var(--accent-green)";
                aiAlert.style.borderColor = "rgba(16, 185, 129, 0.3)";
                aiAlert.style.background = "rgba(16, 185, 129, 0.1)";
            }
        }
    } catch (e) {
        console.error("Weather fetch failed", e);
    }
    
    // Add a slight pulse animation to the widget to show it updated
    const widget = document.querySelector('.weather-widget');
    if(widget) {
        widget.style.transition = "transform 0.3s";
        widget.style.transform = 'scale(1.03)';
        setTimeout(() => widget.style.transform = 'scale(1)', 300);
    }
}

// --- SAMSUNG WEATHER UI LOGIC ---
function getIconForCode(code, isDay = 1) {
    if (code === 0) return isDay ? "ri-sun-fill" : "ri-moon-clear-fill";
    if (code >= 1 && code <= 3) return isDay ? "ri-sun-cloudy-fill" : "ri-moon-cloudy-fill";
    if (code >= 45 && code <= 48) return "ri-mist-fill";
    if (code >= 51 && code <= 65) return "ri-showers-fill";
    if (code >= 71 && code <= 77) return "ri-snowy-fill";
    if (code >= 80 && code <= 82) return "ri-heavy-showers-fill";
    if (code >= 95) return "ri-thunderstorms-fill";
    return "ri-cloud-fill";
}

function getLocalISOString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:00`;
}

function openWeatherDetails() {
    if (!currentWeatherCache) {
        // Production rule: never fabricate weather. Show a clean empty state instead.
        const modal = document.getElementById('weather-details-modal');
        const cityEl = document.getElementById('weather-full-city');
        const tempEl = document.getElementById('weather-full-temp');
        const descEl = document.getElementById('weather-full-desc');
        const feelsEl = document.getElementById('weather-full-feels');
        const hlEl = document.getElementById('weather-full-hl');
        const adviceEl = document.getElementById('weather-full-advice');

        if (cityEl) cityEl.textContent = "Weather not connected";
        if (tempEl) tempEl.textContent = "--";
        if (descEl) descEl.textContent = "Enable location to sync weather intelligence";
        if (feelsEl) feelsEl.textContent = "";
        if (hlEl) hlEl.textContent = "";
        if (adviceEl) adviceEl.textContent = "Once GPS is enabled, we’ll build weather logs and adaptive recommendations from real conditions.";
        if (modal) modal.classList.remove('hidden');
        return;
    }
    const {city, data} = currentWeatherCache;
    const current = data.current;
    const daily = data.daily;
    const hourly = data.hourly;
    
    document.getElementById('weather-full-city').textContent = city;
    document.getElementById('weather-full-temp').textContent = `${Math.round(current.temperature_2m)}°`;
    document.getElementById('weather-full-desc').textContent = getWeatherDescription(current.weather_code);
    
    // Feels Like
    if (current.apparent_temperature !== undefined) {
        document.getElementById('weather-full-feels').textContent = `Feels like ${Math.round(current.apparent_temperature)}°`;
    }
    
    // High/Low
    if(daily && daily.temperature_2m_max) {
        document.getElementById('weather-full-hl').textContent = `H:${Math.round(daily.temperature_2m_max[0])}°  L:${Math.round(daily.temperature_2m_min[0])}°`;
    }
    
    // Sunrise/Sunset Animation
    if (daily && daily.sunrise && daily.sunset) {
        const srDate = new Date(daily.sunrise[0]);
        const ssDate = new Date(daily.sunset[0]);
        const srEl = document.getElementById('weather-full-sunrise');
        const ssEl = document.getElementById('weather-full-sunset');
        
        if(srEl) srEl.textContent = srDate.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
        if(ssEl) ssEl.textContent = ssDate.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
        
        const nowMs = Date.now();
        const srMs = srDate.getTime();
        const ssMs = ssDate.getTime();
        
        let progress = 0;
        if (nowMs < srMs) progress = 0;
        else if (nowMs > ssMs) progress = 1;
        else progress = (nowMs - srMs) / (ssMs - srMs);
        
        setTimeout(() => {
            const sunIcon = document.getElementById('sun-tracker-icon');
            const sunPath = document.getElementById('sun-path-fill');
            
            if (sunPath) {
                const len = 235; // Approx length of Q curve
                sunPath.setAttribute('stroke-dasharray', `${len * progress} 300`);
            }
            if (sunIcon) {
                const t = progress;
                const inv = 1 - t;
                const x = (2 * inv * t * 100) + (t * t * 200);
                const y = (inv * inv * 70) + (2 * inv * t * -20) + (t * t * 70);
                
                sunIcon.style.left = `${(x / 200) * 100}%`;
                sunIcon.style.top = `${(y / 80) * 100}%`;
            }
        }, 100);
        
        // Dynamic Moonrise / Moonset (approximated for demo)
        const moonriseDate = new Date(srMs + 1000 * 60 * 60 * 13.5); // roughly 13.5 hours after sunrise
        const moonsetDate = new Date(ssMs + 1000 * 60 * 60 * 14.2);
        const mrEl = document.getElementById('weather-full-moonrise');
        const msEl = document.getElementById('weather-full-moonset');
        if(mrEl) mrEl.textContent = moonriseDate.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
        if(msEl) msEl.textContent = moonsetDate.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
    }
    
    const uv = daily.uv_index_max ? Math.round(daily.uv_index_max[0]) : 0;
    let uvWord = "Low"; let uvDesc = "Low right now";
    if(uv >= 3) { uvWord = "Moderate"; uvDesc = "Moderate right now"; }
    if(uv >= 6) { uvWord = "High"; uvDesc = "High right now"; }
    if(uv >= 8) { uvWord = "Very High"; uvDesc = "Extreme right now"; }
    
    document.getElementById('weather-full-uv-word').textContent = uvWord;
    document.getElementById('weather-full-uv-desc').textContent = uvDesc;
    setTimeout(() => { 
        let uvPercent = (uv / 11) * 100;
        if(uvPercent > 100) uvPercent = 100;
        const uvDot = document.getElementById('uv-dot');
        uvDot.style.left = `${uvPercent}%`; 
        uvDot.textContent = Math.round(uv);
    }, 100);

    // 2. Humidity
    const hum = Math.round(current.relative_humidity_2m);
    document.getElementById('weather-full-hum').textContent = `${hum}%`;
    let humDesc = "Comfortable";
    if (hum > 60) humDesc = "Noticeable humidity";
    if (hum > 80) humDesc = "Very humid";
    document.getElementById('weather-full-hum-desc').textContent = humDesc;
    setTimeout(() => { document.getElementById('hum-fill-bar').style.width = `${hum}%`; }, 100);
    
    // 3. Wind
    const windSpeed = Math.round(current.wind_speed_10m);
    document.getElementById('weather-full-wind').textContent = windSpeed;
    let windDesc = "Light breeze";
    if (windSpeed > 15) windDesc = "Moderate breeze";
    if (windSpeed > 25) windDesc = "Strong winds";
    document.getElementById('weather-full-wind-desc').textContent = `There is a ${windDesc.toLowerCase()}`;
    
    if (current.wind_direction_10m !== undefined) {
        setTimeout(() => { document.getElementById('wind-arrow').style.transform = `rotate(${current.wind_direction_10m}deg)`; }, 100);
    }

    // 4. Dew point (Approximation if not in API)
    const dewPoint = Math.round(current.temperature_2m - ((100 - hum) / 5));
    document.getElementById('weather-full-dew').textContent = `${dewPoint}°`;
    document.getElementById('weather-full-dew-desc').textContent = humDesc; // Dew point and humidity correlate

    // 5. Pressure
    const pressure = (typeof current.surface_pressure === "number") ? current.surface_pressure : null;
    if (pressure === null) {
        document.getElementById('weather-full-pres').textContent = `--`;
        document.getElementById('weather-full-pres-desc').textContent = `Not available`;
    } else {
        document.getElementById('weather-full-pres').textContent = pressure.toFixed(1);
        let presDesc = "Steady";
        if (pressure < 1005) presDesc = "Currently falling";
        if (pressure > 1020) presDesc = "Currently rising";
        document.getElementById('weather-full-pres-desc').textContent = presDesc;
        // Calculate arc length for pressure (range 950 - 1050)
        setTimeout(() => {
            const presPercent = Math.max(0, Math.min(1, (pressure - 950) / 100));
            // arc radius 40. Circumference = pi * r = ~125.6
            const arcLen = presPercent * 125.6;
            const fillPath = document.getElementById('pressure-gauge-fill');
            if(fillPath) fillPath.setAttribute('stroke-dasharray', `${arcLen} 126`);
        }, 100);
    }
    
    // 6. Visibility
    const visKm = (typeof current.visibility === "number") ? (current.visibility / 1000) : null;
    if (visKm === null) {
        document.getElementById('weather-full-vis').textContent = `--`;
        document.getElementById('weather-full-vis-desc').textContent = `Not available`;
    } else {
        const vis = visKm.toFixed(2);
        document.getElementById('weather-full-vis').textContent = `${vis} km`;
        document.getElementById('weather-full-vis-desc').textContent = visKm > 8 ? "Good right now" : "Poor visibility";
    }
    
    // AI Farming Advice logic
    let advice = "Optimal weather for farming activities today. Proceed as planned.";
    if (current.weather_code >= 61 && current.weather_code <= 82) {
        advice = "Rain expected. Delay pesticide spraying to prevent runoff.";
    } else if (uv >= 8) {
        advice = "Extreme UV Index. Ensure field workers stay hydrated and avoid spraying between 12 PM - 3 PM.";
    } else if (current.wind_speed_10m > 20) {
        advice = "High wind speeds detected. Not ideal for drone spraying or fine seed sowing.";
    } else if (current.relative_humidity_2m > 80) {
        advice = "Very high humidity. Monitor closely for fungal spread in dense crop areas.";
    }
    document.getElementById('weather-full-advice').textContent = advice;
    
    // Hourly Forecast Array
    const hourlyList = document.getElementById('hourly-list');
    hourlyList.innerHTML = '';
    
    // Find closest hour
    const now = new Date();
    const nowHourStr = getLocalISOString(now);
    
    let startIndex = 0;
    for(let i=0; i<hourly.time.length; i++){
        if(hourly.time[i] >= nowHourStr) { startIndex = i; break; }
    }
    
    // Calculate Next Rain Expected
    let nextRainIndex = -1;
    for (let i = startIndex; i < hourly.time.length; i++) {
        if (hourly.precipitation_probability[i] > 40) {
            nextRainIndex = i;
            break;
        }
    }
    
    const rainTimeEl = document.getElementById('next-rain-time');
    const rainAmountEl = document.getElementById('next-rain-amount');
    const rainProbEl = document.getElementById('next-rain-prob');
    
    if (nextRainIndex !== -1 && rainTimeEl) {
        const rainTime = new Date(hourly.time[nextRainIndex]);
        const todayD = new Date();
        const tomorrowD = new Date(todayD);
        tomorrowD.setDate(tomorrowD.getDate() + 1);
        
        let dayStr = "";
        if (rainTime.getDate() === todayD.getDate() && rainTime.getMonth() === todayD.getMonth()) {
            dayStr = "Today";
        } else if (rainTime.getDate() === tomorrowD.getDate() && rainTime.getMonth() === tomorrowD.getMonth()) {
            dayStr = "Tomorrow";
        } else {
            dayStr = rainTime.toLocaleDateString([], {weekday: 'long'});
        }
        
        let timeStr = rainTime.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
        
        rainTimeEl.textContent = `${dayStr}, ${timeStr}`;
        rainAmountEl.textContent = `${hourly.precipitation_probability[nextRainIndex]}%`;
        rainProbEl.textContent = 'Chance';
    } else if (rainTimeEl) {
        rainTimeEl.textContent = 'No rain expected soon';
        rainAmountEl.textContent = `--`;
        rainProbEl.textContent = '';
    }
    
    const itemWidth = 64; // Fixed width
    const chartHeight = 40;
    
    let hourlyHtml = '';
    let points = [];
    
    // Calculate min/max for the next 24 hours
    const tempSlice = hourly.temperature_2m.slice(startIndex, startIndex + 24);
    let minTempHourly = Math.min(...tempSlice);
    let maxTempHourly = Math.max(...tempSlice);
    let tempRange = maxTempHourly - minTempHourly || 1;
    
    for (let i = 0; i < 24; i++) {
        const idx = startIndex + i;
        if (idx >= hourly.temperature_2m.length) break;
        
        const temp = Math.round(hourly.temperature_2m[idx]);
        const precip = hourly.precipitation_probability[idx];
        const hCode = hourly.weather_code[idx];
        const isDayH = hourly.is_day ? hourly.is_day[idx] : 1;
        
        let timeStr = new Date(hourly.time[idx]).toLocaleTimeString([], {hour: 'numeric', hour12: true});
        if (i === 0) timeStr = 'Now';
        
        // Dynamic icon color
        let iconColor = isDayH ? '#fbbf24' : '#cbd5e1';
        if (precip > 30) iconColor = '#60a5fa';
        
        const normalizedY = ((maxTempHourly - temp) / tempRange) * (chartHeight - 10) + 5; 
        const cx = (i * itemWidth) + (itemWidth / 2);
        const cy = normalizedY;
        points.push(`${cx},${cy}`);
        
        hourlyHtml += `
            <div style="width: ${itemWidth}px; display: flex; flex-direction: column; align-items: center; flex-shrink: 0;">
                <span style="color: rgba(255,255,255,0.8); font-size: 13px; font-weight:500;">${timeStr}</span>
                <i class="${getIconForCode(hCode, isDayH)}" style="font-size: 24px; color: ${iconColor}; margin: 12px 0;"></i>
                <span style="font-size: 18px; font-weight: 600; color: white;">${temp}°</span>
                
                <!-- Spacer for the line chart SVG to overlay -->
                <div style="height: ${chartHeight}px; width: 100%;"></div>
                
                <div style="display: flex; align-items: center; gap: 2px; color: rgba(255,255,255,0.6); font-size: 12px; margin-top: 4px;">
                    <i class="ri-drop-fill"></i> ${precip}%
                </div>
            </div>
        `;
    }
    
    const svgWidth = 24 * itemWidth;
    const svgHtml = `
        <svg style="position: absolute; top: 100px; left: 0; width: ${svgWidth}px; height: ${chartHeight}px; pointer-events: none; overflow: visible;">
            <polyline points="${points.join(' ')}" fill="none" stroke="#fde047" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            ${points.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="4" fill="#3b5973" stroke="#fde047" stroke-width="1.5"/>`).join('')}
        </svg>
    `;

    hourlyList.innerHTML = hourlyHtml + svgHtml;
    
    // Set Background Image
    const isDayNow = current.is_day === 1;
    let bgUrl = "url('https://images.unsplash.com/photo-1601297183314-00962450531e?q=80&w=600&auto=format&fit=crop')";
    if (!isDayNow) bgUrl = "url('https://images.unsplash.com/photo-1507400492013-162706c8c05e?q=80&w=600&auto=format&fit=crop')"; // Night sky
    else if (current.weather_code >= 51 && current.weather_code <= 67) bgUrl = "url('https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?q=80&w=600&auto=format&fit=crop')"; // Rain
    else if (current.weather_code >= 2 && current.weather_code <= 3) bgUrl = "url('https://images.unsplash.com/photo-1534088568595-a066f410cbda?q=80&w=600&auto=format&fit=crop')"; // Cloudy field
    
    const bgElement = document.getElementById('weather-bg-img');
    if(bgElement) bgElement.style.backgroundImage = bgUrl;
    
    document.getElementById('weather-details-modal').classList.remove('hidden');
}

function closeWeatherDetails() {
    document.getElementById('weather-details-modal').classList.add('hidden');
}

// Phase 1: await IP geo (fast, reliable). Phase 2: upgrade with GPS when available. Fallback grid if both fail.
async function loadHomeWeather() {
    try {
        const mod = await import('./weather-location.js');
        const { peekActiveWeatherLocation } = await import('./geo/active-location.js?v=1');
        const { FALLBACK_LOC } = mod;
        const pinned = peekActiveWeatherLocation();
        if (pinned) {
            homeWeatherLoadGen++;
            await updateWeatherForLocation(pinned.city, pinned.lat, pinned.lon);
            return;
        }

        const gen = ++homeWeatherLoadGen;
        let showed = false;
        try {
            const ipLoc = await mod.resolveLocationApprox();
            if (peekActiveWeatherLocation() || gen !== homeWeatherLoadGen) return;
            await updateWeatherForLocation(ipLoc.city, ipLoc.lat, ipLoc.lon);
            showed = true;
        } catch (e) {
            console.warn("Home IP geo failed:", e?.message || e);
        }

        mod.resolveWeatherLocation()
            .then(async (gpsLoc) => {
                if (peekActiveWeatherLocation() || gen !== homeWeatherLoadGen) return;
                if (gpsLoc && gpsLoc.source !== "fallback" && gpsLoc.source !== "insecure-context") {
                    mod.persistLocationDetails(gpsLoc);
                    await updateWeatherForLocation(gpsLoc.city, gpsLoc.lat, gpsLoc.lon);
                    import('./auth.js?v=32').then(({ auth, db }) => {
                        if (!auth.currentUser) return;
                        import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js').then(({ doc, setDoc, serverTimestamp }) => {
                            setDoc(doc(db, "users", auth.currentUser.uid), {
                                village: gpsLoc.city,
                                locationDetails: { city: gpsLoc.city, lat: gpsLoc.lat, lon: gpsLoc.lon, source: gpsLoc.source },
                                updatedAt: serverTimestamp(),
                            }, { merge: true }).catch(() => {});
                        });
                    });
                } else if (!showed) {
                    await updateWeatherForLocation(FALLBACK_LOC.city, FALLBACK_LOC.lat, FALLBACK_LOC.lon);
                }
            })
            .catch(async (e) => {
                console.warn("Home GPS location failed:", e?.message || e);
                if (peekActiveWeatherLocation() || gen !== homeWeatherLoadGen) return;
                if (!showed) {
                    await updateWeatherForLocation(FALLBACK_LOC.city, FALLBACK_LOC.lat, FALLBACK_LOC.lon);
                }
            });
    } catch (e) {
        console.warn("Home weather load failed:", e);
    }
}

// Init core features on load
document.addEventListener('DOMContentLoaded', () => {
    if(window.location.pathname.includes('scanner.html')) {
        initCamera();
    }

    // Support both new premium card id ("wcard") and legacy id ("weather-card")
    const weatherCard = document.getElementById("wcard") || document.getElementById("weather-card");
    if (weatherCard) {
        import('./geo/active-location.js?v=1').then((m) => m.startActiveLocationRemoteSync()).catch(() => {});
        // Start weather immediately — no modal, no auth wait
        loadHomeWeather();
    }
});
