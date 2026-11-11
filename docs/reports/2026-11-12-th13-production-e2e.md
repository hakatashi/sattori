# th13（東方神霊廟）の本番E2E: EC2の2つの段（`c7i.4xlarge`等倍・`c7i.2xlarge` 1/2倍速）

- **検証日**: 2026-11-12
- **対象**: PR #373（Issue #79）のバックエンド（Lambda・CPUワーカーイメージ・th13のタイトル資産）。フロントエンドは
  `main`のビルドのまま隠してデプロイ（`verify-recording-in-production` skill）
- **環境**: 本番（eu-south-2）。自宅ワーカーは停止中（登録なし）で、自宅の段は飛ばされる
- **結論**: 2本とも試行1回で`done`。スコア一致（`desyncDetected=false`）、`timedOut=false`、CloudFrontから
  配信版をダウンロードできた

`docs/decisions/0070`のEC2の2つの段を本番で通した。1/2倍速の段は、ジョブの開始前に`capacityExhaustedTargets`へ
等倍の段（`cpu:eu-south-2`）を書き込み、Spot在庫の枯渇を模して到達させた。

## 1. 方法

- `upload-title-assets` skillの`titles.md` §13で作ったアーカイブ（734MB）を`titles/th13/assets.tar.gz`へ
  アップロードし、CPUワーカーイメージを`latest`へpushしたあと、`cdk deploy --all`。公開バンドルの
  `SUPPORTED_GAME_IDS`にth13が無いことをデプロイ後に確認した。
- `POST /uploads` → S3へPUT → `POST /magic-links` → JobsTableからjobIdを引き → `POST /jobs/{id}/start`。
  リプレイは2本ともtouhou-recorderの`th13_06.rpy`（Extraクリア、117,168,790点、45906F=765.1秒）。
- 落ちは、CloudFrontから落とした配信版をtouhou-recorderの`scripts/81_analyze_stutter_periodicity.py`
  （開始30秒から720秒間）で測った。

## 2. 結果

| ジョブ | 段（`recordingStepId`） | インスタンス | 総録画時間 | 配信版 | 配信版の実効fps（落ち） | 判定重複率 | スコア |
|---|---|---|---|---|---|---|---|
| A | `cpu:eu-south-2`（等倍） | `c7i.4xlarge`（2b） | 806.0秒 | 960x720・774.5秒＋640x480の元の解像度版 | 57.84（3.6%） | 0.8% | 一致 |
| B | `cpu-slow:eu-south-2`（1/2倍速） | `c7i.2xlarge`（2b） | 1601.1秒 | 960x720・769.4秒の1本 | 59.74（0.4%） | 54.5%（閾値90%） | 一致 |

- メニュー操作はどちらも完了（`sequence complete`）。Bのワーカーは`InstallSpeedHackHook ... multiplier=0.50`で
  起動し、配信版の画面右下のfps表示は「60.0fps」。Aの冒頭にはウォーターマークが重なり、配信版はロード画面から
  始まっている（カット範囲どおり）。
- Aの落ち3.6%は、touhou-recorder reports/100の`c7i.4xlarge`等倍Extra（4.3%）と同程度。
- 両インスタンスとも完了後にterminateされた。

## 3. 考察・既知の限界

- 1/2倍速の段への到達は`capacityExhaustedTargets`の手書きによる模擬で、本物のSpot在庫枯渇から段が進むことは
  確かめていない（段を進める処理自体は全タイトル共通で、既存タイトルの本番で動いている）。
- 自宅ワーカーの段（オファー・claim）は、自宅ワーカーが停止中のため本番では通していない。録画自体は
  `docs/reports/2026-11-12-th13-recording-verification.md`のとおり、同じイメージでローカルで確認済み。
- 通常ステージ（Hard全クリア）の本番録画はしていない。
