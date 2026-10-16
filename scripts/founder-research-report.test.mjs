import test from 'node:test';import assert from 'node:assert/strict';
import {researchReport,renderResearchReport} from '../web/founder/interaction.mjs';
const fixture=()=>({kind:'research',target:'Specula-Labs/specula-api',observedAt:'2026-10-16T23:14:16Z',researchGoal:'Zahlungsweg prüfen',coverage:[{area:'readme',status:'observed',url:'https://github.com/Specula-Labs/specula-api/blob/main/README.md'},{area:'contributing',status:'observed'},{area:'funding',status:'not_found',partial:true},{area:'discussions',status:'disabled'},{area:'issues',status:'observed',partial:true}],sources:[{url:'https://github.com/Specula-Labs/specula-api/issues',claim:'[Selected excerpts] "url":"https://github.com/Specula-Labs/specula-api/issues/9","title":"[Bounty: $55] Remove unused dependencies","body":"conditions truncated","state":"closed"},{"url":"https://github.com/Specula-Labs/specula-api/pull/23","title":"Delivered USD 55 task","state":"closed"}',truncated:true},{url:'https://github.com/Specula-Labs/specula-api/blob/main/README.md',claim:'Public introduction',truncated:true}],checks:{paymentConfirmed:false,escrowConfirmed:false,coverageComplete:false}});
test('research report distinguishes advertised closed bounties from confirmed payment and incomplete coverage',()=>{
 const r=researchReport(fixture());assert.equal(r.target,'Specula-Labs/specula-api');assert.equal(r.bounties.length,1);assert.equal(r.bounties[0].amount,'USD 55');assert.equal(r.bounties[0].state,'Geschlossen');
 assert.ok(r.open.some(x=>/Zahlung/.test(x)));assert.ok(r.open.some(x=>/Escrow/.test(x)));assert.ok(r.open.some(x=>/gekürzt/.test(x)));assert.equal(r.coverage.find(x=>x.area==='funding').label,'Nicht gefunden');assert.equal(r.coverage.find(x=>x.area==='discussions').label,'Deaktiviert');
 assert.match(r.summary,/nicht bestätigt/);assert.match(r.bountyNote,/keine Zahlungszusage/);
});
test('missing data cannot become absence of a payment path or an assumed successful verification',()=>{
 const r=researchReport({kind:'research',target:'Other/repo',sources:[]});assert.equal(r.bounties.length,0);assert.match(r.bountyNote,/kein Nachweis/);assert.ok(r.open.some(x=>/Abdeckung/.test(x)));assert.ok(r.open.some(x=>/Zahlung/.test(x)));assert.equal(researchReport({kind:'private-draft'}),null);
});
test('only exact repository issue links can become bounty evidence; source strings remain plain data',()=>{
 const f=fixture();f.sources[0].claim='"url":"javascript:alert(1)","title":"[Bounty: $900] secret" "url":"https://github.com/Evil/repo/issues/1","title":"[Bounty: $999] wrong repo"';f.sources.push({url:'javascript:alert(1)',claim:'<img src=x onerror=alert(1)>'});
 const r=researchReport(f);assert.equal(r.bounties.length,0);assert.equal(r.sources.some(s=>s.url.startsWith('javascript:')),false);
});
test('a truncated bounty record keeps its issue status unknown and duplicate excerpts count once',()=>{
 const f=fixture();f.sources[0].claim='"url":"https://github.com/Specula-Labs/specula-api/issues/8","title":"[Bounty: $50] Align names","body":"cut';f.sources.push({...f.sources[0]});const r=researchReport(f);assert.equal(r.bounties.length,1);assert.equal(r.bounties[0].state,'Status im Auszug nicht enthalten');
});

test('report renders semantic sections, safe source links and expandable evidence without interpreting HTML',()=>{
 class Node{constructor(tag){this.tag=tag;this.children=[];this.textContent='';}append(...items){this.children.push(...items);}set innerHTML(value){throw Error('HTML execution forbidden');}all(){return [this,...this.children.flatMap(c=>c.all())];}}
 const f=fixture();f.sources[1].claim='<img src=x onerror=alert(1)> literal public text';const root=renderResearchReport(f,{createElement:tag=>new Node(tag)}),nodes=root.all(),text=nodes.map(n=>n.textContent).join('\n');
 assert.ok(nodes.some(n=>n.tag==='h3'&&n.textContent==='Was noch offen ist'));assert.ok(nodes.some(n=>n.tag==='table'));assert.ok(nodes.some(n=>n.tag==='details'));assert.match(text,/<img src=x onerror=alert\(1\)>/);
 assert.ok(nodes.filter(n=>n.tag==='a').every(n=>n.href.startsWith('https://github.com/')&&n.rel==='noopener noreferrer'));assert.equal(nodes.some(n=>n.tag==='button'||n.tag==='script'||n.tag==='img'),false);assert.doesNotMatch(text,/"kind"\s*:/);
});
