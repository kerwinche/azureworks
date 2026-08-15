/* sim.js: the state machine that walks one ARM request through the city.
 *
 * This is the pacing engine. Three ideas do all the work:
 *
 *   1. The cart moves along a route by distance, and a station fires when it
 *      passes one. Stations own the model steps; travel owns nothing.
 *   2. The FIRST time a station fires, the cart stops for as long as its
 *      write-up takes to read. Every later visit gets a short beat instead.
 *   3. What the reader has already read (`tour`) lives outside the run state,
 *      so a reset replays the run but not the reading.
 */
(function (global) {
  'use strict';

  var Azure = global.Azure;
  var World = global.World;
  var Iso = global.Iso;

  var BASE_SPEED = 6;        // grid units / second at 1x

  /* Which districts the reader has already had explained. This deliberately
     survives a reset, because nobody wants to re-read the tour. */
  var tour = { seen: Object.create(null), done: false };

  var state = {
    running: false,
    paused: true,
    finished: false,

    station: null,
    stationT: 0,
    stepMode: false,
    speed: 1,

    /* ---- model inputs, wired to the sliders in ui.js ---- */
    role: 'Contributor',
    scope: 'rg',
    policyPack: 'off',
    lock: 'none',
    accessPath: 'public',
    redundancy: 'LRS',
    computeType: 'vm',
    size: 'B2s',
    retentionDays: 30,
    diskGb: 128,
    location: 'eastus',

    /* ---- model output ---- */
    plan: null,
    charged: null,
    cart: null,
    denied: false,
    elapsedMs: 0,
    cargoBytes: 0,
    requests: 0,
    lastTotal: 0,
    maxRequests: 1,

    /* ---- pacing ---- */
    reading: false,
    dwellLeft: 0,
    dwellTotal: 0,
    fastForward: false,
    tourDone: false
  };

  var van = {
    routeName: 'out',
    dist: 0,
    dwell: 0,
    stationIdx: 0
  };

  var listeners = [];
  function emit(name, payload) {
    for (var i = 0; i < listeners.length; i++) listeners[i](name, payload);
  }

  /* ---- the model ---------------------------------------------------------- */

  /* Recomputed whenever it is needed rather than cached, so dragging a slider
     mid-trip changes the numbers that have not been charged yet. */
  function planNow() {
    return Azure.compute({
      role: state.role,
      scope: state.scope,
      policyPack: state.policyPack,
      lock: state.lock,
      accessPath: state.accessPath,
      redundancy: state.redundancy,
      computeType: state.computeType,
      size: state.size,
      retentionDays: state.retentionDays,
      diskGb: state.diskGb,
      location: state.location
    });
  }

  function charge(id) {
    state.plan = planNow();
    Azure.apply(state.cart, id, state.plan);
    var note = id;
    var i;
    for (i = 0; i < state.plan.phases.length; i++) {
      if (state.plan.phases[i].id === id) { note = state.plan.phases[i].note; break; }
    }
    state.charged[id] = note;
    state.elapsedMs = state.plan.costMonthly;
    state.cargoBytes = state.plan.storage.copies * 65536;
    if (state.plan.rejectAfterPolicy) state.denied = true;
    return note;
  }

  /* ---- lifecycle --------------------------------------------------------- */

  function beginTrip() {
    state.charged = Object.create(null);
    state.elapsedMs = 0;
    state.cargoBytes = 0;
    state.station = null;
    state.plan = planNow();
    state.denied = false;
    state.cart = Azure.blank();
    state.fastForward = state.requests > 0;
    van.routeName = 'out';
    van.dist = 0;
    van.stationIdx = 0;
    van.dwell = 0;
  }

  function reset() {
    state.finished = false;
    state.requests = 0;
    state.lastTotal = 0;
    state.denied = false;
    state.tourDone = tour.done;
    state.reading = false;
    state.dwellLeft = 0;
    state.dwellTotal = 0;
    beginTrip();
  }

  function run() {
    reset();
    state.running = true;
    state.paused = false;
    emit('reset');
  }

  /* ---- per-station work -------------------------------------------------- */

  var OPS = {
    entra: function () { charge('entra'); },
    rbac: function () { charge('rbac'); },
    policy: function () {
      charge('policy');
      state.denied = state.plan.rejectAfterPolicy;
    },
    lock: function () { charge('lock'); },
    vnet: function () { charge('vnet'); },
    access: function () { charge('access'); },
    storage: function () { charge('storage'); },
    compute: function () { charge('compute'); },
    monitor: function () { charge('monitor'); },
    backup: function () {
      charge('backup');
      state.requests++;
      state.lastTotal = state.plan.costMonthly;
      tour.done = true;
      state.tourDone = true;
      emit('trip', state.requests);
    },
    deny: function () {
      charge('deny');
      state.requests++;
      state.lastTotal = 0;
      tour.done = true;
      state.tourDone = true;
      emit('trip', state.requests);
    }
  };

  /* ---- update ------------------------------------------------------------ */

  function routeOf(name) { return World.routes[name]; }

  function travelBoost() {
    return (state.fastForward ? 2.4 : 1) * (state.tourDone ? 3.0 : 1);
  }
  function dwellBoost() {
    return (state.fastForward ? 2.2 : 1) * (state.tourDone ? 1.4 : 1);
  }

  function fire(st) {
    state.station = st.id;
    state.stationT = 0;
    var op = OPS[st.id];
    if (op) op();
    emit('station', st.id);
  }

  function advanceRoute() {
    if (van.routeName === 'out') {
      /* Policy Hall is the one junction: deny takes the reject spur. */
      van.routeName = state.denied ? 'reject' : 'line';
      van.dist = 0;
      van.stationIdx = 0;
      van.dwell = state.denied ? 0.4 : 0.3;
    } else if (van.routeName === 'line') {
      /* Access Fork: the road itself branches. */
      van.routeName = state.accessPath;
      van.dist = 0;
      van.stationIdx = 0;
      van.dwell = 0.25;
    } else if (van.routeName === 'public' || van.routeName === 'bastion' || van.routeName === 'pe') {
      van.routeName = 'yard';
      van.dist = 0;
      van.stationIdx = 0;
      van.dwell = 0.3;
    } else if (van.routeName === 'yard' || van.routeName === 'reject') {
      state.finished = true;
      state.paused = true;
      state.station = 'done';
      emit('station', 'done');
    }
  }

  function update(dt) {
    state.stationT += dt;
    if (!state.running || state.paused || state.finished) return;

    var sdt = dt * state.speed * travelBoost();

    if (van.dwell > 0) {
      van.dwell -= dt * state.speed;
      state.dwellLeft = Math.max(0, van.dwell);
      if (van.dwell <= 0) { state.reading = false; state.dwellTotal = 0; }
      return;
    }

    var route = routeOf(van.routeName);
    van.dist += BASE_SPEED * sdt;

    var sts = World.stations[van.routeName] || [];
    if (van.stationIdx < sts.length) {
      var st = sts[van.stationIdx];
      if (van.dist >= st.dist) {
        van.dist = st.dist;
        van.stationIdx++;
        var topic = World.stationToDistrict[st.id] || st.id;
        var firstTime = !tour.seen[topic];
        fire(st);
        tour.seen[topic] = true;
        van.dwell = firstTime ? World.readSeconds(st.id) : st.dwell / dwellBoost();
        state.reading = firstTime;
        state.dwellTotal = van.dwell;
        state.dwellLeft = van.dwell;
        if (state.stepMode) { state.paused = true; state.stepMode = false; }
        return;
      }
    }

    if (van.dist >= route.total) advanceRoute();
  }

  function vanPosition() {
    return Iso.smoothAt(routeOf(van.routeName), van.dist, 0.8);
  }

  global.Sim = {
    state: state,
    van: van,
    run: run,
    reset: function () { reset(); emit('reset'); },
    replayTour: function () { tour.seen = Object.create(null); tour.done = false; },
    update: update,
    vanPosition: vanPosition,
    planNow: planNow,
    on: function (fn) { listeners.push(fn); },
    play: function () { if (!state.finished) { state.paused = false; state.running = true; } },
    pause: function () { state.paused = true; },
    toggle: function () { if (state.paused) this.play(); else this.pause(); },
    step: function () {
      if (state.finished) return;
      state.running = true;
      state.stepMode = true;
      state.paused = false;
      if (van.dwell > 0) van.dwell = 0;
    }
  };
})(window);
