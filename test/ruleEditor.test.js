import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// DOM mínimo para exercitar abertura, alteração e envio do formulário real.
function elemento() {
  return {
    value: "", checked: false, disabled: false, hidden: false,
    dataset: {}, options: [], eventos: {},
    classList: { toggle() {} },
    addEventListener(tipo, callback) { this.eventos[tipo] = callback; },
    appendChild() {},
    replaceChildren(...filhos) {
      this.options = filhos;
      this.value = filhos[0]?.value ?? "";
    },
    add(opcao) { this.options.push(opcao); },
  };
}

for (const escopo of ["LOCAL", "GLOBAL"]) {
  test(`editor ${escopo} restaura checkbox, envia alterações e limpa nova regra`, async () => {
    const campos = new Map();
    const campo = (nome) => {
      if (!campos.has(nome)) campos.set(nome, elemento());
      return campos.get(nome);
    };
    campo("comando").options = ["ON", "OFF", "TOGGLE", "FOLLOW"].map((value) => ({ value }));
    const container = elemento();
    container.querySelector = (seletor) => campo(seletor.match(/data-ref="(.+)"/)?.[1] ?? seletor);
    let regra = {
      id: 1, nome: "Regra", ativa: true, escopo, revision: 1,
      quando: { tipo: "EVENTO", recurso: escopo === "LOCAL" ? "R1" : "ORIGEM", evento: "TOGGLE" },
      acao: { tipo: "ESTADO", recurso: escopo === "LOCAL" ? "R2" : "DESTINO", comando: "TOGGLE", origemFollow: true },
    };
    const enviados = [];
    const window = {};
    runInNewContext(readFileSync(new URL("../public/static/ruleEditor.js", import.meta.url), "utf8"), {
      window, TextEncoder, confirm: () => true,
      document: { createElement: elemento },
      Option: function (text, value) { return { text, value }; },
      async fetch(url, opcoes = {}) {
        if (opcoes.method === "PUT") {
          const corpo = JSON.parse(opcoes.body);
          enviados.push(corpo);
          regra = { ...regra, ...corpo, revision: regra.revision + 1 };
        }
        const dados = url.includes("resources")
          ? [
              { recurso_id: "R1", global_id: "ORIGEM", tipo: "RELE" },
              { recurso_id: "R2", global_id: "DESTINO", tipo: "RELE" },
            ]
          : opcoes.method === "PUT" ? regra : [regra];
        return { ok: true, status: 200, json: async () => dados };
      },
    });
    const editor = window.criarEditorRegras({ container, escopo, deviceId: "GROW" });
    await editor.carregar();
    editor.editarRegra(1);
    assert.equal(campo("origemFollow").checked, true);
    assert.equal(campo("origemFollow").disabled, false);

    for (const origemFollow of [false, true]) {
      campo("origemFollow").checked = origemFollow;
      campo("form").eventos.submit({ preventDefault() {} });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(enviados.at(-1).acao.origemFollow, origemFollow);
      editor.editarRegra(1);
      assert.equal(campo("origemFollow").checked, origemFollow);
    }

    campo("comando").value = "FOLLOW";
    campo("form").eventos.change({ target: { dataset: { ref: "comando" } } });
    assert.equal(campo("origemFollow").disabled, true);
    campo("form").eventos.submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(enviados.at(-1).acao.origemFollow, false);

    editor.abrirNova();
    assert.equal(campo("origemFollow").checked, false);
  });
}
