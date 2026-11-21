# フェーズ46: th20のAWS実機(eu-south-2)録画検証・インスタンススペック比較

日付: 2026-08-05〜06

**【重要・追記】本レポート公開後、ユーザーの目視確認により「AWS録画がゲーム内fpsカウンターで常時75fps前後(本来60fps)となり早回しになっている」不具合が発覚し、原因調査・修正・再検証を追加で行った。詳細は末尾の「追記: fps異常バグの発見・修正・再検証」を参照。当初の「結論・推奨」セクションの数値(重複フレーム率・総録画時間・高負荷シーンfps)はこのバグの影響を受けた状態で計測されたものであり、正しい数値は追記セクションを参照すること(結論自体は`.4xlarge`推奨のまま変わらないが、根拠データが更新されている)。**

## 目的

フェーズ44/45でローカル検証済みのth20を、th11等と同様にAWS実機(EC2 Spot)で検証する。th20はローカル検証で「ボム使用等の高負荷な瞬間にゲーム内蔵fpsカウンターが19〜35fps程度まで落ち込む」処理落ちが確認されており(reports/45)、th11の基準(`.2xlarge`帯=8vCPU必須)を上回るスペックが必要かもしれないという仮説があった。リージョンはreports/42/43の方針に従いeu-south-2(ミラノ)を使用した。

## Dockerイメージ構成をtitleごとの単体イメージに変更

当初`cloud/docker/aws/Dockerfile.multigame`(th06/07/08/11)にth20を追加する形で進めたが、7.4GBのイメージのpull(EC2側)に約21分かかり、検証のイテレーション速度を大きく損なうことが判明した。ユーザーからの指摘の通り、`Dockerfile.multigame`は元々フェーズ25で「録画品質劣化がパイプライン/AWS環境固有かゲーム固有か」を切り分けるために作られたもので、単一タイトルの検証には本来不要な構成である。そのため、`cloud/docker/aws/Dockerfile.th20`(th20単体、2.4GB)を新規作成し、以後の検証はすべてこちらを使用した。EC2上でのpullは2.4GBで約25秒まで短縮された。

`.dockerignore`が`games/th20/`を明示的に除外していた(未使用ゲームデータの扱いのまま放置されていた)ため、`games/th20_steam/`(クラウドでは使わないSteam版データ)の除外に差し替えた。

`Dockerfile.multigame`側もth20を含む形に更新済みだが、上記の理由から今後の単発タイトル検証では単体Dockerfileを使う方針とする。

## 発見・修正したバグ

### バグ1: コンテナ実行ユーザー名とWINEPREFIXの%APPDATA%パスの不一致

th20をDockerイメージ化して初めて実行したところ、3回とも「ウィンドウの安定を確認できませんでした」で失敗した。ウィンドウサイズが246x234と異常に小さく、これはreports/44で説明されている「cfg未配置時の初回起動時解像度選択ダイアログ」のサイズと一致していた。

原因は、`GAME_CONFIGS["th20"]["appdata_dir"]`(`scripts/25_record_replay_e2e_multigame.py`)が`.../drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th20`とローカル開発機のユーザー名`hakatashi`を前提にハードコードされている一方、`Dockerfile.multigame`(および新設のth20単体版)のコンテナ実行ユーザーは`ubuntu:24.04`の既定ユーザー`ubuntu`だったこと。Wineは`c:\users\<実行時のUNIXユーザー名>`にプロファイルディレクトリをマッピングするため、`ubuntu`ユーザーで実行すると`drive_c/users/hakatashi/`(cfg配置済み)ではなく空の`drive_c/users/ubuntu/`を新規参照してしまい、cfgが見つからず初回ダイアログで止まっていた。th06/07/08/11はこの`%APPDATA%`依存の仕組みを使わないため、今回th20で初めて表面化したバグである。

