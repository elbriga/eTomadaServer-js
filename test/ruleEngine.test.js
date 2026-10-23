import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";
import { criarRuleRepository } from "../src/repositories/ruleRepository.js";
import { criarRuleEngine } from "../src/services/ruleEngine.js";
import eventsRoutes from "../src/routes/events.js";

function preparar() {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);

  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const rules = criarRuleRepository(db);

  nodes.criar({ device_id: "GROW" });

  resources.descobrir("GROW", [
    { id: "B1", tipo: "BOTAO", nome: "Botão" },
    {
      id: "S1",
      tipo: "SENSOR",
      nome: "Temperatura",
      device: { valor: 25 },
    },
    { id: "R1", tipo: "RELE", nome: "Luz" },
  ]);

  resources.atualizar("GROW", "B1", {
    global_id: "BOTAO_GROW",
  });

  resources.atualizar("GROW", "S1", {
    global_id: "TEMP_GROW",
  });

  resources.atualizar("GROW", "R1", {
    global_id: "LUZ_GROW",
  });

  rules.criar({
    nome: "Teste evento com check",
    ativa: true,
    escopo: "GLOBAL",
    device_id: null,
    quando: {
      tipo: "EVENTO",
      recurso: "BOTAO_GROW",
      evento: "CLICK",
      check: {
        variavel: "TEMP_GROW",
        operacao: ">",
        valor: 20,
      },
    },
    acao: {
      tipo: "ESTADO",
      recurso: "LUZ_GROW",
      comando: "ON",
    },
  });

  return { db, rules };
}

const evento = {
  origem: "GROW",
  id: "B1",
  evento: "CLICK",
  device: {},
};

test("evento físico dispara regra global", async () => {
  const { db } = preparar();

  try {
    const logs = [];

    const engine = criarRuleEngine({
      db,
      log: {
        info: (dados, mensagem) => logs.push({ dados, mensagem }),
      },
    });

    const acoes = await engine.processarEvento(evento);

    assert.equal(acoes.length, 1);
    assert.equal(acoes[0].regra_id, 1);
    assert.equal(acoes[0].acao.recurso, "LUZ_GROW");
    assert.equal(acoes[0].acao.comando, "ON");

    assert.equal(logs.length, 1);
    assert.match(logs[0].mensagem, /SIMULACAO/);
  } finally {
    db.close();
  }
});

test("evento sem global_id não dispara regra", async () => {
  const { db } = preparar();

  try {
    const engine = criarRuleEngine({
      db,
      log: { info() {} },
    });

    assert.deepEqual(
      await engine.processarEvento({
        ...evento,
        id: "NAO_EXISTE",
      }),
      [],
    );
  } finally {
    db.close();
  }
});

test("check falso impede disparo", async () => {
  const { db } = preparar();

  try {
    const resources = criarResourceRepository(db);
    resources.aplicarEvento("GROW", "S1", {
      valor: 15,
    });

    const engine = criarRuleEngine({
      db,
      log: { info() {} },
    });

    assert.deepEqual(await engine.processarEvento(evento), []);
  } finally {
    db.close();
  }
});

test("POST /api/evento mantém persistência e aciona simulação", async () => {
  const { db } = preparar();
  const app = Fastify();

  const logs = [];
  const engine = criarRuleEngine({
    db,
    log: {
      info: (dados, mensagem) => logs.push({ dados, mensagem }),
    },
  });

  try {
    await app.register(eventsRoutes, {
      db,
      monitor: { receberEvento() {} },
      ruleEngine: engine,
    });

    await app.ready();

    const resposta = await app.inject({
      method: "POST",
      url: "/api/evento",
      payload: evento,
    });

    assert.equal(resposta.statusCode, 200);
    assert.equal(resposta.json().ok, true);

    // Aguarda o processamento agendado com setImmediate.
    await new Promise((resolve) => setImmediate(resolve));

    const salvo = db
      .prepare(
        `
      SELECT device_id, recurso_id, evento
      FROM events
    `,
      )
      .get();

    assert.equal(salvo.device_id, "GROW");
    assert.equal(salvo.recurso_id, "B1");
    assert.equal(salvo.evento, "CLICK");

    assert.equal(logs.length, 1);
    assert.equal(logs[0].dados.regra_id, 1);
  } finally {
    await app.close();
    db.close();
  }
});

