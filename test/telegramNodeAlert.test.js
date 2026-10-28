import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarNodeMonitor } from "../src/services/nodeMonitor.js";

test("alertas Telegram acompanham configuração SQLite", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  nodes.criar({ device_id: "GROW" });

  const enviados = [];
  const monitor = criarNodeMonitor({
    db,
    log: { info() {}, warn() {}, error() {} },
    enviarTelegram: async (texto) => {
      enviados.push(texto);
    },
  });

  const snapshot = {
    device_id: "GROW",
    uptime: 45000,
    recursos: [],
  };

  const processarEnvios = () => new Promise(setImmediate);

  try {
    // Padrão: alertas desligados.
    assert.equal(nodes.buscar("GROW").telegram_alert, false);

    monitor.receberSnapshot(snapshot);
    await processarEnvios();
    assert.deepEqual(enviados, []);

    // Ativar sem reiniciar o monitor.
    nodes.atualizar("GROW", { telegram_alert: true });
    assert.equal(nodes.buscar("GROW").telegram_alert, true);

    monitor.resetar("GROW");
    monitor.receberSnapshot(snapshot);
    await processarEnvios();

    assert.deepEqual(enviados, ["[GROW] ONLINE"]);

    // Desativar imediatamente.
    nodes.atualizar("GROW", { telegram_alert: false });

    monitor.resetar("GROW");
    monitor.receberSnapshot(snapshot);
    await processarEnvios();

    assert.equal(enviados.length, 1);
  } finally {
    await monitor.parar();
    db.close();
  }
});
