'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop v0.2 — Servidor (autoinstalação + banco dinâmico)
   Executar:  npm install  &&  npm start
   Acesso:    http://localhost:3333
   ============================================================================ */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const D = require('./db');
const { Sim, haversineKm } = require('./sim');

const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ banco */
const db = D.openDb();
let bootInfo = null;

function ensureInstalled(force = false) {
  const installed = D.isInstalled(db);
  if (!installed || force) {
    console.log('\n=== sky.m3d.pro · AUTOINSTALAÇÃO (banco dinâmico) ===');
    bootInfo = D.install(db, { force });
    console.log(`  schema ${bootInfo.schema_version} · banco ${bootInfo.db_file}`);
    console.log('=== instalação concluída ===\n');
  } else {
    const v = D.meta(db, 'schema_version');
    if (v !== D.SCHEMA_VERSION) {
      console.log(`[db] migração de schema ${v} → ${D.SCHEMA_VERSION}`);
      bootInfo = D.install(db, { force: false });
    } else {
      console.log(`[db] banco existente pronto (schema ${v}) · ${D.meta(db, 'installed_at')}`);
    }
  }
  D.meta(db, 'last_boot', new Date().toISOString());
  return D.isInstalled(db);
}
ensureInstalled(false);

/* -------------------------------------------------------------- eventos/ws */
const busList = new Set();
const sim = new Sim(db, {
  bus: (msg) => { for (const ws of busList) { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } } },
  log: (level, actor, message) => db.prepare('INSERT INTO event_log VALUES(?,?,?,?,?)').run(D.uid('log'), new Date().toISOString(), level, actor, message)
});

/* ---------------------------------------------------------------- helpers */
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/downloads', express.static(path.join(__dirname, '..', 'data')));

const SECRET = () => D.meta(db, 'jwt_secret');
function sign(user) {
  return jwt.sign({ sub: user.user_id, role: user.role, name: user.name, email: user.email }, SECRET(), { expiresIn: '12h' });
}
function auth(required = true) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    if (!t) { if (required) return res.status(401).json({ error: 'token ausente' }); return next(); }
    try { req.user = jwt.verify(t, SECRET()); next(); }
    catch { if (required) return res.status(401).json({ error: 'token inválido' }); return next(); }
  };
}
function perm(...perms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'autenticação necessária' });
    if (req.user.role === 'admin') return next();
    const u = db.prepare('SELECT permissions FROM users WHERE user_id=?').get(req.user.sub);
    const held = u ? JSON.parse(u.permissions || '[]') : [];
    if (perms.some((p) => held.includes(p))) return next();
    return res.status(403).json({ error: 'permissão insuficiente', required: perms });
  };
}
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const J = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/* =============================== INSTALAÇÃO ============================== */
app.get('/api/health', (req, res) => res.json({
  ok: true, app: 'sky.m3d.pro · droneDrop', version: D.SCHEMA_VERSION, ts: new Date().toISOString(),
  installed: D.isInstalled(db), autoconfig: D.meta(db, 'autoconfig'), dynamic_db: 'ACTIVE'
}));

app.get('/api/installer/status', (req, res) => res.json({
  installed: D.isInstalled(db), schema_version: D.meta(db, 'schema_version'),
  expected_schema: D.SCHEMA_VERSION, installed_at: D.meta(db, 'installed_at'), last_boot: D.meta(db, 'last_boot'),
  db_file: D.DB_FILE, db_size_kb: fs.existsSync(D.DB_FILE) ? Math.round(fs.statSync(D.DB_FILE).size / 1024) : 0,
  autoconfig: D.meta(db, 'autoconfig'),
  tables: all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name),
  counts: Object.fromEntries(all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .map(({ name }) => [name, one(`SELECT COUNT(*) c FROM "${name}"`).c])),
  boot: bootInfo
}));
app.get('/api/installer/steps', (req, res) => res.json(all('SELECT * FROM install_log ORDER BY ts DESC LIMIT 60')));
app.post('/api/installer/run', auth(), perm('database.install'), (req, res) => {
  const force = !!req.body.force;
  const info = D.install(db, { force });
  D.meta(db, 'last_boot', new Date().toISOString());
  bootInfo = info;
  res.json({ ok: true, ...info });
});
app.get('/api/installer/schema.sql', (req, res) => res.type('text/plain').send(D.SCHEMA));
app.get('/api/installer/db.sqlite', (req, res) => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  res.download(D.DB_FILE, 'skym3d.sqlite');
});

/* ================================== AUTH ================================ */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = String(email || '').trim().toLowerCase();
  const u = one('SELECT * FROM users WHERE lower(email)=? OR lower(name)=?', key, key);
  if (!u || !bcrypt.compareSync(String(password || ''), u.pass_hash)) return res.status(401).json({ error: 'Credenciais inválidas' });
  run('UPDATE users SET last_login=? WHERE user_id=?', new Date().toISOString(), u.user_id);
  run('INSERT INTO event_log VALUES(?,?,?,?,?)', D.uid('log'), new Date().toISOString(), 'INFO', u.email, 'Sessão iniciada');
  res.json({ token: sign(u), user: publicUser(u) });
});
const publicUser = (u) => ({
  user_id: u.user_id, name: u.name, email: u.email, role: u.role, org: u.org, plan: u.plan,
  on_duty: !!u.on_duty, permissions: J(u.permissions, [])
});
app.get('/api/auth/me', auth(), (req, res) => res.json(publicUser(one('SELECT * FROM users WHERE user_id=?', req.user.sub))));
app.get('/api/auth/demo', (req, res) => res.json(all("SELECT user_id,name,email,role,org,plan FROM users WHERE active=1").map((u) => ({ ...u, demo_password: 'sky2026' }))));

