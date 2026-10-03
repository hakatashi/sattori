# th12の倍速録画で画面上のfps表示が120になる問題の修正（ローカル検証）

Issue #288。本番E2E（`2026-10-02-speedup-production-e2e.md` §3）で見つかった未修正事項への対応。

## 原因の切り分け（HakataMatrix、Xvfb・CPU描画、2倍速、`worker/tests/fixtures/mod-integration/th12/th12_02.rpy`）

| 条件 | 画面のfps表示 |
| --- | --- |
| 本番と同じ構成（`CalcFPS=0`） | 119.7 |
| `SPEED_HACK_TIMERS=qpc,tgt,tick`（全タイマー偽装） | 119.7 |
| `CalcFPS=1` | 119.9 |
| `CalcFPS`キー無し | 119.8 |

- th12のVsyncPatch(`vpatch_th12.dll`)は`CalcFPS`の文字列を持つが、th12では表示に影響しない。
  どのタイマーを偽装しても変わらないので、表示値はvpatchが自前の実時間タイマーで書いている。
- 表示関数は`th12.exe`のRVA `0x1cc9e`（`%2.1ffps`を参照する関数）で、`[eax+0x34]`のfloatを
  読んで表示する（th12.exeを逆アセンブルして特定）。recorder（VsyncPatch無し）で60表示だったのは、
  この値をゲーム本体がQPCで計算していたため。

## 修正

`worker/mods/th12_replay_autoplay/dllmain.cpp`の`InstallFpsDisplayScalePatch()`。上記の`fld`の直後に
係数`60/FPS_LIMIT_TARGET_HZ`を掛けるコードを実行時に差し込む（倍速時のみ。等倍では入れない）。

## 結果

2倍速で59.8fps・59.5fps表示（修正前119.7）。記録スコア一致（`desyncDetected: false`）、重複フレーム率
1.6%、ログ`InstallFpsDisplayScalePatch: OK (factor=0.5000)`。本番（GPU）での確認はデプロイ後に行う。
