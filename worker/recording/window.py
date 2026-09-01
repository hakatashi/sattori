"""ゲームウィンドウの検出と、x11grab のクロップ座標の確定。

座標を「ウィンドウが安定してから」取り直す理由は
[`docs/decisions/0012`](../../docs/decisions/0012-crop-geometry-after-window-stabilizes.md)。
"""
import subprocess
import time


# ウィンドウ座標(x11grabのクロップ座標)を確定させる際の安定判定。wait_for_stable_geometry()
# がこの間隔でfind_window()を繰り返し、2回連続で同じ座標が返るまで待つ。
GEOMETRY_SETTLE_SEC = 0.3
GEOMETRY_SETTLE_TIMEOUT_SEC = 10.0
# windowmove後の再確認に使う短いタイムアウト(最大20回リトライするため、1回あたりは短くする)。
GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC = 3.0


def find_window(config, env, pid):
    out = subprocess.run(
        ["xdotool", "search", "--pid", str(pid)], env=env, capture_output=True, text=True
    ).stdout.split()
    if config.force_window_map:
        # 最小化(Iconic)状態で生成されるゲーム(th12)向けの対策。IsViewable判定に
        # 載せるため検出した全ウィンドウを強制的に可視化する。既にマップ済みの
        # ウィンドウに対して呼んでも副作用は無い(touhou-recorder reports/61)。
        for w in out:
            subprocess.run(["xdotool", "windowmap", w], env=env)
    for w in out:
        info = subprocess.run(["xwininfo", "-id", w], env=env, capture_output=True, text=True).stdout
        if "IsViewable" not in info:
            continue
        x = y = wd = ht = None
        for line in info.splitlines():
            line = line.strip()
            # クロップ座標は xwininfo の Absolute upper-left を使う
            # (xdotool getwindowgeometry だとタイトルバー分ズレる, AGENTS.md)。
            if line.startswith("Absolute upper-left X:"):
                x = int(line.split(":")[1])
            elif line.startswith("Absolute upper-left Y:"):
                y = int(line.split(":")[1])
            elif line.startswith("Width:"):
                wd = int(line.split(":")[1])
            elif line.startswith("Height:"):
                ht = int(line.split(":")[1])
        if wd and wd > 100 and ht and ht > 100:
            return x, y, wd, ht, w
    return None


def wait_for_stable_geometry(config, env, pid, log=print,
                             settle_sec=GEOMETRY_SETTLE_SEC,
                             timeout=GEOMETRY_SETTLE_TIMEOUT_SEC):
    """find_window()をsettle_sec間隔で繰り返し、2回連続で同じ座標が返るまで待つ。

    xwininfoの単発の取得結果は、ウィンドウが移動中だと信用できない。ゲームが
    初期化中に自分でウィンドウを再配置している最中に取得すると、移動前・移動後・
    その中間のいずれとも異なる座標が返ってくる(th11の本番ジョブ・ローカル実測で
    (133,119)(142,137)(159,119)(168,136)(172,197)(197,196)(200,202)と毎回異なる値を
    観測。安定後の真の座標は常に(185,211))。1回の取得結果をそのままクロップ座標に
    採用すると、ズレたまま録画し続けることになる(Issue: th11のジョブ
    a5c36a30-548a-421d-abc7-b4a7fdffc914で、実ウィンドウ(185,211)に対して
    (159,119)を録画し、タイトルバーが写り込み右下26x92pxが欠ける不具合として発覚)。

    タイムアウトした場合は最後に取得できた座標を返す(Noneのこともある)。呼び出し側は
    Noneを失敗として扱うこと。"""
    t0 = time.time()
    prev = None
    while time.time() - t0 < timeout:
        geom = find_window(config, env, pid)
        if geom and prev and geom[:4] == prev[:4]:
            return geom
        prev = geom
        time.sleep(settle_sec)
    log(f"WARNING: ウィンドウ座標が{timeout}秒以内に安定しませんでした (最後の取得値={prev})")
    return prev
