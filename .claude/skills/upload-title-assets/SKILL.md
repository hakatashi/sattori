---
name: upload-title-assets
description: 東方タイトルのゲームデータ・WINEPREFIX・MOD をまとめた資産アーカイブを作って S3 の TitleAssetsBucket へアップロードする手順（th06/th06c/th06nc/th07/th08/th09/th10/th11/th12/th15/th20/th128）。WINEPREFIX の新規作成（setup_wineprefix.sh）も含む。「タイトル資産をアップロードして」「th08 のゲームデータを差し替えたい」「WINEPREFIX を作り直したい」等で使う。tar のオプションやタイトルごとの同梱物に落とし穴があるため、必ずこの手順に従うこと。
---

# タイトル資産（ゲームデータ）の S3 アップロード

ワーカーは録画のたびに S3 の `TitleAssetsBucket` からタイトル資産（ゲーム本体・
WINEPREFIX・MOD の DLL）を取得して展開する。アーカイブ構成と展開の仕組みは
`worker/docs/title-assets.md` を参照。

## 0. 環境値の解決

バケット名はリポジトリにコミットしていない（`cdk deploy` が生成する名前）。

```bash
source scripts/sattori-env.sh
echo "$SATTORI_TITLE_ASSETS_BUCKET"
```

> 2026-08 の eu-south-2 移設に伴い、`TitleAssetsBucket` は eu-south-2 に新規作成し直した
> （クリーンスレート方針、旧 us-east-1 バケットのデータは引き継いでいない）。上記の
> 解決結果が常に正であり、ドキュメントに書かれた古いバケット名は使わないこと。

## 1. `tar` 作成時の注意点

### 1.1 `-h`（`--dereference`）を付けないこと

WINEPREFIX 配下には `dosdevices/z:` → `/` のような絶対パスへのシンボリックリンクが
Wine のドライブマッピングとして正規に存在する。`-h` はアーカイブ対象ツリー内の
**すべての**シンボリックリンクを再帰的に実体化してしまうため、`z:` 経由でルート
ファイルシステム全体を巻き込んでアーカイブが数GB〜青天井に膨張する（th08 で 3.3GB 超まで
肥大化した実例あり）。

内部のシンボリックリンクはリンクのまま格納してよい。`worker/title_assets.py` の
`tar.extractall` により、展開時に絶対リンクとして正しく復元される。

### 1.2 セーブデータ（`score.dat`）やランタイム生成物（`log.txt`等）を同梱しないこと

開発機やローカル検証でプレイ・録画した際のセーブデータ（`score.dat`）やランタイムログ
（`log.txt`）、Steam Cloud メタデータ（`steam_autocloud.vdf`）、リプレイ残骸（`replay/`）が
`games/{title}/` 配下に残っていると、アーカイブに同梱されて本番ワーカーへ展開されてしまう。
録画ジョブは常にクリーンな状態で実行されるべきであるため、**`tar` 作成時に `--exclude` で
除外するか、事前に削除すること**。

```bash
TAR_EXCLUDES=(
  --exclude='score.dat'
  --exclude='log.txt'
  --exclude='steam_autocloud.vdf'
  --exclude='games/*/replay/*'
)
```

## 2. タイトルごとの手順

いずれも `cd worker` してから実行し、`source scripts/sattori-env.sh` を済ませておく。

**タイトルごとのコマンド（同梱物・`tar`の引数・アップロード先）は同じディレクトリの
[`titles.md`](titles.md) にある。対象タイトルの節だけを開いて実行すること**（タイトルごとに
同梱物が違い、他タイトルの手順の流用は事故のもとになる）。

### アップロード後: フォールバック先のレプリカへの複製を確かめる

TitleAssetsBucket の `titles/` は、GPU の容量不足フォールバック先（eu-north-1）のレプリカへ
S3 レプリケーションで自動複製される（Issue #313、
[`decisions/0062`](../../../docs/decisions/0062-gpu-fallback-region-local-output-and-title-assets.md)）。
複製は非同期で、1GB 前後のアーカイブなら数分かかる。**複製が終わるまでの間、フォールバック先で動く
GPU ジョブは旧資産を読む**。差し替えたタイトルの検証ジョブは、完了を確かめてから流すこと。

```bash
GAME=th06nc  # アップロードしたタイトル
# 原本の複製状態が COMPLETED になるまで待つ（PENDING → COMPLETED。FAILED なら設定を疑う）
until [ "$(aws s3api head-object --region eu-south-2 --bucket "$SATTORI_TITLE_ASSETS_BUCKET"   --key "titles/$GAME/assets.tar.gz" --query ReplicationStatus --output text)" = COMPLETED ]; do
  echo "複製待ち…"; sleep 15
done
# レプリカのETagが原本と一致することを確かめる
for b in "eu-south-2 $SATTORI_TITLE_ASSETS_BUCKET" \
         "eu-north-1 sattori-title-assets-${SATTORI_AWS_ACCOUNT_ID}-eu-north-1"; do
  set -- $b
  aws s3api head-object --region "$1" --bucket "$2" --key "titles/$GAME/assets.tar.gz" --query ETag --output text
done
```

## 3. WINEPREFIX の作成・更新（`setup_wineprefix.sh`）

