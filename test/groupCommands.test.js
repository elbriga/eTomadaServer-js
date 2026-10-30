import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { criarGroupService } from "../src/services/groupService.js";
import { criarResourceService } from "../src/services/resourceService.js";
import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarGroupRepository } from "../src/repositories/groupRepository.js";
import groupsRoutes from "../src/routes/groups.js";
import resourcesRoutes from "../src/routes/resources.js";

const rele = (id) => ({
  device_id: "SW6FRI",
  recurso_id: `R${id}`,
  global_id: `LUZ_${id}`,
  tipo: "RELE",
});

function grupo(recursos) {
  return {
    buscar(id) {
      return id === "TESTE" ? { group_id: "TESTE", recursos } : null;
    },
  };
}

// Simula os resultados individuais de um lote sem usar HTTP.
function simularComandos(executar) {
  return {
    executarLote(membros, comando) {
      return Promise.allSettled(
        membros.map((recurso) =>
          executar(recurso.global_id, comando, {
            device_id: recurso.device_id,
            recurso_id: recurso.recurso_id,
          }),
        ),
      );
    },
  };
}

test("comando coletivo confirma relés e ignora sensores", async () => {
  const chamados = [];

  const service = criarGroupService({
    groups: grupo([rele(1), { ...rele(2), tipo: "SENSOR" }, rele(3)]),
    comandos: simularComandos(async (id, command, esperado) => {
      chamados.push({ id, command, esperado });
      return {
        command_id: chamados.length,
        estado: false,
      };
    }),
    permitirComandos: true,
  });

  const resultado = await service.executar("TESTE", "OFF");

  assert.equal(resultado.ok, true);
  assert.equal(resultado.summary.total, 3);
  assert.equal(resultado.summary.confirmed, 2);
  assert.equal(resultado.summary.skipped, 1);
  assert.equal(chamados.length, 2);

  assert.deepEqual(chamados[0].esperado, {
    device_id: "SW6FRI",
    recurso_id: "R1",
  });
});

test("falha e timeout não interrompem os outros recursos", async () => {
  const service = criarGroupService({
    groups: grupo([rele(1), rele(2), rele(3)]),
    comandos: simularComandos(async (id, command, esperado) => {
      if (id === "LUZ_2") {
        throw Object.assign(new Error("Timeout"), {
          code: "TIMEOUT",
          command_id: 20,
          execution_status: "uncertain",
        });
      }

      if (id === "LUZ_3") {
        throw Object.assign(new Error("Estado divergente"), {
          code: "STATE_MISMATCH",
          command_id: 21,
          execution_status: "mismatch",
        });
      }

      return { command_id: 19, estado: true };
    }),
    permitirComandos: true,
  });

  const r = await service.executar("TESTE", "ON");

  assert.equal(r.ok, false);
  assert.equal(r.summary.confirmed, 1);
  assert.equal(r.summary.uncertain, 1);
  assert.equal(r.summary.failed, 1);

  assert.equal(r.results[0].status, "confirmed");
  assert.equal(r.results[1].status, "uncertain");
  assert.equal(r.results[2].status, "mismatch");
});

test("limita concorrência e preserva ordem dos resultados", async () => {
  let ativas = 0;
  let maximo = 0;

  const service = criarGroupService({
    groups: grupo(
      Array.from({ length: 8 }, (_, i) => ({
        ...rele(i + 1),
        device_id: `DEV${i + 1}`,
      })),
    ),
    concorrencia: 2,
    permitirComandos: true,
    comandos: simularComandos(async (id, command, esperado) => {
      ativas++;
      maximo = Math.max(maximo, ativas);

      await new Promise((resolve) => setTimeout(resolve, 5));

      ativas--;
      return { command_id: Number(id.slice(4)), estado: true };
    }),
  });

  const r = await service.executar("TESTE", "ON");

  assert.equal(maximo, 2);
  assert.equal(r.summary.confirmed, 8);
  assert.deepEqual(
    r.results.map((item) => item.global_id),
    Array.from({ length: 8 }, (_, i) => `LUZ_${i + 1}`),
  );
});

test("ambiente DEV bloqueia comandos coletivos", async () => {
  let chamadas = 0;

  const service = criarGroupService({
    groups: grupo([rele(1)]),
    permitirComandos: false,
    comandos: {
      executar() {
        chamadas++;
      },
    },
  });

  await assert.rejects(() => service.executar("TESTE", "OFF"), {
    code: "COMMANDS_DISABLED",
  });

  assert.equal(chamadas, 0);
});

