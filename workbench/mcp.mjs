
const protocolVersions = ['2025-11-25','2025-06-18','2025-03-26'];
const string = {type:'string'};
const boolean = {type:'boolean'};
const object = {type:'object'};
const profile = {type:'string',enum:['audited','fast']};
const revision = {type:['string','null']};
const args = {definition:object, base_revision:revision, expected_revision:revision};

function tool(name,description,properties={},required=[],write=false) {
  return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},write};
}

const localProjectSearch = {
  ...tool('find_local_projects','Find local Git folders by project name or absolute folder path.',{query:string},['query']),
  local:true
};
const tools = [
  localProjectSearch,
  tool('get_profile','Read the applied workflow profile.'),
  tool('inspect_run','Read the stage transitions, checks, and original receipts for a run.',{runId:{...string,pattern:'^\\d{8}T\\d{12}-[a-f0-9]{8}$'}}),
  tool('project_capabilities','Discover checks, preview commands, files, and Git references.'),
  tool('inspect_environment','Inspect the selected project environment.'),
  tool('prepare_environment','Prepare the selected project environment.',{},[],true),
  tool('start_project_preview','Start the detected web preview for the selected project.',{id:string},[],true),
  tool('preview_cleanup','List managed files that can be cleaned.',{},[],true),
  tool('clean_environment','Clean the managed files in the confirmed preview.',{previewId:string},['previewId'],true),
  tool('set_repair_budget','Set the repair limit in a workflow profile.',{profile,value:{type:'integer',minimum:1,maximum:20}},['profile','value'],true),
  tool('set_builder_effort','Set the builder reasoning effort.',{profile,value:{...string,enum:['low','medium','high','xhigh']}},['profile','value'],true),
  tool('quality_status','Read the Quality policy, draft, and trials.'),
  tool('quality_validate','Validate the Quality definition.',{definition:object},['definition']),
  tool('quality_draft','Save a Quality proposal for human review.',args,['definition'],true),
  tool('quality_trial','Run the committed policy against one or two Git refs.',{revision,refs:{type:'array',items:string,minItems:1,maxItems:2}},['revision','refs'],true),
  tool('quality_routes','Find HTTP routes and Electron IPC channels.',{runtime:boolean,app:string}),
  tool('quality_prepare_route','Prepare a rule and review criteria for a route.',{route_id:string,method:string,path:string,source_path:string,base_revision:revision,expected_revision:revision},[],true),
  tool('quality_evidence','Read evidence from a recorded trial.',{id:string},['id']),
  tool('app_list_factory_models','Read the local provider model catalog.',{provider:{...string,enum:['Codex','Muse']}})
];

function checkValue(value,rule) {
  if (Array.isArray(rule.type)) return rule.type.some(type=>checkValue(value,{...rule,type}));
  switch (rule.type) {
    case 'string': return typeof value==='string' && (!rule.enum || rule.enum.includes(value)) && (!rule.pattern || new RegExp(rule.pattern).test(value));
    case 'boolean': return typeof value==='boolean';
    case 'integer': return Number.isSafeInteger(value) && value>=rule.minimum && value<=rule.maximum;
    case 'object': return Boolean(value) && typeof value==='object' && !Array.isArray(value);
    case 'null': return value===null;
    case 'array': return Array.isArray(value) && value.length>=rule.minItems && value.length<=rule.maxItems && value.every(item=>checkValue(item,rule.items));
    default: return false;
  }
}

export function toolDescriptions() {
  return tools.filter(item=>!item.local).map(({name,description,write})=>({name,description,app:name.startsWith('app_'),stageAllowed:!write,
    access:write?'Project writes':name==='quality_routes'?'Reads or runs project code':'Read only'}));
}

