// Restrict automatic assertions to simple, unconditional CSS declarations.
export function changedStyles(before,after){
  const rules=text=>{
    const clean=text.replace(/\/\*[\s\S]*?\*\//g,'');
    const found=new Map();
    for(const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      const prefix=clean.slice(0,match.index);
      if([...prefix].reduce((depth,c)=>depth+(c==='{'?1:c==='}'?-1:0),0)!==0)continue;
      const selector=match[1].trim();
      if(!selector || /[@&]|::|:(?!has\(|is\(|where\(|not\()/.test(selector))continue;
      for(const declaration of match[2].split(';')){
        const pair=declaration.match(/^\s*(color|background-color|border-color|border-radius|outline-color)\s*:\s*([^{};]+)\s*$/i);
        if(!pair || /url\(|var\(|!|expression/i.test(pair[2]))continue;
        const property=pair[1].toLowerCase(),value=pair[2].trim(),key=selector+'\n'+property;
        found.set(key,found.has(key)?null:{selector,property,value});
      }
    }
    return found;
  };
  const old=rules(before);
  return [...rules(after)].flatMap(([key,value])=>value && old.get(key) && old.get(key).value!==value.value?[value]:[]);
}

export async function automaticBrowserChecks(git,record){
  const actions=[];let assertionsLeft=Math.max(0,100-record.manifest.scenarios.length);
  const files=(await git('diff','--name-only','-z',record.identity.base,record.identity.changed,'--')).split('\0').filter(file=>file.endsWith('.css'));
  const styles=new Map(await Promise.all(files.slice(0,30).map(async file=>{
    const texts=await Promise.all([record.identity.base,record.identity.changed].map(sha=>git('show',`${sha}:${file}`).catch(()=>'')));
    return [file,changedStyles(...texts)];
  })));
  for(const item of record.manifest.scenarios){
    actions.push({itemId:item.id,action:'visit',path:item.path===':intake'?null:item.path});
    // Apply inferred selectors only to the requested screen; other screens retain page checks.
    if(item.id!==record.cursor?.itemId)continue;
    for(const file of item.files || [])for(const style of styles.get(file) || []){
      if(assertionsLeft<=0)break;
      actions.push({itemId:item.id,action:'style',...style,optional:true});
      assertionsLeft--;
    }
  }
  return actions.slice(0,100);
}
