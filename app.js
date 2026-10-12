"use strict";
/* PSL Master (phone). Same database, same rules and the same overtime credit system as PSL Master on the PC
   (engine.js is a port of its C# engine). Talks to Firestore directly with the signed-in person's token (through the
   Android bridge, window.Native). Live updates while open; quiet reminders at the times the person chooses.
   Opened in a normal browser (no Native) it runs on a pretend database - for checking the screens. */

// ===================================================================== small helpers
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = x => "RM " + Number(x || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = x => { const v = Math.round(Number(x || 0) * 100) / 100; return (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "")); };
const dmy = s => s && s.length >= 10 ? s.substr(8, 2) + "/" + s.substr(5, 2) + "/" + s.substr(0, 4) : (s || "");
const plural = (n, a, b) => n + " " + (n === 1 ? a : b);
const short = id => { const p = String(id || "").split("-"); return p.length >= 4 ? p.slice(2).join("-") : id; };
const clone = o => JSON.parse(JSON.stringify(o));
const TODAY = () => E.todayLocal();
const TODAY_ISO = () => E.iso(E.todayLocal());

function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 2600); }

// a bottom sheet: buttons [{label, cls, value}] - resolves with the value (or the text box's text when value === "input")
function sheet(title, body, buttons) {
  return new Promise(res => {
    const v = document.createElement("div");
    v.className = "veil";
    v.innerHTML = `<div class="sheet"><h3>${esc(title)}</h3><div class="body">${body}</div><div class="btns">${buttons.map((b, i) => `<button class="btn ${b.cls || ""}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
    v.addEventListener("click", e => {
      const b = e.target.closest("button[data-i]");
      if (b) { const val = buttons[+b.dataset.i].value; const inp = v.querySelector("input,textarea"); v.remove(); res(val === "input" ? (inp ? inp.value : "") : val); }
      else if (e.target === v) { v.remove(); res(null); }
    });
    document.body.appendChild(v);
  });
}
const tell = (t, m) => sheet(t, esc(m).replace(/\n/g, "<br>"), [{ label: "OK", cls: "p" }]);
const msgs = (errors, warnings) => (errors || []).map(e => `<div class="msg e"><b>✕</b><span>${esc(e)}</span></div>`).join("") + (warnings || []).map(w => `<div class="msg w"><b>!</b><span>${esc(w)}</span></div>`).join("");

// ===================================================================== the phone (or a pretend phone in a browser)
const DEMO = !window.Native;
const N = window.Native || {
  session: () => JSON.stringify(demoSession), signIn: () => setTimeout(() => { demoSession.signedIn = true; window.__auth(JSON.stringify(demoSession)); }, 600),
  cancelSignIn() { }, signOut() { demoSession.signedIn = false; }, sha256: s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return ("00000000" + h.toString(16)).slice(-8) + "a1b2c3d4e5f6"; },
  version: () => "demo", save() { }, load: () => "", reminderSettings: () => localStorage.getItem("demo.rem") || "{}", setReminderSettings: j => localStorage.setItem("demo.rem", j),
  testReminder: () => toast("(demo) a test reminder would appear now"), notificationsAllowed: () => true, askNotifications() { }, openNotificationSettings() { },
  openUrl: u => window.open(u), liveStart() { setTimeout(() => window.__live && window.__live(true), 300); }, liveStop() { }, exitApp() { },
  request: (id, m, u, h, b) => setTimeout(() => window.__net(id, 200, "{}"), 50)
};
const demoSession = { signedIn: true, email: "dewi.sample@psetialestari.com", name: "Dewi Supang Robin", employeeId: "PSL14", isAdmin: false };

// ===================================================================== the database (Firestore REST + the live-update markers)
const FSB = "https://firestore.googleapis.com/v1/projects/psl-master/databases/(default)/documents";
const ROOT = "projects/psl-master/databases/(default)/documents";
const RTDB = "https://psl-master-default-rtdb.asia-southeast1.firebasedatabase.app";
let reqSeq = 0;
const waiters = {};
window.__net = (id, status, body) => { const w = waiters[id]; if (!w) return; delete waiters[id]; w({ status, body }); };
function request(method, url, body, headers, auth) {
  return new Promise(res => { const id = "r" + (++reqSeq); waiters[id] = res; N.request(id, method, url, JSON.stringify(headers || {}), body == null ? null : body, auth !== false); });
}
class DbError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function dbError(status, body) {
  let m = body || "";
  try { const o = JSON.parse(body); const e = Array.isArray(o) ? o[0] && o[0].error : o.error; if (e && e.message) m = e.message; } catch (x) { /* plain text */ }
  if (status === 0 || /OFFLINE/.test(m)) return new DbError("offline", "No internet connection - check the network and try again.");
  if (status === 401 || /SIGNED_OUT|UNAUTHENTICATED/.test(m)) return new DbError("expired", "Please sign in again.");
  if (/requires an index|FAILED_PRECONDITION: The query requires/.test(m)) return new DbError("index", "The database needs an index for this.");
  if (status === 403 || /PERMISSION_DENIED/.test(m)) return new DbError("denied", "The database refused this (permission denied).");
  if (status === 409 || /ALREADY_EXISTS/.test(m)) return new DbError("exists", "That record is already in the database.");
  if (status === 404 || /NOT_FOUND|FAILED_PRECONDITION/.test(m)) return new DbError("missing", "That record is not in the database (or was changed).");
  return new DbError("db", "Database problem: " + m);
}
function decode(d) {
  const doc = { id: String(d.name || "").split("/").pop(), f: {} };
  for (const k in (d.fields || {})) {
    const v = d.fields[k];
    if ("booleanValue" in v) doc.f[k] = !!v.booleanValue;
    else if ("stringValue" in v) doc.f[k] = v.stringValue;
    else if ("integerValue" in v) doc.f[k] = String(v.integerValue);
    else if ("doubleValue" in v) doc.f[k] = String(v.doubleValue);
    else if ("timestampValue" in v) doc.f[k] = v.timestampValue;
    else if ("arrayValue" in v) doc.f[k] = ((v.arrayValue || {}).values || []).map(x => x.stringValue != null ? x.stringValue : "");
    else doc.f[k] = "";
  }
  return doc;
}
const val = v => Array.isArray(v) ? { arrayValue: v.length ? { values: v.map(x => ({ stringValue: String(x) })) } : {} }
  : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v == null ? "" : v) };
