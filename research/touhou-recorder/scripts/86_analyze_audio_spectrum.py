#!/usr/bin/env python3
"""録音音声の周波数ロールオフ点を測る(フェーズ86)。

倍速録画の音質劣化(reports/85 §11)の切り分け用。ファイルごとに
「全体のパワースペクトル」を1/3オクターブ相当のバンドに集約し、
ピークから-30dB落ちる周波数(=実効帯域幅)を求めて比較する。

  python3 scripts/86_analyze_audio_spectrum.py [--speed N] file.wav [file2.wav ...]

--speed N を付けると「N倍速で圧縮されたまま記録された音声」とみなし、
周波数軸をNで割って元の速度での周波数に換算して表示する。
"""
import argparse
import json
import subprocess

import numpy as np


def load(path):
    """ffmpeg/ffprobe経由でモノラルfloatへ展開する。

    WAVE_FORMAT_EXTENSIBLE(88200Hz以上のwavで使われる)やmp4/mkvの音声トラックも
    そのまま扱えるようにするため、標準ライブラリのwaveモジュールではなくffmpegを使う。
    元のサンプルレートは維持する(リサンプルさせると測りたいロールオフが消えるため)。
    """
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate", "-of", "json", path],
        capture_output=True, text=True, check=True)
    rate = int(json.loads(probe.stdout)["streams"][0]["sample_rate"])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1",
         "-f", "f32le", "-ar", str(rate), "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64), rate


def spectrum(x, rate, nfft=16384):
    """Welch法相当の平均パワースペクトル(dB)。"""
    hop = nfft // 2
    win = np.hanning(nfft)
    acc = np.zeros(nfft // 2 + 1)
    n = 0
    for start in range(0, len(x) - nfft, hop):
        seg = x[start:start + nfft] * win
        acc += np.abs(np.fft.rfft(seg)) ** 2
        n += 1
    if n == 0:
        raise SystemExit("解析するのに十分な長さがありません")
    psd = acc / n
    freqs = np.fft.rfftfreq(nfft, 1.0 / rate)
    db = 10 * np.log10(psd + 1e-20)
    return freqs, db


def rolloff(freqs, db, drop_db=30.0, floor_start_hz=200.0):
    """ピークから drop_db 下がり、そこから戻らなくなる周波数(実効帯域)。"""
    mask = freqs >= floor_start_hz
    peak = db[mask].max()
    thr = peak - drop_db
    idx = np.where(mask)[0]
    last = idx[0]
    for i in idx:
        if db[i] >= thr:
            last = i
    return freqs[last], peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--speed", type=float, default=1.0,
                    help="圧縮倍率。2なら周波数軸を1/2して元の速度に換算する")
    ap.add_argument("--bands", default="4,6,8,10,12,14,16,18,20",
                    help="平均パワーを表示する帯域の中心(kHz、カンマ区切り)")
    args = ap.parse_args()

    centers = [float(v) * 1000 for v in args.bands.split(",")]
    print(f"{'file':<34} {'rate':>7} {'-30dB帯域':>11}  " +
          "  ".join(f"{c/1000:g}k" for c in centers))
    for path in args.files:
        x, rate = load(path)
        freqs, db = spectrum(x, rate)
        f_orig = freqs / args.speed
        ro, peak = rolloff(f_orig, db)
        cells = []
        for c in centers:
            sel = (f_orig >= c - 1000) & (f_orig < c + 1000)
            cells.append(f"{db[sel].mean() - peak:6.1f}" if sel.any() else "   n/a")
        name = path.rsplit("/", 1)[-1]
        print(f"{name:<34} {rate:>7} {ro/1000:9.2f}kHz  " + " ".join(cells))
    print("\n(各帯域の数値はピーク基準の相対dB。-30dB以下は実質的に失われている)")


if __name__ == "__main__":
    main()
