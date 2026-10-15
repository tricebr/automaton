import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {PublicSignal} from './sources.js';
import type {ResearchOpportunity} from '../revenue/research.js';

export const HORIZON_TOPIC='open market discovery';
export const DISCOVERY_SCHEMA=`
CREATE TABLE IF NOT EXISTS online_discovery_observations(id TEXT PRIMARY KEY,topic TEXT NOT NULL,source_url TEXT NOT NULL,excerpt TEXT NOT NULL,observed_at TEXT NOT NULL,demand INTEGER NOT NULL,willingness INTEGER NOT NULL,sector TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS online_discovery_topic ON online_discovery_observations(topic);
CREATE TABLE IF NOT EXISTS online_discovery_trials(job_id INTEGER PRIMARY KEY,topic TEXT NOT NULL,qualifying_sources INTEGER NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
CREATE TABLE IF NOT EXISTS online_discovery_trial_validity(job_id INTEGER PRIMARY KEY,checked_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS online_discovery_trial_evidence(job_id INTEGER PRIMARY KEY,prior_job_id INTEGER,payload TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS discovery_evidence_no_update BEFORE UPDATE ON online_discovery_trial_evidence BEGIN SELECT RAISE(ABORT,'Discovery trial evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_evidence_no_delete BEFORE DELETE ON online_discovery_trial_evidence BEGIN SELECT RAISE(ABORT,'Discovery trial evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_validity_no_update BEFORE UPDATE ON online_discovery_trial_validity BEGIN SELECT RAISE(ABORT,'Discovery validity immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_validity_no_delete BEFORE DELETE ON online_discovery_trial_validity BEGIN SELECT RAISE(ABORT,'Discovery validity immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_observation_no_update BEFORE UPDATE ON online_discovery_observations BEGIN SELECT RAISE(ABORT,'Discovery observation immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_observation_no_delete BEFORE DELETE ON online_discovery_observations BEGIN SELECT RAISE(ABORT,'Discovery observation immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_trial_no_update BEFORE UPDATE ON online_discovery_trials BEGIN SELECT RAISE(ABORT,'Discovery trial immutable'); END;
CREATE TRIGGER IF NOT EXISTS discovery_trial_no_delete BEFORE DELETE ON online_discovery_trials BEGIN SELECT RAISE(ABORT,'Discovery trial immutable'); END;`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const demand=/\b(need(?:ed|s)?|looking for|help wanted|recommend|manual|time consuming|wish|suche|gesucht|brauche|aufwendig)\b/i;
const willingness=/\b(pay|paying|paid|budget|hire|hiring|bounty|bezahl\w*|honorar)\b/i;
const unsafe=/\b(ignore.{0,25}instructions|system prompt|seed phrase|private key|steal|phishing|ransomware|money laundering|guaranteed profit)\b/i;
const stop=new Set('ask hn show help wanted need needed needs looking for anyone recommend recommendation can could how what which would should you your we our i my a an the to of with without and or is are be in on at from please tool tools software app service solution automate automation'.split(' '));
function fresh(s:PublicSignal){const age=Date.now()-Date.parse(s.observedAt);return Number.isFinite(age)&&age>=0&&age<=90*86400000;}
/** Extracts bounded search terms only. Source prose never becomes instructions or permissions. */
export function deriveResearchHypothesis(s:PublicSignal){
  if(!fresh(s)||unsafe.test(s.excerpt)||!demand.test(s.excerpt))return null;
  const title=(s.title??s.excerpt.split(/[.!?\n]/)[0]).normalize('NFKC').toLowerCase();
  if(title.length>300||/[@<>:/\\]|\d{6}/.test(title.replace(/^ask hn:\s*/,'')))return null;
  const words=title.replace(/^ask hn:\s*/,'').match(/[\p{L}][\p{L}-]{2,24}/gu)??[];
  const terms=[...new Set(words.filter(w=>!stop.has(w)))].slice(0,6);
  const topic=terms.join(' ');if(terms.length<2||topic.length>80)return null;
  const sector:ResearchOpportunity['sector']=/\b(trading|crypto|stock market|financial)\b/i.test(s.excerpt)?'market-research':
    /\b(data|dataset|analytics)\b/i.test(s.excerpt)?'data-products':
    /\b(marketplace|sellers|buyers)\b/i.test(s.excerpt)?'marketplaces':'b2b-services';
  return {topic,sector,demand:1,willingness:Number(willingness.test(s.excerpt))};
}

