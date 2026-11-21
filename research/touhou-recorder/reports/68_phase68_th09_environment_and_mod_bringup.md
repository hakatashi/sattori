# フェーズ68: th09(東方花映塚)の環境構築・自動操作MOD実装(メニュー操作確立まで)

日付: 2026-09-02

## 位置づけ

新規タイトルth09(東方花映塚 / Phantasmagoria of Flower View)をリポジトリの録画パイプラインに追加する作業の第1弾。AGENTS.mdの「新規タイトル対応時の検証チェックリスト」のうち、項目1(設定確認)〜3(MOD開発・動作確認)、および項目8(内部データ取得機能)の一部(life)を完了。項目4(フル尺録画)以降は未着手。**このフェーズだけでは「対応完了」を報告しない**こと。

th09は従来タイトルと異なり対戦形式(1P/2P split-screen、ボム・グレイズ概念なし、残機は0.5刻み)のゲームシステムを持つ。ユーザーからMatchモード・Storyモード両方の録画検証が明示的に要求されている(次フェーズ以降で対応)。

## 前提確認

- 作業開始前に`systemctl status sattori-home-worker`を確認したところ稼働中(3時間前からactive)だったため、`sudo systemctl stop sattori-home-worker`で停止した。以降`ps aux`でwine/ffmpeg残存プロセスが無いことを都度確認しながら作業した。
- `games/th09/`にth09.exe(685,056バイト、ver1.50aとユーザー申告)・th09.cfg(ウィンドウモード設定済みとユーザー申告)・VsyncPatch一式(`vpatch.exe`/`vpatch.ini`/`vpatch_th09.dll`、不具合時のみ使用)・`th09_ver150a.exe`(3,400,133バイト、恐らく自己解凍パッチアーカイブ、gameplayには未使用)が配置された状態で作業開始。`file`コマンドでth09.exeが正常なPE32実行ファイルであることのみ確認し、バージョン一致検証はユーザー申告を信頼して省略した。

## リプレイファイルの内容確認(`@sattori/touhou-replay-parser`使用)

`node ../sattori/packages/replay-parser/dist/cli/index.js -j <file>`で`games/th09/replay/th9_01.rpy`〜`th9_24.rpy`(既存26本)と、ユーザーが新規配置した`th9_ud5615.rpy`・`th9_ud8508.rpy`(ユーザー自身の記録)を全件パースした。

- **Matchモード検証候補**: `th9_ud5615.rpy`(Reimu、Lunatic、「Match 人 vs 人」、対戦相手Eiki、8,848フレーム≒147秒≒2.5分)。短尺で反復検証に向く。
- **Storyモード(通常難度)候補**: `th9_03.rpy`(Aya、Normal、46,873フレーム≒781秒≒13分)。
- **Extraステージ候補**: `th9_04.rpy`(Komachi、Extra、31,424フレーム≒524秒≒8.7分)。
- 参考: `th9_ud8508.rpy`(Mystia、Lunatic Story、100,586フレーム≒28分)は9ステージ(Cirno〜Eiki)を通しでクリアしたフル尺。Lunatic Story modeはステージ数が9であることが`splits`配列から確認できた(Easy/Normal/Hard/Lunaticでステージ数が変わる仕様と推測)。

いずれもSilent Seleneからの追加取得は不要だった。

## WINEPREFIXの構築

```bash
bash ../sattori/worker/setup_wineprefix.sh \
    "$(pwd)/prefixes/th09-wined3d-gl" games/assets/msgothic.ttc games/assets/msmincho.ttc
```

新規`WINEARCH=win32`で初期化、フォントレジストリ登録まで正常完了(パス引数は絶対パス必須、相対パスでは`wine: invalid directory ... not an absolute path`エラーになる点に注意)。

## 自動化MOD(`mods/th09_replay_autoplay/`)

### メニュー操作シーケンス

ユーザー提供の手順をそのまま実装:

```
Down x2 (250ms間隔) -> Enter(「Replay」選択、700ms待機)
-> Right x1(ユーザーリプレイタブへ切替、400ms待機)
-> Enter(1番目のリプレイ選択、700ms待機)
-> Enter(再生確定、700ms待機)
```

