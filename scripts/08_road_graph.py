"""GroundTruth build, part 8: a routable road graph for the "Getting out" view.

Reads the named street centrelines the site already ships (site/data/data.js, Overture/OSM) and the building points
(dataset/buildings_lamorinda.csv) and writes site/data/roads_graph.js.

  nodes   snapped polyline endpoints and junctions (endpoints within TOL_M of each other are one node)
  edges   polyline pieces between nodes, each with its length in metres and the 29 m grid cells it crosses
  exits   dead-end nodes within EXIT_M of the map edge whose road is heading out of the box
  homes   each building goes to the nearest road (not the nearest node: junctions can be 1 km apart on a rural road),
          then to the nearer end of that piece of road. Over MAX_BLD_M from any road counts as "no road found".

Usage:  python3 scripts/08_road_graph.py                 (real data, writes site/data/roads_graph.js)
        python3 scripts/08_road_graph.py --json in out   (tests: {"bbox","nx","ny","lines":[[[lon,lat],..],..],"buildings":[[lon,lat],..]})
Standard library + numpy only.
"""
import sys, os, csv, json, math, datetime
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOL_M, EXIT_M, MAX_BLD_M, STEP_M = 10.0, 60.0, 150.0, 10.0
# Exits are inferred from where the clipped centrelines stop, so two corrections are made by name and reported in the page:
# through-roads whose last mapped vertex sits further inside the box than EXIT_M, and courts, which are dead ends by definition.
FAR_EXITS, FAR_EXIT_M = ('San Pablo Dam Road', 'Taylor Boulevard'), 200.0
KX, KY = 87800.0, 110950.0                                     # metres per degree here, the same constants as site/js/model.js


class UF:
    def __init__(s, n): s.p = list(range(n))
    def find(s, a):
        while s.p[a] != a: s.p[a] = s.p[s.p[a]]; a = s.p[a]
        return a
    def union(s, a, b): s.p[s.find(a)] = s.find(b)


