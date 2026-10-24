function objeto(valor) {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

// Normaliza a definição da regra, ignorando metadados.
function normalizar(regra) {
  if (
    !objeto(regra) ||
    !Number.isInteger(regra.id) ||
    regra.id < 1 ||
    regra.id > 65535 ||
    typeof regra.nome !== "string" ||
    typeof regra.ativa !== "boolean" ||
    !objeto(regra.quando) ||
    !objeto(regra.acao)
  ) {
    throw new TypeError("Regra inválida na comparação");
  }

  return {
    id: regra.id,
    nome: regra.nome,
    ativa: regra.ativa,
    quando: regra.quando,
    acao: regra.acao,
  };
}

// Ordena chaves de objetos para ignorar diferenças na serialização JSON.
function ordenar(valor) {
  if (Array.isArray(valor)) return valor.map(ordenar);

  if (!objeto(valor)) return valor;

  return Object.fromEntries(
    Object.keys(valor)
      .sort()
      .map((chave) => [chave, ordenar(valor[chave])]),
  );
}

function indexar(lista, origem) {
  if (!Array.isArray(lista))
    throw new TypeError(`Lista de regras inválida: ${origem}`);

  const indice = new Map();

  for (const regra of lista) {
    const normalizada = normalizar(regra);

    if (indice.has(normalizada.id))
      throw new Error(`ID duplicado em ${origem}: ${normalizada.id}`);

    indice.set(normalizada.id, {
      original: regra,
      normalizada,
      assinatura: JSON.stringify(ordenar(normalizada)),
    });
  }

  return indice;
}

export function compararRegrasLocais(regrasServidor, regrasNodo) {
  const servidor = indexar(regrasServidor, "servidor");
  const nodo = indexar(regrasNodo, "nodo");

  const iguais = [];
  const somente_servidor = [];
  const somente_nodo = [];
  const divergentes = [];

  const ids = [...new Set([...servidor.keys(), ...nodo.keys()])].sort(
    (a, b) => a - b,
  );

  for (const id of ids) {
    const local = servidor.get(id);
    const remoto = nodo.get(id);

    if (!remoto) {
      somente_servidor.push({
        ...local.normalizada,
        revision: local.original.revision,
      });
      continue;
    }

    if (!local) {
      somente_nodo.push(remoto.normalizada);
      continue;
    }

    if (local.assinatura === remoto.assinatura) {
      iguais.push(id);
      continue;
    }

    divergentes.push({
      id,
      revision: local.original.revision,
      servidor: local.normalizada,
      nodo: remoto.normalizada,
    });
  }

  return {
    situacao:
      somente_servidor.length || somente_nodo.length || divergentes.length
        ? "DIVERGENTE"
        : "IGUAL",
    total_servidor: servidor.size,
    total_nodo: nodo.size,
    iguais,
    somente_servidor,
    somente_nodo,
    divergentes,
  };
}
