#!/usr/bin/env python3
"""低速録画(Issue #68)で撮った動画を「等倍相当」へ戻す後処理。

`FPS_LIMIT_TARGET_HZ` を指定して録画すると、MOD の3つのフックが同じ比率で
ゲームをスローモーション化する(touhou-recorder reports/47・48):

  - `fps_limiter_hook`  : IDirect3DDevice9::Present を目標fpsへスロットル
                          (th20はレンダリングfps＝ゲームロジック更新なので、
                          これがゲーム進行そのもののスローダウンになる)
  - `dsound_hook`       : セカンダリサウンドバッファの再生周波数を同じ比率へ下げる
                          (BGM/SEはDirectSoundの独立したストリーミングで、Presentの
                          スロットルには連動しないため。テープの遅回しと同じ原理)
  - `fps_display_hook`  : 画面に焼き付くfpsカウンターの表示だけ等倍相当へ補正

この録画に対し、映像のPTSを同じ比率で圧縮(`setpts`)し、音声のサンプルレートを
逆比率へ引き上げてリサンプル(`asetrate` + `aresample`)すると、ゲーム内で実際に
経過した時間軸へ正しく戻せる。遅回しを早回しで戻す**可逆変換**なので、速度・ピッチ
とも劣化なく復元できる(reports/47 でフル尺録画3359.1秒 → 1679.6秒＝等倍想定尺
28.0分への復元を実証済み)。

`-r` で出力を等倍のフレームレートに固定するのが要点。録画自体は x11grab の
`-framerate 60`(等倍と同じ)で撮っているため、30Hz駆動の素材は各フレームが2枚ずつ
並んだ状態になっている。PTSを1/2に圧縮すると実質120fps相当になり、そこから60fpsへ
落とすことで**重複フレームがちょうど間引かれ**、等倍録画と同じ「60fps・全フレーム
ユニーク」の動画になる。この性質のおかげで、後段の重複フレーム率チェック
(`recording_common.measure_duplicate_rate()`)は等倍録画と同じ閾値のまま使える
——ゲームが目標fpsを維持できていれば重複はほぼ0%になり、逆に本当に処理落ちして
いれば間引き切れずに重複として現れる。
"""
import os
import subprocess


def descale_to_normal_speed(input_path, output_path, scale, *, native_hz=60.0, log=print):
    """低速録画された動画を等倍相当へ変換する。

    `scale` は `recording_common.slow_motion_scale()` の値(実時間がゲーム内時間の
    何倍か。30Hz駆動なら2.0)。1.0以下なら何もせず False を返す(呼び出し側が
    「変換不要」と扱えるようにするため。等倍録画では呼ばれない)。

    成功したら True。失敗した場合は ffmpeg のログ末尾を残して False を返す
    ——例外を投げないのは、呼び出し元(`attempt_recording()`)がこれを
    「この試行は失敗」として扱い、既存のリトライ経路にそのまま乗せられるようにするため。
    """
    if scale <= 1.0:
        return False

    # 映像のPTSに掛ける係数。scale=2.0(半分の速度で録画した)なら0.5で、尺が半分になる。
    time_scale = 1.0 / scale
    sample_rate = _probe_audio_sample_rate(input_path)
    if sample_rate is None:
        # 音声が無い/読めない場合でも映像だけは等倍へ戻す(音声トラック無しの録画は
        # 通常発生しないが、ここで丸ごと失敗させるより映像を救う方が損失が小さい)。
        log("WARNING: 音声のサンプルレートを取得できませんでした。映像のみ等倍へ変換します")
        filter_args = ["-vf", f"setpts={time_scale}*PTS", "-an"]
    else:
        # 音声は「サンプルレートを上げて読む」ことで早回しし(asetrate)、その後
        # 元のレートへリサンプルし直す(aresample)。速度・ピッチとも同じ比率で戻る。
        asetrate = int(round(sample_rate * scale))
        filter_args = [
            "-filter_complex",
            f"[0:v]setpts={time_scale}*PTS[v];"
            f"[0:a]asetrate={asetrate},aresample={sample_rate}[a]",
            "-map", "[v]", "-map", "[a]",
            "-c:a", "aac", "-b:a", "192k",
        ]

    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        *filter_args,
        "-r", str(native_hz),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        output_path,
    ]
    log(f"等倍相当へ変換します (scale={scale:.3f} setpts={time_scale:.3f}): {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        log(
            f"WARNING: 等倍変換に失敗しました (returncode={result.returncode}): "
            f"{result.stderr[-2000:].decode(errors='replace')}"
        )
        return False
    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        log("WARNING: 等倍変換の出力ファイルが生成されませんでした")
        return False
    return True


def _probe_audio_sample_rate(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return int(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None
