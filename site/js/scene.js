/* GroundTruth 3D terrain: real elevation and Sentinel-2 imagery, risk and motion drawn in the fragment shader. */
(function () {
  const Mo = window.GTModel;
  const SX = 14.06, SZ = 13.34, EXAG = 2.1;            // km east-west, km north-south, vertical exaggeration
  let renderer, scene, camera, mesh, rain, uniforms, canvas;
  const cam = { px: -3, py: 9.5, pz: 17, tx: 0, ty: 0, tz: 0.5 };       // driven by GSAP
  const orbit = { on: false, az: 0, el: 0.7, dist: 16, tx: 0, tz: 0 };
  const markers = [], labels = [];
  let streetLine = null, clock = 0, last = performance.now(), running = true, reduced = false;

  function tex(img, linear) {
    const t = new THREE.Texture(img); t.needsUpdate = true; t.generateMipmaps = false;
    t.minFilter = t.magFilter = linear === false ? THREE.NearestFilter : THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
  }
  function heightAt(u, v) {                               // u east 0..1, v north 0..1 (1 = north edge)
    const x = u * (Mo.NX - 1), y = (1 - v) * (Mo.NY - 1), c = Math.min(Mo.NX - 2, Math.floor(x)), r = Math.min(Mo.NY - 2, Math.floor(y));
    const fx = x - c, fy = y - r, e = Mo.L.elev, i = r * Mo.NX + c;
    return (e[i] * (1 - fx) * (1 - fy) + e[i + 1] * fx * (1 - fy) + e[i + Mo.NX] * (1 - fx) * fy + e[i + Mo.NX + 1] * fx * fy) / 1000 * EXAG;
  }
  function worldOf(lon, lat, lift) {
    const [W, S, E, N] = Mo.bbox, u = (lon - W) / (E - W), v = (lat - S) / (N - S);
    return new THREE.Vector3((u - 0.5) * SX, heightAt(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))) + (lift || 0), (0.5 - v) * SZ);
  }

  const VERT = `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const FRAG = `precision highp float;
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    uniform sampler2D tSatA, tSatB, tTerrain, tMotion, tRoads, tBld, tLSA, tLSB; uniform float uLS, uLSMix, uLSOff;
    uniform float uBld; uniform vec2 uGrid;
    uniform float uSplit, uSplitVis, uR72, uApi, uEra, uAmt, uRisk, uMotion, uRoads, uTime, uDim, uHiOn, uHiR, uUseMotion, uBias;
    uniform vec2 uHi; uniform vec3 uSun, uBg;
    vec3 ramp(float x){
      vec3 a = vec3(0.16,0.07,0.36), b = vec3(0.74,0.13,0.40), c = vec3(1.0,0.50,0.14), d = vec3(1.0,0.92,0.68);
      return x < 0.4 ? mix(a,b,x/0.4) : x < 0.75 ? mix(b,c,(x-0.4)/0.35) : mix(c,d,(x-0.75)/0.25);
    }
    void main(){
      vec3 t = texture2D(tTerrain, vUv).rgb, m = texture2D(tMotion, vUv).rgb;
      float slope = t.r * 51.0, planc = t.b * 0.04 - 0.02, asp = t.g * 6.2831853;
      float vpre = m.r * 40.0 - 8.0, v23 = m.g * 80.0 - 8.0, vnow = m.b * 40.0 - 8.0;
      float vr = mix(vnow, mix(vpre, v23, uAmt), uEra);
      float s = clamp((slope - 8.0) / 22.0, 0.0, 1.0), h = clamp(-planc / 0.01, 0.0, 1.0);
      float mm = uUseMotion * clamp(vr / 20.0, 0.0, 1.0), a = uUseMotion * clamp((vr - vpre) / 15.0, 0.0, 1.0);
      float T = 0.55 * min(1.5, uR72 / 200.0) + 0.45 * min(1.3, uApi / 200.0);
      float z = uBias + 3.0*s + 0.8*h + 1.0*mm + 1.2*a + 3.5*T + 2.0*s*T + 1.6*mm*T;
      float idx = 1.0 / (1.0 + exp(-z));
      if (uLS > 0.5) { float p = clamp(mix(texture2D(tLSA, vUv).r, texture2D(tLSB, vUv).r, uLSMix), 0.002, 0.998); idx = 1.0 / (1.0 + exp(-(log(p / (1.0 - p)) + uLSOff))); }   // trained landslide model (Lamorinda)

      vec3 sat = mix(texture2D(tSatA, vUv).rgb, texture2D(tSatB, vUv).rgb, step(uSplit, vUv.x));
      float lum = dot(sat, vec3(0.299,0.587,0.114));
      float day = uSplitVis;                                        // compare mode shows the imagery in daylight
      vec3 night = mix(vec3(lum), sat, 0.5) * vec3(0.56,0.66,0.90) * 1.25 + vec3(0.014,0.018,0.034);
      vec3 base = mix(night, pow(sat, vec3(0.8)) * 1.45, day);
      float sh = clamp(dot(normalize(vN), normalize(uSun)), 0.0, 1.0);
      base *= mix(0.55 + 0.75 * sh, 0.8 + 0.35 * sh, day);

      float road = texture2D(tRoads, vUv).r;
      base += vec3(0.62,0.70,0.90) * road * uRoads * 0.42;

      vec3 col = base * (1.0 - 0.45 * uRisk * smoothstep(0.1, 0.7, idx));
      float al = smoothstep(0.10, 0.80, idx);
      col += ramp(idx) * al * uRisk * (1.05 + 0.25 * sin(uTime * 1.6 + vW.x * 2.0 + vW.z * 1.3) * step(0.75, idx));

      float mv = smoothstep(1.5, 11.0, vr) * uMotion * uUseMotion;                // bands follow the contours and travel downhill, faster where the ground is faster
      float ph = vW.y * 120.0 + uTime * (1.1 + vr * 0.13);
      float fr = pow(0.5 + 0.5 * sin(ph), 2.0);
      col *= 1.0 - 0.6 * mv * day;
      col += mix(vec3(0.35,0.75,1.0), vec3(1.0,0.86,0.55), clamp(vr / 24.0, 0.0, 1.0)) * mv * (0.16 + 0.95 * fr);

      // real building footprints: one dot per 29 m cell that holds a building, lit only where the ground under it scores Elevated or High
      vec2 gc = vUv * uGrid, cc = (floor(gc) + 0.5) / uGrid; float nb = texture2D(tBld, cc).r * 255.0;
      float dot_ = (1.0 - smoothstep(0.16, 0.34, length(fract(gc) - 0.5))) * step(0.5, nb);
      col = mix(col, mix(vec3(0.55,0.62,0.78), vec3(1.0,0.98,0.92), smoothstep(0.42, 0.52, idx)), dot_ * uBld * mix(0.28, 1.0, smoothstep(0.42, 0.52, idx)));

      float sl = 1.0 - smoothstep(0.0, 0.0016, abs(vUv.x - uSplit));
      col += vec3(1.0,0.95,0.85) * sl * uSplitVis;

      vec2 dh = (vUv - uHi) * vec2(1.054, 1.0);
      float rr = length(dh), ring = 1.0 - smoothstep(0.0, 0.0022, abs(rr - uHiR * (0.75 + 0.25 * sin(uTime * 3.0))));
      col += vec3(1.0,0.95,0.8) * ring * uHiOn;

      vec2 e = min(vUv, 1.0 - vUv); float edge = smoothstep(0.0, 0.07, min(e.x, e.y));
      col = mix(uBg, col * (1.0 - uDim), edge);
      gl_FragColor = vec4(col, 1.0);
    }`;

  function build(cv) {
    canvas = cv;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    scene = new THREE.Scene();
    const bg = new THREE.Color(0x0b0c10); renderer.setClearColor(bg, 1);
    camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);

    const segX = 300, segZ = 284, geo = new THREE.PlaneGeometry(SX, SZ, segX, segZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(uv.getX(i), uv.getY(i)));
    geo.computeVertexNormals();

    const I = Mo.images;
    uniforms = {
      tSatA: { value: tex(I.s2_2023) }, tSatB: { value: tex(I.s2_2026) }, tTerrain: { value: tex(I.terrain) }, tMotion: { value: tex(I.motion) }, tRoads: { value: tex(I.roads) }, tBld: { value: tex(I.buildings || I.roads, false) }, uBld: { value: 0 }, tLSA: { value: null }, tLSB: { value: null }, uLS: { value: 0 }, uLSMix: { value: 1 }, uLSOff: { value: 0 }, uGrid: { value: new THREE.Vector2(Mo.NX, Mo.NY) },
      uSplit: { value: 0 }, uSplitVis: { value: 0 }, uR72: { value: 60 }, uApi: { value: 120 }, uEra: { value: 0 }, uAmt: { value: 0 },
      uRisk: { value: 0.6 }, uMotion: { value: 0.6 }, uRoads: { value: 0 }, uTime: { value: 0 }, uDim: { value: 0 }, uHiOn: { value: 0 }, uHiR: { value: 0.012 }, uUseMotion: { value: 1 }, uBias: { value: -6.5 },
      uHi: { value: new THREE.Vector2(0.5, 0.5) }, uSun: { value: new THREE.Vector3(-0.55, 0.62, 0.35) }, uBg: { value: bg }
    };
    mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    scene.add(mesh);

    // rain: streaks falling over the box, density follows the storm
    const n = 5200, rp = new Float32Array(n * 3), rs = new Float32Array(n);
    for (let i = 0; i < n; i++) { rp[i * 3] = (Math.random() - 0.5) * SX * 1.1; rp[i * 3 + 1] = Math.random() * 7; rp[i * 3 + 2] = (Math.random() - 0.5) * SZ * 1.1; rs[i] = Math.random(); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('seed', new THREE.BufferAttribute(rs, 1));
    rain = new THREE.Points(rg, new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uAmt: { value: 0 }, uPx: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float seed; uniform float uTime, uAmt, uPx; varying float vA;
        void main(){ vec3 p = position; p.y = mod(p.y - uTime * (5.0 + seed * 3.0), 7.0); p.x += p.y * 0.12;
          vec4 mv = modelViewMatrix * vec4(p,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * (26.0 + seed * 30.0) / -mv.z;
          vA = step(seed, uAmt) * (0.25 + 0.5 * seed) * smoothstep(0.0, 0.6, p.y); }`,
      fragmentShader: `precision mediump float; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float a = (1.0 - smoothstep(0.02, 0.07, abs(c.x + c.y * 0.12))) * (1.0 - abs(c.y) * 2.0); gl_FragColor = vec4(0.72, 0.82, 1.0, a * vA); }`
    }));
    rain.frustumCulled = false; scene.add(rain);

    resize(); window.addEventListener('resize', resize); if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); requestAnimationFrame(frame); } });
    requestAnimationFrame(frame);
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 58 : 36;
    if (shiftPx > 0.5) camera.setViewOffset(w, h, -shiftPx, 0, w, h); else if (camera.view) camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  let shiftPx = 0;
  function setShift(px) { shiftPx = px; const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; if (px > 0.5) camera.setViewOffset(w, h, -px, 0, w, h); else if (camera.view) camera.clearViewOffset(); camera.updateProjectionMatrix(); }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; if (!reduced) clock += dt; uniforms.uTime.value = clock;
    if (orbit.on) {
      const ce = Math.cos(orbit.el);
      camera.position.set(orbit.tx + orbit.dist * ce * Math.sin(orbit.az), orbit.dist * Math.sin(orbit.el), orbit.tz + orbit.dist * ce * Math.cos(orbit.az));
      camera.lookAt(orbit.tx, 0.2, orbit.tz);
    } else {
      const d = reduced ? 0 : Math.sin(clock * 0.12) * 0.35;
      camera.position.set(cam.px + d, cam.py, cam.pz); camera.lookAt(cam.tx, cam.ty, cam.tz);
    }
    for (const mk of markers) if (mk.mesh.visible) { mk.mesh.material.opacity = 0.55 + 0.35 * Math.sin(clock * 3 + mk.ph); }
    renderer.render(scene, camera);
    if (labels.length) { const w = canvas.clientWidth, h = canvas.clientHeight; for (const lb of labels) {
      if (!lb.on) { lb.el.hidden = true; continue; }
      const p = lb.pos.clone().project(camera); const vis = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      lb.el.hidden = !vis; if (vis) lb.el.style.transform = `translate3d(${((p.x + 1) / 2 * w).toFixed(1)}px,${((1 - p.y) / 2 * h).toFixed(1)}px,0)`;
    } }
    requestAnimationFrame(frame);
  }

  /* beacons for documented slides */
  function addMarker(lon, lat, labelEl) {
    const base = worldOf(lon, lat, 0), g = new THREE.CylinderGeometry(0.012, 0.03, 1.5, 8, 1, true); g.translate(0, 0.75, 0);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe2a6, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.copy(base); m.visible = false; scene.add(m);
    const mk = { mesh: m, ph: Math.random() * 6 }; markers.push(mk);
    const lb = { el: labelEl, pos: base.clone().add(new THREE.Vector3(0, 1.55, 0)), on: false }; labels.push(lb);
    return { show(v) { m.visible = v; lb.on = v; } };
  }
  function addLabel(lon, lat, el, lift) {
    const lb = { el, pos: worldOf(lon, lat, lift || 0.05), on: false }; labels.push(lb);
    return { show(v) { lb.on = v; if (!v) el.hidden = true; } };
  }
  function ribbon(segs, color, wdt, lift) {               // list of polylines [[lon,lat],...] drawn as a flat ribbon so it has real width
    const v = [];
    for (const seg of segs) for (let k = 0; k + 1 < seg.length; k++) {
      const a = worldOf(seg[k][0], seg[k][1], lift), b = worldOf(seg[k + 1][0], seg[k + 1][1], lift);
      let nx = -(b.z - a.z), nz = b.x - a.x; const l = Math.hypot(nx, nz) || 1; nx = nx / l * wdt; nz = nz / l * wdt;
      v.push(a.x - nx, a.y, a.z - nz, a.x + nx, a.y, a.z + nz, b.x + nx, b.y, b.z + nz, a.x - nx, a.y, a.z - nz, b.x + nx, b.y, b.z + nz, b.x - nx, b.y, b.z - nz);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
    m.renderOrder = 5; scene.add(m); return m;
  }
  const drop = m => { if (m) { scene.remove(m); m.geometry.dispose(); } return null; };
  function showStreet(segs) { streetLine = drop(streetLine); if (segs) streetLine = ribbon(segs, 0xfff1cf, 0.015, 0.045); }
  let pathLine = null, pathEnd = null;
  function showPath(pts) {                                // debris runout path, with a marker where it stops
    pathLine = drop(pathLine); pathEnd = drop(pathEnd); if (!pts || pts.length < 2) return;
    pathLine = ribbon([pts], 0x7fe3ff, 0.022, 0.06); pathLine.renderOrder = 6;
    const e = pts[pts.length - 1], g = new THREE.RingGeometry(0.05, 0.075, 28); g.rotateX(-Math.PI / 2);
    pathEnd = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
    pathEnd.position.copy(worldOf(e[0], e[1], 0.07)); pathEnd.renderOrder = 6; scene.add(pathEnd);
  }
  function highlight(lon, lat, on) {
    const [W, S, E, N] = Mo.bbox; uniforms.uHi.value.set((lon - W) / (E - W), (lat - S) / (N - S)); uniforms.uHiOn.value = on === false ? 0 : 1;
  }
  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), v = new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(v, camera); const hit = rc.intersectObject(mesh)[0]; if (!hit) return null;
    const [W, S, E, N] = Mo.bbox; return [W + hit.uv.x * (E - W), S + hit.uv.y * (N - S)];
  }
  function focusPose(lon, lat, dist, shift) {             // camera pose looking at a place from the south; shift slides the place right of centre
    const p = worldOf(lon, lat, 0), d = dist || 4.2, sx = (shift || 0) * d;
    return { px: p.x - d * 0.2 - sx, py: p.y + d * 0.62, pz: p.z + d * 0.82, tx: p.x - sx, ty: p.y, tz: p.z };
  }

  /* the trained model's score layer for the current storm (Uint8 per cell, rows north to south); fades from the previous one */
  const lsTex = [];
  function setLandslide(layer, fade) {
    if (!uniforms || !layer) return;
    const cv = document.createElement('canvas'); cv.width = Mo.NX; cv.height = Mo.NY; const x = cv.getContext('2d'), im = x.createImageData(Mo.NX, Mo.NY);
    for (let i = 0; i < layer.length; i++) { const o = i * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = layer[i]; im.data[o + 3] = 255; }
    x.putImageData(im, 0, 0); const t = tex(cv);
    if (!lsTex.length) { uniforms.tLSA.value = uniforms.tLSB.value = t; lsTex.push(t); uniforms.uLS.value = 1; uniforms.uLSMix.value = 1; return; }
    const prev = uniforms.tLSB.value; uniforms.tLSA.value = prev; uniforms.tLSB.value = t; uniforms.uLSMix.value = 0;
    if (lsTex.length > 2) lsTex.shift().dispose(); lsTex.push(t);
    if (fade && window.gsap && !reduced) gsap.to(uniforms.uLSMix, { value: 1, duration: 0.5, ease: 'power2.out', overwrite: true }); else uniforms.uLSMix.value = 1;
  }
  window.GTScene = { setLandslide, build, cam, orbit, get u() { return uniforms; }, get rain() { return rain.material.uniforms.uAmt; }, addMarker, addLabel, showStreet, showPath, highlight, pick, focusPose, worldOf,
    setReduced(v) { reduced = v; }, resize, setShift,
    project(lon, lat, lift) { const p = worldOf(lon, lat, lift || 0.05).project(camera); return p.z < 1 ? [(p.x + 1) / 2 * canvas.clientWidth, (1 - p.y) / 2 * canvas.clientHeight] : null; } };   // screen position of a place, for 2D overlays
})();
