// Zugangsschutz für die Funktionen: nur Geräte mit Freischaltung (Cookie aus der Code-Eingabe,
// siehe netlify/edge-functions/gate.js). Ohne gesetzte ACCESS_CODE bleibt alles offen wie bisher.
import { createHmac, timingSafeEqual } from "node:crypto";

export function freigeschaltet(req) {
  const code = process.env.ACCESS_CODE;
  if (!code) return true;
  const want = createHmac("sha256", code).update("mbericht-access-v1").digest("hex");
  const m = String(req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith("mb_access="));
  const have = m ? decodeURIComponent(m.slice(10)) : "";
  return have.length === want.length && timingSafeEqual(Buffer.from(have), Buffer.from(want));
}
