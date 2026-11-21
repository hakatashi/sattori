# フェーズ56: th10(東方風神録)の環境構築・自動操作MOD実装(メニュー操作確立まで)

日付: 2026-08-28

## 位置づけ

新規タイトル th10(東方風神録 / Mountain of Faith)をリポジトリの録画パイプラインに追加する作業の第1弾。AGENTS.mdの「新規タイトル対応時の検証チェックリスト」のうち、項目1(設定確認)〜3(MOD開発・動作確認)を完了し、項目4(フル尺録画)以降は未着手。**このフェーズだけでは「対応完了」を報告しない**こと。

## 前提確認

- `sattori-home-worker.service`が停止済み(2026-08-28 18:47 JSTに`systemctl stop`済み)であることを`systemctl status`で確認し、`ps aux`でwine/ffmpeg/Xvfbの残存プロセスが無いことも確認した上で作業を開始した。

## ゲーム資産・設定ファイル

- `games/th10/`にth10.exe(487,936バイト、PEタイムスタンプ`1186086096`=2007-08-02 20:21:36 UTC)・`th10.cfg`・VsyncPatch一式(`vpatch.exe`/`vpatch.ini`/`vpatch_th10.dll`)が配置済み(ユーザーがウィンドウモード設定済みと申告)。
- PEタイムスタンプは`../thprac/thprac/src/thprac/thprac_th10.cpp`の`gGameVersions[]`テーブルにある`ID_TH10`エントリの`.timeStamp = 1186086096`と完全一致しており、thprac側が想定するバージョンと同一のゲームデータであることを確認した(TH10は公式パッチも単一バージョンのみで、thprac側もバージョン違いのエントリを持たない)。
- `games/th10/vpatch.ini`には`BugFixTh10Power3 = 1`(バグマリ修正が有効)が既に設定されている状態だった。このオプションの有効/無効それぞれでの録画検証は次フェーズ以降の課題(後述)。

## リプレイファイルの内容確認(`@sattori/touhou-replay-parser`使用)

`../sattori/packages/replay-parser`をNode.js APIとして直接呼び出し(`parseReplay()`、CLIは提供されていない)、`games/th10/replay/`配下の全リプレイの内容を確認した:

```bash
cd ../sattori/packages/replay-parser
node --input-type=module -e "
import { parseReplay } from './dist/index.js';
import { readFile } from 'node:fs/promises';
const data = new Uint8Array(await readFile('<path>'));
console.log(JSON.stringify(parseReplay(data).replay));
"
```

- `th10_01.rpy`〜`th10_25.rpy`(既存25本、ユーザーの過去プレイ記録)を全件パースし、キャラ・難易度・到達ステージ・クリア有無・フレーム数を確認。フル尺録画の検証対象として以下を選定した:
  - **通常ステージ(全クリア)候補**: `th10_07.rpy`(ReimuA / Hard / All Clear / score=80,202,630 / 22,099フレーム=368秒≒6.1分)。全クリアの中で最短のためフル尺検証に採用。
  - **Extraステージ(クリア)候補**: `th10_19.rpy`(MarisaA / Extra Stage Clear / score=248,009,430 / 41,264フレーム=688秒≒11.5分)。Extraクリア済みの中で最短のため採用予定。
- **バグマリ検証用リプレイ**の内容確認:
  - `th10_p3_nopatch.rpy`: MarisaB / Hard / Stage 1〜4(未クリア、4面突入直後に意図的被弾) / 記録スコア=59,677,770 / 24,520フレーム(409秒)
  - `th10_p3_patch.rpy`: MarisaB / Hard / Stage 1〜4(未クリア、同様) / 記録スコア=35,266,800 / 33,574フレーム(559秒)
  - いずれも魔理沙Bであることを確認済み(ユーザー申告と一致)。両者でスコアが大きく異なる(59,677,770 vs 35,266,800)のは、バグマリの有無によるショット火力差が主因と推測される(この検証はフェーズ後半で実施予定)。

## 前回の未完了作業の発見

作業着手時、`mods/th10_replay_autoplay/build/th10_hook.dll`(ビルド済みだがソース無し、gitでも未追跡)と`runs/th10_bringup/`(2026-08-24付けの診断ログ・動画・スクリーンショット多数)が既に存在していることを発見した。`scripts/25_record_replay_e2e_multigame.py`にth10のGAME_CONFIGSエントリも当時は存在したはずだが、コミットされないまま失われていた(`git log --all -- mods/th10_replay_autoplay`が空、`git stash list`も空)。

