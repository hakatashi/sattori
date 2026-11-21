# フェーズ75: th06cのフル尺録画検証・スコアRVA特定・メニューカーソル追従方式への変更

フェーズ74(環境構築・Steam要求回避・MOD実装)の続き。`scripts/25` への統合、通常ステージ・
Extraのフル尺録画、スコア変数の特定とデシンク判定、およびユーザーから追加指示のあった
2項目(クリーンセーブでの自動操作、`th6_ud0000.rpy` の認識)を検証した。

## 1. `scripts/25` への統合

`GAME_CONFIGS["th06c"]` を追加。既存タイトルと異なり以下の対応が必要だった。

| 追加した仕組み | 理由 |
|---|---|
| `cfg["injector"]` (既定 `injector.exe`) | th06c.exeが64bitのため `injector64.exe` を使う必要がある |
| `cfg["extra_files"]` | rsync後に正規の `steam_api64.dll` をスタブで上書きする(フェーズ74) |
| `cfg["window_min_size"]` (既定 100x100) | 起動ダイアログ(194x317)を本体ウィンドウと誤検出しないための足切り |
| `--game` の `choices` を `GAME_CONFIGS` から生成 | 新規タイトル追加時の書き漏れ防止 |

### ウィンドウ座標: (0,0)強制移動を使わない

既定の `XVFB_SCREEN`(800x600)では、openboxの初期配置(x=77, y=44)で640x480ウィンドウが
画面内に収まらず、「検出後(0,0)への強制移動」が必ず走る。ところがth06cでこの移動を行うと、
**`xwininfo` は移動後の座標を (0,0) と報告するのに、実際の描画内容はウィンドウ装飾
(タイトルバー)分だけ下にずれたままになり、録画映像にタイトルバーが写り込む**
(th09の既知不具合と同じ症状、`reports/68` 参照)。

対策として `xvfb_screen` を `1400x1100x24` に拡大し、`skip_origin_move_if_fits: True` で
移動自体をスキップする構成にした。この状態でウィンドウは x=377, y=294 に配置され、
クロップは640x480ちょうど・タイトルバーの写り込み無しになることを実機で確認した。

```
[RESULT] game=th06c 総録画=33.4s 計測区間=15..28s 重複フレーム率=0.0%
```

### MOD側に追加したもの

* `WaitForStableWindow`: `scripts/25` が録画開始の合図として待つ
  `WaitForStableWindow: stable` を出す。`mods/common/window_wait.cpp` は
  `dinput_hook.h`(GetDeviceStateフック)に依存していて流用できないため、
  **起動ダイアログ(クラス `#32770`)とクライアント幅320px未満のウィンドウを除外する**
  独自実装をth06c MOD内に置いた。
* `FpsMonitorThread`: 出力形式を `mods/common/fps_monitor.cpp` と完全に同じ
  (`FpsMonitor: %ld GetDeviceState calls in %lu ms (%.1f Hz)`)にしてあり、
  `scripts/25` の `FPS_MONITOR_HZ_RE` によるfps暴走検知がそのまま効く。

## 2. スコア変数のRVA特定

th06cはオリジナルth06の完全な再実装であり、**thpracのth06用RVAは一切流用できない**。
また64bitのため `mods/common/score_probe_hook.*`(32bit・固定RVA範囲の差分スキャン)も
使えないため、MOD内に「既知の値を全コミット済みRWメモリから探す」プローブ
(`ScanForValue`、環境変数 `TH06C_FIND_VALUE` / `TH06C_FIND_DELAY_MS` /
`TH06C_FIND_REPEAT` / `TH06C_FIND_INTERVAL_MS`)を実装した。

### 手順と結果

`th6_03.rpy`(Lunatic、記録スコア 247,920、27秒)を再生し、再生開始15秒後から8秒間隔で
8回スキャンした。