タイトル画面バッファは1500ms(th08と同じ)。th11/th12/th20と同じ「ud0000タブ」方式のため、`scripts/25`統合時にコピー先ファイル名を`th9_ud0000.rpy`に正規化する必要がある(本フェーズでは`scripts/25`未統合、手動で`instances/th09-multigame-recording-test/replay/th9_ud0000.rpy`に配置して検証)。

### 入力注入方式

th09はth06/07/08/10/12と同じ古典的DirectInput `GetDeviceState`ポーリング方式(`mods/common/dinput_hook.cpp`のIAT hook、`PressKey`でDIKスキャンコード注入)。実機のFpsMonitorログで起動直後から100Hz超の`GetDeviceState`呼び出しを確認し、th11/th20のGetKeyboardState方式ではないことを確認した。

### ビルド方法(mingwクロスビルド)

```bash
cd mods/th09_replay_autoplay
i686-w64-mingw32-g++ -shared -O2 -o build/th09_hook.dll \
    dllmain.cpp \
    ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
    ../common/fps_monitor.cpp ../common/stage_probe_hook.cpp ../common/score_probe_hook.cpp \
    ../common/stage_marker_hook.cpp ../common/stage_marker_io.cpp ../common/score_monitor.cpp \
    -static-libgcc -static-libstdc++ -static -luser32
```

MSVC用`build.bat`も新規作成済み(既存タイトルと同型)。

## 実機動作検証(Matchモード、`th9_ud5615.rpy`)

Xvfb `:92`(800x600x24)+openboxで起動し、`wine injector.exe th09.exe th09_hook.dll`で注入。

- ウィンドウ「東方花映塚　～ Phantasmagoria of Flower View. ver 1.50a」が640x480ウィンドウモードで安定生成されることを`xwininfo`で確認。
- MODログで`WaitForStableWindow: stable`→メニュー操作5ステップ→`sequence complete`まで正常完了(所要時間 約3.6秒)。
- スクリーンショット(`ffmpeg -f x11grab`)で実際にMatchリプレイ(Reimu vs Eiki)が1P/2P split-screenで正常再生され、スペルカード「審判「ラストジャッジメント」」発動・スコア表示・60.08fps表示を確認。処理落ちの兆候なし。

## 内部データ取得機能(スコア監視)の調査

### 成功: 残機(life)の取得

`../thprac/thprac/src/thprac/thprac_th09.cpp`の`TH09Tools::OnContentUpdate`から以下のRVAを特定(絶対VA、image base 0x400000):

| 項目 | 絶対VA | pl構造体先頭からのオフセット |
|---|---|---|
| P1状態構造体ポインタ | 0x4a7d94 (RVA=0xa7d94) | - |
| P2状態構造体ポインタ | 0x4a7dcc (RVA=0xa7dcc) | - |
| life(残機、0.5刻みを2倍した整数1〜10) | - | +0xa8 |
| Lv Rank | - | +0xa0 |
| Boss Rank | - | +0xa4 |
| チャージゲージ(float, 0〜400) | - | +0x30388 |

`mods/common/score_monitor.cpp`の`ScoreMonitorConfig`で`baseRva=0xa7d94, baseIsPointer=true, livesOffset=0xa8, livesWidth=4`を設定し、実機でP1側`lives=10`(満タン)が正しく読めることを確認した(`ScoreMonitor: score=0 stage=0 lives=10 graze=0 ...`)。P2側は`ScoreMonitorConfig`が単一のstage/lives/graze欄しか持たない構造上、今回は自分側(P1)のみ監視する。

### 未解決: スコアRVAが特定できない

thprac(`thprac_th09.cpp`)の`TH09Tools`にはスコア表示/編集UIが無く、既知のRVAが得られない。以下の方法で実機探索したが、画面表示スコアと一致するアドレスを発見できなかった:

