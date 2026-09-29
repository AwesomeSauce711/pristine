# Instagram comparison — 28 September 2026

Account: `@pristine4ktool`. The same prepared files used for TikTok were uploaded through Instagram's website. Measurements below came from each **published Reel's** embedded rendition manifest and MP4 version list, not its upload preview.

| Input | Published Reel | Observed delivered video |
| --- | --- | --- |
| J: 2160×3840, nominal 60 fps, 720 frames; normal first audio plus padded second audio | [4K/60 comparison, original framing](https://www.instagram.com/pristine4ktool/reel/Dd2rvZkuHnO/) | 716×1274, 30 fps, H.264; Instagram labels it 720p. |
| K: 1080×1920, nominal 120 fps, 1,440 frames; same audio layout | [1080p/120 comparison, original framing](https://www.instagram.com/pristine4ktool/reel/Dd2qPIKus0r/) | 716×1274, 30 fps, H.264; Instagram labels it 720p. |

Both DASH manifests declare `frameRate="15360/512"`, which is 30 fps. Both progressive version lists expose the same 716×1274 dimensions. The browser's displayed height can differ slightly because of pixel aspect ratio. These measurements describe the renditions exposed at observation time; later processing or another client can differ.

The initial J upload used Instagram's default square crop and became [716×716 at 30 fps](https://www.instagram.com/pristine4ktool/reel/Dd2osf-upnU/). It was repeated with **Original** framing to avoid relying on that cropped comparison.

Neither requested preset retained its resolution/frame rate in these Instagram observations. Instagram is therefore not offered as a website preparation option. At the user's request, 4K/120 was not tested on Instagram.
