"""照合に使う画素(160x120、True=使う)。th13・th14は一覧の先頭行(リプレイ内容=プレイヤー名・日付等が出る行)を除く。
th20は背景の動きが大きく先頭行の差が埋もれるので全画面で照合した(除いても差し支えない)。"""
import numpy as np


def th13():
    m = np.ones((120, 160), bool); m[19:25] = False; return m


def th14():
    m = np.ones((120, 160), bool); m[18:25] = False; return m


def th20_full():
    return np.ones((120, 160), bool)


def th20_header():
    # 比較用: "Replay" 見出しだけ(th10の前例 touhou-recorder reports/56 に倣った案)。全画面より分離が悪かった
    m = np.zeros((120, 160), bool); m[0:20, 55:105] = True; return m


MASKS = {"th13": th13, "th14": th14, "th20_full": th20_full, "th20_header": th20_header}
