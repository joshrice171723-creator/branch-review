import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { scrollBridge } from '../scroll-bridge.mjs';

function preview(rowY) {
  const handlers = {}, sent = [], frames = [];
  const root = {scrollLeft: 0, scrollTop: 0, scrollTo({left, top}) { this.scrollLeft = left; this.scrollTop = top; }};
  const pane = {id: 'grid', scrollLeft: 0, scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    parentElement: root, scrollTo: root.scrollTo};
  const table = {id: 'coverage', querySelectorAll: () => [row]};
  const row = {cells: [{textContent: 'WF-011'}], parentElement: pane, closest: () => table,
    getBoundingClientRect: () => ({top: rowY - root.scrollTop, height: 100, left: 0, right: 800})};
  const parent = {postMessage: message => sent.push(message)};
  const document = {scrollingElement: root, documentElement: root,
    querySelectorAll: selector => selector === 'body *' ? [pane] : [row],
    querySelector: selector => ({'#coverage': table, '#grid': pane})[selector]};
  const context = {document, parent, location: {pathname: '/qa', search: '?view=coverage'},
    innerHeight: 800, innerWidth: 1000, CSS: {escape: value => value},
    getComputedStyle: () => ({overflow: 'auto', overflowX: 'auto', overflowY: 'auto'}),
    addEventListener: (name, fn) => { handlers[name] = fn; }, requestAnimationFrame: fn => frames.push(fn)};
  vm.runInNewContext(`(${scrollBridge.toString()})('http://127.0.0.1:4310')`, context);
  return {root, pane, sent, frames, handlers, request(origin='http://127.0.0.1:4310'){handlers.message({origin,source:parent,data:{type:'review:request-scroll'}});}, receive(snapshot, origin = 'http://127.0.0.1:4310', source = parent) {
    handlers.message({origin, source, data: {type: 'review:scroll', snapshot}});
  }};
}

test('scroll comparison aligns the same row despite different preceding row heights, in both directions', () => {
  const original = preview(1500), changed = preview(1700);
  original.root.scrollTop = 1400;
  original.pane.scrollLeft = 120;
  original.handlers.scroll();
  changed.receive(original.sent[0].snapshot);
  assert.equal(changed.root.scrollTop, 1600);
  assert.equal(changed.pane.scrollLeft, 120);
  changed.handlers.scroll();
  assert.equal(changed.sent.length, 0, 'restoring must not echo');
  changed.frames.shift()();
  changed.root.scrollTop = 1550;
  changed.handlers.scroll();
  original.receive(changed.sent[0].snapshot);
  assert.equal(original.root.scrollTop, 1350);
});

test('scroll messages reject other origins, other windows and different routes; missing rows use pixel fallback', () => {
  const target = preview(1700);
  const snapshot = {route: '/qa?view=coverage', positions: [{selector: ':root', x: 0, y: 900}], anchor: {table: '#coverage', key: 'removed', top: 100}};
  target.receive(snapshot, 'https://outside.example');
  target.receive(snapshot, undefined, {});
  target.receive({...snapshot, route: '/clinic'});
  assert.equal(target.root.scrollTop, 0);
  target.receive(snapshot);
  assert.equal(target.root.scrollTop, 900);
});

test('re-enabling linked scrolling can request the current visible row immediately',()=>{
  const source=preview(1500);source.root.scrollTop=1400;
  source.request('https://outside.example');assert.equal(source.sent.length,0);
  source.request();assert.equal(source.sent[0].snapshot.anchor.key,'WF-011');assert.equal(source.sent[0].snapshot.anchor.top,100);
});

test('guided focus waits for a matching heading without accepting outside messages',()=>{
  const handlers={},parent={},scrolls=[];let available=false,observer,disconnected=0;
  const heading={textContent:'Guided intake · staff assisted',scrollIntoView:options=>scrolls.push(options.block)};
  const document={documentElement:{},querySelectorAll:selector=>selector==='tbody tr'?[]:available?[heading]:[]};
  vm.runInNewContext(`(${scrollBridge.toString()})('http://127.0.0.1:4310')`,{
    document,parent,addEventListener:(name,fn)=>handlers[name]=fn,clearTimeout(){},setTimeout(){},
    MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){disconnected++;}}
  });
  const event={source:parent,origin:'https://outside.example',data:{type:'review:focus',key:heading.textContent}};
  handlers.message(event);assert.equal(observer,undefined);
  handlers.message({...event,origin:'http://127.0.0.1:4310'});assert.equal(scrolls.length,0);
  available=true;observer();assert.deepEqual(scrolls,['start']);assert.equal(disconnected,1);
});
