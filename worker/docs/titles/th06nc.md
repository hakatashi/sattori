# th06nc（東方紅魔郷: New Classic）対応の技術的背景（Issue #241、touhou-recorder reports/78〜81）

GPU EC2導入・カスタムAMI固定方式の根拠は
[`decisions/0046`](../../../docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md)。
自宅ワーカーへオファーしない理由は
[`decisions/0047`](../../../docs/decisions/0047-no-gpu-titles-for-home-worker.md)。
GPU系専用ECRリポジトリを新設した理由は
[`decisions/0048`](../../../docs/decisions/0048-separate-ecr-repo-for-gpu-workers.md)。

2026-09-10発売の「東方紅魔郷: New Classic」（以下th06nc）はth06cと同じDXライブラリ系
エンジンの64bitバイナリ（PE32+）で、Steamworks APIスタブ・GetProcAddressフックによる
入力注入といった基本構造はth06cからそのまま流用できる。**th06cとの決定的な違いは
GPU描画が必須であること**——`GameConfig`・MODを触る前に必ずここを読むこと。
th06とはリプレイ形式のバージョンが非互換なため、**th06として受け付けてはならない**
（`packages/shared/src/games.ts`で別`GameId`として管理済み、`docs/known-limitations.md`参照）。

## GPU描画が必須（既存9タイトルとの最大の違い）

既存9タイトルはすべてXvfb+wined3d+llvmpipe（ソフトウェア描画）で60fpsを達成できるが、
th06ncはこの経路では720pで9.1fps、1080pで5.1fpsしか出ない（touhou-recorder
reports/78 §5）。**GPU（Xorg+NVIDIA GRIDドライバ）+ DXVK（D3D11→Vulkan）の経路が
必須**で、これにより60fps・重複フレーム率0.0〜0.4%を達成している
（reports/79〜81）。ローカル検証環境（AMD Radeon VII）ではプロセス終了時のGPU VM
破棄がdma_fence待ちで恒久的にハングする既知の問題（wined3d/DXVKいずれも発生、
amdgpu固有の可能性が高い）があり、**本番はAWSのNVIDIA GPUインスタンス
（g6f.xlarge）でのみ録画する**方針にした（reports/80・81）。

- インスタンス: `g6f.xlarge`（NVIDIA L4の1/8スライス、4vCPU/16GiB）固定。720p/1080p
  どちらもこの1タイプで録画する（`apps/api/src/ec2.ts`の`GPU_CANDIDATE_INSTANCE_TYPES`）。
- ワーカーイメージ: 別Dockerfile（`worker/Dockerfile.gpu`）・別ECRリポジトリ
  （`sattori-worker-gpu`）。既存の共通イメージ（CPU系9タイトル）とは分離してある。
- ヘッドレス画面: `recording/gpu_display.py`（Xorg+nvidia、`GameConfig.gpu_display=True`）。
  headless weston + Xwayland構成はNVIDIA上でクライアントのOpenGLがllvmpipeへ
  フォールバックしてしまい使えなかった（reports/81 §4）。
- DXVK: `GameConfig.dxvk_dll_overrides="d3d11,dxgi,d3d10core=n"`を`WINEDLLOVERRIDES`
  として渡す。wined3d（D3D11→OpenGL）よりDXVKの方が重複フレーム率で一貫して優位
  だった（reports/79〜81）。DXVKのDLL自体（d3d11.dll/dxgi.dll）はWINEPREFIX側
  （タイトル資産、S3経由）に事前配置する。wineビルトインは退避しておくこと
  （`WINEDLLOVERRIDES`を付けない限りwineは既定でビルトインを優先するため）。
- **【重要・実機未検証】GPU用カスタムAMIとworker-gpuイメージのバージョン同期**:
  NVIDIA GRIDドライバのユーザースペースライブラリ（Xorgのnvidia_drv.so等）は
  AMI側に導入し、`docker run --gpus all`（nvidia-container-toolkit）経由でコンテナへ
  マウントする想定。AMIのドライババージョンとコンテナが期待するバージョンが
  食い違うとXorg/DXVKが起動しない可能性が高い。AMI更新時は必ずworker-gpuイメージの
  動作確認をセットで行うこと（`build-gpu-worker-ami` skill）。

## 起動時ダイアログは無い（th06cとの違い）

th06cは起動のたびに「解像度を選択してください」モーダルダイアログを出すが、th06ncには
このダイアログが無い（実行ファイルに「ゲーム起動」「VSync」等の文字列が存在しない、
reports/78 §4）。`th06.env`（12バイト）のbyte[5]の値で直接ウィンドウ解像度が決まる:

| byte[5] | ウィンドウ |
|---|---|
| 4 | 1280x720（720p） |
| 3または0 | 1920x1080（1080p） |
| 上記以外 | 画面いっぱい（意図しない値） |

