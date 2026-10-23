// Avalia regras sem banco, relógio ou efeitos colaterais.

function comparar(valor, operacao, esperado) {
  switch (operacao) {
    case ">":
      return valor > esperado;
    case "<":
      return valor < esperado;
    case "=":
      return valor === esperado;
    case "!=":
      return valor !== esperado;
    case ">=":
      return valor >= esperado;
    case "<=":
      return valor <= esperado;
    default:
      return false;
  }
}

function checkAtendido(check, valores) {
  if (!check) return true;

  if (!valores || !Object.hasOwn(valores, check.variavel)) return false;

  const bruto = valores[check.variavel];
  const valor = typeof bruto === "boolean" ? Number(bruto) : bruto;

  if (typeof valor !== "number" || !Number.isFinite(valor)) return false;

  if (!Number.isFinite(check.valor)) return false;

  return comparar(valor, check.operacao, check.valor);
}

export function avaliarRegra(regra, evento, valores = {}) {
  if (!regra?.ativa || !regra.quando || !regra.acao || !evento) return null;

  const condicao = regra.quando;
  let disparou = false;

  if (condicao.tipo === "EVENTO") {
    disparou =
      evento.tipo === condicao.evento && evento.recurso === condicao.recurso;
  } else if (condicao.tipo === "HORARIO") {
    disparou =
      evento.tipo === "HORARIO" &&
      evento.hora === condicao.hora &&
      evento.minuto === condicao.minuto;
  }

  if (!disparou || !checkAtendido(condicao.check, valores)) return null;

  return {
    regra_id: regra.id,
    revision: regra.revision,
    acao: { ...regra.acao },
  };
}

export function avaliarRegrasGlobais(regras, evento, valores = {}) {
  const acoes = [];

  for (const regra of regras) {
    if (regra.escopo !== "GLOBAL") continue;

    const acao = avaliarRegra(regra, evento, valores);

    if (acao) acoes.push(acao);
  }

  return acoes;
}

// Determina o último estado ON/OFF de cada recurso,
// considerando o ciclo completo de 24 horas.
export function calcularEstadosBootGlobais(regras, hora, minuto) {
  if (
    !Number.isInteger(hora) ||
    hora < 0 ||
    hora > 23 ||
    !Number.isInteger(minuto) ||
    minuto < 0 ||
    minuto > 59
  ) {
    throw new RangeError("Hora inválida para cálculo do boot");
  }

  const agora = hora * 60 + minuto;
  const ultimas = new Map();

  for (const regra of regras) {
    if (
      regra.escopo !== "GLOBAL" ||
      !regra.ativa ||
      regra.quando?.tipo !== "HORARIO" ||
      regra.acao?.tipo !== "ESTADO" ||
      !["ON", "OFF"].includes(regra.acao.comando)
    )
      continue;

    const { hora: h, minuto: m } = regra.quando;

    if (
      !Number.isInteger(h) ||
      h < 0 ||
      h > 23 ||
      !Number.isInteger(m) ||
      m < 0 ||
      m > 59
    )
      continue;

    const momento = h * 60 + m;

    // Minutos decorridos desde a última ocorrência da regra.
    const distancia = (agora - momento + 1440) % 1440;

    const recurso = regra.acao.recurso;
    const atual = ultimas.get(recurso);

    if (
      !atual ||
      distancia < atual.distancia ||
      (distancia === atual.distancia && regra.id < atual.regra_id)
    ) {
      ultimas.set(recurso, {
        regra_id: regra.id,
        revision: regra.revision,
        acao: { ...regra.acao },
        distancia,
      });
    }
  }

  // Distância é informação interna do cálculo.
  return [...ultimas.values()].map(({ distancia, ...acao }) => acao);
}
