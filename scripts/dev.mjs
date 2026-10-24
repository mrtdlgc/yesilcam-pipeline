import { spawn } from 'node:child_process';
import { once } from 'node:events';
const build = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
const [code] = await once(build, 'exit');
if (code !== 0) process.exit(code ?? 1);
const server = spawn(process.execPath, ['build/server.js'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (status) => process.exit(status ?? 0));
