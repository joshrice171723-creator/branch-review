import {createHash} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {readQuality, writeQuality} from './io.mjs';
import {capture, gitOutput, inside, sourceGuard} from './runner.mjs';
import {boolean, label, relative} from './schema.mjs';

const posix = path.posix;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const jsSuffixes = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const sourceSuffixes = new Set([...jsSuffixes, '.py', '.rb']);
const skipped = new Set(['node_modules', 'vendor', 'dist', 'test', 'tests', 'spec']);
const maxFiles = 1600, maxFileBytes = 750_000, maxSourceBytes = 36_000_000, maxRoutes = 1500;
const jsString = /"[^"\n\\]*(?:\\.[^"\n\\]*)*"|'[^'\n\\]*(?:\\.[^'\n\\]*)*'/;
const jsMask = new RegExp(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|\x60(?:\\.|[^\x60\\])*\x60/.source + '|' + jsString.source, 'gs');
const registration = new RegExp(
  /\b(?:(ipcMain)\.(handle|on)|(app|router|server|fastify|api)\.(get|post|put|patch|delete|head|options))\s*\(\s*/.source +
  '(' + jsString.source + /|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/.source + ')' + /\s*,/.source, 'gi'
);
const reEscape = text => text.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const boundary = (path, name, start, end) => ({path, name, start, end});
const maskJS = text => text.replace(jsMask, token => token.replace(/[^\n]/g, ' '));
const lineAt = (text, position) => text.slice(0, position).split('\n').length;
const uniq = items => [...new Set(items)];
const idFor = ({method, path, source, app_root}) => 'route-' + createHash('sha256').update(
  '[' + [method, path, source?.path || app_root].map(value =>
    JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))).join(', ') + ']'
).digest('hex').slice(0, 20);

function route(method, path, framework, source, handler, anchors, options = {}) {
  const value = {method, path, framework, source, handler, anchors,
    transport: method === 'IPC' ? 'ipc' : 'http', gaps: [], related: [], provenance: 'static_source',
    app_root: '.', observed_at: null, observed_path: null, ...options};
  return {...value, id: idFor(value)};
}

function location(sources, item) {
  return item ? {path: item.path, line: lineAt(sources.get(item.path), item.start)} : null;
}

function routeData(sources, item) {
  const {id, method, path, framework, transport, provenance, app_root, observed_at, observed_path} = item;
  const source = location(sources, item.source);
  const handler = item.handler ? {...location(sources, item.handler), name: item.handler.name} :
    item.target ? {name: item.target, path: null, line: null} : null;
  return {id, method, path, framework, transport, source, handler, provenance, app_root, observed_at, observed_path};
}

async function trackedFiles(root) {
  const [prefix, files] = await Promise.all([
    gitOutput(root, 'rev-parse', '--show-prefix'),
    gitOutput(root, 'ls-files', '-z', '--cached', '--full-name')
  ]);
  const base = prefix.replace(/\r?\n$/, '');
  return uniq(files.split('\0').filter(name => name && name.startsWith(base)).map(name => name.slice(base.length))
    .filter(name => name && !name.startsWith('.harness/'))).sort();
}

async function getSource(root, name) {
  try {
    const file = await inside(root, name);
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > maxFileBytes) return null;
    return new TextDecoder('utf-8', {fatal: true}).decode(await readFile(file)).replace(/\r\n/g, '\n');
  } catch { return null; }
}

async function sourceMap(root, tracked) {
  const selected = tracked.filter(name => sourceSuffixes.has(posix.extname(name)) &&
    !name.endsWith('.min.js') && !name.split('/').some(segment => skipped.has(segment)));
  const sources = new Map();
  let total = 0;
  for (let start = 0; start < Math.min(selected.length, maxFiles); start += 32) {
    const group = selected.slice(start, Math.min(start + 32, maxFiles));
    const texts = await Promise.all(group.map(name => getSource(root, name)));
    for (const [index, text] of texts.entries()) {
      if (text === null) continue;
      total += Buffer.byteLength(text);
      if (total > maxSourceBytes) break;
      sources.set(group[index], text);
    }
    if (total > maxSourceBytes) break;
  }
  return {sources, gaps: sources.size < selected.length ? [
    'Some tracked source files exceeded discovery limits or could not be read.'
  ] : []};
}

function closing(code, start, opener = '(', closer = ')') {
  let depth = 0;
  for (let index = start; index < code.length; index++) {
    if (code[index] === opener) depth++;
    if (code[index] === closer && --depth === 0) return index + 1;
  }
  return null;
}

function bodyAt(code, offset) {
  const start = offset + (code.slice(offset).match(/^\s*/)?.[0].length || 0);
  if (code[start] === '{') {
    const end = closing(code, start, '{', '}');
    return end && [start, end];
  }
  let depth = 0;
  for (let index = start; index < Math.min(code.length, start + 12_000); index++) {
    const char = code[index];
    if ('({['.includes(char)) depth++;
    if (')}]'.includes(char) && depth-- === 0) return [start, index];
    if (char === ';' && depth === 0) return [start, index + 1];
  }
  return null;
}

function jsSymbols(name, text) {
  const code = maskJS(text);
  const found = new Map();
  const declarations = /\b(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?)?\(/g;
  for (const declaration of code.matchAll(declarations)) {
    const end = closing(code, declaration.index + declaration[0].length - 1);
    if (!end) continue;
    const after = /^\s*(?:=>\s*)?(?=\{)/.exec(code.slice(end));
    const body = after && bodyAt(code, end + after[0].length);
    if (body) found.set(declaration[1], boundary(name, declaration[1], ...body));
  }
  return found;
}

function rubySymbols(name, text) {
  const found = new Map();
  for (const match of text.matchAll(/^([ \t]*)def\s+(?:self\.)?([a-z_][\w]*[!?=]?)/gm)) {
    const start = match.index + match[0].length;
    const limit = new RegExp('^' + reEscape(match[1]) + /(?:end\b|def\s)/.source, 'm').exec(text.slice(start));
    const end = limit ? start + limit.index + (limit[0].trim() === 'end' ? limit[0].length : 0) : text.length;
    found.set(match[2], boundary(name, match[2], match.index, end));
  }
  return found;
}

function pythonSymbols(name, text) {
  const found = new Map();
  for (const match of text.matchAll(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)) {
    const newline = text.indexOf('\n', match.index + match[0].length);
    const start = newline < 0 ? text.length : newline + 1;
    const limit = new RegExp('^[ \\t]{0,' + match[1].length + '}[^ \\t\\n#]', 'm').exec(text.slice(start));
    found.set(match[2], boundary(name, match[2], match.index, limit ? start + limit.index : text.length));
  }
  return found;
}

function modulePath(sources, name, requested) {
  const base = posix.join(posix.dirname(name), requested);
  if (sources.has(base)) return base;
  return [...jsSuffixes, '.py'].flatMap(ext => [base + ext, base + '/index' + ext]).find(file => sources.has(file));
}

function importSymbols(sources, name) {
  const text = sources.get(name);
  const found = new Map();
  if (jsSuffixes.includes(posix.extname(name))) {
    for (const match of text.matchAll(/^\s*import\s+([^;]{1,4000}?)\s+from\s+(['"])(\.[^'"\n]+)\2/gm)) {
      const target = modulePath(sources, name, match[3]);
      if (!target) continue;
      const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(match[1]);
      if (namespace) found.set(namespace[1], [target, null]);
      const names = /\{([^{}]+)\}/.exec(match[1]);
      for (const symbol of names?.[1].split(',') || []) {
        const [from, to = from] = symbol.trim().split(/\s+as\s+/);
        if (from) found.set(to, [target, from]);
      }
    }
    for (const match of text.matchAll(/\b(?:const|let)\s+(\{[^}]+\}|[\w$]+)\s*=\s*require\(\s*(['"])(\.[^'"\n]+)\2\s*\)/g)) {
      const target = modulePath(sources, name, match[3]);
      if (!target) continue;
      if (!match[1].startsWith('{')) found.set(match[1], [target, null]);
      else for (const symbol of match[1].slice(1, -1).split(',')) {
        const [from, to = from] = symbol.trim().split(/\s*:\s*/);
        if (from) found.set(to, [target, from]);
      }
    }
  } else if (name.endsWith('.py')) {
    for (const match of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) {
      const target = modulePath(sources, name, match[1].replace(/^\.+/, '').replaceAll('.', '/'));
      if (!target) continue;
      for (const symbol of match[2].split(',')) {
        const [from, to = from] = symbol.trim().split(/\s+as\s+/);
        if (from) found.set(to, [target, from]);
      }
    }
  }
  return found;
}

function jsConstants(text) {
  const constants = new Map();
  const assign = /\b(?:const|let)\s+(\w+)\s*=\s*(['"])([^'"\n]+)\2/g;
  for (const match of text.matchAll(assign)) constants.set(match[1], match[3]);
  for (const match of text.matchAll(/\bconst\s+(\w+)\s*=\s*(?:Object\.freeze\s*\(\s*)?\{([^{}]{1,12000})\}/g)) {
    for (const field of match[2].matchAll(/\b(\w+)\s*:\s*(['"])([^'"\n]+)\2/g)) {
      constants.set(match[1] + '.' + field[1], field[3]);
    }
  }
  return constants;
}

function jsRegistrations(name, text, code, sources) {
  const routes = [];
  const gaps = [];
  const symbols = jsSymbols(name, text);
  const imports = importSymbols(sources, name);
  const constants = new Map(Array.from(jsConstants(text), ([symbol, value]) => [symbol, [name, value]]));
  for (const [alias, [file, symbol]] of imports) {
    for (const [key, value] of jsConstants(sources.get(file))) {
      if (!symbol) constants.set(alias + '.' + key, [file, value]);
      else if (key === symbol || key.startsWith(symbol + '.')) constants.set(alias + key.slice(symbol.length), [file, value]);
    }
  }
  for (const match of text.matchAll(registration)) {
    const [token, ipc, kind, router, verb, raw] = match;
    const prefix = ipc || router;
    if (!code.startsWith(prefix, match.index)) continue;
    const start = match.index;
    const end = start + token.length;
    const [valueFile, value] = /^['"]/.test(raw) ? [name, raw.slice(1, -1)] : (constants.get(raw) || []);
    const method = ipc ? 'IPC' : verb.toUpperCase();
    if (!value || (!ipc && !value.startsWith('/'))) {
      gaps.push(name + ' contains a route registration with an unresolved path or channel.');
      continue;
    }
    const symbol = prefix + '.' + (kind || verb);
    const source = boundary(name, symbol, start, end);
    const bound = closing(code, text.indexOf('(', start));
    const related = [];
    if (bound) for (const reference of code.slice(end, bound - 1).matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=,|$)/g)) {
      const [file, original] = imports.get(reference[1]) || [];
      const target = symbols.get(reference[1]) || (original && jsSymbols(file, sources.get(file)).get(original));
      if (target) related.push(target);
    }
    const handler = related.pop() || (bound ? boundary(name, symbol, end, bound - 1) : null);
    const anchors = [[name, token]];
    if (!/^['"]/.test(raw)) anchors.push([valueFile, value]);
    routes.push(route(method, value, ipc ? 'Electron IPC' : 'Node HTTP', source, handler, anchors, {related}));
  }
  return {routes, gaps};
}

function jsDispatched(name, text, code) {
  const routes = [];
  const gaps = [];
  const branches = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const start = match.index;
    const inside = start + match[0].length;
    const end = closing(code, inside - 1);
    if (!end) continue;
    const condition = text.slice(inside, end - 1);
    const paths = Array.from(condition.matchAll(/\b(?:pathname|path|endpoint|route|url)\s*={2,3}\s*(['"])(\/[^'"\n]*)\1/g), item => item[2]);
    const verbs = uniq(Array.from(condition.matchAll(/\bmethod\s*={2,3}\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/g), item => item[2]));
    const table = /\b(\w+)\.has\(\s*(?:\w+\.)?(?:pathname|path)\s*\)/.exec(condition)?.[1];
    if (!paths.length && !(table && verbs.length)) continue;
    const body = bodyAt(code, end);
    if (body) branches.push({start, end, paths, verbs, table, body});
  }
  for (const {start, end, paths, verbs, table, body} of branches) {
    const predicate = [name, text.slice(start, end)];
    for (const method of verbs) for (const value of paths) {
      routes.push(route(method, value, 'Node HTTP', boundary(name, 'HTTP predicate', start, end),
        boundary(name, method + ' ' + value, ...body), [predicate]));
    }
    if (!table || !verbs.length) continue;
    const declaration = new RegExp(/\b(?:const|let)\s+/.source + reEscape(table) + /\s*=\s*new\s+Set\(\s*\[([^\]]*)\]/.source).exec(text);
    if (!declaration) {
      gaps.push(name + ' dispatches routes through an unresolved request table.');
      continue;
    }
    const entries = Array.from(declaration[1].matchAll(/(['"])(\/[^'"\n]+)\1/g), entry => ({
      value: entry[2], start: text.indexOf('[', declaration.index) + 1 + entry.index, anchors: [[name, declaration[0]], [name, entry[0]]]
    }));
    const added = new RegExp('\\b' + reEscape(table) + /\.add\(\s*(['"])(\/[^'"\n]+)\1\s*\)/.source, 'g');
    for (const entry of text.matchAll(added)) {
      if (code.startsWith(table, entry.index)) entries.push({value: entry[2], start: entry.index, anchors: [[name, entry[0]]]});
    }
    for (const entry of entries) {
      const candidates = branches.filter(branch => !branch.verbs.length && branch.paths.includes(entry.value));
      const target = candidates.find(branch => branch.start >= body[0] && branch.start < body[1]) || candidates[0];
      const anchors = [predicate, ...entry.anchors];
      if (target) anchors.push([name, text.slice(target.start, target.end)]);
      const gaps = target ? [] : ['The request table is visible. The route-specific dispatch target could not be resolved.'];
      for (const method of verbs) {
        routes.push(route(method, entry.value, 'Node HTTP', boundary(name, table, entry.start, entry.start + entry.value.length),
          boundary(name, method + ' ' + entry.value, ...(target?.body || body)), anchors, {gaps}));
      }
    }
  }
  return {routes, gaps};
}

const railsJoin = (...segments) => '/' + segments.map(segment => segment.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

function rubyHandler(sources, root, controller, action) {
  const name = posix.join(root, 'app/controllers', controller + '_controller.rb');
  return sources.has(name) ? rubySymbols(name, sources.get(name)).get(action) || null : null;
}

function railsRoute(method, value, source, anchors, sources, root, namespace, controller, action) {
  const actual = controller ? railsJoin(namespace, controller).slice(1) : '';
  const handler = actual ? rubyHandler(sources, root, actual, action) : null;
  const target = action ? actual + '#' + action : '';
  return route(method, value, 'Rails', source, handler,
    [...anchors, ...(handler ? [[handler.path, 'def ' + action]] : [])], {
      app_root: root, target,
      gaps: handler ? [] : ['The assumed Rails controller action could not be located in tracked source.']
    });
}

function pluralStem(value) {
  if (value.endsWith('ies')) return value.slice(0, -3) + 'y';
  return value.replace(/(ch|sh|ss|x|z)es$/, '$1').replace(/(?<!s)s$/, '');
}

function railsRoutes(name, text, sources) {
  const root = posix.dirname(posix.dirname(name));
  const routes = [], gaps = [], scopes = [];
  let offset = 0;
  for (const raw of lines(text)) {
    const line = raw.replace(/\n$/, '');
    const start = offset;
    offset += raw.length;
    const content = line.trimStart();
    const indent = line.length - content.length;
    if (!content || content.startsWith('#')) continue;
    while (scopes.length && indent <= scopes.at(-1).indent) scopes.pop();
    const parent = scopes.at(-1) || {path: '', module: ''};
    const namespace = /^(namespace|scope)\s+(?::(\w+)|['"]([^'"]+)['"])(.*\bdo\b)/.exec(content);
    if (namespace) {
      const segment = namespace[2] || namespace[3];
      scopes.push({indent, path: railsJoin(parent.path, segment), anchor: content,
        module: namespace[1] === 'namespace' ? railsJoin(parent.module, segment).slice(1) : parent.module});
      continue;
    }
    const verb = /^(get|post|put|patch|delete|head|options)\s+(['"])(.*?)\2(.*)$/.exec(content);
    const resource = /^(resources|resource)\s+(?::(\w+)|['"](\w+)['"])(.*)$/.exec(content);
    if (!verb && !resource) {
      if (/^(match|mount|draw|concern|constraints)\b/.test(content)) {
        gaps.push(name + ' contains Rails route construction that needs runtime inspection.');
      }
      continue;
    }
    const anchors = [...scopes.map(scope => [name, scope.anchor]), [name, content]];
    const source = boundary(name, 'Rails route', start + indent, start + line.length);
    if (verb) {
      const explicit = /(?:\bto:\s*|=>\s*)(['"])([\w/]+)#([\w!?]+)\1/.exec(verb[4]);
      const implicit = /^([\w/]+)#([\w!?]+)$/.exec(verb[3]);
      const [controller = '', action = ''] = explicit?.slice(2) || implicit?.slice(1) || [];
      const value = railsJoin(parent.path, implicit && !explicit ? controller + '/' + action : verb[3]);
      if (!controller) gaps.push(name + ' contains a Rails route with an unresolved target.');
      routes.push(railsRoute(verb[1].toUpperCase(), value, source, anchors, sources, root, parent.module, controller, action));
      continue;
    }
    const plural = resource[1] === 'resources';
    const namePart = resource[2] || resource[3];
    const options = resource[4];
    const controllerOpt = /\bcontroller:\s*(?::([\w/]+)|['"]([\w/]+)['"])/.exec(options);
    const pathOpt = /\bpath:\s*(?::([\w/]+)|['"]([^'"]+)['"])/.exec(options);
    const controller = controllerOpt?.[1] || controllerOpt?.[2] || (plural ? namePart : namePart + 's');
    const value = railsJoin(parent.path, pathOpt?.[1] || pathOpt?.[2] || namePart);
    const param = /\bparam:\s*:(\w+)/.exec(options)?.[1] || 'id';
    const member = plural ? value + '/:' + param : value;
    const endpoints = {new: [['GET', value + '/new']], create: [['POST', value]], show: [['GET', member]],
      edit: [['GET', member + '/edit']], update: [['PATCH', member], ['PUT', member]], destroy: [['DELETE', member]]};
    if (plural) endpoints.index = [['GET', value]];
    const only = /\bonly:\s*(\[[^\]]*\]|:\w+|%i\[[^\]]*\])/.exec(options)?.[1];
    const except = /\bexcept:\s*(\[[^\]]*\]|:\w+|%i\[[^\]]*\])/.exec(options)?.[1];
    for (const [action, entries] of Object.entries(endpoints)) {
      const word = new RegExp('\\b' + action + '\\b');
      if ((only && !word.test(only)) || (except && word.test(except))) continue;
      for (const [method, actual] of entries) {
        routes.push(railsRoute(method, actual, source, anchors, sources, root, parent.module, controller, action));
      }
    }
    if (/\bdo\b/.test(options)) {
      scopes.push({indent, path: plural ? value + '/:' + pluralStem(namePart) + '_' + param : value,
        module: parent.module, anchor: content});
    }
  }
  return {routes, gaps};
}

function pythonRoutes(name, text) {
  const rows = [], scopes = [];
  let offset = 0;
  const all = lines(text);
  for (const [index, line] of all.entries()) {
    const start = offset;
    offset += line.length;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    while (scopes.length && indent <= scopes.at(-1).indent) scopes.pop();
    const def = /^\s*(?:async\s+)?def\s+do_(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/.exec(line);
    if (def) scopes.push({indent, verbs: [def[1]]});
    const condition = /^\s*(?:if|elif)\s+(.+):\s*(?:#[^\n]*)?$/.exec(line)?.[1];
    if (!condition) continue;
    const verbs = uniq(Array.from(condition.matchAll(/\b(?:method|command)\s*==\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/g), item => item[2]));
    if (verbs.length) scopes.push({indent, verbs});
    const active = scopes.at(-1)?.verbs || [];
    if (!active.length) continue;
    const paths = [];
    for (const term of condition.matchAll(/\b(?:pathname|path|endpoint|route)\s*(?:==\s*(['"])(\/[^'"\n]*)\1|in\s*[([{]([^)\]}]+)[)\]}])/g)) {
      if (term[2]) paths.push(term[2]);
      else paths.push(...Array.from(term[3].matchAll(/(['"])(\/[^'"\n]+)\1/g), item => item[2]));
    }
    if (!paths.length) continue;
    let bodyEnd = offset;
    for (const next of all.slice(index + 1)) {
      if (next.trim() && next.match(/^[ \t]*/)[0].length <= indent) break;
      bodyEnd += next.length;
    }
    for (const method of active) for (const value of paths) {
      rows.push(route(method, value, 'Python HTTP', boundary(name, 'HTTP predicate', start, offset),
        boundary(name, method + ' ' + value, offset, bodyEnd), [[name, condition]], {
          gaps: ['The Python trace uses visible predicates and indentation. Dynamic dispatch requires separate inspection.']
        }));
    }
  }
  return rows;
}

const maxRailsOutput = 2 * 1024 * 1024;
const railsMarker = 'WORKBENCH_RAILS_ROUTES ';
const railsRunner = [
  'require "json"',
  'rows = []',
  'omitted = false',
  'Rails.application.routes.routes.each do |route|',
  '  verb = route.verb.to_s',
  '  methods = verb.empty? ? ["*"] : verb.scan(/\\b[A-Z][A-Z0-9-]*\\b/).uniq',
  '  omitted ||= methods.empty?',
  '  methods.each do |method|',
  '    if rows.length >= ' + maxRoutes,
  '      omitted = true',
  '      break',
  '    end',
  '    rows << {method: method, path: route.path.spec.to_s, controller: route.defaults[:controller]&.to_s,',
  '             action: route.defaults[:action]&.to_s, name: route.name&.to_s}',
  '  end',
  '  break if rows.length >= ' + maxRoutes + ' && omitted',
  'end',
  'STDOUT.binmode',
  'STDOUT.write("\\n' + railsMarker + '" + JSON.generate({routes: rows, omitted: omitted}) + "\\n")'
].join('\n');

async function railsDirectory(root, app, candidates) {
  const usable = async name => {
    try {
      const directory = await inside(root, name);
      const files = await Promise.all(['bin/rails', 'config/application.rb'].map(file => inside(directory, file).then(stat)));
      return files.every(file => file.isFile()) ? directory : null;
    } catch { return null; }
  };
  if (app != null) {
    const selected = await usable(relative(app, 'Rails app directory'));
    if (!selected) throw Error('Select a Rails app in this project with bin/rails and config/application.rb.');
    return selected;
  }
  const base = await usable('.');
  if (base) return base;
  const matches = (await Promise.all(candidates.map(usable))).filter(Boolean);
  if (matches.length > 1) throw Error('Select a Rails app directory. This project contains multiple Rails apps.');
  if (!matches.length) throw Error('Rails runtime routes require an app with bin/rails and config/application.rb.');
  return matches[0];
}

function validRuntimeRow(item) {
  return item && typeof item.method === 'string' && /^(?:[A-Z][A-Z0-9-]{0,23}|\*)$/.test(item.method) &&
    typeof item.path === 'string' && item.path.startsWith('/') &&
    ['controller', 'action', 'name'].every(key => item[key] == null || typeof item[key] === 'string');
}

async function refreshRails(root, app, candidates, signal) {
  try {
    const cwd = await railsDirectory(root, app, candidates);
    const env = {...process.env, RAILS_ENV: 'development', RACK_ENV: 'development'};
    delete env.BUNDLE_GEMFILE;
    const result = await capture(['ruby', 'bin/rails', 'runner', '-e', 'development', railsRunner],
      {cwd, env, signal, timeout: 120, limit: maxRailsOutput, stopOnLimit: true});
    if (result.error?.includes('ENOENT')) throw Error('Ruby was not found on PATH. Configure the local Rails runtime.');
    if (result.stdout_truncated || result.stderr_truncated) throw Error('Rails startup exceeded the route refresh output limit.');
    if (result.error?.includes('exceeded') && !result.error.includes('limit')) throw Error('Rails route refresh timed out.');
    if (result.status !== 'passed') {
      const output = result.stdout + result.stderr;
      if (/Bundler::GemNotFound|Gem::MissingSpec|Could not find gem|LoadError/.test(output)) {
        throw Error('Rails could not load local dependencies. Check the bundle and refresh routes again.');
      }
      if (/ConnectionNotEstablished|NoDatabaseError|ConnectionBad|ConnectionError|CantOpenException/.test(output)) {
        throw Error('Rails could not open its development database. Check the local database configuration.');
      }
      throw Error('Rails could not boot in development. Check startup with ruby bin/rails routes.');
    }
    const receipt = result.stdout.split(/\r?\n/).findLast(line => line.startsWith(railsMarker));
    if (!receipt) throw Error('Rails did not return route metadata. Check the local Rails runner.');
    let data;
    try { data = JSON.parse(receipt.slice(railsMarker.length)); }
    catch { throw Error('Rails returned invalid route metadata.'); }
    if (!Array.isArray(data?.routes) || data.routes.length > maxRoutes ||
        typeof data.omitted !== 'boolean' || !data.routes.every(validRuntimeRow)) {
      throw Error('Rails returned invalid route metadata.');
    }
    const stamp = new Date().toISOString();
    const app_root = path.relative(root, cwd).split(path.sep).join('/') || '.';
    return {
      app_root, routes: data.routes.map(row => ({...row, app_root, observed_at: stamp})),
      warnings: data.omitted ? ['Rails returned a bounded route list. Some realized routes were omitted.'] : []
    };
  } catch (error) {
    return {app_root: null, routes: [], warnings: [error.message]};
  }
}

async function withRuntime(root, catalog, {runtime, app, signal}) {
  const file = '.harness/quality/rails-routes.json';
  const stored = await readQuality(root, file).catch(() => null);
  if (!runtime && !stored) return;
  const fingerprint = createHash('sha256');
  fingerprint.update((await gitOutput(root, 'rev-parse', 'HEAD').catch(() => '')).trim());
  for (const name of catalog.tracked) {
    const gemfile = ['Gemfile', 'Gemfile.lock'].includes(posix.basename(name));
    if (!name.endsWith('.rb') && !gemfile) continue;
    const text = catalog.sources.get(name) ?? (gemfile ? await getSource(root, name) : '');
    fingerprint.update(name + '\0' + (text || '') + '\0');
  }
  const digest = fingerprint.digest('hex');
  let rows = stored?.fingerprint === digest && Array.isArray(stored.routes) ? stored.routes.filter(validRuntimeRow) : [];
  if (runtime) {
    const refreshed = await refreshRails(root, app, catalog.rails_apps, signal);
    catalog.gaps.push(...refreshed.warnings);
    if (refreshed.app_root !== null) {
      rows = [...rows.filter(row => (row.app_root || '.') !== refreshed.app_root), ...refreshed.routes];
      await writeQuality(root, file, {fingerprint: digest, routes: rows});
    }
  }
  const observed = new Map(rows.map(item => {
    const value = item.path.replace(/\(\.:format\)$/, '');
    return [JSON.stringify([item.method, value, item.app_root || '.']), {...item, value}];
  }));
  for (const item of catalog.routes) {
    if (item.framework !== 'Rails') continue;
    const key = JSON.stringify([item.method, item.path, item.app_root]);
    const metadata = observed.get(key);
    if (!metadata) continue;
    observed.delete(key);
    Object.assign(item, {provenance: 'rails_runtime', observed_at: metadata.observed_at, observed_path: metadata.path});
    if (!metadata.controller || !metadata.action) continue;
    const target = metadata.controller + '#' + metadata.action;
    if (item.target === target) continue;
    item.target = target;
    item.handler = rubyHandler(catalog.sources, item.app_root, metadata.controller, metadata.action);
    item.gaps.push('Rails runtime resolved a different controller action from the static declaration.');
    item.anchors = item.anchors.filter(anchor => anchor[0] === item.source.path);
    if (item.handler) item.anchors.push([item.handler.path, 'def ' + metadata.action]);
  }
  for (const metadata of observed.values()) {
    const {method, value, controller, action, observed_at, path: observed_path, app_root = '.'} = metadata;
    const handler = controller && action ? rubyHandler(catalog.sources, app_root, controller, action) : null;
    catalog.routes.push(route(method, value, 'Rails', null, handler, handler ? [[handler.path, 'def ' + action]] : [], {
      provenance: 'rails_runtime', app_root, target: controller && action ? controller + '#' + action : '',
      observed_at, observed_path, gaps: [
        'Rails runtime observed this route. Its generated check verifies controller source.',
        'A matching tracked route declaration could not be resolved.'
      ]
    }));
  }
}

async function catalogFor(root, options) {
  boolean(options.runtime, 'Runtime discovery');
  const tracked = await trackedFiles(root);
  const {sources, gaps} = await sourceMap(root, tracked);
  const routes = [];
  for (const [name, text] of sources) {
    if (name === 'config/routes.rb' || name.endsWith('/config/routes.rb')) {
      const found = railsRoutes(name, text, sources);
      routes.push(...found.routes);
      gaps.push(...found.gaps);
    } else if (jsSuffixes.includes(posix.extname(name))) {
      const code = maskJS(text);
      if (/\b(?:ipcMain|app|router|server|fastify|api)\./.test(code)) {
        const found = jsRegistrations(name, text, code, sources);
        routes.push(...found.routes);
        gaps.push(...found.gaps);
      }
      if (/\bif\s*\(/.test(code) && /\bmethod\b/.test(code)) {
        const found = jsDispatched(name, text, code);
        routes.push(...found.routes);
        gaps.push(...found.gaps);
      }
    } else if (name.endsWith('.py')) routes.push(...pythonRoutes(name, text));
  }
  const rails_apps = uniq([...tracked.filter(name => name === 'config/application.rb' || name.endsWith('/config/application.rb'))
    .map(name => posix.dirname(posix.dirname(name))), ...routes.filter(item => item.framework === 'Rails').map(item => item.app_root)]).sort();
  const catalog = {tracked, sources, routes, gaps, rails_apps};
  await withRuntime(root, catalog, options);
  catalog.routes = Array.from(new Map(routes.toReversed().map(item => [item.id, item])).values())
    .sort((a, b) => (a.method === 'IPC') - (b.method === 'IPC') || a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method) || a.app_root.localeCompare(b.app_root) || a.id.localeCompare(b.id));
  return catalog;
}

export async function discoverRoutes(repository, {runtime = false, app, signal} = {}) {
  const {routes, sources, gaps, rails_apps} = await catalogFor(await realpath(repository), {runtime, app, signal});
  if (!routes.length) gaps.push('No supported route declarations were found. Enter the method and path manually.');
  if (routes.length > maxRoutes) gaps.push('The route list reached the discovery limit. Enter an omitted route manually.');
  return {routes: routes.slice(0, maxRoutes).map(item => routeData(sources, item)),
    frameworks: uniq(routes.map(item => item.framework)).sort(), rails_apps, gaps: uniq(gaps).sort()};
}

const dataNames = new Set(('query execute exec_query find find_by findById findOne findMany find_by_sql find_each where pluck ' +
  'select_all select_one select_value aggregate groupBy all count insert insert_all insertMany create createMany update update_all ' +
  'updateMany update_columns save delete delete_all deleteMany destroy destroy_all upsert upsert_all transaction readFile readFileSync ' +
  'writeFile writeFileSync read_text write_text access readdir rename git gitSync capture2 capture3').split(' '));
const writeNames = /^(?:insert|create|update|save|delete|destroy|upsert)/;
const fileNames = /^(?:readFile|writeFile|read_text|write_text|access|readdir|rename)/;
const callNames = /(?<![\w$])([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*[!?]?)\s*(?=\()/g;
const rubyCalls = /\b(?:[A-Z]\w*(?:::[A-Z]\w*)*|self)\.[a-z_]\w*[!?]?/g;
const snakeCase = word => word.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function operationSites(sources, subject, body, ruby) {
  const result = [];
  const tokens = ruby ? body.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+[!?]?/g) : body.matchAll(callNames);
  for (const token of tokens) {
    const name = token[1] || token[0];
    const member = name.split('.').at(-1).replace(/[!?]$/, '');
    if (!dataNames.has(member) || /^(?:Promise|Object|Array|Math)\./.test(name)) continue;
    const kind = fileNames.test(member) ? 'filesystem' : /^(?:git|gitSync)$/.test(member) ? 'Git' :
      member.startsWith('capture') ? 'subprocess' : member === 'transaction' ? 'transaction candidate' :
      writeNames.test(member) ? 'write candidate' : 'query/data access candidate';
    result.push({path: subject.path, line: lineAt(sources.get(subject.path), subject.start + token.index),
      operation: kind + ': ' + name, boundary: subject.name});
  }
  return result;
}

function calledBoundaries(sources, symbols, imports, subject, body, ruby, appRoot) {
  const result = [];
  const names = new Set(Array.from(body.matchAll(callNames), match => match[1]));
  const local = symbols(subject.path);
  const imported = imports(subject.path);
  if (ruby) {
    for (const match of body.matchAll(rubyCalls)) names.add(match[0]);
    for (const name of local.keys()) {
      if (new RegExp('(?<![\\w.])' + reEscape(name) + '\\b').test(body)) names.add(name);
    }
  }
  for (const name of [...names].sort()) {
    const dot = name.indexOf('.');
    const stem = dot < 0 ? name : name.slice(0, dot);
    const member = dot < 0 ? '' : name.slice(dot + 1);
    const target = local.get(member && ['self', 'this'].includes(stem) ? member : name);
    if (target) result.push(target);
    else if (imported.has(stem)) {
      const [file, alias] = imported.get(stem);
      const entry = symbols(file).get(alias || member);
      if (entry) result.push(entry);
    } else if (ruby && member && /^[A-Z]\w*(?:::[A-Z]\w*)*$/.test(stem)) {
      const suffix = '/' + stem.split('::').map(snakeCase).join('/') + '.rb';
      const files = Array.from(sources.keys()).filter(file => file.endsWith(suffix) &&
        (appRoot === '.' || file.startsWith(appRoot + '/'))).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      for (const file of files.slice(0, 4)) {
        const entry = symbols(file).get(member);
        if (entry) result.push(entry);
      }
    }
  }
  return result;
}

async function suggestedChecks(root, tracked, item) {
  const rows = [];
  const exact = new RegExp("(['\"])" + reEscape(item.path) + '\\1');
  for (const name of tracked) {
    const nodeTest = /(?:spec|test)\.[cm]?js$/.test(name);
    const railsTest = item.framework === 'Rails' && name.endsWith('_test.rb');
    if (!nodeTest && !railsTest) continue;
    const text = await getSource(root, name);
    const match = text && exact.exec(text);
    if (!match) continue;
    let argv, cwd;
    if (nodeTest && /['"]node:test['"]/.test(text)) {
      argv = ['node', '--test', name];
      cwd = '.';
    } else if (railsTest && text.includes('ActionDispatch::IntegrationTest') &&
        tracked.includes(posix.join(item.app_root, 'bin/rails')) &&
        (item.app_root === '.' || name.startsWith(item.app_root + '/'))) {
      cwd = item.app_root;
      argv = ['ruby', 'bin/rails', 'test', posix.relative(cwd, name)];
    } else continue;
    rows.push({path: name, line: lineAt(text, match.index), argv, cwd,
      note: 'This tracked test mentions the exact route. Confirm its coverage.'});
    if (rows.length === 5) break;
  }
  return rows;
}

async function traceRoute(root, catalog, item) {
  const {sources, tracked} = catalog;
  const queue = item.handler ? [item.handler, ...item.related] : [];
  const visited = new Set(), boundaries = [], sites = [], definitions = new Map(), imports = new Map();
  const getSymbols = file => {
    if (!definitions.has(file)) {
      const source = sources.get(file);
      definitions.set(file, file.endsWith('.rb') ? rubySymbols(file, source) :
        file.endsWith('.py') ? pythonSymbols(file, source) : jsSymbols(file, source));
    }
    return definitions.get(file);
  };
  const getImports = file => {
    if (!imports.has(file)) imports.set(file, importSymbols(sources, file));
    return imports.get(file);
  };
  while (queue.length && visited.size < 30 && sites.length < 60) {
    const subject = queue.shift();
    const key = JSON.stringify([subject.path, subject.start, subject.end]);
    if (visited.has(key)) continue;
    visited.add(key);
    boundaries.push({...location(sources, subject), symbol: subject.name});
    const text = sources.get(subject.path).slice(subject.start, subject.end);
    const ruby = subject.path.endsWith('.rb');
    const body = jsSuffixes.includes(posix.extname(subject.path)) ? maskJS(text) : text;
    sites.push(...operationSites(sources, subject, body, ruby));
    queue.push(...calledBoundaries(sources, getSymbols, getImports, subject, body, ruby, item.app_root));
  }
  const gaps = [...item.gaps, ...catalog.gaps.filter(gap => item.source && gap.startsWith(item.source.path))];
  gaps.push('Static inspection identifies visible call sites. Verify executed queries, coverage, and side effects separately.');
  if (queue.length || sites.length > 60) gaps.push('The source trace reached its depth or site limit.');
  if (!item.handler) gaps.push('A callable implementation boundary could not be resolved.');
  else if (!sites.length) gaps.push('No data access calls matched in the source boundaries inspected.');
  gaps.push('Dynamic dispatch, callbacks, dependencies, and external services can add operations.');
  return {sites: Array.from(new Map(sites.slice(0, 60).map(row =>
    [JSON.stringify([row.path, row.line, row.operation]), row])).values()),
    boundaries, gaps: uniq(gaps), suggested_checks: await suggestedChecks(root, tracked, item)};
}

async function manualRoute(root, catalog, payload) {
  const method = label(payload.method, 'Route method', 20).toUpperCase();
  if (![...methods, 'IPC'].includes(method)) throw Error('Select an HTTP method or IPC');
  const value = label(payload.path, 'Route path or channel', 300).trim();
  if (method !== 'IPC' && !value.startsWith('/')) throw Error('The HTTP path must start with /');
  const file = payload.source_path ? relative(payload.source_path, 'Route source file') : null;
  const matches = catalog.routes.filter(item => item.method === method && item.path === value && (!file || item.source?.path === file));
  if (matches.length > 1) throw Error('Several sources declare this route. Select a source file.');
  if (matches.length) return matches[0];
  if (file && !catalog.tracked.includes(file)) throw Error('The source file must be tracked by Git');
  const text = file && (catalog.sources.get(file) || await getSource(root, file));
  const exact = text && new RegExp('(?<![\\w/])' + reEscape(value) + '(?![\\w/])').exec(text);
  if (!exact) return route(method, value, 'Manual', null, null, [], {
    gaps: ['No auditable tracked source declaration matched this route.']
  });
  catalog.sources.set(file, text);
  return route(method, value, 'Manual', boundary(file, 'Manual route reference', exact.index, exact.index + value.length),
    null, [[file, value]], {gaps: ['The manual source contains a route reference. The dispatch behavior and method are unverified.']});
}

function addDefinition(definition, item, trace, sources) {
  const id = item.id;
  if (!definition.checks.some(check => check.id === id)) {
    const anchors = item.anchors.slice(0, 12).filter(([, token]) => token && token.length <= 2000)
      .map(anchor => JSON.stringify(anchor));
    if (!anchors.length) throw Error('The route needs a bounded tracked source declaration');
    const kind = item.source ? 'route source guard' : 'controller source guard';
    definition.checks.push({id, name: (item.method + ' ' + item.path + ' ' + kind).slice(0, 120),
      argv: ['node', '-e', sourceGuard, ...anchors], cwd: '.', timeout_seconds: 30, required: true, phases: ['after']});
  }
  let owner = definition.rubrics.find(row => row.stage === 'build_review');
  if (!owner) {
    let id = 'route-review';
    while (definition.rubrics.some(row => row.id === id)) id += '-agent';
    owner = {id, name: 'Route review', actor: 'agent', stage: 'build_review', criteria: []};
    definition.rubrics.push(owner);
  }
  const scope = location(sources, item.source || item.handler);
  const base = item.method + ' ' + item.path;
  const origins = trace.sites.slice(0, 3).map(site => site.path + ':' + site.line).join(', ');
  const criteria = [
    {id: id + '-behavior', description: 'Trace ' + base + ' from ' + scope.path + ':' + scope.line +
      ' through its handler. Use the agreed request fixtures. Record the response and side effects.'},
    {id: id + '-data', description: 'Verify reads and writes for the exercised ' + base + ' cases.' +
      (origins ? ' Inspect candidate sites at ' + origins + '.' : '') +
      ' Record the fixture inputs and evidence. List untested branches and indirect operations.'}
  ];
  for (const criterion of criteria) {
    if (!owner.criteria.some(row => row.id === criterion.id)) {
      owner.criteria.push({...criterion, description: criterion.description.slice(0, 1000), required: true});
    }
  }
  return {check_ids: [id], rubric_ids: [owner.id], criterion_ids: criteria.map(row => row.id), benchmark_ids: []};
}

export async function prepareRoute(root, payload) {
  const catalog = await catalogFor(root, {runtime: false});
  let item = payload.route_id && catalog.routes.find(item => item.id === payload.route_id);
  if (!item && payload.route_id && (!payload.method || !payload.path)) {
    throw Error('The route could not be resolved in tracked source. Refresh the route list or enter it manually.');
  }
  item ||= await manualRoute(root, catalog, payload);
  const trace = await traceRoute(root, catalog, item);
  const response = {route: routeData(catalog.sources, item), trace};
  return item.anchors.length ? {...response, status: 'prepared', add: definition =>
    addDefinition(definition, item, trace, catalog.sources)} :
    {...response, status: 'needs_source', draft: null,
      generated: {check_ids: [], rubric_ids: [], criterion_ids: [], benchmark_ids: []}};
}
