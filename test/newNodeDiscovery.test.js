import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema, SCHEMA_VERSION } from "../src/schema.js";
import { criarNodeMonitor } from "../src/services/nodeMonitor.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import nodesRoutes from "../src/routes/nodes.js";
import resourcesRoutes from "../src/routes/resources.js";

test("descoberta e aprovação de novo nodo", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const notificacoes = [];
  const boots = [];

  const log = {
    info() {},
    warn() {},
    error() {},
  };

  const criarMonitor = () =>
    criarNodeMonitor({
      db,
      log,
      aoAtualizar({ deviceId }) {
        notificacoes.push(deviceId);
      },
      aoReiniciar({ deviceId }) {
        boots.push(deviceId);
      },
    });

  const monitor = criarMonitor();
  const app = Fastify();

  const snapshot = {
    device_id: "SW3NOVO",
    api: "Lite",
    device_model: "Interruptor 3 teclas",
    device_board: "BK7238",
    fw_version: "26.10.28",
    ip: "10.0.0.45",
    uptime: 3000,
    recursos: [
      {
        id: "R1",
        nome: "Rele 1",
        tipo: "RELE",
      },
    ],
  };

  try {
    assert.equal(
      db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION,
    );

    await app.register(nodesRoutes, { db, monitor });
    await app.register(resourcesRoutes, { db, monitor });
    await app.ready();

    // Nodo desconhecido envia seu primeiro snapshot.
    const recebido = await app.inject({
      method: "POST",
      url: "/api/snapshot",
      payload: snapshot,
    });

    assert.equal(recebido.statusCode, 200);
    assert.equal(recebido.json().pendente, true);
    assert.equal(nodes.buscar("SW3NOVO"), null);
    assert.equal(resources.listar("SW3NOVO").length, 0);

    // O overview apresenta o nodo como NOVO.
    const overview = await app.inject({
      method: "GET",
      url: "/api/nodes/overview",
    });

    const novo = overview.json().find((n) => n.device_id === "SW3NOVO");

    assert.ok(novo);
    assert.equal(novo.status, "new");
    assert.equal(novo.pendente, true);
    assert.equal(novo.snapshot.ip, "10.0.0.45");
    assert.ok(notificacoes.includes("SW3NOVO"));

    // Novo monitor, mesmo SQLite: descoberta permanece salva.
    const monitorReiniciado = criarMonitor();

    assert.equal(monitorReiniciado.listarNovos()[0].device_id, "SW3NOVO");

    // O administrador confirma o cadastro.
    const cadastro = await app.inject({
      method: "POST",
      url: "/api/nodes",
      payload: {
        device_id: "SW3NOVO",
        nome: "Interruptor novo",
      },
    });

    assert.equal(cadastro.statusCode, 201);
    assert.equal(nodes.buscar("SW3NOVO").nome, "Interruptor novo");
    assert.equal(nodes.buscar("SW3NOVO").api, "Lite");

    assert.equal(monitor.listarNovos().length, 0);
    assert.equal(resources.listar("SW3NOVO").length, 1);

    // A aprovação não produz um BOOT artificial.
    assert.deepEqual(boots, []);

    const atualizado = await app.inject({
      method: "GET",
      url: "/api/nodes/overview",
    });

    const cadastrado = atualizado.json().find((n) => n.device_id === "SW3NOVO");

    assert.ok(cadastrado);
    assert.equal(cadastrado.pendente, undefined);
    assert.equal(cadastrado.snapshot.ip, "10.0.0.45");

    // O cadastro duplicado continua proibido.
    const duplicado = await app.inject({
      method: "POST",
      url: "/api/nodes",
      payload: { device_id: "SW3NOVO" },
    });

    assert.equal(duplicado.statusCode, 409);
  } finally {
    await app.close();
    db.close();
  }
});
