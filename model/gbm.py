"""GroundTruth hand-built gradient boosting (reference implementation).

Only NumPy. No scikit-learn, XGBoost or LightGBM. This is the model described in
the ML plan: second-order (Newton) boosting on logistic loss with histogram splits.

    F_0      = logit(mean(y))
    g_i      = p_i - y_i              gradient of log loss
    h_i      = p_i (1 - p_i)          hessian of log loss
    gain     = 1/2 [ GL^2/(HL+lam) + GR^2/(HR+lam) - G^2/(H+lam) ] - gamma
    leaf w   = -G / (H + lam)
    F_m      = F_{m-1} + eta * tree_m(x)

Run `python3 gbm.py` to execute the self tests and a smoke run on the sample cells.
STATUS: the code is real and tested. It has NOT been trained on landslide labels yet,
because the label set (USGS inventory) and the real InSAR stack are not in the sample.
"""
import json
import numpy as np


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def log_loss(y, p, w=None):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    l = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return float(np.average(l, weights=w))


def auc(y, s):
    """Area under the ROC curve by the rank-sum formula, ties averaged."""
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s)); ranks[order] = np.arange(1, len(s) + 1)
    ss = s[order]; i = 0
    while i < len(ss):                      # average ranks over ties
        j = i
        while j + 1 < len(ss) and ss[j + 1] == ss[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + j + 2) / 2.0
        i = j + 1
    n1 = y.sum(); n0 = len(y) - n1
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


class Binner:
    """Quantile binning: each feature becomes a uint8 bin index (max 255 bins).
    NaN goes to its own last bin so missing InSAR pixels are handled natively."""

    def __init__(self, max_bins=64):
        self.max_bins = max_bins

    def fit(self, X):
        self.edges = []
        for j in range(X.shape[1]):
            col = X[:, j]; col = col[~np.isnan(col)]
            q = np.unique(np.quantile(col, np.linspace(0, 1, self.max_bins + 1)[1:-1])) if len(col) else np.array([])
            self.edges.append(q)
        return self

    def transform(self, X):
        B = np.empty(X.shape, dtype=np.uint8)
        for j, e in enumerate(self.edges):
            b = np.searchsorted(e, X[:, j], side="left")
            b[np.isnan(X[:, j])] = len(e) + 1
            B[:, j] = b
        return B

    def n_bins(self, j):
        return len(self.edges[j]) + 2       # value bins + NaN bin


