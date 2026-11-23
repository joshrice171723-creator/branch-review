
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

const tools = [
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
  return tools.map(({name,description})=>({name,description,app:name.startsWith('app_')}));
}

export async function workspaceMcp(message,{call,getProfile,verified}) {
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
  const visible = tools.filter(item=>!item.name.startsWith('app_') || allowed.includes(item.name));
  if (method==='tools/list') return reply({tools:visible.map(({write,...definition})=>definition)});
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
