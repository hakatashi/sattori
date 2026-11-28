# 0088. MOD のタイトル定義を `TitleSpec` の宣言にし、DllMain・AutoPlayThread・メニュー操作の流れを共通化する

- **状態**: 有効
- **決定日**: 2026-11-24
- **対象**: worker(`worker/mods/`)・docs
- **関連**: Issue #394、Epic #399、[`0076`](0076-mod-core-and-present-bus.md)、`worker/docs/mods.md` §1.1

th06〜th20・th128(32bit、12本)の `dllmain.cpp` を、`TitleSpec`(`autoplay/title_main.h`)の宣言と `DEFINE_TITLE(spec)` だけにした。
`DllMain`・`AutoPlayThread`・メニュー操作の実行は `autoplay/title_main.cpp`・`autoplay/menu_script.cpp` が1か所で持つ。
th06c・th06nc は起動の流れが違うので、メニュー操作(`MenuStep` の並びと `RunMenuScript`)だけ共有する。
**本番の挙動(待ち時間・キー操作の並び・契約行)は変えていない**。

## 背景

14本の `dllmain.cpp` は同じ流れ(`LogInit` → 各フックの Install → `ScoreMonitorConfig` → AutoPlayThread)を個別に持ち、
AutoPlayThread の冒頭(`WaitForStableWindow`・`WaitForHookActive`・30秒のタイムアウト)とメニュー操作の
「キーを押す → 待つ」の並びが全タイトルでコピーされていた。同系統のタイトルどうしの差分はコメントだけの
ものが多く(th128 と th13、th07 と th08)、フレーム同期の移植(#388)と CPU 低速録画のコード削除(#391)で
タイトル固有のフックの分岐が整理されたので、宣言にすべき項目が確定した(ユーザーの判断、2026-11-20)。

## 決定

1. **`TitleSpec` に出す項目**: タイトルID・入力経路(`kDInput`・`kKeyboardState`)・タイトル画面の待ち(フレーム同期時の別値つき)・
   メニュー操作(`MenuStep` の並び、Step の開始番号)・文字フィルタ・フレーム同期のバックエンドと stepDiv・
   Present の上限(`limiterOnlyWhenScaled` つき)・ScoreMonitor の設定。フックの組み込み順は `TitleDllMain` に固定した。
2. **宣言に収まらないタイトル固有の処理は `realtimeExtra`(引数なしの関数)に残す**。th12 の fps 表示のコードケーブ、
   th06/th08/th09/th14/th15/th20 の fps 表示補正の呼び出し(RVA)がこれにあたる。実時間の録画だけで走り、
   `InstallSpeedHackHook`・上限の後に呼ばれる(従来の順序のまま)。
3. **メニュー操作は `RunMenuScript` が実行する**。各 Step は「`LogStep` → キー(`repeat` 回、各回の後に `MenuSleep(待ち)`)」で、
   フレーム同期時だけ待ちを変える項目(`waitMsFrameSync`)と、キーを送るだけで表せない Step(`custom`、th06c の
   カーソル位置の読み取り)を持つ。**契約行(`Step N:`・`sequence complete`)を出すのはここだけ**で、書式は
   `core/log_contract.h` のまま。`MenuSleep` の倍率・フレーム同期の切り替えは `core/time_scale` に任せ、タイトル側に書かない。
4. **th06c・th06nc は `TitleSpec` を使わない**: 起動ダイアログの処理、`WaitForStableWindow` の種類(`kDxlib`)、
   入力ポーリングの待ち(`g_pollCount`)、th06nc のスコア監視の起動の違い(フレーム同期のときだけ AutoPlayThread から起動)が
   宣言に収まらない。無理に `TitleSpec` へ寄せると条件分岐がタイトルIDの `if` になるため、`DllMain` と起動待ちは各ファイルに残した。
5. **Makefile と `worker/recording/config.py` の対応は、すでに同じパターンで機械的に導出される**
   (`mods/<id>_replay_autoplay/build/<id>_hook.dll`)ので、定義の置き場は増やさなかった。代わりに
   `worker/tests/test_mod_title_definitions.py` が、Makefile の `TITLES`・`record_thNN.py`・`dllmain.cpp` の
   `TitleSpec`/`RunMenuScript` のタイトルIDの突き合わせを行う。
6. **ログの非契約行は揃えた**: `DLL_PROCESS_ATTACH: installing IAT hook(s)`・`Buffering ...ms (scaled) for title screen...` などの
   自由書式の行は全タイトルで文言を統一した(ワーカーは読まない)。契約行の文言と出る順序は変えていない。
7. **フックの組み込み順の違いは1か所だけ**: th11 の `InstallKeyboardStateHook` を、`InstallDSoundHook` の後から
   `InstallDinputHook` の直後(th20 と同じ位置)へ移した。IAT の別の関数への書き換えで互いに依存しない。

## 根拠

宣言化の前後で、**メニュー操作の待ち時間・キー操作の並び**が同じであることを次で確かめた
(`docs/reports/2026-11-24-title-spec-declarative-verification.md`):
全14タイトルの MOD 統合テスト(フレーム同期、`worker/tests/mod_integration/run.py`)の合格と、
変更前後の MOD ログの契約行・フック組み込み行・Step 間の経過の比較。

## 採らなかった選択肢

- **全タイトルを1つの `TitleSpec` にし th06c・th06nc も含める**: 起動の流れの違いを `TitleSpec` の項目で表すと、
  実質タイトルごとの関数ポインタになり宣言の意味がなくなる(上の 4)。
- **フック(フィルタ・上限・fps 表示)を enum にして共通の `.cpp` で分岐する**: 共通の `.cpp` が全フックのシンボルを
  参照することになり、使わないタイトルにもモジュールをリンクしなければならない(DLL が大きくなり、`-static` や
  `check-imports` の確認対象が増える)。関数ポインタで渡せば Makefile の `thNN_MODS` がリンクを決める現状のままでよい。
- **マクロ(`DEFINE_TITLE(th10, ...)` に全項目を並べる)**: designated initializer の `TitleSpec` の方が、項目名がコードに残り、
  コンパイラが型と宣言順を検査する。
- **Makefile と `config.py` を1つの定義ファイルから生成する**: 両者は `<id>` のパターンで機械的に対応しており、
  生成の仕組みを足すコストに見合わない(上の 5)。

## 影響範囲

`worker/mods/autoplay/`・各 `thNN_replay_autoplay/dllmain.cpp`・`worker/mods/Makefile`(`BASE32` に `menu_script`・`title_main`、
th06c/th06nc に `menu_script`)・`worker/docs/mods.md` §1.1。**ワーカーの読む契約行(`core/log_contract.h`)は変えていない**ので
`worker/recording/modlog.py` は不変。タイトルを足すときは `TitleSpec` を書き、`Makefile` の `TITLES`・`thNN_MODS` に足す。
