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
    date: "2026-10-11",
    ja: "GPUを使う録画（東方紅魔郷: New Classic (th06nc)・東方紺珠伝 (th15)・東方錦上京 (th20) と倍速録画）で、録画サーバーが混雑しているときに別の地域の録画サーバーも使うように。混雑による録画の失敗が起きにくくなります",
    en: "Recordings that use a GPU (Embodiment of Scarlet Devil: New Classic (th06nc), Legacy of Lunatic Kingdom (th15), Unfinished Dream of All Living Ghost (th20), and higher-speed recordings) now also use recording servers in another region when the usual servers are busy, making failures due to congestion less likely",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/296",
  },
  {
    date: "2026-10-09",
    ja: "倍速録画で録画サーバーが長く混雑しているとき、失敗させずに自動で通常の速度での録画へ切り替えるように（東方紅魔郷: New Classic (th06nc)・東方紺珠伝 (th15)・東方錦上京 (th20) を除く）",
    en: "When the recording servers stay busy for a long time, higher-speed recordings now automatically switch to normal-speed recording instead of failing (except for Embodiment of Scarlet Devil: New Classic (th06nc), Legacy of Lunatic Kingdom (th15) and Unfinished Dream of All Living Ghost (th20))",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/289",
  },
  {
    date: "2026-10-09",
    ja: "倍速録画で、本編が数十秒程度の短いリプレイが「処理落ち」と誤判定されて録画に失敗することがある問題を修正",
    en: "Fixed an issue where short replays (around tens of seconds) recorded at higher speed could be wrongly judged as lagging and fail to record",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/304",
  },
  {
    date: "2026-10-05",
    ja: "倍速録画で、本編の短いリプレイ（スペルプラクティス等）が「処理落ち」と誤判定されて録画に失敗する問題を修正",
    en: "Fixed an issue where short replays (such as Spell Practice) recorded at higher speed were wrongly judged as lagging and failed to record",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/306",
  },
  {
    date: "2026-10-05",
    ja: "録画した動画から、メニュー操作やリプレイ終了後の静止画面をカットし、リプレイ選択画面から再生終了までだけを配信するように",
    en: "Recorded videos now cut out the menu navigation and the still screen after the replay ends, keeping only the part from the replay selection screen to the end of playback",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/266",
    important: true,
  },
  {
    date: "2026-10-05",
    ja: "東方紺珠伝 (th15)・東方錦上京 (th20) の動画を1080pに拡大して配信するように（YouTubeにアップロードしても720pに落ちないように）。元の解像度の動画も引き続きダウンロード可能",
    en: "Videos of Legacy of Lunatic Kingdom (th15) and Unfinished Dream of All Living Ghost (th20) are now upscaled to 1080p so they are not downgraded to 720p on YouTube. The original-resolution video is also available for download",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/284",
  },
  {
    date: "2026-10-05",
    ja: "高速録画で、動画の冒頭が数秒間止まって見える・リプレイの最初が欠けることがある問題を修正",
    en: "Fixed an issue where, with high-speed recording, the beginning of the video could appear frozen for a few seconds or the start of the replay could be missing",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/302",
  },
  {
    date: "2026-10-05",
    ja: "ブラウザで動画を先頭から再生したときに、音声が映像より先行して聞こえることがある問題を修正",
    en: "Fixed an issue where audio could play ahead of the video when playing from the beginning in some browsers",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/301",
  },
  {
    date: "2026-10-04",
    ja: "すべてのタイトルで録画速度（高速録画）を選べるように。あわせて低速録画を廃止し、東方錦上京 (th20) は等倍のままGPUで録画するようになり品質が向上",
    en: "Recording speed (high-speed recording) can now be selected for all titles. Slow-motion recording has been retired, and Unfinished Dream of All Living Ghost (th20) is now recorded at normal speed on a GPU for better quality",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/288",
    important: true,
  },
  {
    date: "2026-10-03",
    ja: "高速録画オプションを東方妖々夢 (th07) でも利用可能に",
    en: "The high-speed recording option is now also available for Perfect Cherry Blossom (th07)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/288",
  },
  {
    date: "2026-10-03",
    ja: "東方紺珠伝 (th15) の長いリプレイで、録画後の変換に失敗することがある問題を修正",
    en: "Fixed an issue where conversion after recording could fail for long Legacy of Lunatic Kingdom (th15) replays",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/298",
  },
  {
    date: "2026-10-03",
    ja: "2倍速以上の速度で録画を行う高速録画オプションを実装。試験的に東方紺珠伝 (th15) で有効化",
    en: "Implemented a high-speed recording option that records at 2x speed or higher, enabled experimentally for Legacy of Lunatic Kingdom (th15)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/288",
    important: true,
  },
  {
    date: "2026-10-03",
    ja: "録画した動画の音声と映像のタイミングのずれ（音ズレ）を補正する精度を改善",
    en: "Improved the accuracy of correcting audio/video timing offsets in recorded videos",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/288",
  },
  {
    date: "2026-09-30",
    ja: "録画時にサーバーの空きを待つ時間が発生した際、待ち順・おおよその待ち時間を表示するように改善",
    en: "Added display of queue position and estimated wait time when waiting for an available server during recording",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/270",
    important: true,
  },
  {
    date: "2026-09-29",
    ja: "録画時にサーバーの空きを待つ時間が発生した際、録画を受付順に処理するよう修正",
    en: "Fixed recordings to be processed in the order they were received when waiting for an available server",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/276",
  },
  {
    date: "2026-09-28",
    ja: "東方紅魔郷: New Classic (th06nc) の録画に使用するゲームのバージョンを ver 1.0.6 に更新",
    en: "Updated the game version used for recording the Embodiment of Scarlet Devil: New Classic (th06nc) to ver 1.0.6",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/285",
  },
  {
    date: "2026-09-22",
    ja: "録画ワーカーの起動が一時的に混雑している場合に、より分かりやすいエラーメッセージを表示するよう改善",
    en: "Improved the error message shown when a recording worker temporarily can't be started due to congestion",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/282",
  },
  {
    date: "2026-09-20",
    ja: "録画にGPUを使用するタイトルで、サーバーの空きを待っている間にタイムアウトが発生して失敗する問題を修正",
    en: "Fixed an issue where recordings of titles that use a GPU could fail with a timeout while waiting for an available server",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/275",
  },
  {
    date: "2026-09-19",
    ja: "録画対象のプロセスが途中でクラッシュした際に、中断を検知して自動的に録画をやり直すよう修正",
    en: "Fixed recording to automatically retry when the target process crashes during recording",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/267",
  },
  {
    date: "2026-09-19",
    ja: "東方紺珠伝 (th15) の録画に対応",
    en: "Added recording support for Legacy of Lunatic Kingdom (th15)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/82",
    important: true,
  },
  {
    date: "2026-09-16",
    ja: "妖精大戦争 (th128) のリプレイファイル選択時にプレイヤーキャラクター（チルノ）を表示するよう修正",
    en: "Fixed the replay selection screen to show the player character (Cirno) for Fairy Wars (th128) replays",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/262",
  },
  {
    date: "2026-09-16",
    ja: "妖精大戦争 (th128) の録画に対応",
    en: "Added recording support for Fairy Wars (th128)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/78",
    important: true,
  },
  {
    date: "2026-09-14",
    ja: "東方紅魔郷: New Classic (th06nc) のスペルプラクティスのリプレイファイル選択時にスペルカード名を表示するよう修正",
    en: "Fixed the replay selection screen to show the spell card name for Spell Practice replays of the Embodiment of Scarlet Devil: New Classic (th06nc)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/238",
  },
  {
    date: "2026-09-14",
    ja: "リプレイの収録時間が短い場合に録画が誤って失敗することがある不具合を修正",
    en: "Fixed an issue where recording could incorrectly fail for replays with a very short playtime",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/250",
  },
  {
    date: "2026-09-13",
    ja: "リプレイファイルの保存場所のヘルプページで、作品のグループ分類をやめ、すべての作品を1つのボタングループから選択できるよう改善",
    en: "Updated the replay file location help page to select from all titles in a single button group instead of categorized groups",
  },
  {
    date: "2026-09-13",
    ja: "「現在録画対応中のタイトル」の表示スタイルを修正",
    en: "Fixed the display style of \"Currently supported titles\"",
  },
  {
    date: "2026-09-13",
    ja: "東方紅魔郷: New Classic (th06nc) の録画に対応",
    en: "Added recording support for the Embodiment of Scarlet Devil: New Classic (th06nc)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/241",
    important: true,
  },
  {
    date: "2026-09-11",
    ja: "東方錦上京 (th20) の低速録画をサーバーの混雑状況に関わらず常に利用できるよう改善",
    en: "Slow-motion recording for Unfinished Dream of All Living Ghost (th20) is now available at all times regardless of server load",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/245",
  },
  {
    date: "2026-09-10",
    ja: "東方紅魔郷: Classic (th06c) の録画に対応",
    en: "Added recording support for the Embodiment of Scarlet Devil: Classic (th06c)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/240",
    important: true,
  },
  {
    date: "2026-09-10",
    ja: "リプレイファイルパーサが「東方紅魔郷: Classic」「東方紅魔郷: New Classic」を認識できるよう対応",
    en: "The replay file parser now recognizes \"the Embodiment of Scarlet Devil: Classic\" and \"the Embodiment of Scarlet Devil: New Classic\"",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/236",
  },
  {
    date: "2026-09-09",
    ja: "録画ジョブページに「アップロード」のステップを追加",
    en: "Added an 'Upload' step to the recording job page",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/202",
  },
  {
    date: "2026-09-08",
    ja: "正常なリプレイが誤って録画失敗と判定されることがある不具合を修正",
    en: "Fixed an issue where a normal replay could be incorrectly flagged as a recording failure",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/233",
  },
  {
    date: "2026-09-05",
    ja: "録画完了後のプレビュー動画のサムネイルを、動画終盤のシーンから生成するよう改善",
    en: "Improved the completed recording preview thumbnail to be generated from a scene near the end of the video",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/171",
  },
  {
    date: "2026-09-03",
    ja: "録画動画の再生開始が速くなるよう、配信前の変換処理を改善",
    en: "Improved video processing so recorded videos start playing faster",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/90",
  },
  {
    date: "2026-09-03",
    ja: "ヘッダーロゴの画像サイズを縮小してページの表示速度を改善。あわせてfaviconが最新デザインと異なっていた不具合を修正",
    en: "Reduced the header logo image size to speed up page load, and fixed the favicon showing an outdated design",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/212",
  },
  {
    date: "2026-09-03",
    ja: "画像・スタイルシート・スクリプトなどの静的ファイルにキャッシュ設定を追加し、ページの表示速度を改善",
    en: "Added caching for static assets like images, stylesheets, and scripts to improve page load speed",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/223",
  },
  {
    date: "2026-09-03",
    ja: "録画が再試行の末に成功した場合、途中の失敗によるエラー表示が完了後も残ってしまう不具合を修正",
    en: "Fixed an issue where a leftover error from a failed attempt could still be shown after a recording later succeeded on retry",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/219",
  },
  {
    date: "2026-09-03",
    ja: "東方紅魔郷 (th06) の追加ワーカーでの録画が失敗する不具合を修正",
    en: "Fixed an issue where recording of Embodiment of Scarlet Devil (th06) on the additional worker was failing",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/221",
  },
  {
    date: "2026-09-03",
    ja: "東方花映塚 (th09) の録画に対応",
    en: "Added recording support for Phantasmagoria of Flower View (th09)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/216",
    important: true,
  },
  {
    date: "2026-09-02",
    ja: "東方錦上京 (th20) のスペルプラクティスのリプレイを判別し、スペルカード番号を表示するよう修正",
    en: "Fossilized Wonders (th20) spell practice replays are now identified, with the spell card number shown",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/176",
  },
  {
    date: "2026-09-02",
    ja: "東方錦上京 (th20) のリプレイの推定録画時間の算出とステージ別記録の解析に対応",
    en: "Estimated recording duration and per-stage records are now available for Fossilized Wonders (th20) replays",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/176",
  },
  {
    date: "2026-09-02",
    ja: "東方花映塚 (th09) のリプレイの推定録画時間の算出に対応",
    en: "Estimated recording duration is now shown for Phantasmagoria of Flower View (th09) replays",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/213",
  },
  {
    date: "2026-09-02",
    ja: "東方星蓮船 (th12) の録画に対応",
    en: "Added recording support for Undefined Fantastic Object (th12)",
    issueUrl: "https://github.com/hakatashi/sattori-dev/pull/207",
    important: true,
  },
  {
    date: "2026-08-30",
    ja: "追加ワーカーで録画時の起動処理を高速化",
    en: "Sped up startup processing for recording on the additional worker",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/104",
  },
  {
    date: "2026-08-30",
    ja: "録画中に画面が長時間動かなくなった場合、強制的に録画を停止するよう修正",
    en: "Fixed recording to be forcibly stopped when the screen freezes for an extended period during playback",
    issueUrl: "https://github.com/hakatashi/sattori-dev/issues/195",
  },
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
