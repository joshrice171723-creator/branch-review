import path from 'node:path';
import {detectProject} from '../../web-project.mjs';
import {boundedText, gitRead, plainPath, relativePath, stableId, trackedFiles} from './paths.mjs';

const locks = {
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun'
};
const checkKinds = ['test', 'lint', 'build', 'typecheck', 'format', 'benchmark', 'check'];
const fileKinds = ['instruction', 'fixture', 'test', 'script', 'manifest', 'lockfile', 'ci', 'config'];
const adapter = 'workbench-capabilities.json';
const localAddress = 'http://127.0.0.1:{port}';
const ciTools = new Set(['ruby', 'python', 'python3', 'pytest', 'tox', 'uv', 'bundle', 'npm', 'pnpm', 'yarn',
  'bun', 'go', 'cargo', 'mvn', 'gradle', 'dotnet', 'make', 'ruff', 'ctest']);
const evidence = (path, detail) => ({path, detail});
const join = path.posix.join;
const dirname = path.posix.dirname;
const basename = path.posix.basename;

export function fileKind(name) {
  const parts = name.split('/');
  const file = parts.at(-1);
  if (/^(agents|claude|instructions|rules|copilot-instructions|grading|rubric)\.md$/i.test(file) ||
      file === 'workbench-quality.json') return 'instruction';
  if (name.startsWith('.github/workflows/') || ['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml'].includes(name)) return 'ci';
  if (Object.hasOwn(locks, file) || /^(?:poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|go\.sum|Cargo\.lock)$/.test(file)) return 'lockfile';
  if (/^(?:package\.json|pyproject\.toml|setup\.cfg|setup\.py|Pipfile|Gemfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|Makefile|Justfile|requirements(?:[-_.][^/]*)?\.txt)$/.test(file) ||
      /\.[cf]sproj$/.test(file)) return 'manifest';
  if (file === adapter || /^(?:Dockerfile|Procfile(?:\.dev)?|(?:docker-)?compose\.ya?ml|pytest\.ini|tox\.ini|\.env\.(?:example|sample)|(?:playwright|jest|vitest)\.config\.[jt]s)$/.test(file) ||
      /(?:^|\/)config\/(?:routes|application)\.rb$/.test(name)) return 'config';
  if (parts.some(part => /^(?:fixtures?|factories|testdata|__fixtures__)$/.test(part)) || /(?:^seeds\.rb$|\.fixture\.)/.test(file)) return 'fixture';
  if (parts.some(part => /^(?:tests?|spec|__tests__)$/.test(part)) || /(?:^test_|_test\.|_spec\.|\.test\.|\.spec\.)/.test(file)) return 'test';
  if (parts.some(part => /^(?:bin|scripts)$/.test(part)) || /^(?:manage\.py|app\.py|server\.(?:mjs|js|py))$/.test(file)) return 'script';
  return null;
}

async function gitMetadata(root) {
  const read = (...args) => gitRead(root, ...args).catch(() => '');
  const format = '%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)';
  const [head, branch, inventory] = await Promise.all([
    read('rev-parse', '--verify', 'HEAD'),
    read('symbolic-ref', '--quiet', '--short', 'HEAD'),
    read('for-each-ref', '--count=250', '--format=' + format, 'refs/heads', 'refs/remotes', 'refs/tags')
  ]);
  const kinds = {heads: 'branch', remotes: 'remote', tags: 'tag'};
  const refs = inventory.split('\n').flatMap(line => {
    const [ref, type, sha, peeledType, peeledSha, symbol] = line.trimEnd().split('\0');
    if (!ref || symbol || (type !== 'commit' && peeledType !== 'commit')) return [];
    const [, namespace, ...name] = ref.split('/');
    return [{name: name.join('/'), ref, kind: kinds[namespace], sha: type === 'commit' ? sha : peeledSha}];
  });
  return {head: head.trim() || null, branch: branch.trim() || null, refs};
}

function classifyScript(name) {
  const words = name.toLowerCase().split(/[:_.\s-]/);
  if (words.some(word => ['test', 'tests', 'e2e', 'spec', 'pytest', 'rspec', 'ctest', 'tox'].includes(word))) return 'test';
  if (words.some(word => ['typecheck', 'types', 'tsc'].includes(word)) || (words.includes('type') && words.includes('check'))) return 'typecheck';
  if (words.some(word => ['bench', 'benchmark', 'benchmarks'].includes(word))) return 'benchmark';
  return ['lint', 'format', 'build', 'check'].find(kind => words.includes(kind));
}

