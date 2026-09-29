# Upload Inspector 2.8.1

The report inspects playback and the saved-video URL separately when TikTok exposes both. A 720p/30 watermarked download can coexist with higher-quality playback. A readable container alone does not confirm camera-roll compatibility.

## Open a quality report

1. In Chrome, open `chrome://extensions`, enable Developer mode, and click **Reload** on the unpacked **Upload Inspector** extension. If it is not loaded yet, choose **Load unpacked** and select this folder.
2. Open or refresh a published TikTok video page or Instagram Reel. Allow a newly posted video time to process.
3. Click **Open quality report** in the inspector panel. The report opens in a new tab. No local server is needed for this report.
4. Use **Save readable report** to keep a standalone HTML copy that opens after the browser session ends. JSON export is also available.

The report lists declared renditions, decoded frames, compositor presentation rate, and metadata from the delivered MP4 when the CDN permits a small byte-range read. Stored fps is not treated as proof of displayed fps. It includes video frame count, codec/profile/level, audio sample counts, one-tick padding, and unspecified movie duration. A failed current post is never replaced by a preloaded video's measurements.

On TikTok's upload page, turn on **Prepare locally** before selecting a clean MP4 to prepare it in the background. **Automatic preset** uses two audio tracks for 4K/60 and 1080p/120, or the single-audio layout for HEVC 4K/120. It uses Pristine's MP4 preparation code, preserves video packet bytes, and needs no server. It does not publish for you. Already-prepared single-audio files pass through without being padded again. Preparation starts off; inspecting other people's videos does not change any files. Use the website first when resizing or changing the frame rate is needed.

4K/60 played on the test phone, but saved-video compatibility is still under investigation. A 1080p/120 file retained its frames while the phone displayed about 60 fps. See [the public test log](https://github.com/AwesomeSauce711/pristine/blob/main/docs/upload-tests.md). Other platforms' older optional transcoding tools still use the local service; that service is not needed for TikTok preparation or quality reports.

Another creator's delivered file cannot reveal their original upload settings or TikTok's private processing decisions. The report labels evidence separately from inference.
