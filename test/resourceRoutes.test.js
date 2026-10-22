import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { inicializarSchema } from "../src/schema.js";
import resourcesRoutes from "../src/routes/resources.js";

test("API de recursos: descoberta, configuração e preservação", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const recebidos = [];
  const app = Fastify();

  try {
    await app.register(resourcesRoutes, {
      db,
      monitor: {
        receberSnapshot: (snapshot) => recebidos.push(snapshot),
      },
    });
    await app.ready();

    const snapshot = {
      device_id: "GROW",
      recursos: [
        { id: "R1", nome: "Led320", tipo: "RELE", remoto: false },
        { id: "R2", nome: "Remoto", tipo: "RELE", remoto: true },
        { id: "S1", nome: "Temperatura", tipo: "SENSOR" },
      ],
    };

    const post = await app.inject({
      method: "POST",
      url: "/api/snapshot",
      payload: snapshot,
    });

    assert.equal(post.statusCode, 200);
    assert.equal(recebidos.length, 1);

    const lista = await app.inject({
      method: "GET",
      url: "/api/nodes/GROW/resources",
    });

    assert.equal(lista.statusCode, 200);
    assert.equal(lista.json().length, 2);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/R1",
      payload: {
        global_id: "luz_grow",
        nome_configurado: "Luz do Grow",
      },
    });

    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().global_id, "LUZ_GROW");

    // Novo snapshot com nome alterado no firmware.
    const post2 = await app.inject({
      method: "POST",
      url: "/api/snapshot",
      payload: {
        ...snapshot,
        recursos: [{ id: "R1", nome: "Novo nome", tipo: "RELE" }],
      },
    });

    assert.equal(post2.statusCode, 200);

    const global = await app.inject({
      method: "GET",
      url: "/api/resources/luz_grow",
    });

    assert.equal(global.statusCode, 200);
    assert.equal(global.json().nome, "Novo nome");
    assert.equal(global.json().nome_configurado, "Luz do Grow");

    const conflito = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/S1",
      payload: { global_id: "LUZ_GROW" },
    });

    assert.equal(conflito.statusCode, 409);

    const ausente = await app.inject({
      method: "PATCH",
      url: "/api/nodes/GROW/resources/X99",
      payload: { descricao: "teste" },
    });

    assert.equal(ausente.statusCode, 404);
  } finally {
    await app.close();
    db.close();
  }
});
