import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { GAME_TITLES, type GameId } from "@sattori/shared";
import staticStyles from "./StaticPage.module.css";
import styles from "./ReplayHelpPage.module.css";

/**
 * リプレイファイルの保存場所は、ゲームのエンジン世代によって2パターンに分かれる
 * （`docs/known-limitations.md` §2、TH125以降は`%APPDATA%`）。対応タイトルが増えたら
 * ここへ追加すること（`SUPPORTED_GAME_IDS`の部分集合。`packages/shared/src/games.ts`）。
 */
const INSTALL_FOLDER_GAME_IDS: readonly GameId[] = ["th06", "th07", "th08", "th11"];
const APP_DATA_GAME_IDS: readonly GameId[] = ["th20"];

/** `GAME_TITLES`の副題("～ ...")部分を除いた短いタイトル名を取り出す。 */
function shortTitle(id: GameId): string {
  return GAME_TITLES[id].split(" ～ ")[0] ?? GAME_TITLES[id];
}

interface TitlePickerProps {
  titleIds: readonly GameId[];
  selected: GameId;
  onSelect: (id: GameId) => void;
}

/** グループ内の作品を切り替えるボタン列。 */
function TitlePicker({ titleIds, selected, onSelect }: TitlePickerProps) {
  return (
    <div className={styles.picker} role="group">
      {titleIds.map((id) => (
        <button
          key={id}
          type="button"
          className={clsx(styles.pickerButton, id === selected && styles.pickerButtonSelected)}
          aria-pressed={id === selected}
          onClick={() => onSelect(id)}
        >
          <img src={`/icons/${id}.png`} alt="" className={styles.pickerIcon} />
          {shortTitle(id)}
        </button>
      ))}
    </div>
  );
}

interface CopyablePathProps {
  path: string;
}

/** Windowsのパス文字列をクリップボードへコピーできるボタン付きの表示。 */
function CopyablePath({ path }: CopyablePathProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = () => {
    void navigator.clipboard.writeText(path).then(
      () => setCopied(true),
      () => {
        // クリップボードAPIが使えない環境(権限拒否・非HTTPS等)。パス自体は選択・
        // 手動コピーできるため、ここでは静かに諦める。
      },
    );
  };

  return (
    <div className={styles.pathBox}>
      <code className={styles.pathText}>{path}</code>
      <button type="button" className={styles.copyButton} onClick={handleCopy}>
        {copied ? t("replayHelp.copied") : t("replayHelp.copy")}
      </button>
    </div>
  );
}

/** リプレイファイルの場所を案内するヘルプページ（`/replay-help`、Issue #55）。 */
export function ReplayHelpPage() {
  const { t } = useTranslation();
  const [installFolderSelected, setInstallFolderSelected] = useState<GameId>("th06");
  const [appDataSelected, setAppDataSelected] = useState<GameId>("th20");

  const installFolderTitle = shortTitle(installFolderSelected);
  const appDataTitle = shortTitle(appDataSelected);

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("replayHelp.heading")}</h1>
      <p>{t("replayHelp.intro")}</p>

      <h2>{t("replayHelp.groups.installFolder.heading")}</h2>
      <TitlePicker
        titleIds={INSTALL_FOLDER_GAME_IDS}
        selected={installFolderSelected}
        onSelect={setInstallFolderSelected}
      />
      <p>{t("replayHelp.groups.installFolder.description1", { title: installFolderTitle })}</p>
      <p>{t("replayHelp.groups.installFolder.steamLabel")}</p>
      <CopyablePath path={`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${installFolderSelected}\\replay`} />
      <p>{t("replayHelp.groups.installFolder.virtualStoreLabel")}</p>
      <CopyablePath
        path={`%LOCALAPPDATA%\\VirtualStore\\Program Files (x86)\\${installFolderSelected}\\replay`}
      />

      <h2>{t("replayHelp.groups.appData.heading")}</h2>
      <TitlePicker titleIds={APP_DATA_GAME_IDS} selected={appDataSelected} onSelect={setAppDataSelected} />
      <p>{t("replayHelp.groups.appData.description1", { title: appDataTitle })}</p>
      <p>{t("replayHelp.groups.appData.pathLabel")}</p>
      <CopyablePath path={`%APPDATA%\\ShanghaiAlice\\${appDataSelected}\\replay`} />
    </section>
  );
}
