# フェーズ25: th07/th08の同一パイプライン比較によるAWS重複フレーム問題の切り分け

日付: 2026-07-22

## 目的

フェーズ24で、AWS EC2(`c7i.xlarge`/`c7i.2xlarge`)上でth08(ver1.00d)の重複フレーム率が90%超になる問題を調査し、「vCPU数・ポーリング間隔・Dockerコンテナ化のいずれも原因ではなく、AWS EC2の実行環境(仮想化オーバーヘッド)そのものに起因する可能性が高い」と結論づけた。

しかし、th07は同一条件(`c7i.xlarge`)のAWS環境で重複フレーム率4.7%(フェーズ17)と良好であり、ユーザーから「th07とth08でそこまで大きな差が生まれるのは不可解」との指摘があった。そこで、**現行th08パイプライン(`scripts/23_record_th08_ver100d_replay_e2e.py`)の構成を可能な限り変えずに、録画対象だけをth07に差し替えて同一環境で録画する**ことで、「AWS環境自体が原因」というフェーズ24の結論を再検証した。

## 作成した成果物

`scripts/23`をベースに、対象ゲームを`--game {th07,th08}`で切り替えられるよう一般化した`scripts/25_record_replay_e2e_multigame.py`を新規作成した。検知ロジック(fps暴走検知・処理落ち早期検知・画面静止検知・リトライ・zombie PID対策)は`scripts/23`と完全に同一で、ゲームごとの差分(`WINEPREFIX`・`GAME_DIR_SRC`・`GAME_EXE`・`HOOK_DLL`・`DISPLAY`・`INSTANCE_DIR`・既定リプレイファイル)のみを設定辞書(`GAME_CONFIGS`)で切り替える構造にした。th07の`mods/th07_replay_autoplay`にはFpsMonitorログ出力が無いため、fps暴走検知はth07では常に反応しない(無害)。

th07・th08両方のゲームデータ・WINEPREFIX・MOD DLLを1つのDockerイメージに含める`cloud/docker/aws/Dockerfile.multigame`、および`GAME`環境変数で対象を切り替える`cloud/docker/aws/entrypoint_multigame.py`も作成した。

ローカルのDocker上で`--game th07`のスモークテスト(60秒で打ち切り)を行い、ウィンドウ検出・メニュー自動操作・録画開始までth08と同様に正常動作することを確認してからAWSへデプロイした。

## 検証結果

AWS EC2 `c7i.xlarge`(Spot、us-east-1a)上で、`scripts/25`(`--game th07`)により`th7_07.rpy`(約14.2分)を録画した。

| 項目 | 結果 |
|---|---|
| インスタンス | EC2 Spot `c7i.xlarge`(4vCPU)、us-east-1a |
| 試行回数 | 1回目で正常完了(リトライなし) |
| 総録画時間 | 851.3秒(想定と整合) |
| 重複フレーム率(録画開始15秒以降) | **0.8%** |
| 重複フレーム率(0-60s) | 5.9% |
| 重複フレーム率(200-260s) | 9.4% |
| 重複フレーム率(400-460s、ボス戦) | 9.8% |
| 重複フレーム率(600-660s) | 15.1% |
| 重複フレーム率(800-840s、結果画面遷移) | 51.7%(既知の許容範囲、フェーズ22/23参照) |
| 映像 | 640x480, 60fps, h264(ffprobeで確認、51060フレーム) |

フェーズ17の`c7i.xlarge`実測値(重複フレーム率4.7%)とほぼ同水準の結果が、**th08と全く同じDockerイメージ構造・全く同じ検知/リトライスクリプト・全く同じAWSインスタンス上で**再現した。目視確認(`reports/assets/th07_aws_multigame_frame_400s.png`)でも、ボス戦(八雲藍、「ミルキーウェイ」)を含め、HUD・スコア・日本語フォントとも正しく描画されており、`59.92fps`という内部fps表示も正常だった。

## 結論: フェーズ24の結論の訂正

**フェーズ24で「AWS EC2の実行環境そのもの(仮想化オーバーヘッド)が原因」と結論づけたのは誤りだった。** 同一のAWSインスタンスタイプ・同一のDockerコンテナ構造・同一のスクリプトアーキテクチャ(録画開始タイミング・ポーリング方式・リトライロジック)であっても、**th07は正常(0.8%)・th08は異常(90%超)という結果がくっきり分かれた**。これにより、問題はAWS環境一般ではなく、**th08というゲームタイトル(またはth08用MOD・th08のwined3d/D3D9利用パターン)に固有の何か**に起因することがほぼ確定した。

th07とth08の描画関連の違いとして考えられる候補(未検証):

- th07とth08で使用しているDirect3Dのバージョン・API呼び出しパターンの違い(AGENTS.mdには「th08はD3D9」との記載があるが、th07も同じくwined3d経由と見られ、具体的な差分は未調査)
- th08自体の内部フレームペーシング機構(フェーズ23で扱ったvsync関連の挙動)が、th07とは異なる形でAWSの仮想化タイマー特性と相互作用している可能性
- 単純にth08の方が1フレームあたりの描画負荷(ポリゴン数・エフェクト数)が高く、それがwined3d→llvmpipe→X11の経路のどこかでth07よりも顕著にレイテンシの影響を受けやすい設計になっている可能性
- (下記「追加検証」で否定済み: MOD側の`mods/common/`変更・`GetDeviceState`フック頻度自体が原因という説)

