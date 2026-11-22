import test from 'node:test';
import assert from 'node:assert/strict';
import {githubApi,publishWorkbenchCheck} from '../workbench-github.mjs';

const repository='fixture/project';
const commit='a'.repeat(40);
const ref='refs/heads/design/notes';
const prefix='repos/'+repository;
const prPath=prefix+'/pulls/23';
const comments=prefix+'/issues/23/comments';
const statuses=prefix+'/commits/'+commit+'/statuses';
const delivery={commit,ref,repository};
const evidence={commit,ref,base:'b'.repeat(40),checklistHash:'c'.repeat(64),evidenceHash:'d'.repeat(64),
  quality:{status:'recorded',revision:'f'.repeat(64),benchmarks:[]},
  checklist:[{status:'passed',title:'Local-only title'}],approval:{reviewer:'Local Reviewer'}};

function fixture(){
  const pr={number:23,state:'open',head:{sha:commit,ref:'design/notes',repo:{full_name:repository}},base:{repo:{full_name:repository}}};
  const user={login:'fixture-user',type:'User'};
  const writes=[],savedComments=[],savedStatuses=[];
  let interrupted=false;
  const api=async(path,{input}={})=>{
    if(input){
      writes.push({path,input});
      if(path===comments){
        const comment={id:35,user,body:input.body};
        savedComments.unshift(comment);
        return comment;
      }
      if(path!==prefix+'/statuses/'+commit) throw Error('Unexpected status write');
      const result={...input,creator:user,created_at:'2026-11-22T16:00:00Z'};
      savedStatuses.unshift(result);
      if(interrupted){interrupted=false;throw Error('Connection closed after write');}
      return result;
    }
    if(path==='user') return user;
    if(path===prefix+'/pulls?state=open&head=fixture%3Adesign%2Fnotes') return [[pr]];
    if(path===prPath) return pr;
    if(path===prPath+'/reviews') return [[{user,commit_id:commit,state:'APPROVED'}]];
    if(path===comments) return [savedComments];
    if(path===statuses) return [savedStatuses];
    throw Error('Unexpected GitHub path: '+path);
  };
  return {api,writes,pr,interrupt:()=>{interrupted=true;}};
}

test('publishes a redacted PR evidence link and confirms the human status for the exact SHA',async()=>{
  const {api,writes,interrupt}=fixture();
  const publish=()=>publishWorkbenchCheck({evidence,delivery,api,validate:async()=>{}});
  interrupt();
  await assert.rejects(publish(),/Connection closed/);
  const result=await publish();
  assert.equal(result.publisher,'fixture-user');
  assert.equal(result.reviewer,'fixture-user');
  assert.equal(result.commit,commit);
  assert.equal(result.evidenceUrl,'https://github.com/fixture/project/pull/23#issuecomment-35');
  assert.equal(writes.length,2);
  assert.match(writes[0].input.body,new RegExp(commit));
  assert.match(writes[0].input.body,new RegExp(evidence.quality.revision));
  assert.match(writes[0].input.body,new RegExp(evidence.checklistHash));
  assert.doesNotMatch(writes[0].input.body,/Local Reviewer|Local-only title/);
  assert.deepEqual(writes[1].input,{state:'success',context:'branch-review/manual',
    description:'Manual Branch Review approved',target_url:result.evidenceUrl});
});

test('checks both approval and pull request head again before publishing',async()=>{
  const {api,writes,pr}=fixture();
  const publish=validate=>publishWorkbenchCheck({evidence,delivery,api,validate});
  await assert.rejects(publish(async()=>{throw Error('Design group changed');}),/Design group changed/);
  assert.deepEqual(writes,[]);
  let validations=0;
  await assert.rejects(publish(async()=>{if(++validations===3) pr.head.sha='e'.repeat(40);}),/pull request changed/);
  assert.deepEqual(writes.map(row=>row.path),[comments]);
});

test('GitHub CLI adapter sends JSON on stdin and excludes raw errors',async()=>{
  const calls=[];
  const api=githubApi(async(...args)=>{calls.push(args);return '{"state":"success"}';},'fixture repo');
  assert.deepEqual(await api('repos/fixture/statuses/abc',{input:{state:'success'}}),{state:'success'});
  assert.deepEqual(calls,[['gh',['api','--hostname','github.com','--method','POST',
    'repos/fixture/statuses/abc','--input','-'],{cwd:'fixture repo',input:'{"state":"success"}'}]]);
  const forbidden=githubApi(async()=>{throw Error('HTTP 403 secret token');},'fixture repo');
  await assert.rejects(forbidden('user'),error=>/permission/.test(error.message) && !error.message.includes('secret'));
});
