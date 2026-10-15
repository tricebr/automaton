export const TRADING_LIMITS=Object.freeze({perTrade:0.05,total:0.15,dailyEntryStop:0.30});
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
export function zurichDay(now){const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);const midnight=d=>{const base=Date.parse(d+'T00:00:00Z');let x=base;for(let i=0;i<3;i++){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Zurich',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(x).map(p=>[p.type,p.value]));const local=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);x+=base-local;}return x;};const next=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);return {date,startsAt:midnight(date),endsAt:midnight(next)};}
export function assessRisk({market:m,signal:s,sizing:z,day:d,holds=[]},now=Date.now()){
 const reasons=[];const today=zurichDay(now);const fail=t=>reasons.push(t);if(!m||!positive(m.equity)||!Number.isFinite(m.freeMargin)||m.freeMargin<0||!Number.isFinite(m.observedAt)||now-m.observedAt>15000||m.observedAt>now+1000)fail('Aktuelle vollständige Kontobewertung fehlt.');
 if(!s||!['BUY','SELL'].includes(s.side)||![s.entry,s.stop,s.target].every(positive)||!(s.side==='BUY'?s.stop<s.entry&&s.entry<s.target:s.target<s.entry&&s.entry<s.stop)||!Number.isFinite(s.expiresAt)||s.expiresAt<=now)fail('Signal oder Schutzpreise ungültig/veraltet.');
 if(!z||![z.lots,z.plannedLoss,z.margin].every(positive)||z.costsVerified!==true)fail('Positionsgröße oder vollständige Kostenprüfung fehlt.');
 if(!d||d.account!==m?.identity||d.currency!==m?.currency||d.startsAt!==today.startsAt||d.endsAt!==today.endsAt||d.verified!==true||!positive(d.openingEquity)||!Number.isFinite(d.netExternalFlow))fail('Tagesstart oder Geldbewegungen nicht vollständig bestätigt.');
 if(!Array.isArray(holds)||holds.some(h=>!h||h.account!==m?.identity||h.currency!==m?.currency||!positive(h.plannedLoss)))fail('Offenes Risiko nicht vollständig bekannt.');
 const loss=z?.plannedLoss,open=Array.isArray(holds)?holds.reduce((n,h)=>n+h.plannedLoss,0):NaN,riskFraction=loss/m?.equity,totalRiskFraction=(open+loss)/m?.equity;
 const dailyLoss=Math.max(0,(d?.openingEquity??NaN)+(d?.netExternalFlow??NaN)-(m?.equity??NaN));const dailyLossFraction=dailyLoss/d?.openingEquity;
 if(riskFraction>TRADING_LIMITS.perTrade+1e-12)fail('5 % Risiko je Trade überschritten.');if(totalRiskFraction>TRADING_LIMITS.total+1e-12)fail('15 % Gesamtrisiko überschritten.');
 if(dailyLossFraction>=TRADING_LIMITS.dailyEntryStop||(dailyLoss+open+loss)/d?.openingEquity>TRADING_LIMITS.dailyEntryStop+1e-12)fail('30 % Tagesverlustbudget ausgeschöpft.');if(z?.margin>m?.freeMargin)fail('Freie Margin reicht nicht.');
 return {allowed:reasons.length===0,reasons,lots:z?.lots,plannedLoss:loss,riskFraction,totalRiskFraction,dailyLossFraction,currency:m?.currency};
}
