# フェーズ41: 並列録画時のPulseAudio音声混成問題の解決

日付: 2026-07-28

## 背景

sattori(本番サービス)は現在EC2 Fleet(1インスタンス=1ジョブ)で運用しているが、コスト削減のため、開発者の自宅サーバーが空いている時間帯に追加ワーカーとして同一マシン上で複数ジョブ(th06/07/08/11)を並列録画させる構想がある。sattoriリポジトリの`worker/runs/`に残る4並列実行時のログから、映像(x11grabはディスプレイ番号で分離済み)は問題ないが、**音声は全ジョブが同一PulseAudioデーモンの単一デフォルトsink(`auto_null`)のmonitorから録音しており、全ジョブの音声が混ざって記録される**問題が確認されていた。この問題を解決しない限り並列ワーカー化はできないため、本フェーズで根本原因の確認と解決策の実機検証を行った。

なお本フェーズの検証はすべて本リポジトリ(touhou-recorder)のローカル環境で完結させ、sattori側のコード変更は行っていない(知見の記録とPoCまで)。

## 1. 根本原因の確認

`pactl info`で確認した通り、このマシンのPulseAudioは`module-always-sink`により起動時に`auto_null`という単一のnullシンクを自動生成し、`Default Sink`として使う。フェーズ10で既に「全ジョブが同じ`auto_null`を共有すると混ざる」ことは指摘済みだったが、本フェーズで以下を追加確認した。

- Wine側は各WINEPREFIXの`user.reg`に`Software\Wine\Drivers\winepulse.drv\devices\0,auto_null`が登録されているが、これは単に「PulseAudioバックエンドを使う」という指定であり、**接続先sinkを固定するものではない**。実際にどのsinkに繋がるかはPulseAudioクライアントライブラリの挙動(`PULSE_SINK`環境変数、無指定ならデフォルトsink)に従う。
- そのため、Wineプロセス起動時に`PULSE_SINK=<ジョブ専用sink名>`を環境変数として渡せば、Wine側のコード変更なしに出力先を固定できることを実機で確認した(詳細は3節)。

つまり原因は「PulseAudio・Wineどちらの制約でもなく、単に全ジョブが同じsink名を指定(暗黙のデフォルト)していること」であり、Wine側の音声API(DirectSound/waveOut)がホスト側単一サーバーに固定的に接続する構造的な制約ではない。

## 2. 既知の地雷(`auto_null`のリネーム/消失)の実地確認

`worker/entrypoint.py`のコメントにある「追加sinkをロードすると既存の`auto_null`が`auto_null.2`にリネームされる」現象を本マシンで再現した。

```
$ pactl list short sinks
0  auto_null  ...  SUSPENDED
$ pactl load-module module-null-sink sink_name=test_job1 ...
19
$ pactl list short sinks
1  test_job1  ...  IDLE          # auto_null (index 0) が消えている
```

原因は`module-always-sink`の仕様で、「システムに他のsinkが1つも存在しない場合にのみ`auto_null`を自動生成・維持する」ため、専用sinkを追加した瞬間に**既存の`auto_null`インスタンスをunloadする**(リネームというよりは削除+新規sink追加、という形で観測された)。全sinkをunloadすると`module-always-sink`が再度`auto_null`を自動生成して復元されることも確認済み。

**結論**: `auto_null`に依存する運用と、ジョブ専用sinkのみで運用する設計は共存が難しい。したがって解決策としては、**`auto_null`を使うこと自体をやめ、起動時に全ジョブ分の専用null-sinkだけを使う設計**(依頼書の解決策Aの方向性)を採用するのが素直である。専用sinkだけの運用であれば`auto_null`が勝手に消えても実害はない(そもそも使わない)。

## 3. 解決策: ジョブごとの専用null-sink + `PULSE_SINK`環境変数

### 3.1 疑似音源によるsink分離の実証(Task 1)

4つの専用null-sink(`job1`〜`job4`)を作成し、それぞれに異なる周波数のサイン波(440/880/1320/220Hz)を`paplay --device=jobN`で同時再生、各sinkの`monitor`をffmpegで同時録音した。録音結果をFFTで解析した結果:

| sink | 再生した周波数 | 録音から検出されたピーク |
|---|---|---|
| job1 | 440Hz | 440.0Hz のみ |
| job2 | 880Hz | 880.0Hz のみ |
| job3 | 1320Hz | 1320.1Hz のみ |
| job4 | 220Hz | 220.0Hz のみ |

他ジョブの周波数が一切混入しないことを確認した。

### 3.2 実際のWineプロセスでのsink固定確認(Task 2)

th07(`prefixes/th07-wined3d-gl`+`games/th07`を独立コピー)を、環境変数`PULSE_SINK=job1`を付けて起動したところ、`pactl list short sink-inputs`で該当のsink-inputが**sink 4(job1)にのみ**接続され、job1が`RUNNING`に、他のjob2〜4は`SUSPENDED`のまま維持されることを確認した。**Wine側のコード変更やレジストリ変更は一切不要**で、既存の`build_env()`が返す環境変数辞書に`PULSE_SINK`を1行追加するだけで実現できる。

### 3.3 実ゲーム2並列での混成なし確認(Task 3)

th07(`PULSE_SINK=job1`)とth08 ver1.00d(`PULSE_SINK=job2`)を異なるXvfbディスプレイ(:191/:192)で同時起動し、両sinkのmonitorを同時に10秒間録音した。

