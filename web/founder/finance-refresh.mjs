export function mergeFinanceSnapshot(base={},finance){
 if(!finance)return base;
 const result={...base};
 for(const key of ['financeReport','financeLedger','billing','costImport','financeStatus'])if(key in finance)result[key]=finance[key];
 if(finance.financeBudget)result.autonomy={...base.autonomy,budget:finance.financeBudget};
 return result;
}
export function financeRefreshMessage(finance){
 const status=finance?.financeStatus;
 if(!status)return 'Finanzdaten werden geladen …';
 if(status.reason==='powered-off')return 'Numaron ist ausgeschaltet · gespeicherte Finanzdaten. Automatische Kosten- und Einnahmenabrufe beginnen nach dem Einschalten.';
 const observed=status.reportObservedAt;
 const date=observed?new Date(observed).toLocaleString('de-CH',{timeZone:'Europe/Zurich'}):null;
 return status.reportAvailable
  ?'Finanzansicht verbunden · Einnahmenstand '+(date??'nicht angegeben')+'. Kostenstände stehen bei den Anbietern. Einnahmenabruf höchstens alle 5 Minuten, Anbieter-Kosten alle 15 Minuten.'
  :'Einnahmenabruf fehlgeschlagen · '+(date?'Letzter gespeicherter Stand: '+date+'.':'Kein bestätigter Einnahmenstand verfügbar.')+' Fehlende Daten zählen nicht als null. Kostenstände stehen bei den Anbietern.';
}
