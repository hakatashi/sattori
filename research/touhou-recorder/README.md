# touhou-recorder（スナップショット）

> **これは旧リポジトリ `touhou-recorder`（private）の、2026-11-21 時点のスナップショットです。**
> 録画の検証用 PoC として作られ、sattori 本番の録画パイプライン（`worker/`）の元になった
> 実機検証レポート・MOD・スクリプト一式が入っています。**今後の検証は sattori 本体のルールに従い、
> ここへは追記しません**（新しい検証記録は `docs/reports/`、手順は `docs/runbooks/`）。
> 取り込みの経緯と根拠は [`docs/decisions/0074`](../../docs/decisions/0074-import-touhou-recorder-snapshot.md)（Issue #396）。

## 取り込み元

- 元のコミット: `223f266`（touhou-recorder の `main` HEAD、追跡ファイル439件。履歴は取り込んでいない）
- 原本は private のままアーカイブ（read-only）にされ、こちらが正本になった。
- **sattori の文書の「touhou-recorder reports/NN」は `reports/NN_*.md`（このディレクトリ配下）を指す。**
- ゲーム本体・セーブデータ・リプレイ・WINEPREFIX・実行結果（`games/`・`prefixes/`・`instances/`・`runs/`）は
  含まれない（著作権物・個人データ・巨大ファイル。`.gitignore` も元のものを引き継いでいる）。
  そのため **このツリーのスクリプトはそのままでは実行できない**。記録として読むこと。
- 元の `AGENTS.md` は `AGENTS.archived.md` に改名して残した（エージェントに自動で読み込まれないようにするため）。
  元の `CLAUDE.md` は削除した（`@AGENTS.md` の参照だけだったため）。
- `../sattori/...` への相対パスのうち、**動作に関わるもの**（`scripts/53_get_replay_score.mjs`・
  `scripts/91_summarize_slowmo.py`・`scripts/97_time_convert.py`）は取り込み後のパスへ直した。
  レポートの中の記述は当時のまま。
- `package.json` / `pyproject.toml` は無く、pnpm workspace・pytest・vitest・Dependabot の対象外。
  `mods/` は sattori の `worker/mods/` とは別物で、CI のビルドは拾わない。

## 伏せ字の規則

公開してはいけない識別子は、種類が分かる `<...>` に置き換えてある（実際の値は復元できない）。

| 伏せ字 | 元の値 |
| --- | --- |
| `<AWS_ACCOUNT_ID>` | AWS アカウントID（S3 バケット名・ECR の URL・ARN の中のものも） |
| `<INSTANCE_ID>` / `<AMI_ID>` | EC2 インスタンスID / AMI ID |
| `<SECURITY_GROUP_ID>` / `<VPC_ID>` / `<SUBNET_ID>` / `<KEY_PAIR_ID>` | SG・VPC・サブネット・キーペアのID |
| `<SPOT_REQUEST_ID>` | スポットインスタンスリクエストID |
| `<JOB_ID>` / `<JOB_ID_PREFIX>` | 本番の録画ジョブID（`.rpy` のファイル名。認可の秘密値、decisions/0004）と、その先頭8桁の短縮形 |
| `<HOME_GLOBAL_IP>` | 自宅のグローバルIP |
| `<GCP_PROJECT_ID>` / `<GCP_PROJECT_NUMBER>` | GCP のプロジェクト名・番号（削除済み） |

同じ種類の別々の値も同じ伏せ字になるので、**レポートの中で「どの ID とどの ID が同じか」は追えない**
ことがある。検査は `scripts/check-public-mirror.sh --tree research/touhou-recorder`（Issue #395）。
`docs/aws-resources.md` は残存リソースの一覧と削除コマンドだが、識別子がすべて伏せ字なので、
そのままでは実行できない（棚卸しは Issue #397）。

---

以下は元の README（取り込み時点）。「Webサービス化はスコープ外」の記述は、その後 sattori として
実現済みであり、当時のままの記録である。

# touhou-recorder

東方Projectのリプレイファイル(.rpy)を、Wine + Xvfb(ヘッドレス仮想ディスプレイ) + ffmpeg の組み合わせで自動的に動画化できるかを検証するPoC(概念実証)。

目的は「Wine環境で東方のリプレイを60fps固定で再生し、デシンク(同期ずれ)なく動画として録画できるか」という技術的成否の確認のみ。Webサービス化・クラウド展開は本リポジトリのスコープ外。

## ディレクトリ構成

- `games/thXX/` — 各タイトルの実行ファイル・セーブデータ・リプレイ一式(gitignore対象、ローカルにのみ存在)
- `titles/thXX.yaml` — タイトルごとの設定(実行ファイル名、D3D世代、replay配置、期待値など)
- `config/renderers.yaml` — レンダラー(GPU DXVK / wined3d / ソフトウェアlavapipe)のプロファイル定義
- `scripts/` — セットアップ・実行・計測・レポート生成スクリプト一式
- `prefixes/` — WINEPREFIX実体(生成物、gitignore対象)
- `runs/<run_id>/` — 1回の実行の全成果物(動画・ログ・fps統計・判定結果、gitignore対象)
- `reports/` — フェーズごとの進捗ミニレポート、最終レポート(`latest.md`)

## 進め方

検証はフェーズ0(環境確認)→フェーズ1(th06をXサーバー上で確認)→フェーズ2(th06をXvfbヘッドレスで確認)→フェーズ3(全タイトルのデシンク検証)→フェーズ4(GPU/ソフトウェアレンダリング比較)→フェーズ5(並列実行の限界検証)の順で進める。詳細は `reports/` 配下の各ミニレポートを参照。