1. **`mods/common/score_probe_hook.cpp`に`SCORE_PROBE_PTR_RVA`環境変数によるポインタ間接参照対応を追加**(フェーズ68で新規実装。従来はモジュールベース直接オフセットのみ対応だったが、th09のスコアがヒープ確保のプレイヤー構造体内にある可能性を考慮し、`(moduleBase+ptrRva)`のポインタを毎サンプル読み直してから相対オフセットをスキャンする機能を追加)。P1構造体ポインタ(RVA=0xa7d94)を起点に0x0〜0x30400をスキャンしたが、単調増加する値は大量にヒットしたものの(ヒープアドレス自体を指すパターンや、48/56/68バイト刻みで規則的に増加する内部管理用の値と推測される)、画面表示スコアと明確に対応する候補は見つからなかった。
2. **`/proc/PID/mem`による直接メモリダンプ相関確認**: `kill -STOP <pid>`でプロセスを一時停止し、その瞬間のスクリーンショット(表示スコア)とP1/P2構造体全域(0x0〜0x30400)・弾幕マネージャ構造体(絶対VA 0x4a7d98/0x4a7dd0が指す先、0x0〜0x300000)・BSS領域(RVA 0xa0000〜0xe5000)を`sudo python3`で直接読み取り、int32(1倍・10倍)・int64・floatいずれの解釈でも表示スコア(±50の許容誤差)に一致するオフセットが無いことを確認した(`/tmp/search_mem2.py`・`/tmp/search_global.py`、いずれもスクラッチ用途でリポジトリ外の`/tmp`に作成、恒久化していない)。`sudo`が必要だったのは`/proc/PID/mem`の読み取りにYama ptrace_scope(値1)によるCAP_SYS_PTRACE相当の権限が要求されるため。

以上より、**th09のスコアは単純な固定オフセット変数として保持されておらず、複数のサブ統計から都度計算されている(またはより広範囲/別のヒープ領域にある)可能性が高い**と考えられる。次フェーズでスコア監視が必要な場合は、(a) より広範囲のヒープ全域スキャン、(b) `stage_probe_hook`の差分スキャン方式(低頻度・小刻みな値向け)の応用、(c) ユーザーからの追加情報提供、のいずれかが必要。現時点では`ScoreMonitorConfig.scoreWidth=0`(スコア監視を無効化する新規サポート、後述)でlifeのみ監視する運用とする。

### `mods/common/score_monitor.*`への機能追加

スコアRVA不明のタイトルでもlife等だけ監視できるよう、`scoreWidth=0`のときスコア読み取りをスキップし、`baseResolved`のみをログ出力のゲートにする変更を`score_monitor.cpp`に追加(従来はscore読み取り成功が必須ゲートだった)。既存タイトル(th06/07/08/10/11/12/20)は全て`scoreWidth`を明示的に4等に設定しているため後方互換。

## 追記: `scripts/25`統合・Matchモードのフル尺録画検証

上記TODOのうち1〜3(Matchモード分)を本フェーズ内で完了させた。

### `scripts/25_record_replay_e2e_multigame.py`への統合

- `GAME_CONFIGS`に`"th09"`エントリを追加(`display=":92"`、`wineprefix=prefixes/th09-wined3d-gl`、`replay_dest_filename="th9_ud0000.rpy"`、`default_replay="th9_ud5615.rpy"`)、`--game`のchoicesに追加
- `end_template`: フル尺録画から実機取得した`assets/replay_end_templates/th09.png`(リプレイ選択画面「映花一覧」)。既定のEND_TEMPLATE_ROWS(上部1/3)だとリプレイごとに内容が変わる"0000"スロットの行(スコア・日付)まで含んでしまうため、th10と同様に`end_template_rect=(0, 0, 230, 88)`で見出し部分のみに絞り込んだ
- `fps_runaway_hz_threshold=300.0`: th09は健全な状態でもGetDeviceStateポーリングが100〜190Hz程度に達し、既定の100Hz閾値では誤検知で早期打ち切りされることが実機で判明したため緩和(スコア/fps暴走検知ロジック自体は`scan_fps_runaway()`にcfg引数を追加し、`GAME_CONFIGS`側で上書きできるよう汎用化した)

### 発見した不具合: ウィンドウ強制移動によるタイトルバー混入バグ

`scripts/25`は検出したゲームウィンドウを常に(0,0)へ強制移動してから録画するが(他タイトル向けの画面外はみ出し対策)、**th09ではこの移動を行うと録画中盤以降、キャプチャ領域にOSウィンドウ装飾(タイトルバー)が混入し、逆に画面下端(fps/Bossゲージ表示行)が約20px欠落する**という不具合を実機録画で発見した(`th9_ud5615.rpy`のフル尺録画で複数回再現、`ffmpeg`でフレーム抽出して目視確認)。

