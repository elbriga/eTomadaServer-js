import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import eventsRoutes from "../src/routes/events.js";

test("POST /api/evento atualiza estado e preserva historico", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const resources = criarResourceRepository(db);

  resources.descobrir("GROW", [
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

  const notificacoes = [];
  const app = Fastify();

  try {
    await app.register(eventsRoutes, {
      db,
      monitor: {
        receberEvento: (id) => notificacoes.push(id),
      },
    });

    await app.ready();

    const resposta = await app.inject({
      method: "POST",
      url: "/api/evento",
      payload: {
        origem: "GROW",
        id: "S1",
        evento: "VALOR",
        device: { valor: 25 },
      },
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().ok, true);

    const sensor = resources.buscar("GROW", "S1");

    assert.deepEqual(JSON.parse(sensor.reported_json), {
      valor: 25,
      status: "OK",
    });

    const evento = db
      .prepare(
        `
      SELECT device_id, recurso_id, valor
      FROM events
    `,
      )
      .get();

    assert.equal(evento.device_id, "GROW");
    assert.equal(evento.recurso_id, "S1");
    assert.equal(evento.valor, 25);

    assert.deepEqual(notificacoes, ["GROW"]);

    // Evento sem estado continua no historico.
    const semEstado = await app.inject({
      method: "POST",
      url: "/api/evento",
      payload: {
        origem: "GROW",
        id: "R1",
        evento: "TOGGLE",
        device: {},
      },
    });

    assert.equal(semEstado.statusCode, 200);

    assert.deepEqual(JSON.parse(resources.buscar("GROW", "R1").reported_json), {
      estado: false,
    });

    assert.equal(notificacoes.length, 1);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM events").get().total,
      2,
    );
  } finally {
    await app.close();
    db.close();
  }
});
