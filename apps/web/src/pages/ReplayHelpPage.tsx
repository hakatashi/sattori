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
 * 追加すればここは自動で追従する（例外は`STEAM_LIBRARY_GAME_IDS`）。
 */

/**
 * Steamライブラリ配下のゲームディレクトリ直下にreplayフォルダを持つタイトル
 * （インストール先直下でも%APPDATA%でもない第三のパターン、Issue #240）。
 * th06cは実機（Windows）で`C:\Program Files (x86)\Steam\steamapps\common\th06c\replay`
 * と確認済み——Steamのインストールフォルダ名が`GameId`とそのまま一致する。
 * **th06ncのインストールフォルダ名は実機未確認**（`GameId`と同じ`th06nc`と仮定して
 * いる。異なることが判明したら`GameInfoPage.tsx`同様、専用のフォルダ名マップを
 * 導入すること、Issue #241）。
 */
const STEAM_LIBRARY_GAME_IDS: readonly GameId[] = ["th06c", "th06nc"];

const APP_DATA_START_GAME_ID: GameId = "th125";

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

type StorageType = "installFolder" | "steamLibrary" | "appData";

function getStorageType(id: GameId): StorageType {
  if (STEAM_LIBRARY_GAME_IDS.includes(id)) {
    return "steamLibrary";
  }
  const appDataStartIndex = GAME_IDS.indexOf(APP_DATA_START_GAME_ID);
  if (GAME_IDS.indexOf(id) >= appDataStartIndex) {
    return "appData";
  }
  return "installFolder";
}

function installFolderPathPrefix(id: GameId): string {
  const startIndex = GAME_IDS.indexOf(SHANGHAI_ALICE_FOLDER_START_GAME_ID);
  return GAME_IDS.indexOf(id) >= startIndex ? "上海アリス幻樂団\\" : "";
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

/** 作品を切り替えるボタン列。 */
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
  const [selectedGameId, setSelectedGameId] = useState<GameId>("th06");

  const isEnglish = i18n.language.startsWith("en");
  const selectedGameTitle = shortTitle(selectedGameId, isEnglish);
  const selectedGameJapaneseTitle = shortTitle(selectedGameId, false);
  const storageType = getStorageType(selectedGameId);
  const showSteamPath = !NO_STEAM_RELEASE_GAME_IDS.includes(selectedGameId);

  return (
    <section className={staticStyles.card}>
      <h1 className={staticStyles.heading}>{t("replayHelp.heading")}</h1>
      <p>{t("replayHelp.intro")}</p>

      <TitlePicker
        titleIds={GAME_IDS}
        selected={selectedGameId}
        onSelect={setSelectedGameId}
        isEnglish={isEnglish}
      />

      {storageType === "installFolder" && (
        <>
          <p>{t("replayHelp.groups.installFolder.description1", { title: selectedGameTitle })}</p>
          <p>{t("replayHelp.groups.installFolder.defaultLabel")}</p>
          <CopyablePath
            path={`C:\\Program Files (x86)\\${installFolderPathPrefix(selectedGameId)}${selectedGameJapaneseTitle}\\replay`}
          />
          <p>{t("replayHelp.groups.installFolder.virtualStoreLabel")}</p>
          <CopyablePath
            path={`%LOCALAPPDATA%\\VirtualStore\\Program Files (x86)\\${installFolderPathPrefix(selectedGameId)}${selectedGameJapaneseTitle}\\replay`}
          />
          {showSteamPath && (
            <>
              <p>{t("replayHelp.groups.installFolder.steamLabel")}</p>
              <CopyablePath
                path={`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${selectedGameId}\\replay`}
              />
            </>
          )}
        </>
      )}

      {storageType === "steamLibrary" && (
        <>
          <p>
            {t("replayHelp.groups.steamLibrary.description1", {
              title: selectedGameTitle,
            })}
          </p>
          <p>{t("replayHelp.groups.steamLibrary.pathLabel")}</p>
          <CopyablePath path={`C:\\Program Files (x86)\\Steam\\steamapps\\common\\${selectedGameId}\\replay`} />
        </>
      )}

      {storageType === "appData" && (
        <>
          <p>{t("replayHelp.groups.appData.description1", { title: selectedGameTitle })}</p>
          <p>{t("replayHelp.groups.appData.pathLabel")}</p>
          <CopyablePath path={`%APPDATA%\\ShanghaiAlice\\${selectedGameId}\\replay`} />
        </>
      )}
    </section>
  );
}
