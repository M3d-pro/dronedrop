'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop v0.2 — Núcleo da aplicação (UI + API + WebSocket)
   ============================================================================ */
const App = (() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (v === null || v === undefined || isNaN(v)) ? '—' : (+v).toFixed(d);
  const hhmm = (iso) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const dt = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const roleName = { admin: 'Administrador', sender: 'Remetente', recipient: 'Destinatário', hub: 'Estação de distribuição', drone_owner: 'Proprietário de drone', pilot: 'Piloto emergencial', regulator: 'Entidade reguladora' };
  const kindName = { depot: 'Estação de distribuição', rooftop: 'Rooftop pod', micro: 'Micro-hub', support: 'Ponto de apoio', entry: 'Ponto de entrada primário' };
  const kindIco = { depot: '🏭', rooftop: '🏢', micro: '🏪', support: '⛺', entry: '🚪' };

  const S = {
    token: localStorage.getItem('skym3d_token') || '',
    user: null, overview: null, project: null, selDrone: null, selPkg: null, selMission: null,
    live: {}, fps: 60, ws: null, cam: null, pkgFilter: null, reorient: { azimuth: 40, toggle: 1 }
  };

  /* ------------------------------------------------------------------ api */
  async function api(path, opts = {}) {
    const h = { 'Content-Type': 'application/json' };
    if (S.token) h.Authorization = 'Bearer ' + S.token;
    const r = await fetch(path, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || r.statusText);
    return data;
  }
  function toast(msg, kind = 'info') {
    const map = { info: 'b-info', ok: 'b-ok', warn: 'b-warn', err: 'b-red' };
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="badge ${map[kind] || 'b-info'}">${kind.toUpperCase()}</span> ${esc(msg)}`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }
  function modal(html, cls = '') {
    const back = document.createElement('div');
    back.className = 'back';
    back.innerHTML = `<div class="modal ${cls}">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    $('#modals').appendChild(back);
    return back;
  }
  const closeModals = () => $$('.back').forEach((b) => { if (b.id !== 'boot') b.remove(); });

  /* ------------------------------------------------------------- installer */
  async function boot() {
    const steps = $('#boot-steps');
    try {
      const st = await api('/api/installer/status');
      const lines = [];
      lines.push(`<div class="row" style="gap:8px"><span class="badge ${st.installed ? 'b-ok' : 'b-warn'}">${st.installed ? 'INSTALADO' : 'PENDENTE'}</span>
        <span class="badge b-info">SCHEMA ${esc(st.schema_version || '—')}</span>
        <span class="badge ${st.autoconfig === 'OK' ? 'b-ok' : 'b-warn'}">AUTOCONFIG: ${esc(st.autoconfig || '—')}</span></div>`);
      lines.push(`<div class="kv"><span>Banco</span><b>${esc(st.db_file)} · ${st.db_size_kb} KB</b></div>`);
      lines.push(`<div class="kv"><span>Tabelas criadas</span><b>${st.tables.length}</b></div>`);
      lines.push(`<div class="kv"><span>Instalado em</span><b>${dt(st.installed_at)}</b></div>`);
      lines.push(`<div class="mini" style="margin-top:8px">${st.tables.map((t) => `<span class="chipx">${esc(t)} <b>${st.counts[t] ?? 0}</b></span>`).join(' ')}</div>`);
      steps.innerHTML = lines.join('');
      $('#boot-run').style.display = st.installed ? 'none' : 'inline-flex';
      $('#boot-login').style.display = st.installed ? 'grid' : 'none';
      $('#boot-go').style.display = st.installed ? 'inline-flex' : 'none';
      $('#boot-reinstall').style.display = st.installed ? 'inline-flex' : 'none';
      $('#boot-hint').innerHTML = st.installed
        ? 'Banco dinâmico ativo. Contas demo (senha <b>sky2026</b>): admin · remetente · destinatario · hub · drone · piloto · reguladora.'
        : 'Nenhum banco encontrado: clique em <b>Instalar e iniciar</b> para criar o schema, os usuários, a rede de nós, a frota e o catálogo 3D automaticamente.';
      if (st.installed) {
        const demo = await api('/api/auth/demo');
        $('#boot-users').style.display = 'block';
        $('#boot-users').innerHTML = `<div class="mini" style="margin-bottom:4px">Perfis disponíveis</div>` + demo.map((u) =>
          `<div class="urow" style="cursor:pointer" onclick="document.getElementById('lg-user').value='${esc(u.email)}'"><div class="av">${esc(u.name.slice(0, 2).toUpperCase())}</div>
           <div><div class="n">${esc(u.name)}</div><div class="r">${esc(u.email)} · ${roleName[u.role] || u.role}</div></div>
           <span class="pill k-${u.role}" style="margin-left:auto">${esc(u.role)}</span></div>`).join('');
        if (S.token) { try { await refresh(); $('#boot').classList.add('hidden'); } catch { /* segue no login */ } }
      }
    } catch (e) {
      steps.innerHTML = `<span class="badge b-red">ERRO</span> ${esc(e.message)} — verifique se o servidor (node src/server.js) está ativo.`;
    }
  }

  async function runInstaller(force) {
    try {
      $('#boot-steps').innerHTML = '<span class="badge b-info">EXECUTANDO</span> criando schema, seeds e autoconfiguração…';
      const out = await api('/api/installer/run', { method: 'POST', body: { force } });
      toast(`Instalação concluída — schema ${out.schema_version}`, 'ok');
      await boot();
      if (S.token) await refresh();
    } catch (e) {
      if (String(e.message).includes('permissão') || String(e.message).includes('autenticação')) {
        const st = await api('/api/installer/status');
        if (st.installed) { toast('Banco já instalado — informe as credenciais para reinstalar', 'warn'); $('#boot-login').style.display = 'grid'; $('#boot-go').style.display = 'inline-flex'; }
      } else toast(e.message, 'err');
    }
  }

  async function login() {
    try {
      const out = await api('/api/auth/login', { method: 'POST', body: { email: $('#lg-user').value, password: $('#lg-pass').value } });
      S.token = out.token; S.user = out.user; localStorage.setItem('skym3d_token', out.token);
      $('#boot').classList.add('hidden');
      await refresh(); connect();
      toast(`Bem-vindo(a), ${out.user.name}`, 'ok');
      openInstallerOnce();
    } catch (e) { toast(e.message, 'err'); }
  }
  function logout() { S.token = ''; localStorage.removeItem('skym3d_token'); location.reload(); }

  let installerShown = false;
  function openInstallerOnce() { /* placeholder — instalador acessível pelo botão */ }

  /* ------------------------------------------------------------- refresh */
  async function refresh() {
    if (!S.token) return;
    if (!S.user) S.user = await api('/api/auth/me');
    const proj = S.project || ($('#proj').value || undefined);
    const o = await api('/api/overview' + (proj ? '?project_id=' + proj : ''));
    S.overview = o; S.project = o.project?.project_id || null;
    $('#me-name').textContent = S.user.name; $('#me-role').textContent = (roleName[S.user.role] || S.user.role) + ' · ' + (S.user.plan || 'Pro');
    $('#av').textContent = S.user.name.slice(0, 2).toUpperCase();
    const ps = $('#proj');
    if (ps.options.length !== o.projects.length) ps.innerHTML = o.projects.map((p) => `<option value="${p.project_id}">${esc(p.name)}</option>`).join('');
    ps.value = S.project || ps.value;
    S.project && Scene.setProject(o);
    render(o);
    if (!S.selDrone && o.fleet.length) S.selDrone = o.fleet[0].drone_id;
    if (!S.selPkg && o.packages.length) S.selPkg = o.packages[0].package_id;
    renderPackage();
    return o;
  }

  function render(o) {
    // status bar + header
    const k = o.kpis;
    $('#sb-nodes').textContent = k.nodes; $('#sb-fleet').textContent = `${k.drones} (${k.drones_in_flight} em voo)`;
    $('#sb-km').textContent = fmt(k.km_flown, 1); $('#sb-kwh').textContent = fmt(k.energy_kwh, 1);
    $('#sb-zone').textContent = o.project?.name || '—';
    $('#sb-db').textContent = (o.installer?.db_size_kb ?? '—') + ' KB';
    $('#st-install').textContent = o.installer.installed ? 'ok' : 'pendente';
    $('#st-schema').textContent = o.installer.schema_version; $('#st-size').textContent = o.installer.db_size_kb + ' KB';
    $('#st-created').textContent = dt(o.installer.installed_at);
    $('#badge-autocfg').textContent = 'AUTOCONFIG: ' + (o.installer.autoconfig || '—');
    $('#pj-name').textContent = o.project?.name || '—'; $('#pj-city').textContent = o.project?.city || '—';
    $('#pj-badge').textContent = (o.project?.name || 'ALPHA').split(' ')[0].toUpperCase();
    $('#pj-active').textContent = o.missions.filter((m) => ['in_flight', 'charging', 'rerouted'].includes(m.status)).length;
    $('#wx-wind').textContent = fmt(o.settings?.wind_kmh, 1) + ' km/h';

    // usuários
    $('#users-count').textContent = o.users.length;
    $('#users').innerHTML = o.users.map((u) => `
      <div class="urow"><div class="av">${esc(u.name.slice(0, 2).toUpperCase())}</div>
        <div style="flex:1"><div class="n">${esc(u.name)}</div><div class="r">${esc(u.org || roleName[u.role] || '')}</div></div>
        <span class="pill k-${u.role}">${esc(u.role)}</span></div>`).join('');

    // frota lateral
    $('#fleetside').innerHTML = o.fleet.slice(0, 8).map((d) => {
      const col = d.battery > 55 ? '#10b981' : d.battery > 28 ? '#f59e0b' : '#f43f5e';
      return `<div class="fcard" onclick="App.selectDrone('${d.drone_id}')">
        <div class="fn"><span>${esc(d.model)}</span><span class="badge ${d.status === 'in_flight' ? 'b-info' : d.status === 'charging' ? 'b-warn' : d.status === 'maintenance' ? 'b-red' : 'b-ok'}">${esc(d.status)}</span></div>
        <div class="fs">${esc(d.serial)} · ${esc(d.owner_name || 'frota')} · ${d.node_code || '—'}</div>
        <div class="bar"><i style="width:${d.battery}%;background:${col}"></i></div>
        <div class="row" style="justify-content:space-between;margin-top:4px"><span class="mini">${fmt(d.battery)}% bateria</span><span class="mini">${fmt(d.speed_kmh)} km/h · ${fmt(d.payload_kg_now)} kg</span></div>
      </div>`;
    }).join('');

    // nós
    $('#nodes').innerHTML = o.nodes.map((n) => `
      <div class="node" onclick="Maps.focusNode('${n.node_id}')">
        <div class="ico">${kindIco[n.kind] || '📍'}</div>
        <div style="flex:1"><div class="n">${esc(n.code)} · ${esc(n.name)}</div>
          <div class="d">${kindName[n.kind] || n.kind} · ${n.occupancy}/${n.capacity_slots} slots · ${n.charger_kw} kW${n.is_recharge ? ' ⚡' : ''}${n.is_primary_entry ? ' 🚪entrada' : ''}</div></div>
        <span class="badge ${n.status === 'online' ? 'b-ok' : n.status === 'busy' ? 'b-warn' : 'b-red'}">${esc(n.status)}</span>
      </div>`).join('');

    // camadas
    $('#layertoggles').innerHTML = o.layers.map((l) => `
      <div class="between" style="font-size:11px;padding:3px 0">
        <span>${esc(l.type)}</span>
        <label class="sw" style="margin:0;width:30px;height:16px;background:${l.visibility ? '#0ea5e9' : '#cfe4fb'};border-radius:9px;position:relative;display:block">
          <input type="checkbox" ${l.visibility ? 'checked' : ''} onchange="App.toggleLayer('${l.layer_id}',this.checked)" style="display:none">
          <i style="position:absolute;top:2px;left:${l.visibility ? 16 : 2}px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.2s;display:block"></i>
        </label></div>`).join('');

    // frota inferior
    $('#fleetbar').innerHTML = `<div class="mini" style="writing-mode:vertical-rl;text-transform:uppercase;letter-spacing:.1em">frota</div>` + o.fleet.map((d) => {
      const col = d.battery > 55 ? '#10b981' : d.battery > 28 ? '#f59e0b' : '#f43f5e';
      return `<div class="fcard ${S.selDrone === d.drone_id ? 'sel' : ''}" style="width:186px" onclick="App.selectDrone('${d.drone_id}')">
        <div class="fn"><span>${esc(d.model)}</span><span class="badge ${d.status === 'in_flight' ? 'b-info' : d.status === 'charging' ? 'b-warn' : 'b-ok'}">${esc(d.status)}</span></div>
        <div class="fs">${esc(d.owner_name || 'frota')} · ${esc(roleName[d.owner_role] || 'operação')} · ${esc(d.node_code || '—')} · ${fmt(d.range_km)} km autonomia</div>
        <div class="bar"><i style="width:${d.battery}%;background:${col}"></i></div>
        <div class="row" style="justify-content:space-between;margin-top:4px"><span class="mini">${fmt(d.battery)}%</span><span class="mini">${fmt(d.payload_kg_max)} kg máx</span><span class="mini">${fmt(d.health_pct, 0)}% saúde</span></div>
      </div>`;
    }).join('');

    // triangulação
    $('#tri-net').textContent = `saldo ${o.triangulation.net > 0 ? '+' : ''}${o.triangulation.net}`;
    $('#tritbl').innerHTML = o.triangulation.nodes.slice(0, 10).map((n) => `
      <tr><td><b>${esc(n.code)}</b> <span class="mini">${kindIco[n.kind] || ''}</span></td><td>${n.incoming}</td><td>${n.outgoing}</td>
      <td style="color:${n.imbalance > 0 ? '#047857' : n.imbalance < 0 ? '#b45309' : 'inherit'}">${n.imbalance > 0 ? '+' : ''}${n.imbalance}</td>
      <td>${fmt(n.load_pct, 0)}%</td></tr>`).join('');

    // manifest / pacotes
    const ps = $('#pkgsel');
    if (ps.options.length !== o.packages.length) ps.innerHTML = o.packages.map((p) => `<option value="${p.package_id}">${esc(p.code)} · ${esc(p.origin_code)} → ${esc(p.dest_code)}</option>`).join('');
    if (S.selPkg) ps.value = S.selPkg;

    // câmeras
    const cs = $('#camsel');
    if (cs.options.length !== o.cameras.length) cs.innerHTML = o.cameras.map((c) => `<option value="${c.cam_id}">${esc(c.name)} · az ${fmt(c.azimuth, 0)}°</option>`).join('');

    // alertas
    $('#alerts').innerHTML = o.alerts.slice(0, 14).map((a) => `
      <div class="alert a-${a.severity === 'red' ? 'red' : a.severity === 'amber' ? 'amber' : a.severity === 'green' ? 'green' : 'info'}">
        <span>${a.severity === 'red' ? '🔴' : a.severity === 'amber' ? '🟠' : a.severity === 'green' ? '🟢' : '🔵'}</span>
        <div style="flex:1"><b>${esc(a.code || a.severity.toUpperCase())}</b> — ${esc(a.message)}<span class="tm">${dt(a.ts)} ${a.ack ? '· confirmado' : ''}</span></div>
        ${a.ack ? '' : `<button class="btn sm sec" onclick="App.ack('${a.alert_id}')">ok</button>`}</div>`).join('') || '<div class="mini">Sem alertas.</div>';

    Scene.setData(o);
    Maps.render(o);
  }

  function renderPackage() {
    const o = S.overview; if (!o) return;
    const p = o.packages.find((x) => x.package_id === S.selPkg) || o.packages[0];
    if (!p) return;
    S.selPkg = p.package_id;
    $('#mf-code').textContent = p.code; $('#mf-orig').textContent = p.origin_code; $('#mf-dest').textContent = p.dest_code;
    $('#mf-cont').textContent = p.contents; $('#mf-wt').textContent = fmt(p.weight_kg) + ' kg';
    $('#mf-nf').textContent = p.invoice_no || '—';
    const perms = (p.permits || []);
    $('#mf-perm').textContent = perms.map((x) => `${x.entity}:${x.status}`).join(' · ') || '—';
    $('#mf-risk').innerHTML = `<span class="badge ${p.risk === 'low' ? 'b-ok' : p.risk === 'medium' ? 'b-warn' : 'b-red'}">${esc(p.risk)}</span>`;
    $('#qr-main').src = `/api/packages/${p.package_id}/qr.png?t=${Date.now()}`;
  }

  /* ----------------------------------------------------------- ações UI */
  async function selectDrone(id) { S.selDrone = id; render(S.overview); Scene.focusDrone(id); openDrone(id); }
  async function toggleLayer(id, vis) { await api('/api/layers/' + id, { method: 'PATCH', body: { visibility: vis } }); }
  async function ack(id) { try { await api('/api/alerts/' + id + '/ack', { method: 'POST' }); toast('Alerta confirmado', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); } }
  async function emergency() {
    const m = (S.overview.missions || []).find((x) => ['in_flight', 'charging'].includes(x.status));
    if (!m) return toast('Nenhuma missão ativa para desviar', 'warn');
    try { const r = await api(`/api/missions/${m.mission_id}/diversion`, { method: 'POST', body: { reason: 'weather' } }); toast(`Desvio para ${r.hold_node} calculado`, 'warn'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function override(action, payload) {
    const m = (S.overview.missions || []).find((x) => ['in_flight', 'charging', 'rerouted', 'hold'].includes(x.status));
    if (!m) return toast('Nenhuma missão ativa', 'warn');
    try { await api(`/api/missions/${m.mission_id}/override`, { method: 'POST', body: { action, payload } }); toast(`Override: ${action}`, 'ok'); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  }
  function openRedirect() {
    const nodes = S.overview.nodes;
    const back = modal(`<h3>Redirecionar missão</h3><div class="msub">Override de rota por piloto emergencial — validado contra reserva de bateria.</div>
      <label>Novo nó de destino</label><select id="rd-node">${nodes.map((n) => `<option value="${n.node_id}">${esc(n.code)} · ${esc(n.name)}${n.is_recharge ? ' ⚡' : ''}</option>`).join('')}</select>
      <label>Motivo</label><input id="rd-why" value="Desvio manual autorizado — solicitação do operador">
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn sec" onclick="this.closest('.back').remove()">Cancelar</button>
      <button class="btn" id="rd-go">Aplicar desvio</button></div>`, 'sm');
    back.querySelector('#rd-go').onclick = async () => {
      await override('redirect', { to_node_id: back.querySelector('#rd-node').value, reason: back.querySelector('#rd-why').value });
      back.remove();
    };
  }

  function openDrone(id) {
    const d = S.overview.fleet.find((x) => x.drone_id === id) || S.overview.fleet[0]; if (!d) return;
    const g = d.geom || {};
    const back = modal(`<h3>${esc(d.model)} <span class="badge b-info">${esc(d.serial)}</span></h3>
      <div class="msub">${esc(d.brand || '')} · ${esc(d.mclass || '')} · proprietário: ${esc(d.owner_name || 'frota')} (${esc(roleName[d.owner_role] || 'operação')})</div>
      <div class="grid2">
        <div><canvas id="drone3d"></canvas><div class="mini" style="text-align:center;margin-top:4px">arraste para rotacionar · scroll para zoom · modelo ${g.prop || d.rotors} rotores</div></div>
        <div>
          <div class="grid3">
            <div class="tile"><div class="t">Bateria</div><div class="v" style="color:${d.battery > 55 ? '#047857' : d.battery > 28 ? '#b45309' : '#be123c'}">${fmt(d.battery)}%</div></div>
            <div class="tile"><div class="t">Carga útil</div><div class="v">${fmt(d.payload_kg_max)} kg</div></div>
            <div class="tile"><div class="t">Cruzeiro</div><div class="v">${fmt(d.cruise_kmh, 0)} km/h</div></div>
            <div class="tile"><div class="t">Autonomia</div><div class="v">${fmt(d.range_km, 0)} km</div></div>
            <div class="tile"><div class="t">Energia</div><div class="v">${fmt(d.battery_wh, 0)} Wh</div></div>
            <div class="tile"><div class="t">Recarga</div><div class="v">${fmt(d.charge_kw)} kW</div></div>
          </div>
          <div style="margin-top:10px" class="chips">
            <span class="chipx">rotores: ${d.rotors || g.prop}</span><span class="chipx">peso: ${fmt(d.weight_kg)} kg</span>
            <span class="chipx">dimensões: ${esc(d.dims_cm || '—')} cm</span><span class="chipx">reserva: ${fmt(d.model_reserve || d.reserve_pct, 0)}%</span>
            <span class="chipx">saúde: ${fmt(d.health_pct, 0)}%</span><span class="chipx">status: ${esc(d.status)}</span>
            <span class="chipx">nó atual: ${esc(d.node_code || '—')}</span><span class="chipx">operador: ${esc(d.operator_role)}</span>
          </div>
          <div class="row" style="margin-top:12px;gap:6px;flex-wrap:wrap">
            <button class="btn sm" onclick="App.missionFor('${d.drone_id}')">✈️ Planejar missão</button>
            <button class="btn sm sec" onclick="App.charge('${d.drone_id}')">⚡ Mandar recarregar</button>
            ${d.status === 'in_flight' ? `<button class="btn sm sun" onclick="App.override('hold');this.closest('.back').remove()">⏸ Suspender voo</button>` : ''}
          </div>
        </div>
      </div>`);
    Scene.droneViewer(back.querySelector('#drone3d'), d);
  }

  function missionFor(droneId) {
    closeModals();
    const o = S.overview, nodes = o.nodes, pkgs = o.packages.filter((p) => p.status !== 'delivered');
    const back = modal(`<h3>Planejar missão</h3><div class="msub">O roteador insere paradas de recarga automaticamente quando a reserva de bateria é insuficiente.</div>
      <div class="grid3">
        <div><label>Drone</label><select id="pl-d">${o.fleet.map((d) => `<option value="${d.drone_id}" ${d.drone_id === droneId ? 'selected' : ''}>${esc(d.model)} · ${fmt(d.battery)}%</option>`).join('')}</select></div>
        <div><label>Origem</label><select id="pl-o">${nodes.map((n) => `<option value="${n.node_id}">${esc(n.code)}</option>`).join('')}</select></div>
        <div><label>Destino</label><select id="pl-x">${nodes.map((n, i) => `<option value="${n.node_id}" ${i === 5 ? 'selected' : ''}>${esc(n.code)}</option>`).join('')}</select></div>
      </div>
      <div class="grid3">
        <div><label>Pacote vinculado</label><select id="pl-p"><option value="">— sem pacote —</option>${pkgs.map((p) => `<option value="${p.package_id}" data-w="${p.weight_kg}">${esc(p.code)} (${fmt(p.weight_kg)} kg)</option>`).join('')}</select></div>
        <div><label>Carga (kg)</label><input id="pl-w" type="number" step="0.1" value="2"></div>
        <div><label>Reserva mín. SOC (%)</label><input id="pl-r" type="number" value="22"></div>
      </div>
      <div id="pl-out" style="margin-top:12px"></div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn sec" onclick="this.closest('.back').remove()">Fechar</button>
        <button class="btn sec" id="pl-calc">Calcular rota</button>
        <button class="btn mint" id="pl-go">Despachar voo</button>
      </div>`);
    const read = () => ({ drone_id: back.querySelector('#pl-d').value, origin_id: back.querySelector('#pl-o').value, dest_id: back.querySelector('#pl-x').value, payload_kg: +back.querySelector('#pl-w').value, reserve_pct: +back.querySelector('#pl-r').value, project_id: S.project });
    const sel = back.querySelector('#pl-p');
    sel.onchange = () => { const w = sel.selectedOptions[0].dataset.w; if (w) back.querySelector('#pl-w').value = w; };
    back.querySelector('#pl-calc').onclick = async () => {
      try {
        const p = await api('/api/missions/plan', { method: 'POST', body: read() });
        back.querySelector('#pl-out').innerHTML = planHtml(p);
      } catch (e) { back.querySelector('#pl-out').innerHTML = `<div class="alert a-red">${esc(e.message)}</div>`; }
    };
    back.querySelector('#pl-go').onclick = async () => {
      try {
        const r = await api('/api/missions', { method: 'POST', body: { ...read(), package_id: sel.value || null, autostart: true } });
        toast(`Missão despachada — ${r.plan.total_km} km, ETA ${r.plan.total_min} min`, 'ok');
        back.remove(); S.selMission = r.mission_id; await refresh(); Scene.focusMission(r.mission_id);
      } catch (e) { back.querySelector('#pl-out').innerHTML = `<div class="alert a-red">${esc(e.message)}</div>`; }
    };
  }
  const planHtml = (p) => `<div class="grid3">
      <div class="tile"><div class="t">Distância</div><div class="v">${p.total_km} km</div></div>
      <div class="tile"><div class="t">Tempo total</div><div class="v">${p.total_min} min</div></div>
      <div class="tile"><div class="t">Energia</div><div class="v">${p.energy_wh} Wh</div></div></div>
    <table class="dt" style="margin-top:8px"><thead><tr><th>#</th><th>Trecho</th><th>km</th><th>voo</th><th>recarga</th><th>SOC chegada</th><th>alvo</th></tr></thead>
    <tbody>${p.legs.map((l) => `<tr><td>${l.seq}</td><td>${l.from.replace('nod_', '').toUpperCase()} → ${l.to.replace('nod_', '').toUpperCase()}</td>
      <td>${l.km}</td><td>${l.air_min} min</td><td>${l.pause_min} min</td><td>${l.arrive_soc}%</td><td>${l.target_soc}%</td></tr>`).join('')}</tbody></table>
    ${p.stops.length ? `<div class="mini" style="margin-top:6px">Paradas de recarga programadas: <b>${p.stops.join(', ')}</b></div>` : '<div class="mini" style="margin-top:6px">Voo direto — sem necessidade de recarga intermediária.</div>'}`;

  async function charge(id) { try { await api('/api/fleet/' + id, { method: 'PATCH', body: { status: 'charging', battery: 22 } }); closeModals(); toast('Drone encaminhado ao ponto de recarga', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); } }

  /* ------------------------------------------------------- pacotes/track */
  function newPackage() {
    const o = S.overview, nodes = o.nodes, users = o.users;
    const back = modal(`<h3>Registrar pacote na rede</h3><div class="msub">O pacote recebe QR rastreável, tags RFID/BLE, manifesto e nota fiscal automaticamente.</div>
      <div class="grid3">
        <div><label>Remetente</label><select id="np-s">${users.filter((u) => ['sender', 'admin', 'hub'].includes(u.role)).map((u) => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')}</select></div>
        <div><label>Destinatário</label><select id="np-r">${users.filter((u) => ['recipient', 'sender'].includes(u.role)).map((u) => `<option value="${u.user_id}">${esc(u.name)}</option>`).join('')}</select></div>
        <div><label>Prioridade</label><select id="np-p"><option value="1">1 — expressa</option><option value="2" selected>2 — normal</option><option value="3">3 — econômica</option></select></div>
      </div>
      <div class="grid3">
        <div><label>Origem (entrada)</label><select id="np-o">${nodes.filter((n) => n.is_primary_entry || n.kind === 'depot').map((n) => `<option value="${n.node_id}">${esc(n.code)} · ${esc(n.name)}</option>`).join('')}</select></div>
        <div><label>Destino</label><select id="np-d">${nodes.map((n) => `<option value="${n.node_id}">${esc(n.code)} · ${esc(n.name)}</option>`).join('')}</select></div>
        <div><label>Risco</label><select id="np-k"><option value="low">baixo</option><option value="medium">médio</option><option value="high">alto</option></select></div>
      </div>
      <div class="grid3">
        <div><label>Conteúdo</label><input id="np-c" value="Encomenda geral — embalagem padrão"></div>
        <div><label>Peso (kg)</label><input id="np-w" type="number" step="0.1" value="3"></div>
        <div><label>Valor declarado (R$)</label><input id="np-v" type="number" value="450"></div>
      </div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn sec" onclick="this.closest('.back').remove()">Cancelar</button><button class="btn mint" id="np-go">Registrar + gerar QR</button></div>`);
    back.querySelector('#np-go').onclick = async () => {
      try {
        const p = await api('/api/packages', {
          method: 'POST', body: {
            sender_id: back.querySelector('#np-s').value, recipient_id: back.querySelector('#np-r').value,
            origin_node_id: back.querySelector('#np-o').value, dest_node_id: back.querySelector('#np-d').value,
            contents: back.querySelector('#np-c').value, weight_kg: +back.querySelector('#np-w').value,
            declared_value: +back.querySelector('#np-v').value, priority: +back.querySelector('#np-p').value, risk: back.querySelector('#np-k').value,
            project_id: S.project
          }
        });
        toast(`Pacote ${p.code} registrado com QR rastreável`, 'ok'); back.remove(); S.selPkg = p.package_id; await refresh();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  async function openTrack(pkgId) {
    const id = pkgId || S.selPkg;
    try {
      const [p, pred] = await Promise.all([api('/api/packages/' + id), api(`/api/packages/${id}/predictive`)]);
      const back = modal(`<h3>Rastreamento ${esc(p.code)} <span class="badge ${p.status === 'delivered' ? 'b-ok' : 'b-info'}">${esc(p.status)}</span></h3>
        <div class="msub">${esc(p.origin?.name)} → ${esc(p.destination?.name)} · ${fmt(p.weight_kg)} kg · risco ${esc(p.risk)}</div>
        <div class="grid2">
          <div>
            <div class="row" style="gap:10px;align-items:flex-start">
              <img class="qr" src="/api/packages/${p.package_id}/qr.png" alt="QR">
              <div style="flex:1">
                <div class="kv"><span>Nota fiscal</span><b>${esc(p.invoice_no || '—')}</b></div>
                <div class="kv"><span>Valor declarado</span><b>R$ ${fmt(p.declared_value, 2)}</b></div>
                <div class="kv"><span>Conteúdo</span><b style="font-size:10px">${esc(p.contents)}</b></div>
                <div class="kv"><span>Distância prevista</span><b>${pred.predicted_km} km</b></div>
                <div class="kv"><span>ETA previsto</span><b>${dt(pred.predicted_eta)}</b></div>
                <div class="kv"><span>Tags</span><b>${(p.tags || []).map((t) => t.kind).join(' + ')}</b></div>
              </div>
            </div>
            <div class="sub" style="font-weight:700;margin:10px 0 5px">Mapeamento preditivo — pontos de parada</div>
            <div class="timeline">${pred.stops.map((s) => `<div class="tl"><b>${esc(s.to)}</b> · ${s.km} km · ${s.air_min} min · SOC ${s.arrive_soc}% <span class="badge ${s.kind === 'entrega' ? 'b-ok' : s.kind === 'recarga' ? 'b-warn' : 'b-info'}">${esc(s.kind)}</span>${s.recharge_min ? ` · recarga ${s.recharge_min} min` : ''}</div>`).join('')}</div>
          </div>
          <div>
            <div class="sub" style="font-weight:700;margin-bottom:5px">Permissões de trânsito</div>
            <table class="dt"><thead><tr><th>Permissão</th><th>Entidade</th><th>Escopo</th><th>Validade</th><th>Status</th></tr></thead>
              <tbody>${(p.permits || []).map((x) => `<tr><td>${esc(x.id)}</td><td>${esc(x.entity)}</td><td>${esc(x.scope)}</td><td>${esc(x.valid_until || '—')}</td>
              <td><span class="badge ${x.status === 'valid' ? 'b-ok' : x.status === 'pending' ? 'b-warn' : 'b-red'}">${esc(x.status)}</span></td></tr>`).join('')}</tbody></table>
            <div class="sub" style="font-weight:700;margin:10px 0 5px">Eventos de rastreio (RFID / BLE / QR)</div>
            <div class="timeline">${(p.events || []).map((e) => `<div class="tl"><b>${esc(e.status)}</b> <span class="badge b-info">${esc(e.method)}</span> · ${dt(e.ts)}<div class="mini">${esc(e.detail || '')} ${e.reader_id ? '· leitor ' + esc(e.reader_id) : ''} ${e.rssi ? '· ' + e.rssi + ' dBm' : ''}</div></div>`).join('')}</div>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px">
          <button class="btn sec" onclick="App.openManifest('${p.package_id}')">Manifesto</button>
          <button class="btn sec" onclick="App.openInvoice('${p.package_id}')">Nota fiscal</button>
          <button class="btn sec" onclick="App.simulateScan('${p.package_id}','RFID')">Leitura RFID</button>
          <button class="btn sec" onclick="App.simulateScan('${p.package_id}','BLE')">Leitura BLE</button>
          <button class="btn" onclick="App.missionFor()">Despachar drone</button>
        </div>`, 'sm');
      back.querySelector('.modal').style.maxWidth = '980px';
    } catch (e) { toast(e.message, 'err'); }
  }

  async function openManifest(id) {
    const pid = id || S.selPkg;
    const m = await api(`/api/packages/${pid}/manifest.json`);
    modal(`<h3>Manifesto — ${esc(m.code)}</h3><div class="msub">Gerado ${dt(m.generated_at)} · operador ${esc(m.operator)} · projeto ${esc(m.project || '')}</div>
      <pre style="background:#f7fbff;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:11px;overflow:auto;max-height:52vh">${esc(JSON.stringify(m, null, 2))}</pre>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
        <a class="btn sec" href="/api/packages/${pid}/manifest.json" target="_blank">Abrir JSON</a>
        <a class="btn" href="/api/packages/${pid}/qr.png" download="qr-${esc(m.code)}.png">Baixar QR</a></div>`);
  }
  async function openInvoice(id) {
    const pid = id || S.selPkg;
    const i = await api(`/api/packages/${pid}/invoice`);
    modal(`<h3>Nota fiscal ${esc(i.invoice_no || '—')}</h3><div class="msub">${esc(i.issuer)} · emitida ${dt(i.issued_at)} · ${esc(i.code)}</div>
      <table class="dt"><thead><tr><th>Descrição</th><th>Peso</th><th>Valor</th></tr></thead>
      <tbody>${i.linha.map((l) => `<tr><td>${esc(l.descricao)}</td><td>${l.peso_kg} kg</td><td>R$ ${fmt(l.valor, 2)}</td></tr>`).join('')}</tbody></table>
      <div class="grid3" style="margin-top:10px">
        <div class="tile"><div class="t">Subtotal</div><div class="v">R$ ${fmt(i.totals.subtotal, 2)}</div></div>
        <div class="tile"><div class="t">Tributos</div><div class="v">R$ ${fmt(i.totals.taxes, 2)}</div></div>
        <div class="tile"><div class="t">Total</div><div class="v">R$ ${fmt(i.totals.total, 2)}</div></div></div>`);
  }
  async function simulateScan(id, method) {
    const pid = id || S.selPkg;
    const kind = method || (Math.random() > .5 ? 'RFID' : 'BLE');
    try {
      const r = await api(`/api/packages/${pid}/scan`, { method: 'POST', body: { method: kind, reader_id: kind + '-' + Math.round(Math.random() * 40), rssi: -(35 + Math.round(Math.random() * 30)), detail: `Leitura ${kind} em ponto estratégico de monitoramento` } });
      toast(`Leitura ${kind} registrada — status ${r.status}`, 'ok'); await refresh(); if ($('.back')) { closeModals(); openTrack(pid); }
    } catch (e) { toast(e.message, 'err'); }
  }

  /* -------------------------------------------------- câmeras / relatórios */
  async function reorient(delta) {
    const cid = $('#camsel').value; if (!cid) return;
    const cam = S.overview.cameras.find((c) => c.cam_id === cid);
    const back2 = await api('/api/cameras/' + cid + '/reorient', { method: 'POST', body: { azimuth: (cam.azimuth + delta + 360) % 360, mode: 'manual', mission_id: currentMission() } });
    $('#feed-tag').textContent = `${cam.name} · az ${back2.azimuth}°`;
    toast(`Câmera reorientada para ${back2.azimuth}°`, 'info'); refresh();
  }
  async function zoomCam() {
    const cid = $('#camsel').value; if (!cid) return;
    const cam = S.overview.cameras.find((c) => c.cam_id === cid);
    const z = cam.zoom >= 2.6 ? 1 : +(cam.zoom + 0.6).toFixed(1);
    await api('/api/cameras/' + cid + '/reorient', { method: 'POST', body: { zoom: z, mode: z === 1 ? 'auto' : 'manual' } });
    toast('Zoom ' + z + 'x', 'info');
  }
  const currentMission = () => (S.overview.missions.find((m) => ['in_flight', 'charging', 'rerouted'].includes(m.status)) || {}).mission_id || null;

  function openReports() {
    const back = modal(`<h3>Relatórios &amp; análises</h3><div class="msub">Exportação dinâmica para consulta operacional e entidades reguladoras.</div>
      <div class="grid3">
        <div><label>Tipo</label><select id="rp-k"><option>operacional</option><option>frota</option><option>entregas</option><option>triangulacao</option><option>conformidade-regulatoria</option></select></div>
        <div><label>Período</label><input id="rp-p" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div><label>&nbsp;</label><button class="btn" id="rp-go" style="width:100%">Gerar relatório</button></div>
      </div>
      <div id="rp-out" style="margin-top:12px"></div>
      <div class="sub" style="font-weight:700;margin:12px 0 5px">Acessos regulatórios ativos</div>
      <div id="rp-reg"></div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn sec" id="rp-new">Conceder acesso ANAC/DECEA</button><button class="btn sec" onclick="this.closest('.back').remove()">Fechar</button></div>`);
    api('/api/regulator/access').then((rows) => {
      back.querySelector('#rp-reg').innerHTML = `<table class="dt"><thead><tr><th>Entidade</th><th>Escopo</th><th>Token</th><th>Expira</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.entity)}</td><td>${esc(r.scope)}</td><td class="mini">${esc(r.token)}</td><td>${dt(r.expires_at)}</td></tr>`).join('')}</tbody></table>`;
    });
    back.querySelector('#rp-new').onclick = async () => {
      try { const r = await api('/api/regulator/access', { method: 'POST', body: { entity: 'DECEA', purpose: 'auditoria de corredores', scope: 'manifest.read,zones.read', days: 15 } }); toast('Acesso concedido: ' + r.token, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    back.querySelector('#rp-go').onclick = async () => {
      try {
        const r = await api('/api/reports/generate', { method: 'POST', body: { kind: back.querySelector('#rp-k').value, period: back.querySelector('#rp-p').value, project_id: S.project } });
        back.querySelector('#rp-out').innerHTML = `<div class="grid3">
            <div class="tile"><div class="t">Missões concluídas</div><div class="v">${r.payload.kpis.missions_done}</div></div>
            <div class="tile"><div class="t">Entregas</div><div class="v">${r.payload.kpis.delivered}</div></div>
            <div class="tile"><div class="t">Energia</div><div class="v">${r.payload.energy.kwh} kWh</div></div></div>
          <pre style="background:#f7fbff;border:1px solid var(--line);border-radius:12px;padding:10px;font-size:10.5px;margin-top:10px">${esc(r.csv_preview)}</pre>
          <div class="row" style="justify-content:flex-end;margin-top:8px"><a class="btn sec" href="${r.url}" target="_blank">Abrir CSV</a>
          <a class="btn" href="${r.url}">Baixar CSV</a></div>`;
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function openInstaller() {
    api('/api/installer/status').then((st) => {
      const back = modal(`<h3>Instalador / banco dinâmico</h3><div class="msub">Autoinstalação na primeira execução: schema, seeds, usuários, rede, frota e catálogo 3D.</div>
        <div class="grid3">
          <div class="tile"><div class="t">Situação</div><div class="v">${st.installed ? 'instalado' : 'pendente'}</div></div>
          <div class="tile"><div class="t">Schema</div><div class="v">${esc(st.schema_version)}</div></div>
          <div class="tile"><div class="t">Arquivo</div><div class="v" style="font-size:11px">${st.db_size_kb} KB</div></div>
        </div>
        <div class="mini" style="margin:8px 0">${esc(st.db_file)}</div>
        <div class="sub" style="font-weight:700;margin:8px 0 5px">Tabelas e registros</div>
        <div class="chips">${st.tables.map((t) => `<span class="chipx">${esc(t)} <b>${st.counts[t] ?? 0}</b></span>`).join('')}</div>
        <div class="sub" style="font-weight:700;margin:12px 0 5px">Passos de instalação</div>
        <div id="ins-steps" class="mini">carregando…</div>
        <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
          <a class="btn sec" href="/api/installer/schema.sql" target="_blank">Ver DDL</a>
          <a class="btn sec" href="/api/installer/db.sqlite">Baixar .sqlite</a>
          <button class="btn sun" id="ins-re">Reinstalar (apaga dados)</button>
          <button class="btn" onclick="this.closest('.back').remove()">Fechar</button></div>`, 'sm');
      back.querySelector('.modal').style.maxWidth = '820px';
      api('/api/installer/steps').then((rows) => {
        back.querySelector('#ins-steps').innerHTML = rows.slice(0, 25).map((s) => `<div>${dt(s.ts)} · <b>${esc(s.step)}</b> · ${esc(s.status)}${s.detail ? ' — ' + esc(s.detail) : ''}</div>`).join('');
      });
      back.querySelector('#ins-re').onclick = async () => {
        try { const r = await api('/api/installer/run', { method: 'POST', body: { force: true } }); toast(`Reinstalado — schema ${r.schema_version}`, 'ok'); back.remove(); await refresh(); }
        catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  /* ------------------------------------------------------- websocket live */
  function connect() {
    if (!S.token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      S.ws = new WebSocket(`${proto}://${location.host}/ws`);
      S.ws.onopen = () => { $('#sb-ws').textContent = 'live'; $('#sb-ws').style.color = '#047857'; };
      S.ws.onclose = () => { $('#sb-ws').textContent = 'offline'; $('#sb-ws').style.color = '#be123c'; setTimeout(connect, 3000); };
      S.ws.onmessage = (e) => { try { onLive(JSON.parse(e.data)); } catch { /* ignore */ } };
    } catch { setTimeout(connect, 4000); }
  }

  function onLive(msg) {
    if (msg.type !== 'telemetry') return;
    S.live = {};
    (msg.live || []).forEach((l) => { if (l) S.live[l.mission_id] = l; });
    Scene.updateLive(msg.live || [], msg.triangulation);
    Maps.updateLive(msg.live || []);
    const act = (msg.live || []).filter(Boolean);
    if (act.length) {
      const m = act[0];
      S.selMission = m.mission_id;
      $('#rb-mission').textContent = m.mission_id.slice(-6).toUpperCase();
      $('#rb-cp').textContent = `${m.leg.from_code} → ${m.leg.to_code}`;
      $('#rb-dist').textContent = `${m.dist_remaining_km} km até ${(S.overview.missions.find((x) => x.mission_id === m.mission_id) || {}).dest_code || '—'}`;
      $('#rb-eta').textContent = `${m.eta_final_min} min`;
      $('#rb-next').textContent = `${m.leg.to_code} · ${m.eta_next_min} min`;
      $('#rb-bat').textContent = `${m.battery}%`;
      $('#rb-bar').style.width = m.progress + '%';
      $('#rb-nodes').textContent = 'Nós já visitados: ' + (m.passed_nodes.length ? m.passed_nodes.join(' → ') : 'nenhum');
      const tel = (msg.telemetry || []).slice(-1)[0] || {};
      $('#tl-alt').textContent = fmt(tel.alt_m, 0) + ' m'; $('#tl-spd').textContent = fmt(tel.speed_kmh, 0) + ' km/h';
      $('#tl-hdg').textContent = fmt(tel.heading, 0) + '°'; $('#tl-bat').textContent = fmt(tel.battery) + '%';
      $('#tl-sig').textContent = fmt(tel.signal, 0) + '%'; $('#tl-eta').textContent = fmt(tel.eta_final_min, 0) + ' min';
      $('#sb-coord').textContent = `${fmt(tel.lat, 5)}, ${fmt(tel.lon, 5)}`;
      $('#ck-drone').textContent = `frota ${m.mission_id.slice(-4)} · perna ${m.leg.seq} · ${m.phase}`;
    }
    if (msg.triangulation) {
      $('#tri-net').textContent = `saldo ${msg.triangulation.net > 0 ? '+' : ''}${msg.triangulation.net}`;
      const tb = $('#tritbl');
      tb.innerHTML = msg.triangulation.nodes.slice(0, 10).map((n) => `<tr><td><b>${esc(n.code)}</b></td><td>${n.incoming}</td><td>${n.outgoing}</td>
        <td style="color:${n.imbalance > 0 ? '#047857' : n.imbalance < 0 ? '#b45309' : 'inherit'}">${n.imbalance > 0 ? '+' : ''}${n.imbalance}</td><td>${fmt(n.load_pct, 0)}%</td></tr>`).join('');
    }
    if (msg.alert) {
      const a = msg.alert;
      $('#alerts').insertAdjacentHTML('afterbegin', `<div class="alert a-${a.severity === 'red' ? 'red' : a.severity === 'amber' ? 'amber' : a.severity === 'green' ? 'green' : 'info'}">
        <span>${a.severity === 'red' ? '🔴' : a.severity === 'amber' ? '🟠' : a.severity === 'green' ? '🟢' : '🔵'}</span>
        <div style="flex:1"><b>${esc(a.code || a.severity)}</b> — ${esc(a.message)}<span class="tm">${dt(a.ts)}</span></div></div>`);
    }
  }

  /* --------------------------------------------------------- feed de vídeo */
  function startFeed() {
    const c = $('#feedcanvas'), ctx = c.getContext('2d');
    let t = 0;
    const fit = () => { c.width = c.clientWidth; c.height = c.clientHeight; };
    fit(); window.addEventListener('resize', fit);
    (function loop() {
      t += 0.006;
      const w = c.width, h = c.height;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#bfe4ff'); g.addColorStop(.55, '#dff1ff'); g.addColorStop(1, '#f2faff');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // skyline
      for (let i = 0; i < 26; i++) {
        const bw = 18 + ((i * 37) % 40), bh = 40 + ((i * 61) % (h * 0.55));
        const pan = ((t * 20 + i * 40) % (w + 80)) - 60;
        ctx.fillStyle = i % 3 === 0 ? 'rgba(140,180,220,.55)' : 'rgba(120,165,210,.4)';
        ctx.fillRect(pan, h - bh, bw, bh);
      }
      // drone silhueta
      const dx = w / 2 + Math.sin(t * 2) * 10, dy = h * .42 + Math.cos(t * 3) * 4;
      ctx.strokeStyle = 'rgba(15,37,68,.75)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx - 24, dy); ctx.lineTo(dx + 24, dy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dx - 12, dy - 7); ctx.lineTo(dx + 12, dy + 7); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dx - 12, dy + 7); ctx.lineTo(dx + 12, dy - 7); ctx.stroke();
      [-24, -8, 8, 24].forEach((o, i) => { ctx.beginPath(); ctx.arc(dx + o, dy, 5 + Math.sin(t * 20 + i) * 1.6, 0, 7); ctx.stroke(); });
      ctx.fillStyle = 'rgba(14,165,233,.18)';
      ctx.fillRect(0, 0, w, 16);
      requestAnimationFrame(loop);
    })();
  }

  /* ------------------------------------------------------------ clock/fps */
  function tickers() {
    let last = performance.now(), frames = 0;
    (function l(now) {
      frames++;
      if (now - last > 900) { $('#sb-fps').textContent = Math.round(frames * 1000 / (now - last)); frames = 0; last = now; }
      requestAnimationFrame(l);
    })(last);
    setInterval(() => {
      $('#eng-clock').textContent = new Date().toLocaleTimeString('pt-BR');
      if (S.token && S.overview && Math.random() < .34) refresh().catch(() => { });
    }, 1000);
  }

  /* ---------------------------------------------------------------- init */
  function init() {
    $('#proj').onchange = async () => { S.project = $('#proj').value; await refresh(); toast('Projeto alterado', 'info'); };
    $('#pkgsel').onchange = () => { S.selPkg = $('#pkgsel').value; renderPackage(); };
    $('#camsel').onchange = () => { const c = S.overview.cameras.find((x) => x.cam_id === $('#camsel').value); if (c) $('#feed-tag').textContent = `${c.name} · az ${fmt(c.azimuth, 0)}°`; };
    $('#op').oninput = (e) => { $('#op-v').textContent = e.target.value + '%'; Scene.setOpacity(e.target.value / 100); };
    startFeed(); tickers(); Scene.init(); Maps.init();
  }

  return {
    boot, login, logout, refresh, runInstaller, openInstaller, openReports, openDrone, openTrack, openManifest,
    openInvoice, simulateScan, newPackage, missionFor, charge, selectDrone, toggleLayer, ack, emergency,
    override, openRedirect, reorient, zoomCam, init, toast, api, modal, closeModals,
    state: S, esc, fmt, dt, roleName
  };
})();