function packageManager(file, manifest, paths) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(manifest.packageManager);
  if (declared) return [declared[1], [evidence(file, 'Declared package manager')]];
  for (let root = dirname(file); ; root = dirname(root)) {
    const found = Object.entries(locks).filter(([name]) => paths.has(join(root, name)));
    const managers = new Set(found.map(([, manager]) => manager));
    if (managers.size === 1) return [found[0][1], found.map(([name]) => evidence(join(root, name), 'Package manager lockfile'))];
    if (managers.size > 1 || root === '.') return ['npm', []];
  }
}

function scanNode(inventory, file, manifest, paths) {
  const cwd = dirname(file);
  const name = typeof manifest.name === 'string' ? manifest.name.slice(0, 120) : 'Node.js';
  const [manager, lockEvidence] = packageManager(file, manifest, paths);
  const scripts = manifest.scripts || {};
  const dependencies = {...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies};
  const frameworks = Object.keys(dependencies).filter(key => ['react', 'next', 'vite', 'express', 'fastify'].includes(key));
  const component = inventory.component(cwd, 'Node.js', name, [evidence(file, 'Node.js package manifest'), ...lockEvidence], {frameworks});
  const desktopScripts = Object.entries(scripts).filter(([, script]) =>
    dependencies.electron && /(?:^|\s)electron(?:-forge|-vite|\.cmd)?(?:\s|$)/.test(script)).map(([id]) => id);
  let desktop;
  if (desktopScripts.length) {
    const source = [evidence(file, 'Electron launch script')];
    let entry;
    try { entry = join(cwd, relativePath(manifest.main)); }
    catch {}
    if (paths.has(entry)) source.push(evidence(entry, 'Tracked Electron main entry'));
    desktop = inventory.component(cwd, 'Electron', name + ' desktop', source, paths.has(entry) ? {entry_point: entry} : {});
  }
  for (const [scriptName, script] of Object.entries(scripts)) {
    if (typeof script !== 'string' || !script.trim() || /no test specified/i.test(script) ||
        !/^[\w][\w:.-]{0,79}$/.test(scriptName)) continue;
    const isDesktop = desktopScripts.includes(scriptName);
    const isPreview = isDesktop && /^(?:desktop|dev|start|preview|serve)$/.test(scriptName) ||
      /^(?:dev|start|serve|preview)$/.test(scriptName);
    const kind = isPreview ? 'preview' : classifyScript(scriptName);
    if (!kind) continue;
    const argv = manager === 'npm' && scriptName === 'test' ? [manager, 'test'] : [manager, 'run', scriptName];
    const details = {component_id: isDesktop ? desktop : component};
    if (isPreview) {
      details.mode = isDesktop ? 'desktop' : 'web';
      const port = /(?:^|\s)(?:--port[=\s]+|PORT=)([1-9]\d{0,4})(?=\s|$)/.exec(script)?.[1];
      if (!isDesktop && Number(port) <= 65535) details.url = 'http://127.0.0.1:' + port;
      if (!isDesktop && manager === 'npm' && /^(?:vite(?: dev| serve| preview)?|next dev)$/.test(script.trim())) {
        argv.push('--', script.startsWith('next') ? '--hostname' : '--host', '127.0.0.1', '--port', '{port}');
        if (script.startsWith('vite')) argv.push('--strictPort');
        details.url = localAddress;
      }
    }
    inventory.command(kind, scriptName + ' · ' + name, argv, cwd,
      [evidence(file, 'scripts.' + scriptName), ...lockEvidence], details);
  }
}

