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
    LRS:  { copies: 3, zones: 1, regions: 1, datacenters: 1, mult: 1.0,  note: '\u4e09\u4efd\uff0c1 \u500b\u8cc7\u6599\u4e2d\u5fc3\uff0c1 \u500b\u5340\u57df' },
    ZRS:  { copies: 3, zones: 3, regions: 1, datacenters: 3, mult: 1.2,  note: '\u4e09\u4efd\uff0c3 \u500b\u53ef\u7528\u6027\u5340\u57df\uff0c1 \u500b\u5340\u57df' },
    GRS:  { copies: 6, zones: 1, regions: 2, datacenters: 2, mult: 2.0,  note: '6 \u4efd\uff1a\u672c\u5340 LRS + \u914d\u5c0d\u5340\u57df LRS' },
    GZRS: { copies: 6, zones: 3, regions: 2, datacenters: 4, mult: 2.2,  note: '6 \u4efd\uff1a3 \u500b\u53ef\u7528\u6027\u5340\u57df + \u914d\u5c0d\u5340\u57df LRS' }
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
      if (!tags || !tags[key]) denies.push('\u7f3a\u5c11\u5fc5\u8981\u6a19\u7c64\uff1a' + key);
    }

    if (pack === 'full') {
      if (ALLOWED_LOCATIONS.indexOf(location) < 0) {
        denies.push('\u4f4d\u7f6e ' + location + ' \u4e0d\u5728\u5141\u8a31\u6e05\u55ae');
      }
      if (ALLOWED_SKUS.indexOf(sku) < 0) {
        denies.push('SKU ' + sku + ' \u4e0d\u5728\u5141\u8a31\u6e05\u55ae');
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
        note: '\u512a\u5148\u9806\u5e8f ' + hits[0].priority + ' ' + (hits[0].access === 'Allow' ? '\u5141\u8a31' : '\u62d2\u7d55')
      };
    }
    if (direction === 'inbound') {
      return { priority: 65500, access: 'Deny', protocol: '*', port: '*', source: '*', note: '\u9810\u8a2d\u8f38\u5165\u62d2\u7d55' };
    }
    return { priority: 65500, access: 'Allow', protocol: '*', port: '*', source: '*', note: '\u9810\u8a2d\u8f38\u51fa\u5141\u8a31' };
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
      Reader: '\u8b80\u53d6\u8005', Contributor: '\u53c3\u8207\u8005', Owner: '\u64c1\u6709\u8005',
      'User Access Administrator': '\u4f7f\u7528\u8005\u5b58\u53d6\u7cfb\u7d71\u7ba1\u7406\u54e1',
      'Virtual Machine Contributor': '\u865b\u64ec\u6a5f\u5668\u53c3\u8207\u8005',
      'Storage Blob Data Contributor': '\u5132\u5b58\u9ad4 Blob \u8cc7\u6599\u53c3\u8207\u8005'
    };
    var scopeNote = { mg: '\u7ba1\u7406\u7fa4\u7d44', sub: '\u8a02\u7528\u5e33\u6236', rg: '\u8cc7\u6e90\u7fa4\u7d44', resource: '\u8cc7\u6e90' };
    var pathNote = { public: '\u516c\u7528', bastion: 'Bastion', pe: 'Private Endpoint' };
    var typeNote = { vm: 'VM', aca: 'Container Apps', app: 'App Service' };
    var lockNote = { none: '\u7121\u9396\u5b9a', CanNotDelete: '\u7121\u6cd5\u522a\u9664', ReadOnly: '\u552f\u8b80' };
    var vaultNote = { rsv: 'RSV', abv: 'Backup vault' };

    var denyReason = null;
    var status = 'running';
    if (!rbacOk) {
      status = 'denied';
      denyReason = 'RBAC\uff1a' + (roleNote[p.role] || p.role) + ' \u5728' +
        (scopeNote[p.scope] || p.scope) + '\u4e0a\u6c92\u6709' +
        (p.computeType === 'vm' ? '\u5beb\u5165\u6216\u5beb\u5165 VM' : '\u5beb\u5165') +
        '\uff0c\u7121\u6cd5\u90e8\u7f72 ' + (typeNote[p.computeType] || p.computeType);
    } else if (!policyOk) {
      status = 'denied';
      denyReason = '\u539f\u5247\uff1a' + policyDenies.join('\uff1b');
    } else if (lockBlocksWrite) {
      status = 'denied';
      denyReason = '\u9396\u5b9a\uff1a\u552f\u8b80\u5373\u4f7f\u5c0d\u64c1\u6709\u8005\u4e5f\u6703\u64cb\u4f4f\u5efa\u7acb\uff0f\u66f4\u65b0';
    }

    var rejectAfterPolicy = !rbacOk || !policyOk;
    var phases = [
      { id: 'entra',   label: 'Entra \u6b0a\u6756',     ok: true,     note: '\u5df2\u7d81\u5b9a\u4f7f\u7528\u8005\u8207\u7fa4\u7d44\uff1b\u6b0a\u6756\u6a19\u70ba\u6709\u6548\uff08\u5047\u8a2d\uff0c\u7121 OIDC\uff09' },
      { id: 'rbac',    label: 'RBAC \u806f\u96c6',      ok: rbacOk,   note: fmtActions(actions) },
      { id: 'policy',  label: '\u539f\u5247\u8a55\u4f30',       ok: policyOk, note: policyOk ? (p.policyPack === 'off' ? '\u7d44\u5408\u95dc\u9589\uff1a\u7121\u62d2\u7d55' : '\u6a19\u7c64\uff0f\u4f4d\u7f6e\uff0fSKU \u5141\u8a31') : policyDenies.join('\uff1b') },
      { id: 'lock',    label: '\u6a19\u7c64\u8207\u9396\u5b9a',     ok: !lockBlocksWrite, note: lockNote[p.lock] || p.lock },
      { id: 'vnet',    label: 'NSG \u5148\u7b26\u5408\u8005\u52dd', ok: nsg443.access === 'Allow', note: '\u7ba1\u7406 443 \u4f86\u81ea ' + ({ Internet: '\u7db2\u969b\u7db2\u8def', AzureBastion: 'Azure Bastion', VirtualNetwork: '\u865b\u64ec\u7db2\u8def' }[src] || src) + ' \u2192 ' + (nsg443.access === 'Allow' ? '\u5141\u8a31' : '\u62d2\u7d55') },
      { id: 'access',  label: '\u5b58\u53d6\u8def\u5f91',       ok: true,     note: pathNote[p.accessPath] || p.accessPath },
      { id: 'storage', label: '\u5099\u63f4',           ok: true,     note: copies.copies + ' \u4efd\u8907\u672c \u00b7 ' + p.redundancy },
      { id: 'compute', label: '\u904b\u7b97',           ok: rbacOk && policyOk && !lockBlocksWrite, note: (typeNote[p.computeType] || p.computeType) + ' ' + p.size },
      { id: 'monitor', label: '\u77ad\u671b\u5854',         ok: true,     note: '\u8a08\u91cf\u958b\u555f\u300130 \u5929\u8a18\u9304\u30011 \u689d\u8b66\u793a' },
      { id: 'backup',  label: '\u4fdd\u96aa\u5eab',         ok: true,     note: (vaultNote[p.vault] || p.vault) + ' \u00b7 ' + p.retentionDays + ' \u5929 \u00b7 $' + backupUsd.toFixed(2) }
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
        azNote: '\u53ef\u7528\u6027\u5340\u57df\uff0c\u4e0d\u662f\u53ef\u7528\u6027\u8a2d\u5b9a\u7d44'
      },
      monitor: {
        metricsOn: true,
        logRetentionDays: 30,
        alerts: [{ name: 'cpu-or-http', actionGroup: 'ag-ops' }]
      },
      backup: {
        vault: p.computeType === 'vm' ? 'rsv' : 'abv',
        retentionDays: p.retentionDays,
        rpo: '\u6bcf\u65e5',
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
    if (n == null || isNaN(n)) return '\u2014';
    var v = Math.round(n * 100) / 100;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  }

  var ACTION_LABEL = {
    read: '\u8b80\u53d6', write: '\u5beb\u5165', 'delete': '\u522a\u9664', assignRole: '\u6307\u6d3e\u89d2\u8272',
    writeVm: '\u5beb\u5165 VM', deleteVm: '\u522a\u9664 VM',
    readBlob: '\u8b80\u53d6 Blob', writeBlob: '\u5beb\u5165 Blob', deleteBlob: '\u522a\u9664 Blob'
  };

  function fmtActions(actions) {
    if (!actions || !actions.length) return '\uff08\u7121\uff09';
    return actions.map(function (a) { return ACTION_LABEL[a] || a; }).join('\u3001');
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
