# タイトルごとの資産アーカイブ作成・アップロード手順

`upload-title-assets` skill（[`SKILL.md`](SKILL.md)）§2 のタイトル別コマンド。**対象タイトルの節
だけを開いて実行すること**。どの節も `cd worker` してから実行し、`source scripts/sattori-env.sh`
を済ませておく前提。`tar` の注意点（`-h` 禁止・セーブデータの除外）は `SKILL.md` §1、
WINEPREFIX の作成は同 §3、アップロード後のレプリカ複製の確認は同 §2 の末尾にある。

## 目次

- [1. th06（東方紅魔郷）](#1-th06東方紅魔郷)
- [2. th06c（東方紅魔郷: Classic）](#2-th06c東方紅魔郷-classic)
- [3. th06nc（東方紅魔郷: New Classic、GPU描画必須）](#3-th06nc東方紅魔郷-new-classicgpu描画必須)
- [4. th07（東方妖々夢）](#4-th07東方妖々夢)
- [5. th08（東方永夜抄）](#5-th08東方永夜抄)
- [6. th09（東方花映塚）](#6-th09東方花映塚)
- [7. th10（東方風神録）](#7-th10東方風神録)
- [8. th11（東方地霊殿）](#8-th11東方地霊殿)
- [9. th12（東方星蓮船）](#9-th12東方星蓮船)
- [10. th15（東方紺珠伝、GPU描画必須）](#10-th15東方紺珠伝gpu描画必須)
- [11. th20（東方錦上京）](#11-th20東方錦上京)
- [12. th128（妖精大戦争）](#12-th128妖精大戦争)

## 1. th06（東方紅魔郷）

`games/th06` 直下の実行ファイルは元の `東方紅魔郷.exe` のまま使う。th07/th08 のような
`th06.exe` へのリネームは**しないこと** —— VsyncPatch が実行ファイル名を検証している
らしく、リネームすると白画面ハングが再発する（経緯は
`worker/docs/titles/th06.md`）。

`vpatch.exe` / `vpatch.ini` / `vpatch_th06.dll`（VsyncPatch 本体）は `games/th06` 直下に
同梱し、`recording.instance.prepare_instance()` の rsync で自動コピーさせる。

```bash
tar -czf /tmp/th06-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th06 \
  prefixes/th06-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th06_replay_autoplay/build/th06_hook.dll
aws s3 cp /tmp/th06-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th06/assets.tar.gz"
```

## 2. th06c（東方紅魔郷: Classic）

`games/th06c`は`touhou-recorder`の`games/th06c`から`rsync`でコピーする(Steam版、
`worker/docs/titles/th06c.md`参照)。他タイトルと異なり同梱物が2点ある。

1. **正規の`steam_api64.dll`をSteamworks APIスタブで上書きすること**。スタブが無いと
   Xvfb環境でSteamクライアント常駐を要求され`exit(255)`で即終了する
   （`mods/th06c_steam_stub/build/steam_api64.dll`、`build-mods` skill参照）。
2. **injectorは32bit版ではなく64bit版（`injector64.exe`）を同梱すること**。
   th06c.exeがPE32+(x86-64)のため。

WINEPREFIXは`WINEARCH=win64`で作成する（`SKILL.md` §3参照、他タイトルの32bitプレフィックスとは
別物）。

```bash
tar -czf /tmp/th06c-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th06c \
  prefixes/th06c-wined3d-gl \
  mods/common/build/injector64.exe \
  mods/th06c_replay_autoplay/build/th06c_hook.dll
aws s3 cp /tmp/th06c-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th06c/assets.tar.gz"
```

> `games/th06c/steam_api64.dll`は`rsync`前に`mods/th06c_steam_stub/build/steam_api64.dll`
> で上書きしてからtarに固めること（`cp mods/th06c_steam_stub/build/steam_api64.dll
> games/th06c/steam_api64.dll`）。忘れると本番でSteamクライアント常駐要求により
> 即終了する。

## 3. th06nc（東方紅魔郷: New Classic、GPU描画必須）

`games/th06nc`は`touhou-recorder`の`games/th06nc`から`rsync`でコピーする(Steam版、
`worker/docs/titles/th06nc.md`参照)。th06cと同様の同梱物に加え、GPU描画・解像度切替
専用の同梱物がある。

1. **正規の`steam_api64.dll`をth06nc用Steamworks APIスタブで上書きすること**
   （`mods/th06nc_steam_stub/build/steam_api64.dll`。th06c用スタブとはAppIDのみ異なる
   別ビルド、`build-mods` skill参照）。th06c用スタブを誤って流用しないこと。
2. **injectorは64bit版（`injector64.exe`）を同梱すること**（th06ncもPE32+/x86-64）。
3. **`th06.env.720p`・`th06.env.1080p`を`games/th06nc/`直下に同梱すること**
   （12バイトの解像度設定ファイル、byte[5]が4=720p/3=1080p。`record_th06nc.py`が
   `TH06NC_RESOLUTION`環境変数に応じてどちらを`th06.env`として使うか選ぶ。
   ゲーム終了時に書き戻されるため、素の`th06.env`だけを同梱しても意味が無い）。

WINEPREFIXは`WINEARCH=win64`かつ**DXVK配置済み**のものを使う（`SKILL.md` §3の「th06nc」参照、th06cの
WINEPREFIXとは別物）。

```bash
tar -czf /tmp/th06nc-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th06nc \
  prefixes/th06nc-wined3d-gl \
  mods/common/build/injector64.exe \
  mods/th06nc_replay_autoplay/build/th06nc_hook.dll
aws s3 cp /tmp/th06nc-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th06nc/assets.tar.gz"
```

> `games/th06nc/steam_api64.dll`は`rsync`前に
> `mods/th06nc_steam_stub/build/steam_api64.dll`で上書きしてからtarに固めること
> （`cp mods/th06nc_steam_stub/build/steam_api64.dll games/th06nc/steam_api64.dll`）。

## 4. th07（東方妖々夢）

```bash
tar -czf /tmp/th07-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th07 \
  prefixes/th07-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th07_replay_autoplay/build/th07_hook.dll
aws s3 cp /tmp/th07-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th07/assets.tar.gz"
```

## 5. th08（東方永夜抄）

- `games/th08` には公式アップデータ **ver1.00d 相当**のゲームデータを配置すること
  （ver1.00a は fps 暴走の既知不具合あり、`worker/docs/titles/th08.md` 参照）。
- `mods/th08_replay_autoplay/build/th08_hook.dll` は `mods/common/fps_monitor.cpp` を
  含めて再ビルドが必要。
- `prefixes/th08-wined3d-gl` はシンボリックリンクではなく**実ディレクトリ**として
  配置すること（`rsync -a` 等で実体コピー）。

```bash
tar -czf /tmp/th08-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th08 \
  prefixes/th08-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th08_replay_autoplay/build/th08_hook.dll
aws s3 cp /tmp/th08-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th08/assets.tar.gz"
```

## 6. th09（東方花映塚）

`games/th09` は `touhou-recorder` の `games/th09` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th09.dll`）は同梱してよいが、
`record_th09.py`は`extra_dlls`で注入しない（録画では常に無効。不具合発生時のみ
手動で使う位置づけ、`worker/docs/titles/th09.md`参照）。

```bash
tar -czf /tmp/th09-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th09 \
  prefixes/th09-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th09_replay_autoplay/build/th09_hook.dll
aws s3 cp /tmp/th09-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th09/assets.tar.gz"
```

## 7. th10（東方風神録）

`games/th10` は `touhou-recorder` の `games/th10` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th10.dll`）を `games/th10` 直下に
同梱すること（th06と同じ`extra_dlls`の仕組みで注入される）。同梱する`vpatch.ini`の
`BugFixTh10Power3`の値自体はどちらでもよい —— `record_th10.py`が録画直前に
`TH10_BUGFIX_MARISA_B`環境変数に応じて必ず上書きする（`worker/docs/titles/th10.md`参照）。

```bash
tar -czf /tmp/th10-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th10 \
  prefixes/th10-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th10_replay_autoplay/build/th10_hook.dll
aws s3 cp /tmp/th10-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th10/assets.tar.gz"
```

## 8. th11（東方地霊殿）

`games/th11` は `touhou-recorder` の `games/th11` から `rsync` でコピーする
（`log.txt`（前回プレイのランタイムログ）・`unins000.dat` / `unins000.exe`
（アンインストーラー）は動作に不要なため除外）。

MS明朝（`msmincho.ttc`、NPC 会話シーン等で必要、`worker/docs/titles/th11.md` 参照）を
`worker/games/assets/msmincho.ttc` へ配置しておくこと。

```bash
tar -czf /tmp/th11-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th11 \
  prefixes/th11-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th11_replay_autoplay/build/th11_hook.dll
aws s3 cp /tmp/th11-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th11/assets.tar.gz"
```

## 9. th12（東方星蓮船）

`games/th12` は `touhou-recorder` の `games/th12` から `rsync` でコピーする。
VsyncPatch本体（`vpatch.exe` / `vpatch.ini` / `vpatch_th12.dll`）を `games/th12` 直下に
同梱すること（th10と同じ`extra_dlls`の仕組みで注入される）。**th12はVsyncPatchを常時
有効化する固定仕様**（th10の`BugFixTh10Power3`のような切替オプションは無い、
`worker/docs/titles/th12.md`参照）なので、同梱する`vpatch.ini`の内容自体はどちらでも
よい——`extra_dlls`に指定するだけでVsyncPatch本体が常に注入される。

```bash
tar -czf /tmp/th12-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th12 \
  prefixes/th12-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th12_replay_autoplay/build/th12_hook.dll
aws s3 cp /tmp/th12-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th12/assets.tar.gz"
```

## 10. th15（東方紺珠伝、GPU描画必須）

`games/th15`・`prefixes/th15-wined3d-gl` は `touhou-recorder` の同名ディレクトリから
`rsync` でコピーする（`worker/docs/titles/th15.md`参照）。

1. **cfg（`th15.cfg`、ウィンドウモードのもの）を `games/th15/` 直下に必ず同梱する**。
   ワーカーがこれを WINEPREFIX 内の `%APPDATA%/ShanghaiAlice/th15/` へコピーする元になる。
   無いと初回起動時の解像度選択ダイアログで止まり録画に失敗する（th20と同じ理由）。
2. thprac は**同梱不要**（デシンク対策としての実機での必要性が確認されていない、
   touhou-recorder reports/82）。
3. **th06ncと異なりDXVK関連ファイルは不要**。th15はwined3d（OpenGL）のままGPUを使う
   （`worker/docs/titles/th15.md`「GPU描画は必須ではないが」節参照）ため、
   WINEPREFIXは標準の`th15-wined3d-gl`（32bit、th06/07/08等と同じ作り方）でよく、
   `setup_wineprefix.sh`の特殊な引数は不要。

```bash
tar -czf /tmp/th15-assets.tar.gz \
  "${TAR_EXCLUDES[@]}" \
  games/th15 \
  prefixes/th15-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th15_replay_autoplay/build/th15_hook.dll
aws s3 cp /tmp/th15-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th15/assets.tar.gz"
```

## 11. th20（東方錦上京）

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
  "${TAR_EXCLUDES[@]}" \
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

## 12. th128（妖精大戦争）

`games/th128`・`prefixes/th128-wined3d-gl` は `touhou-recorder` の同名ディレクトリから
`rsync` でコピーする。同梱必須のものが2つある。

1. **cfg（`th128.cfg`、ウィンドウモードのもの）を `games/th128/` 直下に必ず同梱する**
   （th20と同じ理由、`worker/docs/titles/th128.md`参照）。
2. **thprac 本体（`thprac.v2.3.0.3.exe`）を `games/th128/` 直下に同梱する**（リプレイ
   選択直後にゲーム本体がフリーズする既知バグの回避に必須。th20と異なり、こちらは
   「無いと録画自体が失敗する」ため気づきやすい）。`.pdb` は不要。thprac を更新した
   場合は `record_th128.py` の `thprac_exe` のファイル名も併せて更新する。

```bash
tar -czf /tmp/th128-assets.tar.gz \
  games/th128 \
  prefixes/th128-wined3d-gl \
  mods/common/build/injector.exe \
  mods/th128_replay_autoplay/build/th128_hook.dll
aws s3 cp /tmp/th128-assets.tar.gz \
  "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/th128/assets.tar.gz"
```
