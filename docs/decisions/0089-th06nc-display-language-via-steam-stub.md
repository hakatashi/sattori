# 0089. th06ncの表示言語は、Steamworks APIスタブが返す言語名で切り替え、詳細設定で選ばせる

- **状態**: 有効
- **決定日**: 2026-11-28
- **対象**: worker（`record_th06nc.py`・`mods/tools/steam_stub.cpp`）/ apps/api / apps/web / packages/shared
- **関連**: Issue #378、`worker/docs/titles/th06nc.md`「表示言語」

th06ncの録画の言語は、Steamworks APIスタブの`GetCurrentGameLanguage()`の戻り値で決まる。スタブは
環境変数`STEAM_GAME_LANGUAGE`を返し、ページAの詳細設定（th06ncのリプレイのみ）で選んだ言語が
`options.th06ncLanguage` → `TH06NC_LANGUAGE` → `STEAM_GAME_LANGUAGE`と渡る。**スタブを更新したら
タイトル資産の再アップロードが要る**（古いスタブのままだと常に日本語で録れる）。

## 背景

th06ncは公式初の多言語対応タイトルで、スペルカード名・会話・一部UIが12言語に切り替わる。ゲーム内に
言語設定は無く、Steamライブラリ側の設定で決まる。Sattoriはヘッドレスのwine上でSteamを動かさず、
Steamworks APIをスタブDLLで置き換えており（th06cと共用の`steam_stub.cpp`）、スタブは
`GetCurrentGameLanguage()`に`"japanese"`を固定で返していた。

## 決定

- スタブが`STEAM_GAME_LANGUAGE`環境変数（Steamの言語名）を返す。未設定は`japanese`で従来どおり。
- `RecordingOptions.th06ncLanguage`（省略可、欠損は日本語。`th06ncLanguageOf()`で読む）を追加。
  `POST /magic-links`はth06nc以外のリプレイ・未知の言語名を日本語に握り潰す（`th10BugfixMarisaB`と同型。
  [`0036`](0036-th10-bugfix-marisab-self-report.md)）。
- `buildWorkerEnv()`は`job.game === "th06nc"`のときだけ`TH06NC_LANGUAGE`を渡す。`record_th06nc.py`が
  Steamの言語名の集合で検証して`STEAM_GAME_LANGUAGE`に変換する。**ワーカーの中に自宅/EC2・段による分岐は作らない**。

## 根拠

- ゲームexeにSteamの言語名（`schinese`・`koreana`・`latam`・`brazilian`など）とロケール名の文字列があり、
  起動時にSteamAPIから言語を取得して表示を切り替える構造と分かる。
- 実機確認（`worker/tests/mod_integration`、CPU描画・フレーム同期）: `english`で英語表示になり、リプレイの
  スコア・理論尺・デシンク検知は日本語と同じ基準を満たした。詳細は`worker/docs/titles/th06nc.md`。

## 採らなかった選択肢

- **言語ごとにタイトル資産・ゲームデータを分ける**: 言語データは同じ`.dat`に入っており、分ける理由が無い。
- **ロケール（`LC_ALL`・`LANG`）で切り替える**: exeはSteamの言語名で言語を決めており、ロケールだけでは変わらない
  （ロケール名の文字列は存在するが、決定は`GetCurrentGameLanguage()`が先）。
- **言語ごとにジョブ種別・EC2の段を変える**: 描画負荷は言語で変わらないので不要。

## 影響範囲

`packages/shared/src/th06ncLanguage.ts`（言語の一覧。`worker/record_th06nc.py`の`_LANGUAGES`と一致させる。
`worker/tests/test_record_th06nc.py`が突き合わせる）・`apps/api/src/handlers/requestMagicLink.ts`・
`apps/api/src/workerEnv.ts`・`apps/web/src/components/UploadForm.tsx`・`worker/mods/tools/steam_stub.cpp`。
**本番反映の順序**: タイトル資産（スタブ入り）→ワーカーイメージ→CDK（API）→フロントエンド。
資産が先なら、APIが言語を渡し始める前でもスタブは日本語を返すので安全。
