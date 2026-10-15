import type {DemandEvidence} from './research.js';
import {ECONOMIC_FIELDS,type EconomicField} from './research-assumptions.js';

const terms:Record<EconomicField,RegExp>={
  payer:/\b(customer|buyer|client|payer|kunde|käufer|auftraggeber)\b/i,
  offer:/\b(deliver|service|report|product|workflow|angebot|produkt|bericht)\b/i,
  channel:/\b(marketplace|listing|channel|newsletter|vertrieb|marktplatz|verzeichnis)\b/i,
  price:/\b(price|pricing|pay|budget|preis|zahlen|bezahlen|honorar)\b/i,
  deliveryCost:/\b(delivery|fulfilment|fulfillment|production|lieferkosten|herstellung)\b/i,
  paymentFees:/\b(payment fee|processing fee|transaction fee|zahlungsgebühr|transaktionsgebühr)\b/i,
  refundAllowance:/\b(refund|chargeback|rückerstattung|erstattung)\b/i,
  taxAllowance:/\b(tax|vat|mwst|steuer)\b/i,
  acquisitionCost:/\b(acquisition|advertising|conversion|akquise|werbung)\b/i,
  fixedTestCost:/\b(setup|pilot cost|test cost|einrichtung|testkosten)\b/i,
  operatingCost:/\b(hosting|subscription|operating|betriebskosten|abonnement)\b/i,
  conservativeSales:/\b(orders|sales|buyers|bestellungen|verkäufe)\b/i,
  probability:/\b(probability|uncertainty|failure|wahrscheinlichkeit|unsicherheit)\b/i,
  timeToRevenue:/\b(settlement|payout|payment terms|auszahlung|zahlungsziel)\b/i,
};

/** Literal search hints, not interpretation, validated economics or citation registration. */
export function suggestEconomicSources(evidence:(DemandEvidence&{digest:string;reviewDecision?:string})[],missing:readonly EconomicField[],now=Date.now()){
  const suggestions:{field:EconomicField;evidenceId:string;evidenceDigest:string;quote:string;stance:'unassessed';untrusted:true}[]=[];
  const seen=new Set<string>();let truncated=false;
  for(const field of ECONOMIC_FIELDS.filter(f=>missing.includes(f))){
    for(const source of evidence){
      const age=now-Date.parse(source.observedAt);
      if(source.provenance!=='reported'||source.reviewDecision==='reject'||!Number.isFinite(age)||age<0||age>90*86400000)continue;
      // Keep full lines so decimal amounts and negations are not split away.
      for(const quote of source.excerpt.split(/\r?\n/).map(line=>line.trim())){
        if(quote.length<10||quote.length>1000||!terms[field].test(quote))continue;
        const key=JSON.stringify([field,quote.toLowerCase().replace(/\s+/g,' ')]);
        if(seen.has(key))continue;seen.add(key);
        if(suggestions.length>=12){truncated=true;continue;}
        suggestions.push({field,evidenceId:source.id,evidenceDigest:source.digest,quote,stance:'unassessed',untrusted:true});
      }
    }
  }
  return {suggestions,truncated,executionAuthorized:false,registeredCitations:0,
    limitation:'Keyword-based literal source hints only. Check relevance, units, exclusions, negation and counterevidence before recording a separate interpretation. No values or probabilities inferred.'};
}
