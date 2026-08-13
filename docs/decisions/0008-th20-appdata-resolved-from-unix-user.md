# 0008. th20 の `%APPDATA%` 配置先を実行中の UNIX ユーザーから解決する

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: worker
- **関連**: Issue #87、touhou-recorder reports/44・46

th20 の cfg とリプレイは `%APPDATA%/ShanghaiAlice/th20/` から読まれる。その配置先を
**資産アーカイブに入っているユーザー名で決め打ちせず、実行中の UNIX ユーザーから解決する**
（`recording_common.resolve_appdata_dir()`）。決め打ちに戻すと、root で動く本番コンテナが
cfg を見失って録画に失敗する。

## 背景

th20（東方錦上京）は TH125 以降のエンジンで、cfg とリプレイをゲーム本体ディレクトリ
ではなく `%APPDATA%/ShanghaiAlice/th20/` から読む（reports/44）。**cfg が無いと
「解像度を選択してください」の初回起動ダイアログ（246x234 の小さなウィンドウ）が出て、
`WaitForStableWindow` が通らず録画に失敗する**。

Wine はこのプロファイルを `drive_c/users/<UNIX ユーザー名>` へマッピングし、無ければ
起動時に作る。ところが**タイトル資産のアーカイブには、それを作った開発機のユーザー名
（`users/hakatashi/...`）が入っている**。本番コンテナは root で動くため、決め打ちにすると
空の `users/root/` を参照することになる。

## 決定

`GameConfig.uses_appdata_profile` を立てたタイトルについて、`prepare_instance()` が
cfg とリプレイを配置する。**配置先は `recording_common.resolve_appdata_dir()` が
実行中の UNIX ユーザーから解決する**。

## 根拠

touhou-recorder（PoC）は**コンテナの実行ユーザー自体を改名して**回避していた
（reports/46）。こちらでその方式を採らなかったのは、
**「イメージの実行ユーザーと、資産アーカイブを作った開発機のユーザー名を一致させ続ける」
という運用上の約束を増やしたくない**ため。

この約束は破られても静かに壊れる。壊れ方は「初回起動ダイアログが出て
`WaitForStableWindow` がタイムアウトする」であり、原因が資産アーカイブ側の
ユーザー名にあることは録画ログからは分からない。しかも資産アーカイブは
`upload-title-assets` skill の手順で人が作るもので、作る人が変われば当然ユーザー名も
変わる。

**ユーザー名に依存しない**方式なら、資産アーカイブがどのユーザー名で作られていても、
コンテナがどのユーザーで動いていても正しく解決する。

## 採らなかった選択肢

- **コンテナの実行ユーザーを資産アーカイブに合わせて改名する**（PoC の方式）。上記のとおり
  暗黙の約束が増える。この方式が有効な検証は touhou-recorder reports/46 にある。
- **資産アーカイブを作るときにユーザー名を正規化する**。アーカイブを作る手順
  （`upload-title-assets` skill）側に規律を要求することになり、破られたときの
  壊れ方が同じく静かである。
- **`WINEPREFIX` を毎回作り直す**。WINEPREFIX の初期化は重く、資産としてアーカイブに
  同梱している前提そのものを崩す。

## 影響範囲

- `worker/recording_common.py`（`resolve_appdata_dir()` / `prepare_instance()`）
- `worker/games.py` 相当の `GameConfig.uses_appdata_profile`
- `upload-title-assets` skill（th20 の資産に `users/<開発機のユーザー名>/` が
  含まれていても構わない、という前提がこの決定に依存している）
- **同じ構造を持つタイトル（TH125 以降のエンジン）を追加するときも同じ方式を使うこと**
  （Issue #13 配下の対応タイトル拡大）