**`th06.env`はゲーム終了時に書き戻されるため、起動のたびに正しい解像度の内容へ
上書きする必要がある**（reports/78 §11.2）。sattoriでは`GameConfig.
extra_instance_files`（720p/1080pそれぞれのタイトル資産内`th06.env.{720p,1080p}`を
`instance_dir/th06.env`へ上書きコピーする、`record_th06nc.py`の`build_config()`が
`TH06NC_RESOLUTION`環境変数から選択する）で解決している。MOD側の
`DismissStartupDialog()`相当の処理は不要で、代わりに「ダイアログが復活していないか」
を1秒だけ監視する`WarnIfStartupDialogPresent()`のみ行う。

## 1080pオプション時のCRTCモード切り替え

Xorg+nvidia環境では「仮想画面サイズ（Xの`Screen`セクション）」と「CRTCの実モード」が
別概念で、th06ncは**CRTCの実モード**を見てウィンドウ解像度の選択肢を決める
（reports/81 §9.9.1）。仮想画面は720p/1080pどちらのウィンドウも収まる大きさ
（`2200x1400`）のまま、CRTCモードだけを`GameConfig.crtc_mode`（1080p選択時のみ
`"1920x1080"`）で`xrandr --output <出力名> --mode`により明示的に切り替える
（`recording/gpu_display.py`）。720p選択時はCRTCモードの変更は不要
（Xorgの既定モードのままで1280x720が選べることを実機確認済み）。

## ローダーロックの地雷（MOD側、最重要）

DllMainから生やしたスレッド（`AutoPlayThread`）が、ゲーム本体の初期化完了前に
USER32のウィンドウ列挙API（`EnumWindows`等）を呼ぶとローダーロックのデッドロックを
起こす（reports/78 §10.1で実機確認）。th06ncのゲーム本体は起動直後、ローダーロックを
保持したまま winmm/xinput 等のDLLを順に読み込むため、この最中に別スレッドから
`EnumWindows`を呼ぶと「`EnumWindows`側がwinex11.drv等のロードでローダーロックを待つ」
×「ゲーム本体側がUSER32側のロックを待つ」のロック反転が起きる。

**対策**: ゲーム本体の初期化完了は入力ポーリング（`GetKeyboardState`）の開始で判定
できる（メモリ上のカウンタを読むだけでロックを取らない）。`AutoPlayThread`は
**ウィンドウ関連のUSER32呼び出し（`WarnIfStartupDialogPresent`・
`WaitForStableWindow`）を、入力ポーリング開始を検出するまで一切行わない**
（`mods/th06nc_replay_autoplay/dllmain.cpp`）。th06cではこの問題が顕在化しなかった
理由は、起動ダイアログのメッセージループが早期に回るため`DismissStartupDialog()`の
`EnumWindows`が安全な時点で走っていたためと見られる。

なお共通実装の`StartScoreMonitorThread()`（`mods/common/score_monitor.cpp`）は
`baseRva`が0（RVA未特定）の場合にスレッド自体を作成しない設計のため、
「RVA未特定時にreturnしてDLL_THREAD_DETACHでローダーロック競合を起こす」という
touhou-recorder側の初期実装が踏んだ地雷は、sattori側の共通実装では最初から
発生しない。th06ncのスコアRVAは特定済みのため、この分岐が問題になることもない。

## メニューカーソル・スコアのRVA

- メニューカーソル位置のRVAは**未特定**。環境変数`TH06NC_MENU_DOWNS`（既定3回）に
  よる固定回数のDownでフォールバックする（未解放セーブデータでも"Replay"に到達
  することを実機確認済み、reports/78 §10）。
- スコアRVA: `kScoreRva = 0x004F2798`（内部即時値）、`kScoreDisplayRva = 0x004F2790`
  （画面表示用の追いかけ値）。**th06cとは内部値/表示値の前後関係が逆**
  （reports/79 §6.1）。デシンク判定には内部値側を使う
  （`worker/recording/modlog.py`の`GAME_SCORE_MULTIPLIERS["th06nc"] = 1`、等倍）。
- ステージ番号・残機・グレイズのRVAは未特定。

## 低速録画・自宅ワーカーはスコープ外

- 低速録画（Issue #68）はth06ncでは提供しない。D3D11経路のフレームレート制限フック
  （`fps_limiter_hook.h`はD3D9専用、`fps_limiter_hook_d3d8.h`はD3D8専用）が
  いずれも使えず新規実装が必要なため、th06cと同じ扱いでスコープ外にした
  （`SLOW_MOTION_SUPPORTED_GAME_IDS`に含めないだけで自動的に塞がれる）。
