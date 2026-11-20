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
//   Wiedemann:         WIE_USER, WIE_PASS, optional WIE_CUSTOMER, WIE_CLIENT_ID (Standard: OMD_CLIENT_ID),
//                      WIE_BASE_URL / WIE_TOKEN_URL (Standard: Adressen aus der Wiedemann-Mail)
//   Bär & Ollenroth:   BO_BASE_URL, BO_TOKEN_URL, BO_USER, BO_PASS, optional BO_CUSTOMER, BO_CLIENT_ID
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
    zaj: { base: E.OMD_BASE_URL, auth: E.OMD_TOKEN_URL, client: E.OMD_CLIENT_ID, user: E.OMD_USER, pass: E.OMD_PASS, kunde: E.OMD_CUSTOMER },
    wie: { base: E.WIE_BASE_URL || WIE_URL, auth: E.WIE_TOKEN_URL || WIE_URL + "/auth", client: E.WIE_CLIENT_ID || E.OMD_CLIENT_ID, user: E.WIE_USER, pass: E.WIE_PASS, kunde: E.WIE_CUSTOMER },
    bo: { base: E.BO_BASE_URL, auth: E.BO_TOKEN_URL, client: E.BO_CLIENT_ID || E.OMD_CLIENT_ID, user: E.BO_USER, pass: E.BO_PASS, kunde: E.BO_CUSTOMER },
  }[h];
  return cfg && cfg.base && cfg.auth && cfg.client && cfg.user && cfg.pass ? { h, ...cfg, base: cfg.base.replace(/\/+$/, "") } : null;
}

async function getToken(H) {
  const t = C.token[H.h];
  if (t && Date.now() < t.exp) return t.v;
  const username = H.kunde ? `${H.user}\t${H.kunde}` : H.user;
  const r = await fetch(H.auth, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "password", client_id: H.client, username, password: H.pass }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`${H.h}_login ${r.status}`);
  C.token[H.h] = { v: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return j.access_token;
}

async function getArtikel(H, token, pid) {
  const key = H.h + ":" + pid, hit = C.art.get(key);
  if (hit && hit.tag === today()) return hit.d;
  const url = `${H.base}/product/bySupplierPID?supplierPid=${encodeURIComponent(pid)}&datapackage=basic&datapackage=prices`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status === 404 || r.status === 400) { C.art.set(key, { tag: today(), d: null }); return null; }
  if (r.status === 401) delete C.token[H.h];
  if (!r.ok) throw new Error(`${H.h}_artikel ${r.status}`);
  const b = await r.json();
  // nur Listenpreis/UVP, nie netPrice. Wiedemann: Kalkulation auf dem Bruttopreis (listPrice), sonst UVP zuerst
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

  const out = { kupfer: null, artikel: {}, fehler: wunsch.filter((h) => !haendler(h, E)).map((h) => h + "_nicht_eingerichtet") };
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
        const d0 = await getArtikel(H, token, pid);
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
  return json(out, 200, "private, max-age=600");
};
