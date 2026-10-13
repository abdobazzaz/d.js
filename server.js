// ╔══════════════════════════════════════════════════════════════╗
// ║          RADWA SMART VENDING - 24/7 MONITOR SERVER          ║
// ║                      Version 1.0.0                          ║
// ╚══════════════════════════════════════════════════════════════╝

const express    = require('express');
const fetch      = require('node-fetch');
const ExcelJS    = require('exceljs');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(express.json());

// ── ACCESS CONTROL: Monitor page is public; Sales, Refill, their APIs and debug routes need the PIN ──
const crypto = require('crypto');
const LOCKED = [/^\/sales(\/|$)/, /^\/refill(\/|$)/, /^\/api\/(sales|refills|slots|replenish)/, /^\/debug-/];
const accessToken = () => process.env.REFILL_PIN ? crypto.createHmac('sha256', process.env.REFILL_PIN).update('radwa-access-v1').digest('hex') : null;
function isAuthed(req) {
  const t = accessToken(); if (!t) return false;
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('rv='));
  const v = c ? c.slice(3) : '';
  return v.length === t.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(t));
}
app.use((req, res, next) => {
  if (!LOCKED.some(r => r.test(req.path)) || isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Locked: open /unlock and enter the PIN' });
  res.redirect('/unlock?next=' + encodeURIComponent(req.path));
});
const FAILS = new Map();
app.post('/api/unlock', (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const f = FAILS.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return res.status(429).json({ error: 'Too many attempts, try again in 15 minutes' });
  const pin = process.env.REFILL_PIN;
  if (!pin) return res.status(403).json({ error: 'No PIN is set on the server (REFILL_PIN)' });
  const h = x => crypto.createHash('sha256').update(String(x || '')).digest();
  if (!crypto.timingSafeEqual(h(req.body?.pin), h(pin))) { f.n++; FAILS.set(ip, f); return res.status(401).json({ error: 'Wrong PIN' }); }
  FAILS.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `rv=${accessToken()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/lock', (req, res) => { res.setHeader('Set-Cookie', 'rv=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); res.redirect('/'); });
app.get('/unlock', (req, res) => res.sendFile(path.join(__dirname, 'unlock.html')));


// ── CONFIGURATION ─────────────────────────────────────────────────────────
const CFG = {
  // Machine
  deviceId:   '203617400',
  deviceName: 'D611 Lunch Box Vending Machine',
  location:   'Dahban, Saudi Arabia',
  phone:      '971502020887',
  password:   '123456',
  api:        'https://merchant.dwvending.cn',

  // Timezone: China GMT+8, Saudi GMT+3, diff = -5h
  tzOffset:   -5 * 60 * 60 * 1000,

  // Alerts
  tempAlert:  -12,   // alert if temp >= this
  slotCap:    2,     // capacity per slot
  stockOkMin: 3,     // OK if >= 3 units per SKU
  checkEvery: 5 * 60 * 1000, // 5 minutes
  powerMinutes: 20,          // no signal from the machine for this long => POWERED OFF
  staleMinutes: 30,          // no heartbeat for this long => treat machine as OFFLINE

  // Email
  email: {
    from:    'abdobazzaz@gmail.com',
    pass:    'bxctdmamcgfsumyj',
    to:      'abdobazzaz@gmail.com',
    fromName:'Radwa Smart Vending Monitor',
  },

  // Products
  products: [
    { code:'EFMC01', name:'Butter Chicken 350gms',             emoji:'🍗', slots:['1','2','3','4'],   rows:[1] },
    { code:'EFMC02', name:'Sweet Chili Chicken 350gms',        emoji:'🌶️', slots:['11','12','13','14'],rows:[2] },
    { code:'EFMC03', name:'Chicken Biryani 350gms',            emoji:'🍚', slots:['21','22','23','24'],rows:[3] },
    { code:'EFMC04', name:'Fettuccine Chicken Alfredo 350gms', emoji:'🍝', slots:['31','32','33','34'],rows:[4] },
    { code:'EFMC05', name:'Chicken Noodles 350gms',            emoji:'🍜', slots:['41','42','43','44'],rows:[5] },
    { code:'EFMC06', name:'Creamy Chicken 350gms',             emoji:'🍲', slots:['51','52','53','54','61','62'],rows:[6,7] },
  ],

  // Layout map: API slot number → row-col code
  slotMap: {
    '1':'1-1','2':'1-2','3':'1-3','4':'1-4',
    '11':'2-1','12':'2-2','13':'2-3','14':'2-4',
    '21':'3-1','22':'3-2','23':'3-3','24':'3-4',
    '31':'4-1','32':'4-2','33':'4-3','34':'4-4',
    '41':'5-1','42':'5-2','43':'5-3','44':'5-4',
    '51':'6-1','52':'6-2','53':'6-3','54':'6-4',
    '61':'7-1','62':'7-2','63':'7-3','64':'7-4',
    '71':'8-1','72':'8-2','73':'8-3','74':'8-4',
  },
};

// ── STATE ─────────────────────────────────────────────────────────────────
let STATE = {
  token:          '',
  cookie:         '',
  lastPower:      null,
  lastRegistered: null, // registration state for alert transitions
  lastTempAlert:  false,
  lastDoneCount:  0,
  lastSkuAlerts:  {}, // track per-SKU alerts
  firstStockCheck: true, // suppress alerts on the first check after startup
  lastCheck:      null,
  stock:          {}, // current slot volumes
  machine:        { temp: -17, online: false, lastConn: '—', ip: '—', registered: false },
  stats:          { today:0, todayCount:0, month:0, monCount:0, totalDone:0, total:0 },
  alerts:         [], // recent alerts log
  errors:         [], // recent errors log
  tempLog:        [], // { time, temp } for 24h
  powerLog:       [], // { time, online } for 24h
  startTime:      new Date(),
};

// ── EMAIL TRANSPORTER ─────────────────────────────────────────────────────

// ── HELPERS ───────────────────────────────────────────────────────────────
// Convert China time string to Saudi Date object
function chinaToSaudi(chinaTimeStr) {
  if (!chinaTimeStr) return null;
  const d = new Date(chinaTimeStr.replace(' ', 'T') + '+08:00');
  return new Date(d.getTime() + CFG.tzOffset + 8*3600000); // adjust to KSA
}

function toKSATime(chinaTimeStr) {
  const d = chinaToSaudi(chinaTimeStr);
  if (!d) return '—';
  return d.toISOString().replace('T',' ').substring(0,16);
}

function nowKSA() {
  return new Date(Date.now() + 3*3600000); // UTC+3
}

function ksaDayRange(date) {
  // Returns China time range for a KSA day
  // KSA midnight = China 05:00
  const d = new Date(date);
  const start = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} 05:00:00`;
  const next  = new Date(d); next.setDate(next.getDate()+1);
  const end   = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')} 05:00:00`;
  return { start, end };
}

function getProductBySlot(slotNum) {
  const s = String(slotNum);
  return CFG.products.find(p => p.slots.includes(s)) || null;
}

function getProductCode(goodsName) {
  const n = (goodsName||'').toLowerCase();
  if (n.includes('butter'))   return CFG.products[0];
  if (n.includes('chili'))    return CFG.products[1];
  if (n.includes('biryani')||n.includes('biriyani')) return CFG.products[2];
  if (n.includes('alfredo')||n.includes('fettuccine')) return CFG.products[3];
  if (n.includes('noodle'))   return CFG.products[4];
  if (n.includes('cream'))    return CFG.products[5];
  return null;
}

function logAlert(subject, body) {
  STATE.alerts.unshift({ time: new Date().toISOString(), subject, body });
  if (STATE.alerts.length > 100) STATE.alerts = STATE.alerts.slice(0, 100);
}

function logError(msg) {
  console.error('❌', msg);
  STATE.errors.unshift({ time: new Date().toISOString(), msg });
  if (STATE.errors.length > 50) STATE.errors = STATE.errors.slice(0, 50);
}

// ── API FETCH ─────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (STATE.token)  headers['Authorization'] = `Bearer ${STATE.token}`;
  if (STATE.cookie) headers['Cookie'] = STATE.cookie;

  const res = await fetch(CFG.api + path, { ...opts, headers, timeout: 30000 });
  const sc = res.headers.get('set-cookie');
  if (sc) STATE.cookie = sc;

  const text = await res.text();
  try { return JSON.parse(text); }
  catch(e) { throw new Error(`Non-JSON from ${path}: ${text.substring(0,100)}`); }
}

async function login() {
  try {
    const params = new URLSearchParams();
    params.append('country_code', '971');
    params.append('mobile', CFG.phone.replace(/^971/, ''));
    params.append('password', CFG.password);
    params.append('remember', 'false');

    const res = await fetch(CFG.api + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      timeout: 30000,
    });

    const sc = res.headers.get('set-cookie');
    if (sc) STATE.cookie = sc;

    const text = await res.text();
    let d = {};
    try { d = JSON.parse(text); } catch(e) {
      logError(`Login non-JSON response (status ${res.status}): ${text.substring(0,200)}`);
    }

    const success = !!STATE.cookie || d.code === 200 || d.success === true || !!d.token || !!d.data?.token;

    if (success) {
      STATE.token = d.token || d.data?.token || '';
      console.log(`✅ Login OK (cookie: ${STATE.cookie ? 'yes' : 'no'}, token: ${STATE.token ? 'yes' : 'no'})`);
      return true;
    }

    logError(`Login rejected: status=${res.status}, body=${JSON.stringify(d).substring(0,200)}`);
    return false;
  } catch(e) {
    logError(`Login error: ${e.message}`);
    return false;
  }
}

