import { build } from 'esbuild';
await build({ entryPoints: ['src/lib/mp4/extension-entry.ts'], outfile: 'extension/single-audio.js',
  bundle: true, format: 'iife', globalName: 'PristineUpload', platform: 'browser' });