const OPS = { "==": "EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL", "has": "ARRAY_CONTAINS" };
const fs = DEMO ? null : {
  async get(col, id) {
    const r = await request("GET", FSB + "/" + col + "/" + encodeURIComponent(id));
    if (r.status === 404) return null;
    if (r.status !== 200) throw dbError(r.status, r.body);
    return decode(JSON.parse(r.body));
  },
  async where(col, conds) {
    const filters = conds.map(c => ({ fieldFilter: { field: { fieldPath: c.f }, op: OPS[c.op || "=="], value: c.ts ? { timestampValue: c.v } : val(c.v) } }));
    const where = filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } };
    const r = await request("POST", FSB + ":runQuery", JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where } }), { "Content-Type": "application/json" });
    if (r.status !== 200) throw dbError(r.status, r.body);
    return JSON.parse(r.body).filter(x => x.document).map(x => decode(x.document));
  },
  async list(col) {
    const out = []; let tok = "";
    for (let p = 0; p < 50; p++) {
      const r = await request("GET", FSB + "/" + col + "?pageSize=300" + (tok ? "&pageToken=" + encodeURIComponent(tok) : ""));
      if (r.status !== 200) throw dbError(r.status, r.body);
      const o = JSON.parse(r.body);
      (o.documents || []).forEach(d => out.push(decode(d)));
      tok = o.nextPageToken || ""; if (!tok) break;
    }
    return out;
  },
  async commit(writes) {
    const arr = writes.map(w => {
      if (w.del) return { delete: ROOT + "/" + w.col + "/" + w.id };
      const fields = {}; for (const k in w.fields) fields[k] = val(w.fields[k]);
      const one = { update: { name: ROOT + "/" + w.col + "/" + (w.id || randomId()), fields } };
      if (w.mask) { one.updateMask = { fieldPaths: w.mask }; one.currentDocument = { exists: true }; }
      else one.currentDocument = { exists: false };
      if (w.serverTime) one.updateTransforms = w.serverTime.map(f => ({ fieldPath: f, setToServerValue: "REQUEST_TIME" }));     // the database's own clock
      return one;
    });
    const r = await request("POST", FSB + ":commit", JSON.stringify({ writes: arr }), { "Content-Type": "application/json" });
    if (r.status !== 200) throw dbError(r.status, r.body);
  }
};
function randomId() { let s = ""; const a = "abcdefghijklmnopqrstuvwxyz0123456789"; for (let i = 0; i < 20; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

// the doorbell: tell every open PSL Master what changed (PslShared\Signals.cs) - never fails the caller.
// This phone already shows what it changed itself, so its own bell coming back (the echo) is not read and drawn again.
const echoes = {};
function takeEcho(p) {
  const l = (echoes[p] || []).filter(t => Date.now() - t < 20000);
  echoes[p] = l;
  if (!l.length) return false;
  l.shift(); return true;
}
function ring(paths) {
  if (DEMO) return;
  for (const p of paths) {
    (echoes[p] = echoes[p] || []).push(Date.now());
    request("PUT", RTDB + "/signals/" + p + ".json", '{".sv":"timestamp"}', { "Content-Type": "application/json" }).catch(() => { takeEcho(p); });     // not sent: no echo to wait for
  }
}

// ===================================================================== state (kept on the phone, per person)
let ME = null;          // {email, name, employeeId, isAdmin, isApprover}
let ST = null;
const PROFILE = { name: "", staffId: "", jobTitle: "", department: "", supervisor: "", location: "Sarawak", wageBasis: "Monthly-rated", basicSalary: 0, normalHours: 8.5, normalDays: "Mon – Fri", restDay: "Sunday", shiftEnd: "17:30" };
function fresh() {
  return { profile: clone(PROFILE), profileSet: false, active: false, policy: { tilForCovered: false, restFree: 1, restAfter: 4 }, db: { claims: [], tilApps: [], payouts: [], adjusts: [] },
    drafts: { claim: null, pay: null, til: null }, lists: { certs: [], lic: {}, licFullAt: 0, tenders: [], tm: {}, tenderFullAt: 0 }, conf: [], names: {}, namesAt: 0,
    pulledAt: "", fullPullAt: "", lastLists: 0, lastMine: 0, isApprover: false, isHr: false, seen: {},
    office: { leave: {}, people: {}, pay: {}, pulled: "", full: 0 }, cal: { dates: [], at: 0 } };
}
const KEY = () => "psl.state." + (ME ? ME.email : "");
function save() { try { localStorage.setItem(KEY(), JSON.stringify(ST)); } catch (e) { /* full */ } }
function loadState() { try { const s = JSON.parse(localStorage.getItem(KEY()) || "null"); ST = Object.assign(fresh(), s || {}); } catch (e) { ST = fresh(); } }
const rates = () => E.rates(ST.profile.location);
const statutory = () => E.lawCovers(Object.assign({}, ST.profile, { staffId: ST.profile.staffId || ME.employeeId }), rates());
// the contract (set by the admin in PSL Master): may this person take credits as time in lieu / turn them into money? (the database checks it too)
const tilAllowed = () => !ST.profile || ST.profile.tilAllowed !== false;
const payAllowed = () => !ST.profile || ST.profile.otPayAllowed !== false;
const ledger = extra => E.build(ST.db, extra || null, TODAY(), rates(), statutory());

// ---- documents -> objects (Service.ClaimFromDoc etc.)
function base(d, o) {
  o.id = d.id; o.status = d.f.status || "";
  o.decidedAt = d.f.decidedAt || ""; o.decidedBy = d.f.decidedBy || ""; o.decisionNote = d.f.decisionNote || "";
  o.signedFile = d.f.signedFile || ""; o.signedName = d.f.signedName || "";
  return o;
}
function claimFrom(d) {
  let c; try { c = JSON.parse(d.f.data); } catch (e) { return null; }
  if (!c) return null; base(d, c);
  if (d.f.review) try { const rv = JSON.parse(d.f.review); c.lines = rv.lines; c.totals = rv.totals; } catch (e) { /* keep */ }
  c.lines = c.lines || []; return c;
}
function tilFrom(d) {
  let a; try { a = JSON.parse(d.f.data); } catch (e) { return null; }
  if (!a) return null; base(d, a);
  ["cancelReason", "cancelRequestedAt", "cancelDecidedAt", "cancelDecidedBy", "cancelNote"].forEach(k => a[k] = d.f[k] || "");
  if (d.f.review) try { const rv = JSON.parse(d.f.review); Object.assign(a, { lines: rv.lines, draws: rv.draws, totalHours: rv.totalHours, unpaidHours: rv.unpaidHours, creditsBefore: rv.creditsBefore, creditsAfter: rv.creditsAfter, decidedByName: rv.decidedByName || "" }); } catch (e) { /* keep */ }
  a.lines = a.lines || []; a.draws = a.draws || []; return a;
}
function payFrom(d) {
  let p; try { p = JSON.parse(d.f.data); } catch (e) { return null; }
  if (!p) return null; base(d, p);
  if (d.f.review) try { const rv = JSON.parse(d.f.review); Object.assign(p, { draws: rv.draws, amount: rv.amount, hours: rv.hours, creditsBefore: rv.creditsBefore, creditsAfter: rv.creditsAfter, decidedByName: rv.decidedByName || "" }); } catch (e) { /* keep */ }
  p.draws = p.draws || []; return p;
}
function adjustFrom(d) { let a; try { a = JSON.parse(d.f.data); } catch (e) { return null; } if (!a) return null; a.id = d.id; a.employeeId = d.f.employeeId || ""; return a; }
function policyFrom(d) {
  let p = { tilForCovered: false, restFree: 1, restAfter: 4 };
  if (d) try { p = Object.assign(p, JSON.parse(d.f.data)); } catch (e) { /* defaults */ }
  if (!(p.restFree >= 0 && p.restFree <= 2)) p.restFree = 1;
  if (!(p.restAfter >= 1 && p.restAfter <= 8)) p.restAfter = 4;
  return p;
}
const merge = (old, fresh) => old.filter(o => !fresh.some(n => n.id === o.id)).concat(fresh);

// ===================================================================== reading (only what changed - the read budget)
async function pullMine() {
  if (DEMO) return;
  if (!ME.employeeId) { ST.profileSet = false; ST.active = false; return; }
  const card = await fs.get("employees", ME.employeeId);
  const pay = await fs.get("ot_pay", ME.employeeId);
  ST.active = !!card && card.f.status === "active";
  const p = Object.assign(clone(PROFILE), pay ? JSON.parse(pay.f.profile || "{}") : {});
  p.staffId = ME.employeeId; p.normalDays = E.cleanDays(p.normalDays);
  if (card) { p.name = card.f.name || ""; p.jobTitle = card.f.position || ""; p.department = card.f.department || ""; p.joined = card.f.joinDate || ""; }
  if (!p.name) p.name = ME.name;
  ST.profile = p; ST.profileSet = !!pay;
  ST.policy = policyFrom(await fs.get("ot_settings", "policy"));
  if (!ME.isAdmin) { try { ST.isApprover = !!(await fs.get("ot_approvers", ME.email)); } catch (e) { ST.isApprover = false; } }
  if (!ME.isAdmin) { try { ST.isHr = !!(await fs.get("ot_hr", ME.email)); } catch (e) { ST.isHr = false; } }
  ME.isApprover = ST.isApprover; ME.isHr = ST.isHr;
  const started = E.nowStamp();
  let delta = !ST.noIndex && ST.fullPullAt && (Date.now() - Date.parse(ST.fullPullAt)) < 24 * 3600e3 && ST.pulledAt;
  const id = ME.employeeId;
  if (delta) {
    try {
      const since = stampMinus(ST.pulledAt, 24);
      const q = (col, f) => fs.where(col, [{ f: "employeeId", v: id }, { f: f || "updatedAt", op: ">", v: since }]);
      const cc = (await q("ot_claims")).map(claimFrom).filter(Boolean), ct = (await q("ot_til")).map(tilFrom).filter(Boolean);
      const cp = (await q("ot_payouts")).map(payFrom).filter(Boolean), ca = (await q("ot_adjust", "createdAt")).map(adjustFrom).filter(Boolean);
      ST.db.claims = merge(ST.db.claims, cc); ST.db.tilApps = merge(ST.db.tilApps, ct); ST.db.payouts = merge(ST.db.payouts, cp); ST.db.adjusts = merge(ST.db.adjusts, ca);
    } catch (e) { if (e.code !== "index") throw e; ST.noIndex = true; delta = false; }
  }
  if (!delta) {
    const q = col => fs.where(col, [{ f: "employeeId", v: id }]);
    ST.db.claims = (await q("ot_claims")).map(claimFrom).filter(Boolean);
    ST.db.tilApps = (await q("ot_til")).map(tilFrom).filter(Boolean);
    ST.db.payouts = (await q("ot_payouts")).map(payFrom).filter(Boolean);
    ST.db.adjusts = (await q("ot_adjust")).map(adjustFrom).filter(Boolean);
    ST.fullPullAt = started;
  }
  ST.pulledAt = started; ST.lastMine = Date.now();
  save(); remember();
}
function stampMinus(stamp, hoursBack) {
  const d = new Date(Date.parse(stamp) - hoursBack * 3600e3), p = x => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

const certFrom = d => ({ id: d.id, title: d.f.title || "(untitled certificate)", category: (d.f.category || "").trim() || "Other", number: d.f.number || "", note: d.f.note || "", expiry: d.f.expiry || "", updatedAt: d.f.updatedAt || "" });
const tenderFrom = d => ({ id: d.id, site: d.f.site || "", siteName: d.f.siteName || d.f.site || "", no: d.f.no || "", title: d.f.title || "(no title)", location: d.f.location || "", kind: d.f.kind || "",
  closingIso: d.f.closingIso || "", closingText: d.f.closingText || "", briefingIso: d.f.briefingIso || "", requirement: d.f.requirement || "", docFee: d.f.docFee || "", sourceUrl: d.f.sourceUrl || "",
  eligible: d.f.eligible === true, listed: d.f.listed !== false, decision: d.f.decision === "accepted" || d.f.decision === "declined" ? d.f.decision : "",
  attended: d.f.attended || "", purchased: d.f.purchased || "", submitted: d.f.submitted || "", updatedAt: d.f.updatedAt || "" });
const int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };

// the licence and tender lists: the summary first (1 read); the list only when it was published since - and then only what changed
async function refreshLists() {
  if (DEMO) return;
  const L = ST.lists;
  const lm = await fs.get("licensemaster_meta", "summary");
  const lic = lm ? { company: lm.f.companyName || "", criticalDays: int(lm.f.criticalDays, 30), highDays: int(lm.f.highDays, 60), mediumDays: int(lm.f.mediumDays, 90), lowDays: int(lm.f.lowDays, 180), last: lm.f.lastSyncedAt || "", total: int(lm.f.total, 0) } : {};
  if (!(lic.criticalDays > 0 && lic.criticalDays < lic.highDays && lic.highDays < lic.mediumDays && lic.mediumDays < lic.lowDays)) Object.assign(lic, { criticalDays: 30, highDays: 60, mediumDays: 90, lowDays: 180 });
  const haveL = L.lic.last && (Date.now() - L.licFullAt) < 12 * 3600e3;
  if (!(haveL && lic.last === L.lic.last)) {
    let certs = null;
    if (haveL && lic.last) {
      const ch = (await fs.where("licensemaster_certificates", [{ f: "updatedAt", op: ">", v: L.lic.last, ts: true }])).map(certFrom);
      certs = merge(L.certs, ch);
      if (lic.total > 0 && certs.length !== lic.total) certs = null;
    }
    if (!certs) { certs = (await fs.list("licensemaster_certificates")).map(certFrom); L.licFullAt = Date.now(); }
    L.certs = certs;
  }
  L.lic = lic;
  const tmd = await fs.get("tenderwatch_meta", "summary");
  const tm = tmd ? { company: tmd.f.companyName || "", warnDays: int(tmd.f.warnDays, 7), checkedAt: tmd.f.checkedAt || "", last: tmd.f.lastSyncedAt || "", total: int(tmd.f.total, 0) } : { warnDays: 7 };
  if (tm.warnDays < 1 || tm.warnDays > 60) tm.warnDays = 7;
  const haveT = L.tm.last && (Date.now() - L.tenderFullAt) < 12 * 3600e3;
  if (!(haveT && tm.last === L.tm.last)) {
    let ts = null;
    if (haveT && tm.last) {
      const ch = (await fs.where("tenderwatch_tenders", [{ f: "updatedAt", op: ">", v: L.tm.last, ts: true }])).map(tenderFrom);
      ts = merge(L.tenders, ch.filter(t => t.no));
      if (tm.total > 0 && ts.length !== tm.total) ts = null;
    }
    if (!ts) { ts = (await fs.list("tenderwatch_tenders")).map(tenderFrom).filter(t => t.no); L.tenderFullAt = Date.now(); }
    L.tenders = ts;
  }
  L.tm = tm;
  ST.lastLists = Date.now();
  save(); remember();
}

// approvers: what waits for them (by status - cheap)
async function refreshConf() {
  if (DEMO || !ME.isApprover) { if (!DEMO) ST.conf = []; return; }
  if (Date.now() - ST.namesAt > 6 * 3600e3) {
    const m = {}; (await fs.list("employees")).forEach(d => m[d.f.employeeId || d.id] = d.f.name || "");
    ST.names = m; ST.namesAt = Date.now();
  }
  const mine = d => ME.employeeId && String(d.f.employeeId || "").toUpperCase() === ME.employeeId.toUpperCase();
  const name = d => ST.names[d.f.employeeId] || d.f.name || d.f.employeeId;
  const out = [];
  for (const d of await fs.where("ot_claims", [{ f: "status", v: "submitted" }])) {
    const c = claimFrom(d); if (!c || mine(d)) continue;
    out.push({ kind: "claim", id: c.id, emp: d.f.employeeId, name: name(d), at: c.submittedAt, hours: c.totals.hours, amount: (c.schema || 0) < 2 ? c.totals.otPay : c.totals.value,
      period: c.lines.map(l => E.showDate(l.date)).filter((x, i, a) => a.indexOf(x) === i).join(", "), notes: (c.warnings || []).length });
  }
  for (const d of await fs.where("ot_payouts", [{ f: "status", v: "submitted" }])) {
    const p = payFrom(d); if (!p || mine(d)) continue;
    out.push({ kind: "pay", id: p.id, emp: d.f.employeeId, name: name(d), at: p.submittedAt, hours: p.hours, amount: p.amount, period: "OT pay from credits", notes: (p.warnings || []).length });
  }
  for (const st of ["submitted", "cancel_requested"])
    for (const d of await fs.where("ot_til", [{ f: "status", v: st }])) {
      const a = tilFrom(d); if (!a || (mine(d) && !(st === "submitted" && a.category === "Sick Leave"))) continue;      // their own sick leave they may approve
      out.push({ kind: st === "submitted" ? "til" : "cancel", id: a.id, emp: d.f.employeeId, name: name(d), at: st === "submitted" ? a.submittedAt : a.cancelRequestedAt, category: a.category || "",
        hours: a.totalHours, unpaid: a.unpaidHours, period: a.lines.map(l => E.showDate(l.date)).join(", "), reason: a.cancelReason, notes: (a.warnings || []).length });
    }
  try {
    for (const d of await fs.where("office_trainings", [{ f: "status", v: "submitted" }])) {
      const x = trainingFrom(d);
      out.push({ kind: "training", id: x.id, emp: "", name: x.byName || x.by, at: x.createdAt, hours: 0, period: x.kind + ": " + x.title + " · " + dmy(x.from) + (x.to !== x.from ? " – " + dmy(x.to) : "") + (trnTime(x) ? " · " + trnTime(x) : ""), trn: x, notes: 0 });
    }
  } catch (e) { if (e.code === "offline" || e.code === "expired") throw e; }
  ST.conf = out.sort((x, y) => (x.at || "") < (y.at || "") ? -1 : 1);
  save();
}

// small facts the 9am / 5pm reminder uses without opening the app
function remember() {
  try {
    N.save("me", JSON.stringify({ employeeId: ME.employeeId, isApprover: !!ME.isApprover, isAdmin: !!ME.isAdmin }));
    N.save("licences", JSON.stringify({ criticalDays: ST.lists.lic.criticalDays || 30, items: ST.lists.certs.map(c => ({ t: c.title, e: c.expiry })) }));
    N.save("tenders", JSON.stringify({ warnDays: ST.lists.tm.warnDays || 7, items: ST.lists.tenders.map(t => ({ n: t.no, c: t.closingIso, s: E.tStatus(t, TODAY()) })) }));
  } catch (e) { /* not important */ }
}

let syncing = false, syncErr = "";
async function syncAll(force) {
  if (syncing) return; syncing = true; lastSync = Date.now();
  try {
    if (force || Date.now() - ST.lastMine > 30 * 60e3) await pullMine();
    // the shared lists are checked EVERY time the app opens or comes back (2 reads when nothing changed), so a tender declined,
    // a licence renewed, a reminder or a training removed shows the same here as on every other phone and PC
    await refreshLists();
    await refreshConf();
    if (officeAllowed()) await refreshOffice(false);
    else await refreshBoard();
    await refreshCal(true);
    syncErr = "";
  } catch (e) { syncErr = e.message || String(e); if (e.code === "expired") return signedOut(); }
  finally { syncing = false; }
  quietRender();
}

// ===================================================================== Who's in (the admin, approvers and HR - as Office.cs on the PC)
const officeAllowed = () => !!ME && (ME.isAdmin || ME.isApprover || ME.isHr);
const LEAVE_ON = ["submitted", "approved", "cancel_requested"];
const LEAVE_GONE = ["withdrawn", "cancelled"];          // kept for the calendar (struck through) - Who's in ignores them
const slimLeave = d => { const a = tilFrom(d); return a ? { emp: String(d.f.employeeId || "").toUpperCase(), status: a.status, by: a.decidedByName || a.decidedBy || "", cat: a.category || "",
  lines: a.lines.map(l => ({ date: l.date, leaveType: l.leaveType, from: l.from || "", to: l.to || "", paidBy: l.paidBy, reason: l.reason || "" })) } : null; };
const cardOf = d => ({ name: d.f.name || "", position: d.f.position || "", department: d.f.department || "", status: d.f.status || "active", leftOn: d.f.leftOn || "" });
const workOf = d => { try { const p = JSON.parse(d.f.profile || "{}"); return { normalDays: E.cleanDays(p.normalDays), restDay: p.restDay || "Sunday" }; } catch (e) { return null; } };
async function refreshOffice(force, changedIds) {
  if (DEMO || !officeAllowed()) return;
  const O = ST.office || (ST.office = { leave: {}, people: {}, pay: {}, pulled: "", full: 0 });
  if (!O.gone) O.gone = {};
  const started = E.nowStamp();
  if (force || !O.full || !O.pulled || Date.now() - O.full > 6 * 3600e3) {
    const people = {}, pay = {}, leave = {};
    (await fs.list("employees")).forEach(d => people[String(d.f.employeeId || d.id).toUpperCase()] = cardOf(d));
    (await fs.list("ot_pay")).forEach(d => { const w = workOf(d); if (w) pay[String(d.f.employeeId || d.id).toUpperCase()] = w; });
    for (const st of LEAVE_ON) for (const d of await fs.where("ot_til", [{ f: "status", v: st }])) { const x = slimLeave(d); if (x) leave[d.id] = x; }
    const gone = {};
    for (const st of LEAVE_GONE) for (const d of await fs.where("ot_til", [{ f: "status", v: st }])) { const x = slimLeave(d); if (x) gone[d.id] = x; }
    Object.assign(O, { people, pay, leave, gone, full: Date.now() });
  } else {
    for (const d of await fs.where("ot_til", [{ f: "updatedAt", op: ">", v: stampMinus(O.pulled, 1 / 6) }])) {
      const x = LEAVE_ON.indexOf(d.f.status) >= 0 ? slimLeave(d) : null;
      if (x) O.leave[d.id] = x; else delete O.leave[d.id];
      const g = LEAVE_GONE.indexOf(d.f.status) >= 0 ? slimLeave(d) : null;
      if (g) O.gone[d.id] = g; else delete O.gone[d.id];
    }
    for (const id of changedIds || []) {
      const c = await fs.get("employees", id); if (c) O.people[id.toUpperCase()] = cardOf(c); else delete O.people[id.toUpperCase()];
      const p = await fs.get("ot_pay", id); const w = p ? workOf(p) : null; if (w) O.pay[id.toUpperCase()] = w; else delete O.pay[id.toUpperCase()];
    }
  }
  O.pulled = started; save();
}
const leaveText = l => (l.leaveType === "Full Day" ? "Full day" : l.leaveType === "Half Day (AM)" ? "Morning off" : l.leaveType === "Half Day (PM)" ? "Afternoon off"
  : l.leaveType === "Hours" ? "Away " + l.from + (l.to ? "–" + l.to : "") : l.leaveType) + (l.paidBy === "Unpaid" ? " · unpaid" : "");
// everybody else reads the office board the admin / approvers / HR publish (office_board/now): who is in, away all day or half a
// day, and when they are back - never the type of leave, reasons or requests still waiting
async function refreshBoard() {
  if (DEMO || officeAllowed()) return;
  try {
    const d = await fs.get("office_board", "now");
    let data = null; try { data = d ? JSON.parse(d.f.data || "null") : null; } catch (e) { data = null; }
    ST.board = { data, at: Date.now(), updatedAt: d ? d.f.updatedAt || "" : "" }; save();
  } catch (e) { if (e.code === "offline" || e.code === "expired") throw e; ST.board = { data: null, at: Date.now(), error: e.message }; }
}
// "Coming up": days in a row of the same thing become one line "Tue 13/10 – Sat 17/10" - keyed by the training / event (or leave)
// ID, so two with the same name are never joined. Only what starts by lastStart is listed.
const upRanges = (list, lastStart) => {
  const out = [];
  list.slice().sort((a, b) => a.l.date < b.l.date ? -1 : a.l.date > b.l.date ? 1 : String(a.key) < String(b.key) ? -1 : 1).forEach(x => {
    const text = leaveText(x.l).replace(/ \(last day\)$/, ""), g = out.filter(y => y.key === x.key && y.text === text && y.ok === x.ok).pop();
    if (g && E.iso(E.addDays(E.day(g.to), 1)) === x.l.date) { g.to = x.l.date; return; }
    out.push({ l: x.l, ok: x.ok, key: x.key, text, to: x.l.date });
  });
  return out.filter(x => x.l.date <= lastStart);
};
function boardDay(dayIso) {
  const B = ST.board && ST.board.data, ppl = (B && B.people) || {};
  const words = c => String(c).indexOf("trn|") === 0 ? String(c).slice(4) : c === "out" ? "Away all day" : c === "am" ? "Morning off" : c === "pm" ? "Afternoon off" : "Away part of the day";
  const LT = { out: "Full Day", am: "Half Day (AM)", pm: "Half Day (PM)", part: "Part of the day" };
  const day = E.day(dayIso), counts = { out: 0, part: 0, training: 0, in: 0, rest: 0, asked: 0 }, people = [];
  Object.keys(ppl).forEach(id => {
    const x = ppl[id] || {}, a = x.a || {}, ti = x.t || {}, work = { normalDays: x.w || "Mon – Fri", restDay: x.r || "Sunday" };
    const stateOn = iso => { const c = a[iso]; return c === "out" ? "out" : c && String(c).indexOf("trn|") === 0 ? "training" : c ? "part" : E.expectedDayType(work, E.day(iso)) !== "Normal Working Day" ? "rest" : "in"; };
    const st = stateOn(dayIso);
    let back = "";
    if (st === "out") for (let i = 1; i <= 90; i++) { const iso = E.iso(E.addDays(day, i)), s2 = stateOn(iso); if (s2 === "in" || s2 === "part" || s2 === "training") { back = iso; break; } }
    const week = []; for (let i = 0; i < 7; i++) { const iso = E.iso(E.addDays(day, i)); week.push({ date: iso, state: stateOn(iso), asked: false }); }
    const ups = []; for (let i = 1; i <= 60; i++) { const iso = E.iso(E.addDays(day, i)); if (a[iso]) ups.push({ l: { date: iso, leaveType: LT[a[iso]] || words(a[iso]) }, ok: true, key: String(a[iso]).indexOf("trn|") === 0 ? "trn|" + (ti[iso] || "") : "away" }); }
    const upcoming = upRanges(ups, E.iso(E.addDays(day, 14))).slice(0, 4);
    counts[st]++;
    people.push({ id, name: x.n || id, job: [id, x.p, x.d].filter(Boolean).join(" · "), state: st, back, week, upcoming, asked: [], detail: a[dayIso] ? words(a[dayIso]) : "", reason: "", cancelAsked: false, by: "" });
  });
  const order = { out: 0, part: 1, training: 2, in: 3, rest: 4 };
  people.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return { people, counts, limited: true, missing: !B };
}
// one day for everybody (Office.Day): out = a full day away, part = half day / hours, rest = not a working day for them, in
function officeDay(dayIso) {
  if (!officeAllowed()) return boardDay(dayIso);
  const O = ST.office || { leave: {}, people: {}, pay: {} };
  const away = {};
  Object.keys(O.leave).forEach(k => { const a = O.leave[k]; (away[a.emp] = away[a.emp] || []).push(...a.lines.filter(l => l.date).map(l => ({ l, a, ok: a.status !== "submitted", key: "lv|" + k }))); });
  // approved training / events: employee ID -> date -> "Training: First aid · 09:00–17:00"
  const tdays = {}, tids = {};          // tids: employee ID -> date -> the training / event ID(s) - two with the same name stay apart
  ((ST.cal || {}).trainings || []).filter(x => x.status === "approved").forEach(x => x.people.forEach(p => {
    const P = String(p).toUpperCase(), m = tdays[P] = tdays[P] || {}, mi = tids[P] = tids[P] || {};
    for (let d = E.day(x.from), i = 0; d && E.iso(d) <= x.to && i < 60; d = E.addDays(d, 1), i++) { const k = E.iso(d), lbl = trnLabelFor(x, p, k); if (lbl) { m[k] = m[k] ? m[k] + " + " + lbl : lbl; mi[k] = mi[k] ? mi[k] + "+" + x.id : x.id; } }
  }));
  const stateOn = (mine, work, iso, id) => {
    const that = mine.filter(x => x.l.date === iso), ok = that.filter(x => x.ok);
    let st = ok.some(x => x.l.leaveType === "Full Day") ? "out" : ok.length ? "part" : E.expectedDayType(work || {}, E.day(iso)) !== "Normal Working Day" ? "rest" : "in";
    if (st !== "out" && id && (tdays[id] || {})[iso]) st = "training";          // working, but not in the office
    return { st, that };
  };
  const day = E.day(dayIso), counts = { out: 0, part: 0, training: 0, in: 0, rest: 0, asked: 0 }, people = [];
  Object.keys(O.people).forEach(id => {
    const c = O.people[id];
    if (c.status === "inactive" || c.status === "left") return;
    const mine = away[id] || [], work = O.pay[id] || null;
    const { st, that } = stateOn(mine, work, dayIso, id);
    const shown = that.filter(x => x.ok), asked = that.filter(x => !x.ok);
    let back = "";
    if (st === "out") for (let i = 1; i <= 90; i++) { const iso = E.iso(E.addDays(day, i)), s2 = stateOn(mine, work, iso, id).st; if (s2 === "in" || s2 === "part" || s2 === "training") { back = iso; break; } }
    const week = []; for (let i = 0; i < 7; i++) { const iso = E.iso(E.addDays(day, i)), r = stateOn(mine, work, iso, id); week.push({ date: iso, state: r.st, asked: r.that.some(x => !x.ok) }); }
    const end = E.iso(E.addDays(day, 60));
    const upcoming = upRanges(mine.filter(x => x.l.date > dayIso && x.l.date <= end)
      .concat(Object.keys(tdays[id] || {}).filter(d => d > dayIso && d <= end).map(d => ({ l: { date: d, leaveType: tdays[id][d] }, ok: true, key: "trn|" + ((tids[id] || {})[d] || "") }))),     // training / events too
      E.iso(E.addDays(day, 14))).slice(0, 4);
    counts[st]++; if (asked.length) counts.asked++;
    people.push({ id, name: c.name || id, job: [id, c.position, c.department].filter(Boolean).join(" · "), state: st, back, week, upcoming, asked,
      detail: [(tdays[id] || {})[dayIso]].concat(shown.map(x => (x.a.cat ? leaveLabel(x.a.cat) + " · " : "") + leaveText(x.l))).filter(Boolean).join(" + "), reason: shown.map(x => x.l.reason).filter(Boolean).join("; "),
      cancelAsked: shown.some(x => x.a.status === "cancel_requested"), by: shown.map(x => x.a.by).filter(Boolean).join(", ") });
  });
  const order = { out: 0, part: 1, training: 2, in: 3, rest: 4 };
  people.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return { people, counts };
}
// ===================================================================== the calendar (Calendar.cs on the PC): blue important dates for all,
// red time off for the admin / approvers / HR. The important dates are a small list - read whole, again when the "calendar" bell rings.
async function refreshCal(force) {
  if (DEMO) return;
  if (!force && ST.cal && ST.cal.at && Date.now() - ST.cal.at < 6 * 3600e3) return;
  // important dates: the admin reads them all; everybody else asks only for the ones meant for them (the database refuses the rest)
  let docs;
  if (ME.isAdmin) docs = await fs.list("office_dates");
  else {
    const m = {}, add = ds => ds.forEach(d => m[d.id] = d);
    add(await fs.where("office_dates", [{ f: "audience", v: "all" }]));
    if (officeAllowed()) add(await fs.where("office_dates", [{ f: "audience", v: "office" }]));
    add(await fs.where("office_dates", [{ f: "by", v: ME.email }]));
    add(await fs.where("office_dates", [{ f: "to", op: "has", v: ME.email }]));
    docs = Object.values(m);
  }
  const forWho = d => { const a = d.f.audience || "all"; return a === "office" ? "Admin, approvers & HR" : a === "me" ? (d.f.by === ME.email ? "Only you" : "Only " + d.f.by) : a === "people" ? (d.f.toNames || "Chosen people") : "Whole office"; };
  const list = docs.map(d => ({ id: d.id, title: d.f.title || "", date: d.f.date || "", end: d.f.end || d.f.date || "", note: d.f.note || "", forWho: forWho(d) })).filter(x => x.date);
  // reminders: mine, the whole office's, and the ones that name me
  const rem = {};
  try {
    const add = ds => ds.forEach(d => rem[d.id] = d);
    add(await fs.where("office_reminders", [{ f: "by", v: ME.email }]));
    add(await fs.where("office_reminders", [{ f: "audience", v: "all" }]));
    add(await fs.where("office_reminders", [{ f: "to", op: "has", v: ME.email }]));
  } catch (e) { if (e.code === "offline" || e.code === "expired") throw e; }
  let trainings = [];
  try { trainings = (await fs.list("office_trainings")).map(trainingFrom); }
  catch (e) { if (e.code === "offline" || e.code === "expired") throw e; }
  const reminders = Object.values(rem).map(d => ({ id: d.id, title: d.f.title || "", date: d.f.date || "", time: d.f.time || "", note: d.f.note || "", by: d.f.by || "", byName: d.f.byName || "",
    audience: d.f.audience || "me", to: Array.isArray(d.f.to) ? d.f.to : [], toNames: d.f.toNames || "", mine: d.f.by === ME.email })).filter(x => x.date);
  ST.cal = { dates: list, reminders, trainings, at: Date.now() }; save();
}
// training / events: working, but not in the office - one record for everybody in it
const trainingFrom = d => ({ id: d.id, title: d.f.title || "", kind: d.f.kind === "Event" ? "Event" : "Training", from: d.f.from || "", to: d.f.to || d.f.from || "", start: d.f.start || "", end: d.f.end || "",
  place: d.f.place || "", notes: d.f.notes || "", people: Array.isArray(d.f.people) ? d.f.people : [], names: Array.isArray(d.f.names) ? d.f.names : [], early: Array.isArray(d.f.early) ? d.f.early : [], status: d.f.status || "",
  by: d.f.by || "", byName: d.f.byName || "", decidedByName: d.f.decidedByName || "", decisionNote: d.f.decisionNote || "", createdAt: d.f.createdAt || "" });
const trnTime = x => x.start ? x.start + (x.end ? "–" + x.end : "") : "";
// leaving early: "PSL12=2026-10-14 15:00" (that day at that time) or "PSL12=2026-10-14" (their last day); older "PSL12=15:00" = the first day
const parseEarly = (v, from) => { const r = { d: "", t: "" }; String(v || "").trim().split(/\s+/).forEach(p => { if (/^\d{4}-\d{2}-\d{2}$/.test(p)) r.d = p; else if (/^\d{2}:\d{2}$/.test(p)) r.t = p; }); if (!r.d) r.d = from || ""; return r; };
const trnEarlyOf = (x, id) => { const e = (x.early || []).find(v => v.indexOf(String(id).toUpperCase() + "=") === 0); return e ? parseEarly(e.split("=")[1], x.from) : null; };
const showEarly = r => !r || !r.d ? "" : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][E.day(r.d).getUTCDay()] + " " + dmy(r.d).substr(0, 5) + (r.t ? " " + r.t : " (last day)");
// one person on one day: "" after the day they leave; on that day, until the time they leave
const trnLabelFor = (x, id, iso) => {
  const e = trnEarlyOf(x, id), base = x.kind + ": " + x.title + (trnTime(x) ? " · " + trnTime(x) : "");
  if (!e) return base;
  if (iso > e.d) return "";
  if (iso !== e.d || !e.t) return base + (iso === e.d ? " (last day)" : "");
  return x.kind + ": " + x.title + " · " + (x.start ? x.start + "–" : "until ") + e.t + " (leaves early)";
};
const trnWithMe = x => !!ME.employeeId && x.people.some(p => String(p).toUpperCase() === ME.employeeId.toUpperCase());
const trnVisible = x => x.status === "approved" || (x.status === "submitted" && (officeAllowed() || x.by === ME.email || trnWithMe(x)));
// everybody in it on one day: gone = they left early on an earlier day
const trnHere = (x, iso) => x.people.map((p, i) => { const r = trnEarlyOf(x, p); return { name: x.names[i] || p, r, gone: !!(r && r.d < iso) }; });
// a day everybody has already left is not on the calendar
const trnOn = iso => ((ST.cal || {}).trainings || []).filter(x => trnVisible(x) && x.from <= iso && x.to >= iso && (!x.people.length || trnHere(x, iso).some(h => !h.gone)))
  .sort((a, b) => (a.start || "99") < (b.start || "99") ? -1 : 1);
const remWho = x => x.audience === "all" ? "Whole office" : x.audience === "people" ? (x.toNames || "Chosen people") : x.mine ? "Only you" : "Only " + (x.byName || x.by);
// tenders on the calendar (Views.CalendarExtras): the ones we bid for (closing + briefing) and eligible ones not decided yet - never declined
function tenderMarks(iso) {
  const out = [];
  for (const t of ST.lists.tenders) {
    if (!t.listed || t.decision === "declined") continue;
    const bid = t.decision === "accepted";
    if (!bid && !t.eligible) continue;
    const where = t.siteName || t.site;
    if (t.closingIso && t.closingIso.substr(0, 10) === iso) out.push({ id: t.id, strong: bid, title: (bid ? "Tender closes: " : "Eligible tender closes: ") + t.no, sub: where + " · " + t.title + (bid && t.submitted ? " · submitted" : bid ? " · not submitted yet" : " · not decided yet") });
    if (t.briefingIso && t.briefingIso.substr(0, 10) === iso) out.push({ id: t.id, strong: bid, title: "Tender briefing / site visit: " + t.no, sub: where + " · " + t.title + (bid && t.attended ? " · attended" : "") });
  }
  return out;
}
function calDay(iso) {
  const imp = ((ST.cal || {}).dates || []).filter(x => x.date <= iso && x.end >= iso);
  const away = [];
  const ten = tenderMarks(iso), today = TODAY();
  const lic = ST.lists.certs.filter(c => c.expiry === iso).map(c => { const left = E.daysTo(c.expiry, today); return { title: "Expires: " + c.title, sub: c.category + (c.number ? " · No. " + c.number : ""), strong: left !== null && left <= 30 }; });
  const rem = ((ST.cal || {}).reminders || []).filter(x => x.date === iso).sort((a, b) => (a.time || "99") < (b.time || "99") ? -1 : 1);
  const trn = trnOn(iso);
  if (!officeAllowed()) {                              // their own time off in detail + everybody else's names from the office board
    const B = ST.board && ST.board.data, LT = { out: "Full Day", am: "Half Day (AM)", pm: "Half Day (PM)", part: "Part of the day" };
    Object.keys((B && B.people) || {}).forEach(id => {
      if (ME.employeeId && id.toUpperCase() === ME.employeeId.toUpperCase()) return;
      const x = B.people[id], c = (x.a || {})[iso];
      if (!c || String(c).indexOf("trn|") === 0) return;
      away.push({ name: x.n || id, emp: id, l: { date: iso, leaveType: LT[c] || "Part of the day", reason: "" }, full: c === "out", ok: true, cancel: false, gone: false, state: "approved", by: "", cat: "" });
    });
    ST.db.tilApps.filter(a => a.status !== "draft" && a.status !== "declined").forEach(a => (a.lines || []).filter(l => l.date === iso).forEach(l => away.push({ name: "You", emp: ME.employeeId, l,
      full: l.leaveType === "Full Day", ok: a.status !== "submitted", cancel: a.status === "cancel_requested", gone: a.status === "withdrawn" || a.status === "cancelled", state: a.status, by: a.decidedByName || "", cat: a.category || "" })));
  }
  if (officeAllowed()) {
    const O = ST.office || { leave: {}, people: {} };
    Object.keys(O.gone || {}).forEach(k => { const a = O.gone[k]; a.lines.filter(l => l.date === iso).forEach(l => away.push({ name: (O.people[a.emp] || {}).name || a.emp, emp: a.emp, l,
      full: l.leaveType === "Full Day", ok: true, cancel: false, gone: true, state: a.status, by: a.by, cat: a.cat })); });
    // last working days from People (the admin, approvers and HR)
    Object.keys(O.people || {}).forEach(k => { const p = O.people[k]; if (p.leftOn === iso) imp.push({ id: "", title: "Last working day: " + (p.name || k), date: iso, end: iso, note: "From People (" + k + ")", forWho: "Admin, approvers & HR" }); });
    Object.keys(O.leave).forEach(k => { const a = O.leave[k]; a.lines.filter(l => l.date === iso).forEach(l => away.push({ name: (O.people[a.emp] || {}).name || a.emp, emp: a.emp, l,
      full: l.leaveType === "Full Day", ok: a.status !== "submitted", cancel: a.status === "cancel_requested", by: a.by, cat: a.cat })); });
    away.sort((x, y) => (x.gone ? 1 : 0) - (y.gone ? 1 : 0) || x.name.localeCompare(y.name));
  }
  if (!officeAllowed()) away.sort((x, y) => (x.name === "You" ? -1 : 0) - (y.name === "You" ? -1 : 0) || (x.gone ? 1 : 0) - (y.gone ? 1 : 0) || x.name.localeCompare(y.name));
  return { imp, away, ten, lic, rem, trn };
}

// who else is away on the days of a time-off request (shown to the approver)
function othersAway(emp, dates) {
  const O = ST.office || { leave: {}, people: {} }, out = [];
  Object.keys(O.leave).forEach(k => { const a = O.leave[k]; if (a.emp === String(emp).toUpperCase()) return;
    a.lines.filter(l => dates.indexOf(l.date) >= 0).forEach(l => out.push(((O.people[a.emp] || {}).name || a.emp) + " - " + dmy(l.date) + " " + leaveText(l) + (a.status === "submitted" ? " (asked)" : ""))); });
  return out.sort();
}

// ---- live updates (while the app is on screen)
let liveOn = false, pendingKeys = new Set(), liveTimer = null;
window.__live = on => { liveOn = on; const l = $("#live"); if (l) { l.innerHTML = on ? "<i></i><span>Live</span>" : "<i></i><span>Offline</span>"; l.classList.toggle("off", !on); } };
window.__signal = keys => {
  keys = keys.filter(k => !takeEcho(k));            // only the echo of this phone's own change
  if (!keys.length) return;
  keys.forEach(k => pendingKeys.add(k));
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    const ks = Array.from(pendingKeys); pendingKeys.clear();
    try {
      if (ks.some(k => k === "tenders" || k === "licences")) await refreshLists();
      if (ks.some(k => k === "settings" || k === "people/" + ME.employeeId)) await pullMine();
      // People changed somebody: the approver's list shows names as they are now (only that person is read again)
      const changed = ks.filter(k => k.indexOf("people/") === 0 && k !== "people/" + ME.employeeId).map(k => k.slice(7));
      if (changed.length && ME.isApprover && !DEMO) {
        for (const id of changed) { const d = await fs.get("employees", id); if (d) ST.names[id] = d.f.name || ""; else delete ST.names[id]; }
        save();
      }
      if (ks.includes("approvals") || (changed.length && ME.isApprover)) await refreshConf();
      if (officeAllowed() && !DEMO && (ks.includes("approvals") || changed.length)) await refreshOffice(false, changed);
      if (ks.includes("calendar")) { await refreshCal(true); await refreshBoard(); }
      // an open request: that employee's details changed - read them again (the approver's corrections stay)
      if (apprItem && !DEMO && changed.indexOf(String(apprItem.emp).toUpperCase()) >= 0) { await currentDetails(apprItem); toast("Employee details updated"); }
    } catch (e) { /* the safety net catches up */ }
    quietRender();
  }, 2500);
};
const editing = () => { const a = document.activeElement; return a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName); };

// 2. a look at the database (live bell, back on screen, the 10-minute check) draws the page again ONLY when something shown changed -
// and never under the fingers of somebody typing: then once they leave the field
let shownSig = "", renderWaiting = false;
function stateSig() {
  try {
    return JSON.stringify([ST, syncErr, ME && ME.isApprover, ME && ME.isHr], function (k, v) {
      // when things were last read - not something shown
      if (this === ST && (k === "lastMine" || k === "lastLists" || k === "pulledAt" || k === "fullPullAt" || k === "namesAt")) return undefined;
      if (ST && ((this === ST.office && (k === "pulled" || k === "full")) || (this === ST.cal && k === "at") || (this === ST.board && k === "at")
        || (this === ST.lists && (k === "licFullAt" || k === "tenderFullAt")))) return undefined;
      return v;
    });
  } catch (e) { return String(Date.now()); }
}
function quietRender() {
  if (!ME || !ST) return;
  if (editing()) { renderWaiting = true; return; }
  if (stateSig() === shownSig) return;
  render();
}
const catchUp = () => { if (renderWaiting && !editing()) { renderWaiting = false; quietRender(); } };
document.addEventListener("focusout", () => setTimeout(catchUp, 0));
setInterval(catchUp, 1500);          // in case leaving the field sends no event (keyboard closed, app switched)

// ===================================================================== doing things (Service.cs / Approval.cs on the phone)
const SAFE = s => String(s || "").replace(/[^A-Za-z0-9]/g, "");
function newRef(prefix, taken) {
  const t = TODAY_ISO().replace(/-/g, ""), stem = prefix + "-" + SAFE(ST.profile.staffId) + "-" + t + "-";
  let n = 1; while (taken.indexOf(stem + n) >= 0) n++;
  return stem + n;
}
function notAllowed() {
  if (ME.isAdmin) return "The admin account does not record or request overtime.";
  if (!ME.employeeId) return "Your Google account has no employee ID yet - ask the admin to add you in People.";
  if (!ST.active) return "Your employee record (" + ME.employeeId + ") is switched off. Ask the admin.";
  if (!ST.profileSet) return "The office has not set your overtime pay details yet. Ask the admin.";
  return E.profileProblem(ST.profile);
}
function submitFields(at, code, hash, data) {
  return { employeeId: ME.employeeId, email: ME.email, name: ST.profile.name, schema: "2", status: "submitted", submittedAt: at, code, hash, data,
    decidedAt: "", decidedBy: "", decisionNote: "", review: "", withdrawnAt: "", updatedAt: at };
}
// the audit trail (legal record - see Audit.cs on the PC): who did what, to whom, from which device; the DATABASE stamps the time
// ("serverAt") and every entry is sealed with SHA-256 - exactly as the PC does, so the export checks phone entries too
const AUDIT_DEVICE = /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone" : /Android/i.test(navigator.userAgent) ? "Android phone" : "Phone";
const auditClean = (v, n) => String(v == null ? "" : v).replace(/[\r\n]/g, " ").trim().slice(0, n);
const auditRole = () => ME.isAdmin ? "admin" : [ME.isApprover && "approver", ME.isHr && "HR"].filter(Boolean).join(" + ") || "employee";
const auditHash = f => N.sha256(["PSLAUDIT2", f.employeeId, f.email, f.at, f.what, f.ref, f.detail, f.actorName, f.actorEmployeeId, f.role, f.device, f.app, (f.subjects || []).join(",")].join("\n"));
function eventWrite(emp, what, ref, detail, subjects) {
  const subj = [];
  if (emp) subj.push(String(emp).toUpperCase());
  (subjects || []).forEach(x => { x = String(x || "").toUpperCase(); if (x && subj.indexOf(x) < 0) subj.push(x); });
  const f = { employeeId: emp || "", email: ME.email, at: E.nowStamp(), what: auditClean(what, 120), ref: auditClean(ref, 120), detail: auditClean(detail, 1500),
    actorName: auditClean(ST && ST.profile && ST.profile.name ? myName() : ME.name || "", 120), actorEmployeeId: ME.employeeId || "", role: auditRole(), device: AUDIT_DEVICE,
    app: "PSL Master " + (N.version ? N.version() : ""), subjects: subj, schema: "audit2" };
  f.hash = auditHash(f);
  return { col: "ot_events", fields: f, serverTime: ["serverAt"] };
}
const blankCommon = () => ({ createdAt: E.nowStamp(), updatedAt: E.nowStamp(), submittedAt: "", submittedDate: "", warnings: [], hash: "", code: "", xlsx: "", pdf: "",
  decidedAt: "", decidedBy: "", decisionNote: "", signedFile: "", signedName: "" });

