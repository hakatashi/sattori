---
name: upload-title-assets
description: 東方タイトルのゲームデータ・WINEPREFIX・MOD をまとめた資産アーカイブを作って S3 の TitleAssetsBucket へアップロードする手順（th06/th07/th08/th09/th10/th11/th12/th20）。WINEPREFIX の新規作成（setup_wineprefix.sh）も含む。「タイトル資産をアップロードして」「th08 のゲームデータを差し替えたい」「WINEPREFIX を作り直したい」等で使う。tar のオプションやタイトルごとの同梱物に落とし穴があるため、必ずこの手順に従うこと。
---

# タイトル資産（ゲームデータ）の S3 アップロード

ワーカーは録画のたびに S3 の `TitleAssetsBucket` からタイトル資産（ゲーム本体・
WINEPREFIX・MOD の DLL）を取得して展開する。アーカイブ構成と展開の仕組みは
`worker/README.md` §8 を参照。

## 0. 環境値の解決

バケット名はリポジトリにコミットしていない（`cdk deploy` が生成する名前）。

```bash
source scripts/sattori-env.sh
echo "$SATTORI_TITLE_ASSETS_BUCKET"
```

> 2026-08 の eu-south-2 移設に伴い、`TitleAssetsBucket` は eu-south-2 に新規作成し直した
> （クリーンスレート方針、旧 us-east-1 バケットのデータは引き継いでいない）。上記の
> 解決結果が常に正であり、ドキュメントに書かれた古いバケット名は使わないこと。

## 1. `tar` に `-h`（`--dereference`）を付けないこと

WINEPREFIX 配下には `dosdevices/z:` → `/` のような絶対パスへのシンボリックリンクが
Wine のドライブマッピングとして正規に存在する。`-h` はアーカイブ対象ツリー内の
**すべての**シンボリックリンクを再帰的に実体化してしまうため、`z:` 経由でルート
ファイルシステム全体を巻き込んでアーカイブが数GB〜青天井に膨張する（th08 で 3.3GB 超まで
肥大化した実例あり）。

内部のシンボリックリンクはリンクのまま格納してよい。`worker/title_assets.py` の
`tar.extractall(..., filter="fully_trusted")` により、展開時に絶対リンクとして正しく
復元される。

## 2. タイトルごとの手順

いずれも `cd worker` してから実行し、`source scripts/sattori-env.sh` を済ませておく。

### th06（東方紅魔郷）

`games/th06` 直下の実行ファイルは元の `東方紅魔郷.exe` のまま使う。th07/th08 のような
`th06.exe` へのリネームは**しないこと** —— VsyncPatch が実行ファイル名を検証している
らしく、リネームすると白画面ハングが再発する（経緯は
`worker/docs/titles/th06.md`）。

`vpatch.exe` / `vpatch.ini` / `vpatch_th06.dll`（VsyncPatch 本体）は `games/th06` 直下に
同梱し、`recording.instance.prepare_instance()` の rsync で自動コピーさせる。

```bash
tar -czf /tmp/th06-assets.tar.gz \
  games/th06 \
  prefixes/th06-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th06_replay_autoplay/build/th06_hook.dll
aws s3 cp /tmp/th06-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th06/assets.tar.gz"
```

### th07（東方妖々夢）

```bash
tar -czf /tmp/th07-assets.tar.gz \
  games/th07 \
  prefixes/th07-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th07_replay_autoplay/build/th07_hook.dll
aws s3 cp /tmp/th07-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th07/assets.tar.gz"
```

### th08（東方永夜抄）

- `games/th08` には公式アップデータ **ver1.00d 相当**のゲームデータを配置すること
  （ver1.00a は fps 暴走の既知不具合あり、`worker/docs/titles/th08.md` 参照）。
- `mods/th08_replay_autoplay/build/th08_hook.dll` は `mods/common/fps_monitor.cpp` を
  含めて再ビルドが必要。
- `prefixes/th08-wined3d-gl` はシンボリックリンクではなく**実ディレクトリ**として
  配置すること（`rsync -a` 等で実体コピー）。

```bash
tar -czf /tmp/th08-assets.tar.gz \
  games/th08 \
  prefixes/th08-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th08_replay_autoplay/build/th08_hook.dll
aws s3 cp /tmp/th08-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th08/assets.tar.gz"
```

### th09（東方花映塚）

`games/th09` は `touhou-recorder` の `games/th09` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th09.dll`）は同梱してよいが、
`record_th09.py`は`extra_dlls`で注入しない（録画では常に無効。不具合発生時のみ
手動で使う位置づけ、`worker/docs/titles/th09.md`参照）。

```bash
tar -czf /tmp/th09-assets.tar.gz \
  games/th09 \
  prefixes/th09-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th09_replay_autoplay/build/th09_hook.dll
aws s3 cp /tmp/th09-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th09/assets.tar.gz"
```

### th10（東方風神録）

`games/th10` は `touhou-recorder` の `games/th10` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th10.dll`）を `games/th10` 直下に
同梱すること（th06と同じ`extra_dlls`の仕組みで注入される）。同梱する`vpatch.ini`の
`BugFixTh10Power3`の値自体はどちらでもよい —— `record_th10.py`が録画直前に
`TH10_BUGFIX_MARISA_B`環境変数に応じて必ず上書きする（`worker/docs/titles/th10.md`参照）。

