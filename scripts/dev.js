// One command for both halves: `npm run dev` starts the API (backend, :3000) and the Vite UI (frontend, :5173).
// `npm start` builds the UI once and serves it from the backend on :3000.
const { spawn } = require('child_process');
const path = require('path');

const prod = process.argv.includes('--prod');
const run = (name, cwd, args) => {
  const p = spawn('npm', args, { cwd: path.join(__dirname, '..', cwd), stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', (code) => { console.log(`[${name}] exited (${code})`); shutdown(code || 0); });
  return p;
};
const children = [];
let closing = false;
function shutdown(code) {
  if (closing) return; closing = true;
  children.forEach((c) => c.kill());
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (prod) {
  const b = spawn('npm', ['run', 'build'], { cwd: path.join(__dirname, '..', 'frontend'), stdio: 'inherit' });
  b.on('exit', (c) => { if (c) process.exit(c); children.push(run('backend', 'backend', ['start'])); });
} else {
  children.push(run('backend', 'backend', ['run', 'dev']));
  children.push(run('frontend', 'frontend', ['run', 'dev']));
}
