/* render.js: a canvas 2D painter's-algorithm renderer.
 *
 * There is no z-buffer and no 3D library. Everything with a footprint on the
 * ground goes into one list, that list is sorted by x + y, and it is painted
 * back to front.
 *
 * Layers: sky, ground, district washes, roads, THE SORTED PASS, then
 * screen-space labels with the world transform removed.
 */
(function (global) {
  'use strict';

  var Iso = global.Iso, World = global.World, Sim = global.Sim, Azure = global.Azure;
  var P = Iso.project;

  var cam = null, ctx = null, t = 0;
  var labels = [];
  var showLabels = true;
  var C = World.palette;

  /* ------------------------------------------------------------------ sky */

  function drawSky(w, h) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#eef3f6');
    g.addColorStop(0.55, '#e9eef0');
    g.addColorStop(1, '#e3e6e2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /* --------------------------------------------------------------- ground */

  function plate(inset, z) {
    return [
      P(inset, inset, z), P(World.GW - inset, inset, z),
      P(World.GW - inset, World.GH - inset, z), P(inset, World.GH - inset, z)
    ];
  }

  var GRASS = ['#8aa96a', '#93b073', '#83a463', '#9ab77c'];

  function drawGround() {
    ctx.fillStyle = 'rgba(120,124,110,0.30)';
    Iso.poly(ctx, plate(-0.9, -0.35));
    ctx.fillStyle = '#93b073';
    Iso.poly(ctx, plate(0, 0));
    for (var gx = 1; gx < World.GW; gx += 2) {
      for (var gy = 1; gy < World.GH; gy += 2) {
        var n = Iso.hash2(gx, gy, 17);
        if (n < 0.45) continue;
        ctx.fillStyle = GRASS[(n * 4) | 0];
        Iso.disc(ctx, gx + n, gy + (1 - n), 0, 0.7 + n * 0.5);
      }
    }
    ctx.strokeStyle = 'rgba(74,69,64,0.28)';
    ctx.lineWidth = 1.4;
    Iso.polyLine(ctx, plate(0, 0), true);
  }

  function drawZones(activeId) {
    for (var i = 0; i < World.districts.length; i++) {
      var d = World.districts[i];
      var on = d.id === activeId;
      ctx.fillStyle = Iso.rgba(d.color, on ? 0.16 : 0.055);
      Iso.disc(ctx, d.x, d.y, 0.01, d.r);
      if (on) {
        ctx.strokeStyle = Iso.rgba(d.color, 0.5);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        var p = P(d.x, d.y, 0.01);
        ctx.ellipse(p.x, p.y, d.r * Iso.TW * 1.41421, d.r * Iso.TH * 1.41421, 0, 0, 6.2832);
        ctx.stroke();
      }
    }
  }

  /* ---------------------------------------------------------------- roads */

  function roadQuad(a, b, width, dz) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len * width / 2, ny = dx / len * width / 2;
    var za = (a.z || 0) + (dz || 0), zb = (b.z || 0) + (dz || 0);
    Iso.poly(ctx, [
      P(a.x + nx, a.y + ny, za), P(b.x + nx, b.y + ny, zb),
      P(b.x - nx, b.y - ny, zb), P(a.x - nx, a.y - ny, za)
    ]);
  }

  function drawRoute(route, opts) {
    if (!route) return;
    var width = opts.width, i, s;

    ctx.fillStyle = opts.shoulder || C.road;
    for (i = 0; i < route.segs.length; i++) {
      s = route.segs[i];
      roadQuad(s.a, s.b, width + 0.5, 0);
      Iso.disc(ctx, s.a.x, s.a.y, s.a.z || 0, (width + 0.5) / 2);
    }
    var last = route.pts[route.pts.length - 1];
    Iso.disc(ctx, last.x, last.y, last.z || 0, (width + 0.5) / 2);

    ctx.fillStyle = opts.surface || C.roadTop;
    for (i = 0; i < route.segs.length; i++) {
      s = route.segs[i];
      roadQuad(s.a, s.b, width, 0.005);
      Iso.disc(ctx, s.a.x, s.a.y, (s.a.z || 0) + 0.005, width / 2);
    }
    Iso.disc(ctx, last.x, last.y, (last.z || 0) + 0.005, width / 2);

    ctx.strokeStyle = opts.dash || 'rgba(96,90,78,0.35)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    for (i = 0; i < route.pts.length; i++) {
      var p = P(route.pts[i].x, route.pts[i].y, (route.pts[i].z || 0) + 0.01);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawRoads() {
    var R = World.routes;
    drawRoute(R.out, { width: 2.6 });
    drawRoute(R.line, { width: 2.4 });
    drawRoute(R.public, { width: 2.2, surface: '#d2ccbd' });
    drawRoute(R.bastion, { width: 2.2, surface: '#c9d4c4', dash: 'rgba(95,138,82,0.45)' });
    drawRoute(R.pe, { width: 2.2, surface: '#c4c9d4', dash: 'rgba(74,122,155,0.45)' });
    drawRoute(R.yard, { width: 2.4 });
    drawRoute(R.reject, { width: 2.2, surface: '#d4b8b0', dash: 'rgba(168,90,68,0.55)' });
  }

  /* ----------------------------------------------------------- landmarks  */

  var FACE_ANG = Math.atan2(Iso.TH, Iso.TW);
  var FACE_U = Math.hypot(Iso.TW, Iso.TH);

  function drawGatePost(b) {
    Iso.box(ctx, { x: b.x - 0.28, y: b.y - 0.28, z: 0, w: 0.56, d: 0.56, h: 3.1, color: b.color });
  }

  function drawGateBeam(b) {
    Iso.box(ctx, { x: b.x - 0.3, y: b.y - 1.85, z: 3.1, w: 0.6, d: 3.7, h: 0.42, color: Iso.mix(b.color, '#ffffff', 0.25) });
  }

  function drawDesk(b) {
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 1.3, z: 0, w: 4.0, d: 2.6, h: 1.6, color: '#c4bedb',
      windows: { cols: 4, seed: 8, color: b.color } });
    Iso.box(ctx, { x: b.x - 1.5, y: b.y + 1.15, z: 0, w: 3.0, d: 0.7, h: 0.85, color: Iso.mix(b.color, '#ffffff', 0.2) });
    var live = Sim.state.station === 'rbac';
    Iso.box(ctx, { x: b.x - 0.45, y: b.y + 1.25, z: 0.85, w: 0.9, d: 0.45, h: 0.12, color: live ? '#7fc06a' : '#d8d3c6' });
  }

  function drawLock(b) {
    var locked = Sim.state.lock !== 'none';
    Iso.box(ctx, { x: b.x - 1.1, y: b.y - 0.9, z: 0, w: 2.2, d: 1.8, h: 1.7, color: locked ? '#8b5f96' : '#cbb6d3' });
    Iso.cylinder(ctx, { x: b.x, y: b.y, z: 1.7, r: 0.7, h: 1.15, color: locked ? '#6d4a78' : '#d5c3da' });
    Iso.box(ctx, { x: b.x - 0.18, y: b.y - 0.18, z: 2.55, w: 0.36, d: 0.36, h: 0.35, color: '#e8ddee' });
  }

  function drawPipes(b) {
    var i;
    for (i = 0; i < 3; i++) {
      Iso.cylinder(ctx, {
        x: b.x - 1.4 + i * 1.4, y: b.y, z: 0,
        r: 0.38, h: 1.4 + (i % 2) * 0.5,
        color: i === 1 ? '#3f8a86' : '#a9c4c2', ring: 0.4
      });
    }
    Iso.box(ctx, { x: b.x - 2.0, y: b.y - 0.22, z: 1.15, w: 4.0, d: 0.44, h: 0.28, color: '#7aa8a4' });
  }

  function drawFork(b) {
    Iso.cylinder(ctx, { x: b.x, y: b.y, z: 0, r: 0.18, h: 2.8, color: '#9c968a' });
    Iso.orientedBox(ctx, {
      x: b.x, y: b.y, z: 2.8, hx: 1, hy: 0, len: 2.2, wid: 0.16, h: 0.7,
      color: '#d9b491'
    });
  }

  function drawBastion(b) {
    Iso.box(ctx, { x: b.x - 1.3, y: b.y - 1.1, z: 0, w: 2.6, d: 2.2, h: 2.2, color: '#b9cdb4',
      windows: { cols: 3, seed: 6, color: b.color } });
    Iso.box(ctx, { x: b.x - 0.45, y: b.y - 0.45, z: 2.2, w: 0.9, d: 0.9, h: 1.1, color: '#6d9068' });
  }

  function drawEndpoint(b) {
    Iso.box(ctx, { x: b.x - 0.9, y: b.y - 0.7, z: 0, w: 1.8, d: 1.4, h: 0.7, color: '#b9c9d4' });
    Iso.box(ctx, { x: b.x - 0.55, y: b.y - 0.4, z: 0.7, w: 1.1, d: 0.8, h: 0.55, color: b.color });
  }

  function drawBarrier(b) {
    Iso.box(ctx, { x: b.x - 1.6, y: b.y - 0.25, z: 0, w: 3.2, d: 0.5, h: 1.1, color: '#b8503f' });
    Iso.box(ctx, { x: b.x - 1.7, y: b.y - 0.12, z: 1.1, w: 3.4, d: 0.24, h: 0.22, color: '#e8d3c4' });
  }

  function drawAcr(b) {
    Iso.box(ctx, { x: b.x - 1.5, y: b.y - 1.1, z: 0, w: 3.0, d: 2.2, h: 2.0, color: '#c8c2b2',
      panels: { cols: 3, seed: 3, color: '#ddd6c8' } });
  }

  function drawTower(b) {
    Iso.box(ctx, { x: b.x - 0.7, y: b.y - 0.7, z: 0, w: 1.4, d: 1.4, h: 5.4, color: '#d4b0b8',
      windows: { cols: 2, rows: 5, seed: 12, color: b.color } });
    Iso.box(ctx, { x: b.x - 0.95, y: b.y - 0.95, z: 5.4, w: 1.9, d: 1.9, h: 0.35, color: '#b05470' });
    var busy = Sim.state.station === 'monitor';
    var p = P(b.x, b.y, 5.9);
    ctx.fillStyle = Iso.rgba('#ffffff', busy ? 0.7 : 0.28);
    ctx.beginPath();
    ctx.arc(p.x, p.y, busy ? 5 + Math.sin(t * 3) * 1.2 : 4, 0, 6.2832);
    ctx.fill();
  }

  function drawAsr(b) {
    Iso.box(ctx, { x: b.x - 1.2, y: b.y - 0.9, z: 0, w: 2.4, d: 1.8, h: 0.45, color: '#c8c2b2' });
    Iso.box(ctx, { x: b.x - 0.7, y: b.y - 0.5, z: 0.45, w: 1.4, d: 1.0, h: 0.7, color: '#b3ab9a' });
  }

  function drawVault(b) {
    Iso.box(ctx, { x: b.x - 2.2, y: b.y - 1.6, z: 0, w: 4.4, d: 3.2, h: 2.9, color: '#c7b6d0',
      panels: { cols: 5, seed: 4, color: '#e2d5ea' } });
    var p = P(b.x, b.y + 1.6, 1.45);
    var rx = 1.15 * FACE_U, ry = 1.3 * Iso.TZ;
    ctx.fillStyle = Iso.shade(b.color, 0.95);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, rx, ry, FACE_ANG, 0, 6.2832);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,52,64,0.5)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    var spin = Sim.state.station === 'backup' ? t * 1.1 : 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(FACE_ANG);
    ctx.strokeStyle = 'rgba(60,52,64,0.55)';
    ctx.lineWidth = 1.8;
    for (var i = 0; i < 4; i++) {
      var a = spin + i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(-Math.cos(a) * rx * 0.72, -Math.sin(a) * ry * 0.72);
      ctx.lineTo(Math.cos(a) * rx * 0.72, Math.sin(a) * ry * 0.72);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.22, ry * 0.22, 0, 0, 6.2832);
    ctx.fill();
    ctx.restore();
  }

  function drawStack(b) {
    Iso.cylinder(ctx, { x: b.x, y: b.y, z: 0, r: 0.7, h: 5.2, color: '#cbbfae', ring: 0.25 });
    var busy = Sim.state.station === 'compute';
    for (var i = 0; i < 4; i++) {
      var ph = (t * 0.35 + i * 0.25) % 1;
      var p = P(b.x, b.y, 5.2 + ph * 3.4);
      ctx.fillStyle = Iso.rgba('#ffffff', (busy ? 0.5 : 0.24) * (1 - ph));
      ctx.beginPath();
      ctx.arc(p.x - ph * 12, p.y, 5 + ph * 13, 0, 6.2832);
      ctx.fill();
    }
  }

  function drawRooftop(o) {
    var m = 0.5;
    Iso.box(ctx, {
      x: o.x + m, y: o.y + m, z: o.z + o.h, w: Math.max(0.8, o.w - m * 2),
      d: Math.max(0.8, o.d - m * 2), h: 0.4, color: Iso.mix(o.rooftop, '#ffffff', 0.35)
    });
  }

  var KIND = {
    gatePost: drawGatePost, gateBeam: drawGateBeam, desk: drawDesk,
    lock: drawLock, pipes: drawPipes, fork: drawFork, bastion: drawBastion,
    endpoint: drawEndpoint, barrier: drawBarrier, acr: drawAcr,
    tower: drawTower, asr: drawAsr, vault: drawVault, stack: drawStack
  };

  /* ----------------------------------------------------------- silos
     One cylinder per redundancy copy. Count comes from the live plan, so
     the redundancy slider moves the silos because the model moved. */

  function drawSilo(i) {
    var p = World.siloPos(i);
    var live = Sim.state.station === 'storage';
    Iso.cylinder(ctx, {
      x: p.x, y: p.y, z: 0, r: 0.52, h: 1.6 + (live ? 0.12 : 0),
      color: i % 2 ? '#8fba8c' : '#a3c7a0', ring: 0.35
    });
  }

  /* -------------------------------------------------------- small props  */

  function drawLamp(p) {
    Iso.cylinder(ctx, { x: p.x, y: p.y, z: 0, r: 0.13, h: 2.7, color: '#9c968a' });
    Iso.box(ctx, { x: p.x - 0.28, y: p.y - 0.22, z: 2.7, w: 0.56, d: 0.44, h: 0.18, color: '#c8c2b2' });
  }

  function drawTree(p) {
    var n = Iso.hash2(p.x, p.y, p.seed || 1);
    Iso.cylinder(ctx, { x: p.x, y: p.y, z: 0, r: 0.18, h: 0.9 + n * 0.4, color: '#8a7358' });
    var r = 0.85 + n * 0.5;
    ctx.fillStyle = n < 0.5 ? '#5f8a52' : '#6d9068';
    Iso.disc(ctx, p.x, p.y, 1.5 + n * 0.8, r);
    ctx.fillStyle = Iso.rgba('#ffffff', 0.16);
    Iso.disc(ctx, p.x - r * 0.25, p.y - r * 0.25, 1.62 + n * 0.8, r * 0.6);
  }

  /* --------------------------------------------------------------- the cart
     Gauge = monthly cost against a $250 reference. Crates = redundancy
     copies. Both are live fields from compute(), not cargo art. */

  function drawVan(v) {
    var s = Sim.state;
    var plan = s.plan || Sim.planNow();
    var hx = v.dx, hy = v.dy;
    var z = v.z || 0;
    var denied = plan.status === 'denied';

    ctx.fillStyle = 'rgba(80,76,66,0.22)';
    Iso.disc(ctx, v.x, v.y, z + 0.01, 1.05);

    Iso.orientedBox(ctx, { x: v.x, y: v.y, z: z + 0.16, hx: hx, hy: hy, len: 2.5, wid: 1.25, h: 0.34, color: '#5c6a72' });
    Iso.orientedBox(ctx, { x: v.x - hx * 0.35, y: v.y - hy * 0.35, z: z + 0.5, hx: hx, hy: hy, len: 1.7, wid: 1.2, h: 1.0, color: denied ? '#e4d0c8' : '#eae6da' });
    Iso.orientedBox(ctx, { x: v.x + hx * 0.85, y: v.y + hy * 0.85, z: z + 0.5, hx: hx, hy: hy, len: 0.85, wid: 1.1, h: 0.76, color: denied ? '#8a3030' : '#b8503f' });

    var frac = Math.min(1, plan.costMonthly / 250);
    var px = -hy, py = hx;
    var side = (px + py) > 0 ? 1 : -1;
    var gx = v.x - hx * 0.35 + px * side * 0.63;
    var gy = v.y - hy * 0.35 + py * side * 0.63;
    var GLEN = 1.5;
    Iso.orientedBox(ctx, {
      x: gx, y: gy, z: z + 0.72, hx: hx, hy: hy, len: GLEN, wid: 0.03, h: 0.42,
      color: '#6d675c', edge: false
    });
    if (frac > 0) {
      Iso.orientedBox(ctx, {
        x: gx - hx * (GLEN * (1 - frac) / 2), y: gy - hy * (GLEN * (1 - frac) / 2),
        z: z + 0.74, hx: hx, hy: hy, len: Math.max(0.07, GLEN * frac - 0.06),
        wid: 0.05, h: 0.34,
        color: denied ? '#e4643f' : (frac > 0.66 ? '#e4643f' : frac > 0.33 ? '#e8b34a' : '#7fc06a'),
        edge: false
      });
    }

    var crates = plan.storage ? plan.storage.copies : 0;
    var i;
    for (i = 0; i < crates; i++) {
      var row = i % 2, col = (i / 2) | 0;
      Iso.orientedBox(ctx, {
        x: v.x - hx * (0.9 - col * 0.42) + px * (row ? 0.28 : -0.28),
        y: v.y - hy * (0.9 - col * 0.42) + py * (row ? 0.28 : -0.28),
        z: z + 1.5, hx: hx, hy: hy, len: 0.38, wid: 0.4, h: 0.34,
        color: i % 3 === 0 ? '#c2913c' : i % 3 === 1 ? '#a8926a' : '#b8a577'
      });
    }

    ctx.fillStyle = '#3f3a34';
    [[0.8, 0.5], [0.8, -0.5], [-0.8, 0.5], [-0.8, -0.5]].forEach(function (o) {
      Iso.disc(ctx, v.x + hx * o[0] + px * o[1], v.y + hy * o[0] + py * o[1], z + 0.14, 0.22);
    });
  }

  /* -------------------------------------------------------------- labels  */

  function drawLabels() {
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    ctx.textBaseline = 'middle';
    labels.sort(function (a, b) { return (b.pri || 0) - (a.pri || 0); });

    var placed = [];
    var i;
    for (i = 0; i < labels.length; i++) {
      var L = labels[i];
      var p = P(L.x, L.y, L.z);
      L.ax = p.x * cam.scale + cam.ox;
      L.ay = p.y * cam.scale + cam.oy;
      L.px = (L.size || 12) * Math.min(1.15, Math.max(0.92, cam.scale));
      ctx.font = (L.bold ? '600 ' : '') + L.px + 'px ' + fontOf(L);
      var wpx = ctx.measureText(L.text).width;
      var subw = L.sub ? ctx.measureText(L.sub).width * 0.85 : 0;
      L.boxW = Math.max(wpx, subw) + 16;
      L.boxH = L.sub ? L.px * 2.4 : L.px * 1.75;
      L.sy = L.lift ? L.ay - L.lift - L.boxH / 2 : L.ay;
      for (var tries = 0; tries < 10 && overlaps(L, placed); tries++) {
        L.sy -= L.boxH * 0.92;
      }
      placed.push(L);
    }
    for (i = 0; i < labels.length; i++) drawPlate(labels[i]);
  }

  function fontOf(L) {
    return L.mono
      ? 'ui-monospace, Menlo, Consolas, "Microsoft JhengHei", monospace'
      : '"Iowan Old Style", Palatino, "Palatino Linotype", "Microsoft JhengHei", "Noto Serif TC", Georgia, serif';
  }

  function overlaps(L, placed) {
    for (var i = 0; i < placed.length; i++) {
      var o = placed[i];
      if (Math.abs(L.ax - o.ax) < (L.boxW + o.boxW) / 2 + 2 &&
          Math.abs(L.sy - o.sy) < (L.boxH + o.boxH) / 2 + 2) return true;
    }
    return false;
  }

  function drawPlate(L) {
    var ax = L.ax, ay = L.ay, sy = L.sy, size = L.px;
    var boxW = L.boxW, boxH = L.boxH;
    ctx.textAlign = 'center';
    ctx.font = (L.bold ? '600 ' : '') + size + 'px ' + fontOf(L);

    if (L.lift) {
      ctx.strokeStyle = Iso.rgba(L.tint || '#6e6250', 0.6);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, sy + boxH / 2);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.fillStyle = Iso.rgba(L.tint || '#6e6250', 0.85);
      ctx.beginPath();
      ctx.arc(ax, ay, 2.4, 0, 6.2832);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(96,84,66,0.26)';
    roundRect(ax - boxW / 2 + 1, sy - boxH / 2 + 2.5, boxW, boxH, 5);
    ctx.fill();
    ctx.fillStyle = L.tint ? Iso.mix('#fffdf7', L.tint, 0.14) : '#fffdf7';
    roundRect(ax - boxW / 2, sy - boxH / 2, boxW, boxH, 5);
    ctx.fill();
    ctx.strokeStyle = Iso.rgba(L.tint || '#6e6250', 0.85);
    ctx.lineWidth = L.bold ? 1.7 : 1.2;
    roundRect(ax - boxW / 2, sy - boxH / 2, boxW, boxH, 5);
    ctx.stroke();

    ctx.fillStyle = L.color || '#3a352e';
    ctx.fillText(L.text, ax, sy + (L.sub ? -size * 0.42 : 0));
    if (L.sub) {
      ctx.font = (size * 0.85) + 'px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = 'rgba(88,80,68,0.75)';
      ctx.fillText(L.sub, ax, sy + size * 0.62);
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- draw  */

  function key(o) { return o.x + o.y + ((o.w || 0) + (o.d || 0)) * 0.5; }

  function draw(canvas, camera, time, activeDistrict, hoverDistrict) {
    ctx = canvas.getContext('2d');
    cam = camera;
    t = time;
    labels.length = 0;

    var w = canvas.width / cam.dpr, h = canvas.height / cam.dpr;
    ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
    drawSky(w, h);

    ctx.setTransform(cam.scale * cam.dpr, 0, 0, cam.scale * cam.dpr,
                     cam.ox * cam.dpr, cam.oy * cam.dpr);

    drawGround();
    drawZones(activeDistrict);
    drawRoads();

    var items = [];
    var i, s = Sim.state;
    var plan = s.plan || Sim.planNow();

    for (i = 0; i < World.buildings.length; i++) {
      var b = World.buildings[i];
      if (b.kind && KIND[b.kind]) items.push({ k: b.x + b.y, f: KIND[b.kind], a: b });
      else items.push({ k: key(b), f: null, a: b });
    }
    for (i = 0; i < World.props.length; i++) {
      var pr = World.props[i];
      items.push({ k: pr.x + pr.y, f: pr.kind === 'tree' ? drawTree : drawLamp, a: pr });
    }
    var copies = plan.storage ? plan.storage.copies : 0;
    for (i = 0; i < copies; i++) {
      var sp = World.siloPos(i);
      items.push({ k: sp.x + sp.y, f: drawSilo, a: i });
    }
    var v = Sim.vanPosition();
    items.push({ k: v.x + v.y + 0.2, f: drawVan, a: v });

    items.sort(function (p, q) { return p.k - q.k; });
    for (i = 0; i < items.length; i++) {
      if (items[i].f) { items[i].f(items[i].a); continue; }
      var o = items[i].a;
      Iso.box(ctx, o);
      if (o.roof) {
        Iso.gableRoof(ctx, {
          x: o.x - 0.08, y: o.y - 0.08, z: o.z + o.h,
          w: o.w + 0.16, d: o.d + 0.16, h: o.roofH || 0.45, color: o.roof
        });
      } else if (o.rooftop) {
        drawRooftop(o);
      }
    }

    if (showLabels) {
      var declutter = cam.scale < 0.34;
      for (i = 0; i < World.districts.length; i++) {
        var d = World.districts[i];
        var isActive = d.id === activeDistrict || d.id === hoverDistrict;
        if (declutter && !isActive) continue;
        var sub = isActive ? d.tag : null;
        if (s.charged && s.charged[d.id] != null) {
          var ph = null, j;
          for (j = 0; j < plan.phases.length; j++) if (plan.phases[j].id === d.id) ph = plan.phases[j];
          sub = ph && !ph.ok ? '已拒絕' : (d.tag || '已套用');
        }
        labels.push({
          x: d.x, y: d.y, z: 0, lift: isActive ? 34 : 26,
          text: d.name, sub: sub,
          color: isActive ? d.color : '#3d3831',
          tint: d.color,
          size: isActive ? 16.5 : 14, bold: isActive,
          pri: isActive ? 2 : 1
        });
      }
    }

    if (s.running) {
      labels.push({
        x: v.x, y: v.y, z: (v.z || 0) + 2.4, lift: 8,
        text: plan.status === 'denied' ? '拒絕' : Azure.fmtUsd(plan.costMonthly),
        sub: (plan.storage ? plan.storage.copies : 0) + ' 份複本 · ' + (plan.network ? ({ public: '公用', bastion: 'Bastion', pe: 'Private Endpoint' }[plan.network.path] || plan.network.path) : ''),
        color: plan.status === 'denied' ? '#8a3030' : '#3d3831',
        tint: plan.status === 'denied' ? '#b8503f' : '#8a8272',
        size: 14, bold: true, mono: true, pri: 3
      });
    }

    drawLabels();
  }

  global.Renderer = {
    draw: draw,
    setLabels: function (v) { showLabels = v; }
  };
})(window);
