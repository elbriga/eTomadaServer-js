import { createHash } from "node:crypto";

function ordenar(valor) {
  if (Array.isArray(valor)) return valor.map(ordenar);

  if (valor === null || typeof valor !== "object") return valor;

  return Object.fromEntries(
    Object.keys(valor)
      .sort()
      .map((chave) => [chave, ordenar(valor[chave])]),
  );
}

export function montarPacoteRegrasLocais(deviceId, regras) {
  const nodo = deviceId?.trim().toUpperCase();

  if (!nodo || !Array.isArray(regras) || regras.length > 64)
    throw new TypeError("Conjunto de regras locais inválido");

  const ids = new Set();

  // Monta somente os campos reconhecidos pelo firmware Full.
  const lista = [...regras]
    .sort((a, b) => a.id - b.id)
    .map((regra) => {
      if (
        regra.escopo !== "LOCAL" ||
        regra.device_id?.toUpperCase() !== nodo ||
        !Number.isInteger(regra.id) ||
        regra.id < 1 ||
        regra.id > 65535 ||
        ids.has(regra.id)
      ) {
        throw new TypeError("Regra local inválida ou duplicada");
      }

      ids.add(regra.id);

      return {
        id: regra.id,
        nome: regra.nome,
        ativa: regra.ativa,
        quando: ordenar(regra.quando),
        acao: ordenar(regra.acao),
      };
    });

  // Revisão do conjunto > muda sempre que o conteúdo desejado muda.
  const assinatura = JSON.stringify({
    device_id: nodo,
    regras: lista,
  });

  const revision = createHash("sha256").update(assinatura).digest("hex");

  return {
    device_id: nodo,
    revision,
    regras: lista,
  };
}
