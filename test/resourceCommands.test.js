import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import {
  enviarComandoRele,
  enviarComandosLote,
} from "../src/devices/nodeClient.js";
import resourcesRoutes from "../src/routes/resources.js";

function respostaRele(id, estado) {
  return {
    msg: "OK",
    duracao_ms: 10,
    recurso: {
      id,
      tipo: "RELE",
      device: { estado },
    },
  };
}

async function preparar({ permitirComandos = true, enviarComando } = {}) {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);

  nodes.criar({ device_id: "GROW" });
  nodes.salvarSnapshot("GROW", {
    device_id: "GROW",
    api: "Full",
  });

  resources.descobrir("GROW", [
    {
      id: "R1",
      tipo: "RELE",
      nome: "Led320",
      device: { estado: false },
    },
    {
      id: "S1",
      tipo: "SENSOR",
      nome: "Temperatura",
      device: { valor: 23 },
    },
  ]);

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });

  resources.atualizar("GROW", "S1", {
    global_id: "TEMP_GROW",
  });

  const notificacoes = [];
  const app = Fastify();

  await app.register(resourcesRoutes, {
    db,
    permitirComandos,
    enviarComando,
    monitor: {
      receberSnapshot() {},
      receberEvento(id) {
        notificacoes.push(id);
      },
    },
  });

  await app.ready();

  return {
    db,
    app,
    nodes,
    resources,
    notificacoes,
    async fechar() {
      await app.close();
      db.close();
    },
  };
}

test("Full usa POST /api/setRecurso", async () => {
  const chamadas = [];

  const resposta = await enviarComandoRele({
    deviceId: "GROW",
    recursoId: "R1",
    api: "Full",
    comando: "ON",
    fetchImpl: async (url, options) => {
      chamadas.push({ url, options });

      return {
        ok: true,
        json: async () => respostaRele("R1", true),
      };
    },
  });

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, "http://grow.etomada/api/setRecurso");
  assert.equal(chamadas[0].options.method, "POST");
  assert.deepEqual(JSON.parse(chamadas[0].options.body), {
    id: "R1",
    estado: "ON",
  });
  assert.equal(resposta.recurso.device.estado, true);
});

test("Lite usa GET /api/setRele", async () => {
  const chamadas = [];

  await enviarComandoRele({
    deviceId: "SW6JANTAR",
    recursoId: "R2",
    api: "Lite",
    comando: "OFF",
    fetchImpl: async (url, options) => {
      chamadas.push({ url, options });

      return {
        ok: true,
        json: async () => respostaRele("R2", false),
      };
    },
  });

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].options.method, "GET");
  assert.equal(
    chamadas[0].url,
    "http://sw6jantar.etomada/api/setRele?id=R2&estado=OFF",
  );
});

test("comando confirmado atualiza estado central", async () => {
  const c = await preparar({
    enviarComando: async () => respostaRele("R1", true),
  });

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "ON" },
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().confirmed, true);

    const recurso = c.resources.buscarGlobal("LUZ_GROW");

    assert.deepEqual(JSON.parse(recurso.reported_json), {
      estado: true,
    });

    assert.deepEqual(c.notificacoes, ["GROW", "GROW"]);
  } finally {
    await c.fechar();
  }
});

test("resposta HTTP 200 sem confirmação não é sucesso", async () => {
  const c = await preparar({
    enviarComando: async () => ({
      msg: "Recurso invalido",
      duracao_ms: 5,
    }),
  });

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "ON" },
    });

    assert.equal(resposta.statusCode, 502);
    assert.equal(resposta.json().code, "NO_CONFIRMATION");

    assert.deepEqual(
      JSON.parse(c.resources.buscarGlobal("LUZ_GROW").reported_json),
      { estado: false },
    );
  } finally {
    await c.fechar();
  }
});

test("estado diferente do solicitado gera erro", async () => {
  const c = await preparar({
    enviarComando: async () => respostaRele("R1", false),
  });

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "ON" },
    });

    assert.equal(resposta.statusCode, 409);
    assert.equal(resposta.json().code, "STATE_MISMATCH");
  } finally {
    await c.fechar();
  }
});

test("DEV bloqueia comandos físicos", async () => {
  let chamadas = 0;

  const c = await preparar({
    permitirComandos: false,
    enviarComando: async () => {
      chamadas++;
      return respostaRele("R1", true);
    },
  });

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "ON" },
    });

    assert.equal(resposta.statusCode, 403);
    assert.equal(resposta.json().code, "COMMANDS_DISABLED");
    assert.equal(chamadas, 0);
  } finally {
    await c.fechar();
  }
});

test("sensores não aceitam comandos de relé", async () => {
  const c = await preparar({
    enviarComando: async () => {
      throw new Error("Não deveria ser chamado");
    },
  });

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/resources/TEMP_GROW/commands",
      payload: { command: "ON" },
    });

    assert.equal(resposta.statusCode, 422);
    assert.equal(resposta.json().code, "UNSUPPORTED_RESOURCE");
  } finally {
    await c.fechar();
  }
});

test("dois comandos simultâneos ao mesmo recurso são bloqueados", async () => {
  let liberar;
  let iniciou;

  const aguardandoInicio = new Promise((resolve) => {
    iniciou = resolve;
  });

  const aguardandoResposta = new Promise((resolve) => {
    liberar = resolve;
  });

  const c = await preparar({
    enviarComando: async () => {
      iniciou();
      await aguardandoResposta;
      return respostaRele("R1", true);
    },
  });

  try {
    const primeiro = c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "ON" },
    });

    await aguardandoInicio;

    const segundo = await c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_GROW/commands",
      payload: { command: "OFF" },
    });

    assert.equal(segundo.statusCode, 409);
    assert.equal(segundo.json().code, "COMMAND_IN_PROGRESS");

    liberar();

    const resultado = await primeiro;
    assert.equal(resultado.statusCode, 200);
  } finally {
    liberar();
    await c.fechar();
  }
});

test("Full envia comandos agrupados em um POST JSON", async () => {
  const chamadas = [];

  await enviarComandosLote({
    deviceId: "DEV02",
    api: "Full",
    recursos: [
      { id: "R1", estado: "ON" },
      { id: "R2", estado: "OFF" },
    ],
    fetchImpl: async (url, options) => {
      chamadas.push({ url, options });
      return {
        ok: true,
        json: async () => ({ ok: true, resultados: [] }),
      };
    },
  });

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, "http://dev02.etomada/api/setRecurso");
  assert.equal(chamadas[0].options.method, "POST");
  assert.deepEqual(JSON.parse(chamadas[0].options.body), {
    recursos: [
      { id: "R1", estado: "ON" },
      { id: "R2", estado: "OFF" },
    ],
  });
});

test("Lite envia comandos agrupados em uma string GET", async () => {
  const chamadas = [];

  await enviarComandosLote({
    deviceId: "DEV",
    api: "Lite",
    recursos: [
      { id: "R1", estado: "ON" },
      { id: "R2", estado: "OFF" },
    ],
    fetchImpl: async (url, options) => {
      chamadas.push({ url, options });
      return {
        ok: true,
        json: async () => ({ ok: true, resultados: [] }),
      };
    },
  });

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].options.method, "GET");
  assert.equal(
    chamadas[0].url,
    "http://dev.etomada/api/setReles?estados=R1%3AON-R2%3AOFF",
  );
});
