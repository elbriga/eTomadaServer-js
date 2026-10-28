import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema, SCHEMA_VERSION } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import nodesRoutes from "../src/routes/nodes.js";
import resourcesRoutes from "../src/routes/resources.js";

test("administração de nodo e integridade dos recursos", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const rules = criarRuleRepository(db);

  nodes.criar({
    device_id: "GROW",
    nome: "Grow",
  });

  resources.descobrir("GROW", [
    { id: "R1", nome: "Led320", tipo: "RELE" },
    { id: "S1", nome: "Temperatura", tipo: "SENSOR" },
  ]);

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });

  const monitor = {
    obterStatus: () => null,
    listarNovos: () => [],
    resetar: () => {},
    receberSnapshot: () => {},
  };

  const app = Fastify();

  try {
    await app.register(nodesRoutes, { db, monitor });
    await app.register(resourcesRoutes, { db, monitor });
    await app.ready();

    // Cadastro e descrição do nodo.
    const edicao = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW",
      payload: {
        nome: "Iluminação Grow",
        descricao: "Controlador de iluminação",
        enabled: false,
      },
    });

    assert.equal(edicao.statusCode, 200);
    assert.equal(edicao.json().nome, "Iluminação Grow");
    assert.equal(edicao.json().descricao, "Controlador de iluminação");
    assert.equal(edicao.json().enabled, false);

    const overview = await app.inject({
      method: "GET",
      url: "/api/nodes/overview",
    });

    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json()[0].descricao, "Controlador de iluminação");

    // Atualizar descrição sem alterar os demais dados.
    const parcial = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW",
      payload: {
        descricao: "Nova descrição",
      },
    });

    assert.equal(parcial.statusCode, 200);
    assert.equal(parcial.json().nome, "Iluminação Grow");
    assert.equal(parcial.json().descricao, "Nova descrição");

    // Editar metadados do recurso.
    const recurso = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/R1",
      payload: {
        nome_configurado: "Luz principal",
        descricao: "Iluminação do ambiente",
      },
    });

    assert.equal(recurso.statusCode, 200);
    assert.equal(recurso.json().global_id, "LUZ_GROW");
    assert.equal(recurso.json().nome_configurado, "Luz principal");

    // Mesmo uma regra desativada conserva referências.
    const regra = rules.criar({
      nome: "Acender GROW",
      ativa: false,
      escopo: "GLOBAL",
      device_id: null,
      quando: { tipo: "HORARIO", hora: 4, minuto: 0 },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "ON",
      },
    });

    const bloqueado = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/R1",
      payload: { global_id: "LUZ_PRINCIPAL" },
    });

    assert.equal(bloqueado.statusCode, 409);
    assert.deepEqual(bloqueado.json().rules, [regra.id]);
    assert.equal(resources.buscar("GROW", "R1").global_id, "LUZ_GROW");

    // Alterações descritivas continuam permitidas.
    const descricao = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/R1",
      payload: { descricao: "Nova descrição do relé" },
    });

    assert.equal(descricao.statusCode, 200);

    // Depois de excluir a regra, a renomeação é permitida.
    rules.excluir(regra.id);

    const renomeado = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/R1",
      payload: { global_id: "LUZ_PRINCIPAL" },
    });

    assert.equal(renomeado.statusCode, 200);
    assert.equal(renomeado.json().global_id, "LUZ_PRINCIPAL");

    // A identidade física permanece a mesma.
    assert.equal(renomeado.json().recurso_id, "R1");

    assert.equal(
      db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );
  } finally {
    await app.close();
    db.close();
  }
});
