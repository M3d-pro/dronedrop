'use strict';
/* ============================================================================
   sky.m3d.pro · droneDrop v0.2 — Mapas 2D (Leaflet)
   Triangulação dinâmica, minimapa de voo e monitoramento de câmeras.
   ============================================================================ */
const Maps = (() => {
  let tri = null, mini = null, triMarks = {}, triLines = [], nodeIndex = {}, miniDrone = null, drawn = false;

  const opts = { zoomControl: false, attributionControl: false };
  const kindIco = { depot: '🏭', rooftop: '🏢', micro: '🏪', support: '⛺', entry: '🚪' };

  function init() {
    const t = document.getElementById('trimap'), m = document.getElementById('minimap');
    if (t) {
      tri = L.map(t, { ...opts, zoomSnap: .25 }).setView([-23.5505, -46.6333], 13);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(tri);
      setTimeout(() => tri.invalidateSize(), 400);
    }
    if (m) {
      mini = L.map(m, { ...opts, zoomSnap: .25 }).setView([-23.5505, -46.6333], 13);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(mini);
      const label = document.createElement('div');
      label.className = 'mini';
      label.style.cssText = 'position:absolute;left:10px;top:8px;z-index:500;background:rgba(255,255,255,.85);border-radius:7px;padding:2px 7px';
      label.textContent = 'voo em curso';
      m.appendChild(label);
      setTimeout(() => mini.invalidateSize(), 400);
    }
  }

  function render(o) {
    if (!o) return;
    nodeIndex = Object.fromEntries(o.nodes.map((n) => [n.node_id, n]));
    if (o.nodes.length) {
      const b = L.latLngBounds(o.nodes.map((n) => [n.lat, n.lon]));
      if (tri) tri.fitBounds(b.pad(.28));
      if (mini) mini.fitBounds(b.pad(.35));
    }
    if (tri) {
      // limpa camadas antigas
      Object.values(triMarks).forEach((mk) => tri.removeLayer(mk));
      triLines.forEach((l) => tri.removeLayer(l));
      triMarks = {}; triLines = [];
      const tri2 = o.triangulation;
      const maxFlow = Math.max(1, ...tri2.nodes.map((n) => n.incoming + n.outgoing));
      tri2.nodes.forEach((n) => {
        const flow = n.incoming + n.outgoing;
        const radius = 6 + (flow / maxFlow) * 11;
        const col = n.imbalance > 0 ? '#0ea5e9' : n.imbalance < 0 ? '#f59e0b' : '#10b981';
        const mk = L.circleMarker([n.lat, n.lon], {
          radius, color: '#fff', weight: 2, fillColor: col, fillOpacity: .82
        }).addTo(tri);
        mk.bindTooltip(`<b>${n.code}</b> ${kindIco[n.kind] || ''}<br>${n.name}<br>in ${n.incoming} · out ${n.outgoing} · saldo ${n.imbalance}<br>ocupação ${n.occupancy}/${n.capacity_slots}`,
          { direction: 'top', className: 'mini' });
        mk.on('click', () => focusNode(n.node_id));
        triMarks[n.node_id] = mk;
      });
      // vetores de fluxo (triangulação dinâmica)
      tri2.nodes.forEach((n) => {
        if (n.outgoing <= 0) return;
        const ang = (n.vector_deg || 0) * Math.PI / 180;
        const len = .004 + (n.outgoing / maxFlow) * .012;
        const end = [n.lat + Math.sin(ang) * len, n.lon + Math.cos(ang) * len];
        triLines.push(L.polyline([[n.lat, n.lon], end], { color: '#6366f1', weight: 1.6, opacity: .5, dashArray: '4,4' }).addTo(tri));
      });
    }
    // minimapa: rotas planejadas + drones
    if (mini) {
      mini.eachLayer((l) => { if (l instanceof L.Polyline || l instanceof L.CircleMarker) mini.removeLayer(l); });
      (o.missions || []).slice(0, 12).forEach((m) => {
        let plan = {}; try { plan = JSON.parse(m.route_json); } catch { }
        const pts = (plan.legs || []).map((l) => {
          const n = nodeIndex[l.to]; return n ? [n.lat, n.lon] : null;
        }).filter(Boolean);
        if (!pts.length) return;
        const active = ['in_flight', 'charging', 'rerouted'].includes(m.status);
        L.polyline(pts, { color: m.status === 'rerouted' ? '#f43f5e' : active ? '#0ea5e9' : '#a9cdf3', weight: active ? 3 : 1.6, opacity: active ? .9 : .4 }).addTo(mini);
      });
      (o.fleet || []).filter((d) => d.lat && d.status === 'in_flight').forEach((d) => {
        L.circleMarker([d.lat, d.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#a855f7', fillOpacity: .95 }).addTo(mini);
      });
    }
    drawn = true;
  }

  function updateLive(live) {
    if (!mini) return;
    (live || []).filter(Boolean).forEach((m) => {
      const p = m.position; if (!p) return;
      if (!miniDrone) {
        miniDrone = L.marker([p.lat, p.lon], {
          icon: L.divIcon({ className: '', html: '<div style="width:14px;height:14px;border-radius:50%;background:#a855f7;border:2px solid #fff;box-shadow:0 0 0 4px rgba(168,85,247,.25)"></div>', iconSize: [14, 14], iconAnchor: [7, 7] })
        }).addTo(mini);
      } else miniDrone.setLatLng([p.lat, p.lon]);
      if (triMarks[m.leg?.to_node_id]) triMarks[m.leg.to_node_id].setStyle({ color: '#f43f5e', weight: 3 });
    });
  }

  function focusNode(id) {
    const n = nodeIndex[id]; if (!n) return;
    if (tri) tri.setView([n.lat, n.lon], 15, { animate: true });
    if (mini) mini.setView([n.lat, n.lon], 14, { animate: true });
    const mk = triMarks[id];
    if (mk) { mk.setStyle({ weight: 4, color: '#0f2544' }); mk.openTooltip(); setTimeout(() => mk.setStyle({ weight: 2, color: '#fff' }), 2200); }
    App.toast(`${n.code} · ${n.name} — ${n.occupancy}/${n.capacity_slots} slots, ${n.charger_kw} kW`, 'info');
  }

  return { init, render, updateLive, focusNode };
})();
