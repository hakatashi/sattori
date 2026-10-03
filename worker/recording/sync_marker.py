"""同期マーカーによるA/V同期補正(Issue #288、touhou-recorder reports/88)。

別プロセスで録った映像・音声のmux(`recording/ffmpeg.py`の`mux_audio_video()`)は、
両ffmpegの`-copyts`のstart_time(壁時計)の差で音声の位置を決めていた(reports/28)。
しかし`ffmpeg -f pulse`のタイムスタンプは「読み取り時刻 − `pa_stream_get_latency()`」で、
モニターソースではシンク側のレイテンシも差し引かれるため、シンクの状態・環境によって
系統的にずれる(最大約0.6秒、reports/87 §6・reports/88)。さらにWineのDirectSound→
PulseAudioの出力遅延(約0.2秒)はどの方式でも補正されずに残り、等倍でも音声が
+90〜+190ms遅れていた。倍速録画ではこれらが等倍へ戻す際にN倍へ拡大される。

そこで、ゲームのMOD(`mods/common/dsound_hook.cpp`・`wasapi_hook.cpp`)に、録音開始後に
置かれるトリガーファイルを合図として**ゲーム自身の音声デバイスから**低レベル(-42dBFS)の
疑似乱数ノイズを1回(約3秒)鳴らさせ、Play直前の壁時計時刻をMODログへ出させる。録画後に
音声からその系列を白色化相互相関(PHAT)で探し出せば、「音声上の位置 ↔ ゲームが発音を
指示した壁時計時刻」の対応がタイムスタンプを一切経由せずに得られる。ゲームのBGM/SEと
同じミキサー・同じPulseAudioストリームを通るので、出力遅延もまとめて打ち消される
(合成プローブでの実測誤差は±20ms以内、reports/88)。

マーカーが見つからない場合(MODログに記録が無い・相関ピークが弱い)は、従来どおり
start_timeの差で補正する(録画自体は失敗させない)。
"""
import os
import re
import subprocess
import threading

import numpy as np

# トリガーから鳴らすまでの待ち。音声ffmpegがpulseへ接続して実際に録音を始めるまでの
# 時間(ローカル・AWSとも1秒未満)に余裕を持たせる。
TRIGGER_DELAY_SEC = 2.0
# マーカーを探す範囲(音声ファイル先頭からの秒数)。マーカーはゲームの進行速度(倍速・
# 低速)によらず録画開始の約TRIGGER_DELAY_SEC秒後に実時間で鳴る。PHATは探索範囲の
# 全体でスペクトルを平坦化するので、範囲を広げるほどピーク比は下がる(th15の実録画で
# 振幅64のとき 5秒=37、10秒=20、30秒=13、reports/88)。
SEARCH_SEC = 20.0
# 相関ピーク/中央値の比がこれを下回ったら見つからなかったとみなす。
MIN_PEAK_RATIO = 20.0
# mux後に検証した残差がこれを超えたら、残差を差し引いて1回だけmuxし直す。
RESIDUAL_TOLERANCE_SEC = 0.003

_MARKER_RE = re.compile(
    r"SYNC_MARKER played epoch=([0-9.]+) play_call_sec=([0-9.]+) rate=(\d+) samples=(\d+) "
    r"amp=(-?\d+) seed=0x([0-9A-Fa-f]+) hr=0x([0-9A-Fa-f]+)"
)


def trigger_path(config):
    return f"{config.instance_dir}/sync_marker.trigger"


def windows_path(path):
    """Wine内のMODから開けるパス(Z:ドライブ=/)。"""
    return "Z:" + os.path.abspath(path).replace("/", "\\")


# 設置待ちのトリガー(instance_dirごと)。前の試行が設置前に中断された場合に、次の試行の
# ゲーム起動後(音声の録音開始前)に古いタイマーがトリガーを置いてしまうと、MODが録音開始前に
# マーカーを鳴らし終えて検出できなくなるため、`clear_trigger()`で必ず止める。
_pending_timers = {}


def clear_trigger(config):
    """設置待ちのトリガーを取り消し、既に置かれたトリガーファイルを消す。各試行の開始時に呼ぶ。"""
    timer = _pending_timers.pop(config.instance_dir, None)
    if timer is not None:
        timer.cancel()
    try:
        os.remove(trigger_path(config))
    except FileNotFoundError:
        pass


def schedule_trigger(config, delay=TRIGGER_DELAY_SEC, log=print):
    """録画開始後、`delay`秒たってからトリガーファイルを置く(非同期)。"""
    def _touch():
        try:
            with open(trigger_path(config), "w") as f:
                f.write("sync\n")
        except OSError as err:
            log(f"WARNING: 同期マーカーのトリガーを設置できませんでした: {err!r}")
            return
        log("同期マーカーのトリガーを設置しました")
    t = threading.Timer(delay, _touch)
    t.daemon = True
    _pending_timers[config.instance_dir] = t
    t.start()
    return t


