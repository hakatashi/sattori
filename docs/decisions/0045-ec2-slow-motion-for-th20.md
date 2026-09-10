# 0045. EC2環境でのth20低速録画を有効化し、対応タイトルをコード内定数で管理する

- **状態**: 有効
- **決定日**: 2026-09-11
- **対象**: packages/shared / apps/api / apps/web / docs
- **関連**: Issue #245、PR #246、`docs/decisions/0010-slow-motion-no-worker-side-branching.md`、
  touhou-recorder reports/45・46・47・48

th20 の描画負荷に対する低速録画（1/2倍速録画＋後処理倍速）を EC2 ワーカーでも有効化し、
今後も迅速に有効・無効を切り替えられるよう `EC2_SLOW_MOTION_SUPPORTED_GAME_IDS` を
コード内の設定定数として保持する。`0010` で「低速録画は自宅限定」とした方針の一部を置き換える。

## 背景

th20 は Xvfb + wined3d + llvmpipe のソフトウェアレンダリング環境で描画負荷が非常に重く、
等倍録画ではゲームエンジン自体が処理落ちする（touhou-recorder reports/45・46）。
この対策として 1/2 倍速録画を導入したが、ADR `0010` では「録画時間が倍になり EC2 Spot 料金も
倍になるため割に合わない」として EC2 では等倍録画へフォールバックさせていた。

しかし、2026-08-22 の初回リリース以降の運用実績により、th20 の利用頻度は当初の想定より
少なく、EC2 で低速録画（実時間2倍）を実行しても運用コストへの影響が極めて小さいことが
判明した。そのため、コマ落ちのない高品質な動画を提供するメリットがコスト懸念を上回ると
判断した。また、今後の利用状況に応じて EC2 での低速録画対応タイトルを柔軟かつ迅速に
切り替えられる構成が求められた。

## 決定

- **`packages/shared/src/slowMotion.ts` に `EC2_SLOW_MOTION_SUPPORTED_GAME_IDS`（現状 `["th20"]`）を定義**し、
  EC2 環境で低速録画を有効化するタイトルをホワイトリスト管理する。
- EC2 起動時（`apps/api/src/ec2.ts` の `buildUserData`）において、ジョブが
  `supportsEc2SlowMotion(job.game)` を満たす場合は `FPS_LIMIT_TARGET_HZ=30` を
  コンテナ環境変数として渡す。
- フロントエンド（`apps/web/src/components/UploadForm.tsx`）では、EC2対応タイトルであれば
  自宅ワーカーの接続有無に関わらず低速録画オプションを選択可能とし、既定で有効（オン）とする。
- ジョブ表示やAPIレスポンス（`isSlowMotionRecording`、`defaultSlowMotionFor`）を更新し、
  EC2 ワーカー実行時でも対象タイトルであれば低速録画として判定・表示する。
- 有効・無効の切り替えは **コード内の定数 `EC2_SLOW_MOTION_SUPPORTED_GAME_IDS` の変更**で行う。
  ランタイム（SSM / DynamoDB など）での動的変更機構は導入しない。

## 根拠

- **運用実績に基づくコスト受容性**:
  実際の利用データから th20 の録画リクエスト頻度は低く、Spot 料金の倍増による月間コスト影響は
  軽微であると確認された。
- **録画品質の担保**:
  th20 は EC2 上の等倍録画ではボムやスペルカード等の高負荷区間で処理落ちが発生するため、
  EC2 でも低速録画を適用することでユーザーへ高品質な録画結果を提供できる。
- **設定定数による運用の単純性と安全性**:
  低速録画の有効化設定は秒単位で頻繁に切り替えるものではなく、コード内定数とすることで
  インフラや Lambda の外部ストア依存・IAM 権限の追加を避け、TypeScript の型検査と
  ユニットテストで安全性を保証できる。
- **ワーカーの透過性維持（`0010` の主原則を継承）**:
  ワーカーコンテナ自体は引き続き `FPS_LIMIT_TARGET_HZ` の有無だけを見て動作し、
  ワーカーコード内に「EC2か自宅か」の環境分岐を持ち込まない設計を一貫して維持している。

## 採らなかった選択肢

- **ランタイム（SSM Parameter Store や DynamoDB）での動的切り替え**:
  外部ストアの読み取りオーバーヘッド、キャッシュ整合性、IAM 権限、インフラ管理コストが
  増大する。コードの定数変更とデプロイで十分に迅速な切り替えが可能であるため不採用とした。
- **全タイトルで無条件に EC2 低速録画を許可する**:
  低速録画に対応していない（または実機検証を経ていない）タイトルで有効化すると、2倍速の
  不正動画が生成されるリスク（`0010`、`docs/known-limitations.md` §1）や無用なコスト増に
  つながるため、ホワイトリスト制（`EC2_SLOW_MOTION_SUPPORTED_GAME_IDS`）とした。

## 影響範囲

- `packages/shared/src/slowMotion.ts`（`EC2_SLOW_MOTION_SUPPORTED_GAME_IDS`、`supportsEc2SlowMotion`、`isSlowMotionRecording`、`defaultSlowMotionFor`）
- `apps/api/src/ec2.ts`（UserData 生成時の `FPS_LIMIT_TARGET_HZ` 付与）
- `apps/api/src/handlers/getJob.ts`（低速録画判定への `job.game` 伝播）
- `apps/web/src/components/UploadForm.tsx`（UI オプション制御と初期値設定）
- `apps/web/src/admin/JobDetailPage.tsx`（管理画面での低速録画バッジ表示）
- `docs/decisions/0010-slow-motion-no-worker-side-branching.md`（EC2低速録画無効化の決定を本ADRで supercede）
- `AGENTS.md` §3
