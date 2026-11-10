export function mountMcp({request,snapshot,dispatch}){
  const $=id=>document.getElementById(id);
  const toggle=$('learn-mcp-enabled'),config=$('learn-mcp-config'),notice=$('learn-mcp-notice');
  const client=crypto.randomUUID();
  let enabled=false,seq=0,last=0,polling=false,timer,closed=false;
  function heartbeat(force=false){
    if(!enabled || closed)return;
    const now=performance.now();
    if(!force && now-last<1750)return;
    last=now;
    void request('state',{client,sequence:++seq,...snapshot()}).catch(()=>{});
  }
  async function poll(){
    if(!enabled || closed || polling)return;
    polling=true;
    try{
      const commands=await request('control?'+new URLSearchParams({client}));
      for(const command of commands){
        if(!enabled || closed)break;
        await dispatch(command);
      }
    }catch(error){if(enabled)notice.textContent=error.message;}
    finally{polling=false;}
  }
  function update(value){
    enabled=value;
    toggle.checked=value;
    config.hidden=!value;
    clearInterval(timer);
    if(value){
      heartbeat(true);
      timer=setInterval(poll,850);
      void poll();
    }
  }
  toggle.onchange=async()=>{
    const desired=toggle.checked;
    try{await request('preferences',{mcpEnabled:desired});notice.textContent='';update(desired);}
    catch(error){toggle.checked=enabled;notice.textContent=error.message;}
  };
  $('learn-mcp-copy').onclick=async()=>{
    try{
      await navigator.clipboard.writeText($('learn-mcp-snippet').value);
      notice.textContent='Connection JSON copied.';
    }catch{
      $('learn-mcp-snippet').select();
      notice.textContent='Copy the selected connection JSON.';
    }
  };
  return {heartbeat,settings(data){
    const url=location.origin+'/mcp';
    $('learn-mcp-url').textContent=url;
    $('learn-mcp-snippet').value=JSON.stringify({mcpServers:{learn:{
      type:'http',url,headers:{Authorization:'Bearer '+data.mcpKey},
    }}},null,2);
    update(data.mcpEnabled!==false);
  },dispose(){closed=true;clearInterval(timer);}};
}
