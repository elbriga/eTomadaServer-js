export function criarGroupRepository(db) {
  const listarGrupos = db.prepare(`
    SELECT g.group_id, g.nome, g.descricao,
           g.created_at, g.updated_at,
           COUNT(gr.recurso_id) AS total_recursos
    FROM groups g
    LEFT JOIN group_resources gr ON gr.group_id = g.group_id
    GROUP BY g.group_id
    ORDER BY g.group_id COLLATE NOCASE
  `);

  const buscarGrupo = db.prepare(`
    SELECT group_id, nome, descricao, created_at, updated_at
    FROM groups WHERE group_id = ?
  `);

  const listarMembros = db.prepare(`
    SELECT r.device_id, r.recurso_id, r.global_id,
           r.nome, r.nome_configurado, r.tipo,
           r.reported_json, r.reported_at
    FROM group_resources gr
    JOIN resources r ON r.device_id = gr.device_id
                    AND r.recurso_id = gr.recurso_id
    WHERE gr.group_id = ?
    ORDER BY COALESCE(
      r.global_id, r.device_id || '/' || r.recurso_id
    ) COLLATE NOCASE
  `);

  const inserir = db.prepare(`
    INSERT INTO groups (group_id, nome, descricao)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id) DO NOTHING
  `);

  const atualizar = db.prepare(`
    UPDATE groups SET
      nome = ?, descricao = ?, updated_at = unixepoch()
    WHERE group_id = ?
  `);

  const excluir = db.prepare(`
    DELETE FROM groups WHERE group_id = ?
  `);

  const buscarRecurso = db.prepare(`
    SELECT device_id, recurso_id, global_id
    FROM resources
    WHERE global_id = ? COLLATE NOCASE
  `);

  const associar = db.prepare(`
    INSERT INTO group_resources (group_id, device_id, recurso_id)
    VALUES (?, ?, ?)
    ON CONFLICT(group_id, device_id, recurso_id) DO NOTHING
  `);

  const remover = db.prepare(`
    DELETE FROM group_resources
    WHERE group_id = ? AND device_id = ? AND recurso_id = ?
  `);

  const tocar = db.prepare(`
    UPDATE groups SET updated_at = unixepoch()
    WHERE group_id = ?
  `);

  function buscar(groupId) {
    const grupo = buscarGrupo.get(groupId);

    return grupo
      ? { ...grupo, recursos: listarMembros.all(grupo.group_id) }
      : null;
  }

  return {
    listar() {
      return listarGrupos.all();
    },

    buscar,

    criar({ group_id, nome = group_id, descricao = "" }) {
      const resultado = inserir.run(group_id.toUpperCase(), nome, descricao);

      return resultado.changes ? buscar(group_id) : null;
    },

    atualizar(groupId, alteracoes) {
      const atual = buscarGrupo.get(groupId);
      if (!atual) return null;

      atualizar.run(
        alteracoes.nome ?? atual.nome,
        alteracoes.descricao ?? atual.descricao,
        atual.group_id,
      );

      return buscar(atual.group_id);
    },

    excluir(groupId) {
      return excluir.run(groupId).changes > 0;
    },

    adicionarRecurso(groupId, globalId) {
      const grupo = buscarGrupo.get(groupId);
      if (!grupo) return { erro: "GROUP_NOT_FOUND" };

      const recurso = buscarRecurso.get(globalId);
      if (!recurso) return { erro: "RESOURCE_NOT_FOUND" };

      const resultado = associar.run(
        grupo.group_id,
        recurso.device_id,
        recurso.recurso_id,
      );

      if (resultado.changes) tocar.run(grupo.group_id);

      return {
        group_id: grupo.group_id,
        ...recurso,
        added: resultado.changes > 0,
      };
    },

    removerRecurso(groupId, globalId) {
      const grupo = buscarGrupo.get(groupId);
      if (!grupo) return { erro: "GROUP_NOT_FOUND" };

      const recurso = buscarRecurso.get(globalId);
      if (!recurso) return { erro: "RESOURCE_NOT_FOUND" };

      const resultado = remover.run(
        grupo.group_id,
        recurso.device_id,
        recurso.recurso_id,
      );

      if (!resultado.changes) {
        return { erro: "MEMBER_NOT_FOUND" };
      }

      tocar.run(grupo.group_id);
      return { removed: true };
    },
  };
}
