# 0049. MOD統合テストはCIではなく`worker/games/`がある環境限定のローカル実行に限定する

- **状態**: 有効
- **決定日**: 2026-09-14
- **対象**: worker
- **関連**: `worker/tests/mod_integration/run.py`、`.github/workflows/test.yml`の
  `mods-build-smoketest`、`docs/runbooks/worker-local-recording.md` §2

`worker/mods/`(*_hook.dll)の退行検知テストを追加したが、実ゲームバイナリへ実際にMODを
注入して録画する統合テストのため、CIには組み込まず、ゲーム本体・WINEPREFIXが展開済みの
環境(`worker/games/`・`worker/prefixes/`)でのみ手動実行する運用にする。

## 背景

MODが正しく動作することは正常な録画ファイルを生成するというサービスのコア体験に直結する。
一方、現状のCI(`mods-build-smoketest`)はmingw-w64クロスビルドが通るかしか見ておらず、実機で
DLL注入が意図通り動くかの検証は担っていない(コメントにも明記済み)。この隙間を埋める手段
として、モックしたゲームプロセスでのビヘイビアテスト・実ゲーム資産を用いたE2Eテストの
2案を検討したが、前者は過去に本番で実際に起きた不具合(RVA特定ミス、ゲームデータの
バージョン差によるRVAずれ、実機タイミング依存の処理落ち等)をいずれも再現できない種類の
テストであり、実装コストに見合う効果が見込めなかった。

## 決定

`worker/tests/mod_integration/run.py`を追加した。`worker/tests/fixtures/mod-integration/`
配下の短いリプレイ(タイトルごと1本、中ボス到達後にわざと被弾してゲームオーバーする
短時間・弾幕多めのもの)を、`docs/runbooks/worker-local-recording.md` §2と同じホスト
直接実行の経路(`worker/games/<game>/`・`worker/prefixes/<game>-wined3d-gl/`・
`worker/mods/*/build/`をそのまま使い、Dockerコンテナは介さない)で実際に録画し、次の
いずれかが起きればNGとする:

- `record_thNN.py`の異常終了(重複フレーム率が閾値を超え続け全試行が失敗した場合を含む)
- リプレイずれ(デシンク)の疑いの検知(`recording.modlog.check_replay_desync()`)
- リプレイ終了を検知できずタイムアウトで打ち切られたこと(Issue #161)

これは`.github/workflows/test.yml`のジョブとして追加しない。`push`・`pull_request`では
実行されず、MOD変更後・実機検証(`verify-recording-locally` skill・touhou-recorderの
reports/)に進む前の速い足がかりとして、開発者が手動で実行する。

## 根拠

- **ゲームバイナリ(タイトル資産)は商用ソフトウェアであり、パブリックリポジトリのCI環境に
  置くのはライセンス上望ましくない。** 現状タイトル資産はS3の非公開バケットで配布されて
  おり(`upload-title-assets` skill)、この配布経路をCIまで広げるのは影響が大きい変更になる。
- **Wine+Xvfb(+GPU系タイトルはXorg+NVIDIA)+PulseAudioの実行環境をGitHub Actions上に
  構築するコストが高く、実行時間も1タイトルあたり数分かかる。** 月間最大1000録画・
  開発者1人という運用規模(AGENTS.md §1)で、pushごとに数十分規模のジョブを追加するのは
  見合わない。
- **`worker/games/`・`worker/prefixes/`にゲーム資産を展開済みの環境なら、追加のインフラ
  投資なしにコマンド一発の自動判定を導入できる。** Dockerコンテナ経由での本番イメージ
  再現(`verify-recording-locally` skillの土台)よりも、ホストに既にセットアップ済みの
  資産をそのまま使う方が導入コストが低い。

## 採らなかった選択肢

- **CIにゲーム資産を持ち込みGitHub Actions上で実行する**: ライセンス・コストの両面で
  見送った。
- **ダミーのCOMオブジェクト(IDirectInputDevice8等)でゲームプロセスをモックしたビヘイビア
  テスト**: `mods/common/`のフックは実ゲームのvtable/RVAへの直接読み書きが仕事の核心で
  あり、これまで実際に本番で起きた不具合(th09のRVA特定失敗、th07のゲームデータバージョン差
  によるRVAずれ、th20のPresentフックの実機タイミング破綻、`-static`忘れによる注入失敗等、
  `docs/known-limitations.md`に列挙済み)はどれもモック環境では原理的に再現しない種類の
  ものだった。実装コスト(Wine実行環境のCI構築・モックCOM実装の設計)に対し、過去の実績の
  あるバグを1つも捕まえられない見込みが高く見送った。
- **`verify-recording-locally` skillと同じDockerコンテナ経由・タイトル資産キャッシュの
  複製方式にする**: 本番イメージの完全な再現という利点はあるが、`worker/games/`・
  `worker/prefixes/`に既にゲーム資産・WINEPREFIXを展開済みの環境が既にあるなら、複製の
  手間なくホスト直接実行の経路(§2)をそのまま使う方が単純で速い。本番との差異(Docker
  イメージ内のOS・依存バージョンではなくホスト環境を使う)は、§2が元々持つ既知のトレード
  オフとして受け入れる。
- **全対応タイトルを最初から網羅する**: まずth06/th08の2タイトルでパイロット導入し、
  判定基準(desync検知・重複フレーム率閾値)が実運用で機能することを確認してから他タイトルへ
  展開する方針にした。

## 影響範囲

- `worker/tests/mod_integration/run.py`・`worker/tests/fixtures/mod-integration/`
- `worker/README.md`(MOD統合テストの節)
- `docs/runbooks/worker-local-recording.md`(§1からの参照)
- `.github/workflows/test.yml`は変更しない(このテストをジョブとして追加しない)