このログを精読した結果、以下が既に判明していた:

- th10.exeはth11/th20と異なり、DirectInputの`GetDeviceState`が実際に56〜60Hzでポーリングされる(`FpsMonitor`ログで確認)。TH10エンジン初出のこのタイトルはまだ`GetKeyboardState`方式に切り替わっておらず、th06/07/08と同じ`PressKey`(DIKスキャンコード経由)を使うべきと判明。
- タイトル画面に明示的な"PRESS ANY BUTTON"表示があり、Enterで消す必要がある(th08等には無いステップ)。
- 過去の試行では、この"タイトル消し"のタイミングが不安定で、Down×2→Replayに正しく到達できず「Rank Select」画面(Game Start経由)に迷い込むケースが多かった。

この情報を踏まえ、`mods/th10_replay_autoplay/dllmain.cpp`をゼロから新規実装した(ソース自体は失われていたため)。

## メニュー操作シーケンスの確立

### 診断手順

1. まず「Enter1回でタイトル消し→2秒待機→Down 1回ずつ、各後に2秒+3秒(計5秒)待機してスクリーンショット」という診断ビルドを作成し、`scripts/25`の`--record-seconds`で短時間録画→`ffmpeg -ss <時刻> -frames:v 1`でフレーム抽出、という手順でメインメニューの構造を実測した。
2. **メインメニュー構成が判明**: Game Start / Extra Start / Practice Start / Replay / Player Data / Music Room / Option / Quit の8項目が常に表示されるが、**Extra Startはカーソル移動時に自動スキップされる**(Down×1で「Practice Start」、Down×2で「Replay」にカーソルが移動することをスクリーンショットで直接確認。`runs/th10_bringup2/frames/pointC.png`・`pointD.png`)。これはユーザー提供の「Down×2でReplay」という手順と一致する。
3. この診断ビルドでの待機時間(Enter後2秒+3秒、Down後2秒+3秒)ではメニュー操作が確実に機能したが、これをそのまま本番シーケンス相当の短い待機(Enter後2秒→Down×2を250ms/500ms/1000ms間隔で連続送信)に置き換えると、**毎回「Rank Select→Player Select」(Game Start経由)に迷い込み、Replayへ到達できなかった**(`runs/th10_bringup2/diag2.mp4`〜`diag5.mp4`で再現、`frames/replay_25s.png`・`diag5_28s.png`等で確認)。
4. 切り分けの結果、**Down間隔の長さではなく「Step0(Enter)を送るタイミングの早さ」が原因**と判明した。タイトルロゴ演出のバッファを1500ms→**4500ms**に延ばしたところ(Down間隔は1000msのまま)、`runs/th10_bringup2/diag7.mp4`で確実に「REPLAY」一覧画面まで到達することを確認できた。3回連続実行(`verify1.mp4`〜`verify3.mp4`)でも安定して成功することを確認済み(重複フレーム率いずれも0.0%/0.0%/8.1%と、リプレイ再生が正常に進行していることを示す値)。
   - 教訓: タイトルロゴ演出中に送った入力は「バッファされず単純に無視される」らしく、早すぎるEnterはタイトル消しに失敗する。失敗した状態で後続のDown/Enterを送ると、それらが「まだ表示されているPRESS ANY BUTTON」を消す動作+メインメニューの項目確定に化けてしまい、結果的にGame Start等の別ルートに入ってしまう。
5. リプレイ一覧画面到達後、**ファイル名の数字がそのままスロット番号(No.NN)に対応する**ことも実機確認した(`th10_07.rpy`を配置すると一覧の「No.07」にそのプレイヤー名・日付・キャラ・難易度が表示された、`diag6_33s.png`参照)。これはth06/07/08と同じ方式で、th11/th20の`_ud0000.rpy`タブ切替方式とは異なる。ユーザー提供の「`th10_01.rpy`という名前を使うこと」という指示はこの規則に基づくものと判明したため、`scripts/25`の`GAME_CONFIGS["th10"]["replay_dest_filename"] = "th10_01.rpy"`でコピー先ファイル名を固定した(th11/th20の正規化と同じ仕組み)。

### 確定した本番シーケンス(`mods/th10_replay_autoplay/dllmain.cpp`)

```
WaitForStableWindow → WaitForHookActive
Sleep(4500)                          // タイトルロゴ演出待ち
PressKey(DIK_RETURN)                 // Step0: "PRESS ANY BUTTON"を消す
Sleep(5000)
PressKey(DIK_DOWN) x2, 各後Sleep(1000)  // Step1: メインメニューでReplayを選択
PressKey(DIK_RETURN); Sleep(700)     // Step2: Replay確定、一覧画面へ
PressKey(DIK_RETURN); Sleep(700)     // Step3: No.01(1番目)のリプレイを選択
PressKey(DIK_RETURN); Sleep(700)     // Step4: 再生確定、1面から開始
```

