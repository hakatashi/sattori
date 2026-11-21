"""画面キャプチャと画素比較(終了検知・処理落ち検知の判定材料)。

ここに置くのは**画素比較そのものの閾値**だけで、「何回連続で一致したら終了とみなすか」
といったポーリング回数は`recorder/pipeline.py`にある(`POLL_INTERVAL_SEC`との積で
意味が決まるため)。

比較はすべて160x120のグレースケール座標系で行う。x11grabで取得した画像も、録画用
ffmpegのサブ出力(`poll_side_stream`)も、テンプレート画像も、この座標系へ揃えてから
MAD(平均絶対差)を取る。
"""
import io
import os
import subprocess

import numpy as np
from PIL import Image

# 画素比較に使う縮小後の解像度。全ての比較対象をこのサイズへ揃える。
FRAME_W = 160
FRAME_H = 120

# 終了検知(画面静止判定)の閾値。reports/13・14の実測に基づく。
STILL_MAD_THRESHOLD = 2.0

# 終了検知(リプレイ選択画面テンプレート照合)の既定値。
# フェーズ33で発覚した誤検知への対策として導入した: ステージ間のリザルト画面等が
# 16秒を超えて静止し続けると、それだけでリプレイ本編の途中でも「終了」と誤判定されて
# しまう(th6_ud1vfq.rpyでステージ4クリア後に発生を確認)。画面静止は「リプレイ終了時に
# 自動的に戻るリプレイ選択画面」でも「ステージクリア後の一時的なリザルト表示」でも同じ
# ように起こりうるため、静止しているという条件だけでは両者を区別できない。静止条件に
# 加えて「実際にリプレイ選択画面(タイトル文言+列見出しの帯)と一致するか」をテンプレート
# マッチングで確認し、両方満たした場合のみ終了と判定する(reports/33)。
# テンプレート画像は`assets/replay_end_templates/`にタイトルごとに1枚用意する。
# 未設定のタイトルは従来通り静止のみで判定する(フォールバック)。
END_TEMPLATE_ROWS = 40  # 160x120座標系での上部の帯(元解像度の上位1/3、タイトル文言+
                        # 列見出し行を含みリプレイ内容に依存しない領域)
END_TEMPLATE_MAD_THRESHOLD = 15.0  # 実測: 同一画面同士は0.0、無関係な画面とは40〜140(reports/33)

# 終了検知用サブ出力(`GameConfig.poll_side_stream`)のフレームレート。画面静止検知
# (2秒間隔)だけなら0.5fpsで足りるが、`recorder/stutter.py`のprobeが0.15秒間隔の
# 連続サンプルを要求するため、そちらも同じサブ出力から賄えるように8fps(0.125秒間隔)に
# している。160x120 grayなので192 KB/s、25分の録画でも約288MB(録画終了時に削除する)。
POLL_STREAM_FPS = 8


def grab_frame(display, env, x, y, w, h):
    """ウィンドウ領域をx11grabで1フレーム取得し、160x120グレースケール配列で返す。

    1回あたり約0.32秒かかり、その間は同じXサーバーから60fpsでキャプチャしている
    本録画を妨害する。高解像度タイトルではこれが周期的なコマ落ちとして無視できない
    影響を持つため、`GameConfig.poll_side_stream`指定タイトルでは代わりに
    `read_poll_frame()`を使う(reports/81)。
    """
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    img = Image.open(io.BytesIO(result.stdout)).convert("L").resize((FRAME_W, FRAME_H))
    return np.asarray(img, dtype=np.float32)


def read_poll_frame(path):
    """録画用ffmpegが吐き出す「終了検知用サブ出力」(160x120のgray rawvideo)から
    最新の1フレームを読む。

    `grab_frame()`をPOLL_INTERVAL_SEC(2秒)ごとに実行すると、本録画のx11grabを周期的に
    妨害して2.32秒(= 2.0 + 0.32)周期でフレームが脱落する(フェーズ81で、AWS g6f.xlarge・
    1280x720のth06nc録画において1バーストあたり平均3.8フレーム、実効fps 57.96まで低下する
    ことを実測。位相集中度 R=0.654)。

    対策として、録画用ffmpegのfilter_complexにsplitを入れてサブ出力を生やし、ポーリング側は
    そのファイルの末尾を読むだけにする。X11キャプチャ自体が1本で済むため妨害が無くなる。
    rawvideoは固定長フレームの単純な連結なので、末尾の「完全な」ブロックだけを読めば
    書き込み途中の切れたフレームを掴むことはない。

    戻り値は (フレーム番号, 画像) のタプル。まだ1枚も無ければ (0, None)。

    **フレーム番号を必ず確認すること。** ffmpegはファイル出力をバッファリングするため、
    `-flush_packets 1`を付けていても書き込みが遅れることがある。同じフレームを2回読むと
    MADが0になり「画面が静止している」と誤判定してリプレイ終了とみなしてしまう
    (フェーズ81で、開始47秒で録画が打ち切られる事象として実際に発生した)。
    """
    size = FRAME_W * FRAME_H
    try:
        n = os.stat(path).st_size // size
    except OSError:
        return 0, None
    if n == 0:
        return 0, None
    try:
        with open(path, "rb") as f:
            f.seek((n - 1) * size)
            buf = f.read(size)
    except OSError:
        return 0, None
    if len(buf) < size:
        return 0, None
    img = np.frombuffer(buf, dtype=np.uint8).reshape(FRAME_H, FRAME_W).astype(np.float32)
    return n, img


