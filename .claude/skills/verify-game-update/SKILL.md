---
name: verify-game-update
description: 録画対応済みの東方タイトルにゲーム側の公式アップデート(新バージョン配信、例: th06nc ver 1.0.6)が来たときに、新しいゲームデータへ差し替えても録画が壊れないかを検証し、本番へ反映するまでの手順。「新バージョンが出たので検証して」「ゲームデータを差し替えたので互換性を確認して」等で使う。旧バージョンで作られたリプレイが新ゲームで再生できるか・MODのRVAが変わっていないか・Steam版の正規DLLでスタブが上書きされていないか等、確認漏れがそのまま本番の全ジョブ失敗につながる項目があるため、必ずこの手順に従うこと。
---

# ゲームのアップデート配信時の検証手順

録画対応済みタイトルに公式アップデートが配信され、`worker/games/<game>/` を新しい
ゲームデータで差し替えるときの手順。**本番のタイトル資産(S3)は全ジョブが即座に
使う共有物**なので、ここに書いた検証をすべて通してからアップロードすること。
初回の実施記録は [`docs/reports/2026-09-28-th06nc-v1.0.6-update-verification.md`](../../docs/reports/2026-09-28-th06nc-v1.0.6-update-verification.md)。

## 0. 何が壊れうるか(検証項目の根拠)

| 壊れうるもの | 壊れたときの症状 | 確認手段 |
| --- | --- | --- |
| リプレイ形式 | パーサーが弾く/誤解析、アップロード画面でエラー | §2 パーサー |
| 旧バージョンのリプレイの再生互換 | 新exeで旧リプレイがデシンク・非再生(th07で前例、`docs/known-limitations.md`) | §3 旧リプレイの再生 |
| MODが使うRVA(スコア等) | exeの再ビルドでアドレスがずれ、スコア監視がゴミ値→デシンク誤判定 | §3 のスコア一致 |
| メニュー操作シーケンス | メニュー構成の変更で自動操作がリプレイ画面へ到達しない | §3 の `sequence complete` |
| 同梱物(スタブDLL・設定ファイル) | Steam版の更新で**正規の`steam_api64.dll`が戻り**、本番で即終了(th06c/th06nc) | §1 差分確認 |

## 1. 新旧ゲームデータの差分を確認する

ユーザーは通常、旧データを `worker/games/<game>.old/` に退避してから `worker/games/<game>/`
を差し替えている(されていなければ退避を依頼する。比較・対照実験に旧データが要る)。

```bash
cd worker/games
diff -rq <game> <game>.old
md5sum <game>/*.exe <game>/*.dll <game>.old/*.exe <game>.old/*.dll
```

- **Steam版タイトル(th06c・th06nc)は `steam_api64.dll` が正規版に戻っていないか必ず確認する**。
  正規版はサイズ・md5がスタブ(`worker/mods/<game>_steam_stub/build/steam_api64.dll`)と
  異なる。戻っていたらスタブで上書きする(`upload-title-assets` skill、`decisions/0044`)。
  2026-09-28のth06nc ver 1.0.6更新では実際に正規版へ戻っていた。
- 実行時に書き戻される設定ファイル(th06ncの`th06.env`等)の差分は、ユーザーが新版を
  手元で起動した結果であることが多く、録画には使われない(`th06.env.720p`等の方を使う)。
- exeのバージョン文字列は `strings` では取れないことが多い。表記はユーザーに確認する。

## 2. リプレイパーサーの互換性

新バージョンで記録したリプレイをユーザーから受け取り、
`packages/replay-parser/test-fixtures/<game>/` に置く(既に置かれていることもある)。

1. ヘッダのフォーマットバージョン(th06系なら0x04の`u16`)を旧フィクスチャと `xxd` で比較する。
   変わっていればパーサー側の対応が要る(`packages/replay-parser/README.md`)。
2. 実際にパースし、`ok: true` と各値(難易度・機体・スコア・`frameCount`・splits)が妥当か、
   **同じモード・難易度の旧フィクスチャと同じ傾向か**を確かめる(例: th06ncのExtraは
   旧版でも開始時power=0として出る)。
3. golden JSON を生成し、`src/golden.test.ts` のフィクスチャ総数を1つ増やす。

```bash
cd packages/replay-parser
# parseReplay() の結果の .replay を JSON.stringify(_, null, 2) + "\n" で書き出す
npx tsx <生成スクリプト>   # → test-fixtures/<game>/<file>.expected.json
npx vitest run src/golden.test.ts
```

## 3. 新ゲームで旧・新リプレイを再生する

