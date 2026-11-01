const button=document.getElementById('choose'),status=document.getElementById('status'),agent=document.getElementById('agent'),agentStatus=document.getElementById('agent-status'),retry=document.getElementById('retry');
let generation=0;
async function check(){const n=++generation;button.disabled=true;retry.disabled=true;agentStatus.textContent='Checking connection…';try{const result=await window.welcome.probe(agent.value);if(n!==generation)return;agentStatus.textContent=result.message;button.disabled=result.status!=='ready';}catch(error){if(n===generation)agentStatus.textContent=error.message || 'Could not check the coding agent.';}finally{if(n===generation)retry.disabled=false;}}
agent.addEventListener('change',check);retry.addEventListener('click',check);
button.addEventListener('click',async()=>{button.disabled=true;status.textContent='';try{await window.welcome.choose(agent.value);}catch(error){status.textContent=error.message || 'Could not open that project. Try again.';}finally{button.disabled=false;}});
void check();
