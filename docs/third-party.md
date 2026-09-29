# Third-party software

Pristine's own source is MIT licensed. Dependencies keep their original licenses.

The build copies the unmodified FFmpeg WebAssembly distributions into `public/encoder/`. They run as separate browser workers and are loaded only when conversion needs the software fallback.

- **@ffmpeg/ffmpeg**: MIT. [Source and license](https://github.com/ffmpegwasm/ffmpeg.wasm).
- **@ffmpeg/core and @ffmpeg/core-mt 0.12.10**: GPL-2.0-or-later. These builds include GPL libraries such as x264 and x265. [Build source, dependency source locations and scripts](https://github.com/ffmpegwasm/ffmpeg.wasm), [FFmpeg GPL v2 text](https://github.com/FFmpeg/FFmpeg/blob/master/COPYING.GPLv2). The original packages are available from npm; exact versions are recorded in `package-lock.json`.
- **Mediabunny and @mediabunny/aac-encoder**: MPL-2.0. [Source and licenses](https://github.com/Vanilagy/mediabunny). The AAC extension contains FFmpeg-derived components covered by its included notices.
- **coi-serviceworker**: MIT. [Source and license](https://github.com/gzuidhof/coi-serviceworker). Adds cross-origin isolation response headers on static hosting so threaded HEVC conversion can run. It does not upload or cache selected video files.
- **Next.js, React, Three.js, and other dependencies** retain the licenses shipped in their packages.

`npm ci` followed by `node scripts/build-encoder.mjs` reproduces the copied encoder assets from the locked npm packages. Pristine does not modify these binaries. For a rebuilt FFmpeg core, use the upstream Dockerfile and dependency build scripts linked above.
