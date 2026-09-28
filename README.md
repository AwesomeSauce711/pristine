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

The included GitHub Actions workflow builds and publishes the site on GitHub Pages when `main` changes. In the repository's **Settings → Pages**, choose **GitHub Actions** as the source. With no custom domain, it builds for `https://AwesomeSauce711.github.io/pristine/`.

To use `pristine4k.com`, set the repository variable `CUSTOM_DOMAIN` to `pristine4k.com` and set the same address in **Settings → Pages → Custom domain**. Point the domain's DNS `A` records to the GitHub Pages addresses in [GitHub's current instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site), and point `www` to `AwesomeSauce711.github.io`. Remove the old Railway DNS records only when the new site is ready. The Pages custom-domain setting handles the domain; a `CNAME` file is unnecessary for an Actions deployment. Once the domain serves the new site reliably, cancel the old Railway service to stop any recurring hosting charge.

## Donations

Using Pristine is free. Donations are optional and do not unlock features. Once the project owner has created a Buy Me a Coffee page, set `NEXT_PUBLIC_BUY_ME_A_COFFEE_URL` to its full `https://buymeacoffee.com/...` URL before building. The footer then shows the donation link. Add the same link to this README and the repository's About section.

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` and `npm run build` before submitting a change. The code is licensed under [MIT](LICENSE).
