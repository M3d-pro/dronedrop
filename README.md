# sky.m3d.pro · droneDrop v0.2
### Urban Airspace Management Platform — autoinstalação + banco de dados dinâmico

Plataforma full-stack para gestão de espaço aéreo urbano, malha logística de drones,
rede de pontos (entrada, apoio, recarga e estação de distribuição), rastreio de pacotes
com QR/RFID/BLE, triangulação dinâmica e monitoramento com override de piloto emergencial.

---

## 1. Como executar

```bash
npm install        # dependências (express, ws, better-sqlite3, jsonwebtoken, bcryptjs, qrcode)
npm start          # sobe a plataforma em http://localhost:3333
```

Na **primeira execução** o servidor detecta a ausência do banco e executa a
autoinstalação: cria o arquivo `data/skym3d.sqlite`, aplica o schema (25 tabelas +
índices), grava os seeds operacionais e registra tudo em `install_log`.

Inspeção/CLI do instalador:

```bash
npm run installer            # verifica e informa o estado do banco
node src/installer.js --inspect   # lista usuários, rede de nós e passos gravados
npm run reset                # REINSTALA do zero (apaga dados)
```

Variáveis de ambiente: `PORT` (padrão 3333), `HOST`, `SKYM3D_DB`, `SKYM3D_DATA`,
`SKYM3D_SPEED` (segundos simulados por tick — padrão 8).

## 2. Contas criadas automaticamente (senha `sky2026`)

| Perfil | E-mail | Papel no ecossistema |
|---|---|---|
| Administrador | admin@sky.m3d.pro | organiza rotas, frota, nós, usuários, simulação |
| Remetente | remetente@sky.m3d.pro | registra pacotes e origem primária |
| Destinatário | destinatario@sky.m3d.pro | recebe pacotes e é ponto de entrada físico |
| Estação de distribuição | hub@sky.m3d.pro | operação de ponto de pouso/decolagem e recarga |
| Proprietário de drone | drone@sky.m3d.pro | oferece aeronave para integrar a rede |
| Piloto emergencial | piloto@sky.m3d.pro | override de rota, pouso emergencial, câmeras |
| Entidade reguladora | reguladora@sky.m3d.pro | acesso a manifesto, permissões e relatórios |

## 3. Mapa funcional → arquivo

| Módulo | Arquivo / rota principal |
|---|---|
| Autoinstalação + schema + seeds | `src/db.js` (`install`, `seed`, `SCHEMA`) · `src/installer.js` · `GET /api/installer/status` · `POST /api/installer/run` · `GET /api/installer/db.sqlite` |
| Motor de simulação, rota com consciência de bateria, ETA, reroteamento | `src/sim.js` (`plan`, `createMission`, `tick`, `autoDiversion`, `override`, `triangulation`, `predictive`) |
| API REST + WebSocket + autenticação JWT/RBAC | `src/server.js` |
| Shell da UI, painéis e ação de cada botão | `public/index.html` · `public/app.js` |
| Visualizador 3D urbano + modelo 3D rotacionável do drone | `public/scene3d.js` (Three.js) |
| Triangulação dinâmica, minimapa de voo e câmeras | `public/maps.js` (Leaflet) |

## 4. Endpoints principais

```
GET  /api/health                     estado do serviço
GET  /api/installer/status           tabelas, contagens, schema, tamanho do banco
POST /api/installer/run {force}      revalida ou reinstala o banco
GET  /api/overview                   carga completa do workspace (KPIs, frota, nós, alertas)
POST /api/auth/login {email,password}
POST /api/missions/plan              rota com paradas de recarga automáticas
POST /api/missions                   despacha missão (start imediato)
GET  /api/missions/:id/live          posição, perna atual, ETA nó/destino, SOC
POST /api/missions/:id/override      hold | resume | emergency_landing | redirect | camera_reorient
POST /api/missions/:id/diversion     desvio emergencial (clima, bateria, risco)
GET  /api/triangulation              in/out/saldo por nó (triangulação dinâmica)
GET  /api/packages/:id/qr.png        QR rastreável (PNG)
GET  /api/packages/:id/manifest.json manifesto + permissões p/ reguladores
GET  /api/packages/:id/invoice       nota fiscal
GET  /api/packages/:id/predictive    origem/destino previstos + pontos de parada
POST /api/packages/:id/scan          leitura RFID / BLE / QR
PATCH /api/sim/settings/:projectId   altitude, densidade, vento (recalcula rotas)
POST /api/reports/generate           relatórios + CSV para consulta dinâmica
WS   /ws                             telemetria, triangulação e alertas ao vivo
```

## 5. Modelo de dados (25 tabelas)

`app_meta`, `install_log`, `users`, `projects`, `map_layers`, `airspace_zones`,
`sim_settings`, `network_nodes`, `drone_models`, `drones`, `packages`, `package_events`,
`missions`, `route_legs`, `telemetry`, `alerts`, `safety_reports`, `diversions`,
`camera_points`, `sensors`, `rfid_tags`, `jobs`, `reports`, `regulator_access`, `event_log`.

Tipos de nó (`network_nodes.kind`): `depot` (estação de distribuição), `rooftop`,
`micro`, `support` (apoio), `entry` (entrada primária) — cada um com `is_recharge`,
`is_primary_entry`, `accepts_inbound/outbound`, `pads`, `charger_kw` e `capacity_slots`.

---

sky.m3d.pro
