// ╔══════════════════════════════════════════════════════════════╗
// ║          RADWA SMART VENDING - 24/7 MONITOR SERVER          ║
// ║                      Version 1.0.0                          ║
// ╚══════════════════════════════════════════════════════════════╝

const express    = require('express');
const fetch      = require('node-fetch');
const nodemailer = require('nodemailer');
const ExcelJS    = require('exceljs');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(express.json());

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

  // Email
  email: {
    from:    'abdobazzaz@gmail.com',
    pass:    'bxctdmamcgfsumyj',
    to:      'abdobazzaz@hotmail.com',
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
  lastTempAlert:  false,
  lastDoneCount:  0,
  lastSkuAlerts:  {}, // track per-SKU alerts
  lastCheck:      null,
  machine:        { temp:-17, online:true, lastConn:'—', fault:'0' },
  stock:          {}, // current slot volumes
  stats:          { today:0, todayCount:0, month:0, monCount:0, totalDone:0, total:0 },
  alerts:         [], // recent alerts log
  errors:         [], // recent errors log
  tempLog:        [], // { time, temp } for 24h
  powerLog:       [], // { time, online } for 24h
  startTime:      new Date(),
};

// ── EMAIL TRANSPORTER ─────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: CFG.email.from, pass: CFG.email.pass },
});

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
  const temp   = parseInt(d.device_temp ?? dd.device_temp ?? -17);
  const online = d.status==='0' || (d.connect_time||'').substring(0,4) >= '2025';
  return { temp, online, lastConn:(d.connect_time||dd.connect_time||'—').substring(0,16), fault:d.fault_code||'0' };
}

