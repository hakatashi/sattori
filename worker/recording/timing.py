"""録画速度(倍速録画 Issue #288・低速録画 Issue #316)に伴う実時間スケーリング。

起動側(`apps/api/src/workerEnv.ts`)が`FPS_LIMIT_TARGET_HZ`を渡すかどうかだけで決まり、
**ワーカーの中に「自宅かEC2か」の分岐は作らない**(docs/decisions/0010)。
"""
import math
import os


# 起動側(apps/api/src/workerEnv.ts)が`FPS_LIMIT_TARGET_HZ`を渡してきた場合、MOD
# (mods/common/fps_limiter_hook.cpp)がIDirect3DDevice9::Presentをその周波数へ
# スロットルし、倍速録画ではさらに`speed_hack_hook`がQueryPerformanceCounterの経過時間を
# 同じ倍率で伸ばす(`GameConfig.build_env()`が`SPEED_HACK_MULTIPLIER`を導出して渡す)。
# 東方作品はレンダリングfpsとゲームロジック更新が直結しているため、これはゲーム進行
# そのものの速度変更になる(touhou-recorder reports/47・85・89)。
#
# **ワーカーは「自分がEC2にいるのか自宅にいるのか」を知らない**。録画速度はこの環境変数の
# 有無だけで決まり、未設定なら従来どおり等倍で動く(全タイトル共通)。
#
# ここで得られるスケール係数は「実時間がゲーム内時間の何倍になるか」で、等倍なら1.0、
# 120Hz指定(2倍速)なら0.5、30Hz指定(低速録画)なら2.0。**MOD内部の待機(dllmain.cppの
# ScaledSleep)だけでなく、それを監視するこちら側の猶予時間も同じ比率で伸縮しないと
# 録画速度の変更は成立しない**(reports/47で、スケール未適用のPOST_START_GRACE_SECのまま
# ステージ開始の導入演出中に処理落ち検知が走り、3回とも誤リトライする事象が実際に発生した)。
NATIVE_FRAME_RATE_HZ = 60.0

# DirectSoundのセカンダリバッファ(BGM等)・WASAPIのミックスフォーマットの基準レート。
# 倍速録画の専用シンクのレートをゲームの実際の出力レート(44100Hz×倍率)に一致させる
# ために使う(48000Hzを基準にするとリサンプリングが余分に挟まって高域が減衰する、
# touhou-recorder reports/85)。
NATIVE_AUDIO_RATE_HZ = 44100

# 倍速録画で許す最大倍率。4倍速(240Hz)を超えるとx11grabのキャプチャが律速して
# 実用にならない(touhou-recorder reports/89 §4)うえ、未検証の領域になる。
MAX_SPEEDUP_MULTIPLIER = 4.0

# 低速録画で許す最大スケール。採用しているのは1/2倍速と1/3倍速(th15 Extra)で、これより遅い
# 速度は検証していない(touhou-recorder reports/91)。
MAX_SLOW_MOTION_SCALE = 3.0

# 低速録画の生データに対する重複フレーム率の閾値(%)。等倍の閾値から構造的な重複ぶんを換算すると
# 20Hzで76.67%になるが、正常な録画の実測が80.3〜80.4%で3回とも破棄された(reports/91 §4)。
# 実測は30Hzが58%、20Hzが80%。一方、メニューで止まった録画は等倍で86.1%(reports/92 §8)で、
# 低速ならユニークなフレームがさらに減るので30Hzで約93%、20Hzで約95%になる見込み。その間に置き、
# 映像が止まっている録画だけを弾く。処理落ちの判定はこの指標では行わない。
SLOW_MOTION_MAX_DUPLICATE_RATE = 90.0


def recording_time_scale(env=None):
    """`FPS_LIMIT_TARGET_HZ`から実時間のスケール係数を求める(等倍なら1.0)。

    未設定・数値でない・0以下はいずれも1.0へ丸める。倍速側は`MAX_SPEEDUP_MULTIPLIER`倍速
    (scale=0.25)より速い値を指定されても0.25で頭打ちにする(起動側の不具合で極端な値が
    渡っても、監視のタイムアウトが際限なく縮んで誤検知しないようにするため)。低速側も同じ理由で
    `MAX_SLOW_MOTION_SCALE`で頭打ちにする。
    """
    raw = (env if env is not None else os.environ).get("FPS_LIMIT_TARGET_HZ")
    if not raw:
        return 1.0
    try:
        target_hz = float(raw)
    except ValueError:
        return 1.0
    if target_hz <= 0:
        return 1.0
    return max(1.0 / MAX_SPEEDUP_MULTIPLIER, min(MAX_SLOW_MOTION_SCALE, NATIVE_FRAME_RATE_HZ / target_hz))


