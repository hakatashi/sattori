#!/usr/bin/env python3
"""全14タイトル（sattori 本番13タイトル＋th14 追補）のフレーム同期キャプチャ EC2 録画速度・課金時間・コスト推定 (フェーズ112).

Phase 105〜112 で計測したローカル実測値 (Ryzen 7 5700X, 8c16t, 8t/4t スケーリング) と
Phase 109 の AWS EC2 実測アンカー (th12 / th15 × c7i.4xlarge / c7i.2xlarge / m7i.xlarge / g6f.xlarge)、
および sattori 本番プラン (../sattori/packages/shared/src/recordingPlan.ts) に基づき、
1時間リプレイ (3600秒) あたりの録画速度・実時間・課金時間・コスト(USD)を算出する。

計算式 (reports/109 §4.3・../sattori/docs/reports/2026-11-08-... と同一モデル):
  課金時間 (h) = 0.05 (固定180s) + rec_hours + convert_ratio
  時間単価 (USD/h) = spot_usd_per_h + 0.0086 (EBS gp3 30GiB + IPv4)
  費用 (USD/h_replay) = 課金時間 * 時間単価

Usage:
  python3 scripts/112_estimate_ec2_costs.py [--markdown]
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Optional

OVERHEAD_HOURS = 180.0 / 3600.0  # 0.05h fixed EC2 boot/prep overhead
EBS_IPV4_USD_PER_HOUR = 0.0086   # 30GiB gp3 + public IPv4
WALL_TIMEOUT_SEC = 7200.0        # sattori MAX_WALL_CLOCK_TIMEOUT_SEC (120 min)

# Spot prices (USD/h) from:
#   - 2026-11-18 UTC actual / snapshot in reports/109 §4.2
#   - 2026-11-08 07:42 UTC snapshot in sattori/docs/reports/2026-11-08-...md §4
SPOT_2026_11_18 = {
    "c7i.4xlarge": ("eus2b", 0.0982),
    "c7i.2xlarge": ("eus2c", 0.0595),
    "c7i.xlarge": ("eus2b", 0.0516),
    "c7i-flex.xlarge": ("eus2_est", 0.0300),  # 11-08 range $0.0292-0.0302 (not re-polled on 11-18)
    "m7i.xlarge": ("eus2c", 0.0313),
    "g6f.xlarge": ("eun1b", 0.0665),          # usw2c was $0.0767 in Phase 109
    "g6f.2xlarge": ("eus2a", 0.1028),         # eun1b $0.0712, eus2b $0.1790
}

SPOT_2026_11_08 = {
    "c7i.4xlarge": ("eus2b", 0.0863),         # range $0.0820-0.1003
    "c7i.2xlarge": ("eus2c", 0.0421),         # range $0.0421-0.0478
    "c7i.xlarge": ("eus2a", 0.0488),          # range $0.0488-0.0554
    "c7i-flex.xlarge": ("eus2a", 0.0292),     # range $0.0292-0.0302
    "m7i.xlarge": ("eus2c", 0.0265),          # range $0.0265-0.0317
    "g6f.xlarge": ("eun1b_est", 0.0665),
    "g6f.2xlarge": ("eus2a", 0.0612),         # range $0.0612-0.1103 (2c=$0.5283), eun1a=$0.0856
}

# Conversion ratios (convert_elapsed / play_dur) for --frame-sync (no speed restore needed).
# Anchors:
#   - reports/109 §4.1: 640x480->960x720 & 1280x960->1440x1080 on c7i.4xlarge/2xlarge/m7i.xlarge/g6f.xlarge
#   - Phase 112 local 16t (109_bench_convert.py):
#       640x480->960x720 = 0.1703, 1280x720 = 0.2097, 1280x960->1440x1080 = 0.4188, 1920x1080 = 0.4707
CONVERT_RATIOS = {
    "640x480": {
        "c7i.4xlarge": 0.1636,
        "c7i.2xlarge": 0.2367,
        "c7i.xlarge": 0.4018,       # proxy: m7i.xlarge (same gen 4vCPU)
        "c7i-flex.xlarge": 0.4018,  # proxy: m7i.xlarge
        "m7i.xlarge": 0.4018,
        "g6f.xlarge": 0.2531,
        "g6f.2xlarge": 0.2000,      # NVENC + 8vCPU (faster audio/filter than g6f.xlarge 0.2531)
    },
    "1280x720": {
        "c7i.4xlarge": 0.1970,      # 0.2097 * (0.1636/0.1703 ~ 0.94 avg scale)
        "c7i.2xlarge": 0.3000,      # 0.2097 * 1.43
        "c7i.xlarge": 0.5180,       # 0.2097 * 2.47
        "c7i-flex.xlarge": 0.5180,
        "m7i.xlarge": 0.5180,
        "g6f.xlarge": 0.2550,
        "g6f.2xlarge": 0.2100,
    },
    "1280x960": {
        "c7i.4xlarge": 0.3750,
        "c7i.2xlarge": 0.6692,
        "c7i.xlarge": 1.2711,
        "c7i-flex.xlarge": 1.2711,
        "m7i.xlarge": 1.2711,
        "g6f.xlarge": 0.2586,
        "g6f.2xlarge": 0.2100,
    },
    "1920x1080": {
        "c7i.4xlarge": 0.4215,      # 0.3750 * (0.4707 / 0.4188)
        "c7i.2xlarge": 0.7521,      # 0.6692 * (0.4707 / 0.4188)
        "c7i.xlarge": 1.4286,       # 1.2711 * (0.4707 / 0.4188)
        "c7i-flex.xlarge": 1.4286,
        "m7i.xlarge": 1.4286,
        "g6f.xlarge": 0.2800,
        "g6f.2xlarge": 0.2300,
    },
}


@dataclass(frozen=True)
class TitleSpec:
    key: str
    title: str
    api: str
    res: str
    regime: str  # "light", "heavy_d3d9", "dxlib_720", "dxlib_1080"
    local_16t: float
    local_8t: Optional[float]
    local_4t: Optional[float]
    aws_actual: dict[str, float]  # directly measured AWS speed (Phase 109)
    legacy_primary: tuple[str, float, float, str]  # (inst, speed, conv_ratio, note)
    legacy_cpu_fallback: Optional[tuple[str, float, float, str]]
    notes: str


# Measured local speeds (unthrottled average speedup) from Phases 105, 108, 109, 110, 111, 112.
TITLES: list[TitleSpec] = [
    TitleSpec(
        key="th06",
        title="th06 (Extra/Normal)",
        api="D3D8+DS8",
        res="640x480",
        regime="light",
        local_16t=5.08,   # Phase 111 th6_ud1bws 5.08x (th6_02 ~5.14x excl. broken local wav)
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="vpatch_th06 IAT",
    ),
    TitleSpec(
        key="th06c",
        title="th06c (Extra/Hard)",
        api="D3D11+WASAPI",
        res="640x480",
        regime="light",
        local_16t=4.58,   # Phase 112 Extra 4.58x, Hard 4.74x
        local_8t=3.62,
        local_4t=2.20,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="64bit DXLib rgb0",
    ),
    TitleSpec(
        key="th06nc_720",
        title="th06nc 720p (Extra/Lunatic)",
        api="D3D11+WASAPI+BC7",
        res="1280x720",
        regime="dxlib_720",
        local_16t=1.51,   # Phase 112 Extra 1.51x, Lunatic 1.57x
        local_8t=1.28,
        local_4t=0.77,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.2xlarge", 0.5, 0.22, "CPU+BC7 1/2x (Extra落ち7.6%)"),
        notes="CPU+BC7 0%落ち; 従来CPU Extra基準外を解消",
    ),
    TitleSpec(
        key="th06nc_1080",
        title="th06nc 1080p (Extra 60s)",
        api="D3D11+WASAPI+BC7",
        res="1920x1080",
        regime="dxlib_1080",
        local_16t=0.86,   # Phase 112 bench_1080p 60s
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 1.0, 0.08, "GPU 1x"),
        legacy_cpu_fallback=("c7i.4xlarge", 0.5, 0.22, "参考(reports/97 CPU 1/2x 2.5%落ち)"),
        notes="GPUなしで1080p可; m7iは遅く120分上限注意",
    ),
    TitleSpec(
        key="th07",
        title="th07 (Extra/Hard)",
        api="D3D8+DS8",
        res="640x480",
        regime="light",
        local_16t=5.37,   # Phase 111 Extra 5.37x, Hard 5.74x
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 3.0, 0.08, "GPU 3x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="stepDiv=32, AdvVirtual",
    ),
    TitleSpec(
        key="th08",
        title="th08 (Extra/Normal)",
        api="D3D8+DS8",
        res="640x480",
        regime="light",
        local_16t=5.29,   # Phase 111 Extra 5.29x, Normal 5.46x
        local_8t=4.02,
        local_4t=2.14,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="stepDiv=32, AdvVirtual",
    ),
    TitleSpec(
        key="th09",
        title="th09 (Story/Match)",
        api="D3D8+DS8",
        res="640x480",
        regime="light",
        local_16t=4.92,   # Phase 111 Lunatic Story 4.92x, Match 4.57x
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="stepDiv=32, AdvVirtual",
    ),
    TitleSpec(
        key="th10",
        title="th10 (Extra/Lunatic)",
        api="D3D9+DS8",
        res="640x480",
        regime="light",
        local_16t=5.42,   # Phase 110 Extra 5.42x, Lunatic 4.81x
        local_8t=4.23,
        local_4t=2.28,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.xlarge", 1.0, 0.22, "CPU 1x"),
        notes="vpatch_th10 IAT",
    ),
    TitleSpec(
        key="th11",
        title="th11 (Extra/Hard)",
        api="D3D9+DS8",
        res="640x480",
        regime="light",
        local_16t=3.46,   # Phase 110 Extra 3.46x, Hard 3.45x
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.2xlarge", 1.0, 0.22, "CPU 1x (.2xl必須)"),
        notes="4vCPUでもデシンク無で解禁",
    ),
    TitleSpec(
        key="th12",
        title="th12 (Extra/Hard)",
        api="D3D9+DS8",
        res="640x480",
        regime="light",
        local_16t=3.21,   # Phase 108 b2 Extra 3.21x, b3 Hard 3.40x
        local_8t=None,
        local_4t=None,
        aws_actual={
            "c7i.4xlarge": 2.32,  # Extra 2.31x, Hard 2.33x (reports/109)
            "c7i.2xlarge": 1.76,  # Extra 1.76x, Hard 1.76x (reports/109)
            "m7i.xlarge": 1.12,   # Extra 1.13x, Hard 1.10x (reports/109)
            "g6f.xlarge": 1.00,   # Extra/Hard 1.00x (reports/109 write=12ms limit)
        },
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.2xlarge", 1.0, 0.22, "CPU 1x (落ち3%台基準外)"),
        notes="AWS実測アンカー; 4vCPU解禁",
    ),
    TitleSpec(
        key="th128",
        title="th128 (Extra/Hard --thprac)",
        api="D3D9+DS8",
        res="640x480",
        regime="light",
        local_16t=2.78,   # Phase 110 Extra 2.78x, Hard 2.95x
        local_8t=None,
        local_4t=None,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.2xlarge", 1.0, 0.22, "CPU 1x (.2xl必須)"),
        notes="thprac必須; 4vCPU解禁見込",
    ),
    TitleSpec(
        key="th13",
        title="th13 (Extra/Hard)",
        api="D3D9+DS8",
        res="640x480",
        regime="light",
        local_16t=2.91,   # Phase 110 Extra 2.91x (Hard 3.03x)
        local_8t=2.62,
        local_4t=1.45,
        aws_actual={},
        legacy_primary=("c7i.4xlarge", 1.0, 0.22, "CPU 1x (Extra落ち4.3%)"),
        legacy_cpu_fallback=("c7i.2xlarge", 0.5, 0.22, "CPU 1/2x"),
        notes="本番GPU段無; c7i.2xlで高品質+安価",
    ),
    TitleSpec(
        key="th14",
        title="th14 (Extra; Lunaticは+18%高速)",
        api="D3D9+DS8",
        res="1280x960",
        regime="heavy_d3d9",
        local_16t=1.17,   # Phase 110追補 Extra 1.17x (Lunatic 1.38x)
        local_8t=0.92,    # Phase 110追補 Extra 60s 8t (保持率79%)
        local_4t=0.48,    # Phase 110追補 Extra 60s 4t (保持率41%)
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.4xlarge", 0.5, 0.22, "CPU 1/2x (局所14.6〜22.2Hz落)"),
        notes="1280x960 CPU塗りつぶし律速; 現行sattori本番13タイトル外(追補)",
    ),
    TitleSpec(
        key="th15",
        title="th15 (Extra; Hardは+20~30%高速)",
        api="D3D9+DS8",
        res="1280x960",
        regime="heavy_d3d9",
        local_16t=1.14,   # Phase 108 b1 Extra 1.14x (Hard 1.50x in Phase 105)
        local_8t=None,
        local_4t=None,
        aws_actual={
            "c7i.4xlarge": 1.20,  # Extra 1.20x, Hard 1.48x (reports/109)
            "c7i.2xlarge": 0.67,  # Extra 0.67x, Hard 0.80x (reports/109)
            "m7i.xlarge": 0.35,   # Extra 0.35x (reports/109)
            "g6f.xlarge": 1.00,   # Extra/Hard 1.00x (reports/109 write=12.5ms limit)
        },
        legacy_primary=("g6f.2xlarge", 2.0, 0.08, "GPU 2x"),
        legacy_cpu_fallback=("c7i.4xlarge", 1.0 / 3.0, 0.22, "CPU 1/3x (Hard 1/2x)"),
        notes="AWS実測アンカー; Hardは1.48x/0.80x",
    ),
    TitleSpec(
        key="th20",
        title="th20 (Hard --thprac)",
        api="D3D9+DS8",
        res="1280x960",
        regime="heavy_d3d9",
        local_16t=1.29,   # Phase 110 Hard 1.29x
        local_8t=1.10,
        local_4t=0.60,
        aws_actual={},
        legacy_primary=("g6f.2xlarge", 1.0, 0.08, "GPU 1x"),
        legacy_cpu_fallback=("c7i.4xlarge", 0.5, 0.22, "CPU 1/2x"),
        notes="thprac必須; c7i.4xl 1/2xから半減",
    ),
]


def estimate_speed(spec: TitleSpec, inst: str) -> tuple[float, str]:
    """Return (estimated_speed_x, basis_tag) for a title and instance."""
    if inst in spec.aws_actual:
        return spec.aws_actual[inst], "実測"

    # g6f.xlarge capped at 1.00x in Phase 109 due to pipe/sync write=12ms ceiling (60Hz cap).
    if inst == "g6f.xlarge":
        return 1.00, "推定(P109上限)"
    if inst == "g6f.2xlarge":
        # Phase 109 noted g6f.xlarge's write=12ms 60Hz cap was independent of encoder/game load;
        # without an AWS test on 8vCPU GPU, conservatively assume >=1.00x (same cap ceiling).
        return 1.00, "未検証(上限見込)"

    # Derive AWS/local ratio from Phase 109 anchors:
    # - th12 (light 640x480): c7i.4xl/16t = 2.32/3.21 = 0.723 (or 0.702 vs avg),
    #   and vs measured local 8t/4t on th08/th10/th06c/th13:
    #     AWS c7i.2xl / local_8t ~ 0.70..0.75; AWS m7i.xl / local_4t ~ 0.65..0.75
    if spec.regime == "light":
        # Anchor: th12 local 3.21x (Extra w/ audio) -> AWS 2.32 / 1.76 / 1.12
        # For faster titles (5x+), Xvfb/FIFO single-thread latency causes mild diminishing returns,
        # modeled via linear + mild IPC latency floor anchored to th12 (3.21x -> 2.32x on c7i.4xl):
        #   t_frame_aws_16t = t_frame_local_16t * 1.10 + 1.50ms  -> at 3.21x (5.19ms), t_aws=7.21ms (2.31x)
        t_loc = 1000.0 / (60.0 * spec.local_16t)
        est_4xl = (1000.0 / (t_loc * 1.10 + 1.50)) / 60.0
        if inst == "c7i.4xlarge":
            return round(est_4xl, 2), "推定"
        # 8vCPU (c7i.2xlarge): if local_8t measured, use min(local_8t * 0.72, ...) calibrated to th12 (1.76x)
        if spec.local_8t is not None:
            # At th12 (5.19ms), ~0.76 of c7i.4xl; use local 8t retention adjusted by AWS IPC overhead
            t_loc8 = 1000.0 / (60.0 * spec.local_8t)
            est_2xl = (1000.0 / (t_loc8 * 1.18 + 2.00)) / 60.0
        else:
            est_2xl = est_4xl * (1.76 / 2.32)
        if inst == "c7i.2xlarge":
            return round(est_2xl, 2), "推定"
        # 4vCPU: m7i.xlarge anchor th12 = 1.12x (48.3% of c7i.4xl)
        if spec.local_4t is not None:
            t_loc4 = 1000.0 / (60.0 * spec.local_4t)
            est_m7i = (1000.0 / (t_loc4 * 1.15 + 3.20)) / 60.0
        else:
            est_m7i = est_4xl * (1.12 / 2.32)
        if inst == "m7i.xlarge":
            return round(est_m7i, 2), "推定"
        if inst == "c7i.xlarge":
            return round(est_m7i * 1.05, 2), "推定(4vCPU)"
        if inst == "c7i-flex.xlarge":
            return round(est_m7i * 0.90, 2), "推定(Flex)"

    elif spec.regime == "heavy_d3d9":
        # Anchor: th15 Extra (1.14x local -> AWS c7i.4xl 1.20x, c7i.2xl 0.67x, m7i.xl 0.35x)
        # Note Xeon Platinum 8488C AVX-512 llvmpipe matches Ryzen 5700X at 16t;
        # for th20 which has higher game thread share (6.5ms vs 0.75ms), blend slightly conservatively (0.95x local_16t).
        est_4xl = spec.local_16t * 0.95
        if inst == "c7i.4xlarge":
            return round(est_4xl, 2), "推定"
        if spec.local_8t is not None:
            # Anchor: c7i.2xl on th15 is ~0.59x of local 16t; on th20 local 8t is 1.10x (retention 0.85),
            # with virtualization/Xvfb memory bandwidth penalty (~0.75x of local 8t -> 0.83x)
            est_2xl = spec.local_8t * 0.75
        else:
            est_2xl = spec.local_16t * (0.67 / 1.14)
        if inst == "c7i.2xlarge":
            return round(est_2xl, 2), "推定"
        if spec.local_4t is not None:
            est_m7i = spec.local_4t * 0.72  # 0.60 * 0.72 = 0.43x (consistent with th15 0.35x)
        else:
            est_m7i = spec.local_16t * (0.35 / 1.14)
        if inst == "m7i.xlarge":
            return round(est_m7i, 2), "推定"
        if inst == "c7i.xlarge":
            return round(est_m7i * 1.05, 2), "推定(4vCPU)"
        if inst == "c7i-flex.xlarge":
            return round(est_m7i * 0.85, 2), "推定(Flex)"

    elif spec.regime == "dxlib_720":
        # th06nc 720p CPU+BC7: ~60% present_ms + ~22% write_ms + ~10% game_ms
        # Calibrated conservatively from th12 (0.72x at 16t) and reports/96-97 c7i Xeon vs Ryzen (~0.82x):
        est_4xl = spec.local_16t * 0.82   # ~1.24x
        est_2xl = (spec.local_8t or spec.local_16t * 0.85) * 0.78  # ~1.00x
        est_m7i = (spec.local_4t or spec.local_16t * 0.51) * 0.74  # ~0.57x
        if inst == "c7i.4xlarge":
            return round(est_4xl, 2), "推定"
        if inst == "c7i.2xlarge":
            return round(est_2xl, 2), "推定"
        if inst == "m7i.xlarge":
            return round(est_m7i, 2), "推定"
        if inst == "c7i.xlarge":
            return round(est_m7i * 1.05, 2), "推定(4vCPU)"
        if inst == "c7i-flex.xlarge":
            return round(est_m7i * 0.85, 2), "推定(Flex)"

    elif spec.regime == "dxlib_1080":
        # th06nc 1080p CPU+BC7: local 16t = 0.86x (present=11.8ms, write=5.8ms)
        est_4xl = spec.local_16t * 0.82   # ~0.71x
        est_2xl = est_4xl * 0.78          # ~0.55x
        est_m7i = est_4xl * 0.48          # ~0.34x
        if inst == "c7i.4xlarge":
            return round(est_4xl, 2), "推定"
        if inst == "c7i.2xlarge":
            return round(est_2xl, 2), "推定"
        if inst == "m7i.xlarge":
            return round(est_m7i, 2), "推定"
        if inst == "c7i.xlarge":
            return round(est_m7i * 1.05, 2), "推定(4vCPU)"
        if inst == "c7i-flex.xlarge":
            return round(est_m7i * 0.85, 2), "推定(Flex)"

    raise ValueError(f"Unknown inst={inst}, regime={spec.regime}")


def billing_and_cost(
    speed: float,
    conv_ratio: float,
    spot_price: float,
    legacy_mode: bool = False,
) -> tuple[float, float, float]:
    """Return (rec_wall_h_per_1h, billed_h_per_1h, usd_per_1h_replay)."""
    if legacy_mode:
        if speed > 1.0:
            rec_h = 1.05 / speed
        elif speed < 1.0:
            rec_h = 1.03 / speed
        else:
            rec_h = 1.0
    else:
        # Frame-sync includes small menu/load fixed ~15s/0.4h (~1% on 1h), matching reports/109.
        rec_h = 1.0 / speed
    billed_h = OVERHEAD_HOURS + rec_h + conv_ratio
    cost = billed_h * (spot_price + EBS_IPV4_USD_PER_HOUR)
    return rec_h, billed_h, cost


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--markdown", action="store_true", help="Output full Markdown tables")
    args = ap.parse_args()

    insts = [
        "c7i.4xlarge",
        "c7i.2xlarge",
        "c7i.xlarge",
        "c7i-flex.xlarge",
        "m7i.xlarge",
        "g6f.xlarge",
        "g6f.2xlarge",
    ]

    print("=== Anchor Verification vs reports/109 (Spot 2026-11-18) ===")
    for key in ("th12", "th15"):
        spec = next(t for t in TITLES if t.key == key)
        for inst in ("c7i.4xlarge", "c7i.2xlarge", "m7i.xlarge", "g6f.xlarge"):
            spd, tag = estimate_speed(spec, inst)
            conv = CONVERT_RATIOS[spec.res][inst]
            az, spot = SPOT_2026_11_18[inst]
            rec_h, billed_h, cost = billing_and_cost(spd, conv, spot)
            print(
                f"  {key:4s} {inst:12s} ({az}, ${spot:.4f}): "
                f"speed={spd:.2f}x [{tag}] conv={conv:.4f} billed={billed_h:.3f}h cost=${cost:.3f}/h"
            )

    print("\n=== All 14 Titles (15 Rows w/ th06nc 720p & 1080p, incl. th14 addendum) — Estimated EC2 Speed & Cost ===")
    print("Spot snapshot: 2026-11-18 (with 2026-11-08 in brackets)")

    header = (
        "| タイトル | 解像度 | ローカル16t | `c7i.4xlarge` (16vCPU) | `c7i.2xlarge` (8vCPU) "
        "| `c7i.xlarge` (4vCPU) | `c7i-flex.xlarge` (4vCPU) | `m7i.xlarge` (4vCPU) "
        "| `g6f.xlarge` (4v+L4) | `g6f.2xlarge` (8v+L4,未検証上限1x) | 現行本番Primary | 現行本番CPUフォールバック | 最適CPU推奨 (11-18 / 11-08) |"
    )
    sep = "|" + "|".join(["---"] * 13) + "|"
    print(header)
    print(sep)

    for spec in TITLES:
        cells = []
        for inst in insts:  # c7i.4xl .. g6f.2xlarge
            spd, tag = estimate_speed(spec, inst)
            conv = CONVERT_RATIOS[spec.res][inst]
            _, b18, c18 = billing_and_cost(spd, conv, SPOT_2026_11_18[inst][1])
            _, b08, c08 = billing_and_cost(spd, conv, SPOT_2026_11_08[inst][1])
            mark = "★" if tag == "実測" else ("*" if inst == "g6f.2xlarge" else "")
            to_warn = " [120m超]" if (1.0 / spd) > 2.0 else ""
            cells.append(f"{mark}{spd:.2f}x / ${c18:.3f}{to_warn}")

        safe_cands = []
        for inst in ("c7i.4xlarge", "c7i.2xlarge", "m7i.xlarge", "c7i.xlarge"):
            spd, _ = estimate_speed(spec, inst)
            conv = CONVERT_RATIOS[spec.res][inst]
            _, b18, c18 = billing_and_cost(spd, conv, SPOT_2026_11_18[inst][1])
            _, _, c08 = billing_and_cost(spd, conv, SPOT_2026_11_08[inst][1])
            if spd >= 0.90:
                safe_cands.append((c18, inst, spd, c08, b18))
        if not safe_cands:
            for inst in ("c7i.4xlarge", "c7i.2xlarge"):
                spd, _ = estimate_speed(spec, inst)
                conv = CONVERT_RATIOS[spec.res][inst]
                _, b18, c18 = billing_and_cost(spd, conv, SPOT_2026_11_18[inst][1])
                _, _, c08 = billing_and_cost(spd, conv, SPOT_2026_11_08[inst][1])
                safe_cands.append((c18, inst, spd, c08, b18))
        best_cost18, best_inst, best_spd, best_cost08, best_bh = min(safe_cands, key=lambda x: x[0])

        l_inst, l_spd, l_conv, l_note = spec.legacy_primary
        _, l_bh, l_c18 = billing_and_cost(l_spd, l_conv, SPOT_2026_11_18[l_inst][1], legacy_mode=True)
        _, _, l_c08 = billing_and_cost(l_spd, l_conv, SPOT_2026_11_08[l_inst][1], legacy_mode=True)
        leg_p_str = f"{l_inst} {l_note}: ${l_c18:.3f} (${l_c08:.3f})"

        if spec.legacy_cpu_fallback:
            fc_inst, fc_spd, fc_conv, fc_note = spec.legacy_cpu_fallback
            _, fc_bh, fc_c18 = billing_and_cost(fc_spd, fc_conv, SPOT_2026_11_18[fc_inst][1], legacy_mode=True)
            _, _, fc_c08 = billing_and_cost(fc_spd, fc_conv, SPOT_2026_11_08[fc_inst][1], legacy_mode=True)
            leg_c_str = f"{fc_inst} {fc_note}: ${fc_c18:.3f} (${fc_c08:.3f})"
        else:
            leg_c_str = "—"

        rec_str = f"**{best_inst}** ({best_spd:.2f}x, {best_bh*60:.0f}m): **${best_cost18:.3f}** / ${best_cost08:.3f}"
        print(
            f"| `{spec.key}` | {spec.res} | {spec.local_16t:.2f}x | "
            + " | ".join(cells)
            + f" | {leg_p_str} | {leg_c_str} | {rec_str} |"
        )

    print("\n=== Spot Snapshot 2026-11-08 (matching sattori/docs/reports/2026-11-08-...md) ===")
    print("| タイトル | `c7i.4xlarge` ($0.0863) | `c7i.2xlarge` ($0.0421) | `c7i.xlarge` ($0.0488) | `c7i-flex.xlarge` ($0.0292) | `m7i.xlarge` ($0.0265) | `g6f.xlarge` ($0.0665) | `g6f.2xlarge` (*$0.0612) |")
    print("|" + "|".join(["---"] * 8) + "|")
    for spec in TITLES:
        r08 = []
        for inst in insts:
            spd, _ = estimate_speed(spec, inst)
            conv = CONVERT_RATIOS[spec.res][inst]
            _, _, c08 = billing_and_cost(spd, conv, SPOT_2026_11_08[inst][1])
            r08.append(f"{spd:.2f}x / ${c08:.3f}")
        print(f"| `{spec.key}` | " + " | ".join(r08) + " |")


if __name__ == "__main__":
    main()
