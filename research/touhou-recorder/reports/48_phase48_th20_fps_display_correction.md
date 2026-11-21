# フェーズ48: th20スローモーション化録画のfpsカウンター表示補正

日付: 2026-08-06

## 背景・目的

フェーズ47で、`FPS_LIMIT_TARGET_HZ`によりth20を意図的にスローモーション化(例: 30fps駆動)してCPU負荷を削減し、録画後に`scripts/47_descale_th20_slowmo.py`で映像・音声とも「等倍相当」に変換する手法を確立した。ただし、変換後の動画でも**画面に焼き付いたゲーム内蔵fpsカウンターのテキスト自体は録画時の値(例: 「30.0fps」)のまま残ってしまい、実際の滑らかさ(60fps相当に復元済み)と表示数値が食い違う**という制約が未解決のまま残っていた。

ユーザーから、既存のDLLインジェクション基盤を使ってこの表示上のfps値そのものを録画中に補正できないか(等倍相当の値をあらかじめ焼き付けられないか)という相談があり、本フェーズで検証・実装した。

## 調査: th20.exe自身のタイマーAPI呼び出しの特定

診断用フック`mods/common/timer_probe_hook.h/.cpp`(新規)を実装し、th20.exe自身のインポートテーブルをIATフックして、`QueryPerformanceCounter`・`timeGetTime`・`GetSystemTimeAsFileTime`・`SetTimer`の呼び出し元(return address)ごとの頻度をログに記録できるようにした。

th20.exeのインポートテーブルを`objdump`で確認したところ、時刻関連APIとしては`QueryPerformanceCounter`/`QueryPerformanceFrequency`(kernel32)・`timeGetTime`(winmm)・`GetSystemTimeAsFileTime`(kernel32)・`SetTimer`/`KillTimer`(user32)が使われていた(`GetTickCount`は未使用)。実機ログでは:

- `GetSystemTimeAsFileTime`は一度も呼ばれない
- `SetTimer`は起動時に1回だけ(250ms間隔、恐らくメニューカーソルの明滅アニメーション用)呼ばれるのみで、fps算出とは無関係
- `timeGetTime`は起動時に1回だけ(恐らく乱数シード等)
- `QueryPerformanceCounter`には持続的に呼ばれる呼び出し元が2箇所ある:
  - rva=`0x00141875`: フレームごとに正確に1回。実際のPresent呼び出し頻度(`fps_limiter_hook`でスロットルされた後の実測レート)と厳密に1:1で相関(60fps時59〜60Hz、`FPS_LIMIT_TARGET_HZ=30`時30Hz)
  - rva=`0x0001cb54`: 常にその3倍のレートで呼ばれる
  - rva=`0x0001b598`: 起動時に1回のみ

また、`strings`でth20.exeバイナリ内を検索したところ`D:\cygwin\home\zun\prog\th20\src\game\fps.cpp:61 FPSInf`・`initialize FPSInf`・`shutdown FPSInf`という文字列が見つかり、fps計測を担う専用クラス`FPSInf`(ZUN自身のソースツリーの`fps.cpp`)が存在することを確認した(printf形式のfps表示フォーマット文字列は見つからず、恐らく数値ビットマップフォントで描画しているため文字列としては現れない)。

## 実装と実機検証: 対象コールサイトの特定(試行錯誤)

### 1回目の試行: rva=0x00141875を対象にした結果(失敗)

Present頻度と厳密に1:1相関することから、rva=`0x00141875`が最有力候補と考え、このコールサイトから呼ばれた`QueryPerformanceCounter`の戻り値だけを「経過時間を`FPS_LIMIT_TARGET_HZ/60`倍に短縮した偽の値」にすり替えるフック(`mods/common/fps_display_hook.h/.cpp`、新規)を実装した。

実機検証(Xvfb上でth20を起動し、ウィンドウを直接キャプチャして画面上のfpsカウンター表示を目視確認)の結果、**このコールサイトを補正してもfpsカウンター表示は変化しなかった**(`FPS_LIMIT_TARGET_HZ=30`のまま「30.0fps」表示が継続)。フックの発火自体は確認できており(ログでrealDelta/fakeDeltaが期待通り半分になっていることを確認)、ロジック上の誤りではなく単に「このコールサイトは表示計算に使われていない」ことが判明した。

### 危険な実験: 全コールサイトを無差別に補正するとハングする

原因切り分けのため、対象コールサイトの制限を外し、th20.exeから呼ばれる`QueryPerformanceCounter`を無差別に(呼び出し元を問わず)補正する実験を行ったところ、**th20が完全にハングした**(`GetDeviceState`ポーリングが0Hzに落ち込み、メニュー操作・リプレイ再生とも一切進行しなくなった)。

