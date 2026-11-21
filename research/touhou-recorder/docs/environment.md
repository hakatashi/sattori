# 環境構築・レンダリングアーキテクチャ

このリポジトリにおけるゲーム実行・レンダリング環境の基本構造と注意点をまとめます。

## 基本構成

東方Projectの各タイトルは、Linux (Ubuntu) 上の以下のスタックで実行されます：

- **ディスプレイサーバー**: Xvfb (X Virtual Framebuffer)
- **ウィンドウマネージャ**: openbox (`openbox --sm-disable`)
- **Windows互換レイヤー**: Wine
- **レンダリングバックエンド**: wined3d (OpenGL) + llvmpipe (CPUソフトウェア描画)

## 重要な注意点・制約

- **描画バックエンドの選択**:
  - Xvfbには `DRI3` 拡張が存在しないため、Vulkan (DXVK) によるウィンドウ表示はクラッシュします。
  - そのため、通常のCPU録画では **wined3d (OpenGL) + llvmpipe (ソフトウェア描画)** 経路のみが実用可能です。
  - ※GPUインスタンスを使用するタイトル（th06nc等）ではXorg + NVIDIAドライバ構成を使用し、DXVKやwined3d+GPUレンダリングを利用します（詳細は [docs/gpu-recording.md](docs/gpu-recording.md) 参照）。
- **ウィンドウマネージャ (openbox) の必須性**:
  - 対象DISPLAYでopenboxが起動していないと、`xdotool windowactivate` やウィンドウフォーカス、配置が正常に機能しません。
- **日本語フォントとロケール**:
  - Windows実機と同じ日本語表示を行うには、MS Gothic系フォントのレジストリ登録に加え、wineプロセスを `LANG=ja_JP.UTF-8` 環境変数付きで起動する必要があります。
- **設定ファイルのウィンドウモード確認**:
  - ゲームの `.cfg` 設定がウィンドウモードになっていることが必須です（フルスクリーンのままだとXvfb環境でプロセスが応答しなくなります）。
  - `.cfg` 内のどのバイトがフルスクリーン/ウィンドウモードを表すかはバージョン依存性があるため、実機で動作確認が必要です。
- **Steam DRM制約**:
  - th13（神霊廟）以降のSteam配信タイトルは、Steamworks API (`steamclient.dll`) 欠落により即終了します（th06cではスタブDLLで回避しています）。

## 参照レポート

- `reports/00_phase0_environment.md`
- `reports/01_phase1_th06_baseline.md`
- `reports/04_phase4_d3d9_software_rendering.md`
- `reports/30_phase30_th06_rendering_fix.md`
