export function criarRecoveryRepository(db) {
  const obter = db.prepare("SELECT * FROM node_recovery WHERE device_id = ?");
  const registrar = db.prepare(`
    INSERT INTO node_recovery (device_id, detected_at, last_seen_at)
    VALUES (?, unixepoch(), unixepoch())
    ON CONFLICT(device_id) DO UPDATE SET last_seen_at = unixepoch()
  `);
  const marcarTentativa = db.prepare(`
    UPDATE node_recovery SET reboot_attempted_at = unixepoch()
    WHERE device_id = ? AND reboot_attempted_at IS NULL
  `);
  const erroTentativa = db.prepare(`
    UPDATE node_recovery SET reboot_error = ? WHERE device_id = ?
  `);
  const limpar = db.prepare("DELETE FROM node_recovery WHERE device_id = ?");

  return {
    obter(deviceId) {
      return obter.get(deviceId) ?? null;
    },
    registrar(deviceId) {
      registrar.run(deviceId);
      return obter.get(deviceId);
    },
    marcarTentativa(deviceId) {
      return marcarTentativa.run(deviceId).changes === 1;
    },
    registrarErro(deviceId, erro) {
      erroTentativa.run(String(erro).slice(0, 300), deviceId);
    },
    limpar(deviceId) {
      return limpar.run(deviceId).changes === 1;
    },
  };
}
