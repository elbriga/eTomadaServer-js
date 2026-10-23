export function criarRuleRepository(db) {
  const campos = `
    id, nome, ativa, escopo, device_id,
    quando_json, acao_json, revision,
    created_at, updated_at
  `;

  const selectAll = db.prepare(`
    SELECT ${campos} FROM rules
    WHERE (? IS NULL OR escopo = ?)
      AND (? IS NULL OR device_id = ? COLLATE NOCASE)
    ORDER BY id
  `);

  const selectOne = db.prepare(`
    SELECT ${campos} FROM rules WHERE id = ?
  `);

  const insert = db.prepare(`
    INSERT INTO rules (
      nome, ativa, escopo, device_id, quando_json, acao_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const update = db.prepare(`
    UPDATE rules SET
      nome = ?,
      ativa = ?,
      escopo = ?,
      device_id = ?,
      quando_json = ?,
      acao_json = ?,
      revision = revision + 1,
      updated_at = unixepoch()
    WHERE id = ? AND revision = ?
  `);

  const remove = db.prepare(`
    DELETE FROM rules WHERE id = ?
  `);

  const countLocal = db.prepare(`
    SELECT COUNT(*) AS total FROM rules
    WHERE escopo = 'LOCAL' AND device_id = ? COLLATE NOCASE
  `);

  function formatar(row) {
    if (!row) return null;

    const { quando_json, acao_json, ...dados } = row;

    return {
      ...dados,
      ativa: dados.ativa === 1,
      quando: JSON.parse(quando_json),
      acao: JSON.parse(acao_json),
    };
  }

  const buscar = (id) => formatar(selectOne.get(id));

  return {
    listar({ escopo = null, device_id = null } = {}) {
      return selectAll.all(escopo, escopo, device_id, device_id).map(formatar);
    },

    buscar,

    contarLocais(deviceId) {
      return countLocal.get(deviceId).total;
    },

    criar(regra) {
      const resultado = insert.run(
        regra.nome,
        regra.ativa ? 1 : 0,
        regra.escopo,
        regra.device_id,
        JSON.stringify(regra.quando),
        JSON.stringify(regra.acao),
      );

      return buscar(Number(resultado.lastInsertRowid));
    },

    atualizar(id, revision, regra) {
      const resultado = update.run(
        regra.nome,
        regra.ativa ? 1 : 0,
        regra.escopo,
        regra.device_id,
        JSON.stringify(regra.quando),
        JSON.stringify(regra.acao),
        id,
        revision,
      );

      return resultado.changes ? buscar(id) : null;
    },

    excluir(id) {
      return remove.run(id).changes > 0;
    },
  };
}
