// Pure presentation gate. No broker connection or order execution.
export function reviewState(proposal, now=Date.now()) {
 const reasons=[];
 const fields=['entry','stop','target','lots','plannedLoss','margin','estimatedCosts'];
 if(!proposal||proposal.decision!=='PROPOSAL')reasons.push('Kein begründeter Handelsvorschlag vorhanden.');
 if(!proposal||!['BUY','SELL'].includes(proposal.side)||typeof proposal.symbol!=='string'||!proposal.symbol)reasons.push('Instrument oder Richtung fehlt.');
 if(!proposal||fields.some(k=>typeof proposal[k]!=='number'||!Number.isFinite(proposal[k])||proposal[k]<=0))reasons.push('Orderdaten, Risiko oder Kosten unvollständig.');
 const observed=Date.parse(proposal?.observedAt),expires=Date.parse(proposal?.expiresAt);
 if(!Number.isFinite(observed)||!Number.isFinite(expires)||now<observed||now>=expires||expires-observed>15000)reasons.push('Kursprüfung fehlt oder ist abgelaufen.');
 if(proposal?.side==='BUY'&&!(proposal.stop<proposal.entry&&proposal.entry<proposal.target)||proposal?.side==='SELL'&&!(proposal.target<proposal.entry&&proposal.entry<proposal.stop))reasons.push('Stop und Gewinnziel passen nicht zur Richtung.');
 if(!proposal?.rationale||!proposal?.invalidation||proposal?.riskChecked!==true||proposal?.costsVerified!==true)reasons.push('Signal, Risikoprüfung oder Kostenbeleg fehlt.');
 return {canAcknowledge:reasons.length===0,reasons,executionEnabled:false};
}
