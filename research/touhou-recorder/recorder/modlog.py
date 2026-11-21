"""MOD(`mods/`)が書き出すログファイルの読み取り。

MODはリプレイ自動再生の進行状況を`{instance_dir}/{game_id}_autoplay.log`へ追記していく。
録画パイプラインはこのログの特定マーカーを待って次の段階へ進む:

  - `WaitForStableWindow: stable` … ウィンドウ生成が落ち着いた(録画開始のトリガ)
  - `sequence complete`           … リプレイ選択のキーシーケンスが完了した(再生開始とみなす)
  - `FpsMonitor: ... (NN Hz)`     … 入力ポーリング頻度(fps暴走の検知材料)

ステージ遷移・弾幕パターンのマーカー(`StageMarker:`)は`recorder/chapters.py`が扱う。
"""
import os
import re
import time

from .log import log
from .timing import MENU_TIME_SCALE

FPS_MONITOR_HZ_RE = re.compile(r"FpsMonitor:.*\(([\d.]+) Hz\)")
def speedup_runaway_threshold(threshold):
    """倍速録画ではポーリング頻度も倍率分上がるので、等倍前提の閾値を倍率分引き上げる
    (th09は1フレーム3回ポーリングで2倍速時360Hz、タイトル別閾値300Hzで誤検知した。
    reports/89)。等倍・低速録画では何もしない。"""
    if 0 < MENU_TIME_SCALE < 1.0:
        return threshold / MENU_TIME_SCALE
    return threshold


# fps暴走の既定閾値。リプレイ再生中に内部fpsが数百〜数千に跳ね上がり、リプレイが実時間の
# 数十分の一で終わってしまう現象(reports/22)の検知用。公式アップデータver1.00dへの更新で
# th08では事実上解消したが、稀な残存ケースへの備えとして残している。
# タイトルごとの緩和は`GameConfig.fps_runaway_hz_threshold`(th09は300Hz、reports/68)。
FPS_RUNAWAY_HZ_THRESHOLD = (
    float(os.environ["FPS_RUNAWAY_HZ_THRESHOLD"]) if "FPS_RUNAWAY_HZ_THRESHOLD" in os.environ
    else speedup_runaway_threshold(100.0)
)
FPS_RUNAWAY_CONSECUTIVE_REQUIRED = 2


def wait_for_log_marker(log_path, marker, timeout, poll_interval=0.1, log_all=False, seen_lines=None):
    """MODログに`marker`を含む行が現れるまで待ち、検出時刻(epoch秒)を返す。

    `seen_lines`(既読行の集合)を呼び出し間で共有すると、同じ行を二重に転記しない。
    `log_all=True`なら待機中に現れた新規行を全て標準出力へ転記する(起動シーケンスの
    追跡用)。タイムアウトしたらNoneを返す。
    """
    if seen_lines is None:
        seen_lines = set()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(log_path):
            with open(log_path, encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            for line in lines:
                if line in seen_lines:
                    continue
                seen_lines.add(line)
                if log_all:
                    log(f"MODログ: {line.strip()}")
                if marker in line:
                    return time.time()
        time.sleep(poll_interval)
    return None


def scan_fps_runaway(log_path, threshold=FPS_RUNAWAY_HZ_THRESHOLD):
    """FpsMonitorログを走査し、閾値超えが連続した場合にその最大値を返す(無ければNone)。

    単発のスパイクで打ち切らないよう、FPS_RUNAWAY_CONSECUTIVE_REQUIRED回連続で
    閾値を超えていることを要求する。
    """
    if not os.path.exists(log_path):
        return None
    with open(log_path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    hz_values = [float(v) for v in FPS_MONITOR_HZ_RE.findall(text)]
    for i in range(len(hz_values) - FPS_RUNAWAY_CONSECUTIVE_REQUIRED + 1):
        window = hz_values[i:i + FPS_RUNAWAY_CONSECUTIVE_REQUIRED]
        if all(v > threshold for v in window):
            return max(window)
    return None
