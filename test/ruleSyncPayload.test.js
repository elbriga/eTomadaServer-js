import test from "node:test";
import assert from "node:assert/strict";

import { montarPacoteRegrasLocais } from "../src/services/ruleSyncPayload.js";

const regra = {
  id: 12,
  nome: "Teste local",
  ativa: true,
  escopo: "LOCAL",
  device_id: "GROW",
  revision: 7,
  quando: {
    tipo: "EVENTO",
    recurso: "B1",
    evento: "CLICK",
  },
  acao: {
    tipo: "ESTADO",
    recurso: "R1",
    comando: "TOGGLE",
  },
};

test("pacote contém somente os campos do Full", () => {
  const pacote = montarPacoteRegrasLocais("GROW", [regra]);

  assert.equal(pacote.device_id, "GROW");
  assert.match(pacote.revision, /^[0-9a-f]{64}$/);
  assert.equal(pacote.regras.length, 1);

  assert.deepEqual(Object.keys(pacote.regras[0]), [
    "id",
    "nome",
    "ativa",
    "quando",
    "acao",
  ]);
});

test("ordem das propriedades não altera a revisão", () => {
  const outro = {
    ...regra,
    revision: 99,
    quando: {
      evento: "CLICK",
      recurso: "B1",
      tipo: "EVENTO",
    },
  };

  const a = montarPacoteRegrasLocais("GROW", [regra]);
  const b = montarPacoteRegrasLocais("grow", [outro]);

  assert.equal(a.revision, b.revision);
});

test("alteração ou exclusão muda a revisão", () => {
  const original = montarPacoteRegrasLocais("GROW", [regra]);

  const alterado = montarPacoteRegrasLocais("GROW", [
    {
      ...regra,
      ativa: false,
    },
  ]);

  const vazio = montarPacoteRegrasLocais("GROW", []);

  assert.notEqual(original.revision, alterado.revision);
  assert.notEqual(original.revision, vazio.revision);
  assert.deepEqual(vazio.regras, []);
});

test("rejeita regras de outros nodos", () => {
  assert.throws(
    () =>
      montarPacoteRegrasLocais("GROW", [
        {
          ...regra,
          device_id: "QUARTO",
        },
      ]),
    TypeError,
  );
});

test("rejeita IDs duplicados", () => {
  assert.throws(
    () => montarPacoteRegrasLocais("GROW", [regra, regra]),
    TypeError,
  );
});
