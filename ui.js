/* Shared header, tab pills and range picker for Sales / Refill pages */
(function () {
  var ICON = {
    monitor: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    sales: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    planogram: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    invoicing: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/>',
    cycles: '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5"/>',
    refill: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>'
  };
  var TABS = [['monitor', '/', 'Monitor'], ['planogram', '/planogram', 'Planogram'], ['refill', '/refill', 'Refill'], ['invoicing', '/invoicing', 'Invoicing'], ['sales', '/sales', 'Sales History']];
  var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr']; // Saturday-first

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function parse(s) { var p = s.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }
  function ksaNow() { return new Date(Date.now() + 3 * 3600 * 1000); }
  function todayISO() { var n = ksaNow(); return iso(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); }
  function addDays(s, n) { var p = parse(s); var t = new Date(Date.UTC(p.y, p.m, p.d + n)); return iso(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); }
  function nice(s) { var p = parse(s); return p.d + ' ' + MS[p.m] + ' ' + p.y; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function header(active, opts) {
    opts = opts || {};
    var el = document.getElementById('hdr');
    if (!el) return;
    var pills = TABS.map(function (t) {
      return '<a class="pill' + (t[0] === active ? ' on' : '') + '" href="' + t[1] + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[t[0]] + '</svg>' + t[2] + '</a>';
    }).join('');
    el.className = 'hdr';
    el.innerHTML = '<div class="hdr-in"><div class="hdr-top"><div class="brand"><img src="/logo.png" alt="Radwa" onerror="this.style.display=\'none\'"><div><div class="title">Vending Machine Monitor</div><div class="sub">' + esc(opts.sub || 'Dahban · Machine 203617400') + '</div></div></div><div class="actions" id="hdr-actions"></div></div><div class="pills">' + pills + '</div></div>';
    return document.getElementById('hdr-actions');
  }

  var PRESETS = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'],
    ['month', 'This month'], ['lastmonth', 'Last month']
  ];
  function presetRange(k) {
    var t = todayISO(), p = parse(t);
    if (k === 'today') return [t, t];
    if (k === 'yesterday') { var y = addDays(t, -1); return [y, y]; }
    if (k === '7d') return [addDays(t, -6), t];
    if (k === '30d') return [addDays(t, -29), t];
    if (k === 'month') return [iso(p.y, p.m, 1), t];
    if (k === 'lastmonth') {
      var lm = new Date(Date.UTC(p.y, p.m - 1, 1)), le = new Date(Date.UTC(p.y, p.m, 0));
      return [iso(lm.getUTCFullYear(), lm.getUTCMonth(), 1), iso(le.getUTCFullYear(), le.getUTCMonth(), le.getUTCDate())];
    }
    return [t, t];
  }

  // host: element; cfg: {from,to,onChange(from,to)}
  function rangePicker(host, cfg) {
    var from = cfg.from, to = cfg.to, pending = false;
    var vp = parse(from), vy = vp.y, vm = vp.m; // left month
    host.className = 'rp';
    host.innerHTML = '<button type="button" class="rp-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#57534e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg><span></span></button><div class="rp-pop"></div>';
    var btn = host.querySelector('.rp-btn'), pop = host.querySelector('.rp-pop'), lab = btn.querySelector('span');

    function label() { lab.textContent = from === to ? nice(from) : nice(from) + '  →  ' + nice(to); }
    function activePreset() {
      for (var i = 0; i < PRESETS.length; i++) { var r = presetRange(PRESETS[i][0]); if (r[0] === from && r[1] === to) return PRESETS[i][0]; }
      return '';
    }
    function month(y, m, left, right) {
      var first = new Date(Date.UTC(y, m, 1)), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      var lead = (first.getUTCDay() + 1) % 7; // Saturday = 0
      var h = '<div><div class="rp-mh">' + (left ? '<button type="button" class="rp-nav" data-nav="-1">‹</button>' : '<span class="rp-nav hide"></span>') +
        '<b>' + MON[m] + ' ' + y + '</b>' + (right ? '<button type="button" class="rp-nav" data-nav="1">›</button>' : '<span class="rp-nav hide"></span>') + '</div><div class="rp-grid">';
      WD.forEach(function (w) { h += '<div class="rp-w">' + w + '</div>'; });
      for (var i = 0; i < lead; i++) h += '<div></div>';
      for (var d = 1; d <= days; d++) {
        var s = iso(y, m, d), c = 'rp-d';
        if (s === from || s === to) c += ' end'; else if (s > from && s < to) c += ' mid';
        h += '<div class="' + c + '" data-d="' + s + '">' + d + '</div>';
      }
      return h + '</div></div>';
    }
    function draw() {
      var ny = vm === 11 ? vy + 1 : vy, nm = (vm + 1) % 12, ap = activePreset();
      pop.innerHTML = '<div class="rp-pre"><h4>Quick select</h4>' + PRESETS.map(function (p) {
        return '<button type="button" class="rp-chip' + (ap === p[0] ? ' on' : '') + '" data-p="' + p[0] + '">' + p[1] + '</button>';
      }).join('') + '</div><div><div class="rp-fields"><div class="rp-field"><label>From</label><div class="' + (pending ? '' : 'act') + '">' + nice(from) + '</div></div><span class="rp-arrow">→</span><div class="rp-field"><label>To</label><div class="' + (pending ? 'act' : '') + '">' + (pending ? 'Pick end date' : nice(to)) + '</div></div></div>' +
        '<div class="rp-months">' + month(vy, vm, true, false) + month(ny, nm, false, true) + '</div>' +
        '<div class="rp-foot"><span class="sw"></span><small>Selected range · weeks start Saturday</small><span class="sp"></span><button type="button" class="btn" data-x="cancel">Cancel</button><button type="button" class="btn green" data-x="apply">Apply</button></div></div>';
    }
    function open() { pop.classList.add('open'); btn.classList.add('open'); draw(); }
    function close() { pop.classList.remove('open'); btn.classList.remove('open'); pending = false; }
    function apply() { pending = false; label(); close(); if (cfg.onChange) cfg.onChange(from, to); }

    btn.addEventListener('click', function (e) { e.stopPropagation(); pop.classList.contains('open') ? close() : open(); });
    pop.addEventListener('click', function (e) {
      e.stopPropagation();
      var t = e.target;
      if (t.dataset.nav) { vm += +t.dataset.nav; if (vm < 0) { vm = 11; vy--; } if (vm > 11) { vm = 0; vy++; } draw(); return; }
      if (t.dataset.p) { var r = presetRange(t.dataset.p); from = r[0]; to = r[1]; apply(); return; }
      if (t.dataset.x === 'apply') { apply(); return; }
      if (t.dataset.x === 'cancel') { close(); return; }
      if (t.dataset.d) {
        var s = t.dataset.d;
        if (!pending) { from = to = s; pending = true; }
        else { if (s < from) { to = from; from = s; } else to = s; pending = false; }
        draw();
      }
    });
    document.addEventListener('click', function () { if (pop.classList.contains('open')) close(); });
    label();
    return { get: function () { return [from, to]; }, set: function (f, t) { from = f; to = t; label(); } };
  }

  // tiny fetch helper
  function getJSON(url) {
    return fetch(url).then(function (r) { return r.json(); });
  }

  window.RUI = { header: header, rangePicker: rangePicker, presetRange: presetRange, todayISO: todayISO, addDays: addDays, nice: nice, esc: esc, getJSON: getJSON };
})();
