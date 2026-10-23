export const JANELA_RECONCILIACAO = 120; // segundos

function estadoBooleano(valor) {
  if (valor === true || valor === 1) return true;
  if (valor === false || valor === 0) return false;
  return null;
}

function formatar(row) {
  if (!row) return null;

  return {
    ...row,
    desired_state: Boolean(row.desired_state),
    observed_state:
      row.observed_state === null ? null : Boolean(row.observed_state),
  };
}

export function criarCommandRepository(db) {
  const inserir = db.prepare(`
    INSERT INTO resource_commands
      (device_id, recurso_id, global_id, command, desired_state)
    VALUES (?, ?, ?, ?, ?)
  `);

  const buscar = db.prepare(`
    SELECT * FROM resource_commands WHERE id = ?
  `);

  const ultimo = db.prepare(`
    SELECT * FROM resource_commands
    WHERE device_id = ? COLLATE NOCASE AND recurso_id = ?
    ORDER BY id DESC LIMIT 1
  `);

  const listar = db.prepare(`
    SELECT * FROM resource_commands
    WHERE device_id = ? COLLATE NOCASE AND recurso_id = ?
    ORDER BY id DESC LIMIT ?
  `);

  const confirmar = db.prepare(`
    UPDATE resource_commands SET
      status = ?, observed_state = ?,
      confirmed_via = 'response',
      finished_at = unixepoch()
    WHERE id = ? AND status = 'pending'
  `);

  const incerto = db.prepare(`
    UPDATE resource_commands SET
      status = 'uncertain',
      error_code = ?,
      error_message = ?,
      finished_at = unixepoch()
    WHERE id = ? AND status = 'pending'
  `);

  const reconciliar = db.prepare(`
    UPDATE resource_commands SET
      status = 'confirmed',
      observed_state = ?,
      confirmed_via = ?,
      finished_at = unixepoch()
    WHERE id = ? AND status = 'uncertain'
  `);

  const pendentesReinicio = db.prepare(`
    UPDATE resource_commands SET
      status = 'uncertain',
      error_code = 'SERVER_RESTART',
      error_message = 'Servidor reiniciado com comando pendente',
      finished_at = unixepoch()
    WHERE status = 'pending'
  `);

  function obter(id) {
    return formatar(buscar.get(id));
  }

  return {
    buscar: obter,

    ultimo(deviceId, recursoId) {
      return formatar(ultimo.get(deviceId, recursoId));
    },

    listar(deviceId, recursoId, limite = 20) {
      return listar.all(deviceId, recursoId, limite).map(formatar);
    },

    iniciar({ device_id, recurso_id, global_id, command }) {
      const id = Number(
        inserir.run(
          device_id,
          recurso_id,
          global_id,
          command,
          command === "ON" ? 1 : 0,
        ).lastInsertRowid,
      );

      return obter(id);
    },

    confirmarResposta(id, estado) {
      const registro = buscar.get(id);
      if (!registro || registro.status !== "pending") return obter(id);

      const valor = estadoBooleano(estado);
      if (valor === null) throw new TypeError("Estado de resposta inválido");

      confirmar.run(
        valor === Boolean(registro.desired_state) ? "confirmed" : "mismatch",
        valor ? 1 : 0,
        id,
      );

      return obter(id);
    },

    marcarIncerto(id, codigo, mensagem) {
      incerto.run(codigo ?? "UNKNOWN", String(mensagem ?? ""), id);
      return obter(id);
    },

    reconciliar(deviceId, recursoId, estado, origem) {
      const valor = estadoBooleano(estado);
      if (valor === null) return null;

      // Somente o comando mais recente para o recurso.
      const registro = ultimo.get(deviceId, recursoId);

      if (!registro || registro.status !== "uncertain") return null;

      if (
        registro.created_at <
          Math.floor(Date.now() / 1000) - JANELA_RECONCILIACAO ||
        !registro.finished_at ||
        registro.finished_at <
          Math.floor(Date.now() / 1000) - JANELA_RECONCILIACAO
      )
        return null;

      // Apenas observações correspondentes ao estado desejado.
      if (valor !== Boolean(registro.desired_state)) return null;

      reconciliar.run(valor ? 1 : 0, origem, registro.id);
      return obter(registro.id);
    },

    encerrarPendentes() {
      return pendentesReinicio.run().changes;
    },
  };
}
