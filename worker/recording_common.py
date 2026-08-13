"""th07/th08 共通の録画パイプライン処理(Sattori ワーカー)。

タイトル固有の差分(実行ファイル名・MOD DLL 名・WINEPREFIX 等)は `GameConfig` に
まとめ、Xvfb 起動・ウィンドウ検出・録画・終了検知・リトライといった手続き自体は
本モジュールに集約する(`record_th07.py` / `record_th08.py` はどちらも `GameConfig`
を組み立てて `record_with_retry()` を呼ぶだけの薄いラッパーになる)。

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
import getpass
import io
import json
import math
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

import pulse

# 既定のXvfb画面サイズ(640x480ウィンドウ+ウィンドウ装飾分の余白)。th20は内部描画解像度が
# 960p相当(1280x960ウィンドウ)へ上がっており収まらないため、GameConfig.xvfb_screenで
# タイトルごとに上書きできる(touhou-recorder reports/44)。
XVFB_SCREEN = "800x600x24"

# ---------------------------------------------------------------------------
# 低速録画(Issue #68)
# ---------------------------------------------------------------------------
# 起動側(apps/api/src/workerEnv.ts)が`FPS_LIMIT_TARGET_HZ`を渡してきた場合、MOD
# (mods/common/fps_limiter_hook.cpp)がIDirect3DDevice9::Presentをその周波数へ
# スロットルする。th20はレンダリングfpsとゲームロジック更新が直結しているため、
# これはゲーム進行そのもののスローモーション化になる(touhou-recorder reports/47)。
# 実時間あたりのCPU負荷が下がり、等倍では処理落ちしていた高負荷区間(最低19.8fps)が
# 安定して目標fpsを維持できるようになる。
#
# **ワーカーは「自分がEC2にいるのか自宅にいるのか」を知らない**。低速録画かどうかは
# この環境変数の有無だけで決まり、未設定なら従来どおり等倍で動く(全タイトル共通)。
#
# ここで得られるスケール係数は「実時間がゲーム内時間の何倍になるか」で、等倍なら1.0、
# 30Hz指定なら2.0。**MOD内部の待機(dllmain.cppのScaledSleep)だけでなく、それを監視する
# こちら側のタイムアウト・猶予時間も同じ比率で伸ばさないと低速録画は成立しない**
# (reports/47で、スケール未適用のPOST_START_GRACE_SECのままステージ開始の導入演出中に
# 処理落ち検知が走り、3回とも誤リトライする事象が実際に発生した)。
NATIVE_FRAME_RATE_HZ = 60.0


def slow_motion_scale(env=None):
    """`FPS_LIMIT_TARGET_HZ`から実時間のスケール係数を求める(等倍なら1.0)。

    未設定・数値でない・0以下・60超のいずれも1.0へ丸める(高速化方向には使わない。
    このスケールはあくまで「ゲームを遅くしたぶん、監視側の時間も伸ばす」ためのもので、
    1.0未満にするとタイムアウトが本来より短くなって誤検知を招くだけ)。
    """
    raw = (env if env is not None else os.environ).get("FPS_LIMIT_TARGET_HZ")
    if not raw:
        return 1.0
    try:
        target_hz = float(raw)
    except ValueError:
        return 1.0
    if target_hz <= 0 or target_hz >= NATIVE_FRAME_RATE_HZ:
        return 1.0
    return NATIVE_FRAME_RATE_HZ / target_hz


def scaled_poll_count(base_count, time_scale):
    """実時間の長さをポーリング回数で表した定数を、低速録画のスケールに合わせて伸ばす。

    ポーリングは実時間駆動(`POLL_INTERVAL_SEC`)なので、`n回連続`という条件は
    `n * POLL_INTERVAL_SEC` **実時間秒**を意味する。低速録画ではその間にゲームが
    半分しか進まないため、回数を据え置くと条件がゲーム内時間で 1/time_scale に
    縮んでしまう。切り上げるのは、条件を本来より緩める方向へ丸めないため。
    """
    return math.ceil(base_count * time_scale)

# 終了検知(画面静止判定)の閾値・待機。PoC(touhou-recorder reports/13・14)の
# 実測に基づく。変更する場合は当該レポートの根拠を必ず確認すること。
STILL_MAD_THRESHOLD = 2.0
# 連続回数はいずれも「等倍録画での秒数」をポーリング回数で表したもの。低速録画では
# attempt_recording() が time_scale 倍して使う(ポーリング間隔は実時間駆動なので、
# 回数を据え置くとゲーム内時間で必要な静止の長さが縮んでしまう)。
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒(等倍録画時)
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 60 * 60

# thpracのアタッチ(attach_thprac()、th20のみ。reports/50)の待ち時間。実測では
# 引数なしの`--attach`は約1秒で正常終了する。低速録画でも伸ばす必要はない
# (アタッチはゲーム内時間に依存しない一回限りの外部プロセス実行のため)。
# ここで待ちきれなくてもthprac無しで録画を続行するだけなので、短めに切ってよい。
THPRAC_ATTACH_TIMEOUT_SEC = 60.0

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
# (`worker/README.md`参照。ゲーム本体等と同様リポジトリには含めずdocker build前に配置する)。
# 未整備・未検出のゲームは警告ログを出しつつ従来の画面静止のみ判定にフォールバックする。
END_TEMPLATE_ROWS = 40  # 160x120にダウンサンプルした座標系での上部の帯(タイトル文言+列見出し
                        # 行を含む。リプレイ内容(一覧の中身・プレイヤー名/日付)には依存しない
                        # 領域であることをreports/34でクロスリプレイ実証済み)
END_TEMPLATE_MAD_THRESHOLD = 15.0  # 実測: テンプレート自己一致は0.0〜0.32、無関係な画面
                                   # (ステージクリア画面・ゲームプレイ中・タイトル等)とは
                                   # 40〜140超と大きなマージンがある(reports/33・34)
END_TEMPLATE_CONSECUTIVE_REQUIRED = 2  # 2 * POLL_INTERVAL_SEC = 4秒(等倍録画時。上記の通り
                                       # 低速録画では time_scale 倍される)。動画圧縮ノイズ等に
                                       # よる単発の偶然一致を弾くため連続一致を要求する(reports/34)

# 進捗スクリーンショットの書き出し間隔。POLL_INTERVAL_SEC(2秒)毎に取得している
# フレームのうち5回に1回だけ保存する(=約10秒毎)。既存のMAD差分検知用のffmpeg
# キャプチャを流用するため、追加のffmpeg呼び出しは発生しない。
PROGRESS_SNAPSHOT_EVERY_N_POLLS = 5

# 処理落ち(reports/12・13・22)の早期検知。通常ポーリング(2秒間隔)では処理落ち中
# でも2秒あれば別のフレームを捉えてしまい見逃すため、0.15秒間隔の短時間サンプリング
# で判定する。処理落ちは実測ではすべて録画開始25秒以内に発生していたため、早期
# 打ち切り判定は録画開始5分以内に限定する(それ以降の高い重複率はリプレイが正常に
# 終了して結果画面(静止画面)に達したケースと区別がつかないため、reports/22)。
STUTTER_PROBE_SAMPLES = 10
STUTTER_PROBE_INTERVAL_SEC = 0.15
STUTTER_PROBE_PERIOD_SEC = 60.0
STUTTER_DUP_FRACTION_THRESHOLD = 0.7
STUTTER_PROBE_ACTIVE_UNTIL_SEC = 300.0

# mods/common/fps_monitor.cpp が5秒ごとにログ出力する
# "FpsMonitor: N GetDeviceState calls in M ms (H.H Hz)" 行からHz値を読み取る。
# 正常時は55〜65Hz程度(垂直同期相当)で安定するが、fps暴走時は実測で479〜2700Hzに
# 達する(reports/22)。単発のノイズ(実測最大118Hz、直後に正常値へ復帰、reports/23)
# を誤検知しないよう、閾値超過が2回連続(出力間隔5秒×2=約10秒間持続)した場合のみ
# 異常とみなす。th07のMODはFpsMonitorを組み込んでいないため、このチェックは
# th07では実質的に発火しない(ログに"FpsMonitor:"行が現れないため常にNoneを返す)。
#
# 会話イベント(ダイアログボックス表示中)は、実際のレンダリングfpsは60のまま
# GetDeviceStateのポーリング頻度だけが一時的に約3倍(実測179.9Hz、通常60Hzの
# ちょうど3倍)に上がる仕様であることが本番ジョブ64367b3c-64f5-47c4-be9d-
# e0c4aa8a35d8の調査で判明した(旧閾値100Hzだとこれだけで誤って異常判定していた)。
# この一時的な上昇は2回連続の判定窓(約10秒)以内に収まり、直後に60Hz程度へ復帰する。
# 閾値はこの良性の上昇(実測上限179.9Hz)を確実に超えつつ、本物のfps暴走(実測下限
# 479Hz)は引き続き検知できるよう、両者の中間である300Hzとする。
FPS_MONITOR_HZ_RE = re.compile(r"FpsMonitor:.*\(([\d.]+) Hz\)")
FPS_RUNAWAY_HZ_THRESHOLD = 300.0
FPS_RUNAWAY_CONSECUTIVE_REQUIRED = 2

# ウィンドウ座標(x11grabのクロップ座標)を確定させる際の安定判定。wait_for_stable_geometry()
# がこの間隔でfind_window()を繰り返し、2回連続で同じ座標が返るまで待つ。
GEOMETRY_SETTLE_SEC = 0.3
GEOMETRY_SETTLE_TIMEOUT_SEC = 10.0
# windowmove後の再確認に使う短いタイムアウト(最大20回リトライするため、1回あたりは短くする)。
GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC = 3.0

MAX_ATTEMPTS_DEFAULT = 3
MAX_DUPLICATE_RATE_DEFAULT = 30.0


@dataclass(frozen=True)
class GameConfig:
    """タイトルごとに異なる値をまとめたもの(record_th07.py / record_th08.py が組み立てる)。"""

    game_id: str  # "th06"〜"th20"(ログメッセージ・自動再生ログのファイル名接頭辞に使う)
    display: str  # Xvfb のディスプレイ番号(例 ":97")。同一ホストでの多重起動を避けるため
    wineprefix: str
    instance_dir: str
    game_dir_src: str
    canonical_slot: str  # アップロードされた任意ファイル名リプレイを配置する正規スロット名
    injector_path: str
    hook_dll_path: str
    # このジョブ専用のPulseAudio null-sink名(Issue #48)。タイトルではなくジョブごとに
    # 一意であるべき値なので、GameConfigの既定値ではなく実行時に注入する
    # (record_th*.pyの`--pulse-sink`引数、entrypoint.pyがjobIdから採番して渡す)。
    # 名前はpulse.sink_name_for_job()で正規化済みのものを渡すこと。
    pulse_sink: str
    # 実行ファイル名。未指定(None)ならf"{game_id}.exe"を使う(th07/th08)。
    # th06はVsyncPatch(vpatch_th06.dll)が対象プロセスの実行ファイル名を検証している
    # らしく、`th06.exe`へリネームすると白画面ハング(reports/30)が再発することを
    # 実機検証で確認した(WaitForStableWindowが`stable`に到達せずCPU使用率100%で
    # 張り付き続ける)。そのためth06は元のファイル名`東方紅魔郷.exe`をそのまま
    # game_exeに指定する。
    game_exe: str | None = None
    # pgrep/pkillでのプロセス検索に使う名前。未指定ならgame_exeを使う。
    # Linuxの`/proc/PID/comm`は15バイトで切り詰められるため、UTF-8で18バイトの
    # `東方紅魔郷.exe`は末尾の`.exe`が欠落した`東方紅魔郷`(15バイトちょうど)という
    # 値になり、`pgrep -x "東方紅魔郷.exe"`は一致しない(touhou-recorder reports/31)。
    # th06はこのフィールドに`"東方紅魔郷"`(拡張子なし)を指定する。
    process_name: str | None = None
    hook_dll: str = field(init=False)
    log_path: str = field(init=False)
    # 録音側ffmpegの入力(pulse_sinkのmonitor)。pulse_sinkから導出する。
    pulse_source: str = field(init=False)
    injector: str = "injector.exe"
    # フックDLLより前に注入する追加DLL(ファイル名のみ、game_dir_src配下に同梱されており
    # prepare_instance()のrsyncで自動的にinstance_dirへコピーされる想定)。
    # th06はwined3dの白画面ハング回避に必須のVsyncPatch(vpatch_th06.dll、
    # touhou-recorder reports/30・31参照)をここで指定する。th07/th08は空タプルのまま
    # (injector.exeは複数DLL指定に対応済みだが1個のみの従来通りの呼び出しになる)。
    extra_dlls: tuple[str, ...] = ()
    # 終了検知用のリプレイ選択画面テンプレート画像のパス。未指定(None)ならこのモジュール
    # (recording_common.py)と同じディレクトリ配下の`assets/replay_end_templates/{game_id}.png`
    # を既定値として使う(record_th06.py等の呼び出し側での明示指定は不要)。ファイルが
    # 存在しない場合はload_end_template()がNoneを返し、画面静止のみ判定にフォールバックする。
    end_template_path: str | None = None
    # 画面静止判定(テンプレート未整備のゲームが使うフォールバック経路)のMAD計算から
    # 除外する矩形(元のウィンドウ座標系、x0, y0, x1, y1)。th11のPause Menu画面は
    # 全体が完全に静止する一方、現在選択中のメニュー項目の文字だけが明滅し続け、
    # 画面全体のMADが閾値をわずかに超え続けて自然終了を検知できない事例が実機で
    # 発生した(touhou-recorder reports/37・38)。この矩形をMAD計算から除外することで
    # 明滅の影響を受けずに静止判定できる。未指定(None)なら従来通り除外なしで計算する。
    # **矩形のリストも受け付ける**(th20はリプレイ終了後も2箇所で背景アニメーションが
    # 継続するため、touhou-recorder reports/45)。
    still_detect_exclude_rect: (
        tuple[int, int, int, int] | list[tuple[int, int, int, int]] | None
    ) = None
    # Xvfbの画面サイズ("WxHx24")。未指定なら全タイトル共通の XVFB_SCREEN(800x600x24)。
    # th20は1280x960ウィンドウで起動するため個別指定が要る(reports/44)。
    xvfb_screen: str | None = None
    # th125以降のエンジン(th20を含む)は、cfg とリプレイをゲーム本体ディレクトリでは
    # なく WINEPREFIX 内の `%APPDATA%/ShanghaiAlice/{title}/` から読み込む
    # (touhou-recorder reports/44)。True にすると prepare_instance() が
    # `resolve_appdata_dir()` の指す場所にも cfg とリプレイを配置する。
    uses_appdata_profile: bool = False
    # `%APPDATA%` へ配置する必要のある cfg のファイル名(uses_appdata_profile が
    # True のときのみ意味を持つ)。未指定なら f"{game_id}.cfg"。
    cfg_filename: str | None = None
    # ゲーム起動直後にアタッチする thprac(https://github.com/touhouworldcup/thprac)の
    # 実行ファイル名。game_dir_src 配下に同梱されている前提で、prepare_instance() の
    # rsync が instance_dir へコピーする。None(既定)ならアタッチしない。
    # th20 はデシンク(リプレイずれ)が頻発するが、その主因は thprac が常時修正して
    # いる ZUN 側のバグ(未初期化 AnmVM の残骸漏れ・宝珠の use-after-free 等)であり、
    # thprac を噛ませるだけで実測4本すべてのずれが解消した(reports/50)。
    thprac_exe: str | None = None

    def __post_init__(self):
        if self.game_exe is None:
            object.__setattr__(self, "game_exe", f"{self.game_id}.exe")
        if self.process_name is None:
            object.__setattr__(self, "process_name", self.game_exe)
        object.__setattr__(self, "hook_dll", f"{self.game_id}_hook.dll")
        object.__setattr__(self, "log_path", f"{self.instance_dir}/{self.game_id}_autoplay.log")
        object.__setattr__(self, "pulse_source", f"{self.pulse_sink}.monitor")
        if self.xvfb_screen is None:
            object.__setattr__(self, "xvfb_screen", XVFB_SCREEN)
        if self.cfg_filename is None:
            object.__setattr__(self, "cfg_filename", f"{self.game_id}.cfg")
        if self.end_template_path is None:
            module_dir = os.path.dirname(os.path.abspath(__file__))
            object.__setattr__(
                self, "end_template_path",
                f"{module_dir}/assets/replay_end_templates/{self.game_id}.png",
            )

    def build_env(self):
        env = os.environ.copy()
        env["WINEPREFIX"] = self.wineprefix
        env["DISPLAY"] = self.display
        # 日本語ロケールを明示しないと動的描画の日本語が文字化けする(reports/13)。
        env["LANG"] = "ja_JP.UTF-8"
        env["LC_ALL"] = "ja_JP.UTF-8"
        # Wineの音声出力先をこのジョブ専用sinkへ固定する(Issue #48、reports/41)。
        # 無指定だとPulseAudioのデフォルトsinkへ流れ、同一ホストの並列録画で音声が
        # 混ざる。WINEPREFIXのレジストリ(winepulse.drvのdevices)は「PulseAudioを使う」
        # という指定でしかなく接続先sinkを固定しないため、Wine側の変更ではなく
        # この環境変数で制御する。
        env["PULSE_SINK"] = self.pulse_sink
        return env


def log_with_prefix(prefix, msg):
    print(f"[{prefix} {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def ensure_xvfb(config, env, log=print):
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"Xvfb {config.display} は起動済みとみなして再利用します")
        return
    log(f"Xvfb {config.display} を起動します (screen={config.xvfb_screen})")
    subprocess.Popen(
        ["Xvfb", config.display, "-screen", "0", config.xvfb_screen],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)


def resolve_appdata_dir(config):
    """th125以降のエンジン(th20)がcfg/リプレイを読む`%APPDATA%/ShanghaiAlice/{title}/`の
    実体パスを、**実行中のUNIXユーザーから**組み立てる。

    Wineはユーザープロファイルを`drive_c/users/<UNIXユーザー名>`にマッピングし、
    プレフィックスに無ければ起動時にそのユーザーぶんを新規作成する。したがって
    タイトル資産アーカイブに入っている`users/hakatashi/...`(アーカイブを作った開発機の
    ユーザー名)を決め打ちにすると、rootで動く本番コンテナは空の`users/root/`を
    参照してcfgを見つけられず、初回起動時の解像度選択ダイアログで止まる
    (touhou-recorder reports/46 のバグ1と同じ症状。あちらはコンテナのユーザー名を
    `hakatashi`へ改名して回避したが、こちらは**ユーザー名に依存しない**方を採る——
    ワーカーイメージの実行ユーザーと、資産アーカイブを作った開発機のユーザー名を
    一致させ続ける運用上の約束を増やしたくないため)。
    """
    return (
        f"{config.wineprefix}/drive_c/users/{getpass.getuser()}"
        f"/AppData/Roaming/ShanghaiAlice/{config.game_id}"
    )


def prepare_instance(config, replay_path, log=print):
    """ゲーム一式を instance ディレクトリへ複製し、録画対象リプレイだけを
    正規スロット名で replay/ 配下に配置する。extra_dlls(th06のvpatch_th06.dll等)は
    game_dir_src配下に同梱されている前提のため、以下のrsyncで自動的にコピーされる
    (個別のcpは不要)。

    `uses_appdata_profile`(th20)のタイトルは、ゲームが実際に読むのは instance
    ディレクトリではなく WINEPREFIX 側の `%APPDATA%` なので、cfg とリプレイを
    そちらにも配置する。instance 側への配置も残しておく——他タイトルと処理を
    共通化できるうえ、ゲームに読まれないだけで害が無いため。"""
    subprocess.run(
        ["rsync", "-a", "--exclude=replay", f"{config.game_dir_src}/", f"{config.instance_dir}/"],
        check=True,
    )
    replay_dir = f"{config.instance_dir}/replay"
    os.makedirs(replay_dir, exist_ok=True)
    for f in os.listdir(replay_dir):
        os.remove(f"{replay_dir}/{f}")
    subprocess.run(["cp", replay_path, f"{replay_dir}/{config.canonical_slot}"], check=True)
    subprocess.run(["cp", config.injector_path, config.instance_dir], check=True)
    subprocess.run(["cp", config.hook_dll_path, config.instance_dir], check=True)
    if config.uses_appdata_profile:
        appdata_dir = resolve_appdata_dir(config)
        appdata_replay_dir = f"{appdata_dir}/replay"
        os.makedirs(appdata_replay_dir, exist_ok=True)
        # 前回の録画で置いたリプレイが残っていると、ユーザーリプレイ一覧の1件目が
        # 今回の対象とは限らなくなる(MODは常に1件目を選ぶ)。必ず空にしてから置く。
        for f in os.listdir(appdata_replay_dir):
            os.remove(f"{appdata_replay_dir}/{f}")
        subprocess.run(
            ["cp", replay_path, f"{appdata_replay_dir}/{config.canonical_slot}"], check=True
        )
        cfg_src = f"{config.game_dir_src}/{config.cfg_filename}"
        if os.path.exists(cfg_src):
            subprocess.run(["cp", cfg_src, f"{appdata_dir}/{config.cfg_filename}"], check=True)
        else:
            # cfgが無いと初回起動時の解像度選択ダイアログが出てウィンドウ検出に失敗する。
            # 資産アーカイブの作り忘れをここで診断できるようにしておく(reports/44)。
            log(f"WARNING: {cfg_src} が見つかりません。初回起動ダイアログで停止する可能性があります")
        log(f"%APPDATA%配下にもcfg/リプレイを配置しました ({appdata_dir})")
    if os.path.exists(config.log_path):
        os.remove(config.log_path)
    log(f"instance 準備完了 (対象リプレイを {config.canonical_slot} として配置)")


def build_injector_cmd(config):
    """injector.exeへ渡す引数列を組み立てる。extra_dllsが指定されていれば
    hook_dllより前に指定順で注入させる(injector.exeは指定順に全DLLを注入してから
    メインスレッドを再開する、mods/common/injector.cpp参照)。"""
    return ["wine", config.injector, config.game_exe, *config.extra_dlls, config.hook_dll]


def find_window(config, env, pid):
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


def find_live_game_pid(process_name):
    """process_nameのPIDのうち、zombie(状態Z)ではないものを1つ返す(なければNone)。
    コンテナ内ではPID 1(entrypoint.py)がinitのように孤児プロセスをreapする仕組みを
    持たないため、前の試行でSIGKILLしたプロセスがzombieのまま残り続けることがある。
    `pgrep -x`はzombieもマッチしてしまうため、2回目以降の試行で新しいプロセスでは
    なく前回のzombieのPIDを掴んでしまい、ウィンドウが永遠に見つからない原因になって
    いた(reports/24)。呼び出し側は`config.game_exe`(実際に起動するファイル名)ではなく
    `config.process_name`(pgrep/pkill専用。`/proc/PID/comm`の15バイト切り詰め対策、
    th06の`東方紅魔郷.exe`→`東方紅魔郷`、touhou-recorder reports/31参照)を渡すこと。"""
    out = subprocess.run(["pgrep", "-x", process_name], capture_output=True, text=True).stdout.split()
    for pid in out:
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat = f.read()
            state = stat.rsplit(") ", 1)[-1].split()[0]
        except FileNotFoundError:
            continue
        if state != "Z":
            return pid
    return None


def thprac_attached(pid, thprac_exe):
    """指定PIDのプロセスにthpracのイメージがマップ済みかを /proc/<pid>/maps で確認する。

    thpracは自分自身のexeイメージを対象プロセスへ注入するため、アタッチが成功すると
    ゲームプロセスのマップにthpracのexeが現れる(reports/50)。"""
    try:
        with open(f"/proc/{pid}/maps") as f:
            return thprac_exe in f.read()
    except OSError:
        return False


def attach_thprac(config, env, timeout=THPRAC_ATTACH_TIMEOUT_SEC, log=print):
    """起動直後のゲームプロセスにthprac(config.thprac_exe)をアタッチする(reports/50)。

    injector.exeが`CREATE_SUSPENDED`でゲームを起動して自作MODを注入する既存の経路は
    一切変えず、**起動後に後付けでアタッチする**方式を採っている。thprac側に
    ゲームを起動させるとMODの注入タイミング(DirectInput8Create呼び出し前のIATフック)が
    崩れるため。th20はタイトルロゴアニメーションだけで10秒待つので、アタッチが
    数秒遅れても操作シーケンスには十分間に合う。

    `--attach` にPIDを渡さないのは、pgrepで得られるのはLinuxのPIDであり、Wineが
    ゲームプロセスに割り当てるWindows側のPIDとは別物だからである(LinuxのPIDを渡すと
    該当プロセスが見つからず、Xvfb上では誰も閉じられない確認ダイアログを出したまま
    thpracが常駐して固まる)。引数なしの`--attach`は「最初に見つかった東方ゲームの
    プロセス」へ自動でアタッチする。

    **同一WINEPREFIXで複数の東方ゲームを同時に走らせるとアタッチ先が不定になる**点に
    注意。Sattoriのワーカーは1コンテナ=1ジョブで、自宅ワーカーの並列録画も
    コンテナごとにWINEPREFIXが分かれる(=Windows側のプロセス列挙も分離される)ため、
    現状の構成では競合しない。

    戻り値: アタッチに成功したら True。失敗しても録画自体は続行できる(thpracなしの
    従来動作に戻るだけ)ため、呼び出し側は False を失敗として扱わないこと。"""
    if not config.thprac_exe:
        return False
    thprac_path = f"{config.instance_dir}/{config.thprac_exe}"
    if not os.path.exists(thprac_path):
        # タイトル資産アーカイブの作り忘れをここで診断できるようにしておく。
        log(f"WARNING: {thprac_path} が見つかりません。thprac無しで録画します"
            "(th20はデシンクが起きやすくなります、reports/50)")
        return False

    log(f"thprac をアタッチします ({config.thprac_exe})")
    t0 = time.time()
    proc = subprocess.Popen(
        ["wine", config.thprac_exe, "--attach"],
        cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        log(f"WARNING: thprac のアタッチが{timeout}秒でタイムアウトしました。"
            "thprac無しで録画します")
        return False

    pid = find_live_game_pid(config.process_name)
    if pid and thprac_attached(pid, config.thprac_exe):
        log(f"thprac アタッチ完了 ({time.time()-t0:.1f}s, pid={pid})")
        return True
    log("WARNING: thprac のイメージがゲームプロセスにマップされていません"
        "(アタッチ失敗)。thprac無しで録画します")
    return False


def kill_wine_and_wait(config, env, process_name):
    """ゲーム本体とwineserverを終了させ、実際にwineserverが終了するまで待つ。
    固定sleepで待っていたところ、AWSのようにCPUが逼迫した環境ではwineserverの
    終了処理自体に2秒以上かかることがあり、終了前に次の試行のinjectorを起動して
    ウィンドウ検出に失敗する事象が確認された(reports/24)。`wineserver -w`は
    現在起動中のwineserverが実際に終了するまでブロックするため、固定時間の
    推測より確実。呼び出し側は`config.process_name`を渡すこと(find_live_game_pid()参照)。"""
    subprocess.run(["pkill", "-9", "-x", process_name])
    subprocess.run(["wineserver", "-k"], env=env)
    subprocess.run(["wineserver", "-w"], env=env, timeout=60)


def wait_for_log_marker(log_path, marker, timeout, poll_interval=0.1, log_all=False, seen_lines=None, log=print):
    if seen_lines is None:
        seen_lines = set()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(log_path):
            with open(log_path) as f:
                lines = f.readlines()
            for line in lines:
                if line in seen_lines:
                    continue
                seen_lines.add(line)
                if log_all:
                    log(f"MODログ: {line.strip()}")
                if marker in line:
                    return time.time()
        time.sleep(poll_interval)
    return None


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


def grab_frame_gray(config, env, x, y, w, h):
    """stutter probe専用の軽量版(カラー画像のデコードを省く)。"""
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{config.display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    img = Image.open(io.BytesIO(result.stdout)).convert("L").resize((160, 120))
    return np.asarray(img, dtype=np.float32)


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
    座標系に揃えた上で、リプレイ内容に依存しない上部の帯(END_TEMPLATE_ROWS)だけを
    切り出して返す。ファイル未設定・未存在の場合はNone(呼び出し側は画面静止のみで
    判定する従来のフォールバック動作になる、reports/33参照)。"""
    if not path or not os.path.exists(path):
        return None
    img = Image.open(path).convert("L").resize((160, 120))
    return np.asarray(img, dtype=np.float32)[:END_TEMPLATE_ROWS, :]


