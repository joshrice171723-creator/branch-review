const {BrowserWindow,session}=require('electron');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function runBrowserQa({run,record,origin,report,isCancelled,onWindow}){
  const partition=`qa-${run.id}`,isolated=session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:details.resourceType==='mainFrame' && new URL(details.url).origin!==origin}));
  const browser=new BrowserWindow({title:'Branch Review · Browser QA',width:1200,height:850,show:false,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  onWindow(browser);browser.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  browser.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  const check=()=>{if(isCancelled()||browser.isDestroyed())throw Error('Browser QA cancelled.');};
  let currentItem,lastStatus=200,unverified=false;
  browser.webContents.on('did-navigate',(_event,_url,status)=>{lastStatus=status;});
  try{
    for(const [index,step] of run.actions.entries()){
      check();browser.setTitle(`Branch Review · ${index+1}/${run.actions.length} · ${step.action}`);
      try{
        if(step.action==='visit'){
          const route=step.path || '/__review/start?scenario='+encodeURIComponent(step.itemId);
          await Promise.race([browser.loadURL(origin+route),pause(30000).then(()=>{throw Error('Page load timed out.');})]);
        }else if(currentItem!==step.itemId){await browser.loadURL(origin+'/__review/start?scenario='+encodeURIComponent(step.itemId));}
        currentItem=step.itemId;
        if(lastStatus>=400)throw Error(`Page returned HTTP ${lastStatus}.`);
        check();
        const deadline=Date.now()+10000;let result;
        do{
          check();
          result=await browser.webContents.executeJavaScript(`(${browserAction.toString()})(${JSON.stringify(step)})`);
          if(result.ok)break;if(!result.retry)throw Error(result.message);await pause(250);
        }while(Date.now()<deadline);
        if(!result?.ok)throw Error(result?.message || 'Expected page state did not appear.');
        await pause(200);check();
        unverified ||= !!result.skipped;
        await report({index,passed:!result.skipped,...(result.skipped?{skipped:true}:{}),message:result.message,screenshot:(await browser.webContents.capturePage()).toDataURL()});
      }catch(error){
        if(!isCancelled()&&!browser.isDestroyed())await report({index,passed:false,message:error.message,screenshot:(await browser.webContents.capturePage()).toDataURL()});
        throw error;
      }
    }
    await report({finish:unverified?'needs-review':'passed'});if(!browser.isDestroyed())browser.setTitle('Branch Review · Browser QA finished');
  }catch(error){await report({finish:isCancelled()||browser.isDestroyed()?'cancelled':'failed',error:error.message});}
}
function browserAction(step){
  if(step.action==='visit'){
    const text=document.body?.innerText.trim() || '';
    if(document.readyState!=='complete' || !text || /^(?:loading(?: this)? page\b|(?:loading|please wait)[. …!]*$)/i.test(text))return {ok:false,retry:true,message:'Waiting for page content to finish loading.'};
    return {ok:true,message:'Page rendered. Behavior still requires its checklist.'};
  }
  const matches=document.querySelectorAll(step.selector);
  if(matches.length!==1)return step.optional?{ok:true,skipped:true,message:`Needs human review: expected one control; found ${matches.length}.`}:{ok:false,retry:matches.length===0,message:`Expected one matching control; found ${matches.length}.`};
  const element=matches[0];
  if(!element.getClientRects().length)return {ok:false,retry:true,message:'The control is not visible.'};
  if(step.action==='text')return {ok:element.textContent.includes(step.value),retry:true,message:`Expected text: ${step.value}`};
  if(step.action==='style'){
    if(!CSS.supports(step.property,step.value))return step.optional?{ok:true,skipped:true,message:'The CSS value needs human review.'}:{ok:false,message:'Unsupported CSS assertion.'};
    const probe=document.createElement('span');probe.style.cssText='all:initial;position:absolute;visibility:hidden';probe.style.setProperty(step.property,step.value);document.body.append(probe);
    const expected=getComputedStyle(probe).getPropertyValue(step.property).trim();probe.remove();
    const actual=getComputedStyle(element).getPropertyValue(step.property).trim();return {ok:actual===expected,retry:true,message:`${step.property}: ${actual}; expected ${expected}`};
  }
  if(element.disabled)return {ok:false,retry:true,message:'The control is disabled.'};
  element.scrollIntoView({block:'center'});
  if(step.action==='click'){element.click();return {ok:true,message:'Clicked '+step.selector};}
  if(step.action==='fill'){
    if(!['INPUT','TEXTAREA','SELECT'].includes(element.tagName)||['password','file','hidden'].includes(element.type))return {ok:false,message:'This field cannot be filled by browser QA.'};
    const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value')?.set;
    if(setter)setter.call(element,step.value);else element.value=step.value;
    element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,message:'Filled '+step.selector};
  }
  return {ok:false,message:'Unknown action.'};
}
module.exports={runBrowserQa,browserAction};
