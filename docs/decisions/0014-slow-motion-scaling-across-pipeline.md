# 0014. 低速録画の倍率はフック・監視・変換・品質チェックのすべてへ一貫して適用する

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: worker / apps/web
- **関連**: Issue #68、touhou-recorder reports/47・48、
  `docs/reports/2026-08-11-th20-slow-motion-local.md`、
  [`0010`](0010-slow-motion-no-worker-side-branching.md)

低速録画（1/2倍速で録画し後処理で等倍へ戻す）は「`Present` を絞る」だけでは成立しない。
**音声・fps 表示・監視側のタイムアウト・品質チェックの閾値・進捗の分子まで、同じ倍率で
換算されていることが前提**になっている。どれか1つを据え置くと、誤リトライ・誤終了検知・
音ズレ・進捗の見た目の破綻のいずれかが起きる。低速録画まわりを触る前に読むこと。

有効化の仕組み（`FPS_LIMIT_TARGET_HZ` の有無だけで決まり、ワーカー側に分岐が無いこと）は
[`0010`](0010-slow-motion-no-worker-side-branching.md)。

## 背景

th20 は Xvfb + wined3d + llvmpipe のソフトウェアレンダリングに対して描画負荷が重く、
ボム・スペルカード等の高負荷区間でゲームエンジン自体が処理落ちする。`Present` を 30Hz へ
絞るとゲーム進行ごとスローモーション化し、実時間あたりの CPU 負荷が下がって処理落ちが
解消する（reports/47 で最低 19.8fps → 安定 30.0fps を実証）。

問題は、ゲーム内時間と実時間の比が 1:2 になることで、**それまで実時間で書かれていた
すべての定数の意味が変わる**点にある。

## 決定

### 1. MOD 側の3つのフックが同じ比率で動く

| フック | 役割 |
| --- | --- |
| `fps_limiter_hook` | `IDirect3DDevice9::Present` を目標fpsへスロットル(＝ゲーム進行のスローダウン) |
| `dsound_hook` | セカンダリバッファの再生周波数を同じ比率へ下げる。BGM/SE は DirectSound の独立したストリーミングで Present のスロットルに連動しないため、これが無いと映像と音声がズレ続ける(reports/47) |
| `fps_display_hook` | 画面に焼き付く fps カウンターの表示だけ等倍相当へ補正。無いと等倍へ戻した動画に「30.0fps」と表示され続ける(reports/48) |

MOD 内のメニュー操作待機(`dllmain.cpp` の `ScaledSleep`)も同じ比率で伸びる。

### 2. 監視側の時間も同じ比率で伸ばす

**MOD 内部の待機だけでなく、それを監視する `recording_common.py` 側のタイムアウト・
猶予も同じ比率で伸ばさないと低速録画は成立しない**。`slow_motion_scale()` の係数を掛けて
いるのは以下:

- MOD の `sequence complete` ログを待つタイムアウト
- `POST_START_GRACE_SEC`(リプレイ再生開始後の猶予)
- `STUTTER_PROBE_INTERVAL_SEC` / `_PERIOD_SEC` / `_ACTIVE_UNTIL_SEC`(処理落ち早期検知)
- `TIMEOUT_SEC`(録画のハードタイムアウト。60分 → 120分)
- `STILL_CONSECUTIVE_REQUIRED` / `END_TEMPLATE_CONSECUTIVE_REQUIRED`
  (終了検知の連続回数。`scaled_poll_count()`で切り上げ)

`TIMEOUT_SEC` が倍になることに合わせて、Step Functions の `taskTimeout` と自宅デーモンの
`HOME_WORKER_DRAIN_TIMEOUT_SEC` も 150 分に揃えてある(`infra/lib/sattori-stack.ts`・
`home-worker/README.md`)。

### 3. 等倍への戻しは配信用変換と同じ1パスで行う

等倍への戻しは独立した工程ではなく、**`convert.py` の1パスにウォーターマーク合成・
解像度合わせと一緒に畳み込んである**。録画後の再エンコードはどのタイトル・どの録画速度
でもこの1回だけで、低速録画のためだけに余分なエンコードが走ることはない。

`-r 60` を掛けるのが要点。録画自体は等倍と同じ `-framerate 60` で撮っているので 30Hz
素材は各フレームが2枚ずつ並ぶが、PTS を 1/2 に圧縮してから 60fps へ落とすと**重複が
ちょうど間引かれ**、等倍録画と同じ「60fps・全フレームユニーク」の動画になる。

### 4. 重複フレーム率は生データに対して閾値を換算して判定する

