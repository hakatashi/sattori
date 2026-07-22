#pragma once

// GetDeviceStateフック呼び出し頻度(=実効描画fps相当)を一定間隔でログに出力する
// デバッグ用スレッド。reports/22_phase22_th08_e2e_recording_verification.mdで発見した
// 「th08は実際のゲームプレイ中にfpsが数百〜数千に暴走する場合がある」
// 「録画が冒頭から重複フレームだらけになる(処理落ち)場合がある」という2種類の
// 異常について、プロセス生存中ずっと実効fpsの推移をログに残すことで原因調査の
// 手がかりを得るために追加した。

namespace autoplay {

// バックグラウンドスレッドを起動し、intervalMsごとに直近のGetDeviceState呼び出し
// 回数(=intervalMsの間に何フレーム分描画が進んだか)をLog()に出力し続ける。
// プロセス終了まで動き続ける常駐スレッド。
void StartFpsMonitorThread(unsigned int intervalMs = 5000);

} // namespace autoplay