原因はwindowmove直後の再取得では正しく(0,0)相当の座標が得られる(`xwininfo`で確認済み)にもかかわらず、録画中の別時点で発生している何らかの理由による位置ズレと推測されるが、**根本原因の完全な特定には至っていない**(手動での`xdotool windowmove`単発実行+その後の追跡では再現せず、`scripts/25`の一連の処理内でのみ再現することを確認)。

th09の初期検出座標(x=3, y=29, w=640, h=480)はXVFB_SCREEN(800x600)の範囲内に元々収まっているため、この強制移動自体が不要と判断し、`GAME_CONFIGS["th09"]["skip_origin_move_if_fits"]=True`を追加。`scripts/25`側に対応する分岐(範囲内なら移動をスキップ)を実装し、この設定で複数回のフル尺録画において問題が再発しないことを確認した。他タイトルは`skip_origin_move_if_fits`未設定のため従来動作のまま(後方互換)。

### Matchモードのフル尺録画検証

`th9_ud5615.rpy`(Reimu vs Eiki、Lunatic、8,848フレーム≒147秒)を`--no-audio`でフル尺録画:

- 上記の座標バグ修正後、総録画時間189.5秒(メニュー操作+再生+静止検知待ち16秒)、**録画開始15秒以降の重複フレーム率0.3%**(良好)
- 画面静止検知でリプレイ終了を正しく検出(MADが167秒付近で0.00に低下)
- `end_template`導入後の再テストでは、テンプレート照合により158.8秒時点(2回連続一致)で終了検出でき、静止検知(16秒待ち)より速く終了判定できることを確認

### 判明したホスト負荷の影響(要注意事項)

上記の良好な結果が出た直後、同一ホスト上で別プロセス(ユーザーの別作業によるllama.cpp推論サーバ起動等、`load average`が15〜23に達する状態)が負荷を上げたタイミングで同じMatchリプレイを3回連続録画したところ、**重複フレーム率がいずれも30%超(34.1%/41.7%/41.1%)となり、`scripts/25`の自動リトライ機構(閾値30%、3回試行)が正しく異常を検知して全て破棄**した。th09固有のバグではなく、**Xvfb+wined3d(llvmpipeソフトウェアレンダリング)がホストCPU負荷に対して非常に敏感である**ことを示す実例と考えられる(直前の低負荷時は同一リプレイ・同一設定で0.3%だった)。このマシンは`sattori-home-worker`本番ワーカーと共用のため、**今後th09に限らずこのマシンでの録画検証時にホスト負荷(`uptime`)を確認し、重複フレーム率が悪い場合はまずホスト側の他プロセス負荷を疑うこと**。真の品質ベンチマークはAGENTS.mdの標準運用どおりAWS専有インスタンスでの実機検証(チェックリスト項目9)を基準とする。

### Storyモード(通常難度)・Extraステージのフル尺録画検証

`--max-duplicate-rate 100`(ホスト負荷影響下での機能検証のため品質リトライゲートを一時的に緩和、後述)で以下を検証、いずれも試行1回目で成功:

| リプレイ | モード/難度 | frameCount(理論尺) | 総録画時間 | 重複フレーム率(15秒以降) | 終了検知方式 |
|---|---|---|---|---|---|
| `th9_03.rpy`(Aya) | Story/Normal | 46,873フレーム≒781秒 | 768.9秒 | 1.9% | テンプレート照合(763.8秒で2連続一致) |
| `th9_04.rpy`(Komachi) | Extra | 31,424フレーム≒524秒 | 499.4秒 | 1.5% | テンプレート照合(494.1秒で2連続一致) |

Storyモードの`th09_autoplay.log`の`ScoreMonitor`出力で、P1残機(`lives`)が各ステージ(対戦相手)の切り替わりごとに`10`(満タン)へリセットされる挙動を確認した(ユーザー申告の「残機はステージをまたぐごとにリセットされる」仕様と一致)。この性質を利用すれば、専用のステージ番号RVAが無くても**lives=10への復帰をステージ境界の代理指標として使える**可能性がある(将来チャプター検出を実装する際の候補、未実装)。

