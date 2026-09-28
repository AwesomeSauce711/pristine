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

The site is published from the `gh-pages` branch at <https://awesomesauce711.github.io/pristine/>. The repository's **Settings → Pages** source is **Deploy from a branch**, using `gh-pages` and `/`.

After changing the source, run `npm run publish` to build and push the static site. It uses your existing Git credentials. GitHub Actions cannot run on the owner's account while GitHub reports a billing lock, so publishing is a local command for now.

To use `pristine4k.com`, put that name in `.github/pages-domain`, run `npm run publish` again, and set the same name in **Settings → Pages → Custom domain**. Point the domain's DNS `A` records to the GitHub Pages addresses in [GitHub's instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site), and point `www` to `AwesomeSauce711.github.io`. Change the DNS only after the custom-domain build is ready. Once the domain serves the new site, cancel the old Railway service to stop any recurring hosting charge.

## Donations

Using Pristine is free. Donations are optional and do not unlock features. You can [buy the project a coffee](https://buymeacoffee.com/pristine4k) if you want to support it.

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` and `npm run build` before submitting a change. The code is licensed under [MIT](LICENSE).
