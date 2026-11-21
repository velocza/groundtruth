/* scree 3D map. Real elevation and Sentinel-2 imagery on the ground, real building outlines extruded to their mapped heights,
   real road centre lines, water, green space and place names (Overture Maps), sun shadows, and the risk score drawn as light.
   Buildings and roads are built tile by tile after the first frame so the page stays responsive. */
(function () {
  const Mo = window.GTModel;
  const SX = 14.06, SZ = 13.34, EXAG = 1.6;             // km east-west, km north-south, vertical exaggeration (terrain and buildings alike)
  const LITE = (window.matchMedia && matchMedia('(pointer:coarse)').matches) || Math.min(window.innerWidth, window.innerHeight) < 620;   // phones and tablets get a lighter build
  const SEGX = LITE ? 240 : 479, SEGZ = LITE ? 228 : 455, VIS = LITE ? 4 : 15;     // terrain grid, and how far (km) buildings stand up
  let renderer, scene, camera, mesh, rain, uniforms, canvas, HG;
  const cam = { px: -3, py: 9.5, pz: 17, tx: 0, ty: 0, tz: 0.5 };       // driven by GSAP
  const orbit = { on: false, az: 0, el: 0.7, dist: 16, tx: 0, tz: 0 };  // free look target; the camera eases toward it
  const sm = { on: false, az: 0, el: 0.7, dist: 16, tx: 0, tz: 0 }, view = { dist: 16, tx: 0, ty: 0, tz: 0 };
  const markers = [], labels = [], layers = { buildings: true, roads: true, labels: true };
  let streetLine = null, clock = 0, last = performance.now(), running = true, reduced = false;
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

  function tex(img, linear) {
    const t = new THREE.Texture(img); t.needsUpdate = true; t.generateMipmaps = false;
    t.minFilter = t.magFilter = linear === false ? THREE.NearestFilter : THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
  }
  function demAt(u, v) {                                  // bilinear elevation, u east 0..1, v north 0..1 (1 = north edge)
    const x = u * (Mo.NX - 1), y = (1 - v) * (Mo.NY - 1), c = Math.min(Mo.NX - 2, Math.floor(x)), r = Math.min(Mo.NY - 2, Math.floor(y));
    const fx = x - c, fy = y - r, e = Mo.L.elev, i = r * Mo.NX + c;
    return (e[i] * (1 - fx) * (1 - fy) + e[i + 1] * fx * (1 - fy) + e[i + Mo.NX] * (1 - fx) * fy + e[i + Mo.NX + 1] * fx * fy) / 1000 * EXAG;
  }
  function heightAt(u, v) {                               // height of the drawn terrain surface: the same two triangles per grid square as the mesh
    const x = clamp01(u) * SEGX, y = (1 - clamp01(v)) * SEGZ, c = Math.min(SEGX - 1, Math.floor(x)), r = Math.min(SEGZ - 1, Math.floor(y));
    const fx = x - c, fy = y - r, i = r * (SEGX + 1) + c, a = HG[i], d = HG[i + 1], b = HG[i + SEGX + 1], cc = HG[i + SEGX + 2];
    return fx + fy <= 1 ? a + (d - a) * fx + (b - a) * fy : cc + (b - cc) * (1 - fx) + (d - cc) * (1 - fy);
  }
  const groundXZ = (x, z) => heightAt(x / SX + 0.5, 0.5 - z / SZ);
  function worldOf(lon, lat, lift) {
    const [W, S, E, N] = Mo.bbox, u = (lon - W) / (E - W), v = (lat - S) / (N - S);
    return new THREE.Vector3((u - 0.5) * SX, heightAt(u, v) + (lift || 0), (0.5 - v) * SZ);
  }
  const liftOf = l => Math.min(0.012, (l || 0.05) * 0.16);   // callers pass lifts sized for the old far-away camera; keep markers close to the ground

  /* ------------------------------------------------ shaders */
  const COMMON = `precision highp float;
    uniform sampler2D tTerrain, tMotion, tShadow;
    uniform float uR72, uApi, uEra, uAmt, uUseMotion, uBias, uTime, uShadowOn, uShadowTexel, uShadowRes, uFogD, uSplitVis, uRisk;
    uniform mat4 uShadowMat; uniform vec3 uSun, uBg;
    vec3 ramp(float x){
      vec3 a = vec3(0.16,0.07,0.36), b = vec3(0.74,0.13,0.40), c = vec3(1.0,0.50,0.14), d = vec3(1.0,0.92,0.68);
      return x < 0.4 ? mix(a,b,x/0.4) : x < 0.75 ? mix(b,c,(x-0.4)/0.35) : mix(c,d,(x-0.75)/0.25);
    }
    float motionAt(vec2 uv, out float vpre){
      vec3 m = texture2D(tMotion, uv).rgb; vpre = m.r * 40.0 - 8.0;
      return mix(m.b * 40.0 - 8.0, mix(vpre, m.g * 80.0 - 8.0, uAmt), uEra);
    }
    float riskIdx(vec2 uv){                                // the placeholder score, same terms as model.js
      vec3 t = texture2D(tTerrain, uv).rgb; float vpre, vr = motionAt(uv, vpre);
      float slope = t.r * 51.0, planc = t.b * 0.04 - 0.02;
      float s = clamp((slope - 8.0) / 22.0, 0.0, 1.0), h = clamp(-planc / 0.01, 0.0, 1.0);
      float mm = uUseMotion * clamp(vr / 20.0, 0.0, 1.0), a = uUseMotion * clamp((vr - vpre) / 15.0, 0.0, 1.0);
      float T = 0.55 * min(1.5, uR72 / 200.0) + 0.45 * min(1.3, uApi / 200.0);
      float z = uBias + 3.0*s + 0.8*h + 1.0*mm + 1.2*a + 3.5*T + 2.0*s*T + 1.6*mm*T;
      return 1.0 / (1.0 + exp(-z));
    }
    float shadowAt(vec3 w, vec3 n){                        // 1 in sun, 0 in shadow; five taps soften the edge
      if (uShadowOn < 0.01) return 1.0;
      vec4 sc = uShadowMat * vec4(w + n * uShadowTexel * 1.8, 1.0);
      vec2 q = abs(sc.xy - 0.5); float inside = 1.0 - smoothstep(0.40, 0.49, max(q.x, q.y));
      if (inside <= 0.0 || sc.z > 1.0) return 1.0;
      float z = sc.z - 0.00035, px = 1.0 / uShadowRes, s = step(z, texture2D(tShadow, sc.xy).r);
      s += step(z, texture2D(tShadow, sc.xy + vec2(px, px * 0.4)).r) + step(z, texture2D(tShadow, sc.xy + vec2(-px * 0.4, px)).r);
      s += step(z, texture2D(tShadow, sc.xy + vec2(-px, -px * 0.4)).r) + step(z, texture2D(tShadow, sc.xy + vec2(px * 0.4, -px)).r);
      return mix(1.0, s / 5.0, inside * uShadowOn);
    }
    vec3 haze(vec3 col, vec3 w){ float d = distance(w, cameraPosition) / uFogD; return mix(col, uBg, 1.0 - exp(-d * d)); }
  `;
  const VERT = `varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
  const FRAG = COMMON + `
    varying vec2 vUv; varying vec3 vN; varying vec3 vW;
    uniform sampler2D tSatA, tSatB, tMask, tNormal, tPhoto;
    uniform float uSplit, uMotion, uDim, uHiOn, uHiR, uMask, uFoot, uNormal, uPhoto;
    uniform vec2 uHi;
    void main(){
      float idx = riskIdx(vUv), vpre, vr = motionAt(vUv, vpre);
      vec3 mk = texture2D(tMask, vUv).rgb * uMask;
      float water = smoothstep(0.35, 0.65, mk.r), green = mk.g, foot = mk.b;
      vec3 sat = mix(texture2D(tSatA, vUv).rgb, texture2D(tSatB, vUv).rgb, step(uSplit, vUv.x));
      float pho = uPhoto * (1.0 - step(0.001, uSplit)); sat = mix(sat, texture2D(tPhoto, vUv).rgb, pho);   // the aerial photo is the ground everywhere except the two-date satellite compare
      float lum = dot(sat, vec3(0.299,0.587,0.114));
      float day = uSplitVis;                                        // compare mode and the Daylight layer show the imagery in daylight
      vec3 n = normalize(mix(vN, texture2D(tNormal, vUv).rgb * 2.0 - 1.0, uNormal));   // hillshade from the 10 m elevation model where it is loaded
      float sh = clamp(dot(n, normalize(uSun)), 0.0, 1.0) * shadowAt(vW, normalize(vN));
      vec3 night = mix(vec3(lum), sat, 0.55) * vec3(0.58,0.68,0.92) * 1.3 + vec3(0.014,0.018,0.034);
      night = mix(night, mix(vec3(lum), sat, 0.7) * (0.30 + 0.62 * lum) * vec3(0.62,0.74,1.0) * 1.25 + vec3(0.012,0.016,0.030), pho);   // the aerial photo is brighter than the satellite scene, so it is toned down more at night
      night = mix(night, night * vec3(0.78,1.16,0.86), green * 0.55 * (1.0 - 0.6 * pho));
      vec3 dayc = mix(pow(sat, vec3(0.8)) * 1.45, sat * 1.04, pho); dayc = mix(dayc, dayc * vec3(0.84,1.08,0.80), green * 0.4 * (1.0 - pho));
      vec3 base = mix(night, dayc, day) * mix(0.46 + 0.86 * sh, mix(0.66 + 0.50 * sh, 0.60 + 0.46 * sh, pho), day);
      base *= 1.0 - uFoot * foot;                                   // ground under buildings: the real footprints, also what stands in for buildings far away

      vec3 wcol = mix(vec3(0.030,0.062,0.115), vec3(0.15,0.34,0.50), day);
      vec2 wp = vW.xz * 46.0; float rip = sin(wp.x * 1.3 + uTime * 0.9) * sin(wp.y * 1.7 - uTime * 0.7) * sin((wp.x + wp.y) * 0.6 + uTime * 0.4);
      vec3 V = normalize(cameraPosition - vW); float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
      wcol += mix(vec3(0.05,0.08,0.13), vec3(0.20,0.24,0.26), day) * fres + vec3(0.10,0.13,0.17) * smoothstep(0.55, 1.0, rip) * (0.25 + 0.75 * fres);
      base = mix(base, wcol, water);
      float land = 1.0 - water;

      vec3 col = base * (1.0 - 0.45 * uRisk * land * smoothstep(0.1, 0.7, idx));
      float al = smoothstep(0.10, 0.80, idx) * land;
      col += ramp(idx) * al * uRisk * (1.05 + 0.25 * sin(uTime * 1.6 + vW.x * 2.0 + vW.z * 1.3) * step(0.75, idx));

      float mv = smoothstep(1.5, 11.0, vr) * uMotion * uUseMotion;                // bands follow the contours and travel downhill, faster where the ground is faster
      float ph = vW.y * 158.0 + uTime * (1.1 + vr * 0.13);
      float fr = pow(0.5 + 0.5 * sin(ph), 2.0);
      col *= 1.0 - 0.6 * mv * day;
      col += mix(vec3(0.35,0.75,1.0), vec3(1.0,0.86,0.55), clamp(vr / 24.0, 0.0, 1.0)) * mv * (0.16 + 0.95 * fr);

      float sl = 1.0 - smoothstep(0.0, 0.0016, abs(vUv.x - uSplit));
      col += vec3(1.0,0.95,0.85) * sl * uSplitVis * step(0.001, uSplit);

      vec2 dh = (vUv - uHi) * vec2(1.054, 1.0);
      float rr = length(dh), ring = 1.0 - smoothstep(0.0, 0.0022, abs(rr - uHiR * (0.75 + 0.25 * sin(uTime * 3.0))));
      col += vec3(1.0,0.95,0.8) * ring * uHiOn;

      col = haze(col, vW);
      vec2 e = min(vUv, 1.0 - vUv); float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
      col = mix(uBg, col * (1.0 - uDim), edge);
      gl_FragColor = vec4(col, 1.0);
    }`;
  /* buildings: position is the roof or base corner, aH.x the height above the base (so far buildings can sink flat), aH.y a per-building tone */
  const BVERT = `attribute vec2 aH; uniform float uVis; varying vec3 vW; varying vec2 vH;
    void main(){ vec3 p = position; float d = distance(p, cameraPosition), up = 1.0 - smoothstep(uVis * 0.72, uVis, d);
      float h = aH.x * 0.6; p.y -= h * (1.0 - up); vH = vec2(h * up, aH.y); vW = p; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`;
  const BFRAG = COMMON + `
    varying vec3 vW; varying vec2 vH; uniform float uBld, uDim, uPhoto; uniform sampler2D tPhoto;
    void main(){
      vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));                 // flat face normal, always toward the viewer
      float roof = smoothstep(0.55, 0.9, n.y), day = uSplitVis;
      float sun = max(dot(n, normalize(uSun)), 0.0) * shadowAt(vW, n);
      vec2 uv = vec2(vW.x / ${SX.toFixed(2)} + 0.5, 0.5 - vW.z / ${SZ.toFixed(2)});
      float idx = riskIdx(uv), tone = 0.90 + 0.20 * vH.y;
      vec3 ph = texture2D(tPhoto, uv).rgb; float pl = dot(ph, vec3(0.299,0.587,0.114));   // roofs take their colour from the aerial photo where it is loaded
      vec3 nroof = mix(vec3(0.50,0.55,0.70), (mix(vec3(pl), ph, 0.6) * vec3(0.62,0.72,0.95) * 0.9 + 0.20), 0.35 * uPhoto);
      vec3 droof = mix(vec3(0.83,0.81,0.77), ph * 0.98 + 0.03, 0.85 * uPhoto);
      vec3 alb = mix(mix(vec3(0.33,0.37,0.50), nroof, roof), mix(vec3(0.74,0.71,0.66), droof, roof), day) * mix(tone, 1.0, roof * uPhoto);
      float ao = mix(mix(0.55, 1.0, smoothstep(0.0, 0.011, vH.x)), 1.0, roof);   // walls darken toward the ground
      float sky = 0.5 + 0.5 * n.y + 0.10 * dot(n, vec3(0.62, 0.0, -0.78));        // light from the open sky, a little stronger from the north-east so each wall reads differently
      vec3 col = alb * ao * (mix(0.42, 0.50, day) * (0.55 + 0.6 * sky) + mix(1.15, 0.52, day) * sun);
      float k = smoothstep(0.42, 0.56, idx) * uRisk * (0.45 + 0.55 * uBld);      // buildings on Elevated or High ground take the risk colour
      col = mix(col, ramp(idx) * (0.62 + 0.55 * roof + 0.35 * sun), k * 0.82);
      vec2 e = min(uv, 1.0 - uv); float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
      gl_FragColor = vec4(mix(uBg, haze(col, vW) * (1.0 - uDim), edge), 1.0);
    }`;
  /* roads: a ribbon along the centre line, as wide as the road and never thinner than a set number of screen pixels */
  const RVERT = `attribute vec4 aS; uniform float uPxK, uMinPx; varying vec3 vW; varying float vC, vA;
    void main(){ vec4 mv = viewMatrix * vec4(position, 1.0); float dpx = -mv.z * uPxK, c = aS.w;
      float minpx = uMinPx > 0.0 ? uMinPx : c < 1.5 ? 1.7 : c < 3.5 ? 1.15 : c < 4.5 ? 0.8 : 0.0;
      float hw = max(aS.z, 0.5 * minpx * dpx), wpx = 2.0 * aS.z / dpx;
      vA = uMinPx > 0.0 || c < 4.5 ? 1.0 : c > 6.5 ? smoothstep(0.45, 1.3, wpx) * 0.8 : smoothstep(0.12, 0.6, wpx);
      vec3 p = position + vec3(aS.x, 0.0, aS.y) * hw; p.y += 0.0010 + dpx * 0.9 + (8.0 - c) * 0.00006;
      vW = p; vC = c; gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`;
  const RFRAG = COMMON + `
    varying vec3 vW; varying float vC, vA; uniform float uRoads, uDim, uMinPx, uOp; uniform vec3 uCol;
    void main(){
      if (uMinPx > 0.0) { gl_FragColor = vec4(uCol, uOp); return; }
      float day = uSplitVis, c = vC;
      vec3 nc = c < 1.5 ? vec3(0.86,0.63,0.36) : c < 2.5 ? vec3(0.66,0.67,0.76) : c < 3.5 ? vec3(0.56,0.58,0.68) : c < 4.5 ? vec3(0.48,0.51,0.61) : c < 5.5 ? vec3(0.37,0.41,0.52) : c < 6.5 ? vec3(0.31,0.35,0.45) : c < 7.5 ? vec3(0.36,0.46,0.42) : vec3(0.50,0.44,0.60);
      vec3 dc = c < 1.5 ? vec3(0.93,0.76,0.46) : c < 4.5 ? vec3(0.86,0.85,0.82) : c < 6.5 ? vec3(0.78,0.77,0.74) : c < 7.5 ? vec3(0.72,0.69,0.56) : vec3(0.46,0.44,0.50);
      vec3 col = mix(nc * (0.82 + 0.5 * uRoads), dc, day) * (0.58 + 0.42 * shadowAt(vW, vec3(0.0, 1.0, 0.0)));
      vec2 uv = vec2(vW.x / ${SX.toFixed(2)} + 0.5, 0.5 - vW.z / ${SZ.toFixed(2)});
      float idx = riskIdx(uv); col = mix(col, ramp(idx) * 1.15, smoothstep(0.3, 0.75, idx) * uRisk * 0.7);
      vec2 e = min(uv, 1.0 - uv); float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
      gl_FragColor = vec4(haze(col, vW) * (1.0 - uDim), vA * edge);
    }`;

  /* ------------------------------------------------ build */
  let bMat, rMat, depthMat, shadowRT, shadowCam, tiles = [], queue = [], maskTex;
  const M3 = window.GT_MAP3D || null;
  function build(cv) {
    canvas = cv;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LITE ? 1.5 : 1.75));
    scene = new THREE.Scene();
    const bg = new THREE.Color(0x0b0c10); renderer.setClearColor(bg, 1);
    camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);

    const geo = new THREE.PlaneGeometry(SX, SZ, SEGX, SEGZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv; HG = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) { HG[i] = demAt(uv.getX(i), uv.getY(i)); pos.setY(i, HG[i]); }
    geo.computeVertexNormals();

    const I = Mo.images, blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
    const SR = LITE ? 1024 : 2048;
    shadowRT = new THREE.WebGLRenderTarget(SR, SR); shadowRT.depthTexture = new THREE.DepthTexture(SR, SR); shadowRT.texture.minFilter = shadowRT.texture.magFilter = THREE.NearestFilter;
    shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10); shadowCam.layers.set(1);
    depthMat = new THREE.ShaderMaterial({ side: THREE.DoubleSide, colorWrite: false, uniforms: { uVis: { value: 1e6 } },
      vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main(){ gl_FragColor = vec4(1.0); }' });
    uniforms = {
      tSatA: { value: tex(I.s2_2023) }, tSatB: { value: tex(I.s2_2026) }, tTerrain: { value: tex(I.terrain) }, tMotion: { value: tex(I.motion) }, tMask: { value: blank }, tNormal: { value: blank }, tPhoto: { value: blank }, uNormal: { value: 0 }, uPhoto: { value: 0 }, tShadow: { value: shadowRT.depthTexture },
      uMask: { value: 0 }, uFoot: { value: 0.3 }, uBld: { value: 0 }, uRoads: { value: 0 }, uGrid: { value: new THREE.Vector2(Mo.NX, Mo.NY) },
      uSplit: { value: 0 }, uSplitVis: { value: 0 }, uR72: { value: 60 }, uApi: { value: 120 }, uEra: { value: 0 }, uAmt: { value: 0 },
      uRisk: { value: 0.6 }, uMotion: { value: 0.6 }, uTime: { value: 0 }, uDim: { value: 0 }, uHiOn: { value: 0 }, uHiR: { value: 0.012 }, uUseMotion: { value: 1 }, uBias: { value: -6.5 },
      uHi: { value: new THREE.Vector2(0.5, 0.5) }, uSun: { value: new THREE.Vector3(-0.58, 0.52, 0.36).normalize() }, uBg: { value: bg },
      uShadowMat: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 }, uShadowTexel: { value: 0.001 }, uShadowRes: { value: SR }, uFogD: { value: 90 }, uVis: { value: VIS }, uPxK: { value: 0.001 },
      uMinPx: { value: 0 }, uCol: { value: new THREE.Color(1, 1, 1) }, uOp: { value: 1 }
    };
    [uniforms.tSatA.value, uniforms.tSatB.value].forEach(t => { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.needsUpdate = true; });
    mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG }));
    mesh.layers.enable(1); scene.add(mesh);
    bMat = new THREE.ShaderMaterial({ uniforms, vertexShader: BVERT, fragmentShader: BFRAG, side: THREE.DoubleSide, extensions: { derivatives: true } });
    rMat = new THREE.ShaderMaterial({ uniforms, vertexShader: RVERT, fragmentShader: RFRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

    // rain: streaks falling over the box, density follows the storm
    const n = 5200, rp = new Float32Array(n * 3), rs = new Float32Array(n);
    for (let i = 0; i < n; i++) { rp[i * 3] = (Math.random() - 0.5) * SX * 1.1; rp[i * 3 + 1] = Math.random() * 7; rp[i * 3 + 2] = (Math.random() - 0.5) * SZ * 1.1; rs[i] = Math.random(); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('seed', new THREE.BufferAttribute(rs, 1));
    rain = new THREE.Points(rg, new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime, uAmt: { value: 0 }, uPx: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float seed; uniform float uTime, uAmt, uPx; varying float vA;
        void main(){ vec3 p = position; p.y = mod(p.y - uTime * (5.0 + seed * 3.0), 7.0); p.x += p.y * 0.12;
          vec4 mv = modelViewMatrix * vec4(p,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = min(uPx * 44.0, uPx * (26.0 + seed * 30.0) / -mv.z);
          vA = step(seed, uAmt) * (0.25 + 0.5 * seed) * smoothstep(0.0, 0.6, p.y) * smoothstep(0.15, 1.2, -mv.z); }`,
      fragmentShader: `precision mediump float; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float a = (1.0 - smoothstep(0.02, 0.07, abs(c.x + c.y * 0.12))) * (1.0 - abs(c.y) * 2.0); gl_FragColor = vec4(0.72, 0.82, 1.0, a * vA); }`
    }));
    rain.frustumCulled = false; rain.renderOrder = 4; scene.add(rain);

    if (M3) initMap3d();
    resize(); window.addEventListener('resize', resize); if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); requestAnimationFrame(frame); } });
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------ buildings and roads (Overture), built per tile */
  let bBytes, rBytes;
  function b64(s) { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function initMap3d() {
    const im = new Image(); im.onload = () => { maskTex = tex(im); maskTex.generateMipmaps = true; maskTex.minFilter = THREE.LinearMipmapLinearFilter; maskTex.needsUpdate = true; uniforms.tMask.value = maskTex; uniforms.uMask.value = 1; }; im.src = M3.mask;
    const HI = window.GT_MAP3D_HI || {};
    if (HI.normal) { const n = new Image(); n.onload = () => { const t = tex(n); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; uniforms.tNormal.value = t; uniforms.uNormal.value = 1; }; n.src = HI.normal; }
    if (HI.photo) { const ph = new Image(); ph.onload = () => {
      let src = ph; const max = Math.min(LITE ? 2048 : 4096, renderer.capabilities.maxTextureSize);
      if (ph.naturalWidth > max) { src = document.createElement('canvas'); src.width = src.height = max; src.getContext('2d').drawImage(ph, 0, 0, max, max); }   // phones take the photo at half size
      const t = tex(src); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.needsUpdate = true; uniforms.tPhoto.value = t; uniforms.uPhoto.value = 1; }; ph.src = HI.photo; }
    bBytes = b64(M3.b); rBytes = b64(M3.r); const T = M3.tiles, dvB = new DataView(bBytes.buffer), dvR = new DataView(rBytes.buffer);
    let ob = 0, or = 0;
    for (let t = 0; t < T * T; t++) {                     // find where each tile starts in the two byte streams
      const tile = { i: t, cx: ((t % T + 0.5) / T - 0.5) * SX, cz: (0.5 - (Math.floor(t / T) + 0.5) / T) * SZ, b0: ob, bn: M3.bcount[t], r0: or, rn: M3.rcount[t], bld: null, road: null, state: 0 };
      for (let k = 0; k < tile.bn; k++) { const n = bBytes[ob]; ob += 9; for (let j = 1; j < n; j++) ob += dvB.getInt8(ob) === -128 ? 5 : 2; }
      for (let k = 0; k < tile.rn; k++) { const n = dvR.getUint16(or + 1, true); or += 7 + (n - 1) * 4; }
      tiles.push(tile);
    }
    queue = tiles.slice();
  }
  const X = [], Y = [], G_ = [];                         // scratch: ring corners in world x / z and ground height
  function earclip(n, base, out) {                        // triangulate one counter-clockwise ring (x east, y north); corners are X[i], -Y[i]
    if (n === 3) { out.push(base, base + 1, base + 2); return; }
    const id = []; for (let i = 0; i < n; i++) id.push(i);
    let i = 0, stall = 0;
    while (id.length > 3) {
      const m = id.length, a = id[(i + m - 1) % m], b = id[i % m], c = id[(i + 1) % m];
      const ax = X[a], ay = -Y[a], bx = X[b], by = -Y[b], cx = X[c], cy = -Y[c], cr = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      let ear = cr > 1e-14 || stall > m;
      if (ear && stall <= m) for (let k = 0; k < m; k++) {
        const p = id[k]; if (p === a || p === b || p === c) continue;
        const px = X[p], py = -Y[p], d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx), d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        if (d1 >= 0 && d2 >= 0 && d3 >= 0) { ear = false; break; }
      }
      if (ear || (Math.abs(cr) <= 1e-14 && stall <= m)) { if (ear) out.push(base + a, base + b, base + c); id.splice(i % m, 1); stall = 0; i = Math.max(0, (i % m) - 1); }
      else { i++; stall++; }
    }
    out.push(base + id[0], base + id[1], base + id[2]);
  }
  function buildBuildings(t) {
    if (!t.bn) return;
    const dv = new DataView(bBytes.buffer), Q = M3.q, P = [], H = [], idx = []; let o = t.b0, nv = 0;
    for (let k = 0; k < t.bn; k++) {
      const n = bBytes[o], hd = dv.getUint16(o + 1, true), md = dv.getUint16(o + 3, true); let qx = dv.getUint16(o + 5, true), qy = dv.getUint16(o + 7, true); o += 9;
      let gmin = 1e9, gmax = -1e9, area = 0;
      for (let j = 0; j < n; j++) {
        if (j) { if (dv.getInt8(o) === -128) { qx += dv.getInt16(o + 1, true); qy += dv.getInt16(o + 3, true); o += 5; } else { qx += dv.getInt8(o); qy += dv.getInt8(o + 1); o += 2; } }
        const u = qx / Q, v = qy / Q, g = heightAt(u, v); X[j] = (u - 0.5) * SX; Y[j] = (0.5 - v) * SZ; G_[j] = g; if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      }
      if (LITE) { for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; area += X[j] * Y[j2] - X[j2] * Y[j]; } if (Math.abs(area) * 5e5 < 45) continue; }   // phones skip sheds under 45 m2
      const hm = (hd ? hd / 10 : M3.defH) / 1000 * EXAG, m0 = md / 10000 * EXAG;      // height in scene units; unknown heights use the area median
      const bot = m0 > 0 ? gmin + m0 : gmin - 0.004, top = Math.max(gmin + hm, gmax + 0.0025 * EXAG), hh = Math.min(65535, Math.round((top - bot) / 0.6 * 65535)), tone = (Math.random() * 65535) | 0;
      for (let j = 0; j < n; j++) { P.push(X[j], top, Y[j]); H.push(hh, tone); }
      for (let j = 0; j < n; j++) { P.push(X[j], bot, Y[j]); H.push(0, tone); }
      earclip(n, nv, idx);
      for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; idx.push(nv + j, nv + n + j, nv + j2, nv + j2, nv + n + j, nv + n + j2); }
      nv += 2 * n;
    }
    if (!nv) return;
    const g = new THREE.BufferGeometry(), drop = function () { this.array = null; };
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3).onUpload(drop)); g.setAttribute('aH', new THREE.BufferAttribute(new Uint16Array(H), 2, true).onUpload(drop));
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1).onUpload(drop)); g.computeBoundingSphere(); g.boundingSphere.radius += 0.7;
    t.bld = new THREE.Mesh(g, bMat); t.bld.layers.enable(1); t.bld.matrixAutoUpdate = false; scene.add(t.bld); t.tris = idx.length / 3;
  }
  const RW = [20, 16, 13, 11, 9, 7, 4.2, 1.8, 3];        // road widths in metres by class: motorway, trunk, primary, secondary, tertiary, residential, service, path, rail
  function ribbonGeo(lines, step) {                       // lines: [{ pts: [x, z, ...], hw (km), cls, bridge }] draped over the terrain with mitred corners
    const P = [], S = [], idx = []; let nv = 0;
    for (const ln of lines) {
      const q = ln.pts, xs = [], zs = [];
      for (let k = 0; k + 2 < q.length; k += 2) {
        const dx = q[k + 2] - q[k], dz = q[k + 3] - q[k + 1], n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
        for (let s = k ? 1 : 0; s <= n; s++) { xs.push(q[k] + dx * s / n); zs.push(q[k + 1] + dz * s / n); }
      }
      const m = xs.length; if (m < 2) continue;
      const y0 = groundXZ(xs[0], zs[0]), y1 = groundXZ(xs[m - 1], zs[m - 1]);
      for (let i = 0; i < m; i++) {
        const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1); let tx = xs[b] - xs[a], tz = zs[b] - zs[a]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        let y = groundXZ(xs[i], zs[i]); if (ln.bridge) y = Math.max(y, y0 + (y1 - y0) * i / (m - 1));      // a bridge runs straight between its two ends
        P.push(xs[i], y, zs[i], xs[i], y, zs[i]); S.push(-tz, tx, ln.hw, ln.cls, tz, -tx, ln.hw, ln.cls);
        if (i) idx.push(nv - 2, nv - 1, nv, nv, nv - 1, nv + 1);
        nv += 2;
      }
    }
    if (!nv) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3)); g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(S), 4));
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1)); g.computeBoundingSphere(); g.boundingSphere.radius += 0.1; return g;
  }
  function buildRoads(t) {
    if (!t.rn) return;
    const dv = new DataView(rBytes.buffer), Q = M3.q, lines = []; let o = t.r0;
    for (let k = 0; k < t.rn; k++) {
      const c = rBytes[o], n = dv.getUint16(o + 1, true); let qx = dv.getUint16(o + 3, true), qy = dv.getUint16(o + 5, true); o += 7;
      const cls = c & 15, pts = [(qx / Q - 0.5) * SX, (0.5 - qy / Q) * SZ];
      for (let j = 1; j < n; j++) { qx += dv.getInt16(o, true); qy += dv.getInt16(o + 2, true); o += 4; pts.push((qx / Q - 0.5) * SX, (0.5 - qy / Q) * SZ); }
      if (LITE && cls === 7) continue;                    // phones leave out footpaths
      lines.push({ pts, hw: RW[cls] / 2000, cls, bridge: !!(c & 16) });
    }
    lines.sort((a, b) => b.cls - a.cls);                  // wide roads are drawn last, over the small ones
    const g = ribbonGeo(lines, LITE ? 0.04 : 0.022); if (!g) return;
    t.road = new THREE.Mesh(g, rMat); t.road.renderOrder = 1; t.road.matrixAutoUpdate = false; scene.add(t.road);
  }
  function buildSome() {                                  // nearest unbuilt tile first, a few milliseconds per frame
    if (!queue.length) return;
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < 7) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < queue.length; i++) { const t = queue[i], d = Math.hypot(t.cx - view.tx, t.cz - view.tz); if (d < bd) { bd = d; best = i; } }
      const t = queue[best];
      if (LITE && t.state === 1 && (bd > VIS + 1 || view.dist > VIS + 1)) break;  // phones build buildings only around where the camera is looking
      if (t.state === 0) { buildRoads(t); t.state = 1; }
      else { buildBuildings(t); t.state = 2; queue.splice(best, 1); shadowDirty = true; }
    }
  }

  /* ------------------------------------------------ sun shadows: one depth pass from the sun around the point in view, redrawn only when the view moves */
  let shadowDirty = true; const shC = new THREE.Vector3(1e9, 0, 0); let shR = 0;
  function updateShadow() {
    const on = clamp01((8.5 - view.dist) / 3) * (layers.shadows === false ? 0 : 1); uniforms.uShadowOn.value = on; if (on <= 0) return;
    const R = Math.max(0.5, Math.min(6, view.dist * 1.05));
    if (!shadowDirty && Math.abs(R - shR) < shR * 0.12 && Math.hypot(view.tx - shC.x, view.tz - shC.z) < shR * 0.22) return;
    shadowDirty = false; shR = R; shC.set(view.tx, view.ty, view.tz);
    const D = R * 2 + 3, sun = uniforms.uSun.value;
    shadowCam.left = shadowCam.bottom = -R; shadowCam.right = shadowCam.top = R; shadowCam.near = 0.01; shadowCam.far = 2 * D; shadowCam.updateProjectionMatrix();
    shadowCam.position.copy(shC).addScaledVector(sun, D); shadowCam.up.set(0, 0, -1); shadowCam.lookAt(shC); shadowCam.updateMatrixWorld(); shadowCam.matrixWorldInverse.copy(shadowCam.matrixWorld).invert();
    uniforms.uShadowMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(shadowCam.projectionMatrix).multiply(shadowCam.matrixWorldInverse);
    uniforms.uShadowTexel.value = 2 * R / shadowRT.width;
    const vis = uniforms.uVis.value; uniforms.uVis.value = 1e6;          // every building in range casts, whatever the camera distance
    for (const t of tiles) if (t.bld) t.bld.visible = layers.buildings;
    scene.overrideMaterial = depthMat; renderer.setRenderTarget(shadowRT); renderer.clear(); renderer.render(scene, shadowCam); renderer.setRenderTarget(null); scene.overrideMaterial = null;
    uniforms.uVis.value = vis;
  }

  /* ------------------------------------------------ place and street names */
  const POOL = 34, pool = []; let lbHost = null, lbNext = 0, lbItems = null;
  function initLabels() {
    lbHost = document.getElementById('labels'); if (!lbHost || !M3) return;
    lbItems = M3.labels.map(l => ({ n: l[0], kind: l[3], rank: l[4], pos: new THREE.Vector3((l[1] - 0.5) * SX, heightAt(l[1], l[2]) + 0.012, (0.5 - l[2]) * SZ) }));
    for (let i = 0; i < POOL; i++) { const el = document.createElement('div'); el.className = 'map-lb'; el.hidden = true; lbHost.appendChild(el); pool.push({ el, it: null }); }
  }
  const tmp = new THREE.Vector3();
  function pickLabels(w, h) {                             // choose which names fit the current view: big places first, streets as you get close, none overlapping
    const d = view.dist, cand = [];
    for (const it of lbItems) {
      const lim = it.kind === 0 ? [60, 15, 6.5, 1.3][it.rank] : it.kind === 3 ? [9, 9, 6.5, 4.2, 2.8, 1.5][it.rank] : [22, 9, 4.5][it.rank];
      if (d > lim) continue;
      const dc = it.pos.distanceTo(camera.position); if (dc > Math.max(3, d * 2.4)) continue;
      tmp.copy(it.pos).project(camera); if (tmp.z > 1 || Math.abs(tmp.x) > 0.96 || Math.abs(tmp.y) > 0.92) continue;
      const pr = (it.kind === 3 ? 10 + it.rank : it.kind === 0 ? it.rank * 3 : 4 + it.rank * 3) + dc / Math.max(1, d) * (it.kind === 3 ? 2 : 0.5);
      cand.push({ it, x: (tmp.x + 1) / 2 * w, y: (1 - tmp.y) / 2 * h, pr });
    }
    cand.sort((a, b) => a.pr - b.pr);
    const keep = [], boxes = [];
    for (const c of cand) {
      const bw = c.it.n.length * (c.it.kind === 0 && c.it.rank === 0 ? 9.5 : 6.6) + 14, bh = 18, x0 = c.x - bw / 2, y0 = c.y - bh / 2; let hit = false;
      for (const b of boxes) if (x0 < b[0] + b[2] && x0 + bw > b[0] && y0 < b[1] + b[3] && y0 + bh > b[1]) { hit = true; break; }
      if (hit) continue; boxes.push([x0, y0, bw, bh]); keep.push(c.it); if (keep.length >= POOL) break;
    }
    const want = new Set(keep);
    for (const p of pool) if (p.it && !want.has(p.it)) { p.it = null; p.el.hidden = true; } else if (p.it) want.delete(p.it);
    for (const it of want) { const p = pool.find(q => !q.it); if (!p) break; p.it = it; p.el.textContent = it.n; p.el.className = 'map-lb k' + it.kind + ' r' + it.rank; }
  }
  function drawLabels(now) {
    if (!lbItems) return; const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!layers.labels) { if (lbNext !== -1) { for (const p of pool) { p.it = null; p.el.hidden = true; } lbNext = -1; } return; }
    if (now > lbNext) { pickLabels(w, h); lbNext = now + 220; }
    for (const p of pool) if (p.it) { tmp.copy(p.it.pos).project(camera); const vis = tmp.z < 1 && Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1; p.el.hidden = !vis;
      if (vis) p.el.style.transform = `translate3d(${((tmp.x + 1) / 2 * w).toFixed(1)}px,${((1 - tmp.y) / 2 * h).toFixed(1)}px,0) translate(-50%,-50%)`; }
  }

  /* ------------------------------------------------ frame */
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 58 : 36;
    if (shiftPx > 0.5) camera.setViewOffset(w, h, -shiftPx, 0, w, h); else if (camera.view) camera.clearViewOffset();
    camera.updateProjectionMatrix(); uniforms.uPxK.value = 2 * Math.tan(camera.fov * Math.PI / 360) / h;
  }
  let shiftPx = 0;
  function setShift(px) { shiftPx = px; const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; if (px > 0.5) camera.setViewOffset(w, h, -px, 0, w, h); else if (camera.view) camera.clearViewOffset(); camera.updateProjectionMatrix(); }
  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; if (!reduced) clock += dt; uniforms.uTime.value = clock;
    if (orbit.on) {
      orbit.tx = Math.max(-SX / 2, Math.min(SX / 2, orbit.tx)); orbit.tz = Math.max(-SZ / 2, Math.min(SZ / 2, orbit.tz));
      if (!sm.on) Object.assign(sm, orbit);               // free look just started: begin from where the view is
      const k = reduced ? 1 : 1 - Math.exp(-dt * 11);
      sm.az += (orbit.az - sm.az) * k; sm.el += (orbit.el - sm.el) * k; sm.tx += (orbit.tx - sm.tx) * k; sm.tz += (orbit.tz - sm.tz) * k;
      sm.dist *= Math.pow(orbit.dist / sm.dist, k);
      const ty = groundXZ(sm.tx, sm.tz), ce = Math.cos(sm.el);
      camera.position.set(sm.tx + sm.dist * ce * Math.sin(sm.az), ty + sm.dist * Math.sin(sm.el), sm.tz + sm.dist * ce * Math.cos(sm.az));
      if (Math.abs(camera.position.x) < SX / 2 && Math.abs(camera.position.z) < SZ / 2) camera.position.y = Math.max(camera.position.y, groundXZ(camera.position.x, camera.position.z) + 0.03);
      camera.lookAt(sm.tx, ty, sm.tz);
      view.dist = sm.dist; view.tx = sm.tx; view.ty = ty; view.tz = sm.tz;
      if (!window.gsap || !gsap.isTweening(cam)) { cam.px = camera.position.x; cam.py = camera.position.y; cam.pz = camera.position.z; cam.tx = sm.tx; cam.ty = ty; cam.tz = sm.tz; }   // leaving free look glides from here
    } else {
      sm.on = false;
      const d = reduced ? 0 : Math.sin(clock * 0.12) * 0.35 * Math.min(1, view.dist / 12);
      camera.position.set(cam.px + d, cam.py, cam.pz); camera.lookAt(cam.tx, cam.ty, cam.tz);
      view.tx = cam.tx; view.tz = cam.tz; view.ty = cam.ty; view.dist = Math.hypot(cam.px - cam.tx, cam.py - cam.ty, cam.pz - cam.tz);
    }
    camera.near = Math.max(0.004, view.dist * 0.03); camera.far = view.dist * 6 + 40; camera.updateProjectionMatrix();
    uniforms.uFogD.value = 7 + view.dist * 5.5;
    buildSome();
    for (const t of tiles) {
      const dc = Math.hypot(t.cx - camera.position.x, t.cz - camera.position.z);
      if (t.bld) t.bld.visible = layers.buildings && dc < VIS + 1.6;
      if (LITE && t.bld && Math.hypot(t.cx - view.tx, t.cz - view.tz) > VIS + 3.5) { scene.remove(t.bld); t.bld.geometry.dispose(); t.bld = null; t.state = 1; queue.push(t); }   // phones let go of buildings far from the view
      if (t.road) t.road.visible = layers.roads;
    }
    updateShadow();
    for (const mk of markers) if (mk.mesh.visible) { mk.mesh.material.opacity = 0.55 + 0.35 * Math.sin(clock * 3 + mk.ph); }
    renderer.render(scene, camera);
    if (labels.length) { const w = canvas.clientWidth, h = canvas.clientHeight; for (const lb of labels) {
      if (!lb.on) { lb.el.hidden = true; continue; }
      const p = lb.pos.clone().project(camera); const vis = p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      lb.el.hidden = !vis; if (vis) lb.el.style.transform = `translate3d(${((p.x + 1) / 2 * w).toFixed(1)}px,${((1 - p.y) / 2 * h).toFixed(1)}px,0)`;
    } }
    if (lbItems === null && M3) initLabels();
    drawLabels(now);
    requestAnimationFrame(frame);
  }

  /* beacons for documented slides */
  function addMarker(lon, lat, labelEl) {
    const base = worldOf(lon, lat, 0), g = new THREE.CylinderGeometry(0.012, 0.03, 1.5, 8, 1, true); g.translate(0, 0.75, 0);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe2a6, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.position.copy(base); m.visible = false; m.renderOrder = 3; scene.add(m);
    const mk = { mesh: m, ph: Math.random() * 6 }; markers.push(mk);
    const lb = { el: labelEl, pos: base.clone().add(new THREE.Vector3(0, 1.55, 0)), on: false }; labels.push(lb);
    return { show(v) { m.visible = v; lb.on = v; } };
  }
  function addLabel(lon, lat, el, lift) {
    const lb = { el, pos: worldOf(lon, lat, liftOf(lift)), on: false }; labels.push(lb);
    return { show(v) { lb.on = v; if (!v) el.hidden = true; } };
  }
  function ribbon(segs, color, wdt, minPx, order) {       // list of polylines [[lon,lat],...] laid on the ground, drawn over everything so a selection is never hidden
    const lines = segs.filter(s => s && s.length > 1).map(s => { const pts = []; for (const p of s) { const w = worldOf(p[0], p[1], 0); pts.push(w.x, w.z); } return { pts, hw: wdt, cls: 0, bridge: false }; });
    const g = ribbonGeo(lines, 0.025); if (!g) return null;
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: Object.assign({}, uniforms, { uMinPx: { value: minPx }, uCol: { value: new THREE.Color(color) }, uOp: { value: 0.95 } }),
      vertexShader: RVERT, fragmentShader: RFRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    m.renderOrder = order; m.frustumCulled = false; scene.add(m); return m;
  }
  const drop = m => { if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } return null; };
  function showStreet(segs) { streetLine = drop(streetLine); if (segs) streetLine = ribbon(segs, 0xfff1cf, 0.006, 3.2, 5); }
  let pathLine = null, pathEnd = null;
  function showPath(pts) {                                // debris runout path, with a marker where it stops
    pathLine = drop(pathLine); pathEnd = drop(pathEnd); if (!pts || pts.length < 2) return;
    pathLine = ribbon([pts], 0x7fe3ff, 0.008, 4.2, 6);
    const e = pts[pts.length - 1], g = new THREE.RingGeometry(0.05, 0.075, 28); g.rotateX(-Math.PI / 2);
    pathEnd = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
    pathEnd.position.copy(worldOf(e[0], e[1], 0.012)); pathEnd.renderOrder = 6; scene.add(pathEnd);
  }
  function highlight(lon, lat, on) {
    const [W, S, E, N] = Mo.bbox; uniforms.uHi.value.set((lon - W) / (E - W), (lat - S) / (N - S)); uniforms.uHiOn.value = on === false ? 0 : 1;
  }
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function groundHit(clientX, clientY) {                  // where a screen point meets the terrain: march along the ray, then close in
    const r = canvas.getBoundingClientRect(); ndc.set((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera); const o = rc.ray.origin, d = rc.ray.direction, inBox = (x, z) => Math.abs(x) <= SX / 2 && Math.abs(z) <= SZ / 2;
    let t = 0, prev = 0, lim = view.dist * 8 + 40;
    while (t < lim) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (inBox(x, z) && y <= groundXZ(x, z)) {
        let a = prev, b = t; for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (o.y + d.y * m <= groundXZ(o.x + d.x * m, o.z + d.z * m)) b = m; else a = m; }
        return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      if (y < -0.5) return null;
      prev = t; t += Math.max(0.006, t * 0.012);
    }
    return null;
  }
  function pick(clientX, clientY) {
    const p = groundHit(clientX, clientY); if (!p) return null;
    const [W, S, E, N] = Mo.bbox; return [W + (p.x / SX + 0.5) * (E - W), S + (0.5 - p.z / SZ) * (N - S)];
  }
  function focusPose(lon, lat, dist, shift) {             // camera pose looking at a place from the south; shift slides the place right of centre
    const p = worldOf(lon, lat, 0), d = dist || 4.2, sx = (shift || 0) * d;
    return { px: p.x - d * 0.2 - sx, py: p.y + d * 0.62, pz: p.z + d * 0.82, tx: p.x - sx, ty: p.y, tz: p.z };
  }
  /* free look moves: drag pans the ground under the pointer, a second gesture turns and tilts, zoom closes in on the pointer */
  const DMIN = 0.4, DMAX = 30;
  const nav = {
    pan(dx, dy) { const wpp = 2 * orbit.dist * Math.tan(camera.fov * Math.PI / 360) / canvas.clientHeight, ca = Math.cos(orbit.az), sa = Math.sin(orbit.az), f = dy * wpp / Math.max(0.3, Math.sin(orbit.el));
      orbit.tx += -ca * dx * wpp - sa * f; orbit.tz += sa * dx * wpp - ca * f; },
    rotate(dx, dy) { orbit.az -= dx * 0.005; orbit.el = Math.max(0.1, Math.min(1.5, orbit.el + dy * 0.004)); },
    zoom(f, clientX, clientY) { const d0 = orbit.dist, d1 = Math.max(DMIN, Math.min(DMAX, d0 * f)), g = d1 / d0; if (g === 1) return;
      const p = clientX == null ? null : groundHit(clientX, clientY); if (p) { orbit.tx = p.x + (orbit.tx - p.x) * g; orbit.tz = p.z + (orbit.tz - p.z) * g; } orbit.dist = d1; },
    twist(da) { orbit.az += da; }
  };
  function setLayer(name, on) { if (layers[name] !== on) { layers[name] = on; if (name === 'buildings') { shadowDirty = true; uniforms.uFoot.value = on ? 0.3 : 0.12; } } }

  window.GTScene = { build, cam, orbit, nav, layers, setLayer, lite: LITE, get u() { return uniforms; }, get rain() { return rain.material.uniforms.uAmt; }, addMarker, addLabel, showStreet, showPath, highlight, pick, focusPose, worldOf,
    get view() { return view; }, get pending() { return queue.length; },
    setReduced(v) { reduced = v; }, resize, setShift,
    project(lon, lat, lift) { const p = worldOf(lon, lat, liftOf(lift)).project(camera); return p.z < 1 ? [(p.x + 1) / 2 * canvas.clientWidth, (1 - p.y) / 2 * canvas.clientHeight] : null; } };   // screen position of a place, for 2D overlays
})();
