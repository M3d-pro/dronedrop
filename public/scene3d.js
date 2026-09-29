'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop v0.2 — Cena 3D (Three.js)
   • Visualizador urbano imersivo (Sky Visualizer) com rotas, nós e drones vivos
   • Visualizador de modelo de drone rotacionável com estado de bateria
   ============================================================================ */
const Scene = (() => {
  let renderer, scene, camera, canvas, raf = null, clock;
  let groups = { city: null, routes: null, nodes: null, drones: null, zones: null, grid: null };
  let cam = { yaw: -0.75, pitch: -0.62, dist: 420, tx: 0, tz: 0, orbit: false };
  let project = null, data = null, opacity = 0.6, drag = null;
  let droneObjs = {}, routeLines = {}, droneById = {};
  let viewer = null;

  const C = { cyan: 0x0ea5e9, mint: 0x10b981, sun: 0xf59e0b, rose: 0xf43f5e, grape: 0xa855f7, slate: 0x93b4d8, ink: 0x0f2544 };

  /* --------------------------------------------------------------- helpers */
  const group = (name) => { const g = new THREE.Group(); g.name = name; scene.add(g); return g; };
  const clearGroup = (g) => { if (!g) return; while (g.children.length) { const c = g.children.pop(); c.geometry?.dispose?.(); c.material?.dispose?.(); } };

  // projeção lat/lon -> plano local (metros aprox.), centrada no projeto
  let origin = { lat: -23.5505, lon: -46.6333 };
  const P = () => ({
    x: (lon, lat) => ((lon - origin.lon) * 111320 * Math.cos(origin.lat * Math.PI / 180)),
    z: (lat) => -((lat - origin.lat) * 110540)
  });

  function projectInit(p) {
    if (!p) return;
    origin = { lat: Number(p?.bbox?.split(',')[0]) || -23.5505, lon: Number(p?.bbox?.split(',')[1]) || -46.6333 };
    // usa o centroide aproximado do bbox quando disponível
    if (p.bbox) {
      const [a, b, c, d] = String(p.bbox).split(',').map(Number);
      if ([a, b, c, d].every((v) => !isNaN(v))) origin = { lat: (a + c) / 2, lon: (b + d) / 2 };
    }
  }

  /* ----------------------------------------------------------------- init */
  function init() {
    canvas = document.getElementById('gl');
    if (!canvas || typeof THREE === 'undefined') return;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xeaf5ff, 900, 2600);
    camera = new THREE.PerspectiveCamera(48, 1, 1, 6000);
    clock = new THREE.Clock();
    groups.grid = group('grid'); groups.city = group('city'); groups.zones = group('zones');
    groups.nodes = group('nodes'); groups.routes = group('routes'); groups.drones = group('drones');
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd6e8ff, 1.05); scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, .75); dir.position.set(240, 420, 180); scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x8ecbff, .35); dir2.position.set(-260, 200, -220); scene.add(dir2);
    buildGround();
    bind();
    resize();
    window.addEventListener('resize', resize);
    loop();
  }

  function buildGround() {
    const g = groups.grid;
    const geo = new THREE.PlaneGeometry(3000, 3000, 30, 30);
    const mat = new THREE.MeshBasicMaterial({ color: 0xdfeeff, transparent: true, opacity: .55, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat); mesh.rotation.x = -Math.PI / 2; mesh.position.y = -0.6; g.add(mesh);
    const grid = new THREE.GridHelper(3000, 60, 0x9cc6ee, 0xc9e2f8);
    grid.material.transparent = true; grid.material.opacity = .5; g.add(grid);
  }

  function resize() {
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth || 900, h = canvas.clientHeight || 600;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function bind() {
    canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, m: 0 }; });
    window.addEventListener('mouseup', () => { drag = null; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return; drag.m++;
      cam.yaw += (e.clientX - drag.x) * .006;
      cam.pitch = Math.max(-1.45, Math.min(-.10, cam.pitch + (e.clientY - drag.y) * .005));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.dist = Math.max(90, Math.min(1500, cam.dist * (1 + e.deltaY * .0011))); }, { passive: false });
  }

  /* ---------------------------------------------------------------- dados */
  function setProject(o) { project = o.project; }
  function setData(o) {
    data = o;
    if (!o) return;
    projectInit(o.project);
    buildCity(o);
    buildNodes(o);
    buildRoutes(o);
    buildDrones(o);
  }

  function buildCity(o) {
    const g = groups.city; clearGroup(g);
    const p = P();
    const zone = o.zones && o.zones[0];
    const seedRand = (n) => { let x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const nodes = o.nodes || [];
    // malha urbana: torres em grade, mais altas no centro; respeita limites de zona (altura)
    const limit = zone ? Math.min(260, zone.height_limit * 1.4) : 200;
    for (let i = -13; i <= 13; i++) {
      for (let j = -13; j <= 13; j++) {
        const r = seedRand(i * 31 + j * 7);
        if (r < .30) continue;
        const near = nodes.some((n) => Math.abs(p.x(n.lon, n.lat) - i * 34) < 40 && Math.abs(p.z(n.lat) - j * 34) < 40);
        const d = Math.hypot(i, j);
        const falloff = Math.max(.12, 1 - d / 15);
        let h = (28 + r * 190) * falloff;
        if (near) h = Math.min(h, 34);
        h = Math.min(h, limit);
        const w = 16 + r * 16;
        const mat = new THREE.MeshPhongMaterial({
          color: new THREE.Color().setHSL(.58 - r * .05, .55, .74 + r * .12),
          emissive: new THREE.Color(0x0ea5e9), emissiveIntensity: .04, transparent: true, opacity: .92, shininess: 12
        });
        const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
        box.position.set(i * 34, h / 2, j * 34);
        g.add(box);
        // coroas (rooftop pads) próximos de nós
        if (near && r > .55) {
          const pad = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 2, 16), new THREE.MeshPhongMaterial({ color: C.mint, emissive: C.mint, emissiveIntensity: .25 }));
          pad.position.set(i * 34, h + 2, j * 34); g.add(pad);
        }
      }
    }
  }

  function buildNodes(o) {
    const g = groups.nodes; clearGroup(g); groups.zones.remove && clearGroup(groups.zones);
    clearGroup(groups.zones);
    const p = P();
    (o.nodes || []).forEach((n) => {
      const x = p.x(n.lon, n.lat), z = p.z(n.lat);
      const col = n.kind === 'depot' ? C.grape : n.kind === 'entry' ? C.sun : n.kind === 'rooftop' ? C.cyan : n.kind === 'micro' ? C.mint : 0x7dd3fc;
      const h = n.kind === 'depot' ? 120 : n.elev_m + 26;
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, h, 10), new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: col, emissiveIntensity: .18, transparent: true, opacity: .85 }));
      tower.position.set(x, h / 2, z); g.add(tower);
      const head = new THREE.Mesh(new THREE.SphereGeometry(9, 18, 14), new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: .55 }));
      head.position.set(x, h + 6, z); g.add(head);
      // anel de recarga pulsante
      if (n.is_recharge) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(13, 17, 32), new THREE.MeshBasicMaterial({ color: C.mint, transparent: true, opacity: .5, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.set(x, h + 2, z); g.add(ring);
      }
      // pilha de ocupação (slots)
      const load = Math.min(1, (n.occupancy || 0) / Math.max(1, n.capacity_slots));
      if (load > 0) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(10, 4 + load * 22, 10), new THREE.MeshPhongMaterial({ color: C.sun, transparent: true, opacity: .8 }));
        box.position.set(x + 16, (4 + load * 22) / 2, z + 10); g.add(box);
      }
    });
    // zonas de espaço aéreo (volumes)
    (o.zones || []).slice(0, 4).forEach((zn, i) => {
      const color = zn.type === 'Restricted' ? C.sun : zn.type.includes('Rescue') ? C.rose : C.cyan;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(320 - i * 30, zn.height_limit, 300 - i * 25),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .07, side: THREE.DoubleSide })
      );
      box.position.set(i * 40 - 60, zn.height_limit / 2, i * 30 - 40);
      groups.zones.add(box);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: .5 }));
      edges.position.copy(box.position); groups.zones.add(edges);
    });
  }

  function buildRoutes(o) {
    const g = groups.routes; clearGroup(g); routeLines = {};
    const p = P();
    const nById = Object.fromEntries((o.nodes || []).map((n) => [n.node_id, n]));
    (o.missions || []).slice(0, 24).forEach((m) => {
      let plan = {}; try { plan = JSON.parse(m.route_json); } catch { }
      const legs = plan.legs || []; if (!legs.length) return;
      const active = ['in_flight', 'charging', 'rerouted'].includes(m.status);
      const pts = [];
      legs.forEach((l) => {
        const a = nById[l.from], b = nById[l.to]; if (!a || !b) return;
        pts.push(new THREE.Vector3(p.x(a.lon, a.lat), 60 + (a.elev_m || 0), p.z(a.lat)));
        pts.push(new THREE.Vector3(p.x(b.lon, b.lat), 60 + (b.elev_m || 0), p.z(b.lat)));
      });
      if (pts.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(120));
      const isDiv = m.status === 'rerouted';
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: isDiv ? C.rose : active ? C.cyan : 0x9ec9ec, transparent: true, opacity: active ? .95 : .35
      }));
      g.add(line); routeLines[m.mission_id] = line;
    });
  }

  function buildDrones(o) {
    const g = groups.drones; clearGroup(g); droneObjs = {}; droneById = {};
    (o.fleet || []).forEach((d) => { droneById[d.drone_id] = d; addDrone(d); });
  }

  function addDrone(d) {
    if (!d || d.lat == null) return;
    const p = P();
    const col = d.status === 'in_flight' ? C.grape : d.status === 'charging' ? C.sun : d.status === 'maintenance' ? C.rose : C.cyan;
    const obj = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 12), new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: col, emissiveIntensity: .3 }));
    obj.add(body);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(22, 1.4, 2), new THREE.MeshPhongMaterial({ color: 0xdfeaff }));
    obj.add(bar);
    const bar2 = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 22), new THREE.MeshPhongMaterial({ color: 0xdfeaff }));
    obj.add(bar2);
    [-11, -4, 4, 11].forEach((ox) => [-10, 10].forEach((oz) => {
      const rot = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.4, .6, 12), new THREE.MeshPhongMaterial({ color: col, transparent: true, opacity: .45 }));
      rot.position.set(ox, 1.6, oz); obj.add(rot);
    }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(17, 18, 14), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .09 }));
    obj.add(halo);
    obj.position.set(p.x(d.lon, d.lat), 66 + (d.alt_m || 0), p.z(d.lat));
    obj.userData = { drone_id: d.drone_id, rotors: obj.children.filter((c) => c.geometry?.type === 'CylinderGeometry') };
    groups.drones.add(obj); droneObjs[d.drone_id] = obj;
  }

  function updateLive(live, tri) {
    if (!groups.drones) return;
    const p = P();
    (live || []).filter(Boolean).forEach((m) => {
      const t = m.position;
      if (m.position) {
        // usa o drone da missão quando identificável; senão posiciona o primeiro livre
        const key = Object.keys(droneObjs).find((k) => !m.drone_id || k === m.drone_id) || Object.keys(droneObjs)[0];
        const obj = droneObjs[key];
        if (obj) {
          obj.position.set(p.x(t.lon, t.lat), 66 + (t.alt_m || 0), p.z(t.lat));
          obj.rotation.y = -((t.heading || 0) * Math.PI / 180);
        }
      }
      const line = routeLines[m.mission_id];
      if (line && m.phase) line.material.opacity = m.phase === 'charging' ? .5 : 1;
      if (m.phase === 'charging' && m.to) {
        const key = Object.keys(droneObjs).find((k) => !m.drone_id || k === m.drone_id) || Object.keys(droneObjs)[0];
        const obj = droneObjs[key];
        obj && obj.position.set(p.x(m.to.lon, m.to.lat), m.to.elev_m + 12, p.z(m.to.lat));
      }
    });
  }

  /* ------------------------------------------------------------- animação */
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!renderer) return;
    const dt = clock.getDelta(), t = clock.elapsedTime;
    if (cam.orbit) cam.yaw += dt * .14;
    Object.entries(droneObjs).forEach(([id, o], i) => {
      o.userData.rotors?.forEach((r, k) => { r.rotation.y += dt * (14 + (i % 3) * 2); });
      o.position.y += Math.sin(t * 1.6 + i) * .12;
      o.children[o.children.length - 1].scale.setScalar(1 + Math.sin(t * 2 + i) * .04);
    });
    groups.nodes.children.forEach((c, i) => { if (c.geometry?.type === 'RingGeometry') { c.scale.setScalar(1 + Math.sin(t * 2 + i * .3) * .1); c.material.opacity = .35 + Math.sin(t * 2 + i) * .15; } });
    if (groups.zones) groups.zones.children.forEach((c) => { if (c.material) c.material.opacity = c.material.opacity > .05 ? c.material.opacity : .06; });
    draw();
  }

  function draw() {
    const cx = cam.tx, cz = cam.tz;
    const d = cam.dist;
    const px = cx + d * Math.cos(cam.pitch) * Math.sin(cam.yaw);
    const pz = cz + d * Math.cos(cam.pitch) * Math.cos(cam.yaw);
    const py = -d * Math.sin(cam.pitch) * 1.15 + 60;
    camera.position.set(px, py, pz);
    camera.lookAt(cx, 40, cz);
    renderer.render(scene, camera);
  }

  function reset() { cam = { yaw: -0.75, pitch: -0.62, dist: 420, tx: 0, tz: 0, orbit: false }; }
  function autoOrbit() { cam.orbit = !cam.orbit; }
  function togglePitch() { cam.pitch = cam.pitch < -1.2 ? -0.55 : -1.4; }
  function setOpacity(v) {
    opacity = v;
    [groups.city, groups.zones].forEach((g) => g && g.children.forEach((c) => { if (c.material && 'opacity' in c.material) c.material.opacity = c.material.userData?.base ?? (opacity * (c.geometry?.type === 'BoxGeometry' ? .16 : .95)); }));
  }
  function focusDrone(id) {
    const o = droneObjs[id]; if (!o) return;
    cam.tx = o.position.x; cam.tz = o.position.z; cam.dist = Math.min(cam.dist, 260);
  }
  function focusMission(id) { const l = routeLines[id]; if (l) { const g = l.geometry.attributes.position; cam.tx = g.getX(0); cam.tz = g.getZ(0); } }
  function snapshot() {
    const a = document.createElement('a');
    a.href = renderer.domElement.toDataURL('image/png');
    a.download = 'skym3d-visualizer.png'; a.click();
    App.toast('Captura do visualizador salva em PNG', 'ok');
  }

  /* ------------------------------------------- visualizador do modelo 3D */
  function droneViewer(el, drone) {
    if (!el || typeof THREE === 'undefined') return;
    const g = drone.geom || {};
    const w = el.clientWidth || 420, h = el.clientHeight || 300;
    const r = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true });
    el.width = w; el.height = h;
    r.setSize(w, h, false); r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    const sc = new THREE.Scene();
    const cam2 = new THREE.PerspectiveCamera(42, w / h, .1, 2000);
    sc.add(new THREE.HemisphereLight(0xffffff, 0xdcecff, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, .8); dl.position.set(60, 90, 50); sc.add(dl);
    const dl2 = new THREE.DirectionalLight(0x8ecbff, .4); dl2.position.set(-60, 40, -50); sc.add(dl2);
    const cg = new THREE.Group(); sc.add(cg);
    const color = new THREE.Color(g.color || '#0ea5e9'), livery = new THREE.Color(g.livery || '#ffffff');
    const prop = g.prop || drone.rotors || 4;
    const bodyW = g.bodyW || 34, bodyH = g.bodyH || 12, bodyL = g.bodyL || 46, armLen = g.armLen || 44, rotorR = g.rotorR || 20;
    // corpo
    const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyL), new THREE.MeshPhongMaterial({ color: livery, shininess: 60, transparent: true, opacity: .97 }));
    cg.add(body);
    // carenagem superior
    const shell = new THREE.Mesh(new THREE.SphereGeometry(bodyW * .46, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhongMaterial({ color, shininess: 70 }));
    shell.position.y = bodyH / 2; shell.scale.set(1, .72, 1.22); cg.add(shell);
    // braços + rotores (distribuição radial conforme nº de rotores)
    for (let i = 0; i < prop; i++) {
      const ang = (i / prop) * Math.PI * 2 + Math.PI / 4;
      const ax = Math.cos(ang) * armLen, az = Math.sin(ang) * armLen;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, Math.hypot(ax, az), 10), new THREE.MeshPhongMaterial({ color: 0xdfeaff }));
      arm.position.set(ax / 2, 0, az / 2);
      arm.rotation.z = Math.PI / 2; arm.rotation.y = -ang; cg.add(arm);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 6, 14), new THREE.MeshPhongMaterial({ color, shininess: 50 }));
      motor.position.set(ax, 2, az); cg.add(motor);
      const rotor = new THREE.Mesh(new THREE.BoxGeometry(rotorR * 2, .6, 2.6), new THREE.MeshPhongMaterial({ color: 0x9fd8ff, transparent: true, opacity: .55 }));
      rotor.position.set(ax, 6, az); cg.add(rotor);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rotorR, .7, 8, 26), new THREE.MeshPhongMaterial({ color: 0xc7e3fb }));
      ring.rotation.x = Math.PI / 2; ring.position.set(ax, 5.2, az); cg.add(ring);
    }
    // asa (VTOL)
    if (g.wing) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 2.4, 2.6, bodyL * .5), new THREE.MeshPhongMaterial({ color: livery }));
      wing.position.set(0, 2, -bodyL * .1); cg.add(wing);
    }
    // trem / carga + indicador de bateria
    const legs = [-1, 1].forEach ? [-1, 1] : [];
    [-1, 1].forEach((s) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 14, 8), new THREE.MeshPhongMaterial({ color: 0xcfdff3 }));
      leg.position.set(s * bodyW * .3, -bodyH / 2 - 6, 0); cg.add(leg);
    });
    const bat = drone.battery ?? 100;
    const batCol = bat > 55 ? 0x10b981 : bat > 28 ? 0xf59e0b : 0xf43f5e;
    const pct = Math.max(.04, bat / 100);
    const bbox = new THREE.Mesh(new THREE.BoxGeometry(bodyW * .8, 8, bodyL * .36), new THREE.MeshPhongMaterial({ color: batCol, emissive: batCol, emissiveIntensity: .35 }));
    bbox.position.set(0, -bodyH / 2 - 12, 0); cg.add(bbox);
    const bin = new THREE.Mesh(new THREE.BoxGeometry(bodyW * .8, 8, bodyL * .36 * pct), new THREE.MeshBasicMaterial({ color: batCol, transparent: true, opacity: .95 }));
    bin.position.copy(bbox.position); bin.position.z -= (bodyL * .36 * (1 - pct)) / 2; cg.add(bin);
    // base
    const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.max(armLen * 1.5, 60), 40), new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: .07 }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -26; cg.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(armLen * 1.4, 56), .8, 8, 60), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .3 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = -26; cg.add(ring);
    let sp = { yaw: .7, pitch: .42, dist: Math.max(armLen * 3.6, 190) }, dg = null;
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', (e) => { dg = { x: e.clientX, y: e.clientY }; el.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', () => { dg = null; el.style.cursor = 'grab'; });
    el.addEventListener('mousemove', (e) => {
      if (!dg) return;
      sp.yaw += (e.clientX - dg.x) * .008;
      sp.pitch = Math.max(-.2, Math.min(1.35, sp.pitch + (e.clientY - dg.y) * .006));
      dg.x = e.clientX; dg.y = e.clientY;
    });
    el.addEventListener('wheel', (e) => { e.preventDefault(); sp.dist = Math.max(90, Math.min(560, sp.dist * (1 + e.deltaY * .0014))); }, { passive: false });
    let alive = true;
    (function spin() {
      if (!alive || !el.isConnected) { alive = false; r.dispose(); return; }
      const t = performance.now() / 1000;
      cg.children.forEach((c) => { if (c.geometry?.type === 'BoxGeometry' && c.material?.transparent && c.material.opacity < .7) c.rotation.y += .25; });
      cg.rotation.y = 0;
      cg.position.y = Math.sin(t * 1.6) * 2.2;
      cam2.position.set(sp.dist * Math.cos(sp.pitch) * Math.sin(sp.yaw), sp.dist * Math.sin(sp.pitch), sp.dist * Math.cos(sp.pitch) * Math.cos(sp.yaw));
      cam2.lookAt(0, 0, 0);
      r.render(sc, cam2);
      requestAnimationFrame(spin);
    })();
  }

  return { init, setData, setProject, updateLive, reset, autoOrbit, togglePitch, setOpacity, focusDrone, focusMission, snapshot, droneViewer, resize };
})();
