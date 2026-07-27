import { describe, expect, it } from "vitest";
import type { ReplayInfo } from "@sattori/shared";
import { buildDownloadFilename } from "./downloadFilename.ts";

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  difficulty: "Lunatic",
  stage: null,
  score: 442469780,
  cleared: true,
  estimatedDurationSeconds: 847,
};

describe("buildDownloadFilename", () => {
  it("副題を除いたタイトル・難易度・キャラ・スコア・プレイヤー名からファイル名を組み立てる", () => {
    expect(buildDownloadFilename("job-1", SAMPLE_REPLAY_INFO, "720p")).toBe(
      "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #TouhouSattori.mp4",
    );
  });

  it("オリジナル解像度版は区別できるサフィックスを付ける", () => {
    expect(buildDownloadFilename("job-1", SAMPLE_REPLAY_INFO, "original")).toBe(
      "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #raw #TouhouSattori.mp4",
    );
  });

  it("難易度・キャラ・スコアが欠けている場合はその部分を省く", () => {
    const info: ReplayInfo = {
      ...SAMPLE_REPLAY_INFO,
      character: null,
      difficulty: null,
      score: null,
      player: "",
    };
    expect(buildDownloadFilename("job-1", info, "720p")).toBe("東方地霊殿 #TouhouSattori.mp4");
  });

  it("replayInfoが無ければjobIdのみで組み立てる", () => {
    expect(buildDownloadFilename("job-1", null, "720p")).toBe("job-1 #TouhouSattori.mp4");
  });

  it("ファイルシステムで使えない記号を全角に置き換える", () => {
    const info: ReplayInfo = { ...SAMPLE_REPLAY_INFO, player: 'a/b:c*d?e"f<g>h|i' };
    expect(buildDownloadFilename("job-1", info, "720p")).toBe(
      "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー a／b：c＊d？e”f＜g＞h｜i) #TouhouSattori.mp4",
    );
  });
});
