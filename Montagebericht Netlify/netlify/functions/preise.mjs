// Tagesaktuelle Listenpreise der Großhändler (Open Masterdata) für die interne Fassung.
//   GET /.netlify/functions/preise?a=0106778,0123456&h=zaj,wie   (bis 40 Artikel-Nr.)
//   h = Großhändler in Abfragereihenfolge (Standard zaj); je Artikel zählt der erste Treffer.
//       zaj = Zajadacz, wie = Wiedemann, bo = Bär & Ollenroth
// Antwort: { kupfer: { wert, stand }, artikel: { "<Nr>": { h, uvp, basis, einheit, cu, cuBasis, zuschlag } } }
//   h        Großhändler, der den Preis geliefert hat
//   uvp      Listenpreis/UVP netto je <basis> <einheit>   (Netto-/Einkaufspreise werden NICHT geliefert);
//            bei Wiedemann der Bruttopreis (listPrice), weil dort darauf kalkuliert wird
//   cu       Kupfergewicht in kg je <basis> <einheit>, cuBasis = im Listenpreis enthaltene Kupferbasis (€/100 kg)
//   zuschlag = cu × (Kupfernotiz − cuBasis) / 100   (€ je <basis> <einheit>)
// Die Kupfernotiz steht nicht in der OMD-Schnittstelle, sondern im Zajadacz-Kundenportal unter „Mein Konto“.
// Dafür meldet sich die Funktion mit den Zajadacz-Zugangsdaten im Shop an (OMD_USER / OMD_PASS).
// Dieselbe Tages-Kupfernotiz gilt für die Zuschläge aller Großhändler.
//
// Umgebungsvariablen
//   Zajadacz:          OMD_TOKEN_URL, OMD_BASE_URL, OMD_CLIENT_ID, OMD_USER, OMD_PASS, optional OMD_CUSTOMER,
//                      optional SHOP_URL (Standard https://www.zajadacz.de)
//   Wiedemann:         WIE_USER, WIE_PASS, WIE_CLIENT_ID (von Wiedemann; ohne wird OMD_CLIENT_ID versucht → invalid_client),
//                      optional WIE_SCOPE (Standard openMasterdata), WIE_CLIENT_SECRET, WIE_CUSTOMER,
//                      WIE_BASE_URL / WIE_TOKEN_URL (Standard: Adressen aus der Wiedemann-Mail)
//   Bär & Ollenroth:   BO_BASE_URL, BO_TOKEN_URL, BO_USER, BO_PASS, optional BO_CUSTOMER, BO_CLIENT_ID, BO_CLIENT_SECRET, BO_SCOPE
//   allgemein:         ALLOWED_ORIGIN
import { freigeschaltet } from "../lib/zugang.mjs";

const json = (o, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });
const clean = (u) => String(u || "").trim().toLowerCase().replace(/\/+$/, "").replace(/^http:/, "https:");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const today = () => new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });

// Zwischenspeicher, solange die Funktion „warm“ ist
const C = globalThis.__mbPreise2 || (globalThis.__mbPreise2 = { token: {}, kupfer: null, art: new Map() });

// Zugangsdaten je Großhändler aus den Umgebungsvariablen; null = nicht eingerichtet
const WIE_URL = "https://shop.wiedemann.de/openmasterdata(bD1kZSZjPTEwMA==)";
function haendler(h, E) {
  const cfg = {
    zaj: { base: E.OMD_BASE_URL, auth: E.OMD_TOKEN_URL, client: E.OMD_CLIENT_ID, scope: E.OMD_SCOPE, user: E.OMD_USER, pass: E.OMD_PASS, kunde: E.OMD_CUSTOMER },
    wie: { base: E.WIE_BASE_URL || WIE_URL, auth: E.WIE_TOKEN_URL || WIE_URL + "/auth", client: E.WIE_CLIENT_ID || E.OMD_CLIENT_ID, secret: E.WIE_CLIENT_SECRET, scope: E.WIE_SCOPE || "openMasterdata", getrennt: true, user: E.WIE_USER, pass: E.WIE_PASS, kunde: E.WIE_CUSTOMER },
    bo: { base: E.BO_BASE_URL, auth: E.BO_TOKEN_URL, client: E.BO_CLIENT_ID || E.OMD_CLIENT_ID, secret: E.BO_CLIENT_SECRET, scope: E.BO_SCOPE, user: E.BO_USER, pass: E.BO_PASS, kunde: E.BO_CUSTOMER },
  }[h];
  return cfg && cfg.base && cfg.auth && cfg.client && cfg.user && cfg.pass ? { h, ...cfg, base: cfg.base.replace(/\/+$/, "") } : null;
}

