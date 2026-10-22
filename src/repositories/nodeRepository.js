export function criarNodeRepository(db) {
  const campos = `
    device_id, nome, enabled, api, device_model, device_board,
    fw_version, mac, ssid, last_seen_at, last_snapshot_at,
    created_at, updated_at
  `;

  const selectTodos = db.prepare(`
    SELECT ${campos} FROM nodes ORDER BY device_id COLLATE NOCASE
  `);

  const selectUm = db.prepare(`
    SELECT ${campos} FROM nodes WHERE device_id = ?
  `);

  const insert = db.prepare(`
    INSERT INTO nodes (device_id, nome, enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO NOTHING
  `);

  const update = db.prepare(`
    UPDATE nodes
    SET nome = ?, enabled = ?, updated_at = unixepoch()
    WHERE device_id = ?
  `);

  const remove = db.prepare(`
    DELETE FROM nodes WHERE device_id = ?
  `);

  const formatar = (row) =>
    row ? { ...row, enabled: row.enabled === 1 } : null;

  return {
    listar() {
      return selectTodos.all().map(formatar);
    },

    buscar(deviceId) {
      return formatar(selectUm.get(deviceId));
    },

    criar({ device_id, nome = "", enabled = true }) {
      const result = insert.run(device_id, nome, enabled ? 1 : 0);

      if (result.changes === 0) return null;

      return formatar(selectUm.get(device_id));
    },

    atualizar(deviceId, alteracoes) {
      const atual = selectUm.get(deviceId);
      if (!atual) return null;

      const nome = alteracoes.nome ?? atual.nome;
      const enabled = alteracoes.enabled ?? atual.enabled === 1;

      update.run(nome, enabled ? 1 : 0, deviceId);
      return formatar(selectUm.get(deviceId));
    },

    excluir(deviceId) {
      return remove.run(deviceId).changes > 0;
    },
  };
}
