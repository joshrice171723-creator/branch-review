const checkContext='branch-review/manual';

export function githubApi(run,repository) {
  return async (endpoint,{input,paginate=false}={})=>{
    const args=['api','--hostname','github.com','--method',input?'POST':'GET',endpoint];
    if(paginate) args.push('--paginate','--slurp');
    if(input) args.push('--input','-');
    try {
      return JSON.parse(await run('gh',args,{cwd:repository,...(input && {input:JSON.stringify(input)})}));
    } catch(error) {
      if(error.code==='ENOENT') throw Error('Install GitHub CLI, then run gh auth login.');
      const status=/HTTP (\d{3})/.exec(error.message)?.[1];
      if(status==='401' || /gh auth login/i.test(error.message)) throw Error('Sign in to github.com with gh auth login.');
      if(status==='403' || status==='404') {
        throw Error('Check GitHub access to this repository and permission to write pull request comments and commit statuses.');
      }
      throw Error('GitHub could not confirm the request. Check the pull request, then retry.');
    }
  };
}

function exactHead(pr,{repository,ref,commit}) {
  return pr.state==='open' && pr.head?.sha===commit && pr.head.ref===ref.slice('refs/heads/'.length) &&
    pr.head.repo?.full_name?.toLowerCase()===repository && pr.base?.repo?.full_name?.toLowerCase()===repository;
}

export async function publishWorkbenchCheck({evidence,delivery,api,validate}) {
  const {commit,ref,checklistHash,quality,evidenceHash,base}=evidence;
  if(delivery?.commit!==commit || delivery.ref!==ref || !delivery.repository) {
    throw Error('Push this exact reviewed branch before publishing its PR check.');
  }
  const {repository}=delivery;
  const prefix='repos/'+repository;
  const {login:publisher,type}=await api('user');
  if(type!=='User' || !/^[a-zA-Z0-9-]{1,39}$/.test(publisher || '')) {
    throw Error('Sign in to GitHub CLI with your user account.');
  }
  const query=new URLSearchParams({state:'open',head:repository.split('/')[0]+':'+ref.slice('refs/heads/'.length)});
  const matching=(await api(prefix+'/pulls?'+query,{paginate:true})).flat().filter(pr=>exactHead(pr,delivery));
  if(matching.length!==1) throw Error('Open one pull request in this repository with the reviewed commit as its head.');
  const pr=matching[0];
  const prPath=prefix+'/pulls/'+pr.number;
  const pullRequestUrl='https://github.com/'+repository+'/pull/'+pr.number;
  const confirmCurrent=async()=>{
    await validate();
    if(!exactHead(await api(prPath),delivery)) throw Error('The pull request changed. Review its new head before publishing.');
    await validate();
  };
  const priorReviews=(await api(prPath+'/reviews',{paginate:true})).flat();
  const githubApproval=priorReviews.findLast(row=>row.user?.login===publisher &&
    ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(row.state));
  const reviewer=githubApproval?.commit_id===commit && githubApproval.state==='APPROVED' ? githubApproval.user.login : null;
  const marker='<!-- branch-review-evidence '+commit+' '+evidenceHash+' -->';
  const commentsPath=prefix+'/issues/'+pr.number+'/comments';
  const saved=(await api(commentsPath,{paginate:true})).flat().find(row=>
    row.user?.login===publisher && row.body?.startsWith(marker+'\n'));
  await confirmCurrent();
  const passed=evidence.checklist.filter(row=>row.status==='passed').length;
  const excluded=evidence.checklist.filter(row=>row.status==='not-applicable').length;
  const benchmarkCount=status=>quality.benchmarks.filter(row=>row.status===status).length;
  const qualitySummary=quality.status==='recorded' ? [
    '- Workbench Quality policy: `'+quality.revision+'`',
    '- Benchmarks: '+benchmarkCount('passed')+' passed, '+benchmarkCount('failed')+' failed, '+benchmarkCount('missing')+' missing'
  ] : ['- Workbench Quality policy: no recorded policy'];
  const comment=saved || await api(commentsPath,{input:{body:[
    marker,'### Manual Branch Review','', 'Result: Approved','',
    '- Commit: `'+commit+'`','- Base: `'+base+'`','- Checklist fingerprint: `'+checklistHash+'`',
    ...qualitySummary,
    '- Evidence fingerprint: `'+evidenceHash+'`','- Checklist results: '+passed+' passed, '+excluded+' not applicable',
    '- Published by: @'+publisher,...(reviewer?['- GitHub approval on this commit: @'+reviewer]:[])
  ].join('\n')}});
  if(!Number.isSafeInteger(comment.id) || comment.id<1) throw Error('GitHub did not confirm the evidence comment. Check the pull request and retry.');
  const evidenceUrl=pullRequestUrl+'#issuecomment-'+comment.id;
  const statusesPath=prefix+'/commits/'+commit+'/statuses';
  const description='Manual Branch Review approved';
  const statuses=(await api(statusesPath,{paginate:true})).flat();
  await confirmCurrent();
  const latest=statuses.find(row=>row.context===checkContext);
  const status=latest?.state==='success' && latest.target_url===evidenceUrl &&
    latest.creator?.login===publisher ? latest : await api(prefix+'/statuses/'+commit,{input:{
    state:'success',context:checkContext,description,target_url:evidenceUrl
  }});
  if(status.state!=='success' || status.context!==checkContext || status.target_url!==evidenceUrl ||
      status.creator?.login!==publisher) throw Error('GitHub did not confirm the PR check. Check the pull request and retry.');
  return {state:'success',context:checkContext,commit,publisher,reviewer,pullRequestUrl,evidenceUrl,
    evidenceHash,at:status.created_at};
}
