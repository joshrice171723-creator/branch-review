const fs = require('node:fs');
const path = require('node:path');

function configureBundledRuntimes(runtimeDirectory, environment = process.env) {
  const root = fs.realpathSync(runtimeDirectory);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'windows-runtimes.json'), 'utf8'));
  const tools = {};
  for (const name of ['python', 'ruby', 'node']) {
    const relative = receipt[name]?.executable;
    if (typeof relative !== 'string') throw Error('The bundled Workbench runtime is incomplete. Reinstall Branch Review.');
    const executable = fs.realpathSync(path.join(root, relative));
    const inside = path.relative(root, executable);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(executable).isFile()) {
      throw Error('The bundled Workbench runtime is invalid. Reinstall Branch Review.');
    }
    tools[name] = executable;
  }
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const entries = (environment[pathKey] || '').split(path.delimiter).filter(Boolean);
  for (const [name, executable] of Object.entries(tools)) {
    environment[`HARNESS_${name.toUpperCase()}`] = executable;
    const directory = path.dirname(executable);
    if (!entries.some(entry => entry.toLowerCase() === directory.toLowerCase())) entries.push(directory);
  }
  environment[pathKey] = entries.join(path.delimiter);
  return tools;
}

module.exports = {configureBundledRuntimes};
