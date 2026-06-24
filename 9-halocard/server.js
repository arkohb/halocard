/* =====================================================================
   HaloCard — Smart Contact QR Card Generator (personal, Halo brands)
   ---------------------------------------------------------------------
   One self-contained Node service (built-in node:sqlite, zero runtime
   deps). Dynamic QR: each card's QR points to /c/<slug>, a live profile
   page + vCard you can edit later without reprinting. Scan + save
   tracking included. Same one-click Railway deploy as the rest.
   ===================================================================== */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "change-me-halocard-secret";
const APP_URL = process.env.APP_URL || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@halocard.app").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const db = new DatabaseSync(path.join(DATA_DIR, "halocard.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL,
  first_name TEXT, last_name TEXT, middle_name TEXT,
  job_title TEXT, company TEXT,
  mobile TEXT, secondary TEXT, email TEXT, website TEXT,
  address TEXT, city TEXT, country TEXT,
  linkedin TEXT, x_twitter TEXT, facebook TEXT, instagram TEXT, whatsapp TEXT,
  photo TEXT, logo TEXT, template TEXT DEFAULT 'corporate', slogan TEXT,
  accent TEXT DEFAULT '#d99b16',
  active INTEGER DEFAULT 1, scan_count INTEGER DEFAULT 0, vcard_downloads INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER, type TEXT,
  at TEXT DEFAULT (datetime('now')));
