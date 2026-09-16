# th128(妖精大戦争)録画対応をsattori本体の`record_th128.py`でローカル実機検証

- **検証日**: 2026-09-09
- **対象**: th128(妖精大戦争 ～ 東方三月精)録画対応(Issue #78)。MOD移植
  (`mods/th128_replay_autoplay/`)・`record_th128.py`・thprac必須運用・スコア監視RVA
- **環境**: 自宅ワーカー機(HakataMatrix)、`sattori-worker`ローカルビルドイメージ
  (`docker build -t sattori-worker:th128-test .`、コンテナ`--cpus 4`)。ゲーム本体・
  WINEPREFIX・MODビルド成果物はtouhou-recorderの検証済み資産(reports/70〜73)から
  インポート
- **結論**: フル尺録画(Hard、Route B、862.2秒)が1回目の試行で成功。記録スコア
  22,666,770との完全一致・重複フレーム率1.3%・thprac必須運用(無いとフリーズする
  既知バグの回避)いずれも実機確認できた

sattori本体のコード(`worker/record_th128.py`・`worker/mods/th128_replay_autoplay/`)を
使い、touhou-recorderで事前検証済みの設計(reports/70〜73)がsattori側でも同様に機能する
ことを確認した。

## 目的

- MOD移植(`mods/th128_replay_autoplay/dllmain.cpp`、th10/th12と同じPressKey方式)が
  sattoriの録画パイプライン(`recording/`パッケージ)上で問題なく動作するか確認する。
- thprac(`thprac.v2.3.0.3.exe`)無しでは録画できない既知バグ(touhou-recorder
  reports/70で発見)への対策(`GameConfig.thprac_exe`)が有効に機能するか確認する。
- スコア監視RVA(`0xb4c00`基点、score `+0xc4`・motivation `+0x164`)がsattoriの
  `recording.modlog`経由でも記録スコアと完全一致するか確認する。
- 終了検知(画面静止のみ、テンプレート未使用)が正しく機能するか確認する。

## 方法

1. `sattori-home-worker.service`を停止(録画前提条件)。
2. touhou-recorderの`games/th128`・`prefixes/th128-wined3d-gl`を`worker/games/th128`・
   `worker/prefixes/th128-wined3d-gl`へrsyncでインポート(いずれも`.gitignore`対象)。
3. `i686-w64-mingw32-g++`で`mods/th128_replay_autoplay/dllmain.cpp`をクロスビルドし
   `th128_hook.dll`を生成(`build-mods` skillの手順どおり)。
4. `docker build -t sattori-worker:th128-test worker/`でローカルイメージをビルド
   (`record_th128.py`・`entrypoint.py`のRECORDING_SCRIPTS登録済みの状態)。
5. `verify-recording-locally` skillの手順に準じ、`/mnt/cache3`配下にタイトル資産を
   隔離コピーして`chown root:root`(コンテナはrootで実行するため。WINEPREFIXの所有者が
   一致しないと`wineserver: ... is not owned by you`で失敗することを最初の試行で確認し、
   2回目の試行で対処した)。
6. `entrypoint.py`を経由せず`record_th128.py`を直接呼び出し、`th128_ud0000.rpy`
   (Hard、Route B、記録スコア22,666,770、touhou-recorder reports/70〜71と同じ検証用
   リプレイ)をフル尺録画した。

```bash
docker run --rm --cpus 4 \
  -v "$D/assets:/mnt/th128-assets" -v "$D/replay.rpy:/mnt/replay.rpy:ro" \
  -v "$D/output:/mnt/output" \
  -e WINEPREFIX=/mnt/th128-assets/prefixes/th128-wined3d-gl \
  -e SATTORI_GAME_DIR=/mnt/th128-assets/games/th128 \
  -e SATTORI_MOD_DIR=/mnt/th128-assets/mods \
  --entrypoint bash sattori-worker:th128-test -c '
    pulseaudio -D --exit-idle-time=-1 --disallow-exit
    timeout --kill-after=30s 1500s python3 record_th128.py \
      --replay-path /mnt/replay.rpy --output /mnt/output/repro.mp4 \
      --diagnostics-dir /mnt/output/diagnostics --progress-dir /mnt/output/progress \
      --expected-duration-seconds 816 --expected-score 22666770 \
      --desync-result-path /mnt/output/desync.json \
      --timeout-result-path /mnt/output/timeout.json --max-attempts 1
  '
```

## 結果

| 項目 | 結果 |
| --- | --- |
| 試行回数 | 1回目で成功(リトライなし) |
| 総録画時間 | 862.2秒 |
| 終了検知方式 | 画面静止検知(`end_template_path`未設定、意図どおり) |
| 重複フレーム率(録画開始15秒以降、30秒スポット) | 1.3% |
| リプレイずれ事後検証 | 記録スコア(22,666,770)と一致するサンプルを確認(デシンクなし) |
| thprac アタッチ | 0.6秒で成功(`thprac アタッチ完了`ログ確認) |
| メニュー操作シーケンス | Down x1 → Enter → Right → Enter → Enterの全ステップが
  約4秒(09:50:57〜09:51:01)で完了、リプレイ選択直後のフリーズは再現せず |
| A/V同期補正 | delta=-0.037s(問題ない範囲) |

理論尺比較: リプレイの`frameCount`(49000、60fps換算816.67秒)に対し、実測プレイ時間
(総録画862.2秒からメニュー操作分約11.3秒・静止検知待機16秒を差し引いた約834.9秒)は
理論尺超過**+2.2%**。touhou-recorderのローカル検証(reports/71、+0.25%)よりは高いが、
AWS `c7i.xlarge`実機検証(reports/73、+1.69%)と同程度で、処理落ちを疑うほどの値ではない
(検証機は他プロセスと共有する開発機であり、専用の検証環境ではない)。

目視確認(t=400秒付近「スプリンクルピース」戦、t=830秒付近「スリーフェアリーズ」戦)では
画面上のfpsカウンター表示が58.6〜60.0fpsで安定しており、映像の乱れは無かった。

## 考察・既知の限界

- 単一リプレイ(Hard、Route B)・単一試行のみの検証。Extra難易度・他ルートは
  touhou-recorder側で検証済み(reports/71)だが、sattori本体のコードでは未検証。
- 低速録画(`FPS_LIMIT_TARGET_HZ`)・EC2実機(`.2xlarge`帯)はtouhou-recorder側の検証結果
  (reports/72・73)を根拠として採用しており、sattori本体のコードでは未検証。
- 検証機(HakataMatrix)は自宅ワーカー本体であり専用ベンチマーク環境ではないため、
  重複フレーム率・理論尺超過率はこのマシンの負荷状況に影響されうる(測定条件: 1回のみ、
  `--cpus 4`制限下)。
