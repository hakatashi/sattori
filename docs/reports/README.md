# 検証記録

このリポジトリで行った実機検証・実測の記録を1検証1ファイルで残す場所
（`docs/documentation-guidelines.md` の分類 ④）。**一度書いたら不変**で、後から分かった
ことは新しいファイルを足す。

「インスタンスタイプ・録画パイプラインの変更は必ず実機検証を経ること」（`AGENTS.md` §3）
という方針の裏付けがここに溜まる。決定記録（[`../decisions/`](../decisions/README.md)）が
根拠として参照する。

## 一覧

| 検証日 | 内容 | 結論 |
| --- | --- | --- |
| [2026-10-11](2026-10-11-gpu-fallback-eu-north-1-production-e2e.md) | GPUのeu-north-1フォールバックの本番検証(初回デプロイ直後、強制設定でth06nc・th15・th07 2倍速。実ユーザーのジョブも自動でフォールバック、Issue #296) | th06nc・th15(Extra)・2倍速は正常に録画できた(重複率0.0〜1.0%)。th15の1面だけのリプレイはステージ終了時のWineクラッシュで失敗したが、資産更新に伴うリプレイ固有の問題とみて#312へ。緊急停止・転送料の計上もリージョンをまたいで動いた |
| [2026-10-11](2026-10-11-gpu-capacity-eu-south-2-vs-eu-north-1.md) | g6f.2xlarge Spotの起動可否・配置スコア・単価・クォータをeu-south-2とeu-north-1で比較(GPUマルチリージョン化の前提確認、Issue #296) | eu-south-2は全AZで`InsufficientInstanceCapacity`、eu-north-1は1bだけ起動できた(配置スコア1対9)。eu-north-1のG系Spotクォータは申請済みの32ではなく8 vCPUのままだった |
| [2026-10-03](2026-10-03-speedup-production-e2e-reverification.md) | 倍速録画の本番E2E再検証(前回の不具合の修正と、メニュー自動操作の待ち時間を倍速時に1/Nにする修正の後、10ジョブ) | 全件1回目の試行で完走し、メニュー操作が等倍の速度になった(メニュー区間が2倍速で4〜9秒短縮)。th07の誤判定とth09の起動待ち失敗は解消。th08の誤判定は残ったが、等倍でも起きうる判定精度の問題で倍速固有ではない |
| [2026-10-04](2026-10-04-delivery-cut-and-1080p-verification.md) | 配信版のカット・1080p化・音声先頭の無音埋め・キャプチャ停止対策(Issue #266/#284/#301/#302)のローカルCPU・GPU実機(us-west-2のg6f.2xlarge)検証 | カット・1080p化・2本出力・空編集の解消を確認。同期マーカーは全ケースで配信版から外れ、同期残差±1ms以内。`-thread_queue_size`で録画開始直後の508msのキャプチャ停止が消えた。視聴後の指摘でカット開始を再生確定キー基準に変え、マーカーを早く鳴らす際の失敗2件(録音に入らない・ゲーム初期化と干渉)を修正。4倍速の重複率は回ごとに2.7〜27.8%とばらつく |
| [2026-10-03](2026-10-03-th12-speedup-fps-display-fix.md) | th12の倍速録画で画面上のfps表示が120になる問題の原因切り分けと修正(ローカル2倍速) | 原因はVsyncPatchが実時間で書く表示値でタイマー偽装は無効。表示関数に係数を掛けるパッチをMODへ入れ、59.5〜59.8fps表示・デシンク無しを確認 |
| [2026-10-02](2026-10-02-speedup-production-e2e.md) | 倍速録画(Issue #288)の本番E2E検証(全12タイトル・1〜4倍速の17ジョブ)とNVENC品質値の決定 | 全件完走、本当のデシンク無し、同期マーカー残差±1ms以内、倍速を等倍に戻した本編の速度ずれ無し。**倍速時だけの不具合2件(スコア監視の取りこぼしによるデシンク誤判定、th09の起動待ちタイムアウト短縮)を修正**。th12の倍速でfps表示が120になる問題は未修正。NVENCの品質値はlibx264 crf18と合計サイズ・SSIMが揃うCQ25に決定 |
| [2026-09-28](2026-09-28-th06nc-v1.0.6-update-verification.md) | th06nc ver 1.0.6(ゲーム側アップデート)のリプレイ互換性とMOD動作のローカル検証 | リプレイ形式は不変で旧版・新版リプレイとも新版で再生・スコア一致。**ただしMODのスコアRVAが`0x004F2798`→`0x0053D3E8`へ移動しており修正が必要だった**。Steam版の正規`steam_api64.dll`も戻っていた。GPU描画での録画品質は未検証 |
| [2026-09-30](2026-09-30-speedup-mods-1x-regression-local.md) | 倍速録画対応MOD・パイプライン(Issue #288)の等倍録画への回帰確認(ローカル、CPU描画、MOD統合テスト+新旧DLLのA/B) | **th10/th12の`fps_limiter_hook`がVsyncPatchと二重制御になりゲーム進行が遅れる退行を検出・修正**。他の退行なし。th07のデシンク判定・被弾タイミング+6秒はハーネス側の揺らぎ。同期マーカーは等倍でも検出でき残差±1ms以内 |
| [2026-09-19](2026-09-19-th15-wine-crash-detection-verification.md) | GPUワーカーで発生したWineクラッシュ3件の原因調査と、録画中に検知する手段の実機比較(Issue #267) | 3件とも`g6f`×`eu-south-2a`で、フリーズ画面を静止検知が誤って「リプレイ終了」と判定していた(AZ別のクラッシュ率は2a:6件中4件・2b:16件中0件、p=0.0021)。**th15 PR #264の変更が原因ではない**(同型事例が旧AMI環境の9/13にも発生)。意図的にアクセス違反を起こす再現実験で本番の2形態(プロセス消滅型・ダイアログ残存型)を両方再現し、**`wine.log`の`Unhandled`だけが両方を検知でき正常時に誤検知しない**ことを確認(プロセス生存・state・`winedbg`監視はいずれも一方のみ) |
| [2026-09-18](2026-09-18-th15-gpu-32bit-llvmpipe-fallback-root-cause.md) | th15 GPU描画が実際には効かずllvmpipeへフォールバックしていた問題の根本原因調査(Issue #82) | nvidia-container-toolkitが32bit互換NVIDIAライブラリを自動マウントしないため、32bitのwineプロセスが`libGLX_nvidia.so.0`を見つけられず静かにソフトウェアレンダラへフォールバックしていた。該当ファイルの個別マウントで解消(`docs/decisions/0053`)。touhou-recorderの検証はコンテナを使わないため同問題に未遭遇だったことも判明 |
| [2026-09-18](2026-09-18-th15-gpu-ami-xorg-libwfb-root-cause.md) | th15 GPU用AMIのXorg起動不能(`Need libwfb`)の根本原因調査(us-west-2、Issue #82) | 原因はAMI構築手順ではなく`apps/api/src/ec2.ts`の`docker run`マウント(`-v /usr/lib/xorg/modules:...`丸ごと)がコンテナ自身のXorgモジュールを隠すことだった。個別ファイルマウントに修正(`docs/decisions/0052`)し解消を確認。th06ncも含むGPU系ジョブ共通の問題 |
| [2026-09-17](2026-09-17-th15-production-e2e-attempt.md) | th15の本番AWS環境でのE2E検証を試みるも未完了(Issue #82) | sattori既存バグ2件(GPU系Dockerfileにwine32が無い・Launch Templateの`$Default`固定)を発見・修正。GPU用AMIへの32bit互換ドライバ追加はXorg起動失敗を招き、th06nc保護のため旧AMIへロールバックして中断。根本原因は次回へ引き継ぎ |
| [2026-09-17](2026-09-17-th15-local-recording-verification.md) | th15(東方紺珠伝)録画対応(Issue #82)をsattori本体の`record_th15.py`でローカル実機検証 | 短尺リプレイでMOD・録画パイプライン結合(メニュー自動操作・スコア監視・終了検知)が成功。記録スコア完全一致・重複フレーム率2.1%。**GPU描画経路(本番のg6f系)自体はこのマシンにNVIDIA GPUが無く未検証**(th06ncと同じ制約) |
| [2026-09-16](2026-09-16-th128-title-screen-wait-reduction-verification.md) | th128のメニュー操作シーケンス冒頭「タイトル画面ロード待ち」を8000msから2000msへ短縮する妥当性を検証(PR #235) | 2000msでもフル尺録画・記録スコア完全一致・シーケンス正常完了を確認。8000msの根拠だった不具合(キー入力を受け付けない)は8000ms・2000msいずれの試行でも再現せず |
| [2026-09-12](2026-09-12-th06nc-recording-verification.md) | th06nc(東方紅魔郷: New Classic)のGPU用カスタムAMI構築・CDKデプロイ・タイトル資産アップロード・E2E検証(Issue #241) | AMI構築・デプロイ・資産アップロード・ローカルMOD機能検証は成功。**本番E2E録画(720p/1080p)はeu-south-2のg6f.xlargeスポット在庫の長時間枯渇によりリトライ全滅で未完了**(sattori側の不具合ではない)。GRIDドライバがnouveauと競合する新知見あり |
| [2026-09-10](2026-09-10-th06c-recording-verification.md) | th06c(東方紅魔郷: Classic)録画対応(Issue #240)をローカル実機検証・本番AWS環境でのE2E検証 | 64bit専用MOD・Steamworks APIスタブ・終了検知テンプレート照合いずれも成功。フル尺録画で重複フレーム率0.1%・スコア完全一致(デシンクなし)。Webアップロード→録画→CloudFront DLのE2Eも成功。副次的に終了検知方式のログラベルが常に「画面静止検知」になるバグを発見・修正 |
| [2026-09-09](2026-09-09-th128-wineprefix-recovery-verification.md) | th128のWINEPREFIXを`setup_wineprefix.sh`のみで作り直しても録画が壊れないか検証(Issue #78フォローアップ) | touhou-recorder製の原本と同じくフル尺録画・スコア完全一致・重複フレーム率1.3%を確認。th06/07/08と同様、原本に依存せず復旧可能 |
| [2026-09-09](2026-09-09-th128-local-recording-verification.md) | th128（妖精大戦争）録画対応(Issue #78)をsattori本体の`record_th128.py`でローカル実機検証 | フル尺録画(1回目の試行で成功、重複フレーム率1.3%)・thprac必須運用・終了検知(画面静止)・スコア完全一致いずれも成功 |
| [2026-09-05](2026-09-05-home-worker-upload-bandwidth.md) | 自宅ワーカーの配信用動画アップロード速度を本番CloudWatch Logs×DynamoDBの突き合わせで実測(Issue #202フォローアップ) | 100MB超のファイルでは10〜12MB/s(80〜99Mbps)に収束する安定した実測値。進捗バー・残り時間推定の悲観バジェットの根拠にした |
| [2026-09-03](2026-09-03-convert-faststart-verification.md) | 配信用変換への`-movflags +faststart`追加(Issue #90)をローカルで検証 | moov atomは先頭へ移動、変換時間の増分は誤差範囲、映像・音声のデコード結果は完全一致(尺・A/V同期に影響なし) |
| [2026-09-02](2026-09-02-th09-local-recording-verification.md) | th09（東方花映塚）録画対応(Issue #73)をsattori本体の`record_th09.py`でローカル実機検証 | Match/Storyモード双方でフル尺録画・終了検知・残機(life)監視が成功。リプレイファイル名接頭辞が`th9_`(`th09_`ではない)である誤りを発見・修正 |
| [2026-09-01](2026-09-01-th12-2xlarge-instance-group-verification.md) | th12のc7a.2xlarge・m7i.2xlargeをAWS実機検証(Issue #76フォローアップ) | 両方とも良好(記録スコア完全一致・理論尺どおりの尺)。m7i.2xlargeの重複フレーム率12.7%は30秒スポット計測の局所ノイズと判明(秒単位再解析で裏付け) |
| [2026-09-01](2026-09-01-th12-local-recording-verification.md) | th12（東方星蓮船）録画対応(Issue #76)をsattori本体の`record_th12.py`でローカル実機検証 | フル尺録画(1回目の試行で成功、重複フレーム率0.1%)・ウィンドウ最小化バグ対策(force_window_map)・VsyncPatch注入・終了検知(画面静止)・スコア完全一致いずれも成功 |
| [2026-08-29](2026-08-29-th10-local-recording-verification.md) | th10（東方風神録）録画対応(Issue #75)をsattori本体の`record_th10.py`でローカル実機検証 | フル尺録画・終了検知(絞り込みテンプレート照合)・スコア完全一致・「バグマリ」修正オプションいずれも成功 |
| [2026-08-31](2026-08-31-recording-package-split-verification.md) | `recording/`パッケージ分割(Issue #201・#188)後の録画パイプラインをth10・th20低速録画で実機確認 | th10はフル尺録画・終了検知・スコア完全一致まで初回試行で成功。th20も低速スケーリング・thprac・画面外ウィンドウ移動まで分割前と同じ挙動 |
| [2026-08-27](2026-08-27-wine-cleanup-hang-incident.md) | 自宅ワーカーホストのsystemdハングインシデントの原因調査(Issue #186) | `kill_wine_and_wait()`のタイムアウト未捕捉でwineserver/winedeviceがホストに取り残され、system D-Busのメッセージキューを枯渇させたことが一因。修正済み |
| [2026-08-26](2026-08-26-th20-post-cooler-replacement-verification.md) | CPUクーラー換装(簡易水冷→空冷)後の自宅ワーカー健全性確認(Issue #162)。th20の低速/等倍/低速2並列 | サーマルは解消(録画中も最大61℃)。ただしth20低速録画2並列で温度と無関係の新規フリーズバグを発見(Issue #179) |
| [2026-08-25](2026-08-25-th07-score-monitor-fix.md) | th07のscore_monitor無効化(RVA不一致)を修正し、判定ロジックも頑健化 | th07を含む全5タイトルで実機動作確認。末尾ゴミ値の新パターンにも対応 |
| [2026-08-25](2026-08-25-score-monitor-desync-verification.md) | score_monitor（リプレイずれ検証、Issue #103）の5タイトル横展開を実機検証 | th06/08/11/20は動作確認。th07はゲームバイナリのバージョン差でMODのRVAが通用せず無効化 |
| [2026-08-11](2026-08-11-th20-slow-motion-local.md) | th20 の低速録画（1/2倍速）をローカル実機でフル尺検証 | 1回目の試行で成功。重複フレーム率・尺・fps 表示のすべてが設計どおり |
| [2026-08-09](2026-08-09-home-worker-parallel-recording.md) | 自宅サーバーでの並列録画（CPU温度・処理落ち） | 破綻の条件は並列数ではなく「サーマル上限＋外部負荷」 |
| [2026-08-08](2026-08-08-parallel-audio-isolation.md) | ジョブ専用 PulseAudio sink による並列録画時の音声分離 | 2並列でも音声は混ざらない。単一ジョブにもリグレッションなし |

長大な調査レポート（数百行規模で、単一の調査として完結しているもの）は
[`../research/`](../research/) に置く。違いは規模と粒度だけなので、迷ったらこちらでよい。

## 書き方

- ファイル名は `YYYY-MM-DD-kebab-case-title.md`（**検証を実施した日付**）。
- [`TEMPLATE.md`](TEMPLATE.md) をコピーして書き始める。書式の詳細は
  [`../documentation-guidelines.md`](../documentation-guidelines.md) §5.3。
- **数値には測定条件（何秒間の測定か、何回の平均か）を必ず併記する**。とくに重複フレーム率は
  録画開始15〜45秒の30秒スポットしか見ていない（Issue #93）ので、全編の代表値として
  読まれないように書くこと。
- **新規追加したら上の一覧にも必ず1行足すこと**（新しいものが上）。
- 検証の結果として何かを決めたなら、決定記録も併せて書く（測定の詳細はこちら、
  何を決めたかは `docs/decisions/`。同ガイドライン §2）。

## touhou-recorder の `reports/NN` とは別物

各所に出てくる `reports/NN`（連番）は PoC リポジトリ **touhou-recorder** のもので、
**こちらへは移設しない**。混同を避けるため、あちらは連番、こちらは日付ベースの命名と
している。このリポジトリの文書から参照するときは「touhou-recorder reports/50」のように
リポジトリ名を添えること。