**少なくとも「旧バージョンで作られたリプレイ」と「新バージョンで作られたリプレイ」の
2本を、新ゲームデータで再生し、MODのスコア監視が記録スコアと一致すること**を確認する。
スコア一致(`--expected-score`・`--desync-result-path`)は、リプレイ互換・MODのRVA・
メニュー操作シーケンスを一度に検証できる。旧リプレイは
`worker/tests/fixtures/mod-integration/<game>/`(期待スコアは
`worker/tests/mod_integration/run.py`の`TITLES`)を使うとよい。

失敗した場合は、**旧ゲームデータ(`<game>.old`)で同条件の対照実験を必ず行う**。
旧データでも同じように失敗するなら検証環境側の問題であって、アップデートの影響ではない。

### 3.1 CPU系タイトル

`verify-recording-locally` skill の手順(Docker、`sattori-home-worker`停止確認込み)で、
§4の資産コピーの代わりに `worker/games/<game>/`(スタブDLL上書き済み)・
`worker/prefixes/<game>-wined3d-gl/`・`worker/mods/*/build/` を `/mnt/cache3` 配下へ
複製して使う。MOD統合テスト(`worker/tests/mod_integration/run.py --game <game>`)でも
旧リプレイ側は確認できる。

### 3.2 GPU描画必須タイトル(th06nc)

このマシン(AMD Radeon VII)ではGPU描画での録画はできない(`worker/docs/titles/th06nc.md`)。
**録画品質(fps・重複フレーム率)は検証できないが、再生互換とスコア一致だけは
GPU無しで検証できる**ので、以下の条件で行う。

- **ホスト直接実行はしない**。WINEPREFIXにDXVKが配置済みのため、ホストで動かすと
  Vulkan経由でamdgpuを掴み、プロセス終了時にGPUがハングしうる(touhou-recorder reports/79)。
  `/dev/dri` を渡さないDockerコンテナなら原理的にGPUへ触れない。
- イメージは `sattori-worker-gpu` に Xvfb だけを足した使い捨てのローカルイメージを作る
  (GPUイメージは Xorg+NVIDIA 前提で Xvfb を含まない)。`record_th06nc.py` は
  `:103` が起動済みなら再利用するので、コンテナ内で先に `Xvfb :103 -screen 0 2200x1400x24`
  と openbox を起動しておく。
- **DXVKは使えない**。lavapipe(Vulkanのソフトウェア実装)上ではDXVKが起動直後に
  `Unhandled division by zero` で落ちる(旧exeでも同じ、2026-09-28対照実験済み)。
  コンテナ内で `record_th06nc.py` の `dxvk_dll_overrides` を `...=b` に書き換え、
  wineビルトインのwined3d(+`LIBGL_ALWAYS_SOFTWARE=1`)で描画する。
- 約10fpsしか出ないので `TH06NC_TIME_SCALE=7`(MODのメニュー操作待ちを7倍に延長)を渡す。
  重複フレーム率チェックは必ず落ちるので `--max-duplicate-rate 100 --max-attempts 1` にする。
  再生時間は `frameCount / 10` 秒程度かかる(パイプラインの60分タイムアウトに収まる長さの
  リプレイを選ぶこと)。
- 資産の複製はコンテナ(root)から使うため、所有者をrootへ変える(hakatashi所有のままだと
  wineが `not owned by you` で拒否する)。`sudo` を使わずに済むよう、コンテナ経由で
  `chown -R 0:0` するとよい。

```bash
B=/mnt/cache3/sattori-<game>-verify/<version>
# 使い捨てイメージ
printf 'FROM %s\nRUN apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*\n' \
  "${SATTORI_ECR_GPU_REPO}:latest" > /tmp/verify-img.Dockerfile
docker build -t sattori-th06nc-verify:local -f /tmp/verify-img.Dockerfile /tmp

docker run --rm --name sattori-verify-th06nc \
  -v "$B/assets:/mnt/th06nc-assets" -v "$B/replay.rpy:/mnt/replay.rpy:ro" -v "$B/out:/mnt/output" \
  -e WINEPREFIX=/mnt/th06nc-assets/prefixes/th06nc-wined3d-gl \
  -e SATTORI_GAME_DIR=/mnt/th06nc-assets/games/th06nc \
  -e SATTORI_MOD_DIR=/mnt/th06nc-assets/mods \
  -e TH06NC_TIME_SCALE=7 -e LIBGL_ALWAYS_SOFTWARE=1 \
  --entrypoint bash sattori-th06nc-verify:local -c '
    sed -i "s/d3d10core=n/d3d10core=b/" record_th06nc.py
    pulseaudio -D --exit-idle-time=-1 --disallow-exit; sleep 1
    Xvfb :103 -screen 0 2200x1400x24 & sleep 2; DISPLAY=:103 openbox --sm-disable & sleep 1
    timeout --kill-after=30s 4000s python3 record_th06nc.py \
      --replay-path /mnt/replay.rpy --output /mnt/output/rec.mp4 \
      --expected-score <記録スコア> --desync-result-path /mnt/output/desync.json \
      --max-attempts 1 --max-duplicate-rate 100
    cp /app/instances/th06nc-recording/*.log /mnt/output/'
```

