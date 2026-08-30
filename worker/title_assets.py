"""GAME環境変数に応じたタイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)をS3から
取得・展開する(Issue #22)。

ECRのイメージストレージコストがタイトル数に比例して増大する問題への対応として、
ワーカーイメージ自体はタイトル非依存の共通部分のみで構成し、タイトル固有の資産
(games/{game}/, prefixes/{game}-*/, mods/**/build/*)は起動時にS3からアーカイブ
1本をダウンロード・展開する。アーカイブの構成は worker/README.md §8、作成・アップロード
手順は upload-title-assets skill を参照。

自宅ワーカー(Issue #104)は `TITLE_ASSETS_CACHE_DIR` が渡されたときだけ、ホスト側で
永続化されたディレクトリ(`docker run -v`でマウントされる)にアーカイブの展開結果を
キャッシュし、S3からのダウンロードをスキップする。EC2はジョブ毎に使い捨てのため
この環境変数は渡されず、常に旧来どおり直接ダウンロードする(`ensure_title_assets()`
はどちらの経路かを分岐で意識しない——渡された環境変数の有無だけで決まる、
`docs/decisions/0010`と同じ構造)。

キャッシュはS3オブジェクトのETagをバージョンキーにした世代ディレクトリ
(`{cache_dir}/{game}/v-{etag}/`)として持つ。リモートのアーカイブが更新されて
ETagが変わればキャッシュミスとして扱い新しい世代を作る。**世代ディレクトリは
中身不変**で、リンク済みの実行中ジョブが参照している最中に上書きされることが
無いようにしてある(同時に2ジョブまで動く自宅ワーカーで、片方が実行中に
資産アップロードが走っても壊れない)。使われなくなった古い世代は`_cleanup_stale_versions()`
が一定時間の経過後に削除する(詳細は同関数のdocstring)。
"""
import fcntl
import os
import shutil
import tarfile
import time

REPO = "/app"
DOWNLOAD_DIR = "/tmp"

# 古い世代ディレクトリを削除するまでの猶予。低速録画(Issue #68)込みの最大所要時間
# (home-worker/README.md §4.1 の `HOME_WORKER_DRAIN_TIMEOUT_SEC` 既定150分)より
# 十分大きく取ることで、削除時点でその世代を参照中のジョブが実行中である可能性を
# 実務上排除する。
STALE_VERSION_MAX_AGE_SECONDS = 6 * 60 * 60


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


def _download_and_extract(s3, bucket, game, dest_dir, *, log):
    """タイトル資産アーカイブをS3から取得し `dest_dir` 直下へ展開する。"""
    key = f"titles/{game}/assets.tar.gz"
    archive_path = f"{DOWNLOAD_DIR}/sattori-title-assets-{game}.tar.gz"
    log(f"タイトル資産をダウンロードします: s3://{bucket}/{key}")
    s3.download_file(bucket, key, archive_path)

    try:
        log(f"タイトル資産を展開します: {archive_path} -> {dest_dir}")
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(dest_dir, filter=_extraction_filter)
    finally:
        os.remove(archive_path)


def _link_into_repo(version_dir, repo, *, log):
    """世代ディレクトリの中身(games/・prefixes/・mods/の各サブディレクトリ)を、
    `record_{game}.py`が既定で参照するパス(`{repo}/games/{game}`等)へシンボリック
    リンクする。アーカイブの内訳(タイトルごとのMODファイル名等)をここで決め打ちせず、
    2階層目のディレクトリ単位でリンクを張るだけにしてあるので、新しいタイトルの
    アーカイブ構成にもそのまま対応する。
    """
    for category in os.listdir(version_dir):
        category_src = os.path.join(version_dir, category)
        if not os.path.isdir(category_src):
            continue
        for name in os.listdir(category_src):
            src = os.path.join(category_src, name)
            dst = os.path.join(repo, category, name)
            if os.path.islink(dst) or os.path.exists(dst):
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(src, dst)
    log(f"タイトル資産をキャッシュからリンクしました: {version_dir} -> {repo}")


def _cleanup_stale_versions(game_cache_root, *, keep, log):
    """`keep`以外の世代ディレクトリのうち、最終アクセスから
    `STALE_VERSION_MAX_AGE_SECONDS`以上経過したものだけ削除する。

    世代ディレクトリは内容不変なので、削除さえしなければ参照中のジョブを
    壊すことは無い。逆に言うと「参照中かどうか」を追跡していないため、
    削除は時間経過だけを根拠にした保守的な判断であり、最大所要時間より
    十分長い猶予を置くことで安全側に倒している。
    """
    now = time.time()
    for name in os.listdir(game_cache_root):
        if name == os.path.basename(keep) or not name.startswith("v-"):
            continue
        path = os.path.join(game_cache_root, name)
        try:
            age = now - os.path.getmtime(path)
        except OSError:
            continue
        if age > STALE_VERSION_MAX_AGE_SECONDS:
            log(f"古いタイトル資産キャッシュを削除します: {path}")
            shutil.rmtree(path, ignore_errors=True)


