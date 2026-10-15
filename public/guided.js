import {itemStatus,statusLabels,reviewCounts,isComplete,nextItem,fixRequest,canApprove,matchesItem} from './review-model.js';
const $ = id => document.getElementById(id);
const el = (tag,text,className) => { const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node; };
export function guided({api,getState,poll,error,onSelect,needsNavigation=()=>false}) {
  let key='', queueKey='', timer, pending=false, advancing=false, dirty=false, version=0, savePromise=Promise.resolve(true);
  let recordId='', itemId='';
  const status = text => { $('item-save').textContent=text; };
  function draft() { return {outcome:$('item-outcome').value,notes:$('item-notes').value,reason:$('item-reason').value}; }
  function draftKey() { return `branch-review:item:${recordId}:${itemId}`; }
  function edited() {
    dirty=true;version++;status('Unsaved changes');
    try { localStorage.setItem(draftKey(),JSON.stringify(draft())); } catch { status('Keep this window open until your notes are saved.'); }
    clearTimeout(timer);timer=setTimeout(()=>void flush(),650);
    $('item-reason-wrap').hidden=!$('item-outcome').value;
  }
  async function flush() {
    clearTimeout(timer);
    if (!dirty) return savePromise;
    const data=draft(), capturedVersion=version, capturedKey=draftKey(), id=recordId, selected=itemId;
    if (data.outcome && !data.reason.trim()) { status('Add a reason to save this outcome.');return false; }
    dirty=false;status('Saving…');
    savePromise=savePromise.catch(()=>false).then(async()=>{
      try {
        await api('/api/item',{id,itemId:selected,...data});
        if (capturedVersion===version && capturedKey===draftKey()) { status('Saved');try{localStorage.removeItem(capturedKey);}catch{} }
        await poll();return true;
      } catch(e) { if(capturedKey===draftKey())dirty=true;status('Save failed — your notes are kept here.');error(e.message);return false; }
    });
    return savePromise;
  }
  async function navigate(next, view='item') {
    if(pending)return;
    pending=true;render(getState());
    try {
      if(!await flush())return;
      const r=getState().record, old=r.manifest.scenarios.find(item=>item.id===itemId), target=r.manifest.scenarios.find(item=>item.id===next);
      if(view==='item' && old && target && (old.path!==target.path || old.originalPath!==target.originalPath || needsNavigation(target)) && !confirm('Open the next screen in both previews? Save any edits inside the preview first.'))return;
      await api('/api/cursor',{id:r.id,itemId:next,view});
      if(view==='item' && target && !matchesItem(r,target,$('item-search').value,$('item-filter').value || 'all')){$('item-search').value='';$('item-filter').value='all';}
      await poll();if(view==='item')onSelect(next);$(view==='item'?'guided-item':'guided-results').scrollIntoView({block:'start'});
    }
    catch(e){error(e.message);}finally{pending=false;render(getState());}
  }
  async function advance(leave=false) {
    if(advancing || pending)return;
    advancing=true;
    try {
    if(!await flush())return;
    const r=getState().record,item=r.manifest.scenarios.find(item=>item.id===itemId);
    if(!leave && !isComplete(itemStatus(r,item)) && !['blocked','needs-fixes'].includes(itemStatus(r,item))) { $('unfinished-choice').hidden=false;$('unfinished-choice').scrollIntoView({block:'center'});return; }
    $('unfinished-choice').hidden=true;
    const next=nextItem(r,itemId);await navigate(next || itemId,next?'item':'results');
    } finally { advancing=false; }
  }
  $('item-next').onclick=()=>advance();
  $('item-search').oninput=$('item-filter').onchange=()=>render(getState());
  $('leave-unfinished').onclick=()=>advance(true);
  $('keep-testing').onclick=()=>{$('unfinished-choice').hidden=true;};
  $('item-previous').onclick=()=>{const items=getState().record.manifest.scenarios,index=items.findIndex(item=>item.id===itemId);if(index>0)void navigate(items[index-1].id);};
  $('show-results').onclick=()=>navigate(itemId,'results');
  $('resume-review').onclick=()=>{const r=getState().record;void navigate(r.manifest.scenarios.find(item=>!isComplete(itemStatus(r,item)))?.id || itemId);};
  $('item-notes').oninput=$('item-reason').oninput=edited;
  $('item-outcome').onchange=()=>{if(!$('item-outcome').value)$('item-reason').value='';edited();};
  $('retry-item-save').onclick=()=>flush();
  $('prepare-handoff').onclick=async()=>{if(!await flush())return;$('handoff-text').value=fixRequest(getState().record);$('handoff-panel').hidden=false;};
  $('copy-handoff').onclick=async()=>{try{await navigator.clipboard.writeText($('handoff-text').value);$('handoff-status').textContent='Copied. Paste this into the Codex chat working on the branch.';}catch{$('handoff-text').focus();$('handoff-text').select();$('handoff-status').textContent='Select and copy the request below.';}};
  $('download-handoff').onclick=()=>{
    const blob=new Blob([$('handoff-text').value],{type:'text/markdown'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='branch-review-fixes.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  function render(state) {
    const r=state.record,enabled=state.status==='ready' && r && !state.busy && !pending;
    $('guided-queue').hidden=!r;
    if(!r)return;
    const items=r.manifest.scenarios,current=items.find(item=>item.id===r.cursor?.itemId)||items[0],index=items.indexOf(current);
    const currentKey=`${r.id}:${current.id}`;
    const moved=key!==currentKey;
    if(moved){
      key=currentKey;recordId=r.id;itemId=current.id;dirty=false;version++;
      let saved=r.items?.[itemId]||{};
      try{const local=JSON.parse(localStorage.getItem(draftKey())||'null');if(local){saved=local;dirty=true;}}catch{}
      $('item-notes').value=saved.notes||'';$('item-reason').value=saved.reason||'';$('item-outcome').value=saved.outcome||'';
      status(dirty?'Recovered unsaved notes — save to continue.':'Saved');
      $('unfinished-choice').hidden=true;$('handoff-panel').hidden=true;
    }
    const results=r.cursor?.view==='results',counts=reviewCounts(r),currentStatus=itemStatus(r,current);
    $('guided-item').hidden=results;$('guided-results').hidden=!results;
    $('item-reason-wrap').hidden=!$('item-outcome').value;
    $('item-number').textContent=`ITEM ${index+1} OF ${items.length}`;
    $('item-title').textContent=current.title;$('item-description').textContent=current.description || r.manifest.summary || 'Compare this behavior in Original and Changed.';
    $('item-instructions').textContent=current.instructions || 'Follow each check below in the live preview.';
    $('item-expected').textContent=current.expected || current.steps.join(' ');
    $('item-status').textContent=statusLabels[currentStatus];$('item-status').className=`item-status status-${currentStatus}`;
    $('queue-progress').textContent=`${counts.complete} of ${counts.total} complete`;
    $('review-summary').textContent=r.manifest.summary || r.title;
    $('review-source').textContent=r.manifest.source || 'Review scenario';
    $('results-counts').textContent=`${counts.passed} passed · ${counts['needs-fixes']} need fixes · ${counts.blocked} blocked · ${counts['not-applicable']} not applicable · ${counts['not-started']+counts['in-progress']} unfinished`;
    $('results-message').textContent=canApprove(r)?'All items are accounted for. Review any exclusions and follow the next action below.':'Resolve the items below or prepare a fix request for Codex.';
    const listKey=JSON.stringify([r.id,r.checks,r.items,r.issues,r.cursor,!!enabled,$('item-search').value,$('item-filter').value]);
    if(queueKey!==listKey){
      queueKey=listKey;
      const buttons=items.map((item,i)=>{
        if(!matchesItem(r,item,$('item-search').value,$('item-filter').value || 'all'))return null;
        const state=itemStatus(r,item),button=el('button','',`queue-item status-${state}`);button.type='button';button.disabled=!enabled;
        button.setAttribute('aria-current',String(item.id===itemId && !results));button.append(el('span',String(i+1),'queue-number'),el('span',item.title,'queue-title'),el('small',statusLabels[state],'queue-status'));button.onclick=()=>navigate(item.id);return button;
      }).filter(Boolean);
      $('item-queue').replaceChildren(...buttons);
      if(!buttons.length)$('item-queue').append(el('p','No items match this view.','small muted'));
      if(moved && !results)buttons.find(button=>button.getAttribute?.('aria-current')==='true')?.scrollIntoView({block:'nearest'});
      $('result-items').replaceChildren(...items.map((item,i)=>{const state=itemStatus(r,item),button=el('button',`${i+1}. ${item.title} — ${statusLabels[state]}`,'result-item');button.disabled=!enabled;button.onclick=()=>navigate(item.id);return button;}));
    }
    for(const id of ['item-next','item-previous','item-outcome','item-notes','item-reason','show-results','resume-review','prepare-handoff','retry-item-save'])$(id).disabled=!enabled;
    $('item-previous').disabled=!enabled || index===0;
    $('resume-review').textContent=counts.complete===counts.total?'Revisit review items':'Continue remaining checks';
    $('prepare-handoff').disabled=!enabled || canApprove(r);
    $('item-next').textContent=nextItem(r,itemId)?'Next item →':'Review results →';
  }
  return {render,flush,navigate};
}
