import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarGroupRepository } from "../src/repositories/groupRepository.js";
import groupsRoutes from "../src/routes/groups.js";

function preparar() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  inicializarSchema(db);

  const resources = criarResourceRepository(db);
  const groups = criarGroupRepository(db);

  resources.descobrir("GROW", [{ id: "R1", nome: "Led320", tipo: "RELE" }]);
  resources.descobrir("SW6FRI", [{ id: "R1", nome: "Relé 1", tipo: "RELE" }]);

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });
  resources.atualizar("SW6FRI", "R1", {
    global_id: "LUZ_ESCADA_TRI",
  });

  return { db, resources, groups };
}

test("schema v4 e inicialização repetida", () => {
  const { db } = preparar();

  try {
    inicializarSchema(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);

    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

    for (const tabela of ["groups", "group_resources"]) {
      const existe = db
        .prepare(
          `
        SELECT name FROM sqlite_master WHERE name = ?
      `,
        )
        .get(tabela);

      assert.ok(existe);
    }
  } finally {
    db.close();
  }
});

test("CRUD de grupos e unicidade de group_id", () => {
  const { db, groups } = preparar();

  try {
    const grupo = groups.criar({
      group_id: "iluminacao",
      nome: "Iluminação",
    });

    assert.equal(grupo.group_id, "ILUMINACAO");
    assert.equal(grupo.recursos.length, 0);

    assert.equal(groups.criar({ group_id: "ILUMINACAO" }), null);

    const atualizado = groups.atualizar("iluminacao", {
      descricao: "Todas as luzes",
    });

    assert.equal(atualizado.descricao, "Todas as luzes");
    assert.equal(groups.listar().length, 1);

    assert.equal(groups.excluir("ILUMINACAO"), true);
    assert.equal(groups.buscar("ILUMINACAO"), null);
  } finally {
    db.close();
  }
});

test("recurso pertence a varios grupos sem duplicacao", () => {
  const { db, groups } = preparar();

  try {
    groups.criar({ group_id: "ILUMINACAO" });
    groups.criar({ group_id: "PRIMEIRO_ANDAR" });

    assert.equal(groups.adicionarRecurso("ILUMINACAO", "LUZ_GROW").added, true);

    assert.equal(
      groups.adicionarRecurso("ILUMINACAO", "LUZ_GROW").added,
      false,
    );

    groups.adicionarRecurso("ILUMINACAO", "LUZ_ESCADA_TRI");

    groups.adicionarRecurso("PRIMEIRO_ANDAR", "LUZ_GROW");

    assert.equal(groups.buscar("ILUMINACAO").recursos.length, 2);

    assert.equal(groups.buscar("PRIMEIRO_ANDAR").recursos.length, 1);
  } finally {
    db.close();
  }
});

test("renomear global_id preserva associação", () => {
  const { db, resources, groups } = preparar();

  try {
    groups.criar({ group_id: "GROW" });
    groups.adicionarRecurso("GROW", "LUZ_GROW");

    resources.atualizar("GROW", "R1", {
      global_id: "ILUMINACAO_GROW",
    });

    const grupo = groups.buscar("GROW");

    assert.equal(grupo.recursos[0].global_id, "ILUMINACAO_GROW");

    assert.equal(
      groups.removerRecurso("GROW", "ILUMINACAO_GROW").removed,
      true,
    );

    assert.equal(groups.buscar("GROW").recursos.length, 0);
  } finally {
    db.close();
  }
});

test("exclusão em cascata preserva outros grupos e recursos", () => {
  const { db, groups } = preparar();

  try {
    groups.criar({ group_id: "ILUMINACAO" });
    groups.criar({ group_id: "GROW" });

    groups.adicionarRecurso("ILUMINACAO", "LUZ_GROW");
    groups.adicionarRecurso("GROW", "LUZ_GROW");

    groups.excluir("ILUMINACAO");

    assert.equal(groups.buscar("GROW").recursos.length, 1);

    // Simula exclusão do recurso físico.
    db.prepare(
      `
      DELETE FROM resources
      WHERE device_id = 'GROW' AND recurso_id = 'R1'
    `,
    ).run();

    assert.equal(groups.buscar("GROW").recursos.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resources").get().n, 1);
  } finally {
    db.close();
  }
});

test("API HTTP de grupos e associações", async () => {
  const { db } = preparar();
  const app = Fastify();

  try {
    await app.register(groupsRoutes, { db });
    await app.ready();

    const criar = await app.inject({
      method: "POST",
      url: "/api/groups",
      payload: {
        group_id: "ILUMINACAO",
        nome: "Todas as luzes",
      },
    });

    assert.equal(criar.statusCode, 201);

    const duplicado = await app.inject({
      method: "POST",
      url: "/api/groups",
      payload: { group_id: "iluminacao" },
    });

    assert.equal(duplicado.statusCode, 409);

    const associar = await app.inject({
      method: "PUT",
      url: "/api/groups/ILUMINACAO/resources/LUZ_GROW",
    });

    assert.equal(associar.statusCode, 201);

    const repetir = await app.inject({
      method: "PUT",
      url: "/api/groups/ILUMINACAO/resources/LUZ_GROW",
    });

    assert.equal(repetir.statusCode, 200);
    assert.equal(repetir.json().added, false);

    const consulta = await app.inject({
      method: "GET",
      url: "/api/groups/ILUMINACAO",
    });

    assert.equal(consulta.statusCode, 200);
    assert.equal(consulta.json().recursos.length, 1);

    const inexistente = await app.inject({
      method: "PUT",
      url: "/api/groups/ILUMINACAO/resources/INEXISTENTE",
    });

    assert.equal(inexistente.statusCode, 404);

    const remover = await app.inject({
      method: "DELETE",
      url: "/api/groups/ILUMINACAO/resources/LUZ_GROW",
    });

    assert.equal(remover.statusCode, 204);

    const excluir = await app.inject({
      method: "DELETE",
      url: "/api/groups/ILUMINACAO",
    });

    assert.equal(excluir.statusCode, 204);
  } finally {
    await app.close();
    db.close();
  }
});