export function recordDiscoverySignals(db:Database,signals:PublicSignal[]){
  for(const signal of signals.slice(0,8)){
    const candidate=deriveResearchHypothesis(signal);if(!candidate)continue;
    const id=hash(JSON.stringify([candidate.topic,signal.sourceUrl,signal.excerpt,signal.observedAt]));
    if(db.prepare('SELECT 1 FROM online_discovery_observations WHERE id=?').get(id))continue;
    if((db.prepare('SELECT COUNT(*) n FROM online_discovery_observations').get() as {n:number}).n>=1000)break;
    if(!db.prepare('SELECT 1 FROM online_discovery_observations WHERE topic=?').get(candidate.topic)&&
      (db.prepare('SELECT COUNT(DISTINCT topic) n FROM online_discovery_observations').get() as {n:number}).n>=200)continue;
    db.prepare('INSERT INTO online_discovery_observations VALUES(?,?,?,?,?,?,?,?)').run(id,candidate.topic,signal.sourceUrl,signal.excerpt,signal.observedAt,candidate.demand,candidate.willingness,candidate.sector);
  }
}

/** Cheap preliminary validation uses relevance, freshness and separate hosts, not claimed revenue. */
export function recordDiscoveryTrial(db:Database,jobId:number,topic:string,signals:PublicSignal[]){
  if(db.prepare('SELECT 1 FROM online_discovery_trials WHERE job_id=?').get(jobId))return;
  if(!db.prepare('SELECT 1 FROM online_discovery_observations WHERE topic=?').get(topic))return;
  const checkedAt=Date.now();
  const prior=db.prepare(`SELECT t.job_id,t.decision,v.checked_ms,v.expires_ms FROM online_discovery_trials t
    LEFT JOIN online_discovery_trial_validity v ON v.job_id=t.job_id WHERE t.topic=? ORDER BY t.job_id DESC LIMIT 1`).get(topic) as
    {job_id:number;decision:string;checked_ms:number;expires_ms:number}|undefined;
  const revalidating=prior?.decision==='research_supported'&&Number.isSafeInteger(prior.expires_ms)&&prior.expires_ms<checkedAt;
  const evidence:{sourceDigest:string;observedMs:number}[]=[];
  const terms=topic.split(' '),hosts=new Set<string>(),texts=new Set<string>();let paying=false,expiresAt=checkedAt+90*86400000;
  for(const s of signals){
    if(!fresh(s)||unsafe.test(s.excerpt)||!demand.test(s.excerpt))continue;
    // A new validation cannot recycle the source generation whose support expired.
    if(revalidating&&Date.parse(s.observedAt)<=prior!.expires_ms)continue;
    const text=s.excerpt.toLowerCase(),words=new Set(text.match(/[\p{L}][\p{L}-]{2,24}/gu)??[]),matches=terms.filter(t=>words.has(t)).length;
    if(matches<Math.min(2,terms.length))continue;
    const excerpt=hash(text.replace(/\s+/g,' ').trim()),host=new URL(s.sourceUrl).hostname;
    if(texts.has(excerpt)||hosts.has(host))continue;
    texts.add(excerpt);hosts.add(host);paying||=willingness.test(text);
    evidence.push({sourceDigest:hash(JSON.stringify([s.sourceUrl,s.excerpt,s.observedAt])),observedMs:Date.parse(s.observedAt)});
    expiresAt=Math.min(expiresAt,Date.parse(s.observedAt)+90*86400000);
  }
  const attempts=(db.prepare('SELECT COUNT(*) n FROM online_discovery_trials WHERE topic=?').get(topic) as {n:number}).n;
  const decision=hosts.size>=2&&paying?'research_supported':attempts>=1?'reject':'hold';
  const reason=decision==='research_supported'?'Relevant fresh reports on two hosts with a payment-intent claim; no verified customer or economic forecast':
    decision==='reject'?'Two bounded research trials did not establish sufficient preliminary demand; stop automatic topic spending':
    'Insufficient preliminary evidence; allow one further research trial after cooldown';
  db.transaction(()=>{
    const inserted=db.prepare('INSERT OR IGNORE INTO online_discovery_trials(job_id,topic,qualifying_sources,decision,reason) VALUES(?,?,?,?,?)').run(jobId,topic,hosts.size,decision,reason);
    if(inserted.changes){
      db.prepare('INSERT INTO online_discovery_trial_validity VALUES(?,?,?)').run(jobId,checkedAt,expiresAt);
      db.prepare('INSERT INTO online_discovery_trial_evidence VALUES(?,?,?)').run(jobId,revalidating?prior!.job_id:null,JSON.stringify(evidence));
    }
  }).immediate();
}

