"""ステージ開始時にゲームがリプレイ記録のスコアで上書きする量(=そのステージまでの再生スコアと記録の差)を測る。"""
import re, sys, json, subprocess, glob, os
B = "/mnt/cache3/sattori-desync-verify/jobs"
P = "/home/hakatashi/Documents/GitHub/sattori/packages/replay-parser/dist/cli/index.js"
verdict = dict(l.split(': ') for l in open(sys.argv[1]).read().strip().splitlines())
paths = sys.argv[2:] or sorted(glob.glob(B + "/*"))
for jd in paths:
    name = os.path.basename(jd.rstrip('/')); g = name.split('-')[0]
    m = 1 if g.startswith('th06') else 10
    r = json.loads(subprocess.run(["node", P, "-j", glob.glob(B + "/" + name + "/replay.rpy")[0]], capture_output=True, text=True).stdout)
    splits = r.get("splits", [])
    if len(splits) < 2 or splits[0]["score"] != 0: continue
    rows = []
    for x in re.finditer(r"ScoreMonitor: score=(\d+) stage=(-?\d+) lives=(-?\d+) graze=(-?\d+)", open(glob.glob(jd + "/output/*_autoplay.log")[0], errors='replace').read()):
        rows.append((int(x[1]) * m, int(x[2]), int(x[3])))
    out = []
    for s in splits[1:]:
        st, target = s["stage"], s["score"]
        idx = [i for i, row in enumerate(rows) if row[1] == st]
        if not idx: out.append(f"st{st}:未到達"); continue
        before = rows[idx[0]][0]  # 新ステージ最初のサンプル(クリアボーナス加算後・上書き前)
        out.append(f"st{st}:{target - before:+}")
    final_short = max(x[0] for x in rows) - r["score"]
    print(f"{name} [{verdict.get(name,'?')}] " + " ".join(out) + f" | 最終 {final_short:+} ({final_short / r['score'] * 100:+.4f}%)")
