import test from 'node:test';
import assert from 'node:assert/strict';
import {photoMarkup} from '../public/photo-markup.js';
function fixture(){
 const calls=[];const ctx=new Proxy({measureText:text=>({width:text.length*12})},{get:(target,key)=>target[key]||((...args)=>calls.push([key,...args]))});
 const image={naturalWidth:1200,naturalHeight:600},controls={},tool={value:'draw'},text={value:'',focus(){}},undo={},clear={};
 const canvas={getContext:()=>ctx,getBoundingClientRect:()=>({left:10,top:20,width:600,height:300}),setPointerCapture(){},hasPointerCapture:()=>true,releasePointerCapture(){},toDataURL:()=> 'data:image/png;base64,bWFya3Vw'};
 const editor=photoMarkup({image,canvas,controls,tool,text,undo,clear});image.onload();
 const event=(x,y)=>({clientX:x,clientY:y,button:0,pointerId:1,preventDefault(){}});
 return {calls,image,canvas,controls,tool,text,undo,clear,editor,event};
}
test('photo marks use original image coordinates; undo and clear restore the unmarked attachment',()=>{
 const h=fixture();assert.equal(h.editor.value(),null);
 h.canvas.onpointerdown(h.event(110,70));h.canvas.onpointermove(h.event(210,120));h.canvas.onpointerup(h.event(310,170));
 assert.ok(h.calls.some(call=>call[0]==='moveTo'&&call[1]===200&&call[2]===100));
 assert.ok(h.calls.some(call=>call[0]==='lineTo'&&call[1]===600&&call[2]===300));
 assert.equal(h.editor.value(),'data:image/png;base64,bWFya3Vw');
 h.tool.value='text';h.tool.onchange();h.text.value='Change this to blue';h.canvas.onpointerdown(h.event(110,70));
 assert.ok(h.calls.some(call=>call[0]==='fillText'&&call[1]==='Change this to blue'&&call[2]===200&&call[3]===100));
 h.undo.onclick();assert.equal(h.editor.value(),'data:image/png;base64,bWFya3Vw');
 h.clear.onclick();assert.equal(h.editor.value(),null);assert.equal(h.undo.disabled,true);
});
test('keyboard places text; cancelling a stroke removes only that stroke and reset clears the next photo',()=>{
 const h=fixture();h.tool.value='text';h.text.value='Keep this';h.canvas.onkeydown({key:'Enter',preventDefault(){}});
 assert.ok(h.calls.some(call=>call[0]==='fillText'&&call[1]==='Keep this'&&call[2]===600&&call[3]===300));
 h.tool.value='draw';h.canvas.onpointerdown(h.event(20,30));h.canvas.onpointercancel();h.undo.onclick();assert.equal(h.editor.value(),null);
 h.editor.reset();assert.equal(h.canvas.hidden,true);assert.equal(h.controls.hidden,true);assert.equal(h.text.value,'');
});
