# 0068. 依存パッケージ更新はDependabotとリリース後クールダウン（5〜7日）・完全ピン留めでサプライチェーン汚染を防ぐ

- **状態**: 有効
- **決定日**: 2026-11-11
- **対象**: 全パッケージ（`pnpm-workspace.yaml` / `worker/` / `.github/`）
- **関連**: Issue #338、#339、#340、#341

Node.js・Python・GitHub Actions の依存更新には GitHub 標準の **Dependabot（`.github/dependabot.yml`）** を採用し、リリース直後の悪性パッケージ混入を防ぐため **5日間（メジャーは7日間）のクールダウン期間** を課す。合わせて Python ワーカーの依存（`worker/requirements*.txt`）と GitHub Actions を推移的依存・コミット SHA まで完全固定する。

## 背景

プロジェクト開始時に導入した依存パッケージの多くが当時のバージョンのまま据え置かれており、継続的なアップデート機構が必要になった。一方で、近年 npm・PyPI・GitHub Actions においてメンテナアカウント乗っ取りやタグ書き換えによるサプライチェーン攻撃が相次いでいる。特に以下の3点が無防備だった:

1. `pnpm-workspace.yaml` にリリース経過日数の制約がなく、ローカルや CI で公開直後のバージョンを解決しうる。
2. `worker/requirements.txt`・`requirements-dev.txt` が下限指定（`>=`）のみでロックされておらず、さらに `worker/Dockerfile`・`Dockerfile.gpu` が `pip3 install ... boto3` を無制約に実行していたため、イメージをビルドするたびに公開直後の `boto3`・`urllib3` 等がノーチェックで混入する。
3. `.github/workflows/*.yml` の Action がタグ指定（`@v4` 等）のみで、`tj-actions/changed-files` 型のタグ書き換え攻撃に対して脆弱だった。

## 決定

- **クールダウン期間（5〜7日）の二重強制**:
  - `.github/dependabot.yml` の全エコシステム（`npm` / `pip` / `github-actions`）に `cooldown`（`default-days: 5`, `semver-major-days: 7`）を設定する。
  - ローカルでの `pnpm up` / `pnpm add` でも同じ制約が効くよう、`pnpm-workspace.yaml` に `minimumReleaseAge: 7200`（5日間＝7200分）を設定する。
  - ルート `package.json` の `pnpm.onlyBuiltDependencies: ["esbuild"]` を維持し、新規・推移的パッケージの `postinstall` 等ライフサイクルスクリプトの実行を原則禁止する。
- **Python 依存の3段ピン留めと `--no-deps` インストール**:
  - Docker イメージ内で `pip` 導入する `boto3` とその推移的依存だけを `worker/requirements-docker.txt` に `==` で完全固定し、`worker/Dockerfile`・`Dockerfile.gpu` では `pip3 install --break-system-packages --no-cache-dir --no-deps -r /tmp/requirements-docker.txt` で導入する（Docker 内の `numpy`・`pillow` は従来どおり Ubuntu 24.04 の `apt` パッケージ `python3-numpy`・`python3-pil` を使うため含めない）。
  - ローカル実行用の `worker/requirements.txt` は `-r requirements-docker.txt` に `numpy`・`pillow` の固定バージョンを足し、テスト用の `worker/requirements-dev.txt` は `-r requirements.txt` に `pytest` 系（推移的依存含む）の固定バージョンを足す3段構成とする。
- **GitHub Actions のコミット SHA ピン留め**:
  - `.github/workflows/test.yml`・`mirror-public.yml` の全 Action をフルレングスのコミット SHA（`uses: owner/repo@<sha> # vX.Y.Z`）で固定し、`mirror-public.yml` の `git-filter-repo` もバージョンを固定する。

## 根拠

- npm / PyPI に公開された悪性バージョンの大半は公開後24〜72時間以内に検知・削除されるため、5日間（120時間）の待機でゼロデイのサプライチェーン汚染の大半を回避できる。
- `requirements-docker.txt` → `requirements.txt` → `requirements-dev.txt` と `-r` で連鎖させることで、同じパッケージのバージョン記述が複数ファイルに重複せず、Dependabot の `pip`（`directory: "/worker"`）が各ファイルを一貫して更新できる。
- Docker ビルド時に `--no-deps` を付けることで、万一推移的依存の追加漏れがあっても PyPI から未固定のパッケージが勝手に解決されず、ビルドまたはテスト時点で即座に検知できる。

## 採らなかった選択肢

- **Renovate（GitHub App）の導入**:
  モノレポ自動検出や Dependency Dashboard などの機能は豊富だが、外部サードパーティ（Mend）の GitHub App にプライベート開発リポジトリ（`hakatashi/sattori-dev`）への読み書き権限を付与する必要がある。現在では GitHub 標準組み込みの Dependabot も `cooldown`・`directories`（pnpm モノレポ対応）・`groups` をすべてネイティブサポートしており、外部連携を増やさない方針（`AGENTS.md` §1・§3）に合致するため Dependabot を選んだ。
- **Docker イメージ内でも `numpy`・`pillow` を `pip` で入れる**:
  Ubuntu の `apt` パッケージ（`python3-numpy`・`python3-pil`）を使う現行構成の方がイメージビルドが速く、システムライブラリとの ABI 不整合も起きないため維持した。

## 影響範囲

- `pnpm-workspace.yaml`（`minimumReleaseAge: 7200`）
- `.github/dependabot.yml`、`.github/workflows/test.yml`、`.github/workflows/mirror-public.yml`
- `worker/requirements-docker.txt`、`worker/requirements.txt`、`worker/requirements-dev.txt`、`worker/Dockerfile`、`worker/Dockerfile.gpu`、`worker/README.md`
