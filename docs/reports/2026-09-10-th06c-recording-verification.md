# th06c（東方紅魔郷: Classic）録画対応：ローカル実機検証・AWSクラウドE2E検証

- **検証日**: 2026-09-10
- **対象**: th06c（東方紅魔郷: Classic）録画対応（Issue #240）。`worker/mods/th06c_replay_autoplay/`・
  `worker/mods/th06c_steam_stub/`・`worker/record_th06c.py`・`worker/recording/config.py`の
  `GameConfig.for_game()`overrides拡張
- **環境**: ローカル検証はHakataMatrix（自宅ワーカー機、`sattori-home-worker.service`停止確認
  済み）、Docker + Wine + Xvfb + ffmpeg。E2E検証は本番AWS環境（eu-south-2、EC2 Fleet、
  Webからのアップロード〜メール認証〜CloudFront DLまでの実フロー）
- **結論**: touhou-recorder側の技術検証（reports/74〜77）で確立したMOD・Steamworks APIスタブ・
  64bit録画経路を、sattori本体の録画パイプライン（`recording/`パッケージ）へ問題なく移植でき、
  ローカル実機検証・AWS本番E2E検証の両方で成功を確認した。

## 目的

Issue #240の実装（64bit専用MOD・Steamworks APIスタブ・`GameConfig.for_game()`のoverrides拡張・
`recording/modlog.py`のスコア倍率登録）が、touhou-recorderのPoCスクリプトではなくsattori本体の
コードで実際に動作すること、および本番AWS環境でWebからのアップロード〜録画〜CloudFront DLの
E2Eが成功することを確認する。

## 方法

### ローカル録画検証

sattori-home-workerが停止していることを`systemctl is-active`で確認した上で、本番ワーカー
イメージ（`sattori-worker:latest`）をベースに、変更後の`worker/recording/`・
`worker/record_th06c.py`をボリュームマウントで上書きし、Dockerコンテナで直接
`record_th06c.py`を実行した（`verify-recording-locally` skill、AWS認証情報不要）。

```bash
docker run --rm --cpus 4 \
  -v "$WORKER/recording:/app/recording:ro" \
  -v "$WORKER/record_th06c.py:/app/record_th06c.py:ro" \
  -v "$WORKER/assets/replay_end_templates/th06c.png:/app/assets/replay_end_templates/th06c.png:ro" \
  -v "$D/games:/mnt/th06c-assets/games:ro" \
  -v "$D/prefixes:/mnt/th06c-assets/prefixes" \
  -v "$D/mods:/mnt/th06c-assets/mods:ro" \
  -e WINEPREFIX=/mnt/th06c-assets/prefixes/th06c-wined3d-gl \
  -e SATTORI_GAME_DIR=/mnt/th06c-assets/games/th06c \
  -e SATTORI_MOD_DIR=/mnt/th06c-assets/mods \
  --entrypoint bash "$ECR" -c '
    pulseaudio -D --exit-idle-time=-1 --disallow-exit
    python3 record_th06c.py --replay-path /mnt/replay.rpy --output /mnt/output/repro.mp4 \
      --expected-score <score> --desync-result-path /mnt/output/desync_result.json
  '
```

ゲーム本体はtouhou-recorderの`games/th06c/`（Steam版）をrsyncし、正規の`steam_api64.dll`を
`mods/th06c_steam_stub/build/steam_api64.dll`で上書きした。WINEPREFIXは
`WINEARCH=win64`で新規作成（`setup_wineprefix.sh`はwin32を強制するため、事前に自分で
win64プレフィックスを作ってから同スクリプトでフォント登録した、`worker/docs/titles/th06c.md`）。
検証は短尺リプレイ（`th6_03.rpy`、Lunatic/ReimuB、27秒）でMOD動作を確認した後、
フル尺リプレイ（`th6_01.rpy`、Hard/ReimuA、25分56秒）で本番相当の検証を行った。

### AWSクラウドE2E検証

本番APIを直接叩き、Webフロントと同じ手順でジョブを作成した: `POST /uploads`で署名付きURLを
取得→S3へ`.rpy`をPUT→`POST /magic-links`（`email`指定）→届いたメール（Gmail）から
マジックリンクの`jobId`を取得→`POST /jobs/{jobId}/start`→`GET /jobs/{jobId}`をポーリング。
ワーカーイメージは今回の変更を含めて`docker build && docker push`済み、タイトル資産
（`games/th06c`・`prefixes/th06c-wined3d-gl`・64bit injector・MOD）は
`upload-title-assets` skillの手順でS3へアップロード済み、CDKスタックは`pnpm run deploy`で
`SUPPORTED_GAME_IDS`等の変更を反映済みの状態で実行した。

## 結果

### ローカル検証: 短尺リプレイ（`th6_03.rpy`、Lunatic/ReimuB、記録スコア247,920）

| 項目 | 結果 |
| --- | --- |
| 起動ダイアログ自動操作 | 成功（「ウィンドウ 640x480」+VSync選択→「ゲーム起動」クリック） |
| Steamworks APIスタブ | 成功（Steamクライアント常駐なしで起動、`exit(255)`は発生せず） |
| GetProcAddressフック | 成功（`GetKeyboardState`を自前実装に差し替え） |
| メニューカーソル追従 | 成功（Down 3回でindex 0→1→2→3、'Replay'に到達） |
| 終了検知（画面静止、テンプレート未整備時） | 成功だが総録画時間55.2秒中の重複フレーム率33.2%で
  破棄・リトライ（**リプレイ自体が27秒と短く、測定区間15〜45秒の大半が終了後の静止画面に
  かかったための偽陽性**。実際のゲームプレイ映像は正常、下記考察参照） |