- 自宅ワーカー（GPU非搭載）には常にオファーしない（`apps/api/src/workerRouting.ts`の
  `GAME_ROUTING_POLICIES.th06nc.offerToHomeWorker = false`、`decisions/0047`）。

## GPU実行時のx11grabキャプチャ競合（`poll_side_stream`）

終了検知・進捗スクショ用の定期ポーリング（`vision.grab_frame()`）は毎回新規の
ffmpegプロセスを起動して同じXサーバーから画面をキャプチャするが、GPU実行かつ
高解像度（720p/1080p）の環境では、これが本番録画用のx11grabキャプチャと定期的に
競合し、周期的なコマ落ちを引き起こすことが判明した（touhou-recorder reports/81 §9、
2.32秒周期＝ポーリング間隔2.0秒+ポーリング所要時間0.32秒に一致する強い周期性で確認）。
既存9タイトル（CPU専用インスタンス・640x480程度の解像度）では実害が確認されて
いないため、この対処は`GameConfig.poll_side_stream=True`でth06nc限定にしてある。

対策: 録画用ffmpegの`-filter_complex`に`split`を入れ、本番録画用の出力とは別に
8fpsの静止画連番出力（`-f image2 -update 1 -flush_packets 1`で同一ファイルへ
継続上書き）を追加する。終了検知・進捗スクショはこのサブストリームを読むだけにし、
X11キャプチャを1本に統一する（`recording/ffmpeg.py`の`build_video_ffmpeg_cmd()`、
`recording/vision.py`の`read_side_stream_frame()`）。読み側は`os.path.getmtime()`で
ファイルが実際に更新されたことを確認してから読む（`-flush_packets 1`だけでは
書き込みタイミングが保証されず、同一フレームを2回掴んで画面静止と誤判定する
リスクがあるため）。

## 1080p録画オプションの品質トレードオフ

th06ncは720p/1080pをユーザーが選べる（Issue #241、`packages/shared/src/
highResolutionRecording.ts`）。reports/81 §9.9.3の実測では、1080p録画は本来
g6f.2xlarge（8vCPU）が推奨——g6f.xlarge（4vCPU）では実効fpsが54.87まで悪化し、
重複フレーム率が7.9%まで増える——だが、eu-south-2のG系スポットクォータが
現状8vCPU（g6f.xlarge換算で2台分の並列運用余地）であることを踏まえ、**1080pも
g6f.xlargeのまま提供する**とユーザー判断で決定した（`decisions/0046`）。
1080p録画で処理落ちが疑われる場合はこの制約を踏まえて調査すること。

## 既知の残課題

- **【最重要】本番相当のE2E録画検証（720p/1080pのフル尺録画）はまだ完了していない**
  （2026-09-12時点）。GPU用カスタムAMI構築・CDKデプロイ・タイトル資産アップロードは
  完了し、ローカル（GPU無し）でのMOD機能検証（ローダーロック回避・メニュー操作
  シーケンス完走・スコア監視）も成功しているが、**eu-south-2のg6f.xlargeスポット
  在庫が長時間枯渇しており、実際の録画ジョブ2本（720p/1080p）が10回のリトライ
  すべてでEC2インスタンス起動に失敗した**（`docs/reports/2026-09-12-th06nc-
  recording-verification.md`）。sattori側の実装の不具合ではなくAWS側の在庫状況に
  よるもの。在庫回復後に必ず再検証し、本レポートまたは新しいレポートで結果を残すこと。
- **GPU用カスタムAMIとNVIDIA `nouveau`ドライバの競合**（新知見、2026-09-12）:
  素のUbuntu 24.04 AMIではOSSの`nouveau`ドライバが先にGPU（vGPU）を掴んでおり、
  `nvidia`ドライバがデバイスへアタッチできず`nvidia-smi`が`No devices were
  found`を返す。`/etc/modprobe.d/blacklist-nouveau.conf`で`nouveau`をブラック
  リストし再起動することで解決する（`build-gpu-worker-ami` skillに手順追記済み）。
- **初回起動時のwineserverコールドスタート**: 新規EC2インスタンスでは1本目の
  録画がwineserverの初回起動遅延で失敗しやすい（reports/81 §10.1）。タイトル資産
  （WINEPREFIX）はS3から実行時ダウンロードする既存方式のため、AMI側にウォームアップ
  済みの状態を焼き込むのは困難。現状は`max_attempts`のリトライに委ねている。
- ステージ番号・残機・グレイズのRVA、メニューカーソル位置のRVAは未特定のまま。
- `worker/recording/pipeline.py`の`_record_with_retry()`が重複フレーム率計測不能
  （`None`）を異常として扱っていない問題（`docs/known-limitations.md`参照）は
  th06nc対応と合わせて修正していない。実機観測後に必要性を判断する。
