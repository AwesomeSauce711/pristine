"""
demo-pair.py -- weld the two TikTok renditions into one side-by-side file.

NOT WHAT THE LANDING PAGE SHOWS ANY MORE. The landing comparison is now the tool
page's preview fed a bundled clip of the pristine rendition (see
src/components/CompareStage.tsx); the two-rendition weld this builds was never
reliable on a phone. Kept because the measurement it does -- the offset between
TikTok's two renditions, and the cuts -- is the record of how those files
actually relate, and because a real-against-real comparison may be wanted again.

    python scripts/demo-pair.py <crushed.mp4> <pristine.mp4> [out-dir]

WHAT THE LANDING COMPARISON IS
One file, both renditions side by side: what TikTok served for an ordinary
upload in the left half (720p, 30fps), what it served for the patched upload
in the right (2160p, 60fps), each re-encoded to the same display size. The
slider draws both halves from the same frame of that one file, so they can
never drift. This script makes that file.

WHY IT IS NOT JUST hstack
Two things were found the hard way, by measuring, after the halves had been
reported as "cutting scenes at two different points":

  1. TikTok's two renditions are not trimmed to the same frame. Ours were
     offset by about 2.5 frames at 60fps (~42ms) -- invisible on a slow first
     frame, unmistakable at a cut. So the crushed rendition is cross-correlated
     against the pristine one, frame by frame, and shifted by the offset found.

  2. A 30fps clip shown against a 60fps one holds each frame for two, so at a
     cut that falls on an odd frame it switches scenes one frame late, every
     time, by arithmetic. So the holds are placed adaptively: where a cut would
     land late, that hold starts a frame early, and both halves change scene on
     the same frame. No frames are invented -- the same real 30fps frames, with
     their boundaries put on the cuts. The frame-rate difference stays real
     everywhere else, which is the point of showing it.

It prints every measurement it makes. If the offset sweep does not show a
clear peak, or the cut lists do not pair up, stop and look rather than ship.
"""

import math
import os
import re
import subprocess
import sys
import tempfile

W, H, FPS = 540, 960, 60
CUT_SCORE = 8.0          # scdet score (0-100) above which a frame is a cut
SWEEP = range(-6, 7)     # offsets tried, in 60fps frames


def run(args, capture=True):
    r = subprocess.run(args, capture_output=capture, text=True)
    if r.returncode != 0:
        sys.exit(f"failed: {' '.join(args)}\n{r.stderr[-2000:] if capture else ''}")
    return (r.stdout or '') + (r.stderr or '')


def probe_fps(path):
    out = run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
               'stream=r_frame_rate', '-of', 'csv=p=0', path]).strip()
    a, b = out.split('/')
    return float(a) / float(b)


def scene_cuts(path, vf=''):
    """Frames whose scdet score is a local maximum above CUT_SCORE."""
    out = run(['ffmpeg', '-v', 'info', '-i', path, '-vf',
               f'{vf}scdet=t=0,metadata=mode=print:key=lavfi.scd.score', '-f', 'null', '-'])
    out = re.sub(r'^\[[^\]]*\] ', '', out.replace('\r', ''), flags=re.M)
    rows = [(int(n), float(s)) for n, s in
            re.findall(r'frame:(\d+)\s+pts:\S+\s+pts_time:\S+\s*\n\s*lavfi\.scd\.score=([0-9.]+)', out)]
    scores = dict(rows)
    cuts = []
    for n, s in rows:
        if s >= CUT_SCORE and s >= scores.get(n - 1, 0) and s > scores.get(n + 1, 0):
            cuts.append(n)
    return cuts, len(rows)


def extract(path, into, vf):
    os.makedirs(into, exist_ok=True)
    run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-vf', vf, '-start_number', '0',
         os.path.join(into, '%04d.png')])
    return len(os.listdir(into))