async function prepararHttp(
  enviarComando,
  enviarLote = async ({ recursos }) => ({
    resultados: await Promise.all(
      recursos.map(async ({ id, estado }) => {
        const resposta = await enviarComando({
          recursoId: id,
          comando: estado,
        });
        return {
          id,
          ok: true,
          recurso: resposta.recurso,
        };
      }),
    ),
    duracao_ms: 5,
  }),
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const groups = criarGroupRepository(db);

  nodes.criar({ device_id: "SW6FRI" });
  nodes.salvarSnapshot("SW6FRI", {
    device_id: "SW6FRI",
    api: "Lite",
  });

  resources.descobrir("SW6FRI", [
    {
      id: "R1",
      tipo: "RELE",
      device: { estado: false },
    },
  ]);
  resources.atualizar("SW6FRI", "R1", {
    global_id: "LUZ_ESCADA_TRI",
  });

  groups.criar({ group_id: "TESTE" });
  groups.adicionarRecurso("TESTE", "LUZ_ESCADA_TRI");

  const monitor = {
    receberEvento() {
      return true;
    },
    receberSnapshot() {
      return true;
    },
  };

  const app = Fastify();

  const comandos = criarResourceService({
    db,
    monitor,
    log: app.log,
    permitirComandos: true,
    enviarComando,
    enviarLote,
  });

  await app.register(resourcesRoutes, {
    db,
    monitor,
    comandos,
  });

  await app.register(groupsRoutes, {
    db,
    comandos,
    permitirComandos: true,
  });

  await app.ready();

  return {
    db,
    app,
    async fechar() {
      await app.close();
      db.close();
    },
  };
}

function respostaRele(estado) {
  return {
    msg: "OK",
    duracao_ms: 5,
    recurso: {
      id: "R1",
      tipo: "RELE",
      device: { estado },
    },
  };
}

test("API coletiva registra comando individual no SQLite", async () => {
  const c = await prepararHttp(async () => respostaRele(false));

  try {
    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/groups/TESTE/commands",
      payload: { command: "OFF" },
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().ok, true);

    const item = resposta.json().results[0];
    assert.equal(item.status, "confirmed");
    assert.ok(item.command_id > 0);

    const registrado = c.db
      .prepare(
        `
      SELECT status, command, global_id
      FROM resource_commands WHERE id = ?
    `,
      )
      .get(item.command_id);

    assert.equal(registrado.status, "confirmed");
    assert.equal(registrado.command, "OFF");
    assert.equal(registrado.global_id, "LUZ_ESCADA_TRI");
  } finally {
    await c.fechar();
  }
});

test("comando individual e coletivo compartilham o bloqueio", async () => {
  let avisarInicio;
  let liberar;

  const iniciou = new Promise((resolve) => {
    avisarInicio = resolve;
  });
  const aguardando = new Promise((resolve) => {
    liberar = resolve;
  });

  const c = await prepararHttp(async () => {
    avisarInicio();
    await aguardando;
    return respostaRele(true);
  });

  try {
    const individual = c.app.inject({
      method: "POST",
      url: "/api/resources/LUZ_ESCADA_TRI/commands",
      payload: { command: "ON" },
    });

    await iniciou;

    const coletivo = await c.app.inject({
      method: "POST",
      url: "/api/groups/TESTE/commands",
      payload: { command: "OFF" },
    });

    const resultado = coletivo.json();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.summary.failed, 1);
    assert.equal(resultado.results[0].code, "COMMAND_IN_PROGRESS");

    liberar();

    const confirmado = await individual;
    assert.equal(confirmado.statusCode, 200);
  } finally {
    liberar();
    await c.fechar();
  }
});

test("lote por nodo mantém histórico e falha parcial", async () => {
  const chamadas = [];

  const c = await prepararHttp(
    async () => respostaRele(false),
    async ({ deviceId, api, recursos }) => {
      chamadas.push({ deviceId, api, recursos });

      return {
        duracao_ms: 8,
        resultados: recursos.map(({ id }) => ({
          id,
          ok: id !== "R2",
          msg: id === "R2" ? "Falha no relé" : "OK",
          recurso: {
            id,
            tipo: "RELE",
            device: { estado: false },
          },
        })),
      };
    },
  );

  try {
    const resources = criarResourceRepository(c.db);
    const groups = criarGroupRepository(c.db);

    resources.descobrir("SW6FRI", [
      {
        id: "R2",
        tipo: "RELE",
        device: { estado: false },
      },
    ]);

    resources.atualizar("SW6FRI", "R2", {
      global_id: "LUZ_TESTE_2",
    });

    groups.adicionarRecurso("TESTE", "LUZ_TESTE_2");

    const resposta = await c.app.inject({
      method: "POST",
      url: "/api/groups/TESTE/commands",
      payload: { command: "OFF" },
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].deviceId, "SW6FRI");
    assert.equal(chamadas[0].api, "Lite");
    assert.equal(chamadas[0].recursos.length, 2);

    const resultado = resposta.json();

    assert.equal(resultado.ok, false);
    assert.equal(resultado.summary.attempted, 2);
    assert.equal(resultado.summary.confirmed, 1);
    assert.equal(resultado.summary.uncertain, 1);

    const registros = c.db
      .prepare(
        `
      SELECT recurso_id, command, status
      FROM resource_commands
      ORDER BY recurso_id
    `,
      )
      .all();

    assert.deepEqual(registros, [
      { recurso_id: "R1", command: "OFF", status: "confirmed" },
      { recurso_id: "R2", command: "OFF", status: "uncertain" },
    ]);
  } finally {
    await c.fechar();
  }
});