test("executa todas as regras globais do evento", async () => {
  const { db, rules } = preparar();
  const chamadas = [];

  try {
    // Segunda regra para o mesmo evento.
    rules.criar({
      nome: "Segunda regra",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "BOTAO_GROW",
        evento: "CLICK",
      },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "OFF",
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      comandos: {
        async executar(recurso, comando) {
          chamadas.push({ recurso, comando });
          return { command_id: chamadas.length };
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const acoes = await engine.processarEvento(evento);

    assert.equal(acoes.length, 2);
    assert.deepEqual(chamadas, [
      { recurso: "LUZ_GROW", comando: "ON" },
      { recurso: "LUZ_GROW", comando: "OFF" },
    ]);
  } finally {
    db.close();
  }
});

test("horário: simula ou executa todas as regras", async () => {
  const { db, rules } = preparar();
  const chamadas = [];

  try {
    for (const comando of ["ON", "OFF"]) {
      rules.criar({
        nome: `Horário ${comando}`,
        ativa: true,
        escopo: "GLOBAL",
        device_id: null,
        quando: {
          tipo: "HORARIO",
          hora: 4,
          minuto: 0,
        },
        acao: {
          tipo: "ESTADO",
          recurso: "LUZ_GROW",
          comando,
        },
      });
    }

    const configuracao = {
      db,
      comandos: {
        async executar(recurso, comando) {
          chamadas.push({ recurso, comando });
          return { command_id: chamadas.length };
        },
      },
      log: { info() {}, warn() {}, error() {} },
    };

    const simulado = criarRuleEngine({
      ...configuracao,
      modo: "simulate",
    });

    const horario = { hora: 4, minuto: 0 };

    assert.equal((await simulado.processarHorario(horario)).length, 2);
    assert.equal(chamadas.length, 0);

    const executor = criarRuleEngine({
      ...configuracao,
      modo: "execute",
    });

    assert.equal((await executor.processarHorario(horario)).length, 2);

    assert.deepEqual(chamadas, [
      { recurso: "LUZ_GROW", comando: "ON" },
      { recurso: "LUZ_GROW", comando: "OFF" },
    ]);
  } finally {
    db.close();
  }
});

test("boot: simula divergência sem executar comandos", () => {
  const { db, rules } = preparar();
  const logs = [];
  const chamadas = [];

  try {
    const criarHorario = (hora, comando) =>
      rules.criar({
        nome: `Teste ${hora} ${comando}`,
        ativa: true,
        escopo: "GLOBAL",
        device_id: null,
        quando: {
          tipo: "HORARIO",
          hora,
          minuto: 0,
        },
        acao: {
          tipo: "ESTADO",
          recurso: "LUZ_GROW",
          comando,
        },
      });

    criarHorario(4, "ON");
    criarHorario(23, "OFF");

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      regraId: 1,
      alvoId: "LUZ_GROW",
      comandos: {
        async executar(...args) {
          chamadas.push(args);
        },
      },
      log: {
        info: (dados, mensagem) => logs.push({ dados, mensagem }),
        warn() {},
        error() {},
      },
    });

    const snapshot = (estado) => ({
      device_id: "GROW",
      recursos: [
        {
          id: "R1",
          tipo: "RELE",
          device: { estado },
        },
      ],
    });

    // 05:00 UTC = 02:00 em São Paulo.
    const instante = new Date("2026-10-23T05:00:00Z");

    const divergente = engine.simularBoot("GROW", snapshot(1), instante);

    assert.equal(divergente.length, 1);
    assert.equal(divergente[0].esperado, 0);
    assert.equal(divergente[0].observado, 1);
    assert.equal(divergente[0].situacao, "DIVERGENTE");

    const correto = engine.simularBoot("GROW", snapshot(0), instante);

    assert.equal(correto[0].situacao, "OK");

    // Mesmo em execute, boot não envia comandos.
    assert.deepEqual(chamadas, []);

    assert.match(logs[0].mensagem, /BOOT.*SIMULACAO/);
  } finally {
    db.close();
  }
});

test("boot: restaura divergências sem filtro de regra", async () => {
  const { db, rules } = preparar();
  const chamadas = [];

  try {
    const criarHorario = (hora, comando) =>
      rules.criar({
        nome: `Boot ${hora} ${comando}`,
        ativa: true,
        escopo: "GLOBAL",
        device_id: null,
        quando: { tipo: "HORARIO", hora, minuto: 0 },
        acao: {
          tipo: "ESTADO",
          recurso: "LUZ_GROW",
          comando,
        },
      });

    criarHorario(4, "ON");
    const off = criarHorario(23, "OFF");

    const log = {
      info() {},
      warn() {},
      error() {},
    };

    const comandos = {
      async executar(globalId, comando, esperado) {
        chamadas.push({ globalId, comando, esperado });
        return { command_id: 123 };
      },
    };

    const engine = criarRuleEngine({
      db,
      log,
      comandos,
      modo: "execute",
    });

    const snapshot = (estado) => ({
      device_id: "GROW",
      uptime: 1500,
      recursos: [
        {
          id: "R1",
          tipo: "RELE",
          device: { estado },
        },
      ],
    });

    // 02:00 em São Paulo: última regra foi OFF às 23:00.
    const instante = new Date("2026-10-23T05:00:00Z");

    const resultado = await engine.reconciliarBoot(
      "GROW",
      snapshot(1),
      instante,
    );

    assert.equal(resultado[0].situacao, "DIVERGENTE");

    assert.deepEqual(chamadas, [
      {
        globalId: "LUZ_GROW",
        comando: "OFF",
        esperado: {
          device_id: "GROW",
          recurso_id: "R1",
        },
      },
    ]);

    // Estado já correto: não repete o comando.
    await engine.reconciliarBoot("GROW", snapshot(0), instante);

    assert.equal(chamadas.length, 1);
  } finally {
    db.close();
  }
});

test("TOGGLE alterna estado confirmado do destino", async () => {
  const { db, rules } = preparar();
  const resources = criarResourceRepository(db);
  const chamadas = [];

  try {
    resources.aplicarEvento("GROW", "R1", { estado: false });

    rules.criar({
      nome: "Teste TOGGLE",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "BOTAO_GROW",
        evento: "DUPCLICK",
      },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "TOGGLE",
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      log: { info() {}, warn() {}, error() {} },
      comandos: {
        async executar(recurso, comando) {
          chamadas.push(comando);
          resources.aplicarEvento("GROW", "R1", {
            estado: comando === "ON",
          });
          return { command_id: chamadas.length };
        },
      },
    });

    const duploClique = {
      ...evento,
      evento: "DUPCLICK",
    };

    await engine.processarEvento(duploClique);
    await engine.processarEvento(duploClique);

    assert.deepEqual(chamadas, ["ON", "OFF"]);
  } finally {
    db.close();
  }
});

