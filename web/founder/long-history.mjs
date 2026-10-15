const date=value=>Number.isFinite(value)?new Date(value).toLocaleDateString('de-CH',{timeZone:'UTC'}):'unbekannt';
const number=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('de-CH',{maximumFractionDigits:2}):'nicht verfügbar';
const rate=value=>Number.isFinite(value)?value.toFixed(2)+' %':'nicht verfügbar';
const label=kind=>({'macro-history':'Zinsphasen','history':'Marktgeschichte','cash-paper':'Strategietest','product-readiness':'Eignung der Daten'}[kind]??'Forschungsbericht');
export function historyView(snapshot={}){
 const coverage=(snapshot.coverage??[]).map(c=>(c.label??c.kind??'Quelle')+': '+date(c.start)+' – '+date(c.end)+(c.startsLate?' · späterer Beginn':'')+(c.endsEarly?' · aktuellster Stand liegt vor dem gewünschten Ende':''));
 return {status:({running:'Forschung aktiv',paused:'Forschung pausiert',stopped:'Forschung gestoppt'}[snapshot.status]??'Forschung noch nicht verbunden'),activity:snapshot.activity??'Noch kein Forschungsstand',coverage,ready:snapshot.counts?.ready??0,reports:snapshot.recentReports??[],blockers:snapshot.blockers??[]};
}
export function formatHistoryReport(report){
 const m=report.metrics??{},lines=[label(report.kind),'Entscheidung: '+report.decision,'Datenpunkte: '+number(m.observations??m.periodObservations),'Zeitraum: '+date(m.start)+' – '+date(m.end)];
 if(report.kind==='macro-history')lines.push('Annualisierter Zinssatz, keine Anlagerendite:','Tiefster Wert: '+rate(m.minimumAnnualRatePercent),'Höchster Wert: '+rate(m.maximumAnnualRatePercent),'Letzter Wert: '+rate(m.latestAnnualRatePercent));
 if(report.kind==='history')lines.push('Zusammengesetzte historische Rendite: '+rate(Number(m.totalReturn)*100),'Rein beschreibend; keine simulierten Trades.');
 if(report.kind==='cash-paper'){
  lines.push('Variante: '+(m.variantId??'unbekannt'),'Prüfabschnitt: '+({development:'Entwicklung',validation:'Validierung',final:'Schlussprüfung'}[m.phase]??'unbekannt'),'Geschlossene simulierte Trades: '+number(m.trades));
  for(const [key,title] of [['netPnlCents','Simuliertes Nettoergebnis'],['stressNetPnlCents','Bei höheren Kosten']])lines.push(title+': '+(Number.isFinite(m[key])?number(m[key]/100)+' '+(report.nativeCurrency??'Währung unbekannt'):'nicht prüfbar'));
  lines.push('Kosten: '+({model:'Modellannahmen, keine historischen Kostenbelege',documented:'zeitlich belegte Kosten',unknown:'noch nicht belegt',gross:'Kosten nicht abgezogen'}[report.costStatus]??'unbekannt'));
  if(m.contaminated)lines.push('Schlussprüfung: Diese Daten waren bereits aus einer früheren Runde bekannt.');
 }
 lines.push('','Grenzen dieser Auswertung',...(report.limitations??[]).slice(0,50).map(x=>'• '+x),'','Nur Forschung und Simulation. Kein bestätigter Live-Handelsvorteil.','Bericht: '+report.id);return lines.join('\n');
}
export function formatHistoryLessons(lessons){return lessons.length?lessons.slice(0,20).map(l=>l.text+'\nStatus: '+l.status+' · Version '+l.version+'\nUmfang: '+l.scope+'\nBelegberichte: '+l.sourceReportIds.length+(l.application?'\nAnwendung: '+l.application.use+'\nPrüfung: '+l.application.check+'\nGrenze: '+l.application.counterEvidence:'')).join('\n\n'):'Noch keine gespeicherten Erkenntnisse.';}
export function formatHistoryCoverage(snapshot){const v=historyView(snapshot);return ['Gewünschter Zeitraum: '+date(snapshot?.requestedStart)+' – '+date(snapshot?.requestedEnd),'Tatsächlich gespeicherte Daten',...v.coverage,'','Historische Analysten-Prüfideen (Quellenberichte, keine vollständigen Kursreihen)',...(snapshot?.analystKnowledge??[]).flatMap(l=>[l.periodStart+'–'+l.periodEnd+' · '+l.title,'Anwendung: '+l.use,'Gegenbeleg/Grenze: '+l.counterEvidence,'Quelle: '+l.source]),'','Quellenrechte',...(snapshot?.sources??[]).map(s=>s.label+': '+({allowed:'freigegeben',pending:'Nachweis offen',restricted:'Nutzung eingeschränkt',blocked:'gesperrt'}[s.status]??s.status)),'','Was noch fehlt',...v.blockers].join('\n');}
export function renderLongHistory(box,snapshot,{onControl,onReport,onLessons,onCoverage}={}){
 if(!box)return;box.replaceChildren();if(!snapshot){box.hidden=true;return;}box.hidden=false;
 const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 const button=(text,callback)=>{const b=node('button',text);b.type='button';b.onclick=async()=>{b.disabled=true;try{await callback?.();}finally{b.disabled=false;}};return b;};
 const v=historyView(snapshot),heading=node('div',undefined,'section-heading'),title=node('div');title.append(node('div','✦ AI RESEARCH LAB','eyebrow'),node('h2','Numaron lernt aus Marktgeschichte'));heading.append(title,node('span',v.status,'quiet-badge'));box.append(heading,node('p',v.activity,'muted'));
 const journey=node('div',undefined,'history-journey');for(const text of ['01 · Daten prüfen','02 · Muster untersuchen','03 · Strategien testen','04 · Erkenntnisse behalten'])journey.append(node('span',text));box.append(journey);
 const cards=node('div',undefined,'history-summary'),lesson=node('div',undefined,'history-finding');lesson.append(node('small','LETZTE ERKENNTNIS'),node('p',snapshot.lastLesson?.text??'Der erste Befund erscheint nach einem abgeschlossenen Durchlauf.'));cards.append(lesson);
 const counts=node('div',undefined,'history-counts');for(const [value,text] of [[snapshot.counts?.datasets??0,'Datenstände'],[snapshot.counts?.lessons??0,'Erkenntnisversionen'],[v.ready,'Für Paper-Test geeignet']]){const card=node('div');card.append(node('strong',String(value)),node('small',text));counts.append(card);}cards.append(counts);box.append(cards);
 if(v.coverage.length)box.append(node('p',v.coverage.join('\n'),'history-coverage'));else box.append(node('p','Noch keine zugelassenen historischen Daten gespeichert.','muted'));
 if(!(snapshot.coverage??[]).some(c=>c.kind==='cash-ohlc'))box.append(node('p','Für konkrete Strategietests fehlen geeignete Produktkurse. Zinswerte liefern Marktkontext, aber keine handelbaren Preise.','notice'));
 const actions=node('div',undefined,'history-actions');actions.append(button('Erkenntnisse ↗',onLessons),button('Datenabdeckung ↗',onCoverage),button(snapshot.status==='running'?'Pause':'Fortsetzen',()=>onControl?.(snapshot.status==='running'?'pause':'resume')),button('Forschung stoppen',()=>onControl?.('stop')));box.append(actions);
 const details=node('details'),summary=node('summary','Strategietests & Berichte ('+(snapshot.counts?.reports??0)+')');details.append(summary);for(const r of v.reports){const row=node('div',undefined,'history-report');row.append(node('span',label(r.kind)+' · '+r.decision),button('Bericht ansehen',()=>onReport?.(r.id)));details.append(row);}if(!v.reports.length)details.append(node('p','Noch keine Berichte gespeichert.'));box.append(details);
 if(v.blockers.length){const gaps=node('details');gaps.append(node('summary','Was die Forschung noch begrenzt ('+v.blockers.length+')'));for(const text of v.blockers.slice(0,20))gaps.append(node('p',text,'muted'));box.append(gaps);}
}