export async function workspaceMcp(message,{call,getProfile,verified,stageTools,coordinatorChat=false}) {
  const {id,method,params={}} = message || {};
  const error = (code,text) => ({jsonrpc:'2.0',id:id ?? null,error:{code,message:text}});
  if (message?.jsonrpc!=='2.0' || typeof method!=='string' || (id!==undefined && typeof id!=='string' && !Number.isInteger(id)))
    return error(-32600,'Invalid request.');
  if (id===undefined) return null;
  if (!params || typeof params!=='object' || Array.isArray(params)) return error(-32602,'Invalid parameters.');
  const reply = result => ({jsonrpc:'2.0',id,result});

  if (method==='initialize') {
    if (typeof params.protocolVersion!=='string' || !params.clientInfo || !params.capabilities)
      return error(-32602,'Missing client initialization fields.');
    return reply({protocolVersion:protocolVersions.includes(params.protocolVersion)?params.protocolVersion:protocolVersions[0],
      capabilities:{tools:{}},serverInfo:{name:'branch-review',version:'1.0.0'}});
  }
  if (method==='ping') return reply({});
  const allowed = (await getProfile())?.permittedTools || [];
  const visible = tools.filter(item=>(!item.name.startsWith('app_') || allowed.includes(item.name)) &&
    (!item.local || verified && !stageTools) &&
    (!stageTools || stageTools.includes(item.name) && (!item.write || coordinatorChat && verified)));
  if (method==='tools/list') return reply({tools:visible.map(({write,local,...definition})=>definition)});
  if (method!=='tools/call') return error(-32601,'Unknown method.');
  const definition = visible.find(item=>item.name===params.name);
  if (!definition) return error(-32602,'Unknown tool.');
  const values = params.arguments ?? {};
  const {properties,required} = definition.inputSchema;
  if (!checkValue(values,object) || required.some(key=>!Object.hasOwn(values,key)) ||
      Object.entries(values).some(([key,value])=>!Object.hasOwn(properties,key)||!checkValue(value,properties[key])))
    return error(-32602,'Invalid tool arguments.');
  const executesProject = definition.name==='quality_routes' && values.runtime===true;
  if ((definition.write || executesProject) && !verified) return error(-32001,'Authorize this client for project writes.');
  try {
    const result = await call(definition.name,values);
    return reply({structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]});
  } catch (issue) {
    return reply({isError:true,content:[{type:'text',text:issue.message}]});
  }
}
import http from 'node:http';
import {randomUUID} from 'node:crypto';


export function selectStageTools(stage, selections, {scope = '', evidenceOnly = false} = {}) {
  if (Array.isArray(selections)) return tools.filter(item=>!item.local && !item.write && selections.includes(item.name)).map(item=>item.name);
  if (evidenceOnly) return [];
  const selected = new Set();
  if (stage === 'plan' || stage === 'plan_review') selected.add('project_capabilities');
  if (/\b(?:route|endpoint|ipc)\b/i.test(scope)) selected.add('quality_routes');
  if (/\b(?:quality|benchmark|rubric)\b/i.test(scope)) selected.add('quality_status');
  if (/\b(?:setup|runtime|environment|preview|electron)\b/i.test(scope) && stage !== 'final_review') {
    selected.add('inspect_environment');
  }
  return [...selected];
}

export function coordinatorTools(diagnosisOnly) {
  return tools.filter(item => !item.local && (!item.write || !diagnosisOnly))
    .map(item => item.name);
}

export async function openStageMcp(call, profile, names, {coordinatorChat = false, coordinatorDiagnosis = false} = {}) {
  if (!names.length) return null;
  const token = '/' + randomUUID();
  let calls = 0;
  const listener = http.createServer(async (req, res) => {
    if (req.url !== token || req.method !== 'POST') {
      res.writeHead(req.url === token ? 405 : 404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw Error('The tool request is too large.');
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks));
      const result = await workspaceMcp(request, {getProfile: () => profile, stageTools: names, verified: coordinatorChat, coordinatorChat,
        call: async (name, values) => {
          if (!coordinatorChat && !coordinatorDiagnosis && ++calls > 8) throw Error('This stage reached its tool call limit.');
          const data = await call(name, values);
          const serialized = JSON.stringify(data) ?? '';
          return serialized.length > 20000 ? {preview: serialized.slice(0, 20000), truncated: true} : data;
        }});
      if (result === null) res.writeHead(202).end();
      else res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(result));
    } catch {
      if (!res.writableEnded) res.writeHead(400).end();
    }
  });
  listener.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  return {url: 'http://127.0.0.1:' + listener.address().port + token, names,
    close() { listener.close(); listener.closeAllConnections(); }};
}