```bash
tar -czf /tmp/th10-assets.tar.gz \
  games/th10 \
  prefixes/th10-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th10_replay_autoplay/build/th10_hook.dll
aws s3 cp /tmp/th10-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th10/assets.tar.gz"
```

### th11（東方地霊殿）

`games/th11` は `touhou-recorder` の `games/th11` から `rsync` でコピーする
（`log.txt`（前回プレイのランタイムログ）・`unins000.dat` / `unins000.exe`
（アンインストーラー）は動作に不要なため除外）。

MS明朝（`msmincho.ttc`、NPC 会話シーン等で必要、`worker/docs/titles/th11.md` 参照）を
`worker/games/assets/msmincho.ttc` へ配置しておくこと。

```bash
tar -czf /tmp/th11-assets.tar.gz \
  games/th11 \
  prefixes/th11-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th11_replay_autoplay/build/th11_hook.dll
aws s3 cp /tmp/th11-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th11/assets.tar.gz"
```

### th12（東方星蓮船）

`games/th12` は `touhou-recorder` の `games/th12` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th12.dll`）を `games/th12` 直下に
同梱すること（th10と同じ`extra_dlls`の仕組みで注入される）。**th12はVsyncPatchを常時
有効化する固定仕様**（th10の`BugFixTh10Power3`のような切替オプションは無い、
`worker/docs/titles/th12.md`参照）なので、同梱する`vpatch.ini`の内容自体はどちらでも
よい——`extra_dlls`に指定するだけでVsyncPatch本体が常に注入される。

```bash
tar -czf /tmp/th12-assets.tar.gz \
  games/th12 \
  prefixes/th12-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th12_replay_autoplay/build/th12_hook.dll
aws s3 cp /tmp/th12-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th12/assets.tar.gz"
```

### th20（東方錦上京）

`games/th20`・`prefixes/th20-wined3d-gl` は `touhou-recorder` の同名ディレクトリから
`rsync` でコピーする（`log.txt` は不要なため除外）。同梱必須のものが2つある。

1. **cfg（`th20.cfg`、ウィンドウモードのもの）を `games/th20/` 直下に必ず同梱する**。
   ワーカーがこれを WINEPREFIX 内の `%APPDATA%/ShanghaiAlice/th20/` へコピーする元になる。
   無いと初回起動時の解像度選択ダイアログで止まり録画に失敗する
   （touhou-recorder reports/44）。
2. **thprac 本体（`thprac.v2.3.0.3.exe`）を `games/th20/` 直下に同梱する**
   （デシンク対策、touhou-recorder reports/50・Issue #105）。`touhou-recorder` の
   `games/th20/` からコピーする。`.pdb`（15MB、デバッグシンボル）は実行時に不要なので
   入れないこと。**無い場合は `attach_thprac()` が警告を出して thprac 無しで録画を
   続行するため、録画は成功するがデシンクが再発する**（= 気づきにくい）。
   thprac を更新した場合は `record_th20.py` の `thprac_exe` のファイル名も併せて更新する。

```bash
tar -czf /tmp/th20-assets.tar.gz \
  games/th20 \
  prefixes/th20-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th20_replay_autoplay/build/th20_hook.dll
aws s3 cp /tmp/th20-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th20/assets.tar.gz"
```

> アーカイブ内の `prefixes/th20-wined3d-gl/drive_c/users/hakatashi/` はこのままでよい。
> ワーカーは実行中の UNIX ユーザーから `%APPDATA%` を解決する
> （`recording.instance.resolve_appdata_dir()`）ので、コンテナの実行ユーザー（root）と
> 一致させる必要はない。

## 3. WINEPREFIX の作成・更新（`setup_wineprefix.sh`）

8タイトルとも同じ手順（`wineboot -u` 初期化 + MS Gothic / MS Mincho 配置・レジストリ登録）で
作成する。`WINEPREFIX` 引数は**絶対パス必須**のため `$(pwd)` で絶対パス化して渡す。

ローカルに X server がない場合は `xvfb-run -a` を前置する（`wineboot` の
`err:winediag:nodrv_CreateWindow` 等の警告を避けられるが、無くても実害はない）。

```bash
cd worker
for t in th06 th07 th08 th09 th10 th11 th12 th20; do
  xvfb-run -a ./setup_wineprefix.sh "$(pwd)/prefixes/${t}-wined3d-gl" \
    "$(pwd)/games/assets/msgothic.ttc" "$(pwd)/games/assets/msmincho.ttc"
done
```

ディレクトリが既に存在すれば `wineboot` 初期化はスキップされ、フォント修正だけが適用される。

**このスクリプトが再現するのは touhou-recorder のレポートで実際に文書化・検証された範囲
（プレフィックス初期化 + フォント修正）だけ**なので、それ以外に WINEPREFIX へ手作業で加えた
変更があった場合は再現されない可能性がある。日本語ロケール（`LANG`/`LC_ALL`）はここでは
扱わない（`recording.config.GameConfig.build_env()` が起動時に毎回設定する。理由は
`worker/docs/titles/th07.md`）。**WINEPREFIX を作り直したら §2 でタイトル資産アーカイブを
作り直してアップロードすること。**

## 関連

- MOD（`*_hook.dll`）のビルド → `build-mods` skill
- デプロイ全般 → `deploy-sattori` skill
- アーカイブ構成・ワーカー側の展開処理 → `worker/README.md` §8
- タイトルごとの同梱物の理由 → `worker/docs/titles/thNN.md`
