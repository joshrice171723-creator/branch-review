const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {port} = require('./local-origin.cjs');
const socket = net.connect({host:'127.0.0.1',port});
socket.once('connect', () => {socket.destroy();console.error('The Branch Review port is already in use: '+port);process.exitCode=1;});
socket.once('error', error => {
  if(error.code !== 'ECONNREFUSED') {console.error(`Could not check the Branch Review port: ${error.message}`);process.exitCode=1;return;}
  const child = spawn(process.execPath, [require.resolve('electron/cli.js'), '.'], {cwd:root, env:{...process.env, BRANCH_REVIEW_DEV:'1'}, stdio:'inherit'});
  child.on('error', error => {console.error(`Could not start Branch Review: ${error.message}`);process.exitCode=1;});
  child.on('exit', (code, signal) => {process.exitCode=code ?? (signal ? 1 : 0);});
});
