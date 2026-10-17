export async function previewHealth(snapshot,fetcher=fetch,webHealthy) {
  const checkedAt=new Date().toISOString();
  const sides=await Promise.all(['original','changed'].map(async side=>{
    const preview=snapshot[side];
    if(!preview || snapshot.status!=='ready')return[side,{ok:false,message:'Preview is not running.'}];
    try {
      if(preview.kind){if(!webHealthy || !await webHealthy(preview))throw Error('The owned web preview stopped. Reopen the review.');return [side,{ok:true,commit:preview.sha,message:'Owned preview is running from the reviewed checkout.'}];}

      const [api,web]=await Promise.all([
        fetcher(`http://127.0.0.1:${preview.api}/up`,{signal:AbortSignal.timeout(4000)}),
        fetcher(`http://127.0.0.1:${preview.web}/build.json`,{cache:'no-store',signal:AbortSignal.timeout(4000)})
      ]);
      if(!api.ok || !web.ok)throw Error('Web or API health check failed.');
      const build=await web.json().catch(()=>{throw Error('This revision does not provide readable build metadata. The preview can be inspected, but its running commit cannot be verified for approval.');});
      if(!build || typeof build.revision!=='string')throw Error('Build identity is missing. The preview can be inspected, but cannot be approved.');
      if(build.revision!==preview.sha || build.dirty)throw Error('Running build differs from the reviewed commit. Reopen the review.');
      return[side,{ok:true,commit:build.revision,message:'Web and API are ready at the reviewed commit.'}];
    }catch(error){return[side,{ok:false,message:error.message}];}
  }));
  return{checkedAt,sides:Object.fromEntries(sides)};
}
