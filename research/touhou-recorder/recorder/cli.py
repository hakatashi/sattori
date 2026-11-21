"""検証用録画コマンドのCLI。

`scripts/25_record_replay_e2e_multigame.py`はこのモジュールの`main()`を呼ぶだけの
薄いシムになっており、コマンドラインの互換性(フラグ名・既定値・終了コード)は
フェーズ25以降のレポートに載っているものをそのまま維持している。
"""
import argparse
import dataclasses
import os
import sys

from .config import REPO
from .games import game_ids, load_game_config
from .options import RecordingOptions
from .runner import record_fixed_seconds, record_with_retry, run_stats
from .timing import default_max_duplicate_rate


def build_parser():
    parser = argparse.ArgumentParser(
        description="東方作品のリプレイをヘッドレス環境で自動再生・録画する検証用パイプライン")
    parser.add_argument("--game", choices=game_ids(), required=True, help="録画対象タイトル")
    parser.add_argument("--replay", default=None, help="未指定ならゲームごとの既定リプレイを使う")
    parser.add_argument("--output", default=None,
                        help="出力先の動画パス(未指定なら runs/<game>_multigame/video.mp4)")
    parser.add_argument("--watermark", default=None)
    parser.add_argument("--watermark-width", type=int, default=285)
    parser.add_argument("--upscale-720p", action="store_true")
    parser.add_argument("--gpu-encode", action="store_true",
                        help="録画キャプチャのエンコードにNVENC(h264_nvenc)を使う"
                             "(GPUインスタンスでのCPU負荷削減効果の検証用、reports/84)")
    parser.add_argument("--no-audio", action="store_true",
                        help="音声を録音しない(pulse依存を排したAWSデバッグ用。"
                             "重複フレーム率は映像のみで計測)")
    parser.add_argument("--muxed-audio", action="store_true",
                        help="映像と音声を1つのffmpegプロセスで同時取り込みする旧来方式。"
                             "AWS環境ではth08の重複フレーム率が85%%超に悪化するため非推奨"
                             "(既定は映像・音声を別プロセスで録画して後muxする方式、reports/26参照)")
    parser.add_argument("--frame-sync", action="store_true",
                        help="フレーム同期キャプチャ(可変速・非リアルタイム録画)。MODが1フレーム"
                             "ごとにバックバッファをFIFOへ書き、描画とエンコードを律速にして"
                             "進める。音声はMOD内の仮想音声デバイスで録音(--no-audioで無効)。"
                             "MODが対応しているタイトルのみ(reports/105・107)")
    parser.add_argument("--max-attempts", type=int, default=3)
    # 低速録画(FPS_LIMIT_TARGET_HZ<60)は意図的な重複フレームが発生するため、既定値を
    # スケールする(recorder/timing.py の default_max_duplicate_rate()、reports/82参照)。
    parser.add_argument("--max-duplicate-rate", type=float, default=default_max_duplicate_rate())
    parser.add_argument("--quick-classify-sec", type=float, default=None)
    parser.add_argument("--record-seconds", type=float, default=None,
                        help="検証高速化用。リプレイ再生開始からこの秒数だけ録画して停止し、"
                             "録画全体の重複フレーム率を計測して終了する(リトライしない)")
    parser.add_argument("--stats-runs", type=int, default=None)
    parser.add_argument("--cpu-display", action="store_true",
                        help="GameConfig.gpu_display=Trueのタイトル(th15/th06nc)でも"
                             "GPU描画面ではなくXvfb(CPU描画、llvmpipe)を使う。"
                             "GPUを持たない/使いたくないローカル環境で音声まわり等を"
                             "検証するための逃げ道(reports/86)")
    parser.add_argument("--gpu-display", action="store_true",
                        help="GameConfig.gpu_display=Falseのタイトルでも、Xvfbではなく"
                             "GPU描画面(Xorg+NVIDIA等)で描画・録画する。GPUインスタンスでの"
                             "倍速録画検証用(reports/89)")
    parser.add_argument("--crtc-mode", default=None,
                        help="--gpu-display時のCRTCモード(例: 1280x960)。未指定ならタイトル設定")
    parser.add_argument("--capture-window-id", action="store_true",
                        help="--gpu-display時、x11grabを座標ではなくウィンドウIDで取り込む"
                             "(録画中にゲームがウィンドウ位置を変えるth08等向け、reports/89)")
    parser.add_argument("--thprac", action="store_true",
                        help="ゲーム起動直後にthprac(thprac_exeを設定したタイトルのみ)を"
                             "アタッチする。th20のリプレイずれ(デシンク)対策、reports/50参照")
    return parser


def build_options(args, config):
    """argparseの結果を`RecordingOptions`へ落とす(既定値の解決もここで行う)。"""
    return RecordingOptions(
        replay=args.replay if args.replay is not None else config.default_replay,
        output=(args.output if args.output is not None
                else f"{REPO}/runs/{config.game_id}_multigame/video.mp4"),
        watermark=args.watermark,
        watermark_width=args.watermark_width,
        upscale_720p=args.upscale_720p,
        gpu_encode=args.gpu_encode,
        no_audio=args.no_audio,
        muxed_audio=args.muxed_audio,
        frame_sync=args.frame_sync,
        max_attempts=args.max_attempts,
        max_duplicate_rate=args.max_duplicate_rate,
        quick_classify_sec=args.quick_classify_sec,
        record_seconds=args.record_seconds,
        stats_runs=args.stats_runs,
        thprac=args.thprac,
    )


def main(argv=None):
    args = build_parser().parse_args(argv)
    config = load_game_config(args.game)
    if args.cpu_display:
        config = dataclasses.replace(config, gpu_display=False, crtc_mode=None)
    elif args.gpu_display:
        # GPU描画面では終了検知ポーリングの個別x11grabが本録画を周期的に妨害する
        # (reports/81・85、th10の2倍速で周期2.26秒のカクつきを再確認、reports/89)ため、
        # th15/th06ncと同じくサブストリーム方式を必ず使う。
        config = dataclasses.replace(config, gpu_display=True, poll_side_stream=True,
                                     capture_by_window_id=args.capture_window_id,
                                     crtc_mode=args.crtc_mode or config.crtc_mode)
    options = build_options(args, config)

    os.makedirs(options.output_dir, exist_ok=True)

    if options.stats_runs is not None:
        ok = run_stats(config, options)
    elif options.record_seconds is not None:
        ok = record_fixed_seconds(config, options)
    else:
        ok = record_with_retry(config, options)

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
