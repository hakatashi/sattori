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
}

export const changelogEntries: ChangelogEntry[] = [
  {
    date: "2026-08-25",
    ja: "自宅サーバーの通信障害を検知し、録画処理を自動でAWS側へ切り替える仕組みを追加",
    en: "Added detection of home-server network issues that automatically falls back recording to AWS",
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
  },
];
