// Zugangsschutz: Ohne gültigen Zugangscode wird nur eine Code-Eingabe ausgeliefert, nicht die App.
// Aktiv erst, wenn in Netlify die Umgebungsvariable ACCESS_CODE gesetzt ist (ohne sie bleibt alles offen wie bisher).
// Freischaltung = Cookie "mb_access" (1 Jahr). Gleiche Prüfung steht in netlify/lib/zugang.mjs (send-intern, preise).
const COOKIE = "mb_access";
const enc = new TextEncoder();

async function token(code) {
  const key = await crypto.subtle.importKey("raw", enc.encode(code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("mbericht-access-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookieOf(req, name) {
  const m = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
const page = (msg) => new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Zugang</title><style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--tx:#14171c;--ln:#cfd4dc;--ac:#14171c;--ac2:#fff;--er:#c0392b}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--tx:#eceff4;--ln:#323945;--ac:#eceff4;--ac2:#14171c;--er:#ff8a7a}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--tx);font:17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
form{width:100%;max-width:380px;background:var(--card);border:1px solid var(--ln);border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;opacity:.75;font-size:15px}
input{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:2px solid var(--ln);border-radius:10px;background:var(--bg);color:var(--tx)}
button{margin-top:12px;width:100%;font:inherit;font-weight:700;padding:13px;border:0;border-radius:10px;background:var(--ac);color:var(--ac2)}
.e{color:var(--er);margin:10px 0 0;font-size:15px;opacity:1}</style></head><body>
<form method="post" action="/"><h1>Montageberichte</h1><p>Bitte Zugangscode eingeben.</p>
<input type="password" name="code" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus aria-label="Zugangscode">
<button type="submit">Öffnen</button>${msg ? `<p class="e">${msg}</p>` : ""}</form></body></html>`, {
  status: msg ? 401 : 200,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
});

export default async (req, context) => {
  const code = (typeof Netlify !== "undefined" && Netlify.env && Netlify.env.get("ACCESS_CODE")) || "";
  if (!code) return context.next(); // Schutz nicht scharf geschaltet
  const want = await token(code);
  if (same(cookieOf(req, COOKIE), want)) return context.next();
  if (req.method === "POST") {
    let given = "";
    try { given = String((await req.formData()).get("code") || ""); } catch (e) {}
    if (given && same(await token(given), want)) {
      return new Response(null, { status: 303, headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${want}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`,
        "Cache-Control": "no-store"
      } });
    }
    await new Promise((r) => setTimeout(r, 1500)); // bremst Raten
    return page("Code falsch. Bitte erneut versuchen.");
  }
  return page("");
};

export const config = { path: "/*", excludedPath: "/.netlify/*" };
