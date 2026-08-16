# 0026. ユニーク訪問者数はIPを日次saltでハッシュ化した仮の訪問者IDで数える

- **状態**: 有効
- **決定日**: 2026-08-16
- **対象**: apps/api / infra
- **関連**: Issue #144、Issue #142（PR #143）、`docs/decisions/0024-cookieless-analytics-beacon.md`

`POST /beacon`が記録する各イベントに、クライアントIPを日次ローテーションのsaltで
ハッシュ化した`visitorHash`を付与する。生IPは保存せず、saltは日ごとに変わるため
日をまたいだ訪問者の突き合わせはできない。

## 背景

`docs/decisions/0024`はCookie無しの計測ビーコンを導入した際、Plausibleが採用する
「IPを日次saltでハッシュ化してユニーク判定する」方式を検討したが、当時のスコープ
（属性ごとの記録）には含めず意図的に見送った（同ファイル「採らなかった選択肢」）。
その後、ユニーク訪問者数も見たいという要望が別途出たため、Issue #144として
改めて着手した。

## 決定

- `apps/api/src/analyticsSalt.ts`の`getOrCreateDailySalt(table, date)`が、
  `SettingsTable`（`apps/api/src/settings.ts`と同じテーブル、Issue #14で導入済み）
  から`settingKey: "analyticsSalt#YYYY-MM-DD"`のitemを読む。無ければ
  `crypto.randomBytes(32)`で新しいsaltを生成し、`ConditionExpression:
  attribute_not_exists(settingKey)`の条件付き`PutCommand`で書き込む。複数の
  Lambda実行が同時に初回アクセスしても、条件不成立になった側は書き込まれた値を
  読み直すことで、その日のsaltを1つに収束させる（`rateLimit.ts`と同じ
  「条件付き書き込みで競合を解決する」パターン）。
- saltのitemだけ`ttl`属性（2日）を持たせ、`SettingsTable`に
  `timeToLiveAttribute: "ttl"`を設定した（`infra/lib/sattori-stack.ts`）。
  既存のキルスイッチ設定item（`settingKey: "global"`）は`ttl`属性を持たないため
  影響を受けない。
- `apps/api/src/analytics.ts`の`extractClientIp()`が、CloudFront経由のリクエスト
  では`X-Forwarded-For`ヘッダーの先頭値（CloudFrontが自動付与する、元のクライアント
  IP）を、直接HTTP APIを叩かれた場合（開発時等）はAPI Gatewayの`sourceIp`を使う。
  `hashVisitorId(ip, salt)`が`sha256(salt + ":" + ip)`を計算し、`recordAnalyticsEvent()`
  がこの値を`visitorHash`として`AnalyticsEventsTable`のitemに含める。**IPそのものは
  一切保存しない**（ハッシュ計算後は破棄）。
- 別テーブルではなく既存の`AnalyticsEventsTable`にフィールドを1つ足す形にした。
  ユニーク訪問者数は「あるeventDateパーティション内でvisitorHashが何種類あるか」で
  集計できるため、イベントとは別のエンティティとして管理する必要がないため。

## 根拠

- **SSM Parameter Store（`docs/decisions/0005`と同じ運用）ではなく`SettingsTable`
  を選んだ**。saltは1日ごとに自動生成・自動失効させたいが、SSMのSecureStringは
  `cdk deploy`前後の手動投入を前提にした運用（`CLAUDE.local.md`）であり、日次の
  自動ローテーションとは相性が悪い。`SettingsTable`はDynamoDBの単純なGet/Put/TTLで
  完結し、`RecordAnalyticsEventFn`に新規リソースを増やさずに済む。
- **saltの取得を`GetItem`→（無ければ）条件付き`PutItem`にした**。単純な
  `PutItem`（無条件上書き）だと、同時に複数のLambda実行が別々のsaltを生成して
  上書きし合い、同じ日のイベント同士でも別のsaltでハッシュ化されてしまい
  ユニーク判定が壊れる。条件付き書き込みで「最初の1件だけを勝たせる」ことで
  1日1saltを保証する。
- **ハッシュ化訪問者IDを`AnalyticsEventsTable`に同居させた**（採らなかった選択肢の
  「別テーブル」を退けた）。ユニーク訪問者数の算出に必要なのは「同じeventDateの
  中でvisitorHashが何種類あるか」だけであり、訪問者を主キーに持つ別テーブルを
  用意しても集計方法が変わらない上、TTL・スキーマ管理の対象が増えるだけになる。

## 採らなかった選択肢

- **saltをSSM Parameter Storeで管理**: 上記「根拠」参照。日次自動ローテーションと
  手動投入前提の運用が噛み合わない。
- **ハッシュ化訪問者IDを別テーブルにする**: 上記「根拠」参照。
- **管理画面へのユニーク訪問者数の表示**: 本Issueのスコープ外とし、別Issueで
  検討する（このリポジトリのIssueトラッカー参照）。集計・可視化はまだ実装して
  いない——現時点では`visitorHash`を記録するところまでが本決定の範囲。

## 影響範囲

- `apps/api/src/analyticsSalt.ts`（新規）・`analytics.ts`（`hashVisitorId()`・
  `extractClientIp()`・`recordAnalyticsEvent()`のシグネチャ変更）・
  `handlers/recordAnalyticsEvent.ts`・`config.ts`（`AnalyticsConfig.settingsTable`）
- `infra/lib/sattori-stack.ts`（`SettingsTable`への`timeToLiveAttribute`追加、
  `RecordAnalyticsEventFn`への`SETTINGS_TABLE`環境変数・`SettingsTable`への
  読み書き権限付与）
- 収集する情報を増やす変更なので、これ以上IPやUAから引き出す情報を増やす場合は
  `docs/decisions/0024`の「あえて集めないもの」との整合を必ず確認すること。