def probe_stutter(config, env, x, y, w, h, interval_sec=STUTTER_PROBE_INTERVAL_SEC):
    """短時間(約1.5秒)に複数フレームを`interval_sec`間隔で連続キャプチャし、隣接フレーム間が
    ほぼ同一(MAD<STILL_MAD_THRESHOLD)である割合を返す。60fpsで本来動いているはずの
    短い間隔でこの割合が高ければ、処理落ち(重複フレーム多発、reports/12・13・22)の
    疑いが強い。

    低速録画(Issue #68)ではゲームの描画頻度自体が下がるため、呼び出し側が同じ比率で
    伸ばした間隔を渡す。等倍と同じ0.15秒のままだと、正常に目標fpsを維持できていても
    隣接フレームが重複と判定され、処理落ちを誤検知する。"""
    frames = [grab_frame_gray(config, env, x, y, w, h)]
    for _ in range(STUTTER_PROBE_SAMPLES - 1):
        time.sleep(interval_sec)
        frames.append(grab_frame_gray(config, env, x, y, w, h))
    dup_count = sum(
        1 for i in range(1, len(frames)) if mad(frames[i - 1], frames[i]) < STILL_MAD_THRESHOLD
    )
    return dup_count / (len(frames) - 1)


def scan_fps_runaway(log_path):
    """log_path全体からFpsMonitorのHz値を読み取り、閾値超過が
    FPS_RUNAWAY_CONSECUTIVE_REQUIRED回連続していればその最大値を返す(なければNone)。
    ファイル全体を毎回読み直す(ログは小さいため負荷は無視できる)。"""
    if not os.path.exists(log_path):
        return None
    with open(log_path) as f:
        text = f.read()
    hz_values = [float(v) for v in FPS_MONITOR_HZ_RE.findall(text)]
    for i in range(len(hz_values) - FPS_RUNAWAY_CONSECUTIVE_REQUIRED + 1):
        window = hz_values[i:i + FPS_RUNAWAY_CONSECUTIVE_REQUIRED]
        if all(v > FPS_RUNAWAY_HZ_THRESHOLD for v in window):
            return max(window)
    return None


