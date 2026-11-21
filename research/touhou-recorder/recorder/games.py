"""タイトルごとの録画設定レジストリ。

各値の根拠(なぜその閾値・その矩形・そのフラグなのか)は、実機検証で判明した事情を
そのままコメントとして残してある。**値を変えるときは必ず該当レポートを確認すること。**
フィールドの意味そのものは`recorder/config.py`の`GameConfig`定義を参照。

タイトル別のより詳しい仕様は`docs/titles/thNN.md`にある。
"""
import dataclasses
import os

from .config import REPO, GameConfig

_TITLES = [
    GameConfig(
        game_id="th07",
        display=":97",
        wineprefix=f"{REPO}/prefixes/th07-wined3d-gl",
        instance_dir=f"{REPO}/instances/th07-multigame-recording-test",
        # フェーズ54: sattori本番が配布しているth07.exeはver1.00b(650752バイト)であり、
        # games/th07/(607744バイト、旧バージョン)とはバイナリレベルで異なることが判明した
        # (sattori側のscore_monitor移植検証で発覚)。以後のth07検証・本番録画はこちらの
        # ver1.00bを使うこと。games/th07/は検証記録として残置のみ(th08のver100d移行と同じ扱い)。
        game_dir_src=f"{REPO}/games/th07_ver100b",
        game_exe="th07.exe",
        default_replay="th7_07.rpy",
        end_template=f"{REPO}/assets/replay_end_templates/th07.png",
    ),
    GameConfig(
        game_id="th08",
        display=":99",
        wineprefix=f"{REPO}/prefixes/th08-wined3d-gl",
        instance_dir=f"{REPO}/instances/th08-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th08_ver100d",
        default_replay="th8_01.rpy",
        end_template=f"{REPO}/assets/replay_end_templates/th08.png",
    ),
    GameConfig(
        game_id="th06",
        display=":96",
        wineprefix=f"{REPO}/prefixes/th06-wined3d-gl",
        instance_dir=f"{REPO}/instances/th06-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th06",
        # ファイル名が日本語(東方紅魔郷.exe)。pgrep -x 等はプロセス名の一致にロケールを
        # 問わないため、game_exe文字列はUTF-8のまま扱ってよい。
        game_exe="東方紅魔郷.exe",
        # Linuxのcomm(/proc/PID/comm)は15バイトで切り詰められるため、UTF-8の
        # "東方紅魔郷.exe"(18バイト)は末尾の".exe"が欠落した状態("東方紅魔郷"、
        # 15バイトちょうど)で記録される。pgrep -x/pkill -xの完全一致対象は
        # こちらを使う必要がある(reports/31)。
        process_name="東方紅魔郷",
        # th06はwined3dの白画面ハング(reports/30)を回避するため、MOD本体より前に
        # ファン製VsyncPatch(vpatch_th06.dll)を同一プロセスへ注入する必要がある。
        # このDLL自体はgame_dir_srcに同梱されておりrsyncで自動コピーされるため、
        # hook_dll_srcのような明示コピーは不要。
        extra_dlls=("vpatch_th06.dll",),
        default_replay="th6_02.rpy",
        end_template=f"{REPO}/assets/replay_end_templates/th06.png",
    ),
    GameConfig(
        game_id="th11",
        display=":95",
        wineprefix=f"{REPO}/prefixes/th11-wined3d-gl",
        instance_dir=f"{REPO}/instances/th11-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th11",
        # th11のリプレイ一覧は組み込みスロット(No.01〜、ファイル名の数字で表示位置が
        # 決まる)と、右キーで切り替わる別タブのユーザーリプレイスロット(ud0000〜)に
        # 分かれている。MOD(mods/th11_replay_autoplay/dllmain.cpp)はユーザータブへ
        # 切り替えた上で先頭スロットを選ぶ固定シーケンスのため、コピー先ファイル名は
        # 元のファイル名によらず常に"th11_ud0000.rpy"に正規化する必要がある(reports/35)。
        replay_dest_filename="th11_ud0000.rpy",
        default_replay="th11_03.rpy",
        # th11の終了画面は「直前ゲームプレイ画面の凍結+Pause Menuオーバーレイ」であり、
        # th06/07/08のような内容非依存の専用リプレイ選択画面ではない(フェーズ36で撮影した
        # assets/replay_end_templates/th11.pngはこの通りスペルカード名・弾幕パターンが
        # リプレイごとに異なる背景を含んでおり、END_TEMPLATE_ROWSの前提「上部帯はリプレイ
        # 内容に依存しない」が崩れるため、テンプレート照合には不向きと判断)。よってth11は
        # end_templateを設定せず、画面静止検知のみにフォールバックする(フェーズ36の
        # フル尺録画で静止検知のみでも正しく終了を判定できることを確認済み)。
        #
        # フェーズ38: th11_ud16gm.rpyでは、Pause Menu画面自体は完全に静止する一方、現在
        # 選択中のメニュー項目(「タイトルへ戻る」等)の文字が明滅するカーソル演出だけが
        # Pause Menu表示中ずっと明滅し続け、画面静止検知のMADがわずかに閾値を超え続けて
        # 自然終了を検知できないことがある(reports/37)。この明滅は640x480原座標で
        # (70,288)-(188,318)の矩形に収まることをフレーム差分のヒートマップで確認済みのため、
        # 画面静止判定のMAD計算からこの矩形を除外する。
        still_detect_exclude_rect=(70, 288, 188, 318),
    ),
    GameConfig(
        game_id="th20",
        display=":98",
        wineprefix=f"{REPO}/prefixes/th20-wined3d-gl",
        instance_dir=f"{REPO}/instances/th20-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th20",
        # th11と同様、ユーザーリプレイタブの先頭スロットへ固定的に着地するシーケンスの
        # ため、コピー先ファイル名は常に"th20_ud0000.rpy"に正規化する(reports/44)。
        replay_dest_filename="th20_ud0000.rpy",
        default_replay="th20_01.rpy",
        # th20は内部描画解像度が960p相当(1280x960ウィンドウ)のため、既定のXvfb画面サイズ
        # (800x600)では収まらない。ウィンドウ装飾分の余白を加えたサイズを個別指定する。
        xvfb_screen="1400x1100x24",
        # th20はth125以降の仕様変更でcfg/replayの配置場所が%APPDATA%/ShanghaiAlice/th20/
        # 配下に変わっている。game_dir_src配下のcfg/replayをrsyncでインスタンスディレクトリに
        # コピーするだけではゲーム本体に読み込まれないため、起動前に別途WINEPREFIX側の
        # AppData配下へコピーする処理が必要(instance.prepare_instance()内で対応)。
        appdata_dir=f"{REPO}/prefixes/th20-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th20",
        cfg_filename="th20.cfg",
        # --thprac 指定時にゲームプロセスへアタッチする thprac 本体(games/th20/に同梱済みで、
        # rsyncでインスタンスディレクトリにコピーされる)。th20はリプレイずれ(デシンク)が
        # 発生しやすく、thpracを噛ませるとZUNの未初期化AnmVMバグ等に起因するずれが解消する
        # (reports/50)。
        thprac_exe="thprac.v2.3.0.3.exe",
        # リプレイ終了後もユーザー指定の2箇所で背景アニメーションが継続する(フェーズ44の
        # 検証時点でリザルト画面末尾に静止しない領域が2つあると事前に判明していたため、
        # th11のstill_detect_exclude_rectと同様の仕組みを複数矩形対応に拡張して両方を除外する)。
        still_detect_exclude_rect=[
            (68, 245, 68 + 406, 245 + 604),
            (851, 488, 851 + 420, 488 + 420),
        ],
    ),
    GameConfig(
        game_id="th15",
        display=":87",
        # Extraステージ等の激しいエフェクト区間でCPU描画(Xvfb)では処理落ちするため、
        # GPU描画面(Xorg+nvidia、wined3d+OpenGL経由)をデフォルトとする(reports/82)。
        # th15はモニタの現在のCRTCモードを見てウィンドウ解像度を決めるため、
        # crtc_modeを明示しないとXorg環境で1030x748に縮小される(reports/82、th06ncと同種の問題)。
        gpu_display=True,
        crtc_mode="1280x960",
        # 終了検知ポーリング(grab_frame、2秒間隔)が本録画のx11grabを毎回約0.32秒妨害し、
        # 2.28秒周期・R=0.566の「強い周期性あり」のカクつきとして実測された
        # (th06ncで発見された現象と同種、reports/81・reports/85)。低フレームレートの
        # サブストリームから終了検知を行う方式に切り替えて解消する(reports/81 §9.2)。
        poll_side_stream=True,
        wineprefix=f"{REPO}/prefixes/th15-wined3d-gl",
        instance_dir=f"{REPO}/instances/th15-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th15",
        # th11/th20と同じ「ud0000タブ」方式(MODがユーザーリプレイタブの先頭スロットへ
        # 固定的に着地するシーケンスのため、コピー先ファイル名は常に
        # "th15_ud0000.rpy"に正規化する、reports/82)。
        replay_dest_filename="th15_ud0000.rpy",
        default_replay="th15_07.rpy",
        # th15はth20と同じく内部描画解像度が960p相当(1280x960ウィンドウ)。
        xvfb_screen="1400x1100x24",
        # th15もth20と同じくth125以降の仕様変更でcfg/replayの配置場所が
        # %APPDATA%/ShanghaiAlice/th15/配下にある(prepare_instance()内で対応)。
        appdata_dir=f"{REPO}/prefixes/th15-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th15",
        cfg_filename="th15.cfg",
        # リプレイ終了後の「再生終了/ゲームを終了/もう一度再生する」メニュー全体を
        # カバーする矩形(ユーザー指定、reports/82)。
        still_detect_exclude_rect=[
            (81, 350, 81 + 389, 350 + 450),
        ],
    ),
    GameConfig(
        game_id="th10",
        display=":94",
        wineprefix=f"{REPO}/prefixes/th10-wined3d-gl",
        instance_dir=f"{REPO}/instances/th10-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th10",
        # th10のリプレイ一覧はファイル名の数字がそのままスロット番号(No.NN)に対応する方式
        # (実機確認: th10_07.rpyを配置するとNo.07に表示された)。MOD(dllmain.cpp)は
        # リプレイ一覧で「Enter=先頭スロット(No.01)を選択」という固定シーケンスのため、
        # コピー先ファイル名は常に"th10_01.rpy"に正規化する(th11/th20のud0000正規化と
        # 同じ理由、ユーザー提供の命名規則指定とも一致)。
        replay_dest_filename="th10_01.rpy",
        default_replay="th10_07.rpy",
        # ユーザー指示によりVsyncPatch(vpatch_th10.dll)を導入した状態で録画する(th06と
        # 同じ仕組み、game_dir_srcに同梱済みでrsyncによりインスタンスへ自動コピーされる)。
        # vpatch.iniの`BugFixTh10Power3`(魔理沙Bのパワー3バグ修正)は録画対象リプレイに
        # よって有効/無効を切り替える必要がある(reports/56、この録画時点では未対応)。
        extra_dlls=("vpatch_th10.dll",),
        # リプレイ選択画面は背景全体(紅葉・木の枝)が常時アニメーションしており、既定の
        # END_TEMPLATE_ROWS(上部帯全体)でのテンプレート照合では背景の変化に引きずられて
        # MADが上振れする(実機検証: 同一画面同士でもMAD≈19、無関係画面ではMAD≈31〜72)。
        # 左上の"REPLAY"見出し(前面レイヤー、内容非依存)だけに絞り込むことで安定して
        # 判別できることを確認した。end_template_mad_thresholdは同一画面同士の実測値
        # (19.37)と最も近い無関係画面の実測値(30.46, Player Select画面)の中間に設定
        # (フェーズ56、reports/56)。static detect(画面静止)はユーザー指摘の通り
        # 機能しない見込みのため使わない。
        end_template=f"{REPO}/assets/replay_end_templates/th10.png",
        end_template_rect=(0, 0, 244, 76),
        end_template_mad_threshold=25.0,
    ),
    GameConfig(
        game_id="th12",
        display=":93",
        wineprefix=f"{REPO}/prefixes/th12-wined3d-gl",
        instance_dir=f"{REPO}/instances/th12-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th12",
        # th11と同様、ユーザーリプレイタブの先頭スロットへ固定的に着地するシーケンスの
        # ため、コピー先ファイル名は常に"th12_ud0000.rpy"に正規化する(ユーザー指示)。
        replay_dest_filename="th12_ud0000.rpy",
        default_replay="th12_02.rpy",
        # ユーザー指示: この作品の終了検知は画面静止検知のみを使う(end_templateは設定しない)。
        # マスク対象領域はユーザー指定(画面左上を(0,0)として(48,214)から幅155px・高さ216px)を
        # (x1,y1,x2,y2)矩形に変換したもの。
        still_detect_exclude_rect=(48, 214, 48 + 155, 214 + 216),
        # 実機検証で判明: th12はゲームウィンドウを最小化(WM_STATE=Iconic)された状態で
        # 作成する(他タイトルでは未確認の挙動)。xwininfoのMap StateがずっとIsUnMappedの
        # ままになり、find_window()が検出できずタイムアウトする(cfgのウィンドウモード設定
        # 自体は正しく、640x480のウィンドウは生成されGetDeviceStateも60Hzで呼ばれ続けている
        # にも関わらず画面に表示されないだけ、というのを`xprop`のWM_STATE確認と
        # `xdotool windowmap`での強制表示テストで確認済み)。この対策として、ウィンドウ検出
        # ループ内でPID所有の全ウィンドウに`xdotool windowmap`を毎回発行してから
        # find_window()を呼ぶ。
        force_window_map=True,
    ),
    GameConfig(
        game_id="th13",
        display=":86",
        wineprefix=f"{REPO}/prefixes/th13-wined3d-gl",
        instance_dir=f"{REPO}/instances/th13-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th13",
        # th13はth125以降と同じくcfg/replayを%APPDATA%/ShanghaiAlice/th13/配下から読む。
        # ユーザーリプレイタブの先頭スロットへ固定的に着地するため"th13_ud0000.rpy"に正規化する。
        replay_dest_filename="th13_ud0000.rpy",
        default_replay="th13_02.rpy",
        appdata_dir=f"{REPO}/prefixes/th13-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th13",
        cfg_filename="th13.cfg",
        # ユーザー指定: 画面静止検知を使い、(48,220)から159x212の領域を除外する。
        still_detect_exclude_rect=(48, 220, 48 + 159, 220 + 212),
    ),
    GameConfig(
        game_id="th14",
        display=":85",
        wineprefix=f"{REPO}/prefixes/th14-wined3d-gl",
        instance_dir=f"{REPO}/instances/th14-multigame-recording-test",
        # ver1.00b(CDリッピング+公式アップデータ)。games/th14_steamはSteam版(reports/04)で別物。
        game_dir_src=f"{REPO}/games/th14",
        # th13/th15と同じ「ud0000タブ」方式(ユーザー指定、reports/103)。
        replay_dest_filename="th14_ud0000.rpy",
        default_replay="th14_22.rpy",
        # th15/th20と同じく内部描画解像度が960p(1280x960ウィンドウ)。
        xvfb_screen="1400x1100x24",
        # --gpu-display(Xorg+NVIDIA)で録るときのCRTCモード。1280x960だとウィンドウ装飾込みで
        # 画面に収まらず、ウィンドウが1280x940に縮む(reports/103)。Xvfbでは使われない。
        crtc_mode="1400x1050",
        # cfg/replayは%APPDATA%/ShanghaiAlice/th14/配下から読む。
        appdata_dir=f"{REPO}/prefixes/th14-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th14",
        cfg_filename="th14.cfg",
        # 1280x960では終了検知の個別x11grabが本録画を周期的に妨害する(th15で実測、
        # reports/81・85)ため、サブストリーム方式にする。
        poll_side_stream=True,
        # ユーザー指定: 画面静止検知を使い、(85,426)から295x429の領域を除外する。
        still_detect_exclude_rect=[
            (85, 426, 85 + 295, 426 + 429),
        ],
    ),
    GameConfig(
        game_id="th09",
        display=":92",
        wineprefix=f"{REPO}/prefixes/th09-wined3d-gl",
        instance_dir=f"{REPO}/instances/th09-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th09",
        # th11/th12/th20と同じ「ud0000タブ」方式(ユーザー指示、フェーズ68)。
        replay_dest_filename="th9_ud0000.rpy",
        default_replay="th9_ud5615.rpy",
        # ユーザー申告どおりテンプレート照合が有効(th06/07/08と同じ世代のエンジンで、
        # リプレイ再生後に「映花一覧」リプレイ選択画面へ戻る)。フェーズ68でMatchリプレイの
        # フル尺録画から実機取得したテンプレート。既定のEND_TEMPLATE_ROWS(上部1/3)は
        # "No.01"等の一覧行まで含んでしまい、一覧の"0000"スロット(スコア・日付表示)は
        # テストしたリプレイ内容に依存して変化するため、th10と同様に内容非依存の見出し
        # 「映花一覧」部分だけに絞り込む。
        end_template=f"{REPO}/assets/replay_end_templates/th09.png",
        end_template_rect=(0, 0, 230, 88),
        # th09は健全な状態でもGetDeviceStateのポーリング周波数がタイトル画面〜通常プレイ中を
        # 通して100〜190Hz程度に達し(実機確認、動画側は正しく60fpsで描画されておりfps暴走では
        # ない)、既定の100Hz閾値では誤検知して録画が早期打ち切りされる。他タイトルで実証済みの
        # 暴走時(th08のVsyncPatch未導入時等)はこれを大きく超える値になるため、300Hzへ緩和
        # しても本来の異常検知能力は保持される(フェーズ68)。
        fps_runaway_hz_threshold=300.0,
        skip_origin_move_if_fits=True,
    ),
    GameConfig(
        game_id="th128",
        display=":91",
        wineprefix=f"{REPO}/prefixes/th128-wined3d-gl",
        instance_dir=f"{REPO}/instances/th128-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th128",
        # th11/th12/th20と同じ「ud0000タブ」方式(ユーザー指示)。
        replay_dest_filename="th128_ud0000.rpy",
        default_replay="th128_ud0000.rpy",
        # ユーザー指示によりVsyncPatch(vpatch_th128.dll)一式を同梱しているが、現時点では
        # VsyncPatchなしでの動作を優先し、必要になった場合のみextra_dllsへ追加する
        # (th06/th10と同じ仕組み)。
        # th128はth20/th125以降と同じ仕様変更で、cfg/replayの配置場所が
        # %APPDATA%/ShanghaiAlice/th128/配下にある(th128.exeの文字列"APPDATA"/
        # "\\ShanghaiAlice"/"\\th128"から確認、../sattori/packages/replay-parser/src/games/
        # th128.tsのコメントとも整合)。
        appdata_dir=f"{REPO}/prefixes/th128-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th128",
        cfg_filename="th128.cfg",
        # 終了検知はユーザー申告どおりテンプレート照合を使う(th06/07/08/09/10と同じ世代の
        # リプレイ選択画面に戻る挙動を想定)。テンプレート画像はフル尺録画の実機取得後に
        # assets/replay_end_templates/th128.pngとして追加する(現時点では画面静止検知に
        # フォールバック)。
        #
        # ユーザー報告: リプレイファイルを選択すると再生が始まらずフリーズする
        # (0 GetDeviceState呼び出し/秒、CPU約103%で無限ループ、ユーザー実機のWindowsでも
        # 再現するゲーム本体側の既知バグとのこと)。thprac経由で起動すると実機で解消した
        # とのことなので、th20と同じ--thprac機構(process.attach_thprac、reports/50)を使う。
        # games/th128/に同梱済みでrsyncによりインスタンスディレクトリへ自動コピーされる。
        thprac_exe="thprac.v2.3.0.3.exe",
    ),
    GameConfig(
        game_id="th06c",
        display=":89",
        wineprefix=f"{REPO}/prefixes/th06c-wined3d-gl",
        instance_dir=f"{REPO}/instances/th06c-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th06c",
        # th06c.exeはPE32+(x86-64)。既存タイトル用の32bit injector.exeではCreateProcess自体は
        # 通るがDLL注入に失敗するため、64bit版を使う
        # (mods/th06c_replay_autoplay/build_mingw.sh でビルド、reports/74)。
        injector="injector64.exe",
        # th06cはSteamworks APIの初期化に失敗すると即exit(255)する。Xvfb環境ではSteam
        # クライアントを常駐させられないため、9関数だけを実装したスタブDLLを正規の
        # steam_api64.dllへ上書きコピーする(reports/74)。rsyncでgames/th06c/の正規DLLが
        # 入った後に上書きする必要があるので、hook_dll_srcと同じ「明示コピー」の仕組みに載せる。
        extra_files=(
            (f"{REPO}/mods/th06c_steam_stub/build/steam_api64.dll", "steam_api64.dll"),
        ),
        # 起動ダイアログ(クラス#32770、194x317)をゲームウィンドウと誤検出しないよう、
        # ウィンドウ検出の最小サイズを640x480ウィンドウに合わせて引き上げる。
        window_min_size=(600, 400),
        # th06cで「検出後(0,0)への強制移動」を行うと、xwininfoは移動後の座標を(0,0)と
        # 報告するのに、実際の描画内容はウィンドウ装飾(タイトルバー)分下にずれたままになり、
        # 録画映像にタイトルバーが写り込む(フェーズ74で実機再現。th09の既知不具合と同じ症状、
        # reports/68)。既定の800x600では640x480ウィンドウがopenboxの初期配置(x=77,y=44)で
        # 画面内に収まらず移動が必須になってしまうため、Xvfbの画面自体を大きくして移動不要に
        # した上で skip_origin_move_if_fits で移動をスキップする。
        xvfb_screen="1400x1100x24",
        skip_origin_move_if_fits=True,
        default_replay="th6_01.rpy",
        # th06cはリプレイ終了後、内容非依存の「瀟洒なるリプレイを見よう!」画面(リプレイ
        # 選択画面)へ戻る。この画面は背景も含めて完全に静止しており(6秒離れたフレーム同士の
        # MADが0.001)、th10/th09のような背景アニメーションの問題は無い。ただし一覧行
        # (y≈155-185)はリプレイの内容(No./Name/Rank)によって変わる(Hard版とExtra版の
        # 同領域のMADは3.01)ため、end_template_rectで「タイトル文言 + 列見出し」の帯だけに
        # 絞り込む。
        #
        # 実測(フェーズ76): この帯でのMADは、別リプレイのリプレイ選択画面同士で0.00、
        # ゲームプレイ中のフレームとは35〜114。Hard(1568秒)・Extra(642秒)の録画全体を
        # 1秒刻みで走査しても、再生中(録画開始15秒〜終了検知まで)に閾値15.0を下回る
        # フレームは1件も無かった。
        end_template=f"{REPO}/assets/replay_end_templates/th06c.png",
        end_template_rect=(20, 78, 560, 152),
    ),
    GameConfig(
        # th06nc(東方紅魔郷: New Classic)はth06cと同系のDXライブラリ製64bitエンジンだが、
        # Xvfb+llvmpipe(ソフトウェア描画)では1280x720でも9fps程度しか出ず録画に耐えない
        # (reports/78 §5)。gpu_display指定時は Xvfb ではなく headless weston +
        # rootful Xwayland のGPU描画面を立てる(§6)。
        game_id="th06nc",
        display=":88",
        gpu_display=True,
        wineprefix=f"{REPO}/prefixes/th06nc-wined3d-gl",
        instance_dir=f"{REPO}/instances/th06nc-multigame-recording-test",
        game_dir_src=f"{REPO}/games/th06nc",
        # th06cと同じくPE32+(x86-64)。injector・Steamworks APIスタブはth06cと共用する。
        injector="injector64.exe",
        # extra_files: rsync後に上書きするファイル。
        #  - steam_api64.dll: Steamworks APIスタブ(th06cのものがそのまま通用する、reports/78 §3)
        #  - th06.env: ウィンドウ解像度設定。ゲームは終了時にこのファイルを書き戻すため、
        #    毎回コピーし直さないと解像度が意図せず変わる。既定は720p。
        #    1080pで検証したい場合は TH06NC_ENV_FILE=games/th06nc/th06.env.1080p を指定する。
        extra_files=(
            (f"{REPO}/mods/th06c_steam_stub/build/steam_api64.dll", "steam_api64.dll"),
            (os.environ.get("TH06NC_ENV_FILE", f"{REPO}/games/th06nc/th06.env.720p"), "th06.env"),
        ),
        # 1280x720(720p)・1920x1080(1080p)いずれのウィンドウ+装飾も収まるサイズ。
        xvfb_screen="2200x1400x24",
        window_min_size=(600, 400),
        # th06c/th09と同じく、(0,0)への強制移動は録画にタイトルバーが写り込む不具合を
        # 誘発しうるため、画面内に収まっていれば移動しない。
        skip_origin_move_if_fits=True,
        default_replay="th6_01.rpy",
        # 【処理落ち早期検知の誤検知対策】th06ncは1280x720の16:9画面で、左のアートワーク・
        # 右のサイドバー・外周の装飾枠が静止しており、実際に動くプレイフィールドは画面中央の
        # x=352..934 だけである。全画面MADだとプレイフィールドの動きが薄まり、正常な60fps
        # 再生でも0.15秒間隔のMADがSTILL_MAD_THRESHOLD(2.0)を下回る(フェーズ79実測:
        # 全画面では62%のサンプルが閾値未満 -> dup_fraction 0.89で誤って早期終了。
        # プレイフィールドのみなら0%)。左右の静止領域をstutter probeのMAD計算から除外する。
        stutter_probe_exclude_rect=[(0, 0, 352, 720), (934, 0, 1280, 720)],
        # 上の矩形は720p(1280x720)のウィンドウで目視して決めたもの。
        # TH06NC_ENV_FILE=games/th06nc/th06.env.1080p で1080p録画する場合は実ウィンドウ
        # サイズへ比例拡大する必要がある(vision.scale_exclude_rects)。
        exclude_rect_base=(1280, 720),
        # ステージ開始直後など弾がほとんど無い区間では、プレイフィールドのみでも17秒区間の
        # 5%程度は閾値未満になる。バーストが偶然固まったときの誤検知を避けるため、
        # 既定の0.7より緩い閾値にする。
        stutter_dup_fraction_threshold=0.9,
        # リプレイ終了検知は当面は画面静止検知のみ(テンプレートはフル尺録画後に取得する)。
        # 【重要】終了検知のフレーム取得を、別プロセスのx11grabではなく録画用ffmpegの
        # サブ出力から読む。th06ncは1280x720と既存タイトル(640x480)の3倍のピクセル数が
        # あり、2秒ごとのgrab_frame(約0.32秒)が本録画のx11grabを周期的に妨害して
        # 「数秒ごとに数フレーム飛ぶ」カクつきを起こす(フェーズ81で実測、2.32秒周期・
        # 実効fps 57.96)。詳細: reports/81
        poll_side_stream=True,
    ),
]

GAME_CONFIGS = {config.game_id: config for config in _TITLES}


def game_ids():
    """対応済みタイトルのID一覧(CLIの--gameの選択肢)。定義順で返す。"""
    return list(GAME_CONFIGS)


def load_game_config(game_id, **overrides):
    """タイトルIDから`GameConfig`を得る。`overrides`があればその場で差し替える
    (検証で一時的に閾値や出力先を変えたいときに使う)。"""
    if game_id not in GAME_CONFIGS:
        raise KeyError(f"未対応のタイトルです: {game_id} (対応: {', '.join(game_ids())})")
    config = GAME_CONFIGS[game_id]
    if not overrides:
        return config
    return dataclasses.replace(config, **overrides)
