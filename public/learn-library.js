const byId=id=>document.getElementById(id);
const time=seconds=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');
function element(tag,text,className){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  if(className)node.className=className;
  return node;
}

export function libraryUI({request,open,setup}){
  const list=byId('library-cards'), notice=byId('library-notice');
  const nameDialog=byId('rename-dialog'), nameField=byId('rename-title');
  let renaming;
  const report=error=>{notice.textContent=error.message;};
  const button=(label,action,className)=>{
    const control=element('button',label,className);
    control.type='button';
    control.onclick=()=>Promise.resolve().then(action).catch(report);
    return control;
  };
  function card(entry){
    const article=element('article',undefined,'learn-card');
    const ready=entry.state==='ready';
    const state=entry.finished?'Finished':ready?'Ready':entry.state==='needs-repo'?'Choose a repo folder':'Source unavailable';
    const header=element('div',undefined,'learn-card-header');
    header.append(element('h3',entry.title),element('span',state,'learn-card-state'));
    const counts=element('p',entry.sectionCount
      ? entry.sectionCount+' sections · '+time(entry.totalDuration)+' · '+entry.percent+'% complete'
      : 'Tour details available after opening');
    const recent=element('p',entry.lastPlayedAt?'Last played '+new Date(entry.lastPlayedAt).toLocaleString():'Unplayed','learn-card-muted');
    const source=element('p',entry.source,'learn-card-source');
    const actions=element('div',undefined,'learn-card-actions');
    if(ready){
      if(entry.position && !entry.finished)actions.append(button('Continue',()=>open(entry.id,true),'primary'));
      actions.append(button('Open',()=>open(entry.id,false)));
      if(entry.position || entry.finished)actions.append(button('Start over',async()=>{
        if(!confirm('Start this tour over? Its saved playback position will be reset.'))return;
        await request('library/reset',{id:entry.id});
        await open(entry.id,false);
      }));
    }else actions.append(button('Relocate',()=>setup(entry),'primary'));
    actions.append(button('Rename',()=>{
      renaming=entry.id;
      nameField.value=entry.title;
      nameDialog.showModal();
      nameField.select();
    }),button('Remove',async()=>{
      if(!confirm('Remove this entry from Learn? The tour and repository files will stay on disk.'))return;
      await request('library/remove',{id:entry.id});
      await refresh();
    }));
    article.append(header,counts,recent,source,actions);
    return article;
  }
  async function refresh(scan=false){
    if(scan)notice.textContent='Scanning the shared tour folder…';
    const entries=await request('library',scan?{}:undefined);
    notice.textContent='';
    list.replaceChildren(...entries.map(card));
    byId('library-empty').hidden=entries.length>0;
    const last=entries.find(entry=>entry.state==='ready' && entry.position && !entry.finished);
    const continueLast=byId('continue-last');
    continueLast.hidden=!last;
    continueLast.onclick=last?()=>open(last.id,true).catch(report):null;
  }
  byId('library-refresh').onclick=()=>refresh(true).catch(report);
  byId('library-add').onclick=()=>setup();
  byId('rename-cancel').onclick=()=>nameDialog.close();
  byId('rename-form').onsubmit=async event=>{
    event.preventDefault();
    try{
      await request('library/rename',{id:renaming,title:nameField.value});
      nameDialog.close();
      await refresh();
    }catch(error){byId('rename-error').textContent=error.message;}
  };
  return {refresh,report};
}
