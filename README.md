<p align="center">
  <img src="apps/web/public/logo-black.svg" alt="Sattori" height="80">
</p>

# Sattori

**東方Projectのリプレイファイルをアップロードするだけで、録画動画を自動生成できる無料ウェブサービス。**

東方原作ファンが、動画ファイルの扱いに詳しくなくても、面倒な処理をせずに気軽に
リプレイの録画動画を作成し、各種動画サイトへ簡単にアップロードできるようにする
ことを目指しています。

## 仕組み

1. リプレイファイル（`.rpy`）をブラウザからアップロード
2. AWS 上で東方本体を Wine + Xvfb + ffmpeg によりヘッドレス録画（GPU不要）
3. 完成した動画を CloudFront 経由でダウンロード

録画パイプラインは別リポジトリ [`touhou-recorder`](../touhou-recorder) の PoC で
th07（妖々夢）・th08（永夜抄）の E2E 動作を実証済みで、その知見をもとに構築しています。

## モノレポ構成

| パッケージ | 内容 |
| --- | --- |
| `apps/web` | フロントエンド（Vite + React + CSS Modules） |
| `apps/api` | バックエンド API（AWS Lambda ハンドラ / TypeScript） |
| `packages/shared` | フロント・API 共有の型定義 |
| `packages/replay-parser` | `.rpy` デコーダ（フェーズ2で実装予定） |
| `worker` | 録画ワーカー（Python + Docker、EC2 Spot 上で実行） |
| `infra` | AWS CDK（TypeScript）によるインフラ定義 |

技術スタック: TypeScript 7.0 / Vite / React / Vitest / CSS Modules / AWS CDK /
pnpm workspaces + Turborepo。

## 開発

```bash
pnpm install            # 依存インストール（asdf で pnpm 10.33 / Node 24 を使用）
pnpm build              # 全パッケージビルド
pnpm test               # 全パッケージのテスト
pnpm typecheck          # 型チェック
pnpm --filter @sattori/web dev   # フロントエンドの開発サーバ
```

## 現在の状況

**フェーズ1（初期実装）**: th07 のリプレイをアップロード → 録画ジョブ実行 →
S3 アップロードまでの最小フローを実装済み。メール認証・リプレイ解析・複数タイトル
対応・ジョブのリトライ制御はフェーズ2以降で追加します。

開発の全体設計・拡張計画・引き継ぎ情報は **[`AGENTS.md`](./AGENTS.md)** を参照してください。

## ライセンス / 注意

Sattori はファンメイドの非公式サービスです。東方Project © 上海アリス幻樂団。
ゲーム本体・リプレイ等の著作権物はリポジトリに含まれません。