function refreshClaim(c) {
  c.schema = 2; c.profile = clone(ST.profile); c.rates = rates();
  for (const l of c.lines) { const d = E.day(l.date); l.dayType = d ? E.expectedDayType(c.profile, d) : ""; }
  const first = c.lines.map(l => l.date).filter(x => x.length >= 7).sort()[0];
  c.month = first ? first.substr(0, 7) : TODAY_ISO().substr(0, 7);
  E.compute(c);
}
function newClaimDraft() {
  return Object.assign(blankCommon(), { schema: 2, id: "", rev: 1, month: "", status: "draft", profile: clone(ST.profile), rates: rates(), lines: [], totals: {}, replaces: "" });
}
const blankLine = prev => ({ date: "", dayType: "", start: prev ? prev.start : (ST.profile.shiftEnd || "17:30"), end: prev ? prev.end : "", remarks: "", breakHrs: 0, note: "",
  day: "", hours: 0, within: 0, beyond: 0, value: 0, comp: "OT Pay", tilHrs: 0, otPay: 0, til: 0 });

async function send(col, obj, canon, extraFields, what, detail) {
  for (let attempt = 0; attempt < 3; attempt++) {
    obj.submittedAt = E.nowStamp(); obj.submittedDate = TODAY_ISO();
    obj.hash = N.sha256(canon(obj)); obj.code = E.shortCode(obj.hash); obj.status = "submitted";
    const f = Object.assign(submitFields(obj.submittedAt, obj.code, obj.hash, JSON.stringify(obj)), extraFields(obj));
    try {
      if (!DEMO) await fs.commit([{ col, id: obj.id, fields: f }, eventWrite(ME.employeeId, what, obj.id, detail(obj))]);
      ring(["approvals", "people/" + ME.employeeId]);
      return;
    } catch (e) {
      obj.status = "draft";
      if (e.code === "exists") { obj.id = obj.id.replace(/-(\d+)$/, (m, n) => "-" + (+n + 1)); continue; }   // the same number was used on another device
      throw e;
    }
  }
  throw new DbError("exists", "Could not find a free reference - try again.");
}

async function submitClaim() {
  const no = notAllowed(); if (no) return tell("Not sent", no);
  try { await pullMine(); } catch (e) { return tell("Not sent", "Could not reach the database, so nothing was sent.\n" + e.message); }
  const c = ST.drafts.claim;
  c.id = newRef("OT", ST.db.claims.map(x => x.id));
  c.lines.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.start || "").localeCompare(b.start || ""));
  refreshClaim(c);
  const chk = E.check(ST.db, c, TODAY());
  if (chk.errors.length) return tell("Fix these first", "• " + chk.errors.join("\n• "));
  c.warnings = chk.warnings;
  try {
    await send("ot_claims", c, E.canonClaim, o => ({ month: o.month, hours: E.Num(o.totals.hours) }), "OT hours sent",
      o => "code " + o.code + "; " + E.Num(o.totals.hours) + " hrs" + (o.warnings.length ? "; " + o.warnings.length + " note(s)" : ""));
  } catch (e) { return tell("Not sent", e.message); }
  ST.db.claims.push(c); ST.drafts.claim = null; save();
  stack.pop(); render(); toast("Sent - waiting for confirmation");
}

function payPreview(p) {
  p.profile = clone(ST.profile); p.rates = rates();
  const led = ledger(p);
  const chk = E.checkPayout(ST.db, p, TODAY(), led);
  p.creditsAfter = led.usable; p.creditsBefore = E.R2(led.usable + p.draws.filter(d => !d.pending).reduce((t, d) => t + d.hours, 0));
  return chk;
}
async function submitPay() {
  const no = notAllowed(); if (no) return tell("Not sent", no);
  try { await pullMine(); } catch (e) { return tell("Not sent", "Could not reach the database.\n" + e.message); }
  const p = ST.drafts.pay;
  p.id = newRef("PAY", ST.db.payouts.map(x => x.id));
  const chk = payPreview(p);
  if (chk.errors.length) return tell("Fix these first", "• " + chk.errors.join("\n• "));
  p.warnings = chk.warnings;
  try {
    await send("ot_payouts", p, E.canonPay, o => ({ hours: E.Num(o.hours), amount: o.amount.toFixed(2) }), "OT pay requested",
      o => "code " + o.code + "; " + E.Num(o.hours) + " hrs = RM " + o.amount.toFixed(2));
  } catch (e) { return tell("Not sent", e.message); }
  ST.db.payouts.push(p); ST.drafts.pay = null; save();
  stack.pop(); render(); toast("Sent for approval");
}

function tilPreview(a) {
  a.schema = 2; a.profile = clone(ST.profile);
  E.computeLeave(a, ST.policy);
  const led = ledger(a);
  const chk = E.checkLeave(ST.db, a, TODAY(), led, ST.policy, statutory());
  a.creditsAfter = led.usable; a.creditsBefore = E.R2(led.usable + a.draws.filter(d => !d.pending).reduce((t, d) => t + d.hours, 0));
  return chk;
}
async function submitTil() {
  const no = notAllowed(); if (no) return tell("Not sent", no);
  try { await pullMine(); } catch (e) { return tell("Not sent", "Could not reach the database.\n" + e.message); }
  const a = ST.drafts.til;
  a.id = newRef("TIL", ST.db.tilApps.map(x => x.id));
  a.lines.sort((x, y) => (x.date || "9999").localeCompare(y.date || "9999"));
  const chk = tilPreview(a);
  if (chk.errors.length) return tell("Fix these first", "• " + chk.errors.join("\n• "));
  a.warnings = chk.warnings;
  try {
    await send("ot_til", a, E.canonTil, o => ({ dates: o.lines.map(l => l.date).join(","), hours: E.Num(o.totalHours), unpaid: E.Num(o.unpaidHours),
      cancelReason: "", cancelRequestedAt: "", cancelDecidedAt: "", cancelDecidedBy: "", cancelNote: "" }), "time off applied for",
      o => "code " + o.code + "; " + E.Num(o.totalHours) + " hrs time-in-lieu" + (o.unpaidHours ? " + " + E.Num(o.unpaidHours) + " hrs unpaid" : ""));
  } catch (e) { return tell("Not sent", e.message); }
  ST.db.tilApps.push(a); ST.drafts.til = null; save();
  stack.pop(); render(); toast("Sent for approval");
}

async function withdraw(col, obj, what) {
  if (!await sheet("Withdraw?", "It stays on record as withdrawn. Any credits it held come back.", [{ label: "Cancel" }, { label: "Withdraw", cls: "p", value: true }])) return;
  if (col === "ot_claims") {
    const used = ledger().lots.filter(l => l.refId === obj.id).reduce((t, l) => t + l.used, 0);
    if (used > 0.001) return tell("Not withdrawn", E.Num(used) + " hrs of these OT hours are already used by an OT pay or time-off request. Withdraw that request first.");
  }
  const now = E.nowStamp();
  try {
    if (!DEMO) await fs.commit([{ col, id: obj.id, mask: ["status", "withdrawnAt", "updatedAt"], fields: { status: "withdrawn", withdrawnAt: now, updatedAt: now } }, eventWrite(ME.employeeId, what, obj.id, "code " + obj.code)]);
  } catch (e) { return tell("Not withdrawn", e.message); }
  obj.status = "withdrawn"; obj.decisionNote = "Withdrawn by the employee"; obj.decidedAt = now;
  ring(["approvals", "people/" + ME.employeeId]); save(); render(); toast("Withdrawn");
}

async function askCancel(a) {
  const reason = await sheet("Ask to cancel this leave?", `An approver has to agree. If they do, the credits come back.<div class="field" style="margin-top:12px"><input type="text" maxlength="200" placeholder="Why (the approver sees it)"></div>`,
    [{ label: "Back" }, { label: "Ask to cancel", cls: "p", value: "input" }]);
  if (reason == null) return;
  if (!reason.trim()) return tell("Not sent", "Write why the leave should be cancelled - the approver sees it.");
  const now = E.nowStamp();
  try {
    if (!DEMO) await fs.commit([{ col: "ot_til", id: a.id, mask: ["status", "cancelReason", "cancelRequestedAt", "updatedAt"], fields: { status: "cancel_requested", cancelReason: reason.trim(), cancelRequestedAt: now, updatedAt: now } },
      eventWrite(ME.employeeId, "leave cancellation asked", a.id, reason.trim())]);
  } catch (e) { return tell("Not sent", e.message); }
  a.status = "cancel_requested"; a.cancelReason = reason.trim(); a.cancelRequestedAt = now;
  ring(["approvals", "people/" + ME.employeeId]); save(); render(); toast("Asked - waiting for an approver");
}

// ---- approvers
let apprItem = null, apprEdits = null, apprNoteText = "";
// the approver's corrections, one per line (day type / break / note; for time off: extra break / unpaid)
function startEdits() {
  if (!apprItem || apprEdits) return;
  if (apprItem.kind === "claim") apprEdits = apprItem.obj.lines.map(l => ({ dayType: l.dayType, breakHrs: l.breakHrs || 0, note: l.note || "" }));
  if (apprItem.kind === "til" && !apprItem.obj.category) apprEdits = apprItem.obj.lines.map(l => ({ extraBreak: l.extraBreak || 0, paidBy: l.paidBy === "Unpaid" ? "Unpaid" : "TIL" }));
}
async function openApproval(it) {
  stack.push({ name: "approveItem", args: it }); apprItem = null; apprEdits = null; apprNoteText = ""; render();
  try {
    if (DEMO) { apprItem = demoApprItem(it); }
    else {
      const col = it.kind === "pay" ? "ot_payouts" : it.kind === "claim" ? "ot_claims" : "ot_til";
      const d = await fs.get(col, it.id);
      if (!d) throw new DbError("missing", "That item is no longer in the database.");
      const emp = d.f.employeeId;
      const q = c => fs.where(c, [{ f: "employeeId", v: emp }]);
      const db = { claims: (await q("ot_claims")).map(claimFrom).filter(Boolean), tilApps: (await q("ot_til")).map(tilFrom).filter(Boolean),
        payouts: (await q("ot_payouts")).map(payFrom).filter(Boolean), adjusts: (await q("ot_adjust")).map(adjustFrom).filter(Boolean) };
      const pd = await fs.get("ot_pay", emp);
      const prof = Object.assign(clone(PROFILE), pd ? JSON.parse(pd.f.profile || "{}") : {}); prof.staffId = emp; prof.normalDays = E.cleanDays(prof.normalDays);
      const pol = policyFrom(await fs.get("ot_settings", "policy"));
      apprItem = { kind: it.kind, doc: d, emp, db, prof, pol, obj: it.kind === "pay" ? payFrom(d) : it.kind === "claim" ? claimFrom(d) : tilFrom(d) };
      if (!apprItem.obj) throw new DbError("damaged", "This request could not be read.");
      apprItem.sent = clone(apprItem.obj.profile || {});
      startEdits();                                  // BEFORE currentDetails: it draws the page, and the page needs the approver's edits
      await currentDetails(apprItem, pd);
      it.name = apprItem.obj.profile.name || it.name;
    }
    startEdits();
  } catch (e) { stack.pop(); render(); return tell("Cannot open", e.message); }
  render();
}
// People / the pay page may have changed the employee since the request was sent: show (and decide on) the details as they are now -
// the name, position and department from the directory, and for a request still waiting the working days / hours / wage
async function currentDetails(item, payDoc) {
  const card = await fs.get("employees", item.emp);
  if (payDoc === undefined) {
    const pd = await fs.get("ot_pay", item.emp);
    item.prof = Object.assign(clone(PROFILE), pd ? JSON.parse(pd.f.profile || "{}") : {}); item.prof.staffId = item.emp; item.prof.normalDays = E.cleanDays(item.prof.normalDays);
    payDoc = pd;
  }
  const was = item.sent || {}, p = Object.assign({}, was), changed = [];
  const note = (what, a, b) => { if (String(a || "").trim() !== String(b || "").trim() && String(b || "").trim() !== "") changed.push(what + ": " + (a || "(none)") + " → " + b); };
  if (card) {
    if (card.f.name) { note("Name", was.name, card.f.name); p.name = card.f.name; ST.names[item.emp] = card.f.name; }
    note("Position", was.jobTitle, card.f.position || ""); p.jobTitle = card.f.position || "";
    note("Department", was.department, card.f.department || ""); p.department = card.f.department || "";
  }
  const waiting = item.obj.status === "submitted" && item.kind !== "claim";
  if (waiting && payDoc) {
    const n = item.prof;
    note("Working days", E.cleanDays(was.normalDays), E.cleanDays(n.normalDays)); note("Normal hours a day", E.Num(was.normalHours), E.Num(n.normalHours));
    note("Rest day", was.restDay, n.restDay); note("Work ends at", was.shiftEnd, n.shiftEnd); note("Place of work", was.location, n.location);
    note("Wage", (was.wageBasis || "") + " RM " + Number(was.basicSalary || 0).toFixed(2), (n.wageBasis || "") + " RM " + Number(n.basicSalary || 0).toFixed(2));
    ["normalDays", "normalHours", "restDay", "shiftEnd", "location", "wageBasis", "basicSalary"].forEach(k => p[k] = n[k]);
    if (n.supervisor) { note("Supervisor", was.supervisor, n.supervisor); p.supervisor = n.supervisor; }
  }
  item.obj.profile = p; item.changed = changed;
  if (stack.length && stack[stack.length - 1].name === "approveItem" && !editing()) render();
}
function apprClaimView() {
  const c = clone(apprItem.obj);
  if (c.status === "submitted") c.lines.forEach((l, i) => { l.dayType = apprEdits[i].dayType; l.breakHrs = E.R2(parseFloat(apprEdits[i].breakHrs) || 0); l.note = apprEdits[i].note; });
  E.compute(c);
  const chk = E.check(apprItem.db, c, TODAY());
  return { c, errors: chk.errors.filter(e => e.indexOf("is in the future") < 0), warnings: chk.warnings };
}
// the employee's rates and whether the overtime law covers them (as Approval.cs RatesFor / Statutory)
function apprCtx() {
  const prof = apprItem.prof || apprItem.obj.profile || {};
  const r = E.rates(prof.location);
  return { r, stat: E.lawCovers(Object.assign({}, prof, { staffId: prof.staffId || apprItem.emp }), r) };
}
const pendingBlockers = draws => {
  const g = {}; (draws || []).filter(x => x.pending).forEach(x => g[x.claimId] = E.R2((g[x.claimId] || 0) + x.hours));
  return Object.keys(g).map(k => E.Num(g[k]) + " hrs come from " + k + ", which is not confirmed yet - confirm those OT hours first.");
};
function apprPayView() {
  const p = clone(apprItem.obj), { r, stat } = apprCtx();
  if (p.status !== "submitted") return { p, blockers: [] };
  const led = E.build(apprItem.db, null, TODAY(), r, stat), s = led.byRef[p.id];
  if (!s) return { p, blockers: ["The credits for this request could not be worked out."] };
  p.draws = s.draws; p.amount = s.amount;
  p.creditsAfter = led.usable; p.creditsBefore = E.R2(led.usable + p.draws.filter(x => !x.pending).reduce((t, x) => t + x.hours, 0));
  const blockers = [];
  if (s.uncovered > 0) blockers.push("The employee no longer has enough free credits (" + E.Num(s.uncovered) + " hrs missing).");
  blockers.push(...pendingBlockers(s.draws));
  if (s.draws.length > E.MaxClaimLines) blockers.push("The credits come from " + s.draws.length + " OT lines - more than one form holds (" + E.MaxClaimLines + "). Ask the employee to split the request.");
  return { p, blockers };
}
function apprTilView() {
  const a = clone(apprItem.obj), { r, stat } = apprCtx(), pol = apprItem.pol || ST.policy;
  if (a.category) return { a, blockers: [], warnings: a.warnings || [] };      // leave: days on the leave form - no credits to check
  if (a.status !== "submitted") return { a, blockers: [], warnings: [] };
  a.lines.forEach((l, i) => { const e = apprEdits[i]; const x = E.R2(parseFloat(e.extraBreak) || 0); l.extraBreak = x >= 0 && x <= 12 ? x : 0; l.paidBy = e.paidBy; });
  E.computeLeave(a, pol);
  const db = Object.assign({}, apprItem.db, { tilApps: apprItem.db.tilApps.filter(x => x.id !== a.id).concat([a]) });
  const led = E.build(db, null, TODAY(), r, stat);
  const chk = E.checkLeave(db, a, TODAY(), led, pol, stat);
  a.creditsAfter = led.usable; a.creditsBefore = E.R2(led.usable + a.draws.filter(x => !x.pending).reduce((t, x) => t + x.hours, 0));
  const s = led.byRef[a.id], blockers = [];
  if (s && s.uncovered > 0) blockers.push(E.Num(s.uncovered) + " hrs of the time-in-lieu are not covered by free credits - allow extra break time for the difference, or make a line Unpaid.");
  if (s) blockers.push(...pendingBlockers(s.draws));
  // the approver's own corrections decide: "in the past" and notice warnings stay notes, real conflicts block
  blockers.push(...chk.errors.filter(e => e.indexOf("credits are free") < 0));
  return { a, blockers, warnings: chk.warnings };
}
const myName = () => (ST.profile.name || ME.name || ME.email.split("@")[0]).replace(/\s*\(sample\)/, "");

async function decide(action) {
  const it = apprItem, o = it.obj;
  const note = ($("#apprNote") || {}).value || "";
  if (action === "decline" && !note.trim()) return tell("Remarks needed", "Write a short reason - the employee will see it.");
  if (ME.employeeId && it.emp === ME.employeeId && !(it.kind === "til" && it.category === "Sick Leave")) return tell("Not allowed", "You cannot decide your own request - another approver has to.");
  const now = TODAY_ISO() + "T" + E.nowStamp().substr(11);
  const writes = [];
  let what = "", evNote = null;
  if (it.kind === "cancel") {
    if (!await sheet(action === "approve" ? "Cancel this leave?" : "Refuse the cancellation?", esc(o.profile.name) + " · " + esc(o.id), [{ label: "Back" }, { label: "Yes", cls: "p", value: true }])) return;
    writes.push({ col: "ot_til", id: o.id, mask: ["status", "cancelDecidedAt", "cancelDecidedBy", "cancelNote", "updatedAt"],
      fields: { status: action === "approve" ? "cancelled" : "approved", cancelDecidedAt: now, cancelDecidedBy: ME.email, cancelNote: note.trim(), updatedAt: E.nowStamp() } });
    what = action === "approve" ? "leave cancelled (credits returned)" : "leave cancellation refused";
  } else {
    const col = it.kind === "pay" ? "ot_payouts" : it.kind === "claim" ? "ot_claims" : "ot_til";
    const fields = { status: action === "approve" ? "approved" : "declined", decidedAt: now, decidedBy: ME.email, decisionNote: note.trim(), review: "", signedFile: "", signedName: "", updatedAt: E.nowStamp() };
    if (action === "approve") {
      if (it.kind === "pay") {
        const v = apprPayView();
        if (v.blockers.length) return tell("Cannot approve yet", "• " + v.blockers.join("\n• "));
        if (!await sheet("Approve this OT pay?", esc(o.profile.name) + " · " + esc(o.id) + "<br><b>" + E.Num(v.p.hours) + " hrs = " + money(v.p.amount) + "</b><br><br>The admin / HR then make the signed copy (your signature + the company chop) for the employee.",
          [{ label: "Back" }, { label: "Approve", cls: "p", value: true }])) return;
        Object.assign(v.p, { status: "approved", decidedAt: now, decidedBy: ME.email, decisionNote: note.trim(), decidedByName: myName() });
        fields.review = JSON.stringify(v.p);
        what = "OT pay approved";
        evNote = "RM " + Number(v.p.amount).toFixed(2) + " for " + E.Num(v.p.hours) + " hrs" + (note.trim() ? " - " + note.trim() : "") + " (on the phone)";
      } else if (it.kind === "til") {
        const v = apprTilView();
        if (v.blockers.length) return tell("Cannot approve yet", "• " + v.blockers.join("\n• "));
        if (!await sheet("Approve this time off?", esc(o.profile.name) + " · " + esc(o.id) + "<br><b>" + E.Num(v.a.totalHours) + " hrs from credits</b>" + (v.a.unpaidHours ? " + " + E.Num(v.a.unpaidHours) + " hrs unpaid" : "") + "<br><br>The admin / HR then make the signed copy (your signature + the company chop) for the employee.",
          [{ label: "Back" }, { label: "Approve", cls: "p", value: true }])) return;
        Object.assign(v.a, { status: "approved", decidedAt: now, decidedBy: ME.email, decisionNote: note.trim(), decidedByName: myName() });
        fields.review = JSON.stringify(v.a);
        what = "time off approved";
        const extra = v.a.lines.reduce((t, l) => t + (l.extraBreak || 0), 0);
        evNote = (extra > 0 ? E.Num(extra) + " hrs extra break allowed" + (note.trim() ? " - " + note.trim() : "") : note.trim()) + " (on the phone)";
      } else {
      if ((o.schema || 0) < 2) return tell("Approve on the PC", "This is an older monthly OT claim - it carries OT pay and its signed form, so it is approved in PSL Master on the PC. You can decline here.");
      const v = apprClaimView();
      if (v.errors.length) return tell("Cannot confirm yet", "• " + v.errors.join("\n• "));
      if (!await sheet("Confirm these hours?", esc(o.profile.name) + " · " + esc(o.id) + "<br>" + E.Num(v.c.totals.hours) + " hrs (worth " + money(v.c.totals.value) + ")<br><br>They become the employee's credits.",
        [{ label: "Back" }, { label: "Confirm", cls: "p", value: true }])) return;
      Object.assign(v.c, { status: "approved", decidedAt: now, decidedBy: ME.email, decisionNote: note.trim() });
      fields.review = JSON.stringify(v.c);
      what = "OT hours confirmed";
      }
    } else {
      if (!await sheet("Decline?", esc(o.profile.name) + " · " + esc(o.id) + "<br><br>Reason: “" + esc(note) + "”", [{ label: "Back" }, { label: "Decline", cls: "p", value: true }])) return;
      what = (it.kind === "pay" ? "OT pay request" : it.kind === "til" ? "time off" : "OT hours") + " declined";
    }
    writes.push({ col, id: o.id, mask: Object.keys(fields), fields });
  }
  writes.push(eventWrite(it.emp, what, o.id, evNote === null ? note.trim() : evNote));
  try {
    if (!DEMO) {
      const cur = await fs.get(writes[0].col, o.id);
      const need = it.kind === "cancel" ? "cancel_requested" : "submitted";
      if (!cur || cur.f.status !== need) return tell("Already decided", "This was already " + (cur ? cur.f.status : "removed") + ".");
      await fs.commit(writes);
    }
  } catch (e) { return tell("Not done", e.message); }
  ring(["approvals", "people/" + it.emp]);
  ST.conf = ST.conf.filter(x => x.id !== o.id); save();
  stack.pop(); render(); toast(action === "approve" ? (it.kind === "pay" || it.kind === "til" ? "Approved - the admin / HR make the signed copy" : "Done") : "Declined - the employee will see your remarks");
  refreshConf().then(() => officeAllowed() && !DEMO ? refreshOffice(false) : null).then(quietRender).catch(() => { });
}

// ===================================================================== screens
let tab = "home", otSeg = "credits", licFilter = "urgent", licQuery = "", tenderFilter = "active";
const stack = [];
const ICON = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  ot: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lic: '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M8 8h8M8 12h5"/><path d="M9 17l-1 4 4-2 4 2-1-4"/>',
  ten: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  appr: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M8.5 12l2.5 2.5L16 9.5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M7.5 14h2M11 14h2M14.5 14h2M7.5 17.5h2M11 17.5h2"/>',
  co: '<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16"/><path d="M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M3 21h18"/>'
};
// the bottom bar holds five at most: Home, Calendar, Overtime, Company (Licences + Tenders, switched at the top of the page) and,
// for approvers, Approve
let coLast = "lic";
function tabsHtml() {
  const t = [["home", "Home", ICON.home], ["cal", "Calendar", ICON.cal], ["ot", "Overtime", ICON.ot], ["co", "Company", ICON.co]];
  if (ME.isApprover) t.push(["appr", "Approve", ICON.appr]);
  const n = ST.conf.length;
  const on = k => !stack.length && (k === "co" ? tab === "lic" || tab === "ten" : tab === k);
  return t.map(([k, l, ic]) => `<button data-tab="${k}" class="${on(k) ? "on" : ""}"><svg viewBox="0 0 24 24">${ic}</svg><span class="l">${l}</span>${k === "appr" && n ? `<span class="badge">${n}</span>` : ""}</button>`).join("");
}

