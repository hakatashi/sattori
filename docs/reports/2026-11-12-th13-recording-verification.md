# th13（東方神霊廟）をsattoriのワーカーイメージでローカル録画し、録画の段を裏付ける

- **検証日**: 2026-11-12
- **対象**: th13 ver1.00c（非Steam版）。`record_th13.py`・`th13_hook.dll`・本番と同じ形式で固めたタイトル資産
  アーカイブ。等倍（自宅ワーカーの段）と1/2倍速（`.2xlarge`の段を8スレッドで模擬）。配信用変換（`convert.py`）、
  MOD統合テスト。あわせてtouhou-recorder reports/100のAWS録画のMODログから理論尺比を算出
- **環境**: HakataMatrix（Ryzen 7 5700X 8コア16スレッド、自宅ワーカー機）、ブランチのコードでビルドした
  CPUワーカーイメージ（`sattori-worker:verify-th13`）をDockerで実行。`sattori-home-worker`は停止中
- **結論**: 等倍(Extra・通常)・1/2倍速(Extra)とも試行1回で完走し、スコアはリプレイの記録値と一致。1/2倍速は落ちなし・
  理論尺比+0.16%。`c7i.4xlarge`の等倍はExtraで理論尺比+1.8%（数値上は基準外）

sattoriのコード（`recording/`パッケージ・`entrypoint.py`の配信用変換）でth13が録れることを確かめ、
[`decisions/0070`](../decisions/0070-th13-native-on-4xlarge-and-half-speed-on-2xlarge.md)の段の配列
（自宅ワーカー→`c7i.4xlarge`の等倍→`.2xlarge`帯の1/2倍速）の根拠をまとめる。

## 1. 目的

- touhou-recorder reports/100で検証したMOD・設定を移植した`record_th13.py`が、本番のワーカーイメージ上で
  録画・終了検知・スコア照合・配信用変換まで通るか。
- 1/2倍速の段に`c7a.2xlarge`・`m7i.2xlarge`を足す根拠（[`0042`](../decisions/0042-2xlarge-instance-type-group-precedent.md)
  が求める`c7i.2xlarge`の理論尺比較）。

## 2. 方法

1. `upload-title-assets` skillの`titles.md` §13のとおりアーカイブ（734MB）を作り、展開したコピーを
   `root`所有にしてコンテナへマウント（`verify-recording-locally` skill §4〜5と同じ手順）。
2. `record_th13.py --max-attempts 1`を直接呼ぶ。1/2倍速は`-e FPS_LIMIT_TARGET_HZ=30`と
   `--cpuset-cpus 0-3,8-11`（物理4コア+SMTの8スレッド、`c7i.2xlarge`相当）。等倍はCPU制限なし
   （自宅ワーカーと同じ）。
3. 録画結果を`convert.convert_for_delivery()`へ本番と同じ引数（カット範囲・ウォーターマーク・
   `time_scale`）で通す。
4. 落ちはtouhou-recorderの`scripts/81_analyze_stutter_periodicity.py`（mpdecimateで残るユニーク
   フレーム）で、録画開始60秒以降を測る。理論尺比は、MODのScoreMonitorログで「stageが1以上になった時刻」から
   「最終スコアに達した時刻」までを`frameCount/60`（×録画速度の逆数）で割ったもの（最終スコアはリプレイ
   終端の少し前に確定するので、比はわずかに小さめに出る）。

リプレイ: Extra=`th13_06.rpy`（Reimu、クリア、117,168,790点、45906F=765.1秒）、通常=`th13_02.rpy`
（Reimu Hard全クリア、257,269,690点、103713F=1728.6秒）。

## 3. 結果

### 3.1 sattoriのワーカーイメージでの録画（ローカル）

| 条件 | リプレイ | 試行 | 総録画時間 | 落ち（生動画） | 配信版の実効fps | 理論尺比 | スコア |
|---|---|---|---|---|---|---|---|
| 等倍・CPU制限なし | Extra | 1回で成功 | 808.8秒 | 3.5%（57.89fps、720秒） | 57.94（700秒） | +1.1% | 一致 |
| 等倍・CPU制限なし | 通常 | 1回で成功 | 1777.8秒 | 1.5%（59.13fps、1680秒） | 未変換 | +0.24% | 一致 |
| 1/2倍速・8スレッド | Extra | 1回で成功 | 1600.6秒 | ユニーク30.09/s（1440秒） | 59.70（700秒） | +0.16% | 一致 |

- 1/2倍速のMODログ: `InstallSpeedHackHook ... multiplier=0.50`・`InstallFpsLimiterHook ... target=30.00 fps`。
  FpsMonitorの下位3件は28.4・28.8・29.2Hz。配信版は960x720・60fps、画面右下のfps表示は「60.0fps」。
- 配信版の変換: 等倍は960x720の配信版と640x480の元の解像度版の2本（776.9秒）、1/2倍速は1本（769.0秒）。
- 等倍の落ち3.5%はreports/100のローカル（0.6%）より悪い。検証中、ホストではユーザーの別プロセス（ComfyUI）が
  1スレッドを常時使っていた。自宅ワーカーの本番も同じホストの他負荷を受ける。
- 新しいWINEPREFIX（スコアファイル無し）でもメニュー操作はDown x3でReplayに着地した。

### 3.2 reports/100のAWS録画の理論尺比（MODログから算出）

| 環境 | リプレイ | 落ち（reports/100） | 理論尺比 |
|---|---|---|---|
| `c7i.4xlarge` 等倍 | Extra | 4.3% | +1.8% |
| `c7i.2xlarge` 等倍 | Extra | 6.3% | +4.8% |
| `c7i.2xlarge` 等倍 | 通常 | 3.0% | +1.7% |
| `c7i.4xlarge` 1/2倍速 | Extra | 落ちなし | +0.1% |
| `c7i.2xlarge` 1/2倍速 | Extra | 落ちなし | +0.16% |
| `c7i.2xlarge` 1/2倍速 | 通常 | 落ちなし | −0.3% |

### 3.3 MOD統合テスト

ユーザーが作成した`worker/tests/fixtures/mod-integration/th13/th13_03.rpy`（Extra、5579F、6,617,760点、
3回被弾してゲームオーバー）で`tests/mod_integration/run.py --game th13`を2回実行し、2回ともOK。
被弾タイミングは1回目99.1・104.1・109.1秒、2回目98.1・104.1・109.1秒（1回目を基準値に登録）。

## 4. 考察・既知の限界

- 1/2倍速は8スレッドへ絞ったローカルでの模擬で、`c7a.2xlarge`・`m7i.2xlarge`の実機は未検証（0042の
  グループとして足した）。
- `c7i.4xlarge`の等倍は数値上は基準外。採用は視聴による判断（0070）。
- GPU描画・倍速は未検証（GPUの在庫が無い）。
- 本番AWS環境でのE2E（アップロード→録画→CloudFrontでのダウンロード）はこの検証の範囲外。