async function fetchStock() {
  const d = await apiFetch(`/api/v1//devices/${CFG.deviceId}/cargoways`);
  const rows = d?.data?.cargoways || {};
  const stock = {};
  Object.values(rows).forEach(slots => {
    slots.forEach(s => {
      stock[String(s.cargoway_num)] = {
        vol:      s.goods_amount || 0,
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
  try {
    await mailer.sendMail({
      from:        `"${CFG.email.fromName}" <${CFG.email.from}>`,
      to:          CFG.email.to,
      subject:     `[Radwa] ${subject}`,
      html:        htmlBody,
      attachments,
    });
    console.log('✅ Email sent!');
  } catch(e) {
    logError(`Email failed: ${e.message}`);
  }
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────
function alertEmail(icon, title, bodyLines) {
  const isRed    = title.includes('OFFLINE') || title.includes('Alert') || title.includes('Empty');
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
    <img src="https://raw.githubusercontent.com/abdobazzaz/d.js/main/logo.png" alt="Radwa" style="width:180px;height:auto;margin-bottom:10px" onerror="this.style.display='none'">
    <div style="color:#1B3F8B;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;font-weight:700">Smart Vending Daily Report</div>
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

    const { temp, online, lastConn } = machine;
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

    // Stats
    const done     = allOrders.filter(o => o.order_status == 5);
    const todayD   = done.filter(o => toKSATime(o.pay_time).startsWith(today));
    const monD     = done.filter(o => toKSATime(o.pay_time).startsWith(mon));
    STATE.stats = {
      today:      todayD.reduce((s,o)=>s+parseFloat(o.order_amount||0),0),
      todayCount: todayD.length,
      month:      monD.reduce((s,o)=>s+parseFloat(o.order_amount||0),0),
      monCount:   monD.length,
      totalDone:  done.length,
      total:      allOrders.length,
    };

    console.log(`⚡ ${online?'ONLINE':'OFFLINE'} | 🌡️ ${temp}°C | ✅ ${done.length} orders`);

    // ── POWER ALERT ──
    if (STATE.lastPower !== null && STATE.lastPower === true && !online) {
      await sendEmail('🔴 Machine is OFFLINE!', alertEmail('🔴','Machine is OFFLINE!',[
        `Your Radwa vending machine has gone <strong>OFFLINE</strong>!`,
        `Machine ID: <strong>${CFG.deviceId}</strong>`,
        `Location: <strong>${CFG.location}</strong>`,
        `Last seen: <strong>${lastConn}</strong>`,
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
    if (STATE.lastDoneCount > 0 && doneCount > STATE.lastDoneCount) {
      const newOnes = done.slice(-( doneCount - STATE.lastDoneCount ));
      for (const o of newOnes) {
        const g     = o.goods?.[0] || {};
        const prod  = getProductCode(g.goods_name||'');
        const apiS  = String(g.cargoway_num||o.cargoway_num||'');
        const slot  = CFG.slotMap[apiS] || apiS || '—';
        const price = parseFloat(g.sale_price||o.order_amount||0).toFixed(2);
        const ksaT  = toKSATime(o.pay_time);
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
      }
    }
    STATE.lastDoneCount = doneCount;

    // ── SKU STOCK ALERTS ──
    for (const prod of CFG.products) {
      const totalUnits = prod.slots.reduce((s,sl)=>s+(stock[sl]?.vol||0),0);
      const key = prod.code;

      if (totalUnits === 0 && STATE.lastSkuAlerts[key] !== 'empty') {
        await sendEmail(`📦 ${prod.code} is EMPTY!`, alertEmail('📦',`${prod.emoji} ${prod.code} is EMPTY!`,[
          `<strong>${prod.name}</strong> has reached <strong>0 units</strong>!`,
          `Slots: ${prod.slots.map(s=>CFG.slotMap[s]||s).join(', ')}`,
          'Please replenish immediately.',
        ]));
        STATE.lastSkuAlerts[key] = 'empty';
      } else if (totalUnits > 0 && totalUnits <= 2 && STATE.lastSkuAlerts[key] !== 'low') {
        await sendEmail(`⚠️ ${prod.code} Low Stock (${totalUnits} units)`, alertEmail('⚠️',`${prod.emoji} ${prod.code} Low Stock!`,[
          `<strong>${prod.name}</strong> has only <strong>${totalUnits} unit${totalUnits!==1?'s':''}</strong> remaining!`,
          `Slots: ${prod.slots.map(s=>`${CFG.slotMap[s]||s}:${stock[s]?.vol||0}`).join(' ')}`,
          'Consider replenishing soon.',
        ]));
        STATE.lastSkuAlerts[key] = 'low';
      } else if (totalUnits >= CFG.stockOkMin) {
        STATE.lastSkuAlerts[key] = 'ok';
      }
    }

    // ── SCHEDULE CHECK ──
    // Check if it's time for daily report (09:30 KSA)
    const h = now.getHours(), m = now.getMinutes();
    if (h === 9 && m >= 30 && m < 35) {
      const reportKey = `daily-${today}`;
      if (!STATE.lastSkuAlerts[reportKey]) {
        STATE.lastSkuAlerts[reportKey] = true;
        sendDailyReport(now);
      }
    }
    // Monthly report: 09:00 AM on 1st of month
    if (now.getDate() === 1 && h === 9 && m >= 0 && m < 5) {
      const monKey = `monthly-${mon}`;
      if (!STATE.lastSkuAlerts[monKey]) {
        STATE.lastSkuAlerts[monKey] = true;
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
  const { temp, online, lastConn } = STATE.machine;
  const pC = online ? '#5A9E1E' : '#C8002A';
  const tC = temp >= CFG.tempAlert ? '#C8002A' : '#1B3F8B';

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Radwa Monitor</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Cairo',sans-serif;background:#F8F1E7;color:#1C2E08;padding:0}
.nav{background:linear-gradient(135deg,#1B3F8B,#5A9E1E);padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#fff;font-weight:900;font-size:18px;letter-spacing:2px}
.nav-r{color:rgba(255,255,255,.7);font-size:12px;text-align:right}
.wrap{max-width:960px;margin:20px auto;padding:0 16px}
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
  <div class="logo">☀️ RADWA MONITOR</div>
  <div class="nav-r">Auto-refresh: 60s<br>Uptime: ${Math.floor(up/3600)}h ${Math.floor(up%3600/60)}m</div>
</div>
<div class="wrap">
  <div class="grid">
    <div class="card" style="border-top:3px solid ${pC}">
      <div class="ci">${online?'🟢':'🔴'}</div><div class="cl">Machine Power</div>
      <div class="cv" style="color:${pC}">${online?'ONLINE':'OFFLINE'}</div>
      <div class="cs">Last: ${lastConn}</div>
    </div>
    <div class="card" style="border-top:3px solid ${tC}">
      <div class="ci">🌡️</div><div class="cl">Temperature</div>
      <div class="cv" style="color:${tC}">${temp}°C</div>
      <div class="cs">${temp>=CFG.tempAlert?'⚠️ CRITICAL':'✓ Normal'} · Alert: ${CFG.tempAlert}°C</div>
    </div>
    <div class="card" style="border-top:3px solid #5A9E1E">
      <div class="ci">💰</div><div class="cl">Today Revenue</div>
      <div class="cv" style="color:#5A9E1E">${STATE.stats.today.toFixed(2)} SAR</div>
      <div class="cs">${STATE.stats.todayCount} orders today</div>
    </div>
    <div class="card" style="border-top:3px solid #1B3F8B">
      <div class="ci">📦</div><div class="cl">This Month</div>
      <div class="cv" style="color:#1B3F8B">${STATE.stats.month.toFixed(2)} SAR</div>
      <div class="cs">${STATE.stats.monCount} orders</div>
    </div>
    <div class="card" style="border-top:3px solid #F5A623">
      <div class="ci">✅</div><div class="cl">Total Completed</div>
      <div class="cv" style="color:#F5A623">${STATE.stats.totalDone}</div>
      <div class="cs">${STATE.stats.total} total orders</div>
    </div>
    <div class="card" style="border-top:3px solid #7A9660">
      <div class="ci">📧</div><div class="cl">Alerts Sent</div>
      <div class="cv" style="color:#7A9660">${STATE.alerts.length}</div>
      <div class="cs">to ${CFG.email.to}</div>
    </div>
  </div>

  <div class="sec">
    <div class="sh" style="background:#1B3F8B">⚙️ Monitor Status</div>
    <div class="sb">
      ${[
        ['Status','🟢 Running 24/7'],
        ['Last Check', STATE.lastCheck ? new Date(STATE.lastCheck).toLocaleString() : 'Starting...'],
        ['Check Interval','Every 5 minutes'],
        ['Machine ID', CFG.deviceId],
        ['Location', CFG.location],
        ['Alert Email', CFG.email.to],
        ['Daily Report','09:30 AM KSA every day'],
        ['Monthly Report','09:00 AM KSA on 1st of each month'],
        ['Temp Threshold',`${CFG.tempAlert}°C`],
        ['Stock Low Alert','≤ 2 units per SKU'],
        ['Stock OK','≥ 3 units per SKU'],
      ].map(([l,v])=>`<div class="ar"><span class="at">${l}</span><span class="as">${v}</span></div>`).join('')}
    </div>
  </div>

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

  <div class="sec">
    <div class="sh" style="background:#F5A623">📧 Recent Alerts (${STATE.alerts.length})</div>
    <div class="sb">
      ${STATE.alerts.length===0
        ? '<div style="text-align:center;color:#7A9660;padding:16px">No alerts yet · All good! ✅</div>'
        : STATE.alerts.slice(0,20).map(a=>`
          <div class="ar">
            <span class="at">${new Date(a.time).toLocaleString()}</span>
            <span class="as">${a.subject}</span>
          </div>`).join('')}
    </div>
  </div>

  ${STATE.errors.length>0?`
  <div class="sec">
    <div class="sh" style="background:#C8002A">⚠️ Recent Errors</div>
    <div class="sb">
      ${STATE.errors.slice(0,10).map(e=>`<div class="er">${new Date(e.time).toLocaleString()} — ${e.msg}</div>`).join('')}
    </div>
  </div>`:''}

</div>
<footer>RADWA SMART VENDING MONITOR v1.0 · ${new Date().toLocaleString()} · Checks every 5 min</footer>
</body></html>`);
});

// Manual triggers
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
