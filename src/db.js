'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop — Camada de dados
   Autoinstalação: o banco SQLite é criado, versionado e populado
   automaticamente na primeira execução (schema + seeds operacionais).
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.SKYM3D_DATA || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.SKYM3D_DB || path.join(DATA_DIR, 'skym3d.sqlite');
const SCHEMA_VERSION = '1.0.0';

const uid = (p = 'id') => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ SCHEMA */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS install_log(
  step_id TEXT PRIMARY KEY, ts TEXT, step TEXT, status TEXT, detail TEXT);

CREATE TABLE IF NOT EXISTS users(
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','sender','recipient','hub','drone_owner','pilot','regulator')),
  org TEXT, phone TEXT, plan TEXT NOT NULL DEFAULT 'Pro',
  permissions TEXT NOT NULL DEFAULT '[]', on_duty INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT, last_login TEXT);

CREATE TABLE IF NOT EXISTS projects(
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT, bbox TEXT,
  created_by TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TEXT, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS map_layers(
  layer_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  type TEXT NOT NULL, data_uri TEXT, visibility INTEGER NOT NULL DEFAULT 1,
  opacity REAL NOT NULL DEFAULT 0.6, updated_at TEXT);

CREATE TABLE IF NOT EXISTS airspace_zones(
  zone_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  layer_id TEXT REFERENCES map_layers(layer_id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'Open', height_limit REAL NOT NULL, density_limit REAL NOT NULL,
  min_soc_pct REAL NOT NULL DEFAULT 22, geom TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sim_settings(
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  alt_m REAL NOT NULL DEFAULT 120, density REAL NOT NULL DEFAULT 12,
  wind_kmh REAL NOT NULL DEFAULT 12, speed_x REAL NOT NULL DEFAULT 8, updated_at TEXT);

CREATE TABLE IF NOT EXISTS network_nodes(
  node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('depot','rooftop','micro','support','entry')),
  lat REAL NOT NULL, lon REAL NOT NULL, elev_m REAL NOT NULL DEFAULT 0,
  pads INTEGER NOT NULL DEFAULT 2, charger_kw REAL NOT NULL DEFAULT 0,
  capacity_slots INTEGER NOT NULL DEFAULT 20, occupancy INTEGER NOT NULL DEFAULT 0,
  accepts_inbound INTEGER NOT NULL DEFAULT 1, accepts_outbound INTEGER NOT NULL DEFAULT 1,
  is_primary_entry INTEGER NOT NULL DEFAULT 0, is_recharge INTEGER NOT NULL DEFAULT 1,
  parent_node_id TEXT REFERENCES network_nodes(node_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'online' CHECK(status IN ('online','busy','offline','weather_hold')),
  owner_id TEXT REFERENCES users(user_id) ON DELETE SET NULL);

CREATE TABLE IF NOT EXISTS drone_models(
  model_id TEXT PRIMARY KEY, brand TEXT, name TEXT NOT NULL, class TEXT,
  rotors INTEGER NOT NULL DEFAULT 4, payload_kg REAL NOT NULL, cruise_kmh REAL NOT NULL,
  range_km REAL NOT NULL, battery_wh REAL NOT NULL, charge_kw REAL NOT NULL,
  weight_kg REAL, dims_cm TEXT, energy_base_wh REAL NOT NULL DEFAULT 22,
  energy_per_km_wh REAL NOT NULL DEFAULT 16, reserve_pct REAL NOT NULL DEFAULT 22,
  geom_json TEXT NOT NULL, notes TEXT);

CREATE TABLE IF NOT EXISTS drones(
  drone_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  owner_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  model_id TEXT NOT NULL REFERENCES drone_models(model_id),
  model TEXT NOT NULL, serial TEXT UNIQUE, operator_role TEXT NOT NULL DEFAULT 'fleet',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','in_flight','charging','maintenance','standby','offline')),
  battery REAL NOT NULL, battery_wh REAL NOT NULL, health_pct REAL NOT NULL DEFAULT 98,
  payload_kg_max REAL NOT NULL, payload_kg_now REAL NOT NULL DEFAULT 0,
  cruise_kmh REAL NOT NULL, range_km REAL NOT NULL, charge_kw REAL NOT NULL,
  reserve_pct REAL NOT NULL DEFAULT 22,
  node_id TEXT REFERENCES network_nodes(node_id) ON DELETE SET NULL,
  lat REAL, lon REAL, alt_m REAL DEFAULT 0, heading REAL DEFAULT 0, speed_kmh REAL DEFAULT 0,
  signal INTEGER DEFAULT 98, temp_c REAL DEFAULT 34, image_url TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS packages(
  package_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(user_id), recipient_id TEXT REFERENCES users(user_id),
  origin_node_id TEXT REFERENCES network_nodes(node_id),
  dest_node_id TEXT REFERENCES network_nodes(node_id),
  contents TEXT, weight_kg REAL NOT NULL DEFAULT 1, declared_value REAL DEFAULT 0,
  invoice_no TEXT, invoice_url TEXT, permits TEXT DEFAULT '[]', hazard TEXT DEFAULT 'none',
  priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'registered'
    CHECK(status IN ('registered','queued','in_transit','at_hub','out_for_delivery','delivered','returned','held')),
  risk TEXT DEFAULT 'low' CHECK(risk IN ('low','medium','high')),
  created_at TEXT, delivered_at TEXT, qr_payload TEXT);

CREATE TABLE IF NOT EXISTS package_events(
  event_id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
  ts TEXT NOT NULL, status TEXT NOT NULL, node_id TEXT, drone_id TEXT, lat REAL, lon REAL,
  method TEXT DEFAULT 'SYSTEM' CHECK(method IN ('SYSTEM','RFID','BLE','QR','MANUAL')),
  reader_id TEXT, rssi INTEGER, actor TEXT, detail TEXT);

CREATE TABLE IF NOT EXISTS missions(
  mission_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  package_id TEXT REFERENCES packages(package_id) ON DELETE SET NULL,
  drone_id TEXT NOT NULL REFERENCES drones(drone_id) ON DELETE CASCADE,
  origin_node_id TEXT NOT NULL REFERENCES network_nodes(node_id),
  dest_node_id TEXT NOT NULL REFERENCES network_nodes(node_id),
  payload_kg REAL NOT NULL DEFAULT 1, route_json TEXT NOT NULL, planned_km REAL NOT NULL,
  planned_air_min REAL NOT NULL, planned_charge_min REAL NOT NULL DEFAULT 0,
  energy_wh REAL NOT NULL DEFAULT 0, battery_at_start REAL NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK(status IN ('planned','queued','in_flight','charging','rerouted','hold','done','aborted')),
  current_leg INTEGER NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0,
  started_at TEXT, ended_at TEXT, eta_final TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS route_legs(
  leg_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, from_node_id TEXT NOT NULL, to_node_id TEXT NOT NULL,
  km REAL NOT NULL, air_min REAL NOT NULL, energy_wh REAL NOT NULL,
  arrive_soc REAL NOT NULL, pause_min REAL NOT NULL DEFAULT 0, target_soc REAL NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','active','done','skipped')),
  launched_at TEXT, closed_at TEXT);

CREATE TABLE IF NOT EXISTS telemetry(
  telemetry_id TEXT PRIMARY KEY, mission_id TEXT, drone_id TEXT NOT NULL, ts TEXT NOT NULL,
  lat REAL, lon REAL, alt_m REAL, speed_kmh REAL, heading REAL, battery REAL,
  signal INTEGER, temp_c REAL, wind_kmh REAL, phase TEXT, eta_next_min REAL, eta_final_min REAL,
  dist_remaining_km REAL);

CREATE TABLE IF NOT EXISTS alerts(
  alert_id TEXT PRIMARY KEY, project_id TEXT, ts TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('red','amber','green','info')),
  code TEXT, message TEXT NOT NULL, drone_id TEXT, mission_id TEXT, node_id TEXT,
  ack INTEGER NOT NULL DEFAULT 0, acked_by TEXT, acked_at TEXT);

CREATE TABLE IF NOT EXISTS safety_reports(
  safety_id TEXT PRIMARY KEY, mission_id TEXT, project_id TEXT, ts TEXT NOT NULL,
  hazard TEXT NOT NULL, severity TEXT, action TEXT, resolved_at TEXT, reported_by TEXT);

CREATE TABLE IF NOT EXISTS diversions(
  diversion_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, ts TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('weather','battery','hazard','regulator','manual')),
  from_node_id TEXT, to_node_id TEXT, hold_node_id TEXT, new_route_json TEXT,
  recalculated_eta TEXT, approved_by TEXT, notes TEXT);

CREATE TABLE IF NOT EXISTS camera_points(
  cam_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT, name TEXT NOT NULL,
  lat REAL, lon REAL, alt_m REAL, azimuth REAL DEFAULT 0, tilt REAL DEFAULT -15,
  zoom REAL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'auto'
    CHECK(mode IN ('auto','manual','emergency','standby')),
  status TEXT DEFAULT 'online', latency_ms INTEGER DEFAULT 38, assigned_mission_id TEXT);

CREATE TABLE IF NOT EXISTS sensors(
  sensor_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('WIND','TEMP','HUM','CAM','RFID','BLE','RADAR')),
  ts TEXT NOT NULL, value_json TEXT NOT NULL, status TEXT DEFAULT 'ok');

CREATE TABLE IF NOT EXISTS rfid_tags(
  tag_id TEXT PRIMARY KEY, package_id TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
  epc TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'RFID' CHECK(kind IN ('RFID','BLE')),
  last_seen_ts TEXT, last_reader_id TEXT, rssi INTEGER, battery_pct INTEGER DEFAULT 100);

CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','error')),
  progress REAL NOT NULL DEFAULT 0, created_at TEXT, finished_at TEXT, result TEXT);

CREATE TABLE IF NOT EXISTS reports(
  report_id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, period TEXT,
  payload_json TEXT NOT NULL, created_at TEXT, created_by TEXT, url TEXT);

CREATE TABLE IF NOT EXISTS regulator_access(
  access_id TEXT PRIMARY KEY, project_id TEXT, entity TEXT NOT NULL, purpose TEXT,
  scope TEXT NOT NULL, token TEXT NOT NULL UNIQUE, granted_at TEXT, expires_at TEXT, active INTEGER DEFAULT 1);

CREATE TABLE IF NOT EXISTS event_log(
  log_id TEXT PRIMARY KEY, ts TEXT NOT NULL, level TEXT NOT NULL,
  actor TEXT, message TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS ix_node_proj ON network_nodes(project_id);
CREATE INDEX IF NOT EXISTS ix_drone_proj ON drones(project_id);
CREATE INDEX IF NOT EXISTS ix_pkg_proj ON packages(project_id);
CREATE INDEX IF NOT EXISTS ix_pkg_code ON packages(code);
CREATE INDEX IF NOT EXISTS ix_evt_pkg ON package_events(package_id, ts);
CREATE INDEX IF NOT EXISTS ix_mission_proj ON missions(project_id);
CREATE INDEX IF NOT EXISTS ix_leg_mission ON route_legs(mission_id, seq);
CREATE INDEX IF NOT EXISTS ix_tel_mission ON telemetry(mission_id, ts);
CREATE INDEX IF NOT EXISTS ix_alert_proj ON alerts(project_id, ts);
`;

/* ------------------------------------------------------------------ helpers */
function openDb(file = DB_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
function tableExists(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}
function meta(db, k, v) {
  if (v === undefined) { const r = db.prepare('SELECT v FROM app_meta WHERE k=?').get(k); return r ? r.v : null; }
  db.prepare('INSERT INTO app_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
  return v;
}
function isInstalled(db) { return tableExists(db, 'app_meta') && meta(db, 'install_complete') === '1'; }

/* inserção por objeto: elimina qualquer risco de desalinhamento de colunas */
function ins(db, table, obj) {
  const cols = Object.keys(obj);
  const sql = `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...cols.map((c) => obj[c]));
}

