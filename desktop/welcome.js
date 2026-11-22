const button=document.getElementById('choose'),status=document.getElementById('status'),agent=document.getElementById('agent'),agentStatus=document.getElementById('agent-status'),retry=document.getElementById('retry'),form=document.getElementById('chat-form'),input=document.getElementById('chat-input'),send=document.getElementById('chat-send'),messages=document.getElementById('chat-messages'),found=document.getElementById('found-project'),openFound=document.getElementById('open-found'),help=document.getElementById('agent-help'),gitStatus=document.getElementById('git-status'),gitHelp=document.getElementById('git-help');
let generation=0,agentReady=false,gitReady=false,checking=false,busy=false,history=[],candidate=null;
function update(){button.disabled=!gitReady||busy;send.disabled=!agentReady||!gitReady||busy;openFound.disabled=!gitReady||busy;agent.disabled=busy;retry.disabled=checking||busy;help.disabled=busy;gitHelp.disabled=busy;}
function add(role,text){const p=document.createElement('p'),label=document.createElement('strong'),body=document.createElement('span');label.textContent=role==='user'?'You':'Agent';body.textContent=text;p.append(label,body);messages.append(p);}
async function check(){
  const n=++generation;
  const provider=agent.value;
  const name=provider==='muse'?'Muse':provider==='claude'?'Claude Code':'Codex';
  agentReady=false;checking=true;update();agentStatus.textContent='Checking connection…';help.textContent='Set up '+name;
  const setGit=value=>{if(n===generation){gitReady=value;gitStatus.hidden=value;gitHelp.hidden=value;update();}};
  void window.welcome.git().then(value=>setGit(value===true),()=>setGit(false));
  try{
    const result=await window.welcome.probe(provider);
    if(n!==generation)return;
    agentReady=result.status==='ready';
    agentStatus.textContent=agentReady?`${name} is connected.`:result.status==='missing'?`Install ${name} to use agent features.`:
      result.status==='sign-in'?`Sign in to ${name} to use agent features.`:result.status==='unavailable'?`Could not connect to ${name}. Check its setup and retry.`:result.message;
    help.hidden=agentReady;
  }catch(error){if(n===generation){agentStatus.textContent=error.message || 'Could not check the coding agent.';help.hidden=false;}}
  finally{if(n===generation){checking=false;update();}}
}
agent.addEventListener('change',()=>{history=[];candidate=null;found.hidden=true;messages.replaceChildren();check();});retry.addEventListener('click',check);help.addEventListener('click',()=>window.welcome.help(agent.value).catch(error=>{agentStatus.textContent=error.message;}));gitHelp.addEventListener('click',()=>window.welcome.help('git').catch(error=>{gitStatus.textContent=error.message;}));
form.addEventListener('submit',async event=>{event.preventDefault();const text=input.value.trim();if(!text||busy||!agentReady||!gitReady)return;input.value='';history.push({role:'user',text});add('user',text);busy=true;candidate=null;found.hidden=true;status.textContent='The agent is looking for your project…';update();try{const result=await window.welcome.chat(agent.value,history.slice(-16));history.push({role:'assistant',text:result.message});add('assistant',result.message);candidate=result.project;if(candidate){document.getElementById('found-name').textContent=candidate.name;document.getElementById('found-path').textContent=candidate.path;found.hidden=false;}status.textContent='';}catch(error){status.textContent=error.message || 'The agent could not finish. Try again.';}finally{busy=false;update();}});
async function choose(foundPath){busy=true;status.textContent='Getting your project ready…';update();try{await window.welcome.choose(agent.value,foundPath);status.textContent='';}catch(error){status.textContent=error.message || 'Could not open that project. Try again.';}finally{busy=false;update();}}
button.addEventListener('click',()=>choose());openFound.addEventListener('click',()=>candidate&&choose(candidate.path));
void check();
