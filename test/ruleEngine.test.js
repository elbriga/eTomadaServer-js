import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import { criarRuleEngine } from "../src/services/ruleEngine.js";
import eventsRoutes from "../src/routes/events.js";

function preparar() {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const rules = criarRuleRepository(db);

  nodes.criar({ device_id: "GROW" });

  resources.descobrir("GROW", [
    { id: "B1", tipo: "BOTAO", nome: "Botão" },
    {
      id: "S1",
      tipo: "SENSOR",
      nome: "Temperatura",
      device: { valor: 25 },
    },
    { id: "R1", tipo: "RELE", nome: "Luz" },
  ]);

  resources.atualizar("GROW", "B1", {
    global_id: "BOTAO_GROW",
  });

  resources.atualizar("GROW", "S1", {
    global_id: "TEMP_GROW",
  });

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });

  rules.criar({
    nome: "Teste evento com check",
    ativa: true,
    escopo: "GLOBAL",
    device_id: null,
    quando: {
      tipo: "EVENTO",
      recurso: "BOTAO_GROW",
      evento: "CLICK",
      check: {
        variavel: "TEMP_GROW",
        operacao: ">",
        valor: 20,
      },
    },
    acao: {
      tipo: "ESTADO",
      recurso: "LUZ_GROW",
      comando: "ON",
    },
  });

  return { db, rules };
}

const evento = {
  origem: "GROW",
  id: "B1",
  evento: "CLICK",
  device: {},
};

test("evento físico dispara regra global", () => {
  const { db } = preparar();

  try {
    const logs = [];

    const engine = criarRuleEngine({
      db,
      log: {
        info: (dados, mensagem) => logs.push({ dados, mensagem }),
      },
    });

    const acoes = engine.processarEvento(evento);

    assert.equal(acoes.length, 1);
    assert.equal(acoes[0].regra_id, 1);
    assert.equal(acoes[0].acao.recurso, "LUZ_GROW");
    assert.equal(acoes[0].acao.comando, "ON");

    assert.equal(logs.length, 1);
    assert.match(logs[0].mensagem, /SIMULACAO/);
  } finally {
    db.close();
  }
});

test("evento sem global_id não dispara regra", () => {
  const { db } = preparar();

  try {
    const engine = criarRuleEngine({
      db,
      log: { info() {} },
    });

    assert.deepEqual(
      engine.processarEvento({
        ...evento,
        id: "NAO_EXISTE",
      }),
      [],
    );
  } finally {
    db.close();
  }
});

test("check falso impede disparo", () => {
  const { db } = preparar();

  try {
    const resources = criarResourceRepository(db);
    resources.aplicarEvento("GROW", "S1", {
      valor: 15,
    });

    const engine = criarRuleEngine({
      db,
      log: { info() {} },
    });

    assert.deepEqual(engine.processarEvento(evento), []);
  } finally {
    db.close();
  }
});

test("POST /api/evento mantém persistência e aciona simulação", async () => {
  const { db } = preparar();
  const app = Fastify();

  const logs = [];
  const engine = criarRuleEngine({
    db,
    log: {
      info: (dados, mensagem) => logs.push({ dados, mensagem }),
    },
  });

  try {
    await app.register(eventsRoutes, {
      db,
      monitor: { receberEvento() {} },
      ruleEngine: engine,
    });

    await app.ready();

    const resposta = await app.inject({
      method: "POST",
      url: "/api/evento",
      payload: evento,
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().ok, true);

    // Aguarda o processamento agendado com setImmediate.
    await new Promise((resolve) => setImmediate(resolve));

    const salvo = db
      .prepare(
        `
      SELECT device_id, recurso_id, evento
      FROM events
    `,
      )
      .get();

    assert.equal(salvo.device_id, "GROW");
    assert.equal(salvo.recurso_id, "B1");
    assert.equal(salvo.evento, "CLICK");

    assert.equal(logs.length, 1);
    assert.equal(logs[0].dados.regra_id, 1);
  } finally {
    await app.close();
    db.close();
  }
});
