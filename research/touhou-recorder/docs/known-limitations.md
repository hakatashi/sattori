# 未解決・要フォローアップの既知課題

このドキュメントでは、現在判明している未解決の課題や、回避策で運用している要フォローアップ項目をまとめます。

---

### th11: ウィンドウ検出後(0,0)への強制移動の恒久対応

openboxの初期ウィンドウ配置がXVFB_SCREEN範囲外にはみ出す問題に対して、現在は事後的な「強制移動 + 座標再取得」で回避しています。ウィンドウ配置そのものを防止する恒久対応は未着手です。

- 参照レポート: `reports/36_phase36_th11_scripts25_integration_and_full_recording.md`, `reports/37_phase37_th11_aws_deployment_and_crop_bugfix.md`

### th10〜th15: 日本語テキスト輪郭のジャギー(原因判明・対策は既定で無効)

会話文・スペルカード名などの日本語テキストが、Windows実機より粗く(二値的に)表示される。フェーズ38・39ではWineのFreeTypeのAAが原因と推定していたが、フェーズ101で**WineのD3DX(d3dx9)が`D3DXLoadSurfaceFromMemory`の`D3DX_FILTER_TRIANGLE`等を実装しておらず最近傍で縮小すること**が原因と判明した(ゲームはGDIで2倍の大きさに描いた二値アルファの文字をこの関数で縮小している)。Wine masterでも未実装。

- 対策: `mods/common/d3dx_filter_hook`(`D3DX_AREA_FILTER=1`)で縮小をMOD側のテント縮小(ネイティブd3dx9のTRIANGLEに合わせたもの)に置き換えると、th13でWindows実機とほぼ同じ見た目になる。th10・th11・th12・th128・th13のExtraのフル尺で表示の崩れが無いこと、AWS(`c7i.2xlarge`、th11・th12等倍、th13 1/2倍速、各2回)で録画品質に差が無いことを確認した(reports/102)。**既定では無効**(本番での有効化は視聴確認後に判断)。th15は内部解像度1280x960では文字を等倍で転送するため対象外。
- th06〜th09(D3D8)とth20は`D3DXLoadSurfaceFromMemory`を使わないため対象外(別経路のジャギーがあるかは未調査)。
- 対策後もWindows実機とは、GDIの字形(Windowsの方が縁の画素を2〜4%多く書く)と、疑似ボールドの小さいMSゴシック(Windowsは二値の太字、WineはAAの細字)の差が残る(reports/101 9節。後者は`AntialiasFakeBoldOrItalic="n"`が候補、未検証)。
- 参照レポート: `reports/38_phase38_th11_still_detection_mask_and_font_fix.md`, `reports/39_phase39_th11_jaggy_font_investigation.md`, `reports/101_phase101_jaggy_text_d3dx_filter.md`, `reports/102_phase102_text_filter_all_titles.md`

### th07: ユーザー記録形式リプレイ（udプレフィックス）での空表示

th07のユーザー記録形式リプレイ（`ud`プレフィックス）がMODの自動操作と噛み合わず、リプレイ一覧が空表示になる問題が未解決です。

- 参照レポート: `reports/42_phase42_eu_south_2_region_migration_verification.md`, `reports/52_phase52_issue158_bad_replay_reproduction.md`

### th06c: 低速録画機能および一部内部データ取得機能の未実装

th06cは新規対応チェックリストのうち以下が未実施・未特定です：
- **低速録画機能**: Direct3D11経路のため、既存のDirect3D9用フック（`fps_limiter_hook.h`）やDirect3D8用フック（`fps_limiter_hook_d3d8.h`）が使えず、新規実装が必要です（クラウド実機検証の完了をもって録画対応完了として運用中）。
- **内部データ取得機能**: スコアのRVAは特定済みですが、ステージ番号・残機・グレイズのRVAが未特定です。ステージ番号が未取得のため、`.chapters.txt`の自動出力にも未対応です。

