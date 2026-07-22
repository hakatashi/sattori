"""GAME環境変数に応じたタイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)をS3から
取得・展開する(Issue #22)。

ECRのイメージストレージコストがタイトル数に比例して増大する問題への対応として、
ワーカーイメージ自体はタイトル非依存の共通部分のみで構成し、タイトル固有の資産
(games/{game}/, prefixes/{game}-*/, mods/**/build/*)は起動時にS3からアーカイブ
1本をダウンロード・展開する。アーカイブの作成・アップロード手順は worker/README.md
「タイトル資産のS3アップロード手順」を参照。
"""
import os
import tarfile

REPO = "/app"
DOWNLOAD_DIR = "/tmp"


def ensure_title_assets(s3, bucket, game, *, log=print):
    """タイトル資産が REPO 配下に未展開ならS3(s3://{bucket}/titles/{game}/assets.tar.gz)
    から取得して展開する。既に展開済み(同一インスタンスでのSpot中断リトライ再利用等)
    ならダウンロードをスキップする。
    """
    marker = f"{REPO}/games/{game}"
    if os.path.exists(marker):
        log(f"タイトル資産は展開済みのためスキップします: game={game}")
        return

    key = f"titles/{game}/assets.tar.gz"
    archive_path = f"{DOWNLOAD_DIR}/sattori-title-assets-{game}.tar.gz"
    log(f"タイトル資産をダウンロードします: s3://{bucket}/{key}")
    s3.download_file(bucket, key, archive_path)

    try:
        log(f"タイトル資産を展開します: {archive_path} -> {REPO}")
        with tarfile.open(archive_path, "r:gz") as tar:
            # WINEPREFIXは`dosdevices/z:`->`/`等、絶対パスへのシンボリックリンクを
            # 内部に含むのが正常な構造(Wineのドライブマッピングの仕組み)。
            # Python 3.12+の既定的な安全フィルタ`filter="data"`はそうした絶対リンクを
            # 一律拒否してしまい展開に失敗する。このアーカイブは自分たちがビルドして
            # 自分たちの非公開S3バケットへ置いた信頼済み成果物であり未検証の外部入力
            # ではないため、`filter="fully_trusted"`(3.12未満相当の無制限展開)を使う。
            tar.extractall(REPO, filter="fully_trusted")
    finally:
        os.remove(archive_path)
    log(f"タイトル資産の展開が完了しました: game={game}")