/* ---------------------------------------------------------------- INSTALAR */
function install(db, { force = false, quiet = false } = {}) {
  const steps = [];
  const say = (step, status, detail = '') => {
    steps.push({ step, status, detail });
    if (!quiet) console.log(`  [${status}] ${step}${detail ? ' — ' + detail : ''}`);
  };
  if (force) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    db.pragma('foreign_keys = OFF');
    for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
    db.pragma('foreign_keys = ON');
    say('reinstall:drop', 'ok', `${tables.length} tabelas removidas`);
  }
  db.exec(SCHEMA);
  say('schema:create', 'ok', `${db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c} objetos criados`);

  meta(db, 'schema_version', SCHEMA_VERSION);
  meta(db, 'installed_at', meta(db, 'installed_at') || now());
  if (!meta(db, 'jwt_secret')) meta(db, 'jwt_secret', crypto.randomBytes(32).toString('hex'));
  meta(db, 'app_name', 'sky.m3d.pro · droneDrop');
  meta(db, 'autoconfig', 'OK');

  const seeded = seed(db, say, force);
  meta(db, 'install_complete', '1');
  meta(db, 'last_boot', now());
  say('autoconfig', 'ok', 'admin, projeto, rede de nós, frota, catálogo 3D, pacotes e sensores');
  return { schema_version: SCHEMA_VERSION, db_file: DB_FILE, steps, seeded };
}

