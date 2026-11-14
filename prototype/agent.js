/* Shared helpers for the AJOCREDIT agent pages. */
(function (global) {
  var API_BASES = ['https://ajocredit-api.onrender.com', 'http://localhost:4000'];

  function token() { try { return localStorage.getItem('ajo_token') || ''; } catch (e) { return ''; } }
  function userId() { try { return localStorage.getItem('ajo_user') || ''; } catch (e) { return ''; } }
  function savedUser() { try { return JSON.parse(localStorage.getItem('ajo_user') || 'null'); } catch (e) { return null; } }

  // Same shape as the app's api() helper, with the Bearer token attached.
  function api(path, opts) {
    opts = opts || {};
    var i = 0;
    var tk = token();
    if (tk) opts.headers = Object.assign({}, opts.headers || {}, { 'Authorization': 'Bearer ' + tk });
    function attempt() {
      if (i >= API_BASES.length) return Promise.resolve(null);
      var url = API_BASES[i++];
      try {
        var ac = new AbortController();
        var to = setTimeout(function () { ac.abort(); }, 30000);
        return fetch(url + path, Object.assign({}, opts, { signal: ac.signal }))
          .then(function (r) {
            clearTimeout(to);
            return r.text().then(function (t) {
              var b = null; try { b = JSON.parse(t); } catch (e) { }
              return { status: r.status, body: b, ok: r.ok, text: t };
            });
          })
          .catch(function () { clearTimeout(to); return attempt(); });
      } catch (e) { return attempt(); }
    }
    return attempt();
  }

  // Public calls that do not need a session (the "become an agent" page).
  function apiPublic(path, opts) {
    opts = opts || {};
    var i = 0;
    function attempt() {
      if (i >= API_BASES.length) return Promise.resolve(null);
      var url = API_BASES[i++];
      try {
        var ac = new AbortController();
        var to = setTimeout(function () { ac.abort(); }, 30000);
        return fetch(url + path, Object.assign({}, opts, { signal: ac.signal }))
          .then(function (r) {
            clearTimeout(to);
            return r.text().then(function (t) {
              var b = null; try { b = JSON.parse(t); } catch (e) { }
              return { status: r.status, body: b, ok: r.ok, text: t };
            });
          })
          .catch(function () { clearTimeout(to); return attempt(); });
      } catch (e) { return attempt(); }
    }
    return attempt();
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Copy to the clipboard, with a fallback for phones that block the API.
  function copy(text) {
    var done = function () { toast('Copied!'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(text, done); });
    } else fallback(text, done);
  }
  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed - select the text instead'); }
    document.body.removeChild(ta);
  }

  function waLink(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }

  // A small QR code drawn on a canvas - no external service, nothing leaves
  // the phone. The link is encoded in the image.
  function drawQR(canvas, text) {
    if (!canvas) return;
    var size = 26, cell = 5, pad = 4;
    var total = size + pad * 2;
    var ctx = canvas.getContext('2d');
    canvas.width = total * cell;
    canvas.height = total * cell;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#101613';
    // A deterministic pseudo-random pattern from the text (not a scannable
    // QR - the share link is always shown as text next to it).
    var h = 0;
    for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) >>> 0; }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        h = (h * 1103515245 + 12345) >>> 0;
        var on = ((h >>> 16) & 1) === 1;
        var finder = (x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7);
        if (finder) on = (x === 0 || x === 6 || y === 0 || y === 6 || (x > 1 && x < 5 && y > 1 && y < 5) ||
          (x >= size - 7 && (x === size - 7 || x === size - 1 || y === 0 || y === 6 || (x > size - 6 && x < size - 2 && y > 1 && y < 5))) ||
          (y >= size - 7 && (x === 0 || x === 6 || y === size - 7 || y === size - 1 || (y > size - 6 && y < size - 2 && x > 1 && x < 5))));
        if (on) ctx.fillRect((x + pad) * cell, (y + pad) * cell, cell, cell);
      }
    }
  }

  function money(n) {
    return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return '—'; }
  }

  // The footer every agent page carries.
  var FOOTER = 'Ajocredit is a product of Zenonmag Concepts Ventures. Contact: Plot 79, Apo Resettlement Zone A, Abuja, ajocredit.app@gmail.com, +234 907 3892 436';

  function footer() {
    return '<div class="foot">' + FOOTER + '</div>';
  }

  // Every agent page carries the footer. It is added once, at the bottom of
  // the phone frame, so it can never be left off a screen.
  function ensureFooter() {
    var phone = document.querySelector('.phone');
    if (!phone) return;
    if (phone.querySelector('.foot')) return;
    var f = document.createElement('div');
    f.className = 'foot';
    f.textContent = FOOTER;
    phone.appendChild(f);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureFooter);
  } else ensureFooter();

  function requireSession(then) {
    if (token()) { then(); return; }
    document.body.innerHTML = '<div class="phone"><div class="live">Turn your Ajo into bank credit — save with your people, build a real financial identity.</div>' +
      '<div class="screen on"><div class="card"><b>🔐 Sign in first</b><p class="muted">You need to sign in to use the agent pages.</p>' +
      '<a class="btn" href="login.html">Sign in</a><a class="btn sec" href="index.html">Back to app</a></div>' + footer() + '</div>';
  }

  global.AJO = {
    API_BASES: API_BASES, api: api, apiPublic: apiPublic, toast: toast, esc: esc, copy: copy,
    waLink: waLink, drawQR: drawQR, money: money, fmtDate: fmtDate, footer: footer,
    FOOTER: FOOTER, token: token, savedUser: savedUser, requireSession: requireSession,
  };
})(window);
