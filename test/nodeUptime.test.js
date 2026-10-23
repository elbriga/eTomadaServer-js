import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { classificarUptime } from "../src/services/nodeUptime.js";
import { criarNodeMonitor } from "../src/services/nodeMonitor.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { inicializarSchema } from "../src/schema.js";

const observacao = (uptime, instanteMs) => ({
  uptime,
  instanteMs,
});

test("primeira observação estabelece referência", () => {
  assert.equal(classificarUptime(null, observacao(5000, 100000)), "inicial");
});

test("uptime contínuo após reconexão", () => {
  assert.equal(
    classificarUptime(observacao(600000, 100000), observacao(7800000, 7300000)),
    "continuo",
  );
});

test("reboot durante desconexão curta", () => {
  assert.equal(
    classificarUptime(observacao(600000, 100000), observacao(5000, 130000)),
    "reiniciou",
  );
});

test("reboot mesmo com uptime atual maior", () => {
  assert.equal(
    classificarUptime(observacao(600000, 100000), observacao(5400000, 7300000)),
    "reiniciou",
  );
});

test("rollover de millis não é reboot", () => {
  assert.equal(
    classificarUptime(
      observacao(2 ** 32 - 10000, 100000),
      observacao(20000, 130000),
    ),
    "continuo",
  );
});

test("intervalo maior que rollover é indeterminado", () => {
  assert.equal(
    classificarUptime(observacao(1000, 0), observacao(2000, 2 ** 32 + 1000)),
    "indeterminado",
  );
});

test("monitor identifica reboot sem iniciar polling", () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  nodes.criar({ device_id: "GROW" });

  const reinicios = [];
  const log = {
    info() {},
    warn() {},
    error() {},
  };

  const monitor = criarNodeMonitor({
    db,
    log,
    aoReiniciar(info) {
      reinicios.push(info.deviceId);
    },
  });

  try {
    const snapshot = (uptime) => ({
      device_id: "GROW",
      uptime,
      recursos: [],
    });

    assert.equal(monitor.receberSnapshot(snapshot(100000)), true);
    assert.equal(monitor.receberSnapshot(snapshot(100010)), true);

    assert.deepEqual(reinicios, []);

    assert.equal(monitor.receberSnapshot(snapshot(500)), true);

    assert.deepEqual(reinicios, ["GROW"]);
  } finally {
    db.close();
  }
});
