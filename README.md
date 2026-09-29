# Pristine

Pristine is a free, open-source browser tool for converting and preparing videos for TikTok. There is no account, payment, upload, or application server. The file stays on your device.

**Latest update — September 28, 2026:** all three export presets, local video conversion, quality reports, optional sounds, and a desktop layout that fits on one screen. Optional donations appear at the bottom of the main page. [Instagram comparison results](docs/instagram-tests.md) currently show 720p/30 playback for both tested files, so the tool remains focused on TikTok.

## How it works

Choose **4K/60**, **1080p/120**, or **4K/120**, select a video, and download the prepared MP4. MP4, MOV, WebM and other supported containers can be read. The browser resizes the picture to the selected dimensions, keeps its aspect ratio with padding, and repeats or drops frames to reach the selected frame rate. Upscaling does not create extra source detail, and repeating 30 fps frames does not create true 120 fps motion. 4K/120 uses HEVC; the other presets use H.264 when conversion is needed.

Encoding runs locally using the browser's encoder when available, with FFmpeg WebAssembly as a software fallback. Large clips can be slow or exceed the device's available memory. A cancel button stops conversion. Already matching, compatible MP4s can skip re-encoding. If a matching MP4 needs its audio normalized, the original video packets are copied while the first audio track is converted to stereo AAC. The output is checked before download.

After conversion, the MP4 preparation step changes audio sample tables and container metadata. This step preserves the video packets and frame count; it never duplicates the video track or makes the video ten times longer. Silent files receive an AAC track. The page includes optional click and file-selection sounds with a remembered mute setting.

Pristine may not always work. TikTok can change quality at upload time or later. The current method retained high-resolution files in published tests. Camera-roll playback remains unreliable in the test group, and file frame rate is different from displayed frame rate. See [test results and limitations](docs/upload-tests.md). Check the published video; the Studio preview is not proof. Pristine is not affiliated with TikTok or ByteDance.

## Run locally

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. To check the MP4 logic and build the static site:

```bash
npm run verify
npm run build
```

`npm run build` writes the website to `out/`. No database, email service, Stripe account, or server runtime is needed.

## Publish

The site is live at <https://pristine4k.com/>. GitHub Pages publishes the `gh-pages` branch from `/` and serves the custom domain over HTTPS.

After changing the source, run `npm run publish` to build and push the static site. It uses your existing Git credentials.

The custom domain is recorded in `.github/pages-domain`. Namecheap points the `@` ALIAS and `www` CNAME to `awesomesauce711.github.io`; existing email records remain separate. Railway is no longer required for Pristine.

## Donations

Donations help fund the creation of these free tools. Donations are optional and do not unlock features. [Buy me a coffee](https://buymeacoffee.com/pristine4k).

## Chrome extension

The [Upload Inspector extension](extension/README.md) opens quality reports for published videos and can prepare a selected TikTok upload locally. Load `extension/` unpacked in Chrome. After editing the shared MP4 code, run `node scripts/build-extension.mjs` to rebuild its browser bundle. It adds no paid service.

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` and `npm run build` before submitting a change. Pristine's own code is licensed under [MIT](LICENSE); bundled dependencies retain their [own licenses](docs/third-party.md).
