# 0013. 並列録画の音声混成をジョブ専用の PulseAudio sink で防ぐ

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: worker
- **関連**: Issue #48、Issue #49、touhou-recorder reports/41、
  `docs/reports/2026-08-08-parallel-audio-isolation.md`

同一ホストで複数ジョブを並列録画すると**全ジョブの音声が混ざって記録される**問題を、
ジョブごとの null-sink と `PULSE_SINK` で解消した。EC2 Fleet(1インスタンス=1ジョブ)でも
同じコードパスを通す。音声まわり(`pulse.py`・`GameConfig.build_env()`)を触る前に読むこと。

## 背景

映像はXvfbのディスプレイ番号(`GameConfig.display`、タイトルごとに`:96`〜`:99`)で
分離されているが、音声は以前はすべてのジョブがPulseAudioのデフォルトsink
(`module-always-sink`が自動生成する`auto_null`)を暗黙に共有していた。
EC2 Fleet(1インスタンス=1ジョブ)では顕在化しないが、自宅サーバーを追加ワーカーとして
併用する構想(Issue #49)の前提としてこれを解消する必要があった。

**原因はPulseAudio・Wineいずれの構造的制約でもない**。WINEPREFIXのレジストリにある
`winepulse.drv`の`devices`設定は「PulseAudioバックエンドを使う」という指定でしか
なく、接続先sinkを固定しない。実際の出力先はPulseAudioクライアントライブラリの
規則(`PULSE_SINK`環境変数、無指定ならデフォルトsink)に従うだけである。

## 決定

- ジョブごとに専用のnull-sinkを作り、ゲーム(Wine)側は`PULSE_SINK`で出力先を
  そのsinkに固定し(`GameConfig.build_env()`)、録音側ffmpegはそのsinkのmonitor
  (`GameConfig.pulse_source` = `<sink名>.monitor`)を入力にする。Wine側・MOD側の
  変更は不要。
- **sinkのライフサイクル**は`recording_common.record_with_retry()`が
  `pulse.job_sink()`で管理する。録画開始時に作成し、成功・失敗を問わず戻る際に
  unloadする。全試行(自動リトライ)で1つのsinkを共有する。
- sink名は`pulse.sink_name_for_job()`でjobIdから採番する
  (`sattori_job_<英数字・アンダースコアに正規化したjobId>`)。jobIdの生成規則に
  依存しないよう、PulseAudioのsink名として安全な文字種へ必ず正規化する。
  `entrypoint.py`が`--pulse-sink`で録画スクリプトへ渡す。ローカル単体実行時
  (`--pulse-sink`未指定)はプロセスIDから採番する。
- 作成前に**同名のsinkが残っていれば必ずunloadする**(`pulse.remove_sink()`)。
- **EC2 Fleet(1インスタンス=1ジョブ)でも同じコードパスを通す**。

## 根拠

- 同名sinkの掃除が要るのは、ワーカーがSIGKILL等で強制終了するとunloadが走らず孤児sinkが
  残り、同名sinkが既に存在する状態で作成すると新しいsinkが`<名前>.2`へリネームされて、
  `<名前>.monitor`が前回の孤児sinkを指してしまうため。掃除の対象を同名sinkに限定して
  いるのは、`sattori_job_*`を一括削除すると並列実行中の他ジョブの音声を巻き込んで
  壊すため。
- **`auto_null`には依存しない**。`module-always-sink`は「他にsinkが1つも無い場合にのみ
  `auto_null`を維持する」仕様のため、専用sinkを作った時点で`auto_null`は消えるが、
  専用sinkしか使わない以上これは無害である(以前`entrypoint.py`にあった「sinkを追加
  すると`auto_null`が消えて録画が失敗する」という注意書きはこの設計変更で解消した)。
- EC2 で同じコードパスを通すのは、1ジョブしかない環境で専用sinkを使うこと自体に副作用が
  なく(既存の`-copyts`+実測`-itsoffset`によるA/V同期補正にも影響しないことをreports/41で
  確認済み)、環境分岐を作らない方がテスト・保守が容易なため
  （`AGENTS.md` §3「ワーカーの中に自宅かEC2かの分岐を作らない」とも整合する）。
- 実機検証は [`docs/reports/2026-08-08-parallel-audio-isolation.md`](../reports/2026-08-08-parallel-audio-isolation.md)。

## 採らなかった選択肢

- **WINEPREFIX のレジストリで出力先 sink を固定する**。`winepulse.drv` の `devices` 設定は
  バックエンドの指定でしかなく、接続先 sink を固定できない(上記「背景」)。
- **並列録画時だけ専用 sink を使う**。ワーカーは自分が何並列で動いているかを知らない
  (知るべきでもない)ので、分岐の判定材料が無い。
- **`sattori_job_*` を起動時に一括削除する**。並列実行中の他ジョブの音声を壊す。

## 影響範囲

- `worker/pulse.py`(`job_sink()`・`sink_name_for_job()`・`remove_sink()`)
- `worker/recording_common.py`(`record_with_retry()`・`GameConfig.build_env()`/
  `pulse_source`)
- `worker/entrypoint.py`(`--pulse-sink` の受け渡し)
- 自宅ワーカーでの並列録画(`home-worker/README.md`、
  `docs/reports/2026-08-09-home-worker-parallel-recording.md`)
