# AGENTS.md

Sattori（東方リプレイ録画ウェブサービス）の全体設計。着手前に必読。**ここには常に踏まえて
おくべき情報だけを置き、詳細は各パッケージの README と `docs/` に分割してある**（§4・§6）。
**毎セッション常時ロードされる**ため、追記型の情報（既知の制約・検証結果・根拠）を書き足しては
ならない。上限は150行 / 12 KB。

## 1. サービス概要と現状

東方Projectのリプレイファイル（`.rpy`）をアップロードすると AWS 上で自動録画し、動画を
ダウンロードできる無料サービス。動画に詳しくないファンでも迷わず使えることを最優先とし、UI は
説明を最小限に、操作を単純にする。想定利用規模は**月間最大1000回**の録画で、コストとオペレー
ションの最小化を最優先に設計判断を行っている。主要機能（アップロード→解析プレビュー→マジック
リンク認証→録画→ポーリング→DL→完了メール）は実装済みで、現在は初回リリースに向けた準備段階。
対応タイトルは th06・th07・th08・th11・th20 の5本。未実装・未検証の事項は
[`docs/known-limitations.md`](docs/known-limitations.md) に一覧してある。実機検証レポート群は別
リポジトリ `touhou-recorder`（PoC）にあり、各所の `reports/NN` はその番号。

## 2. アーキテクチャ概観

**リージョンは `eu-south-2`（スペイン）**（2026-08移設、Spot単価が実測最安のため。
`docs/aws-region-cost-analysis.md`）。**SESだけ`us-east-1`に残している**（eu-south-2にSESが
無いため。`SES_REGION`、`apps/api/src/ses.ts`）。CloudFront用ACM証明書もus-east-1必須で、
SESと合わせ`SattoriEdgeStack`にまとめてある（`infra/README.md`）。

```
[ブラウザ: React/Vite SPA]
  ① 署名付きURLで .rpy を S3 へ直接PUT（解析・プレビューはブラウザ内で並行実行）
  ② POST /magic-links でメール認証（status: pending のジョブ作成）
  ③ メール内リンクから POST /jobs/{jobId}/start で録画ジョブ起動
  ④ GET /jobs/{id} をポーリングして進捗表示・DL
        ▼
[API Gateway HTTP API] → [Lambda ハンドラ群] → [DynamoDB: ジョブ状態・レート制限]
        ▼ startJob が Step Functions を StartExecution
[Step Functions(Standard, 1ジョブ=1実行)] ワーカーを1台**割り当て**、ワーカー自身が taskToken
   で成否を通知。失敗時は孤児をterminateしつつ最大10回リトライ(`apps/api/src/retryPolicy.ts`)
        ├─(A) 自宅サーバーが空いていればオファーを書いて数十秒待つ。常駐デーモン
        │      (`home-worker/`)がclaimすれば同じイメージをローカル実行(§3)
        ▼(B) claimされなければオファーを撤回しEC2へ
[EC2 Fleet ワーカー(Spot, Docker: Wine+Xvfb+ffmpeg+Python)]
   .rpy取得 → 録画 → 生動画をS3へチェックポイントUP → 配信用変換(等倍化・解像度合わせ・
   ウォーターマークを1パス) → S3へUP → DynamoDB更新 → taskToken通知 → 停止
        ▼
[S3(出力) → CloudFront(OAC)] → ブラウザからDL
        ▼ status="done" への更新を DynamoDB Streams が拾って
[Lambda: sendCompletionEmail] → SES(us-east-1) で完了メール送信
```

これとは別に、**EventBridgeの定期実行（10分間隔）で孤児EC2を掃除する Lambda**（Issue #23）が
走っている。ジョブレコードではなく**AWS上に実在するインスタンス（タグ`sattori:jobId`）を起点に
走査する**ため、`Launch`が`instanceId`を書く前に死んだケースも拾える。運用調査用の管理画面
（`/admin`、Issue #51）も同じリソース群を覗く（`apps/api/README.md`）。