/** Read-only audit against the job's research ledger; hashes are integrity, not source authentication. */
export function inspectDiscoveryTrialEvidence(db:Database,jobId:number):{verified:boolean;reason:string}{
  try{
    return db.transaction(()=>{
      const row=db.prepare(`SELECT t.topic,t.qualifying_sources,t.decision,v.checked_ms,v.expires_ms,s.payload,s.prior_job_id,j.opportunity_id
        FROM online_discovery_trials t JOIN online_discovery_trial_validity v ON v.job_id=t.job_id
        JOIN online_discovery_trial_evidence s ON s.job_id=t.job_id JOIN online_jobs j ON j.id=t.job_id AND j.topic=t.topic WHERE t.job_id=?`).get(jobId) as
        {topic:string;qualifying_sources:number;decision:string;checked_ms:number;expires_ms:number;payload:string;prior_job_id:number|null;opportunity_id:string}|undefined;
      if(!row)throw Error();
      const entries=JSON.parse(row.payload) as {sourceDigest:string;observedMs:number}[];
      if(!Array.isArray(entries)||entries.length>8||entries.length!==row.qualifying_sources||!Number.isSafeInteger(row.checked_ms)||row.checked_ms<=0||row.checked_ms>Date.now()||!Number.isSafeInteger(row.expires_ms))throw Error();
      const ledger=db.prepare('SELECT payload,digest FROM research_evidence WHERE opportunity_id=? LIMIT 1001').all(row.opportunity_id) as {payload:string;digest:string}[];
      if(ledger.length>1000)throw Error();
      const sources=new Map<string,{sourceUrl:string;excerpt:string;observedAt:string}>();
      for(const stored of ledger){
        if(hash(stored.payload)!==stored.digest)throw Error();
        const source=JSON.parse(stored.payload);
        if(source.opportunityId!==row.opportunity_id||typeof source.sourceUrl!=='string'||typeof source.excerpt!=='string'||typeof source.observedAt!=='string')throw Error();
        sources.set(hash(JSON.stringify([source.sourceUrl,source.excerpt,source.observedAt])),source);
      }
      let expiry=row.checked_ms+90*86400000,paying=false,priorExpiry:number|undefined;
      const prior=db.prepare(`SELECT t.job_id,t.decision,v.checked_ms,v.expires_ms FROM online_discovery_trials t
        LEFT JOIN online_discovery_trial_validity v ON v.job_id=t.job_id
        WHERE t.topic=? AND t.job_id<? ORDER BY t.job_id DESC LIMIT 1`).get(row.topic,jobId) as
        {job_id:number;decision:string;checked_ms:number;expires_ms:number}|undefined;
      if(prior&&(!['hold','reject','research_supported'].includes(prior.decision)||!Number.isSafeInteger(prior.checked_ms)||!Number.isSafeInteger(prior.expires_ms)||prior.checked_ms<=0||
        prior.checked_ms>row.checked_ms||prior.expires_ms<prior.checked_ms||prior.expires_ms-prior.checked_ms>90*86400000))throw Error();
      const expectedPrior=prior?.decision==='research_supported'&&prior.expires_ms<row.checked_ms?prior.job_id:null;
      if(row.prior_job_id!==expectedPrior)throw Error();
      if(expectedPrior!==null&&prior){
        priorExpiry=prior.expires_ms;
      }
      const hosts=new Set<string>(),texts=new Set<string>(),digests=new Set<string>();
      for(const entry of entries){
        const source=sources.get(entry.sourceDigest);
        if(!source||digests.has(entry.sourceDigest)||!Number.isSafeInteger(entry.observedMs)||Date.parse(source.observedAt)!==entry.observedMs||
          entry.observedMs>row.checked_ms||row.checked_ms-entry.observedMs>90*86400000||(priorExpiry!==undefined&&entry.observedMs<=priorExpiry))throw Error();
        const host=new URL(source.sourceUrl).hostname,text=source.excerpt.toLowerCase(),normalized=text.replace(/\s+/g,' ').trim();
        const words=new Set(text.match(/[\p{L}][\p{L}-]{2,24}/gu)??[]),terms=row.topic.split(' ');
        if(hosts.has(host)||texts.has(normalized)||unsafe.test(text)||!demand.test(text)||terms.filter(t=>words.has(t)).length<Math.min(2,terms.length))throw Error();
        hosts.add(host);texts.add(normalized);digests.add(entry.sourceDigest);paying||=willingness.test(text);expiry=Math.min(expiry,entry.observedMs+90*86400000);
      }
      const expectedDecision=hosts.size>=2&&paying?'research_supported':prior?'reject':'hold';
      if(expiry!==row.expires_ms||row.decision!==expectedDecision)throw Error();
      return {verified:true,reason:'Recorded source generation matches the job research ledger; public claims remain unauthenticated'};
    })();
  }catch{return {verified:false,reason:'Discovery evidence missing or inconsistent; reconciliation required'};}
}

