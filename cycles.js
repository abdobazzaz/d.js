// Stock requests (request -> receive -> refill -> cloud matched) and sales settlements
// (sales check -> POS payment -> invoice -> closed) are two separate tracks.
// A settlement can cover several stock requests, so you can request twice and invoice once.
// Records live in Supabase (vend_* tables); the server uses the service key, the browser never sees it.
const fetch = require('node-fetch');

const STAGES = ['issued', 'received', 'refilled', 'cloud_updated'];      // stock request
const S_STAGES = ['checked', 'paid', 'invoiced', 'closed'];              // settlement
const S_TS = { paid: 'paid_at', invoiced: 'invoiced_at', closed: 'closed_at' };

module.exports = function mountCycles(app, { CFG, getOrdersCached, getProductCode, getSlots, applyToMachine, machineLock, roleName }) {
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
  const who = req => (roleName ? roleName(req) : 'dashboard');
  const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
  const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
  const chinaTime = iso => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().substring(0, 19).replace('T', ' ');
  const ksaDay = () => new Date(Date.now() + 3 * 3600000).toISOString().substring(0, 10).replace(/-/g, '');

  // ── live machine stock and sales helpers ────────────────────────────────
  async function liveStock() {
    const m = {};
    for (const sl of await getSlots()) {
      if (!sl.sku || sl.disabled) continue;
      const o = m[sl.sku] || (m[sl.sku] = { stock: 0, capacity: 0, free: 0 });
      o.stock += sl.amount; o.capacity += sl.vol; o.free += sl.free;
    }
    return m;
  }
  // Completed orders paid in [fromISO, toISO). toISO may be omitted (= until now).
  async function salesBetween(fromISO, toISO) {
    const a = chinaTime(fromISO), b = toISO ? chinaTime(toISO) : '9999';
    const sold = {}; let amount = 0, units = 0;
    for (const o of await getOrdersCached()) {
      const t = o.pay_time || '';
      if (o.order_status != 5 || t < a || t >= b) continue;
      const g = (o.goods && o.goods[0]) || {};
      const p = getProductCode(g.goods_name || '');
      amount += parseFloat(o.order_amount || 0); units++;
      if (p) sold[p.code] = (sold[p.code] || 0) + 1;
    }
    return { sold, amount: +amount.toFixed(2), units };
  }
  // Expected machine stock = stock when requested + refilled - sold since then.
  function reconcile(lines, live, sold) {
    return lines.map(l => {
      const soldN = sold[l.product_code] || 0;
      const lv = live ? (live[l.product_code]?.stock ?? null) : null;
      if (l.stock_before == null) return { product_code: l.product_code, expected: null, live: lv, diff: null, sold_since: soldN };
      const expected = l.stock_before + (l.qty_refilled || 0) - soldN;
      return { product_code: l.product_code, expected, live: lv, diff: lv == null ? null : lv - expected, sold_since: soldN };
    });
  }

  app.get('/api/cycles/live', need, async (req, res) => {
    try { res.json({ live: await liveStock() }); } catch (e) { res.status(502).json({ error: 'Machine cloud not reachable: ' + e.message }); }
  });

  app.get('/api/cycles/meta', (req, res) => res.json({
    configured: configured(), stages: STAGES, sStages: S_STAGES,
    products: CFG.products.map(p => ({ code: p.code, name: p.name, emoji: p.emoji || '' })),
  }));

  // ═══ SECTION 1: stock requests ═══════════════════════════════════════════
  app.get('/api/cycles', need, async (req, res) => {
    try {
      const rows = await sb('GET', 'vend_cycles', { query: '?select=*,vend_cycle_lines(*),vend_settlements(settlement_no,stage)&order=issued_at.desc&limit=100' });
      res.json({ cycles: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cycles/:id', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const rows = await sb('GET', 'vend_cycles', { query: `?id=eq.${id}&select=*,vend_cycle_lines(*),vend_cycle_events(*),vend_settlements(settlement_no,stage)` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const cy = rows[0];
      cy.vend_cycle_events.sort((a, b) => a.at.localeCompare(b.at));
      // Older requests may lack the stock-at-request snapshot or some products. Before anything is refilled,
      // stock at request time = live stock now + sold since the request, so it can be rebuilt safely.
      if (['issued', 'received'].includes(cy.stage)) {
        const missing = codes().filter(c => !cy.vend_cycle_lines.some(l => l.product_code === c));
        const nullBefore = cy.vend_cycle_lines.filter(l => l.stock_before == null);
        if (missing.length || nullBefore.length) {
          try {
            const [live, sales] = await Promise.all([liveStock(), salesBetween(cy.issued_at)]);
            const before = c => live[c] ? live[c].stock + (sales.sold[c] || 0) : null;
            for (const l of nullBefore) {
              const v = before(l.product_code);
              if (v == null) continue;
              await sb('PATCH', 'vend_cycle_lines', { query: `?id=eq.${l.id}&stock_before=is.null`, body: { stock_before: v } });
              l.stock_before = v;
            }
            if (missing.length) cy.vend_cycle_lines.push(...await sb('POST', 'vend_cycle_lines', { body: missing.map(c => ({ cycle_id: cy.id, product_code: c, qty_issued: 0, stock_before: before(c) })) }));
          } catch (e) { /* machine cloud unreachable: try again next time */ }
        }
      }
      cy.vend_cycle_lines.sort((a, b) => a.product_code.localeCompare(b.product_code));
      cy.recon = null;
      if (cy.stage !== 'cancelled') {
        try {
          const [live, sales] = await Promise.all([liveStock(), salesBetween(cy.issued_at)]);
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
    const want = {};
    for (const l of Array.isArray(b.lines) ? b.lines : []) {
      const q = intIn(l.qty, 1, 999);
      if (codes().includes(l.product_code) && q !== null) want[l.product_code] = q;
    }
    if (!Object.keys(want).length) return res.status(400).json({ error: 'Enter at least one product quantity' });
    // Every product gets a line (0 if not requested) so the whole machine is tracked and compared with live stock.
    const lines = codes().map(c => ({ product_code: c, qty_issued: want[c] || 0 }));
    try {
      let cycle;
      for (let i = 0; i < 3 && !cycle; i++) {
        const no = `C-${ksaDay()}-${100 + Math.floor(Math.random() * 900)}`;
        try { cycle = (await sb('POST', 'vend_cycles', { body: { cycle_no: no, salesman, d365_issue_ref: ref, notes: notes || null, device_id: String(CFG.deviceId) } }))[0]; }
        catch (e) { if (!/23505|duplicate/i.test(e.message)) throw e; }
      }
      if (!cycle) throw new Error('Could not allocate a request number, try again');
      let live = null; try { live = await liveStock(); } catch (e) { /* machine cloud unreachable: snapshot stays empty */ }
      await sb('POST', 'vend_cycle_lines', { body: lines.map(l => ({ ...l, cycle_id: cycle.id, stock_before: live && live[l.product_code] ? live[l.product_code].stock : null })) });
      await sb('POST', 'vend_cycle_events', { body: { cycle_id: cycle.id, stage: 'issued', actor: salesman, note: `D365 issue ${ref}`, payload: { lines } } });
      res.json({ ok: true, id: cycle.id, cycle_no: cycle.cycle_no });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── refill against a received request: the salesman taps + on the planogram; writes to the machine and counts the units ──
  app.get('/api/refill/slots', async (req, res) => {
    try { res.json({ slots: await getSlots() }); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  const REFILL_SEEN = new Map();
  app.post('/api/cycles/:id/refill', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    const token = String(req.body?.token || '');
    if (token && REFILL_SEEN.has(token)) return res.json({ ...REFILL_SEEN.get(token), duplicate: true });
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length || changes.length > 64) return res.status(400).json({ error: 'Nothing to refill' });
    try {
      const out = await machineLock(async () => {
        const rows = await sb('GET', 'vend_cycles', { query: `?id=eq.${id}&select=*,vend_cycle_lines(*)` });
        if (!rows.length) { const e = new Error('Not found'); e.code = 404; throw e; }
        const cy = rows[0];
        if (cy.stage !== 'received') { const e = new Error(cy.stage === 'issued' ? 'Confirm receipt of the stock first' : 'This request is not open for refilling (stage: ' + cy.stage + ')'); e.code = 409; throw e; }
        const byId = new Map((await getSlots()).map(s => [s.id, s]));
        const left = {};
        for (const l of cy.vend_cycle_lines) left[l.product_code] = (l.qty_received || 0) - (l.qty_refilled || 0);
        const plan = [], seen = new Set(), add = {};
        for (const c of changes) {
          const s = byId.get(String(c.id)), d = Number(c.delta);
          const bad = m => { const e = new Error(m); e.code = 400; throw e; };
          if (!s) bad('Unknown slot ' + c.id);
          if (seen.has(s.id)) bad('Slot ' + s.label + ' listed twice'); seen.add(s.id);
          if (!Number.isInteger(d) || d < 1) continue;
          if (!s.active) bad('Slot ' + s.label + ' is not active and cannot be refilled');
          if (s.disabled) bad('Slot ' + s.label + ' is disabled on the platform');
          if (!s.sku) bad('Slot ' + s.label + ' has no product');
          if (s.amount + d > s.vol) bad(`Slot ${s.label}: ${s.amount} +${d} is more than its capacity ${s.vol}`);
          add[s.sku] = (add[s.sku] || 0) + d;
          if (add[s.sku] > (left[s.sku] || 0)) bad(`${s.sku}: only ${left[s.sku] || 0} unit(s) still to refill from this request, you are adding ${add[s.sku]}`);
          plan.push({ s, delta: d, after: s.amount + d });
        }
        if (!plan.length) { const e = new Error('Nothing to refill'); e.code = 400; throw e; }
        const results = await applyToMachine(plan);
        const done = {};
        results.forEach((r, i) => { if (r.ok) done[plan[i].s.sku] = (done[plan[i].s.sku] || 0) + plan[i].delta; });
        for (const l of cy.vend_cycle_lines) if (done[l.product_code]) await sb('PATCH', 'vend_cycle_lines', { query: `?id=eq.${l.id}`, body: { qty_refilled: (l.qty_refilled || 0) + done[l.product_code] } });
        const total = Object.values(done).reduce((a, b) => a + b, 0);
        if (total) await sb('POST', 'vend_cycle_events', { body: { cycle_id: id, stage: 'refill_batch', actor: who(req), note: 'Refilled +' + total, payload: { slots: results.map((r, i) => ({ label: r.label, delta: r.delta, before: r.before, after: r.after, ok: r.ok })), by_product: done } } });
        return { ok: results.every(r => r.ok) && results.length === plan.length, results, added: total, skipped: plan.length - results.length };
      });
      if (token) { REFILL_SEEN.set(token, out); setTimeout(() => REFILL_SEEN.delete(token), 600000); }
      res.status(out.ok ? 200 : 502).json(out);
    } catch (e) { res.status(e.code && e.code < 600 ? e.code : 500).json({ error: e.message }); }
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
      const to = String(b.to || '');
      const patch = {}, payload = {}, lineUpdates = [];

      if (to === 'cancelled') {
        if (cy.stage === 'cancelled') return res.status(409).json({ error: 'This request is already cancelled' });
        if (cy.settlement_id) return res.status(409).json({ error: 'This request is part of a sales settlement. Cancel the settlement first.' });
        if (!note) return res.status(400).json({ error: 'Write the reason for cancelling' });
        patch.closed_at = new Date().toISOString();
      } else {
        const next = STAGES[STAGES.indexOf(cy.stage) + 1];
        if (cy.stage === 'cancelled' || !next || to !== next) return res.status(409).json({ error: `Next step for this request is "${next || 'none'}"` });
        if (['received', 'refilled', 'cloud_updated'].includes(to)) patch[to === 'cloud_updated' ? 'cloud_updated_at' : to + '_at'] = new Date().toISOString();
      }
      patch.stage = to;

      const qtyMap = (field, base) => {
        for (const l of lines) {
          const given = b.qty && b.qty[l.product_code] !== undefined ? intIn(b.qty[l.product_code], 0, 999) : l[base];
          if (given === null || given === undefined) return `Bad quantity for ${l.product_code}`;
          lineUpdates.push({ product_code: l.product_code, [field]: given });
        }
        return null;
      };
      if (to === 'received') { const err = qtyMap('qty_received', 'qty_issued'); if (err) return res.status(400).json({ error: err }); payload.lines = lineUpdates.slice(); }
      if (to === 'refilled') {
        // quantities come from the planogram refills already recorded on the request
        const short = lines.filter(l => (l.qty_refilled || 0) < (l.qty_received || 0));
        if (short.length && !note) return res.status(409).json({ error: 'Not everything received was refilled (' + short.map(l => `${l.product_code} ${l.qty_refilled || 0} of ${l.qty_received || 0}`).join(', ') + '). Refill the rest on the planogram, or write the reason in the note.' });
        payload.lines = lines.map(l => ({ product_code: l.product_code, qty_received: l.qty_received, qty_refilled: l.qty_refilled || 0 }));
      }
      if (to === 'cloud_updated') {
        let live;
        try { live = await liveStock(); } catch (e) { return res.status(502).json({ error: 'Cannot read the machine cloud to compare stock: ' + e.message }); }
        const sales = await salesBetween(cy.issued_at);
        const rec = reconcile(lines, live, sales.sold);
        const bad = rec.filter(r => r.diff != null && r.diff !== 0);
        if (bad.length && !note) return res.status(409).json({ error: 'Machine stock does not match this request: ' + bad.map(r => `${r.product_code} shows ${r.live}, expected ${r.expected}`).join('; ') + '. Check the Planogram. An admin can correct a slot there, or write a note to confirm anyway.', mismatch: bad });
        for (const r of rec) lineUpdates.push({ product_code: r.product_code, stock_after: r.live });
        payload.reconcile = rec;
      }

      // The stage filter makes a double click or a second user fail instead of overwriting.
      const upd = await sb('PATCH', 'vend_cycles', { query: `?id=eq.${id}&stage=eq.${cy.stage}`, body: patch });
      if (!upd.length) return res.status(409).json({ error: 'Someone else just changed this request. Reload and check.' });
      for (const u of lineUpdates) {
        const { product_code, ...fields } = u;
        await sb('PATCH', 'vend_cycle_lines', { query: `?cycle_id=eq.${id}&product_code=eq.${encodeURIComponent(product_code)}`, body: fields });
      }
      await sb('POST', 'vend_cycle_events', { body: { cycle_id: id, stage: to, actor: who(req), note, payload } });
      res.json({ ok: true, stage: to });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══ SECTION 2: sales settlements ════════════════════════════════════════
  async function lastPeriodEnd() {
    const r = await sb('GET', 'vend_settlements', { query: '?stage=neq.cancelled&select=period_to&order=period_to.desc&limit=1' });
    return r.length ? r[0].period_to : null;
  }

  // Stock requests that are finished and not invoiced yet, plus where the next period should start.
  app.get('/api/settlements/prepare', need, async (req, res) => {
    try {
      const [available, lastTo] = await Promise.all([
        sb('GET', 'vend_cycles', { query: '?stage=eq.cloud_updated&settlement_id=is.null&select=*,vend_cycle_lines(*)&order=issued_at.asc' }),
        lastPeriodEnd(),
      ]);
      res.json({ available, last_to: lastTo, now: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/settlements', need, async (req, res) => {
    try {
      const rows = await sb('GET', 'vend_settlements', { query: '?select=*,vend_cycles(id,cycle_no,salesman)&order=created_at.desc&limit=100' });
      res.json({ settlements: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/settlements/:id', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const rows = await sb('GET', 'vend_settlements', { query: `?id=eq.${id}&select=*,vend_settlement_lines(*),vend_settlement_events(*),vend_cycles(*,vend_cycle_lines(*))` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      rows[0].vend_settlement_events.sort((a, b) => a.at.localeCompare(b.at));
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/settlements', need, async (req, res) => {
    const b = req.body || {};
    const notes = String(b.notes || '').trim().slice(0, 500);
    const ids = [...new Set((Array.isArray(b.request_ids) ? b.request_ids : []).map(Number))];
    if (!ids.length || ids.length > 50 || ids.some(n => !Number.isInteger(n) || n < 1)) return res.status(400).json({ error: 'Pick at least one finished stock request' });
    const from = new Date(b.from), to = new Date(b.to);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Enter the period start and end' });
    if (to <= from) return res.status(400).json({ error: 'The period end must be after the start' });
    if (to.getTime() > Date.now() + 60000) return res.status(400).json({ error: 'The period end cannot be in the future' });
    try {
      const last = await lastPeriodEnd();
      if (last && from.getTime() < new Date(last).getTime() - 1000) return res.status(409).json({ error: 'This period overlaps the previous settlement, which ends ' + new Date(last).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' }) + ' (KSA). Start at or after that time so no sale is invoiced twice.' });
      const reqs = await sb('GET', 'vend_cycles', { query: `?id=in.(${ids.join(',')})&select=id,cycle_no,stage,settlement_id` });
      if (reqs.length !== ids.length) return res.status(400).json({ error: 'A selected stock request was not found' });
      const badReq = reqs.find(r => r.stage !== 'cloud_updated' || r.settlement_id);
      if (badReq) return res.status(409).json({ error: `${badReq.cycle_no} is not ready: it must be finished (cloud matched) and not already in a settlement.` });

      const sales = await salesBetween(from.toISOString(), to.toISOString());
      let st;
      for (let i = 0; i < 3 && !st; i++) {
        const no = `S-${ksaDay()}-${100 + Math.floor(Math.random() * 900)}`;
        try { st = (await sb('POST', 'vend_settlements', { body: { settlement_no: no, period_from: from.toISOString(), period_to: to.toISOString(), actual_sold_units: sales.units, actual_amount: sales.amount, notes: notes || null } }))[0]; }
        catch (e) { if (!/23505|duplicate/i.test(e.message)) throw e; }
      }
      if (!st) throw new Error('Could not allocate a settlement number, try again');
      try {
        await sb('POST', 'vend_settlement_lines', { body: codes().map(c => ({ settlement_id: st.id, product_code: c, qty_sold: sales.sold[c] || 0 })) });
        const linked = await sb('PATCH', 'vend_cycles', { query: `?id=in.(${ids.join(',')})&settlement_id=is.null&stage=eq.cloud_updated`, body: { settlement_id: st.id } });
        if (linked.length !== ids.length) throw new Error('A stock request changed while creating the settlement. Nothing was saved, try again.');
      } catch (e) {
        await sb('DELETE', 'vend_settlements', { query: `?id=eq.${st.id}` }).catch(() => {});   // lines go with it; requests unlink automatically
        throw e;
      }
      await sb('POST', 'vend_settlement_events', { body: { settlement_id: st.id, stage: 'checked', actor: who(req), note: notes || null, payload: { request_ids: ids, from: from.toISOString(), to: to.toISOString(), sold: sales.sold, amount: sales.amount } } });
      res.json({ ok: true, id: st.id, settlement_no: st.settlement_no });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Re-read the platform orders for the same period (late orders), only before POS payment is entered.
  app.post('/api/settlements/:id/recheck', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    try {
      const rows = await sb('GET', 'vend_settlements', { query: `?id=eq.${id}&select=*` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const st = rows[0];
      if (st.stage !== 'checked') return res.status(409).json({ error: 'Sales can only be re-read before the POS payment is entered' });
      const sales = await salesBetween(st.period_from, st.period_to);
      const upd = await sb('PATCH', 'vend_settlements', { query: `?id=eq.${id}&stage=eq.checked`, body: { actual_sold_units: sales.units, actual_amount: sales.amount, checked_at: new Date().toISOString() } });
      if (!upd.length) return res.status(409).json({ error: 'Someone else just changed this settlement. Reload.' });
      for (const c of codes()) await sb('PATCH', 'vend_settlement_lines', { query: `?settlement_id=eq.${id}&product_code=eq.${encodeURIComponent(c)}`, body: { qty_sold: sales.sold[c] || 0 } });
      await sb('POST', 'vend_settlement_events', { body: { settlement_id: id, stage: 'checked', actor: who(req), note: 'Sales re-read', payload: { sold: sales.sold, amount: sales.amount } } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/settlements/:id/advance', need, async (req, res) => {
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Bad id' });
    const b = req.body || {};
    const note = String(b.note || '').trim().slice(0, 500) || null;
    try {
      const rows = await sb('GET', 'vend_settlements', { query: `?id=eq.${id}&select=*` });
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const st = rows[0];
      const to = String(b.to || '');
      const patch = { stage: to }, payload = {};

      if (to === 'cancelled') {
        if (st.stage === 'closed' || st.stage === 'cancelled') return res.status(409).json({ error: 'This settlement is already finished' });
        if (!note) return res.status(400).json({ error: 'Write the reason for cancelling' });
        patch.closed_at = new Date().toISOString();
      } else {
        const next = S_STAGES[S_STAGES.indexOf(st.stage) + 1];
        if (st.stage === 'cancelled' || !next || to !== next) return res.status(409).json({ error: `Next step for this settlement is "${next || 'none'}"` });
        patch[S_TS[to]] = new Date().toISOString();
      }
      if (to === 'paid') {
        const pos = Number(b.pos_amount);
        if (b.pos_amount === '' || b.pos_amount === null || b.pos_amount === undefined || !Number.isFinite(pos) || pos < 0 || pos > 1e7) return res.status(400).json({ error: 'Enter the amount confirmed in the POS' });
        patch.pos_amount = +pos.toFixed(2);
        patch.gap_amount = +(pos - Number(st.actual_amount || 0)).toFixed(2);
        payload.pos_amount = patch.pos_amount; payload.gap = patch.gap_amount;
      }
      if (to === 'invoiced') {
        const inv = String(b.invoice_ref || '').trim().slice(0, 80);
        if (!inv) return res.status(400).json({ error: 'Enter the sales invoice number' });
        patch.invoice_ref = inv; payload.invoice_ref = inv;
      }
      const upd = await sb('PATCH', 'vend_settlements', { query: `?id=eq.${id}&stage=eq.${st.stage}`, body: patch });
      if (!upd.length) return res.status(409).json({ error: 'Someone else just changed this settlement. Reload and check.' });
      if (to === 'cancelled') await sb('PATCH', 'vend_cycles', { query: `?settlement_id=eq.${id}`, body: { settlement_id: null } });   // requests become available again
      await sb('POST', 'vend_settlement_events', { body: { settlement_id: id, stage: to, actor: who(req), note, payload } });
      res.json({ ok: true, stage: to });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
