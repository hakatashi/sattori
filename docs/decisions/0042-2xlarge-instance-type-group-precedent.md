# 0042. `c7i`/`c7a`/`m7i`の`.2xlarge`帯を実機検証済みグループとして扱う

- **状態**: 有効
- **決定日**: 2026-09-01
- **対象**: apps/api
- **関連**: Issue #76、[`0016`](0016-ec2-fleet-instance-type-diversification.md)、
  th11(touhou-recorder reports/42・43)、
  th12(touhou-recorder reports/67、
  [`docs/reports/2026-09-01-th12-local-recording-verification.md`](../reports/2026-09-01-th12-local-recording-verification.md)、
  [`docs/reports/2026-09-01-th12-2xlarge-instance-group-verification.md`](../reports/2026-09-01-th12-2xlarge-instance-group-verification.md))

`c7i.2xlarge`・`c7a.2xlarge`・`m7i.2xlarge`の3タイプは、異なる録画特性を持つ2タイトル
（th11・th12）で繰り返し良好な結果を示したため、**今後`.2xlarge`帯を必要とする新規
タイトルは、このグループのいずれか1タイプで実機検証が通れば、残り2タイプも候補に
そのまま追加してよい**。ただしこれは「同スペック帯なら安全」という一般原則への回帰
ではなく、この3タイプの組み合わせに限定した例外である。

## 背景

[`0016`](0016-ec2-fleet-instance-type-diversification.md)により、th11専用の候補
（`TH11_CANDIDATE_INSTANCE_TYPES`）は`c7i.2xlarge`・`c7a.2xlarge`・`m7i.2xlarge`の
3タイプすべてが実機検証済みとして採用されている（touhou-recorder reports/42・43）。

th12は当初、`c7i.2xlarge`のみが実機検証済み（touhou-recorder reports/67、重複フレーム率
だけでなく理論尺比較でも良好）として`TH12_CANDIDATE_INSTANCE_TYPES`に採用されていた。
ユーザー指示により、同じ3タイプの残り2つ（`c7a.2xlarge`・`m7i.2xlarge`）でも
sattori本体のコード・本番のLaunch Template（AMI/IAM/SG）を使ったAWS実機検証を行った
結果、両方とも良好（`c7a.2xlarge`は重複フレーム率0.4%、`m7i.2xlarge`は表面上12.7%
だったが秒単位の生存フレーム再解析で測定ノイズと判明、いずれもスコア完全一致・
理論尺どおりの尺）だった
（[`docs/reports/2026-09-01-th12-2xlarge-instance-group-verification.md`](../reports/2026-09-01-th12-2xlarge-instance-group-verification.md)）。

これにより、**異なる2タイトル**でこの3タイプの組み合わせが繰り返し実証されたことになる。
新しいタイトルを追加するたびに同じ3タイプを毎回個別検証するのは工数の重複であり、
一定の実証実績が積み上がった組み合わせについては省略を認める判断をした。

## 決定

- `c7i.2xlarge`・`c7a.2xlarge`・`m7i.2xlarge`を「`.2xlarge`帯実機検証済みグループ」
  として扱う。
- **新規タイトルが`.2xlarge`帯（8vCPU/16GiB以上）を必要とする場合、このグループの
  いずれか1タイプで実機検証（重複フレーム率・理論尺比較・スコア完全一致）が通れば、
  残り2タイプも候補インスタンスタイプにそのまま追加してよい**。3タイプ全ての個別
  実機検証は必須ではなくなる。
- 追加したタイトル専用の候補定数（例: `TH12_CANDIDATE_INSTANCE_TYPES`）のコメントに、
  「グループの1タイプのみ実機検証、残り2タイプは本ADRの実績を根拠に追加」である旨を
  明記すること（推測で足したのではなく、方針に基づく追加であることを後から読む人に
  伝えるため）。

## 根拠

- **一般原則の撤回ではない**。`AGENTS.md`§3・[`0016`](0016-ec2-fleet-instance-type-diversification.md)
  の「同スペック帯・同価格帯だから安全という推測は繰り返し裏切られている」（`z1d.xlarge`が
  高クロック特化ゆえに悪化した実績）という警戒は引き続き有効。この3タイプに限って
  例外を認めるのは、**推測ではなく異なる2タイトルでの実証の積み重ね**が根拠にある
  ため。
- th11: touhou-recorder reports/42（`c7i.2xlarge`実測重複フレーム率4.5%）・reports/43
  （`c7a.2xlarge`0.4%、`m7i.2xlarge`3.7%）。
- th12: touhou-recorder reports/67（`c7i.2xlarge`理論尺超過+0.16%）、
  `docs/reports/2026-09-01-th12-2xlarge-instance-group-verification.md`
  （`c7a.2xlarge`・`m7i.2xlarge`のAWS実機検証、いずれも良好）。
- th12の`m7i.2xlarge`検証で「重複フレーム率だけでは30秒スポット計測のノイズに
  左右されうる」ことが再確認された（`docs/known-limitations.md`§3）。この方針の下で
  1タイプの検証を省略する際も、**残す1タイプの検証自体は重複フレーム率だけでなく
  理論尺比較・秒単位の生存フレーム再解析を併用すること**（Issue #93 の限界を
  踏まえた前提）。

## 採らなかった選択肢

- **全インスタンスタイプ帯（`.xlarge`/`.4xlarge`）に一律でグループ化方針を適用する**。
  実証実績が`.2xlarge`帯に偏っており、他帯への一般化は時期尚早。`.xlarge`帯は
  th06/07/08/10の4タイプがそれぞれ異なる重複フレーム率を示している（0.1〜5.0%、
  touhou-recorder reports/42・43）ため、同様の一般化には追加の実証が要る。`.4xlarge`帯は
  th20専用の`c7i.4xlarge`1本しか検証実績が無い。将来的に複数タイトル・複数タイプでの
  実証が積み重なれば、同様のグループ化を別途検討できる。
- **`z1d.xlarge`等の高クロック特化タイプも同一グループに含める**。過去に悪化実績が
  ある（`AGENTS.md`§3）ため、アーキテクチャ・クロック特性が異なるタイプはグループの
  対象外とする。
- **重複フレーム率のみを検証基準として残し、理論尺比較を省く**。`m7i.2xlarge`の
  検証で重複フレーム率単体では誤った結論（処理落ちしやすい）に至りかねないことが
  分かったため、省略を認めるのは検証手法そのものではなく「検証対象タイプ数」のみ。

## 影響範囲

- `apps/api/src/ec2.ts`（`TH12_CANDIDATE_INSTANCE_TYPES`を3タイプへ拡張。今後別タイトルで
  `.2xlarge`帯が必要になった際もこの3タイプをまず検討する）
- `apps/api/README.md`（候補インスタンスタイプ表）
- [`docs/decisions/0016`](0016-ec2-fleet-instance-type-diversification.md)
  （th12のセクションを更新し、本ADRへリンク）
- `AGENTS.md`§3（グループ化の例外があることを一言追記）
- `docs/known-limitations.md`§3（重複フレーム率の限界の実例として本検証を追記）