def read_poll_frames(path, count):
    """サブ出力の末尾から連続する count 枚を古い順に返す(足りなければ在る分だけ)。

    処理落ち早期検知(`recorder/stutter.py`)用。サブ出力はPOLL_STREAM_FPSで書かれて
    いるので、隣接フレームの時間間隔は 1/POLL_STREAM_FPS 秒になる。
    """
    size = FRAME_W * FRAME_H
    try:
        n = os.stat(path).st_size // size
    except OSError:
        return []
    take = min(count, n)
    if take < 2:
        return []
    frames = []
    try:
        with open(path, "rb") as f:
            f.seek((n - take) * size)
            for _ in range(take):
                buf = f.read(size)
                if len(buf) < size:
                    break
                frames.append(
                    np.frombuffer(buf, dtype=np.uint8)
                    .reshape(FRAME_H, FRAME_W).astype(np.float32)
                )
    except OSError:
        return []
    return frames


def mad(a, b):
    return float(np.mean(np.abs(a - b)))


def mad_masked(a, b, mask):
    if mask is None:
        return mad(a, b)
    return float(np.mean(np.abs(a - b)[mask]))


def scale_exclude_rects(rects, base, w, h):
    """除外矩形(`still_detect_exclude_rect`等)を、基準解像度baseから実ウィンドウ(w,h)へ
    比例拡大する。

    これらの矩形は特定の解像度を前提に目視で決めているが、th06ncのようにウィンドウ解像度を
    切り替えられるタイトル(720p / 1080p)では、そのままだとマスク位置がずれて静止領域を
    除外しきれない。`GameConfig.exclude_rect_base`(矩形を決めたときの解像度)がある
    場合のみ変換する。
    """
    if not rects or not base:
        return rects
    bw, bh = base
    if (bw, bh) == (w, h):
        return rects
    single = len(rects) == 4 and all(isinstance(v, (int, float)) for v in rects)
    src = [rects] if single else rects
    out = [(x0 * w / bw, y0 * h / bh, x1 * w / bw, y1 * h / bh) for x0, y0, x1, y1 in src]
    return out[0] if single else out


def build_still_mask(rects, w, h):
    """除外矩形(元のウィンドウ座標系の(x0,y0,x1,y1)、またはそのリスト)を、160x120
    グレースケール座標系のブールマスク(True=判定に使う画素)に変換する。rects未設定なら
    None(呼び出し側はマスク無しの`mad()`にフォールバックする)。

    th20(フェーズ44)でリプレイ終了後も2箇所で継続するアニメーションを除外する必要が
    生じたため、単一矩形(th11)だけでなく矩形のリストも受け付けるように拡張した
    (後方互換のため、4要素のタプル/リストが来た場合は単一矩形として扱う)。
    """
    if not rects:
        return None
    if len(rects) == 4 and all(isinstance(v, (int, float)) for v in rects):
        rects = [rects]
    mask = np.ones((FRAME_H, FRAME_W), dtype=bool)
    for x0, y0, x1, y1 in rects:
        rx0 = int(x0 * FRAME_W / w)
        rx1 = int(np.ceil(x1 * FRAME_W / w))
        ry0 = int(y0 * FRAME_H / h)
        ry1 = int(np.ceil(y1 * FRAME_H / h))
        mask[ry0:ry1, rx0:rx1] = False
    return mask


def load_end_template(path):
    """リプレイ選択画面テンプレートを読み込み、`grab_frame()`と同じ160x120グレースケール
    座標系に揃えて返す(フル画像、切り出しは`build_end_template_mask()`で行う)。
    ファイル未設定・未存在の場合はNone(呼び出し側は静止のみで判定する従来の
    フォールバック動作になる)。
    """
    if not path or not os.path.exists(path):
        return None
    img = Image.open(path).convert("L").resize((FRAME_W, FRAME_H))
    return np.asarray(img, dtype=np.float32)


def build_end_template_mask(rect, w, h):
    """`end_template_rect`(元のウィンドウ座標系の(x0,y0,x1,y1))を160x120座標系の
    ブールマスク(True=テンプレート照合に使う画素)に変換する。

    th10(フェーズ56)で、リプレイ選択画面の背景全体が常時アニメーションしており上部の帯
    全体(既定のEND_TEMPLATE_ROWS)を比較すると背景の変化に引きずられて同一画面同士でも
    MADが上振れすることが判明したため、左上の"REPLAY"見出し(リプレイ内容に依存しない
    前面レイヤー、幅約244px高さ約76px)だけに絞り込む必要が生じた。矩形未指定時は、
    既存タイトル(th06/07/08)と同じ「上部END_TEMPLATE_ROWS行×全幅」を使う(後方互換)。
    """
    mask = np.zeros((FRAME_H, FRAME_W), dtype=bool)
    if rect is None:
        mask[:END_TEMPLATE_ROWS, :] = True
        return mask
    x0, y0, x1, y1 = rect
    rx0 = int(x0 * FRAME_W / w)
    rx1 = int(np.ceil(x1 * FRAME_W / w))
    ry0 = int(y0 * FRAME_H / h)
    ry1 = int(np.ceil(y1 * FRAME_H / h))
    mask[ry0:ry1, rx0:rx1] = True
    return mask