| 終了検知（テンプレート照合、`th06c.png`配置後） | 成功（総録画時間39.4秒、`template_MAD`が
  2連続で0.51と閾値15.0を十分下回り検知） |
| 重複フレーム率（テンプレート照合時、録画開始15秒以降） | 18.0%（閾値30.0%以内） |
| スコア完全一致検証 | **一致**（記録スコア247,920と一致するサンプルを確認、`desyncDetected: false`） |

### ローカル検証: フル尺リプレイ（`th6_01.rpy`、Hard/ReimuA、記録スコア114,250,700）

| 項目 | 結果 |
| --- | --- |
| 終了検知 | 成功（テンプレート照合、正しく「リプレイ選択画面テンプレート照合」とログ表示——
  下記のバグ修正を反映） |
| 総録画時間 | 1551.9秒（理論尺1556.72秒よりやや短い。touhou-recorder reports/75で確認済みの
  th06c固有の仕様——リプレイ`frameCount`合計がステージ数に比例して実測より系統的に大きい
  ため、理論尺比較は超過方向のみで判定する） |
| 重複フレーム率（録画開始15秒以降） | **0.1%**（非常に良好） |
| スコア完全一致検証 | **一致**（記録スコア114,250,700と一致するサンプルを確認、
  `desyncDetected: false`） |
| タイムアウト打ち切り | なし（`timedOut: false`） |
| 目視確認 | 道中・会話イベント（咲夜とのスペルカード会話）・ボス戦（「紅色の幻想郷」）の
  複数地点をフレーム抽出して確認。全地点で60.00fps安定、弾幕・スコア表示・日本語フォント
  （MSゴシック）に破綻なし |
| 出力 | 640x480 h264/aac、633,095,677バイト |

### AWSクラウドE2E検証（短尺リプレイ、`th6_03.rpy`）

| 項目 | 結果 |
| --- | --- |
| `POST /uploads`→S3 PUT | 成功（200） |
| `POST /magic-links` | 成功（202）。サーバー側の再パースで`game: "th06c"`と判定され
  `isSupportedGame()`を通過（`SUPPORTED_GAME_IDS`へのth06c追加が実際に効いていることを確認） |
| マジックリンクメール | 正常送信（件名・本文の作品タイトル「東方紅魔郷: Classic」・
  プレイヤー名・難易度・スコアが記録内容と一致） |
| `POST /jobs/{jobId}/start` | 成功（`queued`） |
| ジョブステータス遷移 | `launching` → `recording` → `converting` → `done`まで自動遷移 |
| EC2 Fleet実機録画 | 成功（`DEFAULT_CANDIDATE_INSTANCE_TYPES`の`.xlarge`帯、`getCandidateInstanceTypes()`の
  デフォルト分岐がth06cにもそのまま適用されることを確認） |
| デシンク検証 | `desyncDetected: false` |
| タイムアウト打ち切り | `timedOut: false` |
| CloudFront DL | 成功（`downloadUrl`/`downloadUrl720p`とも200、`content-type: video/mp4`） |
| 配信版動画 | 960x720（640x480から拡大）・60fps・ウォーターマーク合成済み・39.2秒 |

## 【副次的に発見・修正したバグ】終了検知方式のログラベルが常に「画面静止検知」になっていた

th06cのテンプレート照合ログを確認中、`recording/pipeline.py`の`attempt_recording()`が
サマリー行の検知方式を`elif detected:`で常に「画面静止検知」に固定していることを発見した
（判定結果自体=`classification`は正しく、ログ表示のみの不具合）。テンプレート照合を使う
全タイトル（th06/06c/07/08/09/10）のログに影響していた。touhou-recorder reports/76で
同種のバグが報告されていたのと同じ原因。`_monitor_until_end()`の戻り値へ`detected_by`
（`"template"` / `"still"`）を追加し、呼び出し側で正しいラベルを出すよう修正した
（`recording/pipeline.py`、回帰防止のユニットテストを追加）。

## 考察・既知の限界

- 短尺リプレイの重複フレーム率チェックが偽陽性を起こす現象は、
  `docs/known-limitations.md`§3の既存の注意書き（測定区間が15〜45秒の30秒スポットに
  固定されている）が本質的な原因であり、th06c固有の問題ではない。ただし該当タイトルの
  リプレイが極端に短い場合（数十秒程度）は同様の偽陽性が起こりうる。
- 低速録画（Issue #68）は未実装（D3D11経路のためMOD側にPresentフックが無い、
  `worker/docs/titles/th06c.md`）。
- ステージ番号・残機・グレイズのRVAは未特定（スコアのみ実装）。デシンクの事後検知は
  スコア一致判定のみに限られる。
- Steamworks APIスタブは実機で観測された呼び出しにのみ対応。将来のゲームアップデートで
  新しいインターフェース/メソッドが呼ばれた場合の追加対応が必要になりうる
  （`docs/decisions/0044`）。
