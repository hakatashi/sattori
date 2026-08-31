# th12（東方星蓮船）: c7a.2xlarge・m7i.2xlargeのAWS実機検証

- **検証日**: 2026-09-01
- **対象**: th12（東方星蓮船）録画品質のインスタンスタイプ横展開検証（Issue #76フォローアップ、
  ユーザー指示）。当初`c7i.2xlarge`のみ実機検証済み（touhou-recorder reports/67）だった
  候補を、`c7a.2xlarge`・`m7i.2xlarge`でも実機検証する
- **環境**: AWS EC2 Spot（eu-south-2）。本番の`SattoriStack`が管理するLaunch Template
  （AMI・IAMインスタンスプロファイル・SecurityGroupはCDK側で設定済み）をそのまま使い、
  UserDataのみ検証用に差し替えたバージョンを作成して直接`RunInstances`で起動した。
  `TASK_TOKEN`・`JOBS_TABLE`を意図的に渡していないため、Step Functions・DynamoDBの
  本番ジョブフローには一切触れていない（`worker/status.py`の設計により、
  `JOBS_TABLE`未設定時は更新を静かにスキップする）
- **結論**: `c7a.2xlarge`・`m7i.2xlarge`ともにth12の録画品質に問題なし。
  `c7i.2xlarge`（reports/67・`docs/reports/2026-09-01-th12-local-recording-verification.md`）
  と合わせ、th11専用候補（`TH11_CANDIDATE_INSTANCE_TYPES`）と同じ3タイプすべてが
  th12でも実機検証済みとなった。

## 準備

- `feat/th12-recording-support`ブランチ（Issue #76実装）の`worker/`コードで
  Dockerイメージをビルドし、ECRへ検証用タグ`sattori-worker:th12-verify`でpush
  （本番`:latest`タグは上書きしていない）。
- th12のタイトル資産（`games/th12`・`prefixes/th12-wined3d-gl`・MOD）を本番の
  `TitleAssetsBucket`（`titles/th12/assets.tar.gz`）へアップロード
  （`upload-title-assets` skill手順どおり）。
- 検証用リプレイ（`th12_02.rpy`、ReimuB/Hard/6面通し、記録スコア183,240,710）を
  本番`UploadBucket`の`replays/th12-verify.rpy`へ配置。
- 本番`WORKER_LAUNCH_TEMPLATE_ID`の`$Default`バージョンをソースに、UserDataだけ
  「ECRログイン→`th12-verify`イメージをpull→`docker run`(`--log-driver awslogs`で
  `/sattori/worker`ロググループへ出力)→`shutdown -h now`」に差し替えた新バージョンを
  `CreateLaunchTemplateVersion`で作成し、`RunInstances`でインスタンスタイプを指定して
  1台ずつ起動した（本番の`launchRecordingInstance()`と同じLaunch Template機構、
  `apps/api/src/ec2.ts`参照）。

## 結果

| インスタンス | 総録画時間 | 重複フレーム率(15-45秒) | スコア完全一致 | 出力 |
| --- | --- | --- | --- | --- |
| c7a.2xlarge (eu-south-2b) | 1730.0秒 | **0.4%** | 一致(183,240,710) | 640x480→960x720、正常 |
| m7i.2xlarge (eu-south-2a) | 1729.9秒 | **12.7%**(下記参照) | 一致(183,240,710) | 640x480→960x720、正常 |

両インスタンスとも1回目の試行で正常終了（画面静止検知、リトライなし）。理論尺
（`th12_02.rpy`のframeCount 102,326/60=1705.4秒）に対し、総録画時間はいずれも
+1.3%程度で、`c7i.2xlarge`でのローカル検証結果（1733.0秒）と同水準だった。

### m7i.2xlargeの重複フレーム率12.7%の分析

他の2タイプ（`c7i.2xlarge`0.1〜0.6%、`c7a.2xlarge`0.4%）より一桁高い値だったため、
`docs/known-limitations.md`§3の「重複フレーム率の自動チェックは録画開始15〜45秒の
30秒スポットしか見ていない」という既知の制約による見かけ上の値ではないかを、
touhou-recorder reports/66・67と同じ手法（`ffmpeg -vf "mpdecimate,showinfo" -vsync 0`で
生存フレームのタイムスタンプを全数取得し秒単位で集計）で検証した。

