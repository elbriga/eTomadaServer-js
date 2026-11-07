export function criarHistoryRepository(db) {
  const selecionar = db.prepare(`
    SELECT * FROM events
    WHERE device_id = ? COLLATE NOCASE AND recurso_id = ?
      AND timestamp < ?
    ORDER BY timestamp, id
  `);
  const atualizar = db.prepare(`
    UPDATE events SET valor = ?, history_optimized = 1 WHERE id = ?
  `);
  const apagar = db.prepare("DELETE FROM events WHERE id = ?");

  return {
    listarParaCompactacao(deviceId, recursoId, antesDe) {
      return selecionar.all(deviceId, recursoId, antesDe);
    },
    substituir(grupo, media) {
      atualizar.run(media, grupo[0].id);
      atualizar.run(media, grupo.at(-1).id);
      for (const evento of grupo.slice(1, -1)) apagar.run(evento.id);
    },
  };
}