export function discoveryCandidates(db:Database){
  const rows=db.prepare('SELECT * FROM online_discovery_observations ORDER BY id LIMIT 1000').all() as {topic:string;source_url:string;excerpt:string;observed_at:string;willingness:number;sector:ResearchOpportunity['sector']}[];
  const grouped=new Map<string,{topic:string;sector:ResearchOpportunity['sector'];hosts:Set<string>;texts:Set<string>;paying:boolean;newest:number}>();
  for(const row of rows){
    const candidate=grouped.get(row.topic)??{topic:row.topic,sector:row.sector,hosts:new Set<string>(),texts:new Set<string>(),paying:false,newest:0};
    grouped.set(row.topic,candidate);
    if(!fresh({id:'',sourceUrl:row.source_url,excerpt:row.excerpt,observedAt:row.observed_at}))continue;
    candidate.newest=Math.max(candidate.newest,Date.parse(row.observed_at));
    const h=hash(row.excerpt.toLowerCase().replace(/\s+/g,' ').trim());if(candidate.texts.has(h))continue;
    candidate.texts.add(h);candidate.hosts.add(new URL(row.source_url).hostname);candidate.paying||=row.willingness===1;
  }
  return [...grouped.values()].map(c=>{
    const trials=db.prepare(`SELECT t.decision,t.reason,v.checked_ms,v.expires_ms FROM online_discovery_trials t
      LEFT JOIN online_discovery_trial_validity v ON v.job_id=t.job_id WHERE t.topic=? ORDER BY t.job_id DESC`).all(c.topic) as {decision:string;reason:string;checked_ms:number|null;expires_ms:number|null}[];
    const latest=trials[0],now=Date.now();
    const supportedExpired=latest?.decision==='research_supported'&&(!Number.isSafeInteger(latest.checked_ms)||!Number.isSafeInteger(latest.expires_ms)||
      latest.checked_ms!>now||latest.expires_ms!<now||latest.expires_ms!<latest.checked_ms!||latest.expires_ms!-latest.checked_ms!>90*86400000);
    const decision=c.hosts.size?(supportedExpired?'stale':latest?.decision??'explore'):'stale';
    // At most three lifetime trials, and only a previously supported topic may
    // receive this extra attempt. Legacy/invalid evidence and rejected topics stay closed.
    const revalidationEligible=!!supportedExpired&&trials.length<3&&Number.isSafeInteger(latest.checked_ms)&&
      Number.isSafeInteger(latest.expires_ms)&&latest.checked_ms!>0&&latest.expires_ms!>=latest.checked_ms!&&
      latest.expires_ms!-latest.checked_ms!<=90*86400000&&latest.expires_ms!<now&&
      now-latest.checked_ms!>=30*86400000&&c.newest>latest.expires_ms!;
    return {topic:c.topic,sector:c.sector,reportedHosts:c.hosts.size,paymentIntentClaim:c.paying,trials:trials.length,decision,
      revalidationEligible,
      priority:4*Math.min(c.hosts.size,3)+(c.paying?4:0)-Math.min(trials.length,2),
      reason:supportedExpired?'Supporting trial evidence expired or lacks a valid persisted lifetime; new topic observations do not renew it':latest?.reason??'Unverified public demand clue; validate cheaply before any business execution',
      profitEstimate:null,executionAuthorized:false};
  }).sort((a,b)=>b.priority-a.priority||a.topic.localeCompare(b.topic));
}
