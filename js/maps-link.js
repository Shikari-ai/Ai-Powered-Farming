/**
 * Opens the device maps app at lat/lon. On Android (including Samsung), uses a geo: URI so the
 * system picker can offer Samsung Maps, Google Maps, etc. Weather data cannot be passed to maps
 * apps from a browser — only coordinates and an optional label.
 */
export function openDeviceMaps(lat, lon, label = "Location") {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }
  const safeLabel = String(label || "Location").slice(0, 100);
  const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";

  if (/Android/i.test(ua)) {
    window.location.href = `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(safeLabel)})`;
    return true;
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const q = encodeURIComponent(safeLabel);
    window.location.href = `https://maps.apple.com/?ll=${lat},${lon}&q=${q}`;
    return true;
  }
  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`,
    "_blank",
    "noopener,noreferrer",
  );
  return true;
}
