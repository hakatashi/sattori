# reports/ インデックス

各フェーズの調査・検証記録の一覧。詳細な経緯・データは各ファイルを参照。現在も有効な運用ルールは`AGENTS.md`にまとまっているので、作業前にはまずそちらを確認すること。

- [`latest.md`](latest.md) — Linux/Wine PoCの総括レポート(MOD開発着手前時点)

## フェーズ一覧

| # | レポート | 概要 |
|---|---|---|
| 00 | [phase0_environment](00_phase0_environment.md) | 環境確認(Xvfb/wine動作確認) |
| 01 | [phase1_th06_baseline](01_phase1_th06_baseline.md) | th06でwined3d/DXVKの切り分け |
| 02 | [phase2_th07_xvfb_success](02_phase2_th07_xvfb_success.md) | th07のXvfb動作成功 |
| 03 | [phase3_input_reliability](03_phase3_input_reliability.md) | 入力オートメーション問題(xdotool方式の限界) |
| 04 | [phase4_d3d9_software_rendering](04_phase4_d3d9_software_rendering.md) | th08(D3D9)成功、th13のSteam DRM問題判明 |
| 05 | [phase5_parallel_execution](05_phase5_parallel_execution.md) | 並列実行の安定上限(2インスタンス)の発見 |
| 06 | [replay_automation_mod_feasibility](06_replay_automation_mod_feasibility.md) | リプレイ自動再生MODの実現可能性調査 |
| 07 | [phase7_th07_replay_autoplay_mod](07_phase7_th07_replay_autoplay_mod.md) | th07向けリプレイ自動再生MOD実装 |
| 08 | [phase8_th08_replay_autoplay_mod](08_phase8_th08_replay_autoplay_mod.md) | th08向けMOD移植・fps依存バグ修正 |
| 09 | [phase9_linux_wine_mod_verification](09_phase9_linux_wine_mod_verification.md) | Linux/Wine環境でのMOD動作検証、フルスクリーンハングの発見 |
| 10 | [phase10_audio_capture_verification](10_phase10_audio_capture_verification.md) | 音声キャプチャ(PulseAudio)の実現可能性検証 |
| 11 | [phase11_e2e_replay_recording](11_phase11_e2e_replay_recording.md) | リプレイ全編録画・終了自動検知の実装 |
| 12 | [phase12_stutter_root_cause_and_fix](12_phase12_stutter_root_cause_and_fix.md) | 録画処理落ちの原因調査(暫定、フェーズ13で真因を訂正) |
| 13 | [phase13_recording_quality_improvements](13_phase13_recording_quality_improvements.md) | 録画品質改善(終了検知再設計・フォント・マウスカーソル等) |
| 14 | [phase14_still_detection_threshold_fix](14_phase14_still_detection_threshold_fix.md) | 終了検知の誤検知修正(MAD閾値10.0→2.0) |
| 15 | [phase15_cloud_deployment_gcp](15_phase15_cloud_deployment_gcp.md) | GCPクラウド環境での動作検証・コスト試算 |
| 16 | [phase16_cloud_deployment_aws](16_phase16_cloud_deployment_aws.md) | AWSクラウド環境での動作検証(EC2 Spot + CloudFront) |
| 17 | [phase17_instance_type_and_spot_fleet_optimization](17_phase17_instance_type_and_spot_fleet_optimization.md) | AWS EC2インスタンスタイプ比較・複数AZ Spot Fleet検証 |
| 18 | [phase18_watermark_overlay_verification](18_phase18_watermark_overlay_verification.md) | ウォーターマーク合成のffmpeg実装検証 |
| 19 | [phase19_watermark_aws_quality_verification](19_phase19_watermark_aws_quality_verification.md) | ウォーターマーク合成のAWSレンダリング品質検証 |
| 20 | [phase20_sattori_production_ecs_agent_contention](20_phase20_sattori_production_ecs_agent_contention.md) | sattori本番環境でのECSエージェント競合による重複フレーム悪化の特定 |
| 21 | [phase21_upscale_to_720p_verification](21_phase21_upscale_to_720p_verification.md) | 720pアップスケール(同時録画 vs 録画後変換)の検証 |
| 22 | [phase22_th08_e2e_recording_verification](22_phase22_th08_e2e_recording_verification.md) | th08 E2E録画品質検証(cfgフラグ反転・fps暴走の発見) |
| 23 | [phase23_th08_ver100d_vsync_fix](23_phase23_th08_ver100d_vsync_fix.md) | th08のfps暴走の根本対応(公式アップデータver1.00dへの更新) |
| 24 | [phase24_th08_aws_deployment_verification](24_phase24_th08_aws_deployment_verification.md) | th08のAWS実機検証(重複フレーム90%超問題の発覚) |
| 25 | [phase25_th07_th08_aws_comparison](25_phase25_th07_th08_aws_comparison.md) | th07/th08のAWS比較、問題がth08固有と確定 |
| 26 | [phase26_th08_aws_audio_capture_root_cause](26_phase26_th08_aws_audio_capture_root_cause.md) | th08 AWS重複フレーム問題の真因特定(x11grab/pulse同時取り込み)と修正 |
| 27 | [phase27_th08_alternative_instance_type_verification](27_phase27_th08_alternative_instance_type_verification.md) | th08代替インスタンスタイプ実機検証 |
| 28 | [phase28_th08_av_sync_fix](28_phase28_th08_av_sync_fix.md) | th08 AWS録画のAV同期(約700ms音ズレ)の根本原因特定と修正 |
| 29 | [phase29_th08_docker_font_mojibake](29_phase29_th08_docker_font_mojibake.md) | th08本番録画の日本語文字化けの原因特定と修正 |
| 30 | [phase30_th06_rendering_fix](30_phase30_th06_rendering_fix.md) | th06のwined3d白画面ハング解消 |
| 31 | [phase31_th06_e2e_recording_verification](31_phase31_th06_e2e_recording_verification.md) | th06向けリプレイ自動再生MOD実装・E2E録画検証 |
| 32 | [phase32_th06_aws_deployment_verification](32_phase32_th06_aws_deployment_verification.md) | th06のAWS実機検証 |
| 33 | [phase33_replay_end_detection_false_positive_fix](33_phase33_replay_end_detection_false_positive_fix.md) | リプレイ終了検知の誤検知修正(テンプレート画像照合の併用) |
| 34 | [phase34_end_detection_latency_and_cross_replay_validation](34_phase34_end_detection_latency_and_cross_replay_validation.md) | 終了検知の高速化・複数リプレイでの動作確認 |
| 35 | [phase35_th11_wine_investigation](35_phase35_th11_wine_investigation.md) | th11のWine環境動作検証、`GetKeyboardState`ポーリング仕様の発見 |
| 36 | [phase36_th11_scripts25_integration_and_full_recording](36_phase36_th11_scripts25_integration_and_full_recording.md) | th11の`scripts/25`統合・フル尺録画 |
| 37 | [phase37_th11_aws_deployment_and_crop_bugfix](37_phase37_th11_aws_deployment_and_crop_bugfix.md) | th11のAWS実機検証・クロップ座標バグ修正 |
| 38 | [phase38_th11_still_detection_mask_and_font_fix](38_phase38_th11_still_detection_mask_and_font_fix.md) | th11のPause Menu静止検知誤動作の修正・MS明朝フォント修正 |
| 39 | [phase39_th11_jaggy_font_investigation](39_phase39_th11_jaggy_font_investigation.md) | th11の文字輪郭ジャギー問題の追加調査(未解決のまま結論) |
| 40 | [phase40_th11_instance_spec_investigation](40_phase40_th11_instance_spec_investigation.md) | th11インスタンススペック調査(8vCPU以上が必須と判明) |
| 41 | [phase41_parallel_recording_pulseaudio_isolation](41_phase41_parallel_recording_pulseaudio_isolation.md) | 並列録画時のPulseAudio音声分離(専用null-sink方式)の実証 |
| 42 | [phase42_eu_south_2_region_migration_verification](42_phase42_eu_south_2_region_migration_verification.md) | AWSリージョン移行(us-east-1→eu-south-2)事前検証 |
| 43 | [phase43_eu_south_2_additional_instance_type_verification](43_phase43_eu_south_2_additional_instance_type_verification.md) | eu-south-2での追加インスタンスタイプ検証(th08/th11) |
| 44 | [phase44_th20_environment_and_mod_bringup](44_phase44_th20_environment_and_mod_bringup.md) | th20の環境構築・自動化MOD実装、dinput_hook共通バグの発見・修正 |
| 45 | [phase45_th20_pipeline_integration_and_recording](45_phase45_th20_pipeline_integration_and_recording.md) | th20の`scripts/25`統合・フル尺録画 |
| 46 | [phase46_th20_aws_eu_south_2_instance_spec_verification](46_phase46_th20_aws_eu_south_2_instance_spec_verification.md) | th20のAWS実機検証(推奨インスタンスタイプ`.4xlarge`帯の確定) |
| 47 | [phase47_th20_slowmotion_timescale_poc](47_phase47_th20_slowmotion_timescale_poc.md) | th20のスローモーション化によるCPU負荷削減PoC |
| 48 | [phase48_th20_fps_display_correction](48_phase48_th20_fps_display_correction.md) | th20スロー化録画のfps表示補正 |
| 49 | [phase49_stage_start_timestamp_detection](49_phase49_stage_start_timestamp_detection.md) | 各ステージ開始時刻の自動検出・チャプター出力の実装 |
| 50 | [phase50_th20_thprac_replay_desync_fix](50_phase50_th20_thprac_replay_desync_fix.md) | th20のthprac導入によるリプレイデシンク対策 |
| 51 | [phase51_home_worker_thermal_throttling](51_phase51_home_worker_thermal_throttling.md) | sattori本番環境の処理落ち原因調査(サーマルスロットリング特定) |
| 52 | [phase52_issue158_bad_replay_reproduction](52_phase52_issue158_bad_replay_reproduction.md) | sattori-dev#158の不良リプレイ(デシンク・非再生)実例の再現検証 |
| 53 | [phase53_score_monitor_all_titles](53_phase53_score_monitor_all_titles.md) | スコア監視機能のth06/07/08/11への横展開、記録スコアとの一致検証(th07のRVAは後にフェーズ54で訂正) |
| 54 | [phase54_th07_ver100b_reverification](54_phase54_th07_ver100b_reverification.md) | th07のゲームデータ差異(ver1.00b)発覚によるMOD・RVAの修正と再検証 |
| 55 | [phase55_wine_cleanup_finally_hardening](55_phase55_wine_cleanup_finally_hardening.md) | ホストsystemdハングインシデントを受けたwineserver/winedevice後片付けのtry/finally化 |
| 56 | [phase56_th10_environment_and_mod_bringup](56_phase56_th10_environment_and_mod_bringup.md) | th10の環境構築・自動操作MOD実装、メニュー操作シーケンスの確立(フル尺録画は次フェーズ) |
| 57 | [phase57_th10_fulllength_recording_and_score_verification](57_phase57_th10_fulllength_recording_and_score_verification.md) | th10のフル尺録画検証(通常・Extra両方)、stage RVA誤認の訂正、記録スコアとの完全一致検証 |
| 58 | [phase58_th10_bugmari_vpatch_verification](58_phase58_th10_bugmari_vpatch_verification.md) | th10「バグマリ」修正オプション(BugFixTh10Power3)の設定不一致によるリプレイずれを4パターン実機検証 |
| 59 | [phase59_th10_timing_tuning_and_slowmotion](59_phase59_th10_timing_tuning_and_slowmotion.md) | th10のメニュー操作タイミング短縮、低速録画機能(fps_limiter_hook/dsound_hook)の実装・実機検証 |
| 60 | [phase60_th10_aws_cloud_verification](60_phase60_th10_aws_cloud_verification.md) | th10のAWSクラウド実機検証(c7i.xlarge、フル尺録画で重複フレーム率1.4〜2.3%を確認)、新規対応チェックリスト完了 |
| 61 | [phase61_th12_environment_and_mod_bringup](61_phase61_th12_environment_and_mod_bringup.md) | th12の環境構築・自動操作MOD実装、入力注入方式の誤り(GetKeyboardState→GetDeviceState)とウィンドウ最小化不具合を発見・修正(フル尺録画は次フェーズ) |
| 62 | [phase62_th12_fulllength_recording_and_score_verification](62_phase62_th12_fulllength_recording_and_score_verification.md) | th12のフル尺録画検証(通常・Extra両方)、記録スコア完全一致確認、Extraステージでの処理落ち(重複フレーム率26.2%)を発見 |
| 63 | [phase63_th12_slowmotion_recording_verification](63_phase63_th12_slowmotion_recording_verification.md) | th12の低速録画機能(fps_limiter_hook/dsound_hook)実装・実機検証、1/2倍速でExtraステージの処理落ちが解消することを確認 |
| 64 | [phase64_th12_stutter_root_cause_and_fps_display_and_overflow_bug](64_phase64_th12_stutter_root_cause_and_fps_display_and_overflow_bug.md) | Extraステージ処理落ちの真因がmongod競合と特定、低速録画fps表示補正(fps_display_hookの複数タイトル対応化)、スコア表示オーバーフローバグのVsyncPatch修正を実機確認 |
| 65 | [phase65_th12_aws_cloud_verification](65_phase65_th12_aws_cloud_verification.md) | th12のAWSクラウド実機検証(c7i.xlarge、通常・Extra両方で重複フレーム率2.0%以下を確認)、新規対応チェックリスト全項目完了 |
| 66 | [phase66_th12_2xlarge_comparison_and_stutter_reanalysis](66_phase66_th12_2xlarge_comparison_and_stutter_reanalysis.md) | ユーザー指摘(局所的fps半減)を受けc7i.2xlargeで比較録画、1秒単位の生存フレーム分析で「半減」区間は会話シーン・終了後静止画面の誤検知と判明、実プレイ中の半減は未検出 |
| 67 | [phase67_th12_theoretical_length_comparison_and_lunatic_verification](67_phase67_th12_theoretical_length_comparison_and_lunatic_verification.md) | 「重複フレーム率」がゲーム全体の間延び型処理落ちを見逃す限界を発見、理論尺比較でxlargeの隠れた処理落ち(+2.11%)を特定しc7i.2xlarge推奨に訂正、Lunatic難易度でのフル尺検証(理論尺超過+0.21%)完了 |
| 68 | [phase68_th09_environment_and_mod_bringup](68_phase68_th09_environment_and_mod_bringup.md) | th09(東方花映塚、対戦形式)の環境構築・自動操作MOD実装、Matchモード実機動作確認、残機(life)RVA特定・score_monitor拡張(scoreWidth=0対応)、scripts/25統合・ウィンドウ座標バグ修正・Direct3D8版低速録画実装・AWS実機検証(Match/Story/Extra全て良好)、スコアRVAは未特定のまま次フェーズへ持ち越し |
| 69 | [phase69_th09_slowmo_fps_display_correction](69_phase69_th09_slowmo_fps_display_correction.md) | th09の低速録画fps表示補正を実装(timeGetTimeベース、th20と異なるAPI)、低速録画時のstutter probe誤検知を修正、低速録画・等倍変換データを整備 |
| 70 | [phase70_th128_environment_and_mod_bringup](70_phase70_th128_environment_and_mod_bringup.md) | th128(妖精大戦争)の環境構築・自動操作MOD実装、リプレイ選択直後フリーズ(実機でも再現する既知バグ)をthprac併用で回避、score/motivationのRVA実機検証(フル尺録画は次フェーズ) |
| 71 | [phase71_th128_fulllength_recording_and_score_verification](71_phase71_th128_fulllength_recording_and_score_verification.md) | th128のフル尺録画検証(通常・Extra両方、重複フレーム率1.1%/2.2%、理論尺超過+0.25%/+0.30%)、記録スコアとの完全一致確認、終了画面がth11と同じ内容依存型と判明しテンプレート照合不採用に訂正 |
| 72 | [phase72_th128_slowmotion_recording_verification](72_phase72_th128_slowmotion_recording_verification.md) | th128の低速録画(30fps)実機検証、`--thprac`併用時にthpracアタッチのタイムアウトが低速録画でスケールされていないバグを発見・修正(全タイトル共通の潜在バグ) |
| 73 | [phase73_th128_aws_cloud_verification](73_phase73_th128_aws_cloud_verification.md) | th128のAWSクラウド実機検証、c7i.xlargeではExtraステージで処理落ち(理論尺超過+4.16%)を検出しc7i.2xlarge(+0.71%)を推奨、entrypoint_multigame.pyに--thprac対応追加、新規対応チェックリスト全項目完了 |
| 74 | [phase74_th06c_environment_and_mod_bringup](74_phase74_th06c_environment_and_mod_bringup.md) | th06c(東方紅魔郷: Classic、64bit・DXライブラリ系)の環境構築、Steamworks APIスタブによるSteamクライアント要求の回避、起動時解像度ダイアログの自動操作、GetProcAddressフック方式の入力注入MOD実装、リプレイ再生の実機確認 |
| 75 | [phase75_th06c_fulllength_recording_and_score_verification](75_phase75_th06c_fulllength_recording_and_score_verification.md) | th06cのscripts/25統合、フル尺録画検証(Hard・Extra)、スコアRVA特定と記録スコア完全一致確認、メニューカーソル位置を読んでReplayに到達する方式への変更(クリーンセーブ対応)、th6_ud0000.rpy認識確認、音ズレ検証 |
| 76 | [phase76_th06c_end_detection_template](76_phase76_th06c_end_detection_template.md) | th06cのリプレイ終了検知をテンプレート照合に対応(録画1本あたり約16秒短縮)、検知方式ラベルが常に「画面静止検知」と表示される全タイトル共通の表示バグを修正 |
| 77 | [phase77_th06c_aws_cloud_verification](77_phase77_th06c_aws_cloud_verification.md) | th06cのAWSクラウド実機検証(c7i.xlarge、Hard・Extraとも理論尺超過なしを確認)、新規対応チェックリスト完了(低速録画・一部RVA特定はユーザー指示によりスコープ外) |
| 78 | [phase78_th06nc_environment_and_gpu_rendering](78_phase78_th06nc_environment_and_gpu_rendering.md) | th06nc(東方紅魔郷: New Classic)の環境構築、llvmpipeでは9fpsしか出ないためGPU描画面(headless weston + rootful Xwayland)を新設、リプレイ自動再生MOD実装、scripts/25統合、ホストGPUハングによる中断 |
| 79 | [phase79_th06nc_amdgpu_fence_hang](79_phase79_th06nc_amdgpu_fence_hang.md) | th06nc実行のたびにホストGPU(Radeon VII)が固着する問題の切り分け(amdgpu_vm_finiでのdma_fence待ち)、ROCm仮説の棄却、stutter probeのマスク対応、スコアRVA特定(内部値0x004F2798)とデシンク判定の実機検証 |
| 80 | [phase80_th06nc_dxvk_and_aws_gpu_survey](80_phase80_th06nc_dxvk_and_aws_gpu_survey.md) | DXVK(D3D11→Vulkan)経路でもamdgpuフェンス固着が同様に発生することを確認(描画API非依存)、th06ncの検証をAWS GPUスポットインスタンスへ移す方針決定、eu-south-2のGPUインスタンス調査(g6f.xlargeが有力、スポット$0.062/h) |
| 81 | [phase81_th06nc_aws_gpu_bringup](81_phase81_th06nc_aws_gpu_bringup.md) | th06ncのAWS GPUスポットインスタンス(g6f)構築・DXVK経路でのフル尺録画検証、CRTCモード指定による1080p対応、空録画・重複フレーム率計測不能時の誤判定バグ修正 |
| 82 | [phase82_th15_environment_and_mod_bringup](82_phase82_th15_environment_and_mod_bringup.md) | th15(東方紺珠伝)の環境構築・自動操作MOD実装、th15はGetKeyboardStateではなくGetDeviceState(DirectInput)でポーリングするというth20/th11と異なる仕様を発見・実機確認 |
| 83 | [phase83_recording_pipeline_modularization](83_phase83_recording_pipeline_modularization.md) | 1,933行に肥大化した`scripts/25_record_replay_e2e_multigame.py`を`recorder/`パッケージ(17モジュール)へ分割、タイトル設定のdataclass化・実行モードの分離、CLI互換シムを維持、新旧A/B録画で品質同等を確認、th07フル尺録画で終了検知・mux・チャプター出力まで実機検証(th07のウィンドウ装飾混入という旧実装からの既存不具合も発見) |
| 84 | [phase84_gpu_nvenc_encoding_offload_verification](84_phase84_gpu_nvenc_encoding_offload_verification.md) | EC2 GPUインスタンス(us-west-2、g6f.xlarge)でのNVENCエンコードオフロード検証(issue #2)、標準apt版ffmpeg+GRIDドライバのみで追加ビルド不要でh264_nvenc動作確認、素のUbuntu24.04コンテナからも`--gpus all`のみで動作、CPU負荷を60fpsで21%・倍速相当120fpsで50%削減、配信用変換のCPU時間58%削減、cq/crf値の単純比較不可でレート制御併用が必要と判明 |
| 85 | [phase85_th15_double_speed_recording_verification](85_phase85_th15_double_speed_recording_verification.md) | th15の倍速録画技術検証(issue #1)、QueryPerformanceCounter偽装によるspeed_hack_hook新規実装、CPU競合(libx264エンコードスレッド)がカクつきの主因でGPU使用率は終始0%と判明、g6f.2xlarge(8vCPU)なら2倍速が品質面で完全に実用的と確認、x11grabキャプチャfps固定・タイムスタンプ異常・stutter probe誤検知・閾値計算バグ(倍速側で負値化)の4件を発見・修正、音声復元はatempoでなくasetrateが必須と判明 |
| 86 | [phase86_doublespeed_audio_bandwidth_root_cause](86_phase86_doublespeed_audio_bandwidth_root_cause.md) | 倍速録画の音質低下(高域欠落)を根本解決。原因はWineのdsoundミキサーがPulseAudioシンクのレートまでアンチエイリアス付きでダウンサンプルすること(対策済みだった)と、FFmpeg AACの既定符号化帯域が絶対Hzで決まり圧縮空間19.3kHz=等倍換算9.7kHzに制限されること(本フェーズで`-cutoff`により解決)の2つで、両者がほぼ同じカットオフを生むため片方だけでは症状が変わらなかった。ローカルCPU描画+DirectSound単体プローブによる検証環境を整備し、2倍速の音質が等倍と0.5dB以内で一致することを実機確認。MOD側のプライマリバッファフックは原理的に無効と確定し撤去、倍速用シンクの後片付け漏れとpactlのロケール依存パースバグも修正 |
| 87 | [phase87_th15_speedup_multiplier_comparison](87_phase87_th15_speedup_multiplier_comparison.md) | フェーズ85・86の改善を全適用したg6f.2xlarge(us-west-2スポット)でth15を1.5/2/3/4倍速録画し等倍復元して比較。2倍速はExtra・Hard全6面とも実用品質(スコア一致・落ちフレーム0.0〜0.1%・音声帯域は等倍と0.5dB以内)。1.5倍速は周期的カクつきとWineの10ms端数丸めと推定される0.0756%の音声ドリフト、3・4倍速はゲーム本体の単一スレッド律速で処理落ち。倍速録画の音声が等倍より一定量遅れる問題を発見し、pulse入力の開始タイムスタンプのぶれ(等倍にも潜在)が原因と推定(未解決)。タイムライン照合・DirectSound遅延プローブ等の診断ツールを追加 |
| 88 | [phase88_av_sync_marker](88_phase88_av_sync_marker.md) | 倍速録画の音ズレの根本原因特定と解決。ffmpegのpulse入力のタイムスタンプはWine(dsound→winepulse)の出力遅延とPulseAudioシンクのレイテンシを含まず、従来のstart_time方式は等倍でも音が+0.09〜0.19秒遅れていた。MODがゲーム自身のDirectSoundから-42dBFSの疑似乱数ノイズ(同期マーカー)を鳴らし、録画後にPHAT相互相関で検出してmuxする方式に変更。光とクリックを同時に出す合成プローブで、ローカル・AWS、等倍・2倍速、libx264・NVENCのいずれでもA/V誤差±20ms以内を確認 |
| 89 | [phase89_speedup_all_titles_gpu](89_phase89_speedup_all_titles_gpu.md) | 倍速録画をth06/th06nc/th07/th08/th09/th10/th11/th12/th128/th15/th20へ展開し、g6f.2xlarge(us-west-2スポット、GPU描画+NVENC)で検証。2倍速は全タイトル試行1回目成功・スコア一致・録画時間約52〜54%、th20以外は復元後の落ちフレームが等倍と同等。th06〜08の3・4倍速はゲームは目標fpsを維持するがx11grab律速で落ち1〜3%/7〜9%。th06ncはWASAPIのレート偽装で対応。GPU描画面の複数Xorg問題、終了検知ポーリングによるカクつき、th08のウィンドウ位置戻し(ウィンドウID取り込みで解決)、fps暴走閾値、thpracアタッチ失敗を修正 |
| 90 | [phase90_fps_display_fix_and_th06c_speedup](90_phase90_fps_display_fix_and_th06c_speedup.md) | 倍速録画時の画面上fps表示を等倍換算(60fps)に修正(th12/th20はspeed_hack_hookとfps_display_hookの二重補正、th06/th08はtimeGetTime由来、th10/th06はvpatchの`CalcFPS=1`が原因)。th06cの倍速対応(QPC・WASAPI偽装)とg6f.2xlargeでの検証(2倍速は実用品質・落ち1.0%、3倍速3.4%・4倍速8.6%はキャプチャ律速) |
| 91 | [phase91_cpu_slowmo_reverification](91_phase91_cpu_slowmo_reverification.md) | th15・th20のCPU低速録画を現行パイプラインで再検証(issue #3)。th20とth15通常ステージは`c7i.4xlarge`の1/2倍速で本番可(落ち0.5〜0.8%、実時間は尺の約2.03倍)、th15 Extraは1/2倍速で最低19.8Hzのため1/3倍速を推奨。同期マーカーは低速でも±11ms以内。40Hzの落ち16%超は復元の間引きが原因で120fpsキャプチャで改善。`scripts/87_compare_timeline.py`の時間軸を修正。c7iでも7台中2台がSpot中断 |
| 92 | [phase92_th06nc_g6_full_l4_verification](92_phase92_th06nc_g6_full_l4_verification.md) | th06ncの`g6.2xlarge`検証(issue #4)。AMI変更なしで`g6f`と同等、起動127〜140秒。現行の変換で倍速の配信版が約45fpsへ落ちることを発見(g6固有ではない) |
| 93 | [phase93_th15_fps_display_correction](93_phase93_th15_fps_display_correction.md) | th15の低速録画で画面上のfps表示を等倍換算に修正。時刻取得関数`0x72c90`がフレームペーシングと共有のため、QPCの戻り先`0x72ccb`と呼び出し元の戻り先`0x33600`の両方で絞り込む`InstallFpsDisplayCorrectionHookViaCaller()`を追加。ローカルの30Hz・20Hzとも60.0fps表示、スコア一致 |
| 94 | [phase94_g6f_xlarge_and_nvfbc_capture](94_phase94_g6f_xlarge_and_nvfbc_capture.md) | th06ncの倍速録画を`g6f.xlarge`で再現できるかの検証。L4の1/8スライスが律速と見られ、720p 3倍速・1080p 2倍速とも実効17.6〜31.4fpsで不可(720p等倍のみ実用)。NvFBC→CUDA→NVENCはvGPUで動くが目標に届かない。オンデマンドでも`g6f.2xlarge`の倍速の方が安い見込み |
| 95 | [phase95_g6f_2xlarge_ondemand_short_check](95_phase95_g6f_2xlarge_ondemand_short_check.md) | `g6f.2xlarge`オンデマンドの短い実測(Extra)。1080p 2倍速は59.20fps(落ち1.3%)で実用水準、720p 3倍速は50.71fps(落ち15.5%)で`g6.2xlarge`と同等でない。reports/94の費用比較を修正 |
| 96 | [phase96_th06nc_cpu_rendering_bc7](96_phase96_th06nc_cpu_rendering_bc7.md) | th06ncのCPU描画が9fpsだった主因はBC7テクスチャのサンプリング。D3D11フックでロード時にRGBA8へ展開すると8スレッドで60fps、Xvfb+wined3dのままLunatic全6面を完走(スコア一致)。1/2倍速なら実効58.45fps、`c7i.2xlarge`で尺1時間約$0.08の見込み。GPU継続時のリージョン別Spot Placement Scoreも調査 |
| 97 | [phase97_th06nc_cpu_spot_verification](97_phase97_th06nc_cpu_spot_verification.md) | th06ncのCPU録画(BC7展開)をeu-south-2の`c7i`スポットで実測。全11本完走・スコア一致。`c7i.2xlarge`の720p 1/2倍速はLunaticでGPU等倍と同等(尺1時間約$0.09)だがExtraの高密度弾幕で描画が約15Hzへ落ちる。`c7i.4xlarge`の1/2倍速はExtra 0.7%(約$0.17)、1080pは約$0.18。等倍・`c7i.xlarge`は不可。FpsMonitorは描画落ちを示さない。th06ncのデシンク判定が本番で常にスキップされる問題も発見 |
| 98 | [phase98_quality_criteria_and_speed_table](98_phase98_quality_criteria_and_speed_table.md) | 録画品質の判定基準を策定(issue #5 作業1)。プレイ区間の落ちフレーム率≤1.5%、FpsMonitor下位5%≥目標×0.97、理論尺超過≤+1.0%、同期マーカー残差≤±20ms。数値は目安で、開発者の視聴結果と本番の費用を優先する。現行のおすすめ速度(`g6f.2xlarge`)と矛盾しないことを確認し、既存レポートからタイトル×環境(`g6f.2xlarge`・`g6.2xlarge`・CPU EC2・自宅ワーカー)の最速速度表を転記(作業2)。CPU等倍と自宅ワーカーは旧指標のみで暫定、th08の3倍速とth06ncの1080p 2倍速が引き上げ候補 |
| 99 | [phase99_th15_th20_cpu_rendering_analysis](99_phase99_th15_th20_cpu_rendering_analysis.md) | th15・th20のCPU描画(wined3d+llvmpipe)の律速調査。D3D9の描画記録フック・スレッド別CPU・倍速ベンチを整備。律速はllvmpipeの塗りつぶし(ブレンド付きスプライト・加算エフェクト)そのもので、CPU量にほぼ比例する。A4R4G4B4の格上げ、深度テストの間引き、等倍コピーのStretchRect化、DXVK(d3d9)はどれも効果なし。内部解像度を960x720(th15.cfg 0x1F=4、th20.cfg 0x78=4)にすると4コア8スレッドで1280x960の8コア16スレッドと同等になり`c7i.2xlarge`の1/2倍速で足りる見込みだが、画質が下がるため視聴判断とクラウド実測が条件 |
| 100 | [phase100_th13_nonsteam_bringup_and_cloud_verification](100_phase100_th13_nonsteam_bringup_and_cloud_verification.md) | th13(ver1.00c・非Steam版)の導入。ローカル・AWSでフル尺録画、スコア全一致。等倍は`c7i.4xlarge`でもExtraが落ち4.3%、1/2倍速なら`c7i.2xlarge`で通常・Extraとも合格 |
| 101 | [phase101_jaggy_text_d3dx_filter](101_phase101_jaggy_text_d3dx_filter.md) | 日本語テキストのジャギーを再調査。原因はGDI/FreeTypeではなく、WineのD3DXが`D3DXLoadSurfaceFromMemory`のTRIANGLEフィルタを実装せず最近傍で縮小すること(ゲームはGDIで2倍の大きさに描いた二値アルファの文字を縮小転送している)。MOD側の縮小(`D3DX_AREA_FILTER=1`、ネイティブd3dx9に合わせたテント半径0.8、ネイティブとの4bitアルファ一致97〜98%)でth13の会話文・スペルカード名がWindows実機とほぼ同じになり、フル尺もスコア一致。ネイティブ`d3dx9_43.dll`(案B)でも同等に直ることを確認。Windows実機でも、GDIのDIBが二値であること、Windowsのd3dx9とWine+ネイティブDLLの出力が同じ入力で画素単位に一致すること、テント半径0.8が最良であることを確認。残る差はGDIの字形と疑似ボールドの扱い。負荷の比較では、高速化した案A(文字の転送1回0.29ms)が現行と同じ負荷・同じ録画品質で、案Bは全体ではわずかに軽いが会話開始時の転送が4倍重く1フレームに集中するため、本番には案Aを推す(録画品質の実測では3方式に差なし)。th10〜th15のMODに組み込み(既定は無効) |
| 102 | [phase102_text_filter_all_titles](102_phase102_text_filter_all_titles.md) | 文字の縮小フィルタ(`D3DX_AREA_FILTER=1`)をth10〜th15で確認。th10・th11・th12・th128・th13は文字を`D3DXLoadSurfaceFromMemory`(TRIANGLE)で縮小しており、Extraのフル尺(ローカル)で縁がなめらかになるだけで表示の崩れなし・スコア一致。th15は内部解像度1280x960では文字を等倍で転送するため対象外。AWS `c7i.2xlarge`でth11・th12(等倍)・th13(1/2倍速)をフィルタなし→あり→あり→なしで録り、落ち・FpsMonitor・理論尺・同期の差はばらつきの範囲。th12の`c7i.2xlarge`等倍はフィルタなしでも落ち3%台で基準外。ローカルの並列2本ではth10・th11が20Hz台まで落ちたため直列で取り直した。視聴確認は未実施 |
| 103 | [phase103_th14_bringup_and_cloud_verification](103_phase103_th14_bringup_and_cloud_verification.md) | th14(ver1.00b・非Steam版)の導入。ローカル・AWSのフル尺18本でスコア全一致。CPU描画の等倍は`c7i.4xlarge`でも落ち4.9〜5.8%、`g6f.2xlarge`(GPU描画)は等倍・2倍速とも合格(落ち0.0〜0.2%)、3倍速は5.8%。CPUは`c7i.4xlarge`の1/2倍速が全体0.7〜0.8%だが局所的に14〜22Hzまで落ちる。低速録画の処理落ち早期検知の誤検知を修正、`th14.cfg`の0x39、fps表示補正 |
| 104 | [phase104_frame_sync_capture_feasibility](104_phase104_frame_sync_capture_feasibility.md) | フレーム同期キャプチャ(ゲームの1フレームの描画・取り込みが終わりしだい次へ進める可変速の非リアルタイム録画)の机上検討。実現可能と判断。仮想時計・`Present`フックでのバックバッファ読み出し・MOD内の仮想音声デバイスの3点で構成し、最大の作業は音声。映像のみのPoCはフェーズ105 |
| 105 | [phase105_frame_sync_capture_poc](105_phase105_frame_sync_capture_poc.md) | フレーム同期キャプチャのPoC(映像のみ)。MODが仮想時計とPresentフックでのバックバッファ読み出し(1フレーム遅延のパイプライン化)をFIFOへ流し、`--frame-sync`で録る。ローカルのXvfbでth15 Extra・Hard、th12 Extra・Hardのフル尺4本がフレーム数一致・スコア一致・落ち0.0%。処理速度はth15 1.17〜1.50倍速、th12 約3.5倍速(既存のth15 CPU録画は1/2倍速)。律速はllvmpipeの描画で、取り込みは上限の8割前後。音声は未対応 |
| 106 | [phase106_dsound_usage_probe](106_phase106_dsound_usage_probe.md) | フレーム同期キャプチャの音声対応の準備。DirectSoundの記録フック(`DSOUND_PROBE=1`)でth15・th12を調査。効果音は静的バッファをメインスレッドから鳴らし、BGMは4秒のバッファを位置通知+補充スレッド(`MsgWaitForMultipleObjects`)で流す。仮想音声デバイスの設計 |
| 107 | [phase107_frame_sync_virtual_audio](107_phase107_frame_sync_virtual_audio.md) | フレーム同期キャプチャの音声対応。MOD内の仮想音声デバイス(`mods/common/frame_sync_audio`)がDirectSoundのバッファを写して仮想で再生し、1フレーム735サンプルをミックスしてPCMへ書く。BGMの位置通知もMODが仮想の再生位置で出す。th15・th12のフル尺4本を含む6本で音声の長さ=映像のフレーム数、補充の待ちのタイムアウト0、スコア一致。実時間録画との照合で曲の中のずれは0.1ms単位で一定、音量もほぼ同じ。視聴確認は未実施 |
| 108 | [phase108_duplicate_sound_buffer_fix](108_phase108_duplicate_sound_buffer_fix.md) | 視聴で指摘された効果音抜けの修正。ゲームは同じ効果音を重ねるために`DuplicateSoundBuffer`で複製(th15・th12とも11本)しており、仮想音声デバイスが複製を把握せず素通しにしていた。複製をフックして写しを共有するよう修正。修正前後の音声の差し引きで、指摘の場面(確信度高・中)すべてに音が戻ったことを確認。視聴比較用の参照と対応時刻。修正後の録画を開発者が全編視聴し、指摘した抜け・違和感はすべて解消、音声・映像とも等倍実機と区別がつかない品質と確認 |
| 109 | [phase109_frame_sync_determinism_and_cloud_verification](109_phase109_frame_sync_determinism_and_cloud_verification.md) | フレーム同期キャプチャ(`--frame-sync`)の負荷耐性(決定性)・AWS実機(`c7i.4xlarge`/`c7i.2xlarge`/`m7i.xlarge`/`g6f.xlarge`)・コスト評価(`th12`/`th15`)。`FrameSyncSleepMs`実装、AWSの`th12` 60fps上限(`GetRasterStatus` `vtable[19]`)を`MyGetRasterStatus`で解除(`2.31〜2.33x`)、`109_compare_determinism.py`にTHPコンパクション回避追加。ローカル並列/16w 100%負荷(`0.11x`)・クラウド8w負荷(`load8`)・AWS全19本で試行1完走・スコア一致・ドリフト`[0,0,0]`・`A/V=0.0ms`・プレイ区間落ち`0.0〜0.2%`。`th15` CPU低速録画比でコスト53〜63%削減、`th12`も`c7i.2xlarge`(1.76x, -32%)・`m7i.xlarge`(1.10〜1.13x, 4vCPU解禁)で基準達成 |
| 110 | [phase110_frame_sync_d3d9_titles](110_phase110_frame_sync_d3d9_titles.md) | D3D9＋DirectSound8系6タイトル(`th10`/`th11`/`th128`/`th13`/`th20`＋2026-11-20追補`th14`)へ`--frame-sync`を展開・ローカル検証。`HookVpatchModule`(`vpatch_th10.dll` IAT仮想化)＋`CalcFPS=0`で`th10`上限解除、`SYNC_MARKER_TRIGGER`残置による`unknown_plays=1`解消(`recorder/framesync.py`＋`dsound_hook.cpp`)、`th20` BGM周回境界の通知スキップ(`refill_timeouts=13`, 音欠け無し)解明。全11本試行1完走・スコア全一致・`frames=vid=aud`端数0B・落ち`0.0〜0.1%`・上限解除`5.42x`(`th10`)/`3.46x`(`th11`)/`2.78〜2.95x`(`th128`)/`2.91〜3.03x`(`th13`)/`1.17〜1.38x`(`th14`, `8t 0.92x`/`4t 0.48x`)/`1.29x`(`th20`) |
| 111 | [phase111_frame_sync_d3d8_titles](111_phase111_frame_sync_d3d8_titles.md) | D3D8＋DirectSound8系4タイトル(`th06`/`th07`/`th08`/`th09`)へ`--frame-sync`を展開・ローカル検証。`CaptureFrameD3D8`・`ResetCaptureDevice`・`stepDiv=32`(`th07/08/09` QPCビジーウェイト対策)・`AdvanceVirtualToFrame`(起動VSync計測による30s遅延/`th08`タイムアウト解消)・`recorder/modlog.py` Shift-JIS対策を実装。全8本試行1完走・`th06/07/08`スコア全一致・`frames=vid=aud`端数0B・`unknown_plays=0`・上限解除`5.08x`(`th06`)/`5.37〜5.74x`(`th07`)/`5.29〜5.46x`(`th08`)/`4.57〜4.92x`(`th09`) |
| 112 | [phase112_frame_sync_dxlib_and_all_titles_summary](112_phase112_frame_sync_dxlib_and_all_titles_summary.md) | 64bit DXライブラリ(D3D11+WASAPI)系`th06c`/`th06nc`へ`--frame-sync`を実装(`frame_sync_d3d11`/`frame_sync_wasapi`・`g_realMixRate`・`rgb0`・ローダーロック遅延開局・`PressVKey` 2フレーム保持)し、`sattori`本番全13タイトル＋追補`th14`の計14タイトル展開完了を確認。ローカルフル尺4本(`th06c` `4.58〜4.74x`, `th06nc` 720p CPU+BC7 `1.51〜1.57x`/0%落ち)完走・スコア一致、`th06nc` 1080p(`0.86x`)、`th06c` 150s決定性(`drift=[0,0,0]`/`A/V=0.0ms`/`MAD=0.0000`)、`8t/4t`スケーリング・変換ベンチ実施。`scripts/112_estimate_ec2_costs.py`で全14タイトル×EC2インスタンス別速度・コスト推定を策定(`th14`は2026-11-20追補) |
