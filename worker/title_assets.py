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


def _extraction_filter(member, dest_path):
    """WINEPREFIXの`dosdevices/z:`->`/`等、絶対パスへのシンボリックリンクを許可
    しつつ、それ以外はPython 3.12+の標準"data"フィルタと同じ制約を保つ独自フィルタ。

    絶対パスへのシンボリックリンクはWineのドライブマッピングとして正規の構造だが、
    標準の`filter="data"`は安全のため一律拒否する。かといって`filter="fully_trusted"`
    に丸ごと切り替えると、"data"フィルタが行っている所有権の無効化(tar内に記録された
    元の所有者(uid/gid)へのchownをスキップし、展開したプロセスの所有のままにする)まで
    失われる。すると本番ワーカー(コンテナ内でrootとして実行)がroot以外の所有権で
    展開してしまい、wineserverの「WINEPREFIXの所有者でない」チェックに阻まれて
    録画自体が失敗する(実際に発生した障害、2026-07-23)。そのため"data"フィルタを
    ベースに、絶対リンクの場合だけ例外を握りつぶし、"data"フィルタと同様に
    所有権情報を持たせない(=chownをスキップさせる)メンバーを返す。
    """
    try:
        return tarfile.data_filter(member, dest_path)
    except tarfile.AbsoluteLinkError:
        return member.replace(uid=None, gid=None, uname=None, gname=None, mode=None, deep=False)


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
            tar.extractall(REPO, filter=_extraction_filter)
    finally:
        os.remove(archive_path)
    log(f"タイトル資産の展開が完了しました: game={game}")
