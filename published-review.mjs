import {target} from './publish.mjs';

export async function publishedPin(record,fetcher=fetch){
  if(!['published','verified'].includes(record.delivery?.stage))throw new Error('Publish this reviewed commit before starting hosted verification.');
  const response=await fetcher(target+'/build.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Could not verify the published build.');
  const build=await response.json();if(build.revision!==record.identity.changed)throw new Error('The published revision differs from this review. Start a review of the deployed commit.');
  return{commit:build.revision,checkedAt:new Date().toISOString(),target};
}
export async function publishedAction(store,record,data,fetcher=fetch){
  const pin=await publishedPin(record,fetcher);
  if(data.action==='start'){
    if(!record.publishedReview || record.publishedReview.commit!==pin.commit)record.publishedReview={...pin,checks:{},notes:{},cursor:record.manifest.scenarios[0].id};
    record.publishedReview.checkedAt=pin.checkedAt;return store.event(record,'published-review-started',pin);
  }
  const review=record.publishedReview;if(!review || review.commit!==pin.commit)throw new Error('Start published verification first.');
  const item=record.manifest.scenarios.find(item=>item.id===data.itemId);if(!item)throw new Error('Choose an existing review item.');
  if(data.action==='check'){
    if(!Number.isInteger(data.index)||data.index<0||data.index>=item.steps.length||typeof data.passed!=='boolean')throw new Error('Choose a valid published check.');
    review.checks[`${item.id}:${data.index}`]=data.passed;
    if(!data.passed && record.delivery.stage==='verified')record.delivery.stage='published';
  }else if(data.action==='note'){
    if(typeof data.note!=='string'||data.note.length>4000)throw new Error('Notes must be shorter than 4,000 characters.');review.notes[item.id]=data.note;
  }else if(data.action==='cursor')review.cursor=item.id;
  else throw new Error('Unsupported published-review action.');
  review.checkedAt=pin.checkedAt;return store.event(record,'published-review-'+data.action,{itemId:item.id,index:data.index,passed:data.passed,commit:pin.commit});
}
export function publishedComplete(record){return record.publishedReview?.commit===record.identity.changed && record.manifest.scenarios.every(item=>item.steps.every((_,index)=>record.publishedReview.checks[`${item.id}:${index}`]));}
