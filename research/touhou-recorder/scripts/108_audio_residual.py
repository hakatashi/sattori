#!/usr/bin/env python3
"""同じリプレイを録った2本の音声を時刻合わせして差し引き、片方にしか無い音の時刻を列挙する(reports/108)。

フレーム同期キャプチャはゲームの進行が決定的なので、修正前(OLD)と修正後(NEW)の音声は、
開始位置のずれ(定数)を除けば、修正で増えた音以外は同じになる。NEWからOLDを引いた残差の
大きい区間が「修正で鳴るようになった音」。AACの符号化誤差が残るので、残差はOLDの音量との
比(dB)で見る。

使い方: python3 scripts/108_audio_residual.py OLD.mp4 NEW.mp4 [--top 40] [--window 0.1]
出力の時刻はOLDの時刻(mm:ss)と、NEWの時刻。
"""
import argparse
import subprocess

import numpy as np

SR = 44100


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-af", "aresample=first_pts=0",
                          "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def find_lag(a, b, at=60.0, dur=20.0, search=5.0):
    """b の中で a[at:at+dur] と一致する位置のずれ(サンプル、b - a)。"""
    i0, n, s = int(at * SR), int(dur * SR), int(search * SR)
    seg = a[i0:i0 + n]
    region = b[max(0, i0 - s):i0 + n + s]
    size = 1 << int(np.ceil(np.log2(len(region) + n)))
    c = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(seg, size)), size)[:len(region) - n + 1]
    return max(0, i0 - s) + int(np.argmax(c)) - i0


def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--window", type=float, default=0.1)
    ap.add_argument("--min-gap", type=float, default=1.0, help="列挙する区間どうしの最小間隔(秒)")
    ap.add_argument("--times", default=None, help="この時刻(OLD、カンマ区切り)の前後の残差も表示する")
    args = ap.parse_args()

    old, new = load(args.old), load(args.new)
    lag = find_lag(old, new)
    # 複数箇所でずれが同じか(決定的なら同じ)
    lags = [find_lag(old, new, at) for at in (60.0, len(old) / SR / 2, len(old) / SR - 60.0)]
    print(f"ずれ(NEW-OLD) {lag / SR:+.5f}秒 = {lag}サンプル  確認: {[l - lag for l in lags]}")
    if lag >= 0:
        o, n = old, new[lag:]
    else:
        o, n = old[-lag:], new
    m = min(len(o), len(n))
    o, n = o[:m], n[:m]
    w = int(args.window * SR)
    k = m // w
    res = np.sqrt(((n[:k * w] - o[:k * w]).reshape(k, w) ** 2).mean(axis=1))
    lvl = np.sqrt((o[:k * w].reshape(k, w) ** 2).mean(axis=1))
    rdb = 20 * np.log10(res + 1e-9)
    rel = rdb - 20 * np.log10(lvl + 1e-9)
    off = max(0, -lag) / SR
    print(f"残差の分布(dBFS): 中央値{np.median(rdb):.1f} 90%{np.percentile(rdb, 90):.1f} "
          f"99%{np.percentile(rdb, 99):.1f} 最大{rdb.max():.1f}")
    order = np.argsort(-rdb)
    picked = []
    for i in order:
        t = i * args.window + off
        if all(abs(t - p) >= args.min_gap for p in picked):
            picked.append(t)
        if len(picked) >= args.top:
            break
    print(f"残差の大きい区間(OLDの時刻、上位{args.top}、{args.min_gap}秒以上離す):")
    for t in sorted(picked):
        i = int((t - off) / args.window)
        print(f"  old {fmt(t)}  new {fmt(t + lag / SR)}  残差 {rdb[i]:6.1f}dBFS  (OLDの音量比 {rel[i]:+5.1f}dB)")
    if args.times:
        print("指定時刻の前後±2秒の残差の最大:")
        for s in args.times.split(","):
            mm, ss = (s.split(":") + [None])[:2] if ":" in s else (None, s)
            t = int(mm) * 60 + float(ss) if mm is not None else float(ss)
            i0 = max(0, int((t - 2 - off) / args.window))
            i1 = min(k, int((t + 2 - off) / args.window) + 1)
            j = i0 + int(np.argmax(rdb[i0:i1]))
            print(f"  old {fmt(t)}: 最大 {rdb[j]:6.1f}dBFS at old {fmt(j * args.window + off)} "
                  f"(OLDの音量比 {rel[j]:+5.1f}dB)")


if __name__ == "__main__":
    main()
