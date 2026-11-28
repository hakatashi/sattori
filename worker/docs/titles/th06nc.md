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

`g6f.2xlarge`が全リージョンで枯渇したら、CPU描画（BC7展開、`c7i.2xlarge`）の1/2倍速で録る
（[`decisions/0067`](../../../docs/decisions/0067-th06nc-cpu-slow-motion-and-drop-1080p.md)。下の「CPU描画」の節）。
かつての最終段`g6.2xlarge`（touhou-recorder reports/92、`0064`）は外した。

既存9タイトルはすべてXvfb+wined3d+llvmpipe（ソフトウェア描画）で60fpsを達成できるが、
th06ncはこの経路では720pで9.1fps、1080pで5.1fpsしか出ない（touhou-recorder
reports/78 §5）。**GPU（Xorg+NVIDIA GRIDドライバ）+ DXVK（D3D11→Vulkan）の経路が
必須**で、これにより60fps・重複フレーム率0.0〜0.4%を達成している
（reports/79〜81）。ローカル検証環境（AMD Radeon VII）ではプロセス終了時のGPU VM
破棄がdma_fence待ちで恒久的にハングする既知の問題（wined3d/DXVKいずれも発生、
amdgpu固有の可能性が高い）があり、**本番はAWSのNVIDIA GPUインスタンス
（g6f.xlarge）でのみ録画する**方針にした（reports/80・81）。

- インスタンス: `g6f.xlarge`（第一候補、NVIDIA L4の1/8スライス、4vCPU/16GiB）および
  `g6f.2xlarge`（xlarge枯渇対策・1080p推奨、8vCPU/32GiB）。`apps/api/src/ec2.ts`の
  `GPU_CANDIDATE_INSTANCE_TYPES`で管理。
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

## CPU描画（BC7展開。かつては1/2倍速の低速録画、現在はフレーム同期）

GPUワーカー（`GPU_WORKER=1`）以外では、他タイトルと同じXvfb+wined3d+llvmpipeで描画する
（`record_th06nc.py`の`gpu_display=gpu_worker()`）。上の9fpsの主因は描画コール数ではなく、
**BC7圧縮テクスチャをllvmpipeがテクセルごとにソフトウェアデコードすること**だった
（touhou-recorder reports/96 §1）。MODがd3d11のテクスチャ生成・転送をフックし、BC7をロード時に
RGBA8へ展開すると、8スレッドで60fpsに届く。

- MOD: `mods/texture/d3d11_bc7.cpp`（デコーダは`bc7_decode.h`）。`D3D11CreateDevice`系を
  `MyGetProcAddress`で包み、`ID3D11Device`のvtable 5・7と`ID3D11DeviceContext`の14・15・48を
  差し替える。**環境変数`D3D11_DECODE_BC7=1`のときだけ有効**で、GPU描画では元の関数をそのまま返す。
- 環境変数（`record_th06nc.py`がCPUのときだけ渡す）: `D3D11_DECODE_BC7=1`、`LP_NUM_THREADS`
  （使えるvCPU数）、`WINEDLLOVERRIDES="d3d11,dxgi,d3d10core=b"`。プレフィックスのsystem32には
  DXVKを置いてあるので、ビルトイン（wined3d）を明示する。DXVKはXvfb上ではRandRの0Hzで
  `dxgi.dll`がゼロ除算して落ちる（reports/96 §1.1）。
- **実時間の等倍はキャプチャ側で落ちる**。かつては1/2倍速の低速録画（`FPS_LIMIT_TARGET_HZ=30`、QPC偽装で減速）で
  使っていたが、低速録画は廃止した（Issue #391）。現在はフレーム同期の段で使う
  （[`0081`](../../../docs/decisions/0081-frame-sync-plan-for-th20-and-th06nc.md)）。
- 品質（廃止した低速録画での実測）: `c7i.2xlarge`の720p 1/2倍速で、通常ステージはGPU等倍と区別できない（Lunatic全6面で
  落ち1.3%）。**Extraのパチュリー戦の高密度弾幕では描画が実時間約15Hzへ間引かれる**（落ち25〜36%の区間が
  約90秒）。FpsMonitorは入力ポーリング回数を数えているので、この描画落ちを示さない
  （reports/97 §3）。品質判定は配信版のユニークフレームで行うこと。
- 1080pはCPU描画では使わない（GPU描画でも廃止予定）。

## 表示言語（Issue #378、[`decisions/0089`](../../../docs/decisions/0089-th06nc-display-language-via-steam-stub.md)）

th06ncは12言語に対応しているが、**ゲーム内に言語設定は無く、Steamライブラリの「言語」設定で決まる**。
ゲームは起動時に`ISteamApps::GetCurrentGameLanguage()`が返すSteamの言語名（`japanese`・`english`・
`schinese`・`tchinese`・`koreana`・`french`・`german`・`spanish`・`latam`・`russian`・`brazilian`・`italian`）を
読み、スペルカード名・会話・UIの文字列を切り替える。exeには上記の言語名と、対応するロケール名
（`zh-CN`・`es-419`・`pt-BR`など）の文字列が埋め込まれている。