### 3.3 見るべき結果

- MODログに `sequence complete`(メニュー操作の完走)、`run.log` に終了検知が出ていること
  (`TH06NC_TIME_SCALE=7` ではメニュー操作が20秒を超えるため、`run.log` 側の
  「キーシーケンス完了ログが検出できませんでした」警告は無視してよい)。
- `desync.json` が一致(`desyncDetected: false`)であること。MODログ
  (`th06nc_autoplay.log`)の `ScoreMonitor: score=` が0やゴミ値のまま動かない場合は
  **RVAがずれている**(th06nc ver 1.0.6で実際に発生。画面上の得点は進んでいるのに
  最後まで0だった)。exeのセクション表(`.data`の開始RVA)を新旧で比べると移動が分かる。

### 3.4 スコアRVAの再特定

再生中のゲームプロセスのメモリを**ホスト側から** `sudo` で読む(コンテナ内からは
`CAP_SYS_PTRACE`が無く `/proc/<pid>/mem` が `Permission denied` になる)。wineの
プロセスはLinuxプロセスそのものなので、ホストの `pgrep -f 'th06nc.exe'` のPIDで読める。
64bit版はImageBase `0x140000000`(MODログの`module_base=`は下位32bitしか表示しない)。

1. 再生中に、exeイメージの書き込み可能領域(`/proc/<pid>/maps` で `0x140000000`台の
   `rw-p`)から、スコアらしいu32(10の倍数)を3秒間隔で2回読み、増えたアドレスを列挙する。
   th06ncでは「先に増える内部値」と「8バイト手前で追いかける表示値」の組が見つかる。
2. 再生終了後もプロセスが生きている間サンプリングを続け、内部値の候補がリプレイの
   記録スコアへぴったり到達することを確認する(記録スコアそのものを保持するアドレスは
   リプレイファイル由来の静的な値なので、再生中から一定値のままのものは除外する)。
3. `worker/mods/<game>_replay_autoplay/dllmain.cpp` の `sm.baseRva` を直し、
   `build-mods` skill で再ビルドして、§3を修正版MODでもう一度通す。hook DLLは
   タイトル資産に同梱されるので、**ワーカーイメージの再デプロイは不要**(§4の
   資産アップロードで反映される)。
- 録画された動画を目視し、リプレイが最後まで再生されていること(ローカルの低fps録画は
  等倍にはならないが、内容の確認には足りる)。

## 4. 本番への反映

1. `upload-title-assets` skill でタイトル資産を作り直してアップロードする。
   **TitleAssetsBucketはバージョニング有効**なので、問題が出たら旧バージョンの
   オブジェクトを戻せばロールバックできる。自宅ワーカーのキャッシュはS3のETagで
   世代管理されているため、手動の無効化は要らない(`decisions/0040`)。
2. ワーカーイメージの変更(MOD修正等)を伴う場合は `deploy-sattori` skill の順序を守る。
3. GPU系タイトル・ローカルで録画品質を見られなかったタイトルは、アップロード後に
   本番で実際に1本録画して確認する(`verify-recording-in-production` skill §5〜6の
   API直叩き手順がそのまま使える。ここではフロントエンドを隠す必要は無い)。
4. 表記の更新: `apps/web/src/pages/GameInfoPage.tsx` の `TITLE_INFO` のバージョン表記と
   同テスト、`apps/web/src/data/changelog.ts` にエントリを追加して PR を作る
   (`docs/runbooks/issue-workflow.md`)。
5. 検証結果を `docs/reports/` に1件残す(ローカルでの再生検証・対照実験の結果、
   本番での録画結果)。

## 5. 後始末

- `$B/assets`(WINEPREFIXの複製、数GB)はコンテナ経由で削除する(root所有のため)。
- 使い捨てイメージは `docker rmi sattori-th06nc-verify:local`。
- `worker/games/<game>.old/` の扱い(残す/消す)はユーザーに任せる。

## 関連

- タイトル資産の作成・アップロード → `upload-title-assets` skill
- CPU系タイトルのローカル録画検証 → `verify-recording-locally` skill
- MODのビルド・RVA → `build-mods` skill、`worker/docs/mods.md`
- 本番でのAPI直叩き録画 → `verify-recording-in-production` skill
