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
CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
  name TEXT, phone TEXT, email TEXT, company TEXT, note TEXT,
  at TEXT DEFAULT (datetime('now')));
`);
/* lightweight migration: columns added after v1 (safe to re-run) */
for (const col of ["tiktok", "snapchat", "payment_url", "payment_label"]) {
  try { db.exec(`ALTER TABLE cards ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN name TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN plan_expires TEXT"); } catch {}
try { db.exec("ALTER TABLE cards ADD COLUMN user_id INTEGER"); } catch {}
/* the original single account becomes the admin; existing cards belong to them */
db.prepare("UPDATE users SET role='admin' WHERE email=?").run(ADMIN_EMAIL);
const _adm = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
if (_adm) db.prepare("UPDATE cards SET user_id=? WHERE user_id IS NULL").run(_adm.id);
/* ---------- plans & billing ---------- */
const PLANS = {
  free:     { label: "Free",     cards: Number(process.env.CARDS_FREE || 1),  price: 0 },
  pro:      { label: "Pro",      cards: Number(process.env.CARDS_PRO || 5),  price: Number(process.env.PRICE_PRO_GHS || 120) },
  business: { label: "Business", cards: Number(process.env.CARDS_BUSINESS || 25), price: Number(process.env.PRICE_BUSINESS_GHS || 300) },
};
const BILLING_PERIOD_DAYS = Number(process.env.BILLING_PERIOD_DAYS || 365); /* annual */
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_UPGRADE_URL = process.env.PAYSTACK_UPGRADE_URL || ""; /* fallback: manual payment page */
/* effective plan (admin = business; paid plans lapse to free on expiry) */
function planOf(u) {
  if (!u) return "free";
  if (u.role === "admin") return "business";
  let p = PLANS[u.plan] ? u.plan : "free";
  if (p !== "free" && u.plan_expires && Date.parse(u.plan_expires) < Date.now()) p = "free";
  return p;
}
const planAtLeast = (p, min) => ({ free: 0, pro: 1, business: 2 }[p] >= { free: 0, pro: 1, business: 2 }[min]);
function ownerPlanForCard(c) { const u = c.user_id ? db.prepare("SELECT * FROM users WHERE id=?").get(c.user_id) : null; return planOf(u); }

