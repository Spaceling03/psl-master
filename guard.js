"use strict";
/* PSL Master web - loaded first, before anything is drawn.
   1. Never inside another website's frame (a page that hides PSL Master under its own buttons to trick a click).
   2. The layout: an iPhone (and any narrow or short window) gets the phone app's screens with the tabs at the bottom; an iPad in
      landscape and a Mac (900 px wide and 560 px tall or more) get the PC app's layout - the menu on the left (desktop.css/.js). */
(function () {
  if (window.top !== window.self) {
    document.documentElement.className += " framed";
    try { window.top.location.replace(window.self.location.href); } catch (e) { /* the other site does not allow it - the page stays blank */ }
    throw new Error("PSL Master does not open inside another page.");
  }
  var wide = window.matchMedia("(min-width: 900px) and (min-height: 560px)");
  var set = function () { document.documentElement.classList.toggle("wide", wide.matches); };
  set();
  if (wide.addEventListener) wide.addEventListener("change", set); else if (wide.addListener) wide.addListener(set);
})();
