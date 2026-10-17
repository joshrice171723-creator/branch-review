import {previewDestination} from './preview-routes.js';

// Keep frames attached: moving an iframe between parents reloads its document.
export function framePool(container){
  const entries=new Set();
  const key=(preview,path)=>`${preview.sha}:${preview.proxy}:${path}`;
  function prune(){for(const entry of entries)if(!container.contains(entry.pane))entries.delete(entry);}
  function create(preview,item,path){
    const pane=document.createElement('section');pane.className='preview-pane preloading';pane.inert=true;
    const label=document.createElement('div');label.className='preview-side-label';
    const frame=document.createElement('iframe');frame.title='Preparing changed preview';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');
    frame.src=`http://127.0.0.1:${preview.proxy}/__review/start?scenario=${encodeURIComponent(item.id)}`;
    const entry={key:key(preview,path),pane,label,frame,path,origin:`http://127.0.0.1:${preview.proxy}`,ready:false,createdAt:Date.now()};
    pane.append(label,frame);container.append(pane);entries.add(entry);return entry;
  }
  function find(preview,path){return [...entries].find(entry=>entry.key===key(preview,path));}
  function preload(prepared){
    prune();
    if(!prepared?.item)return;
    const path=previewDestination(prepared.item,'changed',prepared);
    if(!find(prepared.changed,path))create(prepared.changed,prepared.item,path);
    for(const entry of entries)if(!entry.frame.id && entry.key!==key(prepared.changed,path)){entry.pane.remove();entries.delete(entry);}
  }
  function isPrepared(prepared){if(!prepared?.item)return true;const entry=find(prepared.changed,previewDestination(prepared.item,'changed',prepared));return !!entry && (entry.ready || Date.now()-entry.createdAt>=15000);}
  async function waitPrepared(prepared){
    preload(prepared);
    const deadline=Date.now()+15000;
    while(!isPrepared(prepared) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  }
  function mount(state,item,force,onLoad){
    prune();
    const pair=['original','changed'].map(side=>{
      const path=previewDestination(item,side,state);
      const existing=!force && find(state[side],path);
      return existing?.ready?existing:create(state[side],item,path);
    });
    for(const entry of entries)entry.frame.removeAttribute('id');
    pair.forEach((entry,index)=>{
      const side=index?'changed':'original';entry.frame.id=`frame-${side}`;
      entry.frame.title=`${index?'Changed':'Original'} ${state.project?.name || 'Application'} review`;
      entry.pane.setAttribute('aria-label',`${side} preview`);entry.pane.style.order=index;
      entry.pane.classList.remove('preloading');entry.pane.inert=false;
      entry.label.textContent=`${state.record?.fixComparison?(index?'After fix':'Before fix'):(index?'Changed':'Original')} · ${state[side].sha.slice(0,7)}`;
      entry.frame.onload=()=>onLoad(side);
      if(entry.ready)onLoad(side);
    });
    for(const entry of entries)if(!pair.includes(entry)){entry.pane.remove();entries.delete(entry);}
  }
  window.addEventListener('message',event=>{
    if(event.data?.type!=='review:context')return;
    for(const entry of entries)if(event.source===entry.frame.contentWindow && event.origin===entry.origin){
      entry.ready=event.data.painted===true && event.data.location===entry.path;
    }
  });
  return {preload,mount,waitPrepared,isPrepared};
}