**修正**: `Dockerfile.multigame`・`Dockerfile.th20`の両方で、`RUN usermod -l hakatashi -d /home/hakatashi -m ubuntu && groupmod -n hakatashi ubuntu`によりコンテナの既定ユーザーを`hakatashi`にリネームした(UID/GIDは1000のまま変更なし、ローカル開発機のUIDと元々一致)。修正後、正しく1280×960のゲームウィンドウが検出され、リプレイ自動再生が機能することを確認した。

### バグ2: `entrypoint_multigame.py`が`--record-seconds`等の追加CLI引数を転送していなかった

`docker run <image> --record-seconds 90`のようにCMD経由で引数を渡しても、`entrypoint.py`の`main()`は環境変数のみからコマンドを構築しており、`sys.argv`の追加引数を一切参照していなかったため黙って無視されていた(スモークテストで90秒のはずが録画がフル尺まで継続していたことで発覚)。`RECORD_SECONDS`環境変数を追加し、設定時に`--record-seconds`を転送するよう修正した。

## 検証結果: c7i.2xlarge vs c7i.4xlarge(th20_01.rpy、HARD、想定尺約29分)

th11の基準である`.2xlarge`帯(8vCPU/16GiB)をベースラインとし、ユーザー指示に従いさらに上位の`.4xlarge`帯(16vCPU/32GiB)も比較検証した。両方とも同一のth20単体イメージ・同一リプレイ(`th20_01.rpy`)・eu-south-2で個別ホストとして録画した。

| 項目 | `c7i.2xlarge`(8vCPU/16GiB) | `c7i.4xlarge`(16vCPU/32GiB) | ローカル基準(reports/45, Ryzen 7 5700X) |
|---|---|---|---|
| 総録画時間 | 1819.2秒(30.3分) | **1443.5秒(24.1分)** | 1756.6秒(29.3分) |
| 検知方式 | 画面静止検知(正常) | 画面静止検知(正常) | 画面静止検知(正常) |
| 重複フレーム率(パイプライン内蔵計測、15秒以降) | 3.6% | **1.1%** | (フェーズ45は6区間平均6.8%) |
| 6区間サンプル平均(独立再計測) | 13.4%(5.2〜22.3%) | **3.4%(0.3〜9.1%)** | - |
| Spot価格(実測) | 〜$0.081/時間 | 〜$0.145/時間 | - |

総録画時間は「ゲーム内速度自体の低下」を示す指標(reports/40のth11検証と同じ考え方)であり、`c7i.4xlarge`はローカル基準より約18%短く(処理落ちが少ない)、`c7i.2xlarge`はローカル基準よりわずかに長い(処理落ちがやや多い)という対照的な結果になった。

## 高負荷シーン(スペルカード「巌となるさざれ石」)でのfps実測比較

reports/45でユーザーから指摘のあった処理落ち(th20_01.rpy 24:40付近のボム使用箇所)と同一シーンを、両インスタンスの録画から時間比率換算(ローカル1480秒地点 ÷ ローカル総尺1756.6秒 の比率を各録画の総尺に適用)で特定し、ゲーム内蔵fpsカウンター(画面右下表示)を複数フレームにわたって目視確認した。

- **`c7i.2xlarge`**: 該当区間(録画1500〜1558秒付近)で**9.1fps・16.5fps**まで落ち込むフレームを複数確認した。これはローカル実測の最低値(19.8fps、reports/45)より明確に悪化しており、`.2xlarge`(8vCPU)ではth20の高負荷区間に対して不十分であることが実機で裏付けられた
- **`c7i.4xlarge`**: 同一シーンに相当する区間(録画1195〜1248秒付近)で最低でも**26.6fps**を維持し、9.1fpsのような深刻な落ち込みは確認されなかった。ローカル実測(最低19.8fps)より良好な結果だった

## 結論・推奨

