# 出力ファイル（`convert.py`・S3キー）

録画後の配信用変換（1パスで何をまとめて行うか）、アップロードする動画が1本か2本か、
S3キーごとの中身と保持の参照仕様。変換処理・出力キー・DynamoDBの`outputPath*`を触る前に
読むこと。[`worker/README.md`](../README.md) §4 から分けた。

録画完了後に `convert.py` で配信用に変換する(同時録画中の変換は4vCPU構成で重複フレーム率
を悪化させるため採用しない、reports/21)。変換は1回の ffmpeg 呼び出しで、次をまとめて行う:

- **リプレイ再生区間外のカット**(Issue #266): 再生を確定するキーの1秒前(ゲーム内時間)から
  終了検知の連続一致が始まったフレームまでを残す。範囲は録画スクリプトが`--cut-result-path`の
  JSONで渡す(`recording/cut.py`、[`decisions/0059`](../../docs/decisions/0059-cut-range-decided-by-recorder.md))
- 等倍への戻し(倍速録画、[`recording-speed.md`](recording-speed.md))
- 解像度の引き上げ: 高さ720px未満は720pへ、720px超1080px未満は1080pへ(YouTube対策、
  `convert.py`の docstring)。ちょうど720p・1080pの録画はそのまま
- ウォーターマークの合成(動画の冒頭6秒)
- 映像・音声とも0秒始まりに揃える(音声の先頭の遅れは実際の無音で埋める。MP4の空編集にすると
  ブラウザによっては音ズレする、Issue #301)

**アップロードするファイルが1本か2本かは録画の内容で決まる**(`convert.needs_separate_raw_output()`):

| 録画 | 配信版 | 元の解像度版 | 理由 |
| --- | --- | --- | --- |
| th06/06c/07/08/09/10/11/12/128(640x480・等倍) | 960x720へ拡大 | **2本目として配信** | 解像度が変わるため |
| th15/th20(1280x960・等倍) | 1440x1080へ拡大 | **2本目として配信** | 同上 |
| th06nc(1280x720/1920x1080・等倍) | 元解像度のまま | 出さない | 2本目はウォーターマークの有無しか違わず、S3保管料とCloudFront転送量が倍になるだけ |
| 倍速録画 | 倍率に関わらず等倍へ戻した1本 | 出さない | 生データが等倍の速度でなく、2本目は等倍化した上でのエンコードがもう1本要る |

元の解像度版は配信版と**同じ ffmpeg 呼び出しの2つ目の出力**として作る(カット済み・
ウォーターマーク無し)。`needs_separate_raw_output()`にタイトル固有の分岐は無い。

| S3キー | 内容 |
| --- | --- |
| `videos/{jobId}.mp4` | 録画の生データ(カット前)。録画完了直後、変換前にチェックポイントとして
  アップロードされる(`worker/README.md` §6)。**`done` 確定後に削除する**(配信には使わない) |
| `videos/{jobId}_raw.mp4` | 元の解像度版(DynamoDB `outputPath`)。2本出力のジョブだけ |
| `videos/{jobId}_720p.mp4` | 配信版(DynamoDB `outputPath720p`)。**出力が1本のジョブでは
  このキーが `outputPath` に入り、`outputPath720p` は null になる**。`_720p` は歴史的な接尾辞で、
  実際の解像度は録画によって変わる |
| `progress/{jobId}/{unixMillis}.jpg` | 録画中の進捗スクリーンショット(DynamoDB
  `previewImagePath`)。スナップショット毎にユニークなキーを使う(CloudFrontの長期キャッシュ
  で古い画像が返り続けるのを避けるため) |
| `worker-logs/{jobId}/ffmpeg-upscale.log` | 配信用変換のffmpeg生ログ(キー名は互換のため
  `upscale`のまま)。`convert.py` が `-progress` の生出力をローカルファイルへ書き、
  `entrypoint.py` が `finally` でS3へ上げる。CloudWatchには変換失敗時のみ末尾2000バイトを
  残す(数千行を流すと管理画面のログビューアで他のログが埋もれるため。Issue #58)。
  `OutputBucket`内で3日のライフサイクルルールがあり、DynamoDBには保存しない
  (jobIdから決定的に導出可能、`apps/api/src/downloads.ts`の`buildFfmpegUpscaleLogKey`) |
| `diagnostics/{jobId}/attempt{n}-{classification}.jpg` | 試行を破棄した際の最終フレーム
  (`timeout`/`duplicate_rate`のいずれか、Issue #159)。早期に打ち切られた
  ジョブは`progress/`にスナップショットが1枚も残らず失敗時の画面を事後確認できないため、
  `recording.artifacts.save_diagnostics_snapshot()`が試行ごとに1枚だけ書き出し、
  `entrypoint.py`の`upload_diagnostics_snapshots_if_present()`がまとめてアップロードする。
  `progress/`と違い決定的なキー(ジョブID+試行番号+分類)なのでDynamoDBには保存しない。
  専用のライフサイクルルールは無く既定の`OUTPUT_RETENTION_DAYS`に乗る |

動画のアップロード時には**そのバイト数も DynamoDB へ記録する**
(`outputBytes`/`outputBytes720p`、Issue #60)。管理画面のコスト推定の入力で、動画サイズは
本サービスのコスト構造で最大のレバレッジ(`docs/research/aws-region-cost-analysis.md` §6)
なので平均値で丸めずジョブ単位の実測を残す(生動画のサイズはチェックポイントから再開した
ジョブが`record()`を通らないため`done`遷移時にも併せて書く)。