## 3. 常に踏まえておくべき設計判断

どのパッケージで作業する場合も影響する、確定済みの全体方針。**知らずに作業すると誤った
変更をしてしまうもの**だけを置く。根拠の詳細は括弧内の参照先にある。

- **ウェブ基盤は AWS フルサーバーレスに統一**。録画基盤が AWS 固定で、他クラウドを混ぜると
  クロスクラウドの IAM 連携が増えるため。唯一の例外が SES（§2）。
- **IaC は AWS CDK（TypeScript）だが、EC2 の起動だけは実行時に AWS SDK で行う**（ベースの
  Launch Template のみ CDK が作り、ジョブ毎の UserData は `CreateLaunchTemplateVersion` で
  上書き）。PoC で `terraform-provider-aws` が Spot キャパシティ不足時に無限ハングしたため
  （touhou-recorder `reports/16`）。**新しいインフラを足す際もこの分離を崩さないこと**。
- **録画ジョブは Step Functions（Standard）でオーケストレーションする**（1ジョブ=1実行、
  `infra/README.md`）。**進捗はポーリング**（WebSocket/SSE は月1000回規模には過剰）。
- **配信は必ず CloudFront 経由**（S3 直リンク禁止）。永年無料枠で egress を実質ゼロにできる。
- **録画ワーカーは EC2 Fleet と自宅サーバーの2種類あり、どちらも同じ ECR イメージ・同じ taskToken
  契約で動く**（Issue #49）。自宅マシンは NAT 配下で到達できないため割り当ては**Pull 型**（AWS が
  オファーを書き、常駐デーモンが条件付き更新で原子的に claim する）。**ワーカーの中に「自宅かEC2か」
  の分岐を作らないこと** —— 環境差分は起動側が渡す環境変数（`apps/api/src/workerEnv.ts`）で表す。
- **低速録画（1/2倍速で録画し後処理で等倍へ戻す、Issue #68）は自宅ワーカー限定で、かつ対応タイトル
  （`SLOW_MOTION_SUPPORTED_GAME_IDS`、現状 th20 のみ）でしか選べない**。**この制約もワーカー側の
  分岐にはしない** —— 起動側が `FPS_LIMIT_TARGET_HZ` を渡すかで決まり、claim されなければ EC2 での
  等倍録画へ静かにフォールバックする（`packages/shared/src/slowMotion.ts`）。未対応タイトルで要求
  すると2倍速の動画ができワーカーは検知できない（`docs/known-limitations.md` §1）。
- **録画ワーカー（`worker/`）だけ Python**。PoC の numpy/PIL によるフレーム差分・Wine 制御が実証
  済みのため。**この例外は録画パイプラインに限る** —— 自宅ワーカーの常駐デーモン（`home-worker/`）は
  コントロールプレーンしか担わないので TypeScript で書いている。
- **jobId 自体が認可の秘密値**（マジックリンクのトークンではなく jobId をそのまま使う）。メールを
  確認しないと分からない値であることで bot/濫用対策とメール認証を兼ねている。**管理画面（`/admin`）
  の認証は別系統**で、SSM の共有トークンを Lambda Authorizer が検証する（`infra/README.md`）。
- **インスタンスタイプ・録画パイプラインの変更は必ず実機検証を経ること**。「同スペック帯・同価格帯
  だから安全」という推測は繰り返し裏切られている。妥当性は touhou-recorder のレポートか、この
  リポジトリでの実機/実データスモークテストの記録で必ず裏付けること（`apps/api/README.md`）。
- **重複フレーム率の自動チェックは録画開始15〜45秒の30秒スポットしか見ていない**
  （`recording_common.measure_duplicate_rate`、Issue #93）。タイトル間・環境間で比較する際は
  「全編の代表値ではない」ことに注意（`docs/known-limitations.md` §3）。
- **管理画面のコスト表示は推定値であって請求額ではない**（`packages/shared/src/cost.ts`）。
  リージョンや候補インスタンスタイプを変える場合は単価定数も見直すこと（同 §7）。

