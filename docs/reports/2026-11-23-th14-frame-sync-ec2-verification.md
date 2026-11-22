# th14のフレーム同期録画のEC2実機検証（Issue #80、親 #399）

- **検証日**: 2026-11-23
- **対象**: th14（東方輝針城 ver1.00b、1280x960）。判断は [`0085`](../decisions/0085-th14-frame-sync-plan-without-gpu.md)
- **方法**: [th20・th06ncの検証](2026-11-23-th20-th06nc-frame-sync-ec2-verification.md)と同じ。PR #430 のバックエンド（Lambda）を本番へ先出し（フロントは`main`のまま非公開、`verify-recording-in-production` skill）し、
  実験ジョブ（`POST /admin/experiments`）で eu-south-2 の EC2 Spot（フレーム同期）の `c7i.4xlarge`・`c7i.2xlarge` へ各2本（計4本）を投入した。
  ワーカーイメージは検証用`exp-th14-1`、タイトル資産は本番S3の`titles/th14/assets.tar.gz`（新規）。リプレイは touhou-recorder の
  `th14_08.rpy`（Extra・霊夢A・理論尺767.0秒）と `th14_22.rpy`（Lunatic全クリア・霊夢A・理論尺1506.0秒）。
- **結論**: **4本すべて試行1回で完走**。スコアは全て記録値と一致（`desyncDetected=false`、`timedOut=false`）、理論尺比は-0.23〜+0.54%。

## 結果

| リプレイ | インスタンス | 速度（上限解除後） | 総所要 / 尺 | 理論尺比 | スコア | 推定コスト |
| --- | --- | --- | --- | --- | --- | --- |
| Extra（767秒） | c7i.4xlarge | 1.16倍速（69.7fps） | 1061秒 / 1.38 | +0.54% | 一致 | $0.057 |
| Extra（767秒） | c7i.2xlarge | 0.80倍速（47.8fps） | 1547秒 / 2.02 | +0.54% | 一致 | $0.054 |
| Lunatic（1506秒） | c7i.4xlarge | 1.54倍速（92.2fps） | 1579秒 / 1.05 | -0.23% | 一致 | $0.082 |
| Lunatic（1506秒） | c7i.2xlarge | 0.96倍速（57.4fps） | 2566秒 / 1.70 | -0.23% | 一致 | $0.086 |

- 推定コストは`.2xlarge`と`.4xlarge`で大差ないが、`.4xlarge`のほうが総所要が短い（th15・th20と同じ。計画は`.4xlarge`が先）。
- `.2xlarge`の総所要は尺の1.7〜2.0倍。Lunatic全クリア（1506秒）で約43分。`maxEstimatedDurationSeconds`（3300秒）の尺では約92分でSFnの150分に収まる。
- 速度はローカル（touhou-recorder reports/110の1.17倍・1.38倍速）とほぼ一致。

## 段の `estimatedRealtimeFactor` に入れた値

上限解除後の速度の小さいほうを丸めて下げた値（EC2）。自宅は実測せず、同じ1280x960のth15と同じ値。

| 段 | th14 |
| --- | --- |
| 自宅 | 0.6 |
| `.2xlarge`帯 | 0.75 |
| `.4xlarge`帯 | 1.1 |

## ローカル（このマシン、`sattori-home-worker`停止）

`worker/tests/mod_integration/run.py --game th14`（`th14_25.rpy`、Extra・ゲームオーバー）がフレーム同期で完走。三者照合・スコア一致・
被弾のゲーム内時刻が基準内。基準値は`run.py`に登録した（再生区間119.0秒、最終状態(7,-1,449)）。

## 未確認

- **視聴確認は未実施**（判定は全て数値）。
- 自宅ワーカー経由の本番での録画（デプロイ後に確かめる）。自宅の効率値はth15の値の流用。
- GPUの段（検証していないので計画に入れていない、0085）。c7a・m7iの`.2xlarge`の速度（[`0078`](../decisions/0078-frame-sync-plan-and-instance-type-verification-policy.md)の方針で実測しない）。
- 本番のバックエンドは先出し済み（フロントは非公開）。マージ後に通常のデプロイで公開フロントを更新すること。
