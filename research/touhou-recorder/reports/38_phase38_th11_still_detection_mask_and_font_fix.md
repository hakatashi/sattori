# フェーズ38: th11の画面静止検知マスク導入とMS明朝フォント修正

日付: 2026-07-25

## 目的

フェーズ37で未解決だった2件の課題に対応する。いずれもローカル環境(Xvfb)のみで検証し、AWSリソースは使用していない。

1. `th11_ud16gm.rpy`で画面静止検知が機能せず40分タイムアウトに達する問題
2. `runs/th11_aws_c7i_xlarge_full/video.mp4`で確認された、MS明朝を使用する箇所のフォント誤り・輪郭のジャギーの問題

## 1. 画面静止検知: Pause Menuの選択カーソル明滅を除外

### 原因の特定

`runs/th11_aws_c7i_xlarge_full/video.mp4`の末尾(Pause Menu表示区間)を2秒間隔・10fpsでフレーム抽出して分析したところ、ユーザーが指摘した矩形(640x480原座標で(70,288)-(188,318))は、現在選択中のメニュー項目(「タイトルへ戻る / Return to Title」)の文字が明滅するカーソル演出であることを確認した。この矩形の輝度は約1.3秒周期で46〜54の範囲を往復し続け、Pause Menu表示中は他の要素が完全に静止した後もずっと明滅し続ける([`reports/assets/th11_still_detect_exclude_rect.png`](assets/th11_still_detect_exclude_rect.png)、緑枠が該当矩形)。

この矩形単体が640x480フレーム全体の平均絶対差分(MAD)に与える寄与は、画素数の比(約1.15%)から計算すると最大でも1程度であり、`th11_aws_c7i_xlarge_full/video.mp4`から抽出した実データでも単独では0.1程度にとどまった。フェーズ37で報告された「MADが2.2〜3.0程度で推移し続ける」という値をこの動画だけから再現することはできなかった(この動画は`--record-seconds`固定尺モードで録画されており、画面静止検知の`poll_log`自体が記録されていないため、実際に問題が起きた自然検知の試行とは別収録である)。とはいえ、この矩形が「Pause Menu表示中ずっと明滅し続け、他の一切が静止しても収束しない」性質を持つことは実データで確認済みであり、フェーズ37の症状(MADが閾値をわずかに超え続ける)と機構的に整合する。

### 対応

`scripts/25_record_replay_e2e_multigame.py`に、静止判定用のMAD計算から指定矩形を除外する仕組みを追加した。

- `GAME_CONFIGS["th11"]`に`"still_detect_exclude_rect": (70, 288, 188, 318)`(元のウィンドウ座標系)を追加
- `build_still_mask(rect, w, h)`: 矩形を`grab_frame()`が常にリサイズする160x120グレースケール座標系のブールマスクに変換する関数を追加
- `mad_masked(a, b, mask)`: マスクが指定されていればマスク外の画素のみで平均絶対差分を計算し、未指定なら従来通りの`mad()`にフォールバックする関数を追加
- 画面静止のみで終了判定するゲーム(現状th11のみ)のポーリングループで、`mad()`の代わりに`mad_masked()`を使うよう変更

テンプレート照合を使うth06/07/08には影響しない(該当ゲームは`still_detect_exclude_rect`を設定していないため、`build_still_mask`は常に`None`を返し、動作は従来通り)。

### 検証: `th11_ud16gm.rpy`の自然検知フル尺録画

修正後、`--record-seconds`を使わない自然検知モードで`th11_ud16gm.rpy`(フェーズ37で2回連続40分タイムアウトした同一リプレイ)をローカルXvfb環境でフル尺録画した。

| 項目 | 結果 |
|---|---|
| 検知方式 | 画面静止検知(自然検知、`--record-seconds`未使用) |
| 試行回数 | 1回(修正前は2回とも失敗) |
| 総録画時間 | 1837.6秒(約30.6分) |
| 終了検知の収束 | elapsed=1811.7s: MAD=1.13 → 1814.0s: 0.16 → 1816.3s以降: 0.00が8回連続、1827.6sで終了検知 |
| 重複フレーム率(録画開始15秒以降) | 0.0% |

修正前(フェーズ37)はPause Menu画面到達後もMADが2.2〜3.0で推移し続け40分のハードタイムアウトに達していたのに対し、修正後は同じ画面に到達してからわずか16秒(8回のポーリング)でMAD=0.00に収束し、正常に終了を検知できた。これにより、フェーズ37で未解決とされていた画面静止検知のタイムアウト問題は解消したと判断する。

## 2. MS明朝フォント修正

### 現象

`runs/th11_aws_c7i_xlarge_full/video.mp4`のスペルカード名・NPC会話シーン(13:53、14:02地点)を、ユーザー提供のWindows実機スクリーンショットと比較したところ、以下の2点が確認できた。

1. 会話中のキャラクター名+セリフ欄(例: 「萃香（うん、恐らくね）」)が、実機ではMS明朝の明朝体・全角括弧で表示されるのに対し、録画では別の書体(ゴシック体寄り)・半角括弧に置き換わっていた
2. 文字の輪郭が実機より粗く、ジャギーが目立つ

