> **【アーカイブ】このファイルは旧 touhou-recorder リポジトリの `AGENTS.md` を、そのまま残したものです。**
> 今後の検証の運用は、**リポジトリルートの `AGENTS.md` と `docs/` のルールに従ってください**。
> このファイルは名前を変えてあり（`AGENTS.archived.md`）、エージェントには自動で読み込まれません。
> 以下の記述（保存先 `/mnt/cache3/...`、`../sattori/...` への相対パス、「コミットの粒度」「reports/ への追記」など）は
> 当時の運用であり、現在は当てはまらないものがあります。過去の経緯を読むための資料として扱ってください。
> 取り込みの経緯は [README.md](README.md) を参照。

# AGENTS.md

このリポジトリで作業するエージェント（または人間）向けの引き継ぎメモ。

AGENTS.mdには**どのようなタスクであっても常に必要・意識しておくべき大原則と共通ルール**、および**分野別ドキュメント・過去レポートへのインデックス**を記載しています。
特定の分野や特定タイトルに関する詳細知識は、`docs/` 配下の各ドキュメントを参照してください。

---

## 目次

- [進め方の大原則](#進め方の大原則)
- [全タスク共通の運用ルール](#全タスク共通の運用ルール)
- [録画品質の判定基準](#録画品質の判定基準)
- [新規タイトル対応チェックリスト](#新規タイトル対応チェックリスト)
- [ドキュメントインデックス (docs/)](#ドキュメントインデックス-docs)
- [タイトル別ドキュメント (docs/titles/)](#タイトル別ドキュメント-docstitles)
- [参照ファイル・過去フェーズ一覧](#参照ファイル過去フェーズ一覧)

---

## 進め方の大原則

- **こまめなコミットとミニレポート**:
  - 小さな進捗があるたびに、簡潔なミニレポートを `reports/` 配下に追加し、関連するスクリプト・設定ファイルの変更とあわせてこまめにgit commitする。
  - 1つの疑問の解決や1タイトルの検証完了など、意味のある区切りごとにコミットすること。
- **レポートの再現性**:
  - レポートには、実行したコマンド・編集したファイル・実装した関数名やRVA/オフセットなどの具体的な数値を、後から読んだエージェントが同じ手順で再現実験できる精度で詳しく記載する。
- **録画には `recorder/` パッケージを使う**:
  - 新規タイトルの検証を含め、**ゲームの録画は必ず `recorder/` パッケージ（CLIは `scripts/25_record_replay_e2e_multigame.py`）を経由すること**。新しく録画用のスクリプトを自作しない。
  - 新規タイトルを追加する際は `recorder/games.py` に `GameConfig(...)` を1件足す（フィールドの意味は `recorder/config.py`、全体像は `docs/recording-pipeline.md`）。
  - Pythonから直接使う場合は `from recorder import RecordingOptions, load_game_config, record_with_retry`。
- **スクリプト命名規則**:
  - `scripts/` 配下に新規スクリプトを追加する際は、**ファイル名先頭の連番をそのスクリプトを作成したフェーズのレポート番号と一致させる**（例: フェーズ53で作った新規スクリプトは `scripts/53_<用途>.py`）。既存スクリプトを別フェーズで改修した場合はリネーム不要。
  - ただし**録画パイプライン本体の改修は `scripts/` ではなく `recorder/` 配下で行う**（`scripts/25_record_replay_e2e_multigame.py` は互換シムであり、実装は入っていない）。
- **著作権物・生成物のignore**:
  - `games/` と `instances/` 配下はゲーム本体・セーブデータ（著作権物・個人データ）のため `.gitignore` 済み。新しく生成物を置くディレクトリを増やす場合も同様にignoreすること。
- **定番ツールの事前許可**:
  - vpatch、thcrap、thprac等、東方コミュニティで既によく知られた定番ツールはユーザーの事前許可を得ているため、都度確認せず取得・導入してよい（導入した場合は事後報告する）。
- **録画動画の保存先（厳守）**:
  - **検証のために録画した動画データ（出力ファイル）は、別途指示がない限り `/mnt/cache3/sattori-<title>-verify/` 配下に保存すること**。
  - 作業マシンのルートファイルシステムは常時使用率98%前後で逼迫しており、フル尺録画（数GB）を `runs/`（ルートFS上）に置くとディスク枯渇でffmpegや作業ツールが異常終了する重大インシデントが発生します。`/mnt/cache3` は空き3TB超の別ボリュームです。
- **リプレイファイルの取得・解析**:
  - 検証用リプレイファイルは必要に応じてSilentSelene（silentselene.net）から追加取得可能。
  - リプレイファイル（`.rpy`）の解析・情報取得（記録スコア、ステージ構成等）には `../sattori/packages/replay-parser`（`@sattori/touhou-replay-parser`）を積極的に使用する。CLIツール（`node ../sattori/packages/replay-parser/dist/cli/index.js <file...> -j`）も利用可能。

---

## 全タスク共通の運用ルール

どのようなタスク・タイトルの作業であっても必ず意識すべき共通ルールです。

- **DISPLAY :20 の取り扱い**:
  - `DISPLAY :20` はユーザーが実際に使用しているChrome Remote Desktopの実セッションです。ここでゲーム画面を表示させると**ユーザーの実画面にウィンドウがポップアップする**ため、使用前に必ず確認を取ること。検証は基本的にXvfb上で完結させる。
- **wineserver / winedevice のクリーンアップ保証**:
  - 録画処理中に例外・タイムアウトが発生しても、**必ずtry/finallyでwineserver/winedeviceの後片付け（`kill_wine_and_wait()`）が実行されることを保証すること**。放置するとホストのsystem D-Busのメッセージキューを枯渇させ、システム全体のハングを引き起こします（`reports/55`）。新規スクリプト作成時もこの構造を踏襲すること。
- **並列実行の上限**:
  - 並列実行は同時2インスタンスまでが安定上限。並列実行する場合は **WINEPREFIXとゲームディレクトリの両方をインスタンスごとに個別コピー** すること（共有すると固まる・壊れる原因になります）。
- **バックグラウンド待機マナー**:
  - 長時間かかるバックグラウンドジョブ（録画・ビルド等）の完了を待つ際、`true` や `echo waiting` のような無意味なプレースホルダー呼び出しを毎ターン繰り返さないこと。待機ループを仕掛け、通知が来るまで待つ。
- **プロセス強制終了**:
  - Bashツールで日本語プロセス名等に対して `pkill` を実行すると、正常動作していても `Exit code 1` かつ出力なしになりやすい。対象PIDを `ps aux | grep ...` で確認し、`kill -9 <PID>` で終了させる方が確実。
- **`pgrep -f` / `pkill -f` は使わない**:
  - SSH越しなどで実行すると、パターンを含む検査コマンド自身に一致し、対象が終わっていても「実行中」と誤判定する(`reports/91`で録画完了に約40分気づかず、スポットインスタンスを遊休のまま課金した)。`pgrep -x <プロセス名>`、`ps -eo comm,args` の行頭一致、またはバッチの完了マーカーで判定する。

---

## 録画品質の判定基準

録画速度・インスタンスタイプ・実装の変更などで「品質が保たれているか」を判定するときは、当面この基準を使う（根拠と各セルの実測は `reports/98`）。

| # | 指標 | 閾値 |
|---|---|---|
| ① | **プレイ区間の落ちフレーム率**（主指標。配信版=等倍へ戻した後の60fpsのユニークフレームで数える、`scripts/81_analyze_stutter_periodicity.py`） | **≤ 1.5%**（実効fps ≥ 59.1） |
| ② | **FpsMonitor 下位5%** | **≥ 目標Hz（60×倍率）× 0.97** |
| ③ | **理論尺の超過**（プラス側だけ。`frameCount/60` との比） | **≤ +1.0%** |
| ④ | **A/V同期**（同期マーカーの残差） | **≤ ±20ms** |
| 前提 | 試行1回目で完走し、記録スコアが一致する | – |

- **数値は目安であり、開発者が実際に視聴した結果を重視する。** 視聴で判定が覆ることがある（数値で合格でもカクつき・音ズレ・BGM先行で不採用、数値で境界・不合格でも視聴して採用）。数値で判定したセルは、視聴確認の有無をレポートに明記すること。
- **本番の費用との兼ね合いで、基準をやや満たさないもの・不安定なものが採用されることがある。** 採用した場合は、どの基準をどれだけ外れているかを速度表とレポートに残す。
- 判定は各タイトルで最も負荷の高いリプレイ（Extra、またはLunatic・Hardの全面）で行い、境界に近いものは2本以上録る。全体値だけでなく、局所的な落ち込み（30秒窓など）も確認する。
- **重複フレーム率は品質判定に使わない**（倍速では劣化を捉えられず、低速では正常でも50〜60%になる）。既存の異常検知（`default_max_duplicate_rate()`）にだけ使う。
- 適用除外: th06ncの FpsMonitor は描画落ちを示さない（②は使わず①で判定）。th06c・th06ncの理論尺はマイナス側に系統差があり、未クリアのリプレイの理論尺は当てにならない（③は超過方向だけ、または①で代える）。

---

## 新規タイトル対応チェックリスト

新しいタイトルを録画パイプラインに追加する際は、以下の全ステップを実施して品質を確認します。詳細は [docs/new-title-checklist.md](docs/new-title-checklist.md) を参照してください。

1. **設定確認**: `.cfg` がウィンドウモードになっているか確認
2. **起動確認**: Xvfb上で安定して起動するか確認
3. **MOD開発・動作確認**: リプレイ自動再生MOD（DirectInputまたはGetKeyboardStateフック）を実装
4. **リプレイ録画確認**: 通常ステージとExtraステージの両方でフル尺録画を実施
5. **録画品質確認**: 重複フレーム率・理論尺比較で処理落ちを検証
6. **音ズレ確認**: 音声・映像の同期を確認
7. **低速録画機能**: タイムスケールに応じた低速録画（半速等）を実装・検証
8. **内部データ取得機能**: スコア・残機・ステージ番号等のフックおよび倍率を確定
9. **クラウド実機検証**: クラウド環境での安定録画に必要な推奨スペックを確定
10. **画面上fps表示の補正**: 低速・倍速録画時にゲーム画面のfpsカウンタが等倍換算（60fps前後）で表示されるよう、fps計算に使うタイマー呼び出しだけを`mods/common/fps_display_hook`で補正する（項目7とあわせて実施。reports/48, 69, 90, 93）

---

## ドキュメントインデックス (docs/)

分野ごとの詳細仕様・手順・運用ルールは、以下のドキュメントに分割・整理されています：

| ドキュメント | 内容 |
|---|---|
| [docs/new-title-checklist.md](docs/new-title-checklist.md) | 新規タイトル対応時の10ステップ詳細検証手順 |
| [docs/recording-pipeline.md](docs/recording-pipeline.md) | 録画パイプライン実装（`recorder/` パッケージのモジュール構成）、終了検知（MAD/テンプレート/side_stream）、品質評価（重複フレーム率/理論尺/周期性）、低速録画仕様 |
| [docs/audio-capture.md](docs/audio-capture.md) | 音声キャプチャ仕様、PulseAudio設定、並列分離、sattori-home-worker残置シンク対策、映像・音声分離と後mux補正 |
| [docs/input-automation.md](docs/input-automation.md) | DLLインジェクションMODの入力注入アーキテクチャ、DirectInput/GetKeyboardStateフック、スコア監視・完走検証 |
| [docs/environment.md](docs/environment.md) | Xvfb + openbox + wined3d + llvmpipe の環境構築、日本語フォント・ロケール設定 |
| [docs/cloud-deployment.md](docs/cloud-deployment.md) | AWS EC2 / GCP 実機検証、c7i系推奨スペック、Spot Fleet、Docker運用、CloudFront永年無料枠活用 |
| [docs/gpu-recording.md](docs/gpu-recording.md) | AWS GPUインスタンス（g6f系）構築手順、GRIDドライバ導入、Xorg+NVIDIA設定、G系クォータ管理（th06nc/th15等） |
| [docs/known-limitations.md](docs/known-limitations.md) | 未解決課題・要フォローアップ項目の一覧（小見出し別に記載） |
| [docs/recording-results-matrix.md](docs/recording-results-matrix.md) | 全フェーズ(00〜103)の録画検証結果一覧（フェーズ×タイトル×環境×録画速度×結果を1表に集約。Issue #5の元データ） |
| [docs/aws-resources.md](docs/aws-resources.md) | 現在AWS上に残存している検証用リソースの最新一覧と削除手順 |
| [docs/touhou_menu_automation.md](docs/touhou_menu_automation.md) | 東方ProjectゲームへのDirectInput vtableフック技術ノート |

---

## タイトル別ドキュメント (docs/titles/)

各タイトルの固有仕様、推奨インスタンススペック、設定上の注意点は `docs/titles/` 配下の個別ドキュメントに記載されています。

- タイトル一覧インデックス: [docs/titles/README.md](docs/titles/README.md)
  - [th06.md](docs/titles/th06.md) - 東方紅魔郷 (Direct3D8 / 4 vCPU)
  - [th06c.md](docs/titles/th06c.md) - 東方紅魔郷: Classic (64bit DXライブラリ / 4 vCPU)
  - [th06nc.md](docs/titles/th06nc.md) - 東方紅魔郷: New Classic (GPU必須 `g6f.2xlarge`、フォールバック `g6.2xlarge`)
  - [th07.md](docs/titles/th07.md) - 東方妖々夢 (ver1.00b / 4 vCPU)
  - [th08.md](docs/titles/th08.md) - 東方永夜抄 (ver1.00d / 4 vCPU)
  - [th09.md](docs/titles/th09.md) - 東方花映塚 (Direct3D8 対戦 / 4 vCPU)
  - [th10.md](docs/titles/th10.md) - 東方風神録 (Direct3D9 / 4 vCPU)
  - [th11.md](docs/titles/th11.md) - 東方地霊殿 (GetKeyboardState / 8 vCPU `c7i.2xlarge` 必須)
  - [th12.md](docs/titles/th12.md) - 東方星蓮船 (Direct3D9 / 8 vCPU `c7i.2xlarge` 推奨)
  - [th128.md](docs/titles/th128.md) - 妖精大戦争 (thprac必須 / 8 vCPU `c7i.2xlarge` 推奨)
  - [th13.md](docs/titles/th13.md) - 東方神霊廟 (ver1.00c非Steam版 / 8 vCPU `c7i.2xlarge` + 1/2倍速)
  - [th14.md](docs/titles/th14.md) - 東方輝針城 (ver1.00b非Steam版 / GPU `g6f.2xlarge` 2倍速推奨、CPUは`c7i.4xlarge` + 1/2倍速)
  - [th15.md](docs/titles/th15.md) - 東方紺珠伝 (GPU `g6f` 系推奨 / 低速録画)
  - [th20.md](docs/titles/th20.md) - 東方錦上添花 (thprac必須 / 16 vCPU `c7i.4xlarge`)

---

## 参照ファイル・過去フェーズ一覧

詳細な調査経緯・生データは `reports/` 配下を参照してください。全フェーズの一覧は `reports/README.md` にまとまっています。

- `reports/00`〜`05`: 環境構築（Xvfb/wined3d）、初期動作確認、並列実行の限界
- `reports/06`〜`09`: リプレイ自動再生MOD（th07/th08）の実装、Wine環境検証
- `reports/10`〜`14`: 音声キャプチャ、E2E録画・終了自動検知、処理落ち原因調査
- `reports/15`〜`20`: GCP/AWSクラウドデプロイ、インスタンスタイプ比較、ECSエージェント競合対策
- `reports/21`〜`29`: 720pアップスケール、th08のfps暴走・AV同期・文字化け対応、AWS実機検証
- `reports/30`〜`34`: th06のレンダリング修正・MOD実装・AWS検証、リプレイ終了検知の誤検知修正
- `reports/35`〜`40`: th11のWine対応・GetKeyboardStateフック・AWS検証・インスタンススペック調査
- `reports/41`〜`43`: 並列録画の音声分離、eu-south-2リージョン移行検証
- `reports/44`〜`50`: th20の環境構築・MOD実装・AWS実機検証・低速録画PoC・thprac導入
- `reports/51`〜`52`: sattori本番環境トラブルシューティング（サーマルスロットリング、issue再現）
- `reports/53`: スコア監視機能（`mods/common/score_monitor.*`）の全タイトル横展開・完走検証
- `reports/54`: sattori本番のth07（ver1.00b）バイナリ差異修正・再検証
- `reports/55`: wineserver/winedevice後片付けのtry/finally化
- `reports/56`〜`60`: th10の環境構築・MOD実装・フル尺録画・低速録画・AWS実機検証
- `reports/61`〜`67`: th12の環境構築・MOD実装・フル尺録画・AWS実機検証・理論尺比較
- `reports/68`〜`69`: th09の環境構築・MOD実装・D3D8低速録画実装・AWS実機検証
- `reports/70`〜`73`: th128の環境構築・MOD実装・thprac必須対応・AWS実機検証
- `reports/74`〜`77`: th06c（64bit DXライブラリ）のSteamスタブ・入力注入・フル尺録画・AWS実機検証
- `reports/78`〜`81`: th06ncのGPU描画環境構築・AWS GPUスポットインスタンス実機検証・カクつき周期性分析
- `reports/82`: th15の環境構築・DirectInputポーリング特定・GPU実機検証・低速録画動的閾値修正
- `reports/83`: 録画パイプラインの `recorder/` パッケージ化（`scripts/25`のモジュール分割）
- `reports/84`: EC2 GPUインスタンスでのNVENCエンコードオフロード検証
- `reports/85`: th15の倍速録画技術検証（`speed_hack_hook`新規実装、CPU競合の切り分け、x11grabキャプチャfps/タイムスタンプ/stutter probe誤検知/閾値計算の4件のバグ修正）
- `reports/86`: 倍速録画の音質低下（高域欠落）の根本原因特定と解決（Wine dsoundのミックスフォーマットとFFmpeg AACの既定帯域制限、ローカル検証用DirectSoundプローブの整備）
- `reports/87`: th15倍速録画の倍率別比較（1.5/2/3/4倍速、2倍速のみ実用品質）、通常ステージ全6面の2倍速フル尺検証、倍速時の音声遅れ（pulse入力の開始タイムスタンプのぶれ）の発見
- `reports/88`: 音ズレの原因特定（pulse入力のタイムスタンプがWineの出力遅延・シンクのレイテンシを含まない）と、同期マーカー方式（MODがゲーム自身の音声デバイスから低レベルのノイズを鳴らし録画後に相互相関で検出）によるA/V同期補正（±20ms以内）
- `reports/89`: 倍速録画の全タイトル展開（g6f.2xlarge・GPU描画、2倍速はth20以外実用品質、th06〜08の3・4倍速はキャプチャ律速）、th06ncのWASAPIレート偽装、GPU描画面での録画安定化（複数Xorg、ウィンドウID取り込み、thpracリトライ）
- `reports/90`: 倍速録画時の画面上fps表示の等倍換算修正（th06/th08/th10/th12/th20）、th06cの倍速録画対応・g6f.2xlarge検証（2倍速は実用品質、3・4倍速はキャプチャ律速）
- `reports/91`: th15・th20のCPU低速録画の再検証(issue #3)。th20とth15通常ステージは`c7i.4xlarge`の1/2倍速で本番可、th15 Extraは1/3倍速を推奨、40Hzは120fpsキャプチャが必要、`c7i`でもSpot中断あり
- `reports/92`: th06ncの`g6.2xlarge`(L4フル)Spot検証(issue #4)。AMI変更なしで`g6f`と同等、起動127〜140秒、在庫は変動。配信版の変換(`fps`フィルタ)で倍速が約45fpsへ落ちる問題を発見(g6固有ではない)
- `reports/93`: th15の低速録画の画面上fps表示を等倍換算に修正(呼び出し元の2段階判定)
- `reports/94`: th06ncの倍速録画を`g6f.xlarge`で再現できるかの検証。1/8スライスが律速と見られ720p 3倍速・1080p 2倍速とも不可(実効17.6〜31.4fps)、実用は720p等倍のみ。NvFBC→CUDA→NVENC(`scripts/94_nvfbc/`)はvGPUで動くが品質は目標に届かない
- `reports/95`: `g6f.2xlarge`オンデマンドの短い実測。1080p 2倍速は実用水準(Extra 59.20fps)、720p 3倍速は`g6.2xlarge`と同等でなく50.71fps
- `reports/96`: th06ncのCPU描画の律速はBC7テクスチャ。`D3D11_DECODE_BC7=1`(MODがロード時にRGBA8へ展開)でXvfb+wined3dのまま60fps、GPU無しで品質検査を通る録画を初めて確認。1/2倍速の`c7i.2xlarge`で尺1時間約$0.08の見込み(クラウド未検証)
- `reports/97`: th06ncのCPU録画(BC7展開)の`c7i`スポット実測。`c7i.2xlarge`の720p 1/2倍速は通常ステージでGPU等倍と同等・尺1時間約$0.09、Extraは高密度弾幕で描画落ち(`c7i.4xlarge`なら0.7%・約$0.17)。等倍・`c7i.xlarge`は不可。FpsMonitorは描画落ちを示さない
- `reports/98`: 録画品質の判定基準（落ち率1.5%・FpsMonitor下位5%・理論尺+1.0%・同期±20ms、視聴と費用を優先）の策定と、既存レポートから転記したタイトル×環境の最速速度表(issue #5)。th08の3倍速・th06ncの1080p 2倍速が引き上げ候補
- `reports/99`: th15・th20のCPU描画の律速調査。D3D9の描画記録フック(`D3D9_PROBE=1`)と倍速ベンチ(`scripts/99_bench.sh`)を整備。律速はllvmpipeの塗りつぶしそのもので、BC7のような遅い形式・削れる描画は無かった(格上げ・深度間引き・StretchRect化・DXVKは効果なし)。内部解像度960x720(th15.cfg 0x1F、th20.cfg 0x78)なら4コア8スレッドで現行の8コア16スレッド相当になるが画質が下がる(未採用)
- `reports/100`: th13（東方神霊廟 ver1.00c・非Steam版）の導入。ローカル・AWSのフル尺検証、スコア全一致、等倍は`c7i.4xlarge`でもExtraが基準外、1/2倍速の`c7i.2xlarge`で合格
- `reports/101`: 日本語テキストのジャギーの再調査。原因はWineのD3DXが`D3DXLoadSurfaceFromMemory`のTRIANGLE縮小を最近傍で代用すること(フォント描画ではなかった)。`mods/common/d3dx_filter_hook`(`D3DX_AREA_FILTER=1`)の面積平均でth13がWindows実機とほぼ同じ見た目になる。th10〜th15のMODに組み込み済み・既定は無効
- `reports/102`: 文字の縮小フィルタ(`D3DX_AREA_FILTER=1`)の全タイトル確認。th10・th11・th12・th128・th13で効き、Extraのフル尺で表示の崩れなし・スコア一致。th15は内部解像度1280x960では等倍転送のため対象外。AWS(`c7i.2xlarge`、th11・th12等倍、th13 1/2倍速、各2回)でフィルタの有無による品質差なし。th12の`c7i.2xlarge`等倍はフィルタなしでも基準外。ローカルの並列2本ではth10以降が20Hz台まで落ちる
- `reports/103`: th14（東方輝針城 ver1.00b・非Steam版）の導入。ローカル・AWSのフル尺18本でスコア全一致。CPU描画の等倍は`c7i.4xlarge`でも基準外(1280x960の塗りつぶしが律速)、`g6f.2xlarge`のGPU描画は等倍・2倍速とも合格(3倍速は不可)、CPUは`c7i.4xlarge`の1/2倍速が全体では基準内だが局所的に14〜22Hzまで落ちる。低速録画の処理落ち早期検知の誤検知(サブストリーム方式)を修正、`th14.cfg`の0x39(起動時ダイアログ)、fps表示補正
- `reports/104`: フレーム同期キャプチャ(ゲームの描画・取り込みを律速にした可変速の非リアルタイム録画)の実現可能性の机上検討。実現可能と判断、最大の作業は音声(MOD内の仮想音声デバイス)。映像のみのPoCはフェーズ105
- `reports/105`: フレーム同期キャプチャのPoC(映像のみ、`--frame-sync`、`mods/common/frame_sync_hook`)。ローカルXvfbでth15・th12のフル尺4本がフレーム数一致・スコア一致・落ち0.0%、処理速度はth15 1.17〜1.50倍速・th12 約3.5倍速。音声・クラウド実測・他タイトル展開は未着手
- `reports/106`: th15・th12のDirectSoundの使い方の調査(`mods/common/dsound_probe_hook`、`DSOUND_PROBE=1`)。効果音はメインスレッド、BGMは位置通知と補充スレッド。フレーム同期キャプチャ用の仮想音声デバイスの設計
- `reports/107`: フレーム同期キャプチャの仮想音声デバイス(`mods/common/frame_sync_audio`)。DirectSoundを仮想で再生して1フレーム735サンプルをミックス。th15・th12で音声の長さが映像と一致、実時間録画と照合済み。視聴確認・他タイトル展開・クラウド実測は未着手
- `reports/108`: 仮想音声デバイスの効果音抜けの修正(`DuplicateSoundBuffer`の複製を把握していなかった)。修正前後の差し引き(`scripts/108_audio_residual.py`)で指摘の場面に音が戻ったことを確認
- `reports/109`: フレーム同期キャプチャ(`--frame-sync`)の本番導入に向けた負荷決定性・AWS実機(CPU `c7i.4xlarge`/`c7i.2xlarge`/`m7i.xlarge`・GPU `g6f.xlarge`)・コスト検証(`th12`/`th15`)。`th12`のAWS 60fps上限の原因(`IDirect3DDevice9::GetRasterStatus` `vtable[19]`)を`MyGetRasterStatus`フックで解除(`2.31〜2.33倍速`)、`FrameSyncSleepMs`等でCPU 100%飽和負荷(`0.11倍速`)でも映像・音声ドリフト`[0,0,0]`/`A/V 0.0ms`/プレイ区間落ち`0.0〜0.2%`/スコア全一致を確認、`th15` CPUコスト53〜63%削減・`th12` 4vCPU解禁と32%削減を実証
- `reports/110`: D3D9＋DirectSound8 6タイトル(`th10`/`th11`/`th128`/`th13`/`th20`＋追補`th14`)へ`--frame-sync`展開・ローカル検証(`vpatch_th10.dll` IAT・`SYNC_MARKER_TRIGGER`除去・`th20`通知境界仕様解明)。全11本試行1完走・スコア一致・`0.0〜0.1%`落ち(`th14`は`1.17〜1.38x`・`8t 0.92x`/`4t 0.48x`・落ち`0.0%`)
- `reports/111`: D3D8＋DirectSound8 4タイトル(`th06`/`th07`/`th08`/`th09`)へ`--frame-sync`展開・ローカル検証(`CaptureFrameD3D8`・`stepDiv=32`・`AdvanceVirtualToFrame`・Shift-JIS対策)。全8本試行1完走・`5.08〜5.74x`(`th06_05.wav`破損時は除く)
- `reports/112`: 64bit DXライブラリ系(`th06c`/`th06nc`)へ`--frame-sync`展開(`frame_sync_d3d11`/`frame_sync_wasapi`)・全13本番タイトル＋追補`th14`展開完了(`th06c` `4.58〜4.74x`/`MAD=0.0000`、`th06nc` 720p CPU+BC7 `1.51〜1.57x`/0%落ち)・`scripts/112_estimate_ec2_costs.py`による全14タイトルEC2速度・コスト推定
- `recorder/`: 録画パイプライン本体（モジュール構成は `docs/recording-pipeline.md`）
- `mods/`: MODソースコード（`mods/common/` および各タイトル用ディレクトリ）
