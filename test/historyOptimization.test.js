import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { inicializarSchema } from "../src/schema.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarHistoryOptimization } from "../src/services/historyOptimization.js";
import resourcesRoutes from "../src/routes/resources.js";
import eventsRoutes from "../src/routes/events.js";

test("compactação opcional reduz ruído, preserva degraus, metadados e janela aberta", async () => {
  const db = new DatabaseSync(":memory:");
  const app = Fastify();
  try {
    inicializarSchema(db);
    const recursos = criarResourceRepository(db);
    recursos.descobrir("GROW", [
      { id: "S1", tipo: "SENSOR" }, { id: "S2", tipo: "SENSOR" }, { id: "R1", tipo: "RELE" },
    ]);
    assert.equal(recursos.buscar("GROW", "S1").otimizar_historico, 0);
    const inicio = Math.floor(Date.now() / 1000 / 300) * 300 - 900;
    const inserir = db.prepare(`INSERT INTO events
      (timestamp, device_id, recurso_id, evento, valor, status)
      VALUES (?, 'GROW', ?, 'SENSOR', ?, '')`);
    for (let i = 0; i < 900; i++) {
      const valor = i < 150 || i >= 750 ? 16 + i % 3 : 340 + i % 5;
      inserir.run(inicio + i, "S1", valor);
      inserir.run(inicio + i, "S2", valor);
    }
    // Evento com status e estado próprios não pode desaparecer na média.
    db.prepare(`INSERT INTO events (timestamp, device_id, recurso_id, evento, valor, status, estado)
      VALUES (?, 'GROW', 'S1', 'ALERTA', 999, 'falha', 1)`).run(inicio + 400);
    const aberto = Number(inserir.run(inicio + 901, "S1", 42).lastInsertRowid);
    await app.register(resourcesRoutes, { db, monitor: {} });
    await app.register(eventsRoutes, { db, monitor: { receberEvento() {} } });
    const patch = (id, valor) => app.inject({ method: "PATCH",
      url: `/api/nodes/GROW/resources/${id}`, payload: { otimizar_historico: valor } });
    assert.equal((await patch("R1", true)).statusCode, 422);
    assert.equal((await patch("S1", true)).statusCode, 200);
    const listar = () => db.prepare("SELECT * FROM events WHERE recurso_id = 'S1' ORDER BY timestamp, id").all();
    const resultado = listar();
    assert.ok(resultado.length < 100, `${resultado.length} registros`);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE recurso_id = 'S2'").get().n, 900);
    assert.equal(resultado.find((e) => e.id === aberto).valor, 42);
    assert.equal(resultado.find((e) => e.evento === "ALERTA").valor, 999);
    const baixo = resultado.findLast((e) => e.timestamp < inicio + 150);
    const alto = resultado.find((e) => e.timestamp >= inicio + 150);
    assert.equal(baixo.timestamp, inicio + 149);
    assert.equal(alto.timestamp, inicio + 150);
    assert.ok(baixo.valor < 20);
    assert.ok(alto.valor > 335 && alto.valor < 345);
    criarHistoryOptimization(db).compactar("GROW", "S1");
    assert.deepEqual(listar(), resultado);
    recursos.descobrir("GROW", [{ id: "S1", tipo: "SENSOR" }]);
    assert.equal(recursos.buscar("GROW", "S1").otimizar_historico, 1);
    assert.equal((await patch("S1", false)).statusCode, 200);
    assert.deepEqual(listar(), resultado);
    // Ao reativar, eventos novos também provocam a compactação de janelas fechadas.
    await patch("S1", true);
    for (let i = 0; i < 50; i++) inserir.run(inicio - 300 + i, "S1", 100 + i % 2);
    const recebido = await app.inject({ method: "POST", url: "/api/evento",
      payload: { origem: "GROW", id: "S1", evento: "SENSOR", device: { valor: 21 } } });
    assert.equal(recebido.statusCode, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE recurso_id = 'S1' AND timestamp < ?").get(inicio).n, 2);
    assert.equal(recursos.buscar("GROW", "S1").reported_json, '{"valor":21}');
  } finally {
    await app.close();
    db.close();
  }
});