`);

/* seed the single admin */
(function seedAdmin() {
  if (db.prepare("SELECT id FROM users LIMIT 1").get()) return;
  const pass = ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO users(email,pass_hash,salt) VALUES (?,?,?)").run(ADMIN_EMAIL, hashPassword(pass, salt), salt);
  console.log("==================================================");
  console.log(" HALOCARD ADMIN  login: " + ADMIN_EMAIL + "   password: " + pass);
  console.log(" (set ADMIN_EMAIL / ADMIN_PASSWORD to control this)");
  console.log("==================================================");
})();

/* ---------- security hardening (same pattern as the other apps) ---------- */
const NODE_ENV = process.env.NODE_ENV || "development";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 3 * 1024 * 1024; // 3 MB (cards may carry small embedded images)
const CSP = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'self'", "form-action 'self'",
  "img-src 'self' data: https:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
].join("; ");
if (NODE_ENV === "production" && (AUTH_SECRET === "change-me-halocard-secret" || AUTH_SECRET.length < 16)) {
  console.error("FATAL: set a strong AUTH_SECRET (16+ random chars) before running in production."); process.exit(1);
}
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown"; }
const _rl = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const key = clientIp(req) + "|" + bucket, now = Date.now();
  let e = _rl.get(key);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; _rl.set(key, e); }
  e.count++; return e.count <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of _rl) if (now > e.reset) _rl.delete(k); }, 60000).unref();
function safeEqual(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb); }
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", CSP);
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  }
}

/* ---------- helpers ---------- */
function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function checkPassword(pw, hash, salt) { const a = Buffer.from(hashPassword(pw, salt), "hex"), b = Buffer.from(hash, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function signToken(u) {
  const payload = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 30 * 86400000 })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
}
function userFromToken(t) {
  if (!t) return null; const [p, s] = t.split("."); if (!p || !s) return null;
  const exp = crypto.createHmac("sha256", AUTH_SECRET).update(p).digest("base64url");
  if (!safeEqual(s, exp)) return null;
  let d; try { d = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
  if (d.exp && Date.now() > d.exp) return null;
  return db.prepare("SELECT * FROM users WHERE id=?").get(d.id) || null;
}
const bearer = (req) => { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") ? userFromToken(h.slice(7)) : null; };
function readBody(req) {
  return new Promise((resolve) => {
    let d = "", len = 0, done = false;
    req.on("data", (c) => { if (done) return; len += c.length; if (len > MAX_BODY) { done = true; try { req.destroy(); } catch {} return resolve(""); } d += c; });
    req.on("end", () => { if (!done) resolve(d); });
    req.on("error", () => { if (!done) { done = true; resolve(""); } });
  });
}
const jread = async (req) => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } };
function json(res, code, obj) { if (res.writableEnded || res.destroyed) return; try { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); } catch {} }
function baseUrl(req) { return APP_URL || ((req.headers["x-forwarded-proto"] || "http") + "://" + (req.headers.host || "")); }
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function slugify(first, last) {
  const base = (String(first || "") + "-" + String(last || "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "card";
  return base + "-" + crypto.randomBytes(3).toString("hex");
}
const CARD_FIELDS = ["first_name","last_name","middle_name","job_title","company","mobile","secondary","email","website","address","city","country","linkedin","x_twitter","facebook","instagram","whatsapp","photo","logo","template","slogan","accent"];
const fullName = (c) => [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" ").trim();

/* ---------- vCard 3.0 (generated live from current data) ---------- */
function vcard(c, base) {
  const L = ["BEGIN:VCARD", "VERSION:3.0"];
  L.push(`N:${c.last_name || ""};${c.first_name || ""};${c.middle_name || ""};;`);
  L.push(`FN:${fullName(c) || "Contact"}`);
  if (c.company) L.push(`ORG:${c.company}`);
  if (c.job_title) L.push(`TITLE:${c.job_title}`);
  if (c.mobile) L.push(`TEL;TYPE=CELL:${c.mobile}`);
  if (c.secondary) L.push(`TEL;TYPE=VOICE:${c.secondary}`);
  if (c.whatsapp) L.push(`TEL;TYPE=CELL,VOICE:${c.whatsapp}`);
  if (c.email) L.push(`EMAIL;TYPE=INTERNET:${c.email}`);
  if (c.website) L.push(`URL:${c.website}`);
  if (c.address || c.city || c.country) L.push(`ADR;TYPE=WORK:;;${c.address || ""};${c.city || ""};;;${c.country || ""}`);
  for (const [lbl, v] of [["LinkedIn", c.linkedin], ["X", c.x_twitter], ["Facebook", c.facebook], ["Instagram", c.instagram]])
    if (v) L.push(`X-SOCIALPROFILE;TYPE=${lbl}:${v}`);
  L.push(`SOURCE:${base}/c/${c.slug}`);
  L.push("END:VCARD");
  return L.join("\r\n");
}

/* ---------- public profile page (Halo themed) ---------- */
function profilePage(c, base) {
  const name = esc(fullName(c)), title = esc(c.job_title || ""), company = esc(c.company || "");
  const socials = [];
  const add = (url, label) => { if (url) socials.push(`<a class="soc" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`); };
  add(c.website, "Website"); add(c.linkedin, "LinkedIn"); add(c.x_twitter, "X");
  add(c.facebook, "Facebook"); add(c.instagram, "Instagram");
  if (c.whatsapp) socials.push(`<a class="soc" href="https://wa.me/${esc(String(c.whatsapp).replace(/[^\d]/g, ""))}" target="_blank" rel="noopener">WhatsApp</a>`);
  const photo = c.photo ? `<img class="avatar" src="${esc(c.photo)}" alt="">` : `<div class="avatar mono">${esc((c.first_name || "?")[0] || "?")}</div>`;
  const logo = c.logo ? `<img class="logo" src="${esc(c.logo)}" alt="">` : "";
  const rows = [];
  if (c.mobile) rows.push(`<a class="row" href="tel:${esc(c.mobile)}"><span>📱 Mobile</span><b>${esc(c.mobile)}</b></a>`);
  if (c.email) rows.push(`<a class="row" href="mailto:${esc(c.email)}"><span>✉️ Email</span><b>${esc(c.email)}</b></a>`);
  if (c.address || c.city || c.country) rows.push(`<div class="row"><span>📍 Address</span><b>${esc([c.address, c.city, c.country].filter(Boolean).join(", "))}</b></div>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name || "Contact"} — HaloCard</title>
