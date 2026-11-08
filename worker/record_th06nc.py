#!/usr/bin/env python3
"""th06nc(東方紅魔郷: New Classic)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th06nc 固有の設計判断と踏んだ地雷は [`docs/titles/th06nc.md`](docs/titles/th06nc.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th06nc でしか成り立たない値だけを置く。

GPUワーカー(`GPU_WORKER=1`)では`gpu_display=True`でXorg+NVIDIA GRIDドライバのヘッドレス
画面(`recording/gpu_display.py`)を使い、`dxvk_dll_overrides`でDXVK(D3D11→Vulkan)を有効化する
(Issue #241)。

CPUワーカーでは他タイトルと同じXvfb+wined3d+llvmpipeで描画する。そのままでは9fpsしか出ないが、
主因はBC7圧縮テクスチャのソフトウェアデコードで、MODがロード時にRGBA8へ展開すれば
(`D3D11_DECODE_BC7=1`)60fpsに届く(touhou-recorder reports/96)。等倍はキャプチャ側で落ちるため、
1/2倍速の低速録画でだけ使う(reports/97)。
"""
import os

from recording import cli
from recording.config import WORKER_ROOT, GameConfig
from recording.timing import gpu_worker, recording_time_scale

# th06.env(12バイト)のbyte[5]で解像度が決まる(touhou-recorder reports/78 §4.1)。
# 720p/1080pそれぞれの完成済みth06.envをタイトル資産(games/th06nc/)に同梱しておき、
# 録画のたびにそのままinstance_dirへ上書きコピーする(ゲーム終了時に書き戻されて
# しまうため、内容を自前で組み立てるより既知の正しいファイルをコピーする方が安全)。
_RESOLUTIONS = {
    "720p": {"window": (1280, 720), "env_file": "th06.env.720p", "crtc_mode": None},
    "1080p": {"window": (1920, 1080), "env_file": "th06.env.1080p", "crtc_mode": "1920x1080"},
}

# 720p基準の除外矩形(プレイフィールド外の左右の装飾。stutter probe用に実機特定
# された座標をtouhou-recorder reports/79から流用し、画面静止判定の除外矩形として
# 使う)。1080p選択時は`_scale_rect()`で解像度比に応じて拡大する。
_STILL_DETECT_EXCLUDE_RECT_720P = [(0, 0, 352, 720), (934, 0, 1280, 720)]


def _scale_rect(rects, from_wh, to_wh):
    if from_wh == to_wh:
        return rects
    sx = to_wh[0] / from_wh[0]
    sy = to_wh[1] / from_wh[1]
    return [
        (round(x0 * sx), round(y0 * sy), round(x1 * sx), round(y1 * sy))
        for x0, y0, x1, y1 in rects
    ]


def _cpu_rendering_env(time_scale):
    """CPU描画(Xvfb+wined3d+llvmpipe)用にゲームへ渡す環境変数(touhou-recorder reports/96・97)。"""
    env = [
        # MODがBC7テクスチャをロード時にRGBA8へ展開する(mods/common/d3d11_bc7_hook.cpp)。
        ("D3D11_DECODE_BC7", "1"),
        # llvmpipeのラスタライズスレッドを使えるvCPU数に合わせる(reports/97の構成)。
        # `os.cpu_count()`はCPU affinity(`docker run --cpuset-cpus`)を見ない。
        ("LP_NUM_THREADS", str(len(os.sched_getaffinity(0)))),
    ]
    if time_scale > 1.0:
        # メニュー操作のSleep()は実時間で待つので、低速録画ではゲーム内の遷移アニメーションに
        # 合わせて同じ比率で伸ばす(MODの`GetTimeScale()`)。倍速の短縮は`MenuWaitScale()`が担う。
        env.append(("TH06NC_TIME_SCALE", f"{time_scale:g}"))
    return tuple(env)


def build_config(pulse_sink):
    # for_game()内のmod_dir解決(SATTORI_MOD_DIR対応)と同じロジックをここでも踏む必要が
    # ある(th06c版のコメント参照)。
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{WORKER_ROOT}/mods")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{WORKER_ROOT}/games/th06nc")

    # 1080p録画オプション(Issue #241)。`TH06NC_RESOLUTION`は`apps/api/src/
    # workerEnv.ts`が`job.options.th06ncHighResolution`から設定する
    # (未指定=720p)。インスタンスはどちらもg6f.xlargeのまま
    # (`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`)。
    resolution = os.environ.get("TH06NC_RESOLUTION")
    resolution = resolution if resolution in _RESOLUTIONS else "720p"
    spec = _RESOLUTIONS[resolution]
    window_w, window_h = spec["window"]
    gpu = gpu_worker()
    time_scale = recording_time_scale()

    return GameConfig.for_game(
        "th06nc", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する
        # (th06cは:102を使用)。
        display=":103",
        # th06ncもth06cと同様、リプレイ一覧はファイル名ではなく列挙順で決まると
        # 見られる(未確定、実機検証で確認すること。worker/docs/titles/th06nc.md参照)。
        canonical_slot="th6_01.rpy",
        # th06nc.exeはPE32+(x86-64)のため64bit injectorを使う(th06cと同じ)。
        injector="injector64.exe",
        injector_path=f"{mod_dir}/common/build/injector64.exe",
        # GPU描画ではDXVK(D3D11→Vulkan)を使う。wined3dより重複フレーム率で一貫して
        # 優位だった(touhou-recorder reports/79〜81)。CPU描画ではwined3dのビルトインを明示する
        # (プレフィックスのsystem32にDXVKを置いてあるため。XvfbではDXVKのdxgiがRandRの
        # 0Hzでゼロ除算して落ちる、reports/96 §1.1)。
        gpu_display=gpu,
        dxvk_dll_overrides="d3d11,dxgi,d3d10core=n" if gpu else "d3d11,dxgi,d3d10core=b",
        crtc_mode=spec["crtc_mode"] if gpu else None,
        extra_env=() if gpu else _cpu_rendering_env(time_scale),
        # DXライブラリは時間基準でゲームを進め、fps_limiterを持たないので、低速録画も
        # QPC偽装で減速する(reports/97)。
        slow_motion_speed_hack=True,
        # ウィンドウ+装飾が720p/1080pどちらでも収まる仮想画面サイズ
        # (touhou-recorder reports/81で実機使用)。
        xvfb_screen="2200x1400x24",
        # 起動のたびに書き戻されるth06.envを、選択された解像度のものへ上書きする。
        extra_instance_files=((f"{game_dir_src}/{spec['env_file']}", "th06.env"),),
        # GPU実行時、進捗スクショ用の定期ポーリングキャプチャが本番録画用x11grabと
        # 競合し周期的なコマ落ちを起こす問題への対処(touhou-recorder reports/81 §9)。
        poll_side_stream=gpu,
        still_detect_exclude_rect=_scale_rect(
            _STILL_DETECT_EXCLUDE_RECT_720P, (1280, 720), (window_w, window_h),
        ),
        # 終了検知テンプレートは未整備(実機検証でフル尺録画後に取得する、
        # worker/docs/titles/th06nc.md参照)。画面静止のみでの判定にフォールバックする。
    )


if __name__ == "__main__":
    cli.run("th06nc", build_config)