def save_progress_snapshot(progress_dir, color_frame, elapsed_seconds, expected_duration_seconds):
    """録画中の画面プレビュー(frame.jpg)と進捗算出用の状態(state.json)を書き出す。
    entrypoint.py側のバックグラウンドスレッドがこれをポーリングしてS3へアップロードする。
    一時ファイル→os.replaceでアトミックに上書きし、読み手が書きかけファイルを掴まないようにする。
    """
    thumb = color_frame.copy()
    thumb.thumbnail((480, 480))
    tmp_frame_path = f"{progress_dir}/frame.jpg.tmp"
    thumb.save(tmp_frame_path, "JPEG", quality=80)
    os.replace(tmp_frame_path, f"{progress_dir}/frame.jpg")

    state = {"elapsedSeconds": elapsed_seconds, "expectedDurationSeconds": expected_duration_seconds}
    tmp_state_path = f"{progress_dir}/state.json.tmp"
    with open(tmp_state_path, "w") as f:
        json.dump(state, f)
    os.replace(tmp_state_path, f"{progress_dir}/state.json")


def build_video_ffmpeg_cmd(config, x, y, w, h, video_output):
    """映像のみを録画するffmpegコマンド(音声は別プロセス、reports/26参照)。
    `-copyts`で実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
    start_timeとして保持する。mux時にこれを使ってA/V同期を補正する(reports/28参照)。

    ウォーターマークはこのコマンドでは合成しない。x11grab の生ptsは wallclock
    ベース(実epoch秒)で `-copyts` により無加工のまま filtergraph に渡るため、
    ほぼ0起点のウォーターマーク動画(ファイル入力)と overlay filter 内で
    フレーム同期が全く噛み合わず、overlay の `eof_action=pass` が即座に発動して
    ウォーターマークが一切合成されない不具合が本番のth08録画で発覚した。
    ウォーターマークは convert.py 側(`-copyts`を使わない通常のファイル入力
    同士の合成で、かつどのみち720p変換のために既に発生する再エンコード1回に
    相乗りできる)で行う。
    """
    return [
        "ffmpeg", "-y", "-copyts",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{config.display}+{x},{y}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        video_output,
    ]


