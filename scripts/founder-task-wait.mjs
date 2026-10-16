// Pure explanation of scheduler gates; never changes eligibility or reservations.
export function adapterReadyAt(adapter,task,results=[]){return adapter?.nextReadyAtFor?adapter.nextReadyAtFor({task,dependencies:results}):adapter?.nextReadyAt??0;}
export function explainTaskWait(task,adapter,dependencies=[],now=Date.now(),results=[]){
 if(task.status!=='queued')return null;
 const missing=dependencies.filter(d=>d.status!=='done');
 if(missing.length)return {code:'dependency',reason:'Wartet auf Vorarbeit: '+missing.map(d=>d.title??d.id).join(', ')+'.',until:null};
 if(adapter?.available===false)return {code:'access',reason:adapter.reason??'Dienstzugang nicht verfügbar.',until:null};
 const planned=Math.max(task.input?.notBefore??0,task.next_retry_ms??0);
 if(planned>now)return {code:'scheduled',reason:task.next_retry_ms?'Automatische Wiederholung nach Fehlerpause.':'Für einen späteren Zeitpunkt geplant.',until:planned};
 const wait=adapter?.waitStateFor?adapter.waitStateFor({task,dependencies:results}):adapter?.waitState;
 if(wait)return wait;
 const ready=adapterReadyAt(adapter,task,results);
 if(ready>now)return {code:'cooldown',reason:'Abrufpause des Dienstes.',until:ready};
 return {code:'worker',reason:'Bereit; wartet auf den nächsten Durchlauf oder einen freien Bearbeiter.',until:null};
}
