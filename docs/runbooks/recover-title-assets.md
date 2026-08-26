# タイトル資産を失ったときの復旧手順

`TitleAssetsBucket`（th06/07/08/11/th20のゲーム本体+WINEPREFIX+MOD、2.3GB超）を
誤って消してしまった、または個別オブジェクトを誤って上書き・削除したときの復旧手順。
Issue #136 でバケットに`RemovalPolicy.RETAIN`と`versioned: true`を付けた
（`infra/lib/sattori-stack.ts`のTitleAssetsBucket定義）ため多くの事故は防げるが、
それでも復旧が要るケースは残る。

## 1. まず被害の種類を切り分ける

| 事象 | 原因 | 対応 |
| --- | --- | --- |
| 特定タイトルのオブジェクトを誤って上書き・削除した | `aws s3 cp` の誤操作等 | §2（バージョニングから復元） |
| バケット自体が消えた（`cdk destroy`、置換を伴うスタック更新等） | RETAINでも手動削除やアカウント誤操作は防げない | §3（作り直し） |

## 2. オブジェクト単位の誤上書き・削除はバージョニングから復元する

`versioned: true`によりバケットへの書き込みは常に新バージョンとして積まれ、削除も
削除マーカーが乗るだけで実体は残る。**ただし旧バージョンは90日で自動削除される**
（`noncurrentVersionExpiration`、無期限に残すと上書きのたびにストレージ費が積み
上がるため）。事故に気づいたら90日以内に対応すること。90日を過ぎている場合は
この節では復元できず、§3の作り直しになる。

```bash
source scripts/sattori-env.sh

# 該当オブジェクトのバージョン一覧を確認
aws s3api list-object-versions \
  --bucket "$SATTORI_TITLE_ASSETS_BUCKET" \
  --prefix "titles/th08/assets.tar.gz"

# 削除マーカーが乗っているだけなら、それを消せば直前バージョンが復活する
aws s3api delete-object \
  --bucket "$SATTORI_TITLE_ASSETS_BUCKET" \
  --key "titles/th08/assets.tar.gz" \
  --version-id "<削除マーカーのVersionId>"

# 誤って別内容で上書きした場合は、目的のバージョンを明示的にコピーし直して
# 最新バージョンに戻す(バージョニング下ではin-placeの「巻き戻し」はできない)
aws s3api copy-object \
  --bucket "$SATTORI_TITLE_ASSETS_BUCKET" \
  --copy-source "${SATTORI_TITLE_ASSETS_BUCKET}/titles/th08/assets.tar.gz?versionId=<戻したいVersionId>" \
  --key "titles/th08/assets.tar.gz"
```

WINEPREFIXやMODのビルドし直しは不要——アーカイブそのものが過去のバージョンとして
存在するため、S3操作だけで完結する。

## 3. バケットごと消えた場合は作り直す（バックアップからの復元ではない）

**この経路に「バックアップから復元」に相当する手段は無い。** `upload-title-assets`
skillの手順をタイトル分だけ再実行し、アーカイブを一から作り直してアップロードする。

1. ゲーム本体・WINEPREFIXの原本の所在を確認する。
   - ゲーム本体・th11/th20のWINEPREFIXは別リポジトリ`touhou-recorder`（PoC）の
     `games/<title>`・`prefixes/<title>-wined3d-gl`が原本（`upload-title-assets`
     skill §2参照）。このマシン（HakataMatrix）のローカルクローンに存在する前提。
   - th06/07/08のWINEPREFIXは無ければ`setup_wineprefix.sh`で作り直せる
     （同skill §3）。ただしth08はver1.00d相当のゲームデータが前提
     （`worker/docs/titles/th08.md`）——ゲーム本体自体の原本はtouhou-recorderにも
     無く、手元の正規購入データが唯一の原本になる。
   - MOD（`*_hook.dll`）はソースがこのリポジトリの`mods/`配下にあるため、
     `build-mods` skillで再ビルドできる（原本消失の心配は無い）。
2. `upload-title-assets` skillの手順をth06/07/08/11/th20の全タイトルについて
   実行し、`TitleAssetsBucket`へ再アップロードする。
3. 再アップロード後、タイトルごとに実機スモークテスト（ジョブを1本流して録画が
   成功するか）で確認してから運用に戻す。タイトル間の資産構成の慣習をそのまま
   流用すると失敗しうる（例: th06の実行ファイルはth07/th08と違いリネーム禁止、
   `upload-title-assets` skill §2 th06の項参照）。

## 関連

- バケットの保護設定そのもの → Issue #136、`infra/lib/sattori-stack.ts`の
  `TitleAssetsBucket`
- アーカイブの作り方・タイトルごとの落とし穴 → `upload-title-assets` skill
- MODのビルド → `build-mods` skill
