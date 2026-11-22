import {execFile, spawn} from 'node:child_process';
import {lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {inflateSync} from 'node:zlib';
import {agentArgs, consumeAgentEvent, executable, launchCommand} from '../../providers.mjs';
import {redact} from '../../jobs.mjs';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const providerIds = {Codex: 'codex', Muse: 'muse', 'Claude Code': 'claude'};

export function objectReply(value) {
  let answer;
  try {
    answer = JSON.parse(value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw Error('The provider did not return valid JSON.');
  }
  if (!answer || Array.isArray(answer) || typeof answer !== 'object') throw Error('The provider must return a JSON object.');
  return answer;
}

function environment() {
  const env = {...process.env, ELECTRON_RUN_AS_NODE: '1'};
  for (const name of ['CODEX_WINDOWS_REGISTERED_CORE', 'CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', 'CODEX_PERMISSION_PROFILE']) {
    delete env[name];
  }
  return env;
}

function codexArgs({cwd, write, model, effort, output, schema, images, image}) {
  return [
    'exec', '--json', '--color', 'never', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', write ? 'workspace-write' : 'read-only', '-C', cwd,
    '-c', 'approval_policy="never"', '--disable', 'hooks', '--disable', 'memories', '--disable', 'plugins', '--disable', 'apps',
    '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false',
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
    ...(model ? ['--model', model] : []), ...(effort ? ['-c', 'model_reasoning_effort=' + JSON.stringify(effort)] : []),
    '--ephemeral', '--output-last-message', output, ...(schema ? ['--output-schema', schema] : []),
    ...(image ? ['--disable', 'shell_tool', '--enable', 'image_generation'] : []),
    ...images.flatMap(filename => ['--image', filename]), '-'
  ];
}

async function stop(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 10000}).catch(() => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}

export async function runProvider(options) {
  const {stage, provider, cwd, write = false, model, effort, prompt, schema, signal, report, output,
    images = [], image = false, providerOptions = {}} = options;
  const providerId = Object.hasOwn(providerIds, provider) && providerIds[provider];
  if (!providerId || (write && providerId !== 'codex')) throw Error('Unsupported provider for ' + stage + '.');
  if (image && providerId !== 'codex') throw Error('This planner provider does not support mockup generation.');
  signal?.throwIfAborted();
  const override = providerOptions[providerId]?.executable ??
    (providerOptions.provider === providerId && providerOptions.executable || undefined);
  const file = await executable(providerId, override);
  const args = providerId === 'codex'
    ? codexArgs({cwd, write, model, effort, output, schema, images, image})
    : [
        ...agentArgs(providerId, {kind: 'plan', cwd, output, images}),
        ...(model ? ['--model', model] : []), ...(effort ? ['--reasoning-effort', effort] : []),
        ...(schema ? ['--output-schema', schema] : [])
      ];
  signal?.throwIfAborted();
  const command = launchCommand(file, args);
  const child = spawn(command.file, command.args, {cwd, windowsHide: true, detached: process.platform !== 'win32',
    env: environment(), stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '';
  let timedOut = false;
  let complete = false;
  let answer = '';
  const state = {provider: providerId};
  const closed = new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('close', code => resolve({code}));
  });
  const abort = () => void stop(child);
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, image ? 420000 : 1800000);
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.stdin.on('error', () => {});
  child.stdin.end(providerId === 'muse' ? '' : prompt);
  try {
    const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      consumeAgentEvent(state, event);
      const kind = event.type ?? event.payload_type;
      if (kind === 'turn.completed') complete = true;
      if (kind === 'error' || kind === 'turn.failed') state.agentError ||= event.message || 'The provider did not complete the turn.';
      if (kind === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text;
      if (kind === 'thread.started') await report?.('Session started');
      if (kind === 'run.model.configured' && /^[a-z0-9_.-]{1,100}$/i.test(event.payload?.model_id ?? '')) {
        await report?.('Model selected · ' + event.payload.model_id);
      }
      if (kind === 'item.completed' && ['file_change', 'command_execution', 'mcp_tool_call'].includes(event.item?.type)) {
        await report?.(event.item.type.replaceAll('_', ' ') + ' completed');
      }
    }
    const {code, error} = await closed;
    signal?.throwIfAborted();
    if (timedOut) throw Error(provider + ' timed out during ' + stage + '.');
    if (error) throw error;
    const finished = providerId === 'codex' ? complete : providerId === 'muse' ? state.agentTerminal === 'completed' : !!state.agentResult;
    if (code !== 0 || state.agentError || !finished) {
      throw Error(redact(state.agentError || stderr.trim() || provider + ' did not complete ' + stage + '.').slice(-2000));
    }
    if (providerId === 'codex' && !answer) {
      const file = await lstat(output).catch(() => null);
      if (file?.isFile() && file.size <= 2_000_000) answer = await readFile(output, 'utf8');
    } else if (providerId !== 'codex') {
      answer = state.agentResult;
    }
    if (typeof answer !== 'string' || !answer.trim()) throw Error(provider + ' returned no result for ' + stage + '.');
    return {text: answer, threadId: state.chatId};
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) await stop(child);
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function auditSchema(stage, withCriteria) {
  const fields = {
    verdict: {type: 'string', enum: ['pass', 'replan', ...(stage === 'plan_review' ? [] : ['repair'])]},
    reason: {type: 'string'}
  };
  if (withCriteria) {
    fields.criteria = {type: 'array', items: {type: 'object', properties: {
      id: {type: 'string'},
      verdict: {type: 'string', enum: ['pass', 'fail', 'not_applicable', 'unverified']},
      reason: {type: 'string'},
      evidence: {type: 'array', items: {type: 'string'}}
    }, required: ['id', 'verdict', 'reason', 'evidence'], additionalProperties: false}};
  }
  return {type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false};
}

function validPng(data) {
  if (!Buffer.isBuffer(data) || data.length > 32_000_000 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw Error('The provider did not return a supported PNG.');
  }
  const pixels = [];
  for (let i = 8; i + 12 <= data.length;) {
    const size = data.readUInt32BE(i);
    const kind = data.toString('ascii', i + 4, i + 8);
    const end = i + 12 + size;
    if (end > data.length || (i === 8 && (kind !== 'IHDR' || size !== 13))) break;
    if (kind === 'IDAT') pixels.push(data.subarray(i + 8, end - 4));
    if (kind === 'IEND' && size === 0 && end === data.length && pixels.length) {
      try { if (inflateSync(Buffer.concat(pixels), {maxOutputLength: 64_000_000}).length) return data; }
      catch {}
      break;
    }
    i = end;
  }
  throw Error('The provider returned an incomplete PNG.');
}

export async function generateMockup({provider, prompt, previous, reference, providerOptions, signal, invoke = runProvider}) {
  if (provider !== 'Codex') throw Error('This planner provider does not support mockup generation.');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'branch-review-mockup-'));
  try {
    const screenshot = path.join(cwd, 'reference.png');
    if (reference) await writeFile(screenshot, validPng(reference));
    const result = await invoke({stage: 'mockup', provider, cwd, image: true, signal, providerOptions,
      model: 'gpt-6.2-sol', effort: 'low', output: path.join(cwd, 'reply.txt'),
      images: [reference ? screenshot : null, previous].filter(Boolean),
      prompt: 'Use the image generation tool to create one PNG project mockup. Use the attached reference when provided. Return only the resulting PNG path. Do not run shell commands.\n' + prompt});
    if (!uuid.test(result.threadId ?? '')) throw Error('The provider did not return an image session.');
    const home = await realpath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const folder = path.join(home, 'generated_images', result.threadId);
    if (await realpath(folder) !== folder) throw Error('The image does not belong to this provider session.');
    const candidates = (await readdir(folder, {withFileTypes: true})).filter(entry => entry.isFile() && /\.png$/i.test(entry.name));
    const named = candidates.filter(entry => result.text.includes(entry.name));
    const matches = named.length ? named : candidates;
    if (matches.length !== 1) throw Error('The provider did not return one PNG from this image session.');
    const file = path.join(folder, matches[0].name);
    if ((await lstat(file)).size > 32_000_000) throw Error('The mockup exceeds 32 MB.');
    return validPng(await readFile(file));
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
}