```bash
rsync -a --exclude=replay games/th06c/ instances/th06c-test/
cp games/th06c/replay/th6_03.rpy instances/th06c-test/replay/th6_01.rpy
export TH06C_FIND_VALUE=247920 TH06C_FIND_DELAY_MS=15000 \
       TH06C_FIND_REPEAT=8 TH06C_FIND_INTERVAL_MS=8000
scripts/74_run_th06c.sh --timeout 30 --wait 110 injector64.exe th06c.exe th06c_hook.dll
```

| RVA | 挙動 |
|---|---|
| `module+0x003A3B4C` | リプレイ終了後に記録スコアと一致。**内部スコア(即時加算される真の値)** |
| `module+0x003A3B50` | 同上。実測では画面表示用の追いかけ値(集計アニメーション中は遅れる) |
| `module+0x00B63B74` | **再生開始前から**記録スコアと一致 → リプレイファイルから読んだ記録スコアの保持場所。再生の正しさの検証には使えない |

`0x003A3B4C`(内部スコア)を採用し、`ScoreMonitorThread` で1秒間隔でサンプリングして
`scripts/53_verify_replay_score.py` が読む形式でログ出力する。

```
ScoreMonitor: score=1126970 stage=-1 lives=-1 graze=-1 epoch_ms=... displayed=1126970
```

**スコアの倍率は等倍(×1)**。オリジナルth06と同じ。

**ステージ番号・残機・グレイズのRVAは未特定**のため `-1`(未監視の番兵)を出す。
これに伴い `scripts/53_verify_replay_score.py` の `drop_garbage_samples()` が
`graze=-1` を「ゴミ値」として全サンプル除外してしまう問題があったので、
`graze == -1` はフィルタ対象外とする修正を入れた(0にしないのは「グレイズ0の正当な
サンプル」と区別できなくなるため)。

## 3. メインメニューのカーソル追従方式

### 経緯

フェーズ74では「Extra解放済みセーブなら Down x3 で Replay」と決め打ちしていたが、
ユーザーから以下の指摘があった。

> ゲームがクリーンな状態でも、メニュー画面に「Extra Start」は常に表示されます。
> Extraステージが解放されていない状態でExtra Startにカーソルを合わせようとすると、
> スキップされて1つ下の項目が選択されるのが想定される挙動です。

実機で確認したところ、そのとおりだった。メニュー項目は解放状況によらず常に9つ表示される。

```
0 Start / 1 Extra Start / 2 Practice Start / 3 Replay / 4 Score /
5 Music Room / 6 Option / 7 License / 8 Quit
```

* Extra解放済み: `0 -> 1 -> 2 -> 3` (Down x3 で Replay)
* クリーンセーブ: `0 -> 2 -> 3` (**Down x2 で Replay**。index 1 がスキップされる)

つまり固定回数のDownはセーブデータの状態で破綻する。

### カーソル位置変数の特定

MODに絞り込みスキャン(`NarrowMenuCandidates`、`TH06C_SEQ=menuprobe`)を実装した。
`.data` セクション内のDWORDのうち、カーソルを1つずつ動かしながら期待値と一致し続ける
アドレスだけを残していく方式。

最初は「カーソルが Start(=0) の状態」を初回スキャンの基準にしたが、`.data` の未使用領域が
すべて候補になり上限(200,000件)に達して破綻した。**Downを1回押して値1になった状態を
初回スキャンの基準にする**ことで候補が4,134件まで減り、以後の絞り込みで一意に決まった。

```
[menu] 初回スキャン(値=1): 候補 4134 件
[menu] 絞り込み(値=2): 残り 1 件
[menu]   候補 module+0x00B5C168
[menu] 絞り込み(値=3〜6): 残り 1 件(同上)
```

**`module+0x00B5C168` がメインメニューのカーソル位置**(0始まりのインデックス)。

### 実装

`NavigateToReplay()` で、カーソル位置を読みながら `Replay`(index=3)に一致するまで
Downを送る(最大12回)。これならスキップされる項目が増減しても正しく到達できる。

実機確認:

| セーブデータ | ログ |
|---|---|
| Extra解放済み | `Down 1回目: index 0 -> 1` / `2回目: 1 -> 2` / `3回目: 2 -> 3` |
| クリーン(score.dat削除) | `Down 1回目: index 0 -> 2` / `2回目: 2 -> 3` |

どちらも `th6_ud0000.rpy` の再生が完走し、最終スコアが記録スコア(1,126,970)と一致した。

## 4. ユーザー追加検証項目

### 4.1 クリーンなセーブデータでの自動操作 → 問題なし

`instances/th06c-test/score.dat` を削除して起動。上記のカーソル追従方式により
自動操作は成功する(固定Down回数の実装のままだと `Score` に行き過ぎて失敗していた)。

### 4.2 `th6_ud0000.rpy` の認識 → 問題なし

`replay/th6_ud0000.rpy` として配置したところ、リプレイ一覧に `No.04 koyi ...` として
正しく表示され、再生も完走した(最終スコアも記録値と一致)。

th06c.exeは `FindFirstFileA` / `FindNextFileA` を静的インポートしており、文字列にも
`./replay/%s` があることから、**`th6_%.2d.rpy` のような固定の連番名ではなく
`./replay` ディレクトリを列挙する実装**になっているためと考えられる。
`scripts/25` の `replay_dest_filename` によるファイル名正規化(th11/th12/th20系で必要)は
th06cでは不要。

## 5. フル尺録画

### 5.1 通常ステージ(Hard)

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th06c --replay th6_01.rpy \
    --output runs/th06c_verification/th06c_hard_full.mp4
```

| 項目 | 値 |
|---|---|
| リプレイ | `th6_01.rpy` (Hard / ReimuA / koyi、記録スコア 114,250,700、93,403フレーム) |
| 総録画時間 | 1568.8秒 |
| 終了検知 | 画面静止検知(正常動作) |
| 重複フレーム率(録画全体、15秒以降1540秒) | **2.7%** |
| 実測再生時間(映像から測定) | 6.5秒〜1545.2秒 = **1538.7秒** |
| 理論尺(93,403 / 60) | 1556.72秒 |
| 理論尺比 | **−1.16%** |

### 5.2 Extraステージ

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th06c --replay th6_04.rpy \
    --output runs/th06c_verification/th06c_extra_full.mp4
```

| 項目 | 値 |
|---|---|
| リプレイ | `th6_04.rpy` (Extra / ReimuA / koyi、記録スコア 84,613,650、36,849フレーム) |
| 総録画時間 | 642.3秒 |
| 終了検知 | 画面静止検知(正常動作) |
| 重複フレーム率(録画全体、15秒以降620秒) | **6.2%** |
| 実測再生時間(映像から測定) | 6.5秒〜619.4秒 = **612.9秒** |
| 理論尺(36,849 / 60) | 614.15秒 |
| 理論尺比 | **−0.19%** |
| スコア判定 | `scripts/53_verify_replay_score.py --game th06c` → **一致(デシンクなし)** |

### 5.3 【重要】th06cでは理論尺比較に系統的なマイナス側の差が出る

両方とも**理論尺より短い**(Hard −1.16%、Extra −0.19%)。処理落ちなら理論尺を
「超過」するはずで、マイナスは物理的におかしい。調べたところ、差はステージ数に比例していた。

| リプレイ | ステージ数 | 理論尺との差 | 1ステージあたり |
|---|---|---|---|
| th6_01 (Hard) | 6 | −18.0秒 | 約 −3.0秒 |
| th6_04 (Extra) | 1 | −1.2秒 | 約 −1.2秒 |

`@sattori/touhou-replay-parser` が返す `frameCount` は**ステージごとの `frameCount` の単純合計**
(th6_01 = 9110+12156+15128+19951+18262+18796 = 93403)であり、各ステージの記録フレーム数には
再生時に実際には描画されない末尾分が含まれていると見られる。

