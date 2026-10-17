const $=id=>document.getElementById(id);
export function onboarding({api,settings,refresh}){
  const dialog=document.createElement('dialog');dialog.id='onboarding';dialog.setAttribute('aria-labelledby','onboarding-title');
  dialog.innerHTML=`<header class="dialog-heading"><h2 id="onboarding-title">Set up your project</h2><button id="onboarding-close">Later</button></header><p id="onboarding-project"></p><p>Connect your project and coding agent once. Then choose a branch to compare, or describe a change inside a review.</p><ol id="onboarding-checks"></ol><p id="onboarding-status" role="status"></p><div class="tool-actions"><button id="onboarding-settings">Open settings</button><button id="onboarding-retry">Check again</button><button id="onboarding-done" class="primary" disabled>Start reviewing</button></div><p class="small">Your code stays in its repository. Previews run in separate checkouts. Nothing is merged or published during setup.</p>`;
  document.body.append(dialog);
  const help=document.createElement('details'),label=document.createElement('summary'),instructions=document.createElement('p');
  label.textContent='Installing prerequisites';instructions.textContent='Install Git and the runtime your project uses (Node.js with npm for automatic web previews). Choose Codex or Claude in Settings, install its CLI, then run codex login or claude auth login in a terminal. Reopen Branch Review after installing tools. Your own provider account is required.';
  help.append(label,instructions);
  for(const [key,title] of Object.entries({git:'Get Git',node:'Get Node.js',codex:'Set up Codex',claude:'Set up Claude'})){const button=document.createElement('button');button.textContent=title;button.disabled=!globalThis.desktop?.openSetupHelp;button.onclick=()=>globalThis.desktop.openSetupHelp(key).catch(error=>{$('onboarding-status').textContent=error.message;});help.append(button);}
  dialog.append(help);
  async function check(){
    $('onboarding-done').disabled=true;$('onboarding-retry').disabled=true;$('onboarding-status').textContent='Checking your project and coding agent…';
    try{
      const rows=await api('/api/diagnostics');
      $('onboarding-checks').replaceChildren(...rows.map(row=>{const item=document.createElement('li'),title=document.createElement('strong'),text=document.createElement('span');title.textContent=`${row.ok?'✓':'!'} ${row.name}`;text.textContent=row.message;item.append(title,text);return item;}));
      const ready=rows.every(row=>row.ok);$('onboarding-done').disabled=!ready;$('onboarding-status').textContent=ready?'Ready. Choose a branch next to see its changes.':'Complete the items marked !, then check again.';
    }catch(error){$('onboarding-status').textContent=error.message;}finally{$('onboarding-retry').disabled=false;}
  }
  async function open(){const info=await api('/api/onboarding');$('onboarding-project').textContent=info.project.name+' · '+info.repository;if(!dialog.open)dialog.showModal();await check();}
  $('onboarding-close').onclick=()=>dialog.close();$('onboarding-settings').onclick=()=>{dialog.close();settings();};$('onboarding-retry').onclick=check;
  $('onboarding-done').onclick=async()=>{if($('onboarding-done').disabled)return;$('onboarding-done').disabled=true;try{await api('/api/onboarding',{});dialog.close();await refresh();}catch(error){$('onboarding-status').textContent=error.message;$('onboarding-retry').disabled=false;}};
  const button=document.createElement('button');button.textContent='Project setup guide';button.onclick=()=>{$('tools-dialog').close();void open();};$('workspace-actions').append(button);
  return {open,initialize:async()=>{try{if((await api('/api/onboarding')).needed)await open();}catch(error){$('onboarding-status').textContent=error.message;if(!dialog.open)dialog.showModal();}}};
}
