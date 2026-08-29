/**
 * サービスの更新履歴（`/changelog`）。ユーザーに見える変更を伴うPRをマージする際、
 * 新しいエントリを配列の先頭に追加する（`docs/runbooks/issue-workflow.md` §4）。
 * 内部リファクタ・ドキュメント更新などユーザーに見えない変更は対象外。
 */
export interface ChangelogEntry {
  /** YYYY-MM-DD形式。同日に複数エントリがある場合は新しい順に並べる。 */
  date: string;
  ja: string;
  en: string;
  /** 対応するIssue/PRのURL。管理目的の記録のみで、ページ上には表示しない。 */
  issueUrl?: string;
  /** trueの場合、重要な更新として太字で表示する。 */
  important?: boolean;
}

export const changelogEntries: ChangelogEntry[] = [
  {
    date: "2026-08-29",
    ja: "正常なリプレイが誤って「処理落ち」と判定され録画に失敗する場合がある不具合を修正",
    en: "Fixed some valid replays being incorrectly flagged as \"processing lag\" and failing to record",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/193",
  },
  {
    date: "2026-08-29",
    ja: "東方風神録 (th10) の録画に対応",
    en: "Added recording support for Mountain of Faith (th10)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/192",
    important: true,
  },
  {
    date: "2026-08-28",
    ja: "録画がタイムアウトした際にジョブページに警告を表示するよう修整",
    en: "Fixed the job page to show a warning when recording times out",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/184",
  },
  {
    date: "2026-08-26",
    ja: "ジョブ実行に180分のタイムアウトを設け、それを超えたジョブはエラーとして終了するよう変更",
    en: "Added a 180-minute timeout for job execution, terminating jobs that exceed it with an error",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/178",
  },
  {
    date: "2026-08-25",
    ja: "録画終了時のスコアがリプレイの記録スコアと一致しない場合、リプレイずれの可能性がある旨を表示するよう追加",
    en: "Added a notice warning of a possible replay desync when the score at the end of recording doesn't match the score recorded in the replay file",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/169",
  },
  {
    date: "2026-08-25",
    ja: "アップロード画面から他ページへ移動後、ブラウザで戻っても入力内容が消えないよう修正",
    en: "Fixed input on the upload screen being lost after navigating away and back with the browser",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/139",
  },
  {
    date: "2026-08-25",
    ja: "アップロード後の画面UIを調整",
    en: "Adjusted the UI of the post-upload screen",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/153",
  },
  {
    date: "2026-08-25",
    ja: "追加ワーカーの通信障害を検知し、録画処理を自動でAWS側へ切り替える仕組みを追加",
    en: "Added detection of additional-worker network issues that automatically falls back recording to AWS",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/165",
  },
  {
    date: "2026-08-24",
    ja: "更新履歴ページ (/changelog) を追加",
    en: "Added the changelog page (/changelog)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/164",
  },
  {
    date: "2026-08-23",
    ja: "アップロード画面のドロップゾーンに注意書きを追加",
    en: "Added a notice to the upload screen's drop zone",
  },
  {
    date: "2026-08-22",
    ja: "TouhouSattori 正式公開",
    en: "TouhouSattori public launch",
    important: true,
  },
];