- **プレイ本編（15〜1705秒、1690秒間）に限定して再集計**したところ、75%未満（45/60未満）
  に落ち込んだ秒は**わずか10秒**、50%未満（半分以下）に落ち込んだ秒は**0秒**だった。
  録画中に記録された12.7%という値は、実際には**15〜45秒のスポット計測区間だけ**で
  再現する局所的な値（この区間だけで再集計すると1571/1800フレーム生存=12.7%と、
  記録値と完全一致することを確認した）。
- 15〜45秒区間を秒ごとに集計すると、`23〜28秒`の6秒間だけは完全に重複が無かった
  （60/60）一方、それ以外の区間は毎秒2〜18フレーム程度の軽い重複が薄く分布していた
  （例: 15s=42/60、20s=49/60、30s=50/60、35s=47/60、44s=57/60）。**特定の瞬間に
  重複が集中する「処理落ち」特有のパターン（連続した無変化区間）ではなく、断続的な
  1〜2フレーム単位の重複が全体に散らばっている**。ユーザーが実際にこの動画を視聴し
  「3分付近まで見たが処理落ちしている区間は無かった」と報告した所見と整合する
  （1フレーム単位の重複は肉眼ではまず知覚できない）。
- 該当区間を目視確認したところ、1面開始直後（t=15s、スコア140、アイテムが浮遊する
  のみの低モーション演出）〜1面道中序盤（t=35s、スコア121,540、弾幕・敵編隊出現）で、
  背景の雲海・地形アニメーションが主体の低モーション演出だった。**動きが少ないシーン
  ほどフレーム間の画素差分が小さくなり、x11grabのキャプチャタイミングとゲーム側の
  Present更新タイミングの位相がわずかにずれるだけで、mpdecimateの「実質的に同一」
  という閾値判定に引っかかりやすくなる**。これは真のCPU処理落ち（ゲームロジック自体の
  遅延）ではなく、キャプチャのサンプリングタイミングに起因する現象と考えられる
  （同じ区間で`c7a.2xlarge`が0.4%とほぼ完璧だったのは、そちらのインスタンスでは
  たまたまキャプチャ開始タイミングがPresentタイミングと噛み合っていた、という
  巡り合わせの違いによるものと推測される。総録画時間がc7a・m7iでほぼ同一
  〈1730.0秒 / 1729.9秒〉であることも、両者のCPU処理能力に実質差が無かったことを
  裏付ける）。
- 6面ラストスペル「飛鉢「伝説の飛空円盤」」付近（t=1650s）のフレームを`c7a.2xlarge`と
  比較目視したところ、両者とも同時点で近いスコア（160,568,290 / 160,568,430）に
  達しており、描画崩れ・文字化けは無かった。

**結論: m7i.2xlargeの高い重複フレーム率は測定上のノイズであり、実際の処理落ちでは
ない。** この事例は、重複フレーム率だけでなく秒単位の生存フレーム再解析・理論尺との
比較を併用する必要があるという既存の教訓（`docs/known-limitations.md`§3、
touhou-recorder reports/67）を改めて裏付けるものである。

## 後片付け

検証完了後、両EC2インスタンス（スポット、`trap 'shutdown -h now' EXIT`により自動停止）が
`terminated`状態であることを確認した。検証用に作成したS3オブジェクト
（`videos/th12-verify-*`・`worker-logs/th12-verify-*`・`replays/th12-verify.rpy`）は削除した。
th12のタイトル資産（`titles/th12/assets.tar.gz`）は本番運用に必要なため削除せず残した。
ECRの検証用タグ（`sattori-worker:th12-verify`）・Launch Templateの検証用バージョンは
実害が無いため残置した。

## 関連

この検証結果を受けて、`c7i.2xlarge`・`c7a.2xlarge`・`m7i.2xlarge`を「`.2xlarge`帯
実機検証済みグループ」として扱う方針を
[`decisions/0042`](../decisions/0042-2xlarge-instance-type-group-precedent.md)に定めた。
