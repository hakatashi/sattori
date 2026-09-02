import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { GAME_IDS, GAME_TITLES, type GameId } from "@sattori/shared";
import { usePageMeta } from "../hooks/usePageMeta.ts";
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

/**
 * th10以降は既定インストール先が`Program Files (x86)`直下ではなく
 * `上海アリス幻樂団`フォルダの下になる（例: `Program Files (x86)\上海アリス幻樂団\東方風神録`）。
 */
const SHANGHAI_ALICE_FOLDER_START_GAME_ID: GameId = "th10";

function installFolderPathPrefix(id: GameId): string {
  const startIndex = INSTALL_FOLDER_GAME_IDS.indexOf(SHANGHAI_ALICE_FOLDER_START_GAME_ID);
  return INSTALL_FOLDER_GAME_IDS.indexOf(id) >= startIndex ? "上海アリス幻樂団\\" : "";
}

function iconSrc(id: GameId): string {
  return `/icons/${id}.png`;
}

/** `GAME_TITLES`の副題("～ ...")部分を除いた短いタイトル名を、選択中のロケールに応じて取り出す。 */
function shortTitle(id: GameId, isEnglish: boolean): string {
  return isEnglish ? GAME_TITLES[id].englishName : GAME_TITLES[id].japaneseName;
}

interface TitlePickerProps {
  titleIds: readonly GameId[];
  selected: GameId;
  onSelect: (id: GameId) => void;
  isEnglish: boolean;
}

/** グループ内の作品を切り替えるボタン列。 */
function TitlePicker({ titleIds, selected, onSelect, isEnglish }: TitlePickerProps) {
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
          {shortTitle(id, isEnglish)}
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
  const { t, i18n } = useTranslation();
  usePageMeta({ title: t("replayHelp.heading"), path: "/replay-help" });
  const [installFolderSelected, setInstallFolderSelected] = useState<GameId>(INSTALL_FOLDER_HEADING_FIRST);
  const [appDataSelected, setAppDataSelected] = useState<GameId>("th20");

  const isEnglish = i18n.language.startsWith("en");
  const installFolderTitle = shortTitle(installFolderSelected, false);
  const appDataTitle = shortTitle(appDataSelected, isEnglish);
  const showSteamPath = !NO_STEAM_RELEASE_GAME_IDS.includes(installFolderSelected);

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("replayHelp.heading")}</h1>
      <p>{t("replayHelp.intro")}</p>

      <h2>
        {t("replayHelp.groups.installFolder.heading", {
          first: shortTitle(INSTALL_FOLDER_HEADING_FIRST, isEnglish),
          last: shortTitle(INSTALL_FOLDER_HEADING_LAST, isEnglish),
        })}
      </h2>
      <TitlePicker
        titleIds={INSTALL_FOLDER_GAME_IDS}
        selected={installFolderSelected}
        onSelect={setInstallFolderSelected}
        isEnglish={isEnglish}
      />
      <p>{t("replayHelp.groups.installFolder.description1", { title: shortTitle(installFolderSelected, isEnglish) })}</p>
      <p>{t("replayHelp.groups.installFolder.defaultLabel")}</p>
      <CopyablePath
        path={`C:\\Program Files (x86)\\${installFolderPathPrefix(installFolderSelected)}${installFolderTitle}\\replay`}
      />
      <p>{t("replayHelp.groups.installFolder.virtualStoreLabel")}</p>
      <CopyablePath
        path={`%LOCALAPPDATA%\\VirtualStore\\Program Files (x86)\\${installFolderPathPrefix(installFolderSelected)}${installFolderTitle}\\replay`}
      />
      {showSteamPath && (
        <>
          <p>{t("replayHelp.groups.installFolder.steamLabel")}</p>
          <CopyablePath
            path={`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${installFolderSelected}\\replay`}
          />
        </>
      )}

      <h2>{t("replayHelp.groups.appData.heading", { first: shortTitle(APP_DATA_HEADING_FIRST, isEnglish) })}</h2>
      <TitlePicker
        titleIds={APP_DATA_GAME_IDS}
        selected={appDataSelected}
        onSelect={setAppDataSelected}
        isEnglish={isEnglish}
      />
      <p>{t("replayHelp.groups.appData.description1", { title: appDataTitle })}</p>
      <p>{t("replayHelp.groups.appData.pathLabel")}</p>
      <CopyablePath path={`%APPDATA%\\ShanghaiAlice\\${appDataSelected}\\replay`} />
    </section>
  );
}
