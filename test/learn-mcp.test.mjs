import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createLearnMcp } = await import('../learn-mcp.mjs');

test('stateless local MCP lists and calls the Learn tools with separate authorization', async () => {
  let enabled = true;
  let handle;
  const commands = [];
  const player = { section: 1, file: 'app.rb', line: 4, seconds: 2, playing: true, stateAgeMs: 25 };
  const server = http.createServer((req, res) => handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const key = 'isolated-mcp-test-token';
  const endpoint = new URL('/mcp', origin);
  const auth = { Authorization: 'Bearer ' + key };
  handle = createLearnMcp({
    origin, key, enabled: () => enabled,
    listTours: () => [{ id: 'one', title: 'Example' }],
    getContext: () => player,
    getTranscript: section => [{ start: 0, end: 2, text: 'Section ' + section }],
    getFlags: () => [{ section: 1, cue: 0 }],
    enqueue(command) {
      if (command.type === 'open_tour' && command.id !== 'one') throw Error('Unknown tour.');
      commands.push(command);
      if (command.type === 'pause' || command.type === 'resume') player.playing = command.type === 'resume';
      if (command.type === 'seek') player.seconds = command.seconds;
      return { queued: true };
    },
  });
  const client = new Client({ name: 'learn-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: auth } });
  const call = async (name, args) => JSON.parse((await client.callTool({ name: 'learn.' + name, arguments: args })).content[0].text);
  try {
    assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...auth, Origin: 'https://untrusted.invalid' } })).status, 403);
    assert.equal((await fetch(endpoint, { headers: auth })).status, 405);
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [
      'learn.list_tours', 'learn.get_context', 'learn.get_transcript', 'learn.pause', 'learn.resume',
      'learn.seek', 'learn.next_cue', 'learn.prev_cue', 'learn.open_tour', 'learn.get_flags',
    ]);
    assert.deepEqual(await call('list_tours'), [{ id: 'one', title: 'Example' }]);
    assert.deepEqual(await call('get_context'), player);
    assert.equal((await call('get_transcript', { section: 1 }))[0].text, 'Section 1');
    assert.deepEqual(await call('get_flags'), [{ section: 1, cue: 0 }]);
    await call('pause');
    assert.equal((await call('get_context')).playing, false);
    await call('resume');
    assert.equal((await call('get_context')).playing, true);
    await call('seek', { seconds: 11 });
    assert.equal((await call('get_context')).seconds, 11);
    await assert.rejects(call('seek', { seconds: -1 }), /Invalid seconds/);
    await call('next_cue');
    await call('prev_cue');
    assert.equal((await client.callTool({ name: 'learn.open_tour', arguments: { id: 'missing' } })).isError, true);
    await call('open_tour', { id: 'one' });
    assert.deepEqual(commands, [
      { type: 'pause' }, { type: 'resume' }, { type: 'seek', seconds: 11 },
      { type: 'next_cue' }, { type: 'prev_cue' }, { type: 'open_tour', id: 'one' },
    ]);
    enabled = false;
    assert.equal((await fetch(endpoint, { method: 'POST', headers: auth })).status, 404);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
