export function criarNodeRepository(db) {
  const campos = `
    device_id, nome, descricao, enabled, api, device_model, device_board,
    fw_version, mac, ssid, last_seen_at, last_snapshot_at,
    created_at, updated_at
  `;

  const selectTodos = db.prepare(`
    SELECT ${campos} FROM nodes ORDER BY device_id COLLATE NOCASE
  `);

  const selectComSnapshot = db.prepare(`
    SELECT ${campos}, snapshot_json
    FROM nodes ORDER BY device_id COLLATE NOCASE
  `);

  const selectUm = db.prepare(`
    SELECT ${campos} FROM nodes WHERE device_id = ?
  `);

  const exists = db.prepare(`
    SELECT 1 FROM nodes WHERE device_id = ?
  `);

  const insert = db.prepare(`
    INSERT INTO nodes (device_id, nome, descricao, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO NOTHING
  `);

  const update = db.prepare(`
    UPDATE nodes
    SET nome = ?, descricao = ?, enabled = ?, updated_at = unixepoch()
    WHERE device_id = ?
  `);

  const remove = db.prepare(`
    DELETE FROM nodes WHERE device_id = ?
  `);

  const updateSnapshot = db.prepare(`
    UPDATE nodes SET
      api = COALESCE(?, api),
      device_model = COALESCE(?, device_model),
      device_board = COALESCE(?, device_board),
      fw_version = COALESCE(?, fw_version),
      mac = COALESCE(?, mac),
      ssid = COALESCE(?, ssid),
      last_seen_at = unixepoch(),
      last_snapshot_at = unixepoch(),
      snapshot_json = ?
    WHERE device_id = ?
  `);

  const texto = (valor) =>
    typeof valor === "string" && valor.trim() ? valor.trim() : null;

  const formatar = (row) =>
    row ? { ...row, enabled: row.enabled === 1 } : null;

  return {
    listar() {
      return selectTodos.all().map(formatar);
    },

    listarComSnapshot() {
      return selectComSnapshot.all().map(formatar);
    },

    existe(deviceId) {
      return !!exists.get(deviceId);
    },

    buscar(deviceId) {
      return formatar(selectUm.get(deviceId));
    },

    criar({ device_id, nome = "", descricao = "", enabled = true }) {
      const result = insert.run(device_id, nome, descricao, enabled ? 1 : 0);

      if (result.changes === 0) return null;

      return formatar(selectUm.get(device_id));
    },

    atualizar(deviceId, alteracoes) {
      const atual = selectUm.get(deviceId);
      if (!atual) return null;

      const nome = alteracoes.nome ?? atual.nome;
      const descricao = alteracoes.descricao ?? atual.descricao;
      const enabled = alteracoes.enabled ?? atual.enabled === 1;

      update.run(nome, descricao, enabled ? 1 : 0, deviceId);
      return formatar(selectUm.get(deviceId));
    },

    excluir(deviceId) {
      return remove.run(deviceId).changes > 0;
    },

    salvarSnapshot(deviceId, snapshot) {
      const result = updateSnapshot.run(
        texto(snapshot.api),
        texto(snapshot.device_model),
        texto(snapshot.device_board),
        texto(snapshot.fw_version),
        texto(snapshot.mac),
        texto(snapshot.ssid),
        JSON.stringify(snapshot),
        deviceId,
      );

      return result.changes > 0;
    },
  };
}
