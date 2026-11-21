# フェーズ70: th128(妖精大戦争)の環境構築・自動操作MOD実装(メニュー操作確立・スコア監視RVA検証まで)

日付: 2026-09-04

## 位置づけ

新規タイトルth128(妖精大戦争 ～ 東方三月精 / Fairy Wars)をリポジトリの録画パイプラインに追加する作業の第1弾。AGENTS.mdの「新規タイトル対応時の検証チェックリスト」のうち、項目1(設定確認)〜3(MOD開発・動作確認)、項目8(内部データ取得機能)のうちスコア・motivation(残機/やる気ゲージ相当)のRVA特定・実機検証まで完了。項目4(フル尺録画、通常/Extra両方)以降は未着手。**このフェーズだけでは「対応完了」を報告しない**こと。

th128はZUN本家ではなく黄昏フロンティア制作の外伝作品(TH10 / 東方風神録エンジンをベースにした横スクロール弾幕STG)。thprac側のソース(`thprac_th128.cpp`)がth10用のトラッカーコールバック(`th10_tracker_count_bomb`/`th10_tracker_count_miss`)をそのまま再利用しており、エンジン世代がth10に近いことが示唆されていた(実機検証でもth10/th12と同じ入力方式であることを確認、後述)。

## 前提確認

- 作業開始前に`systemctl status sattori-home-worker`を確認したところ、作業開始の約1時間9分前に既に停止済み(ログに「実行中のジョブはありません」)であることを確認した。念のため`ps aux | grep -iE 'wine|ffmpeg|th12|th06|...'`でも残存プロセス無しを確認してから着手した。
- `games/th128/`にth128.exe(752,640バイト)・th128.dat・thbgm.dat・th128.cfg(ユーザーがウィンドウモード設定済みとして配置)・VsyncPatch一式(`vpatch.exe`/`vpatch.ini`/`vpatch_th128.dll`、対応バージョン記載は「ver1.00a」)が配置された状態で作業開始。
- th128.cfgの先頭バイトは`0x01`で、th12.cfgで実機検証済みのウィンドウモード値(`reports/61`参照、`0x01`=ウィンドウモード)と一致することを確認した(今回は実機での書き換え再検証は省略、th12の先例を踏襲)。
- `strings th128.exe`で`d3d9.dll`が読めることを確認済み(後にIATフックログでも`Direct3DCreate9`フック成功を確認)。DINPUT8.dll/DSOUND.dll/USER32.dllも同時にインポートされている。

## リプレイファイルの内容確認(`@sattori/touhou-replay-parser`使用)

`node ../sattori/packages/replay-parser/dist/cli/index.js -j games/th128/replay/*.rpy`で5本(`th128_ud0000.rpy`・`th128_01〜04.rpy`)を全件パースした。

| ファイル | プレイヤー | 難易度 | 開始ステージ表示 | 記録スコア |
|---|---|---|---|---|
| th128_ud0000.rpy | koyi | Hard | RouteB-1 | 22,666,770 |
| th128_01.rpy | koyi | Hard | RouteA-2 | 5,715,000 |
| th128_02.rpy | koyi | Hard | RouteB-1 | 12,609,300 |
| th128_03.rpy | koyi | Hard | RouteB-1 | 22,666,770(ud0000と同一内容) |
| th128_04.rpy | koyi | Lunatic | RouteC-1 | 21,080 |

ユーザー指定どおり`th128_ud0000.rpy`を検証用に使用した(ユーザー自身の記録、Hard、Route B、3ステージ分のsplitsを含むフル尺リプレイ)。**5本ともHard/Lunaticのみで、Extra難易度のリプレイが無い**ことが判明した。チェックリスト項目4(Extraステージ録画検証)にはExtraリプレイが別途必要(次フェーズでSilentSelene等から取得する想定)。

## AppData配置場所の確認

