"""オファー探索とclaim(Issue #49)のテスト。"""
import pytest
from botocore.exceptions import ClientError

from claim import claim_job, clear_worker_env, find_open_offers, release_claim, touch_claim
from config import OFFER_INDEX_NAME


def conditional_failure():
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "no"}}, "UpdateItem"
    )


class FakeTable:
    def __init__(self, *, query_result=None, update_error=None, update_result=None):
        self.query_calls = []
        self.update_calls = []
        self._query_result = query_result or {"Items": []}
        self._update_error = update_error
        self._update_result = update_result or {}

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        return self._query_result

    def update_item(self, **kwargs):
        self.update_calls.append(kwargs)
        if self._update_error is not None:
            raise self._update_error
        return self._update_result


def test_オファー探索はsparse_GSIを期限で絞って引く():
    table = FakeTable(query_result={"Items": [{"jobId": "job-1"}]})

    items = find_open_offers(table)

    assert items == [{"jobId": "job-1"}]
    call = table.query_calls[0]
    assert call["IndexName"] == OFFER_INDEX_NAME
    assert ":open" in call["ExpressionAttributeValues"]
    assert "homeWorkerOfferExpiresAt > :now" in call["KeyConditionExpression"]


def test_claimは未claimかつ期限内であることを条件にする():
    table = FakeTable(update_result={"Attributes": {"jobId": "job-1", "homeWorkerEnv": {}}})

    job = claim_job(table, "job-1", "home-1")

    assert job == {"jobId": "job-1", "homeWorkerEnv": {}}
    call = table.update_calls[0]
    assert "attribute_not_exists(assignedWorkerId)" in call["ConditionExpression"]
    assert "homeWorkerOfferExpiresAt > :now" in call["ConditionExpression"]
    # コスト推定がworkerKindでEC2課金の有無を分岐するため、claimと同時に記録する。
    assert call["ExpressionAttributeValues"][":kind"] == "home"
    # 状態遷移もclaimと同じ更新で済ませる(AWS側が後追いで書くとコンテナが先に
    # 書いたrecordingを上書きしうるため)。
    assert call["ExpressionAttributeValues"][":launching"] == "launching"
    # オファーのマーカーを消してGSIから外す(他ワーカーが見に来ないように)。
    assert "REMOVE homeWorkerOfferState" in call["UpdateExpression"]


def test_他ワーカーに先を越されたclaimはNone():
    table = FakeTable(update_error=conditional_failure())
    assert claim_job(table, "job-1", "home-1") is None


def test_claim時の想定外エラーは伝播する():
    table = FakeTable(
        update_error=ClientError({"Error": {"Code": "ThrottlingException"}}, "UpdateItem")
    )
    with pytest.raises(ClientError):
        claim_job(table, "job-1", "home-1")


def test_claimが自分のものならTrue():
    table = FakeTable()
    assert touch_claim(table, "job-1", "home-1") is True
    assert table.update_calls[0]["ConditionExpression"] == "assignedWorkerId = :w"


def test_claimが取り消されていたらFalse():
    table = FakeTable(update_error=conditional_failure())
    assert touch_claim(table, "job-1", "home-1") is False


def test_claim解除は自分のものである場合のみ():
    table = FakeTable()
    release_claim(table, "job-1", "home-1")
    call = table.update_calls[0]
    assert call["ConditionExpression"] == "assignedWorkerId = :w"
    assert "REMOVE assignedWorkerId" in call["UpdateExpression"]


def test_既に解除済みなら何もしない():
    table = FakeTable(update_error=conditional_failure())
    release_claim(table, "job-1", "home-1")  # 例外にならない


def test_使用済みtaskTokenを含む環境変数を消す():
    table = FakeTable()
    clear_worker_env(table, "job-1", "home-1")
    assert table.update_calls[0]["UpdateExpression"] == "REMOVE homeWorkerEnv"