def _latest_complete_version(game_cache_root):
    """完全に展開済みの世代のうち、最終アクセスが最も新しいものを返す(無ければNone)。

    リモートへの疎通確認(HeadObject)自体が失敗した場合のフォールバックに使う。
    """
    candidates = []
    for name in os.listdir(game_cache_root):
        if not name.startswith("v-"):
            continue
        path = os.path.join(game_cache_root, name)
        if os.path.isfile(os.path.join(path, ".complete")):
            candidates.append(path)
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


def _ensure_cached_version(s3, bucket, game, cache_dir, *, log):
    """`cache_dir`配下にタイトル資産の世代ディレクトリを用意し、そのパスを返す。

    S3オブジェクトのETag(HeadObjectのみで完結し、本体はダウンロードしない)を
    バージョンキーとして使い、既に同じETagの世代が展開済みならダウンロードを
    まるごと省略する。ダウンロード・展開そのものは`{game}`単位のロックファイルで
    直列化する(自宅ワーカーは同時に複数ジョブが同じタイトルを引き当てうるため、
    二重ダウンロード・展開途中のディレクトリへの同時アクセスを避ける)。
    """
    game_cache_root = os.path.join(cache_dir, game)
    os.makedirs(game_cache_root, exist_ok=True)
    lock_path = os.path.join(game_cache_root, ".lock")

    key = f"titles/{game}/assets.tar.gz"
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            try:
                etag = s3.head_object(Bucket=bucket, Key=key)["ETag"].strip('"')
            except Exception as err:  # noqa: BLE001 - 疎通不良でも既存キャッシュがあれば続行する
                fallback = _latest_complete_version(game_cache_root)
                if fallback is None:
                    raise
                log(
                    "タイトル資産の更新確認に失敗したため、既存キャッシュを使用します: "
                    f"{err}",
                )
                os.utime(fallback, None)
                return fallback

            version_dir = os.path.join(game_cache_root, f"v-{etag}")
            done_marker = os.path.join(version_dir, ".complete")
            if os.path.isfile(done_marker):
                log(f"タイトル資産のキャッシュを再利用します: game={game} etag={etag}")
                os.utime(version_dir, None)
                _cleanup_stale_versions(game_cache_root, keep=version_dir, log=log)
                return version_dir

            log(f"タイトル資産のキャッシュが無いか古いため取得します: game={game} etag={etag}")
            if os.path.isdir(version_dir):
                shutil.rmtree(version_dir)
            os.makedirs(version_dir)
            _download_and_extract(s3, bucket, game, version_dir, log=log)
            # 展開完了後に印を置く。途中で落ちた場合はこの印が付かないため、
            # 次回実行時は「未完了」として再ダウンロードから始め直す(自己修復)。
            open(done_marker, "w").close()
            _cleanup_stale_versions(game_cache_root, keep=version_dir, log=log)
            return version_dir
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def ensure_title_assets(s3, bucket, game, *, log=print, env=None):
    """タイトル資産が REPO 配下に未展開ならS3(s3://{bucket}/titles/{game}/assets.tar.gz)
    から取得して展開する。既に展開済み(同一インスタンスでのSpot中断リトライ再利用等、
    または後述のキャッシュ由来のシンボリックリンク)ならダウンロードをスキップする。

    `TITLE_ASSETS_CACHE_DIR`(自宅ワーカーのみが渡す。Issue #104)が設定されている
    場合は、直接S3からダウンロードする代わりにそのディレクトリ配下のキャッシュを
    使う。EC2はこの環境変数を渡さないため常に従来どおりの直接ダウンロードになる。
    """
    marker = f"{REPO}/games/{game}"
    if os.path.exists(marker):
        log(f"タイトル資産は展開済みのためスキップします: game={game}")
        return

    cache_dir = (env if env is not None else os.environ).get("TITLE_ASSETS_CACHE_DIR")
    if not cache_dir:
        _download_and_extract(s3, bucket, game, REPO, log=log)
        log(f"タイトル資産の展開が完了しました: game={game}")
        return

    version_dir = _ensure_cached_version(s3, bucket, game, cache_dir, log=log)
    _link_into_repo(version_dir, REPO, log=log)
