"use strict";
/* PSL Master web - on an iPad in landscape and on a Mac: the PC app's layout. A dark menu on the left with the PC's pages and names
   (Home, Overtime, Leave, Calendar, Confirmation, Who's In, Licences, Tenders), the page on the right, your name and Sign out at the
   bottom. The pages themselves are the phone app's (app.js) - this only adds the menu and moves between them, using the phone
   app's own buttons (data-tab / data-act), so everything works exactly as on the phone. On an iPhone the menu is not shown. */
(function () {
  if (typeof render !== "function" || typeof esc !== "function") return;

  const ICON = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    overtime: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    leave: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    confirmation: '<path d="M9 12l2 2 4-4"/><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/>',
    office: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-6 6.5-6s5.9 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2c2 .7 3.3 2.7 3.6 5.8"/>',
    licenses: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    tenders: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
    out: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>'
  };
  const svg = p => '<svg viewBox="0 0 24 24" aria-hidden="true">' + p + "</svg>";

  const side = document.createElement("aside");
  side.id = "side";
  side.setAttribute("aria-label", "Menu");
  document.body.appendChild(side);

  // which menu item the page on screen belongs to
  function current() {
    const top = stack[stack.length - 1];
    if (top && top.name === "office") return "office";
    if (top && top.name === "me") return "me";
    if (tab === "ot") return otSeg === "leave" || otSeg === "off" ? "leave" : "overtime";
    return { home: "home", cal: "calendar", appr: "confirmation", lic: "licenses", ten: "tenders" }[tab] || "";
  }
  // the menu, as on the PC: [group, [[key, label, count]]]
  function items() {
    const work = [];
    if (!ME.isAdmin) work.push(["overtime", "Overtime"], ["leave", "Leave"]);       // the admin account records no overtime (as on the PC)
    work.push(["calendar", "Calendar"]);
    const office = [];
    if (ME.isApprover) office.push(["confirmation", "Confirmation", (ST && ST.conf || []).length]);
    office.push(["office", "Who's In"]);
    return [["", [["home", "Home"]]], ["My Work", work], ["Office", office], ["Company", [["licenses", "Licences"], ["tenders", "Tenders"]]]];
  }
  // each item is one of the phone app's own buttons, so app.js does the moving
  const ATTR = {
    home: 'data-tab="home"', overtime: 'data-tab="ot" data-seg-pre="credits"', leave: 'data-tab="ot" data-seg-pre="leave"', calendar: 'data-tab="cal"',
    confirmation: 'data-tab="appr"', office: 'data-act="office"', licenses: 'data-tab="co" data-co="lic"', tenders: 'data-tab="co" data-co="ten"'
  };

  let shown = "";
  function draw() {
    if (!ME) { side.innerHTML = ""; shown = ""; return; }
    const cur = current(), live = document.getElementById("live"), liveOn = !!live && !live.classList.contains("off");
    const ini = (document.getElementById("me") || {}).textContent || "?";
    const name = (ST && ST.profile && ST.profile.name) || ME.name || ME.email;
    const groups = items();
    const sig = JSON.stringify([cur, groups, liveOn, ini, name, ME.email, ME.employeeId, ME.isAdmin, ME.isApprover]);
    if (sig === shown) return;                                    // nothing changed - the menu is not drawn again
    shown = sig;
    let h = '<div class="brand"><div class="logo"><img src="logo.png" alt="PSL"></div><div><b>PSL Master</b><span>Pembinaan Setia Lestari</span></div></div><nav>';
    groups.forEach(([g, list]) => {
      if (!list.length) return;
      if (g) h += '<div class="nav-label">' + esc(g) + "</div>";
      list.forEach(([k, label, n]) => {
        const alert = k === "confirmation" && n > 0;
        h += "<button class=\"nav-item" + (cur === k ? " on" : "") + (alert ? " alert" : "") + "\" " + ATTR[k] + ">" + svg(ICON[k]) + "<span>" + esc(label) + "</span>" +
          (n > 0 ? '<span class="cnt">' + n + "</span>" : "") + "</button>";
      });
    });
    h += '</nav><div class="foot"><div class="live' + (liveOn ? "" : " off") + '"><i></i>' + (liveOn ? "Live updates on" : "Live updates connecting…") + "</div>" +
      '<button class="who' + (cur === "me" ? " on" : "") + '" data-me="1" title="My details &amp; reminders"><span class="av">' + esc(ini) + '</span><span class="w"><span class="n"><span class="nm">' + esc(name) + "</span>" +
      (ME.isAdmin ? '<span class="tag">ADMIN</span>' : ME.isApprover ? '<span class="tag">APPROVER</span>' : "") + '</span><span class="s">' +
      esc(ME.employeeId ? ME.employeeId + " · " + ME.email : ME.email) + "</span></span></button>" +
      '<button class="foot-btn" data-act="signOut">' + svg(ICON.out) + "Sign out</button></div>";
    side.innerHTML = h;
  }

  // before app.js moves (its click handler is on the whole page): which part of Overtime, Licences or Tenders
  side.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.segPre) otSeg = b.dataset.segPre;
    if (b.dataset.co) coLast = b.dataset.co;
    if (b.dataset.me) { stack.length = 0; stack.push({ name: "me" }); render(); window.scrollTo(0, 0); }
  });

  // the page tells which kind it is (forms are kept narrower on a big screen)
  function mark() {
    const v = document.getElementById("view"), top = stack[stack.length - 1];
    if (v) v.dataset.page = top ? top.name : tab;
  }
  const base = window.render;
  window.render = function () {
    const r = base.apply(this, arguments);
    try { mark(); draw(); } catch (e) { /* the menu must never stop the page */ }
    return r;
  };
  const baseLive = window.__live;
  if (typeof baseLive === "function") window.__live = on => { baseLive(on); try { draw(); } catch (e) { /* fine */ } };
  try { if (ME) { mark(); draw(); } } catch (e) { /* not signed in yet */ }
})();
