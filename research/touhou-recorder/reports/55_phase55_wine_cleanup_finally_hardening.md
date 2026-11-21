# フェーズ55: 録画処理の異常終了時にwineserver/winedeviceが放置されるバグの修正

日付: 2026-08-27

## 背景・インシデントの経緯

2026-08-27朝、ホストマシン(HakataMatrix)でsystemd(PID 1)が完全にハングし、
`sudo reboot`が"Transport endpoint is not connected"エラーで失敗、SSH接続も
切断され、手動電源断からの復旧を余儀なくされるインシデントが発生した。

journalctlの調査の結果、原因の一端として「Wineプロセス(`winedevice.exe`、
`uid=1000`)がsystem D-Busのシグナル購読を持ったまま約5時間46分間放置され、
system D-Busのメッセージキューが枯渇し続けた」ことが判明した(dbus-daemonが
同一の"full message queue"拒否ログを106,753回記録)。host上で`uid=1000`
(rootではない)として動いていたことから、Dockerコンテナ経由(sattori本番、
root権限)ではなく、touhou-recorderまたはsattoriのどちらかのWINEPREFIXを
ホスト上で直接(ベアメタルで)実行した結果と推定される。

本フェーズでは、touhou-recorder側のコードに存在していた「録画処理が
異常終了・ハングした場合にwineserver/winedeviceの後片付けが実行されず
プロセスが放置される」という構造的な欠陥を修正した。ホストマシンの
systemd/dbus設定変更やWineのsystem D-Bus接続自体を無効化する設定の検討は
本フェーズのスコープ外(sattori側で別途検討中)。

## 発見した欠陥

`scripts/25_record_replay_e2e_multigame.py`(全タイトル共通の録画パイプライン)
と`scripts/23_record_th08_ver100d_replay_e2e.py`(th08本番録画で使用中、
AGENTS.md記載)の両方に、構造的に同一の欠陥があった。

1. **録画処理本体を覆うtry/finallyが存在しなかった**。`attempt_recording()`は
   ウィンドウ起動→リプレイ再生待ち→録画→静止検知という200行超の処理を行うが、
   後片付け関数`kill_wine_and_wait()`の呼び出しは以下の箇所のみに存在した:
   - セットアップ失敗時の`_setup_failure_result()`内(game_pid検出失敗・
     ウィンドウ検出失敗・ウィンドウ安定確認失敗の3箇所)
   - 録画処理が正常に最後まで到達した場合の関数末尾
   このため、録画処理の途中で未捕捉の例外・タイムアウト・外部からのkillシグナル
   (SSH切断やCtrl+C等)が発生すると、後片付けが一切実行されないまま
   wineserver/winedevice.exeがホスト上に永久に取り残される経路が存在した。
2. **`kill_wine_and_wait()`自体にも、`wineserver -w`(実際にwineserverが
   終了するまでブロックする、reports/24参照)がタイムアウトした場合の
   フォールバックが無かった**。ゲームプロセスがGPU待ち等でカーネルレベルで
   割り込み不可能な状態(D state)にあり`pkill -9`が即座に効かない場合など、
   `subprocess.run(..., timeout=60)`が`TimeoutExpired`を送出すると、それが
   そのまま呼び出し元に伝播し、後片付け処理自体がそこで停止してしまう
   (=呼び出し元のfinallyで呼んでいたとしても、後片付け関数の内部で
   例外が起きればそれ以降の処理が実行されない)。

## 修正内容

### 1. `attempt_recording()`本体をtry/finallyで包む

両スクリプトとも、`ensure_xvfb()`呼び出しから関数末尾の`return`文までの
録画処理本体全体を`try:`ブロックで囲み、`finally:`節で無条件に
`kill_wine_and_wait()`(scripts/25は`kill_wine_and_wait(cfg, env)`)を呼ぶ
ように変更した。

- 早期return(`_setup_failure_result()`)からは`kill_wine_and_wait()`の
  呼び出しを削除し、`finally`節に一元化した(二重呼び出しを避けるため)。
- 正常完了時に呼んでいた関数末尾の`kill_wine_and_wait()`呼び出しも削除し、
  同様に`finally`節に一元化した。
- 結果として、後片付けの呼び出し箇所は各スクリプトにつき`finally`節の
  1箇所のみになり、正常終了・早期return・未捕捉の例外(タイムアウトや
  シグナルによる`KeyboardInterrupt`等を含む)のいずれの経路でも**必ず
  ちょうど1回**`kill_wine_and_wait()`が実行されることが保証される。

編集箇所: `scripts/25_record_replay_e2e_multigame.py`の`attempt_recording()`
(旧586〜952行目相当を`try:`ブロックへ、`_setup_failure_result()`定義・
関数末尾の重複呼び出しを整理)、`scripts/23_record_th08_ver100d_replay_e2e.py`
の`attempt_recording()`(同様の構造)。

### 2. `kill_wine_and_wait()`のタイムアウトフォールバック

`wineserver -w`の`subprocess.run(..., timeout=60)`を`try/except
subprocess.TimeoutExpired`で保護し、タイムアウト時は:

1. WARNINGログを出力
2. 新設した`find_pids_for_wineprefix(wineprefix)`で、対象WINEPREFIXの
   環境変数(`/proc/<pid>/environ`)を持つ全プロセスのPIDを列挙
   (`GAME_EXE`やwineserver自体だけでは`winedevice.exe`等の内部生成
   プロセスを個別に捕捉できないため)
3. 列挙した各PIDに`os.kill(pid, signal.SIGKILL)`を発行
   (`ProcessLookupError`は握りつぶす=プロセスが既に無くなっていても
   後片付け全体は継続する)