async function getToken(H) {
  const t = C.token[H.h];
  if (t && Date.now() < t.exp) return t.v;
  const username = H.kunde ? `${H.user}\t${H.kunde}` : H.user;
  const post = (extra = {}) => fetch(H.auth, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...extra },
    body: new URLSearchParams({ grant_type: "password", client_id: H.client, ...(H.secret ? { client_secret: H.secret } : {}), ...(H.scope ? { scope: H.scope } : {}), username, password: H.pass }),
  });
  const lies = async (r) => { const txt = await r.text().catch(() => ""); let j = {}; try { j = JSON.parse(txt); } catch {} return { r, txt, j }; };
  let a = await lies(await post());
  // Manche Shops (z. B. SAP) verlangen die Anmeldung zusätzlich per HTTP-Basic: dann einmal so wiederholen
  let basic = null;
  if (!a.j.access_token && a.r.status === 401 && /basic/i.test(a.r.headers.get("www-authenticate") || "")) {
    basic = a;
    a = await lies(await post({ Authorization: "Basic " + Buffer.from(`${H.user}:${H.pass}`).toString("base64") }));
  }
  if (!a.j.access_token) {
    // Diagnose ohne Zugangsdaten: OAuth-Grund, Content-Type, WWW-Authenticate, Anfang der Antwort
    const weg = (x) => [H.user, H.pass, H.kunde, H.secret].filter(Boolean).reduce((v, z) => v.split(z).join("***"), String(x || ""));
    const info = (x) => {
      const grund = [x.j.error, x.j.error_description, x.j.message].filter((v) => typeof v === "string" && v).join(": ");
      const text = x.txt.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return [x.r.status, grund, "ct=" + (x.r.headers.get("content-type") || "-"), x.r.headers.get("www-authenticate") && "auth=" + x.r.headers.get("www-authenticate"), !grund && text && "text=" + text.slice(0, 140)]
        .filter(Boolean).join(" | ");
    };
    throw new Error(weg(`${H.h}_login ${info(a)}${basic ? " (nach Basic; vorher: " + info(basic) + ")" : ""}`).slice(0, 600));
  }
  C.token[H.h] = { v: a.j.access_token, exp: Date.now() + Math.max(60, (a.j.expires_in || 3600) - 120) * 1000 };
  return a.j.access_token;
}