- 両ファイルとも実音量(th07: mean -18.3dB/max -1.4dB、th08: mean -13.9dB/max 0.0dB)を確認。
- **対照実験**: th08プロセスをSIGSTOPで一時停止すると、job2(th08用)の録音は直後から`mean_volume: -91.0 dB`(実質無音・フロアノイズ)まで低下した。この間th07は動き続けていたにもかかわらずjob2には一切混入しなかった。これにより、同一PulseAudioデーモン内でも専用sink化により音声が確実に分離されることを実機・実ゲームで実証した。

## 4. 既存A/V同期補正ロジックへの影響確認(Task 4)

`scripts/25_record_replay_e2e_multigame.py`の音声分離+`-copyts`/`-itsoffset`実測補正ロジック(フェーズ26・28)が、専用sink(`auto_null.monitor`ではなく`jobN.monitor`)でも同様に機能するかを確認した。

- th07(job1)動作中に、x11grabとpulse(job1.monitor)をそれぞれ`-copyts`付きで同時起動・`ffprobe`で`start_time`(絶対epoch秒)を取得する実験を3回行った。

| 試行 | video_start | audio_start | delta(audio-video) |
|---|---|---|---|
| 1 | 1785239815.116016 | 1785239815.080000 | -0.036s |
| 2 | 1785239820.316016 | 1785239820.280000 | -0.036s |
| 3 | 1785239825.516016 | 1785239825.482000 | -0.034s |

`-copyts`による絶対時刻の取得自体は専用sinkでも問題なく機能し、既存の「実測差分を`-itsoffset`で補正する」ロジックはそのまま適用できる。

**副次的な発見**: 専用sink使用時のズレ(約35ms)は、フェーズ28でauto_null使用時に計測された値(ローカルで0.588〜1.4秒程度)より明らかに小さかった。これは、専用sinkの場合ゲームプロセスの音声出力(sink-input)が既に継続的にストリーミングしている状態でffmpeg pulse入力を開始するため、pulse側のsink起動・復帰レイテンシが顕在化しにくいためと考えられる(フェーズ28の「事前にRUNNING状態にしても改善は限定的」という所見は、実際のストリームが流れていない単なるsinkのRUNNING化を試した結果であり、今回のように実ストリームが流れ続けている状態とは条件が異なる)。いずれにせよ、**既存の実測ベース補正ロジックは値がどうであれ自動的に吸収する設計なので、この差自体が問題になることはない**。

## 5. sattori側への実装反映方針(実装は別途sattori側で実施)

1. **ジョブ起動時に専用null-sinkを動的作成**: ワーカーがジョブを受け取った際、ジョブID(またはスロット番号)ごとに`pactl load-module module-null-sink sink_name=sattori_job_<id>`でsinkを作成する。既存の`auto_null`には依存しない設計とし、`start_pulseaudio()`側で`auto_null`の存在を前提にしたロジックがあれば見直す(本フェーズで確認した通り、専用sink追加時に`auto_null`が消えても実害はないため、単純に無視してよい)。
2. **ゲームプロセス起動時の環境変数に`PULSE_SINK=sattori_job_<id>`を追加**: 各ジョブのWine起動処理(sattoriの`recording_common.py`相当)で、既存のWINEPREFIX/DISPLAY/LANG設定と同じ場所に1行追加するだけでよい(本リポジトリでは`scripts/25`の`build_env()`に相当)。
3. **音声録音ffmpegの入力ソースを`sattori_job_<id>.monitor`に変更**: 現状のグローバル定数`PULSE_SOURCE = "auto_null.monitor"`(本リポジトリの`scripts/25`。sattori側にも同等の定数があるはず)を、ジョブごとの値に置き換える。
4. **ジョブ終了時にsinkをunload**: `pactl unload-module <module_id>`でクリーンアップする(sinkを使い回すとRUNNING/SUSPENDED状態の遷移や前ジョブの残留ストリームが紛れ込むリスクがあるため、ジョブごとに作成・破棄するのが安全)。
5. 既存のA/V同期補正(`-copyts`+実測`-itsoffset`)・音声分離での重複フレーム対策(フェーズ26)はそのまま維持でよい。本フェーズの検証で専用sink化によりこれらのロジックへの悪影響がないことを確認済み。

## 6. 本フェーズで作成・削除したリソース

- 検証はすべて`/tmp`配下のスクラッチディレクトリ(ゲームディレクトリ・WINEPREFIXの独立コピー、Xvfb :190/:191/:192)で実施し、検証後にすべてのテスト用プロセス(Xvfb・openbox・wineserver・th07.exe/th08.exe)・PulseAudioモジュール(`job1`〜`job4`のnull-sink)を終了・unloadし、`auto_null`のみの元の状態に復元済み。
- 本リポジトリのコード(`scripts/`等)は変更していない(調査・PoCのみ)。

## 結論

並列録画時の音声混成は、PulseAudio・Wineいずれの構造的制約でもなく、**全ジョブが同一のデフォルトsink(`auto_null`)を暗黙に共有していること**が原因であり、ジョブごとに専用null-sinkを動的作成し、Wine起動時の環境変数`PULSE_SINK`で出力先を固定するだけで完全に解決できることを実機(疑似音源4並列・実ゲーム2並列の対照実験)で確認した。既存のA/V同期補正ロジックへの悪影響もない。sattori側での実装は上記5節の方針に従い、比較的小さな変更(sink作成/破棄・環境変数1行・録音元パスの変数化)で反映可能と見込まれる。
