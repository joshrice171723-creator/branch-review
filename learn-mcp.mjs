import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

const fields = {
  section: { type: 'integer', minimum: 0, description: 'Zero-based section index' },
  seconds: { type: 'number', minimum: 0, description: 'Position in the current section, in seconds' },
  id: { type: 'string', minLength: 1, maxLength: 200, description: 'ID from learn.list_tours' },
};
const valid = {
  section: value => Number.isSafeInteger(value) && value >= 0,
  seconds: value => Number.isFinite(value) && value >= 0,
  id: value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200,
};

function failure(res, status, message, headers = {}, code = -32000) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

export function createLearnMcp({ origin, key, enabled, listTours, getContext, getTranscript, getFlags, enqueue }) {
  const endpoint = new URL(origin);
  if (endpoint.hostname !== '127.0.0.1' || typeof key !== 'string' || !key) {
    throw new Error('Learn MCP needs a loopback origin and a bearer token.');
  }
  const secret = Buffer.from(key);
  const tools = new Map();
  function add(name, description, run, field, readOnlyHint = true) {
    const inputSchema = { type: 'object', properties: field ? { [field]: fields[field] } : {}, additionalProperties: false };
    if (field) inputSchema.required = [field];
    tools.set('learn.' + name, {
      definition: { name: 'learn.' + name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } },
      field,
      run,
    });
  }

  add('list_tours', 'List the tours in the Learn library.', listTours);
  add('get_context', 'Read the active tour, cue, code excerpt, transcript sentence and player position.', getContext);
  add('get_transcript', 'Read the transcript for a section of the active tour.', getTranscript, 'section');
  add('pause', 'Queue a pause in the Learn player.', () => enqueue({ type: 'pause' }), null, false);
  add('resume', 'Queue a resume in the Learn player.', () => enqueue({ type: 'resume' }), null, false);
  add('seek', 'Queue a seek within the current section.', seconds => enqueue({ type: 'seek', seconds }), 'seconds', false);
  add('next_cue', 'Queue a jump to the next cue.', () => enqueue({ type: 'next_cue' }), null, false);
  add('prev_cue', 'Queue a jump to the previous cue.', () => enqueue({ type: 'prev_cue' }), null, false);
  add('open_tour', 'Queue opening a tour from the Learn library.', id => enqueue({ type: 'open_tour', id }), 'id', false);
  add('get_flags', 'Read the open study flags for the active tour.', getFlags);

  return async (req, res) => {
    if (!enabled()) return failure(res, 404, 'Learn MCP is off.');
    if (req.socket.localAddress !== '127.0.0.1' || req.socket.remoteAddress !== '127.0.0.1' ||
        req.headers.host !== endpoint.host ||
        (req.headers.origin !== undefined && req.headers.origin !== endpoint.origin)) {
      return failure(res, 403, 'Invalid Learn MCP host or origin.');
    }
    const supplied = Buffer.from(/^Bearer (\S+)$/i.exec(req.headers.authorization || '')?.[1] || '');
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      return failure(res, 401, 'Learn MCP bearer token required.', { 'WWW-Authenticate': 'Bearer' });
    }
    if (req.method !== 'POST') return failure(res, 405, 'Only POST is supported.', { Allow: 'POST' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      return failure(res, 415, 'Use application/json.');
    }
    let parsed;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 32768) {
          req.resume();
          return failure(res, 413, 'Learn MCP request is too large.', { Connection: 'close' });
        }
        chunks.push(chunk);
      }
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return failure(res, 400, 'Invalid JSON request.', {}, -32700);
    }

    const server = new Server({ name: 'branch-review-learn', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools.values()].map(tool => tool.definition) }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools.get(params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown Learn tool.');
      const args = params.arguments ?? {};
      const keys = Object.keys(args);
      if (tool.field ? keys.length !== 1 || !valid[tool.field](args[tool.field]) : keys.length !== 0) {
        throw new McpError(ErrorCode.InvalidParams, tool.field ? 'Invalid ' + tool.field + '.' : 'This tool takes no arguments.');
      }
      try {
        const result = await tool.run(args[tool.field]);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message || 'Learn could not complete this request.' }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) failure(res, 500, 'Learn MCP could not handle this request.', {}, -32603);
      else if (!res.writableEnded) res.end();
    }
  };
}
