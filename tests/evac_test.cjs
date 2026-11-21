/* Getting out: a tiny made-up street network run through the real graph builder (scripts/08_road_graph.py) and the real
   graph code (site/js/evac.js). Run with: node tests/evac_test.cjs

   Layout, in metres on a 2 km box with 50 m cells (west and east edges are the ways out):

        (500,1800)-----D-----(800,1800)        three homes sit on loop D
            |                    |
            C2                   D
            |                    |
        (500,1500)-----D-----(800,1500)
            |
            C1   <- the only link between the loop and the main road: a single point of failure
            |
   W ===A===+===A===(1000,1000)=====B===== E     A and B meet 5 m apart, so they only join if snapping works
*/
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), KX = 87800, KY = 110950, SIZE = 2000, NXY = 40;
const P = (x, y) => [x / KX, y / KY];
const lines = [
  [P(5, 1000), P(500, 1000), P(1000, 1000)],                       // 0 A: leaves the box to the west
  [P(1004, 1003), P(1500, 1000), P(1995, 1000)],                   // 1 B: starts 5 m from the end of A, leaves to the east
  [P(500, 1006), P(500, 1500), P(500, 1800)],                      // 2 C: spur that meets A at a vertex in the middle of A
  [P(500, 1500), P(800, 1500), P(800, 1800), P(500, 1800)]         // 3 D: loop off the top of the spur
];
const buildings = [P(790, 1650), P(650, 1810), P(660, 1490), P(250, 990), P(1400, 1010), P(1500, 1700)];   // the last one is 700 m from any road
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evac-')), fin = path.join(tmp, 'in.json'), fout = path.join(tmp, 'out.json');
fs.writeFileSync(fin, JSON.stringify({ bbox: [0, 0, SIZE / KX, SIZE / KY], nx: NXY, ny: NXY, lines, buildings }));
execFileSync('python3', [path.join(ROOT, 'scripts', '08_road_graph.py'), '--json', fin, fout]);
const raw = JSON.parse(fs.readFileSync(fout, 'utf8'));

require(path.join(ROOT, 'site', 'js', 'evac.js'));
const C = globalThis.GTEvac.core, grid = { bbox: [0, 0, SIZE / KX, SIZE / KY], NX: NXY, NY: NXY };
// the browser file format: flat arrays, edge geometry as a reference into the street list (here one "street" per line)
const flat = { meta: raw.meta, nodes: raw.nodes.flat(), exits: raw.exits, base: raw.base, cellOff: [0], cells: [],
  edges: raw.eu.flatMap((u, e) => [u, raw.ev[e], raw.el[e], 0, raw.ea[e], raw.eb[e], raw.elen[e], raw.b0[e], raw.b1[e]]) };
for (const c of raw.cells) { flat.cells.push(...c); flat.cellOff.push(flat.cells.length); }
const streets = lines.map((g, i) => ({ n: 'ABCD'[i] + ' Street', t: 'Test', g: [g] }));
const g = C.Graph(flat, streets, grid);
const at = (x, y) => { let best = -1, bd = 1e9; for (let n = 0; n < g.nn; n++) { const d = Math.hypot(g.x[n] - x, g.y[n] - y); if (d < bd) { bd = d; best = n; } } assert(bd < 12, `no node near ${x},${y}`); return best; };
const edge = (a, b) => { for (let e = 0; e < g.ne; e++) if ((g.eu[e] === a && g.ev[e] === b) || (g.eu[e] === b && g.ev[e] === a)) return e; assert.fail('no edge'); };
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const W = at(5, 1000), J = at(500, 1000), M = at(1000, 1000), E = at(1995, 1000), S1 = at(500, 1500), S2 = at(500, 1800);
ok('snapping: ends 5 m apart are one junction, a T junction lands on the through road', () => {
  assert.strictEqual(g.nn, 6, 'six junctions'); assert.strictEqual(g.ne, 6, 'six pieces of road: bends are not junctions');
  assert.strictEqual(at(1004, 1003), M); assert.strictEqual(at(500, 1006), J);
  assert(Math.abs(g.elen[edge(J, S1)] - 494) < 1, 'length in metres');
});
ok('exits: only the two roads that leave the box', () => {
  assert.deepStrictEqual([...g.exits].sort(), [W, E].sort()); assert(!g.exits.includes(S2), 'a dead end 200 m inside is not an exit');
});
ok('homes: nearest road, nearer end, and "no road found" beyond 150 m', () => {
  assert.strictEqual(raw.meta.buildings_no_road, 1); assert.strictEqual(raw.meta.buildings_placed, 5); assert.strictEqual(g.homes, 5);
  assert.strictEqual(g.nb[S1] + g.nb[S2], 3, 'three homes on the loop');
});
ok('reachability with nothing blocked: everyone gets out by the shorter way', () => {
  const r = C.route(g, null, null); assert(r.reach.every(v => v === 1));
  assert(Math.abs(r.metres[J] - 495) < 1, 'west exit is nearer'); assert(Math.abs(r.metres[S2] - (495 + 494 + 300)) < 2);
  assert.strictEqual(C.pathFrom(g, r, S2).exit, W);
});
ok('bridges: the spur is the single point of failure, the loop and the main road are not', () => {
  const b = C.bridges(g), spur = edge(J, S1);
  assert.strictEqual(b.isBridge[spur], 1); assert.strictEqual(b.cut[spur], 3, 'three homes behind it'); assert.strictEqual(b.far[spur], S1);
  assert.strictEqual(b.isBridge.reduce((a, v) => a + v, 0), 1, 'no other bridge: the main road has an exit at each end and the loop has two ways round');
});