th128.exeの文字列から`APPDATA`・`\ShanghaiAlice`・`\th128`が続けて見つかり、th20(th125以降のエンジン)と同じ`%APPDATA%\ShanghaiAlice\th128\`配下にcfg/replay/log.txt/snapshotを置く仕様であることを確認した。`../sattori/packages/replay-parser/src/games/th128.ts`のコメント(`128r`デコーダ)とも整合する。

## thprac(thprac_th128.cpp)からのRVA調査

`../thprac/thprac/src/thprac/thprac_th128.cpp`を調査したが、練習モードGUIの`Gui::GuiSlider`/`Gui::GuiCombo`等のウィジェットクラス自体はメモリオフセットを保持しない(UI表示専用のローカル変数)ため、フィールド宣言(`mScore`・`mLife`等)から直接RVAは読み取れなかった。実際のメモリ書き込みは別のフックコールバック内で行われており、`th128_patch_main`フック(絶対VA `0x42641a`、練習モード開始時に呼ばれる)内に以下の直書きコードを発見した(image base `0x400000`前提の絶対VA):

```cpp
// thprac_th128.cpp 2242〜2247行目付近
*(int32_t*)(0x4b4cc4) = (int32_t)(thPracParam.score / 10);
*(int32_t*)(0x4B4D64) = thPracParam.motivation;
*(int32_t*)(0x4B4D70) = thPracParam.perfect_freeze;
*(int32_t*)(0x4B4D6C) = thPracParam.ice_power;
*(float*)(0x4B4D60) = (float)thPracParam.ice_area;
```

th12(`reports/62`)で採用した手法(THAdvOptWnd内の練習モードパラメータ書き込みコードから収集)と同じ考え方で、「練習モード開始時にゲーム内変数へ直接書き込まれる初期値のアドレス」は「実プレイ中も同じアドレスが更新され続ける」という前提のもと、これらをそのままscore_monitorのRVAとして採用した(基点`0x4b4c00`、RVA=`0xb4c00`からのオフセット)。

- score: offset `+0xc4`(`0x4b4cc4`)、表示値の1/10と推定
- motivation(やる気、残機に相当する体力ゲージ): offset `+0x164`(`0x4b4d64`)、表示値は`生値/100`の%表記
- perfect_freeze(パーフェクトフリーズ、ボム相当): offset `+0x170`(`0x4b4d70`)
- ice_power(こおりパワー): offset `+0x16c`(`0x4b4d6c`)
- ice_area(こおらせた面積、float): offset `+0x160`(`0x4b4d60`)

th128にはグレイズの実装が無い(thprac側の`THPracParam`にもgrazeフィールドが無い)。stage/route(`0x4b4d44`、`th128_prac_menu_enter_2`フックが書き込むルート×ステージの線形インデックス0〜15)は練習モード開始地点の設定用であり、通常プレイ中に現在位置を追従して更新される保証が無いため、今回はscore_monitorに含めなかった(要検証、次フェーズ以降の課題)。

## MOD実装(`mods/th128_replay_autoplay/`)

`mods/th10_replay_autoplay/`・`mods/th12_replay_autoplay/`をベースに新規作成。

- **入力方式**: th12(`reports/61`)と同じくGetDeviceState(DirectInput、DIKスキャンコード経由の`PressKey`)を採用した。`InstallDinputHook()`/`InstallKeyboardStateHook()`を両方インストールした上でPressKeyのみ使う設計もth10/th12と同一(実機ログで`WaitForHookActive: GetDeviceState hook active`・`FpsMonitor`が55〜60Hzで推移することを確認し、GetDeviceState経由で正しく動作することを確認済み)。
- **メニュー操作シーケンス**(ユーザー指定どおり):
  1. タイトル画面ロード待ち(8000ms、th10の6000msよりやや長め。ユーザー申告の「1.5秒〜最大10秒」を踏まえた値)
  2. Down x1 → Enter(「Replay」選択)
  3. Right x1(ユーザーリプレイタブへ切替、th11/th12/th20と同じ`_ud0000`規約)
  4. Enter(1番目のユーザーリプレイファイルを選択)
  5. Enter(再生確定)
- **低速録画用フック**: `InstallFpsLimiterHook`/`InstallDSoundHook`をth10/th12と同じ構成でインストール済みだが、**実機検証は未実施**(次フェーズの課題)。
- **ビルド**: `mods/th128_replay_autoplay/build.bat`(MSVC想定)を新規作成。開発中の動作確認用に`i686-w64-mingw32-g++ -shared -O2 -static-libgcc -static-libstdc++ -static`でのクロスビルドが成功することを確認した(CLAUDE.mdの許可事項どおり調査・デバッグ目的のみ、正式ビルドはbuild.bat/MSVC)。

## 重大な不具合の発見と対策: リプレイ選択直後のフリーズ

`scripts/25_record_replay_e2e_multigame.py`にth128エントリを追加(`GAME_CONFIGS["th128"]`、display `:91`)し、まずthprac無しで30秒の短時間録画テスト(`--record-seconds 30 --no-audio`)を実施したところ、以下の症状が再現した:

- メニュー操作シーケンス自体は全ステップ成功ログが出る(Down/Enter/Right/Enter/Enterすべて正常送出)
- Step4(1番目のユーザーリプレイ選択)のEnter後、GetDeviceStateのポーリング周波数が55〜60Hzから15〜16.6Hzへ低下(読み込み開始を示唆)
- Step5(再生確定)のEnter直後からGetDeviceStateの呼び出しが完全に0Hzになり、以後録画終了まで一切回復しない
- ffmpegで撮れた映像は「リプレイ一覧画面(0000番のユーザーリプレイがハイライトされた状態)」のまま完全に静止(重複フレーム率100%)
- ScoreMonitorのログも起動直後の`score=0 stage=0 lives=0`から一切変化しない(実プレイが始まっていないことを裏付ける)
- MOD無しでの手動起動(`wine injector.exe th128.exe th128_hook.dll`を`DISPLAY=:91`で直接実行)でも同一症状を再現。プロセスはCPU約103%で回り続けたまま2分間放置しても状態が変化せず(`ps -o %cpu=`で20秒間隔6回計測、103%→103%→103%→103%→102%→102%とほぼ一定)、スクリーンショットも完全に同一だった。単なる読み込みの遅さではなく、無限ループに入っていることが濃厚と判断した。

この時点でユーザーに調査状況を報告したところ、**「Windows実機でも再現する、ゲーム本体側の既知バグ」であり、実機ではthprac経由で起動することで解消したとの情報提供があった**。ユーザーが検証に使用したthprac本体(`thprac.v2.3.0.3.exe`)を`games/th128/`に配置してもらい、th20で先例のある`--thprac`機構(`attach_thprac()`、`reports/50`参照)をth128にも適用することにした。

`GAME_CONFIGS["th128"]`に`"thprac_exe": "thprac.v2.3.0.3.exe"`を追加(`game_dir_src`がrsyncでインスタンスディレクトリへ丸ごとコピーされるため、`games/th128/thprac.v2.3.0.3.exe`を置くだけで追加のコピー処理は不要)。

`--thprac --record-seconds 40 --no-audio`で再実行したところ、フリーズは再現せず、Step5のEnter直後もGetDeviceStateの周波数低下(15Hz云々)自体が発生しなくなり(Step4→Step5間が0.83秒で完了)、以後正常にステージ1のゲームプレイ映像が録画された。**録画全体の重複フレーム率は1.2%**と良好。この問題は今後th128を録画する際は必ず`--thprac`を付けること(th20の`--thprac`必須ルールと同様、AGENTS.mdの運用ルールに追記予定)。

## スコア監視RVAの実機検証

thpracアタッチ有りの録画(`runs/th128_verification/smoke_test2.mp4`)から、動画のn=1500フレーム目(60fps換算で25秒後、実時刻15:15:56付近)を切り出したところ、画面上のHUD表示は以下の通りだった:

- いまスコア: `52,710`
- やる気: `210%`

同時刻(`15:15:56.611`)のMODログ:

```
ScoreMonitor: score=5271 stage=0 lives=21010 graze=0 epoch_ms=1788502556611
```

- score(生値)`5271` × 10 = `52710` → 表示値`52,710`と完全一致
- lives(motivation生値)`21010` ÷ 100 = `210.1` → 表示値`210%`と一致(小数点以下切り捨て)

これにより、score/motivationのRVA(`0xb4cc4`/`0xb4d64`)と換算式(score×10、motivation/100)を実機で確認できた。perfect_freeze/ice_power/ice_areaはscore_monitorに未接続のため今回は未検証(HUD上に「パーフェクトフリーズ」「こおりパワー」「こおらせた面積」として同時に表示されていることは確認済みなので、次フェーズで接続・検証する)。

## 未完了・次フェーズへの持ち越し事項

1. フル尺録画検証(通常難易度・Extra難易度の両方) — Extraリプレイが手元に無いため、SilentSeleneからの取得が必要
2. 録画品質・fps確認(重複フレーム率、理論尺比較)
3. 音ズレ確認
4. 低速録画機能の実装・実機検証(フック自体はインストール済みだが動作未検証)
5. perfect_freeze/ice_power/ice_area/stageのscore_monitor接続・検証
6. リプレイ終了検知: ユーザー申告どおりテンプレート照合が有効と思われるが、`assets/replay_end_templates/th128.png`は未取得(フル尺録画完了後に取得予定)。現時点では`end_template`未設定のため画面静止検知にフォールバックする設定になっている
7. AWSクラウド実機検証(スポット価格0.2USD/hour以下のインスタンスタイプは非明示許可で起動可、とユーザーから事前承認済み)

## 変更ファイル

- 新規: `mods/th128_replay_autoplay/dllmain.cpp`, `mods/th128_replay_autoplay/build.bat`
- 変更: `scripts/25_record_replay_e2e_multigame.py`(`GAME_CONFIGS["th128"]`追加、`--game`選択肢に`th128`追加)
- 新規: `prefixes/th128-wined3d-gl/`(WINEPREFIX、gitignore対象)
