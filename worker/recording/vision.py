"""画面キャプチャと画素比較(終了検知の判定材料)。

ここに置くのは**画素比較そのものの閾値**だけで、「何回連続で一致したら終了とみなすか」
といったポーリング回数は `recording/pipeline.py` にある。終了検知をテンプレート照合へ
変えた経緯は
[`docs/decisions/0011`](../../docs/decisions/0011-replay-end-template-matching.md)。
"""
import io
import os
import subprocess

import numpy as np
from PIL import Image


# 終了検知(画面静止判定)の閾値・待機。PoC(touhou-recorder reports/13・14)の
# 実測に基づく。変更する場合は当該レポートの根拠を必ず確認すること。
STILL_MAD_THRESHOLD = 2.0


# 終了検知(リプレイ選択画面テンプレート照合)。touhou-recorder reports/33・34で判明した
# 通り、画面静止(STILL_MAD_THRESHOLD/STILL_CONSECUTIVE_REQUIRED)だけでは「リプレイ終了時に
# 自動的に戻るリプレイ選択画面」と「ステージクリア後に一時的に表示されるリザルト画面」を
# 区別できず、後者がSTILL_CONSECUTIVE_REQUIRED(16秒)を超えて静止し続けると、リプレイ本編の
# 途中でも誤って「終了」と判定されてしまう(th06のth6_ud1vfq.rpyでステージ4クリア後に実際に
# 発生を確認、reports/33)。この誤検知はth06に限らずth07/th08にも起こりうる構造的な問題である
# ため、画面静止という条件そのものを「実際にリプレイ選択画面(タイトル文言+列見出しの帯)と
# 一致するか」のテンプレートマッチングに置き換える。
# テンプレートが使えるゲームでは画面静止を待たず毎回テンプレートと照合するため、静止待ちの
# 分だけ終了検知も高速化する(reports/34。静止のみ判定の最短16秒+αから、最短
# END_TEMPLATE_CONSECUTIVE_REQUIRED*POLL_INTERVAL_SEC=4秒へ短縮)。
# テンプレート画像は`assets/replay_end_templates/{game_id}.png`にゲームごとに1枚用意する
# (`worker/README.md` §8参照。ゲーム本体等と同様リポジトリには含めずdocker build前に配置する)。
# 未整備・未検出のゲームは警告ログを出しつつ従来の画面静止のみ判定にフォールバックする。
END_TEMPLATE_ROWS = 40  # 160x120にダウンサンプルした座標系での上部の帯(タイトル文言+列見出し
                        # 行を含む。リプレイ内容(一覧の中身・プレイヤー名/日付)には依存しない
                        # 領域であることをreports/34でクロスリプレイ実証済み)
END_TEMPLATE_MAD_THRESHOLD = 15.0  # 実測: テンプレート自己一致は0.0〜0.32、無関係な画面
                                   # (ステージクリア画面・ゲームプレイ中・タイトル等)とは
                                   # 40〜140超と大きなマージンがある(reports/33・34)


def grab_frame(config, env, x, y, w, h):
    """終了検知用のグレースケール縮小画像と、進捗スクリーンショット用のカラー画像を
    同じffmpegキャプチャから作る(1回のキャプチャで両方をまかない、追加コストを出さない)。"""
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{config.display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    color = Image.open(io.BytesIO(result.stdout)).convert("RGB")
    gray = np.asarray(color.convert("L").resize((160, 120)), dtype=np.float32)
    return gray, color


def mad(a, b):
    return float(np.mean(np.abs(a - b)))


def build_still_mask(rect, w, h):
    """GameConfig.still_detect_exclude_rect(元のウィンドウ座標系のx0,y0,x1,y1)を、
    grab_frame()が常にリサイズする160x120グレースケール座標系のブールマスク
    (True=静止判定に使う画素)に変換する。rect未設定ならNone(呼び出し側はマスク無しの
    従来通りのmad()にフォールバックする)。

    **矩形のリストも受け付ける**。th11は明滅する選択カーソル1箇所だけだったが、th20は
    リプレイ終了後も2箇所(左側の立ち絵まわりと右下)で背景アニメーションが継続するため、
    どちらも除外しないと静止判定が成立しない(touhou-recorder reports/45)。"""
    if not rect:
        return None
    # 単一の矩形(x0,y0,x1,y1)とリストの両方を受けるため、前者はリストへ包む。
    # 「先頭要素が数値かどうか」で見分ける(tuple/listの別には依存しない)。
    rects = [rect] if isinstance(rect[0], (int, float)) else list(rect)
    mask = np.ones((120, 160), dtype=bool)
    for x0, y0, x1, y1 in rects:
        rx0 = int(x0 * 160 / w)
        rx1 = int(np.ceil(x1 * 160 / w))
        ry0 = int(y0 * 120 / h)
        ry1 = int(np.ceil(y1 * 120 / h))
        mask[ry0:ry1, rx0:rx1] = False
    return mask


def mad_masked(a, b, mask):
    if mask is None:
        return mad(a, b)
    return float(np.mean(np.abs(a - b)[mask]))


def load_end_template(path):
    """リプレイ選択画面テンプレートを読み込み、grab_frameと同じ160x120グレースケール
    座標系に揃えたフル画像を返す(切り出しは呼び出し側がbuild_end_template_maskで
    行う)。ファイル未設定・未存在の場合はNone(呼び出し側は画面静止のみで判定する
    従来のフォールバック動作になる、reports/33参照)。"""
    if not path or not os.path.exists(path):
        return None
    img = Image.open(path).convert("L").resize((160, 120))
    return np.asarray(img, dtype=np.float32)


def build_end_template_mask(rect, w, h):
    """GameConfig.end_template_rect(元のウィンドウ座標系のx0,y0,x1,y1)を、
    grab_frame()が常にリサイズする160x120グレースケール座標系のブールマスク
    (True=テンプレート照合に使う画素)に変換する。rect未設定なら従来通り
    「上部END_TEMPLATE_ROWS行×全幅」を使う(th06/07/08、後方互換)。

    th10のリプレイ選択画面は背景全体が常時アニメーションしており、上部帯全体を
    比較すると同一画面同士でもMADが上振れして誤判定を招くため、リプレイ内容に
    依存しない左上の"REPLAY"見出し部分だけに絞り込む必要がある
    (touhou-recorder reports/56)。"""
    mask = np.zeros((120, 160), dtype=bool)
    if rect is None:
        mask[:END_TEMPLATE_ROWS, :] = True
        return mask
    x0, y0, x1, y1 = rect
    rx0 = int(x0 * 160 / w)
    rx1 = int(np.ceil(x1 * 160 / w))
    ry0 = int(y0 * 120 / h)
    ry1 = int(np.ceil(y1 * 120 / h))
    mask[ry0:ry1, rx0:rx1] = True
    return mask
