import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSourceOverview,sourceOverviewCards,renderSourceOverview} from '../web/founder/interaction.mjs';
import {readFileSync} from 'node:fs';
test('overview renders saved evidence with safe read-only links and initializes before boot',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}text(){return (this.textContent??'')+' '+this.children.map(n=>n.text()).join(' ');}}
 const fixture={schema:'numaron-source-overview-v1',checkedAt:'2026-10-17T00:20:03Z',ugig:{storage:'independently_confirmed',status:'pending',proposedUSD:300},guru:{reachable:true,page:3,rows:20,total:182}};
 const text='/* SOURCE_OVERVIEW_JSON\n'+JSON.stringify(fixture)+'\nEND_SOURCE_OVERVIEW_JSON */',box=new Element('section');
 renderSourceOverview(box,parseSourceOverview(text),{createElement:tag=>new Element(tag)});
 assert.match(box.text(),/Antwort ausstehend/);assert.match(box.text(),/182 ausgeschriebene/);
 const cards=box.children.filter(n=>n.tag==='article');assert.equal(cards.length,2);
 for(const card of cards){assert.equal(card.children.at(-1).tag,'a');assert.equal(card.children.at(-1).rel,'noopener noreferrer');assert.ok(card.children.every(n=>n.tag!=='button'));}
 const app=readFileSync(new URL('../web/founder/app.js',import.meta.url),'utf8');assert.ok(app.indexOf('let sourceOverviewBusy=false')<app.indexOf('void boot()'));
});
test('confirmed storage remains distinct from assignment and payment',()=>{
 const p={schema:'numaron-source-overview-v1',checkedAt:'2026-10-17T00:20:03Z',ugig:{storage:'independently_confirmed',status:'pending',proposedUSD:300},guru:{reachable:true,page:3,rows:20,total:182}};
 const cards=sourceOverviewCards(parseSourceOverview('/* SOURCE_OVERVIEW_JSON\n'+JSON.stringify(p)+'\nEND_SOURCE_OVERVIEW_JSON */'));
 assert.match(cards[0].status,/bestätigt gespeichert/);assert.match(cards[0].detail,/keine Auftragszusage/);assert.match(cards[1].detail,/Seite 3/);
 assert.match(cards[0].checkedAt,/17\.10\.2026/);
});
test('invalid data is never presented as a successful check',()=>{
 assert.throws(()=>parseSourceOverview('unavailable'));
 assert.throws(()=>parseSourceOverview('/* SOURCE_OVERVIEW_JSON\n{"schema":"numaron-source-overview-v1","checkedAt":"bad"}\nEND_SOURCE_OVERVIEW_JSON */'));
 const cards=sourceOverviewCards({checkedAt:'2026-10-17T00:20:03Z',ugig:{storage:'unknown'},guru:{reachable:false}});
 assert.match(cards[0].status,/ungeklärt/);assert.match(cards[1].status,/nicht bestätigt/);
});
