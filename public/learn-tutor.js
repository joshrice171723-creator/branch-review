export function mountTutor({request,getContext,pause,isPaused}){
  const $=id=>document.getElementById(id);
  const panel=$('learn-tutor'),form=$('tutor-form'),question=$('tutor-question');
  let pending,answer,contextKey,voiceURI='',rate=1,autoSpeak=true;
  const synthesis=window.speechSynthesis;
  const stopSpeech=()=>synthesis?.cancel();
  const setStatus=text=>{$('tutor-status').textContent=text;};
  function syncContext(){
    const context=getContext();
    $('tutor-open').disabled=!context;
    if(panel.hidden || pending)return;
    const key=context?[context.id,context.section,context.cue].join(':'):null;
    if(key===contextKey)return;
    contextKey=key;
    $('tutor-context').textContent=context
      ? [context.title,context.file+':'+context.line,context.note].join(' · ')
      : 'Choose a cue to ask about its code.';
    form.hidden=!context;
    answer=null;
    $('tutor-answer').hidden=true;
    $('tutor-speak').disabled=true;
    setStatus('');
  }
  function open(){
    if(!getContext())return;
    pause();
    panel.hidden=false;
    syncContext();
    question.focus();
  }
  function speak(){
    if(!answer?.say || !synthesis)return;
    const installed=synthesis.getVoices().filter(voice=>voice.localService);
    if(!installed.length){setStatus('No local Windows voice is available.');return;}
    stopSpeech();
    const speech=new SpeechSynthesisUtterance(answer.say);
    speech.voice=installed.find(voice=>voice.voiceURI===voiceURI) || installed[0];
    speech.rate=rate;
    synthesis.speak(speech);
  }
  async function stop(){
    if(!pending)return;
    try{await request('tutor/stop',{id:pending.id});}
    catch(error){setStatus(error.message);}
  }
  $('tutor-open').onclick=open;
  $('tutor-close').onclick=()=>{panel.hidden=true;stopSpeech();void stop();};
  $('tutor-stop').onclick=stop;
  $('tutor-speak').onclick=speak;
  $('tutor-silence').onclick=stopSpeech;
  form.onsubmit=async event=>{
    event.preventDefault();
    const context=getContext(),value=question.value.trim();
    if(pending || !context || !value)return;
    pause();stopSpeech();syncContext();
    pending=context;
    answer=null;
    $('tutor-answer').hidden=true;
    $('tutor-send').disabled=$('tutor-speak').disabled=true;
    $('tutor-stop').hidden=false;
    setStatus('Waiting for Muse…');
    try{
      const result=await request('tutor',{id:context.id,section:context.section,cue:context.cue,question:value});
      if(result.status==='no-allowance'){
        setStatus('Tutor is resting (plan allowance). '+result.message);
      }else{
        answer=result;
        $('tutor-answer').textContent=answer.display;
        $('tutor-answer').hidden=false;
        $('tutor-speak').disabled=!synthesis;
        setStatus('');
        if(autoSpeak && !panel.hidden && isPaused())speak();
      }
    }catch(error){setStatus(error.message);}
    finally{
      pending=null;
      $('tutor-send').disabled=false;
      $('tutor-stop').hidden=true;
    }
  };
  const voiceSelect=$('tutor-voice');
  function voices(){
    const installed=synthesis?.getVoices().filter(voice=>voice.localService) || [];
    voiceSelect.replaceChildren(new Option('Windows default',''),...installed.map(voice=>new Option(voice.name,voice.voiceURI)));
    voiceSelect.value=installed.some(voice=>voice.voiceURI===voiceURI)?voiceURI:'';
  }
  synthesis?.addEventListener('voiceschanged',voices);
  function save(){
    request('preferences',{tutorVoice:voiceURI,tutorRate:rate,tutorAutoSpeak:autoSpeak}).catch(error=>setStatus(error.message));
  }
  voiceSelect.onchange=()=>{voiceURI=voiceSelect.value;save();};
  $('tutor-rate').onchange=()=>{rate=Number($('tutor-rate').value);save();};
  $('tutor-auto-speak').onchange=()=>{autoSpeak=$('tutor-auto-speak').checked;save();};
  return {open,syncContext,stopSpeech,settings(data){
    voiceURI=data.tutorVoice || '';
    rate=data.tutorRate || 1;
    autoSpeak=data.tutorAutoSpeak!==false;
    $('tutor-rate').value=String(rate);
    $('tutor-auto-speak').checked=autoSpeak;
    voices();
  }};
}
