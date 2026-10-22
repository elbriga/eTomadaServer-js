export function criarResourceRepository(db) {
  const campos = `
    device_id, recurso_id, nome, tipo, updated_at,
    global_id, nome_configurado, descricao, reported_json, reported_at
  `;

  const listarTodos = db.prepare(`
    SELECT ${campos} FROM resources ORDER BY device_id, recurso_id
  `);

  const listarNodo = db.prepare(`
    SELECT ${campos} FROM resources
    WHERE device_id = ? COLLATE NOCASE
    ORDER BY recurso_id
  `);

  const buscarFisico = db.prepare(`
    SELECT ${campos} FROM resources
    WHERE device_id = ? COLLATE NOCASE AND recurso_id = ?
  `);

  const buscarLogico = db.prepare(`
    SELECT ${campos} FROM resources WHERE global_id = ? COLLATE NOCASE
  `);

  const upsert = db.prepare(`
    INSERT INTO resources (device_id, recurso_id, nome, tipo, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(device_id, recurso_id) DO UPDATE SET
      nome = excluded.nome,
      tipo = excluded.tipo,
      updated_at = excluded.updated_at
    WHERE resources.nome <> excluded.nome OR resources.tipo <> excluded.tipo
  `);

  const update = db.prepare(`
    UPDATE resources SET
      global_id = ?, nome_configurado = ?, descricao = ?,
      updated_at = unixepoch()
    WHERE device_id = ? AND recurso_id = ?
  `);

  return {
    listar(deviceId = null) {
      return deviceId === null ? listarTodos.all() : listarNodo.all(deviceId);
    },

    buscar(deviceId, recursoId) {
      return buscarFisico.get(deviceId, recursoId) ?? null;
    },

    buscarGlobal(globalId) {
      return buscarLogico.get(globalId) ?? null;
    },

    descobrir(deviceId, recursos) {
      if (!Array.isArray(recursos) || recursos.length === 0) return 0;

      let total = 0;
      db.exec("BEGIN IMMEDIATE");

      try {
        for (const recurso of recursos) {
          if (!recurso || recurso.remoto === true) continue;

          if (
            typeof recurso.id !== "string" ||
            recurso.id.length < 1 ||
            recurso.id.length > 32
          )
            continue;

          const nome =
            typeof recurso.nome === "string" ? recurso.nome.slice(0, 32) : "";
          const tipo =
            typeof recurso.tipo === "string" ? recurso.tipo.slice(0, 16) : "";

          upsert.run(deviceId, recurso.id, nome, tipo);
          total++;
        }

        db.exec("COMMIT");
      } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
      }

      return total;
    },

    atualizar(deviceId, recursoId, alteracoes) {
      const atual = buscarFisico.get(deviceId, recursoId);
      if (!atual) return null;

      const globalId =
        alteracoes.global_id === undefined
          ? atual.global_id
          : (alteracoes.global_id?.trim().toUpperCase() ?? null);

      const nome =
        alteracoes.nome_configurado === undefined
          ? atual.nome_configurado
          : alteracoes.nome_configurado.trim();

      const descricao =
        alteracoes.descricao === undefined
          ? atual.descricao
          : alteracoes.descricao.trim();

      update.run(globalId, nome, descricao, atual.device_id, atual.recurso_id);

      return buscarFisico.get(atual.device_id, atual.recurso_id);
    },
  };
}
