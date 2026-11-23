import {readFile} from 'node:fs/promises';
import path from 'node:path';

const missing = error => { if (error.code === 'ENOENT') return ''; throw error; };

export async function playwrightCheck(argv, cwd) {
  const [program, action, script, ...args] = argv;
  const npm = /^npm(?:\.cmd)?$/i.test(program) && action === 'run' && Boolean(script) && !args.length;
  let command = argv.join(' ');
  if (npm) {
    const source = await readFile(path.join(cwd, 'package.json'), 'utf8').catch(missing);
    command = source ? JSON.parse(source).scripts?.[script] ?? '' : '';
    command = command.trim();
  }
  if (!/^playwright test(?:\s+--[\w-]+(?:=[\w./-]+)?)*$/.test(command) ||
      /(?:^|\s)--(?:output|config)(?:[=\s]|$)/.test(command)) return null;
  let config = '';
  for (const extension of ['js', 'ts', 'cjs', 'mjs', 'cts', 'mts']) {
    config = await readFile(path.join(cwd, 'playwright.config.' + extension), 'utf8').catch(missing);
    if (config) break;
  }
  return {npm, managedUrl: /\bprocess\.env\.BASE_URL\b/.test(config) && !/\bwebServer\s*:/.test(config)};
}

export async function verifyBrowserPreview(value, signal, fetchPage = fetch) {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('Start a local project preview before running this browser check.');
  }
  const endpoint = url.origin + '/';
  let response;
  try {
    response = await fetchPage(endpoint, {redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)});
  } catch {
    signal?.throwIfAborted();
    throw Error('The browser check could not reach its base URL ' + endpoint);
  }
  await response.body?.cancel();
  if (!response.ok) throw Error('The browser check base URL ' + endpoint + ' returned HTTP ' + response.status + '.');
  return endpoint;
}
