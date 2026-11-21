"""ゲームウィンドウの検出と、録画クロップ座標の確定。

x11grabは画面外にはみ出した矩形を指定すると1フレームも取れずに即終了する
("Cannot get the image data ... Permission denied")ため、録画を始める前に
「ウィンドウが画面内に完全に収まっている」ことを保証するのがこのモジュールの役目。
"""
import subprocess
import threading
import time

from .log import log


def find_window(config, env, pid):
    """指定PIDが持つ可視ウィンドウのうち、本体とみなせるものの座標を返す。

    戻り値は (x, y, w, h, window_id)。見つからなければNone。
    """
    out = subprocess.run(
        ["xdotool", "search", "--pid", str(pid)], env=env, capture_output=True, text=True
    ).stdout.split()
    for w in out:
        info = subprocess.run(["xwininfo", "-id", w], env=env, capture_output=True, text=True).stdout
        if "IsViewable" not in info:
            continue
        x = y = wd = ht = None
        for line in info.splitlines():
            line = line.strip()
            if line.startswith("Absolute upper-left X:"):
                x = int(line.split(":")[1])
            elif line.startswith("Absolute upper-left Y:"):
                y = int(line.split(":")[1])
            elif line.startswith("Width:"):
                wd = int(line.split(":")[1])
            elif line.startswith("Height:"):
                ht = int(line.split(":")[1])
        # th06cは起動時に「解像度を選択してください」ダイアログ(194x317)を出すため、
        # 既定の100x100では本体ウィンドウより先にダイアログを掴んでしまう。
        # window_min_sizeを指定したタイトルではその値で足切りする(reports/74)。
        min_w, min_h = config.window_min_size
        if wd and wd > min_w and ht and ht > min_h:
            return x, y, wd, ht, w
    return None


def wait_for_window(config, env, pid, timeout):
    """ウィンドウが現れるまでポーリングする(タイムアウトでNone)。

    `force_window_map`指定タイトル(th12)は、ゲームがウィンドウを最小化
    (WM_STATE=Iconic)状態で作るためxwininfoのMap StateがIsUnMappedのままになり、
    放っておくと永久に検出できない。毎回`xdotool windowmap`を発行してから検出を試みる
    (reports/61)。
    """
    t0 = time.time()
    while time.time() - t0 < timeout:
        if config.force_window_map:
            for wid in subprocess.run(
                ["xdotool", "search", "--pid", str(pid)], env=env,
                capture_output=True, text=True,
            ).stdout.split():
                subprocess.run(["xdotool", "windowmap", wid], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        geom = find_window(config, env, pid)
        if geom:
            return geom
        time.sleep(0.1)
    return None


def move_into_screen(config, env, pid, winid, geom):
    """ウィンドウを画面内へ収め、確定したクロップ座標 (x, y, w, h) を返す。

    openboxの初期配置によっては、ウィンドウがxvfb_screenの範囲外にはみ出す位置に置かれる
    ことがある(th11実機検証で、y=159+height=480=639が800x600の高さ600を超えて
    x11grabが起動失敗する事象を確認、reports/35関連)。クロップ座標に依存せず常に録画・
    スクリーンショットが機能するよう、検出後に左上(0,0)へ強制移動する。

    移動後の実座標は必ず再取得すること: `xdotool windowmove`は(装飾のあるウィンドウの
    場合)ウィンドウ枠を(0,0)へ移動するため、xwininfoが返すクライアント領域の
    Absolute upper-left自体は(0,0)にならないことがある(th11実機検証で、タイトルバー分
    ずれて録画される不具合として発覚)。さらに`xdotool windowmove`の反映は非同期で、
    直後に再取得すると移動前の座標がまだ返ることがある(AWS実機検証で、windowmove直後の
    1回きりの再取得では画面外の旧座標のままx11grabが起動失敗する事象を確認)。
    座標が画面の範囲内に収まるまでwindowmoveを再試行する。
    """
    screen_w, screen_h = config.screen_size
    x, y, w, h = geom[0], geom[1], geom[2], geom[3]
    # th09(フェーズ68)は元々の検出座標が画面範囲内に収まっているケースでも、この(0,0)への
    # 強制移動を行うと録画中盤以降にウィンドウ装飾(タイトルバー)込みの座標へ再配置されて
    # しまう(録画映像の下端~20pxが欠落するバグとして実機で再現、原因未特定)。範囲内に
    # 収まっているタイトルでは移動そのものが不要なため、skip_origin_move_if_fits指定時は
    # 範囲内なら移動をスキップする。
    # 【重要】x >= 0 / y >= 0 も条件に入れること。openboxはウィンドウを画面左上より外側
    # (例: x=-3, y=-16)に置くことがあり、「x + w <= screen_w」だけでは収まっていると
    # 誤判定してしまう。その状態でx11grabを起動すると1フレームも取れず
    # (Permission denied)、空の動画ができる(フェーズ81、1080p録画で実際に発生)。
    if (config.skip_origin_move_if_fits
            and x >= 0 and y >= 0
            and x + w <= screen_w and y + h <= screen_h):
        log("ウィンドウは既にXVFB_SCREEN範囲内のため(0,0)への強制移動をスキップします")
    else:
        for _ in range(20):
            subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)
            time.sleep(0.1)
            moved_geom = find_window(config, env, pid)
            if moved_geom:
                x, y, w, h, _ = moved_geom
                if x + w <= screen_w and y + h <= screen_h:
                    break
        else:
            log(f"WARNING: {20 * 0.1:.1f}秒待ってもウィンドウが画面内に収まりませんでした "
                f"(x={x} y={y} w={w} h={h})")
    log(f"移動後のウィンドウ座標: x={x} y={y} w={w} h={h}")
    return x, y, w, h


