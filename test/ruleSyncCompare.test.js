import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { compararRegrasLocais } from "../src/services/ruleSyncCompare.js";
import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import rulesRoutes from "../src/routes/rules.js";

const regra = {
  id: 1,
  nome: "Luz local",
  ativa: true,
  quando: {
    tipo: "HORARIO",
    hora: 4,
    minuto: 0,
  },
  acao: {
    tipo: "ESTADO",
    recurso: "R1",
    comando: "ON",
  },
};

test("ignora metadados e ordem das chaves JSON", () => {
  const servidor = [
    {
      ...regra,
      escopo: "LOCAL",
      device_id: "GROW",
      revision: 7,
    },
  ];

  const nodo = [
    {
      id: 1,
      descricao: "HORARIO 04:00 -> R1 ON",
      ativa: true,
      acao: {
        comando: "ON",
        recurso: "R1",
        tipo: "ESTADO",
      },
      quando: {
        minuto: 0,
        hora: 4,
        tipo: "HORARIO",
      },
      nome: "Luz local",
    },
  ];

  const resultado = compararRegrasLocais(servidor, nodo);

  assert.equal(resultado.situacao, "IGUAL");
  assert.deepEqual(resultado.iguais, [1]);
});

test("identifica regras ausentes e divergentes", () => {
  const servidor = [regra, { ...regra, id: 2, nome: "Regra servidor" }];

  const nodo = [
    { ...regra, acao: { ...regra.acao, comando: "OFF" } },
    { ...regra, id: 3, nome: "Regra nodo" },
  ];

  const resultado = compararRegrasLocais(servidor, nodo);

  assert.equal(resultado.situacao, "DIVERGENTE");
  assert.deepEqual(resultado.iguais, []);
  assert.deepEqual(
    resultado.somente_servidor.map((r) => r.id),
    [2],
  );
  assert.deepEqual(
    resultado.somente_nodo.map((r) => r.id),
    [3],
  );
  assert.equal(resultado.divergentes[0].id, 1);
});

test("rejeita IDs duplicados e listas inválidas", () => {
  assert.throws(() => compararRegrasLocais([regra, regra], []), /duplicado/);

  assert.throws(() => compararRegrasLocais([], null), TypeError);
});

test("API compara regras do banco com snapshot Full", async () => {
  const db = new DatabaseSync(":memory:");
  const app = Fastify();

  try {
    inicializarSchema(db);

    const nodes = criarNodeRepository(db);
    nodes.criar({ device_id: "GROW" });

    db.prepare(
      `
      UPDATE nodes SET api = 'Full'
      WHERE device_id = 'GROW'
    `,
    ).run();

    const rules = criarRuleRepository(db);
    const cadastrada = rules.criar({
      nome: regra.nome,
      ativa: regra.ativa,
      escopo: "LOCAL",
      device_id: "GROW",
      quando: regra.quando,
      acao: regra.acao,
    });

    let snapshot = {
      api: "Full",
      device_id: "GROW",
      uptime: 15000,
      regras: [{ ...regra, id: cadastrada.id }],
    };

    await app.register(rulesRoutes, {
      db,
      monitor: {
        async consultar() {
          return { snapshot };
        },
      },
    });

    await app.ready();

    const consultar = () =>
      app.inject({
        method: "GET",
        url: "/api/nodes/GROW/rules/compare",
      });

    const igual = await consultar();

    assert.equal(igual.statusCode, 200);
    assert.equal(igual.json().situacao, "IGUAL");
    assert.deepEqual(igual.json().iguais, [cadastrada.id]);

    snapshot = {
      ...snapshot,
      regras: [
        {
          ...regra,
          id: cadastrada.id,
          acao: { ...regra.acao, comando: "OFF" },
        },
      ],
    };

    const diferente = await consultar();

    assert.equal(diferente.statusCode, 200);
    assert.equal(diferente.json().situacao, "DIVERGENTE");
    assert.equal(diferente.json().divergentes.length, 1);

    snapshot = { ...snapshot, regras: null };

    const invalido = await consultar();
    assert.equal(invalido.statusCode, 502);
  } finally {
    await app.close();
    db.close();
  }
});
