import { performance } from "node:perf_hooks";

export function criarRuleLoopGuard({
  maxAcoes = 8,
  janelaMs = 10000,
  bloqueioMs = 30000,
  agora = () => performance.now(),
} = {}) {
  const registros = new Map();

  function permitir(chaves) {
    const instante = agora();
    const unicos = [...new Set(chaves)];

    // Verifica todos os destinos antes de autorizar qualquer ação.
    for (const chave of unicos) {
      let registro = registros.get(chave);

      if (!registro) {
        registro = {
          instantes: [],
          bloqueadoAte: 0,
        };
        registros.set(chave, registro);
      }

      registro.instantes = registro.instantes.filter(
        (t) => instante - t < janelaMs,
      );

      if (instante < registro.bloqueadoAte) {
        return {
          permitido: false,
          novoBloqueio: false,
          chave,
        };
      }

      if (registro.instantes.length >= maxAcoes) {
        registro.bloqueadoAte = instante + bloqueioMs;
        registro.instantes = [];

        return {
          permitido: false,
          novoBloqueio: true,
          chave,
        };
      }
    }

    // Reserva conjuntamente os destinos da ação.
    for (const chave of unicos) registros.get(chave).instantes.push(instante);

    return { permitido: true };
  }

  return { permitir };
}
