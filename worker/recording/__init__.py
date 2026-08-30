"""全タイトル共通の録画パイプライン(Sattori ワーカー)。

タイトル固有の差分(実行ファイル名・MOD DLL 名・WINEPREFIX 等)は `GameConfig` に
まとめ、Xvfb 起動・ウィンドウ検出・録画・終了検知・リトライといった手続き自体は
本パッケージに集約する(`record_thNN.py` はどれも `GameConfig` を組み立てて
`recording.cli.run()` へ渡すだけの薄いシムになる)。

モジュール構成(責務ごとに分割してある、Issue #201):

  config     GameConfig とその既定値の導出
  timing     低速録画(Issue #68)の実時間スケーリング
  instance   Xvfb・instance ディレクトリ・注入コマンドの準備
  process    ゲームプロセスの探索・thprac のアタッチ・Wine の後片付け
  window     ウィンドウ検出とクロップ座標の確定
  modlog     MOD が書き出すログの読み取り(マーカー待ち・fps暴走・スコア照合)
  vision     画面キャプチャと画素比較
  ffmpeg     録画・結合・重複フレーム率計測の ffmpeg 呼び出し
  artifacts  別プロセスへファイル経由で渡す成果物の書き出し
  pipeline   1回の録画試行と自動リトライ
  cli        record_thNN.py が共有する CLI

Issue #13(th08 対応)に伴う touhou-recorder での検証(reports/22〜26)で、
th07 では問題にならなかった以下2種の異常が th08 で高い確率(ver1.00a 時点で
th8_06.rpy は成功率20%)で発生することが分かった:

  - fps暴走: リプレイ再生中に内部fpsが数百〜数千に跳ね上がり、リプレイが
    実時間の数十分の一で終わってしまう(reports/22)。公式アップデータ
    ver1.00d への更新で事実上解消したが(reports/23)、稀な残存ケースへの
    備えとして検知ロジック自体は残す。
  - 処理落ち: 録画開始直後の外乱でx11grabのフレームタイミングが崩れ、
    以降ずっと重複フレームで埋まる(reports/12・13由来、th08でも発生を確認)。

これらの検知・自動リトライは th08 固有の対策として作られたものだが、
処理落ち自体は th07 の開発初期(reports/12・13)にも観測された現象であり、
リトライという保険自体を両タイトル共通の仕組みにしておいて損はないため、
本モジュールでは th07 に対しても同じ検知・リトライ経路を適用する
(th07 の MOD は FpsMonitor を組み込んでいないため、fps暴走判定は実質的に
発火しない)。既定のリトライ回数は3回(ユーザー判断。th08固有の不安定性は
ver1.00d更新+音声分離修正でおおむね解消された前提のため、旧検証時に推奨されて
いた8〜15回のような大きな値は採用しない)。

もう一つの th08 固有の発見(reports/26)は、x11grab(映像)とpulse(音声)を
1つのffmpegプロセスで同時に取り込むと、単一ffmpeg内部のA/V同期がth08の描画
タイミングを律速し、AWS環境で重複フレーム率が85%超まで悪化するというもの。
th07はこの問題の影響を受けない(4.7%で正常)ことも確認済みだが、これも
「安全側に倒すなら両タイトルとも音声分離が望ましい」(reports/26)との
記載に従い、本モジュールでは両タイトルとも既定で映像・音声を別プロセスで
録画し、停止後に `-c copy -shortest` で結合する方式のみを実装する。

映像・音声を別プロセスで録画する副作用として、両プロセスの起動から実際に
キャプチャを開始するまでの初期化レイテンシが異なり(pulseの方がx11grabより
数百ms〜1秒超遅い)、素朴に結合すると音声が映像より数百ms先行して聴こえる
音ズレが生じることが判明した(th08実機で約700ms、touhou-recorder reports/28)。
build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd で両ffmpegに`-copyts`を付与して
実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
start_timeとして保持し、mux_audio_video()がその差分を実測して遅く始まった側に
`-itsoffset`を与えることで補正する(ハードコードされた定数ではなく毎回実測)。

音声の入出力先はジョブごとに作る専用のPulseAudio null-sink(`GameConfig.pulse_sink`)に
固定する。以前は全ジョブがデフォルトsink(`auto_null`)を暗黙に共有しており、同一ホストで
並列録画すると全ジョブの音声が混ざって記録されていた(Issue #48、reports/41)。sink自体の
作成・破棄は record_with_retry() が pulse.job_sink() で行い、Wine側の出力先は
GameConfig.build_env() が渡す`PULSE_SINK`で固定する。
"""
from .cli import log_with_prefix, run
from .config import GameConfig
from .pipeline import record_with_retry
from .timing import slow_motion_scale

__all__ = ["GameConfig", "log_with_prefix", "record_with_retry", "run", "slow_motion_scale"]