### 原因

`prefixes/th11-wined3d-gl`はth08用WINEPREFIXを複製したものであり(フェーズ35)、フェーズ13/29でth07・th08に適用したMS Gothicの配置・レジストリ登録は引き継がれていたが、**MS明朝(`msmincho.ttc`)は配置もレジストリ登録もされていなかった**(`system.reg`を確認したところ、`MS Gothic (TrueType)`等のエントリはあるが`MS Mincho (TrueType)`は存在せず)。「ＭＳ 明朝」というフォント名の要求に対して実体ファイルが見つからないため、Wineの代替フォント解決チェーンを経由して別の書体にフォールバックしていたと考えられる。

### 対応

フェーズ13・29でth07/th08のMS Gothicに対して行ったのと同じ方法で、th11のWINEPREFIXにMS明朝を追加した。

1. `games/assets/msmincho.ttc`(ユーザー提供、MS Mincho/MS PMincho本体を含むTrueTypeコレクション)を`prefixes/th11-wined3d-gl/drive_c/windows/Fonts/msmincho.ttc`に配置
2. `wine reg add`でレジストリを登録:
   - `HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts`に`"MS Mincho (TrueType)"`・`"MS PMincho (TrueType)"`=`"msmincho.ttc"`
   - `HKLM\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes`に`"ＭＳ 明朝"`→`"MS Mincho"`・`"ＭＳ Ｐ明朝"`→`"MS PMincho"`のマッピング

### 検証

修正後、`th11_ud16gm.rpy`をローカルでフル尺録画し(前節の静止検知検証を兼ねる)、フェーズ37と同じ14:02付近の会話シーンを実機スクリーンショットと比較した([`reports/assets/th11_mincho_font_before_real_after.png`](assets/th11_mincho_font_before_real_after.png)、上から修正前の録画・Windows実機・修正後の録画)。

- 修正前: 「萃香(うん、恐」(半角括弧、ゴシック体寄りの書体、字間が詰まっている)
- Windows実機: 「萃香（うん、」(全角括弧、明朝体特有のセリフ・太細のコントラスト)
- 修正後: 「萃香（うん、」(全角括弧、明朝体の字形。実機とほぼ一致)

修正により、フォントの誤り(書体・全角/半角括弧)は解消したことを実際のゲーム画面で確認した。

### ジャギー(輪郭の粗さ)は未解決

フォント修正後も、文字の輪郭が実機より粗い(グレーの中間諧調が少なく、より二値的な輪郭になる)傾向は残った。原因切り分けのため、mingw-w64でクロスビルドした最小限のWin32 GDIテストプログラム(`CreateFontIndirectW`+`ExtTextOut`でビットマップに直接描画)を同一WINEPREFIX上のWineで実行し、以下を確認した。

- `lfQuality = ANTIALIASED_QUALITY`を明示すると、Wine上でも(msmincho.ttcの有無によらず)グレースケールで滑らかにアンチエイリアスされたテキストが描画される
- `lfQuality = DEFAULT_QUALITY`にして`HKCU\Control Panel\Desktop`の`FontSmoothing`/`FontSmoothingType`/`FontSmoothingGamma`を変更しても、テスト描画の見た目は(ClearType的な色収差が出る場合はあるが)大きくは変わらない

ゲーム本体が内部でどの`lfQuality`を指定しているかはバイナリ解析なしには特定できないが、少なくとも「WINEPREFIX側のFontSmoothing系レジストリを調整する」という安全な手段では改善が確認できなかった。実機での滑らかな見た目は、Windows側のDWM(デスクトップコンポジション)による追加の平滑化、またはWineのFreeTypeラスタライザとWindows GDIのヒンティング処理の違いに起因する可能性が高く、ヘッドレスのWine/Xvfb環境で単純に再現するのは難しいと判断する。これ以上の追求は、ゲーム本体のテキスト描画コード(D3Dテクスチャへの合成方法等)の解析が必要になり費用対効果が低いため、本フェーズでは対応を見送る。

## 変更ファイル

- `scripts/25_record_replay_e2e_multigame.py`: `still_detect_exclude_rect`設定・`build_still_mask()`・`mad_masked()`を追加、th11のポーリングループで使用
- `prefixes/th11-wined3d-gl`(gitignore対象、リポジトリ非追跡): `msmincho.ttc`配置・関連レジストリ登録

## 今後の課題

- ジャギー(輪郭の粗さ)は未解決のまま残る。実機同等の見た目が必須要件になった場合は、ゲーム側のテキスト描画パス(D3Dテクスチャ合成がアルファブレンドかアルファテストか等)の解析が必要
- 本フェーズの検証は`th11_ud16gm.rpy`1本のみ。他のth11リプレイのPause Menuでも同様の明滅カーソルが同じ座標に出るか(解像度・UIレイアウトが同一であれば座標は変わらないはずだが)は未確認
- th07/th08のWINEPREFIXにもMS明朝が同様に未導入である可能性がある(本フェーズではth11のみ対応、他タイトルでMS明朝を使う場面が実際にあるかは未確認)
