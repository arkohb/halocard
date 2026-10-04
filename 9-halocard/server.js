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
/* APP_URL goes inside every QR code, so it must be a full https:// link —
   without the scheme, phone scanners show the text with "Copy" instead of an "Open" link */
function normalizeAppUrl(v) {
  v = String(v || "").trim().replace(/\/+$/, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  if (/^http:\/\//i.test(v) && !/^http:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(v)) v = "https://" + v.slice(7);
  return v;
}
const APP_URL = normalizeAppUrl(process.env.APP_URL);
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
CREATE TABLE IF NOT EXISTS payments(
  reference TEXT PRIMARY KEY, user_id INTEGER, plan TEXT, amount INTEGER, currency TEXT,
  source TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL,
  name TEXT, phone TEXT, email TEXT, company TEXT, note TEXT,
  at TEXT DEFAULT (datetime('now')));
`);
/* lightweight migration: columns added after v1 (safe to re-run) */
for (const col of ["tiktok", "snapchat", "payment_url", "payment_label", "extras"]) {
  try { db.exec(`ALTER TABLE cards ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN name TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN plan_expires TEXT"); } catch {}
try { db.exec("ALTER TABLE cards ADD COLUMN user_id INTEGER"); } catch {}
/* leads: follow-up status, private notes, unread flag */
try { db.exec("ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'new'"); } catch {}
try { db.exec("ALTER TABLE leads ADD COLUMN notes TEXT"); } catch {}
try { db.exec("ALTER TABLE leads ADD COLUMN seen INTEGER DEFAULT 0"); } catch {}
/* teams, events, referrals, reports */
for (const sql of [
  "ALTER TABLE users ADD COLUMN team_id INTEGER", "ALTER TABLE users ADD COLUMN ref_code TEXT",
  "ALTER TABLE users ADD COLUMN referred_by INTEGER", "ALTER TABLE users ADD COLUMN ref_rewarded INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN report_opt_out INTEGER DEFAULT 0",
  "ALTER TABLE cards ADD COLUMN team_id INTEGER", "ALTER TABLE leads ADD COLUMN event TEXT",
]) { try { db.exec(sql); } catch {} }
db.exec(`CREATE TABLE IF NOT EXISTS teams(
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER UNIQUE NOT NULL, name TEXT, company TEXT,
  logo TEXT, accent TEXT, template TEXT, theme TEXT, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS team_invites(email TEXT PRIMARY KEY, team_id INTEGER, card_id INTEGER, at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`);
/* physical NFC card orders */
db.exec(`CREATE TABLE IF NOT EXISTS nfc_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, card_id INTEGER,
  material TEXT, qty INTEGER, name_on_card TEXT, phone TEXT, address TEXT, city TEXT, region TEXT, note TEXT,
  amount REAL, status TEXT DEFAULT 'awaiting_payment', reference TEXT, tracking TEXT,
  at TEXT DEFAULT (datetime('now')), paid_at TEXT)`);
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
function planOf(u, depth = 0) {
  if (!u) return "free";
  if (u.role === "admin") return "business";
  if (u.team_id && depth === 0) {
    const t = db.prepare("SELECT owner_id FROM teams WHERE id=?").get(u.team_id);
    const owner = t && t.owner_id !== u.id ? db.prepare("SELECT * FROM users WHERE id=?").get(t.owner_id) : null;
    if (owner && planOf(owner, 1) === "business") return "business";
  }
  let p = PLANS[u.plan] ? u.plan : "free";
  if (p !== "free" && u.plan_expires && Date.parse(u.plan_expires) < Date.now()) p = "free";
  return p;
}
const planAtLeast = (p, min) => ({ free: 0, pro: 1, business: 2 }[p] >= { free: 0, pro: 1, business: 2 }[min]);
const PLAN_RANK = { free: 0, pro: 1, business: 2 };
/* physical NFC cards (prices in GHS; override in Railway variables) */
const NFC_PRODUCTS = {
  pvc:   { label: "Kente PVC NFC card",   price: Number(process.env.PRICE_NFC_PVC || 250) },
  metal: { label: "Black & gold metal NFC card", price: Number(process.env.PRICE_NFC_METAL || 400) },
};
const NFC_DELIVERY_GHS = Number(process.env.NFC_DELIVERY_GHS || 0);
const ORDER_STATUSES = ["awaiting_payment", "paid", "printing", "shipped", "delivered", "cancelled"];
const LEAD_STATUSES = ["new", "contacted", "won", "lost"];
/* Apply a Paystack transaction exactly once. Used by BOTH the webhook and the
   return-from-checkout verify call, so a missing/misrouted webhook can't strand a payer. */
/* referral programme: when someone you invited pays for a plan, you get REFERRAL_REWARD_DAYS of Pro (or extra time) */
const REFERRAL_REWARD_DAYS = Number(process.env.REFERRAL_REWARD_DAYS || 30);
function rewardReferrer(uid) {
  const u = db.prepare("SELECT referred_by, ref_rewarded FROM users WHERE id=?").get(uid);
  if (!u || !u.referred_by || u.ref_rewarded) return;
  const r = db.prepare("SELECT * FROM users WHERE id=?").get(u.referred_by);
  db.prepare("UPDATE users SET ref_rewarded=1 WHERE id=?").run(uid);
  if (!r || r.role === "admin") return;
  const add = REFERRAL_REWARD_DAYS * 86400000, cur = planOf(r, 1);
  const base = r.plan_expires && Date.parse(r.plan_expires) > Date.now() && cur !== "free" ? Date.parse(r.plan_expires) : Date.now();
  db.prepare("UPDATE users SET plan=?, plan_expires=? WHERE id=?").run(cur === "free" ? "pro" : r.plan, new Date(base + add).toISOString(), r.id);
  console.log(`referrals: user ${r.id} rewarded ${REFERRAL_REWARD_DAYS} days for referring user ${uid}`);
  sendEmail(r.email, "You earned a free month of HaloCard Pro 🎁", `<p>Someone you invited just upgraded their HaloCard. We've added <b>${REFERRAL_REWARD_DAYS} days of ${cur === "free" ? "Pro" : esc(r.plan)}</b> to your account. Thank you for spreading the word!</p>`);
}
function refCodeFor(uid) {
  let u = db.prepare("SELECT ref_code FROM users WHERE id=?").get(uid);
  if (u && u.ref_code) return u.ref_code;
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
    if (code.length === 6 && !db.prepare("SELECT 1 FROM users WHERE ref_code=?").get(code)) { db.prepare("UPDATE users SET ref_code=? WHERE id=?").run(code, uid); return code; }
  }
  return "";
}

/* ---------- teams: one brand for every staff card ---------- */
const teamOwnedBy = (uid) => db.prepare("SELECT * FROM teams WHERE owner_id=?").get(uid);
function applyTeamBrand(cardId) {
  const c = db.prepare("SELECT id, team_id, extras FROM cards WHERE id=?").get(cardId);
  if (!c || !c.team_id) return;
  const t = db.prepare("SELECT * FROM teams WHERE id=?").get(c.team_id);
  if (!t) return;
  const x = cleanExtras(c.extras); if (t.theme) x.theme = t.theme;
  db.prepare(`UPDATE cards SET company=COALESCE(NULLIF(?,''),company), logo=COALESCE(?,logo), accent=COALESCE(?,accent),
    template=COALESCE(?,template), extras=? WHERE id=?`).run(t.company || "", t.logo || null, t.accent || null, t.template || null, JSON.stringify(x), c.id);
}

/* ---------- monthly scan report (email) ---------- */
function reportHtml(u, from, to, label, base) {
  const cards = db.prepare("SELECT id, slug, first_name, last_name FROM cards WHERE user_id=? OR team_id IN (SELECT id FROM teams WHERE owner_id=?)").all(u.id, u.id);
  if (!cards.length) return null;
  let tot = { scan: 0, vcard: 0, lead: 0 }; const rows = [];
  for (const c of cards) {
    const e = {}; for (const r of db.prepare("SELECT type, COUNT(*) n FROM events WHERE card_id=? AND at>=? AND at<? GROUP BY type").all(c.id, from, to)) e[r.type] = r.n;
    const taps = db.prepare("SELECT COUNT(*) n FROM events WHERE card_id=? AND at>=? AND at<? AND type LIKE 'click:%'").get(c.id, from, to).n;
    tot.scan += e.scan || 0; tot.vcard += e.vcard || 0; tot.lead += e.lead || 0;
    rows.push(`<tr><td style="padding:6px 8px">${esc(fullName(c) || c.slug)}</td><td align="center">${e.scan || 0}</td><td align="center">${e.vcard || 0}</td><td align="center">${e.lead || 0}</td><td align="center">${taps}</td></tr>`);
  }
  const box = (k, v, col) => `<td style="background:#fdf6e6;border-radius:10px;padding:12px;text-align:center"><div style="font-size:26px;font-weight:bold;color:${col}">${v}</div><div style="font-size:12px;color:#6b6256">${k}</div></td>`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #eee2c5;border-radius:14px;overflow:hidden">
  <div style="background:#171410;color:#f2c14e;padding:14px 18px;font-size:18px;font-weight:bold">HaloCard &middot; Your ${esc(label)} report</div>
  <div style="padding:16px 18px;color:#171410"><p style="margin:0 0 12px">Hi ${esc(u.name || "there")}, here's how your cards did:</p>
  <table width="100%" cellspacing="6"><tr>${box("Scans", tot.scan, "#b07a0c")}${box("Contacts saved", tot.vcard, "#1f7a4d")}${box("Leads", tot.lead, "#b23a2a")}</tr></table>
  <table width="100%" style="font-size:14px;margin-top:10px;border-collapse:collapse"><tr style="color:#6b6256;font-size:12px"><td style="padding:6px 8px">Card</td><td align="center">Scans</td><td align="center">Saved</td><td align="center">Leads</td><td align="center">Link taps</td></tr>${rows.join("")}</table>
  <p style="margin:16px 0 0">${tot.lead ? `You have leads waiting — <a href="${esc(base)}/app" style="color:#b07a0c">follow up now</a>.` : `Tip: share your card link on your WhatsApp status to get more scans.`}</p>
  <p style="font-size:12px;color:#8f8570;margin-top:14px">Don't want these? Turn off monthly reports in HaloCard &rarr; Account.</p></div></div>`;
}
async function sendMonthlyReports(force) {
  if (!RESEND_API_KEY) return 0;
  const now = new Date();
  if (!force && now.getUTCDate() !== 1) return 0;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const key = "report_" + start.toISOString().slice(0, 7);
  if (db.prepare("SELECT 1 FROM meta WHERE k=?").get(key)) return 0;
  db.prepare("INSERT INTO meta(k,v) VALUES (?,?)").run(key, new Date().toISOString());
  const label = start.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const sql = (d) => d.toISOString().slice(0, 19).replace("T", " ");
  let n = 0;
  for (const u of db.prepare("SELECT * FROM users WHERE COALESCE(report_opt_out,0)=0").all()) {
    const html = reportHtml(u, sql(start), sql(end), label, APP_URL || "");
    if (html && await sendEmail(u.email, `Your HaloCard report — ${label}`, html)) n++;
  }
  console.log(`reports: sent ${n} monthly reports for ${label}`);
  return n;
}
setInterval(() => { sendMonthlyReports(false).catch((e) => console.warn("reports:", e.message)); }, 60 * 60 * 1000).unref();

/* ---------- Google Wallet pass (needs a Google Wallet issuer account) ---------- */
const GW_ISSUER = process.env.GOOGLE_WALLET_ISSUER_ID || "";
const GW_SA_EMAIL = process.env.GOOGLE_WALLET_SA_EMAIL || "";
const GW_KEY = (process.env.GOOGLE_WALLET_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const googleWalletOn = () => !!(GW_ISSUER && GW_SA_EMAIL && GW_KEY);
function googleWalletUrl(c, base) {
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const url = `${base}/c/${c.slug}`, classId = `${GW_ISSUER}.halocard_contact`;
  const img = c.photo ? `${base}/c/${c.slug}/photo` : c.logo ? `${base}/c/${c.slug}/logo` : `${base}/icons/icon-512.png`;
  const t = (v) => ({ defaultValue: { language: "en", value: String(v || " ") } });
  const obj = {
    id: `${GW_ISSUER}.hc_${String(c.slug).replace(/[^\w.-]/g, "_")}`, classId, state: "ACTIVE",
    hexBackgroundColor: "#171410", logo: { sourceUri: { uri: img } },
    cardTitle: t(c.company || "HaloCard"), header: t(fullName(c) || "My card"), subheader: t(c.job_title || "Digital business card"),
    barcode: { type: "QR_CODE", value: url, alternateText: "Scan to open my card" },
    textModulesData: [c.mobile && { id: "phone", header: "Phone", body: c.mobile }, c.email && { id: "email", header: "Email", body: c.email }].filter(Boolean),
    linksModuleData: { uris: [{ uri: url, description: "Open my HaloCard", id: "card" }] },
  };
  const claims = { iss: GW_SA_EMAIL, aud: "google", typ: "savetowallet", iat: Math.floor(Date.now() / 1000), origins: [base],
    payload: { genericClasses: [{ id: classId }], genericObjects: [obj] } };
  const head = b64({ alg: "RS256", typ: "JWT" }) + "." + b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(head), GW_KEY).toString("base64url");
  return "https://pay.google.com/gp/v/save/" + head + "." + sig;
}

function applyOrderPayment(tx, source) {
  const md = tx.metadata || {}, ref = String(tx.reference || "");
  const o = db.prepare("SELECT * FROM nfc_orders WHERE id=?").get(Number(md.order_id));
  if (!o) return { ok: false, reason: "order not found" };
  if (Number(md.uid) !== o.user_id) return { ok: false, reason: "order belongs to another account" };
  if (String(tx.currency || "").toUpperCase() !== "GHS") return { ok: false, reason: "wrong currency" };
  if (!(Number(tx.amount) >= Math.round(o.amount * 100))) return { ok: false, reason: "amount paid is less than the order total" };
  if (db.prepare("SELECT 1 FROM payments WHERE reference=?").get(ref)) return { ok: true, already: true, kind: "nfc", order: o.id };
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO payments(reference,user_id,plan,amount,currency,source) VALUES (?,?,?,?,?,?)").run(ref, o.user_id, "nfc", Number(tx.amount), "GHS", source);
    db.prepare("UPDATE nfc_orders SET status='paid', reference=?, paid_at=datetime('now') WHERE id=? AND status='awaiting_payment'").run(ref, o.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); if (/UNIQUE|PRIMARY/i.test(String(e))) return { ok: true, already: true, kind: "nfc" }; throw e; }
  console.log(`orders: NFC order #${o.id} paid (${ref}, via ${source})`);
  const admin = db.prepare("SELECT email FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (admin) sendEmail(admin.email, `New NFC card order #${o.id} (${o.qty} × ${o.material})`,
    `<p>Order <b>#${o.id}</b> is paid: ${o.qty} × ${esc(o.material)} — GHS ${o.amount}.</p><p>Name on card: <b>${esc(o.name_on_card)}</b><br>Deliver to: ${esc([o.address, o.city, o.region].filter(Boolean).join(", "))}<br>Phone: ${esc(o.phone)}</p>`);
  return { ok: true, kind: "nfc", order: o.id };
}
function applyPayment(tx, source) {
  if (!tx || tx.status !== "success") return { ok: false, reason: "payment not successful" };
  if (tx.metadata && tx.metadata.kind === "nfc") return applyOrderPayment(tx, source);
  const ref = String(tx.reference || "");
  const md = tx.metadata || {};
  const uid = Number(md.uid), plan = String(md.plan || "");
  if (!ref || !uid || !PLANS[plan] || plan === "free") return { ok: false, reason: "not a HaloCard plan payment" };
  if (String(tx.currency || "").toUpperCase() !== "GHS") return { ok: false, reason: "wrong currency" };
  const need = Math.round(PLANS[plan].price * 100);
  if (!(Number(tx.amount) >= need)) {
    console.warn(`billing: REJECTED ${ref} — paid ${tx.amount} pesewas, ${plan} costs ${need}`);
    return { ok: false, reason: "amount paid is less than the plan price" };
  }
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  if (!u) return { ok: false, reason: "user not found" };
  if (db.prepare("SELECT 1 FROM payments WHERE reference=?").get(ref)) return { ok: true, already: true, plan: planOf(u), expires: u.plan_expires };
  const cur = planOf(u);
  const curExp = u.plan_expires ? Date.parse(u.plan_expires) : 0;
  const period = BILLING_PERIOD_DAYS * 86400000;
  let newPlan = plan, expires;
  if (PLAN_RANK[cur] > PLAN_RANK[plan] && (u.role === "admin" || curExp > Date.now())) {
    newPlan = u.plan; expires = u.plan_expires;                      /* paid for a lower plan while on a higher one: never downgrade */
    console.warn(`billing: user ${uid} on ${cur} paid for ${plan} (${ref}) — plan left unchanged, consider a refund`);
  } else {
    const from = (cur === plan && curExp > Date.now()) ? curExp : Date.now(); /* early renewal keeps the remaining days */
    expires = new Date(Math.max(from + period, curExp || 0)).toISOString(); /* upgrading never shortens time already paid for */
  }
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO payments(reference,user_id,plan,amount,currency,source) VALUES (?,?,?,?,?,?)").run(ref, uid, plan, Number(tx.amount), "GHS", source);
    db.prepare("UPDATE users SET plan=?, plan_expires=? WHERE id=?").run(newPlan, expires, uid);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); if (/UNIQUE|PRIMARY/i.test(String(e))) return { ok: true, already: true }; throw e; }
  console.log(`billing: user ${uid} paid ${plan} (${ref}, via ${source}) -> ${newPlan} until ${expires}`);
  rewardReferrer(uid);
  return { ok: true, plan: newPlan, expires };
}
async function paystackVerify(reference) {
  const r = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + PAYSTACK_SECRET_KEY },
  });
  const d = await r.json();
  if (!d.status || !d.data) throw new Error(d.message || "could not verify payment");
  return d.data;
}
/* Pay Me links: https only, and only real payment providers (stops "Pay Me" phishing links) */
const PAY_HOSTS = (process.env.PAY_LINK_HOSTS ||
  "paystack.com,paystack.shop,flutterwave.com,flw.me,hubtel.com,mtn.com.gh,momo.mtn.com,expresspaygh.com,theteller.net,paypal.com,paypal.me,selar.co,selar.com")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