品質チェック(`measure_duplicate_rate()`)が走るのは**等倍へ戻す前の生データ**に対してで、
録画直後・変換前である。ただし低速録画の生データは、ゲームが目標fpsを完璧に維持していても
各フレームが `time_scale` 枚ずつ並ぶ(重複50%)。等倍の閾値をそのまま当てると正常な録画が
必ず「処理落ち」と判定されるため、**閾値の方を換算する**
(`duplicate_rate_threshold_for_raw()`)。ユニークなフレーム数は等倍化で変わらず総フレーム
数だけが `time_scale` 倍になることから

```
生データでの閾値 = (等倍換算の閾値 + (scale - 1) * 100) / scale
```

| 素材(1/2倍速、換算後の閾値65%) | 生データの重複率 | 判定 |
| --- | --- | --- |
| 目標30fpsを維持できた低速録画 | 50% | 通過 |
| 実際には15fpsしか出ていない録画 | 75% | 閾値超過で正しくリトライ |

### 5. 進捗はコンテンツ秒数で報告する

`save_progress_snapshot()` へ渡す進捗は実時間ではなく**コンテンツ秒数**(完成品の動画で
何秒ぶん進んだか)。実時間が倍かかること自体は、フロントエンドがジョブの `slowMotion` を
見て残り時間の見積もりへ織り込む(`apps/web/src/hooks/jobProgressBudget.ts`)。

## 根拠

- **監視側**: reports/47 では、スケール未適用の `POST_START_GRACE_SEC`(15秒)のまま
  ステージ開始の導入演出中に処理落ち検知が走り、3回とも誤ってリトライされる事象が
  実際に起きた。
- **終了検知の連続回数**は秒ではなく**ポーリング回数**だが、ポーリング間隔
  (`POLL_INTERVAL_SEC`)が実時間駆動である以上これも実時間の長さを表している。据え置くと、
  必要な静止の長さがゲーム内時間で半分(16秒→8秒相当)に縮む。低速録画で唯一のタイトルで
  ある th20 は終了検知テンプレートを持たず画面静止のみで判定する(`record_th20.py`)ため
  直撃し、会話イベント等低動作の区間でリプレイ途中を終了と誤判定しうる。しかも
  classification は "good" になるのでリトライされず、途中で切れた動画がそのまま配信される。
- **QC を変換前に置く順序**の利点は、QCで落ちる録画に高価なエンコードを一切かけずに
  捨てられること。
- **閾値を換算する**（生データを先に等倍化してから測るのではなく）ことで、等倍
  (scale=1)では換算しても値が変わらず、th06/07/08/11 の判定は一切変わらない。
- **進捗をコンテンツ秒数にする**のは、分母の `EXPECTED_DURATION_SECONDS` がリプレイの
  再生時間である以上、伸びた実時間をそのまま入れると進捗率が半分に見えてしまうため。
- 全体の実機検証は
  [`docs/reports/2026-08-11-th20-slow-motion-local.md`](../reports/2026-08-11-th20-slow-motion-local.md)。
  原理検証(等倍では最低 19.8fps → 低速録画で安定 30.0fps)は touhou-recorder
  `reports/47`・`reports/48`。

## 採らなかった選択肢

- **低速録画のときだけ別の定数セットを持つ**。定数が二重管理になり、片方だけ更新される
  事故が起きる。倍率を1箇所(`slow_motion_scale()`)に持たせて掛ける方式にした。
- **生データを先に等倍へ戻してから重複フレーム率を測る**。QCで落とす録画にもエンコードを
  かけることになり、順序の利点が消える。
- **等倍への戻しを独立したエンコード工程にする**。再エンコードが1回増えるだけで、
  ウォーターマーク合成・解像度合わせと同じ filter_complex に畳めば済む。

## 影響範囲

- `worker/recording_common.py`(`slow_motion_scale()`・`scaled_poll_count()`・
  `duplicate_rate_threshold_for_raw()`・各タイムアウト定数)
- `worker/convert.py`(`time_scale` 引数・`-r 60`)
- `worker/mods/common/{fps_limiter_hook,dsound_hook,fps_display_hook}.*`
- `infra/lib/sattori-stack.ts`(`taskTimeout`)・`home-worker/README.md`
  (`HOME_WORKER_DRAIN_TIMEOUT_SEC`)
- `apps/web/src/hooks/jobProgressBudget.ts`(残り時間の見積もり)
- リトライが EC2 へ回った場合に備え、録画時の倍率は生データの S3 オブジェクトメタデータ
  (`sattori-time-scale`)で運ぶ([`0015`](0015-resume-from-raw-video-checkpoint.md))
