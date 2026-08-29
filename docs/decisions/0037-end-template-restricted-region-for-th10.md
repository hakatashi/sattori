# 0037. 終了検知テンプレート照合に絞り込み領域・専用閾値を持たせる（th10）

- **状態**: 有効
- **決定日**: 2026-08-29
- **対象**: worker
- **関連**: Issue #75、touhou-recorder reports/56、
  [`decisions/0011`](0011-replay-end-template-matching.md)、`worker/docs/titles/th10.md`

[`decisions/0011`](0011-replay-end-template-matching.md)のテンプレート照合方式は、比較対象を
「上部帯全体×固定閾値」に固定していた。th10ではこの前提が崩れるため、比較領域・閾値を
`GameConfig`で上書きできるよう一般化した。0011自体を覆すものではない。

## 背景

th10（東方風神録）のリプレイ選択画面は、th06/07/08と異なり**背景全体が常時
アニメーションしている**。0011の既定領域（160x120ダウンサンプル座標系の上部
`END_TEMPLATE_ROWS=40`行×全幅）でテンプレート照合すると、この背景アニメーションに
引きずられて同一画面同士でもMADが上振れし、既定の閾値（`END_TEMPLATE_MAD_THRESHOLD=15.0`）
では一致と判定できない（touhou-recorder reports/56）。一方、画面静止検知のみへの
フォールバック（th11・th20方式）も使えない——背景が常時動いているため画面が静止しない。

## 決定

`GameConfig`に`end_template_rect`（元のウィンドウ座標系の絞り込み矩形、未指定なら従来通り
上部帯全体）と`end_template_mad_threshold`（未指定なら従来通り`END_TEMPLATE_MAD_THRESHOLD`）
を追加した。`recording_common.build_end_template_mask()`が矩形を160x120座標系のブール
マスクへ変換し、`mad_masked()`で比較する（`load_end_template()`は以後クロップ済みでは
なくフル画像を返し、クロップはマスク側の責務にした）。

th10は、リプレイ内容に依存しない左上の"REPLAY"見出し部分（元のウィンドウ座標系で
`(0,0)-(244,76)`）だけに絞り込み、閾値も緩めた専用値（25.0）を使う
（`record_th10.py`の`GameConfig`）。

## 根拠

- 絞り込み領域・専用閾値の実機検証はtouhou-recorder reports/56（フル尺録画で
  end_template方式による終了検知が正しく機能することを確認済み）。
- 既存タイトル（th06/07/08）は`rect=None`/`threshold=None`で従来と完全に同じ計算になる
  ため後方互換（`worker/tests/test_recording_common.py`の
  `test_build_end_template_mask_defaults_to_top_band`等で検証）。

## 採らなかった選択肢

- **th10専用の別関数を用意する**: `GameConfig`のフィールド追加＋汎用マスク関数の方が、
  `still_detect_exclude_rect`/`build_still_mask`と対称的な設計になり、将来別タイトルが
  同様の事情（背景アニメーションを含む一部領域だけを比較したい）を持った場合にも
  そのまま使い回せる。
- **th10もth11・th20と同様に画面静止のみへフォールバックする**: 背景が常時動いている
  ため画面が静止せず、この方式自体が成立しない。

## 影響範囲

- `worker/recording_common.py`（`GameConfig.end_template_rect`/`end_template_mad_threshold`・
  `load_end_template()`・`build_end_template_mask()`・`attempt_recording()`）
- `worker/record_th10.py`
- 今後同様の事情を持つタイトルを追加する場合、まずこのフィールドが使えないか検討すること。
