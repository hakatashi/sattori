# worker — Sattori 録画ワーカー

東方妖々夢(th07)のリプレイを Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へ
アップロードする Python ワーカー。AWS EC2 Spot インスタンス上で Docker コンテナ
として実行される。技術的背景は `touhou-recorder` の PoC レポート
(`reports/11`, `reports/13`, `reports/14`, `reports/16`, `reports/17`) を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。S3 DL → 録画 → S3 UP → DynamoDB 状態更新 |
| `record_th07.py` | th07 録画パイプライン本体(任意ファイル名リプレイを正規スロットで再生) |
| `status.py` | DynamoDB へのジョブ状態反映 |
| `Dockerfile` | 実行イメージ定義 |

## リポジトリに含まれない資産(ビルド前に配置が必要)

以下はゲーム本体(著作権物)・ビルド成果物・素材であり `.gitignore` 済み。
`docker build` の前に `worker/` 配下へ配置する(touhou-recorder のチェックアウトや
プライベートなアセットストアからコピーする):

```
worker/games/th07/                                     # th07 本体一式(.cfg はウィンドウモード)
worker/prefixes/th07-wined3d-gl/                       # 日本語ロケール初期化済み WINEPREFIX
worker/mods/common/build/injector.exe                  # DLL インジェクタ
worker/mods/th07_replay_autoplay/build/th07_hook.dll   # 自動再生 MOD
worker/assets/watermark/watermark-60fps.webm           # ウォーターマーク素材(VP9 アルファ)
```

## 実行時の環境変数

`apps/api` の `ec2.buildUserData` が UserData 経由でコンテナに渡す:

| 変数 | 説明 |
| --- | --- |
| `JOB_ID` | ジョブ ID(DynamoDB キー・出力キーに使用) |
| `GAME` | タイトル(フェーズ1は `th07`) |
| `REPLAY_BUCKET` / `REPLAY_KEY` | アップロード済みリプレイの S3 位置 |
| `OUTPUT_BUCKET` | 録画動画の出力先バケット(CloudFront オリジン) |
| `JOBS_TABLE` | ジョブ状態の DynamoDB テーブル名 |
| `WATERMARK` | `1` でウォーターマーク合成、`0` で無効 |

## ローカルでの録画単体テスト(ネットワーク不要)

ゲーム資産を配置済みであれば、S3/DynamoDB を介さず録画本体だけを試せる:

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4 \
  --watermark assets/watermark/watermark-60fps.webm
```

## ビルド

```bash
docker build -t sattori-worker:latest worker/
```

## フェーズ1の制約と今後

- 対応タイトルは th07 のみ(PoC で E2E 実証済みなのは th07・th08)。
- Spot 中断時のリトライは未実装(フェーズ2で Step Functions により担保)。
- リプレイ内容の解析・デシンク検知は未実装(フェーズ2以降)。
