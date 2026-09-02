# MOD(`mods/`)のソース構成

ゲームプロセスへ注入する C++ 製フック DLL とインジェクタの参照仕様。**フックを足す・
移植する・RVA を特定し直すときに、どのソースが何を担っているかをここで確かめること。**
ビルド手順は `build-mods` skill、タイトルごとに組み込むフックの違いは
[`titles/thNN.md`](titles/README.md)、ワーカー全体の構成は [`worker/README.md`](../README.md) §2。

`mods/` 配下はソースとビルドスクリプトのみ管理する(元は `touhou-recorder` の PoC 由来)。
ビルド成果物(`injector.exe`・`thNN_hook.dll`)はリポジトリに含めず、タイトル資産アーカイブ
として S3 へ置く(`worker/README.md` §8)。

## 1. 共通・タイトル別のソース

| ソース | 役割 |
| --- | --- |
| `mods/common/` | DLL インジェクタ(`injector.exe`。複数DLLの順次注入に対応)・共通フック処理・
  fps計測スレッド(`fps_monitor.*`、fps暴走検知用、reports/22)のソース(C++) |
| `mods/thNN_replay_autoplay/` | タイトルごとの自動再生フック DLL(`thNN_hook.dll`)のソース(C++)。
  組み込むフックの違いは各タイトルの背景ファイル([`titles/`](titles/README.md))を参照 |

## 2. 低速録画(`worker/README.md` §5)まわりのフック

| ソース | 役割 |
| --- | --- |
| `mods/common/fps_limiter_hook.*` | `IDirect3DDevice9::Present`のvtableフックによるフレーム
  レート制限(reports/46)。目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60)。低速録画の実装基盤 |
| `mods/common/fps_limiter_hook_d3d8.*` | 上記のDirect3D8版(`IDirect3DDevice8::Present`、
  vtable番号はD3D9よりCreateDeviceが1つ・Presentが2つ小さい)。th09のMODに組み込み済みだが
  `SLOW_MOTION_SUPPORTED_GAME_IDS`未登録のためユーザーには未公開(Issue #101で他タイトルへ
  展開する際にそのまま使える、[titles/th09.md](titles/th09.md)) |
| `mods/common/dsound_hook.*` / `fps_display_hook.*` | 低速録画時に音声を同じ比率へスローダウン
  させる(`SetFrequency`フック、reports/47)／画面に焼き付くfpsカウンター表示だけを等倍相当へ
  補正する(reports/48) |

## 3. スコア監視(デシンク事後検知)

| ソース | 役割 |
| --- | --- |
| `mods/common/score_monitor.*` | ゲーム内スコア・ステージ番号・残機・グレイズの定期サンプリング
  (reports/50、Issue #103)。`recording.modlog.check_replay_desync()`が録画成功直後にMODログの
  スコア推移と`replayInfo.score`を突き合わせてリプレイずれ(デシンク)の疑いを判定する
  (`JobRecord.desyncDetected`、自動リトライはしない)。RVAはタイトル毎に`dllmain.cpp`で指定
  (baseRva+baseIsPointer+フィールドオフセット/幅の汎用設計)。th09を除く7タイトルで実機
  動作確認済み
  ([`docs/reports/2026-08-25-th07-score-monitor-fix.md`](../../docs/reports/2026-08-25-th07-score-monitor-fix.md)、
  `docs/known-limitations.md`参照。th07だけはSattoriが配布するth07.exeが当初の検証環境と
  バイナリが異なりゲームデータのバージョン差でRVAの再特定を要した。th10はtouhou-recorder
  reports/57、th12はtouhou-recorder reports/62で別途確認)。**th09だけはスコアのRVAが
  未特定のため`scoreWidth=0`でスコア読み取りを無効化し、life(残機)のみ監視する**
  ([titles/th09.md](titles/th09.md)参照) |
| `mods/common/score_probe_hook.*` / `stage_probe_hook.*` | RVA特定用の診断専用コード(本番ビルドには
  含めない)。score_monitorのRVAが通用しないタイトル・ゲームバージョンが出た場合の再調査に使う |
