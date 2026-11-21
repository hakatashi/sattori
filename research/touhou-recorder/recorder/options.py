"""1回の録画実行に対する指示(CLIフラグ相当)をまとめた`RecordingOptions`。

パイプライン本体はargparseのNamespaceではなくこのdataclassを受け取るので、
スクリプトからライブラリとして呼ぶ場合も同じ型を組み立てればよい:

    from recorder import RecordingOptions, load_game_config, record_with_retry

    config = load_game_config("th10")
    options = RecordingOptions(replay="th10_07.rpy", output="/mnt/cache3/.../video.mp4")
    record_with_retry(config, options)
"""
import os
from dataclasses import dataclass

from .timing import default_max_duplicate_rate


@dataclass
class RecordingOptions:
    replay: str
    output: str

    # --- 映像の加工 ----------------------------------------------------------
    watermark: str | None = None
    watermark_width: int = 285
    upscale_720p: bool = False
    # gpu_encode: 録画キャプチャのエンコードにNVENC(h264_nvenc)を使うか(既定はCPU/libx264)。
    # GPUインスタンスでのCPU負荷削減効果の検証用(reports/84)。ゲーム描画のGPU利用
    # (GameConfig.gpu_display)とは独立したオプション。
    gpu_encode: bool = False

    # --- 音声の取り込み方 -----------------------------------------------------
    # no_audio: 音声を録音しない(pulse依存を排したAWSデバッグ用)
    no_audio: bool = False
    # muxed_audio: 映像と音声を1つのffmpegプロセスで同時取り込みする旧来方式。
    # AWS環境ではth08の重複フレーム率が85%超に悪化するため非推奨(reports/26)。
    muxed_audio: bool = False

    # --- リトライ・品質判定 ---------------------------------------------------
    # frame_sync: フレーム同期キャプチャ(reports/104・105)。ゲームの1フレームごとにMODが
    # バックバッファをFIFOへ書き、書き終わりしだい次のフレームへ進める(可変速)。
    # x11grabは使わない。音声はMOD内の仮想音声デバイスが書く(reports/107、no_audioで無効)。
    frame_sync: bool = False

    max_attempts: int = 3
    max_duplicate_rate: float | None = None  # 未指定なら低速録画スケール込みの既定値
    thprac: bool = False

    # --- 検証用の打ち切りモード -----------------------------------------------
    # quick_classify_sec: この秒数だけ異常が出なければ「正常」と判定して打ち切る
    quick_classify_sec: float | None = None
    # record_seconds: 指定秒数だけ連続録画して停止し、重複フレーム率を測る(リトライしない)
    record_seconds: float | None = None
    # stats_runs: 同じ条件で繰り返し録画して成功率を集計する
    stats_runs: int | None = None

    def __post_init__(self):
        if self.max_duplicate_rate is None:
            self.max_duplicate_rate = default_max_duplicate_rate()

    # --- 派生値 ---------------------------------------------------------------
    @property
    def separate_audio(self):
        """映像と音声を別プロセスで録画して後でmuxするか(既定、reports/26)。"""
        return (not self.no_audio) and (not self.muxed_audio)

    @property
    def inline_audio(self):
        """映像ffmpegに音声入力を相乗りさせるか(旧来方式、`--muxed-audio`指定時のみ)。"""
        return (not self.no_audio) and (not self.separate_audio)

    @property
    def video_target(self):
        """映像ffmpegの出力先。音声分離時のみ最終出力とは別ファイルになる。"""
        if not self.separate_audio:
            return self.output
        base, _ext = os.path.splitext(self.output)
        return f"{base}.video.mp4"

    @property
    def audio_target(self):
        base, _ext = os.path.splitext(self.output)
        from .timing import AUDIO_CAPTURE_RATE_HZ, NATIVE_AUDIO_RATE_HZ
        if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
            # 倍速録画(issue #1)用の高レート(88200/96000Hz等)キャプチャでは、
            # AACエンコーダが-copytsのstart_timeを0にリセットしてしまう不具合が
            # あるため(reports/85)、この段階ではPCM(mov、pcm_s16le)のまま録音する。
            # wav(RIFF)はコンテナ自体がstart_timeメタデータを持てずA/V同期補正が
            # スキップされてしまうため不可、movなら-copytsの絶対時刻を保持できる
            # ことを確認済み。AACへの変換はmux_audio_video()側で行う。
            return f"{base}.audio.mov"
        return f"{base}.audio.m4a"

    @property
    def poll_raw_path(self):
        """終了検知用サブ出力(`GameConfig.poll_side_stream`使用時のみ)の置き場所。"""
        return f"{os.path.splitext(self.output)[0]}.pollraw"

    @property
    def output_dir(self):
        return os.path.dirname(self.output)