この結果、`wineserver -w`が返ってこないケースでも例外を外へ伝播させず
関数内で完結するようになり、「後片付け処理自体が例外で止まって以後何も
実行されない」状態を解消した。

## 検証方法

実機でwineプロセスをハングさせて再現するのは危険(今回のインシデント自体が
それによるものであるため)なので、各関数をモックで差し替えた単体テストで
検証した(いずれも一時的にPythonの対話実行で確認、テストコード自体は
リポジトリに残していない)。

### 検証1: 録画処理本体で例外が起きてもfinallyで後片付けが1回実行される

`scripts/25_record_replay_e2e_multigame.py`の`ensure_xvfb`をモックで
`RuntimeError`を送出するよう差し替え、`kill_wine_and_wait`もモックで
呼び出し回数を記録するよう差し替えた上で`attempt_recording(cfg, args)`を
呼び出した。

```
OK: 例外は呼び出し元に正しく伝播した: 模擬した例外(Xvfb起動失敗を想定)
kill_wine_and_wait呼び出し回数: 1 [('kill_wine_and_wait', 'th07.exe')]
PASS: 例外発生時でもfinallyでkill_wine_and_waitが1回だけ実行された
```

`scripts/23_record_th08_ver100d_replay_e2e.py`でも同様の手順で
`kill_wine_and_wait`が1回だけ実行されることを確認した。

### 検証2: セットアップ失敗の早期returnでも二重呼び出しにならない

`find_live_game_pid`が`None`を返す(game_pid検出失敗)ケースをモックで再現し、
`attempt_recording()`が`classification: setup_error`を返しつつ
`kill_wine_and_wait`がちょうど1回だけ呼ばれることを確認した(旧実装の
`_setup_failure_result()`内呼び出し+新設した`finally`の二重呼び出しに
なっていないことの確認)。

```
result: {'detected': False, ..., 'classification': 'setup_error', ...}
kill_wine_and_wait呼び出し回数: 1
PASS: セットアップ失敗の早期returnでも後片付けが1回だけ実行された(二重呼び出しなし)
```

### 検証3: `wineserver -w`タイムアウト時のフォールバックが完走する

`subprocess.run`をモックで差し替え、`["wineserver", "-w"]`呼び出しでのみ
`subprocess.TimeoutExpired`を送出するようにし、`find_pids_for_wineprefix`が
存在しないPID(`999999`)を返すようにした上で、`os.kill`も
`ProcessLookupError`を送出するようモックした。

```
WARNING: wineserver -w が60秒以内に終了しませんでした。WINEPREFIX=/tmp/fake-prefix 配下の残存プロセスをSIGKILLで強制終了します(reports/55参照)
subprocess.run呼び出し: [['pkill', '-9', '-x', 'th07.exe'], ['wineserver', '-k'], ['wineserver', '-w']]
os.kill呼び出し: [(999999, <Signals.SIGKILL: 9>)]
PASS: wineserver -w タイムアウト時もProcessLookupErrorが伝播せず、フォールバックが完走した
```

`ProcessLookupError`が握りつぶされ`kill_wine_and_wait()`全体が正常終了する
(=呼び出し元のtry/finallyの外へ例外が漏れない)ことを確認した。

### 検証4: 既存の正常系フローへの影響がないこと

- `python3 -m py_compile`で両スクリプトの構文エラーが無いことを確認。
- `ast.parse`で`attempt_recording()`の関数本体が`[..., Try]`
  (docstring等の後にtryノード1つのみ)という想定通りの構造になっている
  ことを確認。
- `scripts/49_stage_probe_run.py`など`kill_wine_and_wait(cfg, env)`を
  外部から直接呼んでいる既存コードを確認し、関数シグネチャ
  (`kill_wine_and_wait(cfg, env)`)自体は変更していないため影響がないことを
  確認済み。
- 実際のゲームプロセスを使ったフル尺録画でのリグレッション確認は
  本フェーズでは行っていない(コードレビュー+モックによる単体検証に
  留める判断)。次回いずれかのタイトルの本番録画時に、録画完了後
  `pgrep wineserver`等で通常通りプロセスが残っていないことを併せて
  確認することが望ましい。

## 影響範囲・スコープ外事項

- `scripts/23_record_th08_ver100d_replay_e2e.py`は本タスクの依頼文で
  名指しされていた`scripts/25`とは別ファイルだが、同一の構造的欠陥
  (try/finally欠如)を持ち、かつAGENTS.mdに「th08の新規本番録画は
  `games/th08_ver100d/`+`scripts/23`を使うこと」と明記されている
  実運用中のスクリプトであるため、本フェーズで合わせて修正した。
- ホストマシンのsystemd/dbus設定変更、Wineのsystem D-Bus接続自体を
  無効化する設定(`WINEDLLOVERRIDES`等)の追加検討は対象外(sattori側で
  別途検討中)。
- ホスト上に現在残存するプロセスの調査・削除は対象外(インシデント後の
  再起動により既に解消している)。

## 教訓

録画処理中に例外・タイムアウト・外部シグナルが発生しても、必ず
try/finallyでwineserver/winedeviceの後片付けが実行されることを保証する
設計にすること。後片付け関数自体も、内部で使うサブプロセス呼び出しの
タイムアウトが起こりうる前提でフォールバックを持たせ、「後片付けが
例外で止まって以後何も実行されない」状態を作らないこと。詳細はこの
`reports/55`を参照(`AGENTS.md`にも1行で追記済み)。
