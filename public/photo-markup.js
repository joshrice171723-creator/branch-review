export function photoMarkup({image,canvas,controls,tool,text,undo,clear}){
  let marks=[],stroke=null,ready=false;
  const context=()=>canvas.getContext('2d');
  function draw(){
    if(!ready)return;
    const ctx=context(),width=Math.max(3,canvas.width/250),font=Math.max(20,canvas.width/38);
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
    ctx.strokeStyle='#e53445';ctx.fillStyle='#e53445';ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';
    for(const mark of marks){
      if(mark.text){
        ctx.font=`bold ${font}px system-ui`;ctx.textBaseline='top';
        ctx.strokeStyle='#fff';ctx.lineWidth=width*1.5;ctx.strokeText(mark.text,mark.x,mark.y,canvas.width-mark.x);
        ctx.fillText(mark.text,mark.x,mark.y,canvas.width-mark.x);ctx.strokeStyle='#e53445';ctx.lineWidth=width;
      }else if(mark.points.length===1){
        ctx.beginPath();ctx.arc(mark.points[0].x,mark.points[0].y,width/2,0,Math.PI*2);ctx.fill();
      }else{
        ctx.beginPath();ctx.moveTo(mark.points[0].x,mark.points[0].y);
        for(const point of mark.points.slice(1))ctx.lineTo(point.x,point.y);
        ctx.stroke();
      }
    }
    undo.disabled=clear.disabled=!marks.length;
  }
  function reset(){text.value='';text.hidden=true;tool.value='draw';marks=[];stroke=null;ready=false;canvas.hidden=controls.hidden=true;undo.disabled=clear.disabled=true;}
  image.onload=()=>{reset();canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;ready=true;image.hidden=true;canvas.hidden=controls.hidden=false;draw();};
  const point=event=>{
    const bounds=canvas.getBoundingClientRect();
    return {x:Math.max(0,Math.min(canvas.width,(event.clientX-bounds.left)*canvas.width/bounds.width)),y:Math.max(0,Math.min(canvas.height,(event.clientY-bounds.top)*canvas.height/bounds.height))};
  };
  function label(at){
    if(!ready || !text.value.trim())return;
    const ctx=context();ctx.font=`bold ${Math.max(20,canvas.width/38)}px system-ui`;
    marks.push({text:text.value.trim(),x:Math.max(0,Math.min(at.x,canvas.width-ctx.measureText(text.value.trim()).width)),y:Math.min(at.y,canvas.height-Math.max(20,canvas.width/38))});draw();
  }
  canvas.onpointerdown=event=>{
    if(!ready || event.button!==0)return;event.preventDefault();
    if(tool.value==='text'){if(!text.value.trim()){text.focus();return;}label(point(event));return;}
    stroke={points:[point(event)]};marks.push(stroke);canvas.setPointerCapture(event.pointerId);draw();
  };
  canvas.onpointermove=event=>{if(!stroke)return;stroke.points.push(point(event));draw();};
  canvas.onpointerup=event=>{if(!stroke)return;stroke.points.push(point(event));stroke=null;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);draw();};
  canvas.onpointercancel=()=>{if(stroke){marks.pop();stroke=null;draw();}};
  canvas.onlostpointercapture=()=>{stroke=null;};
  canvas.onkeydown=event=>{if(event.key==='Enter' && tool.value==='text'){event.preventDefault();label({x:canvas.width/2,y:canvas.height/2});}};
  tool.onchange=()=>{text.hidden=tool.value!=='text';if(!text.hidden)text.focus();};
  undo.onclick=()=>{marks.pop();stroke=null;draw();};clear.onclick=()=>{marks=[];stroke=null;draw();};
  reset();
  return {reset,value:()=>ready && marks.length?canvas.toDataURL('image/png'):null};
}