def recheck_origin_before_recording(config, env, pid, winid, geometry):
    """録画開始直前にウィンドウが元の位置へ戻っていないかを確認し、戻っていれば再移動する。

    th15のGPU描画面(Xorg+nvidia)実機検証で、ウィンドウ移動の完了直後は(0,0)への移動に
    成功しているのに、その後(`WaitForStableWindow`検出までの間)にウィンドウが元の位置
    (openboxの初期配置座標)へ戻ってしまう現象を確認した(フェーズ82)。原因未特定だが、
    録画開始直前に再度座標を確認し、ずれていれば再移動することで回避する。
    """
    x, y, w, h = geometry
    recheck = find_window(config, env, pid)
    if not recheck:
        return x, y, w, h
    rx, ry, _rw, _rh, _ = recheck
    if rx == 0 and ry == 0:
        return x, y, w, h
    log(f"WARNING: 録画開始直前にウィンドウが再配置されていました (x={rx} y={ry})。"
        "再度(0,0)へ移動します")
    for _ in range(20):
        subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)
        time.sleep(0.1)
        moved_geom = find_window(config, env, pid)
        if moved_geom and moved_geom[0] == 0 and moved_geom[1] == 0:
            x, y, w, h = moved_geom[0], moved_geom[1], moved_geom[2], moved_geom[3]
            break
    log(f"再移動後のウィンドウ座標: x={x} y={y} w={w} h={h}")
    return x, y, w, h


def start_origin_guard(config, env, pid, winid, interval=0.5):
    """録画中もウィンドウを(0,0)に保つ見張りスレッドを起動し、停止用のEventを返す。

    GPU描画面(Xorg+nvidia)では、録画開始直前に(0,0)へ戻しても、その後ゲーム自身が
    ウィンドウ位置を設定し直して(Win32のタイトルバー分下がった)クライアント(3,29)へ
    戻ることがある。th08の2倍速・3倍速でリプレイ中に発生し、以後の映像がずれて
    終了画面のテンプレートが一致せず終了検知できなくなった(reports/89)。
    `recheck_origin_before_recording()`の録画中版として、ずれたらすぐ戻す。
    """
    stop = threading.Event()

    def _run():
        while not stop.wait(interval):
            geom = find_window(config, env, pid)
            if not geom or (geom[0] == 0 and geom[1] == 0):
                continue
            log(f"WARNING: 録画中にウィンドウが移動しました (x={geom[0]} y={geom[1]})。(0,0)へ戻します")
            subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)

    threading.Thread(target=_run, daemon=True).start()
    return stop
