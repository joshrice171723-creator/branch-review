import {createHash} from 'node:crypto';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export const policyFile = 'workbench-quality.json';
export const trialIdPattern = /^[a-f0-9]{32}$/;
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const aggregates = new Set(['mean', 'median', 'min', 'max']);
const operators = new Set(['lte', 'gte', 'eq']);
const agentStages = new Set(['plan_review', 'build_review', 'final_review']);
const legacyFloats = new WeakMap();

// Apex used Python JSON with sorted keys, ASCII escapes, and Python float formatting.
export function parseQualityJSON(text) {
  return JSON.parse(text, function (key, value, context) {
    if (key === 'value' && typeof value === 'number' && /[.eE]/.test(context?.source || '')) {
      legacyFloats.set(this, true);
    }
    return value;
  });
}

function floatText(value) {
  if (Object.is(value, -0)) return '-0.0';
  if (value !== 0 && (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e16)) {
    return value.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return Number.isInteger(value) ? value + '.0' : String(value);
}

const quoted = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char =>
  '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));

export function encodeQuality(value, forceFloat = false) {
  if (Array.isArray(value)) return '[' + value.map(item => encodeQuality(item)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      quoted(key) + ':' + encodeQuality(value[key], key === 'value' && legacyFloats.has(value))).join(',') + '}';
  }
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number' && (forceFloat || !Number.isInteger(value))) return floatText(value);
  if (typeof value === 'number' && String(value).includes('e')) return BigInt(value).toString();
  return JSON.stringify(value);
}

export function stringifyQuality(value) {
  return JSON.stringify(value, function (key, item) {
    if (key === 'value' && typeof item === 'number' && legacyFloats.has(this)) {
      return JSON.rawJSON(floatText(item));
    }
    return item;
  }, 2) + '\n';
}

function row(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected an object');
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key));
  if (missing.length || unknown.length) throw Error(`Missing fields [${missing}]. Unknown fields [${unknown}].`);
  return {...value};
}

function items(value, field, maximum = 50) {
  if (!Array.isArray(value) || value.length > maximum) throw Error(`${field} must be an array of up to ${maximum} items`);
  return value;
}

