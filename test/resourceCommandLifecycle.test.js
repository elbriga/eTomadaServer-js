import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarCommandRepository } from "../src/repositories/commandRepository.js";
import { NodeClientError } from "../src/devices/nodeClient.js";
import resourcesRoutes from "../src/routes/resources.js";
import eventsRoutes from "../src/routes/events.js";

function respostaRele(estado) {
  return {
    msg: "OK",
    duracao_ms: 10,
    recurso: {
      id: "R1",
      tipo: "RELE",
      device: { estado },
    },
  };
}

async function preparar(enviarComando) {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const commands = criarCommandRepository(db);

  nodes.criar({ device_id: "SW6FRI" });
  nodes.salvarSnapshot("SW6FRI", {
    device_id: "SW6FRI",
    api: "Lite",
  });

  resources.descobrir("SW6FRI", [
    {
      id: "R1",
      nome: "Relé 1",
      tipo: "RELE",
      device: { estado: false },
    },
  ]);

  resources.atualizar("SW6FRI", "R1", {
    global_id: "LUZ_ESCADA_TRI",
  });

  const monitor = {
    receberEvento() {
      return true;
    },
    receberSnapshot() {
      return true;
    },
  };

  const app = Fastify();

  await app.register(resourcesRoutes, {
    db,
    monitor,
    permitirComandos: true,
    enviarComando,
  });

  await app.register(eventsRoutes, { db, monitor });
  await app.ready();

  async function executar(command = "ON") {
    return app.inject({
      method: "POST",
      url: "/api/resources/LUZ_ESCADA_TRI/commands",
      payload: { command },
    });
  }

  return {
    app,
    db,
    nodes,
    resources,
    commands,
    executar,
    async fechar() {
      await app.close();
      db.close();
    },
  };
}

test("registra pending antes de enviar o comando", async () => {
  let liberar;
  let avisarInicio;

  const iniciou = new Promise((resolve) => {
    avisarInicio = resolve;
  });
  const aguardando = new Promise((resolve) => {
    liberar = resolve;
  });

  const c = await preparar(async () => {
    avisarInicio();
    await aguardando;
    return respostaRele(true);
  });

  try {
    const chamada = c.executar().then((r) => r);
    await iniciou;

    const pendente = c.commands.ultimo("SW6FRI", "R1");

    assert.equal(pendente.command, "ON");
    assert.equal(pendente.desired_state, true);
    assert.equal(pendente.status, "pending");

    liberar();

    const resposta = await chamada;

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().command_id, pendente.id);

    const final = c.commands.buscar(pendente.id);

    assert.equal(final.status, "confirmed");
    assert.equal(final.observed_state, true);
    assert.equal(final.confirmed_via, "response");
  } finally {
    liberar();
    await c.fechar();
  }
});

test("timeout preserva intenção sem reenviar o comando", async () => {
  let tentativas = 0;

  const c = await preparar(async () => {
    tentativas++;
    throw new NodeClientError("Timeout", "TIMEOUT", 504);
  });

  try {
    const resposta = await c.executar();

    assert.equal(resposta.statusCode, 504);
    assert.equal(resposta.json().status, "uncertain");
    assert.equal(tentativas, 1);

    const registro = c.commands.buscar(resposta.json().command_id);
    assert.equal(registro.error_code, "TIMEOUT");

    const estado = await c.app.inject({
      method: "GET",
      url: "/api/resources/LUZ_ESCADA_TRI/state",
    });

    assert.equal(estado.json().desired.estado, true);
    assert.equal(estado.json().reported.estado, false);
  } finally {
    await c.fechar();
  }
});

