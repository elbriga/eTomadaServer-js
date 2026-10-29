import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";

import { inicializarSchema, SCHEMA_VERSION } from "../src/schema.js";

import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import rulesRoutes from "../src/routes/rules.js";

function prepararBanco() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);

  nodes.criar({ device_id: "GROW" });
  db.prepare("UPDATE nodes SET api = 'Full' WHERE device_id = 'GROW'").run();

  resources.descobrir("GROW", [
    { id: "R1", nome: "Luz", tipo: "RELE" },
    { id: "B1", nome: "Botão", tipo: "BOTAO" },
  ]);

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });

  resources.atualizar("GROW", "B1", {
    global_id: "BOTAO_GROW",
  });

  return db;
}

const globalBody = {
  nome: "Luz GROW ON",
  ativa: true,
  escopo: "GLOBAL",
  quando: {
    tipo: "HORARIO",
    hora: 4,
    minuto: 0,
  },
  acao: {
    tipo: "ESTADO",
    recurso: "LUZ_GROW",
    comando: "ON",
  },
};

const localBody = {
  nome: "Botão GROW",
  ativa: true,
  escopo: "LOCAL",
  device_id: "GROW",
  quando: {
    tipo: "EVENTO",
    recurso: "B1",
    evento: "CLICK",
  },
  acao: {
    tipo: "ESTADO",
    recurso: "R1",
    comando: "TOGGLE",
  },
};

test("schema atual e migração 4→10", () => {
  const db = prepararBanco();

  try {
    assert.equal(
      db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );

    // Simula um banco v4 com dados já persistidos.
    db.exec(`
      DROP TABLE nodes_pending;
      DROP TABLE node_recovery;
      DROP TABLE rules;
      DROP INDEX idx_groups_global_id;
      ALTER TABLE groups DROP COLUMN global_id;
      ALTER TABLE nodes DROP COLUMN descricao;
      ALTER TABLE nodes DROP COLUMN telegram_alert;
      PRAGMA user_version = 4;

      INSERT INTO logs (timestamp, device_id, message)
      VALUES (100, 'GROW', 'log anterior');
    `);

    inicializarSchema(db);
    inicializarSchema(db);

    assert.equal(
      db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );

    assert.equal(
      db.prepare("SELECT message FROM logs").get().message,
      "log anterior",
    );

    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM rules").get().total,
      0,
    );
  } finally {
    db.close();
  }
});

test("persistência e reabertura do SQLite", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "etomada-rules-"));
  const arquivo = path.join(dir, "teste.sqlite");

  try {
    const db = new DatabaseSync(arquivo);
    inicializarSchema(db);

    const rules = criarRuleRepository(db);
    const regra = rules.criar({
      ...globalBody,
      device_id: null,
    });

    assert.equal(regra.id, 1);
    assert.equal(regra.revision, 1);
    db.close();

    const reaberto = new DatabaseSync(arquivo);
    try {
      inicializarSchema(reaberto);
      const recuperada = criarRuleRepository(reaberto).buscar(1);

      assert.equal(recuperada.nome, "Luz GROW ON");
      assert.equal(recuperada.quando.hora, 4);
      assert.equal(recuperada.acao.comando, "ON");
    } finally {
      reaberto.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API CRUD, escopos, revisões e validação", async () => {
  const db = prepararBanco();
  const app = Fastify();

  try {
    await app.register(rulesRoutes, { db });
    await app.ready();

    const criarGlobal = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: globalBody,
    });

    assert.equal(criarGlobal.statusCode, 201);

    const global = criarGlobal.json();
    assert.equal(global.id, 1);
    assert.equal(global.revision, 1);
    assert.equal(global.escopo, "GLOBAL");
    assert.equal(global.device_id, null);

    const criarLocal = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: localBody,
    });

    assert.equal(criarLocal.statusCode, 201);
    assert.equal(criarLocal.json().device_id, "GROW");

    const listar = await app.inject({
      method: "GET",
      url: "/api/rules?escopo=LOCAL&device_id=GROW",
    });

    assert.equal(listar.statusCode, 200);
    assert.equal(listar.json().length, 1);
    assert.equal(listar.json()[0].acao.comando, "TOGGLE");

    const consultar = await app.inject({
      method: "GET",
      url: `/api/rules/${global.id}`,
    });

    assert.equal(consultar.statusCode, 200);

    const atualizarBody = {
      ...globalBody,
      nome: "Luz GROW ON atualizado",
      revision: 1,
    };

    const atualizar = await app.inject({
      method: "PUT",
      url: `/api/rules/${global.id}`,
      payload: atualizarBody,
    });

    assert.equal(atualizar.statusCode, 200);
    assert.equal(atualizar.json().revision, 2);

    const desatualizado = await app.inject({
      method: "PUT",
      url: `/api/rules/${global.id}`,
      payload: atualizarBody,
    });

    assert.equal(desatualizado.statusCode, 409);

    const recursoInvalido = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: {
        ...globalBody,
        acao: {
          tipo: "ESTADO",
          recurso: "NAO_EXISTE",
          comando: "ON",
        },
      },
    });

    assert.equal(recursoInvalido.statusCode, 400);

    const horarioInvalido = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: {
        ...globalBody,
        quando: {
          tipo: "HORARIO",
          hora: 25,
          minuto: 0,
        },
      },
    });

    assert.equal(horarioInvalido.statusCode, 400);

    const excluir = await app.inject({
      method: "DELETE",
      url: `/api/rules/${global.id}`,
    });

    assert.equal(excluir.statusCode, 204);

    const inexistente = await app.inject({
      method: "GET",
      url: `/api/rules/${global.id}`,
    });

    assert.equal(inexistente.statusCode, 404);
  } finally {
    await app.close();
    db.close();
  }
});

test("limite de 64 regras locais por nodo", async () => {
  const db = prepararBanco();
  const app = Fastify();

  try {
    await app.register(rulesRoutes, { db });
    await app.ready();

    for (let i = 0; i < 64; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/rules",
        payload: {
          ...localBody,
          nome: `Regra ${i}`,
          ativa: false,
        },
      });

      assert.equal(res.statusCode, 201);
    }

    const excedente = await app.inject({
      method: "POST",
      url: "/api/rules",
      payload: localBody,
    });

    assert.equal(excedente.statusCode, 409);

    const lista = await app.inject({
      method: "GET",
      url: "/api/rules?escopo=LOCAL&device_id=GROW",
    });

    assert.equal(lista.json().length, 64);
  } finally {
    await app.close();
    db.close();
  }
});
