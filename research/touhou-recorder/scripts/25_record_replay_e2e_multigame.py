#!/usr/bin/env python3
"""リプレイ自動再生・録画パイプラインのCLI(互換シム)。

**実装本体はリポジトリ直下の`recorder/`パッケージへ移動した**(フェーズ83)。
フェーズ25で作られたこのスクリプトは、その後の検証のたびに追記を重ねて2000行近くに
なっていたため、責務ごとにモジュール分割した。設計の全体像は`recorder/__init__.py`の
docstringと`docs/recording-pipeline.md`を参照。

コマンドライン(フラグ名・既定値・終了コード)は従来と完全に同じなので、過去の
レポート(`reports/`)に載っている実行例やクラウド側のentrypointはそのまま使える:

    python3 scripts/25_record_replay_e2e_multigame.py --game th10 --replay th10_07.rpy

Pythonから使う場合は、このシムを`importlib`で読むのではなく`recorder`パッケージを
直接importすること:

    from recorder import RecordingOptions, load_game_config, record_with_retry
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recorder.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