test("evento posterior confirma estado de comando incerto", async () => {
  const c = await preparar(async () => {
    throw new NodeClientError("Timeout", "TIMEOUT", 504);
  });

  try {
    const resposta = await c.executar();
    const id = resposta.json().command_id;

    // Estado divergente não confirma a operação.
    await c.app.inject({
      method: "POST",
      url: "/api/evento",
      payload: {
        origem: "SW6FRI",
        id: "R1",
        evento: "ESTADO",
        device: { estado: 0 },
      },
    });

    assert.equal(c.commands.buscar(id).status, "uncertain");

    // Observação posterior do estado desejado.
    const evento = await c.app.inject({
      method: "POST",
      url: "/api/evento",
      payload: {
        origem: "SW6FRI",
        id: "R1",
        evento: "ESTADO",
        device: { estado: 1 },
      },
    });

    assert.equal(evento.statusCode, 200);
    assert.equal(c.commands.buscar(id).status, "confirmed");
    assert.equal(c.commands.buscar(id).confirmed_via, "event");

    const estado = await c.app.inject({
      method: "GET",
      url: "/api/resources/LUZ_ESCADA_TRI/state",
    });

    assert.equal(estado.json().desired, null);
    assert.equal(estado.json().reported.estado, true);
  } finally {
    await c.fechar();
  }
});

test("snapshot de boot também reconcilia comando incerto", async () => {
  const c = await preparar(async () => {
    throw new NodeClientError("Timeout", "TIMEOUT", 504);
  });

  try {
    const resposta = await c.executar();
    const id = resposta.json().command_id;

    const snapshot = await c.app.inject({
      method: "POST",
      url: "/api/snapshot",
      payload: {
        device_id: "SW6FRI",
        recursos: [
          {
            id: "R1",
            nome: "Relé 1",
            tipo: "RELE",
            device: { estado: true },
          },
        ],
      },
    });

    assert.equal(snapshot.statusCode, 200);
    assert.equal(c.commands.buscar(id).status, "confirmed");
    assert.equal(c.commands.buscar(id).confirmed_via, "push");
  } finally {
    await c.fechar();
  }
});

test("resposta divergente registra mismatch", async () => {
  const c = await preparar(async () => respostaRele(false));

  try {
    const resposta = await c.executar("ON");

    assert.equal(resposta.statusCode, 409);
    assert.equal(resposta.json().code, "STATE_MISMATCH");
    assert.equal(resposta.json().status, "mismatch");

    const registro = c.commands.buscar(resposta.json().command_id);

    assert.equal(registro.desired_state, true);
    assert.equal(registro.observed_state, false);
    assert.equal(registro.status, "mismatch");
  } finally {
    await c.fechar();
  }
});

test("comando posterior não reconcilia uma intenção antiga", async () => {
  let tentativa = 0;

  const c = await preparar(async () => {
    tentativa++;

    if (tentativa === 1) throw new NodeClientError("Timeout", "TIMEOUT", 504);

    return respostaRele(false);
  });

  try {
    const primeiro = await c.executar("ON");
    const segundo = await c.executar("OFF");

    assert.equal(segundo.statusCode, 200);

    await c.app.inject({
      method: "POST",
      url: "/api/evento",
      payload: {
        origem: "SW6FRI",
        id: "R1",
        evento: "ESTADO",
        device: { estado: 1 },
      },
    });

    assert.equal(
      c.commands.buscar(primeiro.json().command_id).status,
      "uncertain",
    );

    assert.equal(
      c.commands.buscar(segundo.json().command_id).status,
      "confirmed",
    );
  } finally {
    await c.fechar();
  }
});

test("restart transforma comandos pendentes em incertos", async () => {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  try {
    const commands = criarCommandRepository(db);

    const registro = commands.iniciar({
      device_id: "SW6FRI",
      recurso_id: "R1",
      global_id: "LUZ_ESCADA_TRI",
      command: "ON",
    });

    assert.equal(commands.encerrarPendentes(), 1);

    const recuperado = commands.buscar(registro.id);

    assert.equal(recuperado.status, "uncertain");
    assert.equal(recuperado.error_code, "SERVER_RESTART");
  } finally {
    db.close();
  }
});