**よってth06cでは「理論尺比較」は絶対値ではなく“超過方向のみ”の検出に使うこと。**
今回はどちらも超過しておらず、**処理落ちによる間延びは検出されなかった**。

なお、Extraの重複フレーム率6.2%は他タイトルの基準ではやや高めだが、理論尺を超過していない
(−0.19%)ことから、これは「同一内容のフレームが連続して描画されている」だけで
処理落ちではないと判断した(`reports/67` の逆パターン。重複フレーム率と理論尺比較は
必ず併用すること)。

## 6. 音ズレ確認

`scripts/25` の既定どおり、映像(x11grab)と音声(pulse)を別プロセスで録画して
実測レイテンシ差で後muxしている。

```
A/V同期補正: video_start=1789034313.666 audio_start=1789034313.632
             delta=-0.034s (video_offset=0.034s audio_offset=0.000s)
```

| 検証 | 結果 |
|---|---|
| 音声の実体 | 全体RMS 7030(無音ではない)、2秒〜640秒まで連続して音がある |
| 尺のドリフト | 映像 641.717秒 / 音声 641.744秒 → 差 **27ms(642秒中0.004%)**。ドリフトなし |
| イベント一致 | リプレイ終了時の白フラッシュ(映像 619.3〜619.4秒)と BGMフェード開始(音声 619.4秒直後にRMSが5503→2515→307→0へ減衰)が**0.1秒の分解能で一致** |

音ズレは検出されなかった。

## 7. 再現手順

```bash
# ビルド(mingw-w64 x86_64クロスビルド)
./mods/th06c_replay_autoplay/build_mingw.sh

# 起動実験(Xvfb :90、wine後片付け付き)
scripts/74_run_th06c.sh --timeout 30 --wait 100 injector64.exe th06c.exe th06c_hook.dll

# 本番相当の録画(Xvfb :89)
python3 scripts/25_record_replay_e2e_multigame.py --game th06c --replay th6_01.rpy \
    --output runs/th06c_verification/th06c_hard_full.mp4

# デシンク判定
python3 scripts/53_verify_replay_score.py --game th06c \
    games/th06c/replay/th6_04.rpy \
    instances/th06c-multigame-recording-test/th06c_autoplay.log \
    --record-log /tmp/th06c_full_extra.log
```

### 診断用の環境変数(MOD側)

| 変数 | 用途 |
|---|---|
| `TH06C_SEQ=none` | ダイアログを閉じるだけで60秒放置 |
| `TH06C_SEQ=enter` | Enterを1回だけ押して30秒放置 |
| `TH06C_SEQ=enterdown` | Enter → 5秒 → Down 1回 → 20秒放置 |
| `TH06C_SEQ=menuprobe` | メニューカーソル位置変数の絞り込みスキャン |
| `TH06C_FIND_VALUE=<10進>` | 指定値を全コミット済みRWメモリから探索(スコアRVA特定用) |

## 8. 残課題

* **低速録画(1/2倍速)が未実装**。th06cはD3D11経路のため、`mods/common/fps_limiter_hook.h`
  (D3D9専用)・`fps_limiter_hook_d3d8.h` のいずれも使えず新規実装が必要
* **ステージ番号・残機・グレイズのRVAが未特定**(スコアのみ実装済み)。
  ステージ番号が取れないため `.chapters.txt` の出力(`reports/49`)にも未対応
* **リプレイ終了検知はテンプレート照合が使えるはず**。th06cはリプレイ終了後に
  内容非依存の「瀟洒なるリプレイを見よう!」画面へ戻ることを実機確認済みなので、
  `assets/replay_end_templates/th06c.png` を用意すれば終了検知を高速化できる
  (現状は画面静止検知のみで、終了まで16秒余分にかかる)
* **AWSクラウド実機検証が未実施**(ユーザー指示により今回はローカル検証までのスコープ)
* メニュー表示のまま放置すると**20〜30秒でアトラクトデモに戻る**。通常のシーケンスは
  数秒で完了するため実害はないが、MODのタイムアウトを延ばす際は注意
