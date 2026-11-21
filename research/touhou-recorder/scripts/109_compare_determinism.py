#!/usr/bin/env python3
"""フレーム同期キャプチャで録画した2本の動画(基準 vs 候補)の決定性・品質一致を検証する(フェーズ109)。

フレーム同期キャプチャはゲームの進行が完全に決定的であるため、異なる負荷条件・並列実行・
異なる環境(ローカル CPU / AWS CPU / AWS GPU)で録画しても、冒頭のメニュー待機時間の差による
定数オフセットを除けば、映像は1フレームのズレもなく、音声はサンプル単位のズレもなく
一致するはずである。

本スクリプトは以下を出力・検証する:
  1. 映像のフレーム照合 (32x24 gray 60fps):
     - 序盤・中盤・終盤の3箇所でローカルベストオフセット(フレーム数)を探し、ズレの変化が [0, 0, 0] か
     - 共通プレイ区間全体にわたるフレーム毎MAD (平均 / 99% / 最大)
  2. 音声のサンプル照合 (44100Hz mono f32le):
     - 序盤・中盤・終盤の3箇所でFFT相互相関によりサンプル単位のオフセットを探し、変化が [0, 0, 0] か
     - 共通プレイ区間全体にわたる0.1秒窓の残差分布 (中央値 / 90% / 99% / 最大 dBFS) と音量比(dB)
     - 映像オフセット(サンプル換算)と音声オフセットの差 (A/V相対ズレ)

使い方:
  python3 scripts/109_compare_determinism.py REF.mp4 CAND.mp4 [--search 20] [--json]
"""
import argparse
import ctypes
import json
import os
import subprocess
import sys

os.environ.setdefault("NUMPY_MADVISE_HUGEPAGE", "0")
try:
    ctypes.CDLL(None).prctl(41, 1, 0, 0, 0)  # PR_SET_THP_DISABLE
except Exception:
    pass

import numpy as np

W, H, FPS, SR = 32, 24, 60, 44100


def load_video(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"fps={FPS},scale={W}:{H},format=gray",
         "-f", "rawvideo", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H * W).astype(np.float32)


def load_audio(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-af", "aresample=first_pts=0",
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def find_video_lag(ref, cand, at_sec, win_sec=4.0, search_sec=20.0):
    i0 = int(at_sec * FPS)
    n = int(win_sec * FPS)
    s = int(search_sec * FPS)
    seg = ref[i0:i0 + n]
    if len(seg) < n:
        return None, None
    best_lag = None
    best_mad = np.inf
    lo = max(-i0, -s)
    hi = min(len(cand) - n - i0, s)
    for d in range(lo, hi + 1):
        mad = float(np.abs(cand[i0 + d:i0 + d + n] - seg).mean())
        if mad < best_mad:
            best_mad = mad
            best_lag = d
    return best_lag, best_mad


def find_audio_lag(ref, cand, at_sec, win_sec=20.0, search_sec=20.0):
    i0 = int(at_sec * SR)
    n = int(win_sec * SR)
    s = int(search_sec * SR)
    seg = ref[i0:i0 + n]
    lo = max(0, i0 - s)
    hi = min(len(cand), i0 + n + s)
    region = cand[lo:hi]
    if len(seg) < n or len(region) < n:
        return None
    size = 1 << int(np.ceil(np.log2(len(region) + n)))
    c = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(seg, size)), size)
    c = c[:len(region) - n + 1]
    return lo + int(np.argmax(c)) - i0


