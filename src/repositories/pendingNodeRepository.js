export function criarPendingNodeRepository(db) {
  const buscar = db.prepare(`
    SELECT device_id, snapshot_json, first_seen_at, last_seen_at
    FROM nodes_pending WHERE device_id = ? COLLATE NOCASE
  `);

  const listar = db.prepare(`
    SELECT p.device_id, p.snapshot_json, p.first_seen_at, p.last_seen_at
    FROM nodes_pending p
    WHERE NOT EXISTS (
      SELECT 1 FROM nodes n WHERE n.device_id = p.device_id
    )
    ORDER BY p.device_id COLLATE NOCASE
  `);

  const salvar = db.prepare(`
    INSERT INTO nodes_pending (
      device_id, snapshot_json, first_seen_at, last_seen_at
    )
    VALUES (?, ?, unixepoch(), unixepoch())
    ON CONFLICT(device_id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      last_seen_at = unixepoch()
  `);

  const excluir = db.prepare("DELETE FROM nodes_pending WHERE device_id = ?");

  function apresentar(row) {
    if (!row) return null;

    const snapshot = JSON.parse(row.snapshot_json);

    return {
      device_id: row.device_id,
      nome: "",
      enabled: true,
      pendente: true,
      status: "new",
      api: snapshot.api ?? null,
      device_model: snapshot.device_model ?? null,
      device_board: snapshot.device_board ?? null,
      fw_version: snapshot.fw_version ?? null,
      mac: snapshot.mac ?? null,
      ssid: snapshot.ssid ?? null,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      last_snapshot_at: row.last_seen_at,
      last_poll_at: null,
      snapshot,
    };
  }

  return {
    registrar(snapshot) {
      const novo = !buscar.get(snapshot.device_id);

      salvar.run(snapshot.device_id, JSON.stringify(snapshot));
      return novo;
    },

    buscar(deviceId) {
      return apresentar(buscar.get(deviceId));
    },

    listar() {
      return listar.all().map(apresentar);
    },

    excluir(deviceId) {
      return excluir.run(deviceId).changes > 0;
    },
  };
}