function scanOther(inventory, paths) {
  for (const file of paths) {
    const cwd = dirname(file);
    const test = (stack, argv) => {
      const source = [evidence(file, stack + ' project manifest')];
      const component = inventory.component(cwd, stack, stack, source);
      inventory.command('test', stack + ' tests', argv, cwd, source, {component_id: component});
      return component;
    };
    switch (basename(file)) {
      case 'Cargo.toml':
        test('Rust', ['cargo', 'test']);
        break;
      case 'go.mod':
        test('Go', ['go', 'test', './...']);
        break;
      case 'pom.xml':
        test('Maven', ['mvn', 'test']);
        break;
      case 'build.gradle':
      case 'build.gradle.kts':
        test('Gradle', ['gradle', 'test']);
        break;
      case 'manage.py': {
        const source = [evidence(file, 'Tracked Django entry point')];
        const component = inventory.component(cwd, 'Django', 'Django', source);
        inventory.command('test', 'Django tests', ['python', 'manage.py', 'test'], cwd, source, {component_id: component});
        inventory.command('preview', 'Django server', ['python', 'manage.py', 'runserver', '127.0.0.1:{port}'], cwd,
          source, {component_id: component, mode: 'web', url: localAddress});
        break;
      }
      default:
        if (/\.[cf]sproj$/.test(file)) test('.NET', ['dotnet', 'test', basename(file)]);
    }
    if (file === 'config/application.rb' || file.endsWith('/config/application.rb')) {
      const app = dirname(cwd);
      const launcher = join(app, 'bin/rails');
      if (!paths.has(launcher)) continue;
      const source = [evidence(file, 'Rails application'), evidence(launcher, 'Tracked Rails entry point')];
      const component = inventory.component(app, 'Rails', 'Rails', source);
      inventory.command('test', 'Rails tests', ['ruby', 'bin/rails', 'test'], app, source, {component_id: component});
      inventory.command('preview', 'Rails server', ['ruby', 'bin/rails', 'server', '--binding', '127.0.0.1', '--port', '{port}'],
        app, source, {component_id: component, mode: 'web', url: localAddress});
    }
  }
}

