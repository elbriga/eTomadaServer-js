import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarLogRepository } from "../src/repositories/logRepository.js";
import { criarServerLogStream } from "../src/services/serverLogStream.js";
import logsRoutes from "../src/routes/logs.js";

test("Fastify grava logs internos e notifica SSE", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const eventosSse = [];
  const saida = [];

  const logsServidor = criarServerLogStream({
    output: { write: (texto) => saida.push(String(texto)) },
  });

  const app = Fastify({
    logger: {
      level: "info",
      stream: logsServidor.stream,
    },
  });

  const notificarLog = (id) => eventosSse.push(id);

  logsServidor.configurar(criarLogRepository(db, notificarLog));

  try {
    await app.register(logsRoutes, { db, notificarLog });
    await app.ready();

    // Logs produzidos pelo próprio servidor.
    app.log.info({ module: "TESTE" }, "Teste de log interno");

    app.log.warn({ device_id: "GROW", erro: "timeout" }, "Nodo OFFLINE");

    // Log recebido pela API existente dos ESPs.
    const post = await app.inject({
      method: "POST",
      url: "/api/log",
      payload: {
        deviceID: "GROW",
        level: 10,
        module: "APP",
        message: "Teste ESP",
        uptime: 100,
      },
    });

    assert.equal(post.statusCode, 200);

    const logs = db
      .prepare(
        `
      SELECT id, device_id, level, module, message
      FROM logs ORDER BY id
    `,
      )
      .all();

    assert.equal(logs.length, 3);

    assert.deepEqual(
      logs.map((log) => log.device_id),
      ["SERVER", "SERVER", "GROW"],
    );

    assert.equal(logs[0].level, 10);
    assert.equal(logs[0].module, "TESTE");
    assert.equal(logs[1].level, 5);
    assert.equal(logs[1].module, "NODES");
    assert.match(logs[1].message, /GROW.*timeout/);

    // Todos os INSERTs dispararam o mesmo notificador.
    assert.deepEqual(
      eventosSse,
      logs.map((log) => log.id),
    );

    const resposta = await app.inject({
      method: "GET",
      url: "/api/logs?deviceID=SERVER",
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().length, 2);

    const nodos = await app.inject({
      method: "GET",
      url: "/api/logs/nodes",
    });

    assert.ok(nodos.json().some((n) => n.device_id === "SERVER"));

    assert.ok(saida.length > 0);
  } finally {
    logsServidor.parar();
    await app.close();
    db.close();
  }
});

test("stream aceita mensagens divididas em chunks", () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const registrar = criarLogRepository(db);
  const logsServidor = criarServerLogStream({
    output: { write() {} },
  });

  try {
    logsServidor.configurar(registrar);

    const linha =
      JSON.stringify({
        level: 50,
        time: Date.now(),
        msg: "Erro de teste",
      }) + "\n";

    logsServidor.stream.write(linha.slice(0, 12));
    logsServidor.stream.write(linha.slice(12));

    const log = db
      .prepare(
        `
      SELECT level, message FROM logs
    `,
      )
      .get();

    assert.equal(log.level, 1);
    assert.equal(log.message, "Erro de teste");
  } finally {
    logsServidor.parar();
    db.close();
  }
});
