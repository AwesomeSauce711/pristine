import { cp, mkdir, readdir } from 'node:fs/promises';
const destination = new URL('../public/encoder/', import.meta.url);
await mkdir(destination, { recursive: true });
await mkdir(new URL('threaded/', destination), { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js']) {
  await cp(new URL(`../node_modules/@ffmpeg/core-mt/dist/umd/${name}`, import.meta.url), new URL(`threaded/${name}`, destination));
}
await cp(new URL('../node_modules/coi-serviceworker/coi-serviceworker.js', import.meta.url), new URL('../public/coi-serviceworker.js', import.meta.url));
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await cp(new URL(`../node_modules/@ffmpeg/core/dist/umd/${name}`, import.meta.url), new URL(name, destination));
}
const wrapper = new URL('../node_modules/@ffmpeg/ffmpeg/dist/umd/', import.meta.url);
for (const name of (await readdir(wrapper)).filter(name => name.endsWith('.js'))) {
  await cp(new URL(name, wrapper), new URL(name, destination));
}
