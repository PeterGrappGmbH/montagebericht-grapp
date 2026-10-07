// VORÜBERGEHENDE Testfunktion für die Zajadacz-OMD-Schnittstelle.
// Aufruf im Browser: https://montageberichte.netlify.app/.netlify/functions/omd-test?pid=0106778
// Meldet sich an, fragt EINEN Artikel ab und zeigt den Aufbau der Antwort.
// Netto-/Einkaufspreise werden vor der Ausgabe entfernt. Wird nach dem Test wieder gelöscht.
//
// Umgebungsvariablen:
//   OMD_TOKEN_URL  https://www.zajadacz.de/api/openmaster/token
//   OMD_BASE_URL   https://www.zajadacz.de/api/openmaster
//   OMD_CLIENT_ID  Client-ID von Zajadacz
//   OMD_USER       Benutzername (bzw. Kundennummer)
//   OMD_CUSTOMER   optional, Kundennummer, falls zusätzlich zum Benutzernamen nötig
//   OMD_PASS       Passwort (geheim)

const json = (o, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

// alles, was nach Netto-/Einkaufspreis aussieht, entfernen
const strip = (v) => {
  if (Array.isArray(v)) return v.slice(0, 20).map(strip);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!/net|purchase|einkauf|ek_?preis|discount|rabatt/i.test(k)) o[k] = strip(x);
    return o;
  }
  return typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
};

export default async (req) => {
  const u = new URL(req.url);
  const pid = (u.searchParams.get("pid") || "0106778").replace(/[^\w.\-]/g, "").slice(0, 20);
  const E = process.env, missing = ["OMD_TOKEN_URL", "OMD_BASE_URL", "OMD_CLIENT_ID", "OMD_USER", "OMD_PASS"].filter((k) => !E[k]);
  if (missing.length) return json({ schritt: "konfiguration", fehlt: missing }, 500);

  // 1) Anmeldung (OAuth2, Passwort-Verfahren)
  const user = E.OMD_CUSTOMER ? `${E.OMD_USER}\t${E.OMD_CUSTOMER}` : E.OMD_USER;
  const form = new URLSearchParams({ grant_type: "password", client_id: E.OMD_CLIENT_ID, username: user, password: E.OMD_PASS });
  let tok, tokStatus, tokText;
  try {
    const r = await fetch(E.OMD_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
    tokStatus = r.status; tokText = await r.text();
    try { tok = JSON.parse(tokText); } catch {}
  } catch (e) { return json({ schritt: "anmeldung", fehler: String(e && e.message) }, 502); }
  if (!tok || !tok.access_token)
    return json({ schritt: "anmeldung", status: tokStatus, antwort: (tokText || "").slice(0, 500) }, 502);
  const token = { felder: Object.keys(tok), token_type: tok.token_type, expires_in: tok.expires_in };

  // 2) Artikelabfrage – Parameter-Varianten durchprobieren
  const pk = ["basic", "additional", "prices", "descriptions", "logistics"];
  const tries = [
    `supplierPid=${pid}&datapackage=${pk.join(",")}`,
    `supplierPid=${pid}&${pk.map((x) => "datapackage=" + x).join("&")}`,
    `supplierPid=${pid}&datapackage=${pk.join("|")}`,
    `supplierPid=${pid}&datapackage=basic,prices`,
    `supplierPid=${pid}&datapackage=prices`,
  ];
  const versuche = [];
  for (const q of tries) {
    const url = `${E.OMD_BASE_URL.replace(/\/+$/, "")}/product/bySupplierPID?${q}`;
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } });
      const t = await r.text(); let b; try { b = JSON.parse(t); } catch {}
      versuche.push({ abfrage: q, status: r.status });
      if (r.ok && b) return json({ ok: true, artikel: pid, token, versuche, antwort: strip(b) });
      versuche[versuche.length - 1].antwort = (t || "").slice(0, 300);
    } catch (e) { versuche.push({ abfrage: q, fehler: String(e && e.message) }); }
  }
  return json({ schritt: "artikel", token, versuche }, 502);
};
