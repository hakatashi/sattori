# タイトル資産アーカイブ(Issue #22)

ゲーム本体・WINEPREFIX・MOD ビルド成果物をまとめて S3 へ置く「タイトル資産アーカイブ」の
参照仕様。**新タイトルを足すとき・ゲーム本体や MOD を差し替えるとき・自宅ワーカーの
キャッシュ挙動を変えるときに読む。** 何をイメージへ焼き込み何をアーカイブへ回すかの区分は
[`worker/README.md`](../README.md) §8、**アーカイブを作って流すコマンド(タイトルごとの
同梱物・`tar` の注意点込み)は `upload-title-assets` skill にある**(ここには構成とワーカー側の
展開の仕組みだけを書く)。

## 1. アーカイブの構成

新タイトル追加時やゲーム本体・MOD更新時は、以下を1本の tar.gz にまとめて
`s3://${TITLE_ASSETS_BUCKET}/titles/{title}/assets.tar.gz` へアップロードする
(`TITLE_ASSETS_BUCKET` は `cdk deploy` 後の `TitleAssetsBucketName` 出力)。アーカイブ内のパスは
`worker/` 配下への展開先と一致させること(`title_assets.py` が `/app` 直下へ相対パスのまま展開):

```
games/{title}/                                  # ゲーム本体一式(.cfg はウィンドウモード必須)
prefixes/{title}-wined3d-gl/                    # 日本語ロケール初期化済み WINEPREFIX
mods/common/build/injector.exe                  # DLL インジェクタ(共通)
mods/{title}_replay_autoplay/build/{title}_hook.dll  # 自動再生 MOD(タイトル毎)
```

タイトルごとの同梱物の違い(th06 の実行ファイル名・th08 のゲームデータのバージョン・
th20 の cfg と thprac など)は [`titles/`](titles/README.md) の各背景ファイルに理由込みで
書いてある。

## 2. ワーカー側の展開

`title_assets.py` はインスタンス起動時に `worker/games/{title}/` が既に存在するかを確認し、
無ければこのアーカイブをダウンロード・展開する(存在すればスキップ。Spot中断リトライ時の
同一インスタンス再利用等を想定)。展開先は `/app` 直下で、`record_{game}.py` が既定で参照
するパス(`/app/games/{game}`、`/app/prefixes/{game}-wined3d-gl` 等)と一致する。

## 3. 自宅ワーカーのキャッシュ(Issue #104)

**自宅ワーカー(`home-worker/`)は `TITLE_ASSETS_CACHE_DIR` が渡された場合、直接ダウンロード
する代わりにホスト側に永続化されたディレクトリをキャッシュとして使う**(Issue #104。
自宅回線は往復距離が長くダウンロードに40秒前後かかるため、頻繁に変わらないタイトル資産を
毎ジョブ取り直す無駄を無くす)。S3オブジェクトのETagをバージョンキーにした世代ディレクトリ
(`{cache_dir}/{game}/v-{etag}/`)として持ち、リモートのアーカイブが更新されて ETag が変われば
キャッシュミスとして扱い新しい世代を取得し直す。EC2 はこの環境変数を渡さないため常に
従来どおりの直接ダウンロードになり、`title_assets.py` 自身は「自宅かEC2か」を分岐しない。
**キャッシュの構造・世代削除の判断根拠を変える前に
[`docs/decisions/0040`](../../docs/decisions/0040-home-worker-title-assets-cache.md) を読むこと。**
旧世代が最大6時間残る制約は
[`docs/known-limitations.md`](../../docs/known-limitations.md) §4。
