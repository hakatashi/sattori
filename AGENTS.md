# AGENTS.md

Sattori（東方リプレイ録画ウェブサービス）の全体設計・拡張計画・引き継ぎ情報。
このリポジトリで作業する次のエージェント（または人間）は着手前に必読。
録画バックエンドの技術的背景は別リポジトリ `touhou-recorder`（PoC）の
`reports/latest.md` と `AGENTS.md` に詳しい。

## 1. サービス概要

東方Projectのリプレイファイル（`.rpy`）をアップロードすると、AWS 上で自動録画し、
動画をダウンロードできる無料サービス。動画に詳しくないファンでも迷わず使えることを
最優先とし、UI は説明を最小限に、操作を単純にする。想定利用規模は**月間最大1000回**の
録画。この規模を前提に、コストとオペレーションを最小化する構成を選んでいる。

## 2. アーキテクチャ（AWS フルサーバーレス）

```
[ブラウザ: React/Vite SPA]
  ① 署名付きURLで .rpy を S3 へ直接 PUT
  ② POST /jobs で録画ジョブ起動
  ③ GET /jobs/{id} をポーリングして進捗表示・DL
        │
[API Gateway HTTP API] → [Lambda: createUpload / createJob / getJob] → [DynamoDB: ジョブ状態]
        │ createJob が Step Functions の実行を開始(StartExecution)
        ▼
[Step Functions(Standard, 1ジョブ=1実行)]
   Launch(Lambda, waitForTaskToken, 60分timeout) が EC2 Fleet でワーカーを起動
   ワーカーの成否は taskToken(SendTaskSuccess/Failure)で通知される。失敗時は
   HandleFailure(Lambda)が孤児インスタンスをterminateしつつ最大3回までリトライ
        ▼
[EC2 Fleet ワーカー(Spot, Docker: Wine+Xvfb+ffmpeg+Python)]
   S3から.rpy取得 → 録画(進捗スクリーンショットをS3・DynamoDBへ定期報告) →
   生動画をS3へチェックポイントUP → 720pアップスケール変換(進捗%報告) →
   変換後動画をS3へUP → DynamoDB更新 → taskToken通知 → 自動シャットダウン
   (Spot中断の2分前通知をIMDS経由で監視し、検知次第taskTokenで早期に失敗通知して
   リトライを早める。リバランス推奨は発効するとは限らない予測的シグナルのため
   失敗扱いにせずログのみで処理を継続する)
        ▼
[S3(出力) → CloudFront(OAC, 無料枠1TB/月)] → ブラウザからDL
```

### 主要な設計判断（確定済み）
- **ウェブ基盤は AWS フルサーバーレスに統一**。録画基盤が AWS 固定（EC2/S3/CloudFront）で
  あるため、Firebase/GCP を混ぜるとクロスクラウドの IAM 連携が増える。単一クラウドに寄せて
  運用を単純化。
- **IaC は AWS CDK（TypeScript）**。モノレポの言語を TS に統一。
  ただし **EC2 インスタンスの起動（EC2 Fleet）は CDK ではなく実行時に AWS SDK で行う**
  （ベースの Launch Template のみ CDK が作り、ジョブ毎の UserData は実行時に
  `CreateLaunchTemplateVersion` で上書きする）。PoC で `terraform-provider-aws` が
  Spot キャパシティ不足時に無限ハングする問題が判明しており（touhou-recorder
  `reports/16`）、IaC でインスタンスを作らない方針を踏襲。
- **録画ジョブは Step Functions（Standard）でオーケストレーション**（Issue #11）。
  1ジョブ=1実行。`Launch` タスク（`waitForTaskToken`、60分タイムアウト）がEC2 Fleetで
  ワーカーを起動し、ワーカー自身が taskToken 経由で成否を通知する。Spot中断・
  タイムアウト時は `HandleFailure` タスクが孤児化したインスタンスをterminateしつつ
  最大3回まで自動リトライする。ワーカーはIMDS経由でSpot中断の2分前通知を監視し、
  検知次第60分タイムアウトを待たずに早期失敗通知する。EC2 Fleetの
  `AllocationStrategy` はコスト優先で `lowest-price` 固定（`apps/api/src/ec2.ts`）
  としており、その分リバランス推奨（発効するとは限らない予測的シグナル）は
  比較的発生しやすい。これをそのまま早期失敗の合図にすると完走できたはずの
  ジョブまで不要にリトライしてしまうため、リバランス推奨は失敗扱いにせずログの
  みで処理を継続する（実際のSpot中断通知の監視は継続）。