## 追加検証: 直近のmods/common変更が原因である可能性の検証

ユーザーから「直近th08向けに`fps_monitor.cpp`等を`mods/common/`に追加した変更が、実は原因ではないか。th07側のDLLはその変更以降にビルドされたものを使っているか」という重要な指摘があった。

### 発覚した事実: th07_hook.dllは大幅に古いビルドだった

ファイルタイムスタンプとgit logを突き合わせたところ、以下が判明した。

- `mods/th07_replay_autoplay/build/th07_hook.dll`(本フェーズの前半で使用したもの)は**2026-07-15 06:00ビルド**
- このビルドは、同日06:07:50の`bab8847`(th08向けMOD移植+`dinput_hook.cpp`の`PressKey`をミリ秒基準からフレーム数基準に変更するバグ修正)より**前**のもの
- `mods/th08_replay_autoplay/build/th08_hook.dll`は**2026-07-21ビルド**で、`bab8847`・`b7a3fa8`(`fps_monitor.cpp`追加)を含む最新の`mods/common/`を反映している

つまり、本フェーズ前半の比較は「同一の共有コード、対象ゲームのみ違う」比較ではなく、**「2026-07-15時点の古い共有コードで動くth07」対「2026-07-21時点の最新共有コードで動くth08」の比較になっていた**。`dinput_hook.cpp`の`PressKey`が導入した`WaitFrames`関数は、`g_hookCallCount`を1msごとにポーリングするビジーループであり、これがメニュー自動操作中(=録画開始直後の、report12/13で「非常にデリケート」とされるffmpegの初期同期期間と重なる)に動作するため、AWS環境固有の重複フレーム問題の原因である可能性が疑われた。

### 検証: th07_hook.dllを現行のmods/common(WaitFrames含む)で再ビルドして再テスト

`mods/th07_replay_autoplay/dllmain.cpp`は`PressKey(dik)`を引数なしで呼んでおり、`dinput_hook.h`のデフォルト値変更(ミリ秒→フレーム数)をソース変更なしにそのまま引き継ぐ構造だったため、mingw-w64(`i686-w64-mingw32-g++`、`AGENTS.md`記載の通り事前許可済み)で現行の`mods/common/`一式と一緒に再ビルドするだけで、th08と同じ`WaitFrames`機構を含む`th07_hook.dll`を作成できた。

```
i686-w64-mingw32-g++ -shared -O2 -o th07_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

ローカルでのスモークテスト(正常にメニュー自動操作・リプレイ開始まで完了)を確認後、この再ビルド版th07_hook.dllを含むDockerイメージでAWS `c7i.xlarge`にて`th7_07.rpy`を録画した。

| 項目 | 結果 |
|---|---|
| 総録画時間 | 851.8秒(想定通り) |
| 重複フレーム率(15秒以降) | **0.5%** |
| 重複フレーム率(0-60s / 400-460s / 800-840s) | 5.7% / 8.9% / 45.8%(前回とほぼ同水準) |

**結果は前回(古いth07_hook.dll)とほぼ変わらず、良好だった。** これにより、`mods/common/`への直近の変更(`fps_monitor.cpp`追加、`dinput_hook.cpp`のフレーム数基準化による`WaitFrames`ビジーループの導入)は、AWS上のth08重複フレーム問題の原因では**ない**ことが確定した。

再ビルドしたth07_hook.dllは、`bab8847`のfps依存誤操作バグ修正を含む最新のコードのため、`mods/th07_replay_autoplay/build/th07_hook.dll`として引き続き使用する(2026-07-15時点の古いビルドより望ましいため)。

## 今後の課題

- th07・th08それぞれの`Present`/`SwapBuffers`呼び出し頻度や、D3Dデバイスの初期化パラメータ(バックバッファ数、スワップエフェクト等)の比較調査
- フェーズ24で発見した「AWS上ではffmpegの`dup`カウンタが直接示すように画面更新自体が60Hzに達していない」という現象が、th08固有のどのAPI呼び出し・タイミングに起因するのかの特定(`strace`でth07・th08両方のwined3dスレッドのシステムコールパターンを比較するのが次の一手になりうる)
- 本フェーズはth07側の1回の録画のみで検証しており(コスト最小化のため)、複数回の再現性確認は行っていない

## 作成した成果物

- `scripts/25_record_replay_e2e_multigame.py`: th07/th08共通の録画スクリプト(`--game`フラグで切り替え)
- `cloud/docker/aws/Dockerfile.multigame`, `cloud/docker/aws/entrypoint_multigame.py`: th07/th08両対応のAWSワーカーイメージ
- `reports/assets/th07_aws_multigame_frame_400s.png`: 本検証で録画した動画からの抽出フレーム(目視確認用)

## クリーンアップ

検証終了後、本フェーズで作成したAWSリソース(EC2インスタンス、S3・CloudFront・IAM・SG、ECRイメージ)は削除済み。
