/* world.js: the control-plane city — routes, stations, districts, buildings.
 *
 * Nothing here animates and nothing here computes the lesson. This file only
 * answers "where is everything, and what does each place mean".
 *
 * Two contracts the rest of the code depends on:
 *   routes[name]      a polyline the cart drives, parameterised by distance
 *   stations[name]    distances along that polyline that fire a model step
 */
(function (global) {
  'use strict';

  var Iso = global.Iso;
  var makeRoute = Iso.makeRoute;

  /* ---- routes ------------------------------------------------------------ */

  /* Identity + governance, west to east. Policy Hall is the junction. */
  var OUT = makeRoute([
    [6, 12],       // 0 Entra Gate
    [18, 12],      // 1 Role Desk
    [30, 12]       // 2 Policy Hall
  ]);

  /* Deny spur: leaves Policy Hall north, ends at the reject pad. */
  var REJECT = makeRoute([
    [30, 12],
    [30, 4],
    [44, 4]
  ]);

  /* Allowed path: lock, VNet, then the access fork. */
  var LINE = makeRoute([
    [30, 12],      // 0 Policy Hall
    [44, 12],      // 1 Tag & Lock Yard
    [58, 12],      // 2 VNet Yards
    [72, 12]       // 3 Access Fork
  ]);

  var PUBLIC = makeRoute([
    [72, 12],
    [84, 12]
  ]);

  var BASTION = makeRoute([
    [72, 12],
    [72, 18],
    [84, 18],
    [84, 12]
  ]);

  var PE = makeRoute([
    [72, 12],
    [72, 4],
    [84, 4],
    [84, 12]
  ]);

  var YARD = makeRoute([
    [84, 12],      // 0 Storehouse
    [84, 22],      // 1 Compute Shed
    [70, 22],      // 2 Watchtower
    [54, 22]       // 3 Vault
  ]);

  function station(route, idx, id, dwell) {
    return { dist: route.cum[idx], id: id, dwell: dwell == null ? 0.8 : dwell };
  }

  var STATIONS = {
    out: [
      station(OUT, 0, 'entra', 1.4),
      station(OUT, 1, 'rbac', 1.6),
      station(OUT, 2, 'policy', 1.8)
    ],
    reject: [
      station(REJECT, 2, 'deny', 1.6)
    ],
    line: [
      station(LINE, 1, 'lock', 1.4),
      station(LINE, 2, 'vnet', 1.6),
      station(LINE, 3, 'access', 1.6)
    ],
    public: [],
    bastion: [],
    pe: [],
    yard: [
      station(YARD, 0, 'storage', 1.6),
      station(YARD, 1, 'compute', 1.6),
      station(YARD, 2, 'monitor', 1.4),
      station(YARD, 3, 'backup', 1.6)
    ]
  };

  var STATION_TO_DISTRICT = {
    entra: 'entra', rbac: 'rbac', policy: 'policy', lock: 'lock',
    vnet: 'vnet', access: 'access', storage: 'storage', compute: 'compute',
    monitor: 'monitor', backup: 'backup', deny: 'deny'
  };

  /* ---- palette ----------------------------------------------------------- */

  var C = {
    steel:  '#4a7a9b',
    violet: '#6f63a8',
    ochre:  '#c2913c',
    stone:  '#7d8b96',
    rose:   '#b05470',
    sage:   '#6d9068',
    teal:   '#3f8a86',
    orange: '#c07a3c',
    brick:  '#a85a44',
    moss:   '#5f8a52',
    plum:   '#8b5f96',
    ink:    '#4a4540',
    paper:  '#e5e1d5',
    road:   '#c9c4b6',
    roadTop:'#d8d3c6'
  };

  /* ---- districts --------------------------------------------------------- */

  var DISTRICTS = [
    {
      id: 'entra', name: 'Entra 大門', x: 6, y: 12, r: 4.4, color: C.steel,
      tag: '身分 20–25%',
      short: '租用戶擁有 Microsoft Entra ID。此門綁定一位使用者與一個群組，並將權杖標為有效。',
      body: '訂用帳戶活在租用戶底下。管理群組巢狀於訂用帳戶之上。資源群組是部署與生命週期邊界——它們不包含租用戶。名稱是 Microsoft Entra ID，不是 Azure AD。授權、SSPR 與外部使用者在考試大綱上，此處不模擬：推車離開此門的瞬間，權杖即假設為有效。沒有執行 OIDC。'
    },
    {
      id: 'rbac', name: '角色櫃檯', x: 18, y: 12, r: 4.2, color: C.violet,
      tag: '加性聯集',
      short: '在選定範圍指派一個內建角色。有效動作是範圍涵蓋該資源的每一筆指派之聯集。',
      body: '管理群組上的角色涵蓋該訂用帳戶及其下每一個資源群組。此資源群組上的角色不涵蓋兄弟資源群組。擁有者與使用者存取系統管理員可以指派角色。參與者不行——寫入不是指派角色。虛擬機器參與者有 writeVm，能落地 VM，不能落地 Azure Container Apps 或 App Service。讀取者只有讀取。此櫃檯是存取控制。原則是下一間大廳，它不是一種 RBAC。'
    },
    {
      id: 'policy', name: '原則大廳', x: 30, y: 12, r: 4.4, color: C.ochre,
      tag: '治理，不是 RBAC',
      short: 'Azure Policy 評估必要標籤、允許的位置與允許的 SKU。此處拒絕即使 RBAC 已允許寫入也會勝出。',
      body: '原則是治理，不是存取控制。缺少必要標籤、落到錯誤區域、或選了不允許的 SKU，都會拒絕要求。推車走此廳北側的拒絕岔線，之後的場不再執行。鎖定也不是此廳——它們在允許道路的下一站。轉動原則組合與大小滑桿：拒絕原因是算出來的，不是查表。'
    },
    {
      id: 'lock', name: '標籤與鎖定場', x: 44, y: 12, r: 4.2, color: C.plum,
      tag: '與 RBAC 正交',
      short: '標籤是中繼資料。無法刪除與唯讀即使對擁有者也會擋住刪除或更新。',
      body: '鎖定不是角色。資源群組上的唯讀擋住建立與更新；無法刪除擋住刪除，建立不受影響。面板上的成本是來自一小張費率表的每月估算，不是即時 Azure 價格。Advisor 有點名，沒有建模。預算數字會動，是因為費率表又跑了一次，不是因為呼叫了價格 API。'
    },
    {
      id: 'vnet', name: 'VNet 場', x: 58, y: 12, r: 4.4, color: C.teal,
      tag: '先符合者勝',
      short: 'NIC 落到一個子網路。NSG 評估是先符合者勝：優先順序數字最小者勝出。',
      body: 'Azure 預設是輸入拒絕、輸出允許，兩者優先順序都是 65500。22/443 的管理流量會對照存取路徑建出的規則表。對等互連與 UDR 在考試上，此處不計算。一個 VNet、一個子網路、一張 NIC——刻意縮尺。看推車走不同岔路時，有效動作如何改變。'
    },
    {
      id: 'access', name: '存取岔路', x: 72, y: 12, r: 4.6, color: C.orange,
      tag: '公用 · Bastion · PE',
      short: '三種進去的方式。路本身分岔。Private Endpoint 不是服務端點。',
      body: '公用 IP 坐在 NIC 上。Azure Bastion 是 VNet 裡的受控跳板主機——南迴圈。Private Endpoint 是你子網路裡一張面向 PaaS 的 NIC——北迴圈。服務端點是通往 PaaS 的 VNet 路由，不是 NIC。兩者不能互換。你看的推車是選擇這三條之一的 ARM 要求，不是資料平面上的封包。'
    },
    {
      id: 'storage', name: '倉庫', x: 84, y: 12, r: 4.4, color: C.sage,
      tag: '複本數是算出來的',
      short: 'LRS 與 ZRS 保留三份。GRS 與 GZRS 保留六份。筒倉就是那個數字。',
      body: 'LRS：一個資料中心三份。ZRS：同一區域三個可用性區域各一份。GRS：本區 LRS 加上配對區域 LRS。GZRS：三個可用性區域加上配對區域的 LRS。存取是帳戶金鑰、SAS 或 Entra 身分——路徑滑桿決定哪一種。虛刪除、生命週期與版本設定有點名，不模擬。Blob 虛刪除不是 Azure Backup。保險庫還有兩站。'
    },
    {
      id: 'compute', name: '運算棚', x: 84, y: 22, r: 4.4, color: C.brick,
      tag: 'VM · ACA · App Service',
      short: '這輛推車上的紙，全程都是一筆 ARM 要求。一支滑桿涵蓋三種執行階段。',
      body: 'VM 有大小與可用性區域。可用性區域不是可用性設定組。App Service 以方案計費；Web 應用程式坐在方案上。Azure Container Apps 是 2026 年大綱上的應用程式平台。隔壁 ACR 是登錄，不是執行階段。ACI 跑容器。ARM/Bicep 沒有真正編譯：編譯是假的。SKU 與類型會改費率表總額，因為算術又跑了一次。'
    },
    {
      id: 'monitor', name: '瞭望塔', x: 70, y: 22, r: 4.2, color: C.rose,
      tag: '監視 10–15%',
      short: '計量開啟、記錄保留天數、一條警示規則與一個動作群組。',
      body: 'Network Watcher 有點名。KQL 刻意不在範圍內。此站存在，是為了讓監視網域在路上有位置，不是為了跑查詢引擎。警示是推車上的標籤：一條規則、一個動作群組。保險庫的保留是下一塊墊，數字與這裡的記錄保留不同。'
    },
    {
      id: 'backup', name: '保險庫', x: 54, y: 22, r: 4.4, color: C.moss,
      tag: 'RSV 或 Backup vault',
      short: '保留 7／30／90／180 天。金額是 0.05 × 磁碟 GB ×（天數／30）。',
      body: 'Recovery Services vault 或 Azure Backup vault——兩者都出現在 2026 年大綱。RPO 顯示為每日（假設）。Site Recovery 是配對區域上有標籤的墊，不是現場容錯移轉演練。Blob 上的虛刪除不是這座保險庫。拖動保留天數看估算移動：那是公式，不是價目表。'
    },
    {
      id: 'deny', name: '拒絕墊', x: 44, y: 4, r: 4.0, color: C.brick,
      tag: '已拒絕',
      short: '原則或 RBAC 拒絕了要求。其餘的場不再執行。',
      body: '缺少寫入、缺少標籤、錯誤位置或不允許的 SKU，部署在此結束。鎖定沒有做成這樣——推車從未到達鎖定場。改角色、SKU 或原則組合，再送一次推車。面板上的拒絕原因是模型產出的字串，不是圖說。'
    }
  ];

  var DISTRICT_BY_ID = {};
  DISTRICTS.forEach(function (d) { DISTRICT_BY_ID[d.id] = d; });

  function readSeconds(stationId) {
    var d = DISTRICT_BY_ID[STATION_TO_DISTRICT[stationId] || stationId];
    if (!d) return 9;
    var chars = (d.short + d.body).replace(/\s+/g, '').length;
    return Math.min(26, Math.max(9, chars / 12 + 3.5));
  }

  /* ---- buildings and props ----------------------------------------------- */

  var buildings = [];
  var props = [];

  function put(o) { buildings.push(o); return o; }

  function block(x, y, o) {
    put({
      x: x, y: y, z: 0, w: o.w, d: o.d, h: o.h, color: o.color,
      roof: o.roof, roofH: o.roofH,
      windows: { cols: o.cols || 3, seed: Math.round(x * 7 + y * 13), color: o.lit }
    });
  }

  var ALL_ROUTES = [OUT, REJECT, LINE, PUBLIC, BASTION, PE, YARD];

  function distToRoutes(x, y) {
    var best = 1e9;
    ALL_ROUTES.forEach(function (r) {
      r.segs.forEach(function (s) {
        var vx = s.b.x - s.a.x, vy = s.b.y - s.a.y;
        var t = ((x - s.a.x) * vx + (y - s.a.y) * vy) / (vx * vx + vy * vy || 1);
        t = Math.max(0, Math.min(1, t));
        var d = Math.hypot(x - (s.a.x + vx * t), y - (s.a.y + vy * t));
        if (d < best) best = d;
      });
    });
    return best;
  }

  /* Silos on the storehouse apron: one per redundancy copy. */
  var SILO_MAX = 6;
  function siloPos(i) {
    var col = i % 3, row = (i / 3) | 0;
    return { x: 87.2 + col * 1.45, y: 6.4 + row * 1.55 };
  }

  function build() {
    if (buildings.length) return;

    /* -- Entra Gate: posts over the road, tenant house set back ----------- */
    [5.0, 7.0].forEach(function (gx) {
      put({ kind: 'gatePost', x: gx, y: 10.2, color: C.steel });
      put({ kind: 'gateBeam', x: gx, y: 12.0, color: C.steel });
      put({ kind: 'gatePost', x: gx, y: 13.8, color: C.steel });
    });
    block(2.2, 4.6, { w: 3.4, d: 2.6, h: 3.2, color: '#c3d0d9', cols: 3, lit: C.steel, roof: '#9aa8b2', roofH: 0.6 });
    block(8.6, 4.8, { w: 2.6, d: 2.2, h: 2.0, color: '#b9c9d4', cols: 2, lit: C.steel });

    /* -- Role Desk: a counter facing the road ------------------------------ */
    put({ kind: 'desk', x: 18.0, y: 5.4, color: C.violet });
    block(14.4, 4.6, { w: 2.4, d: 2.2, h: 2.4, color: '#c4bedb', cols: 2, lit: C.violet });
    block(20.6, 4.8, { w: 2.6, d: 2.2, h: 1.8, color: '#b6afd0', cols: 3, lit: C.violet });

    /* -- Policy Hall: a wide hall, well set back --------------------------- */
    put({
      x: 26.6, y: 3.8, z: 0, w: 6.4, d: 3.6, h: 3.4, color: '#ddc79a',
      panels: { cols: 6, seed: 11, color: '#eed7bd' }, rooftop: C.ochre
    });
    block(33.4, 4.4, { w: 2.2, d: 2.0, h: 2.0, color: '#e0c1a2', cols: 2, lit: C.ochre });

    /* -- Tag & Lock Yard --------------------------------------------------- */
    put({ kind: 'lock', x: 44.0, y: 5.2, color: C.plum });
    block(40.2, 4.6, { w: 2.4, d: 2.2, h: 2.0, color: '#cbb6d3', cols: 2, lit: C.plum });
    block(47.0, 4.8, { w: 2.6, d: 2.0, h: 1.8, color: '#d5c3da', cols: 3, lit: C.plum });

    /* -- VNet Yards: pipes set back, not on the carriageway ---------------- */
    put({ kind: 'pipes', x: 58.0, y: 5.0, color: C.teal });
    block(53.6, 4.4, { w: 2.4, d: 2.2, h: 2.2, color: '#a9c4c2', cols: 2, lit: C.teal });
    block(61.4, 4.6, { w: 2.2, d: 2.0, h: 1.8, color: '#b6cdcb', cols: 2, lit: C.teal });

    /* -- Access Fork: a signpost; the roads are the lesson ----------------- */
    put({ kind: 'fork', x: 72.0, y: 8.4, color: C.orange });
    block(68.4, 5.0, { w: 2.2, d: 2.0, h: 1.8, color: '#d9b491', cols: 2, lit: C.orange });

    /* -- Bastion house on the south loop ----------------------------------- */
    put({ kind: 'bastion', x: 78.0, y: 18.0, color: C.moss });

    /* -- Private-endpoint NIC on the north loop ---------------------------- */
    put({ kind: 'endpoint', x: 78.0, y: 2.2, color: C.steel });

    /* -- Reject barrier ---------------------------------------------------- */
    put({ kind: 'barrier', x: 44.0, y: 2.2, color: C.brick });

    /* -- Storehouse: wide shed; silos are drawn live from copy count ------- */
    put({
      x: 80.6, y: 5.4, z: 0, w: 5.2, d: 3.2, h: 2.6, color: '#b9cdb4',
      panels: { cols: 5, seed: 7, color: '#d4e2cf' }, rooftop: C.sage
    });

    /* -- Compute Shed + ACR warehouse next door (registry, not runtime) ---- */
    put({
      x: 86.4, y: 24.2, z: 0, w: 4.4, d: 3.4, h: 3.0, color: '#d6b8ac',
      panels: { cols: 4, seed: 9, color: '#eed7bd' }, rooftop: C.brick
    });
    put({ kind: 'acr', x: 81.0, y: 25.2, color: C.stone });
    put({ kind: 'stack', x: 90.2, y: 25.6, color: C.brick });

    /* -- Watchtower -------------------------------------------------------- */
    put({ kind: 'tower', x: 70.0, y: 25.6, color: C.rose });
    block(66.2, 24.8, { w: 2.2, d: 2.0, h: 1.8, color: '#d4b0b8', cols: 2, lit: C.rose });

    /* -- Vault + Site Recovery pad (label only) ---------------------------- */
    put({ kind: 'vault', x: 54.0, y: 25.4, color: C.moss });
    put({ kind: 'asr', x: 48.4, y: 25.6, color: C.stone });
    block(57.6, 24.8, { w: 2.4, d: 2.0, h: 1.8, color: '#b9cdb4', cols: 2, lit: C.moss });

    /* -- scenery: hash2, never Math.random() ------------------------------- */
    var spots = [
      [10, 5], [22, 16], [36, 16], [50, 16], [64, 16], [12, 16],
      [24, 20], [40, 20], [52, 16], [10, 20], [20, 24], [36, 26],
      [46, 16], [62, 26], [76, 26], [90, 16], [90, 8], [16, 6],
      [4, 16], [4, 22], [40, 26], [64, 6], [50, 6], [88, 28]
    ];
    spots.forEach(function (s, i) {
      if (distToRoutes(s[0], s[1]) < 2.6) return;
      var n = Iso.hash2(s[0], s[1], 3);
      if (n < 0.34) {
        block(s[0], s[1], {
          w: 1.8 + n * 1.6, d: 1.6 + n, h: 1.4 + n * 1.6,
          color: n < 0.18 ? '#d8cfbe' : '#cfc7b6', cols: 2, lit: '#8b9aa4',
          roof: '#b09a86', roofH: 0.5
        });
      } else {
        props.push({ kind: n < 0.72 ? 'tree' : 'lamp', x: s[0], y: s[1], seed: i });
      }
    });
    for (var k = 0; k < 5; k++) {
      var lx = 10 + k * 12;
      props.push({ kind: 'lamp', x: lx, y: k % 2 ? 14.1 : 9.9, seed: lx });
    }
  }

  global.World = {
    GW: 94, GH: 30,
    routes: {
      out: OUT, reject: REJECT, line: LINE,
      public: PUBLIC, bastion: BASTION, pe: PE, yard: YARD
    },
    pillars: [],
    stations: STATIONS,
    districts: DISTRICTS,
    districtById: DISTRICT_BY_ID,
    stationToDistrict: STATION_TO_DISTRICT,
    readSeconds: readSeconds,
    buildings: buildings,
    props: props,
    palette: C,
    siloPos: siloPos, SILO_MAX: SILO_MAX,
    distToRoutes: distToRoutes,
    build: build
  };
})(window);
