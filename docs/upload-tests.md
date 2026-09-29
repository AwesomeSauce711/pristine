# Published upload tests — 28 September 2026

These observations are specific to the test account and date. The Studio preview is not a delivery measurement. No claim here guarantees future TikTok processing or playback on every device.

## Results

| Test | Source and change | Published result |
| --- | --- | --- |
| [A](https://www.tiktok.com/@_awesomesxuce/video/7690748062364421406) | 4K/60, older duplicate audio 10× | Re-encoded to 720p/30. |
| [B](https://www.tiktok.com/@_awesomesxuce/video/7690748336336391454) | 4K/60, single audio 10×, unspecified movie duration | User confirmed 4K/60 on phone. Desktop AAC decode error. |
| [C](https://www.tiktok.com/@_awesomesxuce/video/7690750459824360735) | B with valid AAC silence packets | User confirmed 4K/60 on phone; desktop plays. Public MP4 byte-identical to upload. User later reported camera-roll playback failures in this test group. |
| [D](https://www.tiktok.com/@_awesomesxuce/video/7690750814511435038) | 1080p/120, B layout | User downloaded a 1080p/120 file, but TikTok playback skipped alternate counter numbers (about 60 fps). **120 fps display is not verified.** |
| [E](https://www.tiktok.com/@_awesomesxuce/video/7690751089750166815) | 4K/120, H.264 Level 6, B layout | Original-sized file retained. User could not download it. Not verified working. |
| [F](https://www.tiktok.com/@_awesomesxuce/video/7690753864064044319) | 4K/60, independent Pristine implementation of C | Published file retains 2160×3840, 720 frames; desktop plays. |
| [G](https://www.tiktok.com/@_awesomesxuce/video/7690755927741451551) | F with movie duration restored to 12 s | Re-encoded to 720p. Restoring duration alone did not retain 4K. |
| [H](https://www.tiktok.com/@_awesomesxuce/video/7690755926235581727) | Older duplicate-audio layout with unspecified movie duration | Re-encoded to 720p. |
| [I](https://www.tiktok.com/@_awesomesxuce/video/7690756601069784350) | HEVC Main Level 5.2, 4K/120, valid AAC silence | Public page retains original-sized 4K file and plays on desktop. User reports downloaded file labeled 4K/120 but incorrect download/playback in camera roll; actual 120 fps display unconfirmed. |
| [J](https://www.tiktok.com/@_awesomesxuce/video/7690759429557456159) | Newer layout with a normal first AAC track and padded second track | Public page retains original-sized 4K file; 720 video frames, 563 normal AAC samples and 5,630 padded-track samples. User confirms it saved as 4K/60; camera-roll compatibility is not established. |
| [K](https://www.tiktok.com/@_awesomesxuce/video/7690768798307175710) | 1080p/120 with normal first AAC track and padded second track | Published page reports no review pending and retains the original 68,665,231-byte file. Source has 1,440 frames at nominal 120 fps (119.834 average after the historical timing adjustment). Actual phone display rate was not separately measured for K. |

Clean 4K/60, 1080p/120 and 4K/120 control uploads earlier that day all became 720p/30 after publication.

## What the current option changes

The browser copies the compressed video packets, keeping their count and content. It does **not** duplicate the video track, create extra video frames, upscale, or interpolate.

The upload layout appends nine extra packets per existing AAC packet to a separate second audio track, each timed at one audio timescale tick. It preserves the original video sample timing and edit lists, includes all added ticks in the audio media duration, and retains the original finite audio presentation interval. It also rebuilds offsets and bitrate fields, moves the index to the front, and sets the movie duration to the ISO-BMFF unspecified value. The video track still supplies its finite duration. Earlier output removed edit lists and stretched the final video sample; the current repair reproduces the phone-confirmed N/O comparisons below.

Standard uses valid AAC-LC stereo silence in the added eight-byte packets. The original test B option retains the raw eight-byte packet pattern for reproducibility; it can fail AAC decoding. Stereo AAC-LC is required for Standard. Silent input receives a small silent track. Already-prepared files and unsupported complex/fragmented MP4s are rejected rather than silently damaged.

The site has three choices: **4K/60**, **1080p/120**, and **4K/120**. All three now preserve normal audio in the first track and add a padded second track, using the repaired N/O presentation timing. The 4K/120 option uses HEVC. Stored, decoded and displayed rates remain separate evidence.

The website now converts mismatched inputs locally before applying the audio/container preparation. It resizes with aspect-preserving padding and repeats or drops frames to reach the requested cadence. These generated constant-rate files have their video sample timing normalized after encoding so AAC priming cannot stretch their first or last frame. The video track is never duplicated. Existing compatible exports can skip conversion and retain their compressed packets. Historical single-audio B/C options remain in the source for reproducibility, outside the simplified site interface.

## Evidence and limits

### End-of-video and saved-file follow-up

The user reported that I stops around counter 713–714 on the phone, and that the larger 4K/60 file also pauses at the end. Local decoding of I finds all 720 frames, including counter 719. Its small 1,578,525-byte size reflects a simple HEVC test pattern and does not establish the cause of the pause. Increasing file size alone is not a demonstrated fix.

The reference files retain edit lists and constant video sample timing. I/J remove those edit lists, stretch their last video sample, and declare padded audio media durations that do not include all appended sample ticks. Two comparisons preserve the original video timing and edit lists, use normal first audio, and correct the padded audio media duration:

| Comparison | Local decoding | Published observation |
| --- | --- | --- |
| [N: 4K/60](https://www.tiktok.com/@_awesomesxuce/video/7690784981081263391) | 720 frames, exactly 60 fps, video and playable audio 12 s | Public, not under review; original 34,586,271-byte file retained. User confirms normal TikTok playback/looping. Saved copies still crash Photos. |
| [O: 4K/120 HEVC](https://www.tiktok.com/@_awesomesxuce/video/7690785857225182495) | 720 frames, exactly 120 fps, 6 s video; playable audio 6.016 s | Public, not under review; original 1,581,410-byte file retained. User confirms normal TikTok playback/looping, but alternate counter numbers are skipped, with even/odd switching during playback. Download is labeled 120 fps; saved copies still crash Photos. |

These timing repairs are now applied to all three website presets. On the same source files, the website's preparation function produces byte-for-byte identical N and O files. The 1080p/120 source retains all 1,440 frames at exactly 120 fps using the same timing logic; this repaired variant has not separately been checked on a phone.

The loop result does not establish Photos compatibility: the user reports that playing a saved copy and opening its information panel crashes Photos. The cause has not been isolated. Controlled follow-ups separately test a finite overall movie duration and a non-default auxiliary audio track, retaining the same compressed video and 10× audio sample count.

| Photos comparison | Single change from N | Published observation |
| --- | --- | --- |
| [P](https://www.tiktok.com/@_awesomesxuce/video/7690814943561518366) | Set the overall movie duration to 12 seconds | Public page re-encoded it to 720×1280, with a 1,211,399-byte `normal_720_0` rendition. Not promoted because it loses the retained 4K result. |
| [Q](https://www.tiktok.com/@_awesomesxuce/video/7690815699937168670) | Clear the padded audio track's enabled/default flag | Public page retains 4K and plays on desktop; phone looping and Photos information-panel behavior awaiting verification. Not yet promoted. |

The @siesta.ae reference downloads as a playable 720p/30 file with a TikTok watermark, despite higher-quality playback; our earlier retained originals downloaded without that watermark. Playback and saved downloads therefore need separate measurements. A browser cannot verify Apple Photos playback on the user's phone.

### Other measurements

- Original 4K/60 source: 2160×3840, 720 video frames, one AAC track with 563 samples.
- C/F: the same 720 compressed video frames, one AAC track with 5,630 samples (5,067 appended), roughly 12 seconds of video. The average sample-table rate is 59.834 because edit-list removal changes the last video sample's timing slightly.
- SHA-256 of the compressed video packet sequence before and after preparation: `a53c919ba9169665fe6a86818ea62e409eeb495dbb8c5caa794db1917c5ffeb4`.
- C public MP4 SHA-256 equals the uploaded file: `48ef87366acef8d34761146c97dddabc4ab142167bc118cd5185b9eec571148d`.
- F public MP4 SHA-256 equals the website-generated file: `022669b27e394242a8dc0767b333c8e52d1e6f4d49a364dda297254a9c5d6ffe`.
- D public MP4 SHA-256 equals the uploaded 1080p/120 file: `ad6d430df3d7b159bd545417881a82790e8f21ec68e7bc0a8525b18f3055c988` (1,440 frames, 119.834 average fps). This does not override the phone's observed 60 fps presentation.
- The selected post must be measured explicitly. TikTok preloads other posts; a failed current player must not cause the inspector to report a neighboring video.
- An empty rendition list does not prove that processing is complete. Report the publication status, observation time, delivered file and actual playback separately.
- File fps, decoded fps and compositor presentation fps are different. A 120 fps file can play at 60 fps. A browser cannot measure a phone's display.
- A public file exposes its delivered container and bitstream. It cannot reveal the creator's original upload, editing history, private processing decisions, or the exact cause of a retention result.

The public reference files supplied by the user contain duplicate AAC tracks with a 10× sample-count ratio and finite movie durations. Repeating the older recipe did not reproduce their delivery result in test A. The current comparator was researched from the [official extension listing](https://chromewebstore.google.com/detail/tiktok-quality-method-by/imgecnpbinmgiflbfhnpkkccomodkhch), version 3.7.0; no third-party extension source is included in this repository. Pristine implements the measured container operations using its own MP4 helpers.

HEVC experiments use an encoder-enforced profile and level. See the [x265 level table](https://github.com/videolan/x265/blob/master/source/encoder/level.cpp) and [encoder options](https://x265.readthedocs.io/en/master/cli.html). Codec support still depends on the actual player and device.
