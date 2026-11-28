#pragma once
#include <windows.h>

#include <span>

// メニュー操作のスクリプト(宣言的な `MenuStep` の並び)の実行部(Issue #394)。
//
// 全タイトルのメニュー操作は「キーを押す → 画面遷移が終わるまで待つ」の繰り返しにすぎないので、
// タイトルごとに書くのは `MenuStep` の並び(キー・回数・待ち時間・Stepの文言)だけにする。
// 実行部は **契約行(core/log_contract.h の `Step N:`・`sequence complete`)を出す唯一の場所**で、
// 待ちは必ず `time_scale::MenuSleep`(倍速録画・フレーム同期の切り替え込み)で行う。
// **タイトル側で待ちの倍率やフレーム同期の分岐を計算しないこと**。

namespace autoplay {

// メニュー操作に使うキー。実際のキーコード(DIKスキャンコード・Win32仮想キー)への写像は、
// 入力経路ごとの `PressFn` が持つ。
enum class Key { kDown, kRight, kReturn };

// 経路ごとのキー押下。押している間・離している間の待ち(ポーリング回数)は各経路の既定のまま。
using PressFn = void (*)(Key key);

struct MenuStep {
    // 押すキー。`custom` があれば使わない。
    Key key = Key::kReturn;
    // 同じキーを押す回数(各回の後に waitMs 待つ)。
    int repeat = 1;
    // 押した後(repeat 回なら各回の後)の MenuSleep の基準時間(ms)。
    DWORD waitMs = 0;
    // フレーム同期時だけ別の待ちにするときの値(0なら waitMs と同じ)。
    DWORD waitMsFrameSync = 0;
    // `Step N:` 行の文言。`custom` を使う Step では custom の中で出す。
    const char* label = nullptr;
    // キーを送るだけで表せない Step(th06c の「カーソル位置を読んでから Down を送る」など)。
    // `step`(通し番号)を受け取り、`Step N:` 行は自分で出す。false を返すとシーケンスを中断する
    // (ERROR 行は custom の中で出す)。
    bool (*custom)(int step) = nullptr;
};

// `steps` を順に実行する。Step の番号は firstStep から1ずつ増える(th10 だけ 0 始まり)。
// 全部実行できたら(最後の待ちの後に)フレーム同期の上限を解除し、`sequence complete` 行を出して true。
// custom が false を返したら false(上限は解除しない・完了行も出さない)。
bool RunMenuScript(const char* gameId, std::span<const MenuStep> steps, int firstStep, PressFn press);

}  // namespace autoplay
