// Injected only into app-owned local previews. Requests must come from the review parent.
export function reviewToolsBridge(appOrigin){
  const send=data=>parent.postMessage(data,appOrigin);
  const clean=value=>String(value).replace(/(authorization|cookie)(\s*[=:]\s*)[^\r\n]+/gi,'$1$2[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(password|token|api[_-]?key|secret)(\s*[=:]\s*)[^\s,;]+/gi,'$1$2[redacted]').replace(/\bsk-[\w-]+/g,'[redacted]');
  const route=()=>location.pathname+location.search+location.hash;
  const errors=[],requests=[];let recording=false,run=0,axeLoading;
  const visible=element=>element.getBoundingClientRect().width>0 && element.getBoundingClientRect().height>0;
  function context(){const row=[...document.querySelectorAll('tbody tr')].find(row=>{const r=row.getBoundingClientRect();return r.top>=0&&r.top<innerHeight&&r.height>0;});send({type:'review:context',location:route(),heading:document.querySelector('h1,h2,[role="heading"]')?.textContent.trim().slice(0,160)||'',anchor:row?.cells[0]?.textContent.trim().slice(0,160)||'',errors:[...errors,...requests].slice(-10)});}
  function fail(value){errors.push(clean(value).slice(0,500));if(errors.length>10)errors.shift();context();}
  addEventListener('error',event=>fail(event.message));addEventListener('unhandledrejection',event=>fail(event.reason));
  function requestError(url,status){let pathname;try{pathname=new URL(url,location.href).pathname;}catch{pathname='request';}requests.push(`${status}: ${pathname}`);if(requests.length>10)requests.shift();context();}
  const nativeFetch=window.fetch;
  window.fetch=async function(...args){try{const response=await nativeFetch.apply(this,args);if(!response.ok)requestError(response.url,response.status);return response;}catch(error){requestError(typeof args[0]==='string'?args[0]:args[0]?.url,'network failure');throw error;}};
  const open=XMLHttpRequest.prototype.open,sendRequest=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url,...args){this.reviewURL=url;return open.call(this,method,url,...args);};
  XMLHttpRequest.prototype.send=function(...args){this.addEventListener('loadend',()=>{if(this.status===0||this.status>=400)requestError(this.reviewURL,this.status||'network failure');},{once:true});return sendRequest.apply(this,args);};
  function locator(element){
    if(element.id)return'#'+CSS.escape(element.id);
    for(const attr of ['data-testid','name','aria-label']){const value=element.getAttribute(attr);if(value){const selector=`${element.localName}[${attr}="${CSS.escape(value)}"]`;if(document.querySelectorAll(selector).length===1)return selector;}}
    return null;
  }
  function record(event){
    if(!recording||!event.isTrusted)return;const element=event.target.closest('button,a,input,select,textarea,[role="button"]');if(!element)return;
    if(['password','file','hidden'].includes(element.type)||element.autocomplete?.includes('cc-'))return;
    const selector=locator(element),label=(element.getAttribute('aria-label') || element.textContent || element.labels?.[0]?.textContent || '').trim().slice(0,160);
    if(!selector){send({type:'review:action-warning',message:'An interaction has no unique stable selector. Add an id, name or data-testid before replaying it.'});return;}
    if(event.type==='click' && ['INPUT','SELECT','TEXTAREA'].includes(element.tagName) && !['checkbox','radio','submit','button'].includes(element.type))return;
    if(event.type==='change' && ['checkbox','radio'].includes(element.type))return;
    send({type:'review:action',action:{type:event.type==='change'?'input':'click',selector,tag:element.tagName,inputType:element.type || '',label,route:route(),value:event.type==='change'?String(element.value).slice(0,2000):undefined}});
  }
  addEventListener('click',record,true);addEventListener('change',record,true);
  async function axe(){if(window.axe)return window.axe;if(!axeLoading)axeLoading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/__review/axe.js';script.onload=()=>resolve(window.axe);script.onerror=()=>{axeLoading=null;reject(Error('Accessibility engine did not load.'));};document.head.append(script);});return axeLoading;}
  addEventListener('message',async event=>{
    if(event.source!==parent||event.origin!==appOrigin||event.data?.type!=='review:tool')return;
    const {id,command,data}=event.data;const reply=(result,error)=>send({type:'review:tool-result',id,result,error});
    try{
      if(command==='record'){recording=!!data;reply({recording});return;}
      if(command==='stop-replay'){run++;reply({stopped:true});return;}
      if(command==='replay'){
        if(!Array.isArray(data)||data.length>30)throw Error('Replay supports up to 30 actions.');
        const generation=++run,results=[];recording=false;
        for(const [index,action] of data.entries()){
          if(generation!==run)throw Error('Replay stopped.');
          if(action.route!==route())throw Error(`Stopped at action ${index+1}: this screen differs from the recorded route.`);
          const matches=document.querySelectorAll(action.selector);if(matches.length!==1)throw Error(`Stopped at action ${index+1}: control is missing or ambiguous.`);
          const element=matches[0],label=(element.getAttribute('aria-label') || element.textContent || element.labels?.[0]?.textContent || '').trim().slice(0,160);
          if(!visible(element)||element.disabled||element.tagName!==action.tag||element.type!==action.inputType && (element.type||action.inputType)||label!==action.label)throw Error(`Stopped at action ${index+1}: control changed.`);
          if(['password','file','hidden'].includes(element.type))throw Error('Sensitive controls cannot be replayed.');
          const started=performance.now();element.scrollIntoView({block:'center'});
          if(action.type==='click')element.click();else if(action.type==='input'){
            const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto,'value').set.call(element,action.value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));
          }else throw Error('Unsupported action.');
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));results.push({index:index+1,renderMs:Math.round(performance.now()-started)});await new Promise(resolve=>setTimeout(resolve,300));
        }
        reply({completed:results.length,results});return;
      }
      if(command==='accessibility'){
        const engine=await axe(),result=await engine.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});
        reply({url:location.pathname,viewport:{width:innerWidth,height:innerHeight},violations:result.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,helpUrl:v.helpUrl,nodes:v.nodes.slice(0,15).map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:result.incomplete.map(v=>({id:v.id,help:v.help})),passes:result.passes.length,manual:'Keyboard navigation, focus order and traps require a manual walkthrough.'});return;
      }
      if(command==='performance'){
        const navigation=performance.getEntriesByType('navigation')[0];reply({route:route(),viewport:{width:innerWidth,height:innerHeight},loadMs:navigation?.loadEventEnd || null,domReadyMs:navigation?.domContentLoadedEventEnd || null,resources:performance.getEntriesByType('resource').length,measuredAt:new Date().toISOString()});return;
      }
      if(command==='context'){context();reply({route:route()});return;}
      throw Error('Unknown preview tool.');
    }catch(error){reply(null,clean(error.message));}
  });
  setInterval(context,1500);context();
}