- **進捗はポーリング**（WebSocket/SSE は月1000回規模には過剰）。ワーカーが DynamoDB を
  更新し、`GET /jobs/{id}` が返す。
- **配信は必ず CloudFront 経由**（S3 直リンク禁止）。CloudFront 永年無料枠で egress を
  実質ゼロにできる（PoC 実証済み）。出力 S3 は7日、アップロード S3 は1日で自動削除。
- **録画ワーカーだけ Python**。PoC の numpy/PIL によるフレーム差分・Wine 制御が実証済みで、
  TS 再実装はリスクだけ増える。フロント・API・パーサー・IaC は TypeScript 7.0。

## 3. モノレポ構成

pnpm workspaces + Turborepo。ルートに `pnpm-workspace.yaml` / `turbo.json` /
`tsconfig.base.json`。Node 24 / pnpm 10.33（`.tool-versions` で asdf 管理）。

| パッケージ | 役割 | 主なツール |
| --- | --- | --- |
| `packages/shared` | 型定義（ゲーム・リプレイ・ジョブ・API 契約） | tsc, vitest |
| `packages/replay-parser` | `.rpy` デコーダ（**実装済み**。npm パッケージ名は `@sattori/touhou-replay-parser`。`@sattori/shared` 非依存でOSS公開可能な設計） | tsc, vitest |
| `apps/api` | Lambda ハンドラ・S3/DynamoDB/EC2 連携 | tsc(--noEmit), vitest |
| `apps/web` | フロントエンド SPA | vite, vitest, jsdom |
| `worker` | 録画パイプライン（Python） | python, docker |
| `infra` | AWS CDK スタック | cdk, tsx, vitest |

### TypeScript の約束事
- `tsconfig.base.json` は `NodeNext` + `verbatimModuleSyntax` + `strict` +
  `noUncheckedIndexedAccess`。
- **相対 import は `.js` 拡張子で書く**（emit される JS に合わせる NodeNext 流儀）。
  `apps/web` と `infra` は Bundler 解決なので `.ts` 拡張子（`allowImportingTsExtensions`）。
- テストファイルは tsc の `build` から除外し、vitest の `include: src/**/*.test.ts` で拾う。

### コマンド
```bash
pnpm install
pnpm build / pnpm test / pnpm typecheck        # turbo で全パッケージ横断
pnpm --filter @sattori/web dev                 # フロント開発サーバ(:5173, /api を :8787 へproxy)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth   # CDK 合成
```
> 注: この環境は asdf の pnpm を使う。CDK の NodejsFunction は**リポジトリルートから
> `esbuild` を exec する**ため、ルート devDependencies に `esbuild` を置いてある。
> corepack のダウンロードプロンプトが出る場合は `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` を付ける。

## 4. API 契約（`packages/shared/src/api.ts`）

| メソッド・パス | 用途 |
| --- | --- |
| `POST /uploads` | 署名付きアップロードURL発行（キーはサーバー採番、`.rpy`・サイズ検証） |
| `POST /jobs` | ジョブ作成＋Step Functions実行開始。フェーズ1は認証なしで即起動 |
| `GET /jobs/{jobId}` | ジョブ状態取得（ポーリング用）。完了時に CloudFront のDL URL、
  進行中は進捗率(`progress`)とプレビュー画像URL(`previewImageUrl`)も返す |

ジョブ状態: `queued → launching → recording → converting → done | failed`
（`packages/shared/src/job.ts`）。ワーカーが `recording` 以降を DynamoDB に書き込む。
`converting` は録画完了(生動画チェックポイントアップロード済み)〜720p変換〜出力
アップロード完了までを指す（旧 `uploading` から改名、Issue #11）。

## 5. 録画ワーカー（`worker/`）

- `entrypoint.py`: ジョブの全体制御。DynamoDBの`outputPath`(生動画チェックポイント)
  が既にあれば「変換から再開」、無ければS3からリプレイDL→録画→生動画をS3へ
  チェックポイントUP(status=`converting`)→720pアップスケール変換→S3へUP→
  DynamoDB更新、の順で進む。バックグラウンドで`InterruptionWatcher`
  （Spot中断の2分前通知をIMDS経由で監視。リバランス推奨は失敗扱いにせずログのみで
  処理を継続する）と`ProgressReporter`（録画中の進捗スクリーンショット/進捗率を
  S3・DynamoDBへ反映）を動かす。taskToken経由で
  Step Functionsへ成否を通知する（`SendTaskSuccess`/`SendTaskFailure`）。
  UserData から `docker run`。
