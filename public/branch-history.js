export function branchHistory({api,getState,flush,poll,error}){
  const $=id=>document.getElementById(id),dialog=document.createElement('dialog');
  dialog.id='history-dialog';dialog.setAttribute('aria-label','Branch versions');
  const header=document.createElement('header');header.className='dialog-heading';
  const heading=document.createElement('h2');heading.textContent='Branch versions';
  const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close();header.append(heading,close);
  const context=document.createElement('p'),notice=document.createElement('p'),list=document.createElement('div');
  notice.setAttribute('role','status');list.className='branch-version-list';
  const latest=document.createElement('button');latest.textContent='Return to latest version';latest.className='secondary';
  dialog.append(header,context,latest,notice,list);document.body.append(dialog);
  let loading=false,history=null;
  async function load(){
    const state=getState();latest.hidden=!state.previewVersion;
    if(!state.record){context.textContent='Open a branch to see its versions.';list.replaceChildren();return;}
    context.textContent=state.record.identity.ref.replace('refs/heads/','');notice.textContent='Loading versions…';
    try{
      history=await api('/api/versions?id='+encodeURIComponent(state.record.id));
      list.replaceChildren(...history.versions.map(version=>{
        const row=document.createElement('article'),title=document.createElement('strong'),meta=document.createElement('p');
        title.textContent=version.subject;meta.className='small muted';meta.textContent=version.sha.slice(0,7)+(version.date?' · '+new Date(version.date).toLocaleString():'')+(version.sha===history.tip?' · Latest':'')+(version.sha===state.previewVersion?.sha?' · Previewing':'');
        const preview=document.createElement('button');preview.textContent='Preview';preview.className='secondary';preview.disabled=version.sha===history.tip || !!state.busy;
        preview.onclick=()=>act('/api/version-preview',{sha:version.sha});
        const restore=document.createElement('button');restore.textContent='Restore as new commit';restore.className='secondary';restore.disabled=version.sha===history.tip || !!state.busy;
        restore.onclick=()=>{if(confirm(`Restore all tracked files on ${history.ref.replace('refs/heads/','')} to ${version.sha.slice(0,7)}? This creates a new commit and keeps every intermediate version. Nothing is pushed.`))void act('/api/version-restore',{sha:version.sha,expected:history.tip,confirmation:`RESTORE ${version.sha} ON ${history.ref}`});};
        const actions=document.createElement('div');actions.className='tool-actions';actions.append(preview,restore);row.append(title,meta,actions);return row;
      }));
      notice.textContent=history.truncated?'Showing the latest 200 versions. Saved reviews remain below.':'Previewing leaves your branch and saved review results unchanged. Restore creates a new commit on this branch.';
    }catch(e){notice.textContent=e.message;}
  }
  async function act(endpoint,data={}){
    if(loading || getState().busy)return;loading=true;
    for(const button of list.querySelectorAll('button'))button.disabled=true;
    latest.disabled=true;notice.textContent=endpoint.includes('restore')?'Restoring and preparing the latest version…':'Preparing version…';
    try{if(!await flush())throw Error('Save your current review notes first.');await api(endpoint,{id:getState().record.id,...data});await poll();if(endpoint==='/api/version-preview')$('changed').click();if(endpoint.includes('restore'))dialog.close();else await load();}
    catch(e){notice.textContent=e.message;error(e.message);}
    finally{loading=false;latest.disabled=false;}
  }
  latest.onclick=()=>act('/api/version-latest');
  $('toolbar-history').onclick=()=>{const details=$('history').closest('details');details.open=false;dialog.append(details);dialog.showModal();void load();};
  return {render(state){latest.hidden=!state.previewVersion;$('toolbar-history').disabled=!!state.busy || !!state.jobsRunning;}};
}
