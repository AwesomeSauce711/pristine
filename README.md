# Pristine

Free, open-source video conversion and TikTok upload preparation. Choose **4K/60**, **1080p/120**, or **4K/120**. Your video is processed on your own device.

**Last updated: September 28, 2026.** The current version includes all three presets, faster preparation for matching videos, optional sound effects, and a one-page desktop layout. This update adds complete local setup instructions and removes the Chrome extension.

## Two ways to use Pristine

| Option | What you need | Where your video is processed |
| --- | --- | --- |
| **1. Use the website** | Open [pristine4k.com](https://pristine4k.com/) in your browser. Nothing to install. | On your device. |
| **2. Run your own local copy** | Download the source and follow the setup steps below. | On your device, through a website running on your computer. |

Both options have the same features and are free. No account, subscription, browser extension, API key, or paid server is required. Donations are optional.

## Option 1: Use the website

1. Open **[pristine4k.com](https://pristine4k.com/)** in Chrome or Edge for the broadest conversion support.
2. Choose **4K/60**, **1080p/120**, or **4K/120**.
3. Click **Choose a video** and select your file, or drag it onto the page.
4. Click **Convert & download**. Keep the tab open until it says **File ready**. You can cancel while it is working.
5. Save the prepared MP4. If the automatic download does not start, click **Save the prepared file again**.
6. Upload that MP4 to TikTok without editing or re-exporting it first. Check the published video; the upload preview does not prove the final playback quality.

## Option 2: Run it on your computer

These steps work on Windows, macOS, and Linux. You need an internet connection to download the project and install its dependencies. You do not need a domain, GitHub account, or separate FFmpeg installation.

### 1. Install Node.js

Download and install the **LTS** version from [nodejs.org](https://nodejs.org/en/download). Node.js 22 or newer is required; the installer includes npm. Open a new terminal after installation so it can find the new commands.

### 2. Download the project

On [this repository's main page](https://github.com/AwesomeSauce711/pristine), click the green **Code** button, then **Download ZIP**. Extract the ZIP into a folder you can find, such as Downloads. The extracted project folder is normally called `pristine-main`.

### 3. Open a terminal in that folder

- **Windows:** open the extracted `pristine-main` folder in File Explorer. Click the address bar, type `cmd`, and press Enter. This opens Command Prompt in the project folder.
- **macOS or Linux:** open Terminal, type `cd ` (including the space), drag the extracted folder into the terminal, and press Enter. You can also type `cd` followed by the folder's full path in quotes.

You should be in the folder containing `package.json`. Check that Node.js and npm are available:

```sh
node --version
npm --version
```

### 4. Install the project's dependencies

Run this command and wait for it to finish:

```sh
npm ci
```

This downloads the versions recorded in `package-lock.json`. You only need this step for the first setup or after downloading an update.

### 5. Start Pristine

Run:

```sh
npm run dev
```

The startup command automatically prepares the bundled video encoder. When the terminal says the site is ready, open **[http://localhost:3000](http://localhost:3000)** in Chrome or Edge. If port 3000 is already in use, open the **Local** address printed in the terminal instead.

Keep the terminal open while using the app. Choose a preset and video, then click **Convert & download**, just as on the public website. Your selected video stays on your device. No `.env` file, login, database, email service, or payment setup is needed.

### 6. Stop it or open it again later

Press **Ctrl+C** in the terminal to stop the local website. To use it again, open a terminal in the same project folder and run `npm run dev`. You do not need to repeat `npm ci` every time.

### 7. Get an update

Download a fresh ZIP from this repository, extract it into a new folder, and repeat steps 3–5. If you have changed the source yourself, keep your old folder so you can bring those changes over.

### If setup does not work

| Message or problem | What to do |
| --- | --- |
| `node` or `npm` is not recognized / command not found | Install Node.js LTS, then close and reopen your terminal. |
| `package.json` cannot be found | Open the extracted project folder containing `package.json` before running the commands. |
| PowerShell says scripts are disabled | Use Windows Command Prompt as described in step 3. You do not need to change your system's security settings. |
| The browser says to reload for 4K conversion | Reload the page once, then choose your file again. |
| Conversion is slow or runs out of memory | Keep the tab open, close other heavy applications, or try a shorter clip on a desktop computer. Changing resolution, frame rate, or codec requires more work. |

## What it does

- Reads MP4, MOV, WebM, and other supported video files.
- Resizes to the selected dimensions, keeps the picture's aspect ratio with padding, and repeats or drops frames to reach the selected frame rate.
- Uses HEVC for 4K/120, and H.264 for the other presets when video encoding is needed.
- Keeps the original compressed video when a matching MP4 can be prepared directly. If only its audio needs normalization, it copies the video packets and converts the first audio track to stereo AAC.
- Prepares the MP4's audio sample tables and container metadata for upload, then checks the output dimensions and frame rate. This step never duplicates the video track or makes the video ten times longer. Silent files receive an AAC track.
- Runs encoding in your browser, using its encoder when available and bundled FFmpeg WebAssembly otherwise. Optional click and file-selection sounds have a remembered mute setting.

## Limitations

Pristine may not always work. TikTok can change quality at upload time or later. Upscaling does not create extra source detail, and repeating 30 fps frames does not create true 120 fps motion. A file's recorded frame rate is different from the frame rate actually displayed by TikTok.

Published tests retained high-resolution files, but camera-roll playback and pauses at the end remain unresolved in the test group. See the [TikTok test results](docs/upload-tests.md). [Instagram comparisons](docs/instagram-tests.md) produced approximately 720p/30 playback for both tested files, so the website currently offers TikTok preparation only. Pristine is not affiliated with TikTok or ByteDance.

## Development and hosting

To check the code and build a static copy:

```sh
npm run lint
npm run verify
npm run build
```

`npm run build` writes the website to `out/`. Static hosting does not need a database or application server. Open the local copy with `npm run dev`; opening `out/index.html` directly as a file does not provide the browser environment the encoder needs.

<details>
<summary>Maintainer publishing notes</summary>

The public site uses GitHub Pages with the custom domain `pristine4k.com`. `npm run publish` builds the static site and pushes it to the `gh-pages` branch using the repository's configured Git remote and your existing Git credentials. It requires write access to that repository; it is not part of local setup.

The domain is recorded in `.github/pages-domain`. If hosting a fork, configure your own remote, Pages settings, and domain first. Railway is not required for this project.

</details>

## Questions or bugs

Discord: **awesomesaucebs**

## Donations

Donations help fund the creation of these free tools. Donations are optional and do not unlock features. [Buy me a coffee](https://buymeacoffee.com/pristine4k).

## License and contributions

Pristine's own code is licensed under [MIT](LICENSE); dependencies retain their [own licenses](docs/third-party.md). Issues and pull requests are welcome. Run the checks above before submitting code changes.
