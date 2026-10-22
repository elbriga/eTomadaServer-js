import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { inicializarSchema } from "../src/schema.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";

function preparar() {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  return { db, repo: criarResourceRepository(db) };
}

test("snapshot grava estados de rele e sensor", () => {
  const { db, repo } = preparar();

  try {
    const quantidade = repo.descobrir("grow", [
      {
        id: "R1",
        tipo: "RELE",
        nome: "Led320",
        device: { num: 1, pino: 21, estado: false },
      },
      {
        id: "S1",
        tipo: "SENSOR",
        device: { num: 1, valor: 0, status: "OK" },
      },
      {
        id: "R2",
        remoto: true,
        device: { estado: true },
      },
    ]);

    assert.equal(quantidade, 2);
    assert.equal(repo.buscar("GROW", "R2"), null);

    const rele = repo.buscar("GROW", "R1");
    const sensor = repo.buscar("GROW", "S1");

    assert.deepEqual(JSON.parse(rele.reported_json), {
      estado: false,
    });

    assert.deepEqual(JSON.parse(sensor.reported_json), {
      valor: 0,
      status: "OK",
    });

    assert.ok(rele.reported_at > 0);
  } finally {
    db.close();
  }
});

test("evento parcial preserva outros campos", () => {
  const { db, repo } = preparar();

  try {
    repo.descobrir("GROW", [
      {
        id: "S1",
        tipo: "SENSOR",
        device: { valor: 23, status: "OK" },
      },
      {
        id: "R1",
        tipo: "RELE",
        device: { estado: false },
      },
    ]);

    repo.atualizar("GROW", "R1", {
      global_id: "LUZ_GROW",
      nome_configurado: "Iluminacao",
    });

    assert.equal(repo.aplicarEvento("GROW", "S1", { valor: 25 }), true);

    assert.deepEqual(JSON.parse(repo.buscar("GROW", "S1").reported_json), {
      valor: 25,
      status: "OK",
    });

    // O evento usa estado inteiro; o snapshot usa booleano.
    repo.aplicarEvento("GROW", "R1", { estado: 1 });

    const rele = repo.buscarGlobal("LUZ_GROW");

    assert.deepEqual(JSON.parse(rele.reported_json), {
      estado: true,
    });

    assert.equal(rele.nome_configurado, "Iluminacao");

    // Nenhum estado inventado.
    assert.equal(repo.aplicarEvento("GROW", "R1", { estado: null }), false);
    assert.equal(repo.aplicarEvento("GROW", "X99", { estado: 1 }), false);
  } finally {
    db.close();
  }
});

test("checkpoint evita escritas quando estado nao mudou", () => {
  const { db, repo } = preparar();

  try {
    const snapshot = [{ id: "R1", device: { estado: false } }];

    repo.descobrir("GROW", snapshot);

    // Simula ultima confirmacao antiga.
    db.prepare(
      `
      UPDATE resources SET reported_at = 123
      WHERE device_id = 'GROW' AND recurso_id = 'R1'
    `,
    ).run();

    repo.descobrir("GROW", snapshot);

    const reportado = repo.buscar("GROW", "R1");
    assert.ok(reportado.reported_at > 123);

    const antes = db
      .prepare(
        `
      SELECT total_changes() AS total
    `,
      )
      .get().total;

    // Mesmo snapshot: nenhuma escrita.
    repo.descobrir("GROW", snapshot);

    const depois = db
      .prepare(
        `
      SELECT total_changes() AS total
    `,
      )
      .get().total;

    assert.equal(depois, antes);

    // Mudanca real: persistencia imediata.
    repo.descobrir("GROW", [{ id: "R1", device: { estado: true } }]);

    assert.deepEqual(JSON.parse(repo.buscar("GROW", "R1").reported_json), {
      estado: true,
    });
  } finally {
    db.close();
  }
});
