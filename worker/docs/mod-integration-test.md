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
python3 tests/mod_integration/run.py                          # 対象タイトル全部(現状13本、フレーム同期)
python3 tests/mod_integration/run.py --game th06
python3 tests/mod_integration/run.py --capture-mode realtime  # 従来の実時間の録画(x11grab・PulseAudio)
```

**既定はフレーム同期キャプチャ(`CAPTURE_MODE=frame_sync`)**。本番の主力の経路で、ゲームが
フレーム単位で決定的に動く(`recording/framesync.py`)ため、実時間の録画では取れなかった厳密な
検証ができる。実時間の経路は`--capture-mode realtime`で残してある(実時間用のMODの退行検知用)。

## 判定基準(フレーム同期)

録画側(`record_thNN.py`)の合否(三者照合・理論尺・Wineクラッシュ・スコア0・デシンク検知・タイム
アウト打ち切り)に加えて、`tests/mod_integration/checks.py`の次の項目を全部満たすこと。
**基準値は`run.py`の`TITLES`に持つ**(実機録画で採取した値、リプレイを差し替えたら採り直す)。

| 項目 | 内容 |
| --- | --- |
| 三者照合 | MODが書いたフレーム数 == 動画 == 音声(端数0バイト) |
| MODログの整合 | `present_count - frames_written == 1`、仮想ミキサの書き出し・ミックス数が映像と一致、補充待ちタイムアウト・未知のPlayが0(th20のBGM周回境界は`max_refill_timeouts`で許容)、`FrameSync: ERROR`・`TIMEOUT`行が無い |
| 取り込みサイズ | `capture start`の解像度が基準(th06ncは1280x720、th20は1280x960、他は640x480) |
| 再生区間の長さ | リプレイ再生開始〜終了検知が基準値の±2.5秒以内(終了検知は動画の2秒おきの格子)。本番の理論尺比較(-30%〜+10%)よりずっと厳しい |
| 最終状態 | 記録スコアに到達したサンプルの(ステージ,残機,グレイズ)が基準と**完全一致**(決定的なので) |
| 被弾回数・被弾時刻 | 残機が減った回数が一致し、各被弾の**ゲーム内の時刻**(リプレイ再生開始からの秒)が基準の±2秒以内 |
| 出力動画の形式 | 解像度が取り込みサイズと一致・60fps・フレーム数が書き出し数と一致・音声ストリームあり・映像と音声の長さの差0.1秒以内 |
| 音声 | `volumedetect`のmax_volumeが-40dB以上(無音でない) |
| 画面 | 動画の25/50/75%位置のフレームが真っ黒・真っ白でない |

ScoreMonitorは実時間20ms間隔のポーリングで行にフレーム番号が無い。そこで被弾時刻は、MODログの
`FrameSync: stats frame=N`(600フレームごと)から実時間→フレーム番号を線形補間して換算する
(誤差はfpsの揺れで最大1秒程度)。**実時間の差は意味を持たない**(フレーム同期のゲームは可変速)ので、
実時間の経路のように最初のサンプルからの経過秒で比べてはならない。

th09はスコア未監視、th06c・th06ncは残機・グレイズのRVA未特定、th128は残機がゴミ値になるため、
該当する項目は基準値を持たず省いてある(`TITLES`の注)。観測値は毎回標準出力へ`観測値:`として
出るので、基準値を採り直すときはそれを見る。

実時間(`--capture-mode realtime`)の判定基準は、`record_thNN.py`の異常終了(重複フレーム率超過を含む)・
デシンク検知・タイムアウト打ち切り・被弾タイミング(最初のサンプルからの実時間の秒)。

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
