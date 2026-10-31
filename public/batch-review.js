import {itemStatus,fixRequest,isPublished} from './review-model.js';
export const reviewAccountedFor=r=>r.manifest.scenarios.every(item=>['passed','needs-fixes','blocked','not-applicable'].includes(itemStatus(r,item)));
export function batchReview({api,getState,getSide,workflow,capture,poll,error}){
  const $=id=>document.getElementById(id),node=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  let saving=false,capturing=false,editing=null,pinned=null,image=null;
  const draftKey=()=>`branch-review:request:${pinned?.id}:${pinned?.scenario}:${editing?.id||'new'}`;
  const saveDraft=()=>{try{localStorage.setItem(draftKey(),JSON.stringify({actual:text.value,expected:expected.value}));}catch{notice.textContent='Keep this window open until your request is saved.';}};
  const modal=node('dialog','');modal.id='request-dialog';modal.setAttribute('aria-label','Request a change');
  const title=node('h2','Request a change'),context=node('p',''),expected=document.createElement('textarea'),text=document.createElement('textarea'),notice=node('p','');notice.setAttribute('role','status');
  expected.maxLength=text.maxLength=4000;text.rows=4;text.id='request-description';
  const label=node('label','What would you like changed?');label.htmlFor=text.id;
  const detail=node('details',''),summary=node('summary','Expected result (edit if needed)');expected.setAttribute('aria-label','Expected result');detail.append(summary,expected);
  const screenshot=document.createElement('img');screenshot.alt='Attached preview screenshot';screenshot.hidden=true;
  const removeImage=node('button','Remove screenshot');removeImage.type='button';removeImage.onclick=()=>{image=null;screenshot.hidden=removeImage.hidden=true;};
  const save=node('button','Save request and next'),close=node('button','Cancel');save.type=close.type='button';save.className='primary';close.className='secondary';
  close.onclick=()=>{if(!saving)modal.close();};modal.append(title,context,detail,label,text,screenshot,removeImage,notice,save,close);document.body.append(modal);
  const requests=node('button','Changes requested');requests.id='batch-requests';requests.className='secondary';$('review-branch-status').after(requests);
  const listDialog=node('dialog','');listDialog.id='requests-dialog';listDialog.setAttribute('aria-label','Requested changes');const list=node('div',''),listClose=node('button','Close');listClose.onclick=()=>listDialog.close();listDialog.append(node('h2','Requested changes'),list,listClose);document.body.append(listDialog);
  const send=node('button','Make requested changes');send.id='batch-send';send.className='primary';$('results-action').before(send);
  const continueReview=node('button','Continue review'),verify=node('button','Verify fixes'),inline=node('section','');continueReview.className='primary';verify.className='secondary';inline.id='summary-requests';$('batch-send').before(continueReview,verify,inline);
  continueReview.onclick=()=>resume(false);verify.onclick=()=>resume(true);
  async function resume(retest){const r=getState().record,target=r.manifest.scenarios.find(item=>retest?itemStatus(r,item)==='ready-to-retest':['not-started','in-progress'].includes(itemStatus(r,item)));if(target)await workflow.navigate(target.id);}
  let inlineKey='';$('results-checks').open=false;
  const skip=node('button','Save and skip this item');skip.type='button';skip.className='secondary';$('item-more').append(skip);skip.onclick=async()=>{try{if(await workflow.flush())await next();}catch(e){error(e.message);}};
  const openIssues=r=>r.issues.filter(issue=>!['resolved','needs-retest'].includes(issue.status));
  async function next(){
    const r=getState().record,current=r.cursor.itemId,index=r.manifest.scenarios.findIndex(i=>i.id===current);
    const todo=item=>!['passed','needs-fixes','blocked','not-applicable'].includes(itemStatus(r,item));
    const target=r.manifest.scenarios.slice(index+1).find(todo)||r.manifest.scenarios.slice(0,index).find(todo);
    await workflow.navigate(target?.id||current,target?'item':'results');
  }
  async function open(issue=null,selection=null){
    if(saving || capturing || getState().busy || getState().previewVersion)return;
    if(!await workflow.flush())return;
    const state=getState(),r=state.record,item=r.manifest.scenarios.find(i=>i.id===(issue?.scenario||r.cursor.itemId));
    editing=issue;pinned={id:r.id,scenario:item.id,side:getSide(),commit:r.identity.changed,location:selection?.location||workflow.getContext(getSide()).location||item.path};
    context.textContent=item.title;expected.value=issue?.expected||item.expected||item.steps.join(' ');text.value=issue?.actual||'';notice.textContent='Requests are collected until you finish the review.';image=null;screenshot.hidden=removeImage.hidden=true;
    try{const draft=JSON.parse(localStorage.getItem(draftKey())||'null');if(draft){text.value=draft.actual;expected.value=draft.expected;}}catch{}
    save.textContent=issue?'Save changes':'Save request and next';
    capturing=true;
    try{if(!issue){image=await capture();screenshot.src=image;screenshot.hidden=removeImage.hidden=false;}}
    catch{notice.textContent='Screenshot unavailable. You can still save this request.';}
    finally{capturing=false;}
    if(getState().record?.id!==r.id)return;
    modal.showModal();text.focus();
  }
  text.oninput=expected.oninput=saveDraft;
  save.onclick=async()=>{
    if(saving)return;if(!text.value.trim()||!expected.value.trim()){notice.textContent='Describe the change and its expected result.';return;}
    if(getState().record?.id!==pinned.id){notice.textContent='The review changed. Close this request and reopen it on the current version.';return;}
    saving=true;save.disabled=close.disabled=true;
    try{
      if(editing)await api('/api/request-update',{id:pinned.id,issueId:editing.id,actual:text.value,expected:expected.value});
      else await api('/api/issue',{...pinned,actual:text.value,expected:expected.value,screenshot:image});
      try{localStorage.removeItem(draftKey());}catch{}
      modal.close();await poll();if(!editing)await next();
    }catch(e){notice.textContent=e.message;}finally{saving=false;save.disabled=close.disabled=false;}
  };
  function showList(){
    const r=getState().record;list.replaceChildren(...openIssues(r).map(issue=>{
      const row=node('article',''),heading=node('strong',r.manifest.scenarios.find(i=>i.id===issue.scenario)?.title||'Earlier review item'),body=node('p',issue.actual),edit=node('button','Edit'),remove=node('button','Remove');
      edit.onclick=()=>{listDialog.close();void open(issue);};remove.onclick=async()=>{try{await api('/api/request-update',{id:r.id,issueId:issue.id,remove:true});await poll();showList();}catch(e){error(e.message);}};row.append(heading,body,edit,remove);return row;
    }));if(!listDialog.open)listDialog.showModal();
  }
  requests.onclick=showList;
  $('report-problem').onclick=()=>open();
  $('item-next').onclick=async()=>{if(saving)return;saving=true;try{if(!await workflow.flush())return;await api('/api/item-accept',{id:getState().record.id,itemId:getState().record.cursor.itemId});await poll();await next();}catch(e){error(e.message);}finally{saving=false;}};
  send.onclick=async()=>{if(saving)return;saving=true;send.disabled=true;try{if(!await workflow.flush())return;const r=getState().record;await api('/api/job',{id:r.id,kind:'fix',batch:true,requestText:fixRequest({...r,issues:openIssues(r),manifest:{...r.manifest,scenarios:r.manifest.scenarios.filter(item=>openIssues(r).some(issue=>issue.scenario===item.id))}})});await poll();}catch(e){error(e.message);}finally{saving=false;}};
  return {open:()=>open(),openTarget:selection=>open(null,selection),render(state){
    const r=state.record,enabled=!!r&&state.status==='ready'&&!state.busy&&!state.jobsRunning&&!state.previewVersion&&!isPublished(r),count=r?openIssues(r).length:0;
    requests.hidden=!r||!count;requests.textContent=`${count} change${count===1?'':'s'} requested`;requests.disabled=!enabled;skip.disabled=!enabled;
    send.hidden=!r||r.cursor?.view!=='results'||!count;send.textContent=count===1?'Make this change':`Make these ${count} changes`;send.disabled=!enabled||saving||!reviewAccountedFor(r);
    const inSummary=!!r && r.cursor?.view==='results',unfinished=r?r.manifest.scenarios.filter(item=>['not-started','in-progress'].includes(itemStatus(r,item))):[],retests=r?r.manifest.scenarios.filter(item=>itemStatus(r,item)==='ready-to-retest'):[];
    continueReview.hidden=!inSummary||!unfinished.length;continueReview.disabled=!enabled;continueReview.textContent=`Continue ${unfinished.length} unfinished item${unfinished.length===1?'':'s'}`;
    verify.hidden=!inSummary||!retests.length;verify.disabled=!enabled;verify.textContent=`Verify ${retests.length} fix${retests.length===1?'':'es'}`;
    inline.hidden=!inSummary||!count;
    const nextKey=JSON.stringify([r?.id,r?openIssues(r):[],enabled]);
    if(nextKey!==inlineKey){inlineKey=nextKey;inline.replaceChildren(node('h3','Requested changes'),...(r?openIssues(r):[]).map(issue=>{
      const row=node('article',''),title=node('strong',r.manifest.scenarios.find(item=>item.id===issue.scenario)?.title||'Earlier review item'),description=node('p',issue.actual),edit=node('button','Edit'),remove=node('button','Remove');edit.className=remove.className='secondary';edit.disabled=remove.disabled=!enabled;
      edit.onclick=()=>open(issue);remove.onclick=async()=>{remove.disabled=true;try{await api('/api/request-update',{id:r.id,issueId:issue.id,remove:true});await poll();}catch(e){error(e.message);remove.disabled=false;}};row.append(title,description,edit,remove);return row;
    }));}

    $('report-problem').textContent='Needs a change';$('report-problem').disabled=!enabled;
    $('item-next').textContent='Looks good → Next';$('item-next').disabled=!enabled||saving||!!r?.issues.some(i=>i.scenario===r.cursor.itemId&&i.status!=='resolved'&&i.status!=='needs-retest');
    $('prepare-handoff').hidden=true;$('handoff-panel').hidden=true;
    if(r && r.cursor?.view==='results'&&count){$('results-action').hidden=true;$('results-message').hidden=false;$('results-message').textContent=reviewAccountedFor(r)?'Review your collected requests, then make the changes together.':'Finish reviewing the remaining items before sending these requests.';}else $('results-action').hidden=false;
    if(inSummary && (unfinished.length||retests.length)){$('results-action').hidden=true;$('results-message').hidden=false;$('results-message').textContent='Continue the unfinished items and verify completed fixes before making another batch of changes.';}
  }};
}
