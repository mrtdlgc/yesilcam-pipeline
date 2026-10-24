import { spawn } from 'node:child_process';
import { at } from './files.js';
import { childEnvironment } from './process.js';

// Kernel advisory locks work across containers sharing the same local volume.
// PID files do not: a replacement container can reuse the previous PID.
export async function acquireInstanceLock(): Promise<() => Promise<void>> {
  const child = spawn(
    'flock',
    [
      '--nonblock',
      '--conflict-exit-code',
      '73',
      at('data', 'server.lock'),
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() },
  );
  let released = false;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Queue lock timed out'));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(
        new Error(
          'Another server owns this data volume. Use one replica and stop it before replacement.',
        ),
      );
    });
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stderr.resume();
  });
  child.once('exit', () => {
    if (!released) {
      console.error('Queue ownership lost');
      process.exit(1);
    }
  });
  return async () => {
    released = true;
    child.stdin.end();
    await closed;
  };
}
