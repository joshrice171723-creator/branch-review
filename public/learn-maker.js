export function mountMaker({request,openEntry,isPlaying,pause,refreshLibrary}){
  const $=id=>document.getElementById(id);
  const dialog=$('maker-dialog'),form=$('maker-form');
  const repos=$('maker-repos'),ref=$('maker-ref'),base=$('maker-base'),diff=$('maker-diff');
  const provider=$('maker-provider'),model=$('maker-model'),reasoning=$('maker-thinking');
  let options,repoPath='',review,jobId,projectGeneration=0;
  const message=value=>{$('maker-message').textContent=value;};
  const fill=(select,values,placeholder)=>select.replaceChildren(
    ...(placeholder?[new Option(placeholder,'')]:[]),
    ...values.map(value=>new Option(value.label,value.value)));
  const toggleDiff=()=>{
    $('maker-base-field').hidden=!diff.checked;
    base.required=diff.checked;
  };
  function thinking(preferred){
    const entry=options.providers.find(item=>item.id===provider.value);
    const selected=entry?.models.find(item=>item.id===model.value);
    const choices=selected?.reasoning?.length?selected.reasoning:entry?.reasoning || [];
    fill(reasoning,choices.map(value=>({value,label:value})),'CLI default');
    reasoning.disabled=!choices.length;
    if(choices.includes(preferred))reasoning.value=preferred;
  }
  function models(preferred,effort){
    const entry=options.providers.find(item=>item.id===provider.value);
    const choices=entry?.models || [];
    fill(model,choices.map(item=>({value:item.id,label:item.label})),'CLI default');
    model.disabled=!choices.length;
    if(choices.some(item=>item.id===preferred))model.value=preferred;
    thinking(effort);
    $('maker-provider-note').textContent=entry?.note || '';
  }
  async function setRepo(value,chosenRef='',chosenBase=''){
    const generation=++projectGeneration;
    repoPath=value;
    $('maker-path').textContent=value || '';
    $('maker-submit').disabled=true;
    if(!value)return;
    try{
      const result=await request('maker/refs',{repoPath:value});
      if(generation!==projectGeneration)return;
      repoPath=result.repoPath;
      $('maker-path').textContent=repoPath;
      const refs=result.refs.map(value=>({value,label:value}));
      fill(ref,refs,'Current branch / HEAD');
      fill(base,refs,'Choose a base branch');
      if(chosenRef && !result.refs.includes(chosenRef))ref.append(new Option(chosenRef,chosenRef));
      if(chosenBase && !result.refs.includes(chosenBase))base.append(new Option(chosenBase,chosenBase));
      ref.value=chosenRef;
      base.value=chosenBase;
      $('maker-submit').disabled=Boolean(jobId);
      message('');
    }catch(error){if(generation===projectGeneration)message(error.message);}
  }
  async function show(reviewId){
    if(jobId){$('maker-progress').scrollIntoView({block:'nearest'});return;}
    message('Loading tour options…');
    dialog.showModal();
    $('maker-submit').disabled=true;
    try{
      options=await request('maker/options');
      review=reviewId?await request('maker/review?'+new URLSearchParams({id:reviewId})):null;
      const known=await window.learnDesktop?.projects().catch(()=>[]) || [];
      const defaults={...options.defaults,...review?.agent};
      if(review && !known.some(item=>item.path===review.repoPath))
        known.unshift({name:review.repoPath.split(/[/\\]/).at(-1),path:review.repoPath});
      fill(repos,known.map(item=>({value:item.path,label:item.name})),'Choose a repository');
      fill(provider,options.providers.map(item=>({value:item.id,label:item.name})));
      provider.value=defaults.provider || 'codex';
      if(!provider.value)provider.selectedIndex=0;
      models(defaults.model,defaults.reasoning);
      fill($('maker-voice'),options.voices.map(value=>({value,label:value})),'Windows default');
      if(defaults.narrationVoice)$('maker-voice').value=defaults.narrationVoice;
      $('maker-instructions').value=review?.instructions || '';
      diff.checked=Boolean(review);toggleDiff();
      $('maker-heading').textContent=review?'Teach me this branch':'Make a tour';
      repos.value=review?.repoPath || '';
      repos.disabled=diff.disabled=$('maker-browse').disabled=Boolean(review);
      $('maker-browse').hidden=!window.learnDesktop;
      await setRepo(repos.value,review?.head,review?.base);
      ref.disabled=base.disabled=Boolean(review);
      message(options.voices.length?'':'No installed Windows narration voice was found.');
    }catch(error){message(error.message);}
  }
  $('maker-open').onclick=()=>show();
  $('maker-close').onclick=()=>dialog.close();
  repos.onchange=()=>setRepo(repos.value);
  $('maker-browse').onclick=async()=>{
    try{
      const folder=await window.learnDesktop.pick('folder');
      if(!folder)return;
      if(!Array.from(repos.options).some(option=>option.value===folder))repos.append(new Option(folder,folder));
      repos.value=folder;
      await setRepo(folder);
    }catch(error){message(error.message);}
  };
  diff.onchange=toggleDiff;
  provider.onchange=()=>models();
  model.onchange=()=>thinking();
  document.querySelectorAll('[data-maker-instructions]').forEach(button=>button.onclick=()=>{
    $('maker-instructions').value=button.textContent;
    $('maker-instructions').focus();
  });
  function paint(job){
    $('maker-progress').hidden=false;
    $('maker-progress-status').textContent=[job.provider,job.model || 'CLI default',job.reasoning,job.message || job.error]
      .filter(Boolean).join(' · ');
    $('maker-cancel').hidden=job.status!=='running';
    const phases=Array.from($('maker-phases').children);
    phases.forEach(item=>{
      if(item.textContent===job.phase)item.setAttribute('aria-current','step');
      else item.removeAttribute('aria-current');
    });
  }
  $('maker-cancel').onclick=()=>request('maker/cancel',{id:jobId}).catch(error=>{
    $('maker-progress-status').textContent=error.message;
  });
  async function watch(job){
    paint(job);
    try{
      while(job.status==='running'){
        await new Promise(resolve=>setTimeout(resolve,900));
        job=await request('maker/job?'+new URLSearchParams({id:job.id}));
        paint(job);
      }
      if(job.status!=='succeeded')return;
      await refreshLibrary();
      $('maker-progress-status').textContent=job.title+' · '+job.cues+' cues · '+job.dropped+' invalid steps dropped';
      if(isPlaying()){
        pause();
        $('maker-ready').hidden=false;
        $('maker-play').onclick=()=>{
          $('maker-ready').hidden=true;
          openEntry(job.tourId,false,true).catch(error=>{$('maker-progress-status').textContent=error.message;});
        };
      }else await openEntry(job.tourId,false,true);
    }catch(error){$('maker-progress-status').textContent=error.message;}
    finally{jobId=null;}
  }
  form.onsubmit=async event=>{
    event.preventDefault();
    if(!repoPath || jobId)return;
    $('maker-submit').disabled=true;
    try{
      const job=await request('maker/start',{
        repoPath,mode:diff.checked?'diff':'repo',head:ref.value || undefined,base:base.value || undefined,
        reviewId:review?.id,instructions:$('maker-instructions').value,providerId:provider.value,
        model:model.value || undefined,reasoning:reasoning.value || undefined,
        narrationVoice:$('maker-voice').value || undefined,
      });
      jobId=job.id;
      dialog.close();
      void watch(job);
    }catch(error){message(error.message);}
    finally{$('maker-submit').disabled=Boolean(jobId);}
  };
  return {show};
}
