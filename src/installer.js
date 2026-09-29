'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop — Instalador de linha de comando
   Uso:  node src/installer.js [--force] [--inspect]
   Cria o banco dinâmico, aplica o schema e popula os dados operacionais.
   ============================================================================ */
const fs = require('fs');
const D = require('./db');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const inspect = argv.includes('--inspect');
const file = process.env.SKYM3D_DB || D.DB_FILE;

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  sky.m3d.pro · droneDrop — instalador de banco dinâmico      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`  arquivo .....: ${file}`);
console.log(`  modo ........: ${force ? 'REINSTALAÇÃO (--force)' : D.isInstalled ? 'verificação' : 'instalação inicial'}\n`);

if (force) for (const suffix of ['', '-wal', '-shm']) { const f = file + suffix; if (fs.existsSync(f)) fs.unlinkSync(f); }

const db = D.openDb(file);
if (D.isInstalled(db) && !force) {
  const v = D.meta(db, 'schema_version');
  console.log(`  banco existente detectado (schema ${v}, instalado em ${D.meta(db, 'installed_at')})`);
  if (v !== D.SCHEMA_VERSION) { console.log(`  migrando ${v} → ${D.SCHEMA_VERSION}`); D.install(db, { force: false }); }
  else console.log('  nada a fazer — use --force para recriar do zero.');
} else {
  const info = D.install(db, { force });
  console.log(`  instalação concluída · schema ${info.schema_version}`);
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
console.log('\n  tabelas e registros:');
for (const { name } of tables) {
  const c = db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
  console.log(`    ${name.padEnd(20)} ${String(c).padStart(5)}`);
}
if (inspect) {
  console.log('\n  usuários criados:');
  db.prepare('SELECT name,email,role,org FROM users ORDER BY role').all()
    .forEach((u) => console.log(`    ${u.role.padEnd(12)} ${u.email.padEnd(30)} ${u.name}`));
  console.log('\n  rede de nós:');
  db.prepare('SELECT code,name,kind,charger_kw,capacity_slots,is_primary_entry,is_recharge FROM network_nodes ORDER BY code').all()
    .forEach((n) => console.log(`    ${n.code}  ${n.kind.padEnd(9)} ${n.name.padEnd(30)} ${n.charger_kw} kW · ${n.capacity_slots} slots${n.is_primary_entry ? ' · entrada' : ''}${n.is_recharge ? ' · recarga' : ''}`));
  console.log('\n  passos registrados em install_log:');
  db.prepare('SELECT ts,step,status,detail FROM install_log ORDER BY ts').all()
    .forEach((s) => console.log(`    [${s.status}] ${s.step} — ${s.detail}`));
}
console.log(`\n  pronto. Inicie a plataforma com:  npm start   (login: admin@sky.m3d.pro / sky2026)\n`);
db.close();
