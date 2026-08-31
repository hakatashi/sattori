"""タイトルごとの差分をまとめた `GameConfig` と、その既定値の導出。

録画パイプライン本体は同じパッケージの各モジュールへ分かれている(`recording/__init__.py`)。
タイトル固有の値をなぜその値にしたのかは `worker/docs/titles/thNN.md` にある。
"""
import os
from dataclasses import dataclass, field

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
        """
        mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{WORKER_ROOT}/mods")
        defaults = {
            "instance_dir": os.environ.get(
                "SATTORI_INSTANCE_DIR", f"{WORKER_ROOT}/instances/{game_id}-recording"),
            "game_dir_src": os.environ.get("SATTORI_GAME_DIR", f"{WORKER_ROOT}/games/{game_id}"),
            "wineprefix": os.environ.get("WINEPREFIX", f"{WORKER_ROOT}/prefixes/{game_id}-wined3d-gl"),
            "injector_path": f"{mod_dir}/common/build/injector.exe",
            "hook_dll_path": f"{mod_dir}/{game_id}_replay_autoplay/build/{game_id}_hook.dll",
        }
        display = os.environ.get("SATTORI_DISPLAY", overrides.pop("display"))
        return cls(game_id=game_id, pulse_sink=pulse_sink, display=display,
                   **defaults, **overrides)

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
