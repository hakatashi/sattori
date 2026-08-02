"""ジョブ状態を DynamoDB (JOBS_TABLE) に反映するヘルパー。
API (apps/api) が作成したジョブレコードを、ワーカーが進行に応じて更新する。
status の値は packages/shared の JobStatus と一致させること。
"""
import datetime
import os

import boto3

# boto3 リソースは遅延生成する。モジュール import 時に生成すると、リージョン
# 未設定（AWS_DEFAULT_REGION/AWS_REGION 無し）の環境で NoRegionError が発生し
# entrypoint 全体が import 段階でクラッシュしてしまうため（コンテナ実行時は
# UserData から AWS_DEFAULT_REGION を渡すが、防御的に遅延化しておく）。
_dynamodb = None


def _table(name):
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(name)


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def get_job(job_id):
    """ジョブレコード全体を取得する(存在しなければ None)。
    録画完了チェックポイント(outputPathの有無)を見て、変換から再開すべきかを
    entrypoint.py が判定するために使う。
    """
    table_name = os.environ.get("JOBS_TABLE")
    if not table_name:
        print(f"[status] JOBS_TABLE 未設定のため取得スキップ: {job_id}", flush=True)
        return None
    table = _table(table_name)
    result = table.get_item(Key={"jobId": job_id})
    return result.get("Item")


def update_status(
    job_id, status, *,
    output_path=None, output_path_720p=None,
    output_bytes=None, output_bytes_720p=None,
    error=None,
):
    """ジョブの status(と任意で outputPath / outputPath720p / 出力サイズ / error)を更新する。

    output_bytes / output_bytes_720p は管理画面のコスト推定(Issue #60)の入力。
    """
    table_name = os.environ.get("JOBS_TABLE")
    if not table_name:
        # ローカル検証等でテーブル未設定なら DynamoDB 更新はスキップする。
        print(f"[status] JOBS_TABLE 未設定のため更新スキップ: {job_id} -> {status}", flush=True)
        return
    table = _table(table_name)
    now = _now()

    expr = "SET #s = :s, updatedAt = :u"
    names = {"#s": "status"}
    values = {":s": status, ":u": now}
    if output_path is not None:
        expr += ", outputPath = :o"
        values[":o"] = output_path
    if output_path_720p is not None:
        expr += ", outputPath720p = :o720"
        values[":o720"] = output_path_720p
    if output_bytes is not None:
        expr += ", outputBytes = :ob"
        values[":ob"] = int(output_bytes)
    if output_bytes_720p is not None:
        expr += ", outputBytes720p = :ob720"
        values[":ob720"] = int(output_bytes_720p)
    if error is not None:
        expr += ", #e = :e"
        names["#e"] = "error"
        values[":e"] = error
    if status == "done":
        # ダウンロード期限表示(ジョブ画面・完了メール)の起点。"done"への遷移は
        # ジョブの生涯で一度しか起こらないため、無条件にセットしてよい。
        expr += ", doneAt = :d"
        values[":d"] = now

    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    print(f"[status] {job_id} -> {status}", flush=True)


def update_progress(job_id, progress, preview_image_path=None):
    """status/outputPath 等には触れず、進捗(・プレビュー画像パス)だけを更新する
    軽量な更新関数。録画・変換フェーズ中に10秒間隔程度の高頻度で呼ばれるため、
    毎回 update_status の全項目を触らないよう分けている。
    progress は全体の長さに対する割合ではなく、現在のフェーズ内で実際に処理が
    完了した時間(秒)を渡す。
    """
    table_name = os.environ.get("JOBS_TABLE")
    if not table_name:
        return
    table = _table(table_name)

    expr = "SET progress = :p, updatedAt = :u"
    values = {":p": progress, ":u": _now()}
    if preview_image_path is not None:
        expr += ", previewImagePath = :pi"
        values[":pi"] = preview_image_path

    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression=expr,
        ExpressionAttributeValues=values,
    )
    print(f"[status] {job_id} progress -> {progress}秒", flush=True)