class Tree:
    """One regression tree grown depth-first on binned features.
    Stored as flat arrays so it exports to JSON for the browser."""

    def __init__(self):
        self.feature, self.threshold, self.bin, self.left, self.right, self.value, self.nan_left = [], [], [], [], [], [], []

    def _node(self):
        for a in (self.feature, self.threshold, self.bin, self.left, self.right, self.value, self.nan_left):
            a.append(-1)
        return len(self.feature) - 1

    def grow(self, B, g, h, idx, binner, p, depth=0, gains=None):
        k = self._node()
        G, H = g[idx].sum(), h[idx].sum()
        self.value[k] = float(-G / (H + p["lam"]))
        if depth >= p["max_depth"] or len(idx) < 2 * p["min_leaf"]:
            return k
        best = (p["gamma"], None)
        parent = G * G / (H + p["lam"])
        for j in p["features"]:
            nb = binner.n_bins(j)
            bj = B[idx, j]
            hg = np.bincount(bj, weights=g[idx], minlength=nb)
            hh = np.bincount(bj, weights=h[idx], minlength=nb)
            hn = np.bincount(bj, minlength=nb)
            gn, hnn, nn = hg[-1], hh[-1], hn[-1]            # NaN bin
            cg, ch, cn = np.cumsum(hg[:-1]), np.cumsum(hh[:-1]), np.cumsum(hn[:-1])
            for nan_left in ((False, True) if nn else (False,)):
                GL = cg + (gn if nan_left else 0); HL = ch + (hnn if nan_left else 0); NL = cn + (nn if nan_left else 0)
                GR, HR, NR = G - GL, H - HL, len(idx) - NL
                ok = (NL >= p["min_leaf"]) & (NR >= p["min_leaf"]) & (HL >= p["min_hess"]) & (HR >= p["min_hess"])
                ok[-1] = False
                gain = 0.5 * (GL * GL / (HL + p["lam"]) + GR * GR / (HR + p["lam"]) - parent)
                gain[~ok] = -np.inf
                b = int(np.argmax(gain))
                if gain[b] > best[0]:
                    best = (float(gain[b]), (j, b, nan_left))
        if best[1] is None:
            return k
        j, b, nan_left = best[1]
        if gains is not None:
            gains[j] += best[0]
        bj = B[idx, j]; isnan = bj == binner.n_bins(j) - 1
        go_left = np.where(isnan, nan_left, bj <= b)
        self.feature[k] = int(j); self.bin[k] = int(b); self.nan_left[k] = bool(nan_left)
        e = binner.edges[j]; self.threshold[k] = float(e[b]) if b < len(e) else float("inf")
        self.left[k] = self.grow(B, g, h, idx[go_left], binner, p, depth + 1, gains)
        self.right[k] = self.grow(B, g, h, idx[~go_left], binner, p, depth + 1, gains)
        return k

    def predict_binned(self, B, binner):
        out = np.empty(len(B)); node = np.zeros(len(B), dtype=np.int64)
        active = np.arange(len(B))
        while len(active):
            nd = node[active]
            f = np.array(self.feature)[nd]
            leaf = f < 0
            out[active[leaf]] = np.array(self.value)[nd[leaf]]
            active = active[~leaf]; nd = nd[~leaf]; f = f[~leaf]
            if not len(active):
                break
            b = B[active, f]
            nb = np.array([binner.n_bins(j) for j in range(B.shape[1])])[f]
            isnan = b == nb - 1
            left = np.where(isnan, np.array(self.nan_left)[nd].astype(bool), b <= np.array(self.bin)[nd])
            node[active] = np.where(left, np.array(self.left)[nd], np.array(self.right)[nd])
        return out

    def to_dict(self):
        return {"feature": self.feature, "threshold": self.threshold, "nan_left": [bool(x) if x != -1 else False for x in self.nan_left],
                "left": self.left, "right": self.right, "value": self.value}


class GroundTruthGBM:
    def __init__(self, n_trees=200, eta=0.08, max_depth=4, min_leaf=20, min_hess=1e-3, lam=1.0, gamma=0.0,
                 subsample=0.8, colsample=0.8, max_bins=64, early_stop=25, seed=0):
        self.p = dict(n_trees=n_trees, eta=eta, max_depth=max_depth, min_leaf=min_leaf, min_hess=min_hess, lam=lam, gamma=gamma,
                      subsample=subsample, colsample=colsample, max_bins=max_bins, early_stop=early_stop)
        self.rng = np.random.default_rng(seed)

    def fit(self, X, y, w=None, X_val=None, y_val=None, names=None):
        p = self.p; n, d = X.shape
        y = y.astype(float); w = np.ones(n) if w is None else w.astype(float)
        self.names = names or [f"f{j}" for j in range(d)]
        self.binner = Binner(p["max_bins"]).fit(X)
        B = self.binner.transform(X)
        pbar = np.clip(np.average(y, weights=w), 1e-6, 1 - 1e-6)
        self.f0 = float(np.log(pbar / (1 - pbar)))
        F = np.full(n, self.f0)
        self.trees, self.train_loss, self.val_loss = [], [], []
        self.gain = np.zeros(d)
        if X_val is not None:
            Bv = self.binner.transform(X_val); Fv = np.full(len(X_val), self.f0); best, best_m = np.inf, 0
        for m in range(p["n_trees"]):
            pr = sigmoid(F)
            g = w * (pr - y); h = w * pr * (1 - pr)
            rows = np.flatnonzero(self.rng.random(n) < p["subsample"]) if p["subsample"] < 1 else np.arange(n)
            k = max(1, int(round(d * p["colsample"])))
            feats = np.sort(self.rng.choice(d, k, replace=False))
            t = Tree(); t.grow(B, g, h, rows, self.binner, dict(p, features=feats), gains=self.gain)
            self.trees.append(t)
            F += p["eta"] * t.predict_binned(B, self.binner)
            self.train_loss.append(log_loss(y, sigmoid(F), w))
            if X_val is not None:
                Fv += p["eta"] * t.predict_binned(Bv, self.binner)
                vl = log_loss(y_val, sigmoid(Fv)); self.val_loss.append(vl)
                if vl < best - 1e-6:
                    best, best_m = vl, m
                elif m - best_m >= p["early_stop"]:
                    self.trees = self.trees[:best_m + 1]; break
        return self

    def raw(self, X):
        B = self.binner.transform(X); F = np.full(len(X), self.f0)
        for t in self.trees:
            F += self.p["eta"] * t.predict_binned(B, self.binner)
        return F

    def predict_proba(self, X):
        return sigmoid(self.raw(X))

    def importance(self):
        s = self.gain.sum() or 1.0
        return sorted(zip(self.names, (self.gain / s).round(4).tolist()), key=lambda t: -t[1])

    def export(self, path):
        """JSON the site can walk: x[feature] <= threshold goes left, NaN follows nan_left."""
        json.dump({"f0": self.f0, "eta": self.p["eta"], "features": self.names, "trees": [t.to_dict() for t in self.trees]}, open(path, "w"))


