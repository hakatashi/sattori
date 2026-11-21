# フェーズ18: 録画へのウォーターマーク合成検証

日付: 2026-07-16

## 目的

試作されたウォーターマーク動画(`/home/hakatashi/Documents/GitHub/agent-playgrounds/watermark-webm-export/output/watermark-60fps.webm`、574x192・60fps・6秒・VP9/webm、フェードイン→表示→フェードアウトするロゴバッジ)を、th07リプレイ録画の冒頭・画面右下に合成しながら録画できるか検証する。

## 結論(要約)

- **ffmpegの`overlay`フィルタで、x11grab(映像)+pulse(音声)+webm(ウォーターマーク)の3入力を単一パスでリアルタイム合成・エンコードできることを実機(th07・Xvfb)で確認した**。既存の録画パイプライン(`scripts/11_record_th07_replay_e2e.py`)への組み込みは`-i`の追加と`-filter_complex`の追加のみで、他のロジック(終了検知等)に変更は不要
- **重要な発見: ウォーターマークのwebmファイル自体は正しくアルファチャンネル(VP9のBlockAdditional side data、`alpha_mode=1`)を持っているが、ffmpegのデフォルト(ネイティブ)VP9デコーダはこのアルファをデコード時にマージせず、常に不透明(255)として扱ってしまう**。`-c:v libvpx-vp9`でlibvpx経由のデコーダを明示指定することで正しくアルファが読み込め、`colorkey`等の近似的な黒抜き処理を使わずに元デザイン通りの半透明合成ができる
- ウォーターマーク動画(6秒)の終了後は`overlay`に`eof_action=pass`を指定することで、以降は自動的に元映像のみが素通しされる(ウォーターマーク動画をループさせたり、録画全体をウォーターマーク動画の長さに合わせて打ち切ったりする必要はない)
- th07のウィンドウ解像度(640x480)に対しては、ウォーターマークを横190px程度にスケールダウンすると右下に収まりのよいサイズになる

## 検証手順

1. `ffprobe`でウォーターマークのメタデータを確認。574x192, 60fps, 6秒, VP9, `TAG:alpha_mode=1`
2. デフォルトデコーダでPNGフレームを抽出したところ、全フレームでalphaチャンネルが255固定だった。中身を目視すると、透明にしたい領域も黒(0,0,0)で塗りつぶされた状態で出力されていた
3. `ffprobe -show_packets`で各パケットに`side_data_type=Matroska BlockAdditional`が存在することを確認し、ファイル自体にはアルファ情報が埋め込まれていると判断
4. `-c:v libvpx-vp9`を明示してPNGフレームを再抽出したところ、alpha値が0〜255の範囲で正しく変化することを確認(原因特定)
5. ダミー背景(`color`フィルタ)+ダミー音声(`sine`)+ウォーターマークの3入力を`overlay`フィルタで合成し、`libx264`+`aac`でmp4にエンコードするテストを実施。フェードイン・表示・フェードアウトの各タイミングでのフレームを目視確認し、想定通りの見た目(角丸バッジがゲーム画面に自然に重なる)であることを確認
6. `scripts/11_record_th07_replay_e2e.py`をベースに、ウォーターマーク合成用の`-filter_complex`を追加し、録画開始から固定秒数(既定25秒)で強制停止する検証専用スクリプト`scripts/18_watermark_overlay_verification.py`を作成
7. 実機(Xvfb `:97`、th07 wined3d-gl prefix)でth07タイトル画面から20秒間録画し、実際のゲーム画面にウォーターマークが合成されることを確認。フェード完了後(6秒以降)は元映像のみに戻ることも確認

## 使用したffmpegコマンド(実機検証で使用した実際のコマンド)

```
ffmpeg -y \
  -f x11grab -draw_mouse 0 -video_size 640x480 -framerate 60 -i :97+3,29 \
  -f pulse -i auto_null.monitor \
  -c:v libvpx-vp9 -i watermark-60fps.webm \
  -filter_complex "[2:v]scale=190:-1[wm];[0:v][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]" \
  -map "[v]" -map 1:a \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  output.mp4
```

## 未検証・今後の課題

- クラウド環境(4vCPU下限、フェーズ17で判明した重複フレーム率の問題)における`overlay`+`colorkey`不要のアルファ合成フィルタ追加分のCPU負荷影響は未計測。フィルタ自体は190x64程度の小画像合成のみで軽量なはずだが、本番導入前にクラウド実機で重複フレーム率への影響を計測すべき
- 今回はタイトル画面のみ・20秒の短時間検証。実際のリプレイ本編中(激しい弾幕描画と同時)での見え方・パフォーマンス影響は未検証
- ウォーターマークの表示位置・サイズ・不透明度はデフォルト値(横190px、右下8pxマージン)で仮決めしたのみ。最終的なブランディング上の仕様はユーザー判断待ち
- `scripts/18_watermark_overlay_verification.py`は検証専用(固定秒数で強制停止、終了検知なし)。本番導入する場合は`scripts/11_record_th07_replay_e2e.py`本体の`ffmpeg_cmd`組み立て部分を同様に改修する必要がある
