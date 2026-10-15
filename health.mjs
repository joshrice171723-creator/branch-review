export async function previewHealth(snapshot,fetcher=fetch) {
  const checkedAt=new Date().toISOString();
  const sides=await Promise.all(['original','changed'].map(async side=>{
    const preview=snapshot[side];
    if(!preview || snapshot.status!=='ready')return[side,{ok:false,message:'Preview is not running.'}];
    try {
      const [api,web]=await Promise.all([
        fetcher(`http://127.0.0.1:${preview.api}/up`,{signal:AbortSignal.timeout(4000)}),
        fetcher(`http://127.0.0.1:${preview.web}/build.json`,{cache:'no-store',signal:AbortSignal.timeout(4000)})
      ]);
      if(!api.ok || !web.ok)throw Error('Web or API health check failed.');
      const build=await web.json();
      if(build.revision!==preview.sha || build.dirty)throw Error('Running build differs from the reviewed commit. Reopen the review.');
      return[side,{ok:true,commit:build.revision,message:'Web and API are ready at the reviewed commit.'}];
    }catch(error){return[side,{ok:false,message:error.message}];}
  }));
  return{checkedAt,sides:Object.fromEntries(sides)};
}
