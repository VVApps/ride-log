const RideSync = (() => {
  const SUPABASE_URL = 'https://xmrfnkdywnvhhwcsyjkj.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_QpCBpL8I7ODsmYmHCBPBNA_pkwipVOT';
  const TABLE = 'rides';

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  let onChangeCallback = null;

  client.auth.onAuthStateChange((_event, session) => {
    if (onChangeCallback) onChangeCallback(session);
  });

  function onAuthChange(cb) {
    onChangeCallback = cb;
  }

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session;
  }

  async function signInWithEmail(email) {
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
  }

  async function signOut() {
    await client.auth.signOut();
  }

  function toRemote(ride) {
    return {
      id: ride.id,
      started_at: ride.startedAt,
      ended_at: ride.endedAt,
      route: ride.route,
      distance_meters: ride.distanceMeters,
      duration_ms: ride.durationMs,
      notes: ride.notes,
      rating: ride.rating,
    };
  }

  function fromRemote(row) {
    return {
      id: row.id,
      startedAt: Number(row.started_at),
      endedAt: Number(row.ended_at),
      route: row.route || [],
      distanceMeters: row.distance_meters,
      durationMs: Number(row.duration_ms),
      notes: row.notes || '',
      rating: row.rating || 0,
      synced: true,
    };
  }

  async function pushUnsyncedRides() {
    const rides = await RideDB.getAllRides();
    const unsynced = rides.filter((r) => !r.synced);
    for (const ride of unsynced) {
      const { error } = await client.from(TABLE).upsert(toRemote(ride), { onConflict: 'id' });
      if (!error) {
        await RideDB.addRide({ ...ride, synced: true });
      }
    }
    return unsynced.length;
  }

  async function pullRemoteRides() {
    const { data, error } = await client.from(TABLE).select('*');
    if (error || !data) return 0;
    const localRides = await RideDB.getAllRides();
    const localIds = new Set(localRides.map((r) => r.id));
    let added = 0;
    for (const row of data) {
      if (!localIds.has(row.id)) {
        await RideDB.addRide(fromRemote(row));
        added++;
      }
    }
    return added;
  }

  async function deleteRemote(id) {
    try {
      await client.from(TABLE).delete().eq('id', id);
    } catch (e) {
      // best-effort: if offline, the remote copy just won't be removed until a manual retry
    }
  }

  async function syncNow() {
    const session = await getSession();
    if (!session || !navigator.onLine) return null;
    const pushed = await pushUnsyncedRides();
    const pulled = await pullRemoteRides();
    return { pushed, pulled };
  }

  return { onAuthChange, getSession, signInWithEmail, signOut, syncNow, deleteRemote };
})();
