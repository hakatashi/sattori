# th128のWINEPREFIXを`setup_wineprefix.sh`のみで作り直しても録画が壊れないことを検証

- **検証日**: 2026-09-09
- **対象**: `worker/prefixes/th128-wined3d-gl`を喪失した場合の復旧手段(Issue #78の
  レビュー指摘)。`worker/setup_wineprefix.sh`だけで作り直したWINEPREFIXで録画が
  成立するか
- **環境**: 自宅ワーカー機(HakataMatrix)、`sattori-worker:th128-test`ローカルビルド
  イメージ(`docs/reports/2026-09-09-th128-local-recording-verification.md`と同じ
  イメージ)。ゲーム本体(`games/th128`)・MODビルド成果物は touhou-recorder 由来の
  ものをそのまま流用し、**WINEPREFIXだけ**新規作成し直した
- **結論**: `setup_wineprefix.sh`のみで作り直したWINEPREFIXでも、touhou-recorder製の
  原本と同じくフル尺録画・記録スコア完全一致・重複フレーム率1.3%を確認できた。
  th128のWINEPREFIXはth06/07/08と同様、touhou-recorder側の原本に依存せず
  `setup_wineprefix.sh`のみで復旧できる

## 目的

`docs/runbooks/recover-title-assets.md`は、th11/th20のWINEPREFIXは
touhou-recorder側の原本（`prefixes/<title>-wined3d-gl`）にしか無い前提で書かれている
（追加のwined3d関連レジストリ設定等がtouhou-recorder側の環境に蓄積している可能性を
排除できていなかった）。th128についても同じ前提を置くべきか、それとも
`setup_wineprefix.sh`（`wineboot -u`初期化+MSゴシック/MS明朝のフォント登録のみ）
だけで十分かを、実際に作り直して録画することで確認する。

## 方法

1. `sattori-home-worker.service`を停止。
2. 動作実績のある`worker/prefixes/th128-wined3d-gl`（touhou-recorder由来、
   `docs/reports/2026-09-09-th128-local-recording-verification.md`で検証済み）を
   `th128-wined3d-gl.imported-backup`へ退避。
3. `setup_wineprefix.sh`で同じパスに新規WINEPREFIXを作成:
   ```bash
   cd worker
   xvfb-run -a ./setup_wineprefix.sh "$(pwd)/prefixes/th128-wined3d-gl" \
     "$(pwd)/games/assets/msgothic.ttc" "$(pwd)/games/assets/msmincho.ttc"
   ```
4. `/mnt/cache3`配下へ新規WINEPREFIX・ゲーム本体・MODビルド成果物を隔離コピーし
   `chown root:root`（`verify-recording-locally` skillの手順どおり）。
5. `record_th128.py`を直接呼び出し、前回と同じ検証用リプレイ(`th128_ud0000.rpy`、
   Hard、Route B、記録スコア22,666,770)をフル尺録画した。

## 結果

| 項目 | touhou-recorder製の原本(前回) | `setup_wineprefix.sh`のみで再作成 |
| --- | --- | --- |
| 試行回数 | 1回目で成功 | 1回目で成功 |
| 総録画時間 | 862.2秒 | 858.0秒 |
| 終了検知方式 | 画面静止検知 | 画面静止検知 |
| 重複フレーム率(録画開始15秒以降) | 1.3% | 1.3% |
| リプレイずれ事後検証 | 記録スコア(22,666,770)と一致 | 記録スコア(22,666,770)と一致 |
| thprac アタッチ | 0.6秒で成功 | 0.8秒で成功 |
| メニュー操作シーケンス | フリーズ再現せず | フリーズ再現せず |

両者は誤差の範囲で同一の結果となった。`setup_wineprefix.sh`が行うのは32bit
WINEPREFIXの初期化とMSゴシック/MS明朝のフォント登録のみだが、th128の録画に必要な
DirectX/wined3dレンダリング・DirectInput・PulseAudio連携はいずれもWineの既定設定
(`WINEARCH=win32`初期化直後の状態)で問題なく機能した。追加のレジストリ設定や
DLLオーバーライドは不要だった。

## 考察・既知の限界

- WINEPREFIXの再現性のみを検証したものであり、`games/th128`（ゲーム本体・
  `thprac.v2.3.0.3.exe`・cfg）自体の原本喪失には対応しない。ゲーム本体は
  touhou-recorderの`games/th128`が唯一の原本のままであり、この検証で不要になる
  わけではない(`docs/runbooks/recover-title-assets.md`§3の1参照)。
- 検証は単一リプレイ・単一試行のみ。Extra難易度・低速録画等はこの検証の対象外。
- 後片付け: 検証後、退避した`th128-wined3d-gl.imported-backup`は削除せず
  そのまま残置した(どちらのWINEPREFIXも動作確認済みのため、以後の
  `upload-title-assets`での資産アップロードにはどちらを使ってもよい)。
