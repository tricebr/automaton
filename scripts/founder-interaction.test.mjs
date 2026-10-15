import test from 'node:test';
import assert from 'node:assert/strict';
import {outsideDialog,taskProgress,readableResult,liveTrading} from '../web/founder/interaction.mjs';
test('trading hides disconnected, stale and future snapshots',()=>{
 const now=Date.now(),data={status:'connected',observedAt:new Date(now).toISOString()};
 assert.equal(liveTrading(data,now),true);
 assert.equal(liveTrading({...data,observedAt:new Date(now-16000).toISOString()},now),false);
 assert.equal(liveTrading({...data,observedAt:new Date(now+2000).toISOString()},now),false);
 assert.equal(liveTrading(null,now),false);
});
test('storage receipts explain what happened without presenting technical identifiers as a result',()=>{
 const text=readableResult({kind:'drive-output',privacy:'private',remoteStatus:'verified',independentFactualVerification:false,digest:'internal-digest'});
 assert.match(text,/privaten/);assert.match(text,/fachlich/);assert.ok(!text.includes('internal-digest'));
});
test('only backdrop clicks outside the dialog bounds dismiss it',()=>{
 const rect={left:100,right:500,top:100,bottom:400};
 assert.equal(outsideDialog(50,200,rect),true);assert.equal(outsideDialog(150,200,rect),false);assert.equal(outsideDialog(100,100,rect),false);
});
test('progress distinguishes user review from automatic checks and never marks failed work complete',()=>{
 assert.equal(taskProgress({source:'own',status:'review'}).current,2);
 assert.equal(taskProgress({source:'autonomy',status:'done'}).labels[3],'Ergebnis bereit');
 assert.equal(taskProgress({source:'own',status:'done'}).labels[3],'Fertig');
 assert.equal(taskProgress({status:'failed'}).current,1);
});
import {draftChanged,rememberDraft} from '../web/founder/interaction.mjs';
test('saved prepaid selection uses its explicit baseline and preserves later user edits',()=>{
 const input={tagName:'SELECT',value:'prepaid',defaultValue:'prepaid',options:[{value:'service'},{value:'prepaid'}]};
 rememberDraft(input);assert.equal(draftChanged(input),false);input.value='service';assert.equal(draftChanged(input),true);
});

test('unchanged selects do not block refresh while actual selection edits stay protected',()=>{
 const options=[{value:'first',defaultSelected:false},{value:'second',defaultSelected:false}];
 assert.equal(draftChanged({tagName:'SELECT',value:'first',options}),false);
 assert.equal(draftChanged({tagName:'SELECT',value:'second',options}),true);
 options[1].defaultSelected=true;
 assert.equal(draftChanged({tagName:'SELECT',value:'second',options}),false);
 assert.equal(draftChanged({tagName:'TEXTAREA',value:'new draft',defaultValue:''}),true);
 assert.equal(draftChanged({tagName:'INPUT',value:'saved',defaultValue:'saved'}),false);
});
import {explainTerm} from '../web/founder/interaction.mjs';
test('context help explains finance and mission terms without inventing outcomes',()=>{
 assert.match(explainTerm('MISSION FORTSCHRITT'),/abgeschlossen/);
 assert.match(explainTerm('Gewinn ↗'),/Ausgaben/);
 assert.match(explainTerm('Swap'),/Finanzierung/);
 assert.equal(explainTerm('Unbekannte neue Überschrift'),null);
});
