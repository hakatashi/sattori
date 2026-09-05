"""別プロセスへファイル経由で渡す成果物の書き出し。

`record_thNN.py` は `entrypoint.py` から `subprocess` で起動される別プロセスのため、
戻り値を直接返せない。進捗・デシンク検証結果・タイムアウト打ち切りの有無はいずれも
一時ファイル → `os.replace` でアトミックに書き、読み手が書きかけを掴まないようにする。
"""
import json
import os


def save_progress_snapshot(progress_dir, color_frame, elapsed_seconds, expected_duration_seconds):
    """録画中の画面プレビュー(frame.jpg)と進捗算出用の状態(state.json)を書き出す。
    entrypoint.py側のバックグラウンドスレッドがこれをポーリングしてS3へアップロードする。
    一時ファイル→os.replaceでアトミックに上書きし、読み手が書きかけファイルを掴まないようにする。
    """
    thumb = color_frame.copy()
    thumb.thumbnail((480, 480))
    tmp_frame_path = f"{progress_dir}/frame.jpg.tmp"
    thumb.save(tmp_frame_path, "JPEG", quality=80)
    os.replace(tmp_frame_path, f"{progress_dir}/frame.jpg")

    state = {"elapsedSeconds": elapsed_seconds, "expectedDurationSeconds": expected_duration_seconds}
    tmp_state_path = f"{progress_dir}/state.json.tmp"
    with open(tmp_state_path, "w") as f:
        json.dump(state, f)
    os.replace(tmp_state_path, f"{progress_dir}/state.json")


def save_diagnostics_snapshot(diagnostics_dir, color_frame, attempt, classification):
    """試行を破棄した際の最終フレームを1枚だけ書き出す(Issue #159)。

    録画が早期に打ち切られたジョブでは`progress_dir`(ProgressReporterのポーリング間隔
    約10秒より先に録画が終わる)に進捗スクリーンショットが1枚も残らず、失敗時の画面を
    事後確認できない。ユーザー向けプレビューの`progress_dir`とは別に、entrypoint.py側が
    S3(`diagnostics/{jobId}/`)へアップロードする調査用の証跡として書き出す。
    `diagnostics_dir`未指定、またはフレームが得られなかった(生成前に破棄された等)場合は
    何もしない。
    """
    if not diagnostics_dir or color_frame is None:
        return
    thumb = color_frame.copy()
    thumb.thumbnail((960, 960))
    path = f"{diagnostics_dir}/attempt{attempt}-{classification}.jpg"
    tmp_path = f"{path}.tmp"
    thumb.save(tmp_path, "JPEG", quality=85)
    os.replace(tmp_path, path)


def write_desync_result(path, desync_detected):
    """リプレイずれ検証の結果をJSONへ書き出す。

    record_with_retry()は record_thNN.py という別プロセス(entrypoint.pyの
    subprocess.run経由)で動くため、戻り値をそのまま親プロセスへ返せない。
    ProgressReporterのstate.json(save_progress_snapshot())と同じファイル受け渡しの
    方式を使い、entrypoint.py側がジョブ完了後にこれを読んでJobsTableへ書き込む。
    """
    if not path:
        return
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump({"desyncDetected": desync_detected}, f)
    os.replace(tmp_path, path)


def write_timeout_result(path, timed_out):
    """録画終了の検知方式がタイムアウト打ち切りだったかをJSONへ書き出す(Issue #161)。

    テンプレート照合・画面静止でリプレイ終了を検知できないまま録画時間の上限に
    達した場合、リプレイ終盤が録画されていない可能性が高い。write_desync_result()
    と同じファイル受け渡しの方式(record_thNN.pyの別プロセス→entrypoint.py)を使う。
    """
    if not path:
        return
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump({"timedOut": timed_out}, f)
    os.replace(tmp_path, path)
