/*
 * graph.js — the map. Every entry in the dictionary and every ancestor form
 * named in its Wiktionary etymology is one point; the app is this map, and an
 * entry is what you see when you stand on one point of it.
 *
 * Geometry (scripts/build-graph-layout.js):
 *   radius from a family's center = time (log years-before-present)
 *   around the circle / between families = relation (branch, cross-links)
 *   dot size = how many English words descend from the point
 *
 * window.RootMap API (used by app.js):
 *   init(el, {onTap(idx), onReady()})     build canvases inside el
 *   ready                                 promise, resolves when data is loaded
 *   find(word) → idx | -1                 English headword lookup
 *   focus(idx, {fly})                     light the node's lineage, dim the rest
 *   clearFocus(); overview()
 *   setInsets({top, bottom})              keep the focused node clear of UI
 *   setLens(name) "descent" | "sense" | "parts" | "doublets"
 *   setSense(idx, [idx…])                 sense links to draw for the sense lens
 *   info(idx) → {label, lang, family, color, year, parent, isWord}
 *   lineage(idx) → [idx…]                 primary line of descent, nearest first
 *   details(idx) → Promise<{g,tr,up,en,ne,dbl,cog}>
 *   families, colorOf(fam)
 */
(function () {
  "use strict";
  const V = "5";
  const DPR = Math.min(2, window.devicePixelRatio || 1);

  // ---- palettes (index = family in info.families) -----------------------------
  const DARK = ["#ece0cc", "#bfae8e", "#6fa9d6", "#e0795f", "#a08ad8", "#f0c75e", "#5fbf8f", "#d98bb5", "#e6a15a",
    "#8fb8a6", "#cdb85c", "#5ec4c9", "#a9c46a", "#d4836e", "#7fa3e0", "#c78f5a", "#9ad0a8", "#8c8478"];
  const LIGHT = ["#3a2f20", "#7a6648", "#2f6ea8", "#b0482c", "#6a4fb0", "#a5780e", "#2e8a5c", "#a6457a", "#b0631d",
    "#4f7f6c", "#8a7a1c", "#1f8a90", "#5f7f22", "#9a4a36", "#3c62b0", "#8a5a2a", "#4f8f62", "#6b645a"];
  const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  // ---- looks: each is drawn from one real source, and every mark on the map follows it --------
  // rgb strings are "r,g,b"; pal is the per-family colour (index = info.families)
  const PASTEL = ["#f1e8d3", "#e2c27a", "#9cb8d6", "#e3a291", "#c4b0de", "#ead07a", "#a9c79a", "#e0a9c4", "#e9b27e",
    "#b2cbbf", "#d9cc8a", "#9fd0d2", "#c6d699", "#e0aa98", "#a9bde6", "#d8b08a", "#b9dcc0", "#c9c3b9"];
  const HANDCOL = ["#2a2016", "#d2ad4b", "#7f9ab3", "#c0705f", "#9a86b8", "#d2ad4b", "#7f9a5a", "#c47c96", "#d6955a",
    "#86a598", "#bfae5a", "#6fa8a8", "#9fb06a", "#c08a70", "#7f95c4", "#b88a5a", "#8fb29a", "#9a9286"];
  const WEBSAFE = ["#ffffff", "#ffcc66", "#66ccff", "#ff9966", "#cc99ff", "#ffff66", "#66ff99", "#ff99cc", "#ff9933",
    "#99cccc", "#cccc66", "#33ffff", "#ccff66", "#ff6666", "#9999ff", "#cc9966", "#99ffcc", "#cccccc"];
  const LOOKS = {
    // Joseph Priestley, A New Chart of History (1769): engraved in one ink, hand-washed families
    priestley: { dark: false, ink: "43,33,25", halo: "rgba(241,232,211,0.92)", pal: PASTEL, shape: 1, outline: "43,33,25",
      lineRGB: "43,33,25", lineA: 0.55, litRGB: "43,33,25", ringRGB: "43,33,25", ringA: 0.34, years: "scale",
      font: "'Libre Caslon Text', Caslon, Georgia, serif", wordColor: null, ancInk: true, you: "93,130,172", here: "93,130,172",
      focusMark: "double", wash: true, regionCaps: true },
    // Abraham Ortelius, Typus Orbis Terrarum (1570): stippled sea, hand-coloured boundaries, spaced capitals
    ortelius: { dark: false, paper: "#ecdfbf", ink: "42,32,22", halo: "rgba(236,223,191,0.94)", pal: HANDCOL, shape: 1, outline: "42,32,22",
      dotColor: (i) => (G.lang[i] === 0 ? [0.165, 0.125, 0.086] : [0.925, 0.875, 0.75]),
      lineRGB: "42,32,22", lineA: 0.6, litRGB: "42,32,22", ringRGB: "42,32,22", ringA: 0.45, ringDouble: true, years: "roman",
      font: "'IM Fell English', Georgia, serif", ancInk: true, you: "192,112,95", here: "192,112,95",
      focusMark: "circle", stipple: true, lands: true, headCaps: true, regionCaps: true },
    // a 1930s Clydebank shipyard blueprint: white line on Prussian blue, chain lines, red pencil
    blueprint: { dark: true, ink: "238,244,251", halo: "rgba(20,69,127,0.92)", pal: null, shape: 1, outline: "238,244,251",
      dotColor: (i) => (G.lang[i] === 0 ? [0.93, 0.955, 0.985] : [0.078, 0.27, 0.5]),
      lineRGB: "238,244,251", lineA: 0.55, litRGB: "238,244,251", ringRGB: "238,244,251", ringA: 0.5, ringDash: [14, 3, 2, 3], years: "dim",
      font: "'Overpass', 'Arial Narrow', sans-serif", weight: 600, caps: true, ancInk: true, you: "255,107,79", here: "255,107,79", hereDash: [6, 4],
      focusMark: "cloud", regionCaps: true },
    // Philip's Planisphere (George Philip & Son): a printed star disc under a gilt morocco overlay
    planisphere: { dark: false, ink: "30,26,22", halo: "rgba(235,227,205,0.94)", pal: null, shape: 2, outline: "30,26,22",
      dotColor: () => [0.118, 0.102, 0.086],
      lineRGB: "30,26,22", lineA: 0.4, litRGB: "184,50,42", ringRGB: "30,26,22", ringA: 0.3, years: "left",
      font: "'Old Standard TT', 'Times New Roman', serif", ancInk: true, litAncRGB: "184,50,42", you: "184,50,42", here: "184,50,42", hereDash: [2, 3],
      focusMark: "circle", plate: true, rivet: true },
    // Netscape Navigator 1.1 (1995): a linked image map on a starfield; links, visited links, <BLINK>
    netscape: { dark: true, ink: "255,255,255", halo: "rgba(0,0,0,0.9)", pal: WEBSAFE, shape: 3, outline: "0,0,0",
      lineRGB: "51,153,204", lineA: 0.9, litRGB: "255,255,0", ringRGB: "51,102,153", ringA: 1, years: "left", yearFont: "'Cousine', 'Courier New', monospace",
      font: "'Tinos', 'Times New Roman', serif", wordColor: (i) => (visited.has(i) ? "255,153,255" : "0,255,255"), ancRGB: "255,153,51", underline: true,
      you: "255,255,0", here: "255,255,0", hereDash: [4, 2], focusMark: "square", blink: true },
  };
  let LOOK = LOOKS.planisphere;
  const visited = new Set();
  const rgbOf = (c) => Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255);
  const hexToRgbStr = (h) => parseInt(h.slice(1, 3), 16) + "," + parseInt(h.slice(3, 5), 16) + "," + parseInt(h.slice(5, 7), 16);
  function isDark() {
    if (LOOK) return LOOK.dark;
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  const RM = {};
  let G = null;           // data
  let gl, glc, lab, ctx, und;  // canvases (und: the look's ground, under the GL layer)
  let W = 0, H = 0;
  const cam = { x: 0, y: 0, s: 0.1 };
  const insets = { top: 0, bottom: 0 };
  let focus = null;       // { idx, lit:Set, path:[…], kids:[…], extra:[…] }
  let lens = "descent";
  let senseLinks = null;  // { from, to:[…] }
  let dirty = true, anim = null;
  let globalGeo = null, globalPairs = null;
  let ping = -1;
  let marks = null; // search matches lit where they live
  let glide = null; // momentum after a flick: { vx, vy (screen px/ms), t }
  let onInteract = null;
  let labelHits = []; // [x0,y0,x1,y1,idx] of labels drawn this frame
  let trail = null;
  let onTap = null, onDraw = null;
  const glossWant = new Set(); // chunks requested for close-range glosses
  let readyResolve; RM.ready = new Promise((r) => (readyResolve = r));

  // ---- data -------------------------------------------------------------------------
  async function load() {
    const get = (p) => fetch("graph/" + p + "?v=" + V);
    const [info, labels, xy, meta, lang, tree, links] = await Promise.all([
      get("info.json").then((r) => r.json()), get("labels.json").then((r) => r.json()),
      get("xy.bin").then((r) => r.arrayBuffer()), get("meta.bin").then((r) => r.arrayBuffer()),
      get("lang.bin").then((r) => r.arrayBuffer()), get("tree.bin").then((r) => r.arrayBuffer()),
      get("links.bin").then((r) => r.arrayBuffer()),
    ]);
    const N = info.n;
    G = { info, N, labels, xy: new Float32Array(xy), meta: new Uint8Array(meta), lang: new Uint16Array(lang), parent: new Int32Array(tree), links: new Int32Array(links) };
    // English headword index (exact, then lowercase)
    G.word = new Map(); G.wordLC = new Map();
    for (let i = 0; i < N; i++) if (G.lang[i] === 0) { G.word.set(labels[i], i); const lc = labels[i].toLowerCase(); if (!G.wordLC.has(lc)) G.wordLC.set(lc, i); }
    // children (primary) and cross adjacency, CSR
    const cnt = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) if (G.parent[i] >= 0) cnt[G.parent[i] + 1]++;
    for (let i = 0; i < N; i++) cnt[i + 1] += cnt[i];
    const kids = new Int32Array(cnt[N]); const fill = cnt.slice(0, N);
    for (let i = 0; i < N; i++) if (G.parent[i] >= 0) kids[fill[G.parent[i]]++] = i;
    G.kidStart = cnt; G.kids = kids;
    G.tree = new Int32Array(N).fill(-1); // root of each node's tree
    for (let i = 0; i < N; i++) {
      if (G.tree[i] >= 0) continue;
      const path = []; let x = i;
      while (x >= 0 && G.tree[x] < 0 && G.parent[x] >= 0) { path.push(x); x = G.parent[x]; }
      const r = G.tree[x] >= 0 ? G.tree[x] : x;
      G.tree[x] = r; for (const p of path) G.tree[p] = r;
    }
    G.crossUp = new Map(); G.crossDown = new Map();
    for (let k = 0; k < G.links.length; k += 2) {
      const c = G.links[k], p = G.links[k + 1];
      (G.crossUp.get(c) || G.crossUp.set(c, []).get(c)).push(p);
      (G.crossDown.get(p) || G.crossDown.set(p, []).get(p)).push(c);
    }
    // size order (labels when zoomed out)
    const order = new Int32Array(N); for (let i = 0; i < N; i++) order[i] = i;
    G.bySize = Array.from(order).sort((a, b) => G.meta[b * 2 + 1] - G.meta[a * 2 + 1]);
    // spatial grid
    const [x0, y0, x1, y1] = info.bounds;
    const C = 4; G.cell = C; G.gx0 = x0; G.gy0 = y0;
    G.gw = Math.ceil((x1 - x0) / C) + 1; G.gh = Math.ceil((y1 - y0) / C) + 1;
    const cc = new Int32Array(G.gw * G.gh + 1);
    const cellOf = (i) => Math.floor((G.xy[i * 2] - x0) / C) + Math.floor((G.xy[i * 2 + 1] - y0) / C) * G.gw;
    for (let i = 0; i < N; i++) cc[cellOf(i) + 1]++;
    for (let i = 0; i < G.gw * G.gh; i++) cc[i + 1] += cc[i];
    const items = new Int32Array(N); const f2 = cc.slice(0, G.gw * G.gh);
    for (let i = 0; i < N; i++) items[f2[cellOf(i)]++] = i;
    G.cellStart = cc; G.cellItems = items;
    G.trees = info.trees.map((t) => ({ root: t[0], x: t[1], y: t[2], scale: t[3], R: t[4] }));
    G.treeOf = new Map(G.trees.map((t) => [t.root, t]));
    G.treeOfRoot = new Map(G.trees.map((t) => [t.root, t]));
    G.chunks = new Map();
    return G;
  }

  // ---- GL ---------------------------------------------------------------------------
  const VS_PT = `
    attribute vec2 p; attribute float sz; attribute vec3 c;
    uniform vec2 ctr; uniform float s; uniform vec2 res; uniform float k; uniform float dpr;
    varying vec3 vc;
    void main(){
      vec2 q = (p - ctr) * s;
      gl_Position = vec4(q.x / (res.x*0.5), -q.y / (res.y*0.5), 0.0, 1.0);
      gl_PointSize = clamp((1.0 + sz / 40.0) * k, 1.0, 34.0) * dpr;
      vc = c;
    }`;
  const FS_PT = `
    precision mediump float; varying vec3 vc; uniform float a; uniform float shape; uniform vec3 oc;
    void main(){
      vec2 d = gl_PointCoord - 0.5; float r = length(d); float e; vec3 col = vc;
      if (shape < 0.5) { e = smoothstep(0.5, 0.36, r); }
      else if (shape < 1.5) { e = smoothstep(0.5, 0.42, r); col = mix(vc, oc, smoothstep(0.27, 0.36, r)); }
      else if (shape < 2.5) { vec2 q = abs(d); float m = max(q.x, q.y); float ray = min(q.x, q.y);
        e = (ray < 0.05 + 0.3 * (0.5 - m) && m < 0.5) ? 1.0 : 0.0; e = max(e, smoothstep(0.18, 0.12, r)); }
      else { e = 1.0; }
      if (e <= 0.0) discard;
      gl_FragColor = vec4(col * e * a, e * a);
    }`;
  const VS_LN = `
    attribute vec2 p; attribute vec3 c;
    uniform vec2 ctr; uniform float s; uniform vec2 res;
    varying vec3 vc;
    void main(){
      vec2 q = (p - ctr) * s;
      gl_Position = vec4(q.x / (res.x*0.5), -q.y / (res.y*0.5), 0.0, 1.0);
      vc = c;
    }`;
  const FS_LN = `precision mediump float; varying vec3 vc; uniform float a; void main(){ gl_FragColor = vec4(vc * a, a); }`;

  function prog(vs, fs) {
    const mk = (t, src) => { const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
    const a = {}; const m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < m; i++) { const nm = gl.getActiveAttrib(p, i).name; a[nm] = gl.getAttribLocation(p, nm); }
    return { p, u, a };
  }
  let P_PT, P_LN, B = {};
  function buf(data) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }

  function buildBuffers() {
    const N = G.N, pal = (LOOK.pal || (isDark() ? DARK : LIGHT)).map(hex);
    G.pal = pal;
    const col = new Float32Array(N * 3), sz = new Float32Array(N);
    const dustStart = G.info.dust ? G.info.dust.inner : Infinity;
    for (let i = 0; i < N; i++) {
      const c = LOOK.dotColor ? LOOK.dotColor(i) : pal[G.meta[i * 2]];
      // headwords with no recorded ancestry ("dust") sit quietly in the outer band
      const r = Math.hypot(G.xy[i * 2], G.xy[i * 2 + 1]);
      const dim = r >= dustStart - 1 ? 0.45 : 1;
      col[i * 3] = c[0] * dim; col[i * 3 + 1] = c[1] * dim; col[i * 3 + 2] = c[2] * dim;
      sz[i] = G.meta[i * 2 + 1];
    }
    G.col = col;
    B.pos = buf(G.xy); B.col = buf(col); B.sz = buf(sz);
    // tree edges
    let m = 0; for (let i = 0; i < N; i++) if (G.parent[i] >= 0) m++;
    const lp = new Float32Array(m * 4), lc = new Float32Array(m * 6);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const p = G.parent[i]; if (p < 0) continue;
      lp[j * 4] = G.xy[i * 2]; lp[j * 4 + 1] = G.xy[i * 2 + 1]; lp[j * 4 + 2] = G.xy[p * 2]; lp[j * 4 + 3] = G.xy[p * 2 + 1];
      const lr = LOOK.lineRGB ? LOOK.lineRGB.split(",").map((v) => v / 255) : [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]];
      for (let t = 0; t < 2; t++) { lc[j * 6 + t * 3] = lr[0]; lc[j * 6 + t * 3 + 1] = lr[1]; lc[j * 6 + t * 3 + 2] = lr[2]; }
      j++;
    }
    B.lpos = buf(lp); B.lcol = buf(lc); B.lcount = m * 2;
    dirty = true;
  }

  function dotRGB(i) { return LOOK.dotColor ? LOOK.dotColor(i) : G.pal[G.meta[i * 2]]; }
  function segRGB(i) { return LOOK.lineRGB ? LOOK.lineRGB.split(",").map((v) => v / 255) : G.pal[G.meta[i * 2]]; }
  // dynamic overlay geometry (focus lineage / lens) rebuilt on change
  function dynLines(segs) { // segs: [[a,b,r,g,b]...] by node index
    const p = new Float32Array(segs.length * 4), c = new Float32Array(segs.length * 6);
    segs.forEach((s, i) => {
      p[i * 4] = G.xy[s[0] * 2]; p[i * 4 + 1] = G.xy[s[0] * 2 + 1]; p[i * 4 + 2] = G.xy[s[1] * 2]; p[i * 4 + 3] = G.xy[s[1] * 2 + 1];
      for (let t = 0; t < 2; t++) { c[i * 6 + t * 3] = s[2]; c[i * 6 + t * 3 + 1] = s[3]; c[i * 6 + t * 3 + 2] = s[4]; }
    });
    return { p, c, n: segs.length * 2 };
  }

  function draw() {
    if (!G || !gl) return;
    gl.viewport(0, 0, glc.width, glc.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ctr = [cam.x - (0) / cam.s, cam.y + (insets.bottom - insets.top) / 2 / cam.s];
    const dim = focus ? 0.55 : 1;
    // edges
    gl.useProgram(P_LN.p);
    gl.uniform2f(P_LN.u.ctr, ctr[0], ctr[1]); gl.uniform1f(P_LN.u.s, cam.s); gl.uniform2f(P_LN.u.res, W, H);
    const ea = Math.min(LOOK.lineA != null ? LOOK.lineA : 0.42, Math.max(0.05, 0.03 + cam.s * 0.05)) * dim;
    gl.uniform1f(P_LN.u.a, ea);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.lpos); gl.enableVertexAttribArray(P_LN.a.p); gl.vertexAttribPointer(P_LN.a.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.lcol); gl.enableVertexAttribArray(P_LN.a.c); gl.vertexAttribPointer(P_LN.a.c, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, B.lcount);
    // points
    gl.useProgram(P_PT.p);
    gl.uniform2f(P_PT.u.ctr, ctr[0], ctr[1]); gl.uniform1f(P_PT.u.s, cam.s); gl.uniform2f(P_PT.u.res, W, H);
    gl.uniform1f(P_PT.u.k, Math.max(0.9, Math.min(7, cam.s * 0.3))); gl.uniform1f(P_PT.u.dpr, DPR);
    gl.uniform1f(P_PT.u.shape, LOOK.shape || 0); const oc = (LOOK.outline || "0,0,0").split(",").map((v) => v / 255); gl.uniform3f(P_PT.u.oc, oc[0], oc[1], oc[2]);
    // at reading distance unlabeled dots recede; the label pass redraws named dots at full strength
    gl.uniform1f(P_PT.u.a, (focus ? 0.6 : 1) * (cam.s >= READ_ZOOM ? 0.32 : 1));
    gl.bindBuffer(gl.ARRAY_BUFFER, B.pos); gl.enableVertexAttribArray(P_PT.a.p); gl.vertexAttribPointer(P_PT.a.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.col); gl.enableVertexAttribArray(P_PT.a.c); gl.vertexAttribPointer(P_PT.a.c, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, B.sz); gl.enableVertexAttribArray(P_PT.a.sz); gl.vertexAttribPointer(P_PT.a.sz, 1, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, G.N);
    // lens overlay across the whole map (e.g. every doublet pair)
    if (globalGeo) {
      gl.useProgram(P_LN.p);
      gl.uniform2f(P_LN.u.ctr, ctr[0], ctr[1]);
      gl.uniform1f(P_LN.u.a, focus ? 0.35 : 0.8);
      gl.bindBuffer(gl.ARRAY_BUFFER, globalGeo.bp); gl.vertexAttribPointer(P_LN.a.p, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, globalGeo.bc); gl.vertexAttribPointer(P_LN.a.c, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, globalGeo.n);
    }
    // focus overlay: bright lines (drawn 3× slightly offset for weight) + lit points
    if (focus && focus.geo) {
      gl.useProgram(P_LN.p);
      gl.uniform1f(P_LN.u.a, 0.95);
      gl.bindBuffer(gl.ARRAY_BUFFER, focus.geo.bp); gl.vertexAttribPointer(P_LN.a.p, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, focus.geo.bc); gl.vertexAttribPointer(P_LN.a.c, 3, gl.FLOAT, false, 0, 0);
      for (const off of [[0, 0], [0.7, 0], [0, 0.7]]) {
        gl.uniform2f(P_LN.u.ctr, ctr[0] + off[0] / cam.s, ctr[1] + off[1] / cam.s);
        gl.drawArrays(gl.LINES, 0, focus.geo.n);
      }
      gl.useProgram(P_PT.p);
      gl.uniform2f(P_PT.u.ctr, ctr[0], ctr[1]);
      gl.uniform1f(P_PT.u.a, cam.s >= READ_ZOOM ? 0.35 : 1);
      gl.uniform1f(P_PT.u.k, Math.max(2.4, Math.min(8, cam.s * 0.34)));
      gl.bindBuffer(gl.ARRAY_BUFFER, focus.geo.pp); gl.vertexAttribPointer(P_PT.a.p, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, focus.geo.pc); gl.vertexAttribPointer(P_PT.a.c, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, focus.geo.ps); gl.vertexAttribPointer(P_PT.a.sz, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, focus.geo.np);
    }
    drawUnder(ctr);
    drawLabels(ctr);
  }

  // ---- labels (no overlaps: a screen-space occupancy grid) -----------------------
  const FONT = '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif';
  function eraLabel(y) { return y <= 0 ? (y === 0 ? "AD 1" : -y + " BC") : y >= 2000 ? "today" : String(y); }
  const ROMAN = (n) => { const t = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]; let s = ""; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s; };
  function yearText(y) {
    if (LOOK.years === "roman") return y >= 2000 ? "Hodie" : y <= 0 ? (y === 0 ? "Anno Domini" : ROMAN(-y) + " ante Christum") : "Anno " + ROMAN(y) + ".";
    if (LOOK.caps) return eraLabel(y).toUpperCase();
    return eraLabel(y);
  }
  const vForU = (t) => t.toUpperCase().replace(/U/g, "V");
  const T = (y) => -Math.log(2400 - Math.min(y, 2000));
  // text that follows a circle (map lettering along a ring), ending at angle a1
  function arcText(text, cx, cy, r, a1, font, fill) {
    ctx.save(); ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    let a = a1; const chars = [...text].reverse();
    for (const ch of chars) {
      const w = ctx.measureText(ch).width; a -= w / 2 / r;
      ctx.save(); ctx.translate(cx + r * Math.cos(a), cy + r * Math.sin(a)); ctx.rotate(a + Math.PI / 2);
      ctx.lineWidth = 3; ctx.strokeStyle = LOOK.halo; ctx.strokeText(ch, 0, 0); ctx.fillStyle = fill; ctx.fillText(ch, 0, 0);
      ctx.restore(); a -= w / 2 / r;
    }
    ctx.restore();
  }
  // a dot in the look's shape (canvas twin of the GL point shader)
  function drawDot(x, y, r, rgb, alpha) {
    const sh = LOOK.shape || 0;
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    if (sh === 3) { ctx.fillRect(x - r, y - r, 2 * r, 2 * r); return; }
    if (sh === 2) {
      ctx.beginPath(); const R = r * 1.5, q = r * 0.32;
      ctx.moveTo(x, y - R); ctx.lineTo(x + q, y - q); ctx.lineTo(x + R, y); ctx.lineTo(x + q, y + q); ctx.lineTo(x, y + R); ctx.lineTo(x - q, y + q); ctx.lineTo(x - R, y); ctx.lineTo(x - q, y - q); ctx.closePath(); ctx.fill(); return;
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (sh === 1) { ctx.strokeStyle = `rgba(${LOOK.outline},${alpha})`; ctx.lineWidth = 0.8; ctx.stroke(); }
  }
  // revision cloud (red pencil)
  function cloud(x, y, r, color) {
    const n = Math.max(8, Math.round(r / 2.6)); ctx.beginPath();
    for (let i = 0; i < n; i++) { const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI, am = (a0 + a1) / 2;
      ctx.arc(x + r * Math.cos(am), y + r * Math.sin(am), r * Math.PI / n, am - Math.PI / 2 - 0.5, am + Math.PI / 2 + 0.5); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
  }
  function youMark(x, y, size, kind) {
    const you = LOOK.you;
    ctx.save(); ctx.setLineDash([]);
    if (kind === "cloud") cloud(x, y, size + 4, `rgba(${you},0.95)`);
    else if (kind === "square") { ctx.strokeStyle = `rgba(${you},1)`; ctx.lineWidth = 1; ctx.strokeRect(x - size, y - size, size * 2, size * 2); }
    else if (kind === "double") { ctx.strokeStyle = `rgba(${LOOK.ink},0.95)`; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, size, 0, 7); ctx.stroke(); ctx.lineWidth = 0.6; ctx.beginPath(); ctx.arc(x, y, size + 3, 0, 7); ctx.stroke(); }
    else { ctx.strokeStyle = `rgba(${you},0.95)`; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(x, y, size, 0, 7); ctx.stroke(); }
    ctx.restore();
  }
  // under the GL layer: the look's ground (Ortelius's stippled sea and coloured lands, Priestley's washes)
  function drawUnder(ctr) {
    if (!und) return;
    const uc = und.getContext("2d");
    uc.setTransform(DPR, 0, 0, DPR, 0, 0); uc.clearRect(0, 0, W, H);
    if (!LOOK.stipple && !LOOK.wash) return;
    const sx = (x) => (x - ctr[0]) * cam.s + W / 2, sy = (y) => (y - ctr[1]) * cam.s + H / 2;
    if (LOOK.stipple) {
      if (!drawUnder.pat) { const pc = document.createElement("canvas"); pc.width = pc.height = 14; const p = pc.getContext("2d"); p.fillStyle = `rgba(${LOOK.ink},0.42)`; p.beginPath(); p.arc(3, 3, 1, 0, 7); p.fill(); p.beginPath(); p.arc(10, 9.5, 0.9, 0, 7); p.fill(); drawUnder.pat = uc.createPattern(pc, "repeat"); }
      uc.fillStyle = drawUnder.pat; uc.fillRect(0, 0, W, H);
    }
    let n = 0;
    for (const t of G.trees) {
      const R = t.R * cam.s; if (R < 14) continue;
      const cx = sx(t.x), cy = sy(t.y);
      if (cx + R < 0 || cx - R > W || cy + R < 0 || cy - R > H) continue;
      if (++n > 400) break;
      const c = G.pal[G.meta[t.root * 2]], rgb = rgbOf(c);
      if (LOOK.stipple) { // a land: paper over the sea, a hand-coloured band inside a dotted shore
        uc.fillStyle = LOOK.paper || "#ecdfbf";
        uc.beginPath(); uc.arc(cx, cy, R, 0, 7); uc.fill();
        uc.strokeStyle = `rgba(${rgb},0.5)`; uc.lineWidth = Math.min(9, R * 0.08); uc.beginPath(); uc.arc(cx, cy, R - uc.lineWidth / 2, 0, 7); uc.stroke();
        uc.setLineDash([1, 2.5]); uc.strokeStyle = `rgba(${LOOK.ink},0.7)`; uc.lineWidth = 0.9; uc.beginPath(); uc.arc(cx, cy, R, 0, 7); uc.stroke(); uc.setLineDash([]);
      } else { // a watercolour wash laid over the family's territory
        const g = uc.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.04);
        g.addColorStop(0, `rgba(${rgb},0.24)`); g.addColorStop(0.85, `rgba(${rgb},0.18)`); g.addColorStop(1, `rgba(${rgb},0)`);
        uc.fillStyle = g; uc.beginPath(); uc.arc(cx, cy, R * 1.04, 0, 7); uc.fill();
      }
    }
  }
  // the planisphere's overlay: leather everywhere but an oval window, gilt-tooled, with the
  // neighbouring families named round the rim where they lie
  let plate = null, plateA = 0, plateWant = 0;
  function drawPlate(sx, sy) {
    if (!LOOK.plate || !plate) return;
    plateA += (plateWant - plateA) * 0.22; if (Math.abs(plateWant - plateA) > 0.01) dirty = true; else plateA = plateWant;
    if (plateA < 0.02) return;
    const { x, y, rx, ry } = plate;
    ctx.save(); ctx.globalAlpha = plateA;
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#1c2541"; ctx.fill("evenodd");
    const gilt = "rgba(209,173,91,1)";
    ctx.strokeStyle = "#0e1426"; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(x, y, rx + 1, ry + 1, 0, 0, 7); ctx.stroke();
    ctx.strokeStyle = gilt; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(x, y, rx + 6, ry + 6, 0, 0, 7); ctx.stroke();
    ctx.lineWidth = 0.5; ctx.beginPath(); ctx.ellipse(x, y, rx + 10, ry + 10, 0, 0, 7); ctx.stroke();
    const ft = (plate.top || 0) + 9, fb = H - (plate.bottom || 0) - 9;
    ctx.lineWidth = 1.2; ctx.strokeRect(9, ft, W - 18, fb - ft); ctx.lineWidth = 0.5; ctx.strokeRect(13, ft + 4, W - 26, fb - ft - 8);
    // what lies beyond the window: the nearest other families, named in gilt on their side
    if (focus) {
      const t = G.treeOf.get(focus.root);
      if (t) {
        const near = [];
        for (const u of G.trees) { if (u === t) continue; const d = Math.hypot(u.x - t.x, u.y - t.y); near.push([d, u]); }
        near.sort((a, b) => a[0] - b[0]);
        const used = [];
        ctx.font = "11px 'Playfair Display SC', 'Playfair Display', Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const [, u] of near) {
          if (used.length >= 3) break;
          const a = Math.atan2(u.y - t.y, u.x - t.x);
          if (used.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 0.9)) continue;
          used.push(a);
          const nx = x + (rx + 24) * Math.cos(a), ny = y + (ry + 24) * Math.sin(a);
          if (nx < 30 || nx > W - 30 || ny < 30 || ny > H - 30) continue;
          ctx.fillStyle = gilt; ctx.beginPath(); ctx.arc(x + (rx + 12) * Math.cos(a), y + (ry + 12) * Math.sin(a), 2, 0, 7); ctx.fill();
          ctx.fillText(G.labels[u.root], nx, ny);
        }
      }
    }
    ctx.restore();
  }
  function drawLabels(ctr) {
    const dark = isDark(), L = LOOK;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sx = (x) => (x - ctr[0]) * cam.s + W / 2, sy = (y) => (y - ctr[1]) * cam.s + H / 2;
    const ink = L.ink;
    const fam = L.font || FONT, wgt = L.weight || 500;
    const occ = new Map(); const CELL = 16;
    const free = (x0, y0, x1, y1) => {
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const Lc = occ.get(gx * 4096 + gy); if (!Lc) continue;
          for (const r of Lc) if (r[0] < x1 && r[2] > x0 && r[1] < y1 && r[3] > y0) return false;
        }
      return true;
    };
    const take = (x0, y0, x1, y1) => {
      const r = [x0, y0, x1, y1];
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const k = gx * 4096 + gy; let Lc = occ.get(k); if (!Lc) occ.set(k, (Lc = [])); Lc.push(r);
        }
    };
    // with the plate down, only what shows through the window is lettered
    const inWindow = (x, y) => !(L.plate && plate && plateA > 0.5) || ((x - plate.x) / plate.rx) ** 2 + ((y - plate.y) / plate.ry) ** 2 < 0.92;
    // block UI-covered strips so labels never hide under the sheet / bar
    take(-1000, -1000, W + 1000, insets.top); take(-1000, H - insets.bottom, W + 1000, H + 1000);
    if (focus) { const fx = sx(G.xy[focus.idx * 2]), fy = sy(G.xy[focus.idx * 2 + 1]); take(fx - 12, fy - 12, fx + 12, fy + 12); }
    // your walk this session: faint dashes between the points you've stood on (Netscape shows it as visited links instead)
    if (trail && trail.length > 1 && !L.wordColor) {
      ctx.save();
      ctx.setLineDash([3, 5]); ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(${ink},0.32)`;
      ctx.beginPath();
      trail.forEach((i, k) => { const x = sx(G.xy[i * 2]), y = sy(G.xy[i * 2 + 1]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.restore();
    }
    // the family you're in: its centre, and the ring through the node you're on
    let hereR = -1, homeT = null;
    if (focus) homeT = G.treeOf.get(focus.root) || null;
    if (focus && OPT.hereRing && homeT) {
      const t = homeT, i = focus.idx, cx = sx(t.x), cy = sy(t.y), x = sx(G.xy[i * 2]), y = sy(G.xy[i * 2 + 1]);
      const r = Math.hypot(x - cx, y - cy);
      if (r > 10) {
        hereR = r;
        ctx.save();
        ctx.strokeStyle = `rgba(${L.here},0.75)`; ctx.lineWidth = 1.4; ctx.setLineDash(L.hereDash || []);
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        const lang = G.info.langs[G.lang[i]], yr = G.info.eras[G.lang[i]];
        let txt = lang + " · " + (yr >= 1990 ? "today" : "c. " + eraLabel(yr));
        if (L.caps || L.regionCaps) txt = txt.toUpperCase();
        ctx.font = `600 ${L.regionCaps ? 10 : 11}px ${fam}`; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        const tw = ctx.measureText(txt).width;
        const a0 = Math.atan2(y - cy, x - cx), spots = [];
        for (let k = 0; k <= 12; k++) for (const sg of k ? [1, -1] : [1]) {
          const ang = a0 + Math.PI + sg * k * Math.PI / 12, px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
          spots.push([px - tw / 2, py + (Math.sin(ang) > 0 ? 13 : -3)]);
        }
        for (const [tx, ty] of spots) {
          if (tx < 6 || tx + tw > W - 6 || !inWindow(tx + tw / 2, ty) || !free(tx - 3, ty - 12, tx + tw + 3, ty + 1)) continue;
          take(tx - 3, ty - 12, tx + tw + 3, ty + 1);
          ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.lineJoin = "round";
          ctx.strokeText(txt, tx, ty); ctx.fillStyle = `rgba(${L.here},1)`; ctx.fillText(txt, tx, ty); break;
        }
        ctx.restore();
      }
    }
    // era rings of families big enough on screen (the axis of successions)
    if (cam.s > 1.2) {
      ctx.lineWidth = 1; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      const ERAS = [-2000, -1000, 0, 1000, 1500, 2000];
      // one rule: the family you're in (or, with nothing focused, the one nearest the
      // middle of the screen) always carries its years; every other family's rings stay bare
      const vis = [];
      for (const t of G.trees) {
        const R = t.R * cam.s; if (R < 70) continue;
        const cx = sx(t.x), cy = sy(t.y);
        if (cx + R < 0 || cx - R > W || cy + R < 0 || cy - R > H) continue;
        vis.push([t, R, cx, cy]);
      }
      let home = focus ? focus.root : -1;
      if (home < 0 || !vis.some((v) => v[0].root === home)) {
        let best = Infinity; const mx = W / 2, my = insets.top + (H - insets.top - insets.bottom) / 2;
        for (const [t, R, cx, cy] of vis) { const d = Math.hypot(cx - mx, cy - my) / R; if (d < best) { best = d; home = t.root; } }
      }
      const ringRGB = L.ringRGB || ink;
      for (const [t, R, cx, cy] of vis) {
        const ry = G.info.eras[G.lang[t.root]];
        const strong = t.root === home;
        const rings = [];
        for (const y of ERAS) {
          if (y <= ry + 50) continue;
          const r = t.scale * (T(y) - T(ry)) * cam.s; if (r < 18) continue;
          rings.push([y, r]);
          ctx.save();
          ctx.strokeStyle = `rgba(${ringRGB},${(L.ringA || 0.16) * (strong ? 1 : 0.45)})`; ctx.lineWidth = L.ringDouble ? 0.5 : 0.9;
          ctx.setLineDash(L.ringDash || []);
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
          if (L.ringDouble) { ctx.beginPath(); ctx.arc(cx, cy, r + 2.5, 0, Math.PI * 2); ctx.stroke(); }
          ctx.restore();
        }
        if (!strong) continue;
        const near = (r) => hereR > 0 && Math.abs(r - hereR) < 16;
        if (L.years === "roman") { // lettered along the ring, like the plate's tropics
          for (const [y, r] of rings) if (!near(r) && y < 2000) arcText(yearText(y), cx, cy, r + 5, -Math.PI / 2 - 0.12, `italic 11px ${fam}`, `rgba(${ink},0.85)`);
        } else if (L.years === "dim") { // an ordinate dimension measured out from the root
          const a = Math.PI * 0.99, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux, far = rings.length ? rings[rings.length - 1][1] : 0;
          ctx.save(); ctx.strokeStyle = `rgba(${ink},0.8)`; ctx.fillStyle = `rgba(${ink},0.9)`; ctx.lineWidth = 0.7;
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + far * ux, cy + far * uy); ctx.stroke();
          ctx.font = `9px 'Overpass Mono', monospace`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
          for (const [y, r] of rings) {
            const x = cx + r * ux, yy = cy + r * uy;
            ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x - 7 * ux + 2.5 * nx, yy - 7 * uy + 2.5 * ny); ctx.lineTo(x - 7 * ux - 2.5 * nx, yy - 7 * uy - 2.5 * ny); ctx.closePath(); ctx.fill();
            const tx = x + 7 * nx, ty = yy - 9;
            if (free(tx - 34, ty - 6, tx + 2, ty + 6)) { take(tx - 34, ty - 6, tx + 2, ty + 6); ctx.fillText(yearText(y), tx, ty); }
          }
          ctx.restore();
        } else if (L.years === "scale" && focus) { // a graduated rule along the line of descent, every century
          const i = focus.idx, nx0 = sx(G.xy[i * 2]), ny0 = sy(G.xy[i * 2 + 1]);
          const a = Math.atan2(ny0 - cy, nx0 - cx), ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
          ctx.save(); ctx.strokeStyle = `rgba(${ink},0.9)`; ctx.fillStyle = `rgba(${ink},1)`; ctx.font = `10px ${fam}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
          for (let y = Math.ceil((ry + 50) / 100) * 100; y <= 2000; y += 100) {
            const r = t.scale * (T(y) - T(ry)) * cam.s; if (r < 8) continue;
            const big = y % 500 === 0, x = cx + r * ux, yy = cy + r * uy, len = big ? 7 : 4;
            ctx.lineWidth = big ? 0.9 : 0.5; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + len * px, yy + len * py); ctx.stroke();
            if (big && y < 2000) { const tx = x + 10 * px, ty = yy + 10 * py; if (free(tx - 30, ty - 6, tx + 2, ty + 6)) { take(tx - 30, ty - 6, tx + 2, ty + 6); ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.strokeText(yearText(y), tx, ty); ctx.fillText(yearText(y), tx, ty); ctx.strokeStyle = `rgba(${ink},0.9)`; } }
          }
          ctx.restore();
        } else if (L.years !== "scale") {
          ctx.font = `10px ${L.yearFont || fam}`;
          for (const [y, r] of rings) {
            if (near(r)) continue;
            const Lb = yearText(y), tw = ctx.measureText(Lb).width;
            const spots = [[cx - tw - 6, cy - r - 2], [cx - tw - 6, cy + r + 12], [cx + r + 3, cy - 2], [cx - r - tw - 3, cy - 2]];
            for (const [tx, ty] of spots) {
              if (!inWindow(tx, ty) || !free(tx, ty - 11, tx + tw, ty)) continue;
              take(tx, ty - 11, tx + tw, ty); ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.strokeText(Lb, tx, ty); ctx.fillStyle = `rgba(${ink},0.7)`; ctx.fillText(Lb, tx, ty); break;
            }
          }
        }
      }
    }
    // region names when zoomed out
    if (cam.s < 0.9) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const R of G.info.regions) {
        const fs = Math.max(11, Math.min(18, R.r * cam.s * 0.12));
        let name = R.name;
        if (L.headCaps) name = vForU(name); else if (L.caps || L.regionCaps) name = name.toUpperCase();
        ctx.font = (L.regionCaps ? "" : "600 ") + fs + "px " + fam;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = L.regionCaps ? fs * 0.3 + "px" : "0px";
        const x = sx(R.x), y = sy(R.y - R.r) - 4, w = ctx.measureText(name).width;
        if (!free(x - w / 2, y - fs / 2, x + w / 2, y + fs / 2)) continue;
        take(x - w / 2 - 4, y - fs / 2, x + w / 2 + 4, y + fs / 2);
        ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.strokeText(name, x, y);
        ctx.fillStyle = `rgba(${ink},${0.8 - Math.max(0, cam.s - 0.5)})`;
        ctx.fillText(name, x, y);
      }
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = "0px";
    }
    // node labels
    const minS = cam.s < 0.25 ? 190 : cam.s < 0.7 ? 100 : cam.s < 2 ? 40 : 0;
    const cand = [];
    const lit = focus ? focus.order : [];
    for (const i of lit) cand.push(i);
    const wx0 = ctr[0] - W / 2 / cam.s, wx1 = ctr[0] + W / 2 / cam.s, wy0 = ctr[1] - H / 2 / cam.s, wy1 = ctr[1] + H / 2 / cam.s;
    const cells = ((wx1 - wx0) / G.cell) * ((wy1 - wy0) / G.cell);
    if (cells < 30000) {
      const pool = [];
      const cx0 = Math.max(0, Math.floor((wx0 - G.gx0) / G.cell)), cx1 = Math.min(G.gw - 1, Math.floor((wx1 - G.gx0) / G.cell));
      const cy0 = Math.max(0, Math.floor((wy0 - G.gy0) / G.cell)), cy1 = Math.min(G.gh - 1, Math.floor((wy1 - G.gy0) / G.cell));
      for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) {
        const c = gx + gy * G.gw;
        for (let k = G.cellStart[c]; k < G.cellStart[c + 1]; k++) { const i = G.cellItems[k]; if (G.meta[i * 2 + 1] >= minS) pool.push(i); }
      }
      pool.sort((a, b) => G.meta[b * 2 + 1] - G.meta[a * 2 + 1]);
      for (const i of pool) cand.push(i);
    } else {
      for (let k = 0, got = 0; k < G.bySize.length && got < 1500; k++) {
        const i = G.bySize[k]; if (G.meta[i * 2 + 1] < minS) break;
        const x = G.xy[i * 2], y = G.xy[i * 2 + 1];
        if (x > wx0 && x < wx1 && y > wy0 && y < wy1) { cand.push(i); got++; }
      }
    }
    const max = W < 500 ? 90 : 170;
    let placed = 0;
    labelHits = [];
    const seen = new Set();
    const texts = []; // names are drawn after every dot, so a dot never sits on top of a name
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (const i of cand) {
      if (placed >= max) break;
      if (seen.has(i)) continue; seen.add(i);
      const x = sx(G.xy[i * 2]), y = sy(G.xy[i * 2 + 1]);
      if (x < -40 || x > W + 40 || y < -20 || y > H + 20) continue;
      if (!inWindow(x, y)) continue;
      const isLit = focus && focus.lit.has(i);
      if (focus && !OPT.otherFamilies && !isLit && G.tree && G.tree[i] !== G.tree[focus.idx]) continue;
      const isWord = G.lang[i] === 0;
      const big = isLit && i === focus.idx;
      let fs = big ? 15 : isLit ? 12.5 : Math.min(13, 10.5 + G.meta[i * 2 + 1] / 70);
      let txt = G.labels[i];
      let spaced = 0;
      if (big && L.headCaps) { txt = vForU(txt); fs = 22; spaced = 0.4; }
      else if (L.caps) { txt = txt.toUpperCase(); fs = Math.max(9.5, fs - 1.5); }
      ctx.font = (big ? "700 " : isWord ? wgt + " " : "italic " + wgt + " ") + fs + "px " + fam;
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = spaced ? fs * spaced + "px" : "0px";
      const w = ctx.measureText(txt).width;
      const dot = Math.max(1, Math.min(34, (1 + G.meta[i * 2 + 1] / 40) * (isLit ? Math.max(2.4, Math.min(8, cam.s * 0.34)) : Math.max(0.9, Math.min(7, cam.s * 0.3)))));
      const pr = big ? Math.max(13, Math.min(17, dot) / 2 + 3) : Math.min(17, Math.max(2, dot)) / 2 + 3;
      // try right, then left, then above (a lettered head goes above, spread over the land)
      const spots = spaced ? [[x - w / 2, y - pr - fs - 6, x + w / 2, y - pr - 4]] : [[x + pr, y - fs / 2 - 1, x + pr + w, y + fs / 2 + 1], [x - pr - w, y - fs / 2 - 1, x - pr, y + fs / 2 + 1], [x - w / 2, y - pr - fs - 1, x + w / 2, y - pr]];
      let ok = null;
      const dr = Math.max(1.5, dot * 0.43); // a name never sits under another node's dot, and vice versa
      if (cam.s >= READ_ZOOM && !isLit && !free(x - dr, y - dr, x + dr, y + dr)) continue;
      for (const s of spots) if (free(s[0], s[1], s[2], s[3]) || (spaced && s === spots[0])) { ok = s; break; }
      if (!ok) continue;
      take(ok[0] - 2, ok[1], ok[2] + 2, ok[3]);
      take(x - pr, y - pr, x + pr, y + pr);
      labelHits.push([ok[0] - 4, ok[1] - 4, ok[2] + 4, ok[3] + 4, i]);
      const famRGB = rgbOf(G.pal[G.meta[i * 2]]);
      const a = focus && !isLit ? 0.62 : 1;
      if (cam.s >= READ_ZOOM) drawDot(x, y, dr, rgbOf(dotRGB(i)), isLit ? 1 : a); // a named dot at full strength
      let colr;
      if (isWord) colr = L.wordColor ? L.wordColor(i) : ink;
      else colr = isLit && L.litAncRGB ? L.litAncRGB : L.ancRGB || (L.ancInk ? ink : famRGB);
      if (big && !L.wordColor) colr = ink;
      if (big && L.wordColor) colr = L.you;
      texts.push([ctx.font, txt, ok[0], (ok[1] + ok[3]) / 2, `rgba(${colr},${a})`, L.underline && isWord, spaced ? fs * spaced : 0]);
      placed++;
      // up close the map reads like the dictionary: a one-line meaning under the label
      if ((!focus || OPT.glossFocused) && cam.s > GLOSS_ZOOM && placed < 60) {
        const g = glossOf(i);
        if (g) {
          ctx.font = "italic 11px " + fam;
          let gt = g.length > 54 ? g.slice(0, 52) + "…" : g;
          const gw = ctx.measureText(gt).width, gx = ok[0], gy = ok[3] + 2;
          if (free(gx, gy, gx + gw, gy + 13)) {
            take(gx, gy, gx + gw, gy + 13);
            texts.push([ctx.font, gt, gx, gy + 6.5, `rgba(${ink},${0.62 * a})`, false, 0]);
          }
        }
      }
    }
    // a soft halo keeps text legible over dots and lines
    ctx.lineWidth = 3; ctx.strokeStyle = L.halo; ctx.lineJoin = "round";
    for (const [f, t, x, y, col, ul, ls] of texts) {
      ctx.font = f; if (ctx.letterSpacing !== undefined) ctx.letterSpacing = ls ? ls + "px" : "0px";
      ctx.strokeText(t, x, y); ctx.fillStyle = col; ctx.fillText(t, x, y);
      if (ul) { const w = ctx.measureText(t).width; ctx.fillRect(x, y + 6, w, 1); }
    }
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = "0px";
    // search matches: marked where they live (in the look's colour for you); off-screen ones point the way
    const markList = (marks || []).slice(0, 12);
    if (ping >= 0 && !markList.includes(ping)) markList.unshift(ping);
    if (markList.length) {
      const top = insets.top + 10, bot = H - insets.bottom - 10;
      const on = !L.blink || Math.floor(performance.now() / 500) % 2 === 0;
      for (const m of markList) {
        const x = sx(G.xy[m * 2]), y = sy(G.xy[m * 2 + 1]);
        if (x > 8 && x < W - 8 && y > top && y < bot) {
          if (L.blink) { if (on) { ctx.fillStyle = `rgba(${L.you},0.85)`; ctx.fillRect(x - 6, y - 6, 12, 12); } }
          else if (L.focusMark === "cloud") youMark(x, y, 8, "cloud");
          else { const t = (performance.now() % 1400) / 1400; ctx.strokeStyle = `rgba(${L.you},${m === ping ? 1 - t : 0.9})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, m === ping ? 6 + 18 * t : 10, 0, Math.PI * 2); ctx.stroke(); }
        } else if (m === markList[0]) {
          const cx = W / 2, cy = (top + bot) / 2, dx = x - cx, dy = y - cy;
          const k = Math.min((W / 2 - 18) / Math.abs(dx || 1e-6), ((bot - top) / 2 - 18) / Math.abs(dy || 1e-6));
          const ax = cx + dx * k, ay = cy + dy * k, ang = Math.atan2(dy, dx);
          ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang);
          ctx.fillStyle = `rgba(${L.you},0.95)`;
          ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-6, -6); ctx.lineTo(-3, 0); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      dirty = true; // keep pulsing
    }
    if (focus) { // the mark of where you are standing
      const i = focus.idx, x = sx(G.xy[i * 2]), y = sy(G.xy[i * 2 + 1]);
      youMark(x, y, L.focusMark === "square" ? 8 : 10, L.focusMark || "circle");
      if (L.focusMark === "cloud") { ctx.save(); ctx.strokeStyle = `rgba(${L.you},1)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x + 16, y - 10); ctx.lineTo(x + 23, y - 22); ctx.lineTo(x + 30, y - 10); ctx.closePath(); ctx.stroke(); ctx.restore(); }
      // the family's root is the brass rivet the disc turns on
      if (L.rivet && homeT) {
        const rx = sx(homeT.x), ry = sy(homeT.y), g = ctx.createRadialGradient(rx - 2, ry - 2, 0.5, rx, ry, 7);
        g.addColorStop(0, "#f6dc95"); g.addColorStop(0.55, "#c7963e"); g.addColorStop(1, "#7d5a1d");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(rx, ry, 6.5, 0, 7); ctx.fill(); ctx.strokeStyle = "#5a3f12"; ctx.lineWidth = 0.6; ctx.stroke();
      }
    }
    drawPlate(sx, sy);
  }

  // glosses come from the per-node detail chunks; fetched on demand, drawn when they land
  const GLOSS_ZOOM = 9;
  // presentation options (kept switchable while the look is being settled)
  const OPT = { glossFocused: false, hereRing: true, otherFamilies: true };
  const READ_ZOOM = 2; // from here every node is a label candidate
  function glossOf(i) {
    const c = Math.floor(i / G.info.chunk);
    const m = G.chunkData && G.chunkData.get(c);
    if (!m) {
      if (!glossWant.has(c) && glossWant.size < 400) { glossWant.add(c); RM.details(i).then(() => { dirty = true; }); }
      return null;
    }
    const d = m[i];
    return d ? d.sd || d.g || null : null;
  }

  // ---- camera ------------------------------------------------------------------------
  function frame() {
    if (anim) {
      const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      cam.x = anim.x0 + (anim.x1 - anim.x0) * e; cam.y = anim.y0 + (anim.y1 - anim.y0) * e;
      // zoom along log space, dipping out when travelling far (keeps context)
      const ls = Math.log(anim.s0) + (Math.log(anim.s1) - Math.log(anim.s0)) * e - anim.dip * Math.sin(Math.PI * e);
      cam.s = Math.exp(ls);
      dirty = true;
      if (t >= 1) { const d = anim.done; anim = null; if (d) d(); }
    }
    if (glide) {
      const now = performance.now(), dt = Math.min(40, now - glide.t); glide.t = now;
      cam.x -= (glide.vx * dt) / cam.s; cam.y -= (glide.vy * dt) / cam.s;
      const k = Math.exp(-dt / 330); glide.vx *= k; glide.vy *= k; // the same friction a phone list uses
      dirty = true;
      if (Math.hypot(glide.vx, glide.vy) < 0.015) { glide = null; if (onInteract) onInteract(false); }
    }
    if (dirty) { dirty = false; draw(); if (onDraw) onDraw(); }
    requestAnimationFrame(frame);
  }
  function flyTo(x, y, s, dur) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) dur = 0;
    const dist = Math.hypot(x - cam.x, y - cam.y) * Math.min(cam.s, s);
    const dip = dist > Math.max(W, H) * 1.5 ? Math.min(3, Math.log(dist / Math.max(W, H))) : 0;
    if (anim && anim.done) anim.done(); // a newer flight supersedes the old one
    let done; const p = new Promise((r) => (done = r));
    anim = { t0: performance.now(), dur: dur == null ? 1100 : dur, x0: cam.x, y0: cam.y, s0: cam.s, x1: x, y1: y, s1: s, dip, done };
    if (!anim.dur) { cam.x = x; cam.y = y; cam.s = s; anim = null; done(); }
    dirty = true;
    return p;
  }
  function fitScale() { const b = G.info.bounds; return Math.min(W, H - insets.top - insets.bottom) / (b[2] - b[0]) * 0.98; }

  // ---- interaction ------------------------------------------------------------------------
  function toWorld(px, py) {
    const ctr = [cam.x, cam.y + (insets.bottom - insets.top) / 2 / cam.s];
    return [(px - W / 2) / cam.s + ctr[0], (py - H / 2) / cam.s + ctr[1]];
  }
  function pick(px, py) {
    // a word's label is as tappable as its dot (labels are the big targets on a phone)
    for (let k = labelHits.length - 1; k >= 0; k--) {
      const h = labelHits[k];
      if (px >= h[0] && px <= h[2] && py >= h[1] && py <= h[3]) return h[4];
    }
    const [wx, wy] = toWorld(px, py);
    const rad = 22 / cam.s;
    let best = -1, bd = Infinity;
    const cx0 = Math.max(0, Math.floor((wx - rad - G.gx0) / G.cell)), cx1 = Math.min(G.gw - 1, Math.floor((wx + rad - G.gx0) / G.cell));
    const cy0 = Math.max(0, Math.floor((wy - rad - G.gy0) / G.cell)), cy1 = Math.min(G.gh - 1, Math.floor((wy + rad - G.gy0) / G.cell));
    if ((cx1 - cx0) * (cy1 - cy0) > 40000) return -1;
    for (let gy = cy0; gy <= cy1; gy++) for (let gx = cx0; gx <= cx1; gx++) {
      const c = gx + gy * G.gw;
      for (let k = G.cellStart[c]; k < G.cellStart[c + 1]; k++) {
        const i = G.cellItems[k];
        // bigger dots are easier to hit
        const d = Math.hypot(G.xy[i * 2] - wx, G.xy[i * 2 + 1] - wy) - (G.meta[i * 2 + 1] / 400) * rad;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return bd < rad ? best : -1;
  }
  function bindInput() {
    const pts = new Map();
    let start = null, pinch = null, moved = false, pinched = false, samples = [];
    lab.addEventListener("pointerdown", (e) => {
      try { lab.setPointerCapture(e.pointerId); } catch (err) {}
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (anim && anim.done) anim.done();
      anim = null;
      if (glide) { glide = null; if (onInteract) onInteract(false); } // a touch catches the sliding map
      if (pts.size === 1) { samples = []; pinched = false; }
      if (focus && focus.tracing) { traceToken++; const i = focus.idx; RM.focus(chainEnd(i), { fly: false }); }
      if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, t: performance.now() }; moved = false; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: cam.s, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w: toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
        if (!moved && onInteract) onInteract(true);
        moved = true;
      }
    });
    lab.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size >= 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        pinched = true;
        cam.s = Math.max(0.05, Math.min(80, pinch.s * d / pinch.d));
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const w = toWorld(mid[0], mid[1]);
        cam.x += pinch.w[0] - w[0]; cam.y += pinch.w[1] - w[1];
        dirty = true;
      } else if (start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) { if (!moved && onInteract) onInteract(true); moved = true; }
        cam.x = start.cx - dx / cam.s; cam.y = start.cy - dy / cam.s;
        const now = performance.now(); samples.push([now, e.clientX, e.clientY]);
        while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
        dirty = true;
      }
    });
    const up = (e) => {
      const was = pts.has(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0 && moved) {
        // a flick: carry on in that direction at the release speed, then ease to a stop
        const now = performance.now(), last = samples[samples.length - 1], first = samples[0];
        let v = null;
        if (!pinched && last && first && last !== first && now - last[0] < 60) {
          const dt = Math.max(16, last[0] - first[0]);
          v = [(last[1] - first[1]) / dt, (last[2] - first[2]) / dt];
        }
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (v && Math.hypot(v[0], v[1]) > 0.3 && !reduce) { const cap = 4.5, sp = Math.hypot(v[0], v[1]), f = sp > cap ? cap / sp : 1; glide = { vx: v[0] * f, vy: v[1] * f, t: now }; dirty = true; }
        else if (onInteract) onInteract(false);
        samples = [];
      }
      if (pts.size === 1) { const [p] = [...pts.values()]; start = { x: p[0], y: p[1], cx: cam.x, cy: cam.y, t: performance.now() }; return; }
      if (was && start && !moved && performance.now() - start.t < 450 && e.type === "pointerup") {
        const r = lab.getBoundingClientRect();
        const i = pick(e.clientX - r.left, e.clientY - r.top);
        if (i >= 0 && onTap) onTap(i);
      }
      start = null;
    };
    lab.addEventListener("pointerup", up); lab.addEventListener("pointercancel", up);
    let wheelT = 0;
    lab.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (onInteract) { if (!wheelT) onInteract(true); clearTimeout(wheelT); wheelT = setTimeout(() => { wheelT = 0; onInteract(false); }, 450); }
      const r = lab.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const before = toWorld(px, py);
      cam.s = Math.max(0.05, Math.min(80, cam.s * Math.exp(-e.deltaY * 0.0016)));
      const after = toWorld(px, py);
      cam.x += before[0] - after[0]; cam.y += before[1] - after[1];
      anim = null; dirty = true;
    }, { passive: false });
    lab.addEventListener("dblclick", (e) => {
      const r = lab.getBoundingClientRect();
      const [wx, wy] = toWorld(e.clientX - r.left, e.clientY - r.top);
      flyTo(wx, wy, Math.min(80, cam.s * 2.2), 450);
    });
  }

  function resize() {
    const r = glc.parentElement.getBoundingClientRect();
    W = r.width; H = r.height;
    for (const c of [und, glc, lab].filter(Boolean)) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.width = W + "px"; c.style.height = H + "px"; }
    dirty = true;
  }

  // ---- focus ------------------------------------------------------------------------------
  function upAll(i) { const out = []; if (G.parent[i] >= 0) out.push(G.parent[i]); const c = G.crossUp.get(i); if (c) for (const p of c) out.push(p); return out; }
  function downAll(i) { const out = []; for (let k = G.kidStart[i]; k < G.kidStart[i + 1]; k++) out.push(G.kids[k]); const c = G.crossDown.get(i); if (c) for (const x of c) out.push(x); return out; }
  RM.lineage = function (i) { const out = []; let x = G.parent[i]; while (x >= 0 && out.length < 40) { out.push(x); x = G.parent[x]; } return out; };

  function buildFocus(idx, extra) {
    const lit = new Set([idx]); const order = [idx];
    const segs = [];
    const ink = LOOK.litRGB ? LOOK.litRGB.split(",").map((v) => v / 255) : isDark() ? [0.96, 0.92, 0.84] : [0.2, 0.16, 0.1];
    const add = (i) => { if (!lit.has(i)) { lit.add(i); order.push(i); } };
    // ancestors (every route), nearest first
    const q = [idx]; const seenA = new Set([idx]);
    while (q.length && seenA.size < 200) {
      const x = q.shift();
      for (const p of upAll(x)) {
        segs.push([x, p, ...(G.parent[x] === p ? ink : segRGB(p))]);
        if (!seenA.has(p)) { seenA.add(p); add(p); q.push(p); }
      }
    }
    // what grew out of it (one generation; more for ancestors)
    const kids = downAll(idx);
    const isWord = G.lang[idx] === 0;
    for (const k of kids.slice(0, isWord ? 60 : 120)) { segs.push([k, idx, ...segRGB(k)]); add(k); }
    if (!isWord) for (const k of kids.slice(0, 40)) for (const g of downAll(k).slice(0, 20)) { segs.push([g, k, ...segRGB(g)]); add(g); }
    if (extra) for (const e of extra) { segs.push([e[0], e[1], ...e[2]]); add(e[0]); add(e[1]); }
    let root = idx; while (G.parent[root] >= 0) root = G.parent[root];
    const L = dynLines(segs);
    const pts = order.map((i) => i);
    const pp = new Float32Array(pts.length * 2), pc = new Float32Array(pts.length * 3), ps = new Float32Array(pts.length);
    pts.forEach((i, k) => { pp[k * 2] = G.xy[i * 2]; pp[k * 2 + 1] = G.xy[i * 2 + 1]; const c = dotRGB(i); pc[k * 3] = c[0]; pc[k * 3 + 1] = c[1]; pc[k * 3 + 2] = c[2]; ps[k] = G.meta[i * 2 + 1] + (i === idx ? 60 : 0); });
    const geo = { bp: buf(L.p), bc: buf(L.c), n: L.n, pp: buf(pp), pc: buf(pc), ps: buf(ps), np: pts.length };
    return { idx, lit, order, geo, root };
  }

  // ---- tracing a line of descent (the search flight) -----------------------------
  // Frame the whole lineage, light it one generation at a time from the oldest
  // ancestor down to the word, then settle on the word. Any touch skips ahead.
  let traceToken = 0;
  function pathFocus(list) {
    const ink = LOOK.litRGB ? LOOK.litRGB.split(",").map((v) => v / 255) : isDark() ? [0.96, 0.92, 0.84] : [0.2, 0.16, 0.1];
    const segs = [];
    for (let k = 1; k < list.length; k++) segs.push([list[k], list[k - 1], ...ink]);
    const head = list[list.length - 1];
    const L = dynLines(segs);
    const pp = new Float32Array(list.length * 2), pc = new Float32Array(list.length * 3), ps = new Float32Array(list.length);
    list.forEach((i, k) => { pp[k * 2] = G.xy[i * 2]; pp[k * 2 + 1] = G.xy[i * 2 + 1]; const c = dotRGB(i); pc[k * 3] = c[0]; pc[k * 3 + 1] = c[1]; pc[k * 3 + 2] = c[2]; ps[k] = G.meta[i * 2 + 1] + (i === head ? 60 : 20); });
    const order = list.slice().reverse();
    return { idx: head, lit: new Set(list), order, root: list[0], geo: { bp: buf(L.p), bc: buf(L.c), n: L.n, pp: buf(pp), pc: buf(pc), ps: buf(ps), np: list.length }, tracing: true };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  RM.trace = async function (idx, opts) {
    if (!G || idx < 0) return;
    const onStep = opts && opts.onStep;
    const my = ++traceToken;
    traceTarget = idx;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const chain = [idx].concat(RM.lineage(idx)).slice(0, 9).reverse(); // oldest … word
    if (reduce || chain.length < 3) return RM.focus(idx, { fly: true, fromTrace: true });
    // 1) frame the lineage
    focus = pathFocus(chain.slice(0, 1));
    RM.fit(chain, 950);
    await new Promise((r) => { const f = () => (!anim || my !== traceToken ? r() : setTimeout(f, 30)); f(); });
    // 2) light it generation by generation, slowly enough to read what happened at each step
    const step = (opts && opts.step) || 1300;
    for (let k = 1; k <= chain.length; k++) {
      if (my !== traceToken) return;
      focus = pathFocus(chain.slice(0, k));
      dirty = true;
      if (onStep) onStep({ i: chain[k - 1], parent: k > 1 ? chain[k - 2] : -1, k, n: chain.length });
      await sleep(k === 1 ? step * 0.8 : step);
    }
    if (my !== traceToken) return;
    // 3) settle on the word with its full neighbourhood lit
    await sleep(120);
    if (my !== traceToken) return;
    traceTarget = -1;
    if (onStep) onStep(null);
    return RM.focus(idx, { fly: true, dur: 900, fromTrace: true });
  };
  RM.cancelTrace = function () { traceToken++; };
  RM.traceLength = function (idx) { return G && idx >= 0 ? Math.min(9, 1 + RM.lineage(idx).length) : 0; };
  RM.setOptions = function (o) { Object.assign(OPT, o || {}); dirty = true; };

  // ---- public ------------------------------------------------------------------------------
  RM.init = function (el, opts) {
    onTap = opts && opts.onTap;
    onDraw = opts && opts.onDraw;
    onInteract = opts && opts.onInteract;
    und = document.createElement("canvas"); und.className = "map-under"; el.appendChild(und);
    glc = document.createElement("canvas"); glc.className = "map-gl";
    lab = document.createElement("canvas"); lab.className = "map-labels";
    el.appendChild(glc); el.appendChild(lab);
    gl = glc.getContext("webgl", { antialias: true, premultipliedAlpha: true, alpha: true });
    ctx = lab.getContext("2d");
    if (!gl) { el.classList.add("map-nogl"); return; }
    P_PT = prog(VS_PT, FS_PT); P_LN = prog(VS_LN, FS_LN);
    resize();
    window.addEventListener("resize", resize);
    bindInput();
    load().then(() => {
      buildBuffers();
      cam.s = fitScale(); cam.x = 0; cam.y = 0;
      requestAnimationFrame(frame);
      const rebuild = () => { buildBuffers(); if (focus) focus = buildFocus(focus.idx, focus.extra); dirty = true; };
      new MutationObserver(rebuild).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rebuild);
      readyResolve(RM);
      if (opts && opts.onReady) opts.onReady();
    }).catch((err) => { el.classList.add("map-failed"); console.error(err); });
  };
  RM.find = function (w) { if (!G) return -1; const i = G.word.get(w); if (i != null) return i; const j = G.wordLC.get(String(w).toLowerCase()); return j == null ? -1 : j; };
  RM.setInsets = function (o) { Object.assign(insets, o); dirty = true; };
  RM.focus = function (idx, o) {
    if (!G || idx < 0) return Promise.resolve();
    if (!(o && o.fromTrace)) { traceToken++; traceTarget = -1; } // a plain focus supersedes a running trace
    focus = buildFocus(idx, null);
    focus.extra = null;
    if ((!o || o.fly !== false) && LOOK.plate && plate) {
      const t = G.treeOf.get(focus.root);
      if (t) {
        const d = Math.hypot(G.xy[idx * 2] - t.x, G.xy[idx * 2 + 1] - t.y);
        const s = Math.max(0.3, Math.min(40, (Math.min(plate.rx, plate.ry) * 0.8) / Math.max(d, t.R * 0.35)));
        const x = t.x - (plate.x - W / 2) / s, y = t.y - (plate.y - H / 2) / s - (insets.bottom - insets.top) / 2 / s;
        dirty = true;
        return flyTo(x, y, s, o && o.dur);
      }
    }
    if (!o || o.fly !== false) {
      // frame the node with its lineage: zoom so the nearest ancestors fit
      const anc = RM.lineage(idx).slice(0, 4);
      let span = 6;
      for (const a of anc) span = Math.max(span, Math.hypot(G.xy[a * 2] - G.xy[idx * 2], G.xy[a * 2 + 1] - G.xy[idx * 2 + 1]));
      const avail = Math.min(W, H - insets.top - insets.bottom);
      const s = Math.max(1.2, Math.min(28, (avail * 0.42) / span));
      dirty = true;
      return flyTo(G.xy[idx * 2], G.xy[idx * 2 + 1], s, o && o.dur);
    }
    dirty = true;
    return Promise.resolve();
  };
  let traceTarget = -1;
  function chainEnd(i) { return traceTarget >= 0 ? traceTarget : i; }
  RM.loaded = function () { return !!(G && B.pos); };
  RM.setExtra = function (pairs) { // [[a, b, [r,g,b]]…] drawn with the focus (lens overlays)
    if (!focus) return;
    focus = buildFocus(focus.idx, pairs);
    focus.extra = pairs;
    dirty = true;
  };
  RM.fit = function (idxs, dur) { // frame a set of nodes
    if (!G || !idxs.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of idxs) { const x = G.xy[i * 2], y = G.xy[i * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const availH = H - insets.top - insets.bottom;
    const s = Math.max(0.08, Math.min(28, Math.min(W / Math.max(8, x1 - x0), availH / Math.max(8, y1 - y0)) * 0.78));
    flyTo((x0 + x1) / 2, (y0 + y1) / 2, s, dur);
  };
  // step-out framing: a node's family (radial tree around its deepest
  // ancestor), then its region (language group)
  RM.frameFamily = function (i) {
    if (!G || i < 0) return Promise.resolve();
    let r = i; while (G.parent[r] >= 0) r = G.parent[r];
    const t = G.treeOfRoot.get(r);
    const availH = H - insets.top - insets.bottom;
    if (t) return flyTo(t.x, t.y, Math.max(0.08, Math.min(40, Math.min(W, availH) / (2 * t.R) * 0.92)), 800);
    const pts = [r]; const q = [r];
    while (q.length && pts.length < 400) { const x = q.shift(); for (let k = G.kidStart[x]; k < G.kidStart[x + 1]; k++) { pts.push(G.kids[k]); q.push(G.kids[k]); } }
    RM.fit(pts, 800); return new Promise((res) => setTimeout(res, 820));
  };
  RM.frameRegion = function (i) {
    if (!G || i < 0) return Promise.resolve();
    const x = G.xy[i * 2], y = G.xy[i * 2 + 1];
    let best = null, bd = Infinity;
    for (const R of G.info.regions) { const d = Math.hypot(R.x - x, R.y - y) / R.r; if (d < bd) { bd = d; best = R; } }
    if (!best || bd > 1.2) return RM.overview();
    const availH = H - insets.top - insets.bottom;
    return flyTo(best.x, best.y, Math.min(W, availH) / (2 * best.r) * 0.95, 850);
  };
  RM.setGlobal = function (pairs) { // [[a, b, [r,g,b]]…] or null
    globalPairs = pairs;
    if (!G || !pairs || !pairs.length) { globalGeo = null; dirty = true; return; }
    const L = dynLines(pairs.map((p) => [p[0], p[1], ...p[2]]));
    globalGeo = { bp: buf(L.p), bc: buf(L.c), n: L.n };
    dirty = true;
  };
  RM.xy = function (i) { return [G.xy[i * 2], G.xy[i * 2 + 1]]; };
  RM.clearFocus = function () { focus = null; dirty = true; };
  RM.overview = function () { if (!G) return Promise.resolve(); focus = null; return flyTo(0, 0, fitScale(), 900); };
  RM.info = function (i) {
    if (!G || i < 0) return null;
    return { idx: i, label: G.labels[i], lang: G.info.langs[G.lang[i]], family: G.info.families[G.meta[i * 2]], fam: G.meta[i * 2],
      year: G.info.eras[G.lang[i]], parent: G.parent[i], isWord: G.lang[i] === 0, size: G.meta[i * 2 + 1] };
  };
  RM.colorOf = function (fam) { return (LOOK.pal || (isDark() ? DARK : LIGHT))[fam]; };
  RM.setTrail = function (list) { trail = list && list.slice(); visited.clear(); (trail || []).forEach((i) => visited.add(i)); dirty = true; };
  RM.setMarks = function (list) { marks = list && list.length ? list.slice() : null; dirty = true; };
  // the planisphere's window (screen px): {x, y, rx, ry}; show(false) lifts the plate while you explore
  RM.setPlate = function (p) { if (p) plate = p; plateWant = p ? 1 : 0; dirty = true; };
  RM._plate = function () { return { plate, plateA, plateWant, look: LOOK && LOOK.plate }; };
  RM.showPlate = function (on) { plateWant = on && plate ? 1 : 0; dirty = true; };
  RM.lookNames = function () { return Object.keys(LOOKS); };
  RM.setLook = function (name) {
    LOOK = LOOKS[name] || LOOKS.planisphere; drawUnder.pat = null;
    if (!LOOK.plate) plateWant = 0;
    if (G && B.pos) { buildBuffers(); if (focus) focus = buildFocus(focus.idx, focus.extra); }
    dirty = true;
  };
  RM.ping = function (i) { ping = i == null ? -1 : i; dirty = true; };
  RM.starts = function () { return G ? G.info.starts || [] : []; };
  RM.families = function () { return G ? G.info.families : []; };
  RM.details = function (i) {
    const c = Math.floor(i / G.info.chunk);
    if (!G.chunks.has(c)) {
      G.chunkData = G.chunkData || new Map();
      G.chunks.set(c, fetch("graph/n/" + c + ".json?v=" + V).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((m) => { G.chunkData.set(c, m); return m; }));
    }
    return G.chunks.get(c).then((m) => m[i] || {});
  };
  // where a node sits on screen right now (CSS px inside the map), for the callout
  RM.screenOf = function (i) {
    if (!G || i < 0) return null;
    const ctr = [cam.x, cam.y + (insets.bottom - insets.top) / 2 / cam.s];
    return [(G.xy[i * 2] - ctr[0]) * cam.s + W / 2, (G.xy[i * 2 + 1] - ctr[1]) * cam.s + H / 2];
  };
  RM.scale = function () { return cam.s; };
  RM.focusIdx = function () { return focus ? focus.idx : -1; };
  RM.moving = function () { return !!anim || !!glide; };
  RM.children = function (i) { return downAll(i); };
  RM.parents = function (i) { return upAll(i); };
  window.RootMap = RM;
})();