これは、rva=`0x00141875`が恐らく「実時間で一定時間経過するまで待つ」という内部フレームペーシング/自己スロットルの判定に使われており、この呼び出し元の戻り値を偽装すると「いつまで経っても閾値に達しない」スピンループに陥ったためと推測される(`fps_limiter_hook`によるPresentの外部スロットリングとは別に、th20自身も内部的に自己スロットルを試みている可能性がある。フェーズ46でAWS実機で発覚した「th20が75fpsに暴走する」不具合も、この自己スロットル機構自体が環境依存で壊れていたことに起因すると考えれば整合的)。**対象コールサイトを1箇所に限定する設計は、正確さだけでなく安全性の観点でも重要であることが実機で裏付けられた。**

### 2回目の試行: rva=0x0001cb54を対象にした結果(成功)

もう一方の候補、フレームごとに3回呼ばれるrva=`0x0001cb54`を対象に切り替えて同様のテストを行ったところ、**画面上のfpsカウンター表示が実際に「60.0fps」に変化することを実機・目視で確認した**(`FPS_LIMIT_TARGET_HZ=30`設定下)。ゲームロジックの進行速度(`FpsMonitor`ログの`GetDeviceState`呼び出し頻度、30.0Hz付近を維持)・CPU使用率(`pidstat`実測で平均251%、フェーズ47の30fps条件の実測値266%と同水準)とも無補正時から変化がなく、**表示補正のみを実現しつつ、フェーズ47のCPU負荷軽減効果(スローモーション化そのもの)には影響しないことを確認した**。

最後に`scripts/25_record_replay_e2e_multigame.py`のフル録画パイプライン経由(`FPS_LIMIT_TARGET_HZ=30`)でも同じ結果(録画映像内で「60.0fps」表示、重複フレーム率50.2%は30fps相当コンテンツとして期待通りの値)を確認し、本番運用相当の経路でも問題なく動作することを検証した。

## 実装

- `mods/common/fps_display_hook.h/.cpp`(新規): th20.exe自身の`QueryPerformanceCounter`のIATエントリをフックし、rva=`0x0001cb54`から呼ばれた場合のみ、経過時間を`FPS_LIMIT_TARGET_HZ/60`倍に圧縮した偽の値にすり替える。他の呼び出し元(`fps_limiter_hook`自身がPresentペーシングに使うQueryPerformanceCounterを含む)には一切影響しない。`FPS_LIMIT_TARGET_HZ`未設定または60の場合はscale=1.0で実質無効化(他フックと同じ既定安全方針)。
- `mods/common/timer_probe_hook.h/.cpp`(新規): 調査用の診断フック。`TIMER_PROBE=1`のときのみ有効化、本番パイプラインには組み込まない(`font_quality_hook.*`と同様、build.batには含めない)。**`fps_display_hook`と同じQueryPerformanceCounterのIATスロットを二重にフックすると、後からフックした側のreturn address捕捉先が相手のフック関数内になってしまい正しく動作しなくなる**(実際にこの二重フックに気づかず「補正が効いていないように見える」誤ったデータを一度得た)。両方を同時に有効化しないよう、ヘッダコメントに明記した。
- `mods/th20_replay_autoplay/dllmain.cpp`: `InstallFpsDisplayCorrectionHook()`を追加(`InstallDSoundHook`の後)。
- `mods/th20_replay_autoplay/build.bat`: `fps_display_hook.cpp`をビルド対象に追加。

## 既知の制約

- rva=`0x0001cb54`はth20.exe(検証時点のバイナリ)固有のオフセットのハードコードであり、ゲームデータが更新されバイナリが変わると別の値になる可能性がある(AGENTS.mdのcfgフルスクリーンフラグの教訓と同様)。想定外のバイナリで一致しなかった場合は単に無補正(実測通りの低いfps表示)に留まるだけで、実害はない(安全側のフォールバック)。
- 本フェーズはfps表示の補正のみが目的で、フェーズ47の音声同期解決(`dsound_hook`)・等倍変換(`scripts/47_descale_th20_slowmo.py`)と組み合わせて初めて「滑らかさ・音声・表示数値すべてが等倍相当で一致した」録画になる。本番録画パイプラインへの`FPS_LIMIT_TARGET_HZ`運用自体の組み込みは、フェーズ47の記載通り依然未実施。

## 成果物

- `runs/th20_slowmo_poc/fps_display_correction_test/video_30hz_fixed.mp4`(88.8秒、`FPS_LIMIT_TARGET_HZ=30`、fps表示補正込み。ゲームプレイ区間で画面上のfpsカウンターが「60.0fps」と表示される)