function render() {
  if (!ME) return;
  shownSig = stateSig(); renderWaiting = false;
  $("#tabs").innerHTML = tabsHtml();
  const top = stack[stack.length - 1];
  $("#back").classList.toggle("hidden", !top);
  const ini = (ST.profile.name || ME.name || ME.email || "?").replace(/\(.*?\)/g, "").split(/\s+/).filter(w => w && !/^(bin|binti|bt|anak|ak|a\/l|a\/p)$/i.test(w));
  $("#me").textContent = ((ini[0] || "?")[0] + (ini.length > 1 ? ini[ini.length - 1][0] : "")).toUpperCase();
  $("#bar").classList.add("hidden"); $("#view").classList.remove("with-bar");
  const v = $("#view");
  const pages = { trnEdit: pageTrnEdit, claimEdit: pageClaimEdit, payEdit: pagePayEdit, tilEdit: pageTilEdit, leaveEdit: pageLeaveEdit, remEdit: pageRemEdit, tender: pageTender, approveItem: pageApproveItem, me: pageMe, office: pageOffice, calendar: pageCalendar };
  if (top) { pages[top.name](v, top.args); return; }
  ({ home: pageHome, cal: pageCalendar, ot: pageOvertime, lic: pageLicences, ten: pageTenders, appr: pageApprove })[tab](v);
}
function title(t) { const e = $("#title"); e.textContent = t; e.classList.toggle("long", String(t).length > 20); }
function actionBar(html) { const b = $("#bar"); b.innerHTML = html; b.classList.remove("hidden"); $("#view").classList.add("with-bar"); }
function banners() {
  let h = DEMO ? `<div class="banner info"><b>Demo</b> - pretend data, nothing is saved.</div>` : "";
  if (syncErr) h += `<div class="banner err">${esc(syncErr)}</div>`;
  if (!ME.isAdmin && ME.employeeId && ST.profileSet && !ST.active) h += `<div class="banner err">Your employee record (${esc(ME.employeeId)}) is switched off. Ask the admin.</div>`;
  if (!ME.isAdmin && !ME.employeeId) h += `<div class="banner warn">${esc(ME.email)} has no employee ID yet - overtime needs one. Ask the admin.</div>`;
  else if (!ME.isAdmin && !ST.profileSet && ST.lastMine) h += `<div class="banner warn">The office has not set your overtime pay details yet.</div>`;
  return h;
}

// ---------- home
function pageHome(v) {
  title("PSL Master");
  const L = ledger(), today = TODAY();
  const lic = ST.lists.certs.map(c => E.licLevel(E.daysTo(c.expiry, today), ST.lists.lic)).filter(l => l <= 1).length;
  const warn = ST.lists.tm.warnDays || 7;
  const closing = ST.lists.tenders.filter(t => { const s = E.tStatus(t, today), d = E.daysTo(t.closingIso, today); return (s === "progress" || s === "awaiting") && d !== null && d >= 0 && d <= warn; }).length;
  const n = ST.conf.length;
  const waiting = [...ST.db.claims, ...ST.db.payouts, ...ST.db.tilApps].filter(x => x.status === "submitted" || x.status === "cancel_requested").length;
  const recent = [...ST.db.claims.map(x => ["OT hours", x]), ...ST.db.payouts.map(x => ["OT pay", x]), ...ST.db.tilApps.map(x => ["Time off", x])]
    .filter(([, x]) => x.status !== "draft").sort((a, b) => ((b[1].decidedAt || b[1].submittedAt || "") > (a[1].decidedAt || a[1].submittedAt || "") ? 1 : -1)).slice(0, 5);
  v.innerHTML = banners() +
    `<div style="margin:2px 2px 12px"><div class="sub">Hello</div><h1 style="font-size:22px;font-weight:900" class="wrap-any">${esc(ST.profile.name || ME.name || ME.email)}</h1></div>` +
    `<div class="hcards">` + homeCards() + `</div>` +          // (a grid of cards on an iPad / Mac - see the web app's desktop.css)
    `<div class="tiles">
      ${ME.isAdmin ? "" : `<button class="tile g" data-go="ot" data-seg="credits"><div class="k">OT Credits</div><div class="v">${hrs(L.usable)} h</div><div class="h">${L.pendingLeft ? hrs(L.pendingLeft) + " h waiting" : "free to use"}</div></button>
      <button class="tile a" data-go="ot" data-seg="hours"><div class="k">My Requests</div><div class="v">${waiting}</div><div class="h">waiting for a decision</div></button>`}
      <button class="tile r" data-go="lic"><div class="k">Licences</div><div class="v">${lic}</div><div class="h">expired or due soon</div></button>
      <button class="tile b" data-go="ten"><div class="k">Tenders</div><div class="v">${closing}</div><div class="h">closing within ${warn} days</div></button>
    </div>` +
    (L.overdueHours > 0 ? `<div class="banner err"><b>Overtime to be paid:</b> ${hrs(L.overdueHours)} hrs should have been paid by now. Claim them under Overtime › OT pay.</div>` : "") +
    (recent.length ? `<div class="section">Latest</div>` + recent.map(([k, x]) => itemRequest(k, x)).join("") : "");
}
// the Home cards: approvals (approvers - a glow and a bubble while something waits), who's in today, and the calendar at a glance
function homeCards() {
  let h = "";
  const n = ST.conf.length;
  if (ME.isApprover) h += `<button class="hcard appr${n ? " hot" : " calm"}" data-go="appr"><span class="deco"></span>${n ? `<span class="bubble">${n}</span>` : ""}
      <div class="lbl">Approvals</div><div class="big">${n ? (n === 1 ? "1 waits for you" : n + " wait for you") : "All clear"}</div>
      <div class="sub">${n ? "Tap to review and decide" : "Nothing is waiting for you"}</div></button>`;
  const D = officeDay(TODAY_ISO()), c = D.counts;
  const awayNames = D.people.filter(p => p.state === "out" || p.state === "part" || p.state === "training").slice(0, 4).map(p => p.name.split(" ")[0]);
  h += `<button class="hcard who" data-act="office"><span class="deco"></span><div class="lbl">Who's In Today</div>
      <div class="big">${c.in}<small> in the office</small></div>
      <div class="pills"><span><i style="background:#ffffff"></i>In ${c.in}</span><span><i style="background:#fca5a5"></i>Leave ${c.out}</span>${c.part ? `<span><i style="background:#fcd34d"></i>Part ${c.part}</span>` : ""}${c.training ? `<span><i style="background:#bbf7d0;box-shadow:0 0 0 2px rgba(255,255,255,.6)"></i>Training ${c.training}</span>` : ""}</div>
      ${awayNames.length ? `<div class="sub">Away: ${esc(awayNames.join(", "))}${D.people.filter(p => p.state === "out" || p.state === "part" || p.state === "training").length > 4 ? " …" : ""}</div>` : ""}</button>`;
  // the calendar: today in one line, the week as dots, and the next few things
  const t = TODAY_ISO(), td = calDay(t), parts = [];
  const aw = td.away.filter(a => !a.gone).length; if (aw) parts.push(aw + " on leave");
  td.trn.filter(x => x.status === "approved").forEach(x => parts.push(x.title));
  td.imp.forEach(x => parts.push(x.title));
  if (td.ten.length) parts.push(plural(td.ten.length, "tender date", "tender dates"));
  if (td.lic.length) parts.push(plural(td.lic.length, "licence expires", "licences expire"));
  if (td.rem.length) parts.push(plural(td.rem.length, "reminder", "reminders"));
  const DOT = { off: "#fca5a5", trn: "#86efac", ten: "#fdba74", lic: "#c4b5fd", imp: "#93c5fd", rem: "#5eead4" }, DN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  let strip = "";
  const next = [], seen = new Set();
  // something over several days is listed once (already running today = not "next"), with the day it ends
  const ends = (a, b2) => b2 && b2 !== a ? " (to " + dmy(b2).substr(0, 5) + ")" : "";
  td.trn.forEach(y => seen.add("t" + y.id)); td.imp.forEach(y => { if (y.id) seen.add("i" + y.id); });
  for (let i = 0; i < 7; i++) {
    const iso = E.iso(E.addDays(TODAY(), i)), x = calDay(iso);
    const kinds = [x.away.some(a => !a.gone) && "off", x.trn.length && "trn", x.ten.length && "ten", x.lic.length && "lic", x.imp.length && "imp", x.rem.length && "rem"].filter(Boolean);
    strip += `<div class="${i === 0 ? "t" : ""}">${DN[E.day(iso).getUTCDay()]}<div class="dots">${kinds.slice(0, 4).map(k => `<i style="background:${DOT[k]}"></i>`).join("")}</div></div>`;
    if (i > 0) {
      x.trn.filter(y => !seen.has("t" + y.id)).forEach(y => { seen.add("t" + y.id); next.push([iso, y.kind + ": " + y.title + ends(y.from, y.to)]); });
      x.imp.filter(y => !y.id || !seen.has("i" + y.id)).forEach(y => { if (y.id) seen.add("i" + y.id); next.push([iso, y.title + ends(y.date, y.end)]); });
      x.ten.filter(y => y.strong).forEach(y => next.push([iso, y.title]));
      x.rem.forEach(y => next.push([iso, (y.time ? y.time + " " : "") + y.title]));
      if (x.away.some(a => !a.gone)) next.push([iso, x.away.filter(a => !a.gone).length + " on leave"]);
    }
  }
  h += `<button class="hcard cal" data-act="calendar"><span class="deco"></span><div class="lbl">Calendar · Today</div>
      <div class="big" style="font-size:20px">${parts.length ? esc(parts.slice(0, 3).join(" · ")) : "A quiet day"}</div>
      <div class="strip">${strip}</div>
      ${next.length ? `<div class="next">${next.slice(0, 3).map(([d, x]) => `<div><b>${DN[E.day(d).getUTCDay()]} ${dmy(d).substr(0, 5)}</b> ${esc(x)}</div>`).join("")}</div>` : ""}</button>`;
  return h;
}

// ---------- the calendar
let calMonth = "", calSel = "";
const MONTHS_L = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function pageCalendar(v) {
  title("Calendar");
  if (!calMonth) calMonth = TODAY_ISO().substr(0, 7);
  const first = E.day(calMonth + "-01"), start = E.addDays(first, -((first.getUTCDay() + 6) % 7)), today = TODAY_ISO();
  let grid = "";
  for (let i = 0; i < 42; i++) {
    const d = E.addDays(start, i), iso = E.iso(d), c = calDay(iso), out = d.getUTCMonth() !== first.getUTCMonth();
    if (i === 35 && out) break;                     // a 5-week month needs no sixth row
    const on = c.away.filter(a => !a.gone);              // everybody away that day = one mark (the day lists them)
    const marks = [c.imp.length && "imp", on.length && (on.some(a => a.ok && a.full) ? "full" : on.every(a => !a.ok) ? "asked" : "part"), !on.length && c.away.length && "gone",
      ...c.trn.slice(0, 2).map(() => "trn"), c.ten.length && "ten", c.lic.length && "lic", c.rem.length && "rem"].filter(Boolean)
      .slice(0, 5).map(k => `<i class="${k}"></i>`).join("");
    grid += `<button class="cd${out ? " out" : ""}${iso === today ? " today" : ""}${iso < today ? " past" : ""}${iso === calSel ? " sel" : ""}" data-act="calDay" data-d="${iso}"><span class="n">${d.getUTCDate()}</span><span class="mk">${marks}</span></button>`;
  }
  const s = calSel ? calDay(calSel) : null, DN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const STW = { withdrawn: "withdrawn", cancelled: "cancelled", cancel_requested: "asked to cancel", submitted: "asked - waiting for approval", approved: "approved" };
  const list = !s ? `<div class="sub" style="margin:10px 2px">Tap a day to see what is on.</div>` :
    `<div class="section" style="display:flex;align-items:center;gap:8px"><span class="grow">${DN[E.day(calSel).getUTCDay()]} ${dmy(calSel)}</span></div>` +
    s.imp.map(x => `<div class="item calrow imp"><div class="main"><div class="t">${esc(x.title)}</div><div class="m">${x.end !== x.date ? dmy(x.date) + " – " + dmy(x.end) : "Important date"}${x.forWho ? " · " + esc(x.forWho) : ""}${x.note ? " · " + esc(x.note) : ""}</div></div></div>`).join("") +
    (s.away.length ? `<div class="item calrow off bundle"><div class="main"><div class="t">On leave · ${s.away.filter(a => !a.gone).length}</div>` +
      s.away.map(a => `<div class="who1${a.gone ? " gone" : ""}"><b>${esc(a.name)}</b> <span>${esc((a.cat ? leaveLabel(a.cat) + " · " : "") + leaveText(a.l))} · ${a.gone ? (a.state === "cancelled" ? "cancelled" : "withdrawn") : a.cancel ? "asked to cancel" : a.ok ? "approved" + (a.by ? " by " + esc(a.by) : "") : "asked - waiting"}</span>${a.l.reason && !a.gone ? `<br><i>“${esc(a.l.reason)}”</i>` : ""}</div>`).join("") + `</div></div>` : "") +
    s.trn.map(x => `<div class="item calrow trn"><div class="main"><div class="t">${esc(x.kind + ": " + x.title)}${x.status === "submitted" ? ` <span class="chip blue">waiting approval</span>` : ""}</div>
      <div class="m">${esc((x.from === x.to ? dmy(x.from) : dmy(x.from) + " – " + dmy(x.to)) + (trnTime(x) ? " · " + trnTime(x) : "") + (x.place ? " · " + x.place : ""))}</div>${x.notes ? `<div class="m"><i>${esc(x.notes)}</i></div>` : ""}
      <div class="whochips">${trnHere(x, calSel).sort((a, b) => a.gone - b.gone).map(h => `<span${h.gone ? ' class="gone"' : ""}>${esc(h.name)}${h.r ? (h.gone ? (h.r.t ? " · left " + esc(showEarly(h.r)) : " · last day " + esc(showEarly(h.r).replace(" (last day)", ""))) : " · leaves " + esc(showEarly(h.r))) : ""}</span>`).join("")}</div>
      <div class="m">${x.status === "submitted" ? "asked by " + esc(x.byName || x.by) : "added by " + esc(x.byName || x.by)}</div>${trnButtons(x)}</div></div>`).join("") +
    s.ten.map(x => `<button class="item calrow ten${x.strong ? "" : " soft"}" data-tender="${esc(x.id)}"><div class="main"><div class="t">${esc(x.title)}</div><div class="m">${esc(x.sub)}</div></div></button>`).join("") +
    s.lic.map(x => `<button class="item calrow lic${x.strong ? "" : " soft"}" data-go="lic"><div class="main"><div class="t">${esc(x.title)}</div><div class="m">${esc(x.sub)}</div></div></button>`).join("") +
    s.rem.map(x => `<div class="item calrow rem"><div class="main"><div class="t">${x.time ? esc(x.time) + " · " : ""}${esc(x.title)}</div><div class="m">${esc(remWho(x))} · ${x.mine ? "set by you" : "from " + esc(x.byName || x.by)}${x.note ? " · " + esc(x.note) : ""}</div>
      ${x.mine ? `<div style="display:flex;gap:6px;margin-top:6px"><button class="btn sm" data-editrem="${esc(x.id)}">Change</button><button class="btn sm" data-delrem="${esc(x.id)}">Remove</button></div>` : ""}</div></div>`).join("") +
    (!s.imp.length && !s.away.length && !s.trn.length && !s.ten.length && !s.lic.length && !s.rem.length ? `<div class="card empty">Nothing on this day.</div>` : "");
  const onDay = calSel ? DN[E.day(calSel).getUTCDay()].substr(0, 3) + " " + dmy(calSel).substr(0, 5) : "today";
  v.innerHTML = banners() +
    `<div class="addbar"><button class="addb trn" data-act="newTrn"><svg viewBox="0 0 24 24"><path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11v5c0 1.5 2.5 3 5 3s5-1.5 5-3v-5"/><path d="M21 9v5"/></svg><span><b>+ Training / Event</b><small>on ${esc(onDay)}</small></span></button>
      <button class="addb rem" data-act="newRem"><svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span><b>+ Reminder</b><small>on ${esc(onDay)}</small></span></button></div>` +
    `<div class="offnav"><button class="btn" data-act="calPrev" aria-label="The month before">‹</button><div class="grow"><b>${MONTHS_L[first.getUTCMonth()]} ${first.getUTCFullYear()}</b></div>
      ${calMonth === today.substr(0, 7) ? "" : `<button class="btn" data-act="calToday">Today</button>`}<button class="btn" data-act="calNext" aria-label="The month after">›</button></div>
    <div class="calwrap"><div class="calmain">
    <div class="calgrid"><div class="wh">Mo</div><div class="wh">Tu</div><div class="wh">We</div><div class="wh">Th</div><div class="wh">Fr</div><div class="wh">Sa</div><div class="wh">Su</div>${grid}</div>
    <div class="callegend"><span><i class="imp"></i>Important date</span><span><i class="full"></i>On leave</span><span><i class="part"></i>Part of the day</span><span><i class="asked"></i>Asked, waiting</span><span><i class="gone"></i>Withdrawn</span>
      <span><i class="trn"></i>Training / event</span><span><i class="ten"></i>Tender</span><span><i class="lic"></i>Licence expiry</span><span><i class="rem"></i>Reminder</span></div></div><div class="calside">` +
    list + (officeAllowed() ? "" : `<div class="sub" style="margin:12px 2px">Other people's time off shows names only - the type of leave and reasons are private.</div>`) + `</div></div>`;      // side by side on an iPad / Mac
}

