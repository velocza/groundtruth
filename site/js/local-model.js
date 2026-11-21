/* Local tree inference. Exact float32 training features, no network or LLM. */
(function (root) {
  'use strict';
  const A = root.GT_LOCAL_ARTIFACT;
  if (!A) throw new Error('Local model artifact is missing. Run model/train_local.py.');
  const bytes = Uint8Array.from(atob(A.static_f32_base64), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const features = new Float32Array(bytes.length / 4);
  for (let i = 0; i < features.length; i++) features[i] = view.getFloat32(i * 4, true);
  delete A.static_f32_base64;
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
  function cellFeatures(i, r72, api) {
    const x = Array.from(features.subarray(i*A.static_count, (i+1)*A.static_count));
    return x.concat([r72, api, .55*Math.min(1.5,r72/200)+.45*Math.min(1.3,api/200)]);
  }
  function street(k, r72, api) {
    if (!Number.isFinite(r72) || !Number.isFinite(api)) throw new Error('Rain and wetness must be finite.');
    r72 = Math.max(0, Math.min(400, r72)); api = Math.max(0, Math.min(280, api));
    const key = `${k}:${r72}:${api}`;
    if (cache.has(key)) return cache.get(key);
    const ids = root.GTModel.cellsForStreet(k);
    if (!ids.length) return null;
    const values = []; let worst = ids[0], peak = -1;
    for (const i of ids) {
      const v = predict(cellFeatures(i,r72,api)); values.push(v);
      if (v > peak) { peak = v; worst = i; }
    }
    values.sort((a,b)=>b-a);
    const n = Math.min(values.length, Math.max(3, Math.ceil(values.length*.1)));
    const out = {score: values.slice(0,n).reduce((a,b)=>a+b,0)/n, worst, cells: ids.length, r72, api};
    if (cache.size > 5000) cache.clear();
    cache.set(key, out); return out;
  }
  function explain(k, r72, api) {
    const s = street(k,r72,api); if (!s) return null;
    const x = cellFeatures(s.worst,s.r72,s.api), baseline = predict(x);
    // Counterfactual score changes, not causal effects or additive attribution.
    const checks = [
      ['terrain slope', () => { const a=x.slice(); a[0]=5; a[1]=0; a[2]=0; return a; }],
      ['terrain wetness index', () => { const a=x.slice(); a[4]=5; return a; }],
      ['storm rain', () => cellFeatures(s.worst,0,s.api)],
      ['antecedent wetness', () => cellFeatures(s.worst,s.r72,0)]
    ];
    return checks.map(([name, make])=>({name, change:baseline-predict(make())})).sort((a,b)=>b.change-a.change);
  }
  root.GTLocalModel = {predict, cellFeatures, street, explain, report:A.report};
})(typeof window === 'undefined' ? globalThis : window);
