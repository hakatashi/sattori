# 0076. MOD を共通基盤(`core/`)と機能別のディレクトリへ再編し、Present をイベントバスにする

- **状態**: 有効
- **決定日**: 2026-11-21
- **対象**: worker(`worker/mods/`)・docs
- **関連**: Issue #393、Epic #399、PR #407(#392)、touhou-recorder の `mods/common/frame_sync_hook.h`・`frame_sync_d3d11.cpp`

MOD のソースを `worker/mods/common/` から `core/`・`clock/`・`input/`・`present/`・`audio/`・`texture/`・
`monitor/`・`autoplay/`・`tools/` へ移し、IAT・vtable の書き換え、環境変数の読み取り、同期マーカー、
Present の上限、メニュー待ちの倍率をそれぞれ1か所にまとめた。**本番の挙動は変えていない**(例外は
下の「決定」の3・4で、本番で使っていない条件だけが変わる)。ビルド成果物の出力パスは変えていない。

## 背景

MOD には同じ処理のコピーが多く、少しずつ挙動が違っていた(2026-11-20 の調査、Issue #393):
IATの書き換えが10か所、vtable の書き換えが7か所(冪等性の扱いがばらばらで、二重パッチによる無限再帰を
呼び出し側の注意だけで防いでいた)、`FPS_LIMIT_TARGET_HZ` の読み取りが12か所、同期マーカーの系列と
トリガー監視が2か所、Present の上限が D3D8/D3D9 で2か所、メニュー待ちの拡縮が3系統、th06c と th06nc の
約300行。さらに #388 でフレーム同期を移植するには、Present・時計・音声に複数の処理をつなぐ口が要る
(touhou-recorder は `fps_limiter_hook.cpp` に大域の関数ポインタを足してしのいでいた)。

## 決定

1. **共通基盤**: `core/pe_iat`(名前・序数・DLL名の前方一致のIAT、`GetProcAddress` の横取りの登録表)、
   `core/vtable_hook.h`(冪等・型付き)、`core/runtime_config`(環境変数をDllMainで1回だけ読む)、
   `core/log_contract.h`(ワーカーが読むログ行の書式)、`core/code_patch`(バイト照合つきのパッチ)、
   `core/time_scale.h`(メニュー待ちと起動待ちの上限)。
2. **Present のイベントバス**(`present/bus.h`): D3D8・D3D9・DXGI の Present フックは薄いアダプタで、
   登録された前後のハンドラを優先度順に呼ぶ。前のハンドラは `kThrottle`(上限の待ちを行う、既定で立つ)と
   `kSkip`(本来の Present を呼ばない)を決める。上限(`present/limiter`)はその上に1本だけ置く。
   **#388 のフレーム同期は limiter より優先度の小さいハンドラとして登録し、`kThrottle` を落として速度を
   自分で決める**(touhou-recorder の `g_d3d9PrePresentCallback` の大域ポインタと同じ役割)。DXGI の
   アダプタ(`present/dxgi.cpp`)は #388 で使う受け皿で、まだどのタイトルにも組み込んでいない。
3. **メニュー待ちを `time_scale::MenuSleep()`(`60/FPS_LIMIT_TARGET_HZ` 倍)の1系統にした**。旧
   `MenuSleep`(倍速のときだけ `1/SPEED_HACK_MULTIPLIER`)・`ScaledSleep`(`60/FPS_LIMIT_TARGET_HZ`)・
   th06nc の `SleepScaled`(`TH06NC_TIME_SCALE × MenuSleep`)は、本番の録画の段で使う速度ではすべて同じ値に
   なる。違うのは旧 `MenuSleep` を使っていた th06・th06c・th07・th08・th10・th11・th12 の**低速録画だけ**で、
   これらのタイトルは本番で低速録画をしない(`packages/shared/src/recordingPlan.ts`)。低速録画では
   メニューのアニメーションもゲーム内時間で遅くなるので、伸ばす方が正しい(th20 で空振りした)。
4. **実時間で進む起動待ち(ウィンドウの出現・入力ポーリングの開始・起動ダイアログ)の上限は、全タイトルで
   低速録画のときだけ `60/FPS_LIMIT_TARGET_HZ` 倍に伸ばす**(`time_scale::StartupTimeout()`)。かつては th09
   だけの例外だった(低速録画で起動が30秒を超えた、touhou-recorder reports/68)。倍速では縮めない
   (2倍速で th09 の起動待ちを縮めて本番E2Eでタイムアウトした、Issue #288)。変わるのはタイムアウトの
   長さだけで、成功する録画の挙動は変わらない。
5. **`TH06NC_TIME_SCALE` を廃止した**。本番では `record_th06nc.py` が低速録画のときに `60/FPS_LIMIT_TARGET_HZ`
   を渡しており、MOD が同じ値を `FPS_LIMIT_TARGET_HZ` から導けるので、出所を1つにした
   (`recording/config.py` の `SPEED_HACK_MULTIPLIER` と同じ方針)。手動の検証で fps が極端に落ちる環境の
   ために使っていた用途(`verify-game-update` skill)は、検証専用の `MENU_WAIT_EXTRA_SCALE` が引き継ぐ。
6. **ログの契約**(`Step N:`・`sequence complete`・`WaitForStableWindow: stable`・`ScoreMonitor: ...`・
   `SYNC_MARKER played ...`)を `core/log_contract.h` の書式にまとめ、`LogStep()`・`LogSequenceComplete()`
   で出す。`mods/tests/log_contract_golden.txt` を MOD 側(`make test`)とワーカー側
   (`worker/tests/test_mod_log_contract.py`)の両方が読み、同期マーカーの系列も
   `mods/tests/sync_marker_golden.txt` で両側を突き合わせる。
7. **Makefile を宣言化した**: タイトルごとに `ARCH`・使うモジュール・`-static` を書き、規則はパターンから
   組み立てる。CI は `make all check`(`-Werror`・インポートの検査・単体テスト)を実行する。
8. **言語は C++20 のまま**(Epic #399 で決定済み)。タイトル定義の宣言化(`TitleSpec`)は #394 で扱う。

## 根拠

- 変更前後で MOD 統合テストの契約行が一致し、代表タイトルの実録画の品質判定が変わらないことを
  確かめた([`docs/reports/2026-11-21-mod-core-refactor-verification.md`](../reports/2026-11-21-mod-core-refactor-verification.md))。
- 変更前後の DLL のインポート(DLL名)は全17ファイルで同じだった。
- 3・5 で値が変わらないことは `mods/tests/test_clock.cpp` の `MenuScaleIsSixtyOverTargetHz` で確かめている
  (`60/120 = 1/2`、`60/30 = 2` など、旧3系統の値と一致する)。

## 採らなかった選択肢

- **旧 `MenuSleep` の「低速録画では伸ばさない」を残す**: タイトルごとに倍率の式が違う状態が残り、#391
  (CPU低速録画の削除)と #394 の妨げになる。本番で違いが出ない以上、正しい方に揃えた。
- **起動待ちの延長を th09 だけに残す**: 低速録画で起動が遅くなるのは th09 固有ではない(Present の上限で
  CPUを占有するのはどのタイトルも同じ)。
- **`TH06NC_TIME_SCALE` を残す**: 本番では値が `FPS_LIMIT_TARGET_HZ` から決まるので、2つを渡すと食い違ったときに
  ワーカーから検知できない。
- **vtable の書き換えで「最初の元関数を保持する」(旧 WASAPI 版)**: Wine の実装では対象の vtable が1つなので
  「上書きする」版と結果は同じ。上書きする版(旧 dinput/D3D/dsound/BC7 版)に揃えた。
- **DXGI のアダプタを書かずに #388 へ回す**: バスの設計が D3D9 に寄りすぎていないかを確かめる意味で、
  touhou-recorder の `frame_sync_d3d11.cpp` の経路(D3D11CreateDevice → ファクトリ → CreateSwapChain)を
  なぞったアダプタを置いた。組み込むときに実機で確かめること。

## 影響範囲

- 旧ファイルとの対応: `common/logging.*` → `core/log.*`、`common/speed_hack_hook.*` → `clock/speed_hack.*`、
  `common/fps_display_hook.*` → `clock/fps_display.*`、`common/dinput_hook.*` → `input/dinput.*`、
  `common/fps_limiter_hook.*`・`fps_limiter_hook_d3d8.*` → `present/limiter.*`・`present/d3d9.cpp`・
  `present/d3d8.cpp`、`common/dsound_hook.*` → `audio/dsound.*`、`common/wasapi_hook.*` → `audio/wasapi.*`、
  `common/d3dx_filter_hook.*` → `texture/d3dx_filter.*`、`common/d3d11_bc7_hook.*` → `texture/d3d11_bc7.*`、
  `common/bc7_decode.h` → `texture/bc7_decode.h`、`common/score_monitor.*` → `monitor/score_monitor.*`、
  `common/window_wait.*` → `autoplay/window_wait.*`、`common/menu_wait.h` → `core/time_scale.h`、
  `common/injector.cpp` → `tools/injector.cpp`、`steam_stub/steam_api_stub.cpp` → `tools/steam_stub.cpp`。
  **これより前の決定記録・検証記録の `mods/common/...` はこの表で読み替える**。
- ワーカーが読むログ行を変えるときは `core/log_contract.h` とゴールデンを同時に直す。
- メニュー待ち・起動待ちの倍率を変えるときは `core/time_scale.h` だけを直す(タイトル側で計算しない)。
- ソースの構成: [`worker/docs/mods.md`](../../worker/docs/mods.md)。ビルド: `build-mods` skill。
