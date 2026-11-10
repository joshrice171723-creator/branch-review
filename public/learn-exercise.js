export function mountExercise({request,context,pause}){
  const $=id=>document.getElementById(id);
  const button=$('exercise-open'),dialog=$('exercise-dialog'),status=$('exercise-status');
  let selected,timer;
  function sync(){button.hidden=!context()?.exercise;}
  function display(result){
    if(!result)return;
    status.textContent=result.error || (result.state==='watching'?'Watching for the requested change…':result.state==='done'?'Done.':
      result.state==='undone'?'Original line restored.':result.state);
    $('exercise-start').disabled=result.state==='watching'||result.state==='done';
    $('exercise-undo').hidden=!result.undoAvailable;
    if(result.state!=='watching'){clearInterval(timer);timer=null;}
  }
  async function check(){
    const current=selected;
    if(!current || !dialog.open)return;
    try{
      const result=await request('exercise?'+new URLSearchParams({id:current.id,key:current.section+':'+current.cue}));
      if(current!==selected || !dialog.open)return;
      display(result);
      if(result?.state==='watching'&&!timer)timer=setInterval(check,700);
    }catch(error){status.textContent=error.message;clearInterval(timer);timer=null;}
  }
  button.onclick=()=>{
    selected=context();
    if(!selected?.exercise)return;
    pause();
    $('exercise-prompt').textContent=selected.exercise.prompt;
    $('exercise-file').textContent=selected.exercise.file;
    $('exercise-confirm').checked=false;
    $('exercise-start').disabled=false;
    $('exercise-undo').hidden=true;
    status.textContent='';
    dialog.showModal();
    void check();
  };
  $('exercise-form').onsubmit=async event=>{
    event.preventDefault();
    try{
      const {id,section,cue}=selected;
      display(await request('exercise/start',{id,section,cue,confirmed:$('exercise-confirm').checked}));
      if(!timer)timer=setInterval(check,700);
    }catch(error){status.textContent=error.message;}
  };
  $('exercise-undo').onclick=async()=>{
    if(!confirm('Restore the original line if the file still matches the completed exercise?'))return;
    try{display(await request('exercise/undo',{id:selected.id,confirmed:true}));}
    catch(error){status.textContent=error.message;}
  };
  $('exercise-close').onclick=()=>dialog.close();
  dialog.onclose=()=>{clearInterval(timer);timer=null;};
  return {sync};
}
