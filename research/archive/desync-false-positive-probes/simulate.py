"""改善案の判定ルールを既存のMODログ(41件)へ当てて、開発者の目視判定と突き合わせる。"""
import re, sys, json, subprocess, glob, os
B = "/mnt/cache3/sattori-desync-verify/jobs"
P = "/home/hakatashi/Documents/GitHub/sattori/packages/replay-parser/dist/cli/index.js"
verdict = dict(l.split(': ') for l in open(sys.argv[1]).read().strip().splitlines())
# th08スペプラ: オフセット0x08で一致することを memwatch で確認済み(debug/mem/th08-*.log)
TH08_OFF8_MATCH = {"th08-01d5db9c", "th08-33851689", "th08-ab900a45", "th08-e646fd8a"}
START_SPLIT = {"th10", "th11", "th12", "th13", "th15", "th20", "th128", "th14"}  # split.score=ステージ開始時
END_SPLIT = {"th06", "th06nc", "th06c", "th07", "th08"}  # split.score=ステージ終了時(最終要素=最終スコア)
TOL = float(sys.argv[2]) if len(sys.argv) > 2 else 0.003
PIV_OVF = 214748  # piv(異変値x5000)がこれを超えると点アイテム得点の32bit乗算が溢れる
res = []
for jd in sorted(glob.glob(B + "/*")):
    name = os.path.basename(jd); g = name.split('-')[0]
    m = 1 if g.startswith('th06') else 10
    r = json.loads(subprocess.run(["node", P, "-j", jd + "/replay.rpy"], capture_output=True, text=True).stdout)
    rec = r["score"]; splits = r.get("splits", [])
    text = open(glob.glob(jd + "/output/*_autoplay.log")[0], errors='replace').read()
    sc = []; by_stage = {}; first_of_stage = {}
    for x in re.finditer(r"ScoreMonitor: score=(\d+) stage=(-?\d+) lives=(-?\d+) graze=(-?\d+)", text):
        if 0 <= int(x[4]) <= 1_000_000:
            sc.append(int(x[1]) * m); by_stage.setdefault(int(x[2]), set()).add(int(x[1]) * m)
            first_of_stage.setdefault(int(x[2]), int(x[1]) * m)
    S = set(sc)
    cur = rec in S
    if name == "th15-d18b4eb3": cur = True  # Wineクラッシュで desync_result が無いが MOD ログでは一致
    new, why = cur, "記録スコアと一致" if cur else ""
    if not new and name in TH08_OFF8_MATCH:
        new, why = True, "th08 真値(0x08)で一致"
    if not new and g in END_SPLIT and splits and splits[-1]["score"] in S and splits[-1]["score"] != rec:
        new, why = True, "最終ステージの記録スコアと一致"
    # ステージ境界の照合(開始時スコアを持つタイトル)
    boundary_ok, first_bad = None, None
    if g in START_SPLIT and len(splits) > 1:
        boundary_ok = True
        for s in splits[1:]:
            if s["score"] not in by_stage.get(s["stage"], set()):
                boundary_ok, first_bad = False, s["stage"]; break
    mx = max(sc) if sc else 0
    short = rec - mx
    if not new and 0 < short <= TOL * rec and boundary_ok is not False:
        new, why = True, f"終端の取りこぼし許容内(-{short/rec*100:.3f}%)"
    if not new and g == "th20" and len(splits) > 1:
        # ステージ開始時にゲームがリプレイのスコアで上書きした量(=直前ステージでの再生と記録の差)
        corr = [(sp["stage"], sp["score"] - first_of_stage[sp["stage"]], sp.get("piv") or 0)
                for sp in splits[1:] if sp["stage"] in first_of_stage]
        bad = [(st, c, pv) for st, c, pv in corr if c != 0]
        if bad and all(c > 0 and pv > PIV_OVF for st, c, pv in bad):
            new, why = None, f"検証不能(thpracのPIV修正で記録された疑い: 上書き{bad[0][1]:+} @st{bad[0][0]}, piv={bad[0][2]})"
    if new is False:
        why = f"不一致 (max {mx}, 記録 {rec}, 差 {mx-rec:+}, 境界={boundary_ok}{'' if first_bad is None else ' 最初の不一致=st'+str(first_bad)})"
    res.append((name, verdict[name], cur, new, why))
tp = sum(1 for x in res if x[1].startswith('T') and x[3] is True)  # 真のずれを見逃した数
for x in res: print("\t".join(map(str, x)))
def cnt(f): return sum(1 for x in res if f(x))
print(f"# TOL={TOL}")
print("# 現行: F中のtrue", cnt(lambda x: x[1]=='F' and not x[2]), "/", cnt(lambda x: x[1]=='F'), " T中のtrue", cnt(lambda x: x[1]=='T' and not x[2]), "/", cnt(lambda x: x[1]=='T'))
print("# 改善: F中のtrue", cnt(lambda x: x[1]=='F' and x[3] is False), " F中のNone", cnt(lambda x: x[1]=='F' and x[3] is None), " T中のtrue", cnt(lambda x: x[1]=='T' and x[3] is False), " T中の見逃し(一致/None)", cnt(lambda x: x[1]=='T' and x[3] is not False))