export function label(value, field, limit = 1000) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit || value.includes('\0')) {
    throw Error(`${field} must be nonempty text of up to ${limit} characters`);
  }
  return value;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !idPattern.test(value) || value.trim() !== value) {
    throw Error(`${field} must start with a lowercase letter and use lowercase letters, digits, underscores, or hyphens`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function boolean(value, field) {
  if (typeof value !== 'boolean') throw Error(`${field} must be true or false`);
  return value;
}

export function number(value, field) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw Error(`${field} must be a finite number`);
  return value;
}

export function relative(value, field) {
  const text = label(value, field).replaceAll('\\', '/');
  if (text.startsWith('/') || text.split('/').some(segment =>
    ['..', '.git', '.harness'].includes(segment.toLowerCase()) || segment.includes(':'))) {
    throw Error(`${field} must be a project-relative path`);
  }
  return path.posix.normalize(text).replace(/\/$/, '');
}

function unique(rows, field) {
  const values = rows.map(item => item[field]);
  if (new Set(values).size !== rows.length) throw Error(`Duplicate ${field}: ${values.join(', ')}`);
  return rows;
}

function command(value, fields = [], optional = []) {
  const data = row(value, ['argv', ...fields], ['cwd', 'timeout_seconds', ...optional]);
  const argv = items(data.argv, 'argv', 100);
  if (!argv.length) throw Error('argv must contain a command');
  data.argv = argv.map(arg => label(arg, 'argv entry', 4096));
  data.cwd = relative(Object.hasOwn(data, 'cwd') ? data.cwd : '.', 'cwd');
  data.timeout_seconds = integer(Object.hasOwn(data, 'timeout_seconds') ? data.timeout_seconds : 120, 'timeout_seconds', 1, 900);
  return data;
}

function check(value) {
  const data = command(value, ['id', 'name', 'required'], ['phases', 'input_paths']);
  identifier(data.id, 'check ID');
  label(data.name, 'check name', 120);
  boolean(data.required, 'check required');
  data.phases = Object.hasOwn(data, 'phases') ? data.phases : ['baseline', 'after'];
  if (!isDeepStrictEqual(data.phases, ['baseline', 'after']) && !isDeepStrictEqual(data.phases, ['after'])) {
    throw Error('Check phases must be baseline and after, or after only');
  }
  if (Object.hasOwn(data, 'input_paths')) {
    data.input_paths = items(data.input_paths, 'check input paths').map(name => relative(name, 'check input path'));
    if (data.input_paths.includes('.') || new Set(data.input_paths).size !== data.input_paths.length) {
      throw Error('Check input paths must be unique project-relative file paths');
    }
  }
  return data;
}

function benchmark(value, checks) {
  const data = row(value, ['id', 'name', 'check_id', 'fixtures', 'metrics', 'repetitions', 'thresholds', 'reset'], ['scripts']);
  identifier(data.id, 'benchmark ID');
  label(data.name, 'benchmark name', 120);
  const checkId = identifier(data.check_id, 'benchmark check ID');
  if (checks.get(checkId)?.phases.length !== 2) {
    throw Error(`Benchmark ${data.id} requires an existing baseline and after check`);
  }
  data.fixtures = unique(items(data.fixtures, 'fixtures').map(item => {
    const fixture = row(item, ['path', 'description']);
    fixture.path = relative(fixture.path, 'fixture path');
    label(fixture.description, 'fixture description');
    return fixture;
  }), 'path');
  data.scripts = items(Object.hasOwn(data, 'scripts') ? data.scripts : [], 'scripts').map(item => relative(item, 'script path'));
  if (new Set(data.scripts).size !== data.scripts.length) throw Error('Benchmark script paths must be unique');
  data.metrics = unique(items(data.metrics, 'metrics').map(entry => {
    const metric = row(entry, ['id', 'unit'], ['aggregate']);
    identifier(metric.id, 'metric ID');
    label(metric.unit, 'metric unit', 80);
    metric.aggregate = Object.hasOwn(metric, 'aggregate') ? metric.aggregate : 'median';
    if (!aggregates.has(metric.aggregate)) throw Error('Unsupported metric aggregate');
    return metric;
  }), 'id');
  if (!data.metrics.length) throw Error('A benchmark needs at least one metric');
  data.repetitions = integer(data.repetitions, 'repetitions', 1, 20);
  data.thresholds = items(data.thresholds, 'thresholds').map(entry => {
    const threshold = row(entry, ['metric', 'op', 'value']);
    const key = identifier(threshold.metric, 'threshold metric ID');
    if (!data.metrics.some(metric => metric.id === key)) throw Error(`Threshold refers to an unknown metric: ${key}`);
    if (!operators.has(threshold.op)) throw Error('Threshold operator must be lte, gte, or eq');
    number(threshold.value, 'threshold value');
    if (legacyFloats.has(entry)) legacyFloats.set(threshold, true);
    return threshold;
  });
  if (!data.thresholds.length) throw Error('A benchmark needs at least one threshold');
  data.reset = command(data.reset);
  return data;
}

function rubric(value) {
  const data = row(value, ['id', 'name', 'actor', 'stage', 'criteria']);
  identifier(data.id, 'rubric ID');
  label(data.name, 'rubric name', 120);
  if (!(data.actor === 'agent' && agentStages.has(data.stage)) &&
      !(data.actor === 'human' && data.stage === 'branch_review')) {
    throw Error('Use an agent audit stage or human Branch Review for a rubric');
  }
  data.criteria = unique(items(data.criteria, 'criteria').map(item => {
    const criterion = row(item, ['id', 'description', 'required']);
    identifier(criterion.id, 'criterion ID');
    label(criterion.description, 'criterion description');
    boolean(criterion.required, 'criterion required');
    return criterion;
  }), 'id');
  if (!data.criteria.length) throw Error('A rubric needs at least one criterion');
  return data;
}

export function validateQuality(definition) {
  const data = row(definition, ['schema_version', 'checks', 'benchmarks', 'rubrics']);
  integer(data.schema_version, 'schema_version', 1, 1);
  data.checks = unique(items(data.checks, 'checks').map(check), 'id');
  const checks = new Map(data.checks.map(item => [item.id, item]));
  data.benchmarks = unique(items(data.benchmarks, 'benchmarks').map(item => benchmark(item, checks)), 'id');
  unique(data.benchmarks, 'check_id');
  data.rubrics = unique(items(data.rubrics, 'rubrics').map(rubric), 'id');
  unique(data.rubrics, 'stage');
  return {revision: createHash('sha256').update(encodeQuality(data)).digest('hex'), definition: data};
}

export function lockedDefinition(value) {
  const normalized = validateQuality(value?.definition);
  if (normalized.revision !== value.revision || !isDeepStrictEqual(normalized.definition, value.definition)) {
    throw Error('Quality policy does not match its revision');
  }
  return normalized;
}

export function validPublication(value) {
  row(value, ['revision', 'definition', 'trial_id', 'published_at', 'trial_status', 'reviewer']);
  lockedDefinition(value);
  if (!['passed', 'failed'].includes(value.trial_status) || value.reviewer !== 'human' ||
      typeof value.trial_id !== 'string' || value.trial_id.length !== 32 || !trialIdPattern.test(value.trial_id)) {
    throw Error('Invalid Quality publication');
  }
  return value;
}