def is_speedup(time_scale):
    """倍速録画(実時間がゲーム内時間より短い)か。"""
    return time_scale < 1.0


def speedup_multiplier(time_scale):
    """倍速録画の倍率(2倍速なら2.0)。等倍・低速録画では1.0。"""
    return 1.0 / time_scale if is_speedup(time_scale) else 1.0


def capture_frame_rate_hz(time_scale):
    """x11grabのキャプチャフレームレート。

    倍速録画ではゲームが60N fpsで描画しているので、キャプチャも60N fpsにしないと
    半分以上のフレームを取りこぼし、等倍へ戻したときに実効fpsが落ちる(reports/85)。
    低速録画はゲームの進行が遅くなるだけで、60fpsのままで全フレームを捉えられる。
    """
    return round(NATIVE_FRAME_RATE_HZ * speedup_multiplier(time_scale))


def audio_capture_rate_hz(time_scale):
    """音声の録音サンプルレート。

    倍速録画ではMOD(dsound_hook/wasapi_hook)がゲームの再生周波数を倍率ぶん上げる
    (2倍速なら44100Hz→88200Hz、「テープの早回し」)。録音側も同じレートにしないと
    圧縮空間での高域(等倍へ戻すと11025Hz超に相当)が録音時点で失われる(reports/85・86)。
    等倍・低速録画ではNoneを返し、従来どおりシンクの既定レートのまま録る。
    """
    if not is_speedup(time_scale):
        return None
    return round(NATIVE_AUDIO_RATE_HZ * speedup_multiplier(time_scale))


def scaled_poll_count(base_count, time_scale):
    """実時間の長さをポーリング回数で表した定数を、録画速度のスケールに合わせて伸縮する。

    ポーリングは実時間駆動(`POLL_INTERVAL_SEC`)なので、`n回連続`という条件は
    `n * POLL_INTERVAL_SEC` **実時間秒**を意味する。倍速録画ではその間にゲームが
    倍率ぶん進み、低速録画では逆に遅れるため、回数を据え置くと条件がゲーム内時間で
    1/time_scale に伸び縮みしてしまう。切り上げるのは、条件を本来より緩める方向へ
    丸めないため。
    """
    return math.ceil(base_count * time_scale)


def scaled_confirmation_count(base_count, time_scale):
    """偶然の一致を弾くための連続回数(終了テンプレートの連続一致等)を伸縮する。

    `scaled_poll_count()`と違い、**倍速録画でも元の回数より減らさない**。この回数の役割は
    「動画圧縮ノイズ等による単発の偶然一致を弾く」ことで、ゲーム内時間の長さではない。
    2倍速で2回→1回に縮めると、連続一致を要求する意味自体が失われる(reports/34)。
    """
    return max(base_count, scaled_poll_count(base_count, time_scale))


def scaled_timeout_sec(base_sec, time_scale):
    """実時間で進む処理(起動・メニュー操作)を待つタイムアウトを伸縮する。

    低速録画では伸ばすが、**倍速録画でも元の値より短くはしない**。ゲームの起動やMODの
    メニュー操作の一部(th06c/th06ncのSleep待ち等)は実時間で進むため、縮めると間に合わずに
    失敗する(touhou-recorder reports/90)。
    """
    return base_sec * max(1.0, time_scale)


def duplicate_rate_threshold_for_raw(threshold_percent, time_scale):
    """重複フレーム率の閾値を、等倍へ戻す前の生データに対する閾値へ換算する。

    低速録画の生データは、ゲームが目標fpsを維持できていても各フレームが`time_scale`枚ずつ
    並ぶ(`SLOW_MOTION_MAX_DUPLICATE_RATE`)。倍速録画はキャプチャ自体を60N fpsで行うため
    構造的な重複が無く、等倍と同じ閾値を使う。
    """
    return SLOW_MOTION_MAX_DUPLICATE_RATE if time_scale > 1.0 else threshold_percent


def gpu_worker(env=None):
    """GPU(NVIDIA)を搭載したワーカーで動いているか(起動側が`GPU_WORKER=1`を渡す)。

    GPU系インスタンスで起動するジョブにだけ起動側(`apps/api/src/workerEnv.ts`)が付与する。
    これが立っていれば、GPU描画が必須ではないタイトルもGPU描画(Xorg+nvidia)とNVENCで
    録画する(倍速録画は全タイトルGPU前提で検証されている、touhou-recorder reports/89)。
    「どこで動いているか」ではなく「何が使えるか」を表す値である点に注意(decisions/0010)。
    """
    return (env if env is not None else os.environ).get("GPU_WORKER") == "1"
