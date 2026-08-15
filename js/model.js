/* model.js: how an Azure admin actually lands a resource.
 *
 * THIS IS THE LESSON. Real arithmetic at reduced scale. Sliders move
 * numbers because compute() ran again — there is no table of pre-baked
 * results. Every figure the panel shows comes out of the functions below.
 *
 * Fidelity (copied into About and the README):
 *
 *   Computed   RBAC inheritance + action union; policy deny; NSG first-match;
 *              redundancy copy count; monthly cost from the rate card;
 *              backup storage estimate.
 *   Scaled     role actions are a handful of verbs; one VNet, one subnet,
 *              one NIC; one policy set; a few VM SKUs.
 *   Assumed    token is valid after Entra Gate (no real OIDC); one region;
 *              one subscription; 730-hour month; daily backup RPO.
 *   Faked      Entra token cryptography; real ARM/Bicep compile; live Azure
 *              retail prices; Site Recovery failover; Advisor recommendations;
 *              SSPR/licenses/external users; AzCopy; full load-balancer datapath.
 *   Indicative building sizes, district labels, any number in narration
 *              that is not on the panel.
 */
(function (global) {
  'use strict';

  /* ---- catalogs ---------------------------------------------------------- */

  var ROLE_ACTIONS = {
    Reader: ['read'],
    Contributor: ['read', 'write', 'delete'],
    Owner: ['read', 'write', 'delete', 'assignRole'],
    'User Access Administrator': ['read', 'assignRole'],
    'Virtual Machine Contributor': ['read', 'writeVm', 'deleteVm'],
    'Storage Blob Data Contributor': ['readBlob', 'writeBlob', 'deleteBlob']
  };

  var ROLE_NAMES = [
    'Reader',
    'Contributor',
    'Owner',
    'User Access Administrator',
    'Virtual Machine Contributor',
    'Storage Blob Data Contributor'
  ];

  /* Depth in the management hierarchy. A smaller number is higher up:
     an assignment at `mg` contains every scope below it. */
  var SCOPE_RANK = { mg: 0, sub: 1, rg: 2, resource: 3 };
  var SCOPE_NAMES = ['mg', 'sub', 'rg', 'resource'];

  var VM_RATES = { B1s: 10, B2s: 30, D2s_v5: 70, D4s_v5: 140 };
  var SIZES = ['B1s', 'B2s', 'D2s_v5', 'D4s_v5'];
  var SIZE_INSTANCES = { B1s: 1, B2s: 2, D2s_v5: 2, D4s_v5: 4 };
  var SIZE_PLAN = { B1s: 1, B2s: 2, D2s_v5: 2, D4s_v5: 4 };

  var REDUNDANCY = {
    LRS:  { copies: 3, zones: 1, regions: 1, datacenters: 1, mult: 1.0,  note: '3 份，1 個資料中心，1 個區域' },
    ZRS:  { copies: 3, zones: 3, regions: 1, datacenters: 3, mult: 1.2,  note: '3 份，3 個可用性區域，1 個區域' },
    GRS:  { copies: 6, zones: 1, regions: 2, datacenters: 2, mult: 2.0,  note: '6 份：本區 LRS + 配對區域 LRS' },
    GZRS: { copies: 6, zones: 3, regions: 2, datacenters: 4, mult: 2.2,  note: '6 份：3 個可用性區域 + 配對區域 LRS' }
  };

  var RETENTIONS = [7, 30, 90, 180];
  var HOURS_MONTH = 730;

  var DEFAULT_TAGS = { env: 'prod', owner: 'ops' };
  var REQUIRED_TAGS = ['env', 'owner'];
  var ALLOWED_LOCATIONS = ['eastus'];
  var ALLOWED_SKUS = ['B1s', 'B2s'];

  /* ---- RBAC -------------------------------------------------------------- */

  /* Assignment scope S contains resource scope R when S is at or above R
     on the same chain. A role at this RG does not cover a sibling RG —
     that is a different chain, represented here as `sibling`. */
  function scopeContains(assignmentScope, resourceScope) {
    if (resourceScope === 'sibling') return assignmentScope === 'mg' || assignmentScope === 'sub';
    return SCOPE_RANK[assignmentScope] <= SCOPE_RANK[resourceScope];
  }

  function unionActions(assignments, resourceScope) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < assignments.length; i++) {
      var a = assignments[i];
      if (!scopeContains(a.scope, resourceScope)) continue;
      var verbs = ROLE_ACTIONS[a.name] || [];
      for (var j = 0; j < verbs.length; j++) {
        if (!seen[verbs[j]]) {
          seen[verbs[j]] = true;
          out.push(verbs[j]);
        }
      }
    }
    return out;
  }

  function hasAction(actions, name) {
    for (var i = 0; i < actions.length; i++) if (actions[i] === name) return true;
    return false;
  }

  /* VM can land with write (Contributor/Owner) or the narrower writeVm.
     Container Apps and App Service need a general write — writeVm is not it. */
  function neededAction(computeType) {
    return computeType === 'vm' ? 'writeVm' : 'write';
  }

  function rbacAllows(actions, computeType) {
    if (computeType === 'vm') return hasAction(actions, 'write') || hasAction(actions, 'writeVm');
    return hasAction(actions, 'write');
  }

  /* ---- Policy ------------------------------------------------------------ */

  function evaluatePolicy(pack, tags, location, sku) {
    var denies = [];
    if (pack === 'off') return denies;

    var i, key;
    for (i = 0; i < REQUIRED_TAGS.length; i++) {
      key = REQUIRED_TAGS[i];
      if (!tags || !tags[key]) denies.push('缺少必要標籤：' + key);
    }

    if (pack === 'full') {
      if (ALLOWED_LOCATIONS.indexOf(location) < 0) {
        denies.push('位置 ' + location + ' 不在允許清單');
      }
      if (ALLOWED_SKUS.indexOf(sku) < 0) {
        denies.push('SKU ' + sku + ' 不在允許清單');
      }
    }
    return denies;
  }

  /* ---- NSG --------------------------------------------------------------- */

  /* First match: sort inbound by priority ascending. A rule matches when
     direction, protocol, port and source all agree (* is a wildcard).
     Azure default: inbound deny, outbound allow, both at 65500. */
  function ruleMatches(rule, direction, protocol, port, source) {
    if (rule.direction !== direction) return false;
    if (rule.protocol !== '*' && rule.protocol !== protocol) return false;
    if (rule.port !== '*' && rule.port !== port) return false;
    if (rule.source !== '*' && rule.source !== source) return false;
    return true;
  }

  function nsgFirstMatch(rules, direction, protocol, port, source) {
    var hits = [];
    var i;
    for (i = 0; i < rules.length; i++) {
      if (ruleMatches(rules[i], direction, protocol, port, source)) hits.push(rules[i]);
    }
    hits.sort(function (a, b) { return a.priority - b.priority; });
    if (hits.length) {
      return {
        priority: hits[0].priority,
        access: hits[0].access,
        protocol: hits[0].protocol,
        port: hits[0].port,
        source: hits[0].source,
        note: '優先順序 ' + hits[0].priority + ' ' + (hits[0].access === 'Allow' ? '允許' : '拒絕')
      };
    }
    if (direction === 'inbound') {
      return { priority: 65500, access: 'Deny', protocol: '*', port: '*', source: '*', note: '預設輸入拒絕' };
    }
    return { priority: 65500, access: 'Allow', protocol: '*', port: '*', source: '*', note: '預設輸出允許' };
  }

  function nsgRulesFor(path) {
    var rules = [
      { priority: 65500, direction: 'inbound',  access: 'Deny',  protocol: '*',   port: '*',   source: '*' },
      { priority: 65500, direction: 'outbound', access: 'Allow', protocol: '*',   port: '*',   source: '*' }
    ];
    if (path === 'public') {
      rules.push({ priority: 100, direction: 'inbound', access: 'Allow', protocol: 'Tcp', port: 443, source: 'Internet' });
      rules.push({ priority: 110, direction: 'inbound', access: 'Allow', protocol: 'Tcp', port: 22,  source: 'Internet' });
    } else if (path === 'bastion') {
      rules.push({ priority: 100, direction: 'inbound', access: 'Allow', protocol: 'Tcp', port: 443, source: 'AzureBastion' });
      rules.push({ priority: 110, direction: 'inbound', access: 'Allow', protocol: 'Tcp', port: 22,  source: 'AzureBastion' });
    } else if (path === 'pe') {
      rules.push({ priority: 100, direction: 'inbound', access: 'Allow', protocol: 'Tcp', port: 443, source: 'VirtualNetwork' });
    }
    return rules;
  }

  function mgmtSource(path) {
    if (path === 'bastion') return 'AzureBastion';
    if (path === 'pe') return 'VirtualNetwork';
    return 'Internet';
  }

  /* ---- storage / backup / cost ------------------------------------------ */

  function storageCopies(redundancy) {
    var r = REDUNDANCY[redundancy] || REDUNDANCY.LRS;
    return {
      redundancy: redundancy,
      copies: r.copies,
      zones: r.zones,
      regions: r.regions,
      datacenters: r.datacenters,
      note: r.note
    };
  }

  function backupEstimate(diskGb, retentionDays) {
    return 0.05 * diskGb * (retentionDays / 30);
  }

  function monthlyCost(p) {
    var size = p.size;
    var compute = 0;
    var instances = SIZE_INSTANCES[size] || 1;
    if (p.computeType === 'vm') {
      compute = VM_RATES[size] || 0;
    } else if (p.computeType === 'aca') {
      compute = 30 * instances;
    } else if (p.computeType === 'app') {
      compute = 55 * (SIZE_PLAN[size] || 1);
    }

    var disk = p.computeType === 'vm' ? (4 + 0.15 * p.diskGb) : 0;
    var pip = p.accessPath === 'public' ? 4 : 0;
    var bastion = p.accessPath === 'bastion' ? 140 : 0;
    var red = REDUNDANCY[p.redundancy] || REDUNDANCY.LRS;
    var storage = 2 + red.mult;
    var backup = backupEstimate(p.diskGb, p.retentionDays);

    return {
      compute: compute,
      disk: disk,
      pip: pip,
      bastion: bastion,
      storage: storage,
      backup: backup,
      total: compute + disk + pip + bastion + storage + backup,
      hours: HOURS_MONTH,
      instances: instances
    };
  }

  /* ---- the whole request ------------------------------------------------- */

  function defaults(p) {
    p = p || {};
    return {
      role: p.role || 'Contributor',
      scope: p.scope || 'rg',
      policyPack: p.policyPack || 'off',
      lock: p.lock || 'none',
      accessPath: p.accessPath || 'public',
      redundancy: p.redundancy || 'LRS',
      computeType: p.computeType || 'vm',
      size: p.size || 'B2s',
      retentionDays: p.retentionDays == null ? 30 : p.retentionDays,
      diskGb: p.diskGb == null ? 128 : p.diskGb,
      location: p.location || 'eastus',
      tags: p.tags || { env: DEFAULT_TAGS.env, owner: DEFAULT_TAGS.owner },
      vault: p.vault || (p.computeType === 'vm' || !p.computeType ? 'rsv' : 'abv')
    };
  }

  function compute(raw) {
    var p = defaults(raw);
    var assignments = [{ name: p.role, scope: p.scope }];
    var actions = unionActions(assignments, 'rg');
    var siblingActions = unionActions(assignments, 'sibling');
    var need = neededAction(p.computeType);
    var rbacOk = rbacAllows(actions, p.computeType);
    var canAssign = hasAction(actions, 'assignRole');

    var policyDenies = evaluatePolicy(p.policyPack, p.tags, p.location, p.size);
    var policyOk = policyDenies.length === 0;

    var lockBlocksWrite = p.lock === 'ReadOnly';

    var rules = nsgRulesFor(p.accessPath);
    var src = mgmtSource(p.accessPath);
    var nsg443 = nsgFirstMatch(rules, 'inbound', 'Tcp', 443, src);
    var nsgInternet = nsgFirstMatch(rules, 'inbound', 'Tcp', 443, 'Internet');
    var nsgOut = nsgFirstMatch(rules, 'outbound', 'Tcp', 443, '*');

    var copies = storageCopies(p.redundancy);
    var cost = monthlyCost(p);
    var backupUsd = cost.backup;

    var accessKind = p.accessPath === 'public' ? 'key' : (p.accessPath === 'bastion' ? 'sas' : 'identity');

    var roleNote = {
      Reader: '讀取者', Contributor: '參與者', Owner: '擁有者',
      'User Access Administrator': '使用者存取系統管理員',
      'Virtual Machine Contributor': '虛擬機器參與者',
      'Storage Blob Data Contributor': '儲存體 Blob 資料參與者'
    };
    var scopeNote = { mg: '管理群組', sub: '訂用帳戶', rg: '資源群組', resource: '資源' };
    var pathNote = { public: '公用', bastion: 'Bastion', pe: 'Private Endpoint' };
    var typeNote = { vm: 'VM', aca: 'Container Apps', app: 'App Service' };
    var lockNote = { none: '無鎖定', CanNotDelete: '無法刪除', ReadOnly: '唯讀' };
    var vaultNote = { rsv: 'RSV', abv: 'Backup vault' };

    var denyReason = null;
    var status = 'running';
    if (!rbacOk) {
      status = 'denied';
      denyReason = 'RBAC：' + (roleNote[p.role] || p.role) + ' 在' +
        (scopeNote[p.scope] || p.scope) + '上沒有' +
        (p.computeType === 'vm' ? '寫入或寫入 VM' : '寫入') +
        '，無法部署 ' + (typeNote[p.computeType] || p.computeType);
    } else if (!policyOk) {
      status = 'denied';
      denyReason = '原則：' + policyDenies.join('；');
    } else if (lockBlocksWrite) {
      status = 'denied';
      denyReason = '鎖定：唯讀即使對擁有者也會擋住建立／更新';
    }

    var rejectAfterPolicy = !rbacOk || !policyOk;
    var phases = [
      { id: 'entra',   label: 'Entra 權杖',     ok: true,     note: '已綁定使用者與群組；權杖標為有效（假設，無 OIDC）' },
      { id: 'rbac',    label: 'RBAC 聯集',      ok: rbacOk,   note: fmtActions(actions) },
      { id: 'policy',  label: '原則評估',       ok: policyOk, note: policyOk ? (p.policyPack === 'off' ? '組合關閉：無拒絕' : '標籤／位置／SKU 允許') : policyDenies.join('；') },
      { id: 'lock',    label: '標籤與鎖定',     ok: !lockBlocksWrite, note: lockNote[p.lock] || p.lock },
      { id: 'vnet',    label: 'NSG 先符合者勝', ok: nsg443.access === 'Allow', note: '管理 443 來自 ' + ({ Internet: '網際網路', AzureBastion: 'Azure Bastion', VirtualNetwork: '虛擬網路' }[src] || src) + ' → ' + (nsg443.access === 'Allow' ? '允許' : '拒絕') },
      { id: 'access',  label: '存取路徑',       ok: true,     note: pathNote[p.accessPath] || p.accessPath },
      { id: 'storage', label: '備援',           ok: true,     note: copies.copies + ' 份複本 · ' + p.redundancy },
      { id: 'compute', label: '運算',           ok: rbacOk && policyOk && !lockBlocksWrite, note: (typeNote[p.computeType] || p.computeType) + ' ' + p.size },
      { id: 'monitor', label: '瞭望塔',         ok: true,     note: '計量開啟、30 天記錄、1 條警示' },
      { id: 'backup',  label: '保險庫',         ok: true,     note: (vaultNote[p.vault] || p.vault) + ' · ' + p.retentionDays + ' 天 · $' + backupUsd.toFixed(2) }
    ];

    return {
      principal: { kind: 'user', upn: 'alex@contoso.com', groups: ['rg-admins'] },
      token: { valid: true, source: 'entra' },
      roles: assignments,
      actions: actions,
      siblingActions: siblingActions,
      siblingCovered: siblingActions.length > 0,
      coveredScopes: SCOPE_NAMES.filter(function (s) { return scopeContains(p.scope, s); }),
      canAssignRole: canAssign,
      neededAction: need,
      rbacOk: rbacOk,
      policy: {
        pack: p.policyPack,
        requiredTags: p.policyPack === 'off' ? [] : REQUIRED_TAGS.slice(),
        allowedLocations: p.policyPack === 'full' ? ALLOWED_LOCATIONS.slice() : [],
        allowedSkus: p.policyPack === 'full' ? ALLOWED_SKUS.slice() : [],
        denies: policyDenies
      },
      policyOk: policyOk,
      tags: p.tags,
      lock: p.lock,
      lockBlocksWrite: lockBlocksWrite,
      placement: { mg: 'mg-corp', sub: 'sub-prod', rg: 'rg-app', location: p.location },
      network: {
        vnet: 'vnet-app',
        subnet: 'snet-app',
        nsgRules: rules,
        effectiveAction: nsg443,
        internet443: nsgInternet,
        outbound: nsgOut,
        path: p.accessPath,
        mgmtPort: 443,
        mgmtSource: src
      },
      storage: {
        account: 'stapp001',
        redundancy: p.redundancy,
        copies: copies.copies,
        zones: copies.zones,
        regions: copies.regions,
        datacenters: copies.datacenters,
        access: accessKind,
        diskGb: p.diskGb,
        note: copies.note
      },
      compute: {
        type: p.computeType,
        sku: p.size,
        zones: p.computeType === 'vm' ? 1 : 0,
        instances: cost.instances,
        azNote: '可用性區域，不是可用性設定組'
      },
      monitor: {
        metricsOn: true,
        logRetentionDays: 30,
        alerts: [{ name: 'cpu-or-http', actionGroup: 'ag-ops' }]
      },
      backup: {
        vault: p.computeType === 'vm' ? 'rsv' : 'abv',
        retentionDays: p.retentionDays,
        rpo: '每日',
        estimate: backupUsd
      },
      cost: cost,
      costMonthly: cost.total,
      status: status,
      denyReason: denyReason,
      rejectAfterPolicy: rejectAfterPolicy,
      phases: phases,
      inputs: p
    };
  }

  /* A cart starts empty. Each station copies the fields that desk is
     responsible for off the live plan. Travel owns nothing. */
  function blank() {
    return {
      principal: { kind: 'user', upn: '', groups: [] },
      token: { valid: false, source: null },
      roles: [],
      actions: [],
      canAssignRole: false,
      tags: {},
      lock: 'none',
      lockBlocksWrite: false,
      placement: { mg: '', sub: '', rg: '', location: '' },
      network: { vnet: '', subnet: '', nsgRules: [], effectiveAction: null, path: '', mgmtPort: 443 },
      storage: { account: '', redundancy: '', copies: 0, access: '', diskGb: 0 },
      compute: { type: '', sku: '', zones: 0, instances: 0 },
      monitor: { metricsOn: false, logRetentionDays: 0, alerts: [] },
      backup: { vault: '', retentionDays: 0, estimate: 0 },
      costMonthly: 0,
      status: 'pending',
      denyReason: null,
      applied: []
    };
  }

  function apply(cart, id, plan) {
    cart.applied.push(id);
    switch (id) {
      case 'entra':
        cart.principal = plan.principal;
        cart.token = plan.token;
        cart.placement = plan.placement;
        break;
      case 'rbac':
        cart.roles = plan.roles;
        cart.actions = plan.actions;
        cart.canAssignRole = plan.canAssignRole;
        if (!plan.rbacOk) {
          cart.status = 'denied';
          cart.denyReason = plan.denyReason;
        }
        break;
      case 'policy':
        cart.tags = plan.tags;
        if (!plan.policyOk) {
          cart.status = 'denied';
          cart.denyReason = plan.denyReason;
        }
        break;
      case 'lock':
        cart.lock = plan.lock;
        cart.lockBlocksWrite = plan.lockBlocksWrite;
        cart.tags = plan.tags;
        if (plan.lockBlocksWrite) {
          cart.status = 'denied';
          cart.denyReason = plan.denyReason;
        }
        break;
      case 'vnet':
        cart.network = plan.network;
        break;
      case 'access':
        cart.network = plan.network;
        break;
      case 'storage':
        cart.storage = plan.storage;
        break;
      case 'compute':
        cart.compute = plan.compute;
        if (plan.status === 'running') cart.status = 'running';
        cart.costMonthly = plan.costMonthly;
        break;
      case 'monitor':
        cart.monitor = plan.monitor;
        break;
      case 'backup':
        cart.backup = plan.backup;
        cart.costMonthly = plan.costMonthly;
        if (plan.status === 'running' && cart.status !== 'denied') cart.status = 'running';
        break;
      case 'deny':
        cart.status = 'denied';
        if (!cart.denyReason) cart.denyReason = plan.denyReason;
        break;
    }
    return cart;
  }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) return '—';
    var v = Math.round(n * 100) / 100;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  }

  var ACTION_LABEL = {
    read: '讀取', write: '寫入', 'delete': '刪除', assignRole: '指派角色',
    writeVm: '寫入 VM', deleteVm: '刪除 VM',
    readBlob: '讀取 Blob', writeBlob: '寫入 Blob', deleteBlob: '刪除 Blob'
  };

  function fmtActions(actions) {
    if (!actions || !actions.length) return '（無）';
    return actions.map(function (a) { return ACTION_LABEL[a] || a; }).join('、');
  }

  global.Azure = {
    ROLE_ACTIONS: ROLE_ACTIONS,
    ROLE_NAMES: ROLE_NAMES,
    SCOPE_RANK: SCOPE_RANK,
    VM_RATES: VM_RATES,
    SIZES: SIZES,
    REDUNDANCY: REDUNDANCY,
    RETENTIONS: RETENTIONS,
    HOURS_MONTH: HOURS_MONTH,
    REQUIRED_TAGS: REQUIRED_TAGS,
    ALLOWED_LOCATIONS: ALLOWED_LOCATIONS,
    ALLOWED_SKUS: ALLOWED_SKUS,
    scopeContains: scopeContains,
    unionActions: unionActions,
    neededAction: neededAction,
    rbacAllows: rbacAllows,
    evaluatePolicy: evaluatePolicy,
    nsgFirstMatch: nsgFirstMatch,
    nsgRulesFor: nsgRulesFor,
    storageCopies: storageCopies,
    backupEstimate: backupEstimate,
    monthlyCost: monthlyCost,
    compute: compute,
    defaults: defaults,
    blank: blank,
    apply: apply,
    fmtUsd: fmtUsd,
    fmtActions: fmtActions
  };
})(typeof window !== 'undefined' ? window : globalThis);
