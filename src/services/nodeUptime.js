// Uptime dos nodos em segundos, sem rollover de 32 bits

function valido(observacao) {
  return (
    observacao &&
    Number.isSafeInteger(observacao.uptime) &&
    observacao.uptime >= 0 &&
    Number.isFinite(observacao.instanteMs)
  );
}

export function classificarUptime(anterior, atual, toleranciaSegundos = 5) {
  if (!valido(atual)) return "indeterminado";
  if (!anterior) return "inicial";
  if (!valido(anterior)) return "indeterminado";

  const decorrido = (atual.instanteMs - anterior.instanteMs) / 1000;

  if (decorrido < 0) return "indeterminado";

  // Compara o avanço do uptime com o relógio monotônico do servidor.
  const avancou = atual.uptime - anterior.uptime;

  if (Math.abs(avancou - decorrido) <= toleranciaSegundos) return "continuo";

  // Uptime regrediu ou indica um novo boot durante a desconexão.
  if (
    atual.uptime < anterior.uptime ||
    atual.uptime <= decorrido + toleranciaSegundos
  )
    return "reiniciou";

  return "indeterminado";
}
