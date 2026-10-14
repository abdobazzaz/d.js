// Refill-to-invoice cycle control. Records live in Supabase (tables vend_cycles, vend_cycle_lines, vend_cycle_events).
// The server talks to Supabase with the service key; the browser never sees it.
const fetch = require('node-fetch');

const STAGES = ['issued', 'received', 'refilled', 'cloud_updated', 'checked', 'paid', 'invoiced', 'closed'];
const STAGE_TS = { received: 'received_at', refilled: 'refilled_at', cloud_updated: 'cloud_updated_at', checked: 'checked_at', paid: 'paid_at', invoiced: 'invoiced_at', closed: 'closed_at' };

module.exports = function mountCycles(app, { CFG, getOrdersCached, getProductCode, getSlots }) {
  const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const configured = () => !!(URL_ && KEY);

  async function sb(method, table, { query = '', body } = {}) {
    const r = await fetch(`${URL_}/rest/v1/${table}${query}`, {
      method,
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: 20000,
    });
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(j && j.message) || String(t).slice(0, 200)}`);
    return j;
  }

  const need = (req, res, next) => configured() ? next() : res.status(503).json({ error: 'Cycle records are not switched on yet: add SUPABASE_URL and SUPABASE_SERVICE_KEY in Render → Environment.' });
  const codes = () => CFG.products.map(p => p.code);
  const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
  const chinaTime = iso => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().substring(0, 19).replace('T', ' ');

  // Live stock in the machine, per product, from the machine cloud.
  async function liveStock() {
    const m = {};
    for (const sl of await getSlots()) {
      if (!sl.sku || sl.disabled) continue;
      const o = m[sl.sku] || (m[sl.sku] = { stock: 0, capacity: 0, free: 0 });
      o.stock += sl.amount; o.capacity += sl.vol; o.free += sl.free;
    }
    return m;
  }
  // Completed orders paid since a moment, per product.
  async function salesSince(iso) {
    const since = chinaTime(iso);
    const sold = {}; let amount = 0, units = 0;
    for (const o of await getOrdersCached()) {
      if (o.order_status != 5 || (o.pay_time || '') < since) continue;
      const g = (o.goods && o.goods[0]) || {};
      const p = getProductCode(g.goods_name || '');
      amount += parseFloat(o.order_amount || 0); units++;
      if (p) sold[p.code] = (sold[p.code] || 0) + 1;
    }
    return { sold, amount, units, since };
  }
  // Expected machine stock = stock when requested + refilled - sold since then.
  function reconcile(lines, live, sold) {
    return lines.map(l => {
      if (l.stock_before == null) return { product_code: l.product_code, expected: null, live: live ? (live[l.product_code]?.stock ?? null) : null, diff: null, sold_since: sold[l.product_code] || 0 };
      const soldN = sold[l.product_code] || 0;
      const expected = l.stock_before + (l.qty_refilled || 0) - soldN;
      const lv = live ? (live[l.product_code]?.stock ?? null) : null;
      return { product_code: l.product_code, expected, live: lv, diff: lv == null ? null : lv - expected, sold_since: soldN };
    });
  }

  app.get('/api/cycles/live', need, async (req, res) => {
    try { res.json({ live: await liveStock() }); } catch (e) { res.status(502).json({ error: 'Machine cloud not reachable: ' + e.message }); }
  });

  app.get('/api/cycles/meta', (req, res) => res.json({
    configured: configured(), stages: STAGES,
    products: CFG.products.map(p => ({ code: p.code, name: p.name, emoji: p.emoji || '' })),
  }));

  app.get('/api/cycles', need, async (req, res) => {
    try {
      const rows = await sb('GET', 'vend_cycles', { query: '?select=*,vend_cycle_lines(*)&order=issued_at.desc&limit=100' });
      res.json({ cycles: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cycles/:id', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const rows = await sb('GET', 'vend_cycles', { query: `?id=eq.${id}&select=*,vend_cycle_lines(*),vend_cycle_events(*)` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const cy = rows[0];
      cy.vend_cycle_events.sort((a, b) => a.at.localeCompare(b.at));
      cy.recon = null;
      if (!['closed', 'cancelled', 'checked', 'paid', 'invoiced'].includes(cy.stage)) {
        try {
          const [live, sales] = await Promise.all([liveStock(), salesSince(cy.issued_at)]);
          cy.recon = reconcile(cy.vend_cycle_lines, live, sales.sold);
        } catch (e) { cy.recon_error = e.message; }
      }
      res.json(cy);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/cycles', need, async (req, res) => {
    const b = req.body || {};
    const salesman = String(b.salesman || '').trim().slice(0, 80);
    const ref = String(b.d365_issue_ref || '').trim().slice(0, 80);
    const notes = String(b.notes || '').trim().slice(0, 500);
    if (!salesman) return res.status(400).json({ error: 'Enter the salesman' });
    if (!ref) return res.status(400).json({ error: 'Enter the D365 issue reference' });
    const lines = [];
    for (const l of Array.isArray(b.lines) ? b.lines : []) {
      const q = intIn(l.qty, 1, 999);
      if (!codes().includes(l.product_code) || q === null) continue;
      lines.push({ product_code: l.product_code, qty_issued: q });
    }
    if (!lines.length) return res.status(400).json({ error: 'Enter at least one product quantity' });
    const day = new Date(Date.now() + 3 * 3600000).toISOString().substring(0, 10).replace(/-/g, '');
    try {
      let cycle;
      for (let i = 0; i < 3 && !cycle; i++) {
        const no = `C-${day}-${100 + Math.floor(Math.random() * 900)}`;
        try { cycle = (await sb('POST', 'vend_cycles', { body: { cycle_no: no, salesman, d365_issue_ref: ref, notes: notes || null, device_id: String(CFG.deviceId) } }))[0]; }
        catch (e) { if (!/23505|duplicate/i.test(e.message)) throw e; }
      }
      if (!cycle) throw new Error('Could not allocate a cycle number, try again');
      let live = null; try { live = await liveStock(); } catch (e) { /* machine cloud unreachable: snapshot stays empty */ }
      await sb('POST', 'vend_cycle_lines', { body: lines.map(l => ({ ...l, cycle_id: cycle.id, stock_before: live && live[l.product_code] ? live[l.product_code].stock : null })) });
      await sb('POST', 'vend_cycle_events', { body: { cycle_id: cycle.id, stage: 'issued', actor: salesman, note: `D365 issue ${ref}`, payload: { lines } } });
      res.json({ ok: true, id: cycle.id, cycle_no: cycle.cycle_no });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/cycles/:id/advance', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    const note = String(b.note || '').trim().slice(0, 500) || null;
    try {
      const rows = await sb('GET', 'vend_cycles', { query: `?id=eq.${id}&select=*,vend_cycle_lines(*)` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const cy = rows[0];
      const lines = cy.vend_cycle_lines;
      let to = String(b.to || '');
      const patch = {};
      const payload = {};

      if (to === 'cancelled') {
        if (cy.stage === 'closed' || cy.stage === 'cancelled') return res.status(409).json({ error: 'This cycle is already finished' });
        if (!note) return res.status(400).json({ error: 'Write the reason for cancelling' });
      } else {
        const next = STAGES[STAGES.indexOf(cy.stage) + 1];
        if (!next || to !== next) return res.status(409).json({ error: `Next step for this cycle is "${next || 'none'}"` });
      }
      patch.stage = to;
      if (STAGE_TS[to]) patch[STAGE_TS[to]] = new Date().toISOString();
      if (to === 'cancelled') patch.closed_at = new Date().toISOString();

      const lineUpdates = [];
      const qtyMap = (field, base) => {
        for (const l of lines) {
          const given = b.qty && b.qty[l.product_code] !== undefined ? intIn(b.qty[l.product_code], 0, 999) : l[base];
          if (given === null || given === undefined) return `Bad quantity for ${l.product_code}`;
          lineUpdates.push({ product_code: l.product_code, [field]: given });
        }
        return null;
      };

      if (to === 'received') { const err = qtyMap('qty_received', 'qty_issued'); if (err) return res.status(400).json({ error: err }); payload.lines = lineUpdates; }
      if (to === 'refilled') { const err = qtyMap('qty_refilled', 'qty_received'); if (err) return res.status(400).json({ error: err }); payload.lines = lineUpdates; }
      if (to === 'cloud_updated') {
        let live;
        try { live = await liveStock(); } catch (e) { return res.status(502).json({ error: 'Cannot read the machine cloud to compare stock: ' + e.message }); }
        const sales = await salesSince(cy.issued_at);
        const rec = reconcile(lines, live, sales.sold);
        const bad = rec.filter(r => r.diff != null && r.diff !== 0);
        if (bad.length && !note) return res.status(409).json({ error: 'Machine stock does not match this cycle: ' + bad.map(r => `${r.product_code} shows ${r.live}, expected ${r.expected}`).join('; ') + '. Fix it in the Refill tab, or write a note to confirm anyway.', mismatch: bad });
        for (const r of rec) lineUpdates.push({ product_code: r.product_code, stock_after: r.live });
        payload.reconcile = rec;
      }
      if (to === 'checked') {
        const since = chinaTime(cy.refilled_at);
        const done = (await getOrdersCached()).filter(o => o.order_status == 5 && (o.pay_time || '') >= since);
        const sold = {}; let amount = 0, units = 0;
        for (const o of done) {
          const g = (o.goods && o.goods[0]) || {};
          const p = getProductCode(g.goods_name || '');
          amount += parseFloat(o.order_amount || 0); units++;
          if (p) sold[p.code] = (sold[p.code] || 0) + 1;
        }
        for (const l of lines) lineUpdates.push({ product_code: l.product_code, qty_sold: sold[l.product_code] || 0 });
        patch.actual_sold_units = units;
        patch.actual_amount = +amount.toFixed(2);
        payload.sold = sold; payload.since_china_time = since;
      }
      if (to === 'paid') {
        const pos = Number(b.pos_amount);
        if (!Number.isFinite(pos) || pos < 0 || pos > 1e7) return res.status(400).json({ error: 'Enter the amount confirmed in the POS' });
        patch.expected_amount = +pos.toFixed(2);
        patch.gap_amount = +(pos - Number(cy.actual_amount || 0)).toFixed(2);
        payload.pos_amount = patch.expected_amount; payload.gap = patch.gap_amount;
      }
      if (to === 'invoiced') {
        const inv = String(b.invoice_ref || '').trim().slice(0, 80);
        if (!inv) return res.status(400).json({ error: 'Enter the sales invoice number' });
        patch.invoice_ref = inv; payload.invoice_ref = inv;
      }

      // The stage filter makes a double click or a second user fail instead of overwriting.
      const upd = await sb('PATCH', 'vend_cycles', { query: `?id=eq.${id}&stage=eq.${cy.stage}`, body: patch });
      if (!upd.length) return res.status(409).json({ error: 'Someone else just changed this cycle. Reload and check.' });
      for (const u of lineUpdates) {
        const { product_code, ...fields } = u;
        await sb('PATCH', 'vend_cycle_lines', { query: `?cycle_id=eq.${id}&product_code=eq.${encodeURIComponent(product_code)}`, body: fields });
      }
      await sb('POST', 'vend_cycle_events', { body: { cycle_id: id, stage: to, actor: 'dashboard', note, payload } });
      res.json({ ok: true, stage: to });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
