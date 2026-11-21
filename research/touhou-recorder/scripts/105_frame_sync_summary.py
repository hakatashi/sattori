#!/usr/bin/env python3
"""フレーム同期キャプチャ(reports/105)のMODログを集計する。

使い方: scripts/105_frame_sync_summary.py <autoplay.log> [区間フレーム数(既定3600=動画1分)]

MODは600フレームごとに次の行を出す:
  FrameSync: stats frame=N written=N real_ms=T fps=F game_ms=.. readback_ms=.. write_ms=..
             present_ms=.. unthrottled=0|1
上限を外した区間(unthrottled=1)だけを対象に、処理速度(1秒に処理できたフレーム数。60で
割ると倍速)と、1フレームの内訳(ゲーム本体・読み出し・パイプ書き込み・Present)を出す。

  game_ms      前のPresentが戻ってから次のPresentが呼ばれるまで(ゲームのロジックと描画コールの発行)
  readback_ms  GetBackBuffer〜LockRect(描画の完了待ちを含む)
  write_ms     FIFOへの書き込み(エンコードが律速のときはここで待たされる)
  present_ms   本来のPresent(Xへの転送)

あわせてScoreMonitorの最終スコアを表示する。
"""
import re
import sys

log_path = sys.argv[1]
bin_frames = int(sys.argv[2]) if len(sys.argv) > 2 else 3600

STATS_RE = re.compile(
    r"FrameSync: stats frame=(\d+) written=(\d+) real_ms=(\d+) fps=([\d.]+) game_ms=([\d.]+) "
    r"readback_ms=([\d.]+) write_ms=([\d.]+) present_ms=([\d.]+) unthrottled=(\d)(?: readback2_ms=([\d.]+))?(?: audio_ms=([\d.]+))?")
SCORE_RE = re.compile(r"ScoreMonitor: score=(\d+)")

rows = []
last_score = None
max_score = 0
stopped = None
prev_frame = 0
for line in open(log_path, errors="ignore"):
    m = STATS_RE.search(line)
    if m:
        frame = int(m.group(1))
        rows.append(dict(frame=frame, n=frame - prev_frame, real_ms=float(m.group(3)),
                         fps=float(m.group(4)), game=float(m.group(5)), readback=float(m.group(6)),
                         write=float(m.group(7)), present=float(m.group(8)),
                         unthrottled=m.group(9) == "1",
                         readback2=float(m.group(10) or 0),
                         audio=float(m.group(11) or 0)))
        prev_frame = frame
        continue
    m = SCORE_RE.search(line)
    if m:
        last_score = int(m.group(1))
        max_score = max(max_score, last_score)
        continue
    m = re.search(r"FrameSync: capture stopped frames_written=(\d+) present_count=(\d+)", line)
    if m:
        stopped = (int(m.group(1)), int(m.group(2)))

if not rows:
    print("NO DATA")
    sys.exit(1)

free = [r for r in rows if r["unthrottled"]]
print(f"stats行: 全{len(rows)} / 上限解除中{len(free)}")
if stopped:
    print(f"停止時: frames_written={stopped[0]} present_count={stopped[1]}")
print(f"ScoreMonitor: 最終score={last_score} 最大score={max_score} (表示スコアは×10)")
if not free:
    sys.exit(0)

n = sum(r["n"] for r in free)
real = sum(r["real_ms"] for r in free)
fps_sorted = sorted(r["fps"] for r in free)


def wavg(key):
    return sum(r[key] * r["n"] for r in free) / n


print(f"上限解除中: {n}フレーム(動画{n / 60:.1f}秒)を実時間{real / 1000:.1f}秒 = "
      f"平均{n * 1000 / real:.1f}fps({n * 1000 / real / 60:.2f}倍速)")
print(f"  600フレーム窓のfps: 最小{fps_sorted[0]:.1f} 下位5%{fps_sorted[len(fps_sorted) // 20]:.1f} "
      f"中央{fps_sorted[len(fps_sorted) // 2]:.1f} 最大{fps_sorted[-1]:.1f}")
total = wavg("game") + wavg("readback") + wavg("write") + wavg("present")
print(f"  1フレームの内訳(平均ms): game={wavg('game'):.2f} readback={wavg('readback'):.2f} "
      f"write={wavg('write'):.2f} present={wavg('present'):.2f} 合計={total:.2f}")
if wavg("audio") > 0:
    print(f"  音声のミックス(Present前、合計に含まない)={wavg('audio'):.2f}ms")
if wavg("readback2") > 0:
    print(f"  診断(FRAME_SYNC_PROBE_READBACK2): 読み出しそのもの={wavg('readback2'):.2f}ms"
          "(合計には含まない)")

bins = {}
for r in free:
    b = r["frame"] // bin_frames
    acc = bins.setdefault(b, dict(n=0, real=0.0, game=0.0, readback=0.0, write=0.0, present=0.0))
    acc["n"] += r["n"]
    acc["real"] += r["real_ms"]
    for k in ("game", "readback", "write", "present"):
        acc[k] += r[k] * r["n"]
print(f"区間({bin_frames}フレーム)ごと:")
print("  区間   fps   倍速  game  readback  write  present")
for b in sorted(bins):
    a = bins[b]
    fps = a["n"] * 1000 / a["real"]
    print(f"  {b:4d} {fps:6.1f} {fps / 60:5.2f} {a['game'] / a['n']:5.2f} {a['readback'] / a['n']:9.2f} "
          f"{a['write'] / a['n']:6.2f} {a['present'] / a['n']:8.2f}")
