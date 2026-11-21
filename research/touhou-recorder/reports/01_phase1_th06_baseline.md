# フェーズ1: th06ベースライン動作確認(進行中)

日付: 2026-07-14

## 環境セットアップ

- `scripts/01_install_deps.sh` でwine 9.0, winetricks, xdotool, vulkan-tools, ja_JP.UTF-8ロケールを導入。全て成功。
- 実Xサーバーとして、ユーザーの許可を得てChrome Remote Desktopの仮想デスクトップセッション(`DISPLAY :20`, Xfce4)を使用。

## 試行1: wined3d(組み込みOpenGL実装)

- `WINEPREFIX=prefixes/th06-wined3d-gl`(32bit)を新規作成し、th06を起動
- ウィンドウ(640x480, タイトル「東方紅魔郷 ～ the Embodiment of Scarlet Devil」)は正常に出現
- しかし画面内容は終始白一色。`xwd`による直接キャプチャでも同様に白 → 画面キャプチャ側の問題ではなく実際に何も描画されていない
- `WINEDEBUG=+d3d,+d3d_caps,+ddraw` でトレースすると、`GL_RENDERER: "llvmpipe (LLVM 20.1.2, 256 bits)"` — **CRDの仮想Xセッションでは実GPUのGLXアクセラレーションが効かず、ソフトウェアレンダリング(llvmpipe)にフォールバックしていた**
- プロセスは101%CPUで回り続けるが、`wined3d_swapchain_*` 系のPresent呼び出しは一度もトレースされず。ウィンドウフォーカスを当てても変化なし。原因は未特定(ゲーム自身のリソースロードが特定の条件で無限リトライしている可能性、あるいはこの環境固有の問題の可能性がある)

## 試行2: DXVK(D3D8→D3D9→Vulkan、Steam Proton同梱DLLを流用)

- Steam Proton「Proton Hotfix」収録のDXVK **v3.0.1** を試したところ、`Device does not support required feature 'khrLoadStoreOpNone'` でVulkanアダプタが見つからずクラッシュ。
  - ホスト側の`vulkaninfo`では`VK_KHR_load_store_op_none`は問題なくサポートされている(driverVersion 25.2.8, apiVersion 1.4.318)ことを確認済み。つまり **Wine 9.0(Ubuntu標準リポジトリ版)の`winevulkan`が、この比較的新しいVulkan拡張をまだWindows側にブリッジできていない** ことが原因と判断
- Steam Proton「Proton 9.0 (Beta)」収録の**DXVK v2.5.1**(より古いビルド)に差し替えたところ、RADV(実GPU、AMD Radeon Graphics RADV VEGA20)を正しく検出し、D3D9互換デバイスの作成、スワップチェーン作成(640x480, windowed=true)まで成功。**ここまではWine+実GPU(DXVK経由)でのD3D8タイトル起動の技術的な成立を確認できた**
- ただしスワップチェーン作成直後に必ず `X connection to :20 broken (explicit kill or server shutdown)` でプロセスが異常終了(再現性あり、複数回試行して毎回同じ箇所で落ちる)
- `xdpyinfo` でCRDの仮想Xサーバー(:20)がサポートする拡張を確認したところ、**`DRI3`が存在せず`DRI2`と`Present`のみ**だった。VulkanのX11プレゼンテーション(WSI)は一般的にDRI3を前提とすることが多く、これが今回のクラッシュの濃厚な原因と考えられる

## 分かったこと・方針転換

- Wine 9.0 + 適切なバージョンのDXVK(v2.5.1、Steam Proton 9.0 Beta同梱)の組み合わせで、th06をD3D8→D3D9互換モードで実GPU(RADV)上に正しく初期化できることを確認できた。**DXVKのバージョン選定がシビアで、新しすぎるビルド(v3.0.1)はWine 9.0とVulkan拡張の対応関係が合わず動かない**という重要な知見が得られた
- CRDの仮想Xセッションは想定と異なりGPUアクセラレーションが困難な環境(wined3d/GLXはllvmpipeにフォールバック、DXVK/VulkanはDRI3欠如でプレゼンテーションがクラッシュ)であり、「通常のXサーバー」としては代表性に乏しいことが判明。これ以上この環境固有の問題を追うよりも、本来のターゲットであるXvfb上で同じ検証を行う方が有益と判断し、フェーズ2(Xvfbでのヘッドレス検証)に前倒しで着手する。

## 次のステップ

Xvfbで同様の切り分け(wined3d/GL、DXVK/Vulkan双方)を行い、DRI3の有無やPresent周りの挙動がCRDと異なるかを確認する。