- 参照レポート: `reports/74`〜`reports/77`

### th09: 内部スコア変数のRVA未特定

thprac（`thprac_th09.cpp`）にスコア表示/編集UIがなく既知の手がかりがないため、プレイヤー構造体全域・弾幕マネージャ構造体・BSS領域を探索したものの、画面表示値と一致する内部スコア変数のオフセットが未特定です（残機`life`は特定・実装済み）。

- 参照レポート: `reports/68_phase68_th09_environment_and_mod_bringup.md`

### th09: (0,0)強制移動時のタイトルバー混入

th09でウィンドウ検出後に(0,0)への強制移動を行うと、録画中盤以降にタイトルバーが混入する不具合があります。現在は`recorder/games.py`のth09に`skip_origin_move_if_fits=True`を指定して移動自体をスキップして回避していますが、根本原因は未解明です。

- 参照レポート: `reports/68_phase68_th09_environment_and_mod_bringup.md`

### th07(ローカル開発機): (0,0)強制移動でウィンドウ装飾が録画に混入しテンプレート照合が不成立

ローカル開発機(HakataMatrix)でth07のフル尺録画を行うと、`move_into_screen()`の(0,0)への強制移動後に`xwininfo`が`x=0 y=0`を返すにもかかわらず、実際の録画映像にはウィンドウ装飾(タイトルバー、高さ約29px)が写り込み、画面全体が右下へずれた状態で記録されます。th09の既知不具合(上記)と同じ症状です。

この状態ではリプレイ選択画面のテンプレート照合が成立せず(実測MAD 39.12 > 閾値15.0)、リプレイが正常終了しているのに終了検知が働かず`TIMEOUT_SEC`(40分)まで録画が続きます。装飾ぶん(3, 29)をずらして切り出したフレームで再計算するとMAD 11.65〜12.75となり、閾値を下回ることを確認済みです。

- フェーズ83のA/B比較で、**この症状は旧`scripts/25`の1ファイル実装でも同様に発生する**(同一リプレイの録画フレームにタイトルバーが写り込む)ことを確認しており、モジュール分割による回帰ではありません。
- th07は640x480ウィンドウが既定のXvfb画面(800x600)に収まるため、th09/th06c/th06ncと同様に`skip_origin_move_if_fits=True`を指定すれば回避できます(フェーズ83の検証ではこの指定で終了検知が正常に働くことを確認)。ただしAWS実機を含む他環境での影響が未確認のため、既定値の変更は行っていません。
- 根本原因(`xdotool windowmove`後に`xwininfo`が実際の描画位置と異なる座標を返す条件)は未解明です。

- 参照レポート: `reports/83_phase83_recording_pipeline_modularization.md`、`reports/68_phase68_th09_environment_and_mod_bringup.md`

### GPU描画面でのウィンドウ再配置現象 (th06nc / th15)

Xorg+nvidiaによるGPU描画面において、`ensure_ready`完了直後の`xdotool windowmove 0 0`に成功しても、`WaitForStableWindow: stable`検出までの間にopenboxの初期配置座標へ戻ってしまう現象が確認されています（Xvfb環境では未確認、根本原因は未特定）。
現在は`recorder/window.py`の`recheck_origin_before_recording()`で、`gpu_display`指定タイトルに限り録画開始直前に座標を再確認・再移動する防御処理により回避しています。

- 参照レポート: `reports/82_phase82_th15_environment_and_mod_bringup.md`

### th15: 32bit DXVKのVulkan実装互換性

AWS GPU環境（GRIDドライバ）において、32bit版DXVK (v3.1.1) が`VK_KHR_load_store_op_none`非サポートと判定されて起動しない問題があります。現在はwined3d（OpenGL）経由でGPUアクセラレーションを有効化して録画しています。

- 参照レポート: `reports/82_phase82_th15_environment_and_mod_bringup.md`

