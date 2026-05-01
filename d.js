// Radwa Mobile Dashboard v4.0 - Lightweight loader
(function(){
if(document.getElementById(‘rdwa-m’)) return;

const DID=‘203617400’,TEMP_ALERT=-12,CAP=2;
const LAYOUT=[
{row:1,cols:[‘1-1’,‘1-2’,‘1-3’,‘1-4’],api:[‘1’,‘2’,‘3’,‘4’],prod:{en:‘Butter Chicken’,ar:‘دجاج بالزبدة’,emoji:‘🍗’,col:’#E07820’}},
{row:2,cols:[‘2-1’,‘2-2’,‘2-3’,‘2-4’],api:[‘11’,‘12’,‘13’,‘14’],prod:{en:‘Sweet Chili’,ar:‘دجاج حلو حار’,emoji:‘🌶️’,col:’#C8002A’}},
{row:3,cols:[‘3-1’,‘3-2’,‘3-3’,‘3-4’],api:[‘21’,‘22’,‘23’,‘24’],prod:{en:‘Chicken Biriyani’,ar:‘برياني دجاج’,emoji:‘🍚’,col:’#8B6000’}},
{row:4,cols:[‘4-1’,‘4-2’,‘4-3’,‘4-4’],api:[‘31’,‘32’,‘33’,‘34’],prod:{en:‘Chicken Alfredo’,ar:‘ألفريدو دجاج’,emoji:‘🍝’,col:’#004F87’}},
{row:5,cols:[‘5-1’,‘5-2’,‘5-3’,‘5-4’],api:[‘41’,‘42’,‘43’,‘44’],prod:{en:‘Chicken Noodles’,ar:‘نودلز دجاج’,emoji:‘🍜’,col:’#376C00’}},
{row:6,cols:[‘6-1’,‘6-2’,‘6-3’,‘6-4’],api:[‘51’,‘52’,‘53’,‘54’],prod:{en:‘Creamy Chicken’,ar:‘دجاج بالكريمة’,emoji:‘🍲’,col:’#5A3080’}},
{row:7,cols:[‘7-1’,‘7-2’,‘7-3’,‘7-4’],api:[‘61’,‘62’,‘63’,‘64’],prod:{en:‘Creamy Chicken’,ar:‘دجاج بالكريمة’,emoji:‘🍲’,col:’#5A3080’}},
{row:8,cols:[‘8-1’,‘8-2’,‘8-3’,‘8-4’],api:[‘71’,‘72’,‘73’,‘74’],prod:null}
];
const SMAP={};
LAYOUT.forEach(r=>r.api.forEach((s,i)=>SMAP[s]={code:r.cols[i],prod:r.prod}));

function gP(n){
n=n||’’;
if(n.includes(‘Butter’)) return LAYOUT[0].prod;
if(n.includes(‘Chili’))  return LAYOUT[1].prod;
if(n.includes(‘Biriyani’)||n.includes(‘Biryani’)) return LAYOUT[2].prod;
if(n.includes(‘Alfredo’)||n.includes(‘Fettuccine’)) return LAYOUT[3].prod;
if(n.includes(‘Noodle’)) return LAYOUT[4].prod;
if(n.includes(‘Cream’))  return LAYOUT[5].prod;
return{en:n.split(’ ‘).filter(w=>/[a-zA-Z]/.test(w)).join(’ ‘)||n,ar:’’,emoji:‘🍽️’,col:’#666’};
}
function gE(n){return(n||’’).split(’ ‘).filter(w=>/[a-zA-Z]/.test(w)).join(’ ’).trim()||n;}
function tM(){return new Date().toISOString().slice(0,7);}

async function run(){
// Show loading overlay
const ov=document.createElement(‘div’);
ov.id=‘rdwa-m’;
ov.style.cssText=‘position:fixed;inset:0;z-index:2147483647;background:#F2F8EA;overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:-apple-system,Cairo,sans-serif’;
ov.innerHTML=’<div style="padding:80px 20px;text-align:center;color:#7A9660"><div style="font-size:36px;margin-bottom:12px">⏳</div><div style="font-weight:700;font-size:15px">Loading Radwa Dashboard…</div><div style="font-size:12px;margin-top:6px;opacity:.7">Fetching live data</div></div>’;
document.body.appendChild(ov);

try{
// Fetch data
let all=[],page=1;
while(page<=10){
const r=await fetch(`/api/v1/orders?page=${page}&limit=100`).then(r=>r.json());
const items=r?.data?.data||[];
all=all.concat(items);
if(items.length<100) break;
page++;
}

```
const[dr,detr]=await Promise.all([
  fetch('/api/v1/devices').then(r=>r.json()).catch(()=>({})),
  fetch('/api/v1/device/detail?device_id='+DID).then(r=>r.json()).catch(()=>({}))
]);
const dv=dr?.data?.devices?.[0]||{};
const dd=detr?.data||{};
const temp=parseInt(dv.device_temp??dd.device_temp??-17);
const online=dv.status==='0'||(dv.connect_time||'').slice(0,4)>='2025';
const lastConn=(dv.connect_time||dd.connect_time||'—').slice(0,16);

const mon=tM();
const done=all.filter(o=>o.order_status==5);
const mDone=done.filter(o=>(o.pay_time||o.create_at||'').startsWith(mon));
const today=new Date().toISOString().slice(0,10);
const tDone=done.filter(o=>(o.pay_time||'').startsWith(today));
const tRev=tDone.reduce((s,o)=>s+parseFloat(o.order_amount||0),0);
const mRev=mDone.reduce((s,o)=>s+parseFloat(o.order_amount||0),0);
const mLabel=new Date().toLocaleDateString('en',{month:'short',year:'numeric'});

const pC=online?'#376C00':'#C8002A';
const tC=temp>=TEMP_ALERT?'#C8002A':temp>=-15?'#E07020':'#004F87';

// Stock
const sold={};
done.forEach(o=>{
  const g=o.goods?.[0]||{};
  const s=String(g.cargoway_num||o.cargoway_num||'').trim();
  if(s) sold[s]=(sold[s]||0)+1;
});

// Build HTML
let H=`
<div style="background:linear-gradient(135deg,#376C00,#004F87);padding:env(safe-area-inset-top,14px) 16px 14px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 2px 10px rgba(0,0,0,.3)">
  <div style="display:flex;align-items:center;gap:8px">
    <div style="background:rgba(255,255,255,.2);border-radius:50px;padding:5px 13px;color:#fff;font-weight:900;font-size:14px">☀️ RADWA</div>
    <div style="color:rgba(255,255,255,.6);font-size:10px;letter-spacing:1px">LIVE</div>
  </div>
  <div style="display:flex;align-items:center;gap:6px">
    <div style="background:rgba(255,255,255,.15);color:#fff;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;border:1px solid rgba(255,255,255,.3)">${online?'🟢 ONLINE':'🔴 OFFLINE'}</div>
    <div style="background:rgba(255,255,255,.15);color:#fff;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;border:1px solid rgba(255,255,255,.3)">🌡️${temp}°C</div>
    <button onclick="document.getElementById('rdwa-m').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:7px 13px;border-radius:8px;font-weight:900;font-size:15px;line-height:1">✕</button>
  </div>
</div>
<div style="padding:14px">`;

// Stats grid
H+=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">`;
[[`💰`,"Today",tRev.toFixed(2)+' SAR',tDone.length+' orders','#376C00'],
 [`📦`,mLabel,mRev.toFixed(2)+' SAR',mDone.length+' orders','#004F87'],
 [`🌡️`,'Temp',temp+'°C',temp>=TEMP_ALERT?'⚠️ Check!':'Normal',tC],
 [`⚡`,'Power',online?'ONLINE':'OFFLINE',lastConn.slice(5,16),pC]
].forEach(([i,l,v,s,c])=>{
  H+=`<div style="background:#fff;border:1.5px solid #C8DCA8;border-top:3px solid ${c};border-radius:12px;padding:12px">
    <div style="font-size:20px">${i}</div>
    <div style="font-size:9px;color:#7A9660;letter-spacing:.5px;text-transform:uppercase;margin:4px 0 2px">${l}</div>
    <div style="font-size:17px;font-weight:900;color:${c};line-height:1">${v}</div>
    <div style="font-size:9px;color:#7A9660;margin-top:2px">${s}</div>
  </div>`;
});
H+=`</div>`;

// Stock
H+=`<div style="background:#fff;border:1.5px solid #C8DCA8;border-radius:14px;overflow:hidden;margin-bottom:12px">
  <div style="background:#376C00;padding:9px 14px;color:#fff;font-weight:700;font-size:12px;display:flex;justify-content:space-between;align-items:center">
    <span>📦 Stock by Slot</span>
    <span style="font-size:10px;opacity:.8">${CAP} units / slot</span>
  </div>
  <div style="padding:10px;display:flex;flex-direction:column;gap:8px">`;

LAYOUT.forEach(row=>{
  if(!row.prod){
    H+=`<div style="background:#F8F8F8;border:1px dashed #DDD;border-radius:8px;padding:7px 10px;text-align:center;font-size:11px;color:#AAA">Row ${row.row} · Empty</div>`;
    return;
  }
  const slots=row.api.map((apiSlot,idx)=>{
    const s=sold[apiSlot]||0;
    const rem=s===0?CAP:Math.max(CAP-(s%CAP),0);
    return{code:row.cols[idx],sold:s,rem,api:apiSlot};
  });
  const tRem2=slots.reduce((a,s)=>a+s.rem,0);
  const tCap2=slots.length*CAP;
  const pct=Math.round(tRem2/tCap2*100);
  const st=tRem2===0?'empty':pct<=30?'low':'ok';
  const sc2=st==='ok'?'#376C00':st==='low'?'#E07020':'#C8002A';
  const sbg=st==='ok'?'#EAF3D8':st==='low'?'#FFF5EC':'#FEF0F0';

  H+=`<div style="background:${sbg};border:1.5px solid ${sc2}40;border-radius:10px;padding:10px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <span style="font-size:20px">${row.prod.emoji}</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:12px;color:#1C2E08">${row.prod.en}</div>
        <div style="height:5px;background:rgba(0,0,0,.08);border-radius:3px;margin-top:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${sc2};border-radius:3px"></div>
        </div>
      </div>
      <div style="font-size:14px;font-weight:900;color:${sc2};white-space:nowrap">${tRem2}/${tCap2}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px">
      ${slots.map(s=>{
        const c2=s.rem===0?'#C8002A':s.rem===1?'#E07020':'#376C00';
        const b2=s.rem===0?'#FEF0F0':s.rem===1?'#FFF5EC':'#EAF3D8';
        return`<div style="background:${b2};border:1px solid ${c2}60;border-radius:6px;padding:4px 2px;text-align:center">
          <div style="font-size:8px;color:#7A9660;font-weight:700">${s.code}</div>
          <div style="font-size:15px;font-weight:900;color:${c2};line-height:1.1">${s.rem}</div>
          <div style="font-size:7px;color:#AAA">${s.sold} sold</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
});
H+=`</div></div>`;

// Sales table
H+=`<div style="background:#fff;border:1.5px solid #C8DCA8;border-radius:14px;overflow:hidden;margin-bottom:20px">
  <div style="background:#004F87;padding:9px 14px;color:#fff;font-weight:700;font-size:12px;display:flex;justify-content:space-between;align-items:center">
    <span>✅ ${mLabel} Completed Sales</span>
    <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:8px;font-size:10px">${mDone.length} · ${mRev.toFixed(2)} SAR</span>
  </div>`;

if(!mDone.length){
  H+=`<div style="padding:20px;text-align:center;color:#7A9660;font-size:12px">No completed sales this month</div>`;
} else {
  mDone.slice().reverse().forEach((o,idx)=>{
    const g=o.goods?.[0]||{};
    const p=gP(gE(g.goods_name||''));
    const img=g.goods_img||'';
    const apiS=String(g.cargoway_num||o.cargoway_num||'');
    const slotCode=SMAP[apiS]?SMAP[apiS].code:apiS||'—';
    const price=parseFloat(g.sale_price||o.order_amount||0).toFixed(2);
    const time=(o.pay_time||o.create_at||'').slice(5,16).replace('T',' ');
    H+=`<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #EFF5E8;${idx%2?'background:#FAFDF6':''}">
      <div style="width:36px;height:36px;border-radius:8px;overflow:hidden;flex-shrink:0;background:#EAF3D8;display:flex;align-items:center;justify-content:center;font-size:20px">
        ${img?`<img src="${img}" style="width:100%;height:100%;object-fit:cover" onerror="this.parentNode.textContent='${p.emoji}'">`:`${p.emoji}`}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:12px;color:#1C2E08;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.en}</div>
        <div style="font-size:10px;color:#7A9660;margin-top:1px">${time}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:monospace;background:#EAF3D8;color:#376C00;padding:2px 6px;border-radius:5px;font-size:9px;font-weight:700">${slotCode}</div>
        <div style="font-size:14px;font-weight:900;color:#376C00;margin-top:2px">${price} SAR</div>
      </div>
    </div>`;
  });
}

H+=`</div>
  <div style="text-align:center;padding:10px;font-size:10px;color:#7A9660">RADWA v4.0 · ${new Date().toLocaleString()} · Tap ✕ to close</div>
</div>`;

ov.innerHTML=H;
```

} catch(e) {
ov.innerHTML=`<div style="padding:60px 20px;text-align:center"> <div style="font-size:40px;margin-bottom:12px">⚠️</div> <div style="font-weight:700;color:#C8002A;font-size:15px;margin-bottom:8px">Connection Error</div> <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:20px">${e.message||'Make sure you are logged in to merchant.dwvending.cn'}</div> <button onclick="document.getElementById('rdwa-m').remove()" style="background:#C8002A;color:#fff;border:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700">Close</button> </div>`;
}
}
run();
})();
