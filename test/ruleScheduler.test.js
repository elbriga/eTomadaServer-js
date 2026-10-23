import test from "node:test";
import assert from "node:assert/strict";
import { criarRuleScheduler } from "../src/services/ruleScheduler.js";

const log = {
  info() {},
  warn() {},
  error() {},
};

function criar() {
  const chamadas = [];

  const scheduler = criarRuleScheduler({
    log,
    async processarHorario(horario) {
      chamadas.push(horario);
      return [];
    },
  });

  return { scheduler, chamadas };
}

test("dispara uma vez na virada do minuto", async () => {
  const { scheduler, chamadas } = criar();

  // 06:59:59 UTC = 03:59:59 em São Paulo.
  await scheduler.tick(new Date("2026-10-23T06:59:59Z"));

  // 07:00 UTC = 04:00 em São Paulo.
  await scheduler.tick(new Date("2026-10-23T07:00:00Z"));
  await scheduler.tick(new Date("2026-10-23T07:00:05Z"));

  assert.deepEqual(chamadas, [{ hora: 4, minuto: 0 }]);
});

test("não dispara ao iniciar no meio do minuto", async () => {
  const { scheduler, chamadas } = criar();

  await scheduler.tick(new Date("2026-10-23T07:00:01Z"));
  await scheduler.tick(new Date("2026-10-23T07:00:05Z"));

  assert.equal(chamadas.length, 0);
});

test("não recupera horários atrasados", async () => {
  const { scheduler, chamadas } = criar();

  await scheduler.tick(new Date("2026-10-23T06:59:59Z"));

  // O relógio avança para 04:00:40.
  // A execução deste minuto será ignorada.
  await scheduler.tick(new Date("2026-10-23T07:00:40Z"));

  // Próximo minuto funciona normalmente.
  await scheduler.tick(new Date("2026-10-23T07:01:00Z"));

  assert.deepEqual(chamadas, [{ hora: 4, minuto: 1 }]);
});

test("não repete minuto após relógio voltar", async () => {
  const { scheduler, chamadas } = criar();

  await scheduler.tick(new Date("2026-10-23T06:59:59Z"));
  await scheduler.tick(new Date("2026-10-23T07:00:00Z"));
  await scheduler.tick(new Date("2026-10-23T07:01:00Z"));

  // Correção do relógio para trás.
  await scheduler.tick(new Date("2026-10-23T07:00:01Z"));

  assert.deepEqual(chamadas, [
    { hora: 4, minuto: 0 },
    { hora: 4, minuto: 1 },
  ]);
});

test("não sobrepõe avaliações", async () => {
  let liberar;
  const bloqueio = new Promise((resolve) => {
    liberar = resolve;
  });

  const chamadas = [];

  const scheduler = criarRuleScheduler({
    log,
    async processarHorario(horario) {
      chamadas.push(horario);
      await bloqueio;
      return [];
    },
  });

  await scheduler.tick(new Date("2026-10-23T06:59:59Z"));

  const primeira = scheduler.tick(new Date("2026-10-23T07:00:00Z"));

  // A primeira avaliação ainda está em andamento.
  await scheduler.tick(new Date("2026-10-23T07:01:00Z"));

  liberar();
  await primeira;

  assert.deepEqual(chamadas, [{ hora: 4, minuto: 0 }]);
});
