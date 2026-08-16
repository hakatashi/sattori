import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { GAME_IDS, GAME_TITLES, SUPPORTED_GAME_IDS, type GameId } from "@sattori/shared";
import staticStyles from "./StaticPage.module.css";
import styles from "./ReplayHelpPage.module.css";

/**
 * リプレイファイルの保存場所は、ゲームのエンジン世代によって2パターンに分かれる
 * （`docs/known-limitations.md` §2、th125から`%APPDATA%`方式に変わる）。本サービスの
 * 録画対応タイトル（`SUPPORTED_GAME_IDS`）に限らず、東方の全ナンバリングタイトル
 * （th19除く。リプレイ保存機能が無いため`GAME_IDS`にも含まれない）を対象にした
 * 汎用ヘルプとして一覧する。新タイトルは`GAME_IDS`（`packages/shared/src/games.ts`）へ
 * 追加すればここは自動で追従する。
 */
const APP_DATA_START_INDEX = GAME_IDS.indexOf("th125");
const INSTALL_FOLDER_GAME_IDS: readonly GameId[] = GAME_IDS.slice(0, APP_DATA_START_INDEX);
const APP_DATA_GAME_IDS: readonly GameId[] = GAME_IDS.slice(APP_DATA_START_INDEX);

/** 見出しの範囲表示用（上の配列の始端・終端と対応させること）。 */
const INSTALL_FOLDER_HEADING_FIRST: GameId = "th06";
const INSTALL_FOLDER_HEADING_LAST: GameId = "th12";
const APP_DATA_HEADING_FIRST: GameId = "th125";

/**
 * Steam版が存在しないタイトル。th06〜08はSteam配信が無く、公式配布アーカイブの
 * 展開先（またはその既定インストール先）にのみリプレイが保存される。
 */
const NO_STEAM_RELEASE_GAME_IDS: readonly GameId[] = ["th06", "th07", "th08"];

/** アイコンファイル名が`{id}.png`と一致しないタイトル（`UploadForm.tsx`の慣習に合わせる）。 */
const ICON_OVERRIDES: Partial<Record<GameId, string>> = {
  th143: "th14.png", // 弾幕アマノジャクは東方輝針城のアイコンを流用
};

function iconSrc(id: GameId): string {
  return `/icons/${ICON_OVERRIDES[id] ?? `${id}.png`}`;
}

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
          <img src={iconSrc(id)} alt="" className={styles.pickerIcon} />
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
  const [installFolderSelected, setInstallFolderSelected] = useState<GameId>(INSTALL_FOLDER_HEADING_FIRST);
  const [appDataSelected, setAppDataSelected] = useState<GameId>("th20");

  const installFolderTitle = shortTitle(installFolderSelected);
  const appDataTitle = shortTitle(appDataSelected);
  const showSteamPath = !NO_STEAM_RELEASE_GAME_IDS.includes(installFolderSelected);

  const supportedTitles = SUPPORTED_GAME_IDS.map(shortTitle).join(t("replayHelp.titleSeparator"));

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("replayHelp.heading")}</h1>
      <p>{t("replayHelp.intro")}</p>
      <p className={staticStyles.disclaimer}>
        {t("replayHelp.supportedNote", { titles: supportedTitles, count: SUPPORTED_GAME_IDS.length })}
      </p>

      <h2>
        {t("replayHelp.groups.installFolder.heading", {
          first: shortTitle(INSTALL_FOLDER_HEADING_FIRST),
          last: shortTitle(INSTALL_FOLDER_HEADING_LAST),
        })}
      </h2>
      <TitlePicker
        titleIds={INSTALL_FOLDER_GAME_IDS}
        selected={installFolderSelected}
        onSelect={setInstallFolderSelected}
      />
      <p>{t("replayHelp.groups.installFolder.description1", { title: installFolderTitle })}</p>
      <p>{t("replayHelp.groups.installFolder.defaultLabel")}</p>
      <CopyablePath path={`C:\\Program Files (x86)\\${installFolderTitle}\\replay`} />
      <p>{t("replayHelp.groups.installFolder.virtualStoreLabel")}</p>
      <CopyablePath path={`%LOCALAPPDATA%\\VirtualStore\\Program Files (x86)\\${installFolderTitle}\\replay`} />
      {showSteamPath && (
        <>
          <p>{t("replayHelp.groups.installFolder.steamLabel")}</p>
          <CopyablePath
            path={`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${installFolderSelected}\\replay`}
          />
        </>
      )}

      <h2>{t("replayHelp.groups.appData.heading", { first: shortTitle(APP_DATA_HEADING_FIRST) })}</h2>
      <TitlePicker titleIds={APP_DATA_GAME_IDS} selected={appDataSelected} onSelect={setAppDataSelected} />
      <p>{t("replayHelp.groups.appData.description1", { title: appDataTitle })}</p>
      <p>{t("replayHelp.groups.appData.pathLabel")}</p>
      <CopyablePath path={`%APPDATA%\\ShanghaiAlice\\${appDataSelected}\\replay`} />
    </section>
  );
}