test("FOLLOW usa o estado recebido no evento", async () => {
  const { db, rules } = preparar();
  const chamadas = [];

  try {
    rules.criar({
      nome: "Teste FOLLOW",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "BOTAO_GROW",
        evento: "DUPCLICK",
      },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "FOLLOW",
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      log: { info() {}, warn() {}, error() {} },
      comandos: {
        async executar(recurso, comando) {
          chamadas.push({ recurso, comando });
          return { command_id: chamadas.length };
        },
      },
    });

    await engine.processarEvento({
      ...evento,
      evento: "DUPCLICK",
      device: { estado: 1 },
    });

    await engine.processarEvento({
      ...evento,
      evento: "DUPCLICK",
      device: { estado: 0 },
    });

    assert.deepEqual(chamadas, [
      { recurso: "LUZ_GROW", comando: "ON" },
      { recurso: "LUZ_GROW", comando: "OFF" },
    ]);
  } finally {
    db.close();
  }
});

test("TOGGLE não executa com estado desconhecido", async () => {
  const { db, rules } = preparar();
  const chamadas = [];

  try {
    rules.criar({
      nome: "Teste sem estado",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "BOTAO_GROW",
        evento: "DUPCLICK",
      },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "TOGGLE",
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      log: { info() {}, warn() {}, error() {} },
      comandos: {
        async executar(...args) {
          chamadas.push(args);
        },
      },
    });

    await engine.processarEvento({
      ...evento,
      evento: "DUPCLICK",
    });

    assert.deepEqual(chamadas, []);
  } finally {
    db.close();
  }
});

