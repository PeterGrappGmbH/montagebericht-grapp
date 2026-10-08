// Tagesaktuelle Listenpreise von Zajadacz für die interne Fassung.
//   GET /.netlify/functions/preise?a=0106778,0123456   (bis 40 Artikel-Nr.)
// Antwort: { kupfer: { wert, stand }, artikel: { "<Nr>": { uvp, basis, einheit, cu, cuBasis, zuschlag } } }
//   uvp      Listenpreis/UVP netto je <basis> <einheit>   (Netto-/Einkaufspreise werden NICHT geliefert)
//   cu       Kupfergewicht in kg je <basis> <einheit>, cuBasis = im Listenpreis enthaltene Kupferbasis (€/100 kg)
//   zuschlag = cu × (Kupfernotiz − cuBasis) / 100   (€ je <basis> <einheit>)
// Die Kupfernotiz steht nicht in der OMD-Schnittstelle, sondern im Kundenportal unter „Mein Konto“.
// Dafür meldet sich die Funktion mit denselben Zugangsdaten im Shop an (OMD_USER / OMD_PASS).
//
// Umgebungsvariablen: OMD_TOKEN_URL, OMD_BASE_URL, OMD_CLIENT_ID, OMD_USER, OMD_PASS, optional OMD_CUSTOMER,
//                     optional SHOP_URL (Standard https://www.zajadacz.de), ALLOWED_ORIGIN

const json = (o, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });
const clean = (u) => String(u || "").trim().toLowerCase().replace(/\/+$/, "").replace(/^http:/, "https:");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const today = () => new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });

// Zwischenspeicher, solange die Funktion „warm“ ist
const C = globalThis.__mbPreise || (globalThis.__mbPreise = { token: null, tokenExp: 0, kupfer: null, art: new Map() });

async function getToken(E) {
  if (C.token && Date.now() < C.tokenExp) return C.token;
  const username = E.OMD_CUSTOMER ? `${E.OMD_USER}\t${E.OMD_CUSTOMER}` : E.OMD_USER;
  const r = await fetch(E.OMD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "password", client_id: E.OMD_CLIENT_ID, username, password: E.OMD_PASS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("omd_login " + r.status);
  C.token = j.access_token; C.tokenExp = Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000;
  return C.token;
}

async function getArtikel(E, token, pid) {
  const hit = C.art.get(pid);
  if (hit && hit.tag === today()) return hit.d;
  const url = `${E.OMD_BASE_URL.replace(/\/+$/, "")}/product/bySupplierPID?supplierPid=${encodeURIComponent(pid)}&datapackage=basic&datapackage=prices`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error("omd_artikel " + r.status);
  const b = await r.json();
  const p = (b && b.prices) || {}, lp = p.rrp || p.listPrice;   // nur Listenpreis/UVP, nie netPrice
  if (!lp || num(lp.value) == null) return null;
  const cu = (p.rawMaterial || []).find((m) => /^cu$/i.test(m.material || ""));
  const d = {
    uvp: num(lp.value), basis: num(lp.basis) || 1, einheit: lp.quantityUnit || "",
    bez: (b.basic && b.basic.productShortDescr || "").replace(/\s{2,}/g, " ").trim(),
    cu: cu ? num(cu.proportionByWeight) : null, cuBasis: cu ? num(cu.quotationOfRawMaterial) : null,
    cuJe: cu ? num(cu.weightBasis) || num(lp.basis) || 1 : null,
  };
  C.art.set(pid, { tag: today(), d });
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

  const E = process.env;
  if (!["OMD_TOKEN_URL", "OMD_BASE_URL", "OMD_CLIENT_ID", "OMD_USER", "OMD_PASS"].every((k) => E[k])) return json({ error: "not_configured" }, 500);

  const u = new URL(req.url);
  const pids = [...new Set((u.searchParams.get("a") || "").split(",").map((s) => s.trim()).filter((s) => /^[\w.\-]{3,20}$/.test(s)))].slice(0, 40);

  const out = { kupfer: null, artikel: {}, fehler: [] };
  try { out.kupfer = await getKupfer(E); } catch (e) { out.fehler.push(String(e.message)); }
  if (pids.length) {
    try {
      const token = await getToken(E);
      await Promise.all(pids.map(async (pid) => {
        try {
          const d = await getArtikel(E, token, pid);
          if (!d) return;
          if (d.cu != null && d.cuBasis != null && out.kupfer) {
            // Zuschlag je Preisbasis (Gewicht ist je cuJe angegeben)
            d.zuschlag = Math.round(d.cu * (d.basis / d.cuJe) * Math.max(0, out.kupfer.wert - d.cuBasis)) / 100;
          }
          out.artikel[pid] = d;
        } catch (e) { out.fehler.push(pid + ": " + e.message); }
      }));
    } catch (e) { out.fehler.push(String(e.message)); }
  }
  return json(out, 200, "private, max-age=600");
};
