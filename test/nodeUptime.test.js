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
  assert.equal(classificarUptime(null, observacao(5, 100000)), "inicial");
});

test("uptime contínuo após reconexão", () => {
  assert.equal(
    classificarUptime(observacao(600, 100000), observacao(7800, 7300000)),
    "continuo",
  );
});

test("reboot durante desconexão curta", () => {
  assert.equal(
    classificarUptime(observacao(600, 100000), observacao(5, 130000)),
    "reiniciou",
  );
});

test("reboot mesmo com uptime atual maior", () => {
  assert.equal(
    classificarUptime(observacao(600, 100000), observacao(5400, 7300000)),
    "reiniciou",
  );
});

test("uptime contínuo atravessa 50 dias", () => {
  assert.equal(
    classificarUptime(
      observacao(4_294_960, 100000),
      observacao(4_294_990, 130000),
    ),
    "continuo",
  );
});

test("uptime acima de 32 bits continua válido", () => {
  assert.equal(
    classificarUptime(
      observacao(2 ** 32 + 100, 100000),
      observacao(2 ** 32 + 130, 130000),
    ),
    "continuo",
  );
});

test("desconexão superior a 49 dias mantém detecção", () => {
  const intervaloMs = 2 ** 32 + 1000;

  assert.equal(
    classificarUptime(observacao(1000, 0), observacao(4_295_968, intervaloMs)),
    "continuo",
  );

  assert.equal(
    classificarUptime(observacao(1000, 0), observacao(10, intervaloMs)),
    "reiniciou",
  );
});

test("uptime fora do intervalo seguro do JS é inválido", () => {
  assert.equal(
    classificarUptime(
      observacao(100, 100000),
      observacao(Number.MAX_SAFE_INTEGER + 1, 130000),
    ),
    "indeterminado",
  );
});

test("monitor identifica boot via push sem iniciar polling", () => {
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

    assert.equal(monitor.receberSnapshot(snapshot(2 ** 32 + 100)), true);
    assert.deepEqual(reinicios, ["GROW"]);

    assert.equal(monitor.receberSnapshot(snapshot(2 ** 32 + 110)), true);
    assert.deepEqual(reinicios, ["GROW", "GROW"]);

    assert.equal(monitor.receberSnapshot(snapshot(5)), true);
    assert.deepEqual(reinicios, ["GROW", "GROW", "GROW"]);

    assert.equal(monitor.obterStatus("GROW").origem, "push");
  } finally {
    db.close();
  }
});
