"""低速録画(Issue #68)の実時間スケーリング。

起動側(`apps/api/src/workerEnv.ts`)が`FPS_LIMIT_TARGET_HZ`を渡すかどうかだけで決まり、
**ワーカーの中に「自宅かEC2か」の分岐は作らない**(docs/decisions/0010)。
"""
import math
import os


# 起動側(apps/api/src/workerEnv.ts)が`FPS_LIMIT_TARGET_HZ`を渡してきた場合、MOD
# (mods/common/fps_limiter_hook.cpp)がIDirect3DDevice9::Presentをその周波数へ
# スロットルする。th20はレンダリングfpsとゲームロジック更新が直結しているため、
# これはゲーム進行そのもののスローモーション化になる(touhou-recorder reports/47)。
# 実時間あたりのCPU負荷が下がり、等倍では処理落ちしていた高負荷区間(最低19.8fps)が
# 安定して目標fpsを維持できるようになる。
#
# **ワーカーは「自分がEC2にいるのか自宅にいるのか」を知らない**。低速録画かどうかは
# この環境変数の有無だけで決まり、未設定なら従来どおり等倍で動く(全タイトル共通)。
#
# ここで得られるスケール係数は「実時間がゲーム内時間の何倍になるか」で、等倍なら1.0、
# 30Hz指定なら2.0。**MOD内部の待機(dllmain.cppのScaledSleep)だけでなく、それを監視する
# こちら側のタイムアウト・猶予時間も同じ比率で伸ばさないと低速録画は成立しない**
# (reports/47で、スケール未適用のPOST_START_GRACE_SECのままステージ開始の導入演出中に
# 処理落ち検知が走り、3回とも誤リトライする事象が実際に発生した)。
NATIVE_FRAME_RATE_HZ = 60.0


def slow_motion_scale(env=None):
    """`FPS_LIMIT_TARGET_HZ`から実時間のスケール係数を求める(等倍なら1.0)。

    未設定・数値でない・0以下・60超のいずれも1.0へ丸める(高速化方向には使わない。
    このスケールはあくまで「ゲームを遅くしたぶん、監視側の時間も伸ばす」ためのもので、
    1.0未満にするとタイムアウトが本来より短くなって誤検知を招くだけ)。
    """
    raw = (env if env is not None else os.environ).get("FPS_LIMIT_TARGET_HZ")
    if not raw:
        return 1.0
    try:
        target_hz = float(raw)
    except ValueError:
        return 1.0
    if target_hz <= 0 or target_hz >= NATIVE_FRAME_RATE_HZ:
        return 1.0
    return NATIVE_FRAME_RATE_HZ / target_hz


def scaled_poll_count(base_count, time_scale):
    """実時間の長さをポーリング回数で表した定数を、低速録画のスケールに合わせて伸ばす。

    ポーリングは実時間駆動(`POLL_INTERVAL_SEC`)なので、`n回連続`という条件は
    `n * POLL_INTERVAL_SEC` **実時間秒**を意味する。低速録画ではその間にゲームが
    半分しか進まないため、回数を据え置くと条件がゲーム内時間で 1/time_scale に
    縮んでしまう。切り上げるのは、条件を本来より緩める方向へ丸めないため。
    """
    return math.ceil(base_count * time_scale)


def duplicate_rate_threshold_for_raw(threshold_percent, time_scale):
    """等倍換算の重複フレーム率の閾値を、**等倍へ戻す前の生データ**に対する閾値へ換算する。

    低速録画(Issue #68)の生データは、ゲームが目標fpsを完璧に維持できていても各フレームが
    `time_scale` 枚ずつ並ぶ(録画自体は等倍と同じ`-framerate 60`で撮るため)。等倍の閾値を
    そのまま当てると、正常な録画が必ず「処理落ち」と判定されてリトライされてしまう。

    ユニークなフレーム数 U は等倍化しても変わらず、総フレーム数だけが `time_scale` 倍に
    なる。生データの尺 T、等倍化後の尺 T/scale として

        raw = 1 - U/(60T)                     等倍化後 = 1 - U/(60T/scale)

    から `等倍化後 = scale*raw - (scale-1)`、逆に解いて

        raw = (等倍化後 + scale - 1) / scale

    等倍(scale=1)では換算しても値が変わらないので、既存タイトルの判定は一切変わらない。
    """
    if time_scale <= 1.0:
        return threshold_percent
    return (threshold_percent + (time_scale - 1) * 100.0) / time_scale