test("TOGGLEF inverte destino e corrige origem", async () => {
  const { db, rules } = preparar();
  const resources = criarResourceRepository(db);
  const chamadas = [];

  try {
    resources.descobrir("GROW", [
      { id: "R2", tipo: "RELE", nome: "Segundo relé" },
    ]);
    resources.atualizar("GROW", "R2", {
      global_id: "LUZ_TESTE_R2",
    });

    resources.aplicarEvento("GROW", "R1", { estado: false });
    resources.aplicarEvento("GROW", "R2", { estado: false });

    rules.criar({
      nome: "Teste TOGGLEF",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "LUZ_GROW",
        evento: "TOGGLE",
      },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_TESTE_R2",
        comando: "TOGGLEF",
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      log: { info() {}, warn() {}, error() {} },
      comandos: {
        async executar(globalId, comando) {
          chamadas.push({ globalId, comando });

          const recurso = resources.buscarGlobal(globalId);
          resources.aplicarEvento(recurso.device_id, recurso.recurso_id, {
            estado: comando === "ON",
          });

          return { command_id: chamadas.length };
        },
      },
    });

    await engine.processarEvento(
      {
        origem: "GROW",
        id: "R1",
        evento: "TOGGLE",
        device: { estado: 0 },
      },
      1,
    );

    assert.deepEqual(chamadas, [
      { globalId: "LUZ_GROW", comando: "ON" },
      { globalId: "LUZ_TESTE_R2", comando: "ON" },
    ]);

    await engine.parar();
  } finally {
    db.close();
  }
});

test("TIMER executa OFF e permite cancelamento", async () => {
  const { db, rules } = preparar();
  const resources = criarResourceRepository(db);
  const chamadas = [];

  const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    rules.criar({
      nome: "Teste TIMER",
      ativa: true,
      escopo: "GLOBAL",
      device_id: null,
      quando: {
        tipo: "EVENTO",
        recurso: "BOTAO_GROW",
        evento: "DUPCLICK",
      },
      acao: {
        tipo: "TIMER",
        recurso: "LUZ_GROW",
        timer: 1,
      },
    });

    const engine = criarRuleEngine({
      db,
      modo: "execute",
      log: { info() {}, warn() {}, error() {} },
      comandos: {
        async executar(globalId, comando) {
          chamadas.push(comando);
          resources.aplicarEvento("GROW", "R1", {
            estado: comando === "ON",
          });
          return { command_id: chamadas.length };
        },
      },
    });

    const disparar = () =>
      engine.processarEvento({
        origem: "GROW",
        id: "B1",
        evento: "DUPCLICK",
        device: {},
      });

    // Primeiro TIMER > ON seguido de OFF.
    await disparar();
    assert.deepEqual(chamadas, ["ON"]);

    await dormir(1200);
    assert.deepEqual(chamadas, ["ON", "OFF"]);

    // Segundo TIMER > cancelamento antes do vencimento.
    await disparar();
    assert.deepEqual(chamadas, ["ON", "OFF", "ON"]);

    assert.equal(engine.cancelarTimerFisico("GROW", "R1"), true);

    await dormir(1200);
    assert.deepEqual(chamadas, ["ON", "OFF", "ON"]);

    await engine.parar();
  } finally {
    db.close();
  }
});
