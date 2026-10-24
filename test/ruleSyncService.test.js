import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import { criarRuleSyncService } from "../src/services/ruleSyncService.js";

function preparar(modo = "execute") {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const rules = criarRuleRepository(db);

  nodes.criar({ device_id: "GROW" });
  db.prepare("UPDATE nodes SET api = 'Full' WHERE device_id = 'GROW'").run();

  const remoto = {
    api: "Full",
    device_id: "GROW",
    uptime: 10000,
    rules_revision: "",
    regras: [],
  };

  const chamadas = [];
  const logs = [];

  const sync = criarRuleSyncService({
    db,
    modo,
    retryMs: 0,
    log: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
    async consultar() {
      return { snapshot: structuredClone(remoto) };
    },
    async enviar({ deviceId, pacote }) {
      chamadas.push({ deviceId, pacote });

      remoto.regras = structuredClone(pacote.regras);
      remoto.rules_revision = pacote.revision;

      return {
        msg: "OK",
        revision: pacote.revision,
        total: pacote.regras.length,
      };
    },
  });

  const criarRegra = (hora, comando) =>
    rules.criar({
      nome: `GROW R1 ${comando}`,
      ativa: true,
      escopo: "LOCAL",
      device_id: "GROW",
      quando: { tipo: "HORARIO", hora, minuto: 0 },
      acao: {
        tipo: "ESTADO",
        recurso: "R1",
        comando,
      },
    });

  return {
    db,
    rules,
    remoto,
    chamadas,
    logs,
    sync,
    criarRegra,
  };
}

test("instala o conjunto completo e não repete PUT sem divergência", async () => {
  const c = preparar();

  try {
    c.criarRegra(4, "ON");
    c.criarRegra(22, "OFF");

    await c.sync.solicitar("GROW");

    assert.equal(c.chamadas.length, 1);
    assert.equal(c.remoto.regras.length, 2);
    assert.match(c.remoto.rules_revision, /^[a-f0-9]{64}$/);

    await c.sync.solicitar("GROW");

    assert.equal(c.chamadas.length, 1);
  } finally {
    await c.sync.parar();
    c.db.close();
  }
});

test("exclusões no servidor removem regras do Full", async () => {
  const c = preparar();

  try {
    const on = c.criarRegra(4, "ON");
    const off = c.criarRegra(22, "OFF");

    await c.sync.solicitar("GROW");

    c.rules.excluir(on.id);
    await c.sync.solicitar("GROW");

    assert.deepEqual(
      c.remoto.regras.map((r) => r.id),
      [off.id],
    );

    c.rules.excluir(off.id);
    await c.sync.solicitar("GROW");

    assert.deepEqual(c.remoto.regras, []);
    assert.equal(c.chamadas.length, 3);
  } finally {
    await c.sync.parar();
    c.db.close();
  }
});

test("detecta divergência mesmo com revision igual", async () => {
  const c = preparar();

  try {
    c.criarRegra(4, "ON");
    await c.sync.solicitar("GROW");

    c.remoto.regras[0].nome = "ALTERADA NO NODO";

    await c.sync.solicitar("GROW");

    assert.equal(c.chamadas.length, 2);
    assert.equal(c.remoto.regras[0].nome, "GROW R1 ON");
  } finally {
    await c.sync.parar();
    c.db.close();
  }
});

test("simulação não envia configurações", async () => {
  const c = preparar("simulate");

  try {
    c.criarRegra(4, "ON");

    await c.sync.solicitar("GROW");

    assert.equal(c.chamadas.length, 0);
    assert.deepEqual(c.remoto.regras, []);
    assert.ok(
      c.logs.some((args) =>
        args.some(
          (item) =>
            typeof item === "string" && item.includes("[SYNC][SIMULACAO]"),
        ),
      ),
    );
  } finally {
    await c.sync.parar();
    c.db.close();
  }
});

test("falha no PUT preserva configuração anterior", async () => {
  const c = preparar();

  try {
    c.criarRegra(4, "ON");

    // Simula uma falha de comunicação antes da aplicação.
    const syncComFalha = criarRuleSyncService({
      db: c.db,
      modo: "execute",
      retryMs: 0,
      log: {
        info() {},
        warn() {},
        error() {},
      },
      async consultar() {
        return { snapshot: c.remoto };
      },
      async enviar() {
        throw new Error("Timeout de teste");
      },
    });

    await syncComFalha.solicitar("GROW");

    assert.deepEqual(c.remoto.regras, []);
    assert.equal(c.remoto.rules_revision, "");

    await syncComFalha.parar();
  } finally {
    await c.sync.parar();
    c.db.close();
  }
});
