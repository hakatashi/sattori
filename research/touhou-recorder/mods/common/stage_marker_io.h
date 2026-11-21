#pragma once
#include <windows.h>

// ステージ開始時刻の記録(ファイルI/O方式、フェーズ49)。
//
// mods/common/stage_marker_hook.* の「ステージ番号変数をポーリングする方式」が
// 使えないタイトル向けの代替。th20は次の理由でこちらを使う:
//
//   - th20.exeの.dataは0.2MBしかなく、ステージ番号はヒープ上のゲーム管理構造体に
//     あると見られる。ヒープはアドレスが実行ごとに変わるためRVA直指定できない
//   - ヒープを探索するための差分メモリスキャン(stage_probe_hook.*)を動かすと、
//     th20はステージ遷移の瞬間(ヒープが大きく再構成されるタイミング)にフリーズする
//
// 代わりに、**ステージロード時に発生するデータアーカイブの大量読み出し**を検出する。
// th20の実測では、ステージ開始のたびにth20.datから5〜7MBを10回前後の読み出しで
// 一気に取り込むバーストが発生し、その直後にBGMが切り替わる。BGMはステージ道中曲と
// ボス曲で1ステージあたり2回切り替わるためBGM単独ではステージ境界を確定できないが、
// **アセットロードのバーストはステージ開始時にしか起きない**ため一意に判定できる。
//
// 出力される行(バーストの「先頭の読み出し」の時刻を使う。実測でユーザーの目視値と
// 最もよく一致する):
//
//   StageMarker: stage_load file=th20.dat bytes=5407503 reads=10 frame=11824 epoch_ms=...
//
// なお、ゲーム起動時にも巨大なバースト(th20で20MB)が出るため、リプレイ再生を
// 開始するまでは検出を無効にしておく必要がある(ArmStageMarkerIo()を
// メニュー自動操作から呼ぶ)。

namespace autoplay {

// dataFileName: 監視するアーカイブのファイル名(大文字小文字は無視、例 "th20.dat")
// burstBytes: この量以上を読んだ一連の読み出しを「ステージロード」とみなす
// burstGapMs: この時間読み出しが途切れたらバースト終了とみなす
bool InstallStageMarkerIoHook(const char* dataFileName,
                              LONGLONG burstBytes = 1024 * 1024,
                              DWORD burstGapMs = 500);

// リプレイ再生を開始する直前に呼ぶ。これ以降のバーストだけが記録対象になる。
void ArmStageMarkerIo();

} // namespace autoplay
