import { useTranslation } from "react-i18next";
import { GAME_TITLES, type GameId } from "@sattori/shared";
import staticStyles from "./StaticPage.module.css";
import styles from "./GameInfoPage.module.css";

interface TitleInfo {
  id: GameId;
  version: string;
  vpatchRev?: number;
  cherryBugFix?: boolean;
}

// CLAUDE.local.mdのデプロイ手順に記載の各タイトルの導入バージョン・パッチ適用状況と一致させる。
const TITLE_INFO: TitleInfo[] = [
  { id: "th06", version: "ver 1.02h", vpatchRev: 4 },
  { id: "th07", version: "ver 1.00b", vpatchRev: 4, cherryBugFix: true },
  { id: "th08", version: "ver 1.00d" },
  { id: "th11", version: "ver 1.00a" },
  { id: "th20", version: "ver 1.00c" },
];

/** 対応タイトルのバージョン・パッチ情報ページ（`/info`）。フッターからナビゲーションする。 */
export function GameInfoPage() {
  const { t } = useTranslation();

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("gameInfo.heading")}</h1>
      {TITLE_INFO.map(({ id, version, vpatchRev, cherryBugFix }) => (
        <div key={id}>
          <div className={styles.game}>
            <img className={styles.icon} src={`/icons/${id}.png`} alt="" />
            <h2>{GAME_TITLES[id]}</h2>
          </div>
          <ul className={styles.versions}>
            <li>{version}</li>
            {vpatchRev !== undefined && <li>{t("gameInfo.vpatchApplied", { rev: vpatchRev })}</li>}
            {cherryBugFix && <li className={styles.nestedItem}>{t("gameInfo.cherryBugFix")}</li>}
          </ul>
        </div>
      ))}
    </section>
  );
}
