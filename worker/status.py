"""ジョブ状態を DynamoDB (JOBS_TABLE) に反映するヘルパー。
API (apps/api) が作成したジョブレコードを、ワーカーが進行に応じて更新する。
status の値は packages/shared の JobStatus と一致させること。
"""
import datetime
import os

import boto3
from botocore.exceptions import ClientError

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
    既に完了している(`done`)ジョブの重複実行かどうかを entrypoint.py が
    判定するために使う。変換から再開すべきかは**このレコードではなく**S3の
    生データチェックポイントの実体で判定する(`entrypoint.raw_checkpoint_exists()`)。
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
    error=None, error_code=None, reset_progress=False,
    desync_detected=None, timed_out=None,
):
    """ジョブの status(と任意で outputPath / outputPath720p / 出力サイズ / error)を更新する。

    desync_detected は録画終了時のスコアがリプレイの記録スコアと一致しなかった疑い
    (Issue #103、`recording.modlog.check_replay_desync()`)。True/False を渡した場合のみ
    書き込む(他の引数と同じくNoneは「このフィールドには触れない」を表す——
    検証できなかった場合は他の引数同様この引数自体を渡さないこと。JobRecord側の
    デフォルトが null=未検証なので、書かなくても意味は保たれる)。

    timed_out はリプレイ終了を検知できないままタイムアウトで打ち切られた録画か
    (Issue #161、`recording.pipeline.attempt_recording()`の`classification == "timeout"`)。
    desync_detected と同じくTrue/Falseを渡した場合のみ書き込む。

    error_code は error（常に日本語固定の文言）に対応する機械可読コードで、
    フロントエンド（apps/web/src/i18n/apiErrors.ts）が `errors.<code>` へ翻訳する
    軸になる（Issue #138）。error を渡す呼び出しでは可能な限り併せて指定すること。

    output_bytes / output_bytes_720p は管理画面のコスト推定(Issue #60)の入力。

    reset_progress=True を渡すと progress を 0 に戻す。**フェーズを開始する書き込みでは
    必ず指定すること**(Issue #108)。progress は「現在のフェーズ内で処理が完了した時間」
    であってフェーズを跨いで意味を持たないため、status だけ先に書き換えると、次の
    `update_progress` が届くまでの数秒間「新しいフェーズ + 前のフェーズの進捗」という
    レコードがユーザーに見えてしまう。ジョブページの経過時間表示は巻き戻らないことを
    保証する作りになっており(`apps/web/src/hooks/useEstimatedProgress.ts`)、その値を
    掴むと以降の進捗が表示に反映されなくなる。status と同じ1回の更新で戻すことで、
    この窓自体を無くす。

    管理画面から緊急停止(Issue #59)されたジョブには一切書き込まない
    (`attribute_not_exists(stopRequestedAt)` を条件にする)。EC2 は
    `TerminateInstances` で即座に黙るが、自宅ワーカー(Issue #49)のコンテナは
    デーモンが claim の取り消しに気づくまで走り続けるため、その間に完走すると
    `done` と doneAt を書き、DynamoDB Streams 経由で**停止したはずのジョブの
    完了メールがユーザーへ飛ぶ**。ワーカーが「自宅かEC2か」を知る必要はなく、
    どちらも同じ拒否票を尊重するだけでよい。

    条件が崩れた場合は例外にせずログだけ残して戻る。停止済みジョブへの書き込みが
    拒否されるのは想定内の正常系であり、ここで例外を投げると録画パイプラインが
    「失敗」として後始末を走らせてしまう。

    `status="done"` かつ error/error_code を渡さない呼び出しでは、前回試行分の
    `error`/`errorCode` を明示的に消す(Issue #219)。同一jobIdへ複数回試行する
    リトライ機構(1回目が失敗して error を書いた後、2回目が成功して done になる
    経路)と組み合わさると、他の引数と同じ「Noneは触れない」ルールのままでは
    前回の失敗情報が成功後もユーザーに見え続けてしまうため、doneだけは例外的に
    クリアする。
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
    if error_code is not None:
        expr += ", errorCode = :ec"
        values[":ec"] = error_code
    if reset_progress:
        expr += ", progress = :zero"
        values[":zero"] = 0
    if desync_detected is not None:
        expr += ", desyncDetected = :dd"
        values[":dd"] = desync_detected
    if timed_out is not None:
        expr += ", timedOut = :to"
        values[":to"] = timed_out
    remove_clauses = []
    if status == "done":
        # ダウンロード期限表示(ジョブ画面・完了メール)の起点。"done"への遷移は
        # ジョブの生涯で一度しか起こらないため、無条件にセットしてよい。
        expr += ", doneAt = :d"
        values[":d"] = now
        if error is None:
            names["#e"] = "error"
            remove_clauses.append("#e")
        if error_code is None:
            remove_clauses.append("errorCode")
    if remove_clauses:
        expr += " REMOVE " + ", ".join(remove_clauses)

    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression=expr,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_not_exists(stopRequestedAt)",
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        print(
            f"[status] {job_id} -> {status} は緊急停止済みのため書き込みませんでした",
            flush=True,
        )
        return
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
