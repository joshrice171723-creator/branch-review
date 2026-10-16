import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRetest} from '../fix-review.mjs';
import {itemStatus,canApprove,matchesItem,reviewCounts,fixRequest} from '../public/review-model.js';
const item={id:'button',title:'Button',path:'/meta-clinic/resources',steps:['Rust button'],expected:'Rust'};
const issue=(id,commit,expected)=>({id,scenario:'button',location:'/meta-clinic/resources',commit,expected,actual:'Wrong color',createdAt:id,status:'needs-retest'});
test('latest revision requests move older requests to history and reopen the retest without granting approval',()=>{
 const r={identity:{changed:'new'},fixComparison:{before:'pink',after:'new'},manifest:{scenarios:[item]},items:{},checks:{},cursor:{itemId:'button',view:'results'},issues:[issue('1','purple','Blue'),issue('2','blue','Pink'),issue('3','pink','Rust'),issue('4','pink','Hover rust')]};
 prepareRetest(r);
 assert.deepEqual(r.issues.map(i=>i.id),['3','4']);assert.deepEqual(r.requestHistory.map(i=>i.id),['1','2']);
 assert.equal(r.cursor.view,'item');assert.equal(itemStatus(r,item),'ready-to-retest');assert.equal(reviewCounts(r)['ready-to-retest'],1);assert.equal(matchesItem(r,item,'','attention'),true);assert.equal(canApprove(r),false);
 assert.doesNotMatch(fixRequest(r),/Expected: Blue|Expected: Pink/);
 r.cursor.view='results';prepareRetest(r);assert.equal(r.cursor.view,'results');assert.equal(r.requestHistory.length,2);
 r.checks['button:0']=true;assert.equal(canApprove(r),false);
 r.issues.forEach(i=>i.status='resolved');assert.equal(itemStatus(r,item),'passed');assert.equal(canApprove(r),true);
});
test('new failures and findings on other destinations remain active',()=>{
 const old=issue('1','a','Different issue');old.location='/other';
 const reported={...issue('3','new','Still broken'),status:'open'};
 const r={fixComparison:{before:'b',after:'new'},manifest:{scenarios:[item]},items:{},checks:{},issues:[old,issue('2','b','Latest'),reported]};
 prepareRetest(r);assert.equal(r.issues.length,3);assert.equal(itemStatus(r,item),'needs-fixes');
});
