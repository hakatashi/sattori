# 0032. replayInfo/game/estimatedDurationSecondsはクライアント申告値を使わずサーバー側で再パースする

- **状態**: 有効
- **決定日**: 2026-08-26
- **対象**: apps/api
- **関連**: Issue #133（OPS-1 フォローアップ）、PR #147

`POST /magic-links`（`RequestMagicLinkRequest`）は`game`/`estimatedDurationSeconds`/
`replayInfo`をクライアントから受け取らない。`JobRecord`のこれら3項目は、`replayKey`が
指すアップロード済み`.rpy`をサーバー側で取得・再パースした結果だけから決める。

## 背景

初期実装ではブラウザ側で解析した`replayInfo`・`game`・`estimatedDurationSeconds`を
そのまま`POST /magic-links`のボディに乗せてサーバーへ渡していた。これには2つの
問題があった。

1. `replayInfo.player`は完了メール本文へそのまま載る（`ses.ts`の
   `formatReplayInfo()`）。クライアント申告値をそのまま信用すると、第三者宛の
   フィッシング文面をここに仕込める経路になる。
2. `game`はEC2インスタンスタイプ選定（`ec2.ts`の`getCandidateInstanceTypes()`）を
   直接左右する。検証せず信用すると、実際にアップロードされたリプレイと無関係な
   高コストなタイトルを申告されうる（Issue #128 SEC-2と同種の「クライアント入力が
   直接コストに効く」経路）。

## 決定

- `requestMagicLink.ts`は`replay.ts`の`fetchReplayBytes()`（`POST /replays/parse`
  （`parseReplay.ts`）と共通処理）でアップロード済み`.rpy`を取得し、
  `parseReplayInfo()`で再パースした結果だけを`JobRecord`へ書く。クライアントが
  送ってきた`game`/`estimatedDurationSeconds`/`replayInfo`は`RequestMagicLinkRequest`
  の型自体に存在しない。
- 再パースに失敗した場合（形式不明の破損ファイル等）のみ`game`はth07を既定とし、
  `estimatedDurationSeconds`は`null`（進捗率非表示）として録画自体は継続する
  （[`0021`](0021-cost-estimation-side-data-never-fails-the-job.md)と同じ「付随データの
  取得失敗でジョブを落とさない」割り切り）。
- `parseReplayInfo()`は「形式不明」と「形式は読めるが録画未対応」をどちらも
  `ok:false`にまとめる仕様のため、後者は`result.error.game`から検出タイトルを
  別途拾う。でないと録画未対応タイトルを偽装して未対応タイトルの検出をすり抜けられる。
- 完了メール側でも二段目の防御を入れた。`sanitizeReplayInfoField()`（`ses.ts`）が
  `player`/`character`/`difficulty`を改行・制御文字除去のうえ32文字に打ち切ってから
  埋め込む。`@sattori/touhou-replay-parser`はth08・th11・th20でこれらをCRLF終端の
  可変長文字列として読むため、サーバー側再パースだけでは「CRLFを含まない任意バイト列を
  偽装した`.rpy`」による長文注入を防げない——ここが実質的な防御層になる。

## 根拠

- クライアントが送ってきた値を信用しない方が実装として単純。「サーバーが最終的に
  信じるのは`replayKey`が指す実体だけ」という一本の原則にできる。
- `estimatedDurationSeconds`の形式バリデーション（旧Issue #127 SEC-1）や`game`の
  早期チェックは、クライアント値を読まなくなったことで丸ごと不要になり削除できた
  （攻撃面を減らす方が検証コードを足すより筋が良い）。

## 採らなかった選択肢

- **クライアント値を受け取りつつサーバー側で検証を強化する**。検証ロジックを
  足すたびに攻撃面が増える。サーバーが独立して取得・再パースできる以上、
  クライアント値を経路として残す理由がそもそも無い。
- **完了メールのサニタイズだけで済ませ、再パースを見送る**。`game`はコストへ
  直接効くため、メール本文の防御だけでは高コストタイトルの偽装申告を防げない。

## 影響範囲

- `apps/api/src/handlers/requestMagicLink.ts`（`RequestMagicLinkRequest`の型・
  `fetchReplayBytes()`呼び出し）
- `apps/api/src/ses.ts`（`sanitizeReplayInfoField()`）
- `apps/web`（`requestMagicLink()`の引数からreplayInfo等を削除済み）
- `apps/api/README.md` §8「マジックリンク送信・レート制限」
- `apps/api/docs/email-templates.md`（メール本文組み立ての参照仕様）