async function getArtikel(H, token, pid, dg) {
  const key = H.h + ":" + pid, hit = C.art.get(key);
  if (!dg && hit && hit.tag === today()) return hit.d;
  const hole = async (pakete) => {
    const r = await fetch(`${H.base}/product/bySupplierPID?supplierPid=${encodeURIComponent(pid)}&${pakete}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const txt = await r.text().catch(() => "");
    let b = null; try { b = JSON.parse(txt); } catch {}
    if (Array.isArray(b)) b = b[0] || null;   // manche Shops liefern eine Liste statt eines Artikels
    return { r, txt, b };
  };
  // Datenpakete: Zajadacz nimmt sie wiederholt (datapackage=basic&datapackage=prices). Liefert ein anderer Shop
  // so nur „basic“, wird kommagetrennt und notfalls „prices“ einzeln nachgefragt.
  // Wiedemann liefert Preise nur bei datapackage=prices allein: Stammdaten und Preise gleichzeitig abfragen
  const versuche = [];
  let r, txt, b;
  if (H.getrennt) {
    const [s1, s2] = await Promise.all([hole("datapackage=basic"), hole("datapackage=prices")]);
    ({ r, txt, b } = s1);
    if (b && s2.r.ok && s2.b && s2.b.prices) b = { ...b, prices: s2.b.prices };
    else versuche.push(`prices: ${s2.r.status} ${s2.b ? Object.keys(s2.b).join("/") : "-"}`);
  } else ({ r, txt, b } = await hole("datapackage=basic&datapackage=prices"));
  if (!H.getrennt && r.ok && b && !b.prices) {
    versuche.push("basic+prices: ohne prices");
    const v2 = await hole("datapackage=basic,prices");
    if (v2.r.ok && v2.b && v2.b.prices) ({ r, txt, b } = v2);
    else {
      versuche.push(`basic,prices: ${v2.r.status} ${v2.b ? Object.keys(v2.b).join("/") : "-"}`);
      const v3 = await hole("datapackage=prices");
      versuche.push(`prices: ${v3.r.status} ${v3.b ? Object.keys(v3.b).join("/") : (v3.txt || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)}`);
      if (v3.r.ok && v3.b && v3.b.prices) b = { ...b, prices: v3.b.prices };
    }
  }
  if (dg) {
    // Diagnose (?diag=1): Aufbau der Antwort, ohne Netto-/Einkaufspreise
    const pr = (b && b.prices) || {};
    dg.push({ h: H.h, pid, status: r.status, ct: r.headers.get("content-type") || "", felder: b ? Object.keys(b) : null,
      basic: b && b.basic ? Object.keys(b.basic) : null, preisfelder: Object.keys(pr), listPrice: pr.listPrice || null, rrp: pr.rrp || null,
      versuche: versuche.length ? versuche : undefined, basicRrp: b && b.basic && b.basic.rrp != null ? b.basic.rrp : undefined,
      text: b ? undefined : txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  if (r.status === 404 || r.status === 400) { C.art.set(key, { tag: today(), d: null }); return null; }
  if (r.status === 401) delete C.token[H.h];
  if (!r.ok) throw new Error(`${H.h}_artikel ${r.status}`);
  if (!b) throw new Error(`${H.h}_artikel keine_json_antwort`);
  // nur Listenpreis/UVP, nie netPrice. Wiedemann: Kalkulation auf dem Bruttopreis (listPrice; Wiedemann liefert
  // stattdessen nur rrp, der dann als Bruttopreis gilt), sonst UVP zuerst
  const p = (b && b.prices) || {}, lp = H.h === "wie" ? p.listPrice || p.rrp : p.rrp || p.listPrice;
  if (!lp || num(lp.value) == null) { C.art.set(key, { tag: today(), d: null }); return null; }
  const cu = (p.rawMaterial || []).find((m) => /^cu$/i.test(m.material || ""));
  const d = {
    h: H.h, uvp: num(lp.value), basis: num(lp.basis) || 1, einheit: lp.quantityUnit || "",
    bez: (b.basic && b.basic.productShortDescr || "").replace(/\s{2,}/g, " ").trim(),
    cu: cu ? num(cu.proportionByWeight) : null, cuBasis: cu ? num(cu.quotationOfRawMaterial) : null,
    cuJe: cu ? num(cu.weightBasis) || num(lp.basis) || 1 : null,
  };
  C.art.set(key, { tag: today(), d });
  return d;
}

// Kupfernotiz aus dem Kundenportal („Mein Konto“, Kasten „Kupfer“), einmal pro Tag
async function getKupfer(E) {
  if (C.kupfer && C.kupfer.stand === today()) return C.kupfer;
  const base = (E.SHOP_URL || "https://www.zajadacz.de").replace(/\/+$/, "");
  const jar = new Map();
  const keep = (r) => {
    const list = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
    for (const c of list) { const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c || ""); if (m) jar.set(m[1], m[2]); }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const go = async (url, init = {}) => {
    let r, u = url, n = 0;
    do {
      r = await fetch(u, { ...init, redirect: "manual", headers: { ...(init.headers || {}), Cookie: cookie(), "User-Agent": "Mozilla/5.0 Montagebericht-App" } });
      keep(r);
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u).href; init = {}; } else break;
    } while (++n < 6);
    return r;
  };
  await go(base + "/");
  await go(base + "/index.php?", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ lang: "0", actcontrol: "tcaz_custom_login", fnc: "login", cl: "tcaz_custom_login", CustomError: "login", lgn_usr: E.OMD_USER, lgn_pwd: E.OMD_PASS }),
  });
  const html = await (await go(base + "/mein-konto/")).text();
  const m = />\s*Kupfer\s*<\/div>\s*<p[^>]*>\s*([\d.,]+)\s*</i.exec(html);
  go(base + "/login/?fnc=logout&redirect=1").catch(() => {});
  if (!m) throw new Error(/lgn_pwd/.test(html) ? "shop_login" : "kupfer_nicht_gefunden");
  const wert = num(m[1].includes(",") ? m[1].replace(/\./g, "") : m[1]);
  if (!wert || wert < 300 || wert > 5000) throw new Error("kupfer_unplausibel");
  C.kupfer = { wert, stand: today() };
  return C.kupfer;
}

export default async (req) => {
  const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map(clean).filter(Boolean);
  const origin = clean(req.headers.get("origin"));
  if (allowed.length && origin && !allowed.includes(origin)) return json({ error: "forbidden" }, 403);
  if (!freigeschaltet(req)) return json({ error: "no_access" }, 401);

  const E = process.env;
  const u = new URL(req.url);
  const pids = [...new Set((u.searchParams.get("a") || "").split(",").map((s) => s.trim()).filter((s) => /^[\w.\-]{3,20}$/.test(s)))].slice(0, 40);
  const wunsch = [...new Set((u.searchParams.get("h") || "zaj").split(",").map((s) => s.trim().toLowerCase()))].filter((h) => ["zaj", "wie", "bo"].includes(h));
  const liste = wunsch.map((h) => haendler(h, E)).filter(Boolean);

  const out = { kupfer: null, artikel: {}, ...(u.searchParams.get("diag") ? { diag: [] } : {}), fehler: wunsch.filter((h) => !haendler(h, E)).map((h) => h + "_nicht_eingerichtet") };
  if (!liste.length) return json({ ...out, error: "not_configured" }, 500);
  if (haendler("zaj", E)) { try { out.kupfer = await getKupfer(E); } catch (e) { out.fehler.push(String(e.message)); } }

  // je Großhändler der Reihe nach; Artikel, die schon einen Preis haben, werden nicht weiter gesucht
  let offen = pids;
  for (const H of liste) {
    if (!offen.length) break;
    let token;
    try { token = await getToken(H); } catch (e) { out.fehler.push(String(e.message)); continue; }
    await Promise.all(offen.map(async (pid) => {
      try {
        const d0 = await getArtikel(H, token, pid, out.diag);
        if (!d0) return;
        const d = { ...d0 };
        if (d.cu != null && d.cuBasis != null && out.kupfer) {
          // Zuschlag je Preisbasis (Gewicht ist je cuJe angegeben)
          d.zuschlag = Math.round(d.cu * (d.basis / d.cuJe) * Math.max(0, out.kupfer.wert - d.cuBasis)) / 100;
        }
        out.artikel[pid] = d;
      } catch (e) { out.fehler.push(pid + ": " + e.message); }
    }));
    offen = offen.filter((pid) => !out.artikel[pid]);
  }
  // nur vollständige, fehlerfreie Antworten zwischenspeichern, sonst bleibt ein behobener Fehler 10 Minuten sichtbar
  const komplett = !out.fehler.length && !out.diag && pids.every((pid) => out.artikel[pid]);
  return json(out, 200, komplett ? "private, max-age=600" : "no-store");
};
