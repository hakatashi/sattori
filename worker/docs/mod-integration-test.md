# MOD統合テスト（`tests/mod_integration/run.py`、`worker/games/`がある環境限定）

`worker/mods/` を変更したときに、決まった短いリプレイで退行を自動検知するローカル専用の
スクリプトの使い方・判定基準・前提条件。MOD を触った後、実機検証へ進む前に読むこと。
[`worker/README.md`](../README.md) §14 から分けた。

`worker/mods/`(`*_hook.dll`)を変更した際、実機検証(`verify-recording-locally` skill・
touhou-recorderのreports/)に進む前の速い足がかりとして、決まった短いリプレイで自動退行
検知ができる(`tests/mod_integration/run.py`)。CIの`mods-build-smoketest`はビルドが通るか
しか見ておらず実機注入テストの代わりにはならないため、このスクリプトはその隙間を埋める
(**このテスト自体もCIには組み込んでおらず、pushごとには実行しない**。ゲーム資産の
ライセンス・実行コストの都合、[`decisions/0049`](../../docs/decisions/0049-mod-integration-test-local-only.md))。

**`worker/games/<game>/`・`worker/prefixes/<game>-wined3d-gl/`にゲーム本体・WINEPREFIXが
展開済みの環境専用**(`worker/README.md` §11のホスト直接実行と同じ経路。Dockerコンテナは使わず、ホストの
Wine/Xvfb/PulseAudioをそのまま使う)。

```bash
python3 tests/mod_integration/run.py               # 対象タイトル全部(現状th06/th08)
python3 tests/mod_integration/run.py --game th06
```

判定基準は本番と同じ自動検知ロジックをそのまま使う。`record_thNN.py`の異常終了(重複
フレーム率超過による全試行失敗を含む)・デシンク検知(`recording.modlog.
check_replay_desync()`)・タイムアウト打ち切りのいずれかが起きればNGとする。

**このスクリプトは実機検証の代わりにはならない**。判定できるのは「今のMODが壊れていない
か」という退行検知のみで、新規タイトル対応や未検証のインスタンスタイプでの妥当性確認は
これまで通り実機検証が必須(AGENTS.md §3)。またDockerコンテナを介さずホストの環境を
直接使うため、`worker/README.md` §11と同じくWineプロセス残留のリスクを伴う(`timeout --kill-after=`を
必ず併用する設計にしてある)。

同一ホストで自宅ワーカーデーモン(`sattori-home-worker`)が稼働している場合は、Xvfbの
ディスプレイ番号・PulseAudioの競合を避けるため停止していること(稼働中なら中断する)。
検証用リプレイは`tests/fixtures/mod-integration/`にタイトルごと1本ずつ配置している
(短時間で自然終了するもの限定。狙いは`tests/fixtures/mod-integration/README.md`参照)。
対象タイトルを増やす場合は同じ条件のリプレイを追加し、`run.py`の`TITLES`辞書に期待
スコア(threpで確認できるリプレイの記録スコア)を登録すること。
