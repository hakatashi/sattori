# ホストsystemdハングインシデント: wineserver後片付け未実行が一因(Issue #186)

- **検証日**: 2026-08-27
- **対象**: 自宅ワーカーのホストマシン(HakataMatrix)障害の原因調査。`worker/recording_common.py`の後片付け処理の頑健性
- **環境**: HakataMatrix(自宅ワーカーのホスト)、`worker/`をDockerを介さず直接(ベアメタルで)実行した検証セッション
- **結論**: `kill_wine_and_wait()`が`wineserver -w`のタイムアウトを捕捉しておらず、例外がリトライループごと伝播してスクリプトをクラッシュさせ、放置されたWineプロセスがsystem D-Busのメッセージキューを枯渇させたことがホストハングの一因だった。Issue #186で修正済み。

## 経緯

2026-08-27朝、自宅ワーカーのホストマシン(HakataMatrix)でsystemd(PID 1)が完全にハングし、
`sudo reboot`が"Transport endpoint is not connected"エラーで失敗、SSH接続も切断され手動電源断
からの復旧を余儀なくされた。

journalctlを調査した結果、以下が判明した:

- Wineプロセス(`winedevice.exe`, uid=1000)がsystem D-Busのシグナル購読を持ったまま約5時間46分間
  放置されていた。
- その間、dbus-daemonが同一の"full message queue"拒否ログを**106,753回**記録しており、
  system D-Busのメッセージキューが枯渇し続けていた。
- 該当プロセスがuid=1000(rootではない)として動いていたことから、Dockerコンテナ経由の本番経路
  (コンテナ内はroot権限で動く)ではなく、`worker/`をホスト上で直接実行した検証セッション由来と
  推定される。

実際、[`2026-08-26-th20-post-cooler-replacement-verification.md`](2026-08-26-th20-post-cooler-replacement-verification.md)
(Issue #162)は、インシデント前日の2026-08-26 14:20〜16:46に`worker/record_th20.py`を
`worker/README.md` §11の手順でローカル直接実行していた記録であり、その中でth20の低速録画
2並列時に「難易度確認画面からステージ開始への遷移で完全にハングする」新規バグが報告され、
Issue #179として起票・未解決のまま残っている。

## 原因

`worker/recording_common.py`の`kill_wine_and_wait()`(修正前)は、`pkill -9` →
`wineserver -k` → `subprocess.run(["wineserver", "-w"], env=env, timeout=60)`の順で
後片付けしていたが、この`timeout=60`に対する`except subprocess.TimeoutExpired`が
存在しなかった。

ゲームプロセスがGPU待ち等でD state(カーネルレベルで割り込み不可能)に陥っている場合、
`wineserver -k`のシグナルが効かず、60秒以内にwineserverが終了せず
`subprocess.TimeoutExpired`が送出される。

呼び出し元`_record_with_retry()`のリトライループには、`attempt_recording()`呼び出しを
囲むtry/exceptが無かった。したがって上記の`TimeoutExpired`が発生すると、リトライループ
ごと例外が伝播してスクリプト全体(`record_th20.py`等のエントリポイント)がクラッシュし、
その時点のwineserver/winedevice.exeプロセスはホスト上に取り残されたまま以後一切の監視・
後片付けがされなくなった。

Issue #162レポートの2並列テストで最後にファイル更新が止まっている
`worker/prefixes/th20-wined3d-gl-parallel-b`(2026-08-26 16:44)が、まさにこの経路で
取り残された可能性が高い。

**Issue #179自体(なぜハングするか)とは別種の問題**であることに注意。#179が解決しても、
未知のタイトル固有バグ・thpracの確認ダイアログ常駐など他の経路でゲームプロセスが
ハングする可能性は残るため、「録画処理がどんな理由であれハングしたときに後片付けが
確実に実行される」という頑健性は独立して担保する必要がある。

## 対応(Issue #186)

- `kill_wine_and_wait()`に`try/except subprocess.TimeoutExpired`を追加。タイムアウト時は
  `/proc/*/environ`からWINEPREFIX一致で対象プロセスを洗い出し、SIGKILLするフォールバックを
  実装した。
- `_record_with_retry()`の各試行(`attempt_recording()`呼び出し)をtry/exceptで保護し、
  想定外の例外が発生しても後片付けしてから次の試行へ進み、リトライループ自体は安全に
  継続・終了できるようにした。
- 全タイトル(`record_th06.py`〜`record_th20.py`)は`recording_common.py`の共有関数
  (`record_with_retry`)のみを経由しており、タイトル固有のwineserver後片付けコードは
  存在しないため、上記2点の修正で全タイトルに反映される。
- `worker/README.md` §11(ベアメタル直接実行手順)に、OSレベルの強制終了ラッパー
  (`timeout --kill-after=`)を併用する注意書きを追記した。

## 考察・既知の限界

- 本番のDocker経路(EC2 Fleet・自宅ワーカーのコンテナ実行)はジョブ完了後にコンテナごと
  破棄されるため、今回のようなホストへのプロセスリークは起きない。**実害があるのは
  `worker/README.md` §11のベアメタル直接実行(手動検証)のみ**。
- 今回の修正は「後片付けが確実に実行される」ことを保証するものであり、**Issue #179
  (th20低速録画2並列がなぜハングするか)自体は未解決のまま**。
- ホストマシンのsystemd/dbus設定変更(D-Busキュー枯渇への耐性強化)は本調査のスコープ外。
- Wine自体のsystem D-Bus接続を無効化する設定を追加するかどうかは、Docker本番経路・
  ベアメタル実行経路の両方に影響する変更になるため、この調査では決定していない
  ([`decisions/0035`](../decisions/0035-outer-timeout-wrapper-for-bare-metal-runs.md)参照)。
