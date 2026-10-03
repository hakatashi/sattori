"""タイトルごとの差分をまとめた `GameConfig` と、その既定値の導出。

録画パイプライン本体は同じパッケージの各モジュールへ分かれている(`recording/__init__.py`)。
タイトル固有の値をなぜその値にしたのかは `worker/docs/titles/thNN.md` にある。
"""
import dataclasses
import os
from dataclasses import dataclass, field

from .timing import NATIVE_FRAME_RATE_HZ, gpu_worker, is_speedup, recording_time_scale, speedup_multiplier

# `worker/` ディレクトリの絶対パス。**このモジュールから見て1つ上**であることに注意
# (`recording/config.py` にあるため)。games/・prefixes/・mods/・assets/ はいずれも
# worker ルート配下にあり、ここを起点に解決する。
WORKER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# 既定のXvfb画面サイズ(640x480ウィンドウ+ウィンドウ装飾分の余白)。th20は内部描画解像度が
# 960p相当(1280x960ウィンドウ)へ上がっており収まらないため、GameConfig.xvfb_screenで
# タイトルごとに上書きできる(touhou-recorder reports/44)。
XVFB_SCREEN = "800x600x24"


@dataclass(frozen=True)
class GameConfig:
    """タイトルごとに異なる値をまとめたもの(各 record_thNN.py が組み立てる)。

    game_id から機械的に決まるパス類は `for_game()` が導出するので、呼び出し側は
    **そのタイトルでしか成り立たない値だけ**を渡すこと。
    """

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
    # 終了検知用のリプレイ選択画面テンプレート画像のパス。未指定(None)なら worker ルート
    # (WORKER_ROOT)配下の`assets/replay_end_templates/{game_id}.png`
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
    # 終了検知テンプレート照合の対象領域(元のウィンドウ座標系、x0, y0, x1, y1)。未指定
    # (None)なら従来通り「上部END_TEMPLATE_ROWS行×全幅」を使う(th06/07/08)。th10の
    # リプレイ選択画面は背景全体が常時アニメーションしており、上部帯全体を比較すると
    # 同一画面同士でもMADが上振れして誤判定を招くため、リプレイ内容に依存しない
    # 左上の"REPLAY"見出し部分だけに絞り込む必要がある(touhou-recorder reports/56)。
    end_template_rect: tuple[int, int, int, int] | None = None
    # 終了検知テンプレート照合のMAD閾値。未指定(None)なら従来通りEND_TEMPLATE_MAD_THRESHOLD。
    # th10はend_template_rectで絞り込んだ領域でも同一画面同士の実測MADがth06/07/08より
    # 高め(背景アニメーションの影響)なため、専用の閾値を使う(touhou-recorder reports/56)。
    end_template_mad_threshold: float | None = None
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
    # 起動前に書き換えるvpatch.ini(VsyncPatch)の設定((section, key, value)のタプル)。
    # th10のBugFixTh10Power3(魔理沙Bのパワー3バグ修正)のように、記録リプレイと再生時の
    # 設定が食い違うとリプレイずれが起きるVsyncPatchオプションを、ジョブごとの録画
    # オプション(RecordingOptions)に応じて動的に上書きするために使う(空タプルが既定で、
    # その場合は同梱のvpatch.iniをそのまま使う。touhou-recorder reports/58)。
    vpatch_ini_overrides: tuple[tuple[str, str, str], ...] = ()
    # ゲームウィンドウが最小化(Iconic)状態で作成される既知の不具合への対策(th12)。
    # find_window()のxwininfo判定はIsViewableを見るため、最小化状態のウィンドウを
    # 検出できずウィンドウ検出ループが延々タイムアウトする。Trueにするとfind_window()が
    # 検出した全ウィンドウへ`xdotool windowmap`を発行してから判定する
    # (touhou-recorder reports/61)。既定Falseの他タイトルはこの追加処理を経ない。
    force_window_map: bool = False
    # GPU描画(Xorg+NVIDIA GRIDドライバ)でヘッドレス画面を作るタイトルか(Issue #241)。
    # Falseなら従来通りXvfb+llvmpipe(ソフトウェア描画)を使う。th06ncはD3D11描画で
    # あり、Xvfb+wined3d+llvmpipeでは60fpsに遠く届かない(720pで9.1fps、
    # touhou-recorder reports/78)ため、この経路が必須。`recording.instance.
    # ensure_display()`が本フラグで初期化方法を切り替える。
    gpu_display: bool = False
    # GPU使用時にWineへ渡すWINEDLLOVERRIDES(DXVK有効化用、例:
    # "d3d11,dxgi,d3d10core=n")。gpu_display=Falseなら無視する。DXVK(D3D11→Vulkan)は
    # wined3d(D3D11→OpenGL)より重複フレーム率が一貫して優位だった
    # (touhou-recorder reports/79〜81)ため、GPU系タイトルはこちらを既定採用する。
    dxvk_dll_overrides: str | None = None
    # GPU使用時、Xorg起動後にxrandrで明示的に切り替えるCRTCモード(例: "1920x1080")。
    # Noneならxrandrでの変更は行わない(Xorg起動時の既定モードのまま)。
    # Xorg+nvidia環境では「仮想画面サイズ」と「CRTCの実モード」が別概念で、th06ncは
    # CRTCの実モードを見てウィンドウ解像度の選択肢を決めるため、1080p録画を選ぶ
    # 場合はこれを明示的に1920x1080へ変更する必要がある(touhou-recorder
    # reports/81 §9.9.1)。
    crtc_mode: str | None = None
    # 終了検知・進捗スクショ用の定期ポーリングキャプチャ(grab_frame)を、本番録画用
    # x11grabと同一のffmpegプロセスから分岐させたサブストリーム経由で行うか。
    # GPU実行時にポーリング用の別ffmpegプロセスが本番キャプチャと定期的に競合し、
    # 周期的なコマ落ちを引き起こす問題への対処(touhou-recorder reports/81 §9)。
    # 既定Falseのタイトルは従来通りgrab_frame()が毎回新規ffmpegプロセスを起動する
    # (CPU専用インスタンス・640x480程度の解像度では実害が確認されていないため、
    # 既存9タイトルの挙動はそのまま維持する)。
    poll_side_stream: bool = False
    # rsync後(prepare_instance())に上書きコピーする追加ファイル
    # ((絶対パスの元ファイル, instance_dir配下の相対パス)のタプル)。
    # th06ncのth06.env(起動時の解像度設定)のように、ゲーム終了時に書き戻されて
    # しまう設定ファイルを、ジョブオプション(720p/1080p)に応じて毎回正しい内容へ
    # 上書きする必要がある場合に使う(touhou-recorder reports/78 §11.2)。
    # 空タプルが既定で、既存9タイトルは触れない。
    extra_instance_files: tuple[tuple[str, str], ...] = ()
    # GPU描画時(`gpu_display`)に、x11grabを座標ではなくウィンドウID(`-window_id`)で
    # 取り込むか。GPU描画面(Xorg+nvidia)のth08は、録画開始前にウィンドウを(0,0)へ
    # 移しても、その後ゲーム自身がウィンドウ位置を(Win32のタイトルバー分下がった)
    # クライアント(3,29)へ設定し直し、以後の映像がずれて終了画面のテンプレートが一致
    # しなくなる(touhou-recorder reports/89 §5.3)。位置に依存しない取り込みにする。
    # Xvfb(CPU描画)では従来どおり座標で取り込む(Xvfb上のth08はウィンドウID基準でも
    # タイトルバー分ずれることが確認されており、利点が無いため、reports/90 §1.3)。
    capture_by_window_id: bool = False

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
            # **`__file__`(=recording/config.py)ではなくWORKER_ROOTを起点にすること**。
            # ここを間違えても例外は出ず、load_end_template()がNoneを返して画面静止のみ
            # 判定へ静かにフォールバックするだけなので、終了検知の劣化として表面化する。
            object.__setattr__(
                self, "end_template_path",
                f"{WORKER_ROOT}/assets/replay_end_templates/{self.game_id}.png",
            )

    @classmethod
    def for_game(cls, game_id, pulse_sink, **overrides):
        """game_id から機械的に決まるパス類を埋めた `GameConfig` を組み立てる。

        タイトルを1つ足すたびに同じ導出を書き写していたため(Issue #188)、6つの
        `record_thNN.py` で共通していた部分だけをここへ集約した。環境変数による上書きの
        名前・既定値・優先順位は従来のまま(ローカル単体実行で `SATTORI_GAME_DIR` 等を
        指す運用が `docs/reports/` の再現手順に載っているため変えられない)。

        `overrides` はそのまま `GameConfig` へ渡す。`display` だけは「タイトルごとの既定値を
        `SATTORI_DISPLAY` が上書きする」という関係なので、ここで解決する。

        `overrides` は `defaults` のキー(`injector_path`等)も上書きできる——th06cが
        32bit共通の`injector.exe`ではなく64bit版の`injector64.exe`を指定するために必要
        (`record_th06c.py`)。`**defaults, **overrides`のように2つの辞書を直接
        キーワード展開すると、キーが重複した場合にTypeErrorになるため、辞書の
        マージ(`overrides`を後勝ちにする`update()`)を経由する。
        """
        mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{WORKER_ROOT}/mods")
        merged = {
            "instance_dir": os.environ.get(
                "SATTORI_INSTANCE_DIR", f"{WORKER_ROOT}/instances/{game_id}-recording"),
            "game_dir_src": os.environ.get("SATTORI_GAME_DIR", f"{WORKER_ROOT}/games/{game_id}"),
            "wineprefix": os.environ.get("WINEPREFIX", f"{WORKER_ROOT}/prefixes/{game_id}-wined3d-gl"),
            "injector_path": f"{mod_dir}/common/build/injector.exe",
            "hook_dll_path": f"{mod_dir}/{game_id}_replay_autoplay/build/{game_id}_hook.dll",
        }
        display = os.environ.get("SATTORI_DISPLAY", overrides.pop("display"))
        merged.update(overrides)
        return cls(game_id=game_id, pulse_sink=pulse_sink, display=display, **merged)

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
        if self.dxvk_dll_overrides:
            env["WINEDLLOVERRIDES"] = self.dxvk_dll_overrides
        # 倍速録画(Issue #288)ではMODのspeed_hack_hookがQueryPerformanceCounterの経過時間を
        # この倍率で伸ばす。起動側は`FPS_LIMIT_TARGET_HZ`(=60×倍率)だけを渡し、倍率は
        # ここで導出する——2つの値を別々に渡すと食い違ったときにゲーム進行とPresent上限・
        # 音声レートがずれ、しかもワーカーからは検知できないため、出所を1つにする。
        time_scale = recording_time_scale(env)
        if is_speedup(time_scale):
            env["SPEED_HACK_MULTIPLIER"] = f"{speedup_multiplier(time_scale):g}"
        else:
            env.pop("SPEED_HACK_MULTIPLIER", None)
        # 同期マーカー(A/V同期補正、touhou-recorder reports/88)のトリガーファイル。MOD
        # (dsound_hook/wasapi_hook)はWine内から開くのでWindows形式(Z:)のパスで渡す。
        # 等倍でも常に有効にする(start_timeの差による従来の補正は等倍でも+90〜+190ms
        # 遅れていた、reports/88)。
        from .sync_marker import trigger_path, windows_path
        env["SYNC_MARKER_TRIGGER"] = windows_path(trigger_path(self))
        return env


