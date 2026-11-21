"""パイプライン全体で共有する簡易ロガー。

出力形式(`[HH:MM:SS] メッセージ`)は`scripts/25_record_replay_e2e_multigame.py`時代から
変えていない。過去のレポート(`reports/`)に貼られた実行ログや、クラウド録画の
`record_stdout.log`を後から突き合わせる際に同じ形で読めるようにするため。
"""
import time


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
