"use strict";
/* PSL Master (phone) - the overtime CREDIT engine, a line-by-line port of PSLMaster\src\ot\Calc.cs (and the licence / tender
   rules of PSLMaster\src\Model.cs). Same rules, same wording, same document shapes as the PC app, so a record made on the
   phone is exactly what the PC expects. Nothing here talks to the network. */

const E = (() => {
  const MaxClaimLines = 15, MaxLeaveLines = 6, MaxLeaveDays = 31;      // 6 rows on the time-off form - a run of full days is one row
  const HalfDayAm = 4, HalfDayPm = 4.5;
  const DayTypes = ["Normal Working Day", "Off Day", "Rest Day", "Public Holiday"];
  const LeaveTypes = ["Full Day", "Half Day (AM)", "Half Day (PM)", "Hours"];
  const S = { Draft: "draft", Submitted: "submitted", Approved: "approved", Declined: "declined", Withdrawn: "withdrawn", CancelRequested: "cancel_requested", Cancelled: "cancelled" };
  const active = s => s === S.Submitted || s === S.Approved || s === S.CancelRequested;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // the template's "Rates & Rules" (Sarawak and Peninsular columns are the same in the company template)
  function rates(location) {
    return { divisor: 26, normalDayOt: 1.5, restHalfMonthly: 0.5, restFullMonthly: 1, restHalfDaily: 1, restFullDaily: 2, restBeyond: 2, phDays: 2, phBeyond: 3,
      monthlyCap: 104, wageThreshold: 4000, weeklyHours: 45, tilBasis: "Hour-for-hour", tilValidityDays: 90, tilUnused: "Paid out at OT rates",
      region: location === "Peninsular Malaysia" ? "Peninsular Malaysia" : "Sarawak" };
  }

  // Math.Round(x, 2, MidpointRounding.AwayFromZero)
  const R2 = x => { const s = x < 0 ? -1 : 1; return s * Math.round(Math.abs(x) * 100 + 1e-9) / 100; };
  const Num = x => { const v = R2(x); return String(v); };

  // ---- dates (all as plain calendar days, no time zones)
  function day(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 ? d : null;
  }
  const iso = d => d.toISOString().substr(0, 10);
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const show = d => iso(d).substr(8, 2) + "/" + iso(d).substr(5, 2) + "/" + iso(d).substr(0, 4);
  const showDate = s => { const d = day(s); return d ? show(d) : (s || ""); };
  const showMonth = m => { const d = day((m || "") + "-01"); return d ? MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() : m; };
  const ddd = d => DAYNAMES[d.getUTCDay()].substr(0, 3);
  const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 86400000);
  function time(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); if (!m || +m[1] > 23 || +m[2] > 59) return null; return +m[1] * 60 + +m[2]; }
  const hm = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  function todayLocal() { const n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); }
  function nowStamp() {                     // Store.Now(): local "yyyy-MM-ddTHH:mm:ss"
    const n = new Date(), p = x => String(x).padStart(2, "0");
    return n.getFullYear() + "-" + p(n.getMonth() + 1) + "-" + p(n.getDate()) + "T" + p(n.getHours()) + ":" + p(n.getMinutes()) + ":" + p(n.getSeconds());
  }
  const day10 = s => (s || "").length >= 10 ? s.substr(0, 10) : "";

  // ---- rates of pay
  function payOf(p, r) {
    const x = {};
    x.monthly = p.wageBasis !== "Daily-rated";
    x.nh = p.normalHours > 0 ? p.normalHours : 8;
    x.orp = p.basicSalary <= 0 ? 0 : (x.monthly ? p.basicSalary / r.divisor : p.basicSalary);
    x.hourly = x.orp / x.nh;
    x.normalOt = x.hourly * r.normalDayOt; x.restOt = x.hourly * r.restBeyond; x.phOt = x.hourly * r.phBeyond;
    x.restHalf = x.monthly ? r.restHalfMonthly : r.restHalfDaily;
    x.restFull = x.monthly ? r.restFullMonthly : r.restFullDaily;
    x.phFlat = x.orp * r.phDays;
    x.monthlyWage = x.monthly ? p.basicSalary : p.basicSalary * 26;
    x.statutory = x.monthlyWage <= r.wageThreshold;
    return x;
  }

  function lineValue(dayType, hours, pay, r) {
    const rest = dayType === "Rest Day", ph = dayType === "Public Holiday";
    const within = (rest || ph) ? Math.min(hours, pay.nh) : 0, beyond = hours - within;
    let value = 0;
    if (dayType !== "" && hours > 0) {
      if (rest) value = R2((within > 0 ? (within <= pay.nh / 2 ? pay.restHalf : pay.restFull) : 0) * pay.orp + beyond * pay.hourly * r.restBeyond);
      else if (ph) value = R2((within > 0 ? r.phDays : 0) * pay.orp + beyond * pay.hourly * r.phBeyond);
      else value = R2(beyond * pay.hourly * r.normalDayOt);
    }
    return { within, beyond, value };
  }

  // ---- OT hours records
  const legacy = c => (c.schema || 0) < 2;
  function compute(c) {
    const pay = payOf(c.profile, c.rates);
    const t = { hours: 0, within: 0, beyond: 0, otPay: 0, til: 0, value: 0 };
    for (const l of c.lines) {
      const d = day(l.date);
      l.day = d ? ddd(d) : "";
      l.hours = l.within = l.beyond = l.value = 0;
      if (legacy(c)) l.otPay = l.til = 0;
      const s = time(l.start), e = time(l.end);
      if (s === null || e === null) continue;
      const span = ((e - s + 1440) % 1440) / 60;
      l.hours = R2(Math.max(0, span - Math.max(0, l.breakHrs || 0)));
      const v = lineValue(l.dayType, l.hours, pay, c.rates);
      l.within = v.within; l.beyond = v.beyond; l.value = v.value;
      t.hours += l.hours; t.within += l.within; t.beyond += l.beyond; t.value += l.value; t.otPay += l.otPay || 0; t.til += l.til || 0;
    }
    for (const k in t) t[k] = R2(t[k]);
    c.totals = t;
  }

  function expectedDayType(p, d) {
    const name = DAYNAMES[d.getUTCDay()];
    if (name.toLowerCase() === String(p.restDay || "").toLowerCase()) return "Rest Day";
    const six = String(p.normalDays || "").indexOf("Sat") >= 0;
    if (d.getUTCDay() === 0 || (d.getUTCDay() === 6 && !six)) return "Off Day";
    return "Normal Working Day";
  }

  function deadline(d) {
    let x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), n = 0;
    while (true) { if (x.getUTCDay() !== 0 && x.getUTCDay() !== 6 && ++n === 3) return x; x = addDays(x, 1); }
  }
  const payBy = d => addDays(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 1)), -1);
  const cleanDays = v => String(v || "").indexOf("Sat") >= 0 ? "Mon – Sat" : "Mon – Fri";

  function profileProblem(p) {
    if (!String(p.name || "").trim()) return "Your name is missing in PSL Admin - ask the admin.";
    if (!String(p.staffId || "").trim()) return "You have no employee ID yet - ask the admin to add you in PSL Admin.";
    if (!(p.basicSalary > 0)) return "Your basic salary is not set yet - ask the admin.";
    if (!(p.normalHours > 0 && p.normalHours <= 12)) return "Your normal hours per day are not set correctly - ask the admin.";
    if (time(p.shiftEnd) === null) return "The time your normal working day ends is not set - ask the admin.";
    return null;
  }

  function spanOf(date, start, end) {
    const d = day(date), s = time(start), e = time(end);
    if (!d || s === null || e === null) return null;
    const a = daysBetween(new Date(Date.UTC(2000, 0, 1)), d) * 1440 + s;
    const b = a + (e - s + 1440) % 1440;
    return b > a ? { a, b } : null;
  }

  function leaveByDate(apps) {
    const map = {};
    for (const a of apps) for (const l of a.lines) map[l.date] = (map[l.date] || 0) + (l.span > 0 ? Math.max(0, l.span - (l.restFree || 0)) : (l.hours || 0));
    return map;
  }

  function check(db, c, today) {
    const r = { errors: [], warnings: [] };
    const pp = profileProblem(c.profile); if (pp) r.errors.push(pp);
    if (c.lines.length === 0) r.errors.push("Add at least one overtime line.");
    if (c.lines.length > MaxClaimLines) r.errors.push("One record has room for " + MaxClaimLines + " lines - you have " + c.lines.length + ". Send the rest as another record.");
    const pay = payOf(c.profile, c.rates);
    const shiftEnd = time(c.profile.shiftEnd) || 0;
    const shiftStart = shiftEnd - Math.round((pay.nh + 1) * 60);
    const mine = [], others = [], monthBeyond = {};
    for (const o of db.claims) if (o.id !== c.id && active(o.status)) for (const l of o.lines) {
      const sp = spanOf(l.date, l.start, l.end);
      if (sp) others.push({ a: sp.a, b: sp.b, where: o.id + " (" + showDate(l.date) + " " + l.start + "-" + l.end + ")" });
      const m = (l.date || "").length >= 7 ? l.date.substr(0, 7) : "";
      monthBeyond[m] = (monthBeyond[m] || 0) + (l.beyond || 0);
    }
    const leave = leaveByDate(db.tilApps.filter(a => active(a.status)));
    c.lines.forEach((l, i) => {
      const n = "Line " + (i + 1) + ": ";
      const d = day(l.date);
      if (!d) { r.errors.push(n + "enter the date."); return; }
      if (d > today) r.errors.push(n + show(d) + " is in the future - overtime can only be recorded after it is worked.");
      if (DayTypes.indexOf(l.dayType) < 0) r.errors.push(n + "choose the day type.");
      const s = time(l.start), e = time(l.end);
      if (s === null || e === null) { r.errors.push(n + "enter the start and end time."); return; }
      if (s === e) { r.errors.push(n + "the start and end time are the same."); return; }
      const span = ((e - s + 1440) % 1440) / 60;
      if ((l.breakHrs || 0) < 0) r.errors.push(n + "the break cannot be negative.");
      if ((l.breakHrs || 0) >= span) r.errors.push(n + "the break is as long as the whole period.");
      if (l.hours > 12) r.warnings.push(n + Num(l.hours) + " hours in one stretch on " + show(d) + ".");
      if (today > deadline(d)) r.warnings.push(n + show(d) + " is recorded late - overtime of " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() + " was due by " + show(deadline(d)) + ".");
      const expected = expectedDayType(c.profile, d);
      if (l.dayType !== "" && l.dayType !== "Public Holiday" && l.dayType !== expected)
        r.warnings.push(n + show(d) + " is a " + DAYNAMES[d.getUTCDay()] + " - normally a " + expected + ", but it is recorded as " + l.dayType + ".");
      if (l.dayType === "Public Holiday") r.warnings.push(n + show(d) + " is recorded as a public holiday - check it is a gazetted holiday.");
      if (l.dayType === "Normal Working Day" && s < shiftEnd && (s + span * 60) > shiftStart)
        r.warnings.push(n + l.start + "-" + l.end + " overlaps normal working hours (" + hm(shiftStart) + "-" + hm(shiftEnd) + "). On a normal day enter only the time after the shift.");
      const sp = spanOf(l.date, l.start, l.end) || { a: 0, b: 0 };
      for (const o of mine) if (sp.a < o.b && o.a < sp.b) r.errors.push(n + "overlaps " + o.where + " in this record.");
      for (const o of others) if (sp.a < o.b && o.a < sp.b) r.errors.push(n + "this time was already recorded in " + o.where + ".");
      mine.push({ a: sp.a, b: sp.b, where: "line " + (i + 1) });
      if (leave[l.date] !== undefined) {
        const off = leave[l.date];
        if (off >= pay.nh) r.errors.push(n + "you have a full day off booked on " + show(d) + ".");
        else r.warnings.push(n + "you also have " + Num(off) + " hrs off booked on " + show(d) + ".");
      }
    });
    const months = {};
    for (const l of c.lines) if ((l.date || "").length >= 7) { const k = l.date.substr(0, 7); months[k] = (months[k] || 0) + (l.beyond || 0); }
    for (const k in months) {
      const total = R2((monthBeyond[k] || 0) + months[k]);
      if (total > c.rates.monthlyCap) r.warnings.push("Beyond-normal hours in " + showMonth(k) + " (" + Num(total) + ", all records together) exceed the " + Num(c.rates.monthlyCap) + "-hour monthly overtime limit - needs management justification.");
    }
    if (!pay.statutory && pay.monthlyWage > 0) r.warnings.push("Wage above RM" + c.rates.wageThreshold.toLocaleString("en-US") + " - OT is by contract / company policy, not the statutory rates.");
    return r;
  }

  // ---- the credit ledger (Calc.Build)
  const expiryOf = (approvedOn, days) => { const d = day(approvedOn); return d ? iso(addDays(d, days)) : ""; };
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  // the company applies NO "overtime must be paid in money" rule (decision 2026-10-06): everybody may take credits as
  // time-in-lieu, and there is no pay-by deadline - the same as Calc.LawCovers on the PC
  const lawCovers = (p, r) => false;

  function build(db, extra, today, r, statutory) {
    const led = { lots: [], spends: [], approvedLeft: 0, expiredLeft: 0, pendingLeft: 0, held: 0, takenOff: 0, paidOut: 0, paidAmount: 0, paperRemoved: 0,
      overdueHours: 0, nextExpiry: "", statutory: statutory, byRef: {} };
    const validity = r.tilValidityDays;
    for (const c of db.claims.filter(x => active(x.status))) {
      const ok = c.status === S.Approved, on = ok ? day10(c.decidedAt) : "";
      c.lines.forEach((l, i) => {
        const lot = { src: "hours", refId: c.id, line: i, date: l.date, dayType: l.dayType, start: l.start, end: l.end, breakHrs: l.breakHrs || 0, lineHours: l.hours,
          remarks: l.remarks || "", approved: ok, approvedOn: on, hours: 0, value: 0, used: 0, remaining: 0, expiry: "", payBy: "" };
        if (legacy(c)) {
          if (!(l.til > 0)) return;
          const worked = l.comp === "Split" ? l.tilHrs : l.hours;
          lot.src = "legacy"; lot.hours = l.til; lot.value = l.hours > 0 ? R2(l.value * worked / l.hours) : 0;
        } else {
          if (!(l.hours > 0)) return;
          lot.hours = l.hours; lot.value = l.value;
        }
        led.lots.push(lot);
      });
    }
    for (const a of db.adjusts.filter(x => x.dir === "add" && x.hours > 0))
      led.lots.push({ src: "paper", refId: a.id, line: 0, date: a.date, dayType: a.dayType, start: "", end: "", breakHrs: 0, lineHours: a.hours, hours: a.hours, value: a.value,
        approved: true, approvedOn: a.paperDate !== "" ? a.paperDate : day10(a.createdAt), remarks: a.what + (a.paperRef !== "" ? " - " + a.paperRef : ""), used: 0, remaining: 0, expiry: "", payBy: "" });
    for (const l of led.lots) {
      l.expiry = l.approved ? expiryOf(l.approvedOn, validity) : "";
      const od = day(l.date);
      if (statutory && od) l.payBy = iso(payBy(od));
    }
    led.lots.sort((x, y) => (x.approved ? 0 : 1) - (y.approved ? 0 : 1) || cmp(x.approved ? x.approvedOn : "", y.approved ? y.approvedOn : "") || cmp(x.date, y.date)
      || cmp(x.start, y.start) || cmp(x.refId, y.refId) || x.line - y.line);
    const perHour = l => l.hours > 0 ? l.value / l.hours : 0;
    const decided = [], waiting = [];
    for (const p of db.payouts.filter(x => active(x.status))) {
      const s = { kind: "pay", refId: p.id, status: p.status, at: p.submittedAt, hours: p.hours, draws: [], uncovered: 0, amount: 0 };
      if (p.status === S.Approved) { s.draws = (p.draws || []).map(d => Object.assign({}, d)); decided.push(s); } else waiting.push(s);
    }
    for (const a of db.tilApps.filter(x => active(x.status) && !x.category)) {          // leave on the leave form (annual, sick ...) never uses credits
      const s = { kind: "leave", refId: a.id, status: a.status, at: a.submittedAt, hours: a.totalHours, draws: [], uncovered: 0, amount: 0 };
      if (a.status !== S.Submitted) { s.draws = (a.draws || []).map(d => Object.assign({}, d)); if ((a.schema || 0) < 2) s.draws.forEach(d => d.src = "legacy-app"); decided.push(s); }
      else waiting.push(s);
    }
    for (const a of db.adjusts.filter(x => x.dir === "remove" && x.hours > 0))
      waiting.push({ kind: "paper", refId: a.id, status: S.Approved, at: a.createdAt, hours: a.hours, draws: [], uncovered: 0, amount: 0 });
    const book = s => {
      s.amount = R2(s.draws.reduce((t, d) => t + d.amount, 0));
      led.spends.push(s); led.byRef[s.refId] = s;
      const h = R2(s.draws.reduce((t, d) => t + d.hours, 0));
      if (s.status === S.Submitted) led.held = R2(led.held + h);
      else if (s.kind === "pay") { led.paidOut = R2(led.paidOut + h); led.paidAmount = R2(led.paidAmount + s.amount); }
      else if (s.kind === "leave") led.takenOff = R2(led.takenOff + h);
      else if (s.kind === "paper") led.paperRemoved = R2(led.paperRemoved + h);
    };
    const tIso = iso(today);
    const take = (s, firstLeave) => {
      let need = s.hours;
      for (const l of led.lots) {
        if (need <= 0.0001) break;
        const left = R2(l.hours - l.used);
        if (left <= 0.0001) continue;
        if (s.kind === "leave" && l.approved && l.expiry !== "") {
          const limit = firstLeave !== "" && firstLeave > tIso ? firstLeave : tIso;
          if (l.expiry < limit) continue;
        }
        const t = R2(Math.min(left, need));
        l.used = R2(l.used + t); need = R2(need - t);
        s.draws.push({ claimId: l.refId, line: l.line, src: l.src, date: l.date, dayType: l.dayType, start: l.start, end: l.end, breakHrs: l.breakHrs, lineHours: l.lineHours,
          hours: t, perHour: R2(perHour(l)), amount: R2(t * perHour(l)), pending: !l.approved, expired: l.approved && l.expiry !== "" && l.expiry < tIso });
      }
      s.uncovered = need > 0.0001 ? R2(need) : 0;
    };
    const firstDate = a => a.lines.map(l => l.date).filter(x => x).sort()[0] || "";
    for (const s of decided) {
      for (const d of s.draws) {
        let need = d.hours;
        const from = d.src === "legacy-app" ? led.lots.filter(l => l.refId === d.claimId) : led.lots.filter(l => l.refId === d.claimId && l.line === d.line);
        for (const l of from) {
          if (need <= 0.0001) break;
          const t = Math.min(need, l.hours - l.used);
          if (t <= 0.0001) continue;
          l.used = R2(l.used + t); need = R2(need - t);
        }
      }
      book(s);
    }
    waiting.sort((x, y) => cmp(x.at || "", y.at || ""));
    for (const s of waiting) { take(s, s.kind === "leave" ? firstDate(db.tilApps.find(a => a.id === s.refId)) : ""); book(s); }
    if (extra && !active(extra.status)) {
      const isLeave = !!extra.lines;
      const s = { kind: isLeave ? "leave" : "pay", refId: extra.id, status: extra.status, hours: isLeave ? extra.totalHours : extra.hours, draws: [], uncovered: 0, amount: 0 };
      take(s, isLeave ? firstDate(extra) : ""); book(s);
    }
    for (const l of led.lots) {
      l.remaining = R2(l.hours - l.used);
      l.expired = l.approved && l.expiry !== "" && l.expiry < tIso;
      const ex = day(l.expiry);
      l.expiringSoon = !l.expired && l.remaining > 0 && !!ex && daysBetween(today, ex) <= 14;
      l.payOverdue = statutory && l.remaining > 0 && l.payBy !== "" && l.payBy < tIso;
      if (!l.approved) led.pendingLeft = R2(led.pendingLeft + l.remaining);
      else if (l.expired) led.expiredLeft = R2(led.expiredLeft + l.remaining);
      else led.approvedLeft = R2(led.approvedLeft + l.remaining);
      if (l.payOverdue) led.overdueHours = R2(led.overdueHours + l.remaining);
      if (l.approved && !l.expired && l.remaining > 0 && (led.nextExpiry === "" || l.expiry < led.nextExpiry)) led.nextExpiry = l.expiry;
    }
    led.usable = R2(led.approvedLeft + led.expiredLeft);
    return led;
  }

  function checkPayout(db, p, today, led) {
    const r = { errors: [], warnings: [] };
    const pp = profileProblem(p.profile); if (pp) r.errors.push(pp);
    const s = led.byRef[p.id];
    p.draws = s ? s.draws : []; p.amount = s ? s.amount : 0;
    if (!(p.hours > 0)) { r.errors.push("Enter how many hours you want paid."); return r; }
    if (s && s.uncovered > 0) r.errors.push("You asked for " + Num(p.hours) + " hrs but only " + Num(R2(p.hours - s.uncovered)) + " hrs of credits are free (some may be held by requests still waiting).");
    if (p.draws.length > MaxClaimLines) {
      const fit = R2(p.draws.slice(0, MaxClaimLines).reduce((t, d) => t + d.hours, 0));
      r.errors.push("These hours come from " + p.draws.length + " different OT lines, but one form has room for " + MaxClaimLines + ". Ask for " + Num(fit) + " hrs now and the rest in another request.");
    }
    const pending = R2(p.draws.filter(d => d.pending).reduce((t, d) => t + d.hours, 0));
    if (pending > 0) r.warnings.push(Num(pending) + " hrs come from OT hours not confirmed yet - the approver confirms those first.");
    const expired = R2(p.draws.filter(d => d.expired).reduce((t, d) => t + d.hours, 0));
    if (expired > 0) r.warnings.push(Num(expired) + " hrs are past their time-off date - paid out at the OT rate as the company rules say.");
    return r;
  }

  // ---- time off
  function computeLeave(a, pol) {
    if (a.category) return;                     // leave on the leave form: worked out on the PC (days, not credits)
    const nh = a.profile.normalHours > 0 ? a.profile.normalHours : 8.5;
    for (const l of a.lines) {
      const d = day(l.date);
      l.day = d ? ddd(d) : "";
      if (l.paidBy !== "Unpaid") l.paidBy = "TIL";
      const s = time(l.from), e = time(l.to);
      if (l.leaveType === "Full Day") l.span = nh;
      else if (l.leaveType === "Half Day (AM)") l.span = HalfDayAm;
      else if (l.leaveType === "Half Day (PM)") l.span = HalfDayPm;
      else if (l.leaveType === "Hours" && s !== null && e !== null) l.span = R2(((e - s + 1440) % 1440) / 60);
      else l.span = 0;
      l.restFree = (a.schema || 0) >= 2 && l.leaveType === "Hours" && l.span > pol.restAfter ? R2(Math.min(pol.restFree, l.span - pol.restAfter)) : 0;
      const away = R2(Math.max(0, l.span - l.restFree));
      l.extraBreak = R2(Math.max(0, Math.min(l.extraBreak || 0, away)));
      if (l.paidBy === "Unpaid") { l.hours = 0; l.unpaid = away; l.extraBreak = 0; }
      else { l.hours = R2(away - l.extraBreak); l.unpaid = 0; }
    }
    a.totalHours = R2(a.lines.reduce((t, l) => t + l.hours, 0));
    a.unpaidHours = R2(a.lines.reduce((t, l) => t + l.unpaid, 0));
    // the public holidays within its dates (the form joins full days across them)
    const ds = a.lines.map(l => l.date).filter(x => !!day(x)).sort();
    a.holidays = ds.length ? Object.keys(holidays(pol)).filter(h => h >= ds[0] && h <= ds[ds.length - 1]).sort() : [];
  }
  // the admin's public holidays ("2026-12-25|Christmas Day"): date -> name
  function holidays(pol) {
    const m = {};
    ((pol && pol.holidays) || []).forEach(h => { h = String(h || ""); const i = h.indexOf("|"), d = (i >= 0 ? h.slice(0, i) : h).trim(), n = i >= 0 ? h.slice(i + 1).trim() : ""; if (day(d) && !(d in m)) m[d] = n || "Public holiday"; });
    return m;
  }

  function workingDaysBetween(from, to) {
    let n = 0;
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
    return n;
  }

  // the rows of the time-off form (Calc.LeaveRows): a run of FULL days - working days in a row, the person's days off between them
  // skipped - with the same "paid by", reason and no extra break is ONE row; every other day is a row of its own
  function leaveRows(a) {
    const ok = s => !!day(s);
    const lines = a.lines.map((l, i) => ({ l, i })).sort((x, y) => (ok(x.l.date) ? 0 : 1) - (ok(y.l.date) ? 0 : 1) || (ok(x.l.date) && x.l.date !== y.l.date ? (x.l.date < y.l.date ? -1 : 1) : 0) || x.i - y.i).map(x => x.l);
    const rows = [], hol = new Set(a.holidays || []);
    for (const l of lines) {
      const last = rows[rows.length - 1], p = last ? last[last.length - 1] : null;
      if (p && joinsRun(a.profile, p, l, hol)) last.push(l); else rows.push([l]);
    }
    return rows;
  }
  function joinsRun(prof, p, l, hol) {
    const a = day(p.date), b = day(l.date);
    if (p.leaveType !== "Full Day" || l.leaveType !== "Full Day" || p.paidBy !== l.paidBy || (p.reason || "") !== (l.reason || "")
      || p.extraBreak > 0 || l.extraBreak > 0 || !a || !b || b <= a || (b - a) / 864e5 > 14) return false;
    for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) if (expectedDayType(prof, d) === "Normal Working Day" && !hol.has(iso(d))) return false;     // a working day in between (not a holiday): a gap
    return true;
  }
  // the working days from .. to (the person's days off left out) - for "several days" in one go
  function workingDays(prof, from, to) {
    const out = [], a = day(from), b = day(to);
    if (!a || !b) return out;
    for (let d = a; d <= b && out.length <= MaxLeaveDays; d = addDays(d, 1)) if (expectedDayType(prof, d) === "Normal Working Day") out.push(iso(d));
    return out;
  }

  function checkLeave(db, a, today, led, pol, statutory) {
    const r = { errors: [], warnings: [] };
    const pp = profileProblem(a.profile); if (pp) r.errors.push(pp);
    if (a.lines.length === 0) r.errors.push("Add at least one day off.");
    if (a.lines.length > MaxLeaveDays) r.errors.push("One application has room for " + MaxLeaveDays + " days - you have " + a.lines.length + ". Send the rest as another application.");
    else {
      const formRows = leaveRows(a).length;
      if (formRows > MaxLeaveLines) r.errors.push("The form has room for " + MaxLeaveLines + " rows - full days in a row count as one row; these days make " + formRows + ". Send the rest as another application.");
    }
    const nh = a.profile.normalHours > 0 ? a.profile.normalHours : 8.5;
    const others = db.tilApps.filter(x => x.id !== a.id && active(x.status));
    const booked = leaveByDate(others);
    const halves = new Set();
    for (const x of others) for (const l of x.lines) if ((l.leaveType || "").startsWith("Half")) halves.add(l.date + l.leaveType);
    const otDates = {};
    for (const c of db.claims.filter(c => active(c.status))) for (const l of c.lines) if (!(l.date in otDates)) otDates[l.date] = c.id;
    const here = {}, hols = holidays(pol), unpaidDays = [];
    a.lines.forEach((l, i) => {
      const n = "Line " + (i + 1) + ": ";
      const d = day(l.date);
      if (!d) { r.errors.push(n + "enter the date."); return; }
      if (LeaveTypes.indexOf(l.leaveType) < 0) { r.errors.push(n + "choose full day, half day or hours."); return; }
      if (!(l.span > 0)) { r.errors.push(n + "enter the from / to time."); return; }
      const away = l.span - l.restFree;
      if (away > nh + 0.001) r.errors.push(n + Num(away) + " hrs is more than a normal day (" + Num(nh) + " hrs).");
      if (l.leaveType.startsWith("Half")) { const k = l.date + l.leaveType; if (halves.has(k)) r.errors.push(n + "you already applied for this " + l.leaveType.toLowerCase() + " on " + show(d) + "."); else halves.add(k); }
      const before = booked[l.date] || 0, so = here[l.date] || 0;
      here[l.date] = so + away;
      if (before + so + away > nh + 0.001) r.errors.push(n + show(d) + " already has " + Num(before + so) + " hrs off booked - a day has only " + Num(nh) + " hrs.");
      if (l.date in otDates) {
        if (l.leaveType === "Full Day") r.errors.push(n + "you recorded overtime on " + show(d) + " (" + otDates[l.date] + ") - a full day off cannot be on the same day.");
        else r.warnings.push(n + "you also recorded overtime on " + show(d) + " (" + otDates[l.date] + ").");
      }
      const expected = expectedDayType(a.profile, d);
      if (expected !== "Normal Working Day")
        r.errors.push(n + show(d) + " is a " + DAYNAMES[d.getUTCDay()] + " (" + expected + ") - not one of your working days (" + cleanDays(a.profile.normalDays) + "), so no time off is taken or charged for it. Remove it.");
      else if (l.date in hols) r.errors.push(n + show(d) + " is a public holiday (" + hols[l.date] + ") - no time off is taken or charged for it. Remove it.");
      if (d < today) r.warnings.push(n + show(d) + " is in the past (applied afterwards).");
      else if (workingDaysBetween(today, d) < 3) r.warnings.push(n + "less than 3 working days' notice for " + show(d) + ".");
      if (l.paidBy === "Unpaid") unpaidDays.push(n + show(d) + " is unpaid leave (" + Num(l.unpaid) + " hrs) - it is deducted from pay.");
      if (l.restFree > 0) r.warnings.push(n + Num(l.restFree) + " hr of rest in this stretch is not charged.");
      if (l.extraBreak > 0) r.warnings.push(n + Num(l.extraBreak) + " hr extra break allowed by the approver (not charged).");
    });
    // unpaid leave: one note (a range of days would otherwise repeat it for every day)
    if (unpaidDays.length === 1) r.warnings.push(unpaidDays[0]);
    else if (unpaidDays.length > 1) r.warnings.push(unpaidDays.length + " days are unpaid leave (" + Num(a.unpaidHours) + " hrs in all) - they are deducted from pay.");
    const s = led.byRef[a.id];
    a.draws = s ? s.draws : [];
    const uncovered = s ? s.uncovered : 0;
    if (a.totalHours > 0 && uncovered > 0.001) {
      const msg = "You are asking for " + Num(a.totalHours) + " hrs of time-in-lieu but only " + Num(R2(a.totalHours - uncovered)) + " hrs of credits are free for those dates (" + Num(uncovered) + " hrs short).";
      if (uncovered >= a.totalHours - 0.001) r.errors.push(msg + " Choose Unpaid leave instead, or record your overtime first.");
      else r.warnings.push(msg + " The approver may allow extra break time for the difference, or make part of it unpaid.");
    }
    const pending = R2(a.draws.filter(x => x.pending).reduce((t, x) => t + x.hours, 0));
    if (pending > 0.001) r.warnings.push(Num(pending) + " hrs come from OT hours not confirmed yet - this leave depends on them being confirmed.");
    return r;
  }

  // ---- leave on the company leave form (Leave.cs): annual, sick, ... counted in DAYS against the yearly entitlement, never credits
  const L_ANNUAL = "Annual Leave", L_SICK = "Sick Leave", L_HOSP = "Hospitalization Leave", L_EMERG = "Emergency Leave", L_MAT = "Maternity/Paternity Leave",
    L_COMP = "Compassionate Leave", L_UNPAID = "Unpaid Leave", L_MARR = "Marriage Leave", L_TRAIN = "Training Leave", L_OTHERS = "Others";
  const LeaveForm = [L_ANNUAL, L_SICK, L_HOSP, L_EMERG, L_MAT, L_COMP, L_UNPAID, L_MARR, L_TRAIN, L_OTHERS];
  const LeaveCounted = [L_ANNUAL, L_SICK, L_HOSP, L_EMERG, L_MAT, L_COMP, L_MARR];
  const MaxRanges = 3;
  const isCounted = t => LeaveCounted.indexOf(t) >= 0;
  const calendarDays = t => t === L_HOSP || t === L_MAT;          // these run day after day; the rest count working days only
  function yearsOfService(joined, on) { const j = day(joined); return !j || j > on ? 0 : (on - j) / 86400000 / 365.25; }
  function defaultDays(type, joined, on) {
    const y = yearsOfService(joined, on);
    switch (type) {
      case L_ANNUAL: return y < 2 ? 8 : y < 5 ? 12 : 16;
      case L_SICK: return y < 2 ? 14 : y < 5 ? 18 : 22;
      case L_HOSP: return 60;
      case L_EMERG: case L_COMP: case L_MARR: return 3;
      default: return 0;
    }
  }
  function daysFor(p, type, on) { const v = p && p.leaveDays ? p.leaveDays[type] : undefined; return typeof v === "number" && v >= 0 ? v : defaultDays(type, p ? p.joined : "", on); }
  function forwardDays(p, type, year) { const v = type === L_ANNUAL && p && p.forward ? p.forward[String(year)] : 0; return typeof v === "number" && v > 0 ? v : 0; }
  const lineDays = l => String(l.leaveType || "").startsWith("Half") ? 0.5 : 1;
  const leaveLine = (a, d, type, span) => ({ date: iso(d), day: ddd(d), leaveType: type, from: "", to: "", paidBy: "Leave", hours: 0, unpaid: 0, reason: a.reason, span, restFree: 0, extraBreak: 0 });

  // From / To stretches -> one line per day off
  function leaveCompute(a) {
    const nh = a.profile.normalHours > 0 ? a.profile.normalHours : 8.5, lines = [];
    for (const g of a.ranges) {
      g.days = 0;
      const f = day(g.from); if (!f) continue;
      let t = day(g.to); if (!t) { t = f; g.to = g.from; }
      if (t < f || (t - f) / 86400000 > 366) continue;
      if (g.half && +f === +t) {
        const lt = g.half === "PM" ? "Half Day (PM)" : "Half Day (AM)";
        lines.push(leaveLine(a, f, lt, lt === "Half Day (PM)" ? HalfDayPm : HalfDayAm)); g.days = 0.5; continue;
      }
      g.half = "";
      for (let d = f; d <= t; d = addDays(d, 1)) {
        if (!calendarDays(a.category) && expectedDayType(a.profile, d) !== "Normal Working Day") continue;
        lines.push(leaveLine(a, d, "Full Day", nh)); g.days += 1;
      }
    }
    a.lines = lines;
    a.leaveDays = R2(lines.reduce((t, l) => t + lineDays(l), 0));
    a.totalHours = 0; a.unpaidHours = 0; a.draws = [];
  }

  // the LEAVE BALANCE box: days a year (+ brought forward) - taken - waiting
  function leaveBalance(db, p, type, year, exceptId) {
    const b = { type, year, counted: isCounted(type), entitlement: 0, forward: 0, taken: 0, waiting: 0, available: 0 };
    if (b.counted) { b.entitlement = daysFor(p, type, new Date(Date.UTC(year, 11, 31))); b.forward = forwardDays(p, type, year); }
    const y = String(year);
    for (const x of db.tilApps) if (x.id !== exceptId && x.category === type && active(x.status)) {
      const n = (x.lines || []).filter(l => String(l.date || "").startsWith(y)).reduce((t, l) => t + lineDays(l), 0);
      if (x.status === S.Submitted) b.waiting += n; else b.taken += n;
    }
    b.taken = R2(b.taken); b.waiting = R2(b.waiting); b.available = R2(b.entitlement + b.forward - b.taken - b.waiting);
    return b;
  }
  function leaveYear(a) {
    const first = (a.lines || []).map(l => l.date).filter(Boolean).sort()[0] || (a.ranges.length ? a.ranges[0].from : "");
    const d = day(first); return d ? d.getUTCFullYear() : todayLocal().getUTCFullYear();
  }

  // the employee's checks (Leave.Check): errors stop it, warnings go with it
  function leaveCheck(db, a, today) {
    const r = { errors: [], warnings: [] }, type = a.category;
    if (LeaveForm.indexOf(type) < 0) { r.errors.push("Choose the type of leave."); return r; }
    const pp = profileProblem(a.profile); if (pp) r.errors.push(pp);
    if (!a.ranges.length) r.errors.push("Add the date(s) of your leave.");
    if (a.ranges.length > MaxRanges) r.errors.push("The leave form has room for " + MaxRanges + " From / To lines - send the rest as another application.");
    a.ranges.forEach((g, i) => {
      const n = a.ranges.length > 1 ? "Line " + (i + 1) + ": " : "";
      const f = day(g.from); if (!f) { r.errors.push(n + "choose the first day."); return; }
      const t = day(g.to) || f;
      if (t < f) { r.errors.push(n + "the last day is before the first day."); return; }
      if ((t - f) / 86400000 > 366) { r.errors.push(n + "that is more than a year."); return; }
      if (g.days <= 0) r.errors.push(n + show(f) + (t > f ? " - " + show(t) : "") + " has no working days in it (rest days / off days are not leave).");
    });
    if (a.leaveDays <= 0 && a.ranges.length > 0 && r.errors.length === 0) r.errors.push("These dates have no working days in them.");
    const booked = leaveByDate(db.tilApps.filter(x => x.id !== a.id && active(x.status)));
    const nh = a.profile.normalHours > 0 ? a.profile.normalHours : 8.5;
    const otDates = {};
    for (const c of db.claims.filter(c => active(c.status))) for (const l of c.lines) if (!(l.date in otDates)) otDates[l.date] = c.id;
    const seen = new Set();
    for (const l of a.lines) {
      const d = day(l.date), before = booked[l.date] || 0;
      if (seen.has(l.date)) r.errors.push(show(d) + " is in this application twice.");
      else { seen.add(l.date); if (before + (l.leaveType.startsWith("Half") ? nh / 2 : nh) > nh + 0.001) r.errors.push("You already have leave / time off on " + show(d) + "."); }
      if ((l.date in otDates) && l.leaveType === "Full Day") r.errors.push("You recorded overtime on " + show(d) + " (" + otDates[l.date] + ") - a whole day of leave cannot be on the same day.");
    }
    const year = leaveYear(a), b = leaveBalance(db, a.profile, type, year, a.id);
    a.balEntitlement = b.entitlement; a.balForward = b.forward; a.balTaken = b.taken;
    a.balAfter = R2(b.entitlement + b.forward - b.taken - b.waiting - a.leaveDays);
    if (b.counted) {
      if (b.entitlement + b.forward <= 0) r.errors.push("Your contract has no " + type.toLowerCase() + ". Ask HR / the admin.");
      else if (a.leaveDays > b.available + 0.001)
        r.errors.push("Only " + Num(Math.max(0, b.available)) + " day(s) of " + type.toLowerCase() + " are left in " + year + " (entitled " + Num(b.entitlement) +
          (b.forward > 0 ? " + " + Num(b.forward) + " brought forward" : "") + ", taken " + Num(b.taken) + (b.waiting > 0 ? ", waiting approval " + Num(b.waiting) : "") + ") - you asked for " + Num(a.leaveDays) + ".");
    }
    if (new Set(a.lines.map(l => l.date.substr(0, 4))).size > 1) r.warnings.push("This leave runs into the next year - it is all counted in " + year + ".");
    const ds = a.lines.map(l => l.date).sort(), first = day(ds[0]), last = day(ds[ds.length - 1]);
    if (first && last) {
      if (type === L_SICK || type === L_HOSP || type === L_EMERG || type === L_COMP) {
        if (workingDaysBetween(last, today) > 3) r.warnings.push("Medical / sick and emergency leave should be sent not later than 2 days after you are back at work.");
      }
      else if (first < today) r.warnings.push("The leave starts in the past (" + show(first) + ").");
      else if (workingDaysBetween(today, first) < 3) r.warnings.push("Leave should be applied for at least 3 days before - this starts " + show(first) + ".");
    }
    if (type === L_SICK || type === L_HOSP) r.warnings.push("Give your medical certificate to HR.");
    if (type === L_UNPAID) r.warnings.push("Unpaid leave is deducted from pay.");
    return r;
  }
  // "08/10/2026 - 10/10/2026 (3 days), 15/10/2026 (half day AM)" (Leave.Dates)
  const leaveDates = a => a.ranges.map(g => showDate(g.from) + (g.to && g.to !== g.from ? " - " + showDate(g.to) : "") + (g.half ? " (half day " + g.half + ")" : " (" + Num(g.days) + (g.days === 1 ? " day)" : " days)"))).join(", ");

  // ---- fingerprints (Calc.Canonical) - hashed by the phone (Native.sha256)
  const R = x => String(x || 0);
  const who = p => p.staffId + "|" + p.name + "|" + p.jobTitle + "|" + p.department + "|" + p.location + "|" + p.wageBasis + "|" + R(p.basicSalary) + "|" + R(p.normalHours) + "\n";
  function canonClaim(c) {
    let s = (legacy(c) ? "OT|" : "OTH2|") + c.id + "|" + c.month + "|" + c.submittedAt + "|" + who(c.profile);
    for (const l of c.lines) s += l.date + "|" + l.dayType + "|" + l.start + "|" + l.end + "|" + R(l.breakHrs) + "|" + R(l.hours) + "|" + R(l.value) + "|" + l.remarks + "\n";
    return s + R(c.totals.hours) + "|" + R(c.totals.value);
  }
  function canonTil(a) {
    let s = "TIL2|" + a.id + "|" + a.submittedAt + "|" + who(a.profile);
    for (const l of a.lines) s += l.date + "|" + l.leaveType + "|" + l.from + "|" + l.to + "|" + l.paidBy + "|" + R(l.hours) + "|" + R(l.unpaid) + "|" + l.reason + "\n";
    for (const d of a.draws) s += d.claimId + "#" + d.line + "=" + R(d.hours) + ";";
    if (a.category) {
      s += "\nLEAVE|" + a.category + "|" + R(a.leaveDays) + "|" + (a.coverName || "") + "|" + (a.coverDesignation || "") + "|" + (a.coverContact || "") + "\n";
      for (const g of a.ranges) s += g.from + "|" + g.to + "|" + g.half + "|" + R(g.days) + "\n";
    }
    return s;
  }
  function canonPay(p) {
    let s = "PAY2|" + p.id + "|" + p.submittedAt + "|" + R(p.hours) + "|" + who(p.profile);
    for (const d of p.draws) s += d.claimId + "#" + d.line + "=" + R(d.hours) + "@" + R(d.amount) + ";";
    return s + "|" + R(p.amount);
  }
  const shortCode = h => (h.substr(0, 4) + "-" + h.substr(4, 4)).toUpperCase();

  // ---- licences and tenders (Model.cs)
  function licLevel(days, m) {
    if (days === null) return 6;
    if (days < 0) return 0;
    if (days <= m.criticalDays) return 1; if (days <= m.highDays) return 2; if (days <= m.mediumDays) return 3; if (days <= m.lowDays) return 4;
    return 5;
  }
  const LIC_NAMES = ["Expired", "Critical", "High", "Medium", "Low", "OK", "No date"];
  function span(d) { if (d === 1) return "1 day"; if (d < 60) return d + " days"; if (d < 730) return Math.round(d / 30.4) + " months"; return (Math.round(d / 365.25 * 10) / 10) + " years"; }
  function licLeft(d) { if (d === null) return "No expiry date"; if (d === 0) return "Expires today"; if (d === 1) return "Expires tomorrow"; if (d < 0) return "Expired " + span(-d) + " ago"; return span(d) + " left"; }
  const daysTo = (s, today) => { const d = day(s); return d ? daysBetween(today, d) : null; };
  const accepted = t => t.decision === "accepted" || (t.decision !== "declined" && (t.attended || t.purchased || t.submitted));
  function tStatus(t, today) {
    if (t.decision === "declined") return "declined";
    if (t.submitted) return "submitted";
    const dc = daysTo(t.closingIso, today), closed = dc !== null && dc < 0;
    if (accepted(t)) return closed ? "closed" : "progress";
    if (closed || !t.eligible) return "closed";
    const db = daysTo(t.briefingIso, today);
    if (db !== null && db < 0) return "missed";
    return "awaiting";
  }
  const T_NAMES = { progress: "In progress", awaiting: "Waiting for decision", missed: "Briefing missed", submitted: "Submitted", declined: "Declined", closed: "Closed" };
  function tReason(t, today, warn) {
    const dc = daysTo(t.closingIso, today), db = daysTo(t.briefingIso, today), st = tStatus(t, today);
    if (st !== "progress" && st !== "awaiting") return "";
    if (!t.attended && db !== null && db >= 0 && db <= 3) return db === 0 ? "Compulsory briefing today" : db === 1 ? "Compulsory briefing tomorrow" : "Compulsory briefing in " + db + " days";
    if (st === "progress" && t.purchased && !t.submitted) return dc !== null ? "Documents bought - submit " + (dc === 0 ? "today" : dc === 1 ? "by tomorrow" : "within " + dc + " days") : "Documents bought - not submitted yet";
    if (dc !== null && dc <= warn) return dc === 0 ? "Closes today" : dc === 1 ? "Closes tomorrow" : "Closes in " + dc + " days";
    return "";
  }

  return { lawCovers, MaxClaimLines, MaxLeaveLines, MaxLeaveDays, leaveRows, workingDays, holidays, HalfDayAm, HalfDayPm, DayTypes, LeaveTypes, S, active, rates, R2, Num, day, iso, addDays, show, showDate, showMonth, time,
    todayLocal, nowStamp, payOf, lineValue, compute, expectedDayType, deadline, payBy, cleanDays, profileProblem, check, build, checkPayout, computeLeave, checkLeave,
    canonClaim, canonTil, canonPay, LeaveForm, MaxRanges, isCounted, calendarDays, leaveCompute, leaveBalance, leaveCheck, leaveDates, leaveYear, shortCode, licLevel, LIC_NAMES, licLeft, daysTo, tStatus, T_NAMES, tReason, accepted };
})();
