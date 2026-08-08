"""オファーの探索とclaim(Issue #49)。

AWS側(`apps/api/src/homeWorker.ts`)と対になる条件付き更新の約束:

- オファー中のジョブは `homeWorkerOfferState = "open"` と
  `homeWorkerOfferExpiresAt`(未来)を持ち、sparse GSI `HomeWorkerOfferIndex` に載る。
- claim は「まだオファー中で、期限内で、誰も取っていない」ことを条件にした
  UpdateItem。DynamoDBの条件付き更新は原子的なので、複数ワーカー・複数スレッドが
  同じジョブを取り合っても成功するのは1つだけになる。
- claim後は `assignedWorkerId` が「誰がこのジョブのtaskTokenを持っているか」の
  唯一の真実。**AWS側がこの属性を消すことがclaimの取り消し**を意味するので、
  実行中は定期的に「自分のIDのままか」を条件にしたハートビートを打ち、条件が
  崩れたらコンテナを停止する(`daemon.py`)。
"""
import datetime

from botocore.exceptions import ClientError

from config import OFFER_INDEX_NAME


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def find_open_offers(table, limit=10):
    """オファー中(期限内)のジョブを古い順に返す。

    sparse GSI なのでインデックスに載っているのはオファー中のジョブだけ。
    期限切れのオファー(AWS側が撤回する前にLambdaが落ちた等)を掴んでも
    claimの条件式で弾かれるが、無駄なUpdateItemを避けるためここでも絞る。
    """
    result = table.query(
        IndexName=OFFER_INDEX_NAME,
        KeyConditionExpression=(
            "homeWorkerOfferState = :open AND homeWorkerOfferExpiresAt > :now"
        ),
        ExpressionAttributeValues={":open": "open", ":now": _now_iso()},
        Limit=limit,
    )
    return result.get("Items", [])


def claim_job(table, job_id, worker_id):
    """ジョブを原子的にclaimする。取れなければ None、取れたら更新後のジョブレコード。

    同時に次の3つを1回の更新で済ませる:

    - `workerKind` を `home` にする(コスト推定がこの値でEC2課金の有無を分岐するため。
      `packages/shared/src/cost.ts`)。
    - `status` を `launching` にする。**claimした側が状態も進める**ことで、AWS側が
      後からstatusを書く経路を作らずに済む(後追いで書くと、先に走り出した
      コンテナの`recording`を上書きしてしまう競合が生まれる)。
    - オファーのマーカーを消してGSIから外し、他のワーカーが同じジョブを見に来ない
      ようにする。

    `homeWorkerEnv`(ワーカーコンテナへ渡す環境変数)は実行に必要なので残す。
    """
    try:
        result = table.update_item(
            Key={"jobId": job_id},
            UpdateExpression=(
                "SET assignedWorkerId = :w, workerKind = :kind, #s = :launching, "
                "homeWorkerHeartbeatAt = :now, updatedAt = :now "
                "REMOVE homeWorkerOfferState"
            ),
            ConditionExpression=(
                "homeWorkerOfferState = :open AND homeWorkerOfferExpiresAt > :now "
                "AND attribute_not_exists(assignedWorkerId)"
            ),
            # "status" はDynamoDBの予約語のためプレースホルダが要る。
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":w": worker_id,
                ":kind": "home",
                ":launching": "launching",
                ":open": "open",
                ":now": _now_iso(),
            },
            ReturnValues="ALL_NEW",
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return None
        raise
    return result.get("Attributes")


def touch_claim(table, job_id, worker_id):
    """claimが自分のものであることを確認しつつ、生存時刻を更新する。

    False を返したら **claimが取り消された**(AWS側の`HandleFailure`・管理画面からの
    緊急停止が `assignedWorkerId` を消した)ということ。呼び出し側はコンテナを
    停止しなければならない——放置すると、既に別経路でリトライが始まっているジョブを
    二重に録画してしまう。
    """
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET homeWorkerHeartbeatAt = :now",
            ConditionExpression="assignedWorkerId = :w",
            ExpressionAttributeValues={":w": worker_id, ":now": _now_iso()},
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise
    return True


def release_claim(table, job_id, worker_id):
    """自分のclaimを手放す(コンテナを起動できなかった場合の後始末)。

    自分が持っている場合のみ解除する。既に別経路で解除・再割り当てされていれば
    何もしない(条件チェック失敗は正常系)。
    """
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression=(
                "SET updatedAt = :now REMOVE assignedWorkerId, homeWorkerEnv"
            ),
            ConditionExpression="assignedWorkerId = :w",
            ExpressionAttributeValues={":w": worker_id, ":now": _now_iso()},
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


def clear_worker_env(table, job_id, worker_id):
    """使い終わったコンテナ環境変数(taskTokenを含む)をジョブレコードから消す。

    taskTokenは一度きりの使い捨てだが、管理画面はジョブレコードをそのまま表示する
    ため、使用済みトークンを残す意味は無い。`assignedWorkerId` は運用調査のために
    残す(どのワーカーが処理したかの記録)。
    """
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="REMOVE homeWorkerEnv",
            ConditionExpression="assignedWorkerId = :w",
            ExpressionAttributeValues={":w": worker_id},
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