def platt_fit(scores, y, iters=200, lr=0.5):
    """Calibration: p = sigmoid(a * score + b), fitted by Newton steps on log loss."""
    a, b = 1.0, 0.0
    for _ in range(iters):
        p = sigmoid(a * scores + b); r = p - y; s = p * (1 - p) + 1e-9
        H = np.array([[np.sum(s * scores * scores), np.sum(s * scores)], [np.sum(s * scores), np.sum(s)]]) + 1e-6 * np.eye(2)
        step = np.linalg.solve(H, np.array([np.sum(r * scores), np.sum(r)]))
        a, b = a - lr * step[0], b - lr * step[1]
    return float(a), float(b)


def spatial_blocks(row, col, block=40, k=5, seed=0):
    """Fold id per cell from 40 x 40 cell blocks (about 1.2 km), so neighbours never straddle train and test."""
    bid = (row // block) * 10_000 + (col // block)
    u = np.unique(bid); rng = np.random.default_rng(seed); fold = dict(zip(u, rng.integers(0, k, len(u))))
    return np.array([fold[b] for b in bid])


# ----------------------------------------------------------------------------- tests
def _tests():
    rng = np.random.default_rng(1)
    # Test 1: gradient and hessian match finite differences of the loss.
    F = rng.normal(size=50); y = (rng.random(50) < 0.4).astype(float); eps = 1e-5
    L = lambda f: -(y * np.log(sigmoid(f)) + (1 - y) * np.log(1 - sigmoid(f)))
    g_num = (L(F + eps) - L(F - eps)) / (2 * eps); h_num = (L(F + eps) - 2 * L(F) + L(F - eps)) / eps ** 2
    p = sigmoid(F)
    assert np.allclose(g_num, p - y, atol=1e-6) and np.allclose(h_num, p * (1 - p), atol=1e-4)
    print("test 1 passed: gradient and hessian match finite differences")

    # Test 2: a pure interaction (XOR) that no linear model can fit; loss must fall every round.
    X = rng.uniform(-1, 1, size=(4000, 4)); y = ((X[:, 0] > 0) ^ (X[:, 1] > 0)).astype(float)
    m = GroundTruthGBM(n_trees=60, eta=0.3, max_depth=3, subsample=1.0, colsample=1.0).fit(X[:3000], y[:3000])
    assert all(b <= a + 1e-12 for a, b in zip(m.train_loss, m.train_loss[1:])), "training loss rose"
    acc = ((m.predict_proba(X[3000:]) > 0.5) == y[3000:]).mean()
    assert acc > 0.97, acc
    print(f"test 2 passed: XOR held-out accuracy {acc:.3f}, loss fell monotonically {m.train_loss[0]:.3f} to {m.train_loss[-1]:.4f}")

    # Test 3: missing values, a rare positive class, early stopping and calibration together.
    n = 12000; X = rng.normal(size=(n, 6)); z = -4.2 + 1.6 * X[:, 0] + 1.2 * np.maximum(X[:, 1], 0) * X[:, 2] + 0.8 * (X[:, 3] > 1)
    y = (rng.random(n) < sigmoid(z)).astype(float); X[rng.random((n, 6)) < 0.1] = np.nan
    tr, va, te = slice(0, 7000), slice(7000, 9500), slice(9500, n)
    m = GroundTruthGBM(n_trees=400, eta=0.08, max_depth=4).fit(X[tr], y[tr], X_val=X[va], y_val=y[va])
    a, b = platt_fit(m.raw(X[va]), y[va]); pt = sigmoid(a * m.raw(X[te]) + b)
    A = auc(y[te], pt); base = log_loss(y[te], np.full(len(y[te]), y[tr].mean()))
    assert A > 0.80 and log_loss(y[te], pt) < base and len(m.trees) < 400
    assert abs(pt.mean() - y[te].mean()) < 0.01
    print(f"test 3 passed: {y.mean():.1%} positives, 10% missing, AUC {A:.3f}, stopped at {len(m.trees)} trees, "
          f"mean predicted {pt.mean():.4f} vs observed {y[te].mean():.4f}")
    return True


def _smoke(csv="../dataset/cells_sample_20k.csv", out="trees_smoke.json"):
    """Fit the sample cells to the site's placeholder tiers. This only proves the pipeline runs end to end
    on GroundTruth features with spatial folds. It is NOT a landslide model: the target is our own formula."""
    import csv as _csv, os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), csv)
    rows = list(_csv.DictReader(open(path)))
    feats = ["slope_deg", "plan_curv", "prof_curv", "relief_m", "twi", "dist_stream_m", "dist_road_m", "ndvi_2026", "ndmi_2026",
             "SIM_v_los_2016_2022_mm_yr", "SIM_v_los_last12mo_mm_yr", "SIM_coherence"]
    X = np.array([[float(r[f]) for f in feats] for r in rows]); row = np.array([int(r["row"]) for r in rows]); col = np.array([int(r["col"]) for r in rows])
    clip = lambda x, a, b: np.minimum(np.maximum(x, a), b)
    s = clip((X[:, 0] - 8) / 22, 0, 1); h = clip(-X[:, 1] / 0.01, 0, 1); mm = clip(X[:, 10] / 20, 0, 1); a = clip((X[:, 10] - X[:, 9]) / 15, 0, 1)
    T = 0.55 * min(1.5, 140 / 200) + 0.45 * min(1.3, 230 / 200)          # the hero storm on the site
    idx = 100 * sigmoid(-6.5 + 3.0 * s + 0.8 * h + 1.0 * mm + 1.2 * a + 3.5 * T + 2.0 * s * T + 1.6 * mm * T)
    y = (idx >= 50).astype(float)
    fold = spatial_blocks(row, col); aucs = []
    for k in range(5):
        te = fold == k; va = fold == (k + 1) % 5; tr = ~(te | va)
        m = GroundTruthGBM(n_trees=150, eta=0.1, max_depth=4).fit(X[tr], y[tr], X_val=X[va], y_val=y[va], names=feats)
        aucs.append(auc(y[te], m.predict_proba(X[te])))
    m.export(os.path.join(os.path.dirname(os.path.abspath(__file__)), out))
    print(f"smoke run: {len(y)} cells, {y.mean():.1%} above Elevated, 5 spatial folds, AUC {np.mean(aucs):.3f} (min {min(aucs):.3f})")
    print("top features by gain:", ", ".join(f"{n} {v:.2f}" for n, v in m.importance()[:4]))
    print("exported", len(m.trees), "trees to", out)


if __name__ == "__main__":
    _tests()
    _smoke()