def build(lines, bbox, nx, ny, buildings, tol=TOL_M, exit_m=EXIT_M, max_bld=MAX_BLD_M, never_exit=(), far_exit=()):
    """lines: list of polylines [[lon, lat], ...]. Returns a dict of plain lists (see the module docstring)."""
    W, S, E, N = bbox
    X = lambda lo: (lo - W) * KX
    Y = lambda la: (la - S) * KY
    # every vertex gets a global id; vid[l] is the id of the first vertex of line l
    vid, P = [], []
    for ln in lines: vid.append(len(P)); P.extend((X(p[0]), Y(p[1])) for p in ln)
    P = np.array(P, float).reshape(-1, 2); nv = len(P); uf = UF(nv)
    line_of = np.repeat(np.arange(len(lines)), [len(l) for l in lines])
    is_end = np.zeros(nv, bool)
    for l, ln in enumerate(lines): is_end[vid[l]] = is_end[vid[l] + len(ln) - 1] = True

    # 1. snap: an endpoint joins any vertex of another line within tol (an end meeting an end, or a T junction onto a vertex)
    grid = {}
    for i, (x, y) in enumerate(P): grid.setdefault((int(x // tol), int(y // tol)), []).append(i)
    is_node = is_end.copy(); n_tjoin = n_proj = 0
    def near(i):
        cx, cy = int(P[i, 0] // tol), int(P[i, 1] // tol)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((cx + dx, cy + dy), ()):
                    if j != i and math.hypot(P[i, 0] - P[j, 0], P[i, 1] - P[j, 1]) <= tol: yield j
    for i in np.flatnonzero(is_end):
        for j in near(i):
            if line_of[j] == line_of[i] and not is_end[j]: continue     # do not weld a line to its own next vertex
            uf.union(i, j)
            if not is_node[j]: is_node[j] = True; n_tjoin += 1
    # 2. interior vertices that two different lines share exactly are crossings
    seen = {}
    for i in np.flatnonzero(~is_end):
        k = (round(P[i, 0], 2), round(P[i, 1], 2)); j = seen.setdefault(k, i)
        if j != i and line_of[j] != line_of[i]: uf.union(i, j); is_node[i] = is_node[j] = True
    # 3. a still-loose endpoint lying on the middle of another line's segment (no vertex there): join it to the segment's nearer end
    roots = {}
    for i in np.flatnonzero(is_node): roots.setdefault(uf.find(i), []).append(i)
    loose = [g[0] for g in roots.values() if len(g) == 1 and is_end[g[0]]]
    if loose:
        A, B = [], []                                          # all segments, as vertex id pairs
        for l, ln in enumerate(lines):
            for k in range(len(ln) - 1): A.append(vid[l] + k); B.append(vid[l] + k + 1)
        A, B = np.array(A), np.array(B); a, d = P[A], P[B] - P[A]; dd = np.maximum((d * d).sum(1), 1e-9)
        for i in loose:
            t = np.clip(((P[i] - a) * d).sum(1) / dd, 0, 1); dist = np.hypot(*(a + d * t[:, None] - P[i]).T)
            dist[line_of[A] == line_of[i]] = 1e9; s = int(dist.argmin())
            if dist[s] <= tol:
                j = int(A[s] if t[s] < 0.5 else B[s]); uf.union(i, j); is_node[j] = True; n_proj += 1

    # nodes: one per welded group, placed at the mean of its vertices
    node_id, groups = {}, []
    for i in np.flatnonzero(is_node):
        r = uf.find(i)
        if r not in node_id: node_id[r] = len(groups); groups.append([])
        groups[node_id[r]].append(i)
    NP = np.array([P[g].mean(0) for g in groups]); nn = len(NP)
    nid = lambda i: node_id[uf.find(i)]

    # edges: cut every line at its node vertices
    cell = lambda x, y: (int(round((N - (S + y / KY)) / (N - S) * ny - 0.5)), int(round(x / KX / (E - W) * nx - 0.5)))
    EU, EV, EL, ES, EA, EB, ELEN, ECELLS, SAMP = [], [], [], [], [], [], [], [], []
    for l, ln in enumerate(lines):
        a = 0
        for b in range(1, len(ln)):
            if not is_node[vid[l] + b]: continue
            pts = P[vid[l] + a:vid[l] + b + 1]; seg = np.hypot(*np.diff(pts, axis=0).T); length = float(seg.sum())
            u, v = nid(vid[l] + a), nid(vid[l] + b)
            if length < 0.5 and u == v: a = b; continue          # two welded vertices in a row: not a road
            cells, samp = [], []
            for k in range(len(pts) - 1):                        # walk the piece every STEP_M to list the cells it crosses
                m = max(1, int(math.ceil(seg[k] / STEP_M)))
                for q in range(m + (k == len(pts) - 2)):
                    x, y = pts[k] + (pts[k + 1] - pts[k]) * q / m; samp.append((x, y)); r, c = cell(x, y)
                    if 0 <= r < ny and 0 <= c < nx and (not cells or cells[-1] != r * nx + c): cells.append(r * nx + c)
            e = len(EU); EU.append(u); EV.append(v); EL.append(l); EA.append(a); EB.append(b); ELEN.append(round(length, 1))
            ECELLS.append(list(dict.fromkeys(cells))); SAMP.append((e, np.array(samp))); a = b
    ne = len(EU); deg = np.bincount(np.array(EU + EV, int), minlength=nn) if ne else np.zeros(nn, int)

    # exits: a dead end close to the map edge whose last stretch points out of the box (the source data is clipped at the box)
    Wm, Hm, exits = X(E), Y(N), []
    for n in range(nn):
        if deg[n] != 1: continue
        x, y = NP[n]; dm, side = min((x, 0), (Wm - x, 1), (y, 2), (Hm - y, 3))
        e = next(k for k in range(ne) if EU[k] == n or EV[k] == n); s = SAMP[e][1]
        if EL[e] in never_exit or dm > (FAR_EXIT_M if EL[e] in far_exit else exit_m): continue
        if EU[e] != n: s = s[::-1]
        back = s[min(len(s) - 1, 3)]; out = (back[0] - x, x - back[0], back[1] - y, y - back[1])[side]   # > 0 when the road was heading for that edge
        if out > 0 or len(s) < 2: exits.append(n)

    # homes: nearest road sample within max_bld, then the nearer end of that edge
    eb0, eb1 = [0] * ne, [0] * ne; far = 0; dists = []
    if len(buildings) and ne:
        SE = np.concatenate([np.full(len(s), e) for e, s in SAMP]); SP = np.concatenate([s for _, s in SAMP])
        SF = np.concatenate([np.linspace(0, 1, len(s)) for _, s in SAMP])       # how far along its edge each sample sits
        g = max_bld; sg = {}
        for i, (x, y) in enumerate(SP): sg.setdefault((int(x // g), int(y // g)), []).append(i)
        sg = {k: np.array(v) for k, v in sg.items()}
        for lo, la in buildings:
            x, y = X(lo), Y(la); cx, cy = int(x // g), int(y // g)
            cand = [sg[(cx + dx, cy + dy)] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (cx + dx, cy + dy) in sg]
            if not cand: far += 1; continue
            cand = np.concatenate(cand); d = np.hypot(SP[cand, 0] - x, SP[cand, 1] - y); j = int(d.argmin())
            if d[j] > max_bld: far += 1; continue
            dists.append(float(d[j])); e = int(SE[cand[j]])
            if SF[cand[j]] < 0.5: eb0[e] += 1
            else: eb1[e] += 1
    nb = [0] * nn
    for e in range(ne): nb[EU[e]] += eb0[e]; nb[EV[e]] += eb1[e]

    # plain connectivity with nothing blocked, so the browser can tell "no way out in a storm" from "not joined up in this street data"
    adj = [[] for _ in range(nn)]
    for e in range(ne): adj[EU[e]].append(EV[e]); adj[EV[e]].append(EU[e])
    reach = np.zeros(nn, bool); stack = list(exits); reach[exits] = True
    while stack:
        n = stack.pop()
        for m in adj[n]:
            if not reach[m]: reach[m] = True; stack.append(m)
    comp = np.full(nn, -1); nc = 0
    for n0 in range(nn):
        if comp[n0] >= 0: continue
        comp[n0] = nc; stack = [n0]
        while stack:
            n = stack.pop()
            for m in adj[n]:
                if comp[m] < 0: comp[m] = nc; stack.append(m)
        nc += 1
    nbv = np.array(nb); placed = int(nbv.sum()); linked = int(nbv[reach].sum())
    ends = int(is_end.sum()); welded = sum(1 for g in groups for i in g if is_end[i] and len(g) > 1)
    dists.sort()
    meta = dict(tol_m=tol, exit_m=exit_m, max_bld_m=max_bld, nodes=nn, edges=ne, exits=len(exits), components=nc, road_km=round(sum(ELEN) / 1000, 1),
                endpoints=ends, endpoints_joined=welded, t_junctions_on_vertex=n_tjoin, t_junctions_on_segment=n_proj,
                buildings=len(buildings), buildings_no_road=far, buildings_placed=placed, buildings_linked=linked, buildings_unlinked=placed - linked,
                bld_dist_median_m=round(dists[len(dists) // 2], 1) if dists else None, bld_dist_p90_m=round(dists[int(len(dists) * 0.9)], 1) if dists else None)
    return dict(meta=meta, nodes=[[round(W + x / KX, 5), round(S + y / KY, 5)] for x, y in NP], exits=exits,
                eu=EU, ev=EV, el=EL, ea=EA, eb=EB, elen=ELEN, cells=ECELLS, b0=eb0, b1=eb1, base=[int(v) for v in reach])


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--json':
        j = json.load(open(sys.argv[2])); g = build(j['lines'], j['bbox'], j['nx'], j['ny'], j.get('buildings', []), j.get('tol', TOL_M), j.get('exit_m', EXIT_M), j.get('max_bld', MAX_BLD_M))
        json.dump(g, open(sys.argv[3], 'w')); return
    src = open(os.path.join(ROOT, 'site', 'data', 'data.js')).read(); G = json.loads(src[src.index('{'):src.rindex('}') + 1])
    lines, ref = [], []                                        # ref: which street and which of its polylines each line is
    for k, st in enumerate(G['streets']):
        for s, pl in enumerate(st['g']): lines.append(pl); ref.append((k, s))
    with open(os.path.join(ROOT, 'dataset', 'buildings_lamorinda.csv')) as fh: bld = [(float(r['lon']), float(r['lat'])) for r in csv.DictReader(fh)]
    name = lambda l: G['streets'][ref[l][0]]['n']
    g = build(lines, G['meta']['bbox'], G['meta']['nx'], G['meta']['ny'], bld, never_exit={l for l in range(len(lines)) if name(l).endswith(' Court')},
              far_exit={l for l in range(len(lines)) if name(l) in FAR_EXITS}); m = g['meta']; m['far_exits'] = list(FAR_EXITS)
    m.update(built=datetime.date.today().isoformat(), streets=len(G['streets']), polylines=len(lines))
    print(json.dumps(m, indent=1))
    print(f"endpoints joined to another line: {m['endpoints_joined'] / m['endpoints']:.1%}")
    print(f"buildings with no road within {MAX_BLD_M:.0f} m: {m['buildings_no_road']} ({m['buildings_no_road'] / m['buildings']:.1%}); on roads with no link to an exit even when dry: {m['buildings_unlinked']} ({m['buildings_unlinked'] / m['buildings']:.1%})")
    names = sorted({G['streets'][ref[g['el'][e]][0]]['n'] for n in g['exits'] for e in range(len(g['eu'])) if g['eu'][e] == n or g['ev'][e] == n})
    print(len(g['exits']), 'exits on', len(names), 'streets:', ', '.join(names))
    # compact form for the browser: flat arrays; edge geometry is a (street, polyline, first vertex, last vertex) reference into GT.streets
    flat = lambda rows: [v for r in rows for v in r]
    off, cells = [0], []
    for c in g['cells']: cells.extend(c); off.append(len(cells))
    js = dict(meta=m, nodes=flat(g['nodes']), exits=g['exits'], base=g['base'],
              edges=flat([g['eu'][e], g['ev'][e], ref[g['el'][e]][0], ref[g['el'][e]][1], g['ea'][e], g['eb'][e], g['elen'][e], g['b0'][e], g['b1'][e]] for e in range(len(g['eu']))),
              cellOff=off, cells=cells)
    out = os.path.join(ROOT, 'site', 'data', 'roads_graph.js')
    open(out, 'w').write('/* Generated by scripts/08_road_graph.py from site/data/data.js and dataset/buildings_lamorinda.csv. Do not edit. */\nwindow.GT_ROADS=' + json.dumps(js, separators=(',', ':')) + ';\n')
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main()
