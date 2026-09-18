# th15(東方紺珠伝)録画対応をsattori本体の`record_th15.py`でローカル実機検証

- **検証日**: 2026-09-17
- **対象**: th15(東方紺珠伝 ～ Legacy of Lunatic Kingdom.)録画対応(Issue #82)。MOD移植
  (`mods/th15_replay_autoplay/`)・`record_th15.py`・スコア監視RVA・終了検知(画面静止)
- **環境**: 自宅ワーカー機(HakataMatrix)、ホスト直接実行(`worker/README.md` §11・
  `docs/runbooks/worker-local-recording.md` §2と同じ経路。事前に`systemctl is-active
  sattori-home-worker`が`inactive`であることを確認済み)。ゲーム本体・WINEPREFIXは
  touhou-recorderの検証済み資産(reports/82)から`worker/games/th15`・
  `worker/prefixes/th15-wined3d-gl`へインポート(いずれも`.gitignore`対象)
- **結論**: 短尺リプレイ(`th15_09.rpy`、Extra、frameCount=9215)の録画が1回目の試行で
  成功。記録スコア17,101,210との完全一致・重複フレーム率2.1%・画面静止による終了検知
  いずれも実機確認できた。**このマシンにNVIDIA GPUが無いため、`gpu_display=True`
  (本番のGPU描画経路)自体は検証できていない**——本検証は`gpu_display=False`
  (Xvfb+wined3d)へ一時的に切り替えて実施しており、GPUによるExtraステージの処理落ち
  解消自体はtouhou-recorder側で実機検証済み(reports/82、AWS g6f.2xlarge)。

sattori本体のコード(`worker/record_th15.py`・`worker/mods/th15_replay_autoplay/`)を
使い、touhou-recorderで事前検証済みの設計(reports/82)——特にMODの入力ポーリング方式
(GetDeviceState、th10と同じ)とスコア監視RVA——がsattori側でも同様に機能することを
確認した。

## 目的

- MOD新規実装(`mods/th15_replay_autoplay/dllmain.cpp`。th20のフレームワーク構造
  [FpsLimiterHook・DSoundHook・ScoreMonitor] に、th10と同じPressKey(DIK)方式の入力
  注入・メニュー操作シーケンス [Down×2→Enter→Right→Enter→Enter] を組み合わせた新規
  ビルド)が、sattoriの`mods/Makefile`でクロスビルドでき、録画パイプライン(`recording/`
  パッケージ)上で問題なく動作するか確認する。
- スコア監視RVA(`baseRva=0xE7400`、`scoreOffset=0x0C`・`livesOffset=0x50`・
  `grazeOffset=0x1C`)がsattoriの`recording.modlog`経由でも記録スコアと完全一致するか
  確認する。
- 終了検知(画面静止のみ、`still_detect_exclude_rect`によるポストリプレイメニューの除外)
  が正しく機能するか確認する。
- `uses_appdata_profile`(`%APPDATA%/ShanghaiAlice/th15/`)による cfg/リプレイの配置が
  機能するか確認する。

## 方法

1. `systemctl is-active sattori-home-worker`が`inactive`であることを確認。
2. touhou-recorderの`games/th15`(`th15.exe`・`th15.dat`・`thbgm.dat`・`th15.cfg`)・
   `prefixes/th15-wined3d-gl`を`worker/games/th15`・`worker/prefixes/th15-wined3d-gl`
   へコピー(いずれも`.gitignore`対象)。
3. `i686-w64-mingw32-g++`(`mods/Makefile`の`th15`ターゲット)で
   `mods/th15_replay_autoplay/dllmain.cpp`をクロスビルドし`th15_hook.dll`を生成
   (`-static`、共通ソース: dinput_hook・window_wait・logging・score_monitor・
   fps_monitor・fps_limiter_hook・dsound_hook)。ビルドエラーなし。
4. `record_th15.py`の`GameConfig.gpu_display`を一時的に`False`へ変更(このマシンに
   NVIDIA GPUが無いため、`recording/gpu_display.py`のXorg+nvidia経路は実行できない。
   `verify-recording-locally` skill §0.0参照)。
5. `entrypoint.py`を経由せず`record_th15.py`をホスト上で直接呼び出し、ユーザー提供の
   短尺検証用リプレイ`worker/tests/fixtures/mod-integration/th15/th15_09.rpy`
   (Extra、`frameCount`=9215、記録スコア17,101,210、`threp -j`相当の
   `@sattori/touhou-replay-parser` CLIで確認)を録画した。

```bash
cd worker
timeout --kill-after=30s 420s python3 record_th15.py \
  --replay-path tests/fixtures/mod-integration/th15/th15_09.rpy \
  --output /tmp/th15-verify/repro.mp4 \
  --diagnostics-dir /tmp/th15-verify/diagnostics \
  --progress-dir /tmp/th15-verify/progress \
  --expected-duration-seconds 153.58 \
  --expected-score 17101210 \
  --desync-result-path /tmp/th15-verify/desync.json \
  --timeout-result-path /tmp/th15-verify/timeout.json \
  --max-attempts 1
```

6. 検証終了後、`GameConfig.gpu_display`を本番値の`True`へ戻し、検証用の出力・
   インスタンスディレクトリを削除した。

## 結果

| 項目 | 結果 |
| --- | --- |
| 試行回数 | 1回目で成功(リトライなし) |
| 総録画時間 | 191.1秒 |
| 終了検知方式 | 画面静止検知(`still_detect_exclude_rect=[(81, 350, 470, 800)]`で
  ポストリプレイメニューを除外、意図どおり) |
| 重複フレーム率(録画開始15秒以降、30秒スポット) | 2.1%(閾値30.0%を大きく下回る) |
| リプレイずれ事後検証 | 記録スコア(17,101,210)と一致するサンプルを確認
  (`desyncDetected: false`) |
| タイムアウト打ち切り | 無し(`timedOut: false`) |
| メニュー操作シーケンス | Down×2 → Enter → Right → Enter → Enterの全ステップが
  約4秒(05:48:08〜05:48:12)で完了 |
| 入力ポーリング方式 | MODログで`DirectInput8Create`/`CreateDevice: hooked
  GetDeviceState`を確認。`FpsMonitor`ログは56.8〜59.9Hzで安定。GetKeyboardStateフック
  無しでメニュー操作が正しく反映され、touhou-recorder reports/82の知見
  (th15はth10と同じGetDeviceState方式)がsattori側のMODでも成立することを確認 |
| A/V同期補正 | delta=-0.035s(問題ない範囲) |

MODログ(`instances/th15-recording/th15_autoplay.log`)のScoreMonitor推移を確認したところ、
`lives`が2から段階的に減少し最終的に`-1`(ゲームオーバー)に到達、最終内部スコア値
`1710121` × 10(倍率、th07/th08/th10/th11/th20と同じ分類) = `17101210`が
リプレイファイルの記録スコアと完全一致した。

## 考察・既知の限界

- **GPU描画経路(`gpu_display=True`、本番のg6f系インスタンスで使う設定)自体は
  このマシンにNVIDIA GPUが無いため検証できていない**(th06ncと同じ制約、
  `verify-recording-locally` skill §0.0)。本検証はMOD・録画パイプラインの結合
  (メニュー自動操作・スコア監視・終了検知・出力動画生成)がsattori側のコードで
  問題なく動くことの確認に限定される。GPUによるExtraステージの処理落ち解消は
  touhou-recorder側で実機検証済み(reports/82、AWS g6f.2xlarge)。
- 短尺リプレイ(Extra、frameCount=9215、約154秒)1本・単一試行のみの検証。フル尺
  リプレイ(Hard全クリア・Extra)でのGPU経由の理論尺比較・fps目視確認は
  touhou-recorder側の検証結果(reports/82)を根拠として採用しており、sattori本体の
  コード・AWSインフラでの本番相当E2E録画は本対応の時点では未実施
  (`docs/titles/th15.md`「既知の残課題」参照)。
- 低速録画(`FPS_LIMIT_TARGET_HZ`)はMOD側に実装済み(th20から踏襲)だが、
  `SLOW_MOTION_SUPPORTED_GAME_IDS`に未登録のためsattori側では未検証・未提供。
- 検証機(HakataMatrix)は自宅ワーカー本体であり専用ベンチマーク環境ではないため、
  重複フレーム率はこのマシンの負荷状況に影響されうる(測定条件: 1回のみ)。
