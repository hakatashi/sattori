# th128のメニュー操作シーケンス冒頭「タイトル画面ロード待ち」を8000msから2000msへ短縮する妥当性を検証

- **検証日**: 2026-09-16
- **対象**: th128(妖精大戦争)MOD(`worker/mods/th128_replay_autoplay/dllmain.cpp`)のメニュー
  操作シーケンス冒頭にある「タイトル画面ロード待ち」の`ScaledSleep`値(Issue #78・PR #235)
- **環境**: 自宅ワーカー機(HakataMatrix)、`worker/README.md` §11のホスト直接実行(Docker
  コンテナ非経由)。`worker/games/th128`・`worker/prefixes/th128-wined3d-gl`は
  [`2026-09-09`](2026-09-09-th128-local-recording-verification.md)の検証時に配置したものを
  再利用
- **結論**: 2000msへ短縮しても1回の試行でメニュー操作シーケンスが正常完了し、フル尺録画・
  記録スコア完全一致を確認した。8000msに設定した根拠だった「最大10秒程度までキー入力を
  受け付けないことがある」というユーザー申告の不具合はいずれの回でも再現しなかった

## 目的

`worker/docs/titles/th128.md`に記載の8000ms(「th10の6000msよりやや長め」)は、ユーザーから
の「タイトル画面表示後、最大10秒程度までキー入力を受け付けないことがある」という申告に基づく
安全側の値だった。この値が妥当か(短縮できないか)を実機録画で確認する。

## 方法

1. 検証用リプレイは[`2026-09-09`](2026-09-09-th128-local-recording-verification.md)と同じ
   `th128_ud0000.rpy`(Hard、Route B、記録スコア22,666,770)を使用。
2. まず変更前(8000ms)のベースラインとして、`worker/README.md` §11のホスト直接実行で
   フル尺録画を1回実施。
3. `dllmain.cpp`の`ScaledSleep(8000)`を`ScaledSleep(2000)`へ変更し、`build-mods` skillの
   手順で`th128_hook.dll`を再ビルド。
4. 同じリプレイで再度フル尺録画を1回実施。

```bash
timeout --kill-after=30s 1500s python3 record_th128.py \
  --replay-path replay.rpy --output output/repro.mp4 \
  --diagnostics-dir output/diagnostics --progress-dir output/progress \
  --expected-duration-seconds 816 --expected-score 22666770 --max-attempts 1
```

## 結果

| ウェイト | 総録画時間 | シーケンス完了までの時間 | 重複フレーム率(録画開始15秒以降30秒スポット) | スコア一致 |
| --- | --- | --- | --- | --- |
| 8000ms(変更前) | 843.7秒 | 約11.78秒 | 0.8% | 一致(22,666,770) |
| 2000ms(変更後) | 837.9秒 | 約5.76秒 | 0.4% | 一致(22,666,770) |

2000ms版のステップ別実測間隔(タイトル画面ロード待ち完了時刻を起点):

| ステップ | 設定ウェイト | 実測間隔 |
| --- | --- | --- |
| タイトル画面ロード待ち | 2000ms | 2002ms |
| Down x1 → Enter(Replay確定) | 500ms | 627ms |
| Enter → Right(タブ切替) | 700ms | 834ms |
| Right → Enter(1番目選択) | 500ms | 635ms |
| Enter → Enter(再生確定) | 700ms | 833ms |
| 再生確定 → sequence complete | 700ms | 833ms |

いずれの回も、最初のDown入力がタイトル画面へ正しく反映され、`th128.md`が警告する
「リプレイ選択直後のフリーズ」も発生せずゲームプレイへ正常に進行した。

## 考察・既知の限界

- 8000ms・2000msそれぞれ1回ずつの試行のみ。「最大10秒程度までキー入力を受け付けない」という
  不具合はユーザー申告に基づくもので発生条件・頻度が特定されていないため、低頻度の事象で
  あれば今回の2試行では再現しない可能性がある。本番投入後も、リプレイ選択画面テンプレート
  未整備(画面静止検知のみ)の状態でこの種のシーケンス失敗が起きた場合は`docs/known-limitations.md`
  への追記を検討すること。
- 検証はホスト直接実行(Dockerコンテナ非経由)で行っており、`verify-recording-locally` skillの
  Docker経由の検証(2026-09-09)とは実行環境が完全には一致しない。ただし結果(重複フレーム率・
  スコア一致)は2026-09-09の検証と遜色ない。
- 単一リプレイ(Hard、Route B)のみでの検証。他ルート・Extra難易度では未確認。
