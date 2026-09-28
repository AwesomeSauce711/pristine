# Pristine

Pristine is a free, open-source browser tool for preparing MP4 videos for TikTok. There is no account, payment, upload, or application server. The file stays on your device.

## How it works

The browser reads the MP4 file's `ftyp` and `moov` boxes to inspect its tracks and properties. When you download, Pristine copies the file index, adds a decoy audio track with extra samples, adjusts the MP4 tables and offsets, and assembles a new file from the original video data. It does not decode, re-encode, upscale, or modify the video frames. If a file has no audio track, it adds a silent AAC track first.

This method depends on how TikTok currently processes uploads. TikTok can change that behavior, and results are not guaranteed for every file or every viewer. Pristine is not affiliated with TikTok or ByteDance.

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

Using Pristine is free. Donations are optional and do not unlock features. You can [buy the project a coffee](https://buymeacoffee.com/pristine4k) if you want to support it.

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` and `npm run build` before submitting a change. The code is licensed under [MIT](LICENSE).
