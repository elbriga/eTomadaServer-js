import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarNodeMonitor } from "../src/services/nodeMonitor.js";

test("GET antigo nao sobrescreve evento mais recente", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);

  nodes.criar({ device_id: "GROW" });
  resources.descobrir("GROW", [
    { id: "R1", tipo: "RELE", device: { estado: false } },
  ]);

  const monitor = criarNodeMonitor({
    db,
    log: { info() {}, warn() {}, error() {} },
  });

  const fetchOriginal = globalThis.fetch;
  let responderGet;

  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          responderGet = resolve;
        }),
    });

    // Inicia GET que ficara aguardando a resposta.
    const consulta = monitor.consultar("GROW");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof responderGet, "function");

    // Um evento chega enquanto o GET esta pendente.
    resources.aplicarEvento("GROW", "R1", { estado: 1 });
    monitor.receberEvento("GROW");

    // O GET antigo responde com estado anterior.
    responderGet({
      device_id: "GROW",
      recursos: [{ id: "R1", tipo: "RELE", device: { estado: false } }],
    });

    const resultado = await consulta;

    assert.equal(resultado.desatualizado, true);

    const recurso = resources.buscar("GROW", "R1");

    assert.deepEqual(JSON.parse(recurso.reported_json), {
      estado: true,
    });
  } finally {
    await monitor.parar();
    globalThis.fetch = fetchOriginal;
    db.close();
  }
});