function scanPython(inventory, files) {
  const markers = files.filter(file => /(?:^|\/)(?:pyproject\.toml|pytest\.ini|setup\.cfg|requirements(?:[-_.][^/]*)?\.txt)$/.test(file));
  const tests = files.filter(file => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(file));
  const groups = new Map();
  for (const file of tests) {
    const parents = markers.filter(marker => dirname(marker) === '.' || file.startsWith(dirname(marker) + '/'));
    const marker = parents.sort((first, second) => dirname(second).length - dirname(first).length)[0];
    const folder = dirname(file);
    const root = marker ? dirname(marker) : ['tests', 'test'].includes(basename(folder)) ? dirname(folder) : folder;
    if (!groups.has(root)) groups.set(root, {file, marker});
  }
  return Promise.all([...groups].map(async ([root, {file, marker}]) => {
    const source = [evidence(file, 'Tracked Python test')];
    if (marker) source.push(evidence(marker, 'Python project configuration'));
    const pytest = marker && (marker.endsWith('pytest.ini') || /(?:\[tool\.pytest|\bpytest\b)/.test(await inventory.text(marker)));
    const directory = path.posix.relative(root, dirname(file)) || '.';
    const argv = pytest ? ['python', '-m', 'pytest'] : ['python', '-m', 'unittest', 'discover', '-s', directory];
    const component = inventory.component(root, 'Python', 'Python', source);
    inventory.command('test', pytest ? 'pytest' : 'Python unit tests', argv, root, source, {component_id: component});
  }));
}

async function scanContinuousIntegration(inventory, paths, file) {
  const text = await inventory.text(file);
  if (/^\s*defaults\s*:/m.test(text)) return;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const command = /^\s*(?:-\s+)?run:\s+(.+)$/.exec(line)?.[1];
    if (!command || /[|;&<>`$\\]/.test(command)) continue;
    const words = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) || [];
    if (words.join(' ').replace(/\s+/g, ' ') !== command.trim().replace(/\s+/g, ' ')) continue;
    const argv = words.map(word => word.replace(/^(['"])(.*)\1$/, '$2'));
    if (!ciTools.has(argv[0])) continue;
    const kind = classifyScript(argv.slice(1).join(' ')) || classifyScript(argv[0]);
    if (!kind) continue;
    let start = index;
    while (start > 0 && !/^\s*-\s+/.test(lines[start]) && lines[start - 1].trim()) start--;
    let end = index + 1;
    while (end < lines.length && !/^\s*-\s+/.test(lines[end]) && lines[end].trim()) end++;
    const working = lines.slice(start, end).map(entry => /^\s*working-directory:\s+(.+)$/.exec(entry)?.[1]).filter(Boolean).at(-1);
    let cwd;
    try { cwd = relativePath(working?.trim().replace(/^['"]|['"]$/g, '') || '.', {directory: true}); }
    catch { continue; }
    if (cwd !== '.' && ![...paths].some(name => name.startsWith(cwd + '/'))) continue;
    const prior = inventory.checks.get(stableId([cwd, argv, null]));
    inventory.command(prior?.kind || kind, prior?.label || 'CI ' + argv.join(' ').slice(0, 90), argv, cwd,
      [{path: file, detail: 'Literal GitHub Actions run step', line: index + 1}],
      {component_id: prior?.component_id || inventory.owner(join(cwd, '_'))});
  }
}

export function literalArguments(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 100 || !argv[0]?.trim?.() ||
      argv.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) {
    throw Error('Enter an executable followed by its literal arguments.');
  }
  return argv;
}

async function applyAdapter(root, inventory, paths, config, files) {
  if (!paths.has(adapter)) return;
  if (config?.schema_version !== 1) {
    inventory.gaps.add(adapter + ' must use schema_version 1.');
    return;
  }
  for (const section of ['components', 'checks', 'previews', 'files']) {
    const rows = config[section] || [];
    if (!Array.isArray(rows) || rows.length > 100) {
      inventory.gaps.add(adapter + ' ' + section + ' must contain up to 100 entries.');
      continue;
    }
    for (const [index, item] of rows.entries()) {
      try {
        const id = item.id;
        if (id !== undefined && (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))) throw Error('Enter a stable capability ID.');
        const label = item.label || item.path;
        if (typeof label !== 'string' || !label.trim() || label.length > 150) throw Error('Enter the capability label.');
        if (section === 'files') {
          const file = relativePath(item.path);
          if (!paths.has(file)) throw Error('Choose a tracked project file.');
          const kind = item.kind || 'config';
          if (!fileKinds.includes(kind)) throw Error('Choose a file type.');
          files.set(file, {id: id || 'file-' + stableId(file), path: file, kind, label, component_id: inventory.owner(file)});
          continue;
        }
        const cwd = relativePath(section === 'components' ? item.root ?? '.' : item.cwd ?? '.', {directory: true});
        await plainPath(root, cwd, {directory: true});
        if (cwd !== '.' && ![...paths].some(file => file.startsWith(cwd + '/'))) throw Error('Choose a directory with tracked files.');
        const source = [evidence(adapter, 'Explicit ' + section + ' entry')];
        if (section === 'components') {
          if (typeof item.stack !== 'string' || !item.stack.trim()) throw Error('Enter the component stack.');
          inventory.component(cwd, item.stack, label, source, id ? {id} : {});
          continue;
        }
        const kind = section === 'previews' ? 'preview' : item.kind || 'check';
        if (kind !== 'preview' && !checkKinds.includes(kind)) throw Error('Choose a check type.');
        const component_id = item.component_id || inventory.owner(join(cwd, '_'));
        if (component_id && !inventory.components.has(component_id)) throw Error('Choose a known component.');
        const details = {component_id, ...(id && {id})};
        if (kind === 'preview') {
          details.mode = item.mode || (item.url ? 'web' : 'desktop');
          if (!['web', 'desktop', 'external'].includes(details.mode)) throw Error('Choose a preview mode.');
          if (item.url) {
            const address = new URL(item.url.replaceAll('{port}', '4000'));
            if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw Error('Enter an HTTP or HTTPS preview address.');
            details.url = item.url;
          }
        }
        inventory.command(kind, label, kind === 'preview' && details.mode === 'external' ? [] : literalArguments(item.argv), cwd, source, details);
      } catch (error) {
        inventory.gaps.add(adapter + ' ' + section + ' entry ' + (index + 1) + ' · ' + error.message);
      }
    }
  }
}

function inventoryFor(root) {
  const components = new Map(), checks = new Map(), previews = new Map(), gaps = new Set(), cache = new Map();
  let remaining = 12 * 1024 * 1024;
  return {
    components, checks, previews, gaps,
    async text(name) {
      if (!cache.has(name)) cache.set(name, (async () => {
        if (remaining < 384 * 1024) return '';
        remaining -= 384 * 1024;
        const text = await boundedText(root, name, 384 * 1024).catch(() => '');
        remaining += 384 * 1024 - Buffer.byteLength(text);
        return text;
      })());
      return cache.get(name);
    },
    component(cwd, stack, label, source, details = {}) {
      const id = details.id || 'component-' + stableId([cwd, stack]);
      const prior = components.get(id);
      if (prior && (prior.root !== cwd || prior.stack !== stack)) throw Error('A component ID already identifies another component.');
      components.set(id, {id, root: cwd, stack, label, source: [...source, ...(prior?.source || [])], ...details});
      return id;
    },
    owner(file) {
      return [...components.values()]
        .filter(row => row.root === '.' || file.startsWith(row.root + '/'))
        .sort((first, second) => second.root.length - first.root.length)[0]?.id || null;
    },
    command(kind, label, argv, cwd, source, details = {}) {
      const catalog = kind === 'preview' ? previews : checks;
      const key = stableId([cwd, argv, argv.length ? null : details.url]);
      const prior = catalog.get(key);
      const id = details.id || prior?.id || 'command-' + key;
      if ([...catalog].some(([other, row]) => other !== key && row.id === id)) throw Error('A command ID already identifies another command.');
      catalog.set(key, {id, label, kind, argv, cwd, source: [...source, ...(prior?.source || [])], ...details});
    }
  };
}

export async function discoverCapabilities(root) {
  const blank = {schema_version: 1, git: {head: null, branch: null, refs: []}, components: [], checks: [], previews: [], files: [], gaps: []};
  const tracked = await trackedFiles(root).catch(() => null);
  if (!tracked) return {...blank, gaps: ['Capability discovery needs a readable Git checkout.']};
  const names = tracked.slice(0, 20000);
  const paths = new Set(names);
  const inventory = inventoryFor(root);
  const json = async file => {
    try {
      const value = JSON.parse(await inventory.text(file));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
    inventory.gaps.add(file + ' does not contain a readable JSON object.');
    return null;
  };
  if (tracked.length > names.length) inventory.gaps.add('The tracked file scan reached its limit.');
  for (const file of names.filter(name => basename(name) === 'package.json')) {
    const manifest = await json(file);
    if (manifest) scanNode(inventory, file, manifest, paths);
  }
  scanOther(inventory, paths);
  await scanPython(inventory, names);
  for (const file of names.filter(name => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name))) {
    await scanContinuousIntegration(inventory, paths, file);
  }
  const staticProject = paths.has('index.html') && await detectProject(root).catch(() => null);
  if (staticProject?.kind === 'static' && !inventory.previews.size) {
    const source = [evidence('index.html', 'Tracked HTML entry point')];
    const component = inventory.component('.', 'Static web', 'Static web', source);
    inventory.command('preview', 'Static website', ['branch-review-static', '{root}', '{port}'], '.', source,
      {component_id: component, mode: 'web', url: localAddress});
  }
  const files = new Map(names.flatMap(file => {
    const kind = fileKind(file);
    return kind ? [[file, {id: 'file-' + stableId(file), path: file, kind, label: file}]] : [];
  }));
  await applyAdapter(root, inventory, paths, paths.has(adapter) ? await json(adapter) : null, files);
  const sortedFiles = [...files.values()].sort((first, second) => fileKinds.indexOf(first.kind) - fileKinds.indexOf(second.kind));
  if (sortedFiles.length > 300) inventory.gaps.add('The evidence file list reached its limit.');
  if (!inventory.checks.size) inventory.gaps.add('No runnable check candidates were found.');
  const sorted = table => [...table.values()].sort((first, second) =>
    (first.cwd || first.root).localeCompare(second.cwd || second.root) || first.label.localeCompare(second.label));
  return {...blank, git: await gitMetadata(root), components: sorted(inventory.components), checks: sorted(inventory.checks),
    previews: sorted(inventory.previews), files: sortedFiles.slice(0, 300).map(row => ({...row, component_id: inventory.owner(row.path)})),
    gaps: [...inventory.gaps]};
}

export async function readInstruction(root, name) {
  const file = relativePath(name);
  const tracked = await trackedFiles(root);
  if (!tracked.includes(file)) throw Error('Choose a tracked project instruction file.');
  if (fileKind(file) !== 'instruction' &&
      !(await discoverCapabilities(root)).files.some(row => row.path === file && row.kind === 'instruction')) {
    throw Error('Choose a tracked project instruction file.');
  }
  return {path: file, content: await boundedText(root, file, 350000)};
}