- `record_th07.py`: th07 録画本体。PoC `scripts/11_...` の刷新版。2秒毎の画面
  キャプチャのうち5回に1回(約10秒毎)を`--progress-dir`へスクリーンショット
  (`frame.jpg`)と経過時間(`state.json`)として書き出す（追加のffmpeg呼び出しは発生
  しない。既存のMAD差分検知用キャプチャを流用）。
- **任意ファイル名のリプレイを正規スロット名 `th7_ud0000.rpy` として配置**することで、
  MOD の「リプレイ一覧の1件目を固定選択」ロジックを改修せずに任意リプレイを再生する。
- `upscale.py`: th07(640x480)のような低解像度録画をそのまま YouTube にアップロード
  すると60fpsとして認識されない問題への対応（`touhou-recorder reports/21`）。
  **録画と同時ではなく録画完了後の別ステップとして**、アスペクト比を保ったまま
  高さ720px(th07なら960x720)へ変換した版を追加生成し、元動画と併せて2本を
  出力S3へアップロードする（DynamoDB `outputPath` / `outputPath720p`、API
  `GetJobResponse.downloadUrl` / `downloadUrl720p`）。同時アップスケールは
  4vCPU構成(実用下限)で重複フレーム率を2倍以上悪化させるため不採用。
  ページBの主要ダウンロードボタンは既定で720p版を案内し、元解像度版は副次リンクで提供する。
  変換の進捗はffmpegの`-progress`出力(`out_time_ms`、実体はマイクロ秒)から算出し、
  10秒間隔程度でコールバックする。
- `interruption_watcher.py` / `progress_reporter.py`: IMDSv2ポーリングによる
  Spot中断監視、および進捗スクリーンショットのS3アップロードを行うバックグラウンド
  スレッド（Issue #11、標準ライブラリのみで実装・新規依存なし）。
- `worker/mods/`: DLL インジェクタ（`common/injector.cpp`）と th07 自動再生フック
  （`th07_replay_autoplay/dllmain.cpp`）の**ソースはこのリポジトリで管理**（元は
  `touhou-recorder` PoC）。C++/MSVC（Windows + VS C++ x86 tools）でビルドが必要
  （ビルド手順は `worker/README.md`）。
- ゲーム本体・WINEPREFIX・MOD **ビルド成果物**（`injector.exe`/`th07_hook.dll` 等）・
  ウォーターマーク素材は**リポジトリに含めない**（`.gitignore` 済み）。ビルド/配置は
  `worker/` 配下へ（`worker/README.md` 参照）。

### PoC 由来の必修ハマりどころ（`touhou-recorder/reports/` 由来）
- 録画開始は MODログ `WaitForStableWindow: stable` 確認後（早いと重複フレーム多発）。
- クロップ座標は `xwininfo` の `Absolute upper-left`（`xdotool` はタイトルバー分ズレる）。
- 日本語表示は MS Gothic 登録 + プロセスを `LANG=ja_JP.UTF-8` で起動。
- 終了検知は直前フレームとの MAD が閾値 **2.0** 未満で16秒連続（霧背景等の誤検知対策）。
- ウォーターマーク webm のデコードは `-c:v libvpx-vp9` を明示（VP9アルファの罠）。
- **4 vCPU が実用下限**、インスタンスは `c7i.xlarge` 推奨。高クロック特化(z1d)は逆効果。
- `.cfg` はウィンドウモード必須（フルスクリーンだと Xvfb でハング）。
- 対応タイトルは PoC 実証済みの th07・th08 のみ。フェーズ1は **th07 のみ有効**。
- 720pアップスケールは**幅を1280に固定しない**（`reports/21`）。th07は640x480(4:3)
  であり、1280x720(16:9)に固定すると横方向だけ引き伸ばされて歪む。入力解像度から
  `round(w * 720 / h / 2) * 2` で幅を算出し、アスペクト比を保つ（th07なら960x720）。

## 6. インフラ（`infra/`, CDK）

`SattoriStack` 一つに集約（フェーズ1）:
- S3: アップロード用（1日）・出力用（7日、動画に加え進捗スクリーンショットも
  `progress/{jobId}/*.jpg` として置く）・Web ホスティング用