async function fetchAllOrders() {
  let all = [], page = 1;
  while (page <= 20) {
    const d = await apiFetch(`/api/v1/orders?page=${page}&limit=100`);
    const items = d?.data?.data || [];
    all = all.concat(items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

async function fetchMachine() {
  const [dr, detr] = await Promise.all([
    apiFetch('/api/v1/devices').catch(()=>({})),
    apiFetch(`/api/v1/device/detail?device_id=${CFG.deviceId}`).catch(()=>({}) ),
  ]);
  const d  = dr?.data?.devices?.[0] || {};
  const dd = detr?.data || {};

  // Log raw status fields to help diagnose online detection
  console.log(`📡 Device raw: status=${JSON.stringify(d.status)} connect_time=${d.connect_time} device_status=${d.device_status} online=${d.online}`);
  console.log(`📡 Device IPs: device_ip=${d.device_ip} ip=${d.ip} dd.device_ip=${dd.device_ip} dd.ip=${dd.ip}`);
  console.log(`📡 Registration: register_status=${d.register_status} is_register=${d.is_register} bind_status=${d.bind_status}`);

  const temp = parseInt(d.device_temp ?? dd.device_temp ?? -17);

  // Online detection: try multiple field patterns used by DW vending API
  // status '1' or 1 = online, '0' or 0 = offline (Chinese IoT convention)
  // Also check device_status, online flag, and recent connect_time as fallbacks
  const statusVal = d.status ?? d.device_status ?? dd.status ?? dd.device_status;
  const onlineByStatus = statusVal === 1 || statusVal === '1' || statusVal === 'online';
  const onlineByFlag   = d.online === 1 || d.online === true || d.online === '1';
  // NOTE: the old "connect_time year >= 2025" fallback was always true, so the
  // machine could never show OFFLINE. Removed. Freshness is checked below instead.
  // The merchant UI has a separate "Online status" column, so also accept other online-style fields.
  const ONLINE_KEYS = ['online_status','is_online','onlineStatus','online_state','net_status','network_status','mqtt_status','device_online'];
  const truthy = v => v === 1 || v === true || v === '1' || v === 'online' || v === 'Online';
  const onlineByOther = [d, dd].some(src => ONLINE_KEYS.some(k => truthy(src[k])));
  const platformOnline = onlineByStatus || onlineByFlag || onlineByOther;

  // Staleness check: the platform can keep reporting status=online from its last
  // known value even when the machine has lost its identity/connection.
  // Use the newest heartbeat-style timestamp the API gives us (China time, GMT+8).
  console.log(`📡 Device keys: ${Object.keys(d).join(',')} | detail keys: ${Object.keys(dd).join(',')}`);
  const HB_FIELDS = ['last_heartbeat','heartbeat_time','last_online_time','last_report_time','report_time','update_time','updated_at'];
  let heartbeat = null, heartbeatSource = 'none';
  for (const src of [d, dd]) {
    for (const f of HB_FIELDS) {
      if (!src[f]) continue;
      const t = typeof src[f] === 'number'
        ? new Date(src[f] < 1e12 ? src[f]*1000 : src[f])
        : new Date(String(src[f]).replace(' ', 'T') + '+08:00');
      if (!isNaN(t) && (!heartbeat || t > heartbeat)) { heartbeat = t; heartbeatSource = f; }
    }
  }
  const staleMins = heartbeat ? Math.round((Date.now() - heartbeat.getTime()) / 60000) : null;
  const stale = staleMins !== null && staleMins > CFG.staleMinutes;
  const online = platformOnline && !stale;
  // Power: the platform has no true power flag, so treat the machine as powered
  // when the device record still returns a live telemetry reading (temperature).
  // Power: the machine keeps signalling the cloud (connect_time keeps advancing) even while it is
  // unregistered/not online, and stops when it loses power. So power = recent signal.
  const sigRaw = d.connect_time || dd.connect_time || '';
  const sigDate = sigRaw ? new Date(String(sigRaw).replace(' ', 'T') + '+08:00') : null;
  const signalMins = sigDate && !isNaN(sigDate) ? Math.max(0, Math.round((Date.now() - sigDate.getTime()) / 60000)) : null;
  const powered = signalMins !== null ? signalMins <= CFG.powerMinutes : false;
  if (stale) console.log(`⚠️ STALE: platform says online but last heartbeat (${heartbeatSource}) was ${staleMins} min ago`);

  const rawConn = d.connect_time || dd.connect_time || '';
  const ksaConn = rawConn ? toKSATime(rawConn) : '—';
  const ip = d.device_ip || d.ip || dd.device_ip || dd.ip || '—';

  // Registered: if machine is online it's definitely registered; also check explicit fields
  const regVals = [d.register_status, d.is_register, d.bind_status, dd.register_status, dd.is_register, dd.bind_status].filter(v => v !== undefined && v !== null && v !== '');
  const registeredExplicit = regVals.length ? regVals.some(v => v === 1 || v === '1' || v === true) : null;
  const registered = online || !!(
    d.register_status === 1 || d.register_status === '1' ||
    d.is_register === 1 || d.is_register === '1' ||
    dd.register_status === 1 || dd.register_status === '1' ||
    dd.is_register === 1 || dd.is_register === '1' ||
    d.bind_status === 1 || d.bind_status === '1' ||
    dd.bind_status === 1 || dd.bind_status === '1'
  );

  console.log(`📡 Result: online=${online} (byStatus=${onlineByStatus} byFlag=${onlineByFlag} stale=${stale} hb=${heartbeatSource}/${staleMins}min) registered=${registered} ip=${ip}`);
  return { temp, online, powered, signalMins, registeredExplicit, platformOnline, stale, staleMins, heartbeatSource, lastConn: ksaConn, fault: d.fault_code || '0', ip, registered };
}
async function fetchStock() {
  const d = await apiFetch(`/api/v1//devices/${CFG.deviceId}/cargoways`);
  const rows = d?.data?.cargoways || {};
  const stock = {};
  Object.values(rows).forEach(slots => {
    slots.forEach(s => {
      stock[String(s.cargoway_num)] = {
vol:      parseInt(s.goods_amount) || 0,
        capacity: 2,
        rowNum:   s.row_num,
        colNum:   s.col_num,
        colCode:  `${s.row_num}-${s.col_num}`,
        hasGoods: s.hasGoods,
      };
    });
  });
  return stock;
}

// ── SEND EMAIL ────────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody, attachments = []) {
  logAlert(subject, htmlBody.replace(/<[^>]+>/g,'').substring(0,200));
  console.log(`📧 Sending: ${subject}`);

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logError('Email failed: RESEND_API_KEY env var is not set');
    return;
  }

  // Convert file attachments to base64 (Resend requires this format)
  const resendAttachments = [];
  for (const att of attachments) {
    try {
      const data = fs.readFileSync(att.path);
      resendAttachments.push({
        filename: att.filename,
        content: data.toString('base64'),
      });
    } catch(e) {
      logError(`Failed to read attachment ${att.filename}: ${e.message}`);
    }
  }

  const payload = {
    from:    `${CFG.email.fromName} <onboarding@resend.dev>`,
    to:      [CFG.email.to],
    subject: `[Radwa] ${subject}`,
    html:    htmlBody,
  };
  if (resendAttachments.length > 0) payload.attachments = resendAttachments;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(payload),
        timeout: 30000,
      });
      const text = await res.text();
      if (res.ok) {
        console.log(`✅ Email sent! (attempt ${attempt})`);
        return;
      }
      // 4xx errors are permanent — don't retry
      if (res.status >= 400 && res.status < 500) {
        logError(`Email rejected (${res.status}): ${text.substring(0, 300)}`);
        return;
      }
      throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
    } catch(e) {
      if (attempt < 3) {
        console.log(`⚠️  Email attempt ${attempt} failed (${e.message}), retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        logError(`Email failed after ${attempt} attempt(s): ${e.message}`);
      }
    }
  }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────
function alertEmail(icon, title, bodyLines) {
  const isRed    = title.includes('OFFLINE') || title.includes('NOT REGISTERED') || title.includes('Alert') || title.includes('Empty');
  const isOrange = title.includes('Temperature') || title.includes('Low');
  const color    = isRed ? '#C8002A' : isOrange ? '#C06000' : '#1B3F8B';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#F8F1E7;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.15)">
  <div style="background:${color};padding:20px 24px;text-align:center">
    <div style="font-size:36px;margin-bottom:8px">${icon}</div>
    <div style="color:#fff;font-size:18px;font-weight:900">${title}</div>
  </div>
  <div style="padding:20px 24px">
    ${bodyLines.map(l=>`<p style="font-size:13px;color:#1C2E08;line-height:1.7;margin:0 0 8px">${l}</p>`).join('')}
    <div style="margin-top:16px;background:#F8F1E7;border-radius:8px;padding:10px 14px;font-size:11px;color:#7A9660">
      Machine: ${CFG.deviceId} · ${CFG.location}<br>
      Time: ${nowKSA().toLocaleString()} (KSA)
    </div>
  </div>
  <div style="background:#1B3F8B;padding:12px 24px;text-align:center;font-size:10px;color:rgba(255,255,255,.6)">
    Radwa Smart Vending Monitor · abdobazzaz@gmail.com
  </div>
</div>
</body></html>`;
}

// ── EXCEL REPORT ──────────────────────────────────────────────────────────
async function buildExcel(dayOrders, skuSummary, closingStock, dateLabel) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Radwa Monitor';

  // Colors
  const GREEN  = { argb: 'FF1B8B3F' };
  const BLUE   = { argb: 'FF1B3F8B' };
  const GOLD   = { argb: 'FFF5A623' };
  const CREAM  = { argb: 'FFF8F1E7' };
  const WHITE  = { argb: 'FFFFFFFF' };
  const LBLUE  = { argb: 'FFD0DCF5' };
  const LGREEN = { argb: 'FFD8F0DC' };
  const LGOLD  = { argb: 'FFFFF0D0' };

  const headerFont  = { bold:true, color:{argb:'FFFFFFFF'}, size:11 };
  const titleFont   = { bold:true, size:12, color:{argb:'FF1C2E08'} };

  // ── SHEET 1: SKU SUMMARY ──
  const ws1 = wb.addWorksheet('SKU Summary');
  ws1.columns = [
    { key:'code',  width:12 },
    { key:'name',  width:35 },
    { key:'qty',   width:12 },
    { key:'price', width:14 },
    { key:'rev',   width:16 },
  ];

  ws1.addRow(['RADWA SMART VENDING - SKU SALES SUMMARY']).font = { bold:true, size:14, color:{argb:'FF1B3F8B'} };
  ws1.addRow([`Date: ${dateLabel} · KSA Time`]).font = { italic:true, color:{argb:'FF7A9660'} };
  ws1.addRow([]);

  const h1 = ws1.addRow(['Code','Product','Qty Sold','Unit Price (SAR)','Revenue (SAR)']);
  h1.font = headerFont;
  h1.fill = { type:'pattern', pattern:'solid', fgColor:BLUE };
  h1.alignment = { horizontal:'center' };

  let grandTotal = 0;
  CFG.products.forEach(p => {
    const s = skuSummary[p.code] || { count:0, rev:0 };
    const row = ws1.addRow([p.code, p.name, s.count, 14.95, s.rev.toFixed(2)]);
    row.getCell('qty').alignment   = { horizontal:'center' };
    row.getCell('price').alignment = { horizontal:'center' };
    row.getCell('rev').alignment   = { horizontal:'right' };
    if (s.count > 0) {
      row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEEF8EE' } };
      row.font = { bold:true };
    }
    grandTotal += s.rev;
  });

  const tot = ws1.addRow(['','GRAND TOTAL', Object.values(skuSummary).reduce((s,v)=>s+v.count,0), '', grandTotal.toFixed(2)]);
  tot.font = { bold:true, size:12 };
  tot.fill = { type:'pattern', pattern:'solid', fgColor:LGOLD };
  tot.getCell('rev').alignment = { horizontal:'right' };

  ws1.mergeCells('A1:E1');
  ws1.mergeCells('A2:E2');

  // ── SHEET 2: ALL PURCHASES ──
  const ws2 = wb.addWorksheet('All Purchases');
  ws2.columns = [
    { key:'no',    width:6  },
    { key:'code',  width:10 },
    { key:'name',  width:35 },
    { key:'slot',  width:8  },
    { key:'ksa',   width:18 },
    { key:'china', width:18 },
    { key:'price', width:14 },
  ];

  ws2.addRow(['RADWA SMART VENDING - ALL PURCHASES']).font = { bold:true, size:14, color:{argb:'FF1B3F8B'} };
  ws2.addRow([`Date: ${dateLabel} · All times in KSA (GMT+3)`]).font = { italic:true, color:{argb:'FF7A9660'} };
  ws2.addRow([]);

  const h2 = ws2.addRow(['#','Code','Product','Slot','Time (KSA)','Time (China)','Price (SAR)']);
  h2.font = headerFont;
  h2.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1B3F8B' } };

  dayOrders.forEach((o, i) => {
    const g    = o.goods?.[0] || {};
    const prod = getProductCode(g.goods_name||'');
    const apiS = String(g.cargoway_num||o.cargoway_num||'');
    const slot = CFG.slotMap[apiS] || apiS;
    const ksaT = toKSATime(o.pay_time);
    const chiT = (o.pay_time||'').substring(0,16);
    const price= parseFloat(g.sale_price||o.order_amount||0).toFixed(2);
    const row  = ws2.addRow([i+1, prod?.code||'—', prod?.name||g.goods_name||'—', slot, ksaT, chiT, price]);
    row.getCell('no').alignment    = { horizontal:'center' };
    row.getCell('slot').alignment  = { horizontal:'center' };
    row.getCell('ksa').alignment   = { horizontal:'center' };
    row.getCell('china').alignment = { horizontal:'center' };
    row.getCell('price').alignment = { horizontal:'right' };
    if (i % 2 === 0) row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF8F8F8' } };
  });

  const tot2 = ws2.addRow(['', '', `TOTAL: ${dayOrders.length} orders`, '', '', '', dayOrders.reduce((s,o)=>s+parseFloat(o.order_amount||0),0).toFixed(2)]);
  tot2.font = { bold:true };
  tot2.fill = { type:'pattern', pattern:'solid', fgColor:LBLUE };
  tot2.getCell('price').alignment = { horizontal:'right' };
  ws2.mergeCells(`A1:G1`);
  ws2.mergeCells(`A2:G2`);

  // ── SHEET 3: CLOSING STOCK ──
  const ws3 = wb.addWorksheet('Closing Stock');
  ws3.columns = [
    { key:'code',   width:10 },
    { key:'name',   width:35 },
    { key:'slots',  width:30 },
    { key:'units',  width:12 },
    { key:'cap',    width:10 },
    { key:'status', width:10 },
  ];

  ws3.addRow(['RADWA SMART VENDING - CLOSING STOCK']).font = { bold:true, size:14, color:{argb:'FF1B3F8B'} };
  ws3.addRow([`Date: ${dateLabel} · As of 23:59 KSA`]).font = { italic:true, color:{argb:'FF7A9660'} };
  ws3.addRow([]);

  const h3 = ws3.addRow(['Code','Product','Slot Details','Units Left','Capacity','Status']);
  h3.font = headerFont;
  h3.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5A623' } };

  CFG.products.forEach(p => {
    const slotDetails = p.slots.map(s => {
      const info = closingStock[s];
      const code = CFG.slotMap[s] || s;
      return info ? `${code}:${info.vol}` : `${code}:?`;
    }).join(' ');
    const totalUnits = p.slots.reduce((sum, s) => sum + (closingStock[s]?.vol||0), 0);
    const capacity   = p.slots.length * 2;
    const status     = totalUnits === 0 ? 'EMPTY' : totalUnits <= 2 ? 'LOW' : 'OK';
    const row = ws3.addRow([p.code, p.name, slotDetails, totalUnits, capacity, status]);
    row.getCell('units').alignment  = { horizontal:'center' };
    row.getCell('cap').alignment    = { horizontal:'center' };
    row.getCell('status').alignment = { horizontal:'center' };
    const statusCell = row.getCell('status');
    if (status === 'EMPTY') {
      statusCell.font = { bold:true, color:{ argb:'FFC8002A' } };
      row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF0F0' } };
    } else if (status === 'LOW') {
      statusCell.font = { bold:true, color:{ argb:'FFE07020' } };
      row.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF5EC' } };
    } else {
      statusCell.font = { bold:true, color:{ argb:'FF376C00' } };
    }
  });

  const totalAll = CFG.products.reduce((s,p) => s + p.slots.reduce((ss,sl)=>ss+(closingStock[sl]?.vol||0),0), 0);
  const capAll   = CFG.products.reduce((s,p) => s + p.slots.length*2, 0);
  const tot3 = ws3.addRow(['','TOTAL STOCK','', totalAll, capAll, `${Math.round(totalAll/capAll*100)}% Full`]);
  tot3.font = { bold:true };
  tot3.fill = { type:'pattern', pattern:'solid', fgColor:LGOLD };
  ws3.mergeCells(`A1:F1`);
  ws3.mergeCells(`A2:F2`);

  // Save to temp file
  const filePath = `/tmp/Radwa_Daily_Report_${dateLabel.replace(/\s/g,'-')}.xlsx`;
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

// ── DAILY REPORT EMAIL HTML ───────────────────────────────────────────────
function buildDailyHtml(dayOrders, skuSummary, closingStock, machine, dateLabel, ksaDate) {
  const { temp, online, lastConn } = machine;
  const totalRev = dayOrders.reduce((s,o) => s+parseFloat(o.order_amount||0), 0);
  const tCol = temp >= CFG.tempAlert ? '#C8002A' : temp >= -15 ? '#E07020' : '#1B3F8B';
  const tBg  = temp >= CFG.tempAlert ? '#FEF0F0' : temp >= -15 ? '#FFF5EC' : '#EEF3FC';
  const tSt  = temp >= CFG.tempAlert ? '🔴 CRITICAL' : temp >= -15 ? '🟡 WARNING' : '🔵 Normal';

  // Build SKU rows for table 1
  const skuRows = CFG.products.map(p => {
    const s = skuSummary[p.code] || { count:0, rev:0 };
    const hasSale = s.count > 0;
    return `<tr style="background:#fff">
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;font-family:monospace;font-weight:700;color:#F5A623;font-size:11px">${p.code}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;font-weight:${hasSale?'700':'400'};color:${hasSale?'#1C2E08':'#AAA'}">${p.emoji} ${p.name}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:center">
        <span style="background:${hasSale?'#1B3F8B':'#F0F0F0'};color:${hasSale?'#fff':'#AAA'};padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700">${s.count}</span>
      </td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:center;color:${hasSale?'#4A6030':'#CCC'}">14.95 SAR</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:right;font-weight:${hasSale?'900':'400'};color:${hasSale?'#1B3F8B':'#CCC'};font-size:${hasSale?'14':'12'}px">${s.rev.toFixed(2)} SAR</td>
    </tr>`;
  }).join('');

  // Build purchase rows for table 2
  const purchaseRows = dayOrders.length === 0
    ? `<tr><td colspan="7" style="padding:20px;text-align:center;color:#7A9660">No completed orders on this day</td></tr>`
    : dayOrders.map((o,i) => {
        const g    = o.goods?.[0] || {};
        const prod = getProductCode(g.goods_name||'');
        const apiS = String(g.cargoway_num||o.cargoway_num||'');
        const slot = CFG.slotMap[apiS] || apiS || '—';
        const ksaT = toKSATime(o.pay_time);
        const chiT = (o.pay_time||'').substring(11,16);
        const price= parseFloat(g.sale_price||o.order_amount||0).toFixed(2);
        return `<tr style="background:#fff">
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;text-align:center;color:#7A9660;font-size:11px">${i+1}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;font-family:monospace;font-weight:700;color:#F5A623;font-size:10px">${prod?.code||'—'}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;font-weight:700;color:#1C2E08;font-size:11px">${prod?.emoji||''} ${prod?.name||g.goods_name||'—'}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;text-align:center">
            <span style="background:#EEF5E8;color:#5A9E1E;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:10px;font-weight:700">${slot}</span>
          </td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;text-align:center;font-weight:700;color:#1B3F8B;font-size:12px">${ksaT.substring(11)}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;text-align:center;color:#7A9660;font-size:11px">${chiT}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #F0E4D0;text-align:right;font-weight:900;color:#5A9E1E;font-size:13px">${price} SAR</td>
        </tr>`;
      }).join('');

  // Build closing stock rows for table 3
  const stockRows = CFG.products.map(p => {
    const slotBadges = p.slots.map(s => {
      const info = closingStock[s];
      const code = CFG.slotMap[s] || s;
      const vol  = info?.vol ?? '?';
      const bg   = vol === 0 ? '#FEF0F0' : '#EEF5E8';
      const col  = vol === 0 ? '#C8002A' : '#5A9E1E';
      return `<span style="background:${bg};color:${col};padding:1px 5px;border-radius:4px;font-family:monospace;font-size:9px;font-weight:700;display:inline-block;margin:1px">${code}:${vol}</span>`;
    }).join('');
    const totalUnits = p.slots.reduce((sum,s)=>sum+(closingStock[s]?.vol||0),0);
    const capacity   = p.slots.length * 2;
    const status     = totalUnits === 0 ? 'EMPTY' : totalUnits <= 2 ? 'LOW' : 'OK';
    const stCol = status==='OK'?'#5A9E1E':status==='LOW'?'#E07020':'#C8002A';
    const stBg  = status==='OK'?'#EEF5E8':status==='LOW'?'#FFF5EC':'#FEF0F0';
    const stLbl = status==='OK'?'✓ OK':status==='LOW'?'⚠ Low':'✕ Empty';
    return `<tr style="background:#fff">
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;font-family:monospace;font-weight:700;color:#F5A623;font-size:11px">${p.code}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;font-weight:700;color:#1C2E08">${p.emoji} ${p.name}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0">${slotBadges}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:center;font-weight:900;color:#1C2E08;font-size:15px">${totalUnits}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:center;color:#7A9660">${capacity}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #F0E4D0;text-align:center">
        <span style="background:${stBg};color:${stCol};padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;border:1px solid ${stCol}">${stLbl}</span>
      </td>
    </tr>`;
  }).join('');

  const totalStock = CFG.products.reduce((s,p)=>s+p.slots.reduce((ss,sl)=>ss+(closingStock[sl]?.vol||0),0),0);
  const totalCap   = CFG.products.reduce((s,p)=>s+p.slots.length*2,0);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#F8F1E7;font-family:Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 30px rgba(0,0,0,.15)">

  <!-- HEADER -->
  <div style="background:#F8F1E7;padding:24px 30px 20px;text-align:center;border-bottom:3px solid #F5A623">
    <img src="https://raw.githubusercontent.com/abdobazzaz/d.js/main/New%20Radwa%20Logo%20with%20text-%20trasperant.png" alt="Radwa" style="width:180px;height:auto;margin-bottom:10px" onerror="this.style.display='none'">    <div style="color:#1B3F8B;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;font-weight:700">Smart Vending Daily Report</div>
    <div style="background:#1B3F8B;border-radius:20px;padding:7px 20px;display:inline-block">
      <span style="color:#fff;font-size:13px;font-weight:700">📅 ${dateLabel} &nbsp;·&nbsp; Dahban Machine</span>
    </div>
  </div>

  <!-- SUMMARY -->
  <div style="background:#FDF8F2;padding:20px 24px;border-bottom:2px solid #F5A623">
    <div style="font-size:10px;color:#1B3F8B;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;font-weight:700">📊 DAY SUMMARY · Saudi Time 00:00 – 23:59 (KSA GMT+3)</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="text-align:center;padding:12px 6px;background:#fff;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:20px;margin-bottom:4px">💰</div>
        <div style="font-size:20px;font-weight:900;color:#5A9E1E">${totalRev.toFixed(2)}</div>
        <div style="font-size:9px;color:#7A9660;margin-top:2px">SAR Revenue</div>
      </td>
      <td width="3%"></td>
      <td style="text-align:center;padding:12px 6px;background:#fff;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:20px;margin-bottom:4px">✅</div>
        <div style="font-size:20px;font-weight:900;color:#1B3F8B">${dayOrders.length}</div>
        <div style="font-size:9px;color:#7A9660;margin-top:2px">Orders Sold</div>
      </td>
      <td width="3%"></td>
      <td style="text-align:center;padding:12px 6px;background:#fff;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:20px;margin-bottom:4px">🌡️</div>
        <div style="font-size:20px;font-weight:900;color:${tCol}">${temp}°C</div>
        <div style="font-size:9px;color:#7A9660;margin-top:2px">${tSt}</div>
      </td>
      <td width="3%"></td>
      <td style="text-align:center;padding:12px 6px;background:#fff;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:20px;margin-bottom:4px">⚡</div>
        <div style="font-size:20px;font-weight:900;color:${online?'#5A9E1E':'#C8002A'}">${online?'Online':'Offline'}</div>
        <div style="font-size:9px;color:#7A9660;margin-top:2px">Machine Status</div>
      </td>
    </tr></table>
  </div>

  <div style="padding:24px 30px">

    <!-- EXCEL NOTE -->
    <div style="background:#FDF8F2;border:1.5px solid #F5A623;border-radius:10px;padding:12px 16px;margin-bottom:22px;display:flex;align-items:center;gap:12px">
      <div style="font-size:28px">📎</div>
      <div>
        <div style="font-weight:700;color:#1B3F8B;font-size:13px">Excel Report Attached</div>
        <div style="font-size:11px;color:#5A7A3A;margin-top:2px">Radwa_Daily_Report_${dateLabel.replace(/\s/g,'-')}.xlsx &nbsp;·&nbsp; SKU Summary + All Purchases + Closing Stock</div>
      </div>
    </div>

    <!-- TABLE 1: SKU SUMMARY -->
    <div style="margin-bottom:28px">
      <div style="margin-bottom:10px">
        <span style="background:#5A9E1E;color:#fff;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700">📦 TABLE 1 · SKU SUMMARY</span>
        <span style="color:#7A9660;font-size:11px;margin-left:8px">Previous day sales by product</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1.5px solid #E8D5B7;font-size:12px">
        <thead><tr style="background:#1B3F8B">
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">CODE</th>
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">QTY SOLD</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">UNIT PRICE</th>
          <th style="padding:10px 12px;text-align:right;color:#fff;font-size:10px;letter-spacing:1px">REVENUE</th>
        </tr></thead>
        <tbody>
          ${skuRows}
          <tr style="background:#FDF0D8">
            <td colspan="2" style="padding:13px 12px;font-weight:900;color:#1C2E08;font-size:14px">🏆 GRAND TOTAL</td>
            <td style="padding:13px 12px;text-align:center"><span style="background:#1B3F8B;color:#fff;padding:5px 16px;border-radius:20px;font-size:15px;font-weight:900">${dayOrders.length}</span></td>
            <td style="padding:13px 12px;text-align:center;color:#7A9660;font-size:11px">14.95 SAR avg</td>
            <td style="padding:13px 12px;text-align:right;font-weight:900;color:#1B3F8B;font-size:20px">${totalRev.toFixed(2)} SAR</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- TABLE 2: ALL PURCHASES -->
    <div style="margin-bottom:28px">
      <div style="margin-bottom:10px">
        <span style="background:#1B3F8B;color:#fff;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700">✅ TABLE 2 · ALL PURCHASES</span>
        <span style="color:#7A9660;font-size:11px;margin-left:8px">Every transaction · KSA time (GMT+3)</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1.5px solid #E8D5B7;font-size:11px">
        <thead><tr style="background:#1B3F8B">
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">#</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">CODE</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">SLOT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">KSA TIME</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">CHINA TIME</th>
          <th style="padding:9px 10px;text-align:right;color:#fff;font-size:9px;letter-spacing:1px">PRICE</th>
        </tr></thead>
        <tbody>
          ${purchaseRows}
          <tr style="background:#D0DCF5">
            <td colspan="6" style="padding:11px 12px;font-weight:900;color:#1B3F8B;font-size:13px">TOTAL · ${dayOrders.length} order${dayOrders.length!==1?'s':''}</td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;color:#1B3F8B;font-size:15px">${totalRev.toFixed(2)} SAR</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- TABLE 3: CLOSING STOCK -->
    <div style="margin-bottom:28px">
      <div style="margin-bottom:10px">
        <span style="background:#F5A623;color:#fff;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700">📦 TABLE 3 · CLOSING STOCK</span>
        <span style="color:#7A9660;font-size:11px;margin-left:8px">Machine stock at 23:59 KSA · OK ≥3 · Low ≤2 · Empty = 0</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1.5px solid #E8D5B7;font-size:12px">
        <thead><tr style="background:#F5A623">
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">CODE</th>
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">SLOT DETAILS</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">UNITS LEFT</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">CAPACITY</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">STATUS</th>
        </tr></thead>
        <tbody>
          ${stockRows}
          <tr style="background:#FDF0D8">
            <td colspan="3" style="padding:12px 14px;font-weight:900;color:#1C2E08;font-size:13px">📦 TOTAL STOCK AT CLOSING</td>
            <td style="padding:12px 14px;text-align:center;font-weight:900;color:#5A9E1E;font-size:18px">${totalStock}</td>
            <td style="padding:12px 14px;text-align:center;color:#7A9660">${totalCap}</td>
            <td style="padding:12px 14px;text-align:center">
              <span style="background:#EEF5E8;color:#5A9E1E;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700">${Math.round(totalStock/totalCap*100)}% Full</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- TEMP & POWER -->
    <div style="display:flex;gap:14px;margin-bottom:24px">
      <div style="flex:1;background:${tBg};border:1.5px solid ${tCol};border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:10px;color:${tCol};font-weight:700;letter-spacing:1px;margin-bottom:4px">🌡️ TEMPERATURE</div>
        <div style="font-size:32px;font-weight:900;color:${tCol};line-height:1">${temp}°C</div>
        <div style="font-size:11px;font-weight:700;color:${tCol};margin-top:4px">${tSt}</div>
        <div style="font-size:10px;color:#7A9660;margin-top:6px">Threshold: ${CFG.tempAlert}°C</div>
      </div>
      <div style="flex:1;background:${online?'#EEF5E8':'#FEF0F0'};border:1.5px solid ${online?'#5A9E1E':'#C8002A'};border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:10px;color:${online?'#5A9E1E':'#C8002A'};font-weight:700;letter-spacing:1px;margin-bottom:4px">⚡ POWER STATUS</div>
        <div style="font-size:24px;font-weight:900;color:${online?'#5A9E1E':'#C8002A'};line-height:1">${online?'🟢 ONLINE':'🔴 OFFLINE'}</div>
        <div style="font-size:10px;color:#7A9660;margin-top:8px">Last seen: ${lastConn}</div>
      </div>
    </div>

    <!-- NOTE -->
    <div style="background:#FDF8F0;border:1.5px solid #F5A623;border-radius:10px;padding:12px 14px;font-size:11px;color:#8B4000;line-height:1.7">
      <strong>📌 Time Zone:</strong> All times in <strong>Saudi Arabia KSA (GMT+3)</strong> · Machine China time adjusted −5 hours.<br>
      <strong>📎 Excel attached</strong> with full data for your records.
    </div>

  </div>

  <!-- FOOTER -->
  <div style="background:#1B3F8B;padding:20px 30px;text-align:center">
    <div style="color:rgba(255,255,255,.9);font-size:13px;font-weight:700;margin-bottom:6px">Radwa Smart Vending Monitor</div>
    <div style="color:rgba(255,255,255,.5);font-size:11px;line-height:1.8">
      Machine ID: ${CFG.deviceId} · ${CFG.location}<br>
      Report: ${dateLabel} · KSA 00:00–23:59<br>
      📧 Daily: 09:30 AM KSA · 📊 Monthly: 09:00 AM on 1st of each month
    </div>
  </div>

</div>
</body></html>`;
}

// ── SEND DAILY REPORT ─────────────────────────────────────────────────────
async function sendDailyReport(targetDate) {
  console.log('\n📊 Building daily report for', targetDate.toDateString());
  try {
    // Get KSA "yesterday"
    const yesterday = new Date(targetDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const { start, end } = ksaDayRange(yesterday);

    const dateLabel = yesterday.toLocaleDateString('en', {
      weekday:'long', day:'numeric', month:'long', year:'numeric'
    });

    // Fetch data
    const [allOrders, machine, stock] = await Promise.all([
      fetchAllOrders(),
      fetchMachine(),
      fetchStock(),
    ]);

    STATE.machine = machine;
    STATE.stock   = stock;

    // Filter orders for the day
    const dayOrders = allOrders.filter(o => {
      if (o.order_status != 5) return false;
      const t = o.pay_time || '';
      return t >= start && t < end;
    });

    console.log(`📦 Found ${dayOrders.length} orders for ${dateLabel}`);

    // Build SKU summary
    const skuSummary = {};
    CFG.products.forEach(p => { skuSummary[p.code] = { count:0, rev:0 }; });
    dayOrders.forEach(o => {
      const g = o.goods?.[0] || {};
      const p = getProductCode(g.goods_name||'');
      if (p) {
        skuSummary[p.code].count++;
        skuSummary[p.code].rev += parseFloat(o.order_amount||0);
      }
    });

    // Build HTML
    const html = buildDailyHtml(dayOrders, skuSummary, stock, machine, dateLabel, yesterday);

    // Build Excel
    const excelPath = await buildExcel(dayOrders, skuSummary, stock, dateLabel);

    // Send email
    await sendEmail(
      `Daily Report - ${dateLabel}`,
      html,
      [{
        filename: path.basename(excelPath),
        path:     excelPath,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }]
    );

    // Clean up
    fs.unlink(excelPath, ()=>{});
    console.log('✅ Daily report sent!');

  } catch(e) {
    logError(`Daily report failed: ${e.message}`);
    await sendEmail('⚠️ Daily Report Error', alertEmail('⚠️','Daily Report Failed',[`Error: ${e.message}`,'Please check the monitor server.']));
  }
}

// ── SEND MONTHLY REPORT ───────────────────────────────────────────────────
async function sendMonthlyReport() {
  console.log('\n📊 Building monthly report...');
  try {
    const now = nowKSA();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthLabel = prevMonth.toLocaleDateString('en', { month:'long', year:'numeric' });

    // Start/end in China time
    const start = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth()+1).padStart(2,'0')}-01 05:00:00`;
    const nextM  = new Date(prevMonth.getFullYear(), prevMonth.getMonth()+1, 1);
    const end    = `${nextM.getFullYear()}-${String(nextM.getMonth()+1).padStart(2,'0')}-01 05:00:00`;

    const allOrders = await fetchAllOrders();
    const monOrders = allOrders.filter(o => o.order_status==5 && (o.pay_time||'') >= start && (o.pay_time||'') < end);

    console.log(`📦 ${monOrders.length} orders in ${monthLabel}`);

    // SKU summary
    const skuSummary = {};
    CFG.products.forEach(p => { skuSummary[p.code] = { count:0, rev:0 }; });
    monOrders.forEach(o => {
      const g = o.goods?.[0]||{};
      const p = getProductCode(g.goods_name||'');
      if(p) { skuSummary[p.code].count++; skuSummary[p.code].rev += parseFloat(o.order_amount||0); }
    });

    const totalRev = monOrders.reduce((s,o)=>s+parseFloat(o.order_amount||0),0);
    const machine  = await fetchMachine();
    const stock    = await fetchStock();

    // Build Excel
    const excelPath = await buildExcel(monOrders, skuSummary, stock, `${monthLabel} (Monthly)`);

    // Simple monthly HTML
    const skuTable = CFG.products.map(p => {
      const s = skuSummary[p.code];
      return `<tr style="background:#fff">
        <td style="padding:10px 12px;border-bottom:1px solid #F0E4D0;font-family:monospace;color:#F5A623;font-weight:700">${p.code}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F0E4D0;font-weight:700;color:#1C2E08">${p.emoji} ${p.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F0E4D0;text-align:center;font-weight:900;color:#1B3F8B">${s.count}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F0E4D0;text-align:right;font-weight:900;color:#5A9E1E">${s.rev.toFixed(2)} SAR</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;background:#F8F1E7;font-family:Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 30px rgba(0,0,0,.15)">
  <div style="background:#F8F1E7;padding:24px 30px;text-align:center;border-bottom:3px solid #F5A623">
    <div style="color:#1B3F8B;font-size:14px;font-weight:900;letter-spacing:2px;margin-bottom:8px">RADWA SMART VENDING</div>
    <div style="color:#F5A623;font-size:20px;font-weight:900;margin-bottom:8px">📊 MONTHLY REPORT</div>
    <div style="background:#1B3F8B;border-radius:20px;padding:7px 20px;display:inline-block">
      <span style="color:#fff;font-size:13px;font-weight:700">📅 ${monthLabel} · Dahban Machine</span>
    </div>
  </div>
  <div style="padding:24px 30px">
    <div style="display:flex;gap:10px;margin-bottom:24px">
      <div style="flex:1;text-align:center;padding:16px;background:#EEF3FC;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:28px;font-weight:900;color:#1B3F8B">${monOrders.length}</div>
        <div style="font-size:11px;color:#7A9660">Total Orders</div>
      </div>
      <div style="flex:1;text-align:center;padding:16px;background:#EEF5E8;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:28px;font-weight:900;color:#5A9E1E">${totalRev.toFixed(2)}</div>
        <div style="font-size:11px;color:#7A9660">Total Revenue (SAR)</div>
      </div>
      <div style="flex:1;text-align:center;padding:16px;background:#FDF8F2;border-radius:12px;border:1.5px solid #E8D5B7">
        <div style="font-size:28px;font-weight:900;color:#F5A623">${(totalRev/Math.max(monOrders.length,1)).toFixed(2)}</div>
        <div style="font-size:11px;color:#7A9660">Avg per Order (SAR)</div>
      </div>
    </div>
    <div style="margin-bottom:10px"><span style="background:#1B3F8B;color:#fff;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700">📦 SKU SUMMARY · ${monthLabel}</span></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-radius:12px;overflow:hidden;border:1.5px solid #E8D5B7;font-size:12px;margin-bottom:20px">
      <thead><tr style="background:#1B3F8B">
        <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px">CODE</th>
        <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px">PRODUCT</th>
        <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px">QTY SOLD</th>
        <th style="padding:10px 12px;text-align:right;color:#fff;font-size:10px">REVENUE</th>
      </tr></thead>
      <tbody>
        ${skuTable}
        <tr style="background:#FDF0D8">
          <td colspan="2" style="padding:13px 12px;font-weight:900;color:#1C2E08;font-size:14px">🏆 GRAND TOTAL</td>
          <td style="padding:13px 12px;text-align:center;font-weight:900;color:#1B3F8B;font-size:16px">${monOrders.length}</td>
          <td style="padding:13px 12px;text-align:right;font-weight:900;color:#5A9E1E;font-size:18px">${totalRev.toFixed(2)} SAR</td>
        </tr>
      </tbody>
    </table>
    <div style="background:#FDF8F0;border:1.5px solid #F5A623;border-radius:10px;padding:12px;font-size:11px;color:#8B4000">
      📎 Full Excel report attached · All ${monOrders.length} orders included
    </div>
  </div>
  <div style="background:#1B3F8B;padding:16px 30px;text-align:center;font-size:10px;color:rgba(255,255,255,.5)">
    Radwa Monitor · Machine ${CFG.deviceId} · Monthly report sent 09:00 AM KSA on 1st of each month
  </div>
</div>
</body></html>`;

    await sendEmail(`Monthly Report - ${monthLabel}`, html, [{
      filename: path.basename(excelPath),
      path: excelPath,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
    fs.unlink(excelPath, ()=>{});
    console.log('✅ Monthly report sent!');

  } catch(e) {
    logError(`Monthly report failed: ${e.message}`);
  }
}

// ── MAIN CHECK (every 5 min) ──────────────────────────────────────────────
async function doCheck() {
  STATE.lastCheck = new Date().toISOString();
  console.log(`\n🔍 Check at ${nowKSA().toLocaleString()} KSA`);

  try {
    // Login if needed
    if (!STATE.token) {
      const ok = await login();
      if (!ok) { logError('Login failed'); return; }
    }

    // Fetch all data
    const [allOrders, machine, stock] = await Promise.all([
      fetchAllOrders(),
      fetchMachine(),
      fetchStock().catch(()=>({})),
    ]);

    STATE.machine = machine;
    STATE.stock   = stock;

    const { temp, online, lastConn, registered } = machine;
    const now = nowKSA();
    const today = now.toISOString().substring(0,10);
    const mon   = now.toISOString().substring(0,7);

    // Log temp & power
    STATE.tempLog.push({ time: now.toISOString(), temp });
    STATE.powerLog.push({ time: now.toISOString(), online });
    // Keep only last 24h
    const cutoff = new Date(now.getTime() - 24*3600000).toISOString();
    STATE.tempLog  = STATE.tempLog.filter(l => l.time > cutoff);
    STATE.powerLog = STATE.powerLog.filter(l => l.time > cutoff);

    // KSA today/month strings (timezone-safe)
    const ksaNow   = new Date(Date.now() + 3*3600000);
    const todayKSA = ksaNow.toISOString().substring(0,10);  // YYYY-MM-DD
    const monKSA   = ksaNow.toISOString().substring(0,7);   // YYYY-MM

    // Stats
    const done     = allOrders.filter(o => o.order_status == 5);
    const todayD   = done.filter(o => toKSATime(o.pay_time).startsWith(todayKSA));
    const monD     = done.filter(o => toKSATime(o.pay_time).startsWith(monKSA));
    STATE.stats = {
      today:      todayD.reduce((s,o)=>s+parseFloat(o.order_amount||0),0),
      todayCount: todayD.length,
      month:      monD.reduce((s,o)=>s+parseFloat(o.order_amount||0),0),
      monCount:   monD.length,
      totalDone:  done.length,
      total:      allOrders.length,
      todayOrders: todayD,  // store today's orders for the dashboard tables
      monthOrders: monD,    // store this month's orders for the dashboard tables
    };

    console.log(`⚡ ${online?'ONLINE':'OFFLINE'} | 🌡️ ${temp}°C | ✅ ${done.length} orders`);

    // ── POWER ALERT ──
    if (STATE.lastPower !== null && STATE.lastPower === true && !online) {
      await sendEmail('🔴 Machine is OFFLINE!', alertEmail('🔴','Machine is OFFLINE!',[
        `Your Radwa vending machine has gone <strong>OFFLINE</strong>!`,
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        `Location: <strong>${CFG.location}</strong>`,
        `Last seen: <strong>${lastConn}</strong>`,
        machine.stale ? `Reason: the platform still says online, but no heartbeat for <strong>${machine.staleMins} min</strong> (data is stale). The machine may have lost its registration or connection.` : 'Reason: the platform reports the machine as offline.',
        'Please check the machine immediately.',
      ]));
    }
    // ── POWER RECOVERY ──
    if (STATE.lastPower !== null && STATE.lastPower === false && online) {
      await sendEmail('🟢 Machine is Back ONLINE!', alertEmail('🟢','Machine is Back ONLINE!',[
        'Your Radwa vending machine is back online.',
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        `Connected at: <strong>${lastConn}</strong>`,
      ]));
    }
    STATE.lastPower = online;

    // ── REGISTRATION ALERTS ──
    // Not registered: alert on the first check too (startup) and on any registered -> not registered change.
    if (!registered && STATE.lastRegistered !== false) {
      await sendEmail('⚠️ Machine is NOT REGISTERED!', alertEmail('⚠️','Machine is NOT REGISTERED!',[
        'Your Radwa vending machine is <strong>not registered / not connected</strong> on the DW Vending platform.',
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        `Location: <strong>${CFG.location}</strong>`,
        `Last connection: <strong>${lastConn}</strong>`,
        'The machine may be powered but unable to identify itself, so it cannot sell. Try a full power-cycle, check the SIM/4G module, then contact DW Vending support.',
      ]));
    }
    // Registered again: only after a confirmed not-registered state.
    if (registered && STATE.lastRegistered === false) {
      await sendEmail('✅ Machine is REGISTERED again', alertEmail('✅','Machine is REGISTERED again',[
        'Your Radwa vending machine is registered and connected again.',
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        `Connected at: <strong>${lastConn}</strong>`,
      ]));
    }
    STATE.lastRegistered = registered;

    // ── TEMP ALERT ──
    if (temp >= CFG.tempAlert && !STATE.lastTempAlert) {
      await sendEmail(`🌡️ Temperature Alert: ${temp}°C`, alertEmail('🌡️',`Temperature Alert: ${temp}°C`,[
        `Machine temperature is <strong>${temp}°C</strong> which is ABOVE the safe threshold of <strong>${CFG.tempAlert}°C</strong>!`,
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        'Please check the refrigeration system immediately!',
      ]));
      STATE.lastTempAlert = true;
    } else if (temp < CFG.tempAlert) {
      STATE.lastTempAlert = false;
    }

    // ── NEW SALE ALERTS ──
    const doneCount = done.length;
    const startupTimeKSA = toKSATime(new Date(STATE.startTime.getTime() - 3*3600000).toISOString().replace('T',' ').substring(0,19));

    if (STATE.lastDoneCount > 0 && doneCount > STATE.lastDoneCount) {
      // Don't trust array ordering — find genuinely new orders by filtering on timestamp:
      // (a) order must be from today (KSA)
      // (b) order must be paid AFTER the service started
      const candidates = done.filter(o => {
        const ksaPayTime = toKSATime(o.pay_time);
        if (!ksaPayTime || ksaPayTime === '—') return false;
        if (!ksaPayTime.startsWith(todayKSA)) return false;       // must be today
        if (ksaPayTime < startupTimeKSA) return false;             // must be after startup
        return true;
      });

      // Of those, only alert on ones we haven't already alerted on
      STATE.alertedOrderIds = STATE.alertedOrderIds || new Set();
      const trulyNew = candidates.filter(o => {
        const id = o.order_no || o.id || `${o.pay_time}-${o.order_amount}`;
        return !STATE.alertedOrderIds.has(id);
      });

      for (const o of trulyNew) {
        const g     = o.goods?.[0] || {};
        const prod  = getProductCode(g.goods_name||'');
        const apiS  = String(g.cargoway_num||o.cargoway_num||'');
        const slot  = CFG.slotMap[apiS] || apiS || '—';
        const price = parseFloat(g.sale_price||o.order_amount||0).toFixed(2);
        const ksaT  = toKSATime(o.pay_time);
        const id    = o.order_no || o.id || `${o.pay_time}-${o.order_amount}`;

        await sendEmail(
          `✅ New Sale! ${prod?.name||'Unknown'}`,
          alertEmail('✅',`New Sale! ${prod?.emoji||''} ${prod?.name||'Unknown'}`,[
            `Product: <strong>${prod?.code||'—'} · ${prod?.name||g.goods_name||'Unknown'}</strong>`,
            `Slot: <strong>${slot}</strong>`,
            `Price: <strong>${price} SAR</strong>`,
            `Time: <strong>${ksaT} KSA</strong>`,
            `Today's total: <strong>${STATE.stats.today.toFixed(2)} SAR (${STATE.stats.todayCount} orders)</strong>`,
          ])
        );

        STATE.alertedOrderIds.add(id);
      }

      // Cap memory: keep only the most recent 500 alerted IDs
      if (STATE.alertedOrderIds.size > 500) {
        STATE.alertedOrderIds = new Set(Array.from(STATE.alertedOrderIds).slice(-500));
      }
    }
    STATE.lastDoneCount = doneCount;

    // ── SKU STOCK ALERTS ──
    for (const prod of CFG.products) {
      const totalUnits = prod.slots.reduce((s,sl)=>s+(stock[sl]?.vol||0),0);
      const key = prod.code;

      // Determine current state
      const currentState = totalUnits === 0 ? 'empty'
                         : totalUnits <= 2 ? 'low'
                         : 'ok';

      // On first check after startup, just record state — don't email
      if (STATE.firstStockCheck) {
        STATE.lastSkuAlerts[key] = currentState;
        continue;
      }

      // On subsequent checks, only alert when state changes to a worse state
      if (currentState === 'empty' && STATE.lastSkuAlerts[key] !== 'empty') {
        await sendEmail(`📦 ${prod.code} is EMPTY!`, alertEmail('📦',`${prod.emoji} ${prod.code} is EMPTY!`,[
          `<strong>${prod.name}</strong> has reached <strong>0 units</strong>!`,
          `Slots: ${prod.slots.map(s=>CFG.slotMap[s]||s).join(', ')}`,
          'Please replenish immediately.',
        ]));
      } else if (currentState === 'low' && STATE.lastSkuAlerts[key] === 'ok') {
        // Only alert "low" when transitioning from OK → low (not from empty → low, that's improvement)
        await sendEmail(`⚠️ ${prod.code} Low Stock (${totalUnits} units)`, alertEmail('⚠️',`${prod.emoji} ${prod.code} Low Stock!`,[
          `<strong>${prod.name}</strong> has only <strong>${totalUnits} unit${totalUnits!==1?'s':''}</strong> remaining!`,
          `Slots: ${prod.slots.map(s=>`${CFG.slotMap[s]||s}:${stock[s]?.vol||0}`).join(' ')}`,
          'Consider replenishing soon.',
        ]));
      }

      STATE.lastSkuAlerts[key] = currentState;
    }

    // After the first check, all subsequent checks behave normally
    if (STATE.firstStockCheck) {
      STATE.firstStockCheck = false;
      console.log('✅ First stock check complete — alerts now active');
    }
    // ── SCHEDULE CHECK ──
    // Compute current KSA time (UTC+3) using safe UTC math
    const utcNow = new Date();
    const ksaH   = (utcNow.getUTCHours() + 3) % 24;
    const ksaM   = utcNow.getUTCMinutes();
    const ksaDay = new Date(utcNow.getTime() + 3*3600000).getUTCDate();
    const ksaToday = new Date(utcNow.getTime() + 3*3600000).toISOString().substring(0,10);
    const ksaMon   = new Date(utcNow.getTime() + 3*3600000).toISOString().substring(0,7);

    // Daily report at 09:30 KSA — fire any time between 09:30 and 09:59 (one-shot per day)
    if (ksaH === 9 && ksaM >= 30) {
      const reportKey = `daily-${ksaToday}`;
      if (!STATE.lastSkuAlerts[reportKey]) {
        STATE.lastSkuAlerts[reportKey] = true;
        console.log(`📅 Triggering daily report (KSA ${ksaH}:${String(ksaM).padStart(2,'0')})`);
        sendDailyReport(now);
      }
    }

    // Monthly report at 09:00 KSA on 1st of month — fire any time between 09:00 and 09:29 (one-shot per month)
    if (ksaDay === 1 && ksaH === 9 && ksaM < 30) {
      const monKey = `monthly-${ksaMon}`;
      if (!STATE.lastSkuAlerts[monKey]) {
        STATE.lastSkuAlerts[monKey] = true;
        console.log(`📅 Triggering monthly report (KSA ${ksaH}:${String(ksaM).padStart(2,'0')})`);
        sendMonthlyReport();
      }
    }
  } catch(e) {
    logError(`Check failed: ${e.message}`);
    if (e.message.includes('401') || e.message.includes('403')) STATE.token = '';
  }
}

// ── WEB DASHBOARD ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const up = process.uptime();
  const { temp, online, powered, signalMins, registeredExplicit, lastConn, registered, stale, staleMins } = STATE.machine;
  const pC = powered ? '#5A9E1E' : '#C8002A';
  const tC = temp >= CFG.tempAlert ? '#C8002A' : '#1B3F8B';

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Radwa Vending Machine Monitor</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Cairo',sans-serif;background:#F8F1E7;color:#1C2E08;padding:0}
.nav{background:#F8F1E7;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #F5A623;flex-wrap:wrap;gap:12px}
.nav-l{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand-logo{height:64px;width:auto;object-fit:contain;flex-shrink:0}
.brand-text{font-size:24px;font-weight:900;color:#1B3F8B;letter-spacing:3px}
.brand-title{color:#1B3F8B;font-size:15px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase}
.nav-r{color:#7A9660;font-size:11px;text-align:right;display:flex;flex-direction:column;gap:3px;font-weight:700}
.nav-stat{background:#fff;padding:5px 11px;border-radius:14px;border:1.5px solid #E8D5B7;font-family:Cairo,sans-serif}
.wrap{max-width:960px;margin:20px auto;padding:0 16px}
.tabs{max-width:960px;margin:14px auto 0;padding:0 16px;display:flex;gap:6px;flex-wrap:wrap}
.pill{padding:7px 14px;font-size:13px;font-weight:700;border-radius:16px;background:#fff;color:#57534e;border:1px solid #e7e5e4;text-decoration:none}
.pill.on{background:#84BD00;color:#173404;border-color:#84BD00}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:20px}
.tile{display:flex;align-items:center;gap:14px;border-radius:16px;padding:20px;text-decoration:none;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.tile.t1{background:#84BD00;color:#173404}.tile.t2{background:#173404;color:#84BD00}
.ti{width:48px;height:48px;border-radius:14px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.tx{flex:1;min-width:0}.tt{font-size:17px;font-weight:900}.td{font-size:12px;font-weight:600;margin-top:2px;opacity:.85}
.tile span{font-size:26px;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{background:#fff;border:1.5px solid #E8D5B7;border-radius:14px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.ci{font-size:24px;margin-bottom:8px}
.cl{font-size:9px;color:#7A9660;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px}
.cv{font-size:20px;font-weight:900;line-height:1;margin-bottom:3px}
.cs{font-size:10px;color:#7A9660}
.sec{background:#fff;border:1.5px solid #E8D5B7;border-radius:14px;overflow:hidden;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.sh{padding:11px 16px;color:#fff;font-weight:700;font-size:13px}
.sb{padding:14px}
.ar{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid #F0E4D0;font-size:12px}
.ar:last-child{border-bottom:none}
.at{color:#7A9660;flex-shrink:0;width:150px;font-size:10px}
.as{font-weight:700;color:#1C2E08}
.er{padding:8px 0;border-bottom:1px solid #F0E4D0;font-size:11px;color:#C8002A}
footer{text-align:center;padding:20px;font-size:11px;color:#7A9660;letter-spacing:1px}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700}
</style></head>
<body>
<div class="nav">
  <div class="nav-l">
   <img src="https://raw.githubusercontent.com/abdobazzaz/d.js/main/New%20Radwa%20Logo%20with%20text-%20trasperant.png" alt="Radwa" class="brand-logo">
    <div class="brand-title">RADWA VENDING MACHINE MONITOR</div>
  </div>
  <div class="nav-r">
    <div class="nav-stat">🔄 Auto-refresh: 60s</div>
    <div class="nav-stat">⏱️ Uptime: ${Math.floor(up/3600)}h ${Math.floor(up%3600/60)}m</div>
  </div>
</div>
<div class="tabs">
  <a class="pill on" href="/">Monitor</a><a class="pill" href="/sales">Sales</a><a class="pill" href="/refill">Refill</a>
</div>
<div class="wrap">
   <div class="grid">
    <!-- 1. Power Status -->
    <div class="card" style="border-top:3px solid ${pC}">
      <div class="ci">${powered?'🟢':'🔴'}</div><div class="cl">Power Status</div>
      <div class="cv" style="color:${pC}">${powered?'POWERED ON':'POWERED OFF'}</div>
      <div class="cs">${signalMins == null ? 'No signal data' : powered ? `Last signal ${signalMins} min ago` : `No signal for ${signalMins} min`}</div>
    </div>

    <!-- 2. Connection -->
    ${(() => {
      const cC = online ? '#5A9E1E' : '#C8002A';
      const lastTxt = lastConn !== '—' ? new Date(lastConn.replace(' ', 'T') + ':00+03:00').toLocaleString('en-GB', { timeZone:'Asia/Riyadh', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true }) : '—';
      return `<div class="card" style="border-top:3px solid ${cC}">
      <div class="ci">🌐</div><div class="cl">Connection</div>
      <div class="cv" style="color:${cC}">${online?'✅ Connected':'❌ Not Connected'}</div>
      <div class="cs">Last connection: ${lastTxt}</div>
      ${registeredExplicit !== null && registeredExplicit !== undefined ? `<div class="cs">Registration: ${registeredExplicit?'Registered':'Not registered'}</div>` : ''}
      ${stale ? `<div class="cs" style="color:#C8002A">⚠️ STALE: no heartbeat for ${staleMins} min</div>` : ''}
    </div>`;
    })()}

    <!-- 3. Temperature -->
    <div class="card" style="border-top:3px solid ${tC}">
      <div class="ci">🌡️</div><div class="cl">Temperature</div>
      <div class="cv" style="color:${tC}">${temp}°C</div>
      <div class="cs">${temp>=CFG.tempAlert?'⚠️ CRITICAL':'✓ Normal'} · Last: ${STATE.lastCheck ? new Date(STATE.lastCheck).toLocaleString('en-GB', { timeZone:'Asia/Riyadh', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true }) : '—'}</div>
    </div>

    <!-- 3. Total Units (NEW) -->
    ${(() => {
      const totalUnits = CFG.products.reduce((s,p) => s + p.slots.reduce((ss,sl) => ss + (STATE.stock[sl]?.vol || 0), 0), 0);
      const totalCap   = CFG.products.reduce((s,p) => s + (p.code === 'EFMC06' ? 12 : 8), 0);
      const pct        = totalCap > 0 ? Math.round(totalUnits/totalCap*100) : 0;
      const restock    = pct < 20;
      const uColor     = totalUnits === 0 || restock ? '#C8002A' : totalUnits < totalCap*0.3 ? '#E07020' : '#5A9E1E';
      return `
    <div class="card" style="border-top:3px solid ${uColor}">
      <div class="ci">📦</div><div class="cl">Total Units in Machine</div>
      <div class="cv" style="color:${uColor}">${totalUnits} / ${totalCap}</div>
      ${restock ? '<div class="cs" style="color:#C8002A;font-weight:700">⚠️ Restock needed</div>' : ''}
      <div class="cs">${pct}% full · Last: ${STATE.lastCheck ? new Date(STATE.lastCheck).toLocaleString('en-GB', { timeZone:'Asia/Riyadh', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true }) : '—'}</div>
    </div>`;
    })()}

    <!-- 4. Alerts Sent -->
    <div class="card" style="border-top:3px solid #7A9660">
      <div class="ci">📧</div><div class="cl">Alerts Sent</div>
      <div class="cv" style="color:#7A9660">${STATE.alerts.length}</div>
      <div class="cs">to ${CFG.email.to}</div>
    </div>

    <!-- 5. Today Revenue -->
    <div class="card" style="border-top:3px solid #5A9E1E">
      <div class="ci">💰</div><div class="cl">Today Revenue</div>
      <div class="cv" style="color:#5A9E1E">${STATE.stats.today.toFixed(2)} SAR</div>
      <div class="cs">${STATE.stats.todayCount} orders today</div>
    </div>

    <!-- 6. This Month -->
    <div class="card" style="border-top:3px solid #1B3F8B">
      <div class="ci">💵</div><div class="cl">This Month</div>
      <div class="cv" style="color:#1B3F8B">${STATE.stats.month.toFixed(2)} SAR</div>
      <div class="cs">${STATE.stats.monCount} orders</div>
    </div>

    <!-- 7. Completed Today -->
    <div class="card" style="border-top:3px solid #F5A623">
      <div class="ci">✅</div><div class="cl">Completed Today</div>
      <div class="cv" style="color:#F5A623">${STATE.stats.todayCount}</div>
      <div class="cs">${new Date().toLocaleDateString('en-GB', { timeZone:'Asia/Riyadh', weekday:'long', day:'numeric', month:'short' })}</div>
    </div>

    <!-- 8. Completed This Month -->
    <div class="card" style="border-top:3px solid #1B3F8B">
      <div class="ci">📅</div><div class="cl">Completed This Month</div>
      <div class="cv" style="color:#1B3F8B">${STATE.stats.monCount}</div>
      <div class="cs">${new Date().toLocaleDateString('en-GB', { timeZone:'Asia/Riyadh', month:'long', year:'numeric' })}</div>
    </div>
  </div>
  <div class="tiles">
    <a class="tile t1" href="/sales"><div class="ti"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></div><div class="tx"><div class="tt">Sales report</div><div class="td">Pick a date range, see revenue by day and product, export to Excel</div></div><span>›</span></a>
    <a class="tile t2" href="/refill"><div class="ti"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg></div><div class="tx"><div class="tt">Refill history</div><div class="td">Who refilled, when, and how many units went into each product</div></div><span>›</span></a>
  </div>
  <div class="sec">
    <div class="sh" style="background:#1B3F8B">⚙️ Monitor Status</div>
    <div class="sb">
      ${[
        ['Status','🟢 Running 24/7'],
        ['Last Check', STATE.lastCheck ? new Date(STATE.lastCheck).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: true }) + ' KSA' : 'Starting...'],
        ['Check Interval','Every 5 minutes'],
        ['Machine ID', CFG.deviceId],
        ['Location', CFG.location],
        ...(registeredExplicit !== null && registeredExplicit !== undefined ? [['Registration', registeredExplicit ? '✅ Registered' : '❌ Not registered']] : []),
        ['Alert Email', CFG.email.to],
        ['Daily Report','09:30 AM KSA every day'],
        ['Monthly Report','09:00 AM KSA on 1st of each month'],
        ['Temp Threshold',`${CFG.tempAlert}°C`],
        ['Stock Low Alert','≤ 2 units per SKU'],
        ['Stock OK','≥ 3 units per SKU'],
      ].map(([l,v])=>`<div class="ar"><span class="at">${l}</span><span class="as">${v}</span></div>`).join('')}
    </div>
  </div>

    ${(() => {
    const todayOrders = STATE.stats.todayOrders || [];
    const totalRev = todayOrders.reduce((s,o)=>s+parseFloat(o.order_amount||0),0);

    // Build SKU summary for today
    const skuSum = {};
    CFG.products.forEach(p => { skuSum[p.code] = { count:0, rev:0 }; });
    todayOrders.forEach(o => {
      const g = o.goods?.[0] || {};
      const p = getProductCode(g.goods_name||'');
      if (p) {
        skuSum[p.code].count++;
        skuSum[p.code].rev += parseFloat(o.order_amount||0);
      }
    });

    const todayLabel = new Date().toLocaleDateString('en-GB', { timeZone:'Asia/Riyadh', weekday:'long', day:'numeric', month:'long', year:'numeric' });

    // Table 1: SKU Summary
    const skuRows = CFG.products.map(p => {
      const s = skuSum[p.code];
      const has = s.count > 0;
      return `<tr style="border-bottom:1px solid #F0E4D0">
        <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:#F5A623;font-size:11px">${p.code}</td>
        <td style="padding:9px 12px;font-weight:${has?'700':'400'};color:${has?'#1C2E08':'#999'};font-size:12px">${p.emoji} ${p.name}</td>
        <td style="padding:9px 12px;text-align:center"><span style="background:${has?'#1B3F8B':'#F0F0F0'};color:${has?'#fff':'#999'};padding:3px 10px;border-radius:14px;font-size:11px;font-weight:700">${s.count}</span></td>
        <td style="padding:9px 12px;text-align:right;font-weight:${has?'900':'400'};color:${has?'#5A9E1E':'#999'};font-size:12px">${s.rev.toFixed(2)} SAR</td>
      </tr>`;
    }).join('');

    // Table 2: All Purchases
    const purRows = todayOrders.length === 0
      ? `<tr><td colspan="6" style="padding:20px;text-align:center;color:#7A9660;font-size:12px">No completed orders today yet</td></tr>`
      : todayOrders.map((o,i) => {
          const g = o.goods?.[0] || {};
          const prod = getProductCode(g.goods_name||'');
          const apiS = String(g.cargoway_num || o.cargoway_num || '');
          const slot = CFG.slotMap[apiS] || apiS || '—';
          const ksaT = toKSATime(o.pay_time).substring(11);
          const price = parseFloat(g.sale_price || o.order_amount || 0).toFixed(2);
          return `<tr style="border-bottom:1px solid #F0E4D0">
            <td style="padding:8px 10px;text-align:center;color:#7A9660;font-size:11px">${i+1}</td>
            <td style="padding:8px 10px;font-family:monospace;font-weight:700;color:#F5A623;font-size:10px">${prod?.code||'—'}</td>
            <td style="padding:8px 10px;font-weight:700;color:#1C2E08;font-size:11px">${prod?.emoji||''} ${prod?.name||g.goods_name||'—'}</td>
            <td style="padding:8px 10px;text-align:center"><span style="background:#EEF5E8;color:#5A9E1E;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:10px;font-weight:700">${slot}</span></td>
            <td style="padding:8px 10px;text-align:center;font-weight:700;color:#1B3F8B;font-size:12px">${ksaT}</td>
            <td style="padding:8px 10px;text-align:right;font-weight:900;color:#5A9E1E;font-size:12px">${price} SAR</td>
          </tr>`;
        }).join('');

    return `
  <div class="sec">
    <div class="sh" style="background:#5A9E1E">📦 Today's SKU Summary · ${todayLabel}</div>
    <div class="sb" style="padding:0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <thead><tr style="background:#1B3F8B">
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">CODE</th>
          <th style="padding:10px 12px;text-align:left;color:#fff;font-size:10px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:10px 12px;text-align:center;color:#fff;font-size:10px;letter-spacing:1px">QTY SOLD</th>
          <th style="padding:10px 12px;text-align:right;color:#fff;font-size:10px;letter-spacing:1px">REVENUE</th>
        </tr></thead>
        <tbody>
          ${skuRows}
          <tr style="background:#FDF0D8">
            <td colspan="2" style="padding:11px 12px;font-weight:900;color:#1C2E08;font-size:13px">🏆 GRAND TOTAL</td>
            <td style="padding:11px 12px;text-align:center"><span style="background:#1B3F8B;color:#fff;padding:4px 14px;border-radius:14px;font-size:13px;font-weight:900">${todayOrders.length}</span></td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;color:#1B3F8B;font-size:16px">${totalRev.toFixed(2)} SAR</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="sec">
    <div class="sh" style="background:#1B3F8B">✅ Today's All Purchases (${todayOrders.length})</div>
    <div class="sb" style="padding:0;overflow-x:auto">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:560px">
        <thead><tr style="background:#1B3F8B">
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">#</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">CODE</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">SLOT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">TIME (KSA)</th>
          <th style="padding:9px 10px;text-align:right;color:#fff;font-size:9px;letter-spacing:1px">PRICE</th>
        </tr></thead>
        <tbody>
          ${purRows}
          ${todayOrders.length > 0 ? `
          <tr style="background:#D0DCF5">
            <td colspan="5" style="padding:11px 12px;font-weight:900;color:#1B3F8B;font-size:12px">TOTAL · ${todayOrders.length} order${todayOrders.length!==1?'s':''}</td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;color:#1B3F8B;font-size:14px">${totalRev.toFixed(2)} SAR</td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>
`;
  })()}
  <div class="sec">
    <div class="sh" style="background:#5A9E1E">📦 Current Stock (${Object.keys(STATE.stock).length} slots)</div>
    <div class="sb">
      ${CFG.products.map(p=>{
        const u=p.slots.reduce((s,sl)=>s+(STATE.stock[sl]?.vol||0),0);
        const c=p.slots.length*2;
        const st=u===0?'EMPTY':u<=2?'LOW':'OK';
        const sc=st==='OK'?'#5A9E1E':st==='LOW'?'#E07020':'#C8002A';
        return `<div class="ar"><span class="at" style="font-weight:700">${p.code}</span><span style="flex:1;font-size:12px;color:#1C2E08">${p.emoji} ${p.name}</span><span class="badge" style="background:${st==='OK'?'#EEF5E8':st==='LOW'?'#FFF5EC':'#FEF0F0'};color:${sc};border:1px solid ${sc}">${u}/${c} · ${st}</span></div>`;
      }).join('')}
    </div>
  </div>
    ${(() => {
    const monthOrders = STATE.stats.monthOrders || [];
    const totalRev = monthOrders.reduce((s,o)=>s+parseFloat(o.order_amount||0),0);
    const monthLabel = new Date().toLocaleDateString('en-GB', { timeZone:'Asia/Riyadh', month:'long', year:'numeric' });

    // Sort newest first so the latest sales are at the top
    const sorted = [...monthOrders].sort((a,b) => (b.pay_time||'').localeCompare(a.pay_time||''));

    const purRows = sorted.length === 0
      ? `<tr><td colspan="6" style="padding:20px;text-align:center;color:#7A9660;font-size:12px">No completed orders this month yet</td></tr>`
      : sorted.map((o,i) => {
          const g = o.goods?.[0] || {};
          const prod = getProductCode(g.goods_name||'');
          const apiS = String(g.cargoway_num || o.cargoway_num || '');
          const slot = CFG.slotMap[apiS] || apiS || '—';
          const ksaT = toKSATime(o.pay_time);
          const ksaDate = ksaT.substring(0,10);
          const ksaTime = ksaT.substring(11);
          const price = parseFloat(g.sale_price || o.order_amount || 0).toFixed(2);
          return `<tr style="border-bottom:1px solid #F0E4D0">
            <td style="padding:8px 10px;text-align:center;color:#7A9660;font-size:11px">${i+1}</td>
            <td style="padding:8px 10px;font-family:monospace;font-weight:700;color:#F5A623;font-size:10px">${prod?.code||'—'}</td>
            <td style="padding:8px 10px;font-weight:700;color:#1C2E08;font-size:11px">${prod?.emoji||''} ${prod?.name||g.goods_name||'—'}</td>
            <td style="padding:8px 10px;text-align:center"><span style="background:#EEF5E8;color:#5A9E1E;padding:2px 7px;border-radius:4px;font-family:monospace;font-size:10px;font-weight:700">${slot}</span></td>
            <td style="padding:8px 10px;text-align:center;font-size:11px"><div style="color:#1B3F8B;font-weight:700">${ksaTime}</div><div style="color:#7A9660;font-size:9px">${ksaDate}</div></td>
            <td style="padding:8px 10px;text-align:right;font-weight:900;color:#5A9E1E;font-size:12px">${price} SAR</td>
          </tr>`;
        }).join('');

    return `
  <div class="sec">
    <div class="sh" style="background:#1B3F8B">📅 This Month's All Purchases · ${monthLabel} (${sorted.length})</div>
    <div class="sb" style="padding:0;overflow-x:auto;max-height:600px;overflow-y:auto">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:560px">
        <thead><tr style="background:#1B3F8B;position:sticky;top:0;z-index:1">
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">#</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">CODE</th>
          <th style="padding:9px 10px;text-align:left;color:#fff;font-size:9px;letter-spacing:1px">PRODUCT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">SLOT</th>
          <th style="padding:9px 10px;text-align:center;color:#fff;font-size:9px;letter-spacing:1px">DATE / TIME (KSA)</th>
          <th style="padding:9px 10px;text-align:right;color:#fff;font-size:9px;letter-spacing:1px">PRICE</th>
        </tr></thead>
        <tbody>
          ${purRows}
          ${sorted.length > 0 ? `
          <tr style="background:#D0DCF5">
            <td colspan="5" style="padding:11px 12px;font-weight:900;color:#1B3F8B;font-size:12px">TOTAL · ${sorted.length} order${sorted.length!==1?'s':''}</td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;color:#1B3F8B;font-size:14px">${totalRev.toFixed(2)} SAR</td>
          </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>
`;
  })()}

  <div class="sec">
    <div class="sh" style="background:#F5A623">📧 Recent Alerts (${STATE.alerts.length})</div>
    <div class="sb">
      ${STATE.alerts.length===0
        ? '<div style="text-align:center;color:#7A9660;padding:16px">No alerts yet · All good! ✅</div>'
        : STATE.alerts.slice(0,20).map(a=>`
          <div class="ar">
            <span class="at">${new Date(a.time).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12: true })}</span>
            <span class="as">${a.subject}</span>
          </div>`).join('')}
    </div>
  </div>

  ${STATE.errors.length>0?`
  <div class="sec">
    <div class="sh" style="background:#C8002A">⚠️ Recent Errors</div>
    <div class="sb">
      ${STATE.errors.slice(0,10).map(e=>`<div class="er">${new Date(e.time).toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12: true })} — ${e.msg}</div>`).join('')}
    </div>
  </div>`:''}

</div>
<footer style="background:#1B3F8B;color:rgba(255,255,255,.85);padding:18px 24px;margin-top:24px;text-align:center;font-size:12px;letter-spacing:1.5px;font-weight:700">
  RADWA VENDING MACHINE MONITOR
  <div style="color:rgba(255,255,255,.55);font-size:10px;font-weight:400;letter-spacing:1px;margin-top:4px;text-transform:none">
    ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12: true })} KSA · Checks every 5 minutes · Machine ${CFG.deviceId}
  </div>
</footer>
</body></html>`);
});

// Manual triggers
// ── SALES PAGE: date-range report ─────────────────────────────────────────
let ORDERS_CACHE = { t: 0, data: [] };
async function getOrdersCached() {
  if (Date.now() - ORDERS_CACHE.t < 60000 && ORDERS_CACHE.data.length) return ORDERS_CACHE.data;
  if (!STATE.token) { const ok = await login(); if (!ok) throw new Error('Login failed'); }
  ORDERS_CACHE = { t: Date.now(), data: await fetchAllOrders() };
  return ORDERS_CACHE.data;
}

function parseSalesRange(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date(Date.now() + 3*3600000).toISOString().substring(0,10);
  let from = re.test(q.from||'') ? q.from : today.substring(0,8) + '01';
  let to   = re.test(q.to||'')   ? q.to   : today;
  if (to < from) [from, to] = [to, from];
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().substring(0,10); };
  if (addDays(from, 366) < to) to = addDays(from, 366);
  // KSA midnight = China 05:00 (same day)
  return { from, to, start: `${from} 05:00:00`, end: `${addDays(to, 1)} 05:00:00`, addDays };
}

async function buildSales(q) {
  const r = parseSalesRange(q);
  const all = await getOrdersCached();
  const inRange = all.filter(o => (o.pay_time || '') >= r.start && (o.pay_time || '') < r.end);
  const done = inRange.filter(o => o.order_status == 5);

  const days = {};
  for (let d = r.from; d <= r.to; d = r.addDays(d, 1)) days[d] = { date: d, orders: 0, revenue: 0 };
  const sku = {};
  CFG.products.forEach(p => { sku[p.code] = { code: p.code, name: p.name, emoji: p.emoji, orders: 0, revenue: 0 }; });
  sku.OTHER = { code: '—', name: 'Other / unmapped', emoji: '', orders: 0, revenue: 0 };

  const rows = done.map(o => {
    const g = o.goods?.[0] || {};
    const prod = getProductCode(g.goods_name || '');
    const apiS = String(g.cargoway_num || o.cargoway_num || '');
    const amount = parseFloat(o.order_amount || 0);
    const ksa = toKSATime(o.pay_time);              // 'YYYY-MM-DD HH:MM'
    const day = ksa.substring(0, 10);
    if (days[day]) { days[day].orders++; days[day].revenue += amount; }
    const k = prod ? sku[prod.code] : sku.OTHER;
    k.orders++; k.revenue += amount;
    return { id: o.order_no || o.id || '', time: ksa, sku: prod?.code || '—', product: prod?.name || g.goods_name || '—', slot: CFG.slotMap[apiS] || apiS || '—', amount };
  }).sort((a, b) => b.time.localeCompare(a.time));

  const revenue = rows.reduce((s, x) => s + x.amount, 0);
  const dayList = Object.values(days);
  const best = dayList.reduce((m, d) => (d.revenue > (m?.revenue ?? -1) ? d : m), null);
  const bySku = Object.values(sku).filter(x => x.orders > 0 || x.code !== '—')
    .map(x => ({ ...x, share: revenue ? x.revenue / revenue * 100 : 0 }));

  return {
    from: r.from, to: r.to,
    kpis: {
      revenue, orders: rows.length,
      avgOrder: rows.length ? revenue / rows.length : 0,
      avgPerDay: dayList.length ? revenue / dayList.length : 0,
      bestDay: best && best.revenue > 0 ? best : null,
      notCompleted: inRange.length - done.length,
    },
    daily: dayList, bySku, orders: rows,
  };
}

app.get('/api/sales', async (req, res) => {
  try { res.json(await buildSales(req.query)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sales.xlsx', async (req, res) => {
  try {
    const d = await buildSales(req.query);
    const wb = new ExcelJS.Workbook();
    const head = ws => { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3F8B' } }; };
    const s1 = wb.addWorksheet('Summary');
    s1.columns = [{ header: 'Metric', width: 28 }, { header: 'Value', width: 22 }];
    [['From', d.from], ['To', d.to], ['Revenue (SAR)', +d.kpis.revenue.toFixed(2)], ['Orders', d.kpis.orders],
     ['Average order (SAR)', +d.kpis.avgOrder.toFixed(2)], ['Average per day (SAR)', +d.kpis.avgPerDay.toFixed(2)],
     ['Best day', d.kpis.bestDay ? `${d.kpis.bestDay.date} (${d.kpis.bestDay.revenue.toFixed(2)} SAR)` : '—'],
     ['Not completed orders', d.kpis.notCompleted]].forEach(r => s1.addRow(r));
    head(s1);
    const s2 = wb.addWorksheet('Daily');
    s2.columns = [{ header: 'Date', width: 14 }, { header: 'Orders', width: 10 }, { header: 'Revenue (SAR)', width: 16 }];
    d.daily.forEach(x => s2.addRow([x.date, x.orders, +x.revenue.toFixed(2)])); head(s2);
    const s3 = wb.addWorksheet('By SKU');
    s3.columns = [{ header: 'SKU', width: 10 }, { header: 'Product', width: 36 }, { header: 'Orders', width: 10 }, { header: 'Revenue (SAR)', width: 16 }, { header: 'Share %', width: 10 }];
    d.bySku.forEach(x => s3.addRow([x.code, x.name, x.orders, +x.revenue.toFixed(2), +x.share.toFixed(1)])); head(s3);
    const s4 = wb.addWorksheet('Orders');
    s4.columns = [{ header: 'Order', width: 26 }, { header: 'Time (KSA)', width: 18 }, { header: 'SKU', width: 10 }, { header: 'Product', width: 36 }, { header: 'Slot', width: 8 }, { header: 'Amount (SAR)', width: 14 }];
    d.orders.forEach(x => s4.addRow([x.id, x.time, x.sku, x.product, x.slot, +x.amount.toFixed(2)])); head(s4);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="radwa-sales-${d.from}_to_${d.to}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sales', (req, res) => res.sendFile(path.join(__dirname, 'sales.html')));

// ── REFILL PAGE: replenishment history ────────────────────────────────────
let REFILL_CACHE = { t: 0, data: [], total: null };
async function getRefillRecords() {
  if (Date.now() - REFILL_CACHE.t < 120000 && REFILL_CACHE.data.length) return REFILL_CACHE;
  if (!STATE.token && !STATE.cookie) { const ok = await login(); if (!ok) throw new Error('Login failed'); }
  const LIMIT = 100, BATCH = 4, MAX_PAGES = 24;
  const seen = new Map();
  let total = null, page = 1, done = false;
  while (!done && page <= MAX_PAGES) {
    const pages = Array.from({ length: BATCH }, (_, i) => page + i);
    const results = await Promise.all(pages.map(p =>
      apiFetch(`/api/v1/device/replenishment_stat?page=${p}&limit=${LIMIT}`).catch(e => ({ _err: e.message }))));
    let added = 0;
    for (const r of results) {
      if (r._err) { if (!seen.size) throw new Error(r._err); done = true; continue; }
      const d = r?.data || {};
      if (total == null) total = d.total ?? d.count ?? d.total_count ?? d.totalCount ?? null;
      const recs = Array.isArray(d.records) ? d.records : [];
      if (!recs.length) done = true;
      for (const x of recs) {
        const id = x.record_id ?? `${x.create_at}|${x.cargoway_num}|${x.admin_name}|${x.goods_amount}`;
        if (!seen.has(id)) { seen.set(id, x); added++; }
      }
    }
    if (!added) done = true;
    page += BATCH;
  }
  REFILL_CACHE = { t: Date.now(), data: [...seen.values()], total };
  return REFILL_CACHE;
}

async function buildRefills(q) {
  const r = parseSalesRange(q);
  const cache = await getRefillRecords();
  const ts = s => Date.parse(String(s).replace(' ', 'T') + '+08:00');
  const recs = cache.data
    .filter(x => (x.create_at || '') >= r.start && (x.create_at || '') < r.end)
    .map(x => {
      const prod = getProductCode(x.goods_name || '');
      const apiS = String(x.cargoway_num || '');
      return {
        id: x.record_id, t: ts(x.create_at), time: toKSATime(x.create_at),
        who: x.admin_name || '—', qty: parseInt(x.goods_amount, 10) || 0,
        sku: prod?.code || '—', product: prod?.name || x.goods_name || '—',
        slot: CFG.slotMap[apiS] || apiS || '—',
      };
    }).sort((a, b) => a.t - b.t);

  // Group events into refill sessions: same person, gaps ≤ 30 minutes
  const GAP = 30 * 60000, sessions = [];
  const open = {};
  for (const e of recs) {
    let s = open[e.who];
    if (!s || e.t - s.last > GAP) {
      s = { who: e.who, start: e.time, end: e.time, first: e.t, last: e.t, added: 0, removed: 0, items: {}, slots: new Set() };
      open[e.who] = s; sessions.push(s);
    }
    s.last = e.t; s.end = e.time; s.slots.add(e.slot);
    if (e.qty > 0) s.added += e.qty; else s.removed += -e.qty;
    const k = e.sku;
    (s.items[k] = s.items[k] || { sku: k, product: e.product, added: 0, removed: 0 });
    if (e.qty > 0) s.items[k].added += e.qty; else s.items[k].removed += -e.qty;
  }
  const out = sessions.map(s => ({
    who: s.who, start: s.start, end: s.end, added: s.added, removed: s.removed, net: s.added - s.removed,
    slots: s.slots.size, items: Object.values(s.items),
  })).sort((a, b) => b.start.localeCompare(a.start));

  const bySku = {};
  recs.forEach(e => {
    const b = (bySku[e.sku] = bySku[e.sku] || { sku: e.sku, product: e.product, added: 0, removed: 0 });
    if (e.qty > 0) b.added += e.qty; else b.removed += -e.qty;
  });
  const byWho = {};
  out.forEach(s => {
    const b = (byWho[s.who] = byWho[s.who] || { who: s.who, sessions: 0, added: 0, removed: 0 });
    b.sessions++; b.added += s.added; b.removed += s.removed;
  });
  const added = out.reduce((n, s) => n + s.added, 0), removed = out.reduce((n, s) => n + s.removed, 0);
  return {
    from: r.from, to: r.to,
    kpis: { sessions: out.length, added, removed, net: added - removed, people: Object.keys(byWho).length, last: out[0]?.start || null },
    sessions: out,
    bySku: Object.values(bySku).sort((a, b) => b.added - a.added),
    byWho: Object.values(byWho).sort((a, b) => b.added - a.added),
    events: recs.slice().reverse().map(({ t, ...e }) => e),
    loaded: cache.data.length, total: cache.total,
  };
}

app.get('/api/refills', async (req, res) => {
  try { res.json(await buildRefills(req.query)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/refills.xlsx', async (req, res) => {
  try {
    const d = await buildRefills(req.query);
    const wb = new ExcelJS.Workbook();
    const head = ws => { ws.getRow(1).font = { bold: true, color: { argb: 'FF173404' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF84BD00' } }; };
    const s1 = wb.addWorksheet('Summary');
    s1.columns = [{ header: 'Metric', width: 28 }, { header: 'Value', width: 22 }];
    [['From', d.from], ['To', d.to], ['Refill sessions', d.kpis.sessions], ['Units added', d.kpis.added],
     ['Units removed', d.kpis.removed], ['Net units', d.kpis.net], ['People', d.kpis.people]].forEach(r => s1.addRow(r));
    head(s1);
    const s2 = wb.addWorksheet('Sessions');
    s2.columns = [{ header: 'Start (KSA)', width: 18 }, { header: 'End (KSA)', width: 18 }, { header: 'Refilled by', width: 22 }, { header: 'Added', width: 9 }, { header: 'Removed', width: 10 }, { header: 'Net', width: 8 }, { header: 'Slots', width: 8 }, { header: 'Products', width: 60 }];
    d.sessions.forEach(s => s2.addRow([s.start, s.end, s.who, s.added, s.removed, s.net, s.slots, s.items.map(i => `${i.sku} +${i.added}${i.removed ? ' −' + i.removed : ''}`).join(', ')])); head(s2);
    const s3 = wb.addWorksheet('By product');
    s3.columns = [{ header: 'SKU', width: 10 }, { header: 'Product', width: 36 }, { header: 'Added', width: 10 }, { header: 'Removed', width: 10 }];
    d.bySku.forEach(x => s3.addRow([x.sku, x.product, x.added, x.removed])); head(s3);
    const s4 = wb.addWorksheet('Events');
    s4.columns = [{ header: 'Time (KSA)', width: 18 }, { header: 'Refilled by', width: 22 }, { header: 'SKU', width: 10 }, { header: 'Product', width: 36 }, { header: 'Slot', width: 8 }, { header: 'Qty', width: 8 }];
    d.events.forEach(x => s4.addRow([x.time, x.who, x.sku, x.product, x.slot, x.qty])); head(s4);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="radwa-refills-${d.from}_to_${d.to}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MACHINE REFILL (writes stock counts to the vending cloud) ─────────────
// Protected by the access PIN (REFILL_PIN) through the guard above.
async function getSlots() {
  if (!STATE.token && !STATE.cookie) { const ok = await login(); if (!ok) throw new Error('Login failed'); }
  let r = await apiFetch(`/api/v1/device/cargoways?device_id=${CFG.deviceId}`);
  if (r?.code !== 200) { await login(); r = await apiFetch(`/api/v1/device/cargoways?device_id=${CFG.deviceId}`); }
  if (r?.code !== 200 || !r?.data?.cargoways) throw new Error('Could not read slots: ' + (r?.msg || r?.code));
  const out = [];
  for (const [row, list] of Object.entries(r.data.cargoways)) {
    for (const c of list || []) {
      if (String(c.is_delete) === '1') continue;
      const name = c.goods?.goods_name || '';
      const rowN = parseInt(c.row_num, 10) || +row;
      const prod = getProductCode(name) || CFG.products.find(p => (p.rows || []).includes(rowN)) || null;
      const vol = parseInt(c.cargoway_vol, 10) || 0, amount = parseInt(c.goods_amount, 10) || 0;
      out.push({
        id: String(c.cargoway_id), num: String(c.cargoway_num), row: parseInt(c.row_num, 10) || +row, col: parseInt(c.col_num, 10) || 0,
        label: `${c.row_num}-${c.col_num}`, name: prod?.name || name, apiName: name, sku: prod?.code || '', img: c.goods?.goods_img || '',
        vol, amount, free: Math.max(0, vol - amount),
        merged: String(c.merge_type) !== '0' || String(c.merge_cargoway_id) !== '0',
        disabled: String(c.cargoway_status) !== '0',
      });
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

app.get('/api/slots', async (req, res) => {
  try { res.json({ slots: await getSlots(), writeEnabled: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const REFILL_DONE = new Map();   // request token -> result (stops double submits)
let REFILL_BUSY = false;
app.post('/api/replenish', async (req, res) => {
  const token = String(req.body?.token || '');
  if (token && REFILL_DONE.has(token)) return res.json({ ...REFILL_DONE.get(token), duplicate: true });
  if (REFILL_BUSY) return res.status(409).json({ error: 'Another refill is in progress' });
  REFILL_BUSY = true;
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!changes.length || changes.length > 100) return res.status(400).json({ error: 'No changes' });
    const slots = await getSlots();
    const byId = new Map(slots.map(s => [s.id, s]));
    const plan = [], seen = new Set();
    for (const c of changes) {
      const s = byId.get(String(c.id)), delta = parseInt(c.delta, 10);
      if (!s) return res.status(400).json({ error: `Unknown slot ${c.id}` });
      if (seen.has(s.id)) return res.status(400).json({ error: `Slot ${s.label} listed twice` });
      seen.add(s.id);
      if (!Number.isInteger(delta) || delta === 0) continue;
      const after = s.amount + delta;
      if (after < 0 || after > s.vol) return res.status(400).json({ error: `Slot ${s.label}: ${s.amount} ${delta > 0 ? '+' : ''}${delta} is outside 0–${s.vol}` });
      plan.push({ s, delta, after });
    }
    if (!plan.length) return res.status(400).json({ error: 'Nothing to change' });
    const results = [];
    for (const p of plan) {
      try {
        const r = await apiFetch(`/api/v1//cargoways/${p.s.id}/replenish`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'goods_amount=' + encodeURIComponent((p.delta > 0 ? '+' : '') + p.delta),
        });
        const ok = r?.code === 200;
        results.push({ label: p.s.label, delta: p.delta, before: p.s.amount, after: p.after, ok, msg: ok ? '' : (r?.msg || `code ${r?.code}`) });
        if (!ok) break;   // stop at first failure; nothing further is sent
      } catch (e) { results.push({ label: p.s.label, delta: p.delta, before: p.s.amount, ok: false, msg: e.message }); break; }
    }
    REFILL_CACHE.t = 0;
    const out = { ok: results.every(r => r.ok) && results.length === plan.length, results, skipped: plan.length - results.length };
    if (token) { REFILL_DONE.set(token, out); setTimeout(() => REFILL_DONE.delete(token), 600000); }
    res.status(out.ok ? 200 : 502).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { REFILL_BUSY = false; }
});

app.get('/refill', (req, res) => res.sendFile(path.join(__dirname, 'refill.html')));
app.get('/ui.css', (req, res) => res.sendFile(path.join(__dirname, 'ui.css')));
app.get('/ui.js',  (req, res) => res.sendFile(path.join(__dirname, 'ui.js')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'New Radwa Logo with text- trasperant.png')));

// Diagnostic: probe replenishment (refill) endpoints. Read-only; only paths containing "replenish" are allowed.
app.get('/debug-refill', async (req, res) => {
  try {
    if (!STATE.token && !STATE.cookie) await login();
    const q = 'page=1&limit=10';
    const given = typeof req.query.path === 'string' ? req.query.path : '';
    if (given && (!given.startsWith('/api/v1/') || given.includes('..') || !/replenish/i.test(given))) {
      return res.status(400).json({ error: 'path must start with /api/v1/ and contain "replenish"' });
    }
    const candidates = given ? [given] : [
      `/api/v1/replenishment_stat?${q}`,
      `/api/v1/device/replenishment_stat?${q}`,
      `/api/v1/devices/replenishment_stat?${q}`,
      `/api/v1/devices/${CFG.deviceId}/replenishment_stat?${q}`,
      `/api/v1/replenishment/stat?${q}`,
      `/api/v1/replenishers?type=all`,
    ];
    const tried = [];
    for (const path of candidates) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (STATE.token)  headers['Authorization'] = `Bearer ${STATE.token}`;
        if (STATE.cookie) headers['Cookie'] = STATE.cookie;
        const r = await fetch(CFG.api + path, { headers, timeout: 20000 });
        const text = await r.text();
        tried.push({ path, status: r.status, bytes: text.length, preview: text.substring(0, 1500) });
      } catch (e) { tried.push({ path, error: e.message }); }
    }
    res.json({ tried });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic (GET only): probe slot/cargoway read endpoints. Paths must start /api/v1/ and contain "cargoway".
app.get('/debug-cargo', async (req, res) => {
  try {
    if (!STATE.token && !STATE.cookie) await login();
    const id = CFG.deviceId;
    const given = typeof req.query.path === 'string' ? req.query.path : '';
    if (given && (!given.startsWith('/api/v1/') || given.includes('..') || !/cargoway/i.test(given))) {
      return res.status(400).json({ error: 'path must start with /api/v1/ and contain "cargoway"' });
    }
    const candidates = given ? [given] : [
      `/api/v1/device/cargoways?device_id=${id}`, `/api/v1/cargoways?device_id=${id}`,
      `/api/v1/devices/${id}/cargoways`, `/api/v1/device/cargoway_stock?device_id=${id}`,
      `/api/v1/cargoway_stock?device_id=${id}`, `/api/v1/device/cargoways`, `/api/v1/cargoways`,
      `/api/v1/device/cargoway_stock`, `/api/v1/cargoway_stock`,
    ];
    const tried = [];
    for (const path of candidates) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (STATE.token)  headers['Authorization'] = `Bearer ${STATE.token}`;
        if (STATE.cookie) headers['Cookie'] = STATE.cookie;
        const r = await fetch(CFG.api + path, { headers, timeout: 20000 });
        const text = await r.text();
        tried.push({ path, status: r.status, bytes: text.length, preview: text.substring(0, 1800) });
      } catch (e) { tried.push({ path, error: e.message }); }
    }
    res.json({ tried });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: shows status-like fields (names + values) the platform returns for this device.
app.get('/debug-device', async (req, res) => {
  try {
    if (!STATE.token) await login();
    const [dr, detr] = await Promise.all([
      apiFetch('/api/v1/devices').catch(e => ({ error: e.message })),
      apiFetch(`/api/v1/device/detail?device_id=${CFG.deviceId}`).catch(e => ({ error: e.message })),
    ]);
    const d = dr?.data?.devices?.[0] || {};
    const dd = detr?.data || {};
    const pick = o => Object.fromEntries(Object.entries(o).filter(([k]) => /status|online|state|conn|regist|bind|heart|time|net|mqtt|fault|active|temp/i.test(k)));
    res.json({ listKeys: Object.keys(d), list: pick(d), detailKeys: Object.keys(dd), detail: pick(dd), listError: dr?.error, detailError: detr?.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/check',        async(req,res) => { await doCheck(); res.json({ok:true,machine:STATE.machine,stats:STATE.stats}); });
app.get('/daily',        async(req,res) => { await sendDailyReport(nowKSA()); res.json({ok:true}); });
app.get('/monthly',      async(req,res) => { await sendMonthlyReport(); res.json({ok:true}); });
app.get('/health',       (req,res) => res.json({status:'ok',uptime:process.uptime(),lastCheck:STATE.lastCheck,machine:STATE.machine,stats:STATE.stats}));
app.get('/test-email',   async(req,res) => {
  await sendEmail('✅ Radwa Monitor is Working!', alertEmail('✅','Monitor is Working!',[
    'Your Radwa Smart Vending monitor is set up correctly!',
    `Machine: <strong>${CFG.deviceId}</strong> · ${CFG.location}`,
    `Daily report: <strong>09:30 AM KSA</strong> every day`,
    `Monthly report: <strong>09:00 AM KSA</strong> on 1st of each month`,
    `Alerts enabled for: Offline, Temperature ≥ ${CFG.tempAlert}°C, New sales, Low/Empty stock`,
  ]));
  res.json({ok:true,sentTo:CFG.email.to});
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Radwa Monitor started on port ${PORT}`);
  console.log(`📧 Alerts → ${CFG.email.to}`);
  console.log(`📊 Daily report: 09:30 AM KSA`);
  console.log(`📊 Monthly report: 09:00 AM KSA on 1st`);
  console.log(`🔍 Checking every ${CFG.checkEvery/60000} minutes\n`);
  await doCheck();
  setInterval(doCheck, CFG.checkEvery);
});
