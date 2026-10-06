// Verschickt Montagebericht-PDFs per IONOS-SMTP.
//  - ans Büro (Standard): interne Fassung + Kundenfassung an MAIL_TO
//  - an den Kunden (mode "kunde"): nur die Kundenfassung an die Adresse aus dem Bericht,
//    das Büro (MAIL_TO) bekommt eine Blindkopie
//
// Umgebungsvariablen in Netlify (Project configuration → Environment variables):
//   SMTP_USER       IONOS-Postfach, über das gesendet wird (z. B. wartung@elektro-grapp.de)
//   SMTP_PASS       Passwort dieses Postfachs
//   MAIL_TO         Empfänger im Büro (z. B. wartung@elektro-grapp.de)
//   MAIL_FROM       optional, Absender (Standard: SMTP_USER)
//   SMTP_HOST       optional, Standard smtp.ionos.de
//   SMTP_PORT       optional, Standard 587 (STARTTLS); 465 = SSL
//   ALLOWED_ORIGIN  optional, z. B. https://montageberichte.netlify.app (Komma für mehrere)
import nodemailer from "nodemailer";

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const clean = (u) => String(u || "").trim().toLowerCase().replace(/\/+$/, "").replace(/^http:/, "https:");
const EMAIL = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[a-z]{2,}$/i;

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map(clean).filter(Boolean);
  const origin = clean(req.headers.get("origin"));
  if (allowed.length && origin && !allowed.includes(origin)) return json({ error: "forbidden" }, 403);

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_TO)
    return json({ error: "not_configured" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const kunde = body.mode === "kunde";
  const files = Array.isArray(body.files) ? body.files : [];
  const ok = files.length >= 1 && files.length <= (kunde ? 1 : 3) && files.every(
    (f) => typeof f.name === "string" && /^[\wäöüÄÖÜß!.\-]{1,150}\.pdf$/.test(f.name) &&
           (!kunde || /_Kunde\.pdf$/.test(f.name)) &&
           typeof f.data === "string" && /^[A-Za-z0-9+/=]+$/.test(f.data));
  if (!ok) return json({ error: "bad_request" }, 400);
  if (files.reduce((n, f) => n + f.data.length, 0) > 5.8e6) return json({ error: "too_large" }, 413);

  const office = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  let mail;
  if (kunde) {
    const to = String(body.to || "").trim();
    if (!EMAIL.test(to)) return json({ error: "bad_email" }, 400);
    const doc = String(body.doc || "").slice(0, 40), obj = String(body.obj || "").slice(0, 120);
    mail = {
      from: { name: "Peter Grapp GmbH", address: from }, to, bcc: office, replyTo: office,
      subject: `Ihr Montagebericht${doc ? " " + doc : ""} – Peter Grapp GmbH`,
      text: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie den Montagebericht${doc ? " " + doc : ""}${obj ? " zu " + obj : ""}.\n\n` +
            `Bei Fragen erreichen Sie uns unter 030 / 769 030 69 oder per Antwort auf diese E-Mail.\n\n` +
            `Mit freundlichen Grüßen\nPeter Grapp Elektroanlagen GmbH\nAkazienstraße 2 · 12207 Berlin\nwww.elektro-grapp.de`,
    };
  } else {
    mail = {
      from, to: office,
      subject: String(body.subject || "Montagebericht").replace(/[\r\n]+/g, " ").slice(0, 200),
      text: String(body.text || "").slice(0, 4000),
    };
  }
  mail.attachments = files.map((f) => ({
    filename: f.name, content: Buffer.from(f.data, "base64"), contentType: "application/pdf",
  }));

  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.ionos.de",
    port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try {
    await transport.sendMail(mail);
  } catch (e) {
    const detail = String((e && (e.response || e.code || e.message)) || "").slice(0, 160);
    console.error("SMTP-Fehler", detail);
    return json({ error: "smtp", detail }, 502);
  }
  return json({ ok: true });
};