9タイトル（th06〜th20・th128の32bitタイトル）は同じ手順（`wineboot -u` 初期化 + MS Gothic /
MS Mincho 配置・レジストリ登録）で作成する。`WINEPREFIX` 引数は**絶対パス必須**のため
`$(pwd)` で絶対パス化して渡す。

ローカルに X server がない場合は `xvfb-run -a` を前置する（`wineboot` の
`err:winediag:nodrv_CreateWindow` 等の警告を避けられるが、無くても実害はない）。

```bash
cd worker
for t in th06 th07 th08 th09 th10 th11 th12 th20 th128; do
  xvfb-run -a ./setup_wineprefix.sh "$(pwd)/prefixes/${t}-wined3d-gl" \
    "$(pwd)/games/assets/msgothic.ttc" "$(pwd)/games/assets/msmincho.ttc"
done
```

ディレクトリが既に存在すれば `wineboot` 初期化はスキップされ、フォント修正だけが適用される。

### th06c（64bitプレフィックス）

`setup_wineprefix.sh`は新規作成時に`WINEARCH=win32`を強制するため、**th06c.exe
（PE32+/x86-64）はそのままでは動かない**。先に自分で64bitプレフィックスを作ってから
同スクリプトを呼ぶ（既存ディレクトリがあればスクリプトは初期化をスキップし
フォント登録だけ行う、という仕組みを利用する）。

```bash
cd worker
WINEARCH=win64 WINEPREFIX="$(pwd)/prefixes/th06c-wined3d-gl" xvfb-run -a wineboot -u
WINEPREFIX="$(pwd)/prefixes/th06c-wined3d-gl" wineserver -w
xvfb-run -a ./setup_wineprefix.sh "$(pwd)/prefixes/th06c-wined3d-gl" \
  "$(pwd)/games/assets/msgothic.ttc" "$(pwd)/games/assets/msmincho.ttc"

# クラッシュ時にwinedbgのGUIがXvfb上に居座りウィンドウ検出を狂わせるのを防ぐ
# (touhou-recorder reports/74)。
WINEPREFIX="$(pwd)/prefixes/th06c-wined3d-gl" wine reg add \
  'HKCU\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f
```

**このスクリプトが再現するのは touhou-recorder のレポートで実際に文書化・検証された範囲
（プレフィックス初期化 + フォント修正）だけ**なので、それ以外に WINEPREFIX へ手作業で加えた
変更があった場合は再現されない可能性がある。日本語ロケール（`LANG`/`LC_ALL`）はここでは
扱わない（`recording.config.GameConfig.build_env()` が起動時に毎回設定する。理由は
`worker/docs/titles/th07.md`）。**WINEPREFIX を作り直したら §2 でタイトル資産アーカイブを
作り直してアップロードすること。**

### th06nc（64bitプレフィックス + DXVK配置）

th06cと同じ手順で64bitプレフィックスを作成したうえで、**DXVK（D3D11→Vulkan）を
追加配置する**（GPU描画必須タイトルのみの手順、`worker/docs/titles/th06nc.md`参照。
wined3dよりDXVKの方が重複フレーム率が一貫して優位だったため、th06ncは既定でDXVKを
使う——`record_th06nc.py`が`WINEDLLOVERRIDES=d3d11,dxgi,d3d10core=n`を設定する）。

```bash
cd worker
WINEARCH=win64 WINEPREFIX="$(pwd)/prefixes/th06nc-wined3d-gl" xvfb-run -a wineboot -u
WINEPREFIX="$(pwd)/prefixes/th06nc-wined3d-gl" wineserver -w
xvfb-run -a ./setup_wineprefix.sh "$(pwd)/prefixes/th06nc-wined3d-gl" \
  "$(pwd)/games/assets/msgothic.ttc" "$(pwd)/games/assets/msmincho.ttc"
WINEPREFIX="$(pwd)/prefixes/th06nc-wined3d-gl" wine reg add \
  'HKCU\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f

# DXVK配置: 対応するDXVKリリース(dxvk-<version>.tar.gz)のx64 DLLを
# system32へ配置する前に、wineビルトインを退避しておくこと
# (WINEDLLOVERRIDESを付けない限りwineは既定でbuiltinを優先するため、
# 退避しなくても動作はするが、誤ってオーバーライドを外した場合の事故を防ぐ)。
PREFIX="$(pwd)/prefixes/th06nc-wined3d-gl"
SYS32="$PREFIX/drive_c/windows/system32"
mkdir -p "$SYS32/_wine_builtin_backup"
for dll in d3d11 dxgi d3d10core; do
  mv "$SYS32/$dll.dll" "$SYS32/_wine_builtin_backup/$dll.dll"
  cp "/path/to/dxvk-<version>/x64/$dll.dll" "$SYS32/$dll.dll"
done
```

**DXVKのバージョンはtouhou-recorderでの実機検証時に使用したものと同じにすること**
（バージョン間の互換性は未検証）。DXVKの入手元・ライセンスはtouhou-recorder側の
記録を確認する。

## 関連

- MOD（`*_hook.dll`）のビルド → `build-mods` skill
- デプロイ全般 → `deploy-sattori` skill
- アーカイブ構成・ワーカー側の展開処理 → `worker/docs/title-assets.md`
- タイトルごとの同梱物の理由 → `worker/docs/titles/thNN.md`
