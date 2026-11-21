#!/usr/bin/env python3
"""倍速録画を復元した動画と等倍録画を、映像・音声それぞれのタイムラインで照合する(フェーズ87)。

リプレイ再生は決定的なので、同じリプレイの等倍録画(参照)と倍速録画の復元動画は
「開始位置のずれ(定数)」を除けば映像・音声とも同じ内容になるはず。参照動画の複数の
アンカー時刻について、候補動画のどこに同じ内容があるかを映像・音声で独立に探し、

  - video_offset(t): 参照のt秒の映像が候補の何秒ずれた位置にあるか
  - audio_offset(t): 同じく音声
  - av_delta(t) = audio_offset - video_offset

を出力する。video_offsetがtによらず一定なら「復元後の尺・速度が正しい(ドリフト無し)」、
av_deltaが0付近で一定なら「A/V同期が参照と同じ」と判断できる。

映像は32x24グレースケールに縮小した60fps列の平均絶対差(MAD)の最小位置、
音声は16kHzモノラルの正規化相互相関の最大位置で探す。

Usage:
  python3 scripts/87_compare_timeline.py REF.mp4 CAND.mp4 [--anchors 30,60,90] [--search 20]
"""
import argparse
import subprocess

import numpy as np

W, H, FPS, SR = 32, 24, 60, 16000


def stream_start(path, kind):
    """ストリームのstart_time(秒)。

    recorder/のmuxは映像・音声の起動時刻差を`-itsoffset`で埋めるため、片方のstart_timeが
    0.5秒前後になることがある。raw出力へデコードするとこの先頭の空白は詰められてしまう
    ので、読み込み側で先頭に同じ長さの無音/黒フレームを足して絶対位置を保つ。
    """
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", kind, "-show_entries", "stream=start_time",
         "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip().splitlines()
    try:
        return float(out[0])
    except (IndexError, ValueError):
        return 0.0


def load_video(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps={FPS},scale={W}:{H},format=gray",
         "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    v = np.frombuffer(raw, np.uint8).reshape(-1, H * W).astype(np.float32)
    pad = int(round(stream_start(path, "v") * FPS))
    return np.concatenate([np.zeros((pad, H * W), np.float32), v]) if pad > 0 else v


def load_audio(path, af=None):
    # `aresample=first_pts=0`で先頭の空白を無音で埋める。mux時の同期マーカー検証・配信版の変換と
    # 同じ時間軸になる。ffprobeのstart_timeで埋める旧実装は、start_timeと実際の先頭位置が
    # 食い違う録画で+0.7秒の見かけのA/V差を出していた(reports/91)。
    filters = (af + "," if af else "") + "aresample=first_pts=0"
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vn", "-af", filters, "-ac", "1", "-ar", str(SR)]
    raw = subprocess.run(cmd + ["-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def video_offset(ref, cand, t, search, win=2.0):
    i0, n = int(t * FPS), int(win * FPS)
    seg = ref[i0:i0 + n]
    if len(seg) < n or seg.std() < 1.0:
        return None, None
    best = (None, np.inf)
    for d in range(-int(search * FPS), int(search * FPS) + 1):
        j = i0 + d
        if j < 0 or j + n > len(cand):
            continue
        mad = np.abs(cand[j:j + n] - seg).mean()
        if mad < best[1]:
            best = (d / FPS, mad)
    return best


def audio_offset(ref, cand, t, search, win=4.0):
    i0, n, s = int(t * SR), int(win * SR), int(search * SR)
    seg = ref[i0:i0 + n]
    lo, hi = max(0, i0 - s), min(len(cand), i0 + n + s)
    region = cand[lo:hi]
    if len(seg) < n or len(region) < n or seg.std() < 1e-4:
        return None, None
    size = 1 << int(np.ceil(np.log2(len(region) + n)))
    corr = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(seg, size)), size)
    corr = corr[:len(region) - n + 1]
    energy = np.sqrt(np.convolve(region ** 2, np.ones(n), "valid"))
    ncc = corr / (energy * np.linalg.norm(seg) + 1e-9)
    k = int(np.argmax(ncc))
    return (lo + k - i0) / SR, float(ncc[k])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref")
    ap.add_argument("cand")
    ap.add_argument("--anchors", default=None, help="カンマ区切りの秒数(未指定なら参照尺を10等分)")
    ap.add_argument("--search", type=float, default=20.0, help="探索範囲(±秒)")
    ap.add_argument("--audio-filter", default=None,
                    help="照合前に音声へ掛けるffmpegフィルタ(例: highpass=f=5000。BGMとSEの切り分け用)")
    args = ap.parse_args()

    rv, cv = load_video(args.ref), load_video(args.cand)
    ra, ca = load_audio(args.ref, args.audio_filter), load_audio(args.cand, args.audio_filter)
    dur = len(rv) / FPS
    anchors = ([float(x) for x in args.anchors.split(",")] if args.anchors
               else [dur * k / 10 for k in range(1, 10)])
    print(f"ref={args.ref} ({dur:.2f}s)  cand={args.cand} ({len(cv) / FPS:.2f}s)")
    print(f"{'t_ref':>8} {'video_off':>10} {'MAD':>7} {'audio_off':>10} {'NCC':>6} {'av_delta':>9}")
    for t in anchors:
        vo, mad = video_offset(rv, cv, t, args.search)
        ao, ncc = audio_offset(ra, ca, t, args.search)
        delta = f"{(ao - vo) * 1000:+8.1f}ms" if vo is not None and ao is not None else "      n/a"
        fmt = lambda x, f: (f % x) if x is not None else "n/a"
        print(f"{t:8.1f} {fmt(vo, '%+9.3fs'):>10} {fmt(mad, '%7.2f'):>7} "
              f"{fmt(ao, '%+9.4fs'):>10} {fmt(ncc, '%6.3f'):>6} {delta}")


if __name__ == "__main__":
    main()
