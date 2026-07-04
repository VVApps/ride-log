(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    screen: 'ride',
    tracking: false,
    watchId: null,
    timerId: null,
    startedAt: null,
    route: [], // {lat, lng, timestamp, accuracy}
    distanceMeters: 0,
    lastAcceptedPoint: null,
    lastFixAt: null,
    lastAccuracy: null,
    gpsError: null,
    pendingRide: null, // ride awaiting notes/rating before save
    rides: [],
    selectedRideId: null,
    rideMapInstance: null,
    lastRideMapInstance: null,
    monthChart: null,
    pendingRating: 0,
  };

  const MIN_POINT_INTERVAL_MS = 3000;
  const MAX_ACCEPTABLE_ACCURACY_M = 50;
  const MAX_PLAUSIBLE_SPEED_MPS = 55; // ~198 km/h guard against GPS jumps

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  }

  // ---------- DOM refs ----------
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    ride: $('#screen-ride'),
    notes: $('#screen-notes'),
    history: $('#screen-history'),
    detail: $('#screen-detail'),
    stats: $('#screen-stats'),
  };
  const navButtons = document.querySelectorAll('.nav-btn');

  function showScreen(name) {
    state.screen = name;
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('active', key === name);
    });
    navButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === name);
    });
    if (name === 'history') renderHistory();
    if (name === 'stats') renderStats();
    if (name === 'ride') renderLastRide();
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.tracking && btn.dataset.nav !== 'ride') {
        // allow navigating away while tracking continues in background
      }
      showScreen(btn.dataset.nav);
    });
  });

  // ---------- Geolocation tracking ----------
  function requestStartRide() {
    if (!('geolocation' in navigator)) {
      showGpsBanner('Geolocation is not supported on this device/browser.');
      return;
    }
    state.gpsError = null;
    state.tracking = true;
    state.startedAt = Date.now();
    state.route = [];
    state.distanceMeters = 0;
    state.lastAcceptedPoint = null;
    state.lastFixAt = null;
    state.lastAccuracy = null;

    state.watchId = navigator.geolocation.watchPosition(
      onPosition,
      onPositionError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );

    state.timerId = setInterval(renderRideScreen, 1000);
    renderRideScreen();
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    const timestamp = pos.timestamp || Date.now();
    state.lastFixAt = Date.now();
    state.lastAccuracy = accuracy;
    state.gpsError = null;

    if (accuracy != null && accuracy > MAX_ACCEPTABLE_ACCURACY_M) {
      // Poor accuracy fix: skip point, keep tracking alive
      renderRideScreen();
      return;
    }

    const point = { lat: latitude, lng: longitude, timestamp };

    if (state.lastAcceptedPoint) {
      const dtSec = (timestamp - state.lastAcceptedPoint.timestamp) / 1000;
      if (dtSec < MIN_POINT_INTERVAL_MS / 1000) {
        renderRideScreen();
        return;
      }
      const distM = haversineMeters(state.lastAcceptedPoint, point);
      const speed = dtSec > 0 ? distM / dtSec : 0;
      if (speed > MAX_PLAUSIBLE_SPEED_MPS) {
        // Likely a GPS glitch/jump: skip this point
        renderRideScreen();
        return;
      }
      state.distanceMeters += distM;
    }

    state.lastAcceptedPoint = point;
    state.route.push(point);
    renderRideScreen();
  }

  function onPositionError(err) {
    state.lastFixAt = state.lastFixAt; // unchanged
    if (err.code === err.PERMISSION_DENIED) {
      state.gpsError = 'Location permission denied. Ride tracking has stopped.';
      stopTracking();
      showGpsBanner('Location permission was denied, so tracking stopped. Enable location access for this site/app in your browser settings, then start a new ride.');
      renderRideScreen();
      return;
    }
    // TIMEOUT or POSITION_UNAVAILABLE: signal dropped, don't crash, keep watch alive
    state.gpsError = 'GPS signal weak or unavailable — still trying...';
    renderRideScreen();
  }

  function showGpsBanner(msg) {
    const banner = $('#gpsBanner');
    banner.textContent = msg;
    banner.style.display = 'block';
  }
  function hideGpsBanner() {
    $('#gpsBanner').style.display = 'none';
  }

  function stopTracking() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    if (state.timerId != null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    state.tracking = false;
  }

  function endRide() {
    const endedAt = Date.now();
    const ride = {
      id: uid(),
      startedAt: state.startedAt,
      endedAt,
      route: state.route.slice(),
      distanceMeters: state.distanceMeters,
      durationMs: endedAt - state.startedAt,
      notes: '',
      rating: 0,
      synced: false,
    };
    stopTracking();
    state.pendingRide = ride;
    state.pendingRating = 0;
    hideGpsBanner();
    $('#notesText').value = '';
    renderStars(0);
    renderRideScreen();
    showScreen('notes');
  }

  // ---------- Ride screen rendering ----------
  function renderRideScreen() {
    const idleEl = $('#rideIdle');
    const activeEl = $('#rideActive');
    if (!state.tracking) {
      idleEl.style.display = '';
      activeEl.style.display = 'none';
      return;
    }
    idleEl.style.display = 'none';
    activeEl.style.display = '';

    const elapsedMs = Date.now() - state.startedAt;
    $('#liveDuration').textContent = formatDuration(elapsedMs);
    $('#liveDistance').textContent = formatKm(state.distanceMeters) + ' km';
    const hours = elapsedMs / 3600000;
    const avgKmh = hours > 0.001 ? (state.distanceMeters / 1000) / hours : 0;
    $('#liveSpeed').textContent = avgKmh.toFixed(1) + ' km/h';
    $('#livePoints').textContent = String(state.route.length);

    const secsSinceFix = state.lastFixAt ? Math.round((Date.now() - state.lastFixAt) / 1000) : null;
    $('#liveAgo').textContent = secsSinceFix != null ? `${secsSinceFix}s ago` : 'waiting for fix…';

    const accEl = $('#liveAccuracy');
    if (state.gpsError) {
      accEl.textContent = state.gpsError;
      accEl.classList.add('warn-text');
    } else if (state.lastAccuracy != null) {
      accEl.textContent = `GPS accuracy ~${Math.round(state.lastAccuracy)} m`;
      accEl.classList.remove('warn-text');
    } else {
      accEl.textContent = 'Acquiring GPS…';
      accEl.classList.remove('warn-text');
    }
  }

  $('#startRideBtn').addEventListener('click', requestStartRide);
  $('#stopPillBtn').addEventListener('click', endRide);
  $('#endRideBtn').addEventListener('click', endRide);

  // ---------- Last ride overlay card ----------
  async function renderLastRide() {
    const rides = await RideDB.getAllRides();
    const card = $('#lastRideCard');
    const empty = $('#lastRideEmpty');

    if (!rides.length) {
      card.style.display = 'none';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    card.style.display = '';

    const ride = rides[0];
    const date = new Date(ride.startedAt);
    $('#lastRideDate').textContent = date.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    $('#lastRideDistance').textContent = formatKm(ride.distanceMeters) + ' km';
    $('#lastRideDuration').textContent = formatDurationShort(ride.durationMs);
    const hours = ride.durationMs / 3600000;
    const avgKmh = hours > 0.001 ? (ride.distanceMeters / 1000) / hours : 0;
    $('#lastRideSpeed').textContent = avgKmh.toFixed(1) + ' km/h';

    const mapEl = $('#lastRideMap');
    if (state.lastRideMapInstance) {
      state.lastRideMapInstance.remove();
      state.lastRideMapInstance = null;
    }
    mapEl.innerHTML = '';
    if (!ride.route || ride.route.length === 0) return;

    const map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    const latlngs = ride.route.map((p) => [p.lat, p.lng]);
    const poly = L.polyline(latlngs, { color: '#ffffff', weight: 4, opacity: 0.95 }).addTo(map);
    map.fitBounds(poly.getBounds(), { padding: [18, 18] });
    setTimeout(() => map.invalidateSize(), 60);
    state.lastRideMapInstance = map;
  }

  // ---------- Notes / rating screen ----------
  function renderStars(rating) {
    state.pendingRating = rating;
    document.querySelectorAll('.star-btn').forEach((btn) => {
      const val = Number(btn.dataset.star);
      btn.classList.toggle('filled', val <= rating);
      btn.textContent = val <= rating ? '★' : '☆';
    });
  }
  document.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderStars(Number(btn.dataset.star)));
  });

  $('#saveRideBtn').addEventListener('click', async () => {
    if (!state.pendingRide) return;
    state.pendingRide.notes = $('#notesText').value.trim();
    state.pendingRide.rating = state.pendingRating;
    await RideDB.addRide(state.pendingRide);
    state.pendingRide = null;
    showScreen('history');
    RideSync.syncNow().then((result) => {
      if (result) renderHistory();
    });
  });

  $('#discardRideBtn').addEventListener('click', () => {
    if (!confirm('Discard this ride? This cannot be undone.')) return;
    state.pendingRide = null;
    showScreen('ride');
  });

  // ---------- History screen ----------
  async function renderHistory() {
    const rides = await RideDB.getAllRides();
    state.rides = rides;
    const listEl = $('#historyList');
    const emptyEl = $('#historyEmpty');
    listEl.innerHTML = '';

    if (rides.length === 0) {
      emptyEl.style.display = '';
      listEl.style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.style.display = '';

    rides.forEach((ride) => {
      const item = document.createElement('div');
      item.className = 'timeline-item';

      const rail = document.createElement('div');
      rail.className = 'timeline-rail';
      rail.innerHTML = '<div class="dot"></div><div class="line"></div>';

      const row = document.createElement('div');
      row.className = 'ride-row';
      row.dataset.id = ride.id;
      const date = new Date(ride.startedAt);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const stars = '★'.repeat(ride.rating || 0) + '☆'.repeat(5 - (ride.rating || 0));

      row.innerHTML = `
        <div class="top">
          <span class="date">${dateStr} · ${timeStr}</span>
          <span class="stars">${ride.rating ? stars : ''}</span>
        </div>
        <div class="meta">
          <span><b>${formatKm(ride.distanceMeters)} km</b></span>
          <span><b>${formatDurationShort(ride.durationMs)}</b></span>
        </div>
        ${ride.notes ? `<div class="notes-preview">${escapeHtml(ride.notes)}</div>` : ''}
      `;
      row.addEventListener('click', () => openDetail(ride.id));

      item.appendChild(rail);
      item.appendChild(row);
      listEl.appendChild(item);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Detail screen ----------
  async function openDetail(id) {
    const ride = await RideDB.getRide(id);
    if (!ride) return;
    state.selectedRideId = id;

    const date = new Date(ride.startedAt);
    $('#detailDate').textContent = date.toLocaleDateString(undefined, {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    });
    $('#detailDistance').textContent = formatKm(ride.distanceMeters) + ' km';
    $('#detailDuration').textContent = formatDurationShort(ride.durationMs);
    $('#detailRating').textContent = ride.rating ? '★'.repeat(ride.rating) + '☆'.repeat(5 - ride.rating) : 'Not rated';
    $('#detailNotes').textContent = ride.notes || 'No notes for this ride.';

    showScreen('detail');
    renderRideMap(ride.route);
  }

  function renderRideMap(route) {
    const mapEl = $('#rideMap');
    if (state.rideMapInstance) {
      state.rideMapInstance.remove();
      state.rideMapInstance = null;
    }
    if (!route || route.length === 0) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8b93a1;font-size:13px;">No route recorded</div>';
      return;
    }
    mapEl.innerHTML = '';
    const map = L.map(mapEl, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const latlngs = route.map((p) => [p.lat, p.lng]);
    const poly = L.polyline(latlngs, { color: '#2f90ac', weight: 4 }).addTo(map);
    L.circleMarker(latlngs[0], { radius: 6, color: '#2f90ac', fillColor: '#2f90ac', fillOpacity: 1 }).addTo(map);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#c5533f', fillColor: '#c5533f', fillOpacity: 1 }).addTo(map);
    map.fitBounds(poly.getBounds(), { padding: [24, 24] });
    state.rideMapInstance = map;
  }

  $('#detailBackBtn').addEventListener('click', () => showScreen('history'));

  $('#deleteRideBtn').addEventListener('click', async () => {
    if (!state.selectedRideId) return;
    if (!confirm('Delete this ride permanently?')) return;
    await RideDB.deleteRide(state.selectedRideId);
    RideSync.deleteRemote(state.selectedRideId);
    showScreen('history');
  });

  // ---------- Stats screen ----------
  async function renderStats() {
    const rides = await RideDB.getAllRides();
    const totalMeters = rides.reduce((sum, r) => sum + (r.distanceMeters || 0), 0);
    const totalMs = rides.reduce((sum, r) => sum + (r.durationMs || 0), 0);

    $('#statTotalKm').textContent = formatKm(totalMeters);
    $('#statTotalRides').textContent = String(rides.length);
    $('#statTotalTime').textContent = formatDurationShort(totalMs);

    const monthly = {};
    rides.forEach((r) => {
      const d = new Date(r.startedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthly[key] = (monthly[key] || 0) + r.distanceMeters / 1000;
    });
    const keys = Object.keys(monthly).sort();
    const last12 = keys.slice(-12);
    const labels = last12.map((k) => {
      const [y, m] = k.split('-');
      return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    });
    const data = last12.map((k) => Number(monthly[k].toFixed(1)));

    const ctx = $('#monthChart').getContext('2d');
    if (state.monthChart) state.monthChart.destroy();

    if (last12.length === 0) {
      $('#statsChartEmpty').style.display = '';
      $('#monthChart').style.display = 'none';
      return;
    }
    $('#statsChartEmpty').style.display = 'none';
    $('#monthChart').style.display = '';

    state.monthChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'km',
          data,
          backgroundColor: '#2f90ac',
          borderRadius: 6,
          maxBarThickness: 34,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#5b6474', font: { weight: '700' } } },
          y: { beginAtZero: true, grid: { color: '#e6dcc6' }, ticks: { color: '#8b93a1' } },
        },
      },
    });
  }

  // ---------- Export CSV ----------
  function csvEscape(val) {
    const s = String(val ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  async function exportCsv() {
    const rides = await RideDB.getAllRides();
    const header = ['date_started', 'time_started', 'date_ended', 'distance_km', 'duration', 'rating', 'notes'];
    const rows = rides.map((r) => {
      const start = new Date(r.startedAt);
      const end = new Date(r.endedAt);
      return [
        start.toLocaleDateString(),
        start.toLocaleTimeString(),
        end.toLocaleString(),
        formatKm(r.distanceMeters),
        formatDurationShort(r.durationMs),
        r.rating || '',
        r.notes || '',
      ].map(csvEscape).join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ride-log-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  $('#exportBtn').addEventListener('click', exportCsv);
  $('#exportBtnStats').addEventListener('click', exportCsv);

  // ---------- Account & sync ----------
  function renderAccountUI(session) {
    const loggedOut = $('#accountLoggedOut');
    const loggedIn = $('#accountLoggedIn');
    if (session) {
      loggedOut.style.display = 'none';
      loggedIn.style.display = '';
      $('#accountEmail').textContent = 'Signed in as ' + session.user.email;
    } else {
      loggedOut.style.display = '';
      loggedIn.style.display = 'none';
    }
  }

  RideSync.onAuthChange((session) => {
    renderAccountUI(session);
    if (session) {
      RideSync.syncNow().then((result) => {
        if (result && state.screen === 'history') renderHistory();
        if (result && state.screen === 'stats') renderStats();
        if (result && state.screen === 'ride') renderLastRide();
      });
    }
  });

  $('#sendMagicLinkBtn').addEventListener('click', async () => {
    const email = $('#authEmailInput').value.trim();
    const msg = $('#authStatusMsg');
    if (!email) return;
    msg.style.display = '';
    msg.textContent = 'Sending link…';
    try {
      await RideSync.signInWithEmail(email);
      msg.textContent = 'Check your email for a sign-in link.';
    } catch (e) {
      msg.textContent = 'Could not send link: ' + e.message;
    }
  });

  $('#verifyPastedLinkBtn').addEventListener('click', async () => {
    const msg = $('#authStatusMsg');
    msg.style.display = '';
    msg.textContent = 'Verifying…';
    try {
      await RideSync.verifyPastedLink($('#pasteLinkInput').value);
      $('#pasteLinkInput').value = '';
      msg.textContent = 'Signed in!';
    } catch (e) {
      msg.textContent = 'Could not verify that link: ' + e.message;
    }
  });

  $('#signOutBtn').addEventListener('click', async () => {
    await RideSync.signOut();
  });

  $('#syncNowBtn').addEventListener('click', async () => {
    const msg = $('#syncStatusMsg');
    msg.textContent = 'Syncing…';
    const result = await RideSync.syncNow();
    if (result) {
      msg.textContent = `Synced — pushed ${result.pushed}, pulled ${result.pulled}.`;
      if (state.screen === 'history') renderHistory();
      if (state.screen === 'stats') renderStats();
    } else {
      msg.textContent = 'Sync unavailable — check your connection.';
    }
  });

  window.addEventListener('online', () => {
    RideSync.syncNow().then((result) => {
      if (!result) return;
      if (state.screen === 'history') renderHistory();
      if (state.screen === 'stats') renderStats();
      if (state.screen === 'ride') renderLastRide();
    });
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // ---------- Sample ride (seeded on first launch only) ----------
  // Real touring route: Pickering -> Scugog -> Peterborough -> Flynn's Turn ->
  // Gooderham -> Bancroft -> Haliburton Highlands -> Minden -> Fenelon Falls, Ontario.
  const SAMPLE_ROUTE_WAYPOINTS = [
    { lat: 43.9100075, lng: -79.1298447 },
    { lat: 44.2159571, lng: -78.7652644 },
    { lat: 44.3047061, lng: -78.3199606 },
    { lat: 44.612842, lng: -78.382017 },
    { lat: 44.906384, lng: -78.379801 },
    { lat: 45.0261326, lng: -77.9749286 },
    { lat: 45.0558574, lng: -77.8548814 },
    { lat: 45.1423946, lng: -78.148146 },
    { lat: 45.0472004, lng: -78.5068228 },
    { lat: 44.9271767, lng: -78.725375 },
  ];

  function buildSampleRoute() {
    const points = [];
    const stepsPerLeg = 14;
    for (let i = 0; i < SAMPLE_ROUTE_WAYPOINTS.length - 1; i++) {
      const a = SAMPLE_ROUTE_WAYPOINTS[i];
      const b = SAMPLE_ROUTE_WAYPOINTS[i + 1];
      for (let s = 0; s < stepsPerLeg; s++) {
        const t = s / stepsPerLeg;
        points.push({
          lat: a.lat + (b.lat - a.lat) * t + (Math.random() - 0.5) * 0.004,
          lng: a.lng + (b.lng - a.lng) * t + (Math.random() - 0.5) * 0.004,
        });
      }
    }
    points.push(SAMPLE_ROUTE_WAYPOINTS[SAMPLE_ROUTE_WAYPOINTS.length - 1]);

    const cumMeters = [0];
    for (let i = 1; i < points.length; i++) {
      cumMeters.push(cumMeters[i - 1] + haversineMeters(points[i - 1], points[i]));
    }
    const totalMeters = cumMeters[cumMeters.length - 1];
    const durationMs = 6.5 * 3600 * 1000;
    const startedAt = new Date('2026-06-28T09:00:00').getTime();

    const route = points.map((p, i) => ({
      lat: p.lat,
      lng: p.lng,
      timestamp: startedAt + (cumMeters[i] / totalMeters) * durationMs,
    }));

    return { route, totalMeters, durationMs, startedAt };
  }

  async function seedSampleRideIfEmpty() {
    const rides = await RideDB.getAllRides();
    if (rides.length > 0) return;
    const { route, totalMeters, durationMs, startedAt } = buildSampleRoute();
    await RideDB.addRide({
      id: uid(),
      startedAt,
      endedAt: startedAt + durationMs,
      route,
      distanceMeters: totalMeters,
      durationMs,
      notes: 'Sample ride — Kawartha Lakes to Haliburton Highlands loop via Bancroft. Delete this from the ride detail screen to start your own log.',
      rating: 5,
      synced: true, // sample data only — never pushed to your account
    });
  }

  // ---------- Init ----------
  (async () => {
    await seedSampleRideIfEmpty();
    showScreen('ride');
    renderRideScreen();
    const session = await RideSync.getSession();
    renderAccountUI(session);
    if (session) {
      RideSync.syncNow().then((result) => {
        if (result && state.screen === 'ride') renderLastRide();
      });
    }
  })();
})();