/* ------------------------------------------------------------------- SEEDS */
function seed(db, say = () => {}, force = false) {
  const hasUsers = tableExists(db, 'users') && db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
  if (hasUsers && !force) { say('seed:skip', 'ok', 'base já populada — nenhuma alteração'); return false; }

  const tx = db.transaction(() => {
    const PW = 'sky2026';
    const hash = bcrypt.hashSync(PW, 8);
    const A = (o) => ({ created_at: now(), active: 1, on_duty: 0, phone: '+55 11 90000-0000', plan: 'Enterprise', ...o });

    const users = [
      A({ user_id: uid('usr'), name: 'Ana Silva', email: 'admin@sky.m3d.pro', pass_hash: hash, role: 'admin', org: 'sky.m3d.pro · Operações',
        permissions: JSON.stringify(['routes.manage', 'fleet.manage', 'nodes.manage', 'users.manage', 'reports.read', 'reports.write', 'alerts.ack', 'sim.control', 'registry.write', 'database.install', 'cameras.control', 'packages.manage']) }),
      A({ user_id: uid('usr'), name: 'Lucas Prado', email: 'remetente@sky.m3d.pro', pass_hash: hash, role: 'sender', org: 'Loja Centro · Alpha', plan: 'Pro',
        permissions: JSON.stringify(['packages.create', 'track.read', 'invoices.read']) }),
      A({ user_id: uid('usr'), name: 'Mariana Costa', email: 'destinatario@sky.m3d.pro', pass_hash: hash, role: 'recipient', org: 'Residência H-B7', plan: 'Pro',
        permissions: JSON.stringify(['track.read', 'delivery.receive', 'packages.receive_physical']) }),
      A({ user_id: uid('usr'), name: 'Carlos Mendes', email: 'hub@sky.m3d.pro', pass_hash: hash, role: 'hub', org: 'Distribution Hub DH-01',
        permissions: JSON.stringify(['packages.receive_physical', 'nodes.operate', 'track.write', 'recharge.manage']) }),
      A({ user_id: uid('usr'), name: 'Elena Petreva', email: 'drone@sky.m3d.pro', pass_hash: hash, role: 'drone_owner', org: 'AeroLift Fleet Ltda',
        permissions: JSON.stringify(['drone.offer', 'fleet.read', 'fleet.manage', 'recharge.manage']) }),
      A({ user_id: uid('usr'), name: 'John Lee', email: 'piloto@sky.m3d.pro', pass_hash: hash, role: 'pilot', org: 'Piloto Emergencial Certificado', on_duty: 1,
        permissions: JSON.stringify(['mission.override', 'route.reroute', 'cameras.control', 'safety.write']) }),
      A({ user_id: uid('usr'), name: 'Marta Rocha', email: 'reguladora@sky.m3d.pro', pass_hash: hash, role: 'regulator', org: 'ANAC / DECEA · Compliance',
        permissions: JSON.stringify(['regulator.access', 'reports.read', 'permits.read', 'manifest.read']) })
    ];
    users.forEach((u) => ins(db, 'users', u));
    const byRole = Object.fromEntries(users.map((u) => [u.role, u.user_id]));
    const { admin, sender, recipient, hub, drone_owner, pilot } = byRole;

    /* projetos */
    const pj1 = uid('prj'), pj2 = uid('prj');
    ins(db, 'projects', { project_id: pj1, name: 'City Grid Alpha', city: 'São Paulo · SP', bbox: '-23.575,-46.655,-23.530,-46.610', created_by: admin, created_at: now(), active: 1 });
    ins(db, 'projects', { project_id: pj2, name: 'Harbor Corridor Beta', city: 'Santos · SP', bbox: '-23.980,-46.345,-23.945,-46.315', created_by: admin, created_at: now(), active: 1 });
    ins(db, 'sim_settings', { project_id: pj1, alt_m: 120, density: 14, wind_kmh: 12.1, speed_x: 8, updated_at: now() });
    ins(db, 'sim_settings', { project_id: pj2, alt_m: 90, density: 8, wind_kmh: 9.4, speed_x: 8, updated_at: now() });

    /* camadas */
    const layers = [];
    [['Zonas de Espaço Aéreo', 'vector/zonas.geojson', 1, 0.45], ['Corredores de Rota', 'vector/rotas.geojson', 1, 0.85],
     ['Nós da Rede', 'vector/nos.geojson', 1, 1], ['Malha Urbana 3D', 'mesh/cidade.glb', 1, 0.9],
     ['Relevo / Terreno', 'raster/relevo.tif', 0, 0.5], ['Pontos de Câmera', 'vector/cameras.geojson', 1, 0.7],
     ['Leitores RFID/BLE', 'vector/leitores.geojson', 1, 0.7], ['Restrições Regulatórias', 'vector/restricoes.geojson', 1, 0.6]
    ].forEach(([type, uri, vis, op], i) => {
      const rec = { layer_id: uid('lyr'), project_id: i < 6 ? pj1 : pj2, type, data_uri: `s3://skym3d/${i < 6 ? 'alpha' : 'beta'}/${uri}`, visibility: vis, opacity: op, updated_at: now() };
      ins(db, 'map_layers', rec); layers.push(rec.layer_id);
    });

    /* zonas de espaço aéreo */
    [['Restricted', 150, 4, 26, 'POLYGONZ((-23.556 -46.640 0,-23.540 -46.640 0,-23.540 -46.620 150,-23.556 -46.620 150,-23.556 -46.640 0))'],
     ['Corridor', 120, 20, 22, 'POLYGONZ((-23.552 -46.630 0,-23.545 -46.628 0,-23.545 -46.625 120,-23.552 -46.630 120))'],
     ['Open Rescue Lane', 130, 15, 18, 'POLYGONZ((-23.548 -46.635 0,-23.542 -46.635 0,-23.542 -46.628 130,-23.548 -46.628 130))']
    ].forEach(([type, h, d, soc, geom], i) => ins(db, 'airspace_zones',
      { zone_id: uid('zon'), project_id: pj1, layer_id: layers[i], type, height_limit: h, density_limit: d, min_soc_pct: soc, geom }));
    ins(db, 'airspace_zones', { zone_id: uid('zon'), project_id: pj2, layer_id: layers[6], type: 'Restricted', height_limit: 200, density_limit: 2, min_soc_pct: 28, geom: 'POLYGONZ((-23.965 -46.340 0,-23.955 -46.340 0,-23.955 -46.325 200,-23.965 -46.325 200))' });

    /* catálogo de modelos (geometria 3D rotacionável) */
    const models = [
      { name: 'SkyCart-P8', brand: 'SkyCart', class: 'Quadricóptero de entrega urbana', rotors: 4, payload_kg: 8, cruise_kmh: 45, range_km: 24, battery_wh: 1200, charge_kw: 1.6, weight_kg: 11.4, dims_cm: '92 x 92 x 28', energy_base_wh: 18, energy_per_km_wh: 14, reserve_pct: 22, notes: 'Pacote padrão até 8 kg',
        geom: { bodyW: 34, bodyH: 11, bodyL: 46, armLen: 43, rotorR: 20, color: '#38bdf8', livery: '#e2f4ff', prop: 4 } },
      { name: 'AeroLift-X1', brand: 'AeroLift', class: 'Hexacóptero de carga média', rotors: 6, payload_kg: 12, cruise_kmh: 55, range_km: 32, battery_wh: 1800, charge_kw: 2.2, weight_kg: 16.8, dims_cm: '118 x 118 x 34', energy_base_wh: 24, energy_per_km_wh: 15, reserve_pct: 24, notes: 'Carga média com redundância de rotores',
        geom: { bodyW: 44, bodyH: 14, bodyL: 58, armLen: 56, rotorR: 24, color: '#34d399', livery: '#ecfff6', prop: 6 } },
      { name: 'AeroLJR-21', brand: 'AeroLift', class: 'Quadricóptero leve de alta velocidade', rotors: 4, payload_kg: 5, cruise_kmh: 60, range_km: 28, battery_wh: 900, charge_kw: 1.4, weight_kg: 8.2, dims_cm: '86 x 86 x 24', energy_base_wh: 15, energy_per_km_wh: 13, reserve_pct: 20, notes: 'Entregas expressas de baixo peso',
        geom: { bodyW: 30, bodyH: 10, bodyL: 42, armLen: 40, rotorR: 18, color: '#a78bfa', livery: '#f4efff', prop: 4 } },
      { name: 'CargoDron X9', brand: 'CargoDron', class: 'Octocóptero de carga pesada', rotors: 8, payload_kg: 25, cruise_kmh: 40, range_km: 40, battery_wh: 3200, charge_kw: 3.3, weight_kg: 31.5, dims_cm: '164 x 164 x 46', energy_base_wh: 34, energy_per_km_wh: 20, reserve_pct: 26, notes: 'Carga pesada hub-a-hub',
        geom: { bodyW: 62, bodyH: 20, bodyL: 82, armLen: 80, rotorR: 30, color: '#fb923c', livery: '#fff3e6', prop: 8 } },
      { name: 'SkyCruiser E7', brand: 'SkyCruiser', class: 'VTOL híbrido de longo alcance', rotors: 6, payload_kg: 15, cruise_kmh: 90, range_km: 60, battery_wh: 2600, charge_kw: 2.6, weight_kg: 24, dims_cm: '210 x 148 x 42', energy_base_wh: 30, energy_per_km_wh: 12, reserve_pct: 24, notes: 'Corredores longos entre hubs',
        geom: { bodyW: 58, bodyH: 15, bodyL: 130, armLen: 62, rotorR: 26, color: '#f472b6', livery: '#fff0f7', prop: 6, wing: true } }
    ];
    const M = {};
    models.forEach((m) => {
      const model_id = `mdl_${m.name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      ins(db, 'drone_models', { model_id, brand: m.brand, name: m.name, class: m.class, rotors: m.rotors, payload_kg: m.payload_kg,
        cruise_kmh: m.cruise_kmh, range_km: m.range_km, battery_wh: m.battery_wh, charge_kw: m.charge_kw, weight_kg: m.weight_kg,
        dims_cm: m.dims_cm, energy_base_wh: m.energy_base_wh, energy_per_km_wh: m.energy_per_km_wh, reserve_pct: m.reserve_pct,
        geom_json: JSON.stringify(m.geom), notes: m.notes });
      M[m.name] = model_id;
    });

    /* rede: estações de distribuição, pontos de apoio, recarga e entradas primárias */
    const N = [
      ['DH-01', 'Distribution Hub Central', 'depot', -23.5505, -46.6333, 18, 12, 22, 240, 34, 1, 1, 1, 1, null, 'online', admin],
      ['RP-02', 'Rooftop Pod Alpha Tower', 'rooftop', -23.5468, -46.6295, 96, 4, 11, 60, 7, 0, 1, 0, 1, 'DH-01', 'online', hub],
      ['MH-03', 'Micro-Hub Rua Direita', 'micro', -23.5560, -46.6360, 6, 3, 7.4, 40, 12, 1, 1, 0, 1, 'DH-01', 'busy', hub],
      ['SP-04', 'Ponto de Apoio Sé', 'support', -23.5441, -46.6302, 24, 2, 7.4, 18, 3, 1, 1, 0, 1, 'DH-01', 'online', hub],
      ['PE-05', 'Entrada Primária Porto', 'entry', -23.5591, -46.6385, 12, 2, 11, 30, 5, 1, 1, 1, 1, 'DH-01', 'online', admin],
      ['SP-06', 'Ponto de Apoio Liberdade', 'support', -23.5415, -46.6265, 30, 2, 7.4, 20, 4, 1, 0, 0, 1, 'DH-01', 'online', hub],
      ['RP-07', 'Rooftop Pod Norte', 'rooftop', -23.5390, -46.6401, 84, 4, 11, 70, 6, 1, 1, 0, 1, 'DH-01', 'online', drone_owner],
      ['MH-08', 'Micro-Hub Sul', 'micro', -23.5620, -46.6245, 5, 3, 7.4, 45, 9, 1, 1, 0, 1, 'DH-01', 'online', hub],
      ['PE-09', 'Entrada Primária Oeste', 'entry', -23.5530, -46.6450, 10, 2, 11, 28, 4, 1, 1, 1, 1, 'DH-01', 'online', admin],
      ['SP-10', 'Ponto de Apoio Jardins', 'support', -23.5480, -46.6180, 26, 2, 11, 22, 2, 1, 1, 0, 1, 'DH-01', 'online', drone_owner]
    ];
    const ND = {};
    N.forEach(([code, name, kind, lat, lon, elev, pads, kw, cap, occ, inb, outb, entry, rech, parent, status, owner]) => {
      const node_id = `nod_${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      ins(db, 'network_nodes', { node_id, project_id: pj1, code, name, kind, lat, lon, elev_m: elev, pads, charger_kw: kw,
        capacity_slots: cap, occupancy: occ, accepts_inbound: inb, accepts_outbound: outb, is_primary_entry: entry, is_recharge: rech,
        parent_node_id: parent ? ("nod_"+parent.toLowerCase().replace(/[^a-z0-9]/g,"")) : null, status, owner_id: owner });
      ND[code] = node_id;
    });

    /* frota: próprios + oferecidos por usuários (drone owner, hub, destinatário) */
    const DR = [
      ['AeroLift-X1', 'DH-01', drone_owner, 'fleet', 'in_flight', 86.5, 4.2],
      ['SkyCart-P8', 'RP-02', drone_owner, 'fleet', 'active', 64.0, 0],
      ['AeroLJR-21', 'SP-04', hub, 'offered', 'active', 78.2, 0],
      ['CargoDron X9', 'DH-01', drone_owner, 'fleet', 'charging', 41.2, 0],
      ['SkyCruiser E7', 'MH-03', drone_owner, 'fleet', 'active', 92.8, 0],
      ['SkyCart-P8', 'MH-08', recipient, 'offered', 'standby', 55.6, 0],
      ['AeroLift-X1', 'SP-06', hub, 'offered', 'active', 97.4, 2.5],
      ['AeroLJR-21', 'PE-09', sender, 'offered', 'maintenance', 100.0, 0],
      ['SkyCruiser E7', 'PE-05', drone_owner, 'fleet', 'in_flight', 18.4, 6.1],
      ['CargoDron X9', 'RP-07', drone_owner, 'fleet', 'active', 71.9, 0]
    ];
    const DRONES = [];
    DR.forEach(([name, nodeCode, owner, role, status, battery, payloadNow], i) => {
      const md = models.find((m) => m.name === name);
      const nd = N.find((x) => x[0] === nodeCode);
      const rec = { drone_id: uid('drn'), project_id: pj1, owner_id: owner, model_id: M[name], model: name,
        serial: `SN-${name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-${1000 + i}`, operator_role: role, status,
        battery, battery_wh: md.battery_wh, health_pct: 88 + (i % 10), payload_kg_max: md.payload_kg, payload_kg_now: payloadNow,
        cruise_kmh: md.cruise_kmh, range_km: md.range_km, charge_kw: md.charge_kw, reserve_pct: md.reserve_pct,
        node_id: ND[nodeCode], lat: nd[3] + (i % 3 - 1) * 0.0009, lon: nd[4] + (i % 4 - 2) * 0.0009,
        alt_m: status === 'in_flight' ? 96 : 0, heading: (i * 37) % 360, speed_kmh: status === 'in_flight' ? md.cruise_kmh : 0,
        signal: 92 + (i % 8), temp_c: 30 + (i % 9), created_at: now() };
      ins(db, 'drones', rec); DRONES.push(rec);
    });

    /* pacotes + tags RFID/BLE + eventos */
    const PK = [
      ['SKY-2026-0041', 'PE-05', 'RP-02', 'Eletrônicos — fone bluetooth + carregador', 1.8, 1290.0, 'NF-88213', 'low', 1, 'queued'],
      ['SKY-2026-0042', 'DH-01', 'MH-08', 'Documentos notariais lacrados', 0.4, 0.0, 'NF-88214', 'medium', 1, 'queued'],
      ['SKY-2026-0043', 'MH-03', 'SP-04', 'Medicamentos refrigerados (2–8 °C)', 2.6, 480.0, 'NF-88215', 'high', 1, 'queued'],
      ['SKY-2026-0044', 'DH-01', 'RP-07', 'Insumos hospitalares — caixa 40x30x22', 6.4, 2310.0, 'NF-88216', 'medium', 2, 'delivered'],
      ['SKY-2026-0045', 'PE-09', 'SP-10', 'Peças de reposição industrial', 9.2, 760.0, 'NF-88217', 'low', 3, 'registered'],
      ['SKY-2026-0046', 'DH-01', 'SP-06', 'Cesta gourmet + bebidas', 4.1, 320.0, 'NF-88218', 'low', 2, 'registered']
    ];
    const PKGS = [];
    PK.forEach(([code, originCode, destCode, contents, weight, value, nf, risk, prio, status], i) => {
      const package_id = uid('pkg');
      const permits = [
        { id: `PERM-${880 + i}`, entity: 'ANAC', scope: 'voo_urbano_BVLOS', valid_until: '2027-03-31', status: 'valid' },
        { id: `PERM-${910 + i}`, entity: 'DECEA', scope: 'corredor_controlado', valid_until: '2027-01-15', status: i === 4 ? 'pending' : 'valid' }
      ];
      ins(db, 'packages', { package_id, code, project_id: pj1, sender_id: sender, recipient_id: recipient,
        origin_node_id: ND[originCode], dest_node_id: ND[destCode], contents, weight_kg: weight, declared_value: value,
        invoice_no: nf, invoice_url: `/api/packages/${package_id}/invoice`, permits: JSON.stringify(permits), hazard: 'none',
        priority: prio, status, risk, created_at: now(), delivered_at: status === 'delivered' ? now() : null,
        qr_payload: JSON.stringify({ code, origin: originCode, destination: destCode, weight_kg: weight,
          hashes: { cargo: crypto.createHash('sha256').update(code + contents).digest('hex').slice(0, 16) } }) });
      PKGS.push({ package_id, code });
      ins(db, 'rfid_tags', { tag_id: uid('tag'), package_id, epc: `E280${crypto.randomBytes(5).toString('hex').toUpperCase()}`, kind: 'RFID',
        last_seen_ts: now(), last_reader_id: `RD-${originCode}`, rssi: -(38 + i), battery_pct: 88 + i });
      ins(db, 'rfid_tags', { tag_id: uid('tag'), package_id, epc: `BLE-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, kind: 'BLE',
        last_seen_ts: now(), last_reader_id: `BLE-${destCode}`, rssi: -(52 + i), battery_pct: 76 + i });
      ins(db, 'package_events', { event_id: uid('evt'), package_id, ts: now(), status: 'registered', node_id: ND[originCode],
        method: 'MANUAL', actor: sender, detail: `Pacote registrado em ${originCode} com QR rastreável` });
    });

    /* câmeras reorientáveis, sensores, acessos regulatórios, alertas */
    [['CAM-09', 'RP-02', 'Câmera Corredor Central', -15, 1.4], ['CAM-14', 'PE-05', 'Câmera Porto', -8, 1.1],
     ['CAM-21', 'SP-04', 'Câmera Sé Reorientável', -22, 2.0], ['CAM-33', 'MH-08', 'Câmera Sul', -12, 1.0]
    ].forEach(([code, nodeCode, name, tilt, zoom], i) => {
      const nd = N.find((x) => x[0] === nodeCode);
      ins(db, 'camera_points', { cam_id: uid('cam'), project_id: pj1, node_id: ND[nodeCode], name, lat: nd[3] + 0.0006, lon: nd[4] - 0.0005,
        alt_m: nd[5] + 22, azimuth: 40 + i * 55, tilt, zoom, mode: 'auto', status: 'online', latency_ms: 28 + i * 9 });
    });
    ['WIND', 'TEMP', 'HUM', 'RADAR', 'RFID', 'BLE'].forEach((kind, i) => {
      const nodeCode = ['DH-01', 'RP-02', 'MH-03', 'PE-05', 'SP-04', 'RP-07'][i];
      const value = kind === 'WIND' ? { speed_kmh: 12.1, gust_kmh: 19.4, dir: 145 } : kind === 'TEMP' ? { c: 24.6 }
        : kind === 'HUM' ? { pct: 62 } : { contacts: 4, range_m: 320 };
      ins(db, 'sensors', { sensor_id: uid('sen'), project_id: pj1, node_id: ND[nodeCode], kind, ts: now(), value_json: JSON.stringify(value), status: 'ok' });
    });
    for (let h = 23; h >= 0; h--) {
      ins(db, 'sensors', { sensor_id: uid('sen'), project_id: pj1, node_id: ND['DH-01'], kind: 'WIND',
        ts: new Date(Date.now() - h * 3600000).toISOString(),
        value_json: JSON.stringify({ speed_kmh: +(8 + Math.random() * 12).toFixed(1), gust_kmh: +(14 + Math.random() * 16).toFixed(1), dir: Math.round(Math.random() * 360) }), status: 'ok' });
    }
    [['ANAC', 'Auditoria de conformidade de voo BVLOS', 'manifest.read,permits.read,missions.read', 30],
     ['DECEA', 'Verificação de corredores e zonas restritas', 'manifest.read,zones.read', 15]
    ].forEach(([entity, purpose, scope, days]) => ins(db, 'regulator_access', {
      access_id: uid('reg'), project_id: pj1, entity, purpose, scope, token: `REG-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      granted_at: now(), expires_at: new Date(Date.now() + days * 864e5).toISOString(), active: 1 }));

    ins(db, 'alerts', { alert_id: uid('alt'), project_id: pj1, ts: new Date(Date.now() - 8 * 60000).toISOString(), severity: 'red', code: 'BAT_LOW',
      message: 'Bateria baixa — redirecionando para ponto de recarga SP-04', drone_id: DRONES[8].drone_id, node_id: ND['SP-04'], ack: 0 });
    ins(db, 'alerts', { alert_id: uid('alt'), project_id: pj1, ts: new Date(Date.now() - 26 * 60000).toISOString(), severity: 'amber', code: 'WX_ALT',
      message: 'Alteração climática — rota ajustada (vento 19.4 km/h)', drone_id: DRONES[0].drone_id, ack: 0 });
    ins(db, 'alerts', { alert_id: uid('alt'), project_id: pj1, ts: new Date(Date.now() - 55 * 60000).toISOString(), severity: 'green', code: 'HUB_OK',
      message: 'DH-01 operacional — 34/240 slots ocupados', node_id: ND['DH-01'], ack: 1, acked_by: admin, acked_at: now() });
    ins(db, 'alerts', { alert_id: uid('alt'), project_id: pj1, ts: new Date(Date.now() - 90 * 60000).toISOString(), severity: 'info', code: 'SCAN',
      message: 'Triangulação dinâmica recalculada com 6 pacotes ativos', node_id: ND['DH-01'], ack: 0 });

    ins(db, 'jobs', { job_id: uid('job'), project_id: pj1, kind: 'ingest:malha-urbana.glb', payload: JSON.stringify({ source: 'glb://cidade-alpha' }),
      status: 'done', progress: 100, created_at: now(), finished_at: now(), result: JSON.stringify({ meshes: 1482, vertices: 812340 }) });
    ins(db, 'event_log', { log_id: uid('log'), ts: now(), level: 'INFO', actor: 'installer@local', message: 'Autoinstalação concluída — banco dinâmico criado e populado' });
    return true;
  });

  tx();
  say('seed:data', 'ok', 'usuários, projeto, rede de nós, frota, catálogo 3D, pacotes, câmeras, sensores, alertas');
  return true;
}

module.exports = { openDb, install, seed, isInstalled, tableExists, meta, ins, uid, now, DB_FILE, DATA_DIR, SCHEMA, SCHEMA_VERSION };
