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
  fps計測スレッド(`fps_monitor.*`)のソース(C++)。5秒毎に`FpsMonitor: N GetDeviceState
  calls in M ms (H.H Hz)`をMODログへ出力し続けるが、これを読んで異常判定・自動リトライに
  使うPython側のロジックは真陽性の実績が無く偽陽性のみだったため削除済み
  ([`decisions/0043`](../../docs/decisions/0043-remove-fps-runaway-detection.md))。ログ出力
  自体は将来の調査用診断情報として残してある |
| `mods/thNN_replay_autoplay/` | タイトルごとの自動再生フック DLL(`thNN_hook.dll`)のソース(C++)。
  組み込むフックの違いは各タイトルの背景ファイル([`titles/`](titles/README.md))を参照 |

## 2. 録画速度(`worker/README.md` §5)・A/V同期まわりのフック

いずれも`FPS_LIMIT_TARGET_HZ`・`SPEED_HACK_MULTIPLIER`が未設定(等倍)なら従来動作と互換。

| ソース | 役割 |
| --- | --- |
| `mods/common/speed_hack_hook.*` | 倍速録画(Issue #288)の本体。`QueryPerformanceCounter`
  (と、`SPEED_HACK_TIMERS`指定時は`timeGetTime`/`GetTickCount`)の経過時間を
  `SPEED_HACK_MULTIPLIER`倍に伸ばし、ゲームに「時間がN倍速く進んだ」と思わせる
  (touhou-recorder reports/85)。全32bitタイトルのMODに組み込み、64bitのth06c/th06ncは
  `GetProcAddress`経由の取得を`WrapQueryPerformanceCounterForSpeedHack()`で差し替える |
| `mods/common/fps_limiter_hook.*` | `IDirect3DDevice9::Present`のvtableフックによるフレーム
  レート制限(reports/46)。目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60)。低速録画の実装基盤で、
  倍速録画ではPresentの上限を`60×倍率`へ引き上げる |
| `mods/common/fps_limiter_hook_d3d8.*` | 上記のDirect3D8版(`IDirect3DDevice8::Present`、
  vtable番号はD3D9よりCreateDeviceが1つ・Presentが2つ小さい)。th09で使う
  ([titles/th09.md](titles/th09.md)) |
| `mods/common/dsound_hook.*` | 音声の再生周波数を`FPS_LIMIT_TARGET_HZ/60`倍にスケールする
  (`SetFrequency`フック、低速録画 reports/47・倍速録画 reports/89)。あわせて**同期マーカー**
  (reports/88)を鳴らす: `SYNC_MARKER_TRIGGER`のファイルが置かれたら、ゲーム自身の
  DirectSoundデバイスから-42dBFS・約3秒の疑似乱数ノイズを再生し、再生直前の壁時計時刻を
  `SYNC_MARKER played ...`としてMODログへ出す(`recording/sync_marker.py`が読む)。等倍でも有効 |
| `mods/common/wasapi_hook.*` | th06c/th06nc(DXライブラリ、音声はWASAPI)向けの`dsound_hook`相当。
  `IAudioClient::GetMixFormat`のレートを1/倍率に見せ、`Initialize`で倍率ぶん戻して実ストリームを
  開く。同期マーカーは`IAudioRenderClient::ReleaseBuffer`で出力バッファへ足し込む(reports/89・90) |
| `mods/common/fps_display_hook.*` | 画面に焼き付くfpsカウンター表示だけを等倍相当へ補正する
  (reports/48)。`speed_hack_hook`が同じAPIを偽装済みの場合はその倍率を割り戻す(二重補正で
  th12/th20が「30fps」になった、reports/90)。**`InstallSpeedHackHook()`の後に呼ぶこと**。
  th06/th08はfps計算が`timeGetTime`なのでtimeGetTime版を使う |

## 3. スコア監視(デシンク事後検知)

| ソース | 役割 |
| --- | --- |
| `mods/common/score_monitor.*` | ゲーム内スコア・ステージ番号・残機・グレイズの定期サンプリング
  (reports/50、Issue #103)。`recording.modlog.check_replay_desync()`が録画成功直後にMODログの
  スコア推移と`replayInfo.score`を突き合わせてリプレイずれ(デシンク)の疑いを判定する
  (`JobRecord.desyncDetected`、自動リトライはしない)。RVAはタイトル毎に`dllmain.cpp`で指定
  (baseRva+baseIsPointer+フィールドオフセット/幅の汎用設計)。th09を除く8タイトルで実機
  動作確認済み
  ([`docs/reports/2026-08-25-th07-score-monitor-fix.md`](../../docs/reports/2026-08-25-th07-score-monitor-fix.md)、
  `docs/known-limitations.md`参照。th07だけはSattoriが配布するth07.exeが当初の検証環境と
  バイナリが異なりゲームデータのバージョン差でRVAの再特定を要した。th10はtouhou-recorder
  reports/57、th12はtouhou-recorder reports/62、th128はtouhou-recorder reports/71で
  別途確認)。**th09だけはスコアのRVAが
  未特定のため`scoreWidth=0`でスコア読み取りを無効化し、life(残機)のみ監視する**
  ([titles/th09.md](titles/th09.md)参照) |
| `mods/common/score_probe_hook.*` / `stage_probe_hook.*` | RVA特定用の診断専用コード(本番ビルドには
  含めない)。score_monitorのRVAが通用しないタイトル・ゲームバージョンが出た場合の再調査に使う |