// ---------- Who's in
let officeDate = "", officeShow = "", officeQ = "";
const OFF = { out: ["On leave", "bad"], part: ["Part of the day", "warn"], training: ["Training / event", "trn"], in: ["In the office", "ok"], rest: ["Rest day / off", "gray"], asked: ["Leave asked", "blue"] };
function pageOffice(v) {
  title("Who's In");
  if (!officeDate) officeDate = TODAY_ISO();
  const D = officeDay(officeDate), c = D.counts, today = officeDate === TODAY_ISO();
  const DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], wd = iso => DN[E.day(iso).getUTCDay()];
  const needle = officeQ.trim().toLowerCase();
  const rows = D.people.filter(p => (!officeShow || (officeShow === "asked" ? p.asked.length : p.state === officeShow)) && (!needle || (p.name + " " + p.job).toLowerCase().indexOf(needle) >= 0));
  v.innerHTML = banners() +
    `<div class="offnav"><button class="btn" data-act="offPrev" aria-label="The day before">‹</button><div class="grow"><b>${wd(officeDate)} ${dmy(officeDate)}</b>${today ? `<span class="sub"> · today</span>` : ""}</div>
      ${today ? "" : `<button class="btn" data-act="offToday">Today</button>`}<button class="btn" data-act="offNext" aria-label="The day after">›</button></div>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input type="text" id="offQ" placeholder="Search a name, ID or job" value="${esc(officeQ)}" autocomplete="off">${officeQ ? `<button class="clr" data-act="offClear" aria-label="Clear">✕</button>` : ""}</div>
    <div class="offcounts">${["out", "part", "training", "in", "rest"].concat(D.limited ? [] : ["asked"]).map(k => `<button class="chip ${OFF[k][1]} ${officeShow === k ? "sel" : ""}" data-act="offShow" data-of="${k}">${c[k]} ${OFF[k][0]}</button>`).join("")}</div>` +
    (D.limited && !ST.board && !DEMO ? `<div class="card empty"><span class="spin"></span> Reading who is in…</div>` :
     D.limited && D.missing && !DEMO ? `<div class="card empty">${ST.board.error ? esc(ST.board.error) : "Who's in has not been published yet - it appears once the admin, an approver or HR opens PSL Master on their PC."}</div>` :
     !D.limited && !Object.keys((ST.office || {}).people || {}).length && !DEMO ? `<div class="card empty"><span class="spin"></span> Reading the time off…</div>` :
    rows.map(p => `<div class="item wrap offrow ${p.state}"><div class="main">
        <div class="t">${esc(p.name)}</div><div class="m">${esc(p.job)}</div>
        ${p.detail ? `<div class="m" style="color:var(--ink);font-weight:700">${esc(p.detail)}</div>` : ""}
        ${p.reason ? `<div class="m"><i>“${esc(p.reason)}”</i></div>` : ""}
        ${p.state === "out" ? `<div class="m">Back ${p.back ? "<b>" + wd(p.back) + " " + dmy(p.back) + "</b>" : "not within 90 days"}</div>` : ""}
        ${p.cancelAsked ? `<div class="m">Asked to cancel - waiting for the approver</div>` : p.by ? `<div class="m">Approved by ${esc(p.by)}</div>` : ""}
        ${p.asked.length ? `<div class="m" style="color:var(--blue)">Asked: ${esc(p.asked.map(x => leaveText(x.l)).join(" + "))} (waiting approval)</div>` : ""}
        <div class="wk">${p.week.map(w => `<span class="${w.state}${w.asked ? " asked" : ""}"><em>${wd(w.date).substr(0, 2)}</em><i></i></span>`).join("")}</div>
        ${p.upcoming.length ? `<div class="m">Coming up: ${p.upcoming.map(x => esc(wd(x.l.date) + " " + dmy(x.l.date).substr(0, 5) + (x.to && x.to !== x.l.date ? " – " + wd(x.to) + " " + dmy(x.to).substr(0, 5) : "") + " " + (x.text || leaveText(x.l)) + (x.ok ? "" : " (asked)"))).join(" · ")}</div>` : ""}
      </div><div class="r"><span class="chip ${OFF[p.state][1]}">${OFF[p.state][0]}</span></div></div>`).join("") || `<div class="card empty">${needle ? "Nobody matches “" + esc(officeQ) + "”" + (officeShow ? " with this filter" : "") + "." : "Nobody here."}</div>`) +
    `<div class="sub" style="margin:12px 2px">Time off applied for in PSL Master, or entered by the office from a signed paper form.${D.limited ? " The type of leave and reasons are kept private." : ""}</div>`;
}
function statusChip(s, words) {
  const W = Object.assign({ draft: "Draft", submitted: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn", cancel_requested: "Cancel asked", cancelled: "Cancelled" }, words || {});
  const C = { draft: "gray", submitted: "blue", approved: "ok", declined: "bad", withdrawn: "gray", cancel_requested: "warn", cancelled: "gray" };
  return `<span class="chip ${C[s] || "gray"}">${esc(W[s] || s)}</span>`;
}
const leaveLabel = c => c === "MIA" ? "MIA (absent without leave)" : c === "Others" ? "Other leave" : c;
const rangeLine = g => dmy(g.from) + (g.to && g.to !== g.from ? " – " + dmy(g.to) : "") + (g.half ? " (half day " + g.half + ")" : "");
function itemRequest(kind, x) {
  if (kind === "Time off" && x.category) {
    return `<div class="item"><div class="main"><div class="t">${esc(leaveLabel(x.category))} <span class="sub">· ${esc(short(x.id))}</span></div><div class="m">${esc((x.ranges || []).map(rangeLine).join(", "))}</div>
      ${x.decisionNote && x.status !== "withdrawn" ? `<div class="m">“${esc(x.decisionNote)}”</div>` : ""}</div>
      <div class="r"><div class="big">${hrs(x.leaveDays)} d</div>${statusChip(x.status)}</div></div>`;
  }
  const amount = kind === "OT pay" ? money(x.amount) : kind === "OT hours" ? hrs(x.totals ? x.totals.hours : 0) + " h" : hrs(x.totalHours) + " h";
  const when = kind === "OT hours" ? x.lines.map(l => dmy(l.date)).filter((d, i, a) => a.indexOf(d) === i).slice(0, 3).join(", ") : kind === "Time off" ? x.lines.map(l => dmy(l.date)).join(", ") : "from your credits";
  return `<div class="item"><div class="main"><div class="t">${kind} <span class="sub">· ${esc(short(x.id))}</span></div><div class="m">${esc(when)}</div>
    ${x.decisionNote && x.status !== "withdrawn" ? `<div class="m">“${esc(x.decisionNote)}”</div>` : ""}</div>
    <div class="r"><div class="big">${amount}</div>${statusChip(x.status, kind === "OT hours" ? { approved: "Confirmed" } : null)}</div></div>`;
}

// ---------- overtime
function pageOvertime(v) {
  title("Overtime");
  if (ME.isAdmin) { v.innerHTML = `<div class="card empty">The admin account does not record overtime. Pay details, approvers and everybody's credits are in PSL Master on the PC.</div>`; return; }
  const segs = [["credits", "Credits"], ["hours", "Hours"], ["pay", "OT Pay"], ["off", "Time Off"], ["leave", "Leave"]];
  let h = banners() + `<div class="seg">${segs.map(([k, l]) => `<button data-seg="${k}" class="${otSeg === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const L = ledger();
  if (otSeg === "credits") {
    h += `<div class="tiles"><div class="tile g"><div class="k">Free</div><div class="v">${hrs(L.usable)} h</div><div class="h">${L.expiredLeft ? hrs(L.expiredLeft) + " h pay-out only" : L.nextExpiry ? "use oldest by " + dmy(L.nextExpiry) : "confirmed"}</div></div>
      <div class="tile a"><div class="k">Waiting</div><div class="v">${hrs(L.pendingLeft)} h</div><div class="h">not confirmed yet</div></div>
      <div class="tile"><div class="k">Held</div><div class="v">${hrs(L.held)} h</div><div class="h">by requests waiting</div></div>
      <div class="tile r"><div class="k">Paid so far</div><div class="v">${money(L.paidAmount)}</div><div class="h">${hrs(L.takenOff)} h as time off</div></div></div>`;
    if (!tilAllowed()) h += `<div class="banner warn">Your contract does not include time in lieu, so your overtime is <b>paid in money</b>. Time off can still be asked for as <b>unpaid leave</b>.</div>`;
    if (!payAllowed()) h += `<div class="banner warn">Your contract does not include OT pay, so your credits are taken as <b>time in lieu</b>.</div>`;
    h += `<div class="section">Where my credits come from</div>` + (L.lots.slice().reverse().map(l => {
      const st = !l.approved ? `<span class="chip warn">Waiting</span>` : l.remaining <= 0.001 ? `<span class="chip gray">Used</span>` : l.expired ? `<span class="chip bad">Pay-out only</span>` : `<span class="chip ok">Free</span>`;
      return `<div class="item"><span class="bar" style="background:${l.approved ? (l.remaining > 0 && !l.expired ? "var(--ok)" : "#cfd2da") : "#d97706"}"></span><div class="main">
        <div class="t">${dmy(l.date)} · ${esc(l.dayType)}</div><div class="m">${l.start ? esc(l.start) + "–" + esc(l.end) + " · " : ""}${l.src === "paper" ? "paper form" : esc(short(l.refId))}${l.expiry ? " · time off by " + dmy(l.expiry) : ""}</div>
        ${l.payOverdue ? `<span class="chip bad" style="margin-top:4px">pay overdue</span>` : ""}</div>
        <div class="r"><div class="big">${hrs(l.remaining)} / ${hrs(l.hours)} h</div>${st}</div></div>`;
    }).join("") || `<div class="card empty">No credits yet - record your OT hours after you work overtime.</div>`);
  }
  if (otSeg === "hours") {
    const d = ST.drafts.claim;
    h += `<button class="btn p block" data-act="claimEdit" style="margin-bottom:12px">${d ? "Continue my draft (" + plural(d.lines.length, "line", "lines") + ")" : "+ Record OT hours"}</button>`;
    h += `<div class="sub" style="margin:0 4px 10px">Record overtime as soon as you have worked it - as often as you like. Confirmed hours become credits.</div>`;
    const list = ST.db.claims.filter(c => c.status !== "draft").sort((a, b) => (b.submittedAt || "") > (a.submittedAt || "") ? 1 : -1);
    h += list.map(c => `<div class="item"><div class="main"><div class="t">${esc(short(c.id))} ${c.code ? `<span class="code">${esc(c.code)}</span>` : ""}</div>
        ${c.lines.map(l => `<div class="m">${dmy(l.date)} ${esc(l.start)}–${esc(l.end)} · ${hrs(l.hours)} h${l.note ? ` · <b>note:</b> ${esc(l.note)}` : ""}</div>`).join("")}
        ${c.decisionNote ? `<div class="m">“${esc(c.decisionNote)}”</div>` : ""}
        ${c.status === "submitted" ? `<button class="btn sm" style="margin-top:8px" data-withdraw="ot_claims" data-id="${esc(c.id)}">Withdraw</button>` : ""}</div>
        <div class="r"><div class="big">${hrs(c.totals.hours)} h</div><div class="m">${money(c.totals.value || c.totals.otPay)}</div>${statusChip(c.status, { submitted: "Waiting", approved: "Confirmed" })}</div></div>`).join("")
      || `<div class="card empty">Nothing sent yet.</div>`;
  }
  if (otSeg === "pay") {
    const d = ST.drafts.pay;
    if (!payAllowed()) h += `<div class="banner warn">Your contract does not include OT pay - use your credits as time in lieu (Time Off).</div>`;
    h += `<button class="btn p block" data-act="payEdit" style="margin-bottom:12px" ${payAllowed() && (L.usable + L.pendingLeft > 0 || d) ? "" : "disabled"}>${d ? "Continue my OT pay request" : "Claim OT Pay"}</button>
      <div class="sub" style="margin:0 4px 10px">Free credits: <b>${hrs(L.usable)} h</b>. The oldest credits are paid first, at the rate of the day they were worked.</div>`;
    const list = ST.db.payouts.filter(p => p.status !== "draft").sort((a, b) => (b.submittedAt || "") > (a.submittedAt || "") ? 1 : -1);
    h += list.map(p => `<div class="item"><div class="main"><div class="t">${esc(short(p.id))} ${p.code ? `<span class="code">${esc(p.code)}</span>` : ""}</div>
        <div class="m">from ${p.draws.length} OT line${p.draws.length === 1 ? "" : "s"} · sent ${dmy(p.submittedDate)}</div>
        ${p.decisionNote ? `<div class="m">“${esc(p.decisionNote)}”</div>` : ""}
        ${p.signedFile ? `<div class="m">Signed copy ready - open it in PSL Master on the PC (Signed form).</div>` : p.status === "approved" ? `<div class="m">Approved${p.decidedByName ? " by " + esc(p.decidedByName) : ""} - the office makes the signed copy; the unsigned approved form is in PSL Master on your PC (OT pay › Approved form).</div>` : ""}
        ${p.status === "submitted" ? `<button class="btn sm" style="margin-top:8px" data-withdraw="ot_payouts" data-id="${esc(p.id)}">Withdraw</button>` : ""}</div>
        <div class="r"><div class="big">${money(p.amount)}</div><div class="m">${hrs(p.hours)} h</div>${statusChip(p.status)}</div></div>`).join("")
      || `<div class="card empty">No OT pay requests yet.</div>`;
  }
  if (otSeg === "off") {
    const d = ST.drafts.til;
    h += `<button class="btn p block" data-act="tilEdit" style="margin-bottom:12px">${d ? "Continue my application" : "+ Ask for Time Off"}</button>
      <div class="sub" style="margin:0 4px 10px">${tilAllowed() ? "From your credits (time-in-lieu) or unpaid leave." : "Unpaid leave (your contract does not include time in lieu)."} Annual, sick and other leave are under <b>Leave</b>. A full day is ${hrs(ST.profile.normalHours)} h; more than ${hrs(ST.policy.restAfter)} h off by the hour includes ${hrs(ST.policy.restFree)} h of rest that is not charged.</div>`;
    const list = ST.db.tilApps.filter(a => a.status !== "draft" && !a.category).sort((a, b) => (b.submittedAt || "") > (a.submittedAt || "") ? 1 : -1);
    h += list.map(a => `<div class="item"><div class="main"><div class="t">${esc(short(a.id))} ${a.code ? `<span class="code">${esc(a.code)}</span>` : ""}</div>
        ${a.lines.map(l => `<div class="m">${dmy(l.date)} · ${esc(l.leaveType)}${l.paidBy === "Unpaid" ? " · <b>unpaid</b>" : ""}${l.extraBreak ? " · +" + hrs(l.extraBreak) + " h break allowed" : ""}</div>`).join("")}
        ${a.decisionNote ? `<div class="m">“${esc(a.decisionNote)}”</div>` : ""}${a.cancelReason ? `<div class="m">Cancel: “${esc(a.cancelReason)}”${a.cancelNote ? " - " + esc(a.cancelNote) : ""}</div>` : ""}
        ${a.status === "submitted" ? `<button class="btn sm" style="margin-top:8px" data-withdraw="ot_til" data-id="${esc(a.id)}">Withdraw</button>` : ""}
        ${a.signedFile ? `<div class="m">Signed copy ready - open it in PSL Master on the PC (Signed form).</div>` : ""}
        ${!a.signedFile && (a.status === "approved" || a.status === "cancel_requested") ? `<div class="m">Approved${a.decidedByName ? " by " + esc(a.decidedByName) : ""} - the office makes the signed copy; the unsigned approved form is in PSL Master on your PC (Time off › Approved form).</div>` : ""}
        ${a.status === "approved" ? `<button class="btn sm" style="margin-top:8px" data-cancel="${esc(a.id)}">Ask to cancel</button>` : ""}</div>
        <div class="r"><div class="big">${hrs(a.totalHours)} h</div>${a.unpaidHours ? `<div class="m">+ ${hrs(a.unpaidHours)} h unpaid</div>` : ""}${statusChip(a.status)}</div></div>`).join("")
      || `<div class="card empty">No time off yet.</div>`;
  }
  if (otSeg === "leave") {
    const d = ST.drafts.leave, year = TODAY().getUTCFullYear();
    h += `<button class="btn p block" data-act="leaveEdit" style="margin-bottom:12px">${d ? "Continue my leave application" : "+ Apply for Leave"}</button>
      <div class="sub" style="margin:0 4px 10px">Annual, sick, emergency and the other leave on the company leave form. Counted in days - your OT credits are not used.</div>`;
    const bals = E.LeaveForm.filter(E.isCounted).map(t => E.leaveBalance(ST.db, ST.profile, t, year, "")).filter(b => b.entitlement + b.forward > 0 || b.taken || b.waiting);
    if (bals.length) h += `<div class="section">My leave in ${year}</div><div class="balgrid">` + bals.map(b => `<div class="bal"><div class="k">${esc(leaveLabel(b.type))}</div>
      <div class="v">${hrs(Math.max(0, b.available))}<span> of ${hrs(b.entitlement + b.forward)} left</span></div><div class="h">${b.taken ? hrs(b.taken) + " taken" : "none taken"}${b.waiting ? " · " + hrs(b.waiting) + " waiting" : ""}</div></div>`).join("") + `</div>`;
    const list = ST.db.tilApps.filter(a => a.status !== "draft" && a.category).sort((a, b) => (b.submittedAt || b.decidedAt || "") > (a.submittedAt || a.decidedAt || "") ? 1 : -1);
    const mt = ((ST.cal || {}).trainings || []).filter(x => (x.by === ME.email || trnWithMe(x)) && x.status !== "withdrawn").sort((a, b) => a.from < b.from ? 1 : -1).slice(0, 8);
    h += `<div class="section">My Training / Events</div><button class="addb trn wide" data-act="newTrn"><svg viewBox="0 0 24 24"><path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11v5c0 1.5 2.5 3 5 3s5-1.5 5-3v-5"/><path d="M21 9v5"/></svg><span><b>+ Training / Event</b><small>A course, talk or event - working, but not in the office</small></span></button>` +
      (mt.map(x => `<div class="item"><span class="bar" style="background:#22c55e"></span><div class="main"><div class="t">${esc(x.kind + ": " + x.title)}</div>
        <div class="m">${esc((x.from === x.to ? dmy(x.from) : dmy(x.from) + " – " + dmy(x.to)) + (trnTime(x) ? " · " + trnTime(x) : "") + (x.place ? " · " + x.place : ""))}</div>
        ${x.decisionNote ? `<div class="m">“${esc(x.decisionNote)}”</div>` : ""}${trnButtons(x)}</div><div class="r">${statusChip(x.status)}</div></div>`).join("") ||
       `<div class="sub" style="margin:0 4px 12px">Nothing yet - it uses no leave days.</div>`);
    h += `<div class="section">My applications</div>` + (list.map(a => `<div class="item"><div class="main"><div class="t">${esc(leaveLabel(a.category))} <span class="sub">· ${esc(short(a.id))}</span> ${a.code ? `<span class="code">${esc(a.code)}</span>` : ""}</div>
        <div class="m">${esc((a.ranges || []).map(rangeLine).join(", "))}</div>${a.reason ? `<div class="m"><i>“${esc(a.reason)}”</i></div>` : ""}
        ${a.source === "paper" ? `<div class="m">From a signed paper form</div>` : ""}
        ${a.decisionNote && a.status !== "withdrawn" ? `<div class="m">“${esc(a.decisionNote)}”</div>` : ""}${a.cancelReason ? `<div class="m">Cancel: “${esc(a.cancelReason)}”${a.cancelNote ? " - " + esc(a.cancelNote) : ""}</div>` : ""}
        ${a.status === "submitted" ? `<button class="btn sm" style="margin-top:8px" data-withdraw="ot_til" data-id="${esc(a.id)}">Withdraw</button>` : ""}
        ${a.status === "approved" && a.category !== "MIA" && !a.source ? `<button class="btn sm" style="margin-top:8px" data-cancel="${esc(a.id)}">Ask to cancel</button>` : ""}</div>
        <div class="r"><div class="big">${hrs(a.leaveDays)} d</div>${statusChip(a.status)}</div></div>`).join("") || `<div class="card empty">No leave applications yet.</div>`);
  }
  v.innerHTML = h;
}

// ---------- leave on the company leave form (editor)
const blankRange = () => ({ from: "", to: "", half: "", days: 0 });
function newLeaveDraft() {
  return Object.assign(blankCommon(), { schema: 2, id: "TIL-DRAFT", status: "draft", category: "", ranges: [blankRange()], reason: "", source: "", coverName: "", coverDesignation: "", coverContact: "",
    leaveDays: 0, balEntitlement: 0, balForward: 0, balTaken: 0, balAfter: 0, profile: clone(ST.profile), lines: [], totalHours: 0, unpaidHours: 0, draws: [], creditsBefore: 0, creditsAfter: 0,
    decidedByName: "", cancelReason: "", cancelRequestedAt: "", cancelDecidedAt: "", cancelDecidedBy: "", cancelNote: "" });
}
function leavePreview(a) { a.schema = 2; a.profile = clone(ST.profile); E.leaveCompute(a); return E.leaveCheck(ST.db, a, TODAY()); }
function pageLeaveEdit(v) {
  title("Apply for Leave");
  if (!ST.drafts.leave) { ST.drafts.leave = newLeaveDraft(); save(); }
  const a = ST.drafts.leave;
  v.innerHTML = banners() + `<div class="card"><div class="field"><label>Type of leave</label><select data-lv="category"><option value="">Choose…</option>${E.LeaveForm.map(t => `<option value="${esc(t)}" ${t === a.category ? "selected" : ""}>${esc(leaveLabel(t))}</option>`).join("")}</select></div>
      <div class="sub" data-c="kindNote"></div></div>` +
    a.ranges.map((g, i) => `<div class="linecard" data-ri="${i}" style="border-left-color:var(--teal)"><div class="head"><b>${a.ranges.length > 1 ? "Dates " + (i + 1) : "Dates"}</b><span class="chip gray" data-c="days"></span>${a.ranges.length > 1 ? `<button class="btn ghost sm" data-rdel="${i}" aria-label="Remove">✕</button>` : ""}</div>
      <div class="grid2"><div class="field"><label>From</label><input type="date" data-lv="from" value="${esc(g.from)}"></div><div class="field"><label>To</label><input type="date" data-lv="to" value="${esc(g.to || g.from)}" min="${esc(g.from)}"></div></div>
      ${g.from && (!g.to || g.to === g.from) ? `<div class="field"><label>How long</label><div class="seg small">${[["", "Full day"], ["AM", "Morning"], ["PM", "Afternoon"]].map(([k, l]) => `<button data-lhalf="${k}" class="${(g.half || "") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>` : ""}</div>`).join("") +
    (a.ranges.length < E.MaxRanges ? `<button class="btn block" data-act="addRange" style="margin-bottom:12px">+ Add more dates</button>` : "") +
    `<div class="card"><div class="field"><label>Reason(s)</label><input type="text" data-lv="reason" maxlength="200" value="${esc(a.reason)}" placeholder="e.g. family matter, medical"></div>
      <div class="section" style="margin-top:4px">Duties covered by (optional)</div>
      <div class="field"><label>Name</label><input type="text" data-lv="coverName" maxlength="80" value="${esc(a.coverName)}"></div>
      <div class="grid2"><div class="field"><label>Designation</label><input type="text" data-lv="coverDesignation" maxlength="80" value="${esc(a.coverDesignation)}"></div><div class="field"><label>Contact</label><input type="tel" data-lv="coverContact" maxlength="40" value="${esc(a.coverContact)}"></div></div></div>
    <div id="lbal"></div><div class="msgs" id="checks"></div>`;
  actionBar(`<div class="info" id="leaveSum"></div><button class="btn p" data-act="sendLeave">Send</button>`);
  leaveCalc();
}
function leaveCalc() {
  const a = ST.drafts.leave; if (!a) return;
  const chk = leavePreview(a);
  $$("[data-ri]").forEach(card => { const g = a.ranges[+card.dataset.ri]; if (g) card.querySelector('[data-c="days"]').textContent = g.days ? hrs(g.days) + (g.days === 1 ? " day" : " days") : "choose"; });
  const kn = $('[data-c="kindNote"]');
  if (kn) kn.textContent = !a.category ? "" : E.calendarDays(a.category) ? "Counted day after day (weekends too)." : E.isCounted(a.category) ? "Counted on your working days only." : "Not counted against a yearly number of days.";
  const year = E.leaveYear(a), b = a.category && E.isCounted(a.category) ? E.leaveBalance(ST.db, ST.profile, a.category, year, a.id) : null;
  $("#lbal").innerHTML = b ? `<div class="card"><div class="section" style="margin-top:0">${esc(leaveLabel(a.category))} in ${year}</div><div class="balrow">
      <div><div class="k">Entitled</div><div class="v">${hrs(b.entitlement)}${b.forward ? " + " + hrs(b.forward) : ""}</div></div><div><div class="k">Taken</div><div class="v">${hrs(b.taken)}</div></div>
      ${b.waiting ? `<div><div class="k">Waiting</div><div class="v">${hrs(b.waiting)}</div></div>` : ""}<div><div class="k">This one</div><div class="v">${hrs(a.leaveDays)}</div></div>
      <div><div class="k">Left after</div><div class="v ${a.balAfter < 0 ? "neg" : ""}">${hrs(a.balAfter)}</div></div></div></div>` : "";
  $("#checks").innerHTML = msgs(chk.errors, chk.warnings) || `<div class="msg ok"><b>✓</b><span>All checks passed.</span></div>`;
  $("#leaveSum").innerHTML = `<b>${hrs(a.leaveDays)} ${a.leaveDays === 1 ? "day" : "days"}</b><br>${a.category ? esc(leaveLabel(a.category)) : "choose the type"}`;
  const btn = $('[data-act="sendLeave"]'); if (btn) btn.disabled = chk.errors.length > 0;
}
async function submitLeave() {
  const no = notAllowed(); if (no) return tell("Not sent", no);
  try { await pullMine(); } catch (e) { return tell("Not sent", "Could not reach the database.\n" + e.message); }
  const a = ST.drafts.leave;
  ["reason", "coverName", "coverDesignation", "coverContact"].forEach(k => a[k] = String(a[k] || "").trim());
  a.id = newRef("TIL", ST.db.tilApps.map(x => x.id));
  const chk = leavePreview(a);
  if (chk.errors.length) return tell("Fix these first", "• " + chk.errors.join("\n• "));
  a.warnings = chk.warnings;
  const L = ledger(); a.creditsAfter = L.usable; a.creditsBefore = L.usable;
  try {
    await send("ot_til", a, E.canonTil, o => ({ dates: o.lines.map(l => l.date).join(","), hours: E.Num(0), unpaid: E.Num(0), category: o.category, days: E.Num(o.leaveDays),
      cancelReason: "", cancelRequestedAt: "", cancelDecidedAt: "", cancelDecidedBy: "", cancelNote: "" }), "leave applied for",
      o => "code " + o.code + "; " + o.category + " " + E.Num(o.leaveDays) + " day(s): " + E.leaveDates(o));
  } catch (e) { return tell("Not sent", e.message); }
  ST.db.tilApps.push(a); ST.drafts.leave = null; save();
  stack.pop(); otSeg = "leave"; render(); toast("Sent for approval");
}

// redraw without jumping: the page and the people list keep their scroll position
function keepScroll(fn) { const y = window.scrollY, l = $(".ppl"), t = l ? l.scrollTop : 0; fn(); window.scrollTo(0, y); const l2 = $(".ppl"); if (l2) l2.scrollTop = t; }

// ---------- a training / event (Training.cs): working, but not in the office
let trnDraft = null, staffList = null, staffQ = "";
async function loadStaff() {
  if (staffList) return;
  if (DEMO) { staffList = [{ id: "PSL12", name: "Ahmad bin Ali", position: "Site Supervisor" }, { id: "PSL13", name: "Siti binti Rahman", position: "Clerk" }, { id: "PSL14", name: "Dewi Supang Robin", position: "Site Manager" }, { id: "PSL15", name: "Jason Lim", position: "Technician" }]; return; }
  staffList = (await fs.list("employees")).filter(d => d.f.status !== "inactive" && d.f.status !== "left")
    .map(d => ({ id: String(d.f.employeeId || d.id).toUpperCase(), name: d.f.name || d.id, position: d.f.position || "" })).sort((a, b) => a.name.localeCompare(b.name));
}
// what the person may do with it: the office decides / changes / cancels (their own too); whoever asked withdraws while it waits
function trnButtons(x) {
  const office = officeAllowed(), b = [];
  if (office && x.status === "submitted") b.push(`<button class="btn sm p" data-tact="approve" data-tid="${esc(x.id)}">Approve</button>`, `<button class="btn sm" data-tact="decline" data-tid="${esc(x.id)}">Decline</button>`);
  if ((office || x.by === ME.email) && (x.status === "approved" || x.status === "submitted")) b.push(`<button class="btn sm" data-tedit="${esc(x.id)}">Change</button>`);
  if (office && x.status === "approved") b.push(`<button class="btn sm" data-tact="cancel" data-tid="${esc(x.id)}">Cancel it</button>`);
  if (x.by === ME.email && x.status === "submitted") b.push(`<button class="btn sm" data-tact="withdraw" data-tid="${esc(x.id)}">Withdraw</button>`);
  return b.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${b.join("")}</div>` : "";
}
function pageTrnEdit(v) {
  const r = trnDraft, office = officeAllowed();
  title(r.id ? "Change Training / Event" : office ? "Add Training / Event" : "Ask for Training / Event");
  const n = staffQ.trim().toLowerCase();
  const pick = !staffList ? `<div class="sub">Reading the staff list…</div>` :
    `<div class="sub" style="margin-bottom:6px">${r.people.length ? r.people.length + " chosen" : "Nobody chosen yet"}</div><div class="field"><input type="search" id="stfQ" placeholder="Find a person…" value="${esc(staffQ)}"></div><div class="ppl">` +
    staffList.filter(s2 => !n || (s2.name + " " + s2.id + " " + s2.position).toLowerCase().indexOf(n) >= 0)
      .map(s2 => { const on = r.people.indexOf(s2.id) >= 0, e = (r.early || {})[s2.id];
        return `<div class="prow"><label><input type="checkbox" data-tp="${esc(s2.id)}" ${on ? "checked" : ""}><span><b>${esc(s2.name)}</b><br><span class="sub">${esc([s2.id, s2.position].filter(Boolean).join(" · "))}</span></span></label>` +
          (on ? `<div class="early"><label><input type="checkbox" data-te="${esc(s2.id)}" ${e !== undefined ? "checked" : ""}>Leaves early</label>${e !== undefined ? `<input type="date" data-td="${esc(s2.id)}" value="${esc(e.d)}" min="${esc(r.from)}" max="${esc(r.to || r.from)}"><input type="time" data-tt="${esc(s2.id)}" value="${esc(e.t)}">` : ""}</div>` +
            (e !== undefined ? `<div class="early-hint">Day they leave · time (leave the time empty if that is their last day)</div>` : "") : "") + `</div>`; }).join("") + `</div>`;
  v.innerHTML = `<div class="sub" style="margin:0 4px 10px">For people who are working, but not in the office (a course, a talk, an exhibition, a site event...). It uses no leave days.${office ? "" : " Choose your colleagues too - an approver checks it first."}</div>
    ${!office && r.id && r.status === "approved" ? `<div class="banner warn">It is approved - saving a change sends it back to the approvers.</div>` : ""}
    <div class="card"><div class="field"><label>Name</label><input type="text" data-tn="title" maxlength="80" value="${esc(r.title)}" placeholder="e.g. First aid course, TedTalk"></div>
    <div class="field"><label>What it is</label><div class="seg small">${["Training", "Event"].map(k => `<button data-tkind="${k}" class="${r.kind === k ? "on" : ""}">${k}</button>`).join("")}</div></div>
    <div class="grid2"><div class="field"><label>From</label><input type="date" data-tn="from" value="${esc(r.from)}"></div><div class="field"><label>To</label><input type="date" data-tn="to" value="${esc(r.to)}" min="${esc(r.from)}"></div></div>
    <div class="grid2"><div class="field"><label>Starts (optional)</label><input type="time" data-tn="start" value="${esc(r.start)}"></div><div class="field"><label>Ends (optional)</label><input type="time" data-tn="end" value="${esc(r.end)}"></div></div>
    <div class="field"><label>Where (optional)</label><input type="text" data-tn="place" maxlength="120" value="${esc(r.place)}"></div>
    <div class="field"><label>Notes / remarks (optional)</label><input type="text" data-tn="notes" maxlength="500" value="${esc(r.notes)}"></div></div>
    <div class="card"><div class="field"><label>Who takes part</label>${pick}</div></div>`;
  actionBar(`<div class="info">${r.people.length ? plural(r.people.length, "person", "people") : "choose who"}${office ? "" : "<br>goes to an approver"}</div><button class="btn p" data-act="saveTrn">${office ? "Save" : "Send"}</button>`);
}
async function saveTraining() {
  const r = trnDraft, office = officeAllowed();
  const title2 = r.title.trim().slice(0, 80), hhmm = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  if (!title2) return tell("Not saved", "Give it a name, e.g. \"Safety training\" or \"TedTalk\".");
  if (!E.day(r.from)) return tell("Not saved", "Choose the first day.");
  const to = E.day(r.to) ? r.to : r.from;
  if (to < r.from) return tell("Not saved", "The last day is before the first day.");
  if ((E.day(to) - E.day(r.from)) / 864e5 >= 60) return tell("Not saved", "One training / event can cover up to 60 days.");
  if ((r.start && !hhmm.test(r.start)) || (r.end && !hhmm.test(r.end))) return tell("Not saved", "The time looks wrong - use e.g. 09:00.");
  if (r.start && r.end && r.end <= r.start && to === r.from) return tell("Not saved", "It ends before it starts.");
  const people = r.people.slice();
  if (!office && !ME.employeeId) return tell("Not saved", "Your Google account has no employee ID yet - ask the admin.");
  const early = [];
  for (const id of Object.keys(r.early || {}).filter(id => people.indexOf(id) >= 0)) {
    const e = r.early[id] || {}, d = e.d || (r.from === to ? r.from : ""), nm = ((staffList || []).find(x => x.id === id) || {}).name || id;
    if (!E.day(d)) return tell("Not saved", "Choose the day " + nm + " leaves.");
    if (d < r.from || d > to) return tell("Not saved", "The day " + nm + " leaves must be between " + dmy(r.from) + " and " + dmy(to) + ".");
    if (e.t && !hhmm.test(e.t)) return tell("Not saved", "The time " + nm + " leaves looks wrong - use e.g. 15:00.");
    if (e.t && ((r.start && e.t <= r.start) || (r.end && e.t >= r.end))) return tell("Not saved", nm + " must leave after it starts and before it ends" + (r.end ? " (" + r.end + ")" : "") + ".");
    if (!e.t && d === to) return tell("Not saved", nm + "'s last day is the last day of it - that is not early. Give the time they leave, or an earlier day.");
    early.push(id + "=" + d + (e.t ? " " + e.t : ""));
  }
  if (!people.length) return tell("Not saved", "Choose who takes part.");
  await loadStaff().catch(() => { });
  const names = people.map(id => ((staffList || []).find(x => x.id === id) || {}).name || (id === String(ME.employeeId).toUpperCase() ? myName() : id));
  const now = E.nowStamp();
  const f = { title: title2, kind: r.kind === "Event" ? "Event" : "Training", from: r.from, to, start: r.start || "", end: r.end || "", place: (r.place || "").trim().slice(0, 120), notes: (r.notes || "").trim().slice(0, 500),
    people, names, early, updatedAt: now };
  const isNew = !r.id;
  let id = r.id;
  if (isNew) {
    id = "TRN-" + r.from.replace(/-/g, "") + "-" + randomId().slice(0, 6);
    Object.assign(f, { by: ME.email, byName: myName().slice(0, 80), byEmployeeId: ME.employeeId || "", createdAt: now, status: office ? "approved" : "submitted",
      decidedBy: office ? ME.email : "", decidedByName: office ? myName().slice(0, 80) : "", decidedAt: office ? now : "", decisionNote: "" });
  } else if (!office) Object.assign(f, { status: "submitted", decidedBy: "", decidedByName: "", decidedAt: "", decisionNote: "" });     // their own change: back to the approvers
  const trail = eventWrite(ME.employeeId || "", (isNew ? (office ? "training / event added" : "training / event asked for") : "training / event changed") + (!isNew && !office ? " (back to waiting)" : ""), id,
    f.kind + ": " + title2 + " · " + r.from + (to !== r.from ? " - " + to : "") + (r.start ? " " + r.start + (r.end ? "-" + r.end : "") : "") + " · people: " + people.map((pp, i) => names[i] + " (" + pp + ")").join(", ") + (early.length ? " · leaving early: " + early.join(", ") : ""), people);
  try { if (!DEMO) await fs.commit([isNew ? { col: "office_trainings", id, fields: f } : { col: "office_trainings", id, fields: f, mask: Object.keys(f) }, trail]); }
  catch (e) { return tell("Not saved", e.code === "denied" ? "The database refused it (the latest database rules may not be published yet)." : e.message); }
  const list = ST.cal.trainings = (ST.cal.trainings || []).filter(x => x.id !== id);
  list.push(Object.assign({ id, status: isNew ? f.status : r.status, by: isNew ? ME.email : r.by, byName: isNew ? f.byName : r.byName, decidedByName: "", decisionNote: "", createdAt: now }, f));
  ring(!office ? ["calendar", "approvals"] : ["calendar"]); save();
  trnDraft = null; stack.pop(); calMonth = r.from.substr(0, 7); calSel = r.from; render();
  toast(!office ? "Sent - an approver will look at it" : "Saved - everybody sees it now");
}
async function trainingAct(id, action) {
  let note = "";
  if (action === "decline" || action === "cancel") {
    note = await sheet(action === "decline" ? "Decline it?" : "Cancel it?", `<div class="field"><input type="text" maxlength="300" placeholder="${action === "decline" ? "Why (they will see it)" : "Why (optional)"}"></div>`,
      [{ label: "Back" }, { label: action === "decline" ? "Decline" : "Cancel it", cls: "p", value: "input" }]);
    if (note == null) return;
    if (action === "decline" && !note.trim()) return tell("Not done", "Write why it is declined - they will see it.");
  } else if (action === "withdraw" && !await sheet("Withdraw it?", "Your request is taken back.", [{ label: "Back" }, { label: "Withdraw", cls: "p", value: true }])) return;
  const to = { approve: "approved", decline: "declined", cancel: "cancelled", withdraw: "withdrawn" }[action], now = E.nowStamp();
  const f = { status: to, updatedAt: now };
  if (action !== "withdraw") Object.assign(f, { decidedBy: ME.email, decidedByName: myName().slice(0, 80), decidedAt: now, decisionNote: note.trim().slice(0, 300) });
  const tx = ((ST.cal || {}).trainings || []).find(y => y.id === id) || { kind: "", title: "", people: [] };
  try { if (!DEMO) await fs.commit([{ col: "office_trainings", id, fields: f, mask: Object.keys(f) }, eventWrite(ME.employeeId || "", "training / event " + to, id, tx.kind + ": " + tx.title + (note && note.trim() ? " - " + note.trim() : ""), tx.people)]); }
  catch (e) { return tell("Not done", e.code === "denied" ? "The database refused it." : e.message); }
  const x = ((ST.cal || {}).trainings || []).find(y => y.id === id); if (x) Object.assign(x, f);
  ST.conf = ST.conf.filter(i => !(i.kind === "training" && i.id === id));
  ring(["calendar", "approvals"]); save(); render();
  toast(action === "approve" ? "Approved - it is on everybody's calendar" : action === "decline" ? "Declined" : action === "cancel" ? "Cancelled" : "Withdrawn");
}

// ---------- a calendar reminder (Calendar.SaveReminder): for me, the whole office, or chosen people
let remDraft = null, peopleList = null, peopleQ = "";
async function loadPeople() {
  if (peopleList || DEMO) { if (DEMO && !peopleList) peopleList = [{ email: "dewi.sample@psetialestari.com", name: "Dewi Supang Robin", employeeId: "PSL13", position: "Manager" }, { email: "siti.sample@gmail.com", name: "Siti binti Rahman", employeeId: "PSL15", position: "Clerk" }].filter(p => p.email !== ME.email); return; }
  const all = await fs.list("employees");
  peopleList = all.map(d => ({ email: String(d.f.email || "").toLowerCase(), name: d.f.name || d.id, employeeId: d.f.employeeId || d.id, position: d.f.position || "", status: d.f.status || "active" }))
    .filter(p => p.email && p.status === "active" && p.email !== ME.email).sort((a, b) => a.name.localeCompare(b.name));
}
function pageRemEdit(v) {
  const r = remDraft;
  title(r.id ? "Change Reminder" : "Set a Reminder");
  const pl = r.audience !== "people" ? "" : !peopleList ? `<div class="sub" style="margin:8px 2px">Reading the staff list…</div>` :
    `<div class="field" style="margin-top:8px"><input type="search" id="pplQ" placeholder="Find a person…" value="${esc(peopleQ)}"></div><div class="ppl">` +
    peopleList.filter(p => !peopleQ || (p.name + " " + p.employeeId + " " + p.position).toLowerCase().indexOf(peopleQ.toLowerCase()) >= 0)
      .map(p => `<label><input type="checkbox" data-pe="${esc(p.email)}" ${r.to.indexOf(p.email) >= 0 ? "checked" : ""}><span><b>${esc(p.name)}</b><br><span class="sub">${esc([p.employeeId, p.position].filter(Boolean).join(" · "))}</span></span></label>`).join("") + `</div>`;
  v.innerHTML = `<div class="card"><div class="field"><label>What</label><input type="text" data-rf="title" maxlength="80" value="${esc(r.title)}" placeholder="e.g. Submit tender T/435"></div>
    <div class="grid2"><div class="field"><label>Day</label><input type="date" data-rf="date" value="${esc(r.date)}"></div><div class="field"><label>Time (optional)</label><input type="time" data-rf="time" value="${esc(r.time)}"></div></div>
    <div class="field"><label>Note (optional)</label><input type="text" data-rf="note" maxlength="200" value="${esc(r.note)}"></div>
    <div class="field"><label>Who sees it</label><div class="seg small">${[["me", "Only Me"], ["all", "Whole Office"], ["people", "Choose People"]].map(([k, l]) => `<button data-raud="${k}" class="${r.audience === k ? "on" : ""}">${l}</button>`).join("")}</div>${pl}</div></div>
    <div class="sub" style="margin:0 4px 12px">It shows in teal on the calendar of everyone it is for, and pops up on their PC at its time (09:00 if no time).</div>`;
  actionBar(`<div class="info">${r.audience === "people" ? plural(r.to.length, "person", "people") + " chosen" : r.audience === "all" ? "Everybody sees it" : "Only you see it"}</div>${r.id ? `<button class="btn" data-act="delRem">Remove</button>` : ""}<button class="btn p" data-act="saveRem">Save</button>`);
}
async function saveReminder() {
  const r = remDraft;
  const title2 = r.title.trim().slice(0, 80), time = (r.time || "").trim();
  if (!title2) return tell("Not saved", "Write what the reminder is about.");
  if (!E.day(r.date)) return tell("Not saved", "Pick the day.");
  if (time && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return tell("Not saved", "The time looks wrong - use e.g. 09:30.");
  const to = r.audience === "people" ? r.to.filter((x, i, a) => x && x !== ME.email && a.indexOf(x) === i) : [];
  if (r.audience === "people" && !to.length) return tell("Not saved", "Choose who should see it.");
  if (to.length > 50) return tell("Not saved", "Choose up to 50 people - or show it to the whole office.");
  const names = r.audience === "people" ? (peopleList || []).filter(p => to.indexOf(p.email) >= 0).map(p => p.name).join(", ").slice(0, 300) : "";
  const f = { title: title2, date: r.date, time, note: r.note.trim().slice(0, 200), by: ME.email, byName: myName().slice(0, 80), audience: r.audience, to, toNames: names, updatedAt: E.nowStamp() };
  const isNew = !r.id, id = r.id || "R-" + r.date.replace(/-/g, "") + "-" + randomId().slice(0, 6);
  try { if (!DEMO) await fs.commit([isNew ? { col: "office_reminders", id, fields: f } : { col: "office_reminders", id, fields: f, mask: Object.keys(f) },
    eventWrite(ME.isAdmin ? "" : ME.employeeId || "", "reminder " + (isNew ? "added" : "changed"), id, title2 + " · " + r.date + (time ? " " + time : "") + " · for " + r.audience + (names ? " (" + names + ")" : ""))]); }
  catch (e) { return tell("Not saved", e.message); }
  const list = (ST.cal.reminders = (ST.cal.reminders || []).filter(x => x.id !== id));
  list.push(Object.assign({ id, mine: true }, f));
  ring(["calendar"]); save();
  calMonth = r.date.substr(0, 7); calSel = r.date; remDraft = null; stack.pop(); render(); toast(r.audience === "me" ? "Reminder set" : "Reminder set - they see it now");
}
async function deleteReminder(id) {
  if (!await sheet("Remove this reminder?", "It goes for everybody it was shown to.", [{ label: "Back" }, { label: "Remove", cls: "p", value: true }])) return;
  try { if (!DEMO) await fs.commit([{ col: "office_reminders", id, del: true }, eventWrite(ME.isAdmin ? "" : ME.employeeId || "", "reminder removed", id, "")]); } catch (e) { return tell("Not removed", e.message); }
  ST.cal.reminders = (ST.cal.reminders || []).filter(x => x.id !== id);
  ring(["calendar"]); save();
  if (stack.length && stack[stack.length - 1].name === "remEdit") { remDraft = null; stack.pop(); }
  render(); toast("Removed");
}

// ---------- record OT hours (editor)
function pageClaimEdit(v) {
  title("Record OT Hours");
  if (!ST.drafts.claim) { ST.drafts.claim = newClaimDraft(); ST.drafts.claim.lines.push(blankLine(null)); save(); }
  const c = ST.drafts.claim;
  v.innerHTML = banners() + `<div class="sub" style="margin:0 4px 12px">Working day: only the time after your shift ends (${esc(ST.profile.shiftEnd)}). Weekend / public holiday: the whole period - mention a public holiday in the remarks; the approver sets it and any break.</div>` +
    c.lines.map((l, i) => `<div class="linecard" data-i="${i}"><div class="head"><b>Overtime ${i + 1}</b><span class="chip gray" data-c="type"></span><button class="btn ghost sm" data-del="${i}" aria-label="Remove">✕</button></div>
      <div class="field"><label>Date</label><input type="date" data-f="date" value="${esc(l.date)}" max="${TODAY_ISO()}"></div>
      <div class="grid2"><div class="field"><label>Start</label><input type="time" data-f="start" value="${esc(l.start)}"></div><div class="field"><label>End</label><input type="time" data-f="end" value="${esc(l.end)}"></div></div>
      <div class="field"><label>Work done / remarks</label><input type="text" data-f="remarks" maxlength="120" value="${esc(l.remarks)}" placeholder="What was done"></div>
      <div class="calc" data-c="calc"></div></div>`).join("") +
    `<button class="btn block" data-act="addLine" style="margin-bottom:12px">+ Add another day</button><div class="msgs" id="checks"></div>`;
  actionBar(`<div class="info" id="claimSum"></div><button class="btn p" data-act="sendClaim">Send</button>`);
  claimCalc();
}
function claimCalc() {
  const c = clone(ST.drafts.claim); refreshClaim(c);
  const chk = E.check(ST.db, c, TODAY());
  const bad = new Set(); chk.errors.forEach(e => { const m = /^Line (\d+):/.exec(e); if (m) bad.add(+m[1] - 1); });
  $$(".linecard").forEach(card => {
    const i = +card.dataset.i, l = c.lines[i]; if (!l) return;
    card.querySelector('[data-c="type"]').textContent = l.day ? l.day + " · " + l.dayType : "choose a date";
    card.querySelector('[data-c="calc"]').innerHTML = l.hours ? `<span class="chip blue">${hrs(l.hours)} h</span><span class="chip gray">worth ${money(l.value)}</span>` : "";
    card.classList.toggle("bad", bad.has(i));
  });
  $("#checks").innerHTML = msgs(chk.errors, chk.warnings) || (c.lines.length ? `<div class="msg ok"><b>✓</b><span>All checks passed.</span></div>` : "");
  $("#claimSum").innerHTML = `<b>${hrs(c.totals.hours)} h</b><br>worth ${money(c.totals.value)}`;
  const b = $('[data-act="sendClaim"]'); if (b) b.disabled = chk.errors.length > 0 || !c.lines.length;
}

// ---------- OT pay (editor)
function pagePayEdit(v) {
  title("Claim OT Pay");
  if (!ST.drafts.pay) {
    const L = ledger();
    const fit = L.lots.filter(l => l.approved && l.remaining > 0).slice(0, E.MaxClaimLines).reduce((t, l) => t + l.remaining, 0);
    ST.drafts.pay = Object.assign(blankCommon(), { schema: 2, id: "PAY-DRAFT", status: "draft", profile: clone(ST.profile), rates: rates(), hours: E.R2(Math.min(L.usable, fit)), remarks: "",
      draws: [], amount: 0, creditsBefore: 0, creditsAfter: 0 });
    save();
  }
  const p = ST.drafts.pay;
  v.innerHTML = banners() + `<div class="card"><div class="field"><label>Hours to be paid</label><div class="row"><input type="number" id="payHours" min="0" step="0.25" value="${esc(p.hours)}" inputmode="decimal">
      <button class="btn" data-act="payAll" style="flex:none">All</button></div></div>
    <div class="field"><label>Remarks (optional)</label><input type="text" id="payRemarks" maxlength="200" value="${esc(p.remarks)}"></div>
    <div class="sub">Oldest credits are paid first. One form holds ${E.MaxClaimLines} OT lines.</div></div>
    <div class="section">Paid from</div><div id="payDraws"></div><div class="msgs" id="checks"></div>`;
  actionBar(`<div class="info" id="paySum"></div><button class="btn p" data-act="sendPay">Send</button>`);
  payCalc();
}
function payCalc() {
  const p = ST.drafts.pay; const chk = payPreview(p);
  $("#payDraws").innerHTML = p.draws.map(d => `<div class="item"><div class="main"><div class="t">${dmy(d.date)} · ${esc(d.dayType)}</div><div class="m">${hrs(d.hours)} of ${hrs(d.lineHours)} h${d.pending ? " · not confirmed yet" : d.expired ? " · pay-out only" : ""}</div></div>
    <div class="r"><div class="big">${money(d.amount)}</div></div></div>`).join("") || `<div class="card empty">No credits used yet.</div>`;
  $("#checks").innerHTML = msgs(chk.errors, chk.warnings);
  $("#paySum").innerHTML = `<b>${money(p.amount)}</b><br>${hrs(p.hours)} h · ${hrs(p.creditsAfter)} h left after`;
  const b = $('[data-act="sendPay"]'); if (b) b.disabled = chk.errors.length > 0;
}

// ---------- time off (editor)
function pageTilEdit(v) {
  title("Time Off");
  if (!ST.drafts.til) {
    ST.drafts.til = Object.assign(blankCommon(), { schema: 2, id: "TIL-DRAFT", status: "draft", profile: clone(ST.profile), lines: [], totalHours: 0, unpaidHours: 0, draws: [], creditsBefore: 0, creditsAfter: 0,
      cancelReason: "", cancelRequestedAt: "", cancelDecidedAt: "", cancelDecidedBy: "", cancelNote: "" });
    ST.drafts.til.lines.push(blankLeave()); save();
  }
  const a = ST.drafts.til, allowed = tilAllowed();
  if (!allowed) tilRange.paidBy = "Unpaid";
  v.innerHTML = banners() + `<div class="sub" style="margin:0 4px 12px">Full day = ${hrs(ST.profile.normalHours)} h · half day AM = ${hrs(E.HalfDayAm)} h · PM = ${hrs(E.HalfDayPm)} h. Apply at least 3 working days before.</div>` +
    // several days in one go: every working day from .. to becomes a full day (your days off are left out)
    `<div class="linecard rangecard" style="border-left-color:var(--teal)"><div class="head"><b>Several days in a row</b></div>
      <div class="grid2"><div class="field"><label>From</label><input type="date" id="rgFrom" value="${esc(tilRange.from)}"></div><div class="field"><label>To</label><input type="date" id="rgTo" value="${esc(tilRange.to)}" min="${esc(tilRange.from)}"></div></div>
      <div class="field"><label>Paid by</label><div class="seg small" id="rgPaid"><button data-rv="TIL" class="${tilRange.paidBy !== "Unpaid" ? "on til" : ""}" ${allowed ? "" : "disabled"}>My credits</button><button data-rv="Unpaid" class="${tilRange.paidBy === "Unpaid" ? "on" : ""}">Unpaid leave</button></div></div>
      <div class="sub" id="rgInfo" style="margin:2px 2px 10px"></div>
      <button class="btn block" data-act="addRange">Add these days</button></div>` +
    a.lines.map((l, i) => `<div class="linecard" data-i="${i}" style="border-left-color:var(--teal)"><div class="head"><b>Day ${i + 1}</b><span class="chip gray" data-c="charged"></span><button class="btn ghost sm" data-del="${i}" aria-label="Remove">✕</button></div>
      <div class="field"><label>Date</label><input type="date" data-f="date" value="${esc(l.date)}"></div>
      <div class="field"><label>Leave</label><select data-f="leaveType">${E.LeaveTypes.map(t => `<option ${t === l.leaveType ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="grid2 ${l.leaveType === "Hours" ? "" : "hidden"}" data-c="hours"><div class="field"><label>From</label><input type="time" data-f="from" value="${esc(l.from)}"></div><div class="field"><label>To</label><input type="time" data-f="to" value="${esc(l.to)}"></div></div>
      <div class="field"><label>Paid by</label><div class="seg small" data-f="paidBy"><button data-v="TIL" class="${l.paidBy !== "Unpaid" ? "on til" : ""}" ${allowed ? "" : "disabled"}>My credits</button><button data-v="Unpaid" class="${l.paidBy === "Unpaid" ? "on" : ""}">Unpaid leave</button></div></div>
      <div class="field"><label>Reason (optional)</label><input type="text" data-f="reason" maxlength="120" value="${esc(l.reason)}"></div></div>`).join("") +
    `<button class="btn block" data-act="addLeave" style="margin-bottom:12px">+ Add another day</button><div class="msgs" id="checks"></div>`;
  actionBar(`<div class="info" id="tilSum"></div><button class="btn p" data-act="sendTil">Send</button>`);
  tilCalc(); rangeInfo();
}
// "several days in a row": the working days in the chosen dates (your days off are left out), each with a "public holiday" tick -
// the admin's public holidays are ticked already; a ticked day is not taken (and not charged). Paid by credits: against your free credits.
let tilRange = { from: "", to: "", paidBy: "TIL", ph: {} };
const rangePh = d => d in tilRange.ph ? tilRange.ph[d] : d in E.holidays(ST.policy);
function rangeDays() { return tilRange.from ? E.workingDays(ST.profile, tilRange.from, tilRange.to || tilRange.from) : []; }
function rangeInfo() {
  const box = $("#rgInfo"); if (!box) return;
  const nh = ST.profile.normalHours || 8.5, free = ledger().approvedLeft, fullDays = Math.floor((free + 0.001) / nh);
  const credits = `Your free credits: <b>${hrs(free)} h</b> = ${plural(fullDays, "full day", "full days")}.`;
  if (!tilRange.from) { box.innerHTML = tilRange.paidBy === "Unpaid" ? "Unpaid leave does not use your credits." : credits; return; }
  const all = rangeDays(), names = E.holidays(ST.policy), days = all.filter(d => !rangePh(d));
  const span = E.day(tilRange.to || tilRange.from) && E.day(tilRange.from) ? Math.round((E.day(tilRange.to || tilRange.from) - E.day(tilRange.from)) / 864e5) + 1 : 0;
  const need = E.R2(days.length * nh), DN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  box.innerHTML = (all.length ? `<div class="phlist">${all.map(d => `<label class="phday${rangePh(d) ? " on" : ""}"><input type="checkbox" data-ph="${d}" ${rangePh(d) ? "checked" : ""}>
      <span><b>${DN[E.day(d).getUTCDay()]} ${dmy(d).substr(0, 5)}</b> ${rangePh(d) ? "public holiday" + (names[d] ? " · " + esc(names[d]) : "") : "working day"}</span></label>`).join("")}</div>
      <div class="sub" style="margin:4px 0 8px">Tick a day that is a public holiday - it is left out.${span > all.length ? " " + plural(span - all.length, "day is", "days are") + " not your working days (" + esc(E.cleanDays(ST.profile.normalDays)) + ") and left out." : ""}</div>` : "") +
    (!days.length ? "No working days to take in these dates." :
    `<b>${plural(days.length, "working day", "working days")}</b> = ${hrs(need)} h` + (tilRange.paidBy === "Unpaid" ? " of unpaid leave (your credits are not used)." :
      " from your credits. " + credits + (need > free + 0.001 ? ` <b style="color:var(--bad)">${hrs(E.R2(need - free))} h more than you have</b> - make some days Unpaid, or choose fewer days.` : "")));
}
const blankLeave = () => ({ date: "", leaveType: "Full Day", from: "", to: "", reason: "", paidBy: tilAllowed() ? "TIL" : "Unpaid", extraBreak: 0, day: "", span: 0, restFree: 0, hours: 0, unpaid: 0 });
function tilCalc() {
  const a = ST.drafts.til; const chk = tilPreview(a);
  $$(".linecard").forEach(card => {
    const l = a.lines[+card.dataset.i]; if (!l) return;
    card.querySelector('[data-c="charged"]').textContent = !l.span ? "choose" : l.paidBy === "Unpaid" ? hrs(l.unpaid) + " h unpaid" : hrs(l.hours) + " h" + (l.restFree ? " (" + hrs(l.restFree) + " h rest free)" : "");
  });
  $("#checks").innerHTML = msgs(chk.errors, chk.warnings) || (a.lines.length ? `<div class="msg ok"><b>✓</b><span>Covered by your credits.</span></div>` : "");
  $("#tilSum").innerHTML = `<b>${hrs(a.totalHours)} h</b> from credits${a.unpaidHours ? "<br>+ " + hrs(a.unpaidHours) + " h unpaid" : "<br>" + hrs(a.creditsAfter) + " h left after"}`;
  const b = $('[data-act="sendTil"]'); if (b) b.disabled = chk.errors.length > 0 || !a.lines.length;
}

// ---------- licences
function pageLicences(v) {
  title("Licences");
  const today = TODAY(), m = ST.lists.lic;
  let items = ST.lists.certs.map(c => { const d = E.daysTo(c.expiry, today); return Object.assign({ days: d, level: E.licLevel(d, m) }, c); });
  const counts = [0, 0, 0, 0, 0, 0, 0]; items.forEach(i => counts[i.level]++);
  if (licFilter === "urgent") items = items.filter(i => i.level <= 2);
  if (licQuery) { const q = licQuery.toLowerCase(); items = items.filter(i => (i.title + " " + i.category + " " + i.number).toLowerCase().indexOf(q) >= 0); }
  items.sort((a, b) => (a.days === null ? 1e9 : a.days) - (b.days === null ? 1e9 : b.days));
  const COLORS = ["#b91c1c", "#dc2626", "#d97706", "#ca8a04", "#2563eb", "#15803d", "#9ca3af"];
  v.innerHTML = banners() + coSwitch() + `<div class="chips" style="margin-bottom:10px"><span class="chip bad">${counts[0]} expired</span><span class="chip bad">${counts[1]} critical</span><span class="chip warn">${counts[2]} high</span><span class="chip ok">${counts[5]} OK</span></div>
    <div class="seg"><button data-lf="urgent" class="${licFilter === "urgent" ? "on" : ""}">Needs attention</button><button data-lf="all" class="${licFilter === "all" ? "on" : ""}">All (${ST.lists.certs.length})</button></div>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input type="text" id="licQ" placeholder="Search" value="${esc(licQuery)}"></div>` +
    (items.map(i => `<div class="item"><span class="bar" style="background:${COLORS[i.level]}"></span><div class="main"><div class="t">${esc(i.title)}</div>
      <div class="m">${esc(i.category)}${i.number ? " · " + esc(i.number) : ""}</div><div class="m">${i.expiry ? "Expires " + dmy(i.expiry) : "No expiry date"}</div></div>
      <div class="r"><div class="big" style="color:${COLORS[i.level]}">${esc(E.licLeft(i.days))}</div><span class="chip ${i.level <= 1 ? "bad" : i.level === 2 ? "warn" : i.level === 5 ? "ok" : "gray"}">${E.LIC_NAMES[i.level]}</span></div></div>`).join("")
      || `<div class="card empty">${ST.lists.certs.length ? "Nothing needs attention." : "No licences published yet."}</div>`);
}

// Licences | Tenders - the two lists of the Company tab
function coSwitch() {
  coLast = tab === "ten" ? "ten" : "lic";
  const today = TODAY(), m = ST.lists.lic, warn = ST.lists.tm.warnDays || 7;
  const licDue = ST.lists.certs.filter(c => E.licLevel(E.daysTo(c.expiry, today), m) <= 1).length;
  const tenDue = ST.lists.tenders.filter(t => { const st = E.tStatus(t, today), d = E.daysTo(t.closingIso, today); return (st === "progress" || st === "awaiting") && d !== null && d >= 0 && d <= warn; }).length;
  return `<div class="coswitch"><button data-co="lic" class="${tab === "lic" ? "on" : ""}"><svg viewBox="0 0 24 24">${ICON.lic}</svg>Licences${licDue ? `<span class="badge">${licDue}</span>` : ""}</button>
    <button data-co="ten" class="${tab === "ten" ? "on" : ""}"><svg viewBox="0 0 24 24">${ICON.ten}</svg>Tenders${tenDue ? `<span class="badge">${tenDue}</span>` : ""}</button></div>`;
}

// ---------- tenders
function pageTenders(v) {
  title("Tenders");
  const today = TODAY(), warn = ST.lists.tm.warnDays || 7;
  let items = ST.lists.tenders.map(t => Object.assign({ st: E.tStatus(t, today), dc: E.daysTo(t.closingIso, today), why: E.tReason(t, today, warn) }, t));
  const active = items.filter(i => i.st === "progress" || i.st === "awaiting");
  if (tenderFilter === "active") items = active;
  items.sort((a, b) => (a.dc === null ? 1e9 : a.dc) - (b.dc === null ? 1e9 : b.dc));
  const CH = { progress: "violet", awaiting: "blue", missed: "warn", submitted: "ok", declined: "bad", closed: "gray" };
  v.innerHTML = banners() + coSwitch() + `<div class="seg"><button data-tf="active" class="${tenderFilter === "active" ? "on" : ""}">Ongoing (${active.length})</button><button data-tf="all" class="${tenderFilter === "all" ? "on" : ""}">All (${ST.lists.tenders.length})</button></div>` +
    (items.map(t => `<button class="item wrap" data-tender="${esc(t.id)}"><span class="bar" style="background:${t.why ? "#d97706" : t.st === "progress" ? "var(--violet)" : "#cfd2da"}"></span><div class="main">
      <div class="m"><b>${esc(t.no)}</b> · ${esc(t.siteName)}</div><div class="t clamp">${esc(t.title)}</div>
      ${t.why ? `<div class="m" style="color:var(--warn);font-weight:700">${esc(t.why)}</div>` : ""}
</div>
      <div class="r"><div class="big">${t.dc === null ? "—" : t.dc < 0 ? "closed" : t.dc === 0 ? "today" : t.dc + " d"}</div><span class="chip ${CH[t.st]}">${E.T_NAMES[t.st]}</span></div>
      <div class="steps"><span class="${E.accepted(t) ? "done" : ""}">Accepted</span><span class="${t.attended ? "done" : ""}">Briefing</span><span class="${t.purchased ? "done" : ""}">Bought</span><span class="${t.submitted ? "done" : ""}">Submitted</span></div></button>`).join("")
      || `<div class="card empty">${ST.lists.tenders.length ? "No ongoing tenders." : "No tenders published yet."}</div>`);
}
function pageTender(v, id) {
  const t = ST.lists.tenders.find(x => x.id === id);
  title(t ? t.no : "Tender");
  if (!t) { v.innerHTML = `<div class="card empty">Not found.</div>`; return; }
  const today = TODAY(), st = E.tStatus(t, today);
  v.innerHTML = `<div class="card"><div class="m sub">${esc(t.siteName)} · ${esc(t.no)}</div><h2 class="wrap-any" style="margin:6px 0 10px">${esc(t.title)}</h2>
    <div class="kv"><div>Status</div><div>${E.T_NAMES[st]}</div><div>Closing</div><div>${t.closingText ? esc(t.closingText) : dmy(t.closingIso) || "—"}</div>
    <div>Briefing</div><div>${t.briefingIso ? dmy(t.briefingIso) : "—"}</div><div>Location</div><div>${esc(t.location) || "—"}</div><div>Document fee</div><div>${t.docFee ? "RM " + esc(t.docFee) : "—"}</div>
    <div>Decision</div><div>${t.decision === "accepted" ? "Accepted" : t.decision === "declined" ? "Declined" : "Not decided yet"}</div>
    <div>Briefing attended</div><div>${t.attended ? dmy(t.attended) : "—"}</div><div>Documents bought</div><div>${t.purchased ? dmy(t.purchased) : "—"}</div><div>Submitted</div><div>${t.submitted ? dmy(t.submitted) : "—"}</div></div></div>
    ${t.requirement ? `<div class="card"><h2>Who may bid</h2><div class="sub wrap-any" style="color:var(--ink2)">${esc(t.requirement)}</div></div>` : ""}
    ${t.sourceUrl ? `<button class="btn block" data-url="${esc(t.sourceUrl)}">Open on the agency's website</button>` : ""}`;
}

// ---------- approve
function pageApprove(v) {
  title("Approve");
  const KIND = { claim: "OT hours to confirm", pay: "OT pay", til: "Time off", cancel: "Cancel approved leave", training: "Training / event" };
  v.innerHTML = banners() + `<div class="sub" style="margin:0 4px 12px">Accept or decline OT hours, OT pay, time off and leave cancellations. After an approval the admin / HR make the signed copy (signature + chop) for the employee.</div>` +
    `<button class="item" data-act="office"><div class="main"><div class="t">Who's in</div><div class="m">Who is on leave today and this week</div></div><div class="r">›</div></button>` +
    (ST.conf.map((i, n) => i.kind === "training" ? `<div class="item"><span class="bar" style="background:#22c55e"></span><div class="main"><div class="t">${esc(i.name)}</div>
      <div class="m">${esc(i.period)}</div><div class="whochips">${i.trn.names.map(nm => `<span>${esc(nm)}</span>`).join("")}</div>${i.trn.notes ? `<div class="m"><i>${esc(i.trn.notes)}</i></div>` : ""}
      <div style="display:flex;gap:6px;margin-top:8px"><button class="btn sm p" data-tact="approve" data-tid="${esc(i.id)}">Approve</button><button class="btn sm" data-tact="decline" data-tid="${esc(i.id)}">Decline</button></div></div></div>` :
      `<button class="item" data-appr="${n}"><span class="bar" style="background:${i.kind === "til" || i.kind === "cancel" ? "var(--teal)" : "var(--red)"}"></span><div class="main">
      <div class="t">${esc(i.name)}</div><div class="m">${KIND[i.kind]} · ${esc(i.period)}</div>${i.reason ? `<div class="m">“${esc(i.reason)}”</div>` : ""}
      ${i.notes ? `<span class="chip warn" style="margin-top:4px">${plural(i.notes, "note", "notes")}</span>` : ""}</div>
      <div class="r"><div class="big">${i.kind === "pay" ? money(i.amount) : hrs(i.hours) + " h"}</div><div class="m">${dmy(i.at)}</div></div></button>`).join("")
      || `<div class="card empty">Nothing waiting - all done.</div>`);
}
function pageApproveItem(v, it) {
  title(it.name);
  if (!apprItem) { v.innerHTML = `<div class="loading"><span class="spin"></span>Opening…</div>`; return; }
  const o = apprItem.obj, prof = o.profile || {};
  let h = `<div class="card"><div class="kv"><div>Employee</div><div>${esc(prof.name)} · ${esc(apprItem.emp)}</div><div>Position</div><div>${esc([prof.jobTitle, prof.department].filter(Boolean).join(" · ")) || "—"}</div>
    <div>Sent</div><div>${dmy(o.submittedDate || o.submittedAt)}</div><div>Reference</div><div>${esc(short(o.id))} <span class="code">${esc(o.code)}</span></div></div></div>`;
  if ((apprItem.changed || []).length) h += `<div class="banner warn"><b>Employee details updated since this was sent</b> - shown as they are now: ${apprItem.changed.map(esc).join(" · ")}</div>`;
  if ((apprItem.kind === "til" || apprItem.kind === "cancel") && officeAllowed()) {
    const others = othersAway(apprItem.emp, (o.lines || []).map(l => l.date));
    h += others.length ? `<div class="banner info"><b>Also away on these days</b><br>${others.map(esc).join("<br>")}</div>` : `<div class="sub" style="margin:0 2px 10px">Nobody else is away on these days.</div>`;
  }
  let canApprove = true, approveLabel = "Confirm hours";
  if (apprItem.kind === "claim") {
    const view = apprClaimView();
    h += view.c.lines.map((l, i) => `<div class="linecard" data-ai="${i}"><div class="head"><b>${dmy(l.date)} · ${esc(l.start)}–${esc(l.end)}</b><span class="chip blue">${hrs(l.hours)} h</span></div>
      <div class="m sub" style="margin-bottom:8px">${esc(l.remarks)}</div>
      <div class="field"><label>Day type</label><select data-af="dayType">${E.DayTypes.map(t => `<option ${t === apprEdits[i].dayType ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="grid2"><div class="field"><label>Break (hrs)</label><input type="number" data-af="breakHrs" min="0" max="12" step="0.25" inputmode="decimal" value="${apprEdits[i].breakHrs || ""}"></div>
      <div class="field"><label>Worth</label><div style="padding:12px 0;font-weight:800">${money(l.value)}</div></div></div>
      <div class="field"><label>Your note (optional)</label><input type="text" data-af="note" maxlength="120" value="${esc(apprEdits[i].note)}"></div></div>`).join("");
    h += `<div class="card"><div class="row"><div class="grow"><b>${hrs(view.c.totals.hours)} h</b> worth <b>${money(view.c.totals.value)}</b></div></div></div><div class="msgs" id="apprChecks">${msgs(view.errors, view.warnings)}</div>`;
    canApprove = !view.errors.length && (o.schema || 0) >= 2;
  } else if (apprItem.kind === "pay") {
    const view = apprPayView();
    h += `<div class="section">Paid from</div>` + view.p.draws.map(d => `<div class="item"><div class="main"><div class="t">${dmy(d.date)} · ${esc(d.dayType)}</div><div class="m">${hrs(d.hours)} of ${hrs(d.lineHours)} h${d.pending ? " · not confirmed yet" : ""}</div></div><div class="r"><div class="big">${money(d.amount)}</div></div></div>`).join("") +
      `<div class="card"><b>${hrs(o.hours)} h = ${money(view.p.amount)}</b>${o.remarks ? `<div class="sub">“${esc(o.remarks)}”</div>` : ""}</div>` +
      `<div class="msgs">${msgs(view.blockers, [])}</div><div class="sub" style="margin:0 4px 12px">After you approve, the admin / HR make the signed copy for the employee.</div>`;
    canApprove = !view.blockers.length; approveLabel = "Approve";
  } else if (o.category) {
    // leave on the company leave form (annual, sick ...): the days, the balance, the reason and who covers
    const left = E.R2((o.balEntitlement || 0) + (o.balForward || 0) - (o.balTaken || 0) - (o.leaveDays || 0));
    h += `<div class="card"><div class="kv"><div>Leave</div><div><b>${esc(leaveLabel(o.category))}</b></div><div>Dates</div><div>${(o.ranges || []).map(g => esc(rangeLine(g))).join("<br>")}</div>
      <div>Days</div><div><b>${hrs(o.leaveDays)}</b></div>${o.balEntitlement + o.balForward > 0 ? `<div>Balance after</div><div style="color:${left < 0 ? "var(--bad)" : "inherit"}">${hrs(left)} of ${hrs(o.balEntitlement + o.balForward)} days</div>` : ""}
      <div>Reason</div><div>${esc(o.reason) || "—"}</div><div>Covered by</div><div>${esc([o.coverName, o.coverDesignation, o.coverContact].filter(Boolean).join(" · ")) || "—"}</div></div></div>`;
    if (apprItem.kind === "cancel") { h += `<div class="banner warn"><b>Asks to cancel:</b> “${esc(o.cancelReason)}”. If you agree, the ${hrs(o.leaveDays)} day(s) go back to the employee's balance.</div>`; approveLabel = "Agree"; }
    else { h += `<div class="msgs">${msgs([], o.warnings || [])}</div><div class="sub" style="margin:0 4px 12px">After you approve, the admin / HR make the signed copy on the company leave form.</div>`; approveLabel = "Approve"; }
  } else {
    const tilList = o.lines.map(l => `<div class="item"><div class="main"><div class="t">${dmy(l.date)} · ${esc(l.leaveType)}${l.from ? " " + esc(l.from) + "–" + esc(l.to) : ""}</div><div class="m">${l.paidBy === "Unpaid" ? "Unpaid leave " + hrs(l.unpaid) + " h" : hrs(l.hours) + " h from credits"}${l.restFree ? " · " + hrs(l.restFree) + " h rest free" : ""}${l.reason ? " · " + esc(l.reason) : ""}</div></div></div>`).join("");
    if (apprItem.kind === "cancel" || o.status !== "submitted") h += tilList;      // waiting time off: editable lines below
    if (apprItem.kind === "cancel") { h += `<div class="banner warn"><b>Asks to cancel:</b> “${esc(o.cancelReason)}”. If you agree, ${hrs(o.totalHours)} h go back to the employee's credits.</div>`; approveLabel = "Agree"; }
    else {
      const view = apprTilView();
      h += view.a.lines.map((l, i) => `<div class="linecard" data-ti="${i}"><div class="head"><b>${dmy(l.date)} · ${esc(l.leaveType)}${l.from ? " " + esc(l.from) + "–" + esc(l.to) : ""}</b><span class="chip ${l.paidBy === "Unpaid" ? "warn" : "blue"}">${l.paidBy === "Unpaid" ? hrs(l.unpaid) + " h unpaid" : hrs(l.hours) + " h"}</span></div>
        ${l.reason ? `<div class="m sub" style="margin-bottom:8px">${esc(l.reason)}</div>` : ""}
        <div class="seg small" style="margin-bottom:10px"><button data-tpaid="TIL" class="${apprEdits[i].paidBy === "TIL" ? "on til" : ""}">From credits</button><button data-tpaid="Unpaid" class="${apprEdits[i].paidBy === "Unpaid" ? "on" : ""}">Unpaid leave</button></div>
        ${apprEdits[i].paidBy === "TIL" ? `<div class="field"><label>Extra break allowed (hrs, not charged)</label><input type="number" data-tf="extraBreak" min="0" max="12" step="0.25" inputmode="decimal" value="${apprEdits[i].extraBreak || ""}" placeholder="0"></div>` : ""}</div>`).join("");
      h += `<div class="card"><b>${hrs(view.a.totalHours)} h from credits</b>${view.a.unpaidHours ? ` + ${hrs(view.a.unpaidHours)} h unpaid` : ""}<div class="sub">Credits left after: ${hrs(view.a.creditsAfter)} h</div></div>
        <div class="msgs">${msgs(view.blockers, view.warnings)}</div><div class="sub" style="margin:0 4px 12px">After you approve, the admin / HR make the signed copy for the employee.</div>`;
      canApprove = !view.blockers.length; approveLabel = "Approve";
    }
  }
  h += `<div class="field"><label>Remarks to the employee (needed when declining)</label><input type="text" id="apprNote" maxlength="300" placeholder="e.g. checked with the site timesheet" value="${esc(apprNoteText)}"></div>`;
  v.innerHTML = h;
  actionBar(`<button class="btn" data-act="decline" style="flex:1">${apprItem.kind === "cancel" ? "Refuse" : "Decline"}</button>` + (canApprove ? `<button class="btn p" data-act="approve" style="flex:1.3">${approveLabel}</button>` : ""));
}

// ---------- me + reminder settings
function pageMe(v) {
  title("Me");
  let rem = {}; try { rem = JSON.parse(N.reminderSettings() || "{}"); } catch (e) { rem = {}; }
  rem = Object.assign({ on: true, times: ["09:00", "17:00"], confirm: true, mine: true, licences: true, tenders: true, sound: "important" }, rem);
  const allowed = N.notificationsAllowed();
  const p = ST.profile;
  const tog = (k, t, s, show) => show === false ? "" : `<label class="switch"><div class="txt"><b>${t}</b><span>${s}</span></div><span class="tog"><input type="checkbox" data-rem="${k}" ${rem[k] ? "checked" : ""}><i></i></span></label>`;
  const slot = t => `<label class="switch"><div class="txt"><b>${t === "09:00" ? "9:00 am" : t === "17:00" ? "5:00 pm" : t}</b><span>${t === "09:00" ? "Start of the day" : t === "17:00" ? "End of the day" : "Your own time"}</span></div><span class="tog"><input type="checkbox" data-slot="${t}" ${rem.times.indexOf(t) >= 0 ? "checked" : ""}><i></i></span></label>`;
  v.innerHTML = `<div class="card"><h2 class="wrap-any">${esc(p.name || ME.name || ME.email)}</h2><div class="sub wrap-any">${esc(ME.email)}${ME.employeeId ? " · " + esc(ME.employeeId) : ""}${ME.isApprover ? " · approver" : ""}${ME.isAdmin ? " · admin" : ""}</div>
      ${ST.profileSet ? `<div class="kv" style="margin-top:12px"><div>Position</div><div>${esc([p.jobTitle, p.department].filter(Boolean).join(" · ")) || "—"}</div><div>Supervisor</div><div>${esc(p.supervisor) || "—"}</div>
      <div>Working days</div><div>${esc(E.cleanDays(p.normalDays))} · rest day ${esc(p.restDay)}</div><div>Day ends</div><div>${esc(p.shiftEnd)}</div></div>` : ""}</div>
    <div class="section">Reminders</div>
    ${allowed ? "" : `<div class="banner warn">Notifications are switched off for PSL Master. <button class="btn sm" data-act="allowNotes" style="margin-top:8px">Allow notifications</button></div>`}
    <div class="card">${tog("on", "Reminders", "One short summary at the times below - never one notification per item, and nothing when there is nothing to say")}</div>
    <div class="card ${rem.on ? "" : "hidden"}"><h2>When</h2>${slot("09:00")}${slot("17:00")}
      ${rem.times.filter(t => t !== "09:00" && t !== "17:00").map(slot).join("")}
      <div class="row" style="margin-top:10px"><input type="time" id="extraTime" style="flex:1"><button class="btn" data-act="addTime" style="flex:none">Add time</button></div></div>
    <div class="card ${rem.on ? "" : "hidden"}"><h2>What to mention</h2>
      ${tog("confirm", "Waiting for my confirmation", "How many OT hours, OT pay, time off or cancellations wait for you", ME.isApprover)}
      ${tog("mine", "My requests", "When your OT hours, OT pay or time off are decided", !ME.isAdmin)}
      ${tog("licences", "Licences", "How many licences have expired or expire soon")}
      ${tog("tenders", "Tenders", "How many ongoing tenders close soon")}</div>
    <div class="card ${rem.on ? "" : "hidden"}"><h2>Sound</h2>
      <div class="seg small" id="soundSeg" style="margin:8px 0 6px"><button data-sound="important" class="${rem.sound === "important" ? "on" : ""}">Important</button><button data-sound="all" class="${rem.sound === "all" ? "on" : ""}">Always</button><button data-sound="silent" class="${rem.sound === "silent" ? "on" : ""}">Silent</button></div>
      <div class="sub">"Important": a sound when something waits for you or your request was decided; licences and tenders arrive silently.</div>
      <div class="btns"><button class="btn" data-act="testReminder">Show me a test reminder</button></div></div>
    <div class="section">Account</div>
    <div class="card"><div class="sub">Live updates: ${liveOn ? "on" : "connecting…"} · version ${esc(N.version())}</div><div class="btns"><button class="btn" data-act="signOut">Sign out</button></div></div>`;
  remCache = rem;
}
let remCache = null;
function saveRem() { N.setReminderSettings(JSON.stringify(remCache)); toast("Saved"); }

// ===================================================================== taps and typing
document.addEventListener("click", async e => {
  const t = e.target;
  const tb = t.closest("[data-tab]");
  if (tb) { const k = tb.dataset.tab; stack.length = 0; if (k === "cal") { openCalendar(); return; } tab = k === "co" ? coLast : k; render(); window.scrollTo(0, 0); return; }
  const co = t.closest("[data-co]"); if (co) { tab = co.dataset.co; render(); window.scrollTo(0, 0); return; }
  const go = t.closest("[data-go]");
  if (go) { tab = go.dataset.go; if (go.dataset.seg) otSeg = go.dataset.seg; stack.length = 0; render(); window.scrollTo(0, 0); return; }
  if (t.closest("#back")) { window.goBack(); return; }
  if (t.closest("#me")) { stack.length = 0; stack.push({ name: "me" }); render(); window.scrollTo(0, 0); return; }
  const sg = t.closest(".seg [data-seg]");
  if (sg) { otSeg = sg.dataset.seg; render(); return; }
  const lf = t.closest("[data-lf]"); if (lf) { licFilter = lf.dataset.lf; render(); return; }
  const tf = t.closest("[data-tf]"); if (tf) { tenderFilter = tf.dataset.tf; render(); return; }
  const td = t.closest("[data-tender]"); if (td) { stack.push({ name: "tender", args: td.dataset.tender }); render(); window.scrollTo(0, 0); return; }
  const url = t.closest("[data-url]"); if (url) { N.openUrl(url.dataset.url); return; }
  const tp = t.closest("[data-tpaid]");
  if (tp && apprEdits) { apprEdits[+tp.closest(".linecard").dataset.ti].paidBy = tp.dataset.tpaid; render(); return; }
  const ap = t.closest("[data-appr]"); if (ap) { openApproval(ST.conf[+ap.dataset.appr]); window.scrollTo(0, 0); return; }
  const wd = t.closest("[data-withdraw]");
  if (wd) { const col = wd.dataset.withdraw, list = col === "ot_claims" ? ST.db.claims : col === "ot_payouts" ? ST.db.payouts : ST.db.tilApps; withdraw(col, list.find(x => x.id === wd.dataset.id), col === "ot_claims" ? "OT hours withdrawn" : col === "ot_payouts" ? "OT pay request withdrawn" : "time off withdrawn"); return; }
  const cn = t.closest("[data-cancel]"); if (cn) { askCancel(ST.db.tilApps.find(x => x.id === cn.dataset.cancel)); return; }
  const del = t.closest("[data-del]");
  if (del) {
    const top = stack[stack.length - 1];
    if (top && top.name === "claimEdit") { ST.drafts.claim.lines.splice(+del.dataset.del, 1); if (!ST.drafts.claim.lines.length) ST.drafts.claim = null; save(); if (!ST.drafts.claim) { stack.pop(); } render(); }
    if (top && top.name === "tilEdit") { ST.drafts.til.lines.splice(+del.dataset.del, 1); if (!ST.drafts.til.lines.length) ST.drafts.til = null; save(); if (!ST.drafts.til) { stack.pop(); } render(); }
    return;
  }
  const tk = t.closest("[data-tkind]"); if (tk && trnDraft) { trnDraft.kind = tk.dataset.tkind; render(); return; }
  const ta = t.closest("[data-tact]"); if (ta) { trainingAct(ta.dataset.tid, ta.dataset.tact); return; }
  const te = t.closest("[data-tedit]");
  if (te) { const x = ((ST.cal || {}).trainings || []).find(y => y.id === te.dataset.tedit); if (x) { trnDraft = clone(x); trnDraft.people = x.people.map(p => String(p).toUpperCase());
      trnDraft.early = {}; (x.early || []).forEach(e => { const i = e.indexOf("="); if (i > 0) trnDraft.early[e.slice(0, i)] = parseEarly(e.slice(i + 1), x.from); }); staffQ = ""; stack.push({ name: "trnEdit" }); render(); window.scrollTo(0, 0); loadStaff().then(() => render()).catch(() => { }); } return; }
  const lh = t.closest("[data-lhalf]");
  if (lh && ST.drafts.leave) { const g = ST.drafts.leave.ranges[+lh.closest("[data-ri]").dataset.ri]; g.half = lh.dataset.lhalf; save(); render(); return; }
  const rdl = t.closest("[data-rdel]");
  if (rdl && ST.drafts.leave) { ST.drafts.leave.ranges.splice(+rdl.dataset.rdel, 1); save(); render(); return; }
  const ra = t.closest("[data-raud]");
  if (ra && remDraft) { remDraft.audience = ra.dataset.raud; render(); if (remDraft.audience === "people" && !peopleList) loadPeople().then(() => render()).catch(e => tell("Could not read the staff list", e.message)); return; }
  const er = t.closest("[data-editrem]");
  if (er) { const x = ((ST.cal || {}).reminders || []).find(r => r.id === er.dataset.editrem); if (x) { remDraft = clone(x); peopleQ = ""; stack.push({ name: "remEdit" }); render(); window.scrollTo(0, 0); if (x.audience === "people") loadPeople().then(() => render()).catch(() => { }); } return; }
  const dr = t.closest("[data-delrem]"); if (dr) { deleteReminder(dr.dataset.delrem); return; }
  const rv = t.closest("#rgPaid button");
  if (rv && !rv.disabled) { tilRange.paidBy = rv.dataset.rv; $$("#rgPaid button").forEach(b => b.className = b === rv ? (rv.dataset.rv === "TIL" ? "on til" : "on") : ""); rangeInfo(); return; }
  const pb = t.closest('[data-f="paidBy"] button');
  if (pb && !pb.disabled) { const i = +pb.closest(".linecard").dataset.i; ST.drafts.til.lines[i].paidBy = pb.dataset.v; save(); render(); return; }
  const snd = t.closest("[data-sound]"); if (snd) { remCache.sound = snd.dataset.sound; saveRem(); render(); return; }
  const act = t.closest("[data-act]"); if (!act) return;
  const a = act.dataset.act;
  if (a === "claimEdit" || a === "payEdit" || a === "tilEdit" || a === "leaveEdit") {
    const no = notAllowed(); if (no) return tell("Not available", no);
    if (a === "payEdit" && !payAllowed()) return tell("Not available", "Your contract does not include OT pay - use your credits as time in lieu.");
    stack.push({ name: a }); render(); window.scrollTo(0, 0); return;
  }
  if (a === "addLine") { const L = ST.drafts.claim.lines; if (L.length >= E.MaxClaimLines) return toast("One record holds " + E.MaxClaimLines + " lines - send it and start another"); L.push(blankLine(L[L.length - 1])); save(); render(); return; }
  if (a === "addLeave") { if (ST.drafts.til.lines.length >= E.MaxLeaveDays) return toast("One application has room for " + E.MaxLeaveDays + " days"); ST.drafts.til.lines.push(blankLeave()); save(); render(); return; }
  if (a === "addRange") {
    const d = ST.drafts.til, from = tilRange.from, to = tilRange.to || tilRange.from;
    if (!E.day(from) || !E.day(to)) return toast("Choose the first and last day");
    if (to < from) return toast("The last day is before the first day");
    const have = new Set(d.lines.map(l => l.date)), days = rangeDays().filter(x => !have.has(x) && !rangePh(x));
    if (!days.length) return toast("No new working days in these dates");
    d.lines = d.lines.filter(l => l.date);                         // an empty "Day 1" goes
    if (d.lines.length + days.length > E.MaxLeaveDays) return toast("One application has room for " + E.MaxLeaveDays + " days - choose fewer");
    days.forEach(x => d.lines.push(Object.assign(blankLeave(), { date: x, leaveType: "Full Day", paidBy: tilRange.paidBy === "Unpaid" || !tilAllowed() ? "Unpaid" : "TIL" })));
    d.lines.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    tilRange = { from: "", to: "", paidBy: tilRange.paidBy, ph: {} };
    save(); keepScroll(render); toast(plural(days.length, "day", "days") + " added"); return;
  }
  if (a === "payAll") { const L = ledger(); ST.drafts.pay.hours = E.R2(L.lots.filter(l => l.approved && l.remaining > 0).slice(0, E.MaxClaimLines).reduce((s, l) => s + l.remaining, 0)); save(); render(); return; }
  if (a === "sendClaim") { if (await sheet("Send these OT hours?", "Once the approver confirms them they become credits for OT pay or time off.", [{ label: "Back" }, { label: "Send", cls: "p", value: true }])) submitClaim(); return; }
  if (a === "sendPay") { const p = ST.drafts.pay; if (await sheet("Send this OT pay request?", `<b>${hrs(p.hours)} h = ${money(p.amount)}</b> from your oldest credits.`, [{ label: "Back" }, { label: "Send", cls: "p", value: true }])) submitPay(); return; }
  if (a === "addRange") { if (ST.drafts.leave.ranges.length < E.MaxRanges) { ST.drafts.leave.ranges.push(blankRange()); save(); render(); } return; }
  if (a === "sendLeave") { const l = ST.drafts.leave; if (await sheet("Send this leave application?", `<b>${esc(leaveLabel(l.category))}</b> · ${hrs(l.leaveDays)} ${l.leaveDays === 1 ? "day" : "days"}<br>It goes to an approver.`, [{ label: "Back" }, { label: "Send", cls: "p", value: true }])) submitLeave(); return; }
  if (a === "newRem") { remDraft = { id: "", title: "", date: calSel || TODAY_ISO(), time: "", note: "", audience: "me", to: [] }; peopleQ = ""; stack.push({ name: "remEdit" }); render(); window.scrollTo(0, 0); return; }
  if (a === "saveRem") { saveReminder(); return; }
  if (a === "newTrn") { const d0 = calSel || TODAY_ISO(); trnDraft = { id: "", title: "", kind: "Training", from: d0, to: d0, start: "", end: "", place: "", notes: "", people: ME.employeeId ? [ME.employeeId.toUpperCase()] : [], early: {} }; staffQ = "";
    stack.push({ name: "trnEdit" }); render(); window.scrollTo(0, 0); loadStaff().then(() => render()).catch(e => tell("Could not read the staff list", e.message)); return; }
  if (a === "saveTrn") { saveTraining(); return; }
  if (a === "offClear") { officeQ = ""; render(); return; }
  if (a === "delRem") { deleteReminder(remDraft.id); return; }
  if (a === "sendTil") { if (await sheet("Send this time-off application?", "It goes to an approver.", [{ label: "Back" }, { label: "Send", cls: "p", value: true }])) submitTil(); return; }
  if (a === "approve" || a === "decline") { decide(a); return; }
  if (a === "calendar") { stack.length = 0; openCalendar(); return; }
  if (a === "calPrev" || a === "calNext" || a === "calToday") {
    if (a === "calToday") { calMonth = TODAY_ISO().substr(0, 7); calSel = TODAY_ISO(); }
    else { const d = new Date(Date.UTC(+calMonth.substr(0, 4), +calMonth.substr(5, 2) - 1 + (a === "calPrev" ? -1 : 1), 1)); calMonth = E.iso(d).substr(0, 7); calSel = ""; }
    render(); return;
  }
  if (a === "calDay") { calSel = act.dataset.d; render(); return; }
  if (a === "office") { officeDate = TODAY_ISO(); stack.push({ name: "office" }); render(); window.scrollTo(0, 0); if (!DEMO) (officeAllowed() ? refreshOffice(false) : refreshBoard()).then(() => render()).catch(() => { }); return; }
  if (a === "offPrev" || a === "offNext" || a === "offToday") { officeDate = a === "offToday" ? TODAY_ISO() : E.iso(E.addDays(E.day(officeDate), a === "offPrev" ? -1 : 1)); render(); return; }
  const of = act.dataset.of; if (a === "offShow") { officeShow = officeShow === of ? "" : of; render(); return; }
  if (a === "allowNotes") { N.askNotifications(); return; }
  if (a === "testReminder") { if (!N.notificationsAllowed()) { N.askNotifications(); return; } N.testReminder(); toast("A test reminder appears in a moment"); return; }
  if (a === "addTime") { const v = ($("#extraTime") || {}).value; if (!v) return toast("Choose a time first"); if (remCache.times.indexOf(v) < 0 && remCache.times.length < 6) remCache.times.push(v); remCache.times.sort(); saveRem(); render(); return; }
  if (a === "signOut") { if (await sheet("Sign out?", "Reminders stop until you sign in again.", [{ label: "Cancel" }, { label: "Sign out", cls: "p", value: true }])) { N.signOut(); signedOut(); } return; }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.rem) { remCache[t.dataset.rem] = t.checked; saveRem(); if (t.dataset.rem === "on") render(); return; }
  if (t.dataset.ph) { tilRange.ph[t.dataset.ph] = t.checked; rangeInfo(); return; }
  if (t.dataset.slot) { const s = t.dataset.slot; remCache.times = remCache.times.filter(x => x !== s); if (t.checked) remCache.times.push(s); remCache.times.sort(); saveRem(); if (!t.checked && s !== "09:00" && s !== "17:00") render(); return; }
  if (t.dataset.af === "dayType") { apprEdits[+t.closest(".linecard").dataset.ai].dayType = t.value; render(); return; }
  if (t.dataset.tf === "extraBreak") { apprEdits[+t.closest(".linecard").dataset.ti].extraBreak = parseFloat(t.value) || 0; render(); return; }
  if (t.dataset.lv && ST.drafts.leave && ["category", "from", "to"].indexOf(t.dataset.lv) >= 0) {
    const a = ST.drafts.leave, k = t.dataset.lv, card = t.closest("[data-ri]");
    if (card) { const g = a.ranges[+card.dataset.ri]; g[k] = t.value; if (k === "from" && (!g.to || g.to < g.from)) g.to = g.from; if (g.to !== g.from) g.half = ""; }
    else a[k] = t.value;
    save(); render(); return;
  }
  if (t.dataset.tp && trnDraft) { const id = t.dataset.tp; trnDraft.people = trnDraft.people.filter(x => x !== id); if (t.checked) trnDraft.people.push(id); else delete (trnDraft.early || {})[id]; keepScroll(render); return; }
  if (t.dataset.te && trnDraft) { trnDraft.early = trnDraft.early || {}; if (t.checked) trnDraft.early[t.dataset.te] = trnDraft.early[t.dataset.te] || { d: trnDraft.from === (trnDraft.to || trnDraft.from) ? trnDraft.from : "", t: "" }; else delete trnDraft.early[t.dataset.te]; keepScroll(render); return; }
  if (t.dataset.tt && trnDraft) { trnDraft.early = trnDraft.early || {}; (trnDraft.early[t.dataset.tt] = trnDraft.early[t.dataset.tt] || { d: "", t: "" }).t = t.value; return; }
  if (t.dataset.td && trnDraft) { trnDraft.early = trnDraft.early || {}; (trnDraft.early[t.dataset.td] = trnDraft.early[t.dataset.td] || { d: "", t: "" }).d = t.value; return; }
  if (t.dataset.tn && trnDraft && (t.dataset.tn === "from" || t.dataset.tn === "to")) { trnDraft[t.dataset.tn] = t.value; if (t.dataset.tn === "from" && (!trnDraft.to || trnDraft.to < t.value)) trnDraft.to = t.value; render(); return; }
  if (t.dataset.pe && remDraft) { const em = t.dataset.pe; remDraft.to = remDraft.to.filter(x => x !== em); if (t.checked) remDraft.to.push(em); render(); return; }
  if (t.dataset.f === "leaveType") { const card = t.closest(".linecard"), l = ST.drafts.til.lines[+card.dataset.i]; l.leaveType = t.value; if (t.value !== "Hours") { l.from = l.to = ""; } save(); render(); return; }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "licQ") { licQuery = t.value; const pos = t.selectionStart; render(); const q = $("#licQ"); q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* fine */ } return; }
  if (t.id === "payHours") { ST.drafts.pay.hours = E.R2(Math.max(0, parseFloat(t.value) || 0)); save(); payCalc(); return; }
  if (t.id === "payRemarks") { ST.drafts.pay.remarks = t.value.slice(0, 200); save(); return; }
  if (t.id === "apprNote") { apprNoteText = t.value; return; }
  if (t.id === "rgFrom" || t.id === "rgTo") {
    tilRange[t.id === "rgFrom" ? "from" : "to"] = t.value;
    if (t.id === "rgFrom") { const to = $("#rgTo"); if (to) { to.min = t.value; if (!tilRange.to || tilRange.to < t.value) { tilRange.to = t.value; to.value = t.value; } } }
    rangeInfo(); return;
  }
  if (t.dataset.rf && remDraft) { remDraft[t.dataset.rf] = t.value; return; }
  if (t.dataset.tn && trnDraft) { trnDraft[t.dataset.tn] = t.value; return; }
  if (t.id === "stfQ") { staffQ = t.value; const pos = t.selectionStart; render(); const q = $("#stfQ"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } return; }
  if (t.id === "offQ") { officeQ = t.value; const pos = t.selectionStart; render(); const q = $("#offQ"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } return; }
  if (t.id === "pplQ") { peopleQ = t.value; const pos = t.selectionStart; render(); const q = $("#pplQ"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* fine */ } } return; }
  if (t.dataset.lv && ST.drafts.leave && ["reason", "coverName", "coverDesignation", "coverContact"].indexOf(t.dataset.lv) >= 0) { ST.drafts.leave[t.dataset.lv] = t.value; save(); leaveCalc(); return; }
  if (t.dataset.af) {
    const i = +t.closest(".linecard").dataset.ai;
    apprEdits[i][t.dataset.af] = t.dataset.af === "breakHrs" ? (parseFloat(t.value) || 0) : t.value;
    const view = apprClaimView(); const box = $("#apprChecks"); if (box) box.innerHTML = msgs(view.errors, view.warnings);
    return;
  }
  const card = t.closest(".linecard"); if (!card || !t.dataset.f) return;
  const top = stack[stack.length - 1]; if (!top) return;
  if (top.name === "claimEdit") { ST.drafts.claim.lines[+card.dataset.i][t.dataset.f] = t.value; save(); claimCalc(); }
  if (top.name === "tilEdit") { ST.drafts.til.lines[+card.dataset.i][t.dataset.f] = t.value; save(); tilCalc(); }
});

// the phone's Back button
window.goBack = () => {
  const veil = $(".veil"); if (veil) { veil.remove(); return true; }
  if (stack.length) { stack.pop(); render(); window.scrollTo(0, 0); return true; }
  if (tab !== "home") { tab = "home"; render(); return true; }
  return false;
};
// the Calendar tab: this month, today chosen, fresh from the database
function openCalendar() {
  tab = "cal"; calMonth = TODAY_ISO().substr(0, 7); calSel = TODAY_ISO(); render(); window.scrollTo(0, 0);
  if (!DEMO) refreshCal(true).then(() => officeAllowed() ? refreshOffice(false) : null).then(() => { if (tab === "cal" && !stack.length) render(); }).catch(() => { });
}
window.goTo = g => { stack.length = 0; if (g === "calendar") { openCalendar(); return; } tab = g === "approve" ? (ME && ME.isApprover ? "appr" : "home") : g === "overtime" ? "ot" : g === "licences" ? "lic" : g === "tenders" ? "ten" : "home"; render(); };
window.onPermission = () => { const top = stack[stack.length - 1]; if (top && top.name === "me") render(); };

// ===================================================================== signing in / starting
function signedOut() {
  ME = null; N.liveStop();
  $("#app").classList.add("hidden");
  renderLogin("");
}
function renderLogin(err, waiting) {
  const v = $("#login"); v.classList.remove("hidden");
  v.innerHTML = `<div class="login"><div class="logo"><img src="logo.png" alt="PSL"></div><h1>PSL Master</h1>
    <p>Overtime credits, licences and tenders - for the whole company.</p>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    ${waiting ? `<button class="gbtn" disabled><span class="spin"></span> Finish signing in in the browser…</button><button class="btn ghost block" style="color:#d2d3db;margin-top:10px" id="cancelSign">Cancel</button>`
      : `<button class="gbtn" id="signIn"><svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</button>`}
    <div class="note">Use your company Google account (@psetialestari.com), or the account the administrator added for you.</div></div>`;
}
document.addEventListener("click", e => {
  if (e.target.closest("#signIn")) { renderLogin("", true); N.signIn(); }
  if (e.target.closest("#cancelSign")) { N.cancelSignIn(); renderLogin(""); }
});
window.__auth = json => {
  let s = {}; try { s = JSON.parse(json); } catch (e) { s = {}; }
  if (!s.signedIn) { renderLogin(s.error || "Not signed in."); return; }
  start(s);
};

async function start(s) {
  ME = { email: s.email, name: s.name, employeeId: (s.employeeId || "").toUpperCase(), isAdmin: !!s.isAdmin, isApprover: false, isHr: false };
  loadState();
  ME.isApprover = ST.isApprover; ME.isHr = ST.isHr;
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  if (DEMO) demoSeed();
  render();
  N.liveStart();
  if (!DEMO) fs.commit([eventWrite(ME.isAdmin ? "" : ME.employeeId || "", "signed in", "", auditRole())]).catch(() => { });       // the trail: who used the app, when, on which phone
  if (!DEMO) { const l = $("#view"); if (!ST.lastMine) l.insertAdjacentHTML("afterbegin", `<div class="loading" id="firstLoad"><span class="spin"></span>Getting your records…</div>`); }
  await syncAll(!ST.lastMine);
  if (!N.notificationsAllowed() && !localStorage.getItem("psl.askedNotes")) { localStorage.setItem("psl.askedNotes", "1"); N.askNotifications(); }
}

window.onPhoneResume = g => {
  if (!ME) return;
  N.liveStart();
  if (g) window.goTo(g);
  if (Date.now() - lastSync > 30e3) syncAll(false).catch(() => { });      // back on screen: catch up with what changed meanwhile
};
let lastSync = 0;
// while the app stays open: a quiet check every 10 minutes too (a missed bell, a new day)
setInterval(() => { if (ME && !document.hidden && Date.now() - lastSync > 9 * 60e3) syncAll(false).catch(() => { }); }, 60e3);

(function boot() {
  document.documentElement.setAttribute("data-ready", "1");     // tells the phone the code started (else it shows the problem)
  let s = {}; try { s = JSON.parse(N.session() || "{}"); } catch (e) { s = {}; }
  if (s.signedIn) start(s); else renderLogin("");
  // browser preview only: index.html#ot/pay, #me, #appr/0, #ten/t2 open that page
  if (DEMO && location.hash) {
    const [t, x] = location.hash.slice(1).split("/");
    if (t === "me") stack.push({ name: "me" });
    else if (t === "appr" && x) { tab = "appr"; openApproval(ST.conf[+x]); return; }
    else if (t === "ten" && x) { tab = "ten"; stack.push({ name: "tender", args: x }); }
    else if (/^(claimEdit|payEdit|tilEdit)$/.test(t)) { tab = "ot"; stack.push({ name: t }); }
    else { tab = t; if (x) otSeg = x; }
    render();
  }
})();

// ===================================================================== the pretend database (browser only)
function demoSeed() {
  const today = TODAY(), d = n => E.iso(E.addDays(today, n));
  ST.profile = Object.assign(clone(PROFILE), { name: "Dewi Supang Robin (sample)", staffId: "PSL14", jobTitle: "Site Manager", department: "Kuching office", supervisor: "Director", basicSalary: 3200 });
  ST.profileSet = true; ST.active = true; ST.isApprover = true; ME.isApprover = true; ST.policy = { tilForCovered: true, restFree: 1, restAfter: 4 };
  const mk = (id, status, lines, decided) => { const c = Object.assign(newClaimDraft(), { id, status, submittedAt: d(-9) + "T10:00:00", submittedDate: d(-9), decidedAt: decided ? d(-7) + "T09:00:00" : "", code: "AB12-CD34" });
    c.lines = lines.map(x => Object.assign(blankLine(null), { date: x[0], start: x[1], end: x[2], remarks: x[3] })); refreshClaim(c); return c; };
  ST.db.claims = [mk("OT-PSL14-20260920-1", "approved", [[d(-20), "17:30", "20:30", "Concrete pour"], [d(-19), "08:00", "13:00", "Material delivery"], [d(-18), "08:00", "12:00", "Scaffold check"]], true),
    mk("OT-PSL14-20261003-1", "submitted", [[d(-3), "17:30", "19:00", "Rebar delivery"]], false)];
  const pay = Object.assign(blankCommon(), { schema: 2, id: "PAY-PSL14-20260925-1", status: "approved", submittedAt: d(-8) + "T11:00:00", submittedDate: d(-8), decidedAt: d(-6) + "T09:00:00", profile: clone(ST.profile), rates: rates(), hours: 3, remarks: "", draws: [], amount: 0, code: "EF56-GH78" });
  const led = E.build({ claims: ST.db.claims, tilApps: [], payouts: [], adjusts: [] }, Object.assign(clone(pay), { status: "draft" }), today, rates(), true);
  pay.draws = led.byRef[pay.id].draws; pay.amount = led.byRef[pay.id].amount; ST.db.payouts = [pay];
  ST.lists.lic = { criticalDays: 30, highDays: 60, mediumDays: 90, lowDays: 180, last: "x" };
  ST.lists.certs = [["PSL Trade License - Event Management", "Trade License", "TL 1194455", 4], ["CIDB Registration (PPK) G7", "CIDB & NIOSH Certs", "0120191029-SR034484", 1200], ["UPKJ Registration - Works", "UPKJ", "UPKJ/W/023872", 765],
    ["MOF Registration", "MOF", "MOF-2209912", 158], ["PETRONAS Licence", "PETRONAS", "PC-77120", 26], ["Public Liability Insurance", "Insurance", "PLI-8841", -9], ["Workmen's Compensation", "Insurance", "WC-3312", 55], ["Training Provider Licence", "Other", "", null]]
    .map((x, i) => ({ id: "c" + i, title: x[0], category: x[1], number: x[2], note: "", expiry: x[3] === null ? "" : d(x[3]), updatedAt: "" }));
  ST.lists.tm = { warnDays: 7, last: "x" };
  ST.lists.tenders = [["JKR", "T/435/08/2026", "Daif Sarawak (2024) - Pembinaan Semula Bangunan Daif dan Menaik Taraf Kapasiti Penyaluran Bekalan Air Di Sekolah Menengah Kebangsaan Ulu Balingian", 2, "accepted", d(-3), d(-2), ""],
    ["DID", "DID/TN/04-09/2026", "UPGRADING AND IMPROVEMENT WORKS TO EARTH BUND AT SKIM KABONG NYABOR, KABONG, BETONG DIVISION.", 16, "accepted", TODAY_ISO(), "", ""],
    ["JKR", "T/472/09/2026", "Retender : Pembangunan Balai Bomba dan Kuarters Sungai Asap, Belaga, Sarawak", 28, "", "", "", ""],
    ["UNIMAS", "UNIMAS/SH/PP/58/2026", "NAIKTARAF LANGSIR DI ARENA GEMILANG, UNIVERSITI MALAYSIA SARAWAK (UNIMAS), KOTA SAMARAHAN", 9, "", "", "", ""],
    ["DID", "DID/TN/D/173-09/2026", "PERKHIDMATAN KAWALAN KESELAMATAN (TANPA SENJATA) UNTUK TUJUH (7) STESEN PAM DI BANDAR SIBU", 14, "declined", "", "", ""]]
    .map((x, i) => ({ id: "t" + i, site: x[0], siteName: x[0] + " Sarawak", no: x[1], title: x[2], location: "KUCHING", kind: "Work", closingIso: d(x[3]), closingText: "", briefingIso: i === 2 ? d(2) : "",
      requirement: "UPKJ | Class: A | Head: I | and | CIDB (PPK) | Grade: G1 or above", docFee: "268.00", sourceUrl: "https://example.org", eligible: true, listed: true, decision: x[4], attended: x[5], purchased: x[6], submitted: x[7], updatedAt: "" }));
  ST.conf = [{ kind: "claim", id: "OT-PSL12-20261005-1", emp: "PSL12", name: "Ahmad bin Ali (sample)", at: d(-1) + "T18:00:00", hours: 6.5, amount: 119.12, period: dmy(d(-2)) + ", " + dmy(d(-1)), notes: 1 },
    { kind: "pay", id: "PAY-PSL12-20261005-1", emp: "PSL12", name: "Ahmad bin Ali (sample)", at: d(-1) + "T18:05:00", hours: 3, amount: 54.98, period: "OT pay from credits", notes: 0 },
    { kind: "til", id: "TIL-PSL12-20261006-1", emp: "PSL12", name: "Ahmad bin Ali (sample)", at: d(0) + "T07:45:00", hours: 8.5, period: dmy(d(7)), notes: 0 },
    { kind: "cancel", id: "TIL-PSL13-20260930-1", emp: "PSL13", name: "Siti binti Rahman (sample)", at: d(0) + "T08:10:00", hours: 8.5, period: dmy(d(5)), reason: "Site visit moved", notes: 0 }];
  ST.cal = { at: Date.now(), dates: [{ id: "D1", title: "Safety audit (JKR site)", date: d(6), end: d(7), note: "" }, { id: "D2", title: "Tender T/435 closes", date: d(2), end: d(2), note: "Submit by 12 noon" },
    { id: "D3", title: "Monthly meeting", date: d(-5), end: d(-5), note: "" }],
    trainings: [{ id: "TRN-1", title: "TedTalk", kind: "Event", from: d(1), to: d(1), start: "14:00", end: "16:00", place: "Hilton Kuching", notes: "", people: ["PSL12", "PSL14"], names: ["Ahmad bin Ali", "Dewi Supang Robin"],
      status: "approved", by: "admin@psetialestari.com", byName: "Admin", decidedByName: "Admin", decisionNote: "", createdAt: "" },
      { id: "TRN-2", title: "First aid course", kind: "Training", from: d(3), to: d(4), start: "09:00", end: "17:00", place: "Red Crescent", notes: "Bring IC", people: ["PSL15"], names: ["Jason Lim"],
      status: "submitted", by: "siti.sample@gmail.com", byName: "Siti binti Rahman", decidedByName: "", decisionNote: "", createdAt: "" }] };
  ST.office = { full: Date.now(), pulled: E.nowStamp(),
    people: { PSL12: { name: "Ahmad bin Ali (sample)", position: "Site Supervisor", department: "Kuching project site", status: "active" },
      PSL13: { name: "Siti binti Rahman (sample)", position: "Clerk", department: "Kuching office", status: "active" },
      PSL14: { name: "Dewi Supang Robin (sample)", position: "Site Manager", department: "Kuching office", status: "active" },
      PSL15: { name: "Jason Lim (sample)", position: "Driver", department: "Kuching office", status: "active" } },
    pay: { PSL12: { normalDays: "Mon – Sat", restDay: "Sunday" } },
    leave: { L1: { emp: "PSL13", status: "approved", by: "Dewi Supang Robin", lines: [{ date: d(0), leaveType: "Full Day", from: "", to: "", paidBy: "TIL", reason: "Family wedding in Sibu" }, { date: d(1), leaveType: "Full Day", from: "", to: "", paidBy: "TIL", reason: "" }] },
      L2: { emp: "PSL12", status: "approved", by: "Dewi Supang Robin", lines: [{ date: d(0), leaveType: "Hours", from: "14:00", to: "17:30", paidBy: "TIL", reason: "Collect documents at JKR" }] },
      L3: { emp: "PSL15", status: "submitted", by: "", lines: [{ date: d(2), leaveType: "Half Day (AM)", from: "", to: "", paidBy: "Unpaid", reason: "Clinic" }] },
      L4: { emp: "PSL15", status: "approved", by: "Dewi Supang Robin", lines: [{ date: d(7), leaveType: "Full Day", from: "", to: "", paidBy: "TIL", reason: "" }] } } };
  ST.lastMine = ST.lastLists = Date.now();
}
function demoApprItem(it) {
  const prof = Object.assign(clone(PROFILE), { name: it.name, staffId: it.emp, jobTitle: "Site Supervisor", department: "Kuching project site", basicSalary: 2700, location: "Sarawak" });
  const today = TODAY(), d = n => E.iso(E.addDays(today, n));
  const line = (date, start, end, remarks) => { const l = Object.assign(blankLine(null), { date, start, end, remarks }); l.dayType = E.expectedDayType(prof, E.day(date)); return l; };
  // the employee's earlier, confirmed overtime: the credits the requests below use
  const done = Object.assign(newClaimDraft(), { id: "OT-" + it.emp + "-20260915-1", status: "approved", profile: prof, rates: E.rates(prof.location), submittedAt: d(-20) + "T18:00:00", submittedDate: d(-20), decidedAt: d(-19) + "T09:00:00", code: "0A0B-0C0D" });
  done.lines = [line(d(-22), "17:30", "21:30", "Slab pour"), line(d(-21), "17:30", "22:00", "Formwork"), line(d(-20), "17:30", "20:30", "Rebar check")];
  E.compute(done);
  const db = { claims: [done], tilApps: [], payouts: [], adjusts: [] };
  let obj;
  if (it.kind === "claim") {
    obj = Object.assign(newClaimDraft(), { id: it.id, status: "submitted", profile: prof, rates: E.rates(prof.location), submittedAt: d(-1) + "T18:00:00", submittedDate: d(-1), code: "1A2B-3C4D" });
    obj.lines = [line(d(-2), "17:30", "20:30", "Concrete pour - slab level 2"), line(d(-1), "17:30", "21:00", "Formwork inspection")];
    E.compute(obj); db.claims.push(obj);
  } else if (it.kind === "pay") {
    obj = Object.assign(blankCommon(), { schema: 2, id: it.id, status: "submitted", profile: prof, rates: E.rates(prof.location), hours: 3, amount: 0, remarks: "", code: "5E6F-7A8B", submittedAt: d(-1) + "T18:05:00", submittedDate: d(-1), draws: [] });
    db.payouts.push(obj);
  } else {
    obj = Object.assign(blankCommon(), { schema: 2, id: it.id, status: it.kind === "til" ? "submitted" : "cancel_requested", profile: prof, code: "9C0D-1E2F", submittedAt: d(-6) + "T08:00:00", submittedDate: d(-6),
      cancelReason: it.reason || "", totalHours: 0, unpaidHours: 0, draws: [], lines: [{ date: d(7), leaveType: "Full Day", from: "", to: "", paidBy: "TIL", hours: 0, unpaid: 0, restFree: 0, extraBreak: 0, reason: "Family" }] });
    E.computeLeave(obj, ST.policy);
    if (it.kind === "cancel") obj.status = "cancel_requested";
    db.tilApps.push(obj);
  }
  return { kind: it.kind, emp: it.emp, obj, db, prof, pol: ST.policy };
}