- CloudFront: 動画配信用・Web 用（いずれも OAC 非公開）
- DynamoDB: `jobId` パーティションキー、オンデマンド課金
- ECR: `sattori-worker`
- VPC: NAT なし公開サブネット×2AZ（ワーカーは外向き通信のみ）+ SG（egress のみ）
- EC2 Launch Template: ワーカー起動の基点（AMI/インスタンスタイプ/IAM/SG固定）。
  ジョブ固有の UserData は実行時に `CreateLaunchTemplateVersion` で上書きする
- Step Functions: `RecordingStateMachine`（Standard）。`Launch`
  （`waitForTaskToken`、60分タイムアウト）→ 失敗時 `HandleFailure` →
  リトライ(最大3回)/`Fail` の状態遷移（Issue #11）
- IAM: ワーカーロール（ECR pull / S3 / DynamoDB / `states:SendTask*`）+
  インスタンスプロファイル、Launch Lambda ロール（EC2 Fleet起動 + `iam:PassRole`）、
  HandleFailure Lambda ロール（`ec2:TerminateInstances`）、
  createJob Lambda ロール（`states:StartExecution`）
- Lambda(NodejsFunction ESM) × 6（createUpload/parseReplay/createJob/getJob/
  sfn.launch/sfn.handleFailure）+ HTTP API + ルーティング
- ワーカー AMI は SSM の ECS 最適化 AL2023（Docker 同梱）を参照

デプロイ手順の要点:
1. `pnpm build`（web の dist を作ると CDK が `BucketDeployment` で配信）
2. `cdk bootstrap`（初回）→ `cdk deploy`
3. ワーカーイメージを ECR へ push（`docker build worker/` → `docker push`）
4. web の `VITE_API_BASE` に HTTP API の URL を設定して再ビルド・再デプロイ

## 7. ユーザーフロー（製品全体像 / フェーズ2で実装）

フェーズ1は「アップロード→即録画→DL」の最小フローのみ。製品版は以下:
1. **ページA**: `.rpy` 選択 → 自動アップロード＆解析 → ゲーム名/キャラ/スコア/クリア可否を
   プレビュー。メール入力＋解析成功で「次のステップ」活性化。詳細設定でウォーターマーク
   ON/OFF（既定 ON）。
2. ボタン押下で SES から**マジックリンク**送信（単一ジョブ紐付け・有効期限付き・単回使用）。
   これがメール認証と bot/濫用対策（コスト管理）を兼ねる。同一メールのレート制限あり。
3. **ページB**（リンク先）: クリックでジョブ起動、進捗ポーリング、完了で DL ＋完了メール再送。
   リンク＝ジョブの永続ビューとして何度でも戻れる。

## 8. リプレイパーサー（`packages/replay-parser`, 実装済み）

`raviddog/threplay` の `ReplayDecoder.cs` を参考に独自にTypeScriptへ書き起こした
（詳細は `packages/replay-parser/README.md`）。**`@sattori/shared` を含む他の
ワークスペースパッケージに一切依存しない**（単体でOSS公開できることを意識した設計）。
Sattori向けの `ReplayInfo` への変換は `packages/shared/src/replay.ts` の
`fromParsedReplay()` が担う（依存の向きは shared → replay-parser の一方向）。

- **npm パッケージ名は `@sattori/touhou-replay-parser`**（ディレクトリ名
  `packages/replay-parser` とは異なる）。単体OSS公開を前提としているため、
  モノレポ内の他パッケージのような `@sattori/<ディレクトリ名>` 命名には揃えていない。
- **コード内コメント・README・テストの記述（`describe`/`it` 文言等）は英語で書く**
  （このパッケージのみの規約。モノレポの他パッケージは日本語で構わない）。
  ただし以下は対象外・例外:
  - `REPLAY_GAME_TITLES`（`src/game-ids.ts`）や `ParsedReplay.gameTitle` など、
    ライブラリが実際に返す値（公開APIの出力データ）は原作準拠の日本語表記のまま。
    ゴールデンテストの `test-fixtures/**/*.expected.json` にも同じ値が書き込まれている。
  - Shift_JISデコードの検証用リテラル（例: `byte-reader.test.ts` の `"あい"`）等、
    テスト対象のデータそのものである日本語文字列。
  - 東方タイトルの日本語名に言及するコメントは、日本語名を残したまま
    英語略称を併記する（例: `th07 (東方妖々夢, PCB)`）。

- ゲーム判定: 先頭4バイトのマジック（`T6RP`/`T7RP`/`T8RP`/… `t10r`…）。
  th13(神霊廟)とth14(輝針城)は同一マジック`t13r`をヘッダ内バージョンバイトで判別。