/* seed the single admin */
(function seedAdmin() {
  if (db.prepare("SELECT id FROM users LIMIT 1").get()) return;
  const pass = ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO users(email,pass_hash,salt,role,name) VALUES (?,?,?,'admin','Admin')").run(ADMIN_EMAIL, hashPassword(pass, salt), salt);
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
const CARD_FIELDS = ["first_name","last_name","middle_name","job_title","company","mobile","secondary","email","website","address","city","country","linkedin","x_twitter","facebook","instagram","whatsapp","tiktok","snapchat","payment_url","payment_label","photo","logo","template","slogan","accent"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/; /* 3-40 chars */
const slugTaken = (slug, exceptId) => { const r = db.prepare("SELECT id FROM cards WHERE slug=?").get(slug); return r && r.id !== exceptId; };
const fullName = (c) => [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" ").trim();

/* ---------- vCard 3.0 (generated live from current data) ---------- */
const vv = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim(); // strip CRLF: prevents vCard line injection
function socialUrl(kind, v) {
  if (!v) return "";
  v = vv(v);
  if (/^https?:\/\//i.test(v)) return v;
  const h = encodeURIComponent(v.replace(/^@/, "").replace(/\s+/g, ""));
  switch (kind) {
    case "instagram": return "https://www.instagram.com/" + h;
    case "tiktok":    return "https://www.tiktok.com/@" + h;
    case "snapchat":  return "https://www.snapchat.com/add/" + h;
    case "facebook":  return "https://www.facebook.com/" + h;
    case "x_twitter": return "https://x.com/" + h;
    case "linkedin":  return "https://www.linkedin.com/in/" + h;
    case "website":   return "https://" + vv(v).replace(/\s+/g, "");
    default: return "https://" + h;
  }
}
function vcard(c, base) {
  const L = ["BEGIN:VCARD", "VERSION:3.0"];
  L.push(`N:${vv(c.last_name)};${vv(c.first_name)};${vv(c.middle_name)};;`);
  L.push(`FN:${vv(fullName(c)) || "Contact"}`);
  if (c.company) L.push(`ORG:${vv(c.company)}`);
  if (c.job_title) L.push(`TITLE:${vv(c.job_title)}`);
  if (c.mobile) L.push(`TEL;TYPE=CELL:${vv(c.mobile)}`);
  if (c.secondary) L.push(`TEL;TYPE=VOICE:${vv(c.secondary)}`);
  if (c.whatsapp) L.push(`TEL;TYPE=CELL,VOICE:${vv(c.whatsapp)}`);
  if (c.email) L.push(`EMAIL;TYPE=INTERNET:${vv(c.email)}`);
  if (c.website) L.push(`URL:${socialUrl("website", c.website)}`);
  if (c.address || c.city || c.country) L.push(`ADR;TYPE=WORK:;;${vv(c.address)};${vv(c.city)};;;${vv(c.country)}`);
  for (const [lbl, kind, v] of [
    ["LinkedIn", "linkedin", c.linkedin], ["X", "x_twitter", c.x_twitter], ["Facebook", "facebook", c.facebook],
    ["Instagram", "instagram", c.instagram], ["TikTok", "tiktok", c.tiktok], ["Snapchat", "snapchat", c.snapchat],
  ]) if (v) L.push(`X-SOCIALPROFILE;TYPE=${lbl}:${socialUrl(kind, v)}`);
  L.push(`SOURCE:${base}/c/${c.slug}`);
  L.push("END:VCARD");
  return L.join("\r\n");
}

/* ---------- kente weave: brand thread used on the profile page ---------- */
const KENTE = { gold: "#d99b16", goldHi: "#f2c14e", black: "#171410", red: "#b23a2a", green: "#1f7a4d" };
function kenteBand(id) {
  /* one woven strip tile (56x26), repeated across the band */
  return `<svg class="kente-band" viewBox="0 0 560 26" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs><pattern id="kw${id}" width="56" height="26" patternUnits="userSpaceOnUse">
  <rect width="56" height="26" fill="${KENTE.gold}"/>
  <rect y="0" width="56" height="3" fill="${KENTE.black}"/>
  <rect y="23" width="56" height="3" fill="${KENTE.black}"/>
  <rect x="0" y="3" width="14" height="20" fill="${KENTE.red}"/>
  <rect x="28" y="3" width="14" height="20" fill="${KENTE.green}"/>
  <rect x="16" y="6" width="10" height="3" fill="${KENTE.black}"/>
  <rect x="18" y="11.5" width="8" height="3" fill="${KENTE.black}"/>
  <rect x="16" y="17" width="10" height="3" fill="${KENTE.black}"/>
  <rect x="44" y="6" width="10" height="3" fill="${KENTE.black}"/>
  <rect x="46" y="11.5" width="8" height="3" fill="${KENTE.black}"/>
  <rect x="44" y="17" width="10" height="3" fill="${KENTE.black}"/>
  <rect x="2" y="8" width="10" height="2" fill="${KENTE.goldHi}"/>
  <rect x="2" y="15" width="10" height="2" fill="${KENTE.goldHi}"/>
  <rect x="30" y="8" width="10" height="2" fill="${KENTE.goldHi}"/>
  <rect x="30" y="15" width="10" height="2" fill="${KENTE.goldHi}"/>
</pattern></defs>
<rect width="560" height="26" fill="url(#kw${id})"/></svg>`;
}

const ICONS = {
  phone: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18" stroke="currentColor" stroke-width="2"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" width="24" height="24"><rect x="3" y="3" width="18" height="18" rx="5.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.35" fill="currentColor"/></svg>`,
  whatsapp: `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path fill="currentColor" d="M9.2 8.1c.2-.4.5-.4.7-.4h.6c.2 0 .4 0 .6.4l.8 1.9c.1.2 0 .5-.1.6l-.6.7c-.1.2-.2.4 0 .6.5.9 1.3 1.7 2.3 2.2.3.1.5.1.6-.1l.6-.7c.2-.2.4-.2.6-.1l1.9.9c.3.2.4.3.4.5 0 1-.9 2-1.9 2-3.7 0-7-3.3-7-7 0-.6.2-1.1.5-1.5z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" width="24" height="24"><text x="12" y="18" text-anchor="middle" font-family="Arial, sans-serif" font-size="17" font-weight="800" fill="currentColor">f</text></svg>`,
  tiktok: `<svg viewBox="0 0 24 24" width="24" height="24"><text x="12" y="18" text-anchor="middle" font-family="Arial, sans-serif" font-size="17" font-weight="800" fill="currentColor">&#9835;</text></svg>`,
  snapchat: `<svg viewBox="0 0 24 24" width="24" height="24"><text x="12" y="17.5" text-anchor="middle" font-size="14">&#128123;</text></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" width="24" height="24"><text x="12" y="17" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" font-weight="800" fill="currentColor">in</text></svg>`,
  x: `<svg viewBox="0 0 24 24" width="24" height="24"><text x="12" y="17.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="800" fill="currentColor">&#120143;</text></svg>`,
  save: `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
};
function profilePage(c, base, plan = "business") {
  const PRO = planAtLeast(plan, "pro"), BIZ = planAtLeast(plan, "business");
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(c.accent || "")) ? c.accent : "#d99b16";
  const name = esc(fullName(c)) || "Contact", title = esc(c.job_title || ""), company = esc(c.company || "");
  const initials = esc(((c.first_name || "?")[0] || "?") + ((c.last_name || "")[0] || "")).toUpperCase();
  const photo = c.photo ? `<img class="avatar" src="${esc(c.photo)}" alt="${name}">` : `<div class="avatar mono">${initials}</div>`;
  const logo = c.logo ? `<img class="brandlogo" src="${esc(c.logo)}" alt="">` : "";

  /* social chips — brand-coloured, deep-link straight to each profile */
  const chips = [];
  const go = (kind) => `/c/${c.slug}/go/${kind}`; /* tracked click-through */
  const chip = (kind, has, label, bg, icon, fg = "#ffffff") => { if (has) chips.push({ href: go(kind), label, bg, icon, fg }); };
  chip("whatsapp", c.whatsapp, "WhatsApp", "#25D366", ICONS.whatsapp);
  chip("instagram", c.instagram, "Instagram", "#E1306C", ICONS.instagram);
  chip("facebook", c.facebook, "Facebook", "#1877F2", ICONS.facebook);
  chip("tiktok", c.tiktok, "TikTok", "#010101", ICONS.tiktok);
  chip("snapchat", c.snapchat, "Snapchat", "#FFFC00", ICONS.snapchat, "#171410");
  chip("linkedin", c.linkedin, "LinkedIn", "#0A66C2", ICONS.linkedin);
  chip("x_twitter", c.x_twitter, "X", "#000000", ICONS.x);
  chip("website", c.website, "Website", accent, ICONS.globe);
  const chipHtml = chips.map((s) =>
    `<a class="chip" href="${esc(s.href)}" target="_blank" rel="noopener" aria-label="${esc(s.label)}">
       <span class="chip-ring"><span class="chip-ic" style="background:${s.bg};color:${s.fg}">${s.icon}</span></span>
       <span class="chip-lb">${esc(s.label)}</span></a>`).join("");

  /* quick actions + contact rows */
  const actions = [];
  if (c.mobile) actions.push(`<div class="act-frame"><a class="act call" href="tel:${esc(c.mobile)}">${ICONS.phone}<span>Call</span></a></div>`);
  if (c.email) actions.push(`<div class="act-frame"><a class="act email" href="mailto:${esc(c.email)}">${ICONS.mail}<span>Email</span></a></div>`);
  const rows = [];
  if (c.mobile) rows.push(`<a class="row" href="tel:${esc(c.mobile)}"><span class="rk">${ICONS.phone} Mobile</span><b>${esc(c.mobile)}</b></a>`);
  if (c.secondary) rows.push(`<a class="row" href="tel:${esc(c.secondary)}"><span class="rk">${ICONS.phone} Phone 2</span><b>${esc(c.secondary)}</b></a>`);
  if (c.email) rows.push(`<a class="row" href="mailto:${esc(c.email)}"><span class="rk">${ICONS.mail} Email</span><b>${esc(c.email)}</b></a>`);
  if (c.address || c.city || c.country) {
    const addr = [c.address, c.city, c.country].filter(Boolean).join(", ");
    rows.push(`<a class="row" href="https://maps.google.com/?q=${encodeURIComponent(addr)}" target="_blank" rel="noopener"><span class="rk">${ICONS.pin} Address</span><b>${esc(addr)}</b></a>`);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#171410">
<meta property="og:title" content="${name}${company ? " — " + company : ""}">
<meta property="og:description" content="Tap to save my contact and connect on social media.">
${c.photo || c.logo ? `<meta property="og:image" content="${esc(base)}/c/${esc(c.slug)}/${c.photo ? "photo" : "logo"}">` : ""}
<meta property="og:type" content="profile">
<meta property="og:url" content="${esc(base)}/c/${esc(c.slug)}">
<title>${name} — HaloCard</title>
<style>
:root{--accent:${esc(accent)};--dark:#171410;--cream:#f7f2e7;--ink:#2a251d;--mut:#6b6256}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:var(--dark);min-height:100vh;display:flex;justify-content:center;padding:0 0 2rem;color:var(--ink)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;
 background:radial-gradient(60% 40% at 50% 0%, rgba(217,155,22,.22), transparent 70%), repeating-linear-gradient(45deg, rgba(217,155,22,.05) 0 2px, transparent 2px 14px);
 background:radial-gradient(60% 40% at 50% 0%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 70%), repeating-linear-gradient(45deg, rgba(217,155,22,.05) 0 2px, transparent 2px 14px)}
.page{width:100%;max-width:430px;position:relative;animation:up .45s ease both}
@keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.hero{height:144px;margin-top:-2px;background:var(--accent);background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 55%, #171410));border-radius:0 0 26px 26px;position:relative;overflow:hidden}
.hero::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(-45deg,rgba(255,255,255,.06) 0 3px,transparent 3px 16px)}
.brandlogo{position:absolute;top:14px;right:14px;max-height:38px;max-width:120px;object-fit:contain;background:rgba(255,255,255,.92);border-radius:9px;padding:5px 8px;z-index:2}
.kente-band{display:block;width:100%;height:18px}
.kente-band.slim{height:12px;border-radius:7px;overflow:hidden;box-shadow:0 3px 10px rgba(0,0,0,.35)}
.avatar-ring{padding:5px;border-radius:50%;position:relative;z-index:2;box-shadow:0 8px 26px rgba(0,0,0,.45);
 background:#d99b16;
 background:repeating-conic-gradient(#d99b16 0 18deg,#171410 18deg 24deg,#b23a2a 24deg 42deg,#171410 42deg 48deg,#1f7a4d 48deg 66deg,#171410 66deg 72deg)}
.avatar{display:block;width:108px;height:108px;border-radius:50%;object-fit:cover;border:3px solid var(--cream)}
.avatar.mono{display:flex;align-items:center;justify-content:center;background:var(--dark);color:var(--accent);font-size:2.3rem;font-weight:800;letter-spacing:.03em}
.sheet-frame{margin:-64px 14px 0;padding:3px;border-radius:29px;box-shadow:0 18px 50px rgba(0,0,0,.5);position:relative;
 background:#d99b16;
 background:repeating-linear-gradient(45deg,#d99b16 0 12px,#171410 12px 15px,#b23a2a 15px 27px,#171410 27px 30px,#1f7a4d 30px 42px,#171410 42px 45px)}
.sheet{background:var(--cream);border-radius:26px;padding:0 18px 22px}
.head{display:flex;flex-direction:column;align-items:center;text-align:center;transform:translateY(-56px);margin-bottom:-44px}
h1{font-size:1.5rem;color:var(--dark);margin-top:.65rem;line-height:1.15}
.ptitle{color:var(--accent);font-weight:700;margin-top:.2rem;filter:saturate(1.2) brightness(.85)}
.pcompany{color:var(--mut);font-size:.95rem;margin-top:.12rem}
.save{display:flex;align-items:center;justify-content:center;gap:.55rem;background:var(--accent);color:#171410;font-weight:800;font-size:1.02rem;text-decoration:none;border-radius:15px;padding:.95rem;margin-top:1rem;box-shadow:0 6px 18px rgba(0,0,0,.35);box-shadow:0 6px 18px color-mix(in srgb,var(--accent) 45%, transparent);transition:transform .12s}
.save:active{transform:scale(.97)}
.acts{display:flex;gap:.6rem;margin-top:.6rem}
.act-frame{flex:1;padding:2.5px;border-radius:15px;box-shadow:0 4px 12px rgba(0,0,0,.18);
 background:#d99b16;
 background:repeating-linear-gradient(45deg,#d99b16 0 9px,#171410 9px 11px,#b23a2a 11px 20px,#171410 20px 22px,#1f7a4d 22px 31px,#171410 31px 33px)}
.act{display:flex;align-items:center;justify-content:center;gap:.45rem;color:#fff;font-weight:800;text-decoration:none;border-radius:12.5px;padding:.72rem;font-size:.95rem;transition:transform .12s}
.act:active{transform:scale(.97)}
.act.call{background:linear-gradient(135deg,#1f7a4d,#155c39)}
.act.email{background:linear-gradient(135deg,#b23a2a,#8e2c1f)}
.act svg{color:#fff}
.sect{font-size:.78rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin:1.35rem 0 .6rem}
.chips{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem .4rem}
.chip{display:flex;flex-direction:column;align-items:center;gap:.35rem;text-decoration:none;color:var(--ink)}
.chip-ring{padding:3px;border-radius:21px;box-shadow:0 5px 14px rgba(0,0,0,.22);transition:transform .12s;
 background:#d99b16;
 background:repeating-conic-gradient(#d99b16 0 18deg,#171410 18deg 24deg,#b23a2a 24deg 42deg,#171410 42deg 48deg,#1f7a4d 48deg 66deg,#171410 66deg 72deg)}
.chip-ic{width:54px;height:54px;border-radius:18px;display:flex;align-items:center;justify-content:center;border:2px solid var(--cream)}
.chip:active .chip-ring{transform:scale(.92)}
.chip-lb{font-size:.72rem;font-weight:700;color:var(--mut)}
.rows{display:flex;flex-direction:column;gap:.5rem}
.row{display:flex;flex-direction:column;gap:.15rem;background:#fff;border:1.5px solid #e6dcc6;border-radius:13px;padding:.65rem .85rem;text-decoration:none;color:var(--ink)}
.row:active{background:#f3ecd9}
.rk{display:flex;align-items:center;gap:.4rem;font-size:.75rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
.rk svg{width:15px;height:15px;color:var(--accent)}
.row b{font-size:.98rem;word-break:break-word}
.save.pay{background:var(--dark);color:#f2c14e;border:2px solid var(--accent);margin-top:.55rem;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.leadbox{background:#fff;border:1.5px solid #e6dcc6;border-radius:15px;padding:.8rem}
.leadbox input,.leadbox textarea{width:100%;border:1.5px solid #e6dcc6;border-radius:10px;padding:.62rem .7rem;font-size:.95rem;font-family:inherit;margin-bottom:.5rem;background:#fdfaf2;color:var(--ink)}
.leadbox input:focus,.leadbox textarea:focus{outline:none;border-color:var(--accent)}
.leadbox .save{width:100%;border:none;cursor:pointer;font-family:inherit}
.lmsg{margin-top:.5rem;font-size:.9rem;font-weight:700;text-align:center}
.lmsg.ok{color:#1f7a4d;padding:.8rem 0}
.lmsg.err{color:#b23a2a}
.foot{text-align:center;color:#8f8570;font-size:.8rem;margin-top:1.4rem}
.foot b{color:var(--accent)}
</style></head>
<body>
<div class="page">
  ${kenteBand("top")}
  <div class="hero">${logo}</div>
  <div class="sheet-frame"><div class="sheet">
    <div class="head">
      <div class="avatar-ring">${photo}</div>
      <h1>${name}</h1>
      ${title ? `<div class="ptitle">${title}</div>` : ""}
      ${company ? `<div class="pcompany">${company}</div>` : ""}
    </div>
    <a class="save" href="/c/${esc(c.slug)}/vcard.vcf">${ICONS.save} Save to Contacts</a>
    ${PRO && c.payment_url ? `<a class="save pay" href="/c/${esc(c.slug)}/go/pay" target="_blank" rel="noopener">&#128179; ${esc(vv(c.payment_label) || "Pay Me")}</a>` : ""}
    ${actions.length ? `<div class="acts">${actions.join("")}</div>` : ""}
    ${chips.length ? `<div class="sect">Connect with me</div><div class="chips">${chipHtml}</div>` : ""}
    ${rows.length ? `<div class="sect">Contact details</div><div class="rows">${rows.join("")}</div>` : ""}
    ${PRO ? `<div class="sect">Share your details back</div>
    <div class="leadbox">
      <input id="ln" maxlength="120" placeholder="Your name">
      <input id="lp" maxlength="40" placeholder="Phone / WhatsApp" inputmode="tel">
      <input id="le" maxlength="160" placeholder="Email (optional)" inputmode="email">
      <textarea id="lm" maxlength="500" rows="2" placeholder="Message (optional)"></textarea>
      <button id="lbtn" class="save" style="margin-top:.55rem">&#128233; Send my details to ${esc(c.first_name || "them")}</button>
      <div id="lmsg" class="lmsg" hidden></div>
    </div>` : ""}
    ${BIZ ? "" : `<div class="foot">Made with <a href="/" style="color:inherit;text-decoration:none"><b>HaloCard</b></a></div>`}
  </div></div>
  <div style="padding:16px 26px 0">${kenteBand("bot").replace('class="kente-band"','class="kente-band slim"')}</div>
</div>
${PRO ? `<script>
(function(){
  var b=document.getElementById('lbtn'),m=document.getElementById('lmsg');
  b.addEventListener('click',function(){
    var name=document.getElementById('ln').value.trim(),phone=document.getElementById('lp').value.trim();
    var email=document.getElementById('le').value.trim(),note=document.getElementById('lm').value.trim();
    if(!name&&!phone){m.hidden=false;m.textContent='Please enter your name or phone.';m.className='lmsg err';return;}
    b.disabled=true;b.textContent='Sending\u2026';
    fetch('/api/public/lead',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({slug:${JSON.stringify(c.slug)},name:name,phone:phone,email:email,note:note})})
    .then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)throw new Error(d.error||'error');});})
    .then(function(){document.querySelector('.leadbox').innerHTML='<div class="lmsg ok">&#10004; Sent! ${esc(c.first_name || "They")} now has your details.</div>';})
    .catch(function(e){b.disabled=false;b.textContent='\uD83D\uDCE9 Try again';m.hidden=false;m.textContent=e.message;m.className='lmsg err';});
  });
})();
</script>` : ""}
</body></html>`;
}

/* ---------- static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".map": "application/json" };
const PAGES = { "/": "home.html", "/login": "index.html", "/register": "index.html", "/app": "app.html", "/start": "landing.html" };
function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, "");
  const pubDir = path.join(__dirname, "public");
  const full = path.join(pubDir, rel);
  if (!full.startsWith(pubDir + path.sep)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>404</h1>"); }
    const type = MIME[path.extname(full)] || "application/octet-stream";
    /* html pages may carry a __BASE__ token so social crawlers get absolute og:image URLs */
    if (path.extname(full) === ".html") buf = Buffer.from(buf.toString().split("__BASE__").join(baseUrl(req)));
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length });
    res.end(req.method === "HEAD" ? undefined : buf);
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
  if (p === "/api/public/lead" && req.method === "POST" && !rateLimit(req, "lead", 6, 10 * 60 * 1000)) return json(res, 429, { error: "Too many submissions, please try again later." });

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
    /* tracked click-through: /c/<slug>/go/<kind> -> logs the tap, then redirects */
    const mGo = p.match(/^\/c\/([A-Za-z0-9-]+)\/go\/([a-z_]+)$/);
    if (req.method === "GET" && mGo) {
      const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(mGo[1]);
      if (!c || !c.active) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      const kind = mGo[2];
      const targets = {
        whatsapp: c.whatsapp ? "https://wa.me/" + String(c.whatsapp).replace(/[^\d]/g, "") : "",
        instagram: c.instagram ? socialUrl("instagram", c.instagram) : "",
        facebook: c.facebook ? socialUrl("facebook", c.facebook) : "",
        tiktok: c.tiktok ? socialUrl("tiktok", c.tiktok) : "",
        snapchat: c.snapchat ? socialUrl("snapchat", c.snapchat) : "",
        linkedin: c.linkedin ? socialUrl("linkedin", c.linkedin) : "",
        x_twitter: c.x_twitter ? socialUrl("x_twitter", c.x_twitter) : "",
        website: c.website ? socialUrl("website", c.website) : "",
        pay: c.payment_url && planAtLeast(ownerPlanForCard(c), "pro") ? socialUrl("website", c.payment_url) : "",
      };
      const target = targets[kind];
      if (!target || !/^https:\/\//i.test(target)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,?)").run(c.id, "click:" + kind);
      res.writeHead(302, { Location: target }); return res.end();
    }

    /* serve the card's photo/logo bytes (for WhatsApp/social link previews) */
    const mImg = p.match(/^\/c\/([A-Za-z0-9-]+)\/(photo|logo)$/);
    if (req.method === "GET" && mImg) {
      const c = db.prepare("SELECT photo,logo FROM cards WHERE slug=?").get(mImg[1]);
      const mm = /^data:(image\/[a-z+.\-]+);base64,(.+)$/.exec((c && c[mImg[2]]) || "");
      if (!mm) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": mm[1], "Cache-Control": "public, max-age=3600" });
      return res.end(Buffer.from(mm[2], "base64"));
    }

    /* Paystack webhook: auto-upgrade on successful payment */
    if (req.method === "POST" && p === "/api/paystack/webhook") {
      if (!PAYSTACK_SECRET_KEY) { res.writeHead(404); return res.end(); }
      const raw = await readBody(req);
      const sig = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(raw).digest("hex");
      if (!safeEqual(sig, String(req.headers["x-paystack-signature"] || ""))) { res.writeHead(401); return res.end(); }
      let ev; try { ev = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
      if (ev.event === "charge.success") {
        const md = (ev.data && ev.data.metadata) || {};
        const uid = Number(md.uid), plan = String(md.plan || "");
        if (uid && PLANS[plan] && plan !== "free") {
          const expires = new Date(Date.now() + BILLING_PERIOD_DAYS * 86400000).toISOString();
          db.prepare("UPDATE users SET plan=?, plan_expires=? WHERE id=?").run(plan, expires, uid);
          console.log(`billing: user ${uid} upgraded to ${plan} until ${expires}`);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}');
    }

    /* public: visitor shares their details back (lead capture) */
    if (req.method === "POST" && p === "/api/public/lead") {
      const b = await jread(req);
      const c = db.prepare("SELECT id,active,user_id FROM cards WHERE slug=?").get(String(b.slug || ""));
      if (!c || !c.active) return json(res, 404, { error: "card not found" });
      if (!planAtLeast(ownerPlanForCard(c), "pro")) return json(res, 403, { error: "lead capture is not enabled on this card" });
      const f = (v, n) => vv(v).slice(0, n);
      const name = f(b.name, 120), phone = f(b.phone, 40), email = f(b.email, 160), company = f(b.company, 120), note = f(b.note, 500);
      if (!name && !phone) return json(res, 400, { error: "enter a name or phone" });
      db.prepare("INSERT INTO leads(card_id,name,phone,email,company,note) VALUES (?,?,?,?,?,?)").run(c.id, name, phone, email, company, note);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'lead')").run(c.id);
      return json(res, 200, { ok: true });
    }

    const mProfile = p.match(/^\/c\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && mProfile) {
      const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(mProfile[1]);
      if (!c) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>Card not found</h1>"); }
      if (!c.active) { res.writeHead(410, { "Content-Type": "text/html" }); return res.end("<h1>This card is no longer active.</h1>"); }
      db.prepare("UPDATE cards SET scan_count=scan_count+1 WHERE id=?").run(c.id);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'scan')").run(c.id);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(profilePage(c, baseUrl(req), ownerPlanForCard(c)));
    }

    /* ---------- auth ---------- */
    if (req.method === "POST" && p === "/api/login") {
      const b = await jread(req);
      const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(b.email || "").trim().toLowerCase());
      if (!u || !checkPassword(String(b.password || ""), u.pass_hash, u.salt)) return json(res, 401, { error: "wrong email or password" });
      return json(res, 200, { token: signToken(u), email: u.email, role: u.role || "user", name: u.name || "" });
    }

    /* public self-registration */
    if (req.method === "POST" && p === "/api/register") {
      if (!rateLimit(req, "register", 5, 60 * 60 * 1000)) return json(res, 429, { error: "Too many sign-ups from this network, try later." });
      const b = await jread(req);
      const email = String(b.email || "").trim().toLowerCase();
      const name = vv(b.name).slice(0, 80);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "enter a valid email" });
      if (String(b.password || "").length < 8) return json(res, 400, { error: "password must be 8+ characters" });
      if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return json(res, 409, { error: "that email is already registered — sign in instead" });
      const salt = crypto.randomBytes(16).toString("hex");
      const r = db.prepare("INSERT INTO users(email,pass_hash,salt,role,name) VALUES (?,?,?,'user',?)").run(email, hashPassword(b.password, salt), salt, name);
      const u = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
      return json(res, 200, { token: signToken(u), email: u.email, role: "user", name: u.name || "" });
    }

    const me = bearer(req);
    const isAdmin = !!(me && me.role === "admin");
    if (req.method === "GET" && p === "/api/me") { if (!me) return json(res, 401, { error: "unauthorized" }); return json(res, 200, { email: me.email, name: me.name || "", role: me.role || "user", plan: planOf(me), plan_expires: me.plan_expires || null, app_url: baseUrl(req) }); }
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
      const W = isAdmin ? "" : " WHERE user_id=" + Number(me.id);
      const total = db.prepare("SELECT COUNT(*) n FROM cards" + W).get().n;
      const active = db.prepare("SELECT COUNT(*) n FROM cards" + (W ? W + " AND" : " WHERE") + " active=1").get().n;
      const scans = db.prepare("SELECT COALESCE(SUM(scan_count),0) s FROM cards" + W).get().s;
      const downloads = db.prepare("SELECT COALESCE(SUM(vcard_downloads),0) s FROM cards" + W).get().s;
      const leads = isAdmin
        ? db.prepare("SELECT COUNT(*) n FROM leads").get().n
        : db.prepare("SELECT COUNT(*) n FROM leads l JOIN cards c ON c.id=l.card_id WHERE c.user_id=?").get(me.id).n;
      return json(res, 200, { total, active, scans, downloads, leads, role: me.role || "user", app_url: baseUrl(req) });
    }

    if (p === "/api/cards") {
      if (!needAuth()) return;
      if (req.method === "GET") {
        const cards = isAdmin
          ? db.prepare(`SELECT c.id,c.slug,c.first_name,c.last_name,c.job_title,c.company,c.template,c.active,c.scan_count,c.vcard_downloads,c.updated_at,u.email owner
              FROM cards c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.updated_at DESC`).all()
          : db.prepare("SELECT id,slug,first_name,last_name,job_title,company,template,active,scan_count,vcard_downloads,updated_at FROM cards WHERE user_id=? ORDER BY updated_at DESC").all(me.id);
        return json(res, 200, { cards, app_url: baseUrl(req) });
      }
      if (req.method === "POST") {
        const b = await jread(req);
        if (!b.first_name && !b.last_name) return json(res, 400, { error: "a name is required" });
        let slug = String(b.slug || "").trim().toLowerCase();
        if (slug) {
          if (!isAdmin && !planAtLeast(planOf(me), "pro")) return json(res, 403, { error: "Custom links are a Pro feature. Upgrade to choose your own link.", upgrade: true });
          if (!SLUG_RE.test(slug)) return json(res, 400, { error: "link can use 3-40 lowercase letters, numbers and dashes" });
          if (slugTaken(slug)) return json(res, 409, { error: "that link is already taken" });
        } else slug = slugify(b.first_name, b.last_name);
        /* who owns this card */
        let ownerId = me.id;
        if (isAdmin && b.owner_email) {
          const ou = db.prepare("SELECT id FROM users WHERE email=?").get(String(b.owner_email).trim().toLowerCase());
          if (!ou) return json(res, 404, { error: "no user with that email — ask them to register first" });
          ownerId = ou.id;
        }
        if (!isAdmin) {
          const myPlan = planOf(me), lim = PLANS[myPlan].cards;
          const n = db.prepare("SELECT COUNT(*) n FROM cards WHERE user_id=?").get(me.id).n;
          if (n >= lim) return json(res, 403, { error: `Your ${PLANS[myPlan].label} plan allows ${lim} card${lim > 1 ? "s" : ""}. Upgrade to add more.`, upgrade: true });
        }
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        const sql = `INSERT INTO cards(slug,user_id,${cols.join(",")}) VALUES (?,?${",?".repeat(cols.length)})`;
        db.prepare(sql).run(slug, ownerId, ...cols.map((f) => b[f] ?? null));
        const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(slug);
        return json(res, 200, { ok: true, id: c.id, slug, url: baseUrl(req) + "/c/" + slug });
      }
    }

    /* ownership: users may only touch their own cards; admin touches all */
    const ownCard = (id) => {
      const c = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
      if (!c) return null;
      if (!isAdmin && c.user_id !== me.id) return null;
      return c;
    };

    const mCard = p.match(/^\/api\/cards\/(\d+)$/);
    if (mCard) {
      if (!needAuth()) return;
      const id = Number(mCard[1]);
      if (req.method === "GET") { const c = ownCard(id); return c ? json(res, 200, { card: c, url: baseUrl(req) + "/c/" + c.slug }) : json(res, 404, { error: "not found" }); }
      if (req.method === "PUT") {
        if (!ownCard(id)) return json(res, 404, { error: "not found" });
        const b = await jread(req);
        const newSlug = String(b.slug || "").trim().toLowerCase();
        const curSlug = db.prepare("SELECT slug FROM cards WHERE id=?").get(id).slug;
        if (newSlug && newSlug !== curSlug) {
          if (!isAdmin && !planAtLeast(planOf(me), "pro")) return json(res, 403, { error: "Custom links are a Pro feature. Upgrade to choose your own link.", upgrade: true });
          if (!SLUG_RE.test(newSlug)) return json(res, 400, { error: "link can use 3-40 lowercase letters, numbers and dashes" });
          if (slugTaken(newSlug, id)) return json(res, 409, { error: "that link is already taken" });
          db.prepare("UPDATE cards SET slug=? WHERE id=?").run(newSlug, id);
        }
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        if (cols.length) db.prepare(`UPDATE cards SET ${cols.map((f) => f + "=?").join(",")}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((f) => b[f] ?? null), id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") { if (!ownCard(id)) return json(res, 404, { error: "not found" }); db.prepare("DELETE FROM cards WHERE id=?").run(id); db.prepare("DELETE FROM events WHERE card_id=?").run(id); db.prepare("DELETE FROM leads WHERE card_id=?").run(id); return json(res, 200, { ok: true }); }
    }

    /* billing */
    if (req.method === "GET" && p === "/api/billing/plans") {
      if (!needAuth()) return;
      return json(res, 200, {
        plans: Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { label: v.label, cards: v.cards, price: v.price }])),
        period_days: BILLING_PERIOD_DAYS,
        current: planOf(me), expires: me.plan_expires || null,
        paystack: !!PAYSTACK_SECRET_KEY, manual_url: PAYSTACK_UPGRADE_URL || null,
      });
    }
    if (req.method === "POST" && p === "/api/billing/init") {
      if (!needAuth()) return;
      const b = await jread(req);
      const plan = String(b.plan || "");
      if (!PLANS[plan] || plan === "free") return json(res, 400, { error: "unknown plan" });
      if (!PAYSTACK_SECRET_KEY) {
        return json(res, 200, { manual: true, url: PAYSTACK_UPGRADE_URL || null,
          note: "Online billing is not configured. Pay via the payment page (or contact the admin) and your account will be upgraded manually." });
      }
      try {
        const r = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST",
          headers: { Authorization: "Bearer " + PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            email: me.email,
            amount: Math.round(PLANS[plan].price * 100), /* pesewas */
            currency: "GHS",
            metadata: { uid: me.id, plan },
            callback_url: baseUrl(req) + "/app",
          }),
        });
        const d = await r.json();
        if (!d.status || !d.data?.authorization_url) return json(res, 502, { error: d.message || "could not start payment" });
        return json(res, 200, { url: d.data.authorization_url });
      } catch { return json(res, 502, { error: "payment service unreachable, try again shortly" }); }
    }

    /* admin: user management */
    if (req.method === "GET" && p === "/api/admin/users") {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const users = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.plan,u.plan_expires,u.created_at,
          (SELECT COUNT(*) FROM cards c WHERE c.user_id=u.id) cards
        FROM users u ORDER BY u.created_at DESC LIMIT 1000`).all();
      return json(res, 200, { users: users.map((u) => ({ ...u, effective: planOf(u) })) });
    }
    const mUserDel = p.match(/^\/api\/admin\/users\/(\d+)$/);
    if (req.method === "DELETE" && mUserDel) {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const uid = Number(mUserDel[1]);
      const u = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
      if (!u) return json(res, 404, { error: "not found" });
      if (u.role === "admin") return json(res, 403, { error: "admin accounts cannot be deleted" });
      for (const c of db.prepare("SELECT id FROM cards WHERE user_id=?").all(uid)) {
        db.prepare("DELETE FROM events WHERE card_id=?").run(c.id);
        db.prepare("DELETE FROM leads WHERE card_id=?").run(c.id);
      }
      db.prepare("DELETE FROM cards WHERE user_id=?").run(uid);
      db.prepare("DELETE FROM users WHERE id=?").run(uid);
      return json(res, 200, { ok: true });
    }

    const mUserPlan = p.match(/^\/api\/admin\/users\/(\d+)\/plan$/);
    if (req.method === "PUT" && mUserPlan) {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const b = await jread(req);
      const plan = String(b.plan || "");
      if (!PLANS[plan]) return json(res, 400, { error: "unknown plan" });
      const expires = plan === "free" ? null : new Date(Date.now() + BILLING_PERIOD_DAYS * 86400000).toISOString();
      db.prepare("UPDATE users SET plan=?, plan_expires=? WHERE id=?").run(plan, expires, Number(mUserPlan[1]));
      return json(res, 200, { ok: true, plan, expires });
    }

    /* leads inbox */
    if (req.method === "GET" && p === "/api/leads") {
      if (!needAuth()) return;
      const leads = isAdmin
        ? db.prepare(`SELECT l.*, c.first_name cf, c.last_name cl, c.slug cslug
            FROM leads l LEFT JOIN cards c ON c.id=l.card_id ORDER BY l.at DESC LIMIT 500`).all()
        : db.prepare(`SELECT l.*, c.first_name cf, c.last_name cl, c.slug cslug
            FROM leads l JOIN cards c ON c.id=l.card_id WHERE c.user_id=? ORDER BY l.at DESC LIMIT 500`).all(me.id);
      return json(res, 200, { leads });
    }
    const mLead = p.match(/^\/api\/leads\/(\d+)$/);
    if (req.method === "DELETE" && mLead) {
      if (!needAuth()) return;
      const lid = Number(mLead[1]);
      if (!isAdmin) {
        const owns = db.prepare("SELECT l.id FROM leads l JOIN cards c ON c.id=l.card_id WHERE l.id=? AND c.user_id=?").get(lid, me.id);
        if (!owns) return json(res, 404, { error: "not found" });
      }
      db.prepare("DELETE FROM leads WHERE id=?").run(lid);
      return json(res, 200, { ok: true });
    }

    /* per-card analytics: totals, per-link taps, last-30-day scan/save series */
    const mStats = p.match(/^\/api\/cards\/(\d+)\/analytics$/);
    if (req.method === "GET" && mStats) {
      if (!needAuth()) return;
      const id = Number(mStats[1]);
      const c = ownCard(id);
      if (!c) return json(res, 404, { error: "not found" });
      if (!isAdmin && !planAtLeast(planOf(me), "pro")) return json(res, 403, { error: "Analytics is a Pro feature. Upgrade to see your 30-day chart and link taps.", upgrade: true });
      const leads = db.prepare("SELECT COUNT(*) n FROM leads WHERE card_id=?").get(id).n;
      const clicks = {};
      for (const r of db.prepare("SELECT type, COUNT(*) n FROM events WHERE card_id=? AND type LIKE 'click:%' GROUP BY type").all(id))
        clicks[r.type.slice(6)] = r.n;
      const days = db.prepare(`SELECT substr(at,1,10) d,
          SUM(CASE WHEN type='scan' THEN 1 ELSE 0 END) scans,
          SUM(CASE WHEN type='vcard' THEN 1 ELSE 0 END) saves,
          SUM(CASE WHEN type='lead' THEN 1 ELSE 0 END) leads
        FROM events WHERE card_id=? AND at >= date('now','-29 days') GROUP BY d ORDER BY d`).all(id);
      return json(res, 200, { scans: c.scan_count, saves: c.vcard_downloads, leads, clicks, days });
    }

    const mToggle = p.match(/^\/api\/cards\/(\d+)\/toggle$/);
    if (req.method === "POST" && mToggle) {
      if (!needAuth()) return;
      db.prepare("UPDATE cards SET active = 1 - active, updated_at=datetime('now') WHERE id=?").run(Number(mToggle[1]));
      const c = ownCard(Number(mToggle[1]));
      return json(res, 200, { ok: true, active: !!c?.active });
    }

    if (req.method === "POST" && p === "/api/cards/bulk") {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "bulk import is admin-only" });
      const b = await jread(req);
      const rows = Array.isArray(b.rows) ? b.rows : [];
      let made = 0;
      for (const r of rows.slice(0, 1000)) {
        if (!r.first_name && !r.last_name && !r.name) continue;
        let first = r.first_name, last = r.last_name;
        if (!first && r.name) { const parts = String(r.name).trim().split(/\s+/); first = parts.shift(); last = parts.join(" "); }
        const slug = slugify(first, last);
        db.prepare("INSERT INTO cards(slug,user_id,first_name,last_name,job_title,company,mobile,email,template) VALUES (?," + Number(me.id) + ",?,?,?,?,?,?,?)")
          .run(slug, first || "", last || "", r.position || r.job_title || "", r.company || "", r.phone || r.mobile || "", r.email || "", b.template || "corporate");
        made++;
      }
      return json(res, 200, { ok: true, created: made });
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
    return json(res, 404, { error: "not found" });
  } catch (e) { console.error("ERR", p, e); return json(res, 500, { error: e.message || "server error" }); }
});

server.listen(PORT, () => console.log(`HaloCard on :${PORT}  (data: ${DATA_DIR})`));
