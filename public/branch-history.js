export function branchHistory({api,getState,flush,poll,error}){
  const $=id=>document.getElementById(id),dialog=document.createElement('dialog');
  dialog.id='history-dialog';dialog.setAttribute('aria-label','Branch versions');
  const header=document.createElement('header');header.className='dialog-heading';
  const heading=document.createElement('h2');heading.textContent='Branch versions';
  const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close();header.append(heading,close);
  const context=document.createElement('p'),intro=document.createElement('p'),viewing=document.createElement('p'),notice=document.createElement('p'),list=document.createElement('div');
  context.className='version-branch';intro.className='version-intro';viewing.className='version-viewing';
  intro.textContent='View an earlier version of this branch. Viewing does not change your files or saved review.';
  notice.setAttribute('role','status');list.className='branch-version-list';
  const latest=document.createElement('button');latest.textContent='Back to latest version';latest.className='secondary';
  dialog.append(header,context,intro,viewing,latest,notice,list,$('history').closest('details'));document.body.append(dialog);
  let loading=false,history=null;
  async function load(){
    const state=getState();latest.hidden=!state.previewVersion;list.replaceChildren();viewing.textContent='';
    if(!state.record){context.textContent='Open a branch to see its versions.';notice.textContent='';return;}
    context.textContent=state.record.identity.ref.replace('refs/heads/','');notice.textContent='Loading versions…';
    try{
      history=await api('/api/versions?id='+encodeURIComponent(state.record.id));
      const viewed=state.previewVersion?.sha || history.tip;
      const selected=history.versions.find(version=>version.sha===viewed);
      viewing.textContent=state.previewVersion?`You are viewing: ${selected?.subject || viewed.slice(0,7)}. Your branch is still on the latest version.`:'You are viewing the latest version.';
      list.replaceChildren(...history.versions.map(version=>{
        const row=document.createElement('article'),title=document.createElement('h3'),meta=document.createElement('p'),label=document.createElement('span');
        const isLatest=version.sha===history.tip,isViewed=version.sha===viewed;
        row.className=isViewed?'version-current':'';
        title.textContent=version.subject;meta.className='small muted';
        meta.textContent=version.date?new Date(version.date).toLocaleString():'';
        label.className='version-label';label.textContent=[isLatest?'Latest version':version.startingPoint?'Starting point':'Earlier version',isViewed?'Viewing now':''].filter(Boolean).join(' · ');
        const preview=document.createElement('button');preview.textContent=isViewed?'Viewing now':'View this version';preview.className='secondary';preview.disabled=isViewed || !!state.busy;
        preview.onclick=()=>act(isLatest?'/api/version-latest':'/api/version-preview',isLatest?{}:{sha:version.sha});
        const details=document.createElement('details'),summary=document.createElement('summary'),commit=document.createElement('p');
        summary.textContent='Version details';commit.className='small muted';commit.textContent='Commit '+version.sha.slice(0,7);details.append(summary,commit);
        if(!isLatest){
          const explanation=document.createElement('p'),restore=document.createElement('button');
          explanation.textContent='To keep this version, restore all tracked files on this branch. This adds a new commit, preserves the full history, and does not push anything.';
          restore.textContent='Restore this version…';restore.className='secondary';restore.disabled=!!state.busy;
          restore.onclick=()=>{if(confirm(`Restore all tracked files on ${history.ref.replace('refs/heads/','')} to “${version.subject}” (${version.sha.slice(0,7)})? This adds a new commit and preserves the full history. Nothing is pushed.`))return act('/api/version-restore',{sha:version.sha,expected:history.tip,confirmation:`RESTORE ${version.sha} ON ${history.ref}`});};
          details.append(explanation,restore);
        }
        const copy=document.createElement('div');copy.className='version-copy';copy.append(label,title,meta);
        const main=document.createElement('div');main.className='version-main';main.append(copy,preview);row.append(main,details);return row;
      }));
      notice.textContent=history.truncated?'Showing the most recent 200 changes and the starting point.':'';
    }catch(e){notice.textContent=e.message;}
  }
  async function act(endpoint,data={}){
    if(loading || getState().busy)return;loading=true;
    const buttons=[...list.querySelectorAll('button')].map(button=>[button,button.disabled]);
    for(const [button] of buttons)button.disabled=true;
    latest.disabled=true;notice.textContent=endpoint.includes('restore')?'Restoring and preparing the latest version…':'Opening version…';
    try{if(!await flush())throw Error('Save your current review notes first.');await api(endpoint,{id:getState().record.id,...data});await poll();if(!endpoint.includes('restore'))$('changed').click();dialog.close();}
    catch(e){notice.textContent=e.message;error(e.message);}
    finally{loading=false;latest.disabled=false;for(const [button,disabled] of buttons)button.disabled=disabled;}
  }
  latest.onclick=()=>act('/api/version-latest');
  $('toolbar-history').onclick=()=>{const details=$('history').closest('details');details.open=false;dialog.append(details);dialog.showModal();return load();};
  return {render(state){latest.hidden=!state.previewVersion;$('toolbar-history').disabled=!!state.busy || !!state.jobsRunning;}};
}