function cleanPayUrl(v) {
  v = vv(v).replace(/\s+/g, "");
  if (!v) return "";
  if (/^http:\/\//i.test(v)) v = "https://" + v.slice(7);
  if (!/^https:\/\//i.test(v)) v = "https://" + v;
  let u; try { u = new URL(v); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !PAY_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
  return u.toString();
}
/* ---------- business-profile extras (stored as one JSON column) ---------- */
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const THEMES = ["kente", "adinkra", "executive"];
const httpsUrl = (v, max = 400) => { v = vv(v).replace(/\s+/g, "").slice(0, max); if (!v) return ""; if (/^http:\/\//i.test(v)) v = "https://" + v.slice(7); if (!/^https:\/\//i.test(v)) v = "https://" + v; try { const u = new URL(v); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; } };
const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : "");
function cleanExtras(x) {
  if (typeof x === "string") { try { x = JSON.parse(x || "{}"); } catch { x = {}; } }
  if (!x || typeof x !== "object") x = {};
  const out = {
    wa_message: vv(x.wa_message).slice(0, 300),
    booking_url: httpsUrl(x.booking_url), review_url: httpsUrl(x.review_url),
    maps_url: httpsUrl(x.maps_url), video_url: httpsUrl(x.video_url),
    theme: THEMES.includes(x.theme) ? x.theme : "kente",
    hours: {}, menu: [], menu_title: vv(x.menu_title).slice(0, 40),
    event_name: vv(x.event_name).slice(0, 80), event_place: vv(x.event_place).slice(0, 80),
    event_until: /^\d{4}-\d{2}-\d{2}$/.test(String(x.event_until || "")) ? String(x.event_until) : "",
  };
  const h = x.hours && typeof x.hours === "object" ? x.hours : {};
  for (const d of DAYS) {
    const e = h[d] || {};
    out.hours[d] = { closed: !!e.closed, o: hhmm(e.o), c: hhmm(e.c) };
  }
  out.has_hours = DAYS.some((d) => out.hours[d].closed || (out.hours[d].o && out.hours[d].c));
  for (const it of Array.isArray(x.menu) ? x.menu.slice(0, 30) : []) {
    const name = vv(it && it.name).slice(0, 80);
    if (!name) continue;
    const price = Number(String(it.price ?? "").replace(/[^\d.]/g, ""));
    out.menu.push({ name, price: isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null, desc: vv(it.desc).slice(0, 200) });
  }
  return out;
}
const extrasOf = (c) => cleanExtras(c && c.extras);
/* event mode is on while the event name is set and the end date (if any) hasn't passed */
const activeEvent = (x) => (x.event_name && (!x.event_until || x.event_until >= new Date().toISOString().slice(0, 10)) ? x.event_name : "");
/* YouTube link -> privacy-friendly embed URL (other video links open in a new tab) */
function youtubeEmbed(u) {
  const m = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,15})/.exec(u || "");
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : "";
}
/* open/closed right now — Ghana time (Africa/Accra = UTC+0) */
function openNow(hours) {
  const now = new Date();
  const d = DAYS[(now.getUTCDay() + 6) % 7];
  const e = hours && hours[d];
  if (!e || e.closed || !e.o || !e.c) return { open: false, today: e };
  const t = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [oh, om] = e.o.split(":").map(Number), [ch, cm] = e.c.split(":").map(Number);
  const o = oh * 60 + om, c = ch * 60 + cm;
  return { open: c > o ? t >= o && t < c : t >= o || t < c, today: e };
}

/* ---------- email (Resend) for new-lead alerts ---------- */
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "HaloCard <onboarding@resend.dev>";
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
    if (!r.ok) console.warn("email: resend responded", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.warn("email: failed", e.message); return false; }
}
function leadEmailHtml(card, lead, base) {
  const wa = lead.phone ? "https://wa.me/" + String(lead.phone).replace(/[^\d]/g, "").replace(/^0/, "233") +
    "?text=" + encodeURIComponent(`Hi ${lead.name || ""}, thanks for connecting with ${fullName(card) || "me"} via HaloCard. `) : "";
  const row = (k, v) => (v ? `<tr><td style="padding:4px 10px 4px 0;color:#6b6256">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>` : "");
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #eee2c5;border-radius:14px;overflow:hidden">
  <div style="background:#171410;color:#f2c14e;padding:14px 18px;font-size:18px;font-weight:bold">HaloCard &middot; New lead</div>
  <div style="padding:16px 18px;color:#171410">
    <p style="margin:0 0 10px">Someone shared their details from your card <b>${esc(fullName(card))}</b>:</p>
    <table style="font-size:15px">${row("Name", lead.name)}${row("Phone", lead.phone)}${row("Email", lead.email)}${row("Company", lead.company)}${row("Message", lead.note)}</table>
    ${wa ? `<p style="margin:18px 0 6px"><a href="${wa}" style="background:#25D366;color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:bold">Reply on WhatsApp</a></p>` : ""}
    <p style="margin:14px 0 0"><a href="${esc(base)}/app" style="color:#b07a0c">Open your leads inbox</a></p>
  </div></div>`;
}

const PAY_URL_ERROR = "Payment link must be a Paystack, Flutterwave, Hubtel, MTN MoMo, ExpressPay, Theteller, PayPal or Selar link (e.g. https://paystack.shop/pay/yourpage).";
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
  "img-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
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
function readRaw(req) {
  return new Promise((resolve) => {
    const parts = []; let len = 0, done = false;
    req.on("data", (c) => { if (done) return; len += c.length; if (len > MAX_BODY) { done = true; try { req.destroy(); } catch {} return resolve(Buffer.alloc(0)); } parts.push(c); });
    req.on("end", () => { if (!done) resolve(Buffer.concat(parts)); });
    req.on("error", () => { if (!done) { done = true; resolve(Buffer.alloc(0)); } });
  });
}
const jread = async (req) => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } };
function json(res, code, obj) { if (res.writableEnded || res.destroyed) return; try { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); } catch {} }
function baseUrl(req) {
  if (APP_URL) return APP_URL;
  const host = String(req.headers.host || "");
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host);
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (local ? "http" : "https");
  return proto + "://" + host;
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function slugify(first, last) {
  const base = (String(first || "") + "-" + String(last || "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "card";
  return base + "-" + crypto.randomBytes(3).toString("hex");
}
const CARD_FIELDS = ["first_name","last_name","middle_name","job_title","company","mobile","secondary","email","website","address","city","country","linkedin","x_twitter","facebook","instagram","whatsapp","tiktok","snapchat","payment_url","payment_label","photo","logo","template","slogan","accent","extras"];
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
  const ph = /^data:image\/(jpe?g|png);base64,([A-Za-z0-9+/=]+)$/i.exec(c.photo || "");
  if (ph && ph[2].length < 400000) {
    /* vCard 3.0 inline photo, folded to 75-char lines as the spec requires */
    const line = `PHOTO;ENCODING=b;TYPE=${/png/i.test(ph[1]) ? "PNG" : "JPEG"}:` + ph[2];
    L.push(line.match(/.{1,74}/g).join("\r\n "));
  }
  L.push("END:VCARD");
  return L.join("\r\n");
}

/* Android "insert contact" intent: opens the Contacts app's new-contact screen with the details filled in.
   If no app handles it, Chrome follows browser_fallback_url (the vCard). */
function androidContactIntent(c, base) {
  const x = [];
  const add = (k, v) => { v = vv(v); if (v) x.push(`S.${k}=${encodeURIComponent(v)}`); };
  add("name", fullName(c));
  add("company", c.company);
  add("job_title", c.job_title);
  add("phone", c.mobile || c.whatsapp);
  if (c.mobile || c.whatsapp) x.push("i.phone_type=2"); /* mobile */
  if (c.secondary) { add("secondary_phone", c.secondary); x.push("i.secondary_phone_type=3"); /* work */ }
  add("email", c.email);
  add("postal", [c.address, c.city, c.country].filter(Boolean).join(", "));
  add("notes", [c.website ? socialUrl("website", c.website) : "", `${base}/c/${c.slug}`].filter(Boolean).join("\n"));
  x.push(`S.browser_fallback_url=${encodeURIComponent(`${base}/c/${c.slug}/vcard.vcf`)}`);
  return `intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/contact;${x.join(";")};end`;
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
  cal: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z"/></svg>`,
  star: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M23 12l-2.44-2.78.34-3.68-3.61-.82-1.89-3.18L12 3 8.6 1.54 6.71 4.72l-3.61.81.34 3.68L1 12l2.44 2.78-.34 3.69 3.61.82 1.89 3.18L12 21l3.4 1.46 1.89-3.18 3.61-.82-.34-3.68L23 12zm-12.91 4.72-3.8-3.81 1.48-1.48 2.32 2.33 5.85-5.87 1.48 1.48-7.33 7.35z"/></svg>`,
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

  /* ---- Pro business-profile blocks ---- */
  const X = extrasOf(c);
  const theme = PRO ? X.theme : "kente";
  const biz = [];   /* big action buttons */
  const waNum = String(c.whatsapp || c.mobile || "").replace(/[^\d]/g, "").replace(/^0/, "233");
  const addrTxt = [c.address, c.city, c.country].filter(Boolean).join(", ");
  if (PRO) {
    if (waNum) biz.push(`<a class="bz wa" href="${go("chat")}" target="_blank" rel="noopener">${ICONS.whatsapp}<span>Chat on WhatsApp</span></a>`);
    if (X.booking_url) biz.push(`<a class="bz" href="${go("booking")}" target="_blank" rel="noopener">${ICONS.cal}<span>Book an appointment</span></a>`);
    if (X.maps_url || addrTxt) biz.push(`<a class="bz" href="${go("directions")}" target="_blank" rel="noopener">${ICONS.pin}<span>Get directions</span></a>`);
    if (X.review_url) biz.push(`<a class="bz" href="${go("review")}" target="_blank" rel="noopener">${ICONS.star}<span>Leave a review</span></a>`);
  }
  let hoursHtml = "";
  if (PRO && X.has_hours) {
    const lbl = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
    const today = ["mon","tue","wed","thu","fri","sat","sun"][(new Date().getUTCDay() + 6) % 7];
    const fmt = (t) => { const [h, m] = t.split(":").map(Number); return ((h % 12) || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm"); };
    const st = openNow(X.hours);
    hoursHtml = `<div class="sect">Opening hours <span class="opn ${st.open ? "on" : "off"}">${st.open ? "Open now" : "Closed now"}</span></div>
    <div class="hours">${Object.keys(lbl).map((d) => { const e = X.hours[d];
      const v = e.closed ? "Closed" : e.o && e.c ? `${fmt(e.o)} – ${fmt(e.c)}` : "—";
      return `<div class="hr${d === today ? " today" : ""}"><span>${lbl[d]}</span><b>${v}</b></div>`; }).join("")}</div>`;
  }
  let menuHtml = "";
  if (PRO && X.menu.length) {
    const pay = c.payment_url && cleanPayUrl(c.payment_url);
    menuHtml = `<div class="sect">${esc(X.menu_title || "Products & services")}</div><div class="menu">${X.menu.map((it) => {
      const price = it.price != null ? `GHS ${it.price.toLocaleString("en-GH", { minimumFractionDigits: it.price % 1 ? 2 : 0 })}` : "";
      const msg = `Hi ${c.first_name || ""}, I'd like to order: ${it.name}${price ? " (" + price + ")" : ""}. (via your HaloCard)`;
      const order = waNum ? `<a class="mb wa" href="https://wa.me/${waNum}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${ICONS.whatsapp} Order</a>` : "";
      const payBtn = pay ? `<a class="mb" href="${go("pay")}" target="_blank" rel="noopener">&#128179; Pay</a>` : "";
      return `<div class="mi"><div class="mi-t"><b>${esc(it.name)}</b>${price ? `<span class="mp">${price}</span>` : ""}</div>
        ${it.desc ? `<div class="md">${esc(it.desc)}</div>` : ""}${order || payBtn ? `<div class="mbs">${order}${payBtn}</div>` : ""}</div>`; }).join("")}</div>`;
  }
  let videoHtml = "";
  if (PRO && X.video_url) {
    const emb = youtubeEmbed(X.video_url);
    videoHtml = emb
      ? `<div class="sect">Watch my intro</div><div class="vid"><iframe src="${emb}" title="Intro video" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`
      : `<a class="bz" href="${go("video")}" target="_blank" rel="noopener" style="margin-top:.55rem">&#9654;<span>Watch my intro video</span></a>`;
  }
  const evName = PRO ? activeEvent(X) : "";
  const eventHtml = evName ? `<div class="evt">&#128205; Meet me at <b>${esc(evName)}</b>${X.event_place ? ` &middot; ${esc(X.event_place)}` : ""}</div>` : "";
  const verified = PRO ? `<span class="vbadge" title="Verified HaloCard ${BIZ ? "Business" : "Pro"}">${ICONS.check}</span>` : "";

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
.evt{margin-top:.9rem;background:linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 70%,#171410));color:#171410;border-radius:13px;padding:.6rem .8rem;text-align:center;font-size:.92rem;font-weight:600}
.bzs{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.6rem}
.bz{display:flex;align-items:center;justify-content:center;gap:.45rem;background:#fff;border:1.5px solid #e6dcc6;color:var(--ink);font-weight:800;font-size:.86rem;text-decoration:none;border-radius:13px;padding:.7rem .5rem;text-align:center}
.bz svg{color:var(--accent);flex:none}
.bz.wa{grid-column:1/-1;background:#25D366;border-color:#1fb457;color:#fff;font-size:.98rem}
.bz.wa svg{color:#fff}
.bz:active{transform:scale(.97)}
.vbadge{display:inline-flex;vertical-align:middle;margin-left:.3rem;color:#1d9bf0}
.vbadge svg{width:21px;height:21px}
.opn{display:inline-block;margin-left:.45rem;padding:.12rem .5rem;border-radius:999px;font-size:.7rem;letter-spacing:.04em}
.opn.on{background:#e3f4ea;color:#1f7a4d}.opn.off{background:#f6e3df;color:#b23a2a}
.hours{background:#fff;border:1.5px solid #e6dcc6;border-radius:13px;padding:.3rem .85rem}
.hr{display:flex;justify-content:space-between;padding:.38rem 0;border-bottom:1px dashed #eee2c5;font-size:.92rem;color:var(--mut)}
.hr:last-child{border-bottom:none}.hr b{color:var(--ink)}.hr.today span,.hr.today b{color:var(--accent);filter:brightness(.8)}
.menu{display:flex;flex-direction:column;gap:.5rem}
.mi{background:#fff;border:1.5px solid #e6dcc6;border-radius:13px;padding:.7rem .85rem}
.mi-t{display:flex;justify-content:space-between;gap:.6rem;align-items:baseline}
.mp{font-weight:800;color:var(--accent);filter:brightness(.8);white-space:nowrap}
.md{font-size:.86rem;color:var(--mut);margin-top:.2rem}
.mbs{display:flex;gap:.4rem;margin-top:.5rem}
.mb{flex:1;display:flex;align-items:center;justify-content:center;gap:.3rem;border-radius:10px;padding:.5rem;font-weight:800;font-size:.84rem;text-decoration:none;background:var(--dark);color:#f2c14e}
.mb.wa{background:#25D366;color:#fff}.mb svg{width:18px;height:18px}
.vid{position:relative;padding-top:56.25%;border-radius:14px;overflow:hidden;background:#000}
.vid iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.xbar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:40;background:var(--dark);color:#fdf6e6;border:2px solid var(--accent);border-radius:16px;padding:.7rem .8rem;display:flex;gap:.6rem;align-items:center;max-width:410px;width:calc(100% - 24px);box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:.9rem}
.xbar[hidden]{display:none}.xbar button{border:none;border-radius:10px;padding:.55rem .7rem;font-weight:800;font-family:inherit;cursor:pointer}
.xbar .xgo{background:var(--accent);color:#171410;white-space:nowrap}.xbar .xno{background:none;color:#a99e8a;padding:.3rem}
/* ---- theme: Adinkra (cream, gold symbols, no kente frames) ---- */
body.t-adinkra{background:#efe6d2}
body.t-adinkra::before{background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cg fill='none' stroke='%23b8892a' stroke-width='2' opacity='.35'%3E%3Ccircle cx='16' cy='16' r='7'/%3E%3Cpath d='M16 6v20M6 16h20'/%3E%3Cpath d='M42 40c6-8 14-8 14 0s-8 8-14 0-14-8-14 0 8 8 14 0z'/%3E%3C/g%3E%3C/svg%3E")}
body.t-adinkra .sheet-frame,body.t-adinkra .act-frame,body.t-adinkra .chip-ring,body.t-adinkra .avatar-ring{background:var(--accent)}
body.t-adinkra .kente-band{display:none}
body.t-adinkra .hero{border-radius:0 0 40px 40px}
/* ---- theme: Executive (black & gold) ---- */
body.t-executive{background:#0b0a09}
body.t-executive::before{background:radial-gradient(70% 40% at 50% 0%,rgba(242,193,78,.16),transparent 70%)}
body.t-executive .hero{background:linear-gradient(135deg,#1b1813,#0b0a09);border-bottom:1px solid #f2c14e55}
body.t-executive .hero::after{background:repeating-linear-gradient(-45deg,rgba(242,193,78,.07) 0 1px,transparent 1px 12px)}
body.t-executive .sheet-frame,body.t-executive .act-frame,body.t-executive .chip-ring,body.t-executive .avatar-ring{background:linear-gradient(135deg,#f2c14e,#9c7413)}
body.t-executive .kente-band{display:none}
body.t-executive .sheet{background:#15130f}
body.t-executive h1{color:#fdf6e6}
body.t-executive .pcompany,body.t-executive .sect,body.t-executive .chip-lb,body.t-executive .rk,body.t-executive .hr,body.t-executive .md{color:#b3a68a}
body.t-executive .chip-ic,body.t-executive .avatar{border-color:#15130f}
body.t-executive .row,body.t-executive .bz:not(.wa),body.t-executive .hours,body.t-executive .mi,body.t-executive .leadbox{background:#1d1a15;border-color:#3a3328;color:#fdf6e6}
body.t-executive .row b,body.t-executive .hr b,body.t-executive .mi b{color:#fdf6e6}
body.t-executive .leadbox input,body.t-executive .leadbox textarea{background:#14120e;border-color:#3a3328;color:#fdf6e6}
body.t-executive .save:not(.pay){background:linear-gradient(135deg,#f2c14e,#c9961c);color:#171410}
body.t-executive .mb:not(.wa){background:transparent;border:1.5px solid #f2c14e;color:#f2c14e}
.savetip{position:fixed;inset:0;background:rgba(23,20,16,.55);display:flex;align-items:flex-end;justify-content:center;z-index:50;padding:12px}
.savetip[hidden]{display:none}
.savetip-card{background:#fffdf8;border-radius:18px;max-width:440px;width:100%;padding:1.1rem 1.1rem .8rem;box-shadow:0 -6px 30px rgba(0,0,0,.25);border-top:5px solid var(--accent)}
.savetip-h{font-weight:800;font-size:1.1rem;margin-bottom:.4rem;color:var(--ink)}
.savetip-b{font-size:.95rem;line-height:1.45;color:#3b352c;margin-bottom:.45rem}
.savetip-b.small{font-size:.83rem;color:#6b6256}
.savetip .save{width:100%;border:none;cursor:pointer;font-family:inherit}
.savetip-x{display:block;margin:.5rem auto 0;background:none;border:none;color:#8f8570;font-weight:700;font-family:inherit;font-size:.9rem;cursor:pointer}
.foot b{color:var(--accent)}
</style></head>
<body class="t-${theme}">
<div class="page">
  ${kenteBand("top")}
  <div class="hero">${logo}</div>
  <div class="sheet-frame"><div class="sheet">
    <div class="head">
      <div class="avatar-ring">${photo}</div>
      <h1>${name}${verified}</h1>
      ${title ? `<div class="ptitle">${title}</div>` : ""}
      ${company ? `<div class="pcompany">${company}</div>` : ""}
    </div>
    ${eventHtml}
    <a class="save" id="saveBtn" href="/c/${esc(c.slug)}/vcard.vcf" data-intent="${esc(androidContactIntent(c, base))}">${ICONS.save} Save to Contacts</a>
    ${PRO && c.payment_url && cleanPayUrl(c.payment_url) ? `<a class="save pay" href="/c/${esc(c.slug)}/go/pay" target="_blank" rel="noopener">&#128179; ${esc(vv(c.payment_label) || "Pay Me")}</a>` : ""}
    ${actions.length ? `<div class="acts">${actions.join("")}</div>` : ""}
    ${biz.length ? `<div class="bzs">${biz.join("")}</div>` : ""}
    ${videoHtml}
    ${menuHtml}
    ${hoursHtml}
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
<div id="saveTip" class="savetip" hidden>
  <div class="savetip-card">
    <div class="savetip-h">&#128241; Almost done</div>
    <div class="savetip-b">Your phone downloaded <b>${esc(fullName(c) || "the contact")}</b>'s details.<br>
      Tap <b>Open</b> on the download message at the bottom of the screen (or open the file from your notifications), then tap <b>Save</b>.</div>
    <div class="savetip-b small">Tip: next time, point your phone camera at the QR on the <b>back</b> of the card &mdash; it adds the contact in one step.</div>
    <button type="button" class="save" id="saveAgain" style="margin-top:.6rem">&#11015; Download again</button>
    ${PRO ? `<button type="button" class="save pay" id="tipSwap" style="width:100%;border:none;cursor:pointer;font-family:inherit">&#128075; Share my details back</button>` : ""}
    <button type="button" class="savetip-x" id="saveTipX">Close</button>
  </div>
</div>
${PRO ? `<div id="xbar" class="xbar" hidden><span>&#128075; Swap details with <b>${esc(c.first_name || "them")}</b>?</span>
  <button type="button" class="xgo" id="xgo">Share mine</button><button type="button" class="xno" id="xno">&#10005;</button></div>` : ""}
<script>
/* Save to Contacts, as seamless as each phone allows:
   iPhone  -> vCard served inline: iOS shows the contact card with "Create New Contact" (no download)
   Android -> try the phone's own pre-filled "Create contact" screen; if the phone doesn't allow that
              from a web page, Chrome downloads the vCard and we show a 1-step guide
   desktop -> downloads the .vcf */
(function(){
  var s=document.getElementById('saveBtn'), tip=document.getElementById('saveTip'); if(!s) return;
  var vcf=s.getAttribute('href');
  function showTip(){ tip.hidden=false; }
  document.getElementById('saveTipX').onclick=function(){ tip.hidden=true; };
  document.getElementById('saveAgain').onclick=function(){ location.href=vcf; };
  var ts=document.getElementById('tipSwap'); if(ts) ts.onclick=function(){ tip.hidden=true; var l=document.querySelector('.leadbox'); l&&l.scrollIntoView({behavior:'smooth',block:'center'}); };
  /* exchange: after saving their contact, invite the visitor to share theirs back */
  var xb=document.getElementById('xbar'), lb=document.querySelector('.leadbox');
  function offerSwap(){ if(xb && lb && tip.hidden) xb.hidden=false; }
  if(xb){ document.getElementById('xno').onclick=function(){xb.hidden=true;};
    document.getElementById('xgo').onclick=function(){xb.hidden=true;lb.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(function(){var n=document.getElementById('ln');n&&n.focus();},500);}; }
  s.addEventListener('click',function(){ setTimeout(offerSwap,3500); });
  s.addEventListener('click',function(e){
    if(!/Android/i.test(navigator.userAgent) || !s.dataset.intent) return; /* iPhone & desktop: normal link */
    e.preventDefault();
    try{ navigator.sendBeacon('/api/public/saved', new Blob([JSON.stringify({slug:${JSON.stringify(c.slug)}})],{type:'application/json'})); }catch(_){}
    var left=false; function gone(){ if(document.visibilityState==='hidden') left=true; }
    document.addEventListener('visibilitychange',gone);
    location.href = s.dataset.intent;               /* opens Contacts if the phone allows it… */
    setTimeout(function(){                           /* …otherwise Chrome fell back to downloading the vCard */
      document.removeEventListener('visibilitychange',gone);
      if(!left) showTip();
    },1600);
  });
})();
</script>
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
/* release notes: public/changelog.json — newest first. Adding an entry changes the version,
   which updates the service worker and shows "What's new" to every user once. */
let CHANGELOG = [];
try { CHANGELOG = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "changelog.json"), "utf8")); } catch { CHANGELOG = []; }
const APP_VERSION = (CHANGELOG[0] && CHANGELOG[0].version) || "1.0.0";
const MIME = { ".json": "application/json", ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".map": "application/json" };
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
    if (path.extname(full) === ".html") buf = Buffer.from(buf.toString().split("__BASE__").join(baseUrl(req)).split("__VERSION__").join(APP_VERSION));
    if (rel === "sw.js") buf = Buffer.from(buf.toString().split("__VERSION__").join(APP_VERSION));
    const fresh = rel === "sw.js" || rel === "changelog.json" || rel === "manifest.webmanifest" || path.extname(full) === ".html";
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": fresh ? "no-cache" : "public, max-age=86400" });
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
    if (p === "/health") return json(res, 200, { ok: true, version: APP_VERSION, time: new Date().toISOString() });
    if (req.method === "GET" && p === "/api/version") return json(res, 200, { version: APP_VERSION, changelog: CHANGELOG.slice(0, 12) });

    /* ---------- public: dynamic profile + vCard (the QR target) ---------- */
    const mVcf = p.match(/^\/c\/([A-Za-z0-9-]+)\/vcard\.vcf$/);
    if (req.method === "GET" && mVcf) {
      const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(mVcf[1]);
      if (!c || !c.active) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      db.prepare("UPDATE cards SET vcard_downloads=vcard_downloads+1 WHERE id=?").run(c.id);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'vcard')").run(c.id);
      res.writeHead(200, { "Content-Type": "text/vcard; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `inline; filename="${(fullName(c) || "contact").replace(/[^\w]+/g, "_")}.vcf"` });
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
        pay: c.payment_url && planAtLeast(ownerPlanForCard(c), "pro") ? (cleanPayUrl(c.payment_url) || "") : "",
      };
      if (planAtLeast(ownerPlanForCard(c), "pro")) {
        const x = extrasOf(c);
        const addr = [c.address, c.city, c.country].filter(Boolean).join(", ");
        targets.booking = x.booking_url; targets.review = x.review_url; targets.video = x.video_url;
        targets.directions = x.maps_url || (addr ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr) : "");
        const waNum = String(c.whatsapp || c.mobile || "").replace(/[^\d]/g, "").replace(/^0/, "233");
        targets.chat = waNum ? "https://wa.me/" + waNum + (x.wa_message ? "?text=" + encodeURIComponent(x.wa_message) : "") : "";
      }
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

    /* Paystack webhook: auto-upgrade on successful payment (signature over the exact raw bytes) */
    if (req.method === "POST" && p === "/api/paystack/webhook") {
      if (!PAYSTACK_SECRET_KEY) { res.writeHead(404); return res.end(); }
      const raw = await readRaw(req);
      const sig = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(raw).digest("hex");
      if (!safeEqual(sig, String(req.headers["x-paystack-signature"] || ""))) { res.writeHead(401); return res.end(); }
      let ev; try { ev = JSON.parse(raw.toString("utf8")); } catch { res.writeHead(400); return res.end(); }
      if (ev.event === "charge.success") {
        const r = applyPayment(ev.data, "webhook");
        if (!r.ok) console.warn(`billing: webhook ${ev.data && ev.data.reference} ignored — ${r.reason}`);
      }
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}');
    }

    /* public: a contact was saved via the phone's own "new contact" screen (Android) */
    if (req.method === "POST" && p === "/api/public/saved") {
      if (!rateLimit(req, "saved", 30, 10 * 60 * 1000)) return json(res, 429, { error: "slow down" });
      const b = await jread(req);
      const c = db.prepare("SELECT id,active FROM cards WHERE slug=?").get(String(b.slug || ""));
      if (!c || !c.active) return json(res, 404, { error: "card not found" });
      db.prepare("UPDATE cards SET vcard_downloads=vcard_downloads+1 WHERE id=?").run(c.id);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'vcard')").run(c.id);
      return json(res, 200, { ok: true });
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
      const evt = activeEvent(extrasOf(db.prepare("SELECT extras FROM cards WHERE id=?").get(c.id)));
      db.prepare("INSERT INTO leads(card_id,name,phone,email,company,note,event) VALUES (?,?,?,?,?,?,?)").run(c.id, name, phone, email, company, note, evt || null);
      db.prepare("INSERT INTO events(card_id,type) VALUES (?,'lead')").run(c.id);
      /* email the card owner (fire-and-forget; needs RESEND_API_KEY) */
      const full = db.prepare("SELECT * FROM cards WHERE id=?").get(c.id);
      const owner = c.user_id ? db.prepare("SELECT email FROM users WHERE id=?").get(c.user_id) : null;
      if (owner) sendEmail(owner.email, `New lead from your HaloCard: ${name || phone}`, leadEmailHtml(full, { name, phone, email, company, note }, baseUrl(req)));
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
      const refBy = b.ref ? db.prepare("SELECT id FROM users WHERE ref_code=?").get(String(b.ref).toUpperCase().slice(0, 12)) : null;
      const r = db.prepare("INSERT INTO users(email,pass_hash,salt,role,name,referred_by) VALUES (?,?,?,'user',?,?)").run(email, hashPassword(b.password, salt), salt, name, refBy ? refBy.id : null);
      const newId = Number(r.lastInsertRowid);
      /* invited by a company? join the team and take over the card made for you */
      const inv = db.prepare("SELECT * FROM team_invites WHERE email=?").get(email);
      if (inv) {
        db.prepare("UPDATE users SET team_id=? WHERE id=?").run(inv.team_id, newId);
        if (inv.card_id) db.prepare("UPDATE cards SET user_id=? WHERE id=? AND team_id=?").run(newId, inv.card_id, inv.team_id);
        db.prepare("DELETE FROM team_invites WHERE email=?").run(email);
      }
      const u = db.prepare("SELECT * FROM users WHERE id=?").get(newId);
      return json(res, 200, { token: signToken(u), email: u.email, role: "user", name: u.name || "" });
    }

    const me = bearer(req);
    const isAdmin = !!(me && me.role === "admin");
    if (req.method === "GET" && p === "/api/me") { if (!me) return json(res, 401, { error: "unauthorized" }); const myTeam = teamOwnedBy(me.id), inTeam = me.team_id ? db.prepare("SELECT t.name, t.company, u.email owner FROM teams t JOIN users u ON u.id=t.owner_id WHERE t.id=?").get(me.team_id) : null;
      return json(res, 200, { id: me.id, email: me.email, name: me.name || "", role: me.role || "user", plan: planOf(me), plan_expires: me.plan_expires || null, app_url: baseUrl(req),
        team_owner: !!myTeam, team_member: inTeam || null, wallet_google: googleWalletOn(), report_opt_out: !!me.report_opt_out, email_on: !!RESEND_API_KEY }); }
    if (req.method === "PUT" && p === "/api/me/prefs") {
      if (!me) return json(res, 401, { error: "unauthorized" });
      const b = await jread(req);
      if (b.report_opt_out !== undefined) db.prepare("UPDATE users SET report_opt_out=? WHERE id=?").run(b.report_opt_out ? 1 : 0, me.id);
      if (b.name !== undefined) db.prepare("UPDATE users SET name=? WHERE id=?").run(vv(b.name).slice(0, 80), me.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/report/test") {
      if (!me) return json(res, 401, { error: "unauthorized" });
      if (!RESEND_API_KEY) return json(res, 400, { error: "Email is not set up yet (RESEND_API_KEY)." });
      const sql = (d) => d.toISOString().slice(0, 19).replace("T", " ");
      const html = reportHtml(me, sql(new Date(Date.now() - 30 * 86400000)), sql(new Date(Date.now() + 60000)), "last 30 days", baseUrl(req));
      if (!html) return json(res, 400, { error: "Create a card first." });
      const ok = await sendEmail(me.email, "Your HaloCard report — last 30 days", html);
      return ok ? json(res, 200, { ok: true }) : json(res, 502, { error: "Email could not be sent — check RESEND_API_KEY / MAIL_FROM." });
    }
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
        : db.prepare("SELECT COUNT(*) n FROM leads l JOIN cards c ON c.id=l.card_id WHERE (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?))").get(me.id, me.id).n;
      const leads_new = isAdmin
        ? db.prepare("SELECT COUNT(*) n FROM leads WHERE COALESCE(seen,0)=0").get().n
        : db.prepare("SELECT COUNT(*) n FROM leads l JOIN cards c ON c.id=l.card_id WHERE (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?)) AND COALESCE(l.seen,0)=0").get(me.id, me.id).n;
      return json(res, 200, { total, active, scans, downloads, leads, leads_new, role: me.role || "user", app_url: baseUrl(req), plan: planOf(me) });
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
        if (b.payment_url) { const pu = cleanPayUrl(b.payment_url); if (pu === null) return json(res, 400, { error: PAY_URL_ERROR }); b.payment_url = pu; }
        if (b.extras !== undefined) b.extras = JSON.stringify(cleanExtras(b.extras));
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        const sql = `INSERT INTO cards(slug,user_id,${cols.join(",")}) VALUES (?,?${",?".repeat(cols.length)})`;
        db.prepare(sql).run(slug, ownerId, ...cols.map((f) => b[f] ?? null));
        const c = db.prepare("SELECT * FROM cards WHERE slug=?").get(slug);
        if (me.team_id) { db.prepare("UPDATE cards SET team_id=? WHERE id=?").run(me.team_id, c.id); applyTeamBrand(c.id); }
        else if (teamOwnedBy(me.id)) { db.prepare("UPDATE cards SET team_id=? WHERE id=?").run(teamOwnedBy(me.id).id, c.id); applyTeamBrand(c.id); }
        return json(res, 200, { ok: true, id: c.id, slug, url: baseUrl(req) + "/c/" + slug });
      }
    }

    /* ownership: users may only touch their own cards; admin touches all */
    const ownCard = (id) => {
      const c = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
      if (!c) return null;
      if (!isAdmin && c.user_id !== me.id) {
        const t = c.team_id ? db.prepare("SELECT owner_id FROM teams WHERE id=?").get(c.team_id) : null;
        if (!t || t.owner_id !== me.id) return null;
      }
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
        if (b.payment_url) { const pu = cleanPayUrl(b.payment_url); if (pu === null) return json(res, 400, { error: PAY_URL_ERROR }); b.payment_url = pu; }
        if (b.extras !== undefined) b.extras = JSON.stringify(cleanExtras(b.extras));
        const cols = CARD_FIELDS.filter((f) => b[f] !== undefined);
        if (cols.length) db.prepare(`UPDATE cards SET ${cols.map((f) => f + "=?").join(",")}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((f) => b[f] ?? null), id);
        applyTeamBrand(id);
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
      if (PLAN_RANK[planOf(me)] > PLAN_RANK[plan]) return json(res, 400, { error: `You're already on ${PLANS[planOf(me)].label}. Renew that plan instead.` });
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

    /* return-from-checkout: confirm with Paystack directly (backup for the webhook) */
    if (req.method === "GET" && p === "/api/billing/verify") {
      if (!needAuth()) return;
      const ref = String(url.searchParams.get("reference") || "").slice(0, 100);
      if (!ref) return json(res, 400, { error: "missing reference" });
      if (!PAYSTACK_SECRET_KEY) return json(res, 400, { error: "online billing is not configured" });
      let tx; try { tx = await paystackVerify(ref); } catch (e) { return json(res, 502, { error: "could not confirm payment yet — try again in a minute" }); }
      if (Number(tx.metadata && tx.metadata.uid) !== me.id) return json(res, 403, { error: "this payment belongs to another account" });
      if (tx.status !== "success") return json(res, 402, { error: "payment not completed (" + (tx.status || "unknown") + ")", status: tx.status });
      const r = applyPayment(tx, "verify");
      if (!r.ok) return json(res, 400, { error: r.reason });
      if (r.kind === "nfc") return json(res, 200, { ok: true, kind: "nfc", order: r.order });
      const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(me.id);
      return json(res, 200, { ok: true, plan: planOf(fresh), expires: fresh.plan_expires });
    }

    /* ---------- Google Wallet ---------- */
    const mWallet = p.match(/^\/api\/cards\/(\d+)\/wallet\/google$/);
    if (req.method === "GET" && mWallet) {
      if (!needAuth()) return;
      const c = ownCard(Number(mWallet[1]));
      if (!c) return json(res, 404, { error: "not found" });
      if (!googleWalletOn()) return json(res, 400, { error: "Google Wallet is not set up yet." });
      try { return json(res, 200, { url: googleWalletUrl(c, baseUrl(req)) }); }
      catch (e) { console.warn("wallet:", e.message); return json(res, 500, { error: "Could not create the wallet pass — check the Google Wallet key." }); }
    }

    /* ---------- referrals ---------- */
    if (req.method === "GET" && p === "/api/referrals") {
      if (!needAuth()) return;
      const code = refCodeFor(me.id);
      const signups = db.prepare("SELECT COUNT(*) n FROM users WHERE referred_by=?").get(me.id).n;
      const paid = db.prepare("SELECT COUNT(*) n FROM users WHERE referred_by=? AND ref_rewarded=1").get(me.id).n;
      return json(res, 200, { code, link: baseUrl(req) + "/register?ref=" + code, signups, paid, days_per_reward: REFERRAL_REWARD_DAYS, days_earned: paid * REFERRAL_REWARD_DAYS });
    }

    /* ---------- teams (Business plan) ---------- */
    if (p === "/api/team" && req.method === "GET") {
      if (!needAuth()) return;
      const t = teamOwnedBy(me.id);
      if (!t) {
        const member = me.team_id ? db.prepare("SELECT t.name, t.company, u.email owner FROM teams t JOIN users u ON u.id=t.owner_id WHERE t.id=?").get(me.team_id) : null;
        return json(res, 200, { owner: false, eligible: planOf(me) === "business" && !me.team_id, member });
      }
      const members = db.prepare("SELECT id, email, name, created_at FROM users WHERE team_id=? ORDER BY id").all(t.id).map((m) => ({ ...m, invited: false }));
      const invites = db.prepare("SELECT email, card_id, at FROM team_invites WHERE team_id=?").all(t.id);
      const cards = db.prepare(`SELECT c.id, c.slug, c.first_name, c.last_name, c.job_title, c.active, c.scan_count, c.vcard_downloads, c.user_id,
          (SELECT COUNT(*) FROM leads l WHERE l.card_id=c.id) leads, u.email FROM cards c LEFT JOIN users u ON u.id=c.user_id WHERE c.team_id=? ORDER BY c.id`).all(t.id);
      return json(res, 200, { owner: true, team: t, members, invites, cards, seats: PLANS.business.cards, app_url: baseUrl(req) });
    }
    if (p === "/api/team" && req.method === "POST") {
      if (!needAuth()) return;
      if (me.team_id) return json(res, 400, { error: "You are a member of another company's team." });
      if (planOf(me) !== "business") return json(res, 403, { error: "Teams are a Business feature. Upgrade to Business to brand your staff cards.", upgrade: true });
      const b = await jread(req);
      const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(b.accent || "")) ? b.accent : null;
      const template = ["corporate", "executive", "minimalist", "premium", "modern"].includes(b.template) ? b.template : null;
      const theme = THEMES.includes(b.theme) ? b.theme : null;
      const logo = /^data:image\/(png|jpe?g|webp);base64,/i.test(String(b.logo || "")) && String(b.logo).length < 1500000 ? b.logo : null;
      let t = teamOwnedBy(me.id);
      if (!t) { db.prepare("INSERT INTO teams(owner_id) VALUES (?)").run(me.id); t = teamOwnedBy(me.id); }
      db.prepare("UPDATE teams SET name=?, company=?, accent=?, template=?, theme=?, logo=COALESCE(?,logo) WHERE id=?")
        .run(vv(b.name).slice(0, 80), vv(b.company).slice(0, 120), accent, template, theme, logo, t.id);
      if (b.clear_logo) db.prepare("UPDATE teams SET logo=NULL WHERE id=?").run(t.id);
      db.prepare("UPDATE cards SET team_id=? WHERE user_id=? AND team_id IS NULL").run(t.id, me.id); /* owner's own cards join the brand */
      for (const c of db.prepare("SELECT id FROM cards WHERE team_id=?").all(t.id)) applyTeamBrand(c.id);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/team/members" && req.method === "POST") {
      if (!needAuth()) return;
      const t = teamOwnedBy(me.id);
      if (!t) return json(res, 400, { error: "Set up your team brand first." });
      if (planOf(me) !== "business") return json(res, 403, { error: "Teams need an active Business plan.", upgrade: true });
      const b = await jread(req);
      const email = String(b.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "enter the staff member's email" });
      if (email === me.email) return json(res, 400, { error: "that's you — you're already the team owner" });
      const used = db.prepare("SELECT COUNT(*) n FROM users WHERE team_id=?").get(t.id).n + db.prepare("SELECT COUNT(*) n FROM team_invites WHERE team_id=?").get(t.id).n + 1;
      if (used >= PLANS.business.cards) return json(res, 403, { error: `Your Business plan covers ${PLANS.business.cards} people.` });
      const existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      if (existing && existing.team_id && existing.team_id !== t.id) return json(res, 409, { error: "that person is already in another company's team" });
      if (existing && teamOwnedBy(existing.id)) return json(res, 409, { error: "that person owns their own team" });
      if (!existing && db.prepare("SELECT 1 FROM team_invites WHERE email=?").get(email)) return json(res, 409, { error: "already invited" });
      const first = vv(b.first_name).slice(0, 60) || email.split("@")[0], last = vv(b.last_name).slice(0, 60);
      const slug = slugify(first, last);
      const ownerId = existing ? existing.id : me.id;
      const r = db.prepare("INSERT INTO cards(slug,user_id,team_id,first_name,last_name,job_title,mobile,email,template) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(slug, ownerId, t.id, first, last, vv(b.job_title).slice(0, 80), vv(b.mobile).slice(0, 40), email, t.template || "corporate");
      const cardId = Number(r.lastInsertRowid);
      applyTeamBrand(cardId);
      if (existing) db.prepare("UPDATE users SET team_id=? WHERE id=?").run(t.id, existing.id);
      else db.prepare("INSERT INTO team_invites(email,team_id,card_id) VALUES (?,?,?)").run(email, t.id, cardId);
      const link = baseUrl(req) + (existing ? "/login" : "/register");
      sendEmail(email, `${t.company || t.name || "Your company"} created a HaloCard for you`,
        `<p>${esc(me.name || me.email)} added you to <b>${esc(t.company || t.name || "their team")}</b> on HaloCard. Your digital business card is ready:</p>
         <p><a href="${esc(baseUrl(req))}/c/${esc(slug)}">${esc(baseUrl(req))}/c/${esc(slug)}</a></p>
         <p>${existing ? "Sign in" : "Create your login with this email"} to add your photo and details: <a href="${esc(link)}">${esc(link)}</a></p>`);
      return json(res, 200, { ok: true, card_id: cardId, slug, invited: !existing, link });
    }
    const mTeamMember = p.match(/^\/api\/team\/members\/(\d+)$/);
    if (mTeamMember && req.method === "DELETE") {
      if (!needAuth()) return;
      const t = teamOwnedBy(me.id); const uid = Number(mTeamMember[1]);
      if (!t || !db.prepare("SELECT 1 FROM users WHERE id=? AND team_id=?").get(uid, t.id)) return json(res, 404, { error: "not found" });
      /* staff leaving: their company cards come back to the owner (disabled) so the QR can be reassigned */
      db.prepare("UPDATE cards SET user_id=?, active=0 WHERE user_id=? AND team_id=?").run(me.id, uid, t.id);
      db.prepare("UPDATE users SET team_id=NULL WHERE id=?").run(uid);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/team/invites" && req.method === "DELETE") {
      if (!needAuth()) return;
      const t = teamOwnedBy(me.id); const email = String(url.searchParams.get("email") || "").toLowerCase();
      const inv = t && db.prepare("SELECT * FROM team_invites WHERE email=? AND team_id=?").get(email, t.id);
      if (!inv) return json(res, 404, { error: "not found" });
      db.prepare("DELETE FROM team_invites WHERE email=?").run(email);
      if (inv.card_id) db.prepare("UPDATE cards SET active=0 WHERE id=? AND user_id=?").run(inv.card_id, me.id);
      return json(res, 200, { ok: true });
    }

    /* ---------- physical NFC card orders ---------- */
    if (req.method === "GET" && p === "/api/nfc/products") {
      if (!needAuth()) return;
      const mine = db.prepare("SELECT * FROM nfc_orders WHERE user_id=? ORDER BY id DESC LIMIT 50").all(me.id);
      return json(res, 200, { products: NFC_PRODUCTS, delivery: NFC_DELIVERY_GHS, online: !!PAYSTACK_SECRET_KEY, orders: mine });
    }
    if (req.method === "POST" && p === "/api/nfc/order") {
      if (!needAuth()) return;
      const b = await jread(req);
      const prod = NFC_PRODUCTS[b.material];
      if (!prod) return json(res, 400, { error: "choose PVC or Metal" });
      const qty = Math.max(1, Math.min(50, parseInt(b.qty, 10) || 1));
      const card = ownCard(Number(b.card_id));
      if (!card) return json(res, 400, { error: "choose which card to put on the NFC card" });
      const f = (v, n) => vv(v).slice(0, n);
      const name_on_card = f(b.name_on_card, 60) || fullName(card), phone = f(b.phone, 40), address = f(b.address, 200), city = f(b.city, 60), region = f(b.region, 60);
      if (!phone || !address || !city) return json(res, 400, { error: "enter delivery phone, address and city" });
      const amount = prod.price * qty + NFC_DELIVERY_GHS;
      const r0 = db.prepare("INSERT INTO nfc_orders(user_id,card_id,material,qty,name_on_card,phone,address,city,region,note,amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(me.id, card.id, b.material, qty, name_on_card, phone, address, city, region, f(b.note, 300), amount);
      const orderId = Number(r0.lastInsertRowid);
      if (!PAYSTACK_SECRET_KEY) return json(res, 200, { ok: true, order: orderId, manual: true, note: "Order received. We will contact you on WhatsApp to confirm payment and delivery." });
      try {
        const r = await fetch("https://api.paystack.co/transaction/initialize", {
          method: "POST", headers: { Authorization: "Bearer " + PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email: me.email, amount: Math.round(amount * 100), currency: "GHS",
            metadata: { kind: "nfc", order_id: orderId, uid: me.id }, callback_url: baseUrl(req) + "/app" }),
        });
        const d = await r.json();
        if (!d.status || !d.data?.authorization_url) return json(res, 502, { error: d.message || "could not start payment" });
        return json(res, 200, { ok: true, order: orderId, url: d.data.authorization_url });
      } catch { return json(res, 502, { error: "payment service unreachable, try again shortly" }); }
    }
    if (req.method === "GET" && p === "/api/admin/stats") {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const one = (sql, ...a) => db.prepare(sql).get(...a);
      const users = db.prepare("SELECT id, email, name, role, plan, plan_expires, created_at, team_id, referred_by FROM users").all();
      const plans = { free: 0, pro: 0, business: 0 };
      for (const u of users) if (u.role !== "admin") plans[planOf(u)] = (plans[planOf(u)] || 0) + 1;
      const customers = users.filter((u) => u.role !== "admin").length;
      const months = []; const now = new Date();
      for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
      const pay = db.prepare("SELECT substr(at,1,7) m, plan, SUM(amount) a, COUNT(*) n FROM payments GROUP BY m, plan").all();
      const revenue = months.map((m) => {
        const r = { m, plans: 0, nfc: 0 };
        for (const x of pay.filter((x) => x.m === m)) { if (x.plan === "nfc") r.nfc += x.a / 100; else r.plans += x.a / 100; }
        return r;
      });
      const sign = db.prepare("SELECT substr(created_at,1,7) m, COUNT(*) n FROM users WHERE role!='admin' GROUP BY m").all();
      const signups = months.map((m) => ({ m, n: (sign.find((x) => x.m === m) || {}).n || 0 }));
      const tot = one("SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM payments");
      const thisMonth = months[11];
      const in30 = new Date(Date.now() + 30 * 86400000).toISOString(), ago30 = new Date(Date.now() - 30 * 86400000).toISOString(), nowIso = new Date().toISOString();
      const expiring = users.filter((u) => u.role !== "admin" && u.plan && u.plan !== "free" && u.plan_expires && u.plan_expires > ago30 && u.plan_expires < in30)
        .map((u) => ({ id: u.id, email: u.email, name: u.name, plan: u.plan, expires: u.plan_expires, expired: u.plan_expires < nowIso }))
        .sort((a, b) => a.expires.localeCompare(b.expires));
      const recent = db.prepare(`SELECT p.reference, p.plan, p.amount, p.source, p.at, u.email FROM payments p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.at DESC LIMIT 100`).all()
        .map((x) => ({ ...x, amount: x.amount / 100 }));
      const top = db.prepare(`SELECT c.id, c.slug, c.first_name, c.last_name, c.company, c.scan_count, c.vcard_downloads, u.email,
          (SELECT COUNT(*) FROM leads l WHERE l.card_id=c.id) leads FROM cards c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.scan_count DESC LIMIT 10`).all();
      const sqlAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace("T", " ");
      return json(res, 200, {
        version: APP_VERSION,
        kpi: {
          customers, new_this_month: (signups[11] || {}).n || 0, paying: plans.pro + plans.business,
          revenue_total: tot.a / 100, payments: tot.n, revenue_month: (revenue[11].plans + revenue[11].nfc),
          cards: one("SELECT COUNT(*) n FROM cards").n, cards_live: one("SELECT COUNT(*) n FROM cards WHERE active=1").n,
          scans: one("SELECT COALESCE(SUM(scan_count),0) n FROM cards").n, scans_30: one("SELECT COUNT(*) n FROM events WHERE type='scan' AND at>=?", sqlAgo(30)).n,
          saves: one("SELECT COALESCE(SUM(vcard_downloads),0) n FROM cards").n, leads: one("SELECT COUNT(*) n FROM leads").n,
          leads_30: one("SELECT COUNT(*) n FROM leads WHERE at>=?", sqlAgo(30)).n,
          teams: one("SELECT COUNT(*) n FROM teams").n, referred: users.filter((u) => u.referred_by).length,
          orders_open: one("SELECT COUNT(*) n FROM nfc_orders WHERE status IN ('paid','printing','shipped')").n,
          orders_waiting: one("SELECT COUNT(*) n FROM nfc_orders WHERE status='awaiting_payment'").n,
        },
        plans, revenue, signups, expiring, recent, top, month: thisMonth, email_on: !!RESEND_API_KEY,
      });
    }
    if (req.method === "POST" && p === "/api/admin/reports/run") {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      if (!RESEND_API_KEY) return json(res, 400, { error: "Email is not set up yet (RESEND_API_KEY)." });
      db.prepare("DELETE FROM meta WHERE k=?").run("report_" + new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7));
      return json(res, 200, { ok: true, sent: await sendMonthlyReports(true) });
    }
    if (req.method === "GET" && p === "/api/admin/orders") {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const orders = db.prepare(`SELECT o.*, u.email, c.slug FROM nfc_orders o LEFT JOIN users u ON u.id=o.user_id
        LEFT JOIN cards c ON c.id=o.card_id ORDER BY o.id DESC LIMIT 500`).all();
      return json(res, 200, { orders, app_url: baseUrl(req) });
    }
    const mOrder = p.match(/^\/api\/admin\/orders\/(\d+)$/);
    if (req.method === "PUT" && mOrder) {
      if (!needAuth()) return;
      if (!isAdmin) return json(res, 403, { error: "admin only" });
      const b = await jread(req);
      if (b.status !== undefined && !ORDER_STATUSES.includes(b.status)) return json(res, 400, { error: "bad status" });
      if (b.status !== undefined) db.prepare("UPDATE nfc_orders SET status=? WHERE id=?").run(b.status, Number(mOrder[1]));
      if (b.tracking !== undefined) db.prepare("UPDATE nfc_orders SET tracking=? WHERE id=?").run(vv(b.tracking).slice(0, 200), Number(mOrder[1]));
      return json(res, 200, { ok: true });
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
            FROM leads l JOIN cards c ON c.id=l.card_id WHERE (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?)) ORDER BY l.at DESC LIMIT 500`).all(me.id, me.id);
      return json(res, 200, { leads });
    }
    if (req.method === "POST" && p === "/api/leads/seen") {
      if (!needAuth()) return;
      if (isAdmin) db.prepare("UPDATE leads SET seen=1").run();
      else db.prepare("UPDATE leads SET seen=1 WHERE card_id IN (SELECT id FROM cards c WHERE (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?)))").run(me.id, me.id);
      return json(res, 200, { ok: true });
    }
    const mLead = p.match(/^\/api\/leads\/(\d+)$/);
    if (req.method === "PUT" && mLead) {
      if (!needAuth()) return;
      const lid = Number(mLead[1]);
      if (!isAdmin && !db.prepare("SELECT l.id FROM leads l JOIN cards c ON c.id=l.card_id WHERE l.id=? AND (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?))").get(lid, me.id, me.id)) return json(res, 404, { error: "not found" });
      const b = await jread(req);
      if (b.status !== undefined) { if (!LEAD_STATUSES.includes(b.status)) return json(res, 400, { error: "bad status" }); db.prepare("UPDATE leads SET status=? WHERE id=?").run(b.status, lid); }
      if (b.notes !== undefined) db.prepare("UPDATE leads SET notes=? WHERE id=?").run(vv(b.notes).slice(0, 1000), lid);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && mLead) {
      if (!needAuth()) return;
      const lid = Number(mLead[1]);
      if (!isAdmin) {
        const owns = db.prepare("SELECT l.id FROM leads l JOIN cards c ON c.id=l.card_id WHERE l.id=? AND (c.user_id=? OR c.team_id IN (SELECT id FROM teams WHERE owner_id=?))").get(lid, me.id, me.id);
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
      if (!ownCard(Number(mToggle[1]))) return json(res, 404, { error: "not found" });
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
