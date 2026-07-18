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


def update_status(job_id, status, *, output_path=None, output_path_720p=None, error=None):
    """ジョブの status(と任意で outputPath / outputPath720p / error)を更新する。"""
    table_name = os.environ.get("JOBS_TABLE")
    if not table_name:
        # ローカル検証等でテーブル未設定なら DynamoDB 更新はスキップする。
        print(f"[status] JOBS_TABLE 未設定のため更新スキップ: {job_id} -> {status}", flush=True)
        return
    table = _table(table_name)

    expr = "SET #s = :s, updatedAt = :u"
    names = {"#s": "status"}
    values = {":s": status, ":u": _now()}
    if output_path is not None:
        expr += ", outputPath = :o"
        values[":o"] = output_path
    if output_path_720p is not None:
        expr += ", outputPath720p = :o720"
        values[":o720"] = output_path_720p
    if error is not None:
        expr += ", #e = :e"
        names["#e"] = "error"
        values[":e"] = error

    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    print(f"[status] {job_id} -> {status}", flush=True)
