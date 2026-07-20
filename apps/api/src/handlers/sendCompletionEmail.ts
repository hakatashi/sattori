import type { DynamoDBStreamHandler } from "aws-lambda";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { JobRecord } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { sendCompletionEmail } from "../ses.js";

/** aws-lambdaトリガー型のNewImage/OldImageはSDKのAttributeValueと構造的に同一。 */
function unmarshallImage(image: Record<string, unknown>): JobRecord {
  return unmarshall(image as Record<string, AttributeValue>) as JobRecord;
}

/**
 * JobsTable の DynamoDB Streams を起点に、ジョブが "done" に遷移した瞬間だけ
 * 完了メールを送信する（Issue #10）。CDK側（infra）のフィルタ条件
 * （`eventName: MODIFY`, `dynamodb.NewImage.status.S: "done"`）で対象イベントを
 * 絞り込んでいるが、フィルタをすり抜けたレコード（旧状態が既に "done" だった場合等）
 * も安全のためここでも弾く。1回のジョブの生涯で "done" への遷移は一度しか
 * 起こらないため、これで送信は1通のみになる。
 *
 * ジョブ本体の状態更新（DynamoDB書き込み）と完了メール送信を分離することで、
 * ワーカー（worker/, Python）にSESの権限・文面知識を持たせずに済む
 * （AGENTS.md「録画ワーカーだけPython」の方針どおり、ユーザー向け通信はAPI層に閉じる）。
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  const config = loadConfig();

  for (const record of event.Records) {
    if (record.eventName !== "MODIFY" || !record.dynamodb?.NewImage) {
      continue;
    }

    const newJob = unmarshallImage(record.dynamodb.NewImage);
    const oldStatus = record.dynamodb.OldImage
      ? unmarshallImage(record.dynamodb.OldImage).status
      : undefined;

    if (newJob.status !== "done" || oldStatus === "done" || !newJob.email) {
      continue;
    }

    try {
      await sendCompletionEmail({
        from: config.sesFromAddress,
        to: newJob.email,
        webBaseUrl: config.webBaseUrl,
        jobId: newJob.jobId,
      });
    } catch (err) {
      // 完了メールが送れなくても動画自体はジョブページから取得できるため、
      // ここで例外を投げてリトライさせず（DynamoDB Streamsのリトライは同じ
      // レコードを再送し続け、後続レコードの処理も止めてしまう）ログのみ残す。
      console.error(
        JSON.stringify({
          event: "send_completion_email_failed",
          jobId: newJob.jobId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
};