def mean_ssim(a_dir, a_start, b_dir, b_start, frames):
    out = run(['ffmpeg', '-v', 'error', '-start_number', str(a_start), '-i', os.path.join(a_dir, '%04d.png'),
               '-start_number', str(b_start), '-i', os.path.join(b_dir, '%04d.png'),
               '-frames:v', str(frames), '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-'])
    vals = [float(x) for x in re.findall(r'All:([0-9.]+)', out)]
    return sum(vals) / len(vals) if vals else 0.0


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    crushed, pristine = sys.argv[1], sys.argv[2]
    out_dir = sys.argv[3] if len(sys.argv) > 3 else 'public/demo'
    tmp = tempfile.mkdtemp(prefix='demo-pair-')
    print(f'work dir: {tmp}')

    cfps = probe_fps(crushed)
    print(f'crushed rendition: {cfps:g} fps   pristine rendition: {probe_fps(pristine):g} fps')

    # 1. Both at display size. The pristine side at 60; the crushed side at its
    #    own rate -- its frames are what they are.
    pris60 = os.path.join(tmp, 'pristine.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-i', pristine, '-an', '-vf', f'scale={W}:{H}:flags=lanczos,fps={FPS}',
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', pris60])
    cru = os.path.join(tmp, 'crushed.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-i', crushed, '-an', '-vf', f'scale={W}:{H}:flags=lanczos',
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', cru])

    # 2. The offset. Compare the crushed side, plainly duplicated up to 60, against
    #    the pristine side at every shift; the peak is the real offset. Small
    #    thumbnails are enough for this and make the sweep fast.
    small = f'scale={W // 2}:{H // 2}'
    p_dir, c_dir = os.path.join(tmp, 'P'), os.path.join(tmp, 'C60')
    n_p = extract(pris60, p_dir, small)
    n_c = extract(cru, c_dir, f'fps={FPS},{small}')
    frames = min(n_p, n_c) - max(abs(d) for d in SWEEP) - 1
    print(f'offset sweep over {frames} frames (crushed[n] vs pristine[n+d]):')
    best = None
    for d in SWEEP:
        v = mean_ssim(c_dir, max(0, -d), p_dir, max(0, d), frames)
        print(f'  d={d:+d}  {v:.4f}')
        if best is None or v > best[1]:
            best = (d, v)
    d, v = best
    if d in (SWEEP.start, SWEEP.stop - 1):
        sys.exit('the peak is at the edge of the sweep -- widen SWEEP and look at the footage')
    # crushed[n] matches pristine[n+d]: the crushed side leads by d frames at 60.
    # A positive d means the crushed side runs early and must be delayed; negative,
    # it runs late and its first frames are dropped.
    # The crushed side can only sit on its own frame grid -- at 30fps, every
    # other 60fps position -- so a peak of two and a half frames is a tie
    # between two shifts, and rounding picks the wrong one half the time. It
    # did: the first run rounded 1.5 crushed frames up to 2 and the finished
    # file came out leading by two. So both candidates are tried and the one
    # that measures better at zero offset is kept.
    raw = abs(d) * cfps / FPS
    scored = []
    for k in sorted({math.floor(raw), math.ceil(raw)}):
        sh = round(k * FPS / cfps)  # the candidate, in 60fps frames
        s_ = mean_ssim(c_dir, sh if d < 0 else 0, p_dir, 0 if d < 0 else sh, frames)
        scored.append((s_, k))
        print(f'  shift of {k} crushed frame(s) measures {s_:.4f} at zero offset')
    best_k = max(scored)[1]
    drop = best_k if d < 0 else -best_k
    print(f'peak at d={d:+d} ({v:.4f}): crushed side {"lags" if d < 0 else "leads"} '
          f'-> {"drop" if drop > 0 else "delay by"} {abs(drop)} crushed frame(s)')

    # 3. The cuts, in each rendition's own frames.
    p_cuts, n_p60 = scene_cuts(pris60)
    c_cuts, n_cru = scene_cuts(cru)
    print(f'pristine cuts (60fps frames): {p_cuts}')
    print(f'crushed cuts ({cfps:g}fps frames): {c_cuts}')

    # 4. The hold map: output frame n shows crushed source frame j.
    total = n_p60
    def plain(n):
        return max(0, min(n_cru - 1, int(n * cfps / FPS) + drop))
    j = [plain(n) for n in range(total)]
    holds = []
    for c in p_cuts:
        expect = plain(c)
        # the crushed cut that begins the same scene: nearest to where it should be
        near = min(c_cuts, key=lambda x: abs(x - expect)) if c_cuts else None
        if near is None or abs(near - expect) > 2:
            print(f'  cut at pristine frame {c}: no crushed cut near expected frame {expect} -- left alone')
            continue
        n = c
        while n < total and j[n] < near:
            j[n] = near
            holds.append(n)
            n += 1
        # and never show the new scene before the cut
        n = c - 1
        while n >= 0 and j[n] >= near:
            j[n] = near - 1
            holds.append(n)
            n -= 1
    print(f'adaptive holds at output frames: {sorted(holds)}')

    # 5. Weld. The crushed side is fed from the source frames by the map, so the
    #    file's frame n really is crushed frame j[n] beside pristine frame n.
    src_dir = os.path.join(tmp, 'CSRC')
    extract(cru, src_dir, 'null')
    lst = os.path.join(tmp, 'list.txt')
    with open(lst, 'w') as f:
        for n in range(total):
            f.write(f"file '{os.path.join(src_dir, f'{j[n]:04d}.png').replace(os.sep, '/')}'\nduration {1 / FPS:.7f}\n")
        f.write(f"file '{os.path.join(src_dir, f'{j[-1]:04d}.png').replace(os.sep, '/')}'\n")
    cru60 = os.path.join(tmp, 'crushed60.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', f'fps={FPS},format=yuv420p',
         '-frames:v', str(total), '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', cru60])
    os.makedirs(out_dir, exist_ok=True)
    pair = os.path.join(out_dir, 'pair.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-i', cru60, '-i', pris60, '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]',
         '-map', '[v]', '-frames:v', str(total), '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
         '-pix_fmt', 'yuv420p', '-movflags', '+faststart', pair])
    # The poster is the 50/50 composite the canvas will draw first.
    run(['ffmpeg', '-y', '-v', 'error', '-i', pair, '-frames:v', '1', '-vf',
         f'split=2[a][b];[a]crop={W // 2}:{H}:0:0[l];[b]crop={W // 2}:{H}:{W + W // 2}:0[r];[l][r]hstack=inputs=2',
         '-q:v', '3', os.path.join(out_dir, 'pair.jpg')])

    # 6. Prove it: the sweep on the finished file must peak at zero.
    l_dir, r_dir = os.path.join(tmp, 'L'), os.path.join(tmp, 'R')
    extract(pair, l_dir, f'crop={W}:{H}:0:0,{small}')
    extract(pair, r_dir, f'crop={W}:{H}:{W}:0,{small}')
    print('alignment of the finished file (must peak at d=0):')
    peak = None
    for d2 in range(-3, 4):
        v2 = mean_ssim(l_dir, max(0, -d2), r_dir, max(0, d2), total - 4)
        print(f'  d={d2:+d}  {v2:.4f}')
        if peak is None or v2 > peak[1]:
            peak = (d2, v2)
    if peak[0] != 0:
        sys.exit(f'NOT ALIGNED: the finished file peaks at d={peak[0]:+d}. Do not ship it.')
    print(f'ok: {pair} ({total} frames), poster written. Aligned at d=0.')


if __name__ == '__main__':
    main()