### 全タイトル: 倍速録画でBGMと画面の対応が0.1〜0.2秒ずれることがある(解決済みの音ズレとは別)

従来のstart_time方式の音ズレ(等倍でも+0.09〜0.19秒、倍速で拡大)は、同期マーカー方式で解決した(A/V誤差±20ms以内、reports/88)。ただし同期マーカーでmuxした等倍録画と倍速の復元動画を照合すると、タイトルによってBGMが一定量(+0.15〜0.2秒、th07/th08/th09)遅れて見える、または時間とともに0.1〜0.4秒変化する(th06nc/th11/th128)。BGMの開始・ストリーミングがゲーム内部で実時間の遅れを含み、倍速では復元時にN倍に伸びるためと考えられる(効果音はフレーム処理から直接鳴るので影響しない)。詳細未調査。

- 参照レポート: `reports/88_phase88_av_sync_marker.md`、`reports/89_phase89_speedup_all_titles_gpu.md` §6

### 倍速録画: 配信版の変換でユニークフレームが約45/秒へ落ちる(未修正、reports/92、sattori-dev#322)

sattoriの`30874c1`(2026-10-04)で等倍化が`-r 60`から`fps=60:start_time=0`フィルタへ変わり、x11grabのptsが等間隔でない素材では約25%のフレームが失われる。th06ncの2倍速・3倍速とth07の3倍速で確認、th12の2倍速では起きない(出し分けは未調査)。g6・g6fとも同じで、重複率の検査は生映像を見るので検知できない。**倍速の品質は配信版のユニークフレーム(`scripts/81`)で評価すること。** `-r 60`に戻せば解消するが、#301(先頭の無音・映像の埋め)との両立は要確認。

### 全タイトル: 3倍速以上はx11grabのキャプチャが律速

th06〜th08・th06cはゲーム本体が180Hz・240Hzを維持できるが、録画側(x11grab)が追いつかず、復元後の落ちフレームが3倍速で1.2〜3.4%、4倍速で7〜9%になる(th06cは3.4%・8.6%、reports/90)。th15・th20はゲーム本体の単一スレッド性能も律速(th20は2倍速でも下位5%が109.7Hz、復元後1.6%)。

- 参照レポート: `reports/89_phase89_speedup_all_titles_gpu.md` §3〜§4、`reports/90_phase90_fps_display_fix_and_th06c_speedup.md` §2

### 画面上fps表示の補正はゲームバイナリ固有のRVAに依存

倍速・低速録画時に画面上のfps表示を等倍換算(60fps)にする補正(`mods/common/fps_display_hook`)は、fps計算に使われるタイマー呼び出しの戻り先RVAをハードコードしている(th06: `0x23f63`/`0x23f6e`、th08 ver1.00d: `0x46fad`/`0x46fb8`、th09: `0x31701`、th12: `0x508e8`、th14 ver1.00b: QPC戻り先`0x6ac5e`かつ呼び出し元の戻り先`0x2e4e0`、th15: QPC戻り先`0x72ccb`かつ呼び出し元の戻り先`0x33600`、th20: `0x1cb54`)。バイナリが変わると補正されず実測値(2倍速なら120fps)が表示される(録画自体には影響しない)。th10・th06はVsyncPatchの`CalcFPS=0`(倍速・低速時に`recorder/instance.py`が自動設定)が前提。th07/th09/th11/th128/th15/th06nc/th06cは倍速録画なら追加補正なしで60fps前後になる(th15の低速録画はreports/93の補正で60fps前後になる)。

- 参照レポート: `reports/90_phase90_fps_display_fix_and_th06c_speedup.md` §1

### CPU低速録画の既知の制約(reports/91)

