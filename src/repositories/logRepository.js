export function criarLogRepository(db, notificarLog = () => {}) {
  const inserir = db.prepare(`
    INSERT INTO logs (
      timestamp, device_id, ip, level, module, message, uptime
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  return function registrarLog({
    timestamp = null,
    device_id,
    ip = null,
    level,
    module = "",
    message,
    uptime = null,
  }) {
    const result = inserir.run(
      timestamp,
      device_id,
      ip,
      level,
      module,
      message,
      uptime,
    );

    const id = Number(result.lastInsertRowid);
    notificarLog(id);

    return id;
  };
}
