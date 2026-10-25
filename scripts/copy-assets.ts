import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Invoked only after the compiler by `npm run build` (including Docker builds).
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const directory of ['public', 'scripts']) {
  for (const file of await fs.readdir(path.join(project, directory), { recursive: true })) {
    if (
      !/\.(html|css|svg|py|json|txt)$/.test(file) ||
      file.startsWith('tests/') ||
      file.startsWith('legacy/')
    )
      continue;
    const source = path.join(project, directory, file);
    if (!(await fs.stat(source)).isFile()) continue;
    const target = path.join(project, 'build', directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}
await fs.copyFile(
  path.join(project, 'transcription-matrix.example.json'),
  path.join(project, 'build', 'transcription-matrix.example.json'),
);
// Pinned, same-origin browser engine. No CDN or user media requests leave the app.
for (const [name, directory] of [
  ['ffmpeg', 'ffmpeg-0.12.15'],
  ['core', 'ffmpeg-core-0.12.10'],
]) {
  const source = path.join(project, 'node_modules', '@ffmpeg', name, 'dist', 'esm');
  const target = path.join(project, 'build', 'public', 'vendor', directory);
  await fs.mkdir(target, { recursive: true });
  for (const file of await fs.readdir(source)) {
    if (/\.(js|wasm)$/.test(file))
      await fs.copyFile(path.join(source, file), path.join(target, file));
  }
}
