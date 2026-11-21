/* Local tree inference for the Lamorinda landslide model (local_model_landslide, written to site/data/local-model.js by
   model/export_landslide_site.py). Exact float32 training features, no network or LLM. Loaded for Lamorinda only. */
(function (root) {
  'use strict';
  const A = root.GT_LOCAL_ARTIFACT;
  if (!A) return;                                                    // areas without a landslide model load no artifact
  const bytes = Uint8Array.from(atob(A.static_f32_base64), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer), SC = A.static_count, NF = SC + 3;
  const features = new Float32Array(bytes.length / 4);
  for (let i = 0; i < features.length; i++) features[i] = view.getFloat32(i * 4, true);
  delete A.static_f32_base64;
  const NC = features.length / SC, F = name => A.features.indexOf(name);
  const valid = new Uint8Array(NC);
  for (let i = 0; i < NC; i++) { let ok = 1; for (let j = 0; j < SC; j++) if (Number.isNaN(features[i * SC + j])) { ok = 0; break; } valid[i] = ok; }
  const cache = new Map();
  function predict(x) {
    let f = A.f0;
    for (const t of A.trees) {
      let n = 0;
      while (t.feature[n] >= 0) {
        const v = x[t.feature[n]];
        n = (Number.isNaN(v) ? t.nan_left[n] : v <= t.threshold[n]) ? t.left[n] : t.right[n];
      }
      f += A.eta * t.value[n];
    }
    return 100 / (1 + Math.exp(-Math.max(-35, Math.min(35, f))));
  }
  const trig = (r72, api) => .55 * Math.min(1.5, r72 / 200) + .45 * Math.min(1.3, api / 200);
  function cellFeatures(i, r72, api) {
    const x = Array.from(features.subarray(i * SC, (i + 1) * SC));
    return x.concat([r72, api, trig(r72, api)]);
  }
  const clampStorm = (r72, api) => {
    if (!Number.isFinite(r72) || !Number.isFinite(api)) throw new Error('Rain and wetness must be finite.');
    return [Math.max(0, Math.min(400, r72)), Math.max(0, Math.min(280, api))];
  };
  /* every cell of the grid for one storm; cached for the last few storms */
  const areaCache = new Map();
  function area(r72, api) {
    [r72, api] = clampStorm(r72, api);
    const key = r72 + ':' + api; if (areaCache.has(key)) return areaCache.get(key);
    const lay = root.GTModel && root.GTModel.lsLayer && root.GTModel.lsLayer({ r72, api });
    if (lay && lay.length === NC) {                                  // the precomputed map (model/export_landslide_layers.py), same trees to 0.4 points
      const out = new Float32Array(NC); for (let i = 0; i < NC; i++) out[i] = lay[i] / 2.55;
      if (areaCache.size > 3) areaCache.delete(areaCache.keys().next().value);
      areaCache.set(key, out); return out;
    }
    const out = new Float32Array(NC), x = new Float64Array(NF); x[SC] = r72; x[SC + 1] = api; x[SC + 2] = trig(r72, api);
    for (let i = 0; i < NC; i++) { for (let j = 0; j < SC; j++) x[j] = features[i * SC + j]; out[i] = predict(x); }
    if (areaCache.size > 3) areaCache.delete(areaCache.keys().next().value);
    areaCache.set(key, out); return out;
  }
  function topMean(values) {
    values.sort((a, b) => b - a);
    const n = Math.min(values.length, Math.max(3, Math.ceil(values.length * .1)));
    return values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  }
  function street(k, r72, api) {
    [r72, api] = clampStorm(r72, api);
    const key = `${k}:${r72}:${api}`;
    if (cache.has(key)) return cache.get(key);
    const ids = root.GTModel.cellsForStreet(k);
    if (!ids.length) return null;
    const pre = areaCache.get(r72 + ':' + api) || (root.GTModel.landslide && root.GTModel.landslide() ? area(r72, api) : null), values = []; let worst = ids[0], peak = -1;
    for (const i of ids) {
      const v = pre ? pre[i] : predict(cellFeatures(i, r72, api)); values.push(v);
      if (v > peak) { peak = v; worst = i; }
    }
    const out = { score: topMean(values), worst, cells: ids.length, r72, api };
    if (cache.size > 5000) cache.clear();
    cache.set(key, out); return out;
  }
  /* every street with at least 12 cells, highest first, from one area pass */
  function rank(r72, api, n) {
    const s = area(r72, api), out = [];
    for (let k = 0; k < n; k++) {
      const ids = root.GTModel.cellsForStreet(k); if (ids.length < 12) continue;
      let worst = ids[0], peak = -1; const values = [];
      for (const i of ids) { const v = s[i]; values.push(v); if (v > peak) { peak = v; worst = i; } }
      out.push({ k, score: topMean(values), worst, cells: ids.length });
    }
    return out.sort((a, b) => b.score - a.score);
  }
  /* references for the counterfactual checks, by feature name so they follow the model's column order */
  const REFS = [
    ['terrain slope', { slope_deg: 5, slope_max_90m: 5, northness: 0, eastness: 0 }],
    ['local relief', { relief_150m: 5 }],
    ['terrain wetness index', { twi: 5 }],
    ['distance to a stream', { dist_stream_m: 500 }]
  ];
  function explain(k, r72, api) {
    const s = street(k, r72, api); if (!s) return null;
    return explainCell(s.worst, s.r72, s.api);
  }
  function explainCell(cell, r72, api) {
    const s = { worst: cell, r72, api };
    const x = cellFeatures(s.worst, s.r72, s.api), baseline = predict(x);
    // Counterfactual score changes, not causal effects or additive attribution.
    const checks = REFS.filter(([, ref]) => Object.keys(ref).every(n => F(n) >= 0)).map(([name, ref]) => [name, () => { const a = x.slice(); for (const n in ref) a[F(n)] = ref[n]; return a; }])
      .concat([['storm rain', () => cellFeatures(s.worst, 0, s.api)], ['antecedent wetness', () => cellFeatures(s.worst, s.r72, 0)]]);
    return checks.map(([name, make]) => ({ name, change: baseline - predict(make()) })).sort((a, b) => b.change - a.change);
  }
  root.GTLocalModel = { predict, cellFeatures, street, explain, explainCell, area, rank, valid, cells: NC, report: A.report };
})(typeof window === 'undefined' ? globalThis : window);