- **Steamworks APIスタブ（`mods/tools/steam_stub.cpp`）が環境変数`STEAM_GAME_LANGUAGE`の値を返す**
  （未設定は従来どおり`japanese`）。スタブはth06cと共用だが、th06cの`record_th06c.py`は渡さないので
  日本語のまま。`record_th06nc.py`が`TH06NC_LANGUAGE`（`apps/api/src/workerEnv.ts`が
  `job.options.th06ncLanguage`から設定する）を検証して`GameConfig.extra_env`の`STEAM_GAME_LANGUAGE`へ渡す。
  Steamの言語名以外は日本語に倒す。
- **英語の言語名は`english`**（exeに文字列は無いが、`GetCurrentGameLanguage()`が`english`を返すと英語表示になる。
  ローカルで実機確認済み）。
- `GetAvailableGameLanguages()`は実Steam同様に全言語をカンマ区切りで返す。
- **スタブを更新したらタイトル資産（`games/th06nc/steam_api64.dll`）の再アップロードが必要**
  （`upload-title-assets` skill）。古いスタブのままだと言語を渡しても日本語で録れる（エラーにはならない）。
- リプレイファイルは言語に依存しないので、言語を変えてもリプレイずれには影響しない
  （同じ`th6_31.rpy`でスコア・理論尺とも日本語と一致、`tests/mod_integration`で確認）。

実機確認の結果（このマシン、CPU描画・フレーム同期）:

| 言語 | 結果 |
|---|---|
| `english` | OK。「Derangement of Scarlet Devil - Sister of Scarlet」、Hi Score/Player/Bomb/Power/Graze/Points |
| `japanese`（新スタブ） | OK。退行なし（再生区間132.9秒、`replay_start_frame=575`） |
| `koreana` | 表示はハングルのタイトルロゴ・メニューで成功。終了位置・スコア・デシンク検知は日本語と同じ。統合テストの「再生区間」だけ+3.8秒でNG（下記） |

**韓国語のNGは言語の問題ではなく、配信版の開始位置の推定誤差**: `find_frame_sync_replay_start_frame()`は
実時間×60Hzでメニュー区間を遡って開始フレームを求めるが、この実行はメニュー区間のfpsが27.5
（英語の実行は38.3）と遅く、推定が約220フレーム（3.7秒）手前にずれた。`unthrottled=1 at frame=805`・
終了位置（142.5秒）は日本語・英語と同一。マシンが遅いとき配信版の頭にメニューが少し余計に入りうる
が、録画内容そのものは正しい。

上記以外の言語（簡体字・繁体字・フランス語など）の文字の描画は個別には確認していない。
`TH06NC_LANGUAGE=<言語名> python3 tests/mod_integration/run.py --game th06nc --keep-output`で
同じ手順で確認できる（ホストの`games/th06nc/steam_api64.dll`を新しいスタブにしておくこと）。

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

なお共通実装の`StartScoreMonitorThread()`（`mods/monitor/score_monitor.cpp`）は
`baseRva`が0（RVA未特定）の場合にスレッド自体を作成しない設計のため、
「RVA未特定時にreturnしてDLL_THREAD_DETACHでローダーロック競合を起こす」という
touhou-recorder側の初期実装が踏んだ地雷は、sattori側の共通実装では最初から
発生しない。th06ncのスコアRVAは特定済みのため、この分岐が問題になることもない。

## メニューカーソル・スコアのRVA

- メニューカーソル位置のRVAは**未特定**。固定3回のDownでフォールバックする
  （かつての環境変数`TH06NC_MENU_DOWNS`は、ワーカーが設定せず既定値しか使われないためIssue #392で削除）（未解放セーブデータでも"Replay"に到達
  することを実機確認済み、reports/78 §10）。
- スコアRVA（ver 1.0.6）: `kScoreRva = 0x0053D3E8`（内部即時値）、`kScoreDisplayRva =
  0x0053D3E0`（画面表示用の追いかけ値）。**th06cとは内部値/表示値の前後関係が逆**
  （reports/79 §6.1）。デシンク判定には内部値側を使う
  （`worker/recording/modlog.py`の`GAME_SCORE_MULTIPLIERS["th06nc"] = 1`、等倍）。
- **スコアRVAはゲームのバージョンごとに変わる**。ver 1.0.6より前は`0x004F2798`/
  `0x004F2790`で、ver 1.0.6でexeが再ビルドされ`.data`セクションごと移動した
  （[`docs/reports/2026-09-28-th06nc-v1.0.6-update-verification.md`](../../../docs/reports/2026-09-28-th06nc-v1.0.6-update-verification.md)）。
  ゲーム更新時は`verify-game-update` skillで必ず再確認すること。
- ステージ番号・残機・グレイズのRVAは未特定。

## 自宅ワーカーはスコープ外

- 自宅ワーカーには常にオファーしない。CPU描画は自宅の環境では本番相当の検証をしていない（`apps/api/src/workerRouting.ts`の
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
重複フレーム率が7.9%まで増える——だが、当時のeu-south-2のG系スポットクォータが
8vCPU（g6f.xlarge換算で2台分の並列運用余地）だったことを踏まえ、**1080pも
g6f.xlargeで起動しうる**ままにするとユーザー判断で決定した（`decisions/0046`）。
クォータは2026-09に32vCPUへ引き上げられたため、1080pをg6f.2xlargeに固定する
見直しをIssue #286で検討している。1080p録画で処理落ちが疑われる場合はこの制約を
踏まえて調査すること。

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