- 処理落ちのあと、次に曲が始まるまでBGMが映像より先行する(th20 Hard 30Hzで最終面約0.5秒)。
- 20Hzは`default_max_duplicate_rate()`の閾値(76.67%)を実測80.4%が超え、正常な録画を破棄する(th14でも81.9%で再現、reports/103。`--max-duplicate-rate 95`で回避)。
- 40Hzは60fpsキャプチャだと復元の間引きで落ち16.6〜18.3%(120fpsキャプチャでth20は1.4%)。
- `recorder/`の終了検知(16秒静止)は低速でゲーム内時間が短くなる。

### th15: 倍速録画の倍率は2倍のみ推奨

1.5倍速は周期的なカクつき(3フレームに1枚の重複)と、Wineの10ms周期の端数丸め(66150Hz×10ms=661.5フレーム)と推定される0.0756%の音声ドリフトが出る。3倍・4倍速はth15本体の単一スレッド性能が律速で処理落ちする(復元後14〜20%のフレーム停止、BGMと画面が徐々にずれる)。また、`-vsync 0`(倍速時)ではNVENCの`-maxrate`が効かず、中間ファイルのビットレートが20〜44Mbpsになる。

- 参照レポート: `reports/87_phase87_th15_speedup_multiplier_comparison.md` §2〜§3, §5.1

### th06nc: `g6f.xlarge`の倍速録画は実用水準に届かない

L4の1/8スライスが律速と見られ、ゲームとキャプチャのfpsの合計が720pで約206〜221、1080pで約167〜173に収まる。NvFBCでも改善しない。未検証の手段はゲームプロセス内のキャプチャ、1.5倍速。

- 参照レポート: `reports/94_phase94_g6f_xlarge_and_nvfbc_capture.md`

### th06nc: CPU描画(BC7展開)はExtraの高密度弾幕で描画が落ちる

`c7i.2xlarge`の720p 1/2倍速はLunaticではGPU等倍と同等だが、Extraのパチュリー戦で描画が実時間約15Hzへ間引かれる(ロジックは30Hzのまま)。`c7i.4xlarge`では解消するが、Lunatic終盤は逆に2xlargeより悪く、1本ずつのため再現性は未確認。等倍は`c7i.4xlarge`でも落ち7%で、試行1回目が処理落ち早期検知で破棄される(原因未調査)。th06ncのFpsMonitorは`GetDeviceState`の回数なので描画落ちを示さない。4 vCPUや等倍では描画を省く代わりにゲーム自体が遅れ、BGMが先行する(reports/97 §8)。本番ワーカーへの組み込みは未実施。

- 参照レポート: `reports/96_phase96_th06nc_cpu_rendering_bc7.md`、`reports/97_phase97_th06nc_cpu_spot_verification.md`

### th06c・th06nc: デシンク判定が常に「検証できず」になる(sattori側、hakatashi/sattori-dev#327)

th06c・th06ncのMODは`ScoreMonitor`に`graze=-1`を書き、sattoriの`read_verified_scores()`は`graze < 0`をゴミ値として全て捨てるため、本番のデシンク判定は常にスキップされる(GPU録画も同じ)。

- 参照レポート: `reports/97_phase97_th06nc_cpu_spot_verification.md` §5

### th15・th20: CPU描画は塗りつぶし量で律速し、描画を変えずに削れる部分が無い(reports/99)

llvmpipeのラスタライズ(アルファブレンド・フィルタ付きのスプライトと加算エフェクト)そのものが律速で、処理能力はCPU量にほぼ比例する。th06ncのBC7のような遅い形式は無く、A4R4G4B4の格上げ・深度テストの間引き・等倍コピーのStretchRect化・DXVK(d3d9)はどれも効かなかった。効くのは内部解像度だけで、960x720(th15.cfgの0x1F=4、th20.cfgの0x78=4)にすると4コア8スレッドで1280x960の8コア16スレッドと同等になるが、配信の画質が下がり、終了検知の除外矩形等の座標も縮める必要がある(未実装・未採用)。

- 参照レポート: `reports/99_phase99_th15_th20_cpu_rendering_analysis.md`