/* ============================== CATÁLOGOS =============================== */
app.get('/api/users', auth(), perm('users.manage'), (req, res) => res.json(all('SELECT user_id,name,email,role,org,phone,plan,permissions,on_duty,active FROM users ORDER BY created_at')));
app.post('/api/users', auth(), perm('users.manage'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) return res.status(400).json({ error: 'nome e e-mail obrigatórios' });
  const id = D.uid('usr');
  run(`INSERT INTO users(user_id,name,email,pass_hash,role,org,phone,plan,permissions,on_duty,active,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`, id, b.name, b.email.toLowerCase(), bcrypt.hashSync(b.password || 'sky2026', 8),
    b.role || 'sender', b.org || '', b.phone || '', b.plan || 'Pro', JSON.stringify(b.permissions || ['track.read']), b.on_duty ? 1 : 0, new Date().toISOString());
  res.json(publicUser(one('SELECT * FROM users WHERE user_id=?', id)));
});

app.get('/api/models', auth(false), (req, res) => res.json(all('SELECT * FROM drone_models ORDER BY payload_kg').map((m) => ({ ...m, geom: J(m.geom_json, {}) }))));
app.get('/api/models/:id', auth(false), (req, res) => {
  const m = one('SELECT * FROM drone_models WHERE model_id=? OR name=?', req.params.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'modelo não encontrado' });
  const drones = all('SELECT drone_id,model,battery,status,owner_id,battery_wh,health_pct FROM drones WHERE model_id=?', m.model_id);
  res.json({ ...m, geom: J(m.geom_json, {}), drones });
});

app.get('/api/nodes', auth(false), (req, res) => res.json(all(`SELECT n.*, u.name AS owner_name, (SELECT COUNT(*) FROM drones d WHERE d.node_id=n.node_id) AS drones_here
  FROM network_nodes n LEFT JOIN users u ON u.user_id=n.owner_id ORDER BY n.code`)));
