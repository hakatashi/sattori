# フェーズ57: th10のフル尺録画検証・stage RVA訂正・スコア完全一致検証

日付: 2026-08-28

## 位置づけ

フェーズ56で確立したth10のメニュー自動化・VsyncPatch統合・リプレイ終了検知(end_template方式)を使い、AGENTS.mdの新規タイトル対応チェックリストのうち項目4(フル尺録画、通常+Extra)・8(内部データ取得機能)の実機検証を行った。あわせて、フェーズ56で「異常値」と誤認していたステージ番号RVAについて訂正を行った。

## 【訂正】stage RVA(`STAGE_NUM`, RVA=0x74c7c)は正常だった

フェーズ56で、`th10_07.rpy`を使ったフル尺検証時にステージ番号が終始`stage=6`固定になることを「異常値」と判断していたが、これは**誤認だった**(ユーザー指摘により発覚)。

`@sattori/touhou-replay-parser`で`th10_07.rpy`を再確認したところ、`splits.length=1`・`splits[0].stage=6`であり、**プラクティスモードで6面のみをプレイしたリプレイ**であることが判明した。プラクティス開始面が6面固定のリプレイである以上、ステージ番号が終始6のままなのは正しい挙動であり、RVA自体には問題がなかった。

念のため、`games/th10/replay/`内の全25本のリプレイについて`splits`の内容(通しプレイ=`stage: 1,2,3,4,5,6`か、プラクティス=一部ステージのみか)を確認した:

```bash
cd ../sattori/packages/replay-parser
node --input-type=module -e "... r.replay.splits.map(s=>s.stage).join(',') ..."
```

結果、`th10_07.rpy`(splits=6のみ)・`th10_14.rpy`(splits=5,6)・`th10_16.rpy`(splits=6のみ)・`th10_17.rpy`(splits=6のみ)・`th10_18.rpy`(splits=5,6)がいずれもプラクティス専用リプレイであり、通しプレイ(`splits=1,2,3,4,5,6`)は`th10_01/02/04/05/06/08/11/12/21/22/23/24/25.rpy`だった(Extra系`th10_03/09/10/13/15/19/20.rpy`はExtraステージ自体が単一ステージ構成のため`splits=7`の1件で正常)。

この訂正を受けて、`mods/th10_replay_autoplay/dllmain.cpp`の`InstallStageMarkerHook`を有効化した(フェーズ56時点では`rva=0`で無効化していた)。

## 通常ステージ(通しプレイ)のフル尺録画検証

### リプレイ選定

「通常ステージのフル尺録画」検証には1面から最終面まで通しでプレイしたリプレイが必要なため、フェーズ56で使った`th10_07.rpy`(プラクティス6面のみ)は不適切と判断し、通しプレイ(`splits=1..6`)の中で最短の`th10_24.rpy`(ReimuB / Lunatic / cleared=false、ゲームオーバーで6面まで到達 / 67,332フレーム=1122秒≒18.7分)を採用した。

### 実行コマンドと結果

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th10 --replay th10_24.rpy --max-attempts 1 \
    --output runs/th10_bringup2/e2e_normal_full.mp4
```

(`--no-audio`を付けず、音声込みのフル尺録画として実行)

- **ステージ開始時刻の自動検出(`InstallStageMarkerHook`有効化後)が1〜6面全て正しく機能した**:
  ```
  00:00 動画開始
  00:13 1面
  02:27 2面
  05:15 3面
  08:35 4面
  12:35 5面
  16:51 6面
  ```
- リプレイ終了検知(フェーズ56のend_template方式)も正しく機能し、1126.6秒経過時点(実際のリプレイ本編1122秒とほぼ一致)で自然終了を検知。
- 総録画時間1142.4秒、**録画開始15秒以降の重複フレーム率0.0%**。
- 音声・映像別プロセス方式(AGENTS.md記載の標準方式)でのA/V同期補正が機能: `video_start=1787918345.016 audio_start=1787918345.609 delta=+0.593s`を検出し、`-itsoffset 0.592984`でmux。

### スコア完全一致検証

```bash
python3 scripts/53_verify_replay_score.py --game th10 games/th10/replay/th10_24.rpy \
    instances/th10-multigame-recording-test/th10_autoplay.log
```

```
タイトル      : th10
リプレイ      : th10_24.rpy (Lunatic / Stage 1 ～ 6 / koyi)
記録時スコア  : 150,277,360
再生時スコア  : 150,277,360 (内部値15,027,736×10, 最大150,277,360)
到達ステージ  : 6  残機: 0  グレイズ: 0
スコア動作時間: 1119.2s  サンプル数: 999
警告          : 再生中に残機が負になっています(ゲームオーバー)
判定          : 一致(デシンクなし)
```

**記録スコアと再生時スコアが完全一致**し、フェーズ56で暫定としていた「score内部値は表示値の1/10(×10系列)」という推測が実機で裏付けられた。`scripts/53_verify_replay_score.py`の`GAME_MULTIPLIERS`に`"th10": 10`を追加した。「残機が負」警告はゲームオーバー時の想定内の一時的な値(th07/th08で確認されている解放済みメモリのゴミ値と同種の現象、AGENTS.md参照)であり、スコア判定には影響しない。

## Extraステージのフル尺録画検証

`th10_19.rpy`(MarisaA / Extra Stage Clear / 41,264フレーム=688秒≒11.5分、フェーズ56で選定済み)で検証:

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th10 --replay th10_19.rpy --no-audio --max-attempts 1 \
    --output runs/th10_bringup2/e2e_extra1.mp4
```

- end_template方式による終了検知が692.5秒経過時点(実際のリプレイ本編688秒とほぼ一致)で正しく機能。
- 総録画時間707.2秒、**録画開始15秒以降の重複フレーム率0.0%**。
- VsyncPatch(`vpatch_th10.dll`)導入後もメニュー自動操作・スコア監視・終了検知いずれも通常ステージと同様に問題なく機能することを確認(このテストが本フェーズで最初の`extra_dlls`込みの実機検証)。

## 未実施・次フェーズへの持ち越し

1. 音声波形とゲームプレイ内容の対応関係を目視・耳での確認(A/V同期補正のログ上の整合性は確認したが、実際の聴感上の確認は未実施)
2. 低速録画機能(1/2倍速)の実装・検証
3. `th10_p3_nopatch.rpy` / `th10_p3_patch.rpy` によるバグマリ修正(`BugFixTh10Power3`)の要否検証(4パターンの組み合わせテストが必要、`games/th10/vpatch.ini`の切り替えが前提)
4. chara/subshot RVA(+0x68/+0x6c)の実機検証、graze要否の裏付け調査
5. クラウド実機検証(AWS、推奨インスタンスタイプの確認)
