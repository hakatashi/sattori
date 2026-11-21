"""低速録画(`FPS_LIMIT_TARGET_HZ`)に伴う実時間スケーリング。

MOD側(`mods/common/fps_limiter_hook.h`)が`FPS_LIMIT_TARGET_HZ`の周波数へPresentを
スロットルすると、東方作品はレンダリングfpsとゲームロジック更新が直結しているため
ゲーム進行そのものがスローモーションになる(reports/47)。

**MOD内部の待機(dllmain.cppのScaledSleep)だけでなく、それを監視する録画側の
タイムアウト・猶予時間も同じ比率で伸ばさないと低速録画は成立しない。**
フェーズ47のフル尺録画で、スケール未適用の`POST_START_GRACE_SEC=15`秒のまま最初の
stutter probeを行ったところ、スロー化によりゲーム内時間はまだ7.5秒相当(ステージ開始の
導入演出中)だったため「処理落ち」と誤検知し、3回ともリトライに失敗する事象が発生した。

スケールを適用している箇所:

  - `pipeline.POST_START_GRACE_SEC` (リプレイ開始後の猶予)
  - `stutter.STUTTER_PROBE_INTERVAL_SEC` / `stutter.STUTTER_DUP_FRACTION_THRESHOLD`
  - MODログのマーカー待ち(`pipeline`内の各`wait_for_log_marker`のtimeout)
  - thpracのアタッチ待ち(`process.attach_thprac`のtimeout、reports/72)
  - ウィンドウ検出待ち(reports/68)
  - `--max-duplicate-rate`の既定値(`default_max_duplicate_rate()`、reports/82)
"""
import os

NATIVE_FRAME_RATE_HZ = 60.0

# 環境変数はプロセス起動時に一度だけ読む(MOD側へも同じ環境変数がそのまま渡るため、
# 途中で値が変わることは想定しない)。
_FPS_LIMIT_TARGET_HZ = float(os.environ.get("FPS_LIMIT_TARGET_HZ", str(NATIVE_FRAME_RATE_HZ)))

# 「実時間がゲーム内時間の何倍になるか」。等倍(未設定)なら1.0、30Hz指定なら2.0。
MENU_TIME_SCALE = (
    NATIVE_FRAME_RATE_HZ / _FPS_LIMIT_TARGET_HZ if _FPS_LIMIT_TARGET_HZ > 0 else 1.0
)


def scale_seconds(seconds):
    """等倍録画を前提に決めた秒数を、低速録画の実時間へ引き伸ばす。"""
    return seconds * MENU_TIME_SCALE


# DirectSoundのセカンダリバッファ(BGM等)の既定レートと同じ44100Hzを基準にする。
# 48000Hz(PulseAudio auto_nullの実際のレート)を基準にすると、倍速録画用の専用シンク
# レートがゲームの実際の出力レート(44100Hz×倍率)と一致せず、リサンプリングが余分に
# 挟まって高域が想定より減衰する(実測、reports/85)ことが分かったため44100Hzを使う。
NATIVE_AUDIO_RATE_HZ = 44100

# 倍速録画(MENU_TIME_SCALE<1.0、issue #1)では、`mods/common/dsound_hook.h`が
# セカンダリサウンドバッファの再生周波数を同じ比率でスケールする(2倍速なら
# 44100Hz→88200Hz)ため、録音される音声は「テープの早回し」と同じ原理で圧縮される。
# この圧縮された音声を録音時のサンプルレート(44100Hz、ナイキスト22050Hz)のまま
# 録音すると、圧縮空間で22050Hzを超える成分(元の速度に戻すと11025Hz超に相当)が
# 録音時点で失われ、setpts復元後の音声で明確な高域欠落として現れる不具合が実機検証で
# 見つかった(reports/85)。映像キャプチャのCAPTURE_FRAME_RATE_HZ(recorder/ffmpeg.py)
# と同じ理屈で、録音のサンプルレート自体も倍率分引き上げ、専用シンクをゲームの実際の
# 出力レートに一致させる。
AUDIO_CAPTURE_RATE_HZ = (
    round(NATIVE_AUDIO_RATE_HZ / MENU_TIME_SCALE) if 0 < MENU_TIME_SCALE < 1.0
    else NATIVE_AUDIO_RATE_HZ
)


def default_max_duplicate_rate(native_threshold_percent=30.0):
    """`--max-duplicate-rate`の既定値を低速録画のスケールに合わせて換算する。

    低速録画は意図的に「1フレームの内容を複数回キャプチャする」状態(30fps時は理論上
    50%が重複)になるため、等倍前提の閾値をそのまま当てると正常な録画が必ず
    「処理落ち」と判定される。native値30.0%は「非重複率70%以上が正常」の意味なので、
    非重複率をスケールで割って(30fps時は35%)重複率へ戻す(65%)。

    フェーズ82のth15低速録画実機検証で、この最終判定側のスケーリング漏れ
    (stutter probe側のみフェーズ69で対応済みだった)により実測58.3%の重複フレーム率
    (30fps録画では正常範囲)が固定閾値30%超過と誤判定され、3回とも失敗する不具合が
    見つかったことへの対応。

    倍速録画(MENU_TIME_SCALE<1.0、issue #1)ではこの換算式が逆方向に働き、例えば
    4倍速(scale=0.25)で `100.0 - 70.0/0.25 = -180.0` という負の閾値になり、
    重複フレーム率0%でも必ず超過判定される不具合が実機検証で見つかった(reports/85)。
    倍速側は重複フレームが増える理由が無い(むしろ減る)ため、換算はscale>1.0
    (低速側)のときのみ適用する。
    """
    if MENU_TIME_SCALE <= 1.0:
        return native_threshold_percent
    return 100.0 - (100.0 - native_threshold_percent) / MENU_TIME_SCALE
