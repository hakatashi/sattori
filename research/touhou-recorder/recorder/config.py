"""タイトルごとの差分をまとめた`GameConfig`と、パイプライン共通の既定値。

タイトル固有の**値そのもの**(なぜその値なのかの根拠コメント込み)は`recorder/games.py`に
あり、このモジュールはその入れ物と、どのフィールドが何を意味するかの定義だけを持つ。

値の解決規則は「`None` = 既定値を使う」で統一している。閾値の既定値は、その閾値を
実際に使うモジュール(`vision`・`stutter`・`modlog`)が持っているため、ここでは
`None`のままにしておき、使う側が自分の既定値で解決する(循環importを避けるためでもある)。
"""
import os
from dataclasses import dataclass, field

# リポジトリルート。**このモジュールから見て1つ上**であることに注意
# (`recorder/config.py`にあるため)。games/・prefixes/・mods/・assets/・scripts/は
# いずれもリポジトリルート直下にあり、ここを起点に解決する。
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 既定のXvfb画面サイズ(640x480ウィンドウ+ウィンドウ装飾分の余白)。th15/th20は内部
# 描画解像度が960p相当(1280x960ウィンドウ)、th06c/th06ncはさらに大きいため、
# `GameConfig.xvfb_screen`でタイトルごとに上書きする(reports/44)。
XVFB_SCREEN = "800x600x24"

# 既定のDLLインジェクタ(32bitタイトル用)。th06c/th06ncはPE32+(x86-64)のため
# `injector64.exe`を指定する(reports/74)。
INJECTOR = "injector.exe"

# PulseAudioの録音元。検証環境では`pulseaudio -D`が自動生成するnull-sinkの
# monitorをそのまま使う(本番sattoriはジョブごとに専用sinkを作るが、
# 本リポジトリは同時実行2インスタンスまでの検証用途のため既定のままとしている)。
PULSE_SOURCE = "auto_null.monitor"

# 倍速録画(issue #1)専用のPulseAudioシンク名接頭辞。ゲームの音声出力を
# `AUDIO_CAPTURE_RATE_HZ`(recorder/timing.py)相当の高レートシンクへ向けるために使う
# (reports/85、録音のナイキスト周波数不足による高域欠落対策)。
DOUBLESPEED_SINK_NAME_PREFIX = "touhou_doublespeed"