実機で1面のプレイ画面(HUD・BGM「御柱の墓場 ~ Grave of Being」・スコア増加)が正しく表示されることを確認済み(`runs/th10_bringup2/frames/diag7_20s.png`・`diag7_60s.png`)。

## `scripts/25_record_replay_e2e_multigame.py`への統合

`GAME_CONFIGS`に`"th10"`エントリを追加(`display=":94"`、`wineprefix`/`instance_dir`は前回作業で既に用意されていたものを再利用)。`--game`の`choices`にも`"th10"`を追加。`end_template`・`still_detect_exclude_rect`は未設定(リプレイ選択画面の終了検知方式は次フェーズで検討、後述)。

## ビルド方法

MSVC用`build.bat`を新規作成(`mods/th11_replay_autoplay/build.bat`と同型)。動作確認には、AGENTS.md記載のmingw-w64クロスビルドを使用:

```bash
cd mods/th10_replay_autoplay
i686-w64-mingw32-g++ -shared -O2 -o build/th10_hook.dll \
    dllmain.cpp \
    ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
    ../common/fps_monitor.cpp ../common/score_monitor.cpp ../common/stage_marker_hook.cpp \
    -static-libgcc -static-libstdc++ -static -luser32
```

## score_monitor / stage_marker_hook の現状(未解決事項あり)

thprac(`thprac_th10.cpp`)の`enum ADDRS`と`THGuiPrac::State()`内の実書き込みコードから、以下の絶対VA(=RVA、image base 0x400000)を収集し、`0x474c00`を基点(RVA=`0x74c00`)としたオフセットに整理した:

| オフセット | 内容 | 実機検証結果 |
|---|---|---|
| +0x44 | score(int32、表示値の1/10) | 単調増加を確認、フル尺録画での完全一致検証は未実施 |
| +0x70 | life(残機) | 値2(妥当)を確認 |
| +0x7c | stage(ステージ番号、`STAGE_NUM`) | 当初「常に6固定の異常値」と誤認したが**誤り**。訂正: `reports/57`参照 |
| +0x68 / +0x6c | chara / subshot | 未検証 |
| grazeなし | — | thprac側にグレイズの読み書きコードが存在せず(`THPracParam`にフィールド自体が無い)、th10エンジンでのグレイズ機能自体が未実装と判断し計測対象から外した |

**【訂正・reports/57参照】**: 上記「stage常に6固定の異常値」はこのフェーズ時点の誤認だった。検証に使った`th10_07.rpy`はユーザー指摘により**プラクティスモードで6面のみをプレイしたリプレイ**(`@sattori/touhou-replay-parser`で`splits.length=1, splits[0].stage=6`と確認)と判明し、stage=6で終始変化しないのはこのリプレイの性質上正しい挙動だった。`STAGE_NUM`(RVA=0x74c7c)自体は正常に機能しており、`InstallStageMarkerHook`は有効化して問題ない。詳細な再検証は`reports/57`を参照。

## 次フェーズでやるべきこと(AGENTS.mdチェックリストの残り)

1. 通常ステージ(`th10_07.rpy`)・Extraステージ(`th10_19.rpy`)双方のフル尺録画検証
2. 録画品質(重複フレーム率・fps)、音ズレの確認
3. リプレイ終了検知方式の確立: ユーザー指摘の通りリプレイ選択画面は背景全体が常時アニメーションしており画面静止検知が使えない見込み。左上「REPLAY」見出し(幅約244px×高さ約76px)のend_templateマッチングを試すこと
4. 低速録画機能(1/2倍速)の実装・検証
5. `STAGE_NUM`の再特定(STAGE_PROBE)とgraze要否の裏付け調査
6. `th10_p3_nopatch.rpy`/`th10_p3_patch.rpy`によるバグマリ修正(`BugFixTh10Power3`)の要否検証: 双方が意図通り4面突入まで進むか、逆のオプション設定でリプレイずれによる早期終了が起きるかを確認
7. `scripts/53_verify_replay_score.py`によるフル尺録画でのスコア完全一致検証(GAME_MULTIPLIERSにth10を追加する必要あり、倍率は×10と推測)
8. クラウド実機検証(AWS、推奨インスタンスタイプの確認)
