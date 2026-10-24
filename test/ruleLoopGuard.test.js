import test from "node:test";
import assert from "node:assert/strict";
import { criarRuleLoopGuard } from "../src/services/ruleLoopGuard.js";

test("bloqueia após 8 comandos e libera após 30 segundos", () => {
  let tempo = 1000;

  const guard = criarRuleLoopGuard({
    agora: () => tempo,
  });

  for (let i = 0; i < 8; i++) {
    assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, true);
  }

  const bloqueado = guard.permitir(["SW6FRI/R2"]);

  assert.deepEqual(bloqueado, {
    permitido: false,
    novoBloqueio: true,
    chave: "SW6FRI/R2",
  });

  assert.equal(guard.permitir(["SW6FRI/R2"]).novoBloqueio, false);

  tempo += 30001;

  assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, true);
});

test("limite de um relé não bloqueia os demais", () => {
  let tempo = 0;

  const guard = criarRuleLoopGuard({
    maxAcoes: 1,
    agora: () => tempo,
  });

  assert.equal(guard.permitir(["SW6FRI/R1"]).permitido, true);

  assert.equal(guard.permitir(["SW6FRI/R1"]).permitido, false);

  assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, true);
});

test("TOGGLEF reserva os dois relés atomicamente", () => {
  const guard = criarRuleLoopGuard({
    maxAcoes: 1,
    agora: () => 1000,
  });

  guard.permitir(["SW6FRI/R1"]);

  // R1 está no limite. A operação conjunta é rejeitada.
  assert.equal(guard.permitir(["SW6FRI/R2", "SW6FRI/R1"]).permitido, false);

  // R2 não deve ter consumido sua autorização.
  assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, true);
});

test("o limite acompanha o recurso físico", () => {
  const guard = criarRuleLoopGuard({
    maxAcoes: 1,
    agora: () => 1000,
  });

  assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, true);

  assert.equal(guard.permitir(["GROW/R2"]).permitido, true);

  assert.equal(guard.permitir(["SW6FRI/R2"]).permitido, false);
});
