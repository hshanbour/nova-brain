import test from 'node:test';
import assert from 'node:assert/strict';
import {readFreshaSelector} from '../src/booking/fresha-browser-operations.js';
test('actual selector shape uses accessible button names and sibling price text',()=>{
const snapshot=`- dialog:
  - button "Close Drawer"
  - button "Haircut (no beard trim )"
  - paragraph: Haircut (no beard trim )
  - paragraph: 25m
  - text: £20
  - button "Waxing"
  - paragraph: Waxing
  - paragraph: 5m
  - text: from £3`;
assert.deepEqual(readFreshaSelector(snapshot),[{name:'Haircut (no beard trim )',durationMinutes:25,priceGbp:20,priceFrom:false},{name:'Waxing',durationMinutes:5,priceGbp:3,priceFrom:true}]);
assert.deepEqual(readFreshaSelector('- list:\n  - listitem:\n    - button "Any team member"\n  - listitem:\n    - button "Hamood"\n    - text: Hamood',{team:true}),['Hamood']);
});
