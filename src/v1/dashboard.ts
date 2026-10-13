import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SimulationRuntime } from "./runtime.js";
import { seedDemo, paperDemo } from "./simulation.js";

export async function startDashboard(runtime: SimulationRuntime, port = 0) {
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(24).toString("base64");
  let origin = "";
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' https://*.amplitude.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
    if (req.headers.host !== new URL(origin).host) { json(403, { error: "Host rejected" }); return; }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(page(token, nonce)); return;
    }
    const provided = req.headers["x-obolus-token"] ?? req.headers["x-aureus-token"];
    const auth = typeof provided === "string" ? provided : "";
    if (!/^[a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(token)) ||
        (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
      json(403, { error: "Local session authentication required" }); return;
    }
    try {
      if (req.method === "GET" && req.url === "/api/snapshot") { json(200, runtime.snapshot()); return; }
      if (req.method !== "POST") { json(405, { error: "Method rejected" }); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { json(415, { error: "JSON required" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk); if (size > 8192) { json(413, { error: "Request too large" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (req.url === "/api/control") runtime.control(body.action);
      else if (req.url === "/api/demo") { if (runtime.status === "running") throw new Error("Pause before seeding"); seedDemo(runtime); }
      else if (req.url === "/api/paper") paperDemo(runtime);
      else if (req.url === "/api/reconcile") runtime.reconcileSimulatedJobs();
      else { json(404, { error: "Route not found" }); return; }
      json(200, runtime.snapshot());
    } catch (error) { json(400, { error: error instanceof Error ? error.message.slice(0, 200) : "Operation failed" }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setInterval(async () => {
    if (busy || runtime.status !== "running") return;
    busy = true;
    try { if (!(await runtime.tick()) && runtime.status === "running") runtime.control("pause"); }
    catch { if (runtime.status === "running") runtime.control("emergency"); }
    finally { busy = false; }
  }, 500);
  timer.unref();
  return { url: origin, close: async () => {
    clearInterval(timer);
    if (runtime.status === "running") runtime.control("pause");
    // No tick has external awaits: its microtasks finish before this close callback.
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

function page(token: string, nonce: string): string {
  return String.raw`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>numaron · Simulationskontrolle</title>
<script nonce="${nonce}" src="https://cdn.amplitude.com/script/f7d07467c3be44b239f7dcea69ec713e.js"></script>
<script nonce="${nonce}">
const amplitudeKey='f7d07467c3be44b239f7dcea69ec713e';
if(!amplitudeKey||!window.amplitude){
 console.error('[amplitude] SDK unavailable — no events will be sent');
}else{
 // Private financial dashboard: capture only the explicitly requested lifecycle event.
 window.amplitude.init(amplitudeKey,{serverZone:'US',autocapture:false});
 window.amplitude.track('dashboard geöffnet');
}
</script>
<style nonce="${nonce}">
:root{font-family:Segoe UI,system-ui,sans-serif;color:#eae9e4;background:#11161c;color-scheme:dark}*{box-sizing:border-box}body{margin:0}header{padding:24px 32px;border-bottom:1px solid #36404b;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:26px;margin:0;letter-spacing:3px;color:#edc474}header p{margin:6px 0 0;color:#aab8c5;font-size:13px}.badge{padding:8px 12px;background:#393021;color:#f2cd89;border:1px solid #745e37;border-radius:5px;font-weight:600;font-size:12px}main{max-width:1450px;margin:auto;padding:24px 32px}.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:20px}button{font:inherit;font-size:13px;border:1px solid #516070;border-radius:5px;background:#25313e;color:#f5f5f5;padding:10px 14px;cursor:pointer}button:hover{background:#344658}button:disabled{opacity:.4;cursor:not-allowed}.danger{background:#732c35;border-color:#c77780}.gold{background:#d8b16d;color:#17202b;border:0}.state{margin-right:14px;font-weight:600}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:18px 0 26px}.metric{padding:18px;background:#1b242e;border:1px solid #34404a;border-radius:7px}.metric small{display:block;color:#aab8c5;font-size:12px}.metric strong{font-size:25px;display:block;margin-top:7px}.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}.panel{border:1px solid #34404a;background:#18212a;border-radius:7px;overflow:hidden;margin-bottom:18px}.panel h2{margin:0;padding:16px 18px;font-size:15px;border-bottom:1px solid #34404a}.scroll{overflow:auto;max-height:350px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #303d49;vertical-align:top}th{color:#b4c1cd;font-weight:500}td{overflow-wrap:anywhere}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:0;padding:16px;line-height:1.6}.note{font-size:12px;color:#b4c1cd;line-height:1.6}.notice{padding:12px 16px;border-left:3px solid #d8b16d;background:#252a2f;margin-bottom:20px}#error{color:#ffb0b7;min-height:24px}details{font-size:12px}summary{cursor:pointer;padding:10px}footer{color:#94a6b8;font-size:12px;padding:12px 0}@media(max-width:900px){.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}header,main{padding:18px}.metric strong{font-size:21px}}
</style><header><div><h1>numaron</h1><p>V1 · Wirtschaftsexperimente und kontrollierte Simulation</p></div><span class="badge">SIMULATION · KEINE LIVEAKTIONEN</span></header>
<main><div class="notice note">Alle Einnahmen und Kosten des Wirtschaftszyklus sind synthetisch. Importierte Forschungsbelege erscheinen getrennt als ungeprüfte oder manuell geprüfte Angaben; sie erzeugen keine Einnahmen. Keine Wallets, bezahlten Provider, Shellbefehle oder echten Orders. Die Steuerung gilt für diese Simulationslaufzeit, nicht für einen separat gestarteten Legacy-Agenten.</div>
<div class="controls"><span class="state" id="status">Verbinden …</span><button class="gold" data-action="start">Start</button><button data-action="pause">Pause</button><button data-action="resume">Fortsetzen</button><button data-action="stop">Stopp</button><button class="danger" data-action="emergency">Not-Aus</button><button data-action="reset">Not-Aus zurücksetzen</button></div>
<div class="controls"><button id="seed">Demo-Chancen laden</button><button id="paper">Paper-Demo auswerten</button><button id="reconcile">Unklare Simulationen abstimmen</button></div><div id="error" role="alert"></div>
<div class="metrics" id="metrics"></div><div class="grid"><div><section class="panel"><h2>Chancen und Wirtschaftszyklus · letzte 100</h2><div class="scroll" id="cases"></div></section><section class="panel"><h2>Worker und Tasks · letzte 100</h2><div class="scroll" id="jobs"></div></section><section class="panel"><h2>Experimente und Kriterien · letzte 100</h2><div class="scroll" id="experiments"></div></section></div>
<div><section class="panel"><h2>Ziele, Budgets und Modelle</h2><pre id="settings"></pre></section><section class="panel"><h2>Paper-Positionen / Walk-forward</h2><div id="paperResults"></div></section><section class="panel"><h2>Entscheidungen, Fehler und Freigaben</h2><div class="scroll" id="audit"></div><pre id="approvals"></pre></section></div></div>
<section class="panel"><h2>Lokale Nachfrageforschung · keine Umsatzbuchungen</h2><div class="scroll" id="research"></div><p class="note">Quellenprüfung erfolgt durch den Importierenden. Unterschiedliche Quellhosts sind kein Beweis unabhängiger Kunden. Prognosen bleiben Annahmen; Vorschläge sind keine Ausgabenfreigabe.</p></section>
<footer>Lokale Sitzung · persistente Datenbank · nach Neustart keine automatische Fortsetzung · USD-Simulationscent</footer></main>
<script nonce="${nonce}">
const AUTH=${JSON.stringify(token)};
const $=id=>document.getElementById(id);const money=n=>(n/100).toLocaleString('de-CH',{style:'currency',currency:'USD'});
async function api(route,body){const r=await fetch('/api/'+route,{method:body?'POST':'GET',headers:{'X-Obolus-Token':AUTH,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
function table(id,rows,columns){const host=$(id);host.replaceChildren();if(!rows.length){const p=document.createElement('pre');p.textContent='Noch keine Einträge.';host.append(p);return;}const t=document.createElement('table'),head=document.createElement('tr');columns.forEach(([key,label])=>{const th=document.createElement('th');th.textContent=label;head.append(th)});t.append(head);rows.forEach(row=>{const tr=document.createElement('tr');columns.forEach(([key])=>{const td=document.createElement('td');td.textContent=String(row[key]??'—');tr.append(td)});t.append(tr)});host.append(t)}
function render(s){$('status').textContent={running:'Läuft',paused:'Pausiert',stopped:'Gestoppt',emergency:'Not-Aus aktiv'}[s.status];$('metrics').replaceChildren();[['Liquidität frei',s.totals.liquidCents],['Reserviert',s.totals.reservedCents],['Einnahmen',s.totals.revenueCents],['Ausgaben',s.totals.spentCents],['Netto simuliert',s.totals.netCents]].forEach(([label,value])=>{const el=document.createElement('div');el.className='metric';const small=document.createElement('small'),strong=document.createElement('strong');small.textContent=label;strong.textContent=money(value);el.append(small,strong);$('metrics').append(el)});
table('cases',s.cases,[['name','Chance'],['sector','Sektor'],['stage','Phase'],['lesson','Forecast / Lernen']]);table('jobs',s.jobs,[['worker','Worker'],['stage','Task'],['status','Status'],['reserved_cents','Reserviert (c)']]);table('experiments',s.experiments,[['offer','Phase'],['status','Status'],['success_criteria','Kriterien'],['result','Ergebnis']]);table('audit',s.audit,[['created_at','Zeit'],['action','Entscheidung'],['detail','Begründung / Fehler']]);
table('research',s.research||[],[['title','Chance'],['independentSources','Quellhosts'],['forecastNetCents','Prognose netto (c)'],['decision','Vorschlag'],['reason','Begründung']]);
$('settings').textContent=s.goals.join('\n')+'\n\nKapital: '+money(s.settings.capitalCents)+'\nLiquiditätsreserve: '+money(s.settings.liquidityFloorCents)+'\nAusgabenlimit: '+money(s.settings.spendLimitCents)+'\nJe Task: '+money(s.settings.perTaskCents)+'\nWorkerlimit: '+s.settings.workers+'\nModell: deterministic-fixture\nToken: 0 · echte API-Kosten: 0';$('approvals').textContent=JSON.stringify(s.approvals,null,2);
$('paperResults').replaceChildren();if(!s.paper.length){const p=document.createElement('pre');p.textContent='Paper-Demo noch nicht ausgeführt.';$('paperResults').append(p)}s.paper.forEach(item=>{const r=JSON.parse(item.result),p=document.createElement('pre');p.textContent='Synthetische OOS-Fenster: '+r.windows.length+'\nPositionen: '+r.trades.length+'\nNetto inkl. Gebühren/Slippage: '+money(r.netPnlCents)+'\nKein Nachweis realer Profitabilität.';$('paperResults').append(p);const d=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('pre');summary.textContent='Positionen, These, Entry, Stop, Target, Exit';content.textContent=JSON.stringify(r.trades,null,2);d.append(summary,content);$('paperResults').append(d)});
document.querySelectorAll('[data-action]').forEach(b=>{const a=b.dataset.action;b.disabled=!(a==='emergency'||a==='stop'&&s.status!=='emergency'||a==='start'&&s.status==='stopped'||a==='pause'&&s.status==='running'||a==='resume'&&s.status==='paused'||a==='reset'&&s.status==='emergency')});$('seed').disabled=s.status==='running';$('reconcile').disabled=s.status==='running';}
async function act(route,body={}){try{$('error').textContent='';render(await api(route,body))}catch(e){$('error').textContent=e.message}}
document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>act('control',{action:b.dataset.action})));$('seed').onclick=()=>act('demo');$('paper').onclick=()=>act('paper');$('reconcile').onclick=()=>act('reconcile');
let polling=false,lastSnapshot='';async function refresh(){if(polling)return;polling=true;try{const s=await api('snapshot'),encoded=JSON.stringify(s);if(encoded!==lastSnapshot){render(s);lastSnapshot=encoded}}catch(e){$('error').textContent=e.message}finally{polling=false}}refresh();setInterval(refresh,1000);
</script></html>`;
}
