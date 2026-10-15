import test from 'node:test';
import assert from 'node:assert/strict';
import {renderFounderArchive} from '../web/founder/interaction.mjs';
class Element{constructor(tag){this.tagName=tag;this.children=[];this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}text(){return this.textContent+' '+this.children.map(c=>c.text()).join(' ');}}
test('archive renders completed results with read-only open and pagination actions',()=>{
 const previous=global.document;global.document={createElement:tag=>new Element(tag)};
 try{const box=new Element('section'),opened=[];let more=0;renderFounderArchive(box,{items:[{id:'done',kind:'local',input:{title:'A completed task'},updated_ms:1800000000000}],total:146,nextCursor:'1800000000000:done',loading:false},{open:item=>opened.push(item.id),more:()=>more++,refresh(){}});assert.match(box.text(),/146 abgeschlossene Arbeiten/);assert.match(box.text(),/A completed task/);const buttons=box.children.flatMap(c=>[c,...c.children]).filter(c=>c.tagName==='button');buttons.find(b=>b.textContent==='Ergebnis öffnen').onclick();buttons.find(b=>b.textContent==='Weitere laden').onclick();assert.deepEqual(opened,['done']);assert.equal(more,1);assert.doesNotMatch(box.text(),/einschalten|freigeben|Wiederholen/);}finally{global.document=previous;}
});
test('unavailable running server is explained without inventing an empty archive',()=>{
 const previous=global.document;global.document={createElement:tag=>new Element(tag)};try{const box=new Element('section');renderFounderArchive(box,{items:[],total:null,nextCursor:null,error:'Dienst wird noch aktualisiert.',loading:false},{refresh(){}});assert.match(box.text(),/Dienst wird noch aktualisiert/);assert.doesNotMatch(box.text(),/0 abgeschlossene Arbeiten|Noch keine abgeschlossenen/);}finally{global.document=previous;}
});
