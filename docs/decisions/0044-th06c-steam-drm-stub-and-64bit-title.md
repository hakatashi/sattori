# 0044. th06cのSteamworks API初期化要求は最小限のスタブDLLで回避し、64bit専用の録画経路を別途用意する

- **状態**: 有効
- **決定日**: 2026-09-10
- **対象**: worker
- **関連**: Issue #240、touhou-recorder reports/74〜77、`worker/docs/titles/th06c.md`

th06c（東方紅魔郷: Classic）はSteam版でのみ配布されるPE32+(x86-64)タイトルで、他の
8タイトル（すべて32bit・非Steam限定または任意配布経路）と構造が大きく異なる。本決定は
「Steamworks APIの初期化要求をどう回避するか」と「64bitタイトルを既存パイプラインに
どう組み込むか」の2点についてのもの。

## 背景

th06c.exeは起動時に`steam_api64.dll`経由で`SteamAPI_Init`を呼び、これが失敗すると
`exit(255)`で即終了する。Xvfb上のヘッドレス録画環境にSteamクライアントを常駐させる
（Proton等の正規ルート）のは、Docker/AWS化が困難なうえ、Steamは同一アカウントでの
同時プレイに制約があり、Sattoriの並列録画（1インスタンス=1ジョブ）と相性が悪い。

またth06c.exeはPE32+(x86-64)であり、他タイトルが共有する32bit injector・MODビルド
パイプライン（`mods/common/build/injector.exe`、`i686-w64-mingw32-g++`）をそのまま
流用できない。

## 決定

**Steamworks APIを、実機で観測された9関数・3インターフェースのみを実装した最小限の
スタブDLL（`mods/th06c_steam_stub/steam_api_stub.cpp`）に差し替える。** 正規の
`steam_api64.dll`をタイトル資産アーカイブ内でスタブへ置き換えるだけで、Steamクライアント
無しでゲームが正常起動する。呼ばれていないインターフェース/メソッドはダミーvtable
（全スロット0を返す）でカバーし、実機でNULL逆参照クラッシュが確認された箇所
（`STEAMAPPS_INTERFACE_VERSION009`のスロット0/4/5、`SteamUtils010`のスロット4/9）のみ
個別の戻り値を用意する。

**64bit対応は、既存の32bitパイプラインに条件分岐を持ち込まず、`GameConfig.for_game()`の
`overrides`で`injector`/`injector_path`を明示的に上書きする方式にする。**
`for_game()`はこれまで`defaults`（`injector_path`等）を`overrides`で上書きできなかった
（`**defaults, **overrides`のキー重複でTypeError）ため、`update()`でマージするよう
`recording/config.py`を修正した。これにより「`game_id`からすべてのパスを機械的に導出する」
という既存タイトルの前提を崩さずに、th06cだけ64bit版の成果物を指すようにできる。

MOD本体（`mods/th06c_replay_autoplay/`）も入力注入方式が他タイトルと異なる（DirectInput
でもIATの`GetKeyboardState`でもなく、`KERNEL32!GetProcAddress`のIATフックで入力APIの
解決を横取りする）ため、`mods/common/dinput_hook.*`・`window_wait.cpp`には依存せず、
ウィンドウ検出（起動ダイアログの除外込み）を専用実装で持つ。一方でスコア監視
（`mods/common/score_monitor.h`）はuintptr_t/uint32_t設計のためそのまま64bitでも動作し、
共通コードを再利用した。

## 根拠

- Steamworks APIスタブの実機動作確認: touhou-recorder reports/74（9関数・3インター
  フェースの特定、`ISteamApps::GetCurrentGameLanguage()`のNULL逆参照クラッシュの発見と
  対処）。
- 64bit injector/MODのビルド・実機注入確認: touhou-recorder reports/74〜77（メニュー
  操作シーケンス・スコアRVA特定・終了検知・AWSクラウド実機検証まで完走）。
- sattori本体でのビルド確認: `worker/mods/th06c_replay_autoplay/`・`th06c_steam_stub/`を
  `x86_64-w64-mingw32-g++`でクロスビルドし、`th06c_hook.dll`・`steam_api64.dll`・
  `injector64.exe`の生成を確認済み。

## 採らなかった選択肢

- **Proton + 実際のSteamクライアントを常駐させる**: 正規ルートだがSteam常駐が必須で
  Docker/AWS化が困難、かつ同一アカウントでの同時プレイ制約により並列録画ができない
  （touhou-recorder reports/74で比較検討済み）。
- **WINEPREFIX内にWindows版Steamクライアントを導入する**: 同様にSteam常駐が必要な上、
  プレフィックスが重くなりログインも要る。
- **64bit対応をGameConfigの新規フィールド（例: `injector64: bool`）で表現する**:
  タイトルが増えるたびにフィールドが専用目的化し、th06c以外に使い道が無い。既存の
  `overrides`機構を汎用化する方が、将来別の64bitタイトルが来た場合にも同じ経路で
  対応できる。

## 影響範囲

- `worker/recording/config.py`（`GameConfig.for_game()`の`overrides`マージ順）
- `worker/record_th06c.py`（`injector`/`injector_path`の明示上書き）
- `worker/mods/th06c_replay_autoplay/`・`worker/mods/th06c_steam_stub/`
- `.claude/skills/build-mods/SKILL.md`・`.claude/skills/upload-title-assets/SKILL.md`
  （64bitクロスビルド・Steamスタブの同梱手順）
- 将来Steam版の別タイトル（th13以降）を追加する場合、同種のSteamworks API要求を
  踏む可能性が高く、本決定のスタブ方式・ログによるスロット特定運用がそのまま使える。
