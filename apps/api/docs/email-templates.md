# メール本文（`ses.ts`）

マジックリンクメール・完了メールの本文組み立ての参照仕様。`apps/api/README.md` §8から
分割してある。なぜ`replayInfo`をクライアントから受け取らずサーバー側で再パースするか、
なぜ本文の各フィールドをサニタイズするかは
[`docs/decisions/0032`](../../../docs/decisions/0032-replay-info-server-side-reparse-only.md)
を参照。

マジックリンクメール・完了メールの2通とも、文面はジョブ作成時に選ばれた言語
（`JobRecord.language`）で出し分ける。本文の構成はどちらも共通で、冒頭に**どのリプレイに
ついてのメールかを示すブロック**（作品タイトル・プレイヤー名・難易度・自機タイプ・スコア。
`JobRecord.replayInfo` 由来で、値が取れない項目と `replayInfo` 自体が無いジョブでは
その行／ブロックごと省く）を置き、続けてジョブページへのリンクを案内する（Issue #95）。

- リンクは常に**ジョブページ**（`/jobs/{jobId}`、`en`なら`/en/jobs/{jobId}`）で、
  動画の直リンクは載せない（ダウンロードURLはジョブの状態次第で変わり得るため）。
- 完了メールのダウンロード期限（`calculateDownloadExpiresAt()`）は、**日本語の文面はJST、
  英語の文面はUTC**で表記する（メールでは閲覧者のタイムゾーンが分からないため、
  タイムゾーン名まで必ず併記する）。
- 作品タイトルは `GAME_TITLES`（日本語名。副題に英語名を含む）を両言語で使い、自機タイプは
  言語に応じたローカライズ名（`localizedCharacterName()`）を使う。
- `player`/`character`/`difficulty`は`sanitizeReplayInfoField()`で改行・制御文字を
  除去し32文字に打ち切ってから埋め込む。サーバー側再パース（`requestMagicLink.ts`）
  だけでは防げない長文注入への二段目の防御で、理由は
  [`docs/decisions/0032`](../../../docs/decisions/0032-replay-info-server-side-reparse-only.md)。
