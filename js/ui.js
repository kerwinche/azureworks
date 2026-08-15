/* ui.js: DOM panels, controls, narration.
 *
 * The canvas shows the mechanism; this file shows the numbers. Every widget
 * here reads Sim.state or calls Azure.compute — nothing is stored twice.
 */
(function (global) {
  'use strict';

  var Sim = global.Sim, World = global.World, Azure = global.Azure;

  var $ = function (id) { return document.getElementById(id); };

  var el = {};
  var activeDistrict = null;
  var pinnedDistrict = null;
  var lastPaint = 0;
  var flyTo = null;
  var sheetOpen = false;

  var STATION_LABEL = {
    entra: '身分', rbac: '角色', policy: '原則', lock: '鎖定',
    vnet: 'NSG', access: '岔路', storage: '倉庫', compute: '運算',
    monitor: '監看', backup: '保險庫', deny: '拒絕', done: '完成'
  };

  var ROLE_LABEL = {
    Reader: '讀取者',
    Contributor: '參與者',
    Owner: '擁有者',
    'User Access Administrator': '使用者存取系統管理員',
    'Virtual Machine Contributor': '虛擬機器參與者',
    'Storage Blob Data Contributor': '儲存體 Blob 資料參與者'
  };

  var SCOPE_LABEL = { mg: '管理群組', sub: '訂用帳戶', rg: '資源群組' };

  var ROLES = Azure.ROLE_NAMES;
  var SCOPES = ['mg', 'sub', 'rg'];
  var PACKS = ['off', 'tags', 'full'];
  var PACK_LABEL = { off: '關閉', tags: '要求標籤', full: '標籤+位置+SKU' };
  var LOCKS = ['none', 'CanNotDelete', 'ReadOnly'];
  var LOCK_LABEL = { none: '無', CanNotDelete: '無法刪除', ReadOnly: '唯讀' };
  var PATHS = ['public', 'bastion', 'pe'];
  var PATH_LABEL = { public: '公用', bastion: 'Bastion', pe: 'Private Endpoint' };
  var REDS = ['LRS', 'ZRS', 'GRS', 'GZRS'];
  var TYPES = ['vm', 'aca', 'app'];
  var TYPE_LABEL = { vm: 'VM', aca: 'Container Apps', app: 'App Service' };
  var SIZES = Azure.SIZES;
  var RETS = Azure.RETENTIONS;
  var STATUS_LABEL = { pending: '待處理', denied: '已拒絕', running: '執行中' };
  var NSG_ACCESS = { Allow: '允許', Deny: '拒絕' };

  /* ------------------------------------------------------------------ init */

  function init() {
    [
      'stage-chip', 'stage-tag', 'stage-name', 'stage-short', 'stage-body',
      'dwell', 'dwell-bar', 'dwell-hint',
      'wf-list', 'wf-hint', 'sum-cost', 'sum-actions', 'sum-copies', 'sum-nsg',
      'sum-note', 'district-chips',
      'hud-phase', 'hud-status', 'hud-cost', 'hud-path', 'hud-note',
      'inspector', 'btn-run', 'btn-play', 'play-glyph', 'btn-step', 'btn-reset',
      'speed', 'role', 'scope', 'pack', 'lock', 'path', 'redundancy',
      'ctype', 'size', 'retain',
      'v-speed', 'v-role', 'v-scope', 'v-pack', 'v-lock', 'v-path',
      'v-redundancy', 'v-ctype', 'v-size', 'v-retain',
      'follow', 'labels',
      'btn-about', 'about', 'about-close', 'btn-panel', 'tooltip',
      'sheet-handle', 'btn-tune', 'dock', 'dock-tune'
    ].forEach(function (id) { el[id] = $(id); });

    buildChips();
    wire();
    applyResponsiveLabels();

    Sim.on(function (name, payload) {
      if (name === 'station') onStation(payload);
      if (name === 'reset') { pinnedDistrict = null; paint(true); }
    });
  }

  function buildChips() {
    World.districts.forEach(function (d) {
      var b = document.createElement('button');
      b.textContent = d.name;
      b.dataset.id = d.id;
      b.addEventListener('click', function () {
        showDistrict(d, true);
        flyTo = { x: d.x, y: d.y };
      });
      el['district-chips'].appendChild(b);
    });
  }

  function wire() {
    el['btn-run'].addEventListener('click', function () { Sim.run(); paint(true); });
    el['btn-play'].addEventListener('click', function () { Sim.toggle(); paint(true); });
    el['btn-step'].addEventListener('click', function () { Sim.step(); });
    el['btn-reset'].addEventListener('click', function () { Sim.replayTour(); Sim.run(); paint(true); });

    bindRange('speed', 'v-speed', function (v) {
      Sim.state.speed = v;
      return v.toFixed(2) + '×';
    });
    bindDiscrete('role', 'v-role', ROLES, function (name) {
      Sim.state.role = name;
      return ROLE_LABEL[name] || name;
    });
    bindDiscrete('scope', 'v-scope', SCOPES, function (name) {
      Sim.state.scope = name;
      return SCOPE_LABEL[name] || name;
    });
    bindDiscrete('pack', 'v-pack', PACKS, function (name) {
      Sim.state.policyPack = name;
      return PACK_LABEL[name];
    });
    bindDiscrete('lock', 'v-lock', LOCKS, function (name) {
      Sim.state.lock = name;
      return LOCK_LABEL[name] || name;
    });
    bindDiscrete('path', 'v-path', PATHS, function (name) {
      Sim.state.accessPath = name;
      return PATH_LABEL[name];
    });
    bindDiscrete('redundancy', 'v-redundancy', REDS, function (name) {
      Sim.state.redundancy = name;
      return name;
    });
    bindDiscrete('ctype', 'v-ctype', TYPES, function (name) {
      Sim.state.computeType = name;
      return TYPE_LABEL[name];
    });
    bindDiscrete('size', 'v-size', SIZES, function (name) {
      Sim.state.size = name;
      return name;
    });
    bindDiscrete('retain', 'v-retain', RETS, function (n) {
      Sim.state.retentionDays = n;
      return n + ' 天';
    });

    el.labels.addEventListener('change', function () { global.Renderer.setLabels(el.labels.checked); });

    el['btn-about'].addEventListener('click', function () { el.about.hidden = false; });
    el['about-close'].addEventListener('click', function () { el.about.hidden = true; });
    el.about.addEventListener('click', function (e) { if (e.target === el.about) el.about.hidden = true; });

    el['btn-panel'].addEventListener('click', function () {
      var hidden = el.inspector.classList.toggle('hidden');
      el['btn-panel'].setAttribute('aria-expanded', String(!hidden));
      applyResponsiveLabels();
    });
    window.addEventListener('resize', applyResponsiveLabels);

    el['sheet-handle'].addEventListener('click', function () { setSheet(!sheetOpen); });

    el['btn-tune'].addEventListener('click', function () {
      var open = el.dock.classList.toggle('tune-open');
      el['btn-tune'].setAttribute('aria-expanded', String(open));
      el['btn-tune'].title = open ? '隱藏設定' : '顯示設定';
    });
  }

  function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }

  function applyResponsiveLabels() {
    var hidden = el.inspector.classList.contains('hidden');
    var narrow = isMobile();
    el['btn-panel'].textContent = narrow ? (hidden ? '面板' : '隱藏')
                                         : (hidden ? '顯示面板' : '隱藏面板');
    el['btn-about'].textContent = narrow ? '關於' : '關於與準確度';
    el['dwell-hint'].innerHTML = narrow
      ? '閱讀停留：點下方 <b>❚❚</b> 停在此處'
      : '閱讀停留：按 <kbd>Space</kbd> 停在此處';
  }

  function setSheet(open) {
    sheetOpen = open;
    el.inspector.classList.toggle('open', open);
    el['sheet-handle'].setAttribute('aria-expanded', String(open));
    if (open) el.inspector.scrollTop = 0;
  }

  function bindRange(id, out, fn) {
    var input = el[id];
    var apply = function () {
      el[out].textContent = fn(parseFloat(input.value));
      paint(true);
    };
    input.addEventListener('input', apply);
    el[out].textContent = fn(parseFloat(input.value));
  }

  function bindDiscrete(id, out, list, fn) {
    var input = el[id];
    var apply = function () {
      var item = list[input.value | 0];
      el[out].textContent = fn(item);
      paint(true);
    };
    input.addEventListener('input', apply);
    el[out].textContent = fn(list[input.value | 0]);
  }

  /* -------------------------------------------------------------- narration */

  function onStation(station) {
    var id = station === 'done' ? null : (World.stationToDistrict[station] || station);
    activeDistrict = id;
    if (!pinnedDistrict && id) {
      var d = World.districtById[id];
      if (d) writeCard(d, station);
    }
    if (station === 'done') writeDone();
    paint(true);
  }

  function writeCard(d, station) {
    el['stage-chip'].textContent = STATION_LABEL[station] || d.id;
    el['stage-chip'].style.color = d.color;
    el['stage-chip'].style.background = global.Iso.rgba(d.color, 0.14);
    el['stage-chip'].style.borderColor = global.Iso.rgba(d.color, 0.3);
    el['stage-tag'].textContent = d.tag;
    el['stage-name'].textContent = d.name;
    el['stage-short'].textContent = d.short;
    el['stage-body'].textContent = d.body;
  }

  function writeDone() {
    var plan = Sim.state.plan || Sim.planNow();
    el['stage-chip'].textContent = '完成';
    el['stage-tag'].textContent = STATUS_LABEL[plan.status] || plan.status;
    if (plan.status === 'denied') {
      el['stage-name'].textContent = '部署已拒絕';
      el['stage-short'].textContent = plan.denyReason || '要求已被拒絕。';
      el['stage-body'].textContent = '推車沒有走完工廠線。改角色、SKU、鎖定或原則組合，再按「執行」。拒絕原因是模型產出的字串。';
    } else {
      el['stage-name'].textContent = '資源已落地';
      el['stage-short'].textContent = '費率表每月估算 ' + Azure.fmtUsd(plan.costMonthly) +
        '。' + plan.storage.copies + ' 份複本。路徑 ' + (PATH_LABEL[plan.network.path] || plan.network.path) + '。';
      el['stage-body'].textContent = '那個金額不是即時 Azure 價格。動一支滑桿：數字會動，因為 compute() 又跑了一次。重設（⟲）重播慢速導覽；執行保留你已經讀過的。';
    }
  }

  function showDistrict(d, pin) {
    pinnedDistrict = pin ? d.id : null;
    writeCard(d, Sim.state.station);
    if (pin) {
      el['stage-chip'].textContent = '已釘選';
      el['stage-tag'].textContent = d.tag + ' · 點空白地面繼續';
      if (isMobile()) setSheet(true);
    }
    updateChips();
  }

  function updateChips() {
    var kids = el['district-chips'].children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('on', kids[i].dataset.id === (pinnedDistrict || activeDistrict));
    }
  }

  /* ------------------------------------------------------------------ paint */

  function paint(force) {
    var now = performance.now();
    if (!force && now - lastPaint < 90) return;
    lastPaint = now;

    var s = Sim.state;
    var plan = s.plan || Sim.planNow();

    el['play-glyph'].textContent = s.paused || s.finished ? '▶' : '❚❚';

    el['hud-phase'].textContent = s.station ? (STATION_LABEL[s.station] || s.station) : '閒置';
    el['hud-status'].textContent = STATUS_LABEL[plan.status] || plan.status;
    el['hud-cost'].textContent = Azure.fmtUsd(plan.costMonthly);
    el['hud-path'].textContent = PATH_LABEL[plan.network.path] || plan.network.path;
    el['hud-note'].textContent = hudNote(s, plan);

    var showing = s.reading && s.dwellTotal > 0 && s.dwellLeft > 0;
    el.dwell.hidden = !showing;
    if (showing) {
      el['dwell-bar'].style.width = (s.dwellLeft / s.dwellTotal * 100).toFixed(1) + '%';
    }

    paintPhases(s, plan);
    paintSummary(s, plan);
    updateChips();
  }

  function hudNote(s, plan) {
    if (s.finished) return plan.denyReason || '';
    if (s.reading) return '停在此處，方便閱讀面板';
    if (!s.running) return '按「執行」送出一筆 ARM 要求穿越這座城。';
    if (s.denied && s.station === 'policy') return '拒絕岔線：原則或 RBAC 已拒絕；此廳之後的場不再執行';
    if (s.tourDone) return '各區已講完，其餘以正常速度跑（把速度往下拉可放慢）';
    return plan.denyReason || '';
  }

  function paintPhases(s, plan) {
    var max = 1;
    plan.cost && plan.cost.total > max && (max = plan.cost.total);

    el['wf-hint'].textContent = s.charged
      ? '已套用 ' + Object.keys(s.charged).length + '／' + plan.phases.length
      : '預估';

    el['wf-list'].innerHTML = plan.phases.map(function (p) {
      var paid = s.charged && s.charged[p.id] != null;
      var live = s.station === p.id;
      var skipped = plan.rejectAfterPolicy && (p.id === 'lock' || p.id === 'vnet' || p.id === 'access' ||
        p.id === 'storage' || p.id === 'compute' || p.id === 'monitor' || p.id === 'backup');
      var cls = 'bar' + (paid ? ' paid' : '') + (live ? ' live' : '') + (skipped || !p.ok ? ' cut' : '');
      return '<div class="' + cls + '" title="' + escapeHtml(p.note) + '">' +
        '<span class="lbl">' + escapeHtml(p.label) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + (p.ok ? '100' : '18') + '%"></span></span>' +
        '<span class="val">' + (p.ok ? '通過' : '拒絕') + '</span></div>';
    }).join('');
  }

  function paintSummary(s, plan) {
    el['sum-cost'].textContent = Azure.fmtUsd(plan.costMonthly);
    el['sum-actions'].textContent = Azure.fmtActions(plan.actions);
    el['sum-copies'].textContent = plan.storage.copies + ' · ' + plan.storage.redundancy;
    var nsg = plan.network.effectiveAction;
    el['sum-nsg'].textContent = (NSG_ACCESS[nsg.access] || nsg.access) + ' ' + plan.network.mgmtPort + ' @ ' + nsg.priority;

    var bits = [];
    bits.push('費率表，730 小時月，不是即時 Azure 價格。');
    bits.push('兄弟資源群組' + (plan.siblingCovered ? '被' : '不被') +
      (SCOPE_LABEL[plan.inputs.scope] || plan.inputs.scope) + '指派涵蓋。');
    bits.push(plan.canAssignRole ? '此角色可以指派角色。' : '此角色不能指派角色（參與者不行）。');
    if (plan.denyReason) bits.push(plan.denyReason);
    else bits.push('網際網路:443 → ' + (NSG_ACCESS[plan.network.internet443.access] || plan.network.internet443.access) +
      ' · 備份 ' + Azure.fmtUsd(plan.backup.estimate) + '（已計算）。');
    el['sum-note'].textContent = bits.join(' ');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  global.UI = {
    init: init,
    paint: paint,
    run: function () { Sim.run(); paint(true); },
    resetAll: function () { Sim.replayTour(); Sim.run(); paint(true); },
    showDistrict: showDistrict,
    unpin: function () { pinnedDistrict = null; updateChips(); },
    activeDistrict: function () { return pinnedDistrict || activeDistrict; },
    takeFlyTo: function () { var f = flyTo; flyTo = null; return f; },
    el: el
  };
})(window);