@dataclass(frozen=True)
class GameConfig:
    """1タイトルぶんの録画設定。

    `game_id`から機械的に決まる値(`game_exe`・`hook_dll`・`log_path`)は
    `__post_init__`が導出するので、`recorder/games.py`では**そのタイトルでしか
    成り立たない値だけ**を書くこと。
    """

    # --- 必須 --------------------------------------------------------------
    game_id: str
    display: str  # Xvfbのディスプレイ番号(例 ":97")。同一ホストでの多重起動を避けるためタイトルごとに別番号
    wineprefix: str
    instance_dir: str
    game_dir_src: str
    default_replay: str  # --replay未指定時に使うリプレイファイル名

    # --- 実行ファイル・プロセス --------------------------------------------
    # 実行ファイル名。未指定なら f"{game_id}.exe"。
    # th06は元のファイル名が日本語(東方紅魔郷.exe)で、VsyncPatchが実行ファイル名を
    # 検証しているらしくリネームすると白画面ハングが再発する(reports/30)。
    game_exe: str | None = None
    # pgrep/pkillでのプロセス検索に使う名前。未指定ならgame_exeを使う。
    # Linuxの`/proc/PID/comm`は15バイトで切り詰められるため、UTF-8で18バイトの
    # `東方紅魔郷.exe`は末尾の`.exe`が欠落した`東方紅魔郷`(15バイトちょうど)になり、
    # `pgrep -x "東方紅魔郷.exe"`は一致しない(reports/31)。
    process_name: str | None = None
    injector: str = INJECTOR

    # --- 注入するDLL・ファイル ----------------------------------------------
    hook_dll: str | None = None  # 未指定なら f"{game_id}_hook.dll"
    hook_dll_src: str | None = None  # 未指定なら mods/{game_id}_replay_autoplay/build/{hook_dll}
    # MOD本体より**前に**注入するDLL(th06/th10のVsyncPatch等)。
    # ゲームディレクトリに同梱されておりrsyncでコピーされるため、明示コピーは不要。
    extra_dlls: tuple = ()
    # rsync後に上書き配置する (コピー元パス, インスタンス内でのファイル名) のリスト
    # (th06c/th06ncのSteamworks APIスタブ等)。
    extra_files: tuple = ()

    # --- リプレイの配置 ------------------------------------------------------
    # コピー先のファイル名を固定したいタイトル用。MODがリプレイ一覧の特定スロットへ
    # 固定的に着地するシーケンスを持つ場合(ud0000タブ方式のth09/th11/th12/th15/th20、
    # No.01固定のth10)は、元のファイル名によらずここで正規化する。
    replay_dest_filename: str | None = None
    # th125以降のエンジン(th128/th15/th20)はcfg/replayを
    # %APPDATA%/ShanghaiAlice/<title>/配下から読む(reports/44)。
    appdata_dir: str | None = None
    cfg_filename: str | None = None

    # --- 起動オプション ------------------------------------------------------
    # `--thprac`指定時にアタッチするthprac本体のファイル名(ゲームディレクトリに同梱)。
    thprac_exe: str | None = None

    # --- 画面・ウィンドウ ----------------------------------------------------
    xvfb_screen: str = XVFB_SCREEN
    # ソフトウェア描画(llvmpipe)では60fpsに届かないタイトル用。Xvfbではなく
    # GPU描画面(headless weston + rootful Xwayland、または Xorg+NVIDIA)を立てる(reports/78)。
    gpu_display: bool = False
    # xorgバックエンドでのプライマリ出力の表示モード。「モニタのモード」を見て
    # ウィンドウ解像度を決めるタイトル(th06nc)で必要(reports/81)。
    crtc_mode: str | None = None
    # ウィンドウ検出時の足切りサイズ。起動ダイアログを本体ウィンドウと誤検出しない
    # ようにするため(th06cの解像度選択ダイアログは194x317、reports/74)。
    window_min_size: tuple = (100, 100)
    # 最小化(WM_STATE=Iconic)状態で作られるウィンドウを強制表示する(th12、reports/61)。
    force_window_map: bool = False
    # ウィンドウが画面内に収まっていれば(0,0)への強制移動をスキップする。
    # 移動するとタイトルバーが録画に写り込む・下端が欠ける不具合が出るタイトル用
    # (th06c/th06nc/th09、reports/68・74)。
    skip_origin_move_if_fits: bool = False
    # x11grabを座標ではなくウィンドウID(-window_id)で取り込む。GPU描画面(Xorg+nvidia)では
    # ゲーム自身が録画中にウィンドウ位置を(Win32のタイトルバー分ずらした)クライアント(3,29)
    # へ設定し直し、(0,0)へ戻しても繰り返し戻される(th08の4倍速で発生、reports/89)ため、
    # 位置に依存しない取り込みにする。
    capture_by_window_id: bool = False

    # --- 終了検知 ------------------------------------------------------------
    # リプレイ選択画面のテンプレート画像。未設定なら画面静止検知のみで判定する。
    end_template: str | None = None
    # テンプレート照合に使う矩形(元ウィンドウ座標系の(x0,y0,x1,y1))。
    # 未指定なら上部`vision.END_TEMPLATE_ROWS`行×全幅(th06/07/08の従来動作)。
    end_template_rect: tuple | None = None
    # 未指定なら`vision.END_TEMPLATE_MAD_THRESHOLD`。
    end_template_mad_threshold: float | None = None
    # 画面静止判定のMAD計算から除外する矩形(単一またはリスト)。
    # 終了画面に残るアニメーション・明滅するカーソル演出を除外する。
    still_detect_exclude_rect: tuple | list | None = None

    # --- 処理落ち早期検知(stutter probe) ------------------------------------
    # probe専用の除外矩形(静止した装飾領域が大半を占めるタイトル用、reports/79)。
    stutter_probe_exclude_rect: tuple | list | None = None
    # 未指定なら`stutter.STUTTER_DUP_FRACTION_THRESHOLD`。
    stutter_dup_fraction_threshold: float | None = None
    # 上記2種の除外矩形を目視で決めたときの基準解像度。ウィンドウ解像度を切り替えられる
    # タイトル(th06ncの720p/1080p)では、実ウィンドウサイズへ比例拡大するために使う。
    exclude_rect_base: tuple | None = None

    # --- ポーリング方式 -------------------------------------------------------
    # 終了検知のフレーム取得を、別プロセスのx11grabではなく録画用ffmpegのサブ出力から
    # 読む。高解像度タイトルでは毎回のgrab_frameが本録画のx11grabを周期的に妨害して
    # カクつきを起こすため(reports/81)。
    poll_side_stream: bool = False

    # --- fps暴走検知 ----------------------------------------------------------
    # 未指定なら`modlog.FPS_RUNAWAY_HZ_THRESHOLD`。健全な状態でもポーリング周波数が
    # 高いタイトル(th09は100〜190Hz)は個別に緩める(reports/68)。
    fps_runaway_hz_threshold: float | None = None

    # --- 導出値(指定不要) ----------------------------------------------------
    log_path: str = field(default=None)  # 未指定なら {instance_dir}/{game_id}_autoplay.log

    def __post_init__(self):
        # frozen=True のため object.__setattr__ で導出値を埋める。
        def default(name, value):
            if getattr(self, name) is None:
                object.__setattr__(self, name, value)

        default("game_exe", f"{self.game_id}.exe")
        default("process_name", self.game_exe)
        default("hook_dll", f"{self.game_id}_hook.dll")
        default("hook_dll_src",
                f"{REPO}/mods/{self.game_id}_replay_autoplay/build/{self.hook_dll}")
        default("log_path", f"{self.instance_dir}/{self.game_id}_autoplay.log")

    @property
    def screen_size(self):
        """`xvfb_screen`("800x600x24")から(幅, 高さ)を取り出す。"""
        w, h = (int(v) for v in self.xvfb_screen.split("x")[:2])
        return w, h

    def build_env(self):
        """ゲーム・ffmpeg・xdotoolの各サブプロセスへ渡す環境変数。

        LANG/LC_ALLを日本語にしないと、Wine上のゲームが表示する日本語が文字化けする
        (reports/21)。
        """
        env = os.environ.copy()
        env["WINEPREFIX"] = self.wineprefix
        env["DISPLAY"] = self.display
        env["LANG"] = "ja_JP.UTF-8"
        env["LC_ALL"] = "ja_JP.UTF-8"
        # 倍速録画時、ゲームの音声出力を高レート専用シンクへ向ける
        # (recorder.instance.ensure_audio_sink()がシンクの作成を担当、reports/85)。
        from .timing import AUDIO_CAPTURE_RATE_HZ, NATIVE_AUDIO_RATE_HZ
        if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
            env["PULSE_SINK"] = f"{DOUBLESPEED_SINK_NAME_PREFIX}_{self.game_id}"
        # 同期マーカー(reports/88)のトリガーファイル。MOD(dsound_hook)はWine内から
        # 開くのでWindows形式(Z:)のパスで渡す。dsound_hookを組み込んでいないMODは無視する。
        from .sync_marker import trigger_path, windows_path
        env["SYNC_MARKER_TRIGGER"] = windows_path(trigger_path(self))
        return env
