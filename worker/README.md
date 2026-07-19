# worker — Sattori 録画ワーカー

東方妖々夢(th07)のリプレイを Wine + Xvfb + ffmpeg でヘッドレス録画し、S3 へ
アップロードする Python ワーカー。AWS EC2 Spot インスタンス上で Docker コンテナ
として実行される。技術的背景は `touhou-recorder` の PoC レポート
(`reports/11`, `reports/13`, `reports/14`, `reports/16`, `reports/17`, `reports/21`) を参照。

## 構成

| ファイル | 役割 |
| --- | --- |
| `entrypoint.py` | ジョブ全体の制御。DynamoDBのチェックポイント確認 → (再開でなければ)S3 DL →
  録画 → 生動画をS3へチェックポイントUP → 720p変換 → S3 UP → DynamoDB/taskToken 通知 |
| `record_th07.py` | th07 録画パイプライン本体(任意ファイル名リプレイを正規スロットで再生)。
  進捗スクリーンショット/状態も書き出す |
| `upscale.py` | 録画動画をアスペクト比を保って720pへアップスケールする後処理(reports/21)。
  進捗コールバック対応 |
| `status.py` | DynamoDB へのジョブ状態・進捗反映、チェックポイント確認用のジョブ取得 |
| `interruption_watcher.py` | Spot中断通知/リバランス推奨をIMDS経由で監視するバックグラウンドスレッド |
| `progress_reporter.py` | 録画中の進捗スクリーンショットをS3へアップロードするバックグラウンドスレッド |
| `Dockerfile` | 実行イメージ定義 |
| `mods/common/` | DLL インジェクタ(`injector.exe`)・共通フック処理のソース(C++, MSVC) |
| `mods/th07_replay_autoplay/` | th07 自動再生フック DLL(`th07_hook.dll`)のソース(C++, MSVC) |

`mods/` 配下はソース・ビルドスクリプトのみリポジトリで管理する
(元は `touhou-recorder` の PoC で作成したもの)。ビルド方法は後述。

## テスト(`tests/`)

Wine/Xvfb/実ゲームに依存する録画本体(`record_th07.py` の `main()`)以外の、
純粋なロジック部分(MAD計算・ffmpegコマンド組み立て・720pアップスケールの
解像度/進捗計算・DynamoDB更新式の組み立て・Spot中断/リバランス判定・進捗
レポートの重複排除等)を pytest でユニットテストする。boto3 呼び出しは
`unittest.mock` でモックし、実際の AWS リソースには接続しない(moto 等の
追加依存は導入していない)。

```bash
pip install -r requirements-dev.txt
pytest
```

GitHub Actions の `Test` ワークフロー(`.github/workflows/test.yml`)の
`worker-test` ジョブで push・PR 毎に自動実行される。

## リポジトリに含まれない資産(ビルド前に配置が必要)

以下はゲーム本体(著作権物)・ビルド成果物・素材であり `.gitignore` 済み。
`docker build` の前に `worker/` 配下へ配置する(touhou-recorder のチェックアウトや
プライベートなアセットストアからコピーする):

```
worker/games/th07/                                     # th07 本体一式(.cfg はウィンドウモード)
worker/prefixes/th07-wined3d-gl/                       # 日本語ロケール初期化済み WINEPREFIX
worker/mods/common/build/injector.exe                  # DLL インジェクタ(下記手順でビルド)
worker/mods/th07_replay_autoplay/build/th07_hook.dll   # 自動再生 MOD(下記手順でビルド)
worker/assets/watermark/watermark-60fps.webm           # ウォーターマーク素材(VP9 アルファ)
```

## MOD (DLL インジェクタ / 自動再生フック) のビルド

`mods/` はソースのみ管理しており、`injector.exe` / `th07_hook.dll` 自体は
`.gitignore` 済みのビルド成果物。**Windows + Visual Studio (C++ x86/x64 tools)**
が必要(ゲームが 32bit ネイティブ Win32 バイナリのため MSVC の x86 ツールチェーンで
ビルドする)。x86 Native Tools Command Prompt for VS、または通常のコマンドプロンプトから:

