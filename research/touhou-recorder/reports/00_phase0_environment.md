# フェーズ0: 環境確認

日付: 2026-07-14

## ホスト環境

- OS: Ubuntu 24.04.4 LTS (kernel 6.8.0-124-generic)
- CPU: AMD Ryzen 7 5700X (8コア16スレッド)
- メモリ: 94GB(空き約73GB)、ディスク空き141GB
- GPU: AMD Radeon Pro/Instinct Vega 20(`amdgpu`ドライバ、実GPU搭載)
  - Vulkan ICD: `/usr/share/vulkan/icd.d/radeon_icd.json`(RADV、実GPU)と `lvp_icd.json`(lavapipe、ソフトウェア)の両方が存在
- passwordless sudo 利用可能

## ツール導入状況(フェーズ0時点)

| ツール | 状態 |
|---|---|
| Xvfb | インストール済み |
| ffmpeg (6.1.1) | インストール済み |
| wine | 未導入(Ubuntu標準repoに9.0系あり、WineHQ公式repoは未設定) |
| winetricks | 未導入(標準repoに20240105-2あり) |
| vulkan-tools | 未導入(標準repoに1.3.275.0あり) |
| xdotool | 未導入(標準repoに1:3.20160805.1あり) |
| ja_JP系ロケール | 未生成(`locale -a`はC, C.utf8, en_US.utf8, POSIXのみ) |
| DXVK単体 | 未導入。ただしSteam Proton配下(`~/.steam/debian-installation/steamapps/common/Proton Hotfix/` 等)に `files/lib/wine/dxvk/i386-windows/` としてd3d8/d3d9/d3d10core/d3d11/dxgi.dllが存在。全タイトルのexeは32bit PEのため、流用するならi386-windows版が対応する |

## ゲームディレクトリ調査結果

| タイトル | exe | D3D世代 | replayディレクトリ | リプレイ本数 | 備考 |
|---|---|---|---|---|---|
| th06 紅魔郷 | `東方紅魔郷.exe` | D3D8 | `REPLAY/`(大文字) | 3 | 文字化けした壊れ旧cfgが残存 |
| th07 妖々夢 | `th07.exe` | D3D8 | `replay/` | 3 | |
| th08 永夜抄 | `TH08.EXE` | D3D9 | `replay/` | 3 | `replayview.exe`という専用リプレイビューアを同梱 |
| th11 地霊殿 | `th11.exe` | D3D9 | `replay/` | 4 | `d3dx9_37/d3dx9_37.dll`が同梱済み(配置場所は未検証) |
| th13 神霊廟 | `th13.exe` | D3D9(文字列確認済) | `replay/` | 3 | config系ファイルなし |
| th14 輝針城 | `th14.exe` | D3D9(文字列確認済) | `replay/` | 4 | config系ファイルなし |
| th15 紺珠伝 | `th15.exe` | D3D9(文字列確認済) | `replay/` | 1 | cfgは中身0x00の未初期化状態 |
| th20 錦上京 | `th20.exe` | **D3D9のまま**(想定外、D3D11/12化なし) | `replay/` | 3 | exeサイズ約2倍、XInput1_4/gdiplus依存が新規追加 |

- 全タイトルで vpatch関連ファイルは見つからず(コミュニティパッチ未導入の素の状態)
- th06のRPYは `T6RP`マジック(旧世代・暗号化ヘッダ)、th11のrpyは`t11r`マジック(新世代)と形式が異なることを確認
- `~/.wine` は未作成(prefix未セットアップの白紙状態)

## 次のステップ

フェーズ1(th06を実Xサーバー上でベースライン動作確認)に進む。wine/xdotool/vulkan-tools/winetricksの導入とja_JP.UTF-8ロケールの生成から着手する。
