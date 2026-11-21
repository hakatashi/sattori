"""Count differing dst alpha pixels between two dump dirs (paired by identical src). Usage: count_diff.py A B"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import numpy as np
from compare_xfer_dumps import collect
A, B = collect(sys.argv[1]), collect(sys.argv[2])
for k in A:
    if k not in B: continue
    aa, ab = A[k][3][4], B[k][3][4]
    d = aa != ab
    ys, xs = np.nonzero(d)
    print(os.path.basename(A[k][1]), "diff px", int(d.sum()), "/", d.size, list(zip(xs.tolist(), ys.tolist(), aa[d].tolist(), ab[d].tolist()))[:6])
