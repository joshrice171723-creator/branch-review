export function mountTranscript({request,seek,position}){
  const panel=document.getElementById('learn-transcript');
  const toggle=document.getElementById('transcript-open');
  const list=document.getElementById('transcript-sentences');
  const notice=document.getElementById('transcript-notice');
  let visible=true,suppressed=false,generation=0,sentences=[],active=-1;
  function visibility(){
    panel.hidden=!visible || suppressed;
    toggle.setAttribute('aria-pressed',String(!panel.hidden));
    toggle.disabled=suppressed;
  }
  toggle.onclick=()=>{visible=!visible;visibility();sync(position());};
  document.getElementById('transcript-close').onclick=()=>{visible=false;visibility();};
  function sync(seconds){
    if(panel.hidden)return;
    let next=-1;
    for(let i=sentences.length-1;i>=0;i--){
      if(sentences[i].start<=seconds && seconds<sentences[i].end){next=i;break;}
    }
    if(next===active)return;
    list.children[active]?.firstElementChild.removeAttribute('aria-current');
    active=next;
    const item=list.children[active];
    item?.firstElementChild.setAttribute('aria-current','true');
    item?.scrollIntoView({block:'nearest'});
  }
  async function load(id,section){
    const sequence=++generation;
    sentences=[];active=-1;list.replaceChildren();
    notice.textContent='Loading transcript…';
    try{
      const result=await request('transcript?'+new URLSearchParams({id,section}));
      if(sequence!==generation)return;
      sentences=result.sentences;
      notice.textContent=sentences.length
        ? result.estimated?'Timings estimated.':''
        : 'No transcript for this section.';
      const fragment=document.createDocumentFragment();
      for(const {start,text} of sentences){
        const item=document.createElement('li'),button=document.createElement('button');
        button.type='button';button.textContent=text;button.onclick=()=>seek(start);
        item.append(button);fragment.append(item);
      }
      list.append(fragment);
      sync(position());
    }catch(error){
      if(sequence===generation)notice.textContent='Could not load transcript. '+error.message;
    }
  }
  visibility();
  return {load,sync,suppress(value){suppressed=value;visibility();sync(position());}};
}