// hazards on a made-up score: one hot cell on the spur, and a debris path that crosses road A west of the junction
const cellOf = (x, y) => Math.round((SIZE - y) / SIZE * NXY - 0.5) * NXY + Math.round(x / SIZE * NXY - 0.5);
const hot = cellOf(500, 1250), srcCell = cellOf(250, 1300), pathCells = [srcCell, cellOf(250, 1200), cellOf(250, 1100), cellOf(250, 1000)];
const env = { g, score: (i, sc) => (i === hot ? sc.hot : i === srcCell ? sc.src : 10), runout: () => ({ path: pathCells }), srcCells: Int32Array.from([srcCell]), stream: () => 500, mapped: null, opts: { thr: 50 } };
const hz = C.makeHazards(env);
ok('blocking: a road is blocked when a cell on it reaches the threshold, and the homes behind it are stranded', () => {
  const calm = C.evaluate(env, hz, { hot: 40, src: 0, r72: 0 }, ['slide', 'runout']); assert.strictEqual(calm.nBlocked, 0); assert.strictEqual(calm.stranded, 0);
  const ev = C.evaluate(env, hz, { hot: 60, src: 0, r72: 0 }, ['slide', 'runout']), spur = edge(J, S1);
  assert.strictEqual(ev.blocked[spur], 1); assert.strictEqual(ev.nBlocked, 1); assert.strictEqual(ev.stranded, 3); assert.strictEqual(ev.streetsCut, 1, 'all three homes stand on D Street'); assert.strictEqual(ev.byStreet.get(3), 3);
  assert(/scores 60/.test(ev.reason(spur))); assert.strictEqual(ev.r.reach[S2], 0); assert.strictEqual(ev.r.reach[J], 1);
  assert.deepStrictEqual(C.blockers(g, ev, S2), [spur], 'the blocked segment that shuts the loop in');
  env.opts.thr = 75; assert.strictEqual(C.evaluate(env, hz, { hot: 60, src: 0, r72: 0 }, ['slide']).nBlocked, 0, 'High threshold'); env.opts.thr = 50;
});
ok('debris runout: a path from a high-scoring slope blocks the road it crosses, and the route turns east', () => {
  const ev = C.evaluate(env, hz, { hot: 0, src: 90, r72: 0 }, ['slide', 'runout']), west = edge(W, J);
  assert.strictEqual(ev.blocked[west], 1); assert.strictEqual(ev.counts.runout, 1); assert.strictEqual(ev.counts.slide, 0); assert(/debris path/.test(ev.reason(west)));
  assert.strictEqual(ev.stranded, 0, 'there is still a way out to the east'); assert.strictEqual(C.pathFrom(g, ev.r, J).exit, E);
  assert(Math.abs(ev.r.metres[J] - (500 + 991)) < 3, 'real length of the way round');
  assert.strictEqual(C.evaluate(env, hz, { hot: 0, src: 90, r72: 0 }, ['slide']).nBlocked, 0, 'runout is its own switch');
});
ok('recorded slides: within 30 m of the road blocks it, 35 m does not, and it is a separate switch', () => {
  const near = C.mappedEdges(g, [P(525, 1250)], C.MAP_M), far = C.mappedEdges(g, [P(535, 1250)], C.MAP_M), spur = edge(J, S1);
  assert.strictEqual(near.flag[spur], 1); assert.deepStrictEqual(near.touch[0], [spur]); assert.strictEqual(far.flag[spur], 0); assert.strictEqual(far.touch[0].length, 0);
  const seg = C.mappedEdges(g, [[...P(450, 1700), ...P(600, 1700)]], C.MAP_M); assert.strictEqual(seg.flag[edge(S1, S2)], 1, 'a slide outline that crosses the road');
  env.mapped = near.flag;
  assert.strictEqual(C.evaluate(env, hz, { hot: 0, src: 0, r72: 0 }, ['slide', 'runout']).nBlocked, 0, 'off in forecast mode');
  const ev = C.evaluate(env, hz, { hot: 0, src: 0, r72: 0 }, ['mapped23']); assert.strictEqual(ev.stranded, 3); assert(/recorded within 30 m/.test(ev.reason(spur)));
});
ok('creek proxy: only with heavy rain forecast and only when switched on', () => {
  const wet = { ...env, stream: i => (i === hot ? 4 : 500) }, h2 = C.makeHazards(wet);
  assert.strictEqual(C.evaluate(wet, h2, { hot: 0, src: 0, r72: 150 }, ['slide', 'runout']).nBlocked, 0);
  assert.strictEqual(C.evaluate(wet, h2, { hot: 0, src: 0, r72: 50 }, ['flood']).nBlocked, 0);
  assert.strictEqual(C.evaluate(wet, h2, { hot: 0, src: 0, r72: 150 }, ['flood']).stranded, 3);
});
ok('ranking helper: a perfect separation scores 1, a tie scores one half', () => { assert.strictEqual(C.auc([3, 4], [1, 2]), 1); assert.strictEqual(C.auc([1], [1]), 0.5); });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} checks passed`);
