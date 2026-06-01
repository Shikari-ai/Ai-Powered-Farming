// Shared normalizer for field.boundary.coordinates.
//
// Historical shape (in-memory and pre-Firestore-save):
//   [[lat, lng], [lat, lng], ...]   — but Firestore forbids nested arrays
//   inside document fields, so persisting this form fails with
//   "Function WriteBatch.set() called with invalid data. Nested arrays
//   are not supported".
//
// New persisted shape:
//   [{ lat, lng }, { lat, lng }, ... ]
//
// Some older field docs may already exist in either shape (depending on
// how/when they were written). All readers go through this helper so
// they accept both and emit a consistent [[lat, lng], ...] form for
// downstream geometry code.

export function normalizeBoundaryCoords(coords) {
  if (!Array.isArray(coords)) return [];
  const out = [];
  for (const p of coords) {
    if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number") {
      out.push([p[0], p[1]]);
    } else if (p && typeof p === "object" && typeof p.lat === "number" && typeof p.lng === "number") {
      out.push([p.lat, p.lng]);
    }
  }
  return out;
}