def with_runtime_overrides(config, env=None, log=print):
    """実行時の環境変数(録画速度・GPUの有無)に応じて`GameConfig`を調整したコピーを返す。

    タイトルごとの`record_thNN.py`は「そのタイトルでしか成り立たない値」だけを持ち、
    起動側から渡される条件による調整はここに集約する(`recording.cli.run()`が呼ぶ)。

    - **GPUワーカー(`GPU_WORKER=1`)**: GPU描画が必須ではないタイトルもGPU描画
      (Xorg+nvidia)で録画する。倍速録画はGPU描画・NVENCを前提に検証されており
      (touhou-recorder reports/89)、CPU描画(llvmpipe)では2倍速を維持できない。GPU描画面
      では終了検知用のポーリングを本番キャプチャと同じffmpegから分岐させる
      (`poll_side_stream`、無いと周期的なカクつきが出る、reports/81・89 §5.2)。
    - **倍速録画かつVsyncPatch注入タイトル(th06/th07/th10/th12)**: vpatch.iniの
      `GameFPS`を60×倍率へ、`CalcFPS`を0へ書き換える。VsyncPatchを注入したタイトルの
      フレームレートはvpatch自身のタイマーが決めており、MODのQPC偽装はexeのIATにしか
      効かないためvpatch内部の待ちには届かない(reports/89)。`CalcFPS=1`のままだと
      vpatchが画面上のfps表示を実時間で計算し、2倍速で「120fps」と表示される(reports/90)。
    """
    env = env if env is not None else os.environ
    changes = {}
    if gpu_worker(env) and not config.gpu_display:
        log("GPUワーカーのため、GPU描画(Xorg+nvidia)で録画します")
        changes.update(gpu_display=True, poll_side_stream=True)
    time_scale = recording_time_scale(env)
    if is_speedup(time_scale) and any(d.lower().startswith("vpatch_") for d in config.extra_dlls):
        game_fps = round(NATIVE_FRAME_RATE_HZ * speedup_multiplier(time_scale))
        changes["vpatch_ini_overrides"] = config.vpatch_ini_overrides + (
            ("Option", "GameFPS", str(game_fps)),
            ("Option", "CalcFPS", "0"),
        )
    return dataclasses.replace(config, **changes) if changes else config
