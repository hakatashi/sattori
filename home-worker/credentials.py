"""自宅ワーカー(Issue #49)が使うAWS認証情報の供給。

自宅マシンにはEC2のインスタンスプロファイルが無いため、何らかの長期認証情報を
置かざるを得ない。そのリスクを抑えるため、**長期キーは「ロールをassumeする権限
だけを持つIAMユーザー」に限定し、実際にS3やDynamoDBを触るのは assume して得た
短命クレデンシャル**という二段構えにする(`HomeWorkerRole`、`infra/README.md`)。

デーモン自身のAPI呼び出しにも、ワーカーコンテナへ渡す環境変数にも、同じここで
発行した認証情報を使う。コンテナ内には認証情報を再取得する手段が無いので、
**コンテナ起動の直前に「ジョブ1本ぶんの残存時間があるか」を確かめ、足りなければ
assumeし直す**のが要点(録画の途中で認証エラーになると、そのジョブは丸ごと無駄になる)。

`role_arn` を指定しない場合は環境の認証情報(`~/.aws/credentials`・環境変数・
インスタンスプロファイル等)をそのまま使う。ローカル検証用の逃げ道で、本番の
自宅ワーカーでは必ずロールを指定すること。
"""
import datetime
import threading

import boto3

#: 有効期限がこれを下回ったら再assumeする(通常のリフレッシュ判定)。
REFRESH_MARGIN_SEC = 15 * 60

#: コンテナへ渡す認証情報に最低限残っていてほしい時間。録画(最長60分)+720p変換+
#: アップロードを賄える長さにする。
MIN_CONTAINER_TTL_SEC = 100 * 60


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


class CredentialProvider:
    def __init__(self, region, role_arn=None, duration_sec=4 * 60 * 60,
                 session_name="sattori-home-worker", log=print, sts_client=None):
        self._region = region
        self._role_arn = role_arn
        self._duration_sec = duration_sec
        self._session_name = session_name
        self._log = log
        self._sts = sts_client
        self._lock = threading.Lock()
        self._credentials = None
        self._expiration = None

    def _sts_client(self):
        if self._sts is None:
            self._sts = boto3.client("sts", region_name=self._region)
        return self._sts

    def _remaining_sec(self):
        if self._expiration is None:
            return 0.0
        return (self._expiration - _now()).total_seconds()

    def _ensure(self, min_ttl_sec):
        """残存時間が `min_ttl_sec` を下回っていれば assume し直す。"""
        with self._lock:
            if self._credentials is not None and self._remaining_sec() >= min_ttl_sec:
                return self._credentials
            result = self._sts_client().assume_role(
                RoleArn=self._role_arn,
                RoleSessionName=self._session_name,
                DurationSeconds=self._duration_sec,
            )
            creds = result["Credentials"]
            self._credentials = {
                "aws_access_key_id": creds["AccessKeyId"],
                "aws_secret_access_key": creds["SecretAccessKey"],
                "aws_session_token": creds["SessionToken"],
            }
            self._expiration = creds["Expiration"]
            self._log(f"[credentials] ロールをassumeしました(期限: {self._expiration.isoformat()})")
            return self._credentials

    def session(self):
        """デーモン自身のAPI呼び出しに使うセッション。"""
        if self._role_arn is None:
            return boto3.Session(region_name=self._region)
        return boto3.Session(region_name=self._region, **self._ensure(REFRESH_MARGIN_SEC))

    def container_env(self):
        """ワーカーコンテナへ渡す認証情報の環境変数。

        ロール未指定(検証用)の場合は環境の認証情報をそのまま解決して渡す。長期キーを
        コンテナへ渡すことになるため、本番では必ず `role_arn` を指定すること。
        """
        if self._role_arn is None:
            frozen = boto3.Session(region_name=self._region).get_credentials()
            if frozen is None:
                raise RuntimeError("AWS認証情報が見つかりません")
            frozen = frozen.get_frozen_credentials()
            env = {
                "AWS_ACCESS_KEY_ID": frozen.access_key,
                "AWS_SECRET_ACCESS_KEY": frozen.secret_key,
            }
            if frozen.token:
                env["AWS_SESSION_TOKEN"] = frozen.token
            return env

        creds = self._ensure(MIN_CONTAINER_TTL_SEC)
        return {
            "AWS_ACCESS_KEY_ID": creds["aws_access_key_id"],
            "AWS_SECRET_ACCESS_KEY": creds["aws_secret_access_key"],
            "AWS_SESSION_TOKEN": creds["aws_session_token"],
        }