## 4. モノレポ構成

pnpm workspaces + Turborepo。Node 24 / pnpm 10.33（`.tool-versions` で asdf 管理）。
**各パッケージの詳細は README にある。作業前に必ず該当する README を開くこと。**

| パッケージ（詳細はリンク先） | 役割 |
| --- | --- |
| [`packages/shared`](packages/shared/README.md) | 型定義（ゲーム・リプレイ・ジョブ・API 契約） |
| [`packages/replay-parser`](packages/replay-parser/README.md) | `.rpy` デコーダ。npm 名 `@sattori/touhou-replay-parser`（OSS公開のため `@sattori/shared` 非依存） |
| [`apps/api`](apps/api/README.md) | Lambda ハンドラ・EC2起動・課金/レート制限・管理API |
| [`apps/web`](apps/web/README.md) | フロントエンド SPA（`react-router-dom`、vite） |
| [`worker`](worker/README.md) | 録画パイプライン（Python、docker） |
| [`home-worker`](home-worker/README.md) | 自宅サーバー常駐デーモン（Issue #49） |
| [`infra`](infra/README.md) | AWS CDK スタック |

**TypeScript の約束事**（全 TS パッケージ共通）: `tsconfig.base.json` は `NodeNext` +
`verbatimModuleSyntax` + `strict` + `noUncheckedIndexedAccess`。**相対 import は `.js`
拡張子で書く**（NodeNext 流儀。`apps/web` と `infra` は Bundler 解決なので `.ts`）。
テストファイルは tsc の `build` から除外し、vitest の `include: src/**/*.test.ts` で拾う。

```bash
pnpm build / pnpm test / pnpm typecheck        # turbo で全パッケージ横断
pnpm --filter @sattori/web dev                 # フロント開発サーバ(:5173, /api を :8787 へproxy)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth   # CDK 合成
```
> 注: CDK の NodejsFunction が**リポジトリルートから `esbuild` を exec する**ため、ルートの
> devDependencies に `esbuild` を置いてある（この環境は asdf の pnpm を使う）。

## 5. ジョブ状態機械（横断的に使われる）

`pending → queued → launching → recording → converting → done | failed`
（`packages/shared/src/job.ts`）。フロント・API・ワーカーの3者が共通で参照するため、状態の意味を
変える場合は3パッケージすべての整合を確認すること（`packages/shared/README.md`）。

## 6. ドキュメント・手順の置き場所

**ドキュメントに何かを書き足す前に
[`docs/documentation-guidelines.md`](docs/documentation-guidelines.md) を読むこと**（Issue #112）。
書き換えるファイルには追記せず、追記型の情報は1件1ファイルで増やす:

- **現在の仕様が変わった** → 該当パッケージの `README.md` を**書き換える**（追記しない）
- **なぜそうしたかの根拠・踏んだ地雷** → `docs/decisions/` に**新規ファイル**（軽量ADR）
- **実機検証・実測をした** → `docs/reports/` に**新規ファイル**（`YYYY-MM-DD-title.md`、不変）
- **既知の制約・未実装事項** → [`docs/known-limitations.md`](docs/known-limitations.md)
- **手順が増えた** → `docs/runbooks/` か Skill

移設・分割の際は必ず相互リンクを張ること。リンクが無いとエージェントは決定記録に気づけないまま
README の仕様だけを読んで推測で変更する（§3 が最も警戒する事態）。

デプロイ・運用手順は Skill にしてある: `deploy-sattori`（CDK デプロイ・ワーカーイメージの push・
管理画面トークン）／`upload-title-assets`（タイトル資産の S3 アップロード・WINEPREFIX 作成）／
`build-mods`（`*_hook.dll` のビルド）。Issue・PR・GitHub Projects の運用ルールは
[`docs/runbooks/issue-workflow.md`](docs/runbooks/issue-workflow.md)。**Issue を解決する修正は
直接 main にコミットせず必ず PR を作り、本文に `Closes #xxx` を書くこと。**
