// Uptime dos ESPs: millis() em uint32_t.
const MODULO = 2 ** 32;

function valido(observacao) {
  return (
    observacao &&
    Number.isInteger(observacao.uptime) &&
    observacao.uptime >= 0 &&
    observacao.uptime < MODULO &&
    Number.isFinite(observacao.instanteMs)
  );
}

export function classificarUptime(anterior, atual, toleranciaMs = 5000) {
  if (!valido(atual)) return "indeterminado";
  if (!anterior) return "inicial";
  if (!valido(anterior)) return "indeterminado";

  const decorrido = atual.instanteMs - anterior.instanteMs;

  // Sem informação confiável após intervalo >= 49,7 dias.
  if (decorrido < 0 || decorrido >= MODULO) return "indeterminado";

  // Avanço esperado de millis(), incluindo rollover.
  const avancou = (atual.uptime - anterior.uptime + MODULO) % MODULO;

  if (Math.abs(avancou - decorrido) <= toleranciaMs) return "continuo";

  // O uptime atual cabe dentro do intervalo transcorrido:
  // é possível que o dispositivo tenha iniciado nesse período.
  if (atual.uptime <= decorrido + toleranciaMs) return "reiniciou";

  return "indeterminado";
}