def build_audio_ffmpeg_cmd(config, audio_output):
    """音声のみを録画するffmpegコマンド(別プロセス、reports/26参照)。
    `-copyts`はbuild_video_ffmpeg_cmd()と同じ理由(reports/28参照)。"""
    return [
        "ffmpeg", "-y", "-copyts", "-f", "pulse", "-i", config.pulse_source,
        "-c:a", "aac", "-b:a", "192k", audio_output,
    ]


def ffprobe_start_time(path, env):
    """-copytsで保持した絶対wallclock秒(epoch秒)のstart_timeを取得する。取得失敗時はNoneを返す。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
             "-of", "default=nw=1:nk=1", path],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def mux_audio_video(video_path, audio_path, output_path, env, log=print):
    """映像・音声を結合する(再エンコードなし)。

    x11grab(映像)とpulse(音声)は起動から実際にキャプチャを開始するまでの初期化
    レイテンシが異なり(音声側が数百ms〜1秒超遅い、touhou-recorder reports/28)、
    素朴に結合すると音声が映像より数百ms先行して聴こえる音ズレが生じる。
    build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd が付与する`-copyts`で保持した
    絶対start_time(wallclockベース、epoch秒)の差分を実測し、遅く始まった側に
    `-itsoffset`を与えることでハードコードされた定数を使わずに毎回自動補正する。
    """
    video_offset = 0.0
    audio_offset = 0.0
    v_start = ffprobe_start_time(video_path, env)
    a_start = ffprobe_start_time(audio_path, env)
    if v_start is not None and a_start is not None:
        delta = a_start - v_start
        if delta > 0:
            audio_offset = delta
        elif delta < 0:
            video_offset = -delta
        log(
            f"A/V同期補正: video_start={v_start:.3f} audio_start={a_start:.3f} "
            f"delta={delta:+.3f}s (video_offset={video_offset:.3f}s audio_offset={audio_offset:.3f}s)"
        )
    else:
        log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")

    cmd = ["ffmpeg", "-y"]
    if video_offset:
        cmd += ["-itsoffset", f"{video_offset:.6f}"]
    cmd += ["-i", video_path]
    if audio_offset:
        cmd += ["-itsoffset", f"{audio_offset:.6f}"]
    cmd += ["-i", audio_path, "-c", "copy", "-shortest", output_path]
    log(f"mux実行: {' '.join(cmd)}")
    result = subprocess.run(cmd, env=env, capture_output=True)
    if result.returncode != 0:
        log(f"WARNING: mux失敗 (returncode={result.returncode}): {result.stderr[-2000:].decode(errors='replace')}")
    return result.returncode == 0


def duplicate_rate_threshold_for_raw(threshold_percent, time_scale):
    """等倍換算の重複フレーム率の閾値を、**等倍へ戻す前の生データ**に対する閾値へ換算する。

    低速録画(Issue #68)の生データは、ゲームが目標fpsを完璧に維持できていても各フレームが
    `time_scale` 枚ずつ並ぶ(録画自体は等倍と同じ`-framerate 60`で撮るため)。等倍の閾値を
    そのまま当てると、正常な録画が必ず「処理落ち」と判定されてリトライされてしまう。

    ユニークなフレーム数 U は等倍化しても変わらず、総フレーム数だけが `time_scale` 倍に
    なる。生データの尺 T、等倍化後の尺 T/scale として

        raw = 1 - U/(60T)                     等倍化後 = 1 - U/(60T/scale)

    から `等倍化後 = scale*raw - (scale-1)`、逆に解いて

        raw = (等倍化後 + scale - 1) / scale

    等倍(scale=1)では換算しても値が変わらないので、既存タイトルの判定は一切変わらない。
    """
    if time_scale <= 1.0:
        return threshold_percent
    return (threshold_percent + (time_scale - 1) * 100.0) / time_scale


def measure_duplicate_rate(video_path, start_sec, duration_sec):
    """録画動画の指定区間について、mpdecimateフィルタで重複フレーム率(%)を計測する。
    ウィンドウ再作成等による処理落ち(reports/12・13・22)の事後検知に使う。
    計測に失敗した場合はNoneを返す。"""
    try:
        probe_out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-read_intervals", f"{start_sec}%+{duration_sec}",
                # ffmpeg 6.x(Ubuntu 24.04 のワーカーイメージが導入するバージョン)では
                # 旧称の `pkt_pts_time` は出力されなくなっている(空文字列を返し続け、
                # 常にNoneになる不具合を実機テストで確認した)。現行の `pts_time` を使う。
                "-show_entries", "frame=pts_time", "-of", "csv=p=0", video_path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout
        total_frames = len([line for line in probe_out.splitlines() if line.strip()])
        if total_frames == 0:
            return None

        decimate_result = subprocess.run(
            [
                "ffmpeg", "-i", video_path, "-ss", str(start_sec), "-t", str(duration_sec),
                "-vf", "mpdecimate", "-vsync", "0", "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        matches = re.findall(r"frame=\s*(\d+)", decimate_result.stderr)
        if not matches:
            return None
        unique_frames = int(matches[-1])

        return round(max(0.0, (1 - unique_frames / total_frames) * 100), 1)
    except (subprocess.CalledProcessError, ValueError, ZeroDivisionError, OSError):
        return None


def _failure_result(config, env, log):
    """game_pid/ウィンドウ検出/安定確認のいずれかが失敗した場合の戻り値。
    output_exists=Falseにしておけばrecord_with_retry()の失敗判定がそのまま効く
    (reports/24で、以前はsys.exit(1)によりリトライループごとプロセスが終了して
    しまう不具合があった教訓を踏まえた設計)。"""
    kill_wine_and_wait(config, env, config.process_name)
    return {
        "output_exists": False,
        "classification": "setup_error",
        "fps_runaway_hz": None,
        "total_record_sec": 0.0,
        "time_scale": 1.0,
    }


def attempt_recording(config, replay_path, output_path, progress_dir, expected_duration_seconds, log=print):
    """録画を1回試行する。戻り値: dict(output_exists, classification, fps_runaway_hz, total_record_sec)。
    classification は "good" / "fps_runaway" / "stutter" / "timeout" / "setup_error" のいずれか。
    """
    env = config.build_env()
    # 低速録画(Issue #68)のスケール係数。等倍なら1.0で、以下の時間依存パラメータは
    # すべて従来値のままになる。
    time_scale = slow_motion_scale(env)
    if time_scale != 1.0:
        log(
            f"低速録画モード: FPS_LIMIT_TARGET_HZ={env.get('FPS_LIMIT_TARGET_HZ')} "
            f"(実時間はゲーム内時間の{time_scale:.2f}倍。監視の猶予・タイムアウトも同じ比率で伸ばします)"
        )
    post_start_grace_sec = POST_START_GRACE_SEC * time_scale
    stutter_probe_interval_sec = STUTTER_PROBE_INTERVAL_SEC * time_scale
    stutter_probe_period_sec = STUTTER_PROBE_PERIOD_SEC * time_scale
    stutter_probe_active_until_sec = STUTTER_PROBE_ACTIVE_UNTIL_SEC * time_scale
    timeout_sec = TIMEOUT_SEC * time_scale
    # 終了検知の「連続回数」も同じ比率で伸ばす。ポーリングは実時間駆動
    # (POLL_INTERVAL_SEC)なので、回数を据え置くと**ゲーム内時間で必要な静止の長さが
    # 1/time_scale に縮む**——低速録画のth20なら16秒→8秒相当になり、会話イベントや
    # 弾幕の薄い区間でリプレイ途中の誤検知を招く(しかも classification は "good" に
    # なるためリトライされず、途中で切れた動画がそのまま配信される)。
    still_consecutive_required = scaled_poll_count(STILL_CONSECUTIVE_REQUIRED, time_scale)
    end_template_consecutive_required = scaled_poll_count(
        END_TEMPLATE_CONSECUTIVE_REQUIRED, time_scale,
    )
    end_template = load_end_template(config.end_template_path)
    if end_template is None:
        log(
            f"WARNING: {config.end_template_path} が見つからないため、画面静止のみで"
            "リプレイ終了を判定します(誤検知の可能性あり、reports/33参照)"
        )
    ensure_xvfb(config, env, log=log)
    prepare_instance(config, replay_path, log=log)

    injector_cmd = build_injector_cmd(config)
    log(f"injector を起動します: {' '.join(injector_cmd)}")
    subprocess.Popen(
        injector_cmd,
        cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    game_pid = None
    t0 = time.time()
    while time.time() - t0 < 20:
        game_pid = find_live_game_pid(config.process_name)
        if game_pid:
            break
        time.sleep(0.1)
    if not game_pid:
        log(f"ERROR: {config.process_name} プロセスが検出できませんでした")
        return _failure_result(config, env, log)
    log(f"game_pid={game_pid} ({time.time()-t0:.1f}s)")

    # thpracを設定しているタイトル(th20)は、ここで後付けアタッチする。ウィンドウ検出の
    # 前に済ませるのは、MODのタイトルロゴ待ち(th20は10秒)が終わってメニュー操作が
    # 始まるより先にthpracのパッチを当てたいため。失敗しても録画は続行する
    # (thprac無しの従来動作に戻るだけ。attach_thprac()参照)。
    attach_thprac(config, env, log=log)

    geom = None
    t0 = time.time()
    while time.time() - t0 < 20:
        geom = find_window(config, env, game_pid)
        if geom:
            break
        time.sleep(0.1)
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        return _failure_result(config, env, log)
    log(f"ウィンドウを検出しました: x={geom[0]} y={geom[1]} w={geom[2]} h={geom[3]} "
        f"(winid={geom[4]}。この時点の座標はまだ確定値ではない)")

    # ここで得た座標をそのままクロップ座標に使ってはならない。この検出はウィンドウが
    # Xサーバー上でviewableになった直後に成立するが、ゲームによってはその後さらに自分で
    # ウィンドウを再配置する。th11(地霊殿)は openbox の初期配置 client=(159,119)
    # (=800x600に収まるようクランプされた位置)でviewableになった直後に、自身で
    # client=(185,211)(=画面右下にはみ出す位置)へ移動する。実測で両者の間隔は
    # 40msしかなく、負荷の高いEC2上ではこの隙間で検出が成立してしまう
    # (ローカル再現試験でCPUに負荷をかけると8試行中7回発生)。
    # th08は起動から約2.5秒後にウィンドウ自体を破棄・再生成する(座標は同じ(3,29))。
    # そのため、MOD側のWaitForStableWindowが安定を報告するまで待ってから座標を取り直す。
    seen_lines = set()
    stable_time = wait_for_log_marker(
        config.log_path, "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if stable_time is None:
        log("ERROR: ウィンドウの安定を確認できませんでした")
        return _failure_result(config, env, log)
    log("ウィンドウの安定を確認しました。クロップ座標を確定します")

    # MOD側のWaitForStableWindowはHWNDの同一性しか見ておらず(mods/common/window_wait.cpp)、
    # 位置・サイズの安定までは保証しない。座標そのものが落ち着いたことは
    # wait_for_stable_geometry()で別途確認する。
    geom = wait_for_stable_geometry(config, env, game_pid, log=log)
    if not geom:
        log("ERROR: ウィンドウ座標を確定できませんでした")
        return _failure_result(config, env, log)
    x, y, w, h, winid = geom
    log(f"クロップ座標を確定: x={x} y={y} w={w} h={h} (winid={winid})")

    # 確定した座標がXvfbの画面(config.xvfb_screen)の範囲外にはみ出す場合は左上(0,0)へ移動する
    # (th11の安定位置(185,211)は 185+640=825 > 800 で範囲外。この状態のままだと
    # x11grabが起動に失敗する、touhou-recorder reports/35)。
    # 移動後の実座標は必ず再取得すること: xdotool windowmoveは(装飾のあるウィンドウの場合)
    # ウィンドウ枠を(0,0)へ移動するため、xwininfoが返すクライアント領域のAbsolute
    # upper-leftは(0,0)にならない(th11実機検証で、タイトルバー分ずれて録画される
    # 不具合として発覚、touhou-recorder reports/37)。さらにxdotool windowmoveの反映は
    # 非同期なので、ここでもwait_for_stable_geometry()で座標が落ち着くのを待ってから
    # 画面内に収まったかを判定し、収まるまで最大20回リトライする。
    screen_w, screen_h = (int(v) for v in config.xvfb_screen.split("x")[:2])
    if x + w > screen_w or y + h > screen_h:
        for _ in range(20):
            subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)
            moved_geom = wait_for_stable_geometry(
                config, env, game_pid, log=log,
                timeout=GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC,
            )
            if not moved_geom:
                continue
            mx, my, mw, mh, _ = moved_geom
            if mx + mw > screen_w or my + mh > screen_h:
                continue
            x, y, w, h = mx, my, mw, mh
            break
        else:
            log(f"WARNING: ウィンドウが画面内に収まりませんでした (x={x} y={y} w={w} h={h})")
        log(f"移動後のウィンドウ座標: x={x} y={y} w={w} h={h}")
    else:
        log(f"ウィンドウは既に画面内に収まっているため移動をスキップします: x={x} y={y} w={w} h={h}")
    still_mask = build_still_mask(config.still_detect_exclude_rect, w, h)
    log("録画を開始します")

    base, _ext = os.path.splitext(output_path)
    video_target = f"{base}.video.mp4"
    audio_target = f"{base}.audio.m4a"

    video_cmd = build_video_ffmpeg_cmd(config, x, y, w, h, video_target)
    log(f"録画開始(映像): {' '.join(video_cmd)}")
    video_log_path = f"{os.path.dirname(output_path)}/ffmpeg_video.log"
    video_log_file = open(video_log_path, "wb")
    video_proc = subprocess.Popen(
        video_cmd, env=env, stdin=subprocess.PIPE, stdout=video_log_file, stderr=subprocess.STDOUT,
    )

    audio_cmd = build_audio_ffmpeg_cmd(config, audio_target)
    log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
    audio_log_path = f"{os.path.dirname(output_path)}/ffmpeg_audio.log"
    audio_log_file = open(audio_log_path, "wb")
    audio_proc = subprocess.Popen(
        audio_cmd, env=env, stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
    )
    record_start = time.time()

    # MODのメニュー自動操作(dllmain.cppのScaledSleep)は低速録画時に同じ比率だけ
    # 実時間が伸びるため、その完了を待つこちらのタイムアウトも伸ばす。伸ばし忘れると
    # 「シーケンス完了ログが検出できない」と誤判定する(touhou-recorder reports/47)。
    sequence_complete_time = wait_for_log_marker(
        config.log_path, "sequence complete", timeout=20 * time_scale, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if sequence_complete_time is None:
        log("WARNING: MOD のキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻から監視開始(猶予{post_start_grace_sec:.1f}秒)")

    prev_frame = None
    consecutive_still = 0
    end_template_consecutive = 0
    detected = False
    stutter_detected = False
    fps_runaway_hz = None
    poll_count = 0
    next_stutter_probe = post_start_grace_sec
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > timeout_sec:
            log(f"TIMEOUT: {timeout_sec:.0f}秒経過したため強制停止します")
            break

        runaway_hz = scan_fps_runaway(config.log_path)
        if runaway_hz is not None:
            log(f"WARNING: FpsMonitorログで異常な高fps({runaway_hz:.1f}Hz)を検知しました。早期終了します")
            fps_runaway_hz = runaway_hz
            break

        if elapsed < post_start_grace_sec:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if elapsed >= next_stutter_probe and elapsed < stutter_probe_active_until_sec:
            dup_fraction = probe_stutter(config, env, x, y, w, h, stutter_probe_interval_sec)
            elapsed_after_probe = time.time() - gameplay_start
            next_stutter_probe = elapsed_after_probe + stutter_probe_period_sec
            log(f"stutter probe: elapsed={elapsed_after_probe:.1f}s dup_fraction={dup_fraction:.2f}")
            if dup_fraction >= STUTTER_DUP_FRACTION_THRESHOLD:
                log(f"WARNING: 短間隔サンプリングでの重複フレーム率({dup_fraction:.2f})が閾値を超えました。早期終了します")
                stutter_detected = True
                break
            prev_frame = None  # プローブでffmpeg呼び出しの時間が経っているため、次回はここから再計測する

        frame, color_frame = grab_frame(config, env, x, y, w, h)
        poll_count += 1
        if progress_dir and poll_count % PROGRESS_SNAPSHOT_EVERY_N_POLLS == 0:
            # 進捗は**実時間ではなくコンテンツ秒数**(＝完成品の動画で何秒ぶん進んだか)
            # で報告する。分母の expected_duration_seconds がリプレイの再生時間である
            # 以上、低速録画で伸びた実時間をそのまま入れると進捗率が半分に見えてしまう。
            # 実時間が倍かかること自体はフロントエンド側がジョブの `slowMotion` を見て
            # 残り時間の見積もりに織り込む(`apps/web/src/hooks/jobProgressBudget.ts`)。
            save_progress_snapshot(
                progress_dir, color_frame, elapsed / time_scale, expected_duration_seconds,
            )
        if end_template is not None:
            # テンプレートが使えるゲームでは、画面静止を待たずに毎回テンプレート照合する
            # (静止待ちを挟むと、リプレイ選択画面に戻った後さらにSTILL_CONSECUTIVE_REQUIRED
            # 分の遅延が余分にかかってしまうため、reports/34)。テンプレート自体が
            # ステージクリア画面等の無関係な画面と大きく乖離する(MAD 40〜140超、reports/33・34)
            # ため誤検知リスクは小さいが、動画圧縮ノイズ等による単発の偶然一致を弾くため
            # END_TEMPLATE_CONSECUTIVE_REQUIRED回連続の一致を要求する。
            template_d = mad(frame[:END_TEMPLATE_ROWS, :], end_template)
            if template_d < END_TEMPLATE_MAD_THRESHOLD:
                end_template_consecutive += 1
            else:
                end_template_consecutive = 0
            log(
                f"poll: elapsed={elapsed:.1f}s template_MAD={template_d:.2f} "
                f"end_template_consecutive={end_template_consecutive}"
            )
            if end_template_consecutive >= end_template_consecutive_required:
                log("リプレイ選択画面と連続して一致したためリプレイ終了と判定しました")
                detected = True
                break
        else:
            if prev_frame is not None:
                d = mad_masked(prev_frame, frame, still_mask)
                if d < STILL_MAD_THRESHOLD:
                    consecutive_still += 1
                else:
                    consecutive_still = 0
                log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} still={consecutive_still}")
                if consecutive_still >= still_consecutive_required:
                    log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                    detected = True
                    break
            prev_frame = frame
        time.sleep(POLL_INTERVAL_SEC)

    log("録画を停止します (SIGINT)")
    video_proc.send_signal(signal.SIGINT)
    audio_proc.send_signal(signal.SIGINT)
    try:
        video_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(映像) が時間内に終了しなかったため terminate します")
        video_proc.terminate()
        video_proc.wait(timeout=10)
    video_log_file.close()
    log(f"ffmpeg(映像) exit_code={video_proc.returncode}")
    try:
        audio_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(音声) が時間内に終了しなかったため terminate します")
        audio_proc.terminate()
        audio_proc.wait(timeout=10)
    audio_log_file.close()
    log(f"ffmpeg(音声) exit_code={audio_proc.returncode}")

    output_exists = False
    if os.path.exists(video_target) and os.path.exists(audio_target):
        output_exists = mux_audio_video(video_target, audio_target, output_path, env, log=log)
    else:
        log(f"WARNING: 映像/音声の中間ファイルが見つかりません: video={video_target} audio={audio_target}")

    if output_exists:
        log(f"出力ファイル: {output_path} ({os.path.getsize(output_path)} bytes)")
    else:
        # 失敗時の診断のため、ffmpegログの末尾をCloudWatch Logsに残す(ffmpeg.logは
        # ファイルなのでawslogsドライバに拾われず、コンテナ破棄で消えてしまうため)。
        for label, path in (("映像", video_log_path), ("音声", audio_log_path)):
            try:
                with open(path, "rb") as f:
                    tail = f.read()[-2000:]
                log(f"ffmpeg({label})ログ末尾: {tail.decode(errors='replace')}")
            except OSError:
                pass

    total_record_sec = time.time() - record_start
    if fps_runaway_hz is not None:
        classification = "fps_runaway"
        stop_reason = "fps暴走早期検知"
    elif stutter_detected:
        classification = "stutter"
        stop_reason = "処理落ち早期検知"
    elif detected:
        classification = "good"
        stop_reason = "画面静止検知"
    else:
        classification = "timeout"
        stop_reason = "タイムアウト"
    log(f"録画終了。総録画時間 {total_record_sec:.1f}秒 検知方式: {stop_reason}")

    kill_wine_and_wait(config, env, config.process_name)

    return {
        "output_exists": output_exists,
        "classification": classification,
        "fps_runaway_hz": fps_runaway_hz,
        "total_record_sec": total_record_sec,
        # この試行の録画に適用されていた実時間スケール(等倍なら1.0)。出力は等倍へ
        # 戻す前の生データなので、重複フレーム率の判定にこの値が要る
        # (`duplicate_rate_threshold_for_raw()`)。
        "time_scale": time_scale,
    }


def record_with_retry(config, replay_path, output_path, *,
                       progress_dir=None, expected_duration_seconds=None,
                       max_attempts=MAX_ATTEMPTS_DEFAULT, max_duplicate_rate=MAX_DUPLICATE_RATE_DEFAULT,
                       log=print):
    """attempt_recording()を最大max_attempts回試行し、fps暴走・処理落ちの早期検知や
    事後の重複フレーム率チェックに引っかかった場合は出力を破棄してリトライする。
    正常な録画が得られればTrueを、max_attempts回失敗すればFalseを返す。

    このジョブ専用のPulseAudio null-sink(config.pulse_sink)はここで作成し、成功・失敗を
    問わず戻る際に破棄する(Issue #48)。全試行で同じsinkを使い回す(試行ごとにWineと
    録音ffmpegは起動し直されるため、sinkだけを共有しても前試行の残留ストリームは残らない)。
    """
    with pulse.job_sink(config.pulse_sink, log=log):
        return _record_with_retry(
            config, replay_path, output_path,
            progress_dir=progress_dir, expected_duration_seconds=expected_duration_seconds,
            max_attempts=max_attempts, max_duplicate_rate=max_duplicate_rate, log=log,
        )


def _record_with_retry(config, replay_path, output_path, *,
                       progress_dir, expected_duration_seconds,
                       max_attempts, max_duplicate_rate, log):
    for attempt in range(1, max_attempts + 1):
        log(f"=== 試行 {attempt}/{max_attempts} ===")
        result = attempt_recording(
            config, replay_path, output_path, progress_dir, expected_duration_seconds, log=log,
        )
        if not result["output_exists"]:
            log("WARNING: 出力ファイルが生成されなかったため、この試行は失敗として扱います")
            continue
        if result["classification"] == "fps_runaway":
            log(f"WARNING: fps暴走({result['fps_runaway_hz']:.1f}Hz)を検知したため破棄してリトライします")
            continue
        if result["classification"] == "stutter":
            log("WARNING: 処理落ちの早期検知によりこの試行を破棄してリトライします")
            continue

        # 判定対象は**等倍へ戻す前の生データ**なので、閾値の方をスケールに合わせて
        # 換算する(`duplicate_rate_threshold_for_raw()`)。等倍録画では換算しても
        # 値が変わらないため、th06/07/08/11の挙動は従来どおり。
        time_scale = result.get("time_scale", 1.0)
        threshold = duplicate_rate_threshold_for_raw(max_duplicate_rate, time_scale)
        dup_rate = measure_duplicate_rate(output_path, 15, min(30, max(5, result["total_record_sec"] - 15)))
        log(
            f"録画開始15秒以降の重複フレーム率: {dup_rate}% "
            f"(閾値{threshold:.1f}% = 等倍換算{max_duplicate_rate}%、time_scale={time_scale})"
        )
        if dup_rate is not None and dup_rate > threshold:
            log(f"WARNING: 重複フレーム率({dup_rate}%)が閾値({threshold:.1f}%)を超えました。破棄してリトライします")
            continue

        log(f"試行{attempt}で正常な録画を確認しました")
        return True

    log(f"ERROR: {max_attempts}回試行しても正常な録画が得られませんでした")
    return False
