// Verschickt die Montagebericht-PDFs direkt ans Büro (IONOS-SMTP).
// Der Empfänger steht nur hier auf dem Server (MAIL_TO), die App kann ihn nicht ändern.
//
// Umgebungsvariablen in Netlify (Site configuration → Environment variables):
//   SMTP_USER       IONOS-Postfach, über das gesendet wird (z. B. wartung@elektro-grapp.de)
//   SMTP_PASS       Passwort dieses Postfachs
//   MAIL_TO         Empfänger im Büro (z. B. wartung@elektro-grapp.de)
//   MAIL_FROM       optional, Absender (Standard: SMTP_USER)
//   SMTP_HOST       optional, Standard smtp.ionos.de
//   SMTP_PORT       optional, Standard 587 (STARTTLS); 465 = SSL
//   ALLOWED_ORIGIN  optional, z. B. https://montagebericht-grapp.netlify.app (Komma für mehrere)
import nodemailer from "nodemailer";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  if (allowed.length && !allowed.includes(origin)) return json({ error: "forbidden" }, 403);

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_TO)
    return json({ error: "not_configured" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const files = Array.isArray(body.files) ? body.files : [];
  const ok = files.length >= 1 && files.length <= 3 && files.every(
    (f) => typeof f.name === "string" && /^[\wäöüÄÖÜß!.\-]{1,150}\.pdf$/.test(f.name) &&
           typeof f.data === "string" && /^[A-Za-z0-9+/=]+$/.test(f.data));
  if (!ok) return json({ error: "bad_request" }, 400);
  if (files.reduce((n, f) => n + f.data.length, 0) > 5.8e6) return json({ error: "too_large" }, 413);

  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.ionos.de",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: process.env.MAIL_TO,
      subject: String(body.subject || "Montagebericht").replace(/[\r\n]+/g, " ").slice(0, 200),
      text: String(body.text || "").slice(0, 4000),
      attachments: files.map((f) => ({
        filename: f.name,
        content: Buffer.from(f.data, "base64"),
        contentType: "application/pdf",
      })),
    });
  } catch (e) {
    console.error("SMTP-Fehler", e && e.message);
    return json({ error: "smtp" }, 502);
  }
  return json({ ok: true });
};
