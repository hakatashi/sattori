# 0072. WebCdnはオリジンのno-cacheに関わらずエッジでHTMLをキャッシュする

- **状態**: 有効
- **決定日**: 2026-11-12
- **対象**: infra
- **関連**: Issue #376、Issue #210

`WebCdn`のデフォルトビヘイビアは、minTTL 1日の専用`CachePolicy`を使う。これを標準の
ポリシー(minTTL 1秒)へ戻すと、HTMLが毎回S3へ再検証されTTFBが約1秒に悪化する。
S3を`cdk deploy`の外で書き換えたときは、手動で`/*`を無効化しないと最大1日古いままになる。

## 背景

HTML等には S3 の`Cache-Control: no-cache`を付けている(Issue #210、ブラウザに古いHTMLを
持たせないため)。CloudFrontもこれに従い、毎回オリジン(eu-south-2)へ条件付きリクエストを
送っていた(`x-cache: RefreshHit from cloudfront`)。Lighthouseで
`Server responded slowly (observed 804 ms)`と指摘された。

## 決定

`infra/lib/sattori-stack.ts`の`webCachePolicy`(minTTL=defaultTTL=1日、maxTTL=365日、
gzip/Brotli有効)を`WebCdn`のデフォルトビヘイビアに付ける。minTTLはオリジンの`no-cache`より
優先されるので、エッジではキャッシュされ、ブラウザへは`no-cache`がそのまま渡る。
鮮度は`WebDeploy`・`WebDeployAssets`の`distributionPaths: ["/*"]`による無効化が担う。

## 根拠

東京からの`curl`実測(各数回、2026-11-12)。

| x-cache | TTFB |
| --- | --- |
| Hit from cloudfront | 0.22〜0.31 s |
| RefreshHit from cloudfront | 0.94〜1.03 s |

## 採らなかった選択肢

- **オリジンの`Cache-Control`を`max-age`付きに変える**: ブラウザにも古いHTMLが残り、
  Issue #210の趣旨(再検証の強制)に反する。
- **Origin Shield**: Missの往復は縮まるが、月間1000録画規模では費用対効果が薄い。
- **minTTLを短く(数分)する**: アクセスが少ないPOPでHit率が上がらない。

## 影響範囲

- `infra/README.md`のCloudFront節。
- 初回アクセス・デプロイ直後・アクセスの少ないPOPでは依然としてMissになり、約1秒かかる。
- `index.html`以外(`sitemap.xml`・`robots.txt`・OGP画像等)も同じポリシーで1日キャッシュされる。