app.post('/api/nodes', auth(), perm('nodes.manage'), (req, res) => {
  const b = req.body || {};
  const id = D.uid('nod');
  const n = Number(one('SELECT COUNT(*) c FROM network_nodes').c) + 1;
  run(`INSERT INTO network_nodes(node_id,project_id,code,name,kind,lat,lon,elev_m,pads,charger_kw,capacity_slots,occupancy,accepts_inbound,
       accepts_outbound,is_primary_entry,is_recharge,parent_node_id,status,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, b.project_id, b.code || `ND-${String(n).padStart(2, '0')}`, b.name || 'Novo ponto', b.kind || 'support',
    Number(b.lat), Number(b.lon), Number(b.elev_m || 0), Number(b.pads || 1), Number(b.charger_kw || 0), Number(b.capacity_slots || 10),
    0, b.accepts_inbound === false ? 0 : 1, b.accepts_outbound === false ? 0 : 1, b.is_primary_entry ? 1 : 0, b.is_recharge === false ? 0 : 1,
    b.parent_node_id || null, 'online', req.user.sub);
  res.json(one('SELECT * FROM network_nodes WHERE node_id=?', id));
});
app.patch('/api/nodes/:id', auth(), perm('nodes.manage', 'nodes.operate'), (req, res) => {
  const cur = one('SELECT * FROM network_nodes WHERE node_id=?', req.params.id);
  if (!cur) return res.status(404).json({ error: 'nó inexistente' });
  const b = { ...cur, ...req.body };
  run(`UPDATE network_nodes SET name=?,kind=?,status=?,pads=?,charger_kw=?,capacity_slots=?,occupancy=?,accepts_inbound=?,accepts_outbound=?,
       is_recharge=?,is_primary_entry=? WHERE node_id=?`, b.name, b.kind, b.status, Number(b.pads), Number(b.charger_kw), Number(b.capacity_slots),
    Number(b.occupancy), b.accepts_inbound ? 1 : 0, b.accepts_outbound ? 1 : 0, b.is_recharge ? 1 : 0, b.is_primary_entry ? 1 : 0, req.params.id);
  res.json(one('SELECT * FROM network_nodes WHERE node_id=?', req.params.id));
});

app.get('/api/zones', auth(false), (req, res) => res.json(all('SELECT * FROM airspace_zones ORDER BY height_limit DESC')));
app.get('/api/layers', auth(false), (req, res) => res.json(all('SELECT * FROM map_layers ORDER BY type')));
app.patch('/api/layers/:id', auth(), (req, res) => {
  const b = req.body || {};
  run('UPDATE map_layers SET visibility=COALESCE(?,visibility), opacity=COALESCE(?,opacity), updated_at=? WHERE layer_id=?',
    b.visibility === undefined ? null : (b.visibility ? 1 : 0), b.opacity === undefined ? null : Number(b.opacity), new Date().toISOString(), req.params.id);
  res.json(one('SELECT * FROM map_layers WHERE layer_id=?', req.params.id));
});

/* ================================ FROTA ================================= */
app.get('/api/fleet', auth(false), (req, res) => {
  const rows = all(`SELECT d.*, m.geom_json, m.brand, m.class AS mclass, m.rotors, m.reserve_pct AS model_reserve, m.dims_cm, m.weight_kg,
      u.name AS owner_name, u.role AS owner_role, n.code AS node_code, n.name AS node_name
    FROM drones d LEFT JOIN drone_models m ON m.model_id=d.model_id LEFT JOIN users u ON u.user_id=d.owner_id
    LEFT JOIN network_nodes n ON n.node_id=d.node_id ORDER BY d.model, d.created_at`);
  res.json(rows.map((r) => ({ ...r, geom: J(r.geom_json, {}), autonomy_km: r.range_km, load_pct: r.payload_kg_max ? Math.round((r.payload_kg_now / r.payload_kg_max) * 100) : 0 })));
});
app.post('/api/fleet', auth(), perm('drone.offer', 'fleet.manage'), (req, res) => {
  const b = req.body || {};
  const md = one('SELECT * FROM drone_models WHERE model_id=? OR name=?', b.model_id || b.model, b.model || b.model_id);
  if (!md) return res.status(400).json({ error: 'modelo inválido' });
  const node = b.node_id ? one('SELECT * FROM network_nodes WHERE node_id=?', b.node_id) : null;
  const id = D.uid('drn');
  run(`INSERT INTO drones(drone_id,project_id,owner_id,model_id,model,serial,operator_role,status,battery,battery_wh,health_pct,payload_kg_max,
       payload_kg_now,cruise_kmh,range_km,charge_kw,reserve_pct,node_id,lat,lon,alt_m,heading,speed_kmh,signal,temp_c,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, b.project_id, req.user.sub, md.model_id, md.name, b.serial || `SN-${D.uid('x').slice(-8).toUpperCase()}`,
    b.operator_role || 'offered', 'active', Number(b.battery ?? 100), md.battery_wh, 100, md.payload_kg, 0, md.cruise_kmh, md.range_km,
    md.charge_kw, md.reserve_pct, node ? node.node_id : null, node ? node.lat : null, node ? node.lon : null, 0, 0, 0, 98, 32, new Date().toISOString());
  res.json(one('SELECT * FROM drones WHERE drone_id=?', id));
});
app.patch('/api/fleet/:id', auth(), perm('fleet.manage', 'recharge.manage'), (req, res) => {
  const cur = one('SELECT * FROM drones WHERE drone_id=?', req.params.id);
  if (!cur) return res.status(404).json({ error: 'drone inexistente' });
  const b = { ...cur, ...req.body };
  run('UPDATE drones SET status=?, battery=?, node_id=?, payload_kg_now=? WHERE drone_id=?',
    b.status, Number(b.battery), b.node_id || null, Number(b.payload_kg_now || 0), req.params.id);
  res.json(one('SELECT * FROM drones WHERE drone_id=?', req.params.id));
});

/* ============================== MISSÕES ================================= */
app.get('/api/missions', auth(false), (req, res) => {
  const rows = all(`SELECT m.*, d.model AS drone_model, o.code AS origin_code, t.code AS dest_code, p.code AS package_code
    FROM missions m LEFT JOIN drones d ON d.drone_id=m.drone_id LEFT JOIN network_nodes o ON o.node_id=m.origin_node_id
    LEFT JOIN network_nodes t ON t.node_id=m.dest_node_id LEFT JOIN packages p ON p.package_id=m.package_id
    ORDER BY m.created_at DESC LIMIT 120`);
  res.json(rows.map((r) => ({ ...r, stops: J(r.route_json, { stops: [] }).stops || [] })));
});
app.post('/api/missions/plan', auth(false), (req, res) => {
  try {
    const b = req.body || {};
    if (!b.drone_id || !b.origin_id || !b.dest_id) return res.status(400).json({ error: 'drone_id, origin_id e dest_id são obrigatórios' });
    res.json(sim.plan({
      drone_id: b.drone_id, origin_id: b.origin_id, dest_id: b.dest_id,
      payload_kg: Number(b.payload_kg || 1), project_id: b.project_id || one('SELECT project_id FROM projects LIMIT 1').project_id,
      reserve_pct: b.reserve_pct
    }));
  } catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/missions', auth(), perm('routes.manage', 'packages.create', 'packages.manage'), (req, res) => {
  try {
    const b = req.body || {};
    const out = sim.createMission({
      project_id: b.project_id || one('SELECT project_id FROM projects LIMIT 1').project_id,
      drone_id: b.drone_id, origin_id: b.origin_id, dest_id: b.dest_id,
      payload_kg: Number(b.payload_kg || 1), package_id: b.package_id || null, autostart: b.autostart !== false
    });
    res.json({ ok: true, ...out, live: sim.liveState(out.mission_id) });
  } catch (e) { res.status(409).json({ error: e.message }); }
});
app.get('/api/missions/:id/live', auth(false), (req, res) => {
  try { res.json(sim.liveState(req.params.id)); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
app.get('/api/missions/:id/telemetry', auth(false), (req, res) => res.json(all('SELECT * FROM telemetry WHERE mission_id=? ORDER BY ts DESC LIMIT 400', req.params.id)));
app.post('/api/missions/:id/start', auth(), perm('routes.manage', 'mission.override'), (req, res) => {
  try { res.json(sim.start(req.params.id)); } catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/missions/:id/finish', auth(), perm('routes.manage', 'mission.override'), (req, res) => {
  sim.finish(req.params.id, req.body.status || 'done'); res.json({ ok: true });
});
app.post('/api/missions/:id/override', auth(), perm('mission.override', 'route.reroute', 'routes.manage'), (req, res) => {
  try { res.json(sim.override(req.params.id, { ...req.body, by: req.user.email })); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/missions/:id/diversion', auth(), perm('route.reroute', 'mission.override', 'routes.manage'), (req, res) => {
  try {
    const hold = sim.autoDiversion(req.params.id, req.body.reason || 'weather', req.body.battery);
    res.json({ ok: true, hold_node: hold ? hold.code : null });
  } catch (e) { res.status(409).json({ error: e.message }); }
});
app.get('/api/diversions', auth(false), (req, res) => res.json(all(`SELECT v.*, m.mission_id, d.model AS drone_model FROM diversions v
  LEFT JOIN missions m ON m.mission_id=v.mission_id LEFT JOIN drones d ON d.drone_id=m.drone_id ORDER BY v.ts DESC LIMIT 60`)));
app.get('/api/safety', auth(false), (req, res) => res.json(all('SELECT * FROM safety_reports ORDER BY ts DESC LIMIT 60')));

/* ============================== PACOTES ================================= */
app.get('/api/packages', auth(false), (req, res) => res.json(all(`SELECT p.*, o.code AS origin_code, d.code AS dest_code,
  s.name AS sender_name, r.name AS recipient_name FROM packages p LEFT JOIN network_nodes o ON o.node_id=p.origin_node_id
  LEFT JOIN network_nodes d ON d.node_id=p.dest_node_id LEFT JOIN users s ON s.user_id=p.sender_id
  LEFT JOIN users r ON r.user_id=p.recipient_id ORDER BY p.created_at DESC`).map((p) => ({ ...p, permits: J(p.permits, []) }))));
app.get('/api/packages/:id', auth(false), (req, res) => {
  const p = one('SELECT * FROM packages WHERE package_id=? OR code=?', req.params.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'pacote não encontrado' });
  res.json({
    ...p, permits: J(p.permits, []),
    events: all('SELECT * FROM package_events WHERE package_id=? ORDER BY ts', p.package_id),
    tags: all('SELECT * FROM rfid_tags WHERE package_id=?', p.package_id),
    mission: one('SELECT mission_id,status,drone_id,progress FROM missions WHERE package_id=? ORDER BY created_at DESC', p.package_id) || null,
    origin: one('SELECT code,name,lat,lon FROM network_nodes WHERE node_id=?', p.origin_node_id),
    destination: one('SELECT code,name,lat,lon FROM network_nodes WHERE node_id=?', p.dest_node_id)
  });
});
app.post('/api/packages', auth(), perm('packages.create', 'packages.manage'), (req, res) => {
  const b = req.body || {};
  const id = D.uid('pkg');
  const n = Number(one('SELECT COUNT(*) c FROM packages').c) + 41;
  const code = b.code || `SKY-2026-${String(n).padStart(4, '0')}`;
  const qr = JSON.stringify({ code, track: `/track?id=${id}`, issued: new Date().toISOString() });
  run(`INSERT INTO packages(package_id,code,project_id,sender_id,recipient_id,origin_node_id,dest_node_id,contents,weight_kg,declared_value,
    invoice_no,invoice_url,permits,hazard,priority,status,risk,created_at,qr_payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, code, b.project_id || one('SELECT project_id FROM projects LIMIT 1').project_id, b.sender_id || req.user.sub, b.recipient_id || null,
    b.origin_node_id, b.dest_node_id, b.contents || '', Number(b.weight_kg || 1), Number(b.declared_value || 0), b.invoice_no || null,
    `/api/packages/${id}/invoice`, JSON.stringify(b.permits || [{ id: 'PERM-NEW', entity: 'ANAC', scope: 'voo_urbano_BVLOS', status: 'pending' }]),
    b.hazard || 'none', Number(b.priority || 2), 'registered', b.risk || 'low', new Date().toISOString(), qr);
  run('INSERT INTO rfid_tags(tag_id,package_id,epc,kind,last_seen_ts,last_reader_id,rssi,battery_pct) VALUES(?,?,?,?,?,?,?,?)',
    D.uid('tag'), id, `E280${D.uid('x').slice(-10).toUpperCase()}`, 'RFID', new Date().toISOString(), 'RD-MANUAL', -45, 100);
  sim.event(id, 'registered', b.origin_node_id, 'Pacote registrado manualmente');
  res.json(one('SELECT * FROM packages WHERE package_id=?', id));
});
app.get('/api/packages/:id/qr.png', async (req, res) => {
  const p = one('SELECT * FROM packages WHERE package_id=? OR code=?', req.params.id, req.params.id);
  if (!p) return res.status(404).end();
  const target = `${req.protocol}://${req.get('host')}/track?id=${p.package_id}`;
  const png = await QRCode.toBuffer(JSON.stringify({ code: p.code, url: target, origin: p.origin_node_id, dest: p.dest_node_id, wt: p.weight_kg }), { width: 320, margin: 1, color: { dark: '#0b1120', light: '#e8f6ff' } });
  res.type('png').send(png);
});
app.get('/api/packages/:id/invoice', auth(false), (req, res) => {
  const p = one('SELECT * FROM packages WHERE package_id=?', req.params.id);
  if (!p) return res.status(404).json({ error: 'não encontrado' });
  res.json({
    invoice_no: p.invoice_no, code: p.code, issued_at: p.created_at, currency: 'BRL', declared_value: p.declared_value,
    weight_kg: p.weight_kg, contents: p.contents, issuer: 'sky.m3d.pro · droneDrop logistics',
    linha: [{ descricao: p.contents, peso_kg: p.weight_kg, valor: p.declared_value }],
    totals: { subtotal: p.declared_value, taxes: +(p.declared_value * 0.12).toFixed(2), total: +(p.declared_value * 1.12).toFixed(2) },
    invoice_url: p.invoice_url
  });
});
app.get('/api/packages/:id/manifest.json', auth(false), (req, res) => {
  const p = one('SELECT * FROM packages WHERE package_id=? OR code=?', req.params.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'não encontrado' });
  res.json({
    manifest_version: '1.0', generated_at: new Date().toISOString(),
    operator: 'sky.m3d.pro', project: one('SELECT name FROM projects WHERE project_id=?', p.project_id)?.name,
    code: p.code, contents: p.contents, weight_kg: p.weight_kg, hazard: p.hazard, priority: p.priority,
    declared_value: p.declared_value, invoice_no: p.invoice_no,
    origin: one('SELECT code,name,lat,lon FROM network_nodes WHERE node_id=?', p.origin_node_id),
    destination: one('SELECT code,name,lat,lon FROM network_nodes WHERE node_id=?', p.dest_node_id),
    sender: one('SELECT name,org FROM users WHERE user_id=?', p.sender_id), recipient: one('SELECT name,org FROM users WHERE user_id=?', p.recipient_id),
    permits: J(p.permits, []), tracking: `/track?id=${p.package_id}`,
    regulatory: { anac_bvlos: 'compliant', dea_1520_2023: 'compliant', correios_licence: 'applied', scan_required: true },
    hashes: J(p.qr_payload, {}).hashes || {}, qr: `/api/packages/${p.package_id}/qr.png`
  });
});
app.get('/api/packages/:id/predictive', auth(false), (req, res) => {
  try { res.json(sim.predictive(req.params.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/packages/:id/scan', auth(false), (req, res) => {
  const p = one('SELECT * FROM packages WHERE package_id=? OR code=?', req.params.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'não encontrado' });
  const b = req.body || {};
  const method = (b.method || 'QR').toUpperCase();
  const status = b.status || (p.status === 'registered' ? 'queued' : p.status === 'in_transit' ? 'at_hub' : p.status);
  run('INSERT INTO package_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', D.uid('evt'), p.package_id, new Date().toISOString(), status,
    b.node_id || p.origin_node_id, null, b.lat ?? null, b.lon ?? null, method, b.reader_id || null, b.rssi ?? null,
    b.actor || 'leitor', b.detail || `Leitura ${method} registrada`);
  run('UPDATE packages SET status=? WHERE package_id=?', status === 'delivered' ? 'delivered' : status, p.package_id);
  if (method === 'RFID' || method === 'BLE') run('UPDATE rfid_tags SET last_seen_ts=?, last_reader_id=?, rssi=? WHERE package_id=? AND kind=?',
    new Date().toISOString(), b.reader_id || 'RD-01', b.rssi ?? -48, p.package_id, method);
  res.json({ ok: true, status, method, tags: all('SELECT * FROM rfid_tags WHERE package_id=?', p.package_id) });
});

/* ========================= TRIANGULAÇÃO / TELEMETRIA ==================== */
app.get('/api/triangulation', auth(false), (req, res) => res.json(sim.triangulation(req.query.project_id)));
app.get('/api/telemetry', auth(false), (req, res) => {
  const mid = req.query.mission_id;
  if (mid) return res.json(all('SELECT * FROM telemetry WHERE mission_id=? ORDER BY ts DESC LIMIT 300', mid).reverse());
  res.json(all('SELECT * FROM telemetry ORDER BY ts DESC LIMIT 400').reverse());
});
app.post('/api/sim/tick', auth(false), (req, res) => res.json(sim.tick()));
app.get('/api/sim/settings', auth(false), (req, res) => res.json(all('SELECT * FROM sim_settings')));
app.patch('/api/sim/settings/:project_id', auth(), perm('sim.control'), (req, res) => {
  const b = req.body || {};
  run('UPDATE sim_settings SET alt_m=COALESCE(?,alt_m), density=COALESCE(?,density), wind_kmh=COALESCE(?,wind_kmh), speed_x=COALESCE(?,speed_x), updated_at=? WHERE project_id=?',
    b.alt_m ?? null, b.density ?? null, b.wind_kmh ?? null, b.speed_x ?? null, new Date().toISOString(), req.params.project_id);
  const s = one('SELECT * FROM sim_settings WHERE project_id=?', req.params.project_id);
  if (b.wind_kmh > 22) sim.alert('amber', 'WX_ALT', `Vento ${b.wind_kmh} km/h acima do limite operacional — rotas serão ajustadas`, null, null, null);
  res.json(s);
});

/* ================================ ALERTAS =============================== */
app.get('/api/alerts', auth(false), (req, res) => res.json(all('SELECT * FROM alerts ORDER BY ts DESC LIMIT 120')));
app.post('/api/alerts/:id/ack', auth(), perm('alerts.ack'), (req, res) => {
  run('UPDATE alerts SET ack=1, acked_by=?, acked_at=? WHERE alert_id=?', req.user.email, new Date().toISOString(), req.params.id);
  res.json(one('SELECT * FROM alerts WHERE alert_id=?', req.params.id));
});
app.get('/api/logs', auth(false), (req, res) => res.json(all('SELECT * FROM event_log ORDER BY ts DESC LIMIT 200')));

/* ========================= CÂMERAS / SENSORES =========================== */
app.get('/api/cameras', auth(false), (req, res) => res.json(all(`SELECT c.*, n.code AS node_code, m.mission_id AS live_mission FROM camera_points c
  LEFT JOIN network_nodes n ON n.node_id=c.node_id LEFT JOIN missions m ON m.mission_id=c.assigned_mission_id ORDER BY c.name`)));
app.post('/api/cameras/:id/reorient', auth(), perm('cameras.control'), (req, res) => {
  const b = req.body || {};
  run('UPDATE camera_points SET azimuth=COALESCE(?,azimuth), tilt=COALESCE(?,tilt), zoom=COALESCE(?,zoom), mode=COALESCE(?,mode), assigned_mission_id=COALESCE(?,assigned_mission_id) WHERE cam_id=?',
    b.azimuth ?? null, b.tilt ?? null, b.zoom ?? null, b.mode || 'manual', b.mission_id || null, req.params.id);
  const c = one('SELECT * FROM camera_points WHERE cam_id=?', req.params.id);
  if (c) sim.alert('info', 'CAM_REORIENT', `Câmera ${c.name} reorientada (az ${c.azimuth}°, zoom ${c.zoom}x) por ${req.user.email}`, null, b.mission_id || null, c.node_id);
  res.json(c);
});
app.get('/api/sensors', auth(false), (req, res) => res.json(all('SELECT * FROM sensors ORDER BY ts DESC LIMIT 120').map((s) => ({ ...s, value: J(s.value_json, {}) }))));
app.post('/api/sensors', auth(false), (req, res) => {
  const b = req.body || {};
  const id = D.uid('sen');
  run('INSERT INTO sensors(sensor_id,project_id,node_id,kind,ts,value_json,status) VALUES(?,?,?,?,?,?,?)',
    id, b.project_id || one('SELECT project_id FROM projects LIMIT 1').project_id, b.node_id || null, b.kind || 'WIND', new Date().toISOString(),
    JSON.stringify(b.value || {}), 'ok');
  if (b.kind === 'WIND' && Number(b.value?.speed_kmh) > 24) sim.alert('amber', 'WX_ALT', `Rajada crítica ${b.value.speed_kmh} km/h — reroteamento preventivo`, null, null, b.node_id || null);
  res.json({ ok: true, sensor_id: id });
});

/* ================================= JOBS ================================= */
app.get('/api/jobs', auth(false), (req, res) => res.json(all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 60')));
app.post('/api/jobs', auth(), (req, res) => {
  const b = req.body || {};
  const id = D.uid('job');
  run('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)', id, b.project_id || null, b.kind || 'ingest:dados.geojson', JSON.stringify(b.payload || {}), 'running', 12, new Date().toISOString(), null, null);
  for (let i = 1; i <= 5; i++) {
    setTimeout(() => {
      const pct = i * 20;
      run('UPDATE jobs SET progress=?, status=? WHERE job_id=?', pct, pct >= 100 ? 'done' : 'running', id);
      if (pct >= 100) run('UPDATE jobs SET finished_at=?, result=? WHERE job_id=?', new Date().toISOString(), JSON.stringify({ features: 120 + Math.round(Math.random() * 80) }), id);
    }, i * 320);
  }
  res.json(one('SELECT * FROM jobs WHERE job_id=?', id));
});

/* ============================== RELATÓRIOS ============================== */
app.get('/api/reports', auth(false), (req, res) => res.json(all('SELECT report_id,project_id,kind,period,created_at,created_by,url FROM reports ORDER BY created_at DESC LIMIT 60')));
app.post('/api/reports/generate', auth(), perm('reports.write', 'regulator.access'), (req, res) => {
  const kind = req.body?.kind || 'operacional';
  const period = req.body?.period || new Date().toISOString().slice(0, 10);
  const payload = {
    kind, period, generated_at: new Date().toISOString(), generated_by: req.user.email,
    kpis: kpis(),
    fleet: all('SELECT model,COUNT(*) n,ROUND(AVG(battery),1) avg_batt FROM drones GROUP BY model'),
    missions: all("SELECT status,COUNT(*) n FROM missions GROUP BY status"),
    alerts: all('SELECT severity,COUNT(*) n FROM alerts GROUP BY severity'),
    triangulation: sim.triangulation(),
    deliveries: all("SELECT code,status,weight_kg,dest_node_id,delivered_at FROM packages WHERE status='delivered' ORDER BY delivered_at DESC LIMIT 30"),
    energy: { total_wh_last_day: Math.round(one('SELECT COALESCE(SUM(energy_wh),0) s FROM missions').s), kwh: +(one('SELECT COALESCE(SUM(energy_wh),0) s FROM missions').s / 1000).toFixed(2) }
  };
  const id = D.uid('rep');
  const csv = toCsv(payload);
  run('INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)', id, req.body?.project_id || null, kind, period, JSON.stringify(payload), new Date().toISOString(), req.user.email, `/api/reports/${id}.csv`);
  res.json({ report_id: id, kind, period, payload, csv_preview: csv.split('\n').slice(0, 6).join('\n'), url: `/api/reports/${id}.csv` });
});
function toCsv(payload) {
  const lines = [`# relatório ${payload.kind} · ${payload.period} · ${payload.generated_at}`, ''];
  lines.push('secao;chave;valor');
  Object.entries(payload.kpis || {}).forEach(([k, v]) => lines.push(`kpi;${k};${v}`));
  (payload.fleet || []).forEach((f) => lines.push(`frota;${f.model};unidades=${f.n};bateria_media=${f.avg_batt}`));
  (payload.missions || []).forEach((m) => lines.push(`missoes;${m.status};${m.n}`));
  (payload.alerts || []).forEach((a) => lines.push(`alertas;${a.severity};${a.n}`));
  (payload.triangulation?.nodes || []).forEach((n) => lines.push(`triangulacao;${n.code};in=${n.incoming};out=${n.outgoing};saldo=${n.imbalance}`));
  (payload.deliveries || []).forEach((d) => lines.push(`entregas;${d.code};${d.status};${d.weight_kg}kg`));
  lines.push(`energia;kwh;${payload.energy?.kwh ?? 0}`);
  return lines.join('\n');
}
app.get('/api/reports/:id.csv', auth(false), (req, res) => {
  const r = one('SELECT * FROM reports WHERE report_id=?', req.params.id);
  if (!r) return res.status(404).json({ error: 'relatório não encontrado' });
  const p = J(r.payload_json, {});
  const csv = toCsv(p);
  run('INSERT INTO event_log VALUES(?,?,?,?,?)', D.uid('log'), new Date().toISOString(), 'INFO', 'regulator', `Relatório ${r.kind} exportado (${req.ip})`);
  res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="skym3d-${r.kind}-${r.period}.csv"`).send(csv);
});
function kpis() {
  const mes = all("SELECT status FROM missions");
  return {
    nodes: one('SELECT COUNT(*) c FROM network_nodes').c,
    drones: one('SELECT COUNT(*) c FROM drones').c,
    drones_in_flight: one("SELECT COUNT(*) c FROM drones WHERE status='in_flight'").c,
    drones_charging: one("SELECT COUNT(*) c FROM drones WHERE status='charging'").c,
    avg_battery: one('SELECT ROUND(AVG(battery),1) a FROM drones').a,
    packages: one('SELECT COUNT(*) c FROM packages').c,
    packages_in_transit: one("SELECT COUNT(*) c FROM packages WHERE status='in_transit'").c,
    delivered: one("SELECT COUNT(*) c FROM packages WHERE status='delivered'").c,
    missions_total: mes.length, missions_done: mes.filter((m) => m.status === 'done').length,
    alerts_open: one('SELECT COUNT(*) c FROM alerts WHERE ack=0').c,
    alerts_red: one("SELECT COUNT(*) c FROM alerts WHERE severity='red' AND ack=0").c,
    km_flown: +one('SELECT COALESCE(SUM(planned_km),0) s FROM missions').s.toFixed(2),
    energy_kwh: +(one('SELECT COALESCE(SUM(energy_wh),0) s FROM missions').s / 1000).toFixed(2),
    co2_saved_kg: +(one('SELECT COALESCE(SUM(planned_km),0) s FROM missions').s * 0.19).toFixed(2)
  };
}
app.get('/api/kpis', auth(false), (req, res) => res.json(kpis()));
app.get('/api/regulator/access', auth(false), (req, res) => res.json(all('SELECT * FROM regulator_access ORDER BY granted_at DESC')));
app.post('/api/regulator/access', auth(), perm('regulator.access'), (req, res) => {
  const b = req.body || {};
  const id = D.uid('reg');
  const token = 'REG-' + D.uid('x').slice(-12).toUpperCase();
  run('INSERT INTO regulator_access(access_id,project_id,entity,purpose,scope,token,granted_at,expires_at,active) VALUES(?,?,?,?,?,?,?,?,1)',
    id, b.project_id || null, b.entity || 'ANAC', b.purpose || 'auditoria', b.scope || 'manifest.read,permits.read',
    token, new Date().toISOString(), new Date(Date.now() + (b.days || 15) * 864e5).toISOString());
  res.json(one('SELECT * FROM regulator_access WHERE access_id=?', id));
});

/* ============================== OVERVIEW ================================ */
app.get('/api/overview', auth(false), (req, res) => {
  const projectId = req.query.project_id || one('SELECT project_id FROM projects LIMIT 1')?.project_id;
  res.json({
    kpis: kpis(), project: one('SELECT * FROM projects WHERE project_id=?', projectId),
    projects: all('SELECT project_id,name,city FROM projects'),
    settings: one('SELECT * FROM sim_settings WHERE project_id=?', projectId),
    nodes: all('SELECT * FROM network_nodes ORDER BY code'),
    fleet: all(`SELECT d.*, m.geom_json, m.rotors, m.class AS mclass, m.dims_cm, m.weight_kg, u.name AS owner_name, u.role AS owner_role, n.code AS node_code
      FROM drones d LEFT JOIN drone_models m ON m.model_id=d.model_id LEFT JOIN users u ON u.user_id=d.owner_id LEFT JOIN network_nodes n ON n.node_id=d.node_id`)
      .map((d) => ({ ...d, geom: J(d.geom_json, {}) })),
    models: all('SELECT * FROM drone_models').map((m) => ({ ...m, geom: J(m.geom_json, {}) })),
    zones: all('SELECT * FROM airspace_zones'),
    layers: all('SELECT * FROM map_layers'),
    triangulation: sim.triangulation(projectId),
    alerts: all('SELECT * FROM alerts ORDER BY ts DESC LIMIT 40'),
    cameras: all('SELECT * FROM camera_points'),
    missions: all(`SELECT m.*, d.model AS drone_model, o.code AS origin_code, t.code AS dest_code, p.code AS package_code FROM missions m
      LEFT JOIN drones d ON d.drone_id=m.drone_id LEFT JOIN network_nodes o ON o.node_id=m.origin_node_id
      LEFT JOIN network_nodes t ON t.node_id=m.dest_node_id LEFT JOIN packages p ON p.package_id=m.package_id ORDER BY m.created_at DESC LIMIT 60`),
    packages: all(`SELECT p.*, o.code AS origin_code, d.code AS dest_code FROM packages p
      LEFT JOIN network_nodes o ON o.node_id=p.origin_node_id LEFT JOIN network_nodes d ON d.node_id=p.dest_node_id ORDER BY p.created_at DESC`),
    sensors: all('SELECT * FROM sensors ORDER BY ts DESC LIMIT 40').map((s) => ({ ...s, value: J(s.value_json, {}) })),
    users: all('SELECT user_id,name,email,role,org,plan,on_duty,permissions FROM users ORDER BY created_at'),
    logs: all('SELECT * FROM event_log ORDER BY ts DESC LIMIT 60'),
    reports: all('SELECT report_id,kind,period,created_at,url FROM reports ORDER BY created_at DESC LIMIT 20'),
    installer: {
      installed: D.isInstalled(db), schema_version: D.meta(db, 'schema_version'), installed_at: D.meta(db, 'installed_at'),
      autoconfig: D.meta(db, 'autoconfig'), db_size_kb: fs.existsSync(D.DB_FILE) ? Math.round(fs.statSync(D.DB_FILE).size / 1024) : 0
    }
  });
});

/* ============================= FALLBACK SPA ============================= */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* =============================== SERVIDOR =============================== */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  busList.add(ws);
  try {
    ws.send(JSON.stringify({ type: 'hello', ts: new Date().toISOString(), kpis: kpis(), triangulation: sim.triangulation(), live: [] }));
  } catch { /* ignore */ }
  ws.on('message', (m) => {
    try {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'subscribe') ws.send(JSON.stringify({ type: 'subscribed', ts: new Date().toISOString() }));
    } catch { /* ignore */ }
  });
  ws.on('close', () => busList.delete(ws));
});

setInterval(() => { try { sim.tick(); } catch (e) { console.error('[sim]', e.message); } }, 1000);

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  sky.m3d.pro · droneDrop v0.2`);
  console.log(`  banco: ${D.DB_FILE}`);
  console.log(`  autoinstalação: ${D.isInstalled(db) ? 'ok (schema ' + D.meta(db, 'schema_version') + ')' : 'pendente'}`);
  console.log(`  aplicação: ${url}`);
  console.log(`  login demo: admin@sky.m3d.pro / sky2026\n`);
});

module.exports = { app, server, db, sim };
