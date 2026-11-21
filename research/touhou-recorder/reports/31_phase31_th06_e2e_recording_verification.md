# フェーズ31: th06(紅魔郷)リプレイ自動再生・E2E録画の実証

日付: 2026-07-23

## 背景

フェーズ30でth06のwined3d白画面ハングを解消(`LANG=ja_JP.UTF-8` + VsyncPatch)した。本フェーズでは、th07/th08と同様のリプレイ自動再生MOD・E2E録画パイプラインをth06向けに実装し、実際にリプレイからの動画生成が成立するかを検証した。

## MOD実装: `mods/th06_replay_autoplay/`

ユーザー提供のキー操作手順(実機Windowsでの手動プレイ確認済み)を元に、`mods/th07_replay_autoplay/dllmain.cpp`をベースに実装した。th06はタイトル画面が最初からアトラクトモードのデモプレイ("DEMO PLAY")を表示しており、th07/th08と異なり**メニュー自体がまだ出ていない**ため、Down連打の前に**メニュー表示のためのEnter押下**が1回余分に必要な点が構造上の違い(それ以外はth07/th08と同じ「フックが呼ばれるまで待つ→Down×N→Enterで確定→Enterでリプレイ選択→Enterで再生開始」というパターンを踏襲):

1. タイトル画面表示後 2000ms待機(ロゴアニメーション)
2. Enter(デモプレイを止めてメインメニュー表示)
3. Down×2 → 500ms
4. Enter(「Replay」確定、リプレイ一覧へ) → 2000ms(画面遷移待ち、th07/08の700msより長め。ユーザー確認により本タイトルは遷移に約2秒かかるため)
5. Enter(1番目のリプレイファイル選択) → 1000ms
6. Enter(再生開始)

mingw-w64(`i686-w64-mingw32-g++`)でセルフビルドし、実機注入テストでフックチェーン確立(IATフック→CreateDevice→GetDeviceStateのvtableフック)・キーシーケンス完走・実際のリプレイ再生開始まで一発で確認できた。

## injectorの複数DLL注入対応

th06はMOD(`th06_hook.dll`)に加えて、フェーズ30で判明した白画面ハング回避に必須の`vpatch_th06.dll`(VsyncPatch)も同一プロセスに注入する必要がある。`mods/common/injector.cpp`を拡張し、`injector.exe <target.exe> <dll1> [dll2 ...]`の形式で複数DLLを指定順に(CreateProcess(SUSPENDED)のまま)順次LoadLibrary注入してからメインスレッドを再開できるようにした。

検証は、注入だけを行うテストで**vpatch_th06.dllのDllMain(DLL_PROCESS_ATTACH)を素朴にLoadLibraryするだけで白画面ハングが解消する**ことを先に確認済み(`vpatch.exe`本体を経由せず、明示的な`_Initialize@4`エクスポート呼び出しも不要)だったため、既存のIATフック方式のMODと同じ「LoadLibraryA注入のみ」で両DLLを共存させられた。th07/th08向けの既存呼び出し(DLL1個)にも後方互換。

## 発見: 日本語ファイル名exeのcomm切り詰め問題

`scripts/25_record_replay_e2e_multigame.py`のプロセス検出・終了処理は`pgrep -x`/`pkill -x`でexe名の完全一致を見ているが、**Linuxの`/proc/PID/comm`は15バイトで切り詰められる**ため、UTF-8で18バイトの`東方紅魔郷.exe`は末尾の`.exe`が欠落した`東方紅魔郷`(15バイトちょうど)という値になる。`pgrep -x "東方紅魔郷.exe"`は一致せず、`pgrep -x "東方紅魔郷"`(拡張子無し)なら一致することを実機確認した。

対応として、`GAME_CONFIGS`に`process_name`キー(pgrep/pkill専用、th06のみ`"東方紅魔郷"`を設定)を追加し、`find_live_game_pid`/`kill_wine_and_wait`は`cfg.get("process_name", cfg["game_exe"])`で解決するようにした(th07/th08は元々ASCIIで15バイト以内に収まるため影響なし、キー未設定時は従来通り`game_exe`にフォールバック)。

## `scripts/25_record_replay_e2e_multigame.py`のth06対応

`GAME_CONFIGS`に`th06`エントリを追加(display `:96`、`prefixes/th06-wined3d-gl`、`extra_dlls: ["vpatch_th06.dll"]`、既定リプレイ`th6_02.rpy`)。`extra_dlls`は`game_dir_src`(`games/th06`)に同梱済みのDLLをrsyncで自動コピーし、MOD本体より先に注入するために使う汎用の仕組みとして実装した(他タイトルで同種のファン製パッチが必要になった場合にも流用できる)。

## 検証結果

- `--record-seconds 30`によるクイック検証(`th6_02.rpy`): 総録画38.2秒、**重複フレーム率0.0%**(録画開始15秒〜33秒の区間)。タイトル画面・メニュー操作・リプレイ再生いずれも60.00fpsで安定
- 自然終了検知(画面静止判定)によるフル尺録画(`th6_03.rpy`、Extraステージのリプレイと判明): **総録画395.3秒(約6.6分)、画面静止検知により正常終了、録画開始15秒以降の重複フレーム率0.1%**。中盤の高密度弾幕(Extraボス戦のスペルカード、`reports/assets/th06_e2e_extra_boss.png`)でも60.00fps安定、重複フレームの悪化なし。終了後は自動的にリプレイ選択画面(`reports/assets/th06_e2e_replay_end.png`、「No.03 koyi 08/12/11 ReimuA Extra」)まで正しく遷移していることを確認し、リプレイ再生・終了検知ロジックがth07/th08と同様に機能することを実証した

## 結論

th06(紅魔郷)は、
1. `LANG=ja_JP.UTF-8`環境変数(cfg読み込みのロケール依存修正、フェーズ30)
2. VsyncPatch(`vpatch_th06.dll`)の同時注入(白画面ハング回避、フェーズ30)
3. `mods/th06_replay_autoplay/th06_hook.dll`によるリプレイ自動再生(本フェーズ)
4. `process_name`によるcomm切り詰め対策(本フェーズ)

の4点を揃えることで、th07・th08と同様にWine+Xvfb+ffmpegによるヘッドレスE2E録画が可能になることを実証した。クイック検証(30秒)・フル尺自然終了検証(約6.6分、Extraボス戦含む)の両方で重複フレーム率0.1%以下という良好な結果を得ており、**th06はth07・th08と同水準の録画品質でパイプラインに組み込める状態**にあると言える。

次のステップ: 複数リプレイ・複数回試行での成功率測定(th08で行ったfps暴走・処理落ちの統計測定に相当するもの、ただし今回の検証ではth06にfps暴走の兆候は見られなかった)、AWS環境での実機検証、Docker本番イメージ(`cloud/docker/aws/Dockerfile.multigame`相当)へのth06追加。