<link rel="stylesheet" href="/app.css">
<style>:root{--accent:${esc(c.accent || "#d99b16")}}</style></head>
<body class="profile">
<div class="pcard">
  <div class="phead">${logo}${photo}
    <h1>${name}</h1>
    ${title ? `<div class="ptitle">${title}</div>` : ""}
    ${company ? `<div class="pcompany">${company}</div>` : ""}
  </div>
  <a class="btn save" href="/c/${esc(c.slug)}/vcard.vcf">＋ Save to contacts</a>
  <div class="prows">${rows.join("")}</div>
  ${socials.length ? `<div class="socials">${socials.join("")}</div>` : ""}
  <div class="pfoot">Made with <b>HaloCard</b></div>
</div></body></html>`;
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".map": "application/json" };
const PAGES = { "/": "index.html", "/app": "app.html" };
function serveStatic(res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, "");
  const full = path.join(__dirname, "public", rel);
  if (!full.startsWith(path.join(__dirname, "public"))) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>404</h1>"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" }); res.end(buf);
  });
}

/* =====================================================================
   server
   ===================================================================== */
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  applyCors(req, res);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (/login/.test(p) && req.method === "POST" && !rateLimit(req, "auth", 12, 5 * 60 * 1000)) return json(res, 429, { error: "Too many attempts, wait a few minutes." });

  try {
    if (p === "/health") return json(res, 200, { ok: true, time: new Date().toISOString() });

    /* ---------- public: dynamic profile + vCard (the QR target) ---------- */
    const mVcf = p.match(/^\/c\/([A-Za-z0-9-]+)\/vcard\.vcf$/);
    if (req.method === "GET" && mVcf) {
      const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(mVcf[1]);
      if (!c || !c.active) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      db.prepare("UPDATE cards SET vcard_downloads=vcard_downloads+1 WHERE id=?").run(c.id);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'vcard')").run(c.id);
      res.writeHead(200, { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `attachment; filename="${(fullName(c) || "contact").replace(/[^\w]+/g, "_")}.vcf"` });
      return res.end(vcard(c, baseUrl(req)));
    }
    const mProfile = p.match(/^\/c\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && mProfile) {
      const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(mProfile[1]);
      if (!c) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>Card not found</h1>"); }
      if (!c.active) { res.writeHead(410, { "Content-Type": "text/html" }); return res.end("<h1>This card is no longer active.</h1>"); }
      db.prepare("UPDATE cards SET scan_count=scan_count+1 WHERE id=?").run(c.id);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'scan')").run(c.id);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(profilePage(c, baseUrl(req)));
    }

    /* ---------- auth ---------- */
    if (req.method === "POST" && p === "/api/login") {
      const b = await jread(req);
      const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(b.email || "").trim().toLowerCase());
      if (!u || !checkPassword(String(b.password || ""), u.pass_hash, u.salt)) return json(res, 401, { error: "wrong email or password" });
      return json(res, 200, { token: signToken(u), email: u.email });
    }

    const me = bearer(req);
    if (req.method === "GET" && p === "/api/me") { if (!me) return json(res, 401, { error: "unauthorized" }); return json(res, 200, { email: me.email, app_url: baseUrl(req) }); }
    if (req.method === "POST" && p === "/api/change-password") {
      if (!me) return json(res, 401, { error: "unauthorized" });
      const b = await jread(req); if (String(b.password || "").length < 6) return json(res, 400, { error: "password must be 6+ characters" });
      const salt = crypto.randomBytes(16).toString("hex");
      db.prepare("UPDATE users SET pass_hash=?, salt=? WHERE id=?").run(hashPassword(b.password, salt), salt, me.id);
      return json(res, 200, { ok: true });
    }

    /* ---------- everything below is admin-only ---------- */
    const needAuth = () => { if (!me) { json(res, 401, { error: "unauthorized" }); return false; } return true; };

    if (req.method === "GET" && p === "/api/overview") {
      if (!needAuth()) return;
      const total = db.prepare("SELECT COUNT(*) n FROM cards").get().n;
      const active = db.prepare("SELECT COUNT(*) n FROM cards WHERE active=1").get().n;
      const scans = db.prepare("SELECT COALESCE(SUM(scan_count),0) s FROM cards").get().s;
      const downloads = db.prepare("SELECT COALESCE(SUM(vcard_downloads),0) s FROM cards").get().s;
      return json(res, 200, { total, active, scans, downloads, app_url: baseUrl(req) });
    }

    if (p === "/api/cards") {
      if (!needAuth()) return;
      if (req.method === "GET") {
        const cards = db.prepare("SELECT id,slug,first_name,last_name,job_title,company,template,active,scan_count,vcard_downloads,updated_at FROM cards ORDER BY updated_at DESC").all();
        return json(res, 200, { cards, app_url: baseUrl(req) });
      }
      if (req.method === "POST") {
        const b = await jread(req);
        if (!b.first_name && !b.last_name) return json(res, 400, { error: "a name is required" });
        const slug = slugify(b.first_name, b.last_name);
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        const sql = `INSERT INTO cards(slug,${cols.join(",")}) VALUES (?${",?".repeat(cols.length)})`;
        db.prepare(sql).run(slug, ...cols.map((f) => b[f] ?? null));
        const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(slug);
        return json(res, 200, { ok: true, id: c.id, slug, url: baseUrl(req) + "/c/" + slug });
      }
    }

    const mCard = p.match(/^\/api\/cards\/(\d+)$/);
    if (mCard) {
      if (!needAuth()) return;
      const id = Number(mCard[1]);
      if (req.method === "GET") { const c = db.prepare("SELECT * FROM cards WHERE id=?").get(id); return c ? json(res, 200, { card: c, url: baseUrl(req) + "/c/" + c.slug }) : json(res, 404, { error: "not found" }); }
      if (req.method === "PUT") {
        const b = await jread(req);
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        if (cols.length) db.prepare(`UPDATE cards SET ${cols.map((f) => f + "=?").join(",")}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((f) => b[f] ?? null), id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") { db.prepare("DELETE FROM cards WHERE id=?").run(id); db.prepare("DELETE FROM events WHERE card_id=?").run(id); return json(res, 200, { ok: true }); }
    }

    const mToggle = p.match(/^\/api\/cards\/(\d+)\/toggle$/);
    if (req.method === "POST" && mToggle) {
      if (!needAuth()) return;
      db.prepare("UPDATE cards SET active = 1 - active, updated_at=datetime('now') WHERE id=?").run(Number(mToggle[1]));
      const c = db.prepare("SELECT active FROM cards WHERE id=?").get(Number(mToggle[1]));
      return json(res, 200, { ok: true, active: !!c?.active });
    }

    if (req.method === "POST" && p === "/api/cards/bulk") {
      if (!needAuth()) return;
      const b = await jread(req);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      let made = 0;
      for (const r of rows.slice(0, 1000)) {
        if (!r.first_name && !r.last_name && !r.name) continue;
        let first = r.first_name, last = r.last_name;
        if (!first && r.name) { const parts = String(r.name).trim().split(/\s+/); first = parts.shift(); last = parts.join(" "); }
        const slug = slugify(first, last);
        db.prepare("INSERT INTO cards(slug,first_name,last_name,job_title,company,mobile,email,template) VALUES (?,?,?,?,?,?,?,?)")
          .run(slug, first || "", last || "", r.position || r.job_title || "", r.company || "", r.phone || r.mobile || "", r.email || "", b.template || "corporate");
        made++;
      }
      return json(res, 200, { ok: true, created: made });
    }

    if (req.method === "GET") return serveStatic(res, p);
    return json(res, 404, { error: "not found" });
  } catch (e) { console.error("ERR", p, e); return json(res, 500, { error: e.message || "server error" }); }
});

server.listen(PORT, () => console.log(`HaloCard on :${PORT}  (data: ${DATA_DIR})`));
