import { describe, expect, it } from "vitest";
import type { ReplayInfo } from "./replay.js";
import { buildContentDispositionValue, buildDownloadFilename } from "./download.js";

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
    expect(buildDownloadFilename("job-1", SAMPLE_REPLAY_INFO, "delivery")).toBe(
      "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi) #TouhouSattori.mp4",
    );
  });

  it("オリジナル解像度版は区別できるサフィックスを付ける", () => {
    expect(buildDownloadFilename("job-1", SAMPLE_REPLAY_INFO, "raw")).toBe(
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
    expect(buildDownloadFilename("job-1", info, "delivery")).toBe("東方地霊殿 #TouhouSattori.mp4");
  });

  it("replayInfoが無ければjobIdのみで組み立てる", () => {
    expect(buildDownloadFilename("job-1", null, "delivery")).toBe("job-1 #TouhouSattori.mp4");
  });

  it("ファイルシステムで使えない記号を全角に置き換える", () => {
    const info: ReplayInfo = { ...SAMPLE_REPLAY_INFO, player: 'a/b:c*d?e"f<g>h|i' };
    expect(buildDownloadFilename("job-1", info, "delivery")).toBe(
      "東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー a／b：c＊d？e”f＜g＞h｜i) #TouhouSattori.mp4",
    );
  });
});

describe("buildContentDispositionValue", () => {
  it("ASCIIのみのファイル名はfilenameとfilename*の両方に同じ値を使う", () => {
    expect(buildContentDispositionValue("video.mp4")).toBe(
      "attachment; filename=\"video.mp4\"; filename*=UTF-8''video.mp4",
    );
  });

  it("日本語ファイル名はfilenameをASCII置換し、filename*にUTF-8パーセントエンコードを使う", () => {
    const value = buildContentDispositionValue("東方地霊殿 Lunatic.mp4");
    expect(value).toContain('filename="_____ Lunatic.mp4"');
    expect(value).toContain(
      "filename*=UTF-8''%E6%9D%B1%E6%96%B9%E5%9C%B0%E9%9C%8A%E6%AE%BF%20Lunatic.mp4",
    );
  });

  it("ダブルクォートはfilenameフォールバック側でシングルクォートへ置き換える", () => {
    const value = buildContentDispositionValue('a"b.mp4');
    expect(value).toContain('filename="a\'b.mp4"');
  });

  it("filename*側は*や'などRFC5987で許可されない記号もパーセントエンコードする", () => {
    const value = buildContentDispositionValue("a*b'c.mp4");
    expect(value).toContain("filename*=UTF-8''a%2Ab%27c.mp4");
  });
});