- **th20はth11の基準(`.2xlarge`帯、8vCPU/16GiB)では実機検証上も不十分であり、`.4xlarge`帯(16vCPU/32GiB)を推奨する**。重複フレーム率(全体・区間平均とも)、総録画時間(ゲーム内速度低下の指標)、高負荷シーンでの実測fpsのいずれの指標でも`c7i.4xlarge`が`c7i.2xlarge`を明確に上回った
- コスト面では`c7i.2xlarge`(〜$0.081/時間)から`c7i.4xlarge`(〜$0.145/時間)への変更で約1.8倍になるが、eu-south-2のSpot価格は依然$0.15/時間の許容上限内に収まる
- `c7i.2xlarge`でも重複フレーム率の「全体」値自体は3.6%と一見問題なく見えるが、区間サンプリングでは13.4%まで悪化し、かつ高負荷シーンでのフレーム実測(9.1fps)は動画のなめらかさに直結する重大な劣化である。**th20のような高負荷タイトルでは、パイプラインの「全体」重複フレーム率だけでなく、区間サンプリングや実際のゲーム内fps推移も合わせて評価する必要がある**(AGENTS.mdの既存の注意点「単一60秒サンプルはブレが大きい」がth20ではより顕著に表れた)
- より上位のインスタンスタイプ(`.8xlarge`帯等)でさらに改善するかは未検証。`c7i.4xlarge`で高負荷シーンの実測fpsは26.6fpsまで改善したが60fpsには届いておらず、予算に余裕があれば`.8xlarge`帯の検証も価値があるかもしれない(本フェーズのスコープ外)

## 発見した副次的な環境課題

- eu-south-2のEC2 user-data(`docker.io`+awscli公式zipインストーラの分離インストール、reports/42で確立した方式)は、`unzip`パッケージが未インストールだと`awscliv2.zip`の展開に失敗する。今回使用したuser-dataスクリプトに`unzip`が含まれておらず2台とも同じ失敗をしたため、`apt-get install -y docker.io unzip`に修正した(今回のスクラッチパッド内のuser-data.shのみの修正、リポジトリには影響なし)
- ECRの`docker pull`はレイヤーのダウンロード自体は完了していても、展開(unpacking)処理に数分かかることがあり、`pgrep -f "docker pull"`のようなプロセス存在チェックだけでは「完了」の判定が遅れる場合がある(バックグラウンドの`docker pull`プロセスが先に終了した後も、実際にイメージが使えるようになるまでのタイムラグに注意)

## 成果物

