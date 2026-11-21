# mod-probes — ステージ・スコア探索用のプローブ

`worker/mods/common/` にあったが、どの `dllmain.cpp` からもインクルードされず Makefile にも載っていなかった
（ビルドされないまま残っていた）探索用のフック。Issue #392 で `worker/mods` から移した。

- `stage_probe_hook.{h,cpp}`（648行）: ステージ・ゲーム状態のメモリを監視してログに出すプローブ。
- `score_probe_hook.{h,cpp}`（132行）: スコアの RVA を探すためのプローブ。

採用しなかった理由: スコアの RVA は特定済みで `score_monitor` が担っており、実運用では使わないため。
新しいタイトルの RVA 探索で参考にできるよう、コードだけ残してある。

動かすには、`worker/mods/common/` へ戻して該当タイトルの `dllmain.cpp` から呼び、Makefile のソースに足す
（このディレクトリはビルド・テストの対象外）。
