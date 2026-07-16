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
        │ createJob が AWS SDK で EC2 Spot を起動（IaC ではなく実行時起動）
        ▼
[EC2 Spot ワーカー(Docker: Wine+Xvfb+ffmpeg+Python)]
   S3から.rpy取得 → 録画 → S3(出力)へUP → DynamoDB更新 → 自動シャットダウン
        ▼
[S3(出力) → CloudFront(OAC, 無料枠1TB/月)] → ブラウザからDL
```

### 主要な設計判断（確定済み）
- **ウェブ基盤は AWS フルサーバーレスに統一**。録画基盤が AWS 固定（EC2/S3/CloudFront）で
  あるため、Firebase/GCP を混ぜるとクロスクラウドの IAM 連携が増える。単一クラウドに寄せて
  運用を単純化。
- **IaC は AWS CDK（TypeScript）**。モノレポの言語を TS に統一。
  ただし **EC2 Spot の起動は CDK ではなく実行時に AWS SDK（`ec2:RunInstances`）で行う**。
  PoC で `terraform-provider-aws` が Spot キャパシティ不足時に無限ハングする問題が
  判明しており（touhou-recorder `reports/16`）、IaC でインスタンスを作らない方針を踏襲。
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
| `packages/replay-parser` | `.rpy` デコーダ（**フェーズ2で実装**、ディレクトリ未作成） | tsc, vitest |
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
| `POST /jobs` | ジョブ作成＋EC2 Spot 起動。フェーズ1は認証なしで即起動 |
| `GET /jobs/{jobId}` | ジョブ状態取得（ポーリング用）。完了時に CloudFront のDL URL |

ジョブ状態: `queued → launching → recording → uploading → done | failed`
（`packages/shared/src/job.ts`）。ワーカーが `recording` 以降を DynamoDB に書き込む。

## 5. 録画ワーカー（`worker/`）

- `entrypoint.py`: S3からリプレイDL → 録画 → S3へUP → DynamoDB更新。UserData から `docker run`。
- `record_th07.py`: th07 録画本体。PoC `scripts/11_...` の刷新版。
- **任意ファイル名のリプレイを正規スロット名 `th7_01.rpy` として配置**することで、
  MOD の「リプレイ一覧の1件目を固定選択」ロジックを改修せずに任意リプレイを再生する。
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

## 6. インフラ（`infra/`, CDK）

`SattoriStack` 一つに集約（フェーズ1）:
- S3: アップロード用（1日）・出力用（7日）・Web ホスティング用
- CloudFront: 動画配信用・Web 用（いずれも OAC 非公開）
- DynamoDB: `jobId` パーティションキー、オンデマンド課金
- ECR: `sattori-worker`
- VPC: NAT なし公開サブネット×2AZ（ワーカーは外向き通信のみ）+ SG（egress のみ）
- IAM: ワーカーロール（ECR pull / S3 / DynamoDB）+ インスタンスプロファイル、
  API Lambda ロール（S3/DynamoDB、createJob に `ec2:RunInstances` + `iam:PassRole`）
- Lambda(NodejsFunction ESM) × 3 + HTTP API + ルーティング
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

## 8. リプレイパーサー（`packages/replay-parser`, フェーズ2）

`raviddog/threplay` の `ReplayDecoder.cs` を TypeScript へ移植する。
- ゲーム判定: 先頭4バイトのマジック（`T6RP`/`T7RP`/`T8RP`/… `t10r`…）。
- 旧世代(TH06–09): offset 12 の USER セクションポインタから名前/日付/キャラ/難易度/
  ステージ/スコアを抽出。
- 新世代(TH10+): 36バイトヘッダ除去 → `decode()` 2パス（ブロックXOR: `(0x400,0xaa,0xe1)`
  と `(0x80,0x3d,0x7a)`）→ LZSS系 `decompress()`（13bit辞書/4bit長）で展開後に抽出。
- 出力は `ReplayInfo`（`packages/shared/src/replay.ts`）。不正/非対応ファイルの
  ハンドリングを最初から実装し、既知 `.rpy` のゴールデンテストを置く。

## 9. フェーズ計画（GitHub Project の kanban で管理）

- **フェーズ1（実装済み）**: モノレポ雛形 / shared 型 / web 最小UI / api（署名URL・ジョブ起動・
  状態取得）/ worker（th07 録画・S3・DynamoDB）/ CDK 一式。認証・解析・複雑なキューは含まない。
- **フェーズ2**: replay-parser（th07）、ページAのプレビュー、SES + マジックリンク認証、
  ページB、Step Functions 化（Spot 中断リトライ・タイムアウト・taskToken 完了通知）、
  ウォーターマークUIの貫通。
- **フェーズ3以降**: 対応タイトル拡大（th08→th06→th10+…、MOD 移植とパーサー拡張を並行）、
  レート制限・濫用対策強化、コスト監視、同時実行スケーリング検証。

## 10. 未解決・要検討
- Spot 中断時のリトライ／レジューム（フェーズ2で Step Functions により担保予定）。
- 録画がリプレイと一致しているかの自動デシンク検知は PoC でも未実装（目視のみ）。
- 複数 EC2 同時起動の負荷検証は未実施（1インスタンス=1ジョブ分離で問題ないと推測）。
- th07 以外のタイトルは MOD 移植・パーサー拡張ともに未着手。
