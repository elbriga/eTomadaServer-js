import test from "node:test";
import assert from "node:assert/strict";

import {
  avaliarRegra,
  avaliarRegrasGlobais,
  calcularEstadosBootGlobais,
} from "../src/services/ruleEvaluator.js";

const criar = (dados = {}) => ({
  id: 1,
  revision: 1,
  ativa: true,
  escopo: "GLOBAL",
  quando: {
    tipo: "EVENTO",
    recurso: "BOTAO_GROW",
    evento: "CLICK",
  },
  acao: {
    tipo: "ESTADO",
    recurso: "LUZ_GROW",
    comando: "ON",
  },
  ...dados,
});

const evento = {
  tipo: "CLICK",
  recurso: "BOTAO_GROW",
};

test("EVENTO: compara tipo e recurso; ignora inativas", () => {
  assert.equal(avaliarRegra(criar(), { ...evento, tipo: "DUPCLICK" }), null);

  assert.equal(avaliarRegra(criar(), { ...evento, recurso: "OUTRO" }), null);

  assert.equal(avaliarRegra(criar({ ativa: false }), evento), null);
});

test("motor global não avalia regras locais", () => {
  const regras = [criar(), criar({ id: 2, escopo: "LOCAL" })];

  const acoes = avaliarRegrasGlobais(regras, evento);

  assert.deepEqual(
    acoes.map((a) => a.regra_id),
    [1],
  );
});

test("HORARIO: exige minuto e tipo de evento exatos", () => {
  const regra = criar({
    quando: { tipo: "HORARIO", hora: 4, minuto: 0 },
  });

  assert.equal(
    avaliarRegra(regra, {
      tipo: "HORARIO",
      hora: 3,
      minuto: 59,
    }),
    null,
  );

  assert.equal(
    avaliarRegra(regra, {
      tipo: "CLICK",
      hora: 4,
      minuto: 0,
    }),
    null,
  );

  assert.equal(
    avaliarRegra(regra, {
      tipo: "HORARIO",
      hora: 4,
      minuto: 0,
    }).regra_id,
    1,
  );
});

test("check: seis operadores de comparação", () => {
  const casos = [
    [">", 10, 10, false],
    ["<", 10, 10, false],
    ["=", 10, 10, true],
    ["!=", 10, 10, false],
    [">=", 10, 10, true],
    ["<=", 10, 10, true],
    [">", 15, 10, true],
    ["<", 5, 10, true],
    ["!=", 15, 10, true],
  ];

  for (const [operacao, valor, limite, esperado] of casos) {
    const regra = criar({
      quando: {
        ...criar().quando,
        check: {
          variavel: "S1",
          operacao,
          valor: limite,
        },
      },
    });

    const resultado = avaliarRegra(regra, evento, {
      S1: valor,
    });

    assert.equal(
      resultado !== null,
      esperado,
      `Falha: ${valor} ${operacao} ${limite}`,
    );
  }
});

test("check: booleanos, HORASSECO e valores ausentes", () => {
  const regraCheck = (variavel, operacao, valor) =>
    criar({
      quando: {
        ...criar().quando,
        check: { variavel, operacao, valor },
      },
    });

  const valores = {
    R1: true,
    HORASSECO: 14,
  };

  assert.ok(avaliarRegra(regraCheck("R1", "=", 1), evento, valores));

  assert.ok(avaliarRegra(regraCheck("HORASSECO", ">", 12), evento, valores));

  assert.equal(
    avaliarRegra(regraCheck("AUSENTE", "<", 10), evento, valores),
    null,
  );
});

test("preserva comandos e TIMER sem modificar a regra", () => {
  const acoes = [
    { tipo: "ESTADO", recurso: "LUZ_GROW", comando: "ON" },
    { tipo: "ESTADO", recurso: "LUZ_GROW", comando: "OFF" },
    { tipo: "ESTADO", recurso: "LUZ_GROW", comando: "TOGGLE" },
    { tipo: "ESTADO", recurso: "LUZ_GROW", comando: "FOLLOW" },
    { tipo: "ESTADO", recurso: "LUZ_GROW", comando: "TOGGLEF" },
    { tipo: "TIMER", recurso: "LUZ_GROW", timer: 90 },
  ];

  for (const acao of acoes) {
    const regra = criar({ acao });
    const plano = avaliarRegra(regra, evento);

    assert.deepEqual(plano, {
      regra_id: 1,
      revision: 1,
      acao,
    });

    assert.notStrictEqual(plano.acao, acao);
  }
});

test("boot: busca circular de 24 horas", () => {
  const regras = [
    criar({
      id: 1,
      quando: { tipo: "HORARIO", hora: 4, minuto: 0 },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "ON",
      },
    }),
    criar({
      id: 2,
      quando: { tipo: "HORARIO", hora: 23, minuto: 0 },
      acao: {
        tipo: "ESTADO",
        recurso: "LUZ_GROW",
        comando: "OFF",
      },
    }),
  ];

  const estado = (hora, minuto) =>
    calcularEstadosBootGlobais(regras, hora, minuto)[0].acao.comando;

  assert.equal(estado(2, 0), "OFF");
  assert.equal(estado(4, 0), "ON");
  assert.equal(estado(22, 30), "ON");
  assert.equal(estado(23, 0), "OFF");
});

test("boot: ignora regras locais, inativas e ações incompatíveis", () => {
  const horario = {
    tipo: "HORARIO",
    hora: 6,
    minuto: 0,
  };

  const acao = {
    tipo: "ESTADO",
    recurso: "LUZ_GROW",
  };

  const regras = [
    criar({
      id: 8,
      quando: horario,
      acao: { ...acao, comando: "OFF" },
    }),
    criar({
      id: 2,
      quando: horario,
      acao: { ...acao, comando: "ON" },
    }),
    criar({
      id: 4,
      escopo: "LOCAL",
      quando: horario,
      acao: { ...acao, comando: "OFF" },
    }),
    criar({
      id: 5,
      ativa: false,
      quando: horario,
      acao: { ...acao, comando: "OFF" },
    }),
    criar({
      id: 6,
      quando: horario,
      acao: { ...acao, comando: "TOGGLE" },
    }),
    criar({
      id: 7,
      quando: horario,
      acao: {
        tipo: "TIMER",
        recurso: "LUZ_GROW",
        timer: 20,
      },
    }),
  ];

  const resultado = calcularEstadosBootGlobais(regras, 7, 0);

  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].regra_id, 2);
  assert.equal(resultado[0].acao.comando, "ON");

  assert.throws(() => calcularEstadosBootGlobais(regras, 24, 0), RangeError);
});