def compare_pair(ref_path, cand_path, search_sec=20.0):
    ref_v = load_video(ref_path)
    cand_v = load_video(cand_path)
    ref_dur_v = len(ref_v) / FPS

    v_anchors = [
        60.0,
        max(60.0, ref_dur_v / 2.0),
        max(60.0, ref_dur_v - 45.0),
    ]
    v_lag0, v_mad0 = find_video_lag(ref_v, cand_v, v_anchors[0], win_sec=5.0, search_sec=search_sec)
    v_lags = [v_lag0]
    v_mads = [v_mad0]
    for at in v_anchors[1:]:
        # アンカー2点目以降は初回ラグの±2秒周辺でチェックし、ドリフトが無いか確認する
        lag, mad = find_video_lag(
            ref_v, cand_v, at, win_sec=5.0,
            search_sec=min(search_sec, 3.0) if v_lag0 is not None else search_sec)
        # search_sec=3sで探す際はcand側がv_lag0周辺にあるはずなので、一旦全体再探索と併用
        if v_lag0 is not None:
            # 厳密にはref[at]に対してcand[at + v_lag0 ± 180フレーム]を探索
            i0 = int(at * FPS)
            n = int(5.0 * FPS)
            seg = ref_v[i0:i0 + n]
            best_d, best_m = None, np.inf
            for d in range(v_lag0 - 180, v_lag0 + 181):
                j = i0 + d
                if 0 <= j and j + n <= len(cand_v):
                    m = float(np.abs(cand_v[j:j + n] - seg).mean())
                    if m < best_m:
                        best_m = m
                        best_d = d
            v_lags.append(best_d)
            v_mads.append(best_m)
        else:
            v_lags.append(lag)
            v_mads.append(mad)

    # 共通プレイ区間全体のフレーム単位MAD (t=30s〜末尾30s手前)
    v_start = int(30 * FPS)
    if v_lag0 is not None:
        r_lo = max(v_start, -v_lag0 + v_start)
        r_hi = min(len(ref_v) - int(30 * FPS), len(cand_v) - v_lag0 - int(30 * FPS))
        if r_hi > r_lo:
            diff_v = np.abs(cand_v[r_lo + v_lag0:r_hi + v_lag0] - ref_v[r_lo:r_hi]).mean(axis=1)
            v_mean_mad = float(diff_v.mean())
            v_p99_mad = float(np.percentile(diff_v, 99))
            v_max_mad = float(diff_v.max())
            v_gt2 = int((diff_v > 2.0).sum())
            v_total_checked = int(len(diff_v))
        else:
            v_mean_mad = v_p99_mad = v_max_mad = float("nan")
            v_gt2 = v_total_checked = 0
    else:
        v_mean_mad = v_p99_mad = v_max_mad = float("nan")
        v_gt2 = v_total_checked = 0

    v_drift = [l - v_lag0 if (l is not None and v_lag0 is not None) else None for l in v_lags]

    # 音声
    ref_a = load_audio(ref_path)
    cand_a = load_audio(cand_path)
    ref_dur_a = len(ref_a) / SR
    a_anchors = [
        60.0,
        max(60.0, ref_dur_a / 2.0),
        max(60.0, ref_dur_a - 60.0),
    ]
    a_lag0 = find_audio_lag(ref_a, cand_a, a_anchors[0], win_sec=20.0, search_sec=search_sec)
    a_lags = [a_lag0]
    for at in a_anchors[1:]:
        if a_lag0 is not None:
            # 基準ラグ周辺 ±5秒で探す
            i0 = int(at * SR)
            n = int(20.0 * SR)
            s = int(5.0 * SR)
            seg = ref_a[i0:i0 + n]
            lo = max(0, i0 + a_lag0 - s)
            hi = min(len(cand_a), i0 + a_lag0 + n + s)
            region = cand_a[lo:hi]
            if len(seg) == n and len(region) >= n:
                size = 1 << int(np.ceil(np.log2(len(region) + n)))
                c = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(seg, size)), size)
                c = c[:len(region) - n + 1]
                a_lags.append(lo + int(np.argmax(c)) - i0)
            else:
                a_lags.append(None)
        else:
            a_lags.append(find_audio_lag(ref_a, cand_a, at, win_sec=20.0, search_sec=search_sec))
    a_drift = [l - a_lag0 if (l is not None and a_lag0 is not None) else None for l in a_lags]

    # 共通プレイ区間(t=30s〜末尾30s手前)の音声残差
    if a_lag0 is not None:
        skip = int(30 * SR)
        if a_lag0 >= 0:
            r_sub = ref_a[skip:]
            c_sub = cand_a[a_lag0 + skip:]
        else:
            r_sub = ref_a[-a_lag0 + skip:]
            c_sub = cand_a[skip:]
        m = max(0, min(len(r_sub), len(c_sub)) - int(30 * SR))
        w = int(0.1 * SR)
        k = m // w
        if k > 0:
            r_blk = r_sub[:k * w].reshape(k, w)
            c_blk = c_sub[:k * w].reshape(k, w)
            res = np.sqrt(((c_blk - r_blk) ** 2).mean(axis=1))
            lvl = np.sqrt((r_blk ** 2).mean(axis=1))
            rdb = 20.0 * np.log10(res + 1e-9)
            rel = rdb - 20.0 * np.log10(lvl + 1e-9)
            a_res_med = float(np.median(rdb))
            a_res_p90 = float(np.percentile(rdb, 90))
            a_res_p99 = float(np.percentile(rdb, 99))
            a_res_max = float(rdb.max())
            a_rel_med = float(np.median(rel))
            a_rel_max = float(rel.max())
        else:
            a_res_med = a_res_p90 = a_res_p99 = a_res_max = a_rel_med = a_rel_max = float("nan")
    else:
        a_res_med = a_res_p90 = a_res_p99 = a_res_max = a_rel_med = a_rel_max = float("nan")

    av_diff_samples = None
    av_diff_ms = None
    if v_lag0 is not None and a_lag0 is not None:
        # 1フレーム = 735サンプル (44100 / 60)
        av_diff_samples = a_lag0 - v_lag0 * (SR // FPS)
        av_diff_ms = av_diff_samples / SR * 1000.0

    return {
        "ref": ref_path,
        "cand": cand_path,
        "ref_frames": int(len(ref_v)),
        "cand_frames": int(len(cand_v)),
        "video_lag_frames": v_lag0,
        "video_drift_frames": v_drift,
        "video_anchor_mads": [round(m, 3) if m is not None else None for m in v_mads],
        "video_checked_frames": v_total_checked,
        "video_mean_mad": round(v_mean_mad, 4),
        "video_p99_mad": round(v_p99_mad, 4),
        "video_max_mad": round(v_max_mad, 4),
        "video_frames_mad_gt2": v_gt2,
        "audio_lag_samples": a_lag0,
        "audio_drift_samples": a_drift,
        "av_diff_samples": av_diff_samples,
        "av_diff_ms": round(av_diff_ms, 3) if av_diff_ms is not None else None,
        "audio_res_median_dbfs": round(a_res_med, 2),
        "audio_res_p90_dbfs": round(a_res_p90, 2),
        "audio_res_p99_dbfs": round(a_res_p99, 2),
        "audio_res_max_dbfs": round(a_res_max, 2),
        "audio_rel_median_db": round(a_rel_med, 2),
        "audio_rel_max_db": round(a_rel_max, 2),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref", help="基準動画 (無負荷ローカル録画)")
    ap.add_argument("cand", help="候補動画 (負荷下・並列・クラウド録画)")
    ap.add_argument("--search", type=float, default=20.0, help="オフセット探索幅(±秒)")
    ap.add_argument("--json", action="store_true", help="JSON形式で出力")
    args = ap.parse_args()

    res = compare_pair(args.ref, args.cand, search_sec=args.search)
    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(f"基準: {res['ref']} ({res['ref_frames']}f)")
        print(f"候補: {res['cand']} ({res['cand_frames']}f)")
        print(f"映像: lag={res['video_lag_frames']}f  drift={res['video_drift_frames']}f  "
              f"anchor_mad={res['video_anchor_mads']}")
        print(f"      全区間({res['video_checked_frames']}f) MAD: mean={res['video_mean_mad']:.4f} "
              f"p99={res['video_p99_mad']:.4f} max={res['video_max_mad']:.4f} "
              f"MAD>2.0={res['video_frames_mad_gt2']}f")
        print(f"音声: lag={res['audio_lag_samples']}samp ({(res['audio_lag_samples'] or 0) / SR:+.5f}s)  "
              f"drift={res['audio_drift_samples']}samp  "
              f"A/V差={res['av_diff_samples']}samp ({res['av_diff_ms']}ms)")
        print(f"      残差(0.1s窓): median={res['audio_res_median_dbfs']}dBFS "
              f"p90={res['audio_res_p90_dbfs']} p99={res['audio_res_p99_dbfs']} "
              f"max={res['audio_res_max_dbfs']}  (基準比 median={res['audio_rel_median_db']}dB "
              f"max={res['audio_rel_max_db']}dB)")


if __name__ == "__main__":
    main()
