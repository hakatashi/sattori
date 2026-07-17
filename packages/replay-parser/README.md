# @sattori/replay-parser

東方Project本編のリプレイファイル（`.rpy`）をデコードする、依存ゼロのTypeScriptライブラリです。
[Sattori](https://github.com/hakatashi/sattori)（東方リプレイ録画ウェブサービス）のために
書かれましたが、Sattori固有の型には依存しない設計になっており、単体で利用できます。

[raviddog/threplay](https://github.com/raviddog/threplay) の `ReplayDecoder.cs`（C#実装）を
TypeScriptに移植したものをベースに、Shift_JISプレイヤー名の正しいデコード、破損ファイルに対する
安全なエラーハンドリング、および threplay が未対応だったタイトルへの対応を追加しています。

## インストール

```bash
npm install @sattori/replay-parser
```

## 使い方

```ts
import { parseReplay } from "@sattori/replay-parser";
import { readFile } from "node:fs/promises";

const data = new Uint8Array(await readFile("th7_01.rpy"));
const result = parseReplay(data);

if (result.ok) {
  const { game, player, character, difficulty, score, cleared, splits } = result.replay;
  console.log(`${game}: ${player} / ${character} / ${difficulty} / ${score}`);
} else {
  // parseReplay は例外を投げない。不正・非対応・破損ファイルは
  // 判別可能なエラーコードとして返る。
  console.error(result.error.code, result.error.message);
}
```

`parseReplay` は決して例外を投げません（内部の破損データ検出は `ReplayCorruptError` として
捕捉され、`{ ok: false, error: { code: "corrupt", ... } }` に変換されます）。

## 対応タイトル

先頭4バイトのマジックバイトでタイトルを判別します。th13（神霊廟）とth14（輝針城）は
同一のマジック `t13r` を使うため、ヘッダ内のバージョンバイトで判別しています。

| ゲームID | タイトル | 検証状況 |
| --- | --- | --- |
| `th06` | 東方紅魔郷 | `test-fixtures/`のチェックイン済みリプレイ+ゲーム画面スクリーンショットで検証済み |
| `th07` | 東方妖々夢 | 同上 |
| `th08` | 東方永夜抄 | 同上（Shift_JISキャラ名を含む） |
| `th09` | 東方花映塚 | 実リプレイ（[Silent Selene](https://www.silentselene.net/)取得サンプル）で検証済み |
| `th095` | 東方文花帖 | 同上 |
| `th10` | 東方風神録 | 実リプレイ+スクリーンショット/サンプルで検証済み |
| `th11` | 東方地霊殿 | `test-fixtures/`+スクリーンショットで検証済み |
| `th12` | 東方星蓮船 | Silent Seleneサンプルで検証済み |
| `th125` | ダブルスポイラー | `test-fixtures/`のチェックイン済みリプレイで検証済み |
| `th128` | 妖精大戦争 | Silent Seleneサンプルで検証済み |
| `th13` | 東方神霊廟 | `test-fixtures/`+スクリーンショットで検証済み |
| `th14` | 東方輝針城 | 同上 |
| `th143` | 弾幕アマノジャク | `test-fixtures/`のチェックイン済みリプレイで検証済み |
| `th15` | 東方紺珠伝 | `test-fixtures/`+スクリーンショットで検証済み |
| `th16` | 東方天空璋 | Silent Seleneサンプルで検証済み |
| `th165` | 秘封ナイトメアダイアリー | **未検証**（threplay移植のみ。テストデータ未入手） |
| `th17` | 東方鬼形獣 | Silent Seleneサンプルで検証済み |
| `th18` | 東方虹龍洞 | 同上 |
| `th20` | 東方錦上京 | プレイヤー名/日付/キャラ/難易度/ステージ/スコアは`test-fixtures/`+スクリーンショットで検証済み。<br>**ステージ内訳（splits）は未対応**（下記参照） |

th19（東方獣王園）はゲーム自体にリプレイ保存機能が存在しないため対象外です。

### th20（東方錦上京）についての注記

threplayはth18までしか対応しておらず、th20はこのパッケージ独自の調査に基づく実装です。
USERセクション（プレイヤー名・日付・キャラクター・難易度・ステージ・スコア）はth10〜th18と
同一レイアウトであることを確認済みですが、th10〜th18に存在した「ヘッダのXOR復号+LZSS展開に
よるステージ内訳データ」は、手元のサンプルでは展開後サイズが常に一定（進行状況に依存しない）で
あり、フォーマットが変わっている可能性が高いことが分かっています。解析ができていないため、
`splits` は常に空配列を返します。

## 出力データ

`ParsedReplay`（`result.ok === true` の場合の `result.replay`）は、Sattori本体が使う
`ReplayInfo`（プレイヤー名・日付・キャラ・難易度・ステージ・スコア・クリア可否）よりも
リッチな情報を持ちます。特に `splits`（ステージごとのスコア・パワー・残機・ボム・グレイズ等の
内訳）と `formatVersion`（ヘッダに含まれる生のバージョン/フォーマットバイト。意味はゲームごとに
異なり、本パッケージでは意味を断定しません）は `ReplayInfo` には含まれません。

Sattori本体での `ReplayInfo` への変換は `packages/shared` の `fromParsedReplay()` が行います
（本パッケージはSattori固有の型に依存しないよう、変換ロジックをあえて持ちません）。

`splits[].lives` / `splits[].bombs` は文字列ではなく `ReplayResourceCount`
（`{ count, pieces, maxPieces }`）という構造化された型です。欠片（次の1個までの破片）を
持つゲームでは `pieces`/`maxPieces` が埋まり、持たないゲームでは `null` になります
（th128のみ例外で、`count` がパーセンテージ・`maxPieces` が常に100になります。詳細は
`src/games/th128.ts` のコメント参照）。`splits[].additional` も同様に、ゲーム固有の
付加情報（UFOの色・トランス・季節・スペルカード等）を文字列ではなく実際のプロパティを持つ
オブジェクト（例: `{ ufoColors: ["Red", "None", "None"] }`）として返します。

## テスト

`*.rpy` はリポジトリ全体で `.gitignore` 対象（著作権物のため）ですが、`test-fixtures/**` は
その例外です。ここに含まれるリプレイは**すべてこのパッケージの作者自身が実際にプレイして
作成したファイル**（プレイヤー名が `koyi` 系）であり、第三者の著作物ではないためチェックイン
しています。Silent Selene 等からダウンロードしたサンプルはリポジトリに含めていません。

各フィクスチャには対応する `*.expected.json`（`parseReplay()` の全出力。`splits` の内訳も含む）が
併置されており、ゴールデンテスト（`src/golden.test.ts`）はこれらを動的に列挙して完全一致
（`toEqual`）を検証します。追加でスクリーンショットとの目視突き合わせ済みの主要ゲームについては、
ゴールデンJSON自体の誤生成を検知できるよう独立した期待値でも確認しています。

## クレジット

デコードロジックの大部分は [raviddog/threplay](https://github.com/raviddog/threplay) の
`ReplayDecoder.cs` を参考に独自にTypeScriptへ書き起こしたものです。LZSS展開・XORブロック
復号のコアアルゴリズムは、同リポジトリが参照している
[Fluorohydride/threp](https://github.com/Fluorohydride/threp) の `common.cpp` に由来します。

いずれのリポジトリにも明示的なOSSライセンスの記載はありません
（threplayの `LICENCES.txt` はUIコンポーネント等サードパーティ依存のライセンスのみを
記載しており、`ReplayDecoder.cs` 自体のライセンスではありません）。本パッケージは
バイトオフセット・XORキー等の事実情報を独自実装に落とし込んだものとしてMITで公開しますが、
利用にあたってはこの経緯を踏まえてご判断ください。

## License

MIT（[LICENSE](./LICENSE) 参照。上記「クレジット」の経緯も参照してください）
