import { useTranslation } from "react-i18next";
import { GAME_TITLES, type GameId } from "@sattori/shared";
import { usePageMeta } from "../hooks/usePageMeta.ts";
import staticStyles from "./StaticPage.module.css";
import styles from "./GameInfoPage.module.css";

interface TitleInfo {
  id: GameId;
  version: string;
  vpatchRev?: number;
  cherryBugFix?: boolean;
  /** 魔理沙Bの「バグマリ」修正(BugFixTh10Power3)をページAの詳細設定から選択できるか
      (Issue #75)。cherryBugFixと異なり常時適用ではなく利用者が選ぶオプションなので、
      「適用済み」ではなく「利用可能」と表示する。 */
  th10BugfixOption?: boolean;
  /** スコア21億到達時のオーバーフローバグ修正がvpatchで適用済みか（th12）。 */
  th12ScoreOverflowFix?: boolean;
  /** 録画時にアタッチしているthpracのバージョン（Issue #105）。`worker/games/{id}/`に
      同梱する実行ファイル名（`thprac.v{version}.exe`）と一致させること。 */
  thpracVersion?: string;
  /** thpracを適用している理由。タイトルによって異なるため、`thpracVersion`とセットで
      必ず指定すること（Issue #78のレビュー指摘。th20はデシンク軽減が主目的だが、
      th128はリプレイ選択直後のフリーズ回避が主目的で、デシンク軽減の効能ではない
      —— worker/docs/titles/th128.md参照）。
      "desync": リプレイずれの軽減が目的（th20、worker/docs/titles/th20.md）。
      "freezeFix": リプレイ選択直後のフリーズ回避が目的（th128、worker/docs/titles/th128.md）。 */
  thpracPurpose?: "desync" | "freezeFix";
}

// CLAUDE.local.mdのデプロイ手順に記載の各タイトルの導入バージョン・パッチ適用状況と一致させる。
const TITLE_INFO: TitleInfo[] = [
  { id: "th06", version: "ver 1.02h", vpatchRev: 4 },
  { id: "th06c", version: "ver 1.03" },
  { id: "th07", version: "ver 1.00b", vpatchRev: 4, cherryBugFix: true },
  { id: "th08", version: "ver 1.00d" },
  { id: "th09", version: "ver 1.50a" },
  { id: "th10", version: "ver 1.00a", vpatchRev: 4, th10BugfixOption: true },
  { id: "th11", version: "ver 1.00a" },
  { id: "th12", version: "ver 1.00b", vpatchRev: 7, th12ScoreOverflowFix: true },
  { id: "th20", version: "ver 1.00c", thpracVersion: "2.3.0.3", thpracPurpose: "desync" },
  { id: "th128", version: "ver 1.00a", thpracVersion: "2.3.0.3", thpracPurpose: "freezeFix" },
];

/** 対応タイトルのバージョン・パッチ情報ページ（`/info`）。フッターからナビゲーションする。 */
export function GameInfoPage() {
  const { t } = useTranslation();
  usePageMeta({ title: t("gameInfo.heading"), path: "/info" });

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("gameInfo.heading")}</h1>
      {TITLE_INFO.map(
        ({
          id,
          version,
          vpatchRev,
          cherryBugFix,
          th10BugfixOption,
          th12ScoreOverflowFix,
          thpracVersion,
          thpracPurpose,
        }) => (
          <div key={id}>
            <div className={styles.game}>
              <img className={styles.icon} src={`/icons/${id}.png`} alt="" />
              <h2>{GAME_TITLES[id].fullName}</h2>
            </div>
            <ul className={styles.versions}>
              <li>{version}</li>
              {vpatchRev !== undefined && <li>{t("gameInfo.vpatchApplied", { rev: vpatchRev })}</li>}
              {cherryBugFix && <li className={styles.nestedItem}>{t("gameInfo.cherryBugFix")}</li>}
              {th10BugfixOption && (
                <li className={styles.nestedItem}>{t("gameInfo.th10BugfixOption")}</li>
              )}
              {th12ScoreOverflowFix && (
                <li className={styles.nestedItem}>{t("gameInfo.th12ScoreOverflowFix")}</li>
              )}
              {thpracVersion !== undefined && (
                <>
                  <li>{t("gameInfo.thpracApplied", { version: thpracVersion })}</li>
                  <li className={styles.nestedItem}>
                    {t(
                      thpracPurpose === "freezeFix"
                        ? "gameInfo.thpracPurposeFreezeFix"
                        : "gameInfo.thpracPurposeDesync",
                    )}
                  </li>
                </>
              )}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}
