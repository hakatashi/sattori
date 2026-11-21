"""処理落ちの早期検知(stutter probe)。

録画開始直後の外乱でx11grabのフレームタイミングが崩れると、以降ずっと重複フレームで
埋まったまま復帰しない(reports/12・13)。フル尺を録り終えてから重複フレーム率で気づくと
30分を無駄にするため、再生中に短間隔サンプリングで早期に検知してリトライへ回す。
"""
import os
import time

from .timing import MENU_TIME_SCALE, scale_seconds
from .vision import STILL_MAD_THRESHOLD, POLL_STREAM_FPS, grab_frame, mad_masked, read_poll_frames

STUTTER_PROBE_SAMPLES = 10
STUTTER_PROBE_INTERVAL_SEC = scale_seconds(0.15)
STUTTER_PROBE_PERIOD_SEC = 60.0
# probeを打ち切るまでの経過秒(リプレイ再生開始からの実時間)。処理落ちは録画開始直後の
# 外乱で始まるものなので、序盤だけ見れば足りる。
# 環境変数で上書きでき、0でprobe自体を止める(描画性能のベンチマークでキャプチャを30fpsに
# 落とすと、倍速の映像が重複扱いされて誤検知するため、reports/99)。
STUTTER_PROBE_ACTIVE_UNTIL_SEC = float(os.environ.get("STUTTER_PROBE_ACTIVE_UNTIL_SEC", "300"))

# 低速録画(FPS_LIMIT_TARGET_HZ<60)は意図的に「1フレーム内容を複数回キャプチャする」
# 状態(30fps時は理論上50%が重複)になるため、閾値0.7をそのまま使うと素のマージンが
# 0.2しか残らず、サンプリングの分散だけで誤検知しうる(th09実機で発生を確認、フェーズ69)。
# ネイティブ60fps時の余裕(0.7に対して素の重複率がほぼ0、マージン0.7)と同じ比率の
# マージンを維持するよう、期待される重複率(1-scale)を差し引いた残りマージンに0.7を
# 掛けて動的に算出する(scale=1.0時は従来通り0.7)。
#
# 倍速録画(MENU_TIME_SCALE<1.0、issue #1)ではこの調整式が逆方向に働き、4倍速
# (scale=0.25)で閾値が-0.2という負の値になり、重複フレーム率0%でも必ず誤検知する
# 不具合が実機検証で見つかった(reports/85)。倍速側は重複フレームが増える理由が
# 無い(むしろ減る)ため、調整はscale>1.0(低速側)のときのみ適用する。
STUTTER_DUP_FRACTION_THRESHOLD = (
    1.0 - (1.0 - 0.7) * (1.0 / MENU_TIME_SCALE) if MENU_TIME_SCALE > 1.0 else 0.7
)


def probe_stutter(display, env, geometry, mask=None, poll_raw_path=None):
    """短間隔で連続キャプチャし、隣接フレームが「静止」と見なせた割合を返す。

    maskに`stutter_probe_exclude_rect`から作った真偽マスクを渡すと、その領域をMAD計算から
    除外する。th06nc(1280x720・16:9)のように画面の大半が静止した装飾(左のアートワーク・
    右のサイドバー)で占められるタイトルでは、全画面MADだとプレイフィールドの動きが薄まり、
    正常な60fps再生でも0.15秒間隔のMADがSTILL_MAD_THRESHOLDを下回って誤検知する
    (フェーズ79実測: 全画面では62%のサンプルが閾値未満、プレイフィールドのみなら0%)。
    """
    x, y, w, h = geometry
    if poll_raw_path:
        # 録画用ffmpegのサブ出力から直近のサンプルを読む。grab_frameを10回叩くと約3.2秒ぶん
        # 本録画のx11grabを妨害し、それ自体が数十フレームの脱落を生んでしまう(フェーズ81で、
        # 修正後も1バースト54フレームの脱落として観測)。サブ出力が溜まるのを待ってから読む。
        # 低速録画(MENU_TIME_SCALE>1.0)ではサブ出力の隣接フレーム(実時間で1/POLL_STREAM_FPS秒)
        # のあいだにゲームが進む量が1/scaleに減り、動きの少ない場面(ステージ冒頭など)で
        # 正常でも「静止」と判定される(th14の1/2倍速で冒頭にdup_fraction 0.89>閾値0.85となり
        # 録画が破棄された、reports/103)。grab_frame方式がSTUTTER_PROBE_INTERVAL_SECを
        # scale倍しているのと同じく、scale枚おきに間引いてゲーム内時間の間隔を等倍時に揃える。
        stride = max(1, int(round(MENU_TIME_SCALE)))
        need = (STUTTER_PROBE_SAMPLES - 1) * stride + 1
        time.sleep(need / float(POLL_STREAM_FPS))
        frames = read_poll_frames(poll_raw_path, need)[::-1][::stride][::-1]
        if len(frames) < 2:
            return 0.0
    else:
        frames = [grab_frame(display, env, x, y, w, h)]
        for _ in range(STUTTER_PROBE_SAMPLES - 1):
            time.sleep(STUTTER_PROBE_INTERVAL_SEC)
            frames.append(grab_frame(display, env, x, y, w, h))
    dup_count = sum(
        1 for i in range(1, len(frames))
        if mad_masked(frames[i - 1], frames[i], mask) < STILL_MAD_THRESHOLD
    )
    return dup_count / (len(frames) - 1)
