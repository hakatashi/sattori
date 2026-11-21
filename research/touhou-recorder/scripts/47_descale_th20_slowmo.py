#!/usr/bin/env python3
"""低速録画・倍速録画(FPS_LIMIT_TARGET_HZ、reports/47・reports/85参照)を、
正しい速度・ピッチの「等倍相当」動画に変換するツール。

mods/common/fps_limiter_hook.h(Present頻度制限)とmods/common/dsound_hook.h
(DirectSoundバッファのSetFrequency)の両方をFPS_LIMIT_TARGET_HZ/60倍にスケール
して録画すると、映像・ゲームロジック・音声が全て同じ比率でスローモーション化
される。この録画に対し、映像のPTSを同じ比率で圧縮(setpts)し、音声のサンプル
レートを同じ比率で引き上げてリサンプル(asetrate+aresample)することで、
ゲーム内で実際に経過した時間軸に正しく戻せる(テープの遅回しを早回しで戻すのと
同じ可逆変換のため、速度・ピッチとも劣化なく復元できる)。

倍速録画(`--target-hz`が`--native-hz`より大きい場合、issue #1)でも同じ式がそのまま
成立する(time_scale>1で映像を引き伸ばし、asetrateでサンプルレートを下げる)。
倍速録画の音声は88200Hz等の高レートで記録されているため、復元後は`--audio-rate`
(既定48000Hz)へリサンプルして通常のファイルに揃える。
"""
import argparse
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--target-hz", type=float, required=True,
                         help="録画時にFPS_LIMIT_TARGET_HZへ指定した値(例: 30)")
    parser.add_argument("--native-hz", type=float, default=60.0,
                         help="ゲーム本来のフレームレート(既定60)")
    parser.add_argument("--audio-rate", type=int, default=48000,
                         help="出力音声のサンプルレート(既定48000)")
    args = parser.parse_args()

    time_scale = args.target_hz / args.native_hz  # 0.5 = 録画時に半分速度にした
    speedup = 1.0 / time_scale  # 2.0 = 元に戻すための倍速係数

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=sample_rate", "-of", "default=nw=1:nk=1", args.input],
        capture_output=True, text=True, check=True,
    )
    sample_rate = int(probe.stdout.strip())
    asetrate = int(round(sample_rate * speedup))
    out_rate = args.audio_rate

    cmd = [
        "ffmpeg", "-y", "-i", args.input,
        "-filter_complex",
        f"[0:v]setpts={time_scale}*PTS[v];[0:a]asetrate={asetrate},aresample={out_rate}[a]",
        "-map", "[v]", "-map", "[a]",
        "-r", str(args.native_hz),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        args.output,
    ]
    print(f"time_scale={time_scale} speedup={speedup} sample_rate={sample_rate} "
          f"asetrate={asetrate} out_rate={out_rate}")
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