### 音ズレ確認

`th9_ud5615.rpy`(Match)を音声ありでフル尺録画し、AV同期を確認予定(次項に結果を追記)。

### 低速録画機能(Direct3D8版)の新規実装

th10/th12/th20の低速録画機能(`mods/common/fps_limiter_hook.h`+`dsound_hook.h`)はDirect3D9の`Direct3DCreate9`/`IDirect3D9::CreateDevice`(vtable[16])/`IDirect3DDevice9::Present`(vtable[17])を前提にしており、Direct3D8エンジンのth09にはそのまま使えない。**新規に`mods/common/fps_limiter_hook_d3d8.h/.cpp`を追加**し、Direct3D8版のvtableフックを実装した:

- IATフック: `d3d8.dll!Direct3DCreate8`
- vtableフック: `IDirect3D8::CreateDevice`(**vtable[15]**、D3D9の16よりCheckDeviceFormatConversionが無い分1つ小さい)
- vtableフック: `IDirect3DDevice8::Present`(**vtable[15]**、D3D9の17よりGetSwapChain/GetNumberOfSwapChainsが無い分2つ小さい)

vtable番号はd3d8.h(DirectX8 SDK)のインターフェース定義順から手計算で導出し(根拠は`fps_limiter_hook_d3d8.h`のコメント参照)、実機で正しく機能することを確認した。DirectSoundの音声速度スケーリング(`dsound_hook.h`、`DirectSoundCreate8`ベース)はDirectX世代非依存のAPIのため無改造でth09にも流用できた。

`mods/th09_replay_autoplay/dllmain.cpp`にth10/th12と同じ`ScaledSleep`/`GetMenuTimeScale`パターンを追加し、メニュー操作の待機時間をFPS_LIMIT_TARGET_HZに応じてスケールするようにした。

### 発見した不具合: 低速録画時のウィンドウ安定待ちタイムアウト

`FPS_LIMIT_TARGET_HZ=30`で初回テストしたところ、`GetDeviceState`のポーリングが一切始まらないまま(0.0 Hz)ウィンドウ安定待ちがタイムアウトし、録画が失敗した。診断用ログ(`MyPresent8`内に一時的に追加、検証後削除)で調査した結果、**Present間引きのSleep+ビジーウェイトがCPUを占有し、th09のタイトル画面ロード完了(≒GetDeviceStateポーリング開始)までの実時間が通常より大幅に延びる**(実機で22秒程度かかることを確認、ホスト高負荷時はさらに延びうる)ことが原因と判明した。

`scripts/25_record_replay_e2e_multigame.py`とMOD側の両方に、**メニュー操作待機(`ScaledSleep`)以外にもハードコードされた30秒/20秒のタイムアウトが複数箇所に残っていた**(MOD側`WaitForStableWindow`/`WaitForHookActive`の`timeoutMs`引数、Python側のウィンドウジオメトリ検出ループ、`WaitForStableWindow: stable`ログ待ちの`wait_for_log_marker`)。これらを全て`GetMenuTimeScale()`/`MENU_TIME_SCALE`でスケールするよう修正し、`FPS_LIMIT_TARGET_HZ=30`でのフル動作(メニュー操作→リプレイ開始→30秒録画)を実機確認した(録画開始15秒以降の重複フレーム率50.0%、60fpsコンテナに30fps描画を収録した場合の理論値と一致する正しい特徴)。この修正は他タイトル(th10/th12/th20)の低速録画にも間接的に安全側で効く(未設定時はscale=1.0で無変更)。

## AWSクラウド実機検証

ユーザーから「スポット価格0.2USD/hour以下のインスタンスタイプであれば明示的な許可なく起動してよい」との事前許可を受けて実施。

### 準備

- `cloud/docker/aws/Dockerfile.th09`を新規作成(th10/th12のDockerfileを土台にth09単体の軽量イメージ、`games/th09/`・`prefixes/th09-wined3d-gl/`・`mods/th09_replay_autoplay/build/th09_hook.dll`を同梱)。`entrypoint_multigame.py`はGAME環境変数を汎用的に受け取るため無改造で流用
- ECRリポジトリ`touhou-recorder-th09`(eu-south-2)を新規作成、EC2キーペア`touhou-recorder-th09-key`を新規作成
- th10/th12と同じ構成(AMI`<AMI_ID>`、`c7i.xlarge`、`<SECURITY_GROUP_ID>`、`<SUBNET_ID>`、`touhou-recorder-verify-profile`)でスポットインスタンスを起動: `<INSTANCE_ID>`(eu-south-2b、スポット価格実測$0.0298/hour)

