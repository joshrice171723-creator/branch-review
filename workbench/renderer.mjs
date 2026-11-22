
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const views = ['mcp-client','live','design','design-progress','quality','project-conversation','app'];
const styles = ['styles.css','design-progress.css','design-ux.css','quality.css'];
const root = new URL('./ui/', import.meta.url);
let renderer;

export function workspaceRenderer() {
  renderer ||= compile().catch(error=>{renderer=undefined;throw error;});
  return renderer;
}

async function compile() {
  const [template,entry,...scripts] = await Promise.all([
    readFile(new URL('template.html',root),'utf8'), readFile(new URL('entry.js',root),'utf8'),
    ...views.map(name=>readFile(new URL(name+'.js',root),'utf8'))
  ]);
  const source = [
    'import {WorkbenchProfile, modelCatalog, presetDocuments} from "/workspace-profile.js";',
    'const workspaceMarkup = '+JSON.stringify(template)+';',
    'const workspaceStyles = '+JSON.stringify(styles)+';',
    entry,
    'async function createWorkbench(panelRoot, {dispose, embedded, hostOptions, panelUrl, signal, setTimeout, clearTimeout}) {',
    ...scripts,
    '}'
  ].join('\n;\n');
  return {source,etag:'"'+createHash('sha256').update(source).digest('hex')+'"'};
}