- `runs/th20_aws_verification/c7i_2xlarge_th20_01/video.mp4`(3.7GB、1819.2秒)+ `record_stdout.log`
- `runs/th20_aws_verification/c7i_4xlarge_th20_01/video.mp4`(3.2GB、1443.5秒)+ `record_stdout.log`
- いずれもS3バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`(us-east-1、既存流用)にもアップロード済み(`th20_c7i_2xlarge_full/`・`th20_c7i_4xlarge_full/`)

## 今回作成・変更したAWSリソース(eu-south-2)

- ECRリポジトリ`touhou-recorder-th20`(新規作成、タグ`test`のイメージを保持)。既存の`touhou-recorder-multigame`リポジトリにもth20込みの`th20-test`イメージが残っている(整理は次回課題)
- SSHキーペア`touhou-recorder-verify-key`は秘密鍵が失われていたため再作成(reports/42/43と同様の運用)
- EC2インスタンス2台(`c7i.2xlarge`・`c7i.4xlarge`、いずれもSpot)は検証終了後に`terminate-instances`済み、`terminated`状態を確認済み
- 概算コスト: `c7i.2xlarge`約1.8時間+`c7i.4xlarge`約0.9時間、実測Spot単価ベースで合計1ドル未満

## 変更したファイル

- `cloud/docker/aws/Dockerfile.multigame`: th20を追加(games/th20・prefixes/th20-wined3d-gl・mods/th20_replay_autoplay/build/th20_hook.dll)、コンテナユーザーを`ubuntu`から`hakatashi`にリネームする修正を追加
- `cloud/docker/aws/Dockerfile.th20`(新規): th20単体の軽量イメージ定義
- `cloud/docker/aws/entrypoint_multigame.py`: `RECORD_SECONDS`環境変数を追加(`--record-seconds`をscripts/25へ転送)
- `.dockerignore`: `games/th20/`の除外を`games/th20_steam/`の除外に差し替え

## 次のステップ(初版時点)

- 本番運用でth20を扱う場合は、Spot Fleetの構成候補に`c7i.4xlarge`(またはeu-south-2で未検証の同価格帯タイプ)を追加する必要がある
- `touhou-recorder-multigame`リポジトリ側のth20対応が今後も必要か(単体イメージ運用に一本化するか)は要検討
- より上位スペック(`.8xlarge`帯)での追加検証は本フェーズのスコープ外、必要であれば別途実施

---

## 追記: fps異常バグの発見・修正・再検証

### 発見の経緯

ユーザーが上記2本の録画(`c7i.2xlarge`・`c7i.4xlarge`)を目視確認したところ、**両方とも全編を通してゲーム内蔵fpsカウンターが75fps前後を示しており、本来60fpsのはずのリプレイが早回しになっている**との指摘を受けた。改めてローカル録画(`runs/th20_verification/th20_01.mp4`)の「通常シーン」(ボム等の高負荷シーンではない場面)のfpsカウンターを複数箇所確認したところ**常時60.0〜60.4fps**だったのに対し、AWS録画(`c7i.2xlarge`・`c7i.4xlarge`とも)の同種シーンは**常時74〜79fps程度**(負荷が上がると60fps付近〜それ以下まで低下)であることを確認し、不具合が実在すると確定した。

これにより、当初の結論(「`c7i.4xlarge`の総録画時間がローカルより18%短い=処理落ちが少なく良好」)は誤りで、**実際には`c7i.4xlarge`はゲームが早回しで進行していたために短くなっていただけ**という可能性が浮上した(`c7i.2xlarge`は早回しと処理落ちが両方発生し打ち消し合っていたため、たまたま総録画時間がローカルに近い値になっていたと考えられる)。

### 原因調査

以下の手順でwine層・Xvfb層を1つずつ実機で切り分けた(すべてeu-south-2の使い捨てデバッグ用EC2インスタンスで検証)。

1. **wineのSleep/QueryPerformanceCounter/GetTickCount自体を疑い、mingw-w64で自作した検証用バイナリ(`Sleep(3000)`を挟んでQPC・GetTickCount・timeGetTimeの経過時間を測定)をAWS実機のwineで実行**したところ、いずれも3000msに対し3001〜3004msと正確だった。**wineのntdll層のタイマー実装自体はAWS環境でも正確**であることを確認(この時点でwine一般のタイマーバグ説は否定された)
2. **Xvfbが報告するディスプレイのリフレッシュレート**(`xrandr --query`)をローカル・AWSで比較したが、両方とも`0.00*`(Xvfbは実ディスプレイを持たないため未定義)で完全に同一だった。Xvfb側の設定差もないことを確認
3. **th20.exeの実プロセスに`strace`をアタッチ**(`--cap-add=SYS_PTRACE`でコンテナ起動)し、フレームループが呼んでいるsyscallを直接観測した。`nanosleep`/`clock_gettime`は一切呼ばれておらず、代わりに**`pselect6`(wineの`NtDelayExecution`の実装)が5〜8ms程度の可変タイムアウトで繰り返し呼ばれ、かつ連続する`pselect6`完了の実測間隔が約13ms(≒75fps相当)**であることを確認した。60fps(16.67ms/フレーム)を維持するには本来8〜9ms待つ必要がある場面で5〜8msしか待っていない、というパターンが直接観測された
4. **`LD_PRELOAD`で`glXSwapBuffers`をフックし独自の60Hzスロットルを行う対策を試みた**が、wineのプロセスローダーが`LD_PRELOAD`環境変数をth20.exeプロセスへ伝播しない(診断ログが一切出力されない)ことが判明し、この経路は機能しなかった

上記より、**問題はwineのタイマー実装ではなく、th20自身(またはMesa/llvmpipeの間接GLXレンダリング内部)のフレームペーシング計算が、AWS実機(Intel Xeon/Nitro仮想化環境)でのみ短く見積もられている**ことが直接観測で裏付けられた。あわせて、th20はレンダリングfpsとゲーム内ロジック更新が直結しており(th08のような実時間ベースのdelta-time方式ではない)、fpsが上振れするとゲーム進行速度自体も比例して早くなることも確認した(これが総録画時間の短縮という形で表れていた)。

### 修正

Linux側のLD_PRELOADが効かなかったため、**th20.exeに既に注入しているMOD DLL自身にIDirect3DDevice9::Presentのvtableフックを追加し、QueryPerformanceCounter基準(実測で正確と確認済み)で60Hzにスロットルする**方式に切り替えた。`mods/common/dinput_hook.cpp`の既存のvtableフック手法(`DirectInput8Create` IATフック → `IDirectInput8::CreateDevice` vtable[3]フック → `IDirectInputDevice8::GetDeviceState` vtable[9]フック)と全く同じ構造で、`d3d9.dll!Direct3DCreate9`をIATフック → `IDirect3D9::CreateDevice`をvtable[16]フック → `IDirect3DDevice9::Present`をvtable[17]フックする新規モジュール`mods/common/fps_limiter_hook.h/.cpp`を実装した(目標fpsは環境変数`FPS_LIMIT_TARGET_HZ`で変更可、既定60)。`mods/th20_replay_autoplay/dllmain.cpp`の`DLL_PROCESS_ATTACH`に`InstallFpsLimiterHook(60.0)`を追加し、`build.bat`にも新ファイルを追加した。

ローカル(mingw-w64クロスビルド、実機同様wine 9.0)で60秒の録画テストを行い、フック導入後も引き続き60.0fpsで安定していること(回帰なし)を確認した後、AWSデバッグインスタンスへ新DLLを転送し60秒スモークテストを実行したところ、**fpsカウンターが59.7〜59.9fpsに是正されたことを確認**した。

### 修正版での再検証(th20_01.rpy フル尺、`c7i.2xlarge`・`c7i.4xlarge`)

同一リプレイで両インスタンスタイプのフル尺録画をやり直した結果:

| 項目 | `c7i.2xlarge`(修正版) | `c7i.4xlarge`(修正版) | ローカル基準 | `c7i.2xlarge`(バグあり版) | `c7i.4xlarge`(バグあり版) |
|---|---|---|---|---|---|
| 総録画時間 | 1913.0秒(31.9分、**ローカル比+8.9%**) | **1725.8秒(28.8分、ローカル比-1.8%)** | 1756.6秒(29.3分) | 1819.2秒 | 1443.5秒 |
| 重複フレーム率(パイプライン内蔵計測) | 7.2% | **1.4%** | - | 3.6% | 1.1% |
| 6区間サンプル平均(独立再計測) | 13.75%(7.8〜18.8%) | **5.73%(3.5〜10.8%)** | - | 13.4% | 3.42% |
| 高負荷シーン(スペルカード「巌となるさざれ石」)実測fps | **11.7〜32.5fpsが複数フレームにわたり持続**(60fps付近への復帰に時間がかかる) | **13.2fpsへの単発の落ち込みが1回のみ、前後は57.6〜60.0fpsで安定** | 最低19.8fps(reports/45) | 最低9.1fps | 最低26.6fps |

**総録画時間が是正後は`c7i.4xlarge`でローカル基準とほぼ一致(-1.8%)し、`c7i.2xlarge`は逆に本物の処理落ちにより+8.9%と伸びる、という直感通りの結果になった**(修正前は両者とも早回しと処理落ちが混在して数値が歪んでいた)。

**修正後もなお`c7i.4xlarge`が`c7i.2xlarge`を明確に上回ることが、バグの影響を受けない形で確認できた**。特に高負荷シーンの実測fpsの質的な違い(`c7i.2xlarge`は複数フレームにわたる持続的な低下、`c7i.4xlarge`は単発の落ち込みからの速やかな回復)は、視聴体験への影響という観点で重要な差である。

### 結論(修正後)

- **fps異常バグは修正済み**(`mods/common/fps_limiter_hook.h/.cpp`、`mods/th20_replay_autoplay`に組み込み済み、リポジトリにコミット済み)。**このバグはth20固有かつAWS実機(少なくともeu-south-2のIntel Xeon Nitro環境)固有の問題であり、ローカル(Ryzen 7 5700X)は元々影響を受けていなかった**。今後th20をAWSで録画する際は、この修正込みのDLL(`mods/th20_replay_autoplay/build/th20_hook.dll`、ECRイメージは`touhou-recorder-th20:test`タグに反映済み)を使うこと
- **th20には引き続き`.4xlarge`帯(`c7i.4xlarge`、16vCPU/32GiB)を推奨する**。バグ修正後の正しい計測でも、総録画時間・重複フレーム率・高負荷シーンの実測fpsのいずれも`c7i.4xlarge`が`c7i.2xlarge`を明確に上回った
- **根本原因(なぜth20のフレームペーシングがAWS実機でのみ短く見積もられるか)は未特定のまま**。wineのntdll層のタイマーは正確と確認済みのため、th20自身の内部実装(またはMesa/llvmpipeの間接GLXレンダリング経路)固有の問題と考えられるが、ソースコードが無いため深追いはしていない。今回の対策(Present呼び出しの外側から強制的にフレームレートを制御する)は根本原因を問わず有効な対症療法として機能している
- 他タイトル(th06/07/08/11)がこの問題を起こしていない理由は、th20固有の`%APPDATA%`仕様同様、th20が採用しているエンジン(TH125以降系列)固有の実装差である可能性が高いが未確認。**今後th20以降の新タイトルを追加する際は、同様のfps異常が無いか毎回目視確認すること**を強く推奨する

### 変更したファイル(追記分)

- `mods/common/fps_limiter_hook.h`(新規): IDirect3DDevice9::Presentフックによるフレームレート制限の実装
- `mods/common/fps_limiter_hook.cpp`(新規): 同上
- `mods/th20_replay_autoplay/dllmain.cpp`: `InstallFpsLimiterHook(60.0)`をDLL_PROCESS_ATTACHに追加
- `mods/th20_replay_autoplay/build.bat`: 新ファイルをビルド対象に追加
- `mods/th20_replay_autoplay/build/th20_hook.dll`: 再ビルド済み(mingw-w64)
- ECRイメージ`touhou-recorder-th20:test`(eu-south-2)・`touhou-recorder-multigame:test`(eu-south-2)を修正版DLLで再ビルド・再push済み

### 追加で作成・削除したAWSリソース(eu-south-2)

- デバッグ用EC2インスタンス3台(`c7i.2xlarge`のfps異常調査用1台、修正版再検証用に`c7i.2xlarge`・`c7i.4xlarge`各1台、いずれもSpot)はすべて検証終了後に`terminate-instances`済み、`terminated`状態を確認済み
- 概算コスト: デバッグ・再検証あわせて`c7i.2xlarge`約2時間+`c7i.4xlarge`約1時間、実測Spot単価ベースで2ドル未満

### 成果物(追記分)

- `runs/th20_aws_verification/c7i_2xlarge_fpsfix/video.mp4`(3.8GB、1913.0秒)+ `record_stdout.log`
- `runs/th20_aws_verification/c7i_4xlarge_fpsfix/video.mp4`(3.7GB、1725.8秒)+ `record_stdout.log`

### 次のステップ(追記分)

- th20のfps異常バグの根本原因(Mesa/llvmpipeの間接GLXレンダリングかth20自身の実装か)を厳密に切り分けるには、th20以外の簡易な自作D3D9テストアプリをAWS実機で動かして再現するなどの追加調査が必要(本フェーズのスコープ外)
- `.8xlarge`帯でさらに改善するかは、修正後のデータでも依然未検証