- 旧世代(TH06–09/095/125/128/143/165): offset 12 の USER セクションポインタから
  名前/日付/キャラ/難易度/ステージ/スコアを抽出（一部はLZSS展開したステージ内訳も持つ）。
- 新世代(TH10–18): 36バイトヘッダ除去 → `decode()` 2パス（ブロックXOR）→ LZSS系
  `decompress()`（13bit辞書/4bit長）で展開後に抽出。
- **対応タイトルと検証状況は `packages/replay-parser/README.md` の一覧を参照**。
  th06/07/08/09/095/10/11/12/125/128/13/14/143/15/16/17/18/20 は実リプレイ
  （`packages/replay-parser/test-fixtures/**` にチェックイン済みの作者本人プレイ分、
  または Silent Selene から取得した検証用サンプル）で検証済み。th165のみテストデータ
  未入手のため upstream 移植のみ（未検証）。
  th20(錦上京)はUSERセクション（名前/日付/キャラ/難易度/ステージ/スコア）のみ対応
  （ステージ内訳は未解析フォーマットのため非対応）。th19(獣王園)はリプレイ保存機能
  自体が存在しないため対象外。
- 残機・ボム(`splits[].lives`/`.bombs`)は文字列ではなく欠片数にも対応した構造化型
  `ReplayResourceCount`、UFOの色やトランス等のゲーム固有付加情報(`splits[].additional`)も
  文字列ではなく実プロパティを持つオブジェクトとして返す（`packages/replay-parser/README.md`
  参照）。
- 不正/破損/非対応ファイルは例外を投げず `ReplayParseResult`（判別可能なエラー種別）
  を返す。
- ゴールデンテストは `packages/replay-parser/src/golden.test.ts`。`test-fixtures/**`
  にチェックイン済みの実リプレイ（著作権上問題のない作者本人プレイ分のみ）を動的に
  列挙し、`splits` を含む全プロパティをゴールデンJSON(`*.expected.json`)と完全一致
  比較する。リポジトリのクローンのみで完結し、外部リポジトリへの依存はない。
- ライセンス注記: 移植元(threplay/threp)にOSSライセンスの明記がないため、
  `packages/replay-parser/README.md`「クレジット」節にその経緯を記載した上で
  MITとして公開している。

### 版数非互換（旧 #16、解消済み）
録画用 th07 バイナリのバージョンアップにより、以前は再生できなかった版の
リプレイも認識できるようになった。そのため replay-parser・shared のいずれにも
「録画可能バージョンかどうか」を判定するロジックは持たせていない
（`ParsedReplay.formatVersion` はヘッダの生バイトとしてのみ公開）。

## 9. フェーズ計画（GitHub Project の kanban で管理）

- **フェーズ1（実装済み）**: モノレポ雛形 / shared 型 / web 最小UI / api（署名URL・ジョブ起動・
  状態取得）/ worker（th07 録画・S3・DynamoDB）/ CDK 一式。認証・解析・複雑なキューは含まない。
- **フェーズ2**: replay-parser（**実装済み**。§8参照。th06〜th20の大半に対応済みだが、
  録画対応は引き続き th07 のみ）、ページAのプレビュー、SES + マジックリンク認証、
  ページB、Step Functions 化（Spot 中断リトライ・タイムアウト・taskToken 完了通知）、
  ウォーターマークUIの貫通。
- **フェーズ3以降**: 対応タイトル拡大（th08→th06→th10+…、MOD 移植と録画ワーカー拡張を
  並行。パーサー側は既に多タイトル対応済みのため主にMOD移植が残作業）、
  レート制限・濫用対策強化、コスト監視、同時実行スケーリング検証。

## 10. 未解決・要検討
- Spot 中断時のリトライ／レジュームは Step Functions（Issue #11）で対応済み
  （録画完了後・変換前のチェックポイントにより「変換から」再開可能。録画フェーズ
  自体の途中再開は対象外で、中断時はそのフェーズを最初からやり直す）。
- 録画がリプレイと一致しているかの自動デシンク検知は PoC でも未実装（目視のみ）。
- 複数 EC2 同時起動の負荷検証は未実施（1インスタンス=1ジョブ分離で問題ないと推測）。
- th07 以外のタイトルは MOD 移植（録画対応）が未着手
  （リプレイパーサー自体は th06〜th20 の大半に対応済み、§8参照）。