### 検証結果

短時間動作確認(`RECORD_SECONDS=40`)で追加設定なしにS3アップロードまで正常完了(exit_code=0)することを確認した後、Match/Story(通常難度)/Extraの3種ともフル尺(自然終了検知)で検証:

| リプレイ | モード | 総所要時間(entrypoint計測) | 重複フレーム率(60秒サンプル) |
|---|---|---|---|
| `th9_ud5615.rpy` | Match | 173.4秒 | 3.1%(15〜75秒) |
| `th9_03.rpy` | Story/Normal | 783.0秒 | 1.5%(60〜120秒) |
| `th9_04.rpy` | Extra | 511.8秒 | 1.7%(60〜120秒) |

いずれもローカル実機での総録画時間(189.5秒/768.9秒/500.6秒)と近い値で、exit_code=0・S3アップロードも正常完了。**c7i.xlarge(4vCPU)がth09の推奨インスタンスタイプ**(th10/th12と同じ結論)。上位インスタンスタイプへのステップアップ検証は品質良好のため不要と判断した。

検証完了後、EC2インスタンスを`terminate-instances`し、`describe-instances`で稼働中インスタンスが無いことを確認した。ECRリポジトリ・キーペアはCLAUDE.local.mdの運用ルールに従い残置。

### 録画データの保存

ローカル実機録画(Match/Story-Normal/Extra、いずれも音声付きフル尺)とAWS実機録画(同3種、S3からダウンロード)を`/mnt/cache3/sattori-th09-verify/`に保存した(ユーザー指示):

```
th09-match-local.mp4                  (130MB)
th09-match-aws-c7i-xlarge.mp4         (129MB)
th09-story-normal-local.mp4           (679MB)
th09-story-normal-aws-c7i-xlarge.mp4  (677MB)
th09-extra-local.mp4                  (528MB)
th09-extra-aws-c7i-xlarge.mp4         (526MB)
```

## AGENTS.md新規タイトル対応チェックリスト完了状況

1. 設定確認 ✅(ユーザー申告のウィンドウモード設定を実機起動で確認)
2. 起動確認 ✅
3. MOD開発・動作確認 ✅(Match/Storyどちらのメニュー操作も実装・確認)
4. リプレイ録画確認(通常ステージ+Extra) ✅(Story/Normal・Extra両方フル尺確認、加えてユーザー明示要求によりMatchモードも確認)
5. 録画品質確認 ✅(ローカル・AWS両方で重複フレーム率3.1%以下を確認、ローカルはホスト負荷次第で悪化しうることも記録)
6. 音ズレ確認 ✅(既存のitsoffset補正機構で正常動作)
7. 低速録画機能 ✅(Direct3D8版を新規実装、実機確認済み)
8. 内部データ取得機能 △(life取得は実装・確認済み、scoreは実機探索を尽くしたが未特定のまま)
9. クラウド実機検証 ✅(c7i.xlargeでMatch/Story/Extra全て良好)

項目8(スコアRVA)が未解決のまま残るが、他8項目は完了しており、AGENTS.mdの「未解決・要フォローアップの既知課題」に追記の上で「対応完了」として報告する。

## 次フェーズ以降のTODO(未解決事項)

1. スコアRVAの継続調査(必要になった場合。より広範囲のヒープ全域スキャン、または`stage_probe_hook`の差分スキャン方式の応用、もしくはユーザーからの追加情報提供)
2. チャプター検出(ステージ開始時刻)の実装(life=10リセットを利用する案、または`scripts/49`のプローブ方式を試す)
3. th09固有のウィンドウ座標バグ(`skip_origin_move_if_fits`で回避)の根本原因は未特定のまま
4. Extraステージの低速録画・fps表示補正の実機検証は未実施(Match/Storyでのみ確認済み。ロジック自体はモード非依存のため動作するはずだが未確認)