```bat
worker\mods\common\build_injector.bat
worker\mods\th07_replay_autoplay\build.bat
```

- `build_injector.bat` は `setup_vcvars.bat`(vswhere.exe で VS を検出し
  `vcvars32.bat` を呼ぶ)経由で環境を整えてから `cl.exe` で
  `worker/mods/common/build/injector.exe` を生成する。
- `th07_replay_autoplay/build.bat` は `dllmain.cpp` と `common/` の
  `dinput_hook.cpp` / `window_wait.cpp` / `logging.cpp` を静的にまとめて
  `worker/mods/th07_replay_autoplay/build/th07_hook.dll` を生成する。
- ビルドしたら上記2ファイルを `docker build` 前に配置する(ビルドマシンが
  そのまま `worker/` チェックアウトなら追加コピーは不要)。

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
| `TASK_TOKEN` | Step Functions の `waitForTaskToken` トークン(省略時は通知をスキップ、ローカル検証用) |
| `EXPECTED_DURATION_SECONDS` | リプレイの推定再生時間(進捗率算出の参考値、省略可) |

## 出力ファイル

録画完了後、`upscale.py` で720p(アスペクト比維持、th07なら960x720)へ変換した版を
別ファイルとして追加生成し、元動画と合わせて2本を `OUTPUT_BUCKET` へアップロードする
(同時録画中のアップスケールは4vCPU構成で重複フレーム率を悪化させるため採用しない、
reports/21)。th07(640x480)のような低解像度録画はそのままだと YouTube 側で60fpsと
認識されないため、ページBの主要ダウンロードボタンは既定で720p版を案内する。

| S3キー | 内容 |
| --- | --- |
| `videos/{jobId}.mp4` | 録画そのままの解像度(DynamoDB `outputPath`)。録画完了直後、
  変換前にチェックポイントとしてアップロードされる(Issue #11) |
| `videos/{jobId}_720p.mp4` | 720pアップスケール版(DynamoDB `outputPath720p`) |
| `progress/{jobId}/{unixMillis}.jpg` | 録画中の進捗スクリーンショット(DynamoDB
  `previewImagePath`)。スナップショット毎にユニークなキーを使う(CloudFrontの
  長期キャッシュで古い画像が返り続けるのを避けるため) |

## Spot中断時のリトライと再開(Issue #11)

`entrypoint.py` は起動直後にDynamoDBのジョブレコードを確認し、`outputPath`
(上記の生動画チェックポイント)が既に設定済みなら「変換から再開」する(S3から
生動画をダウンロードし、録画をスキップして720p変換から実行する)。Step Functions
がSpot中断/タイムアウトを検知して新しいワーカーインスタンスでリトライした場合、
このチェックポイントにより録画をやり直さずに済む(録画フェーズ自体の途中再開は
非対応で、中断時はそのフェーズを最初からやり直す)。

`interruption_watcher.py` がIMDS経由でSpot中断通知/リバランス推奨(いずれも2分前
通知)を監視し、検知次第 taskToken 経由で Step Functions に早期失敗通知する
(60分のタスクタイムアウトを待たずに新インスタンスでのリトライを開始させるため)。

## ローカルでの録画単体テスト(ネットワーク不要)

ゲーム資産を配置済みであれば、S3/DynamoDB を介さず録画本体だけを試せる:

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4 \
  --watermark assets/watermark/watermark-60fps.webm
```

720pアップスケール変換だけを試す場合(ffmpeg/ffprobeがあれば動作する):

```bash
python3 -c "from upscale import upscale_to_720p; upscale_to_720p('/tmp/out.mp4', '/tmp/out_720p.mp4')"
```

## ビルド

```bash
docker build -t sattori-worker:latest worker/
```

## フェーズ1の制約と今後

- 対応タイトルは th07 のみ(PoC で E2E 実証済みなのは th07・th08)。
- Spot 中断時のリトライは未実装(フェーズ2で Step Functions により担保)。
- リプレイ内容の解析・デシンク検知は未実装(フェーズ2以降)。