def parse_marker_log(log_path, log=print):
    """MODログから最後のSYNC_MARKER行を読む。見つからなければNone。"""
    try:
        with open(log_path, errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    found = _MARKER_RE.findall(text)
    if not found:
        return None
    epoch, call_sec, rate, samples, amp, seed, hr = found[-1]
    if int(hr, 16) != 0:
        log(f"WARNING: 同期マーカーのPlayが失敗しています (hr=0x{hr})")
        return None
    return dict(epoch=float(epoch), play_call_sec=float(call_sec), rate=int(rate),
                samples=int(samples), amp=int(amp), seed=int(seed, 16))


def marker_sequence(samples, seed):
    """MODと同じxorshift32の最下位ビットによる±1系列。"""
    out = np.empty(samples, dtype=np.float64)
    x = seed & 0xFFFFFFFF
    for i in range(samples):
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        out[i] = 1.0 if (x & 1) else -1.0
    return out


def decode_mono(path, rate, env=None, stream="a:0", duration=SEARCH_SEC):
    """音声を「muxが使うのと同じ時間軸」でモノラルfloatにデコードする。

    `-copyts`を付けずにデコードするとffmpegは入力のstart_timeを差し引き、さらに
    `aresample=first_pts=0`でt=0から始まるよう先頭を無音で埋める。これでサンプル番号 h が
    「入力ファイルのstart_timeからh/rate秒後」に厳密に対応する(AACのプライミング
    サンプルの扱いもmux時と一致する)。"""
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-map", f"0:{stream}",
         "-t", f"{duration}", "-af", "aresample=first_pts=0", "-ac", "1", "-ar", str(rate),
         "-f", "f32le", "-"],
        stdin=subprocess.DEVNULL, capture_output=True, env=env,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def locate(signal_, seq):
    """PHAT(白色化)相互相関で系列の開始位置を探す。(位置, ピーク/中央値比)を返す。"""
    n = len(signal_) + len(seq)
    nfft = 1 << int(np.ceil(np.log2(n)))
    y = np.fft.rfft(signal_, nfft)
    p = np.fft.rfft(seq, nfft)
    cross = y * np.conj(p)
    c = np.fft.irfft(cross / (np.abs(cross) + 1e-12), nfft)[:len(signal_)]
    a = np.abs(c)
    k = int(np.argmax(a))
    med = float(np.median(a)) or 1e-12
    # 放物線補間でサブサンプル精度にする
    frac = 0.0
    if 0 < k < len(a) - 1:
        y0, y1, y2 = a[k - 1], a[k], a[k + 1]
        den = y0 - 2 * y1 + y2
        if den != 0:
            frac = 0.5 * (y0 - y2) / den
    return k + frac, a[k] / med


def find_marker_time(path, marker, env=None, stream="a:0"):
    """音声(入力ファイルのstart_time基準)上でマーカーが始まる秒数と信頼度。
    デコードできなければ(None, 0.0)。"""
    rate = marker["rate"]
    try:
        x = decode_mono(path, rate, env=env, stream=stream)
    except (subprocess.SubprocessError, OSError):
        return None, 0.0
    if len(x) < marker["samples"]:
        return None, 0.0
    pos, ratio = locate(x, marker_sequence(marker["samples"], marker["seed"]))
    return pos / rate, ratio


def verify_output(output_path, marker, video_first_frame_epoch, env=None):
    """mux後の動画で、マーカーの音声上の位置と映像の時間軸上の期待位置の差(秒)を返す。

    映像の時間軸: 出力動画の映像ストリームのstart_time(ファイル先頭基準)が、
    録画した映像の先頭フレームの壁時計時刻に対応する。

    ffprobeの失敗・想定外の出力(`N/A`等)では(None, 0.0)を返す。検証は補正の念押しに
    すぎないため、ここで例外を出して録画の試行ごと失敗させてはならない。"""
    try:
        return _verify_output(output_path, marker, video_first_frame_epoch, env)
    except (ValueError, IndexError, subprocess.SubprocessError, OSError):
        return None, 0.0


def _verify_output(output_path, marker, video_first_frame_epoch, env):
    def stream_start(sel):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", sel, "-show_entries",
             "stream=start_time", "-of", "csv=p=0", output_path],
            capture_output=True, text=True, env=env).stdout.strip()
        return float(out.splitlines()[0]) if out else None
    fmt = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0",
         output_path], capture_output=True, text=True, env=env).stdout.strip()
    v_st = stream_start("v:0")
    if v_st is None or not fmt:
        return None, 0.0
    v_rel = v_st - float(fmt)
    t_audio, ratio = find_marker_time(output_path, marker, env=env)
    if t_audio is None:
        return None, ratio
    t_expected = v_rel + (marker["epoch"] - video_first_frame_epoch)
    return t_audio - t_expected, ratio
