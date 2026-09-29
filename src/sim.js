'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop — Motor de simulação
   Planejamento de rota com consciência de bateria, triangulação dinâmica,
   telemetria em tempo real, reroteamento emergencial e override de piloto.
   ============================================================================ */
const { uid, now } = require('./db');

const R_EARTH = 6371;
const ALLOWED_REASONS = ['weather', 'battery', 'hazard', 'regulator', 'manual'];
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function lerpPos(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

class Sim {
  constructor(db, ctx = {}) {
    this.db = db;
    this.ctx = ctx;                 // { bus(msg), log(level,actor,msg) }
    this.speed = Number(process.env.SKYM3D_SPEED || 8); // 1s real = 8s simulado
    this.runtime = new Map();       // mission_id -> estado vivo
    this.telBuffer = [];            // ring de telemetria recente
  }

  /* --------------------------------------------------------------- helpers */
  nodes() { return this.db.prepare('SELECT * FROM network_nodes').all(); }
  node(id) { return this.db.prepare('SELECT * FROM network_nodes WHERE node_id=?').get(id); }
  drones() { return this.db.prepare('SELECT d.*, m.brand, m.geom_json, m.rotors, m.class AS mclass, m.reserve_pct AS m_reserve, m.energy_base_wh, m.energy_per_km_wh, m.range_km AS model_range_km, m.dims_cm, m.weight_kg, m.notes FROM drones d JOIN drone_models m ON m.model_id=d.model_id').all(); }
  drone(id) { return this.drones().find((d) => d.drone_id === id); }
  busy(fn, ...a) { return this.db.transaction(fn).apply(this, a); }

  energyWh(drone, km, payloadKg) {
    const factor = 1 + (Number(payloadKg || 0) / Math.max(1, Number(drone.payload_kg_max))) * 0.4;
    return round((Number(drone.energy_base_wh) + km * Number(drone.energy_per_km_wh) * factor) * 1.06, 1);
  }
  airMin(drone, km, windKmh = 12) {
    const eff = Number(drone.cruise_kmh) * Math.max(0.72, 1 - windKmh / 160);
    return round((km / Math.max(8, eff)) * 60, 1);
  }
  nearestRecharge(node, excludeId) {
    const list = this.nodes().filter((n) => n.node_id !== excludeId && n.is_recharge && n.status !== 'offline');
    let best = null, bestD = Infinity;
    for (const n of list) { const d = haversineKm(node, n); if (d < bestD && d < 6) { bestD = d; best = n; } }
    return best || list.sort((a, b) => haversineKm(node, a) - haversineKm(node, b))[0] || null;
  }

  /* ------------------------------------------------------ planejamento rota */
  plan({ drone_id, origin_id, dest_id, payload_kg = 1, project_id, reserve_pct }) {
    const drone = this.drone(drone_id);
    if (!drone) throw new Error('drone inexistente');
    const origin = this.node(origin_id), dest = this.node(dest_id);
    if (!origin || !dest) throw new Error('nó inexistente');
    if (origin.node_id === dest.node_id) throw new Error('origem e destino iguais');

    const settings = this.db.prepare('SELECT * FROM sim_settings WHERE project_id=?').get(project_id) || { wind_kmh: 12, alt_m: 120 };
    const zone = this.db.prepare('SELECT MIN(min_soc_pct) m FROM airspace_zones WHERE project_id=?').get(project_id);
    const reserve = Number(reserve_pct ?? zone?.m ?? drone.reserve_pct ?? 22);
    const cap = Number(drone.battery_wh);
    const usable = Math.max(0, (drone.battery - reserve) / 100 * cap); // Wh disponíveis agora
    if (drone.status === 'maintenance') throw new Error(`aeronave ${drone.model} está em manutenção — não pode ser despachada`);
    if (usable <= 0) throw new Error(`SOC ${drone.battery}% abaixo da reserva mínima (${reserve}%) — despache o drone para recarga antes de planejar a rota`);
    const nodes = this.nodes();
    const legs = [];
    let cur = origin, socNow = Number(drone.battery), avail = usable, totalKm = 0, totalAir = 0, totalCharge = 0, totalWh = 0;

    for (let hop = 0; hop < 6; hop++) {
      const directKm = haversineKm(cur, dest);
      const directWh = this.energyWh(drone, directKm, payload_kg);
      if (directWh <= avail || hop === 5) {
        const km = round(directKm, 3);
        const wh = this.energyWh(drone, km, payload_kg);
        const arr = socNow - (wh / cap) * 100;
        legs.push({ seq: legs.length + 1, from: cur.node_id, to: dest.node_id, km, air_min: this.airMin(drone, km, settings.wind_kmh), energy_wh: wh, arrive_soc: round(arr, 1), pause_min: 0, target_soc: round(socNow, 1) });
        totalKm += km; totalAir += this.airMin(drone, km, settings.wind_kmh); totalWh += wh;
        cur = dest; break;
      }
      // procura nó de apoio à frente que deixe energia para continuar
      const cands = nodes
        .filter((n) => n.node_id !== cur.node_id && n.node_id !== dest.node_id && n.is_recharge)
        .map((n) => {
          const d1 = haversineKm(cur, n), d2 = haversineKm(n, dest);
          const w1 = this.energyWh(drone, d1, payload_kg), w2 = this.energyWh(drone, d2, payload_kg);
          return { n, d1, d2, w1, w2, detour: d1 + d2 - directKm, fitsNow: w1 <= avail, fitsNext: w2 <= (cap * 0.8) };
        })
        .filter((c) => c.fitsNow && c.fitsNext)
        .sort((a, b) => a.detour - b.detour);
      let pick = cands[0];
      if (!pick) {
        // sem nó que cubra origem+destino: escolhe o recarregável mais próximo que a bateria alcance agora
        const reach = nodes.filter((n) => n.node_id !== cur.node_id && n.is_recharge && n.node_id !== dest.node_id)
          .map((n) => ({ n, d1: haversineKm(cur, n) }))
          .filter((c) => this.energyWh(drone, c.d1, payload_kg) <= avail)
          .sort((a, b) => (a.d1 + haversineKm(a.n, dest)) - (b.d1 + haversineKm(b.n, dest)));
        if (!reach.length) throw new Error('rota inviável: nenhum ponto de recarga alcançável com a bateria atual');
        pick = { n: reach[0].n, d1: reach[0].d1, d2: haversineKm(reach[0].n, dest) };
      }
      const km = round(pick.d1, 3);
      const wh = this.energyWh(drone, km, payload_kg);
      const airMin = this.airMin(drone, km, settings.wind_kmh);
      const arriveSoc = socNow - (wh / cap) * 100;
      const needWh = this.energyWh(drone, pick.d2, payload_kg);
      const targetSoc = Math.min(100, ((needWh / cap) * 100) + reserve + 6);
      const chargeNeededWh = Math.max(0, ((targetSoc - arriveSoc) / 100) * cap);
      const chargeMin = pick.n.charger_kw > 0 ? round((chargeNeededWh / (pick.n.charger_kw * 1000)) * 60 + 2.5, 1) : 45;
      legs.push({ seq: legs.length + 1, from: cur.node_id, to: pick.n.node_id, km, air_min: airMin, energy_wh: wh, arrive_soc: round(arriveSoc, 1), pause_min: chargeMin, target_soc: round(targetSoc, 1) });
      totalKm += km; totalAir += airMin; totalCharge += chargeMin; totalWh += wh;
      cur = pick.n; socNow = targetSoc; avail = ((targetSoc - reserve) / 100) * cap;
    }

    const result = {
      project_id, drone_id, origin_node_id: origin.node_id, dest_node_id: dest.node_id,
      legs, total_km: round(totalKm, 2), total_air_min: round(totalAir, 1), total_charge_min: round(totalCharge, 1),
      total_min: round(totalAir + totalCharge, 1), energy_wh: round(totalWh, 1),
      stops: legs.filter((l) => l.pause_min > 0).map((l) => this.node(l.to).code),
      reserve_pct: reserve, feasible: true
    };
    return result;
  }

  /* -------------------------------------------------------------- criar OS */
  createMission({ project_id, drone_id, origin_id, dest_id, payload_kg, package_id, autostart = false }) {
    const plan = this.plan({ drone_id, origin_id, dest_id, payload_kg, project_id });
    const drone = this.drone(drone_id);
    const mission_id = uid('msn');
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO missions(mission_id,project_id,package_id,drone_id,origin_node_id,dest_node_id,payload_kg,route_json,planned_km,
        planned_air_min,planned_charge_min,energy_wh,battery_at_start,status,current_leg,progress,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)`).run(
        mission_id, project_id, package_id || null, drone_id, origin_id, dest_id, payload_kg, JSON.stringify(plan),
        plan.total_km, plan.total_air_min, plan.total_charge_min, plan.energy_wh, drone.battery,
        autostart ? 'in_flight' : 'queued', now());
      const insLeg = this.db.prepare('INSERT INTO route_legs(leg_id,mission_id,seq,from_node_id,to_node_id,km,air_min,energy_wh,arrive_soc,pause_min,target_soc,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      plan.legs.forEach((l, i) => insLeg.run(uid('leg'), mission_id, l.seq, l.from, l.to, l.km, l.air_min, l.energy_wh, l.arrive_soc, l.pause_min, l.target_soc, i === 0 ? 'active' : 'upcoming'));
      if (package_id) {
        this.db.prepare("UPDATE packages SET status='in_transit' WHERE package_id=?").run(package_id);
        this.db.prepare('INSERT INTO package_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(uid('evt'), package_id, now(), 'in_transit', origin_id, drone_id, null, null, 'SYSTEM', null, null, 'sistema', `Missão ${mission_id.slice(-6)} despachada de ${this.node(origin_id).code}`);
      }
    });
    tx();
    if (autostart) this.start(mission_id);
    return { mission_id, plan };
  }

  /* --------------------------------------------------------------- runtime */
  start(mission_id) {
    const m = this.db.prepare('SELECT * FROM missions WHERE mission_id=?').get(mission_id);
    if (!m) throw new Error('missão inexistente');
    const legs = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(mission_id);
    const drone = this.drone(m.drone_id);
    const plan = JSON.parse(m.route_json);
    this.runtime.set(mission_id, {
      mission_id, drone_id: m.drone_id, legIndex: 0, legElapsed: 0,
      totalAir: plan.total_air_min, totalCharge: plan.total_charge_min,
      airDone: 0, chargeDone: 0, phase: 'air',
      soc: Number(drone.battery), payload: Number(m.payload_kg), plan,
      startedAt: Date.now(), holds: []
    });
    this.db.prepare("UPDATE missions SET status='in_flight', started_at=?, current_leg=0, progress=0 WHERE mission_id=?").run(now(), mission_id);
    this.db.prepare("UPDATE drones SET status='in_flight', payload_kg_now=? WHERE drone_id=?").run(m.payload_kg, m.drone_id);
    this.log('INFO', 'sim', `Missão ${mission_id.slice(-6)} iniciada — ${plan.legs.length} perna(s), ${plan.total_km} km`);
    return this.liveState(mission_id);
  }

  liveState(mission_id) {
    const rt = this.runtime.get(mission_id);
    const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(mission_id);
    const plan = JSON.parse(this.db.prepare('SELECT route_json FROM missions WHERE mission_id=?').get(mission_id).route_json);
    const cur = rows[Math.min(rt ? rt.legIndex : 0, rows.length - 1)] || rows[0];
    const from = this.node(cur.from_node_id), to = this.node(cur.to_node_id);
    const tel = this.telBuffer.filter((t) => t.mission_id === mission_id).slice(-1)[0] || null;
    const etaNext = rt ? round(Math.max(0, cur.air_min - rt.legElapsed), 1) : cur.air_min;
    let remaining = 0;
    if (rt) {
      remaining = plan.total_air_min - rt.airDone + Math.max(0, plan.total_charge_min - rt.chargeDone);
    } else remaining = plan.total_min;
    return {
      mission_id, phase: rt ? rt.phase : 'idle', legIndex: rt ? rt.legIndex : 0, legs: rows.length,
      current_leg: cur, from, to, leg: { seq: cur.seq, from_code: from.code, to_code: to.code, km: cur.km, air_min: cur.air_min, pause_min: cur.pause_min },
      position: tel ? { lat: tel.lat, lon: tel.lon, alt_m: tel.alt_m, heading: tel.heading, speed_kmh: tel.speed_kmh } : { lat: from.lat, lon: from.lon, alt_m: 0, heading: 0, speed_kmh: 0 },
      battery: rt ? round(rt.soc, 1) : null, eta_next_min: etaNext, eta_final_min: round(remaining, 1),
      progress: rt ? round((rt.airDone + rt.chargeDone) / Math.max(1, plan.total_min) * 100, 1) : 0,
      dist_remaining_km: round(this.remainingKm(mission_id), 2), plan,
      passed_nodes: rows.filter((r) => r.status === 'done').map((r) => this.node(r.to_node_id).code)
    };
  }

  remainingKm(mission_id) {
    const rt = this.runtime.get(mission_id);
    const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(mission_id);
    if (!rows.length) return 0;
    let d = 0;
    for (let i = rt ? rt.legIndex : 0; i < rows.length; i++) {
      let km = rows[i].km;
      if (rt && i === rt.legIndex && rows[i].air_min > 0) km = km * (1 - Math.min(1, rt.legElapsed / rows[i].air_min));
      d += km;
    }
    return d;
  }

  /* ------------------------------------------------------------------ tick */
  tick() {
    const dtSim = this.speed; // segundos simulados por tick
    const t = new Date().toISOString();
    const actives = this.db.prepare("SELECT * FROM missions WHERE status IN ('in_flight','charging','rerouted')").all();
    for (const m of actives) {
      if (!this.runtime.has(m.mission_id)) { this.runtime.set(m.mission_id, this.rehydrate(m)); }
      const rt = this.runtime.get(m.mission_id);
      const drone = this.drone(rt.drone_id);
      const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(m.mission_id);
      const leg = rows[rt.legIndex];
      if (!leg) { this.finish(m.mission_id, 'done'); continue; }
      const from = this.node(leg.from_node_id), to = this.node(leg.to_node_id);
      const settings = this.db.prepare('SELECT * FROM sim_settings WHERE project_id=?').get(m.project_id) || { alt_m: 120, wind_kmh: 12 };

      if (rt.phase === 'air') {
        rt.legElapsed += dtSim / 60;
        rt.airDone += dtSim / 60;
        const frac = Math.min(1, rt.legElapsed / Math.max(0.1, leg.air_min));
        const p = lerpPos(from, to, frac);
        const drain = (leg.energy_wh / Math.max(0.1, leg.air_min)) * (dtSim / 60) / Number(drone.battery_wh) * 100;
        rt.soc = Math.max(0.5, rt.soc - drain);
        const tel = {
          mission_id: m.mission_id, drone_id: rt.drone_id, ts: t, lat: p.lat, lon: p.lon,
          alt_m: settings.alt_m + Math.sin(Date.now() / 9000) * 6, speed_kmh: drone.cruise_kmh * (0.94 + Math.random() * 0.08),
          heading: bearing(from, to), battery: round(rt.soc, 1), signal: 88 + Math.round(Math.random() * 11),
          temp_c: 32 + Math.random() * 8, wind_kmh: settings.wind_kmh, phase: 'air',
          eta_next_min: round(Math.max(0, leg.air_min - rt.legElapsed), 1),
          eta_final_min: round(this.remainingMinutes(rt), 1), dist_remaining_km: round(this.remainingKm(m.mission_id), 2)
        };
        this.pushTelemetry(tel);
        this.db.prepare('UPDATE drones SET lat=?,lon=?,alt_m=?,heading=?,speed_kmh=?,battery=?,signal=? WHERE drone_id=?')
          .run(p.lat, p.lon, tel.alt_m, tel.heading, tel.speed_kmh, tel.battery, tel.signal, rt.drone_id);
        this.db.prepare('UPDATE missions SET progress=?, current_leg=?, eta_final=? WHERE mission_id=?')
          .run(round((rt.airDone + rt.chargeDone) / Math.max(1, rt.totalAir + rt.totalCharge) * 100, 1), rt.legIndex,
            new Date(Date.now() + this.remainingMinutes(rt) * 60000).toISOString(), m.mission_id);

        // bateria crítica -> reroteamento automático
        if (tel.battery <= Number(drone.reserve_pct) + 3 && leg.pause_min === 0 && rt.legIndex < rows.length - 1) {
          this.autoDiversion(m.mission_id, 'battery', tel.battery);
        }
        if (tel.battery <= 12) this.alert('red', 'BAT_CRIT', `Bateria crítica ${tel.battery}% — pouso no ponto mais próximo`, rt.drone_id, m.mission_id, to.node_id);

        if (frac >= 1) {
          this.db.prepare("UPDATE route_legs SET status='done', closed_at=? WHERE leg_id=?").run(t, leg.leg_id);
          const next = rows[rt.legIndex + 1];
          if (next) {
            this.db.prepare("UPDATE route_legs SET status='active', launched_at=? WHERE leg_id=?").run(t, next.leg_id);
          }
          if (leg.pause_min > 0 && rt.legIndex < rows.length - 1) {
            rt.phase = 'charge'; rt.legElapsed = 0;
            this.db.prepare("UPDATE missions SET status='charging' WHERE mission_id=?").run(m.mission_id);
            this.db.prepare("UPDATE drones SET status='charging', speed_kmh=0, alt_m=?, lat=?, lon=? WHERE drone_id=?").run(to.elev_m + 1, to.lat, to.lon, rt.drone_id);
            this.db.prepare('UPDATE network_nodes SET occupancy=MIN(capacity_slots, occupancy+1) WHERE node_id=?').run(to.node_id);
            this.alert('amber', 'RECHARGE', `${drone.model} recarregando em ${to.code} (${leg.target_soc}% alvo)`, rt.drone_id, m.mission_id, to.node_id);
            this.event(m.mission_id, 'at_hub', to.node_id, 'Chegou ao ponto de recarga');
          } else {
            rt.legIndex++; rt.legElapsed = 0;
            if (rt.legIndex >= rows.length) this.finish(m.mission_id, 'done');
          }
        }
      } else if (rt.phase === 'charge') {
        const needed = leg.target_soc - rt.soc;
        const perSec = (to.charger_kw * 1000 / Number(drone.battery_wh)) * 100 * (dtSim / 3600);
        rt.soc = Math.min(leg.target_soc, rt.soc + perSec);
        rt.chargeDone += dtSim / 60;
        this.pushTelemetry({
          mission_id: m.mission_id, drone_id: rt.drone_id, ts: t, lat: to.lat, lon: to.lon, alt_m: to.elev_m + 1,
          speed_kmh: 0, heading: 0, battery: round(rt.soc, 1), signal: 97, temp_c: 30, wind_kmh: settings.wind_kmh,
          phase: 'charging', eta_next_min: round(Math.max(0, (needed / Math.max(0.5, perSec)) * dtSim / 60), 1),
          eta_final_min: round(this.remainingMinutes(rt), 1), dist_remaining_km: round(this.remainingKm(m.mission_id), 2)
        });
        this.db.prepare('UPDATE drones SET battery=?, alt_m=? WHERE drone_id=?').run(round(rt.soc, 1), to.elev_m + 1, rt.drone_id);
        if (rt.soc >= leg.target_soc - 0.4) {
          rt.phase = 'air'; rt.legElapsed = 0; rt.legIndex++;
          this.db.prepare('UPDATE network_nodes SET occupancy=MAX(0, occupancy-1) WHERE node_id=?').run(to.node_id);
          this.db.prepare('UPDATE drones SET status=?, speed_kmh=? WHERE drone_id=?').run('in_flight', drone.cruise_kmh, rt.drone_id);
          if (rt.legIndex < rows.length) {
            this.db.prepare("UPDATE route_legs SET status='active', launched_at=? WHERE leg_id=?").run(t, rows[rt.legIndex].leg_id);
            this.db.prepare("UPDATE missions SET status='in_flight' WHERE mission_id=?").run(m.mission_id);
          } else this.finish(m.mission_id, 'done');
        }
      }
    }
    // triangulação + broadcast
    const tri = this.triangulation();
    if (this.ctx.bus) {
      this.ctx.bus({ type: 'telemetry', ts: t, telemetry: this.telBuffer.slice(-24), triangulation: tri, live: actives.map((m) => m.mission_id).map((id) => { try { return this.liveState(id); } catch { return null; } }).filter(Boolean) });
    }
    return { tick: t, active: actives.length, telemetry: this.telBuffer.length };
  }

  remainingMinutes(rt) {
    return Math.max(0, (rt.totalAir - rt.airDone) + (rt.totalCharge - rt.chargeDone));
  }
  rehydrate(m) {
    const plan = JSON.parse(m.route_json);
    const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(m.mission_id);
    const d = this.drone(m.drone_id);
    const airDone = rows.filter((r) => r.status === 'done').reduce((s, r) => s + r.air_min, 0);
    return {
      mission_id: m.mission_id, drone_id: m.drone_id, legIndex: m.current_leg, legElapsed: 0,
      totalAir: plan.total_air_min, totalCharge: plan.total_charge_min, airDone,
      chargeDone: rows.filter((r) => r.status === 'done' && r.pause_min > 0).reduce((s, r) => s + r.pause_min, 0),
      phase: m.status === 'charging' ? 'charge' : 'air', soc: Number(d.battery), payload: Number(m.payload_kg),
      plan, startedAt: Date.now(), holds: []
    };
  }

  pushTelemetry(tel) {
    tel.telemetry_id = uid('tel');
    try {
      this.db.prepare(`INSERT INTO telemetry(telemetry_id,mission_id,drone_id,ts,lat,lon,alt_m,speed_kmh,heading,battery,signal,temp_c,wind_kmh,phase,eta_next_min,eta_final_min,dist_remaining_km)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tel.telemetry_id, tel.mission_id, tel.drone_id, tel.ts, tel.lat, tel.lon, tel.alt_m, tel.speed_kmh, tel.heading, tel.battery, tel.signal, tel.temp_c, tel.wind_kmh, tel.phase, tel.eta_next_min, tel.eta_final_min, tel.dist_remaining_km);
    } catch { /* ignora */ }
    this.telBuffer.push(tel);
    if (this.telBuffer.length > 600) this.telBuffer.splice(0, this.telBuffer.length - 600);
    return tel;
  }

  finish(mission_id, status = 'done') {
    const m = this.db.prepare('SELECT * FROM missions WHERE mission_id=?').get(mission_id);
    if (!m) return;
    const drone = this.drone(m.drone_id);
    this.runtime.delete(mission_id);
    this.db.prepare('UPDATE missions SET status=?, ended_at=?, progress=100 WHERE mission_id=?').run(status, now(), mission_id);
    this.db.prepare('UPDATE route_legs SET status=? WHERE mission_id=? AND status IN (\'active\')').run('done', mission_id);
    this.db.prepare("UPDATE drones SET status='active', speed_kmh=0, alt_m=0, payload_kg_now=0, node_id=? WHERE drone_id=?").run(m.dest_node_id, m.drone_id);
    if (m.package_id) {
      this.db.prepare("UPDATE packages SET status='delivered', delivered_at=? WHERE package_id=?").run(now(), m.package_id);
      this.event(m.package_id, 'delivered', m.dest_node_id, 'Entregue no destino final', 'QR');
    }
    this.alert('green', 'DELIVERED', `${drone.model} concluiu ${mission_id.slice(-6)} — entrega confirmada`, m.drone_id, mission_id, m.dest_node_id);
    this.log('INFO', 'sim', `Missão ${mission_id.slice(-6)} concluída`);
  }

  event(package_id, status, node_id, detail, method = 'SYSTEM') {
    try {
      this.db.prepare('INSERT INTO package_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(uid('evt'), package_id, now(), status, node_id, null, null, null, method, null, null, 'sistema', detail);
    } catch { /* ignora */ }
  }

  alert(severity, code, message, drone_id = null, mission_id = null, node_id = null) {
    const id = uid('alt');
    this.db.prepare('INSERT INTO alerts(alert_id,project_id,ts,severity,code,message,drone_id,mission_id,node_id,ack,acked_by,acked_at) VALUES(?,?,?,?,?,?,?,?,?,0,null,null)')
      .run(id, this.ctx.projectId || null, now(), severity, code, message, drone_id, mission_id, node_id);
    if (this.ctx.bus) this.ctx.bus({ type: 'alert', alert: { alert_id: id, ts: now(), severity, code, message, drone_id, mission_id, node_id, ack: 0 } });
    return id;
  }

  log(level, actor, message) {
    this.db.prepare('INSERT INTO event_log VALUES(?,?,?,?,?)').run(uid('log'), now(), level, actor, message);
    if (this.ctx.bus) this.ctx.bus({ type: 'log', log: { ts: now(), level, actor, message } });
  }

  /* ------------------------------------------------- reroteamento/override */
  autoDiversion(mission_id, reason, battery) {
    const rt = this.runtime.get(mission_id);
    if (!rt) return null;
    const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(mission_id);
    const leg = rows[rt.legIndex];
    const dest = this.node(leg.to_node_id), from = this.node(leg.from_node_id);
    const hold = this.nearestRecharge(dest, dest.node_id) || from;
    const m = this.db.prepare('SELECT * FROM missions WHERE mission_id=?').get(mission_id);
    const newRoute = JSON.stringify({
      emergency: true, reason, ts: now(),
      hold_node: hold.code, original_dest: this.node(m.dest_node_id).code,
      legs: [{ seq: 1, from: dest.code, to: hold.code, km: round(haversineKm(dest, hold), 2) }]
    });
    this.db.prepare('INSERT INTO diversions(diversion_id,mission_id,ts,reason,from_node_id,to_node_id,hold_node_id,new_route_json,recalculated_eta,approved_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid('div'), mission_id, now(), reason, from.node_id, dest.node_id, hold.node_id, newRoute,
        new Date(Date.now() + 12 * 60000).toISOString(), 'sistema:auto', `Desvio automático por ${reason} (bateria ${battery ?? '—'}%)`);
    this.db.prepare("UPDATE missions SET status='rerouted' WHERE mission_id=?").run(mission_id);
    this.db.prepare("UPDATE camera_points SET mode='emergency' WHERE project_id=?").run(m.project_id);
    this.alert(reason === 'battery' ? 'red' : 'amber', reason === 'battery' ? 'REROUTE_BAT' : 'REROUTE_WX',
      `Rota emergencial calculada: desvio para ${hold.code} (recarga) — destino final reprogramado após estabilização`, m.drone_id, mission_id, hold.node_id);
    this.db.prepare('INSERT INTO safety_reports VALUES(?,?,?,?,?,?,?,?,?)').run(uid('saf'), mission_id, this.ctx.projectId || null, now(),
      reason === 'battery' ? 'Reserva de energia violada em corredor urbano' : 'Rajada de vento acima do limite operacional',
      'medio', `Desvio para ${hold.code}; recálculo de destino após análise de segurança`, null, 'sistema');
    this.log('WARN', 'routing', `Divergência ${reason} na missão ${mission_id.slice(-6)} → ${hold.code}`);
    return hold;
  }

  manualReroute(mission_id, { to_node_id, reason = 'manual', by = 'piloto' }) {
    if (!ALLOWED_REASONS.includes(reason)) reason = 'manual';
    const rt = this.runtime.get(mission_id);
    if (!rt) throw new Error('missão não está ativa');
    const rows = this.db.prepare('SELECT * FROM route_legs WHERE mission_id=? ORDER BY seq').all(mission_id);
    const leg = rows[rt.legIndex];
    const target = this.node(to_node_id);
    const newLegs = [{ seq: rows.length + 1, from_node_id: leg.to_node_id, to_node_id: target.node_id, km: round(haversineKm(this.node(leg.to_node_id), target), 2) }];
    const drone = this.drone(rt.drone_id);
    const km = newLegs[0].km;
    const wh = this.energyWh(drone, km, rt.payload);
    const airMin = this.airMin(drone, km, 12);
    if (wh > ((rt.soc - Number(drone.reserve_pct)) / 100) * Number(drone.battery_wh)) {
      throw new Error(`Energia insuficiente para o desvio (${rt.soc}% SOC, reserva ${drone.reserve_pct}%)`);
    }
    this.db.prepare('INSERT INTO route_legs(leg_id,mission_id,seq,from_node_id,to_node_id,km,air_min,energy_wh,arrive_soc,pause_min,target_soc,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid('leg'), mission_id, rows.length + 1, leg.to_node_id, target.node_id, km, airMin, wh,
        round(rt.soc - (wh / Number(drone.battery_wh)) * 100, 1), target.is_recharge ? 20 : 0, rt.soc, 'upcoming');
    this.db.prepare('INSERT INTO diversions(diversion_id,mission_id,ts,reason,from_node_id,to_node_id,hold_node_id,new_route_json,recalculated_eta,approved_by,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(uid('div'), mission_id, now(), reason, leg.from_node_id, leg.to_node_id, target.node_id, JSON.stringify({ legs: newLegs }),
        new Date(Date.now() + (airMin + 5) * 60000).toISOString(), by, 'Desvio manual autorizado por piloto emergencial');
    this.alert('amber', 'MANUAL_REROUTE', `Rota alterada manualmente por ${by} → ${target.code}`, rt.drone_id, mission_id, target.node_id);
    this.log('WARN', by, `Reroteamento manual da missão ${mission_id.slice(-6)} para ${target.code}`);
    return { ok: true, to: target.code, km, air_min: airMin };
  }

  override(mission_id, { action, payload = {}, by = 'piloto@sky.m3d.pro' }) {
    const rt = this.runtime.get(mission_id) || this.rehydrate(this.db.prepare('SELECT * FROM missions WHERE mission_id=?').get(mission_id));
    if (!rt) throw new Error('missão inexistente');
    const drone = this.drone(rt.drone_id);
    switch (action) {
      case 'hold': {
        this.db.prepare("UPDATE missions SET status='hold' WHERE mission_id=?").run(mission_id);
        this.db.prepare("UPDATE drones SET status='standby', speed_kmh=0 WHERE drone_id=?").run(rt.drone_id);
        rt.holds.push({ ts: now(), by, reason: payload.reason || 'ordem do piloto' });
        this.alert('amber', 'OVERRIDE_HOLD', `Voo suspenso por piloto emergencial ${by}: ${payload.reason || 'aguardando liberação'}`, rt.drone_id, mission_id, null);
        break;
      }
      case 'resume': {
        this.db.prepare("UPDATE missions SET status='in_flight' WHERE mission_id=?").run(mission_id);
        this.db.prepare("UPDATE drones SET status='in_flight', speed_kmh=? WHERE drone_id=?").run(drone.cruise_kmh, rt.drone_id);
        this.alert('green', 'OVERRIDE_RESUME', `Voo retomado por ${by}`, rt.drone_id, mission_id, null);
        break;
      }
      case 'emergency_landing': {
        const hold = this.nearestRecharge(this.node(rt.plan.legs[rt.legIndex].to), null);
        this.db.prepare("UPDATE missions SET status='hold', route_json=? WHERE mission_id=?").run(JSON.stringify(rt.plan), mission_id);
        this.alert('red', 'EMERG_LAND', `Pouso emergencial em ${hold ? hold.code : 'área livre'} por ${by}`, rt.drone_id, mission_id, hold ? hold.node_id : null);
        break;
      }
      case 'redirect': return this.manualReroute(mission_id, { to_node_id: payload.to_node_id, reason: ALLOWED_REASONS.includes(payload.reason) ? payload.reason : 'manual', by });
      case 'camera_reorient': {
        this.db.prepare("UPDATE camera_points SET mode='manual', azimuth=?, tilt=?, zoom=? WHERE cam_id=?").run(payload.azimuth ?? 0, payload.tilt ?? -18, payload.zoom ?? 1.6, payload.cam_id);
        this.alert('info', 'CAM_REORIENT', `Câmera ${payload.cam_id} reorientada por ${by} para acompanhar a carga`, rt.drone_id, mission_id, null);
        break;
      }
      default: throw new Error('ação de override desconhecida');
    }
    this.log('WARN', by, `Override ${action} na missão ${mission_id.slice(-6)}`);
    return { ok: true, action };
  }

  /* ------------------------------------------------------- triangulação */
  triangulation(project_id) {
    const nodes = this.nodes().filter((n) => !project_id || n.project_id === project_id);
    const missions = this.db.prepare("SELECT * FROM missions WHERE status IN ('in_flight','charging','rerouted','queued','planned')" + (project_id ? ' AND project_id=?' : '')).all(...(project_id ? [project_id] : []));
    const rows = nodes.map((n) => {
      let incoming = 0, outgoing = 0, inboundKg = 0, outboundKg = 0;
      for (const m of missions) {
        const plan = JSON.parse(m.route_json);
        if (m.origin_node_id === n.node_id) { outgoing++; outboundKg += Number(m.payload_kg); }
        if (m.dest_node_id === n.node_id) { incoming++; inboundKg += Number(m.payload_kg); }
        plan.legs.forEach((l) => { if (l.to === n.node_id && l.pause_min > 0) incoming++; });
      }
      const packagesAtNode = this.db.prepare("SELECT COUNT(*) c FROM packages WHERE (origin_node_id=? OR dest_node_id=?) AND status NOT IN ('delivered','returned')").get(n.node_id, n.node_id).c;
      const imbalance = incoming - outgoing;
      return {
        node_id: n.node_id, code: n.code, name: n.name, kind: n.kind, lat: n.lat, lon: n.lon,
        occupancy: n.occupancy, capacity_slots: n.capacity_slots, pads: n.pads, charger_kw: n.charger_kw,
        incoming, outgoing, inbound_kg: round(inboundKg, 1), outbound_kg: round(outboundKg, 1),
        imbalance, packages_at_node: packagesAtNode, is_recharge: !!n.is_recharge,
        load_pct: round((n.occupancy / Math.max(1, n.capacity_slots)) * 100, 1),
        vector_deg: (outgoing || incoming) ? round((Math.atan2(outboundKg - inboundKg, outgoing - incoming || 0.001) * 180) / Math.PI, 1) : 0
      };
    });
    const totalIn = rows.reduce((s, r) => s + r.incoming, 0), totalOut = rows.reduce((s, r) => s + r.outgoing, 0);
    return {
      ts: now(), nodes: rows.sort((a, b) => (b.incoming + b.outgoing) - (a.incoming + a.outgoing)),
      total_incoming: totalIn, total_outgoing: totalOut, net: totalIn - totalOut,
      balance_index: round((totalIn / Math.max(1, totalIn + totalOut)) * 100, 1),
      active_missions: missions.length
    };
  }

  /* --------------------------------------------------- mapeamento preditivo */
  predictive(package_id) {
    const pkg = this.db.prepare('SELECT * FROM packages WHERE package_id=?').get(package_id);
    if (!pkg) throw new Error('pacote inexistente');
    const mission = this.db.prepare("SELECT * FROM missions WHERE package_id=? ORDER BY created_at DESC LIMIT 1").get(package_id);
    const events = this.db.prepare('SELECT * FROM package_events WHERE package_id=? ORDER BY ts').all(package_id);
    const origin = this.node(pkg.origin_node_id), dest = this.node(pkg.dest_node_id);
    const plan = mission ? JSON.parse(mission.route_json) : this.plan({ drone_id: this.drones()[0].drone_id, origin_id: pkg.origin_node_id, dest_id: pkg.dest_node_id, payload_kg: pkg.weight_kg, project_id: pkg.project_id });
    const stops = plan.legs.map((l, i) => ({
      seq: l.seq, from: this.node(l.from)?.code, to: this.node(l.to)?.code, km: l.km, air_min: l.air_min,
      arrive_soc: l.arrive_soc, recharge_min: l.pause_min, kind: l.pause_min > 0 ? 'recarga' : (i === plan.legs.length - 1 ? 'entrega' : 'passagem'),
      lat: this.node(l.to)?.lat, lon: this.node(l.to)?.lon
    }));
    return {
      package: pkg, origin, dest, stops, predicted_km: plan.total_km, predicted_min: plan.total_min,
      predicted_eta: new Date(Date.now() + plan.total_min * 60000).toISOString(),
      mission: mission ? { mission_id: mission.mission_id, status: mission.status, drone_id: mission.drone_id } : null,
      events, tags: this.db.prepare('SELECT * FROM rfid_tags WHERE package_id=?').all(package_id)
    };
  }
}

module.exports = { Sim, haversineKm, bearing, lerpPos };
