import test from 'node:test';
import assert from 'node:assert/strict';
import {missionDeck} from '../web/founder/model.mjs';
test('mission deck uses actual completed work and preserves waiting and failed states',()=>{
 const deck=missionDeck({autonomy:{status:'paused',tasks:[{id:'a',status:'done',title:'Fertig'},{id:'b',status:'queued'},{id:'c',status:'failed'}]},products:[]});
 assert.equal(deck.completed,1);assert.equal(deck.total,3);assert.equal(deck.state,'paused');assert.equal(deck.progress,33);
 assert.equal(deck.missions[0].status,'queued');assert.equal(deck.milestones[0].earned,true);assert.equal(deck.milestones[1].earned,false);
});
test('missing observations never claim activity or award achievements',()=>{
 const deck=missionDeck({});assert.equal(deck.state,'unknown');assert.equal(deck.progress,0);assert.equal(deck.completed,0);assert.ok(deck.milestones.every(m=>!m.earned));assert.deepEqual(deck.missions,[]);
});
