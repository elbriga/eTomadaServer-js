const MAX_TIMEOUT = 2 ** 31 - 1;

export function criarRuleTimers({ log, aoVencer }) {
  const pendentes = new Map();
  let encerrando = false;

  const chaveDe = (deviceId, recursoId) =>
    `${deviceId.toUpperCase()}/${recursoId}`;

  function cancelar(deviceId, recursoId) {
    const chave = chaveDe(deviceId, recursoId);
    const registro = pendentes.get(chave);

    if (!registro) return false;

    clearTimeout(registro.timeout);
    pendentes.delete(chave);

    log.info(
      { module: "RULES", global_id: registro.globalId },
      `[TIMER] Cancelado: ${chave}`,
    );

    return true;
  }

  function cancelarNodo(deviceId) {
    for (const registro of [...pendentes.values()]) {
      if (registro.deviceId.toUpperCase() === deviceId.toUpperCase())
        cancelar(registro.deviceId, registro.recursoId);
    }
  }

  function agendar({
    deviceId,
    recursoId,
    globalId,
    segundos,
    regraId,
    revision,
  }) {
    if (encerrando) return false;

    cancelar(deviceId, recursoId);

    const chave = chaveDe(deviceId, recursoId);

    const registro = {
      deviceId,
      recursoId,
      globalId,
      segundos,
      regraId,
      revision,
      venceEm: performance.now() + segundos * 1000,
      timeout: null,
    };

    pendentes.set(chave, registro);

    // Temporizador relativo > suporta períodos longos sem overflow.
    function programar() {
      if (pendentes.get(chave) !== registro) return;

      const restante = registro.venceEm - performance.now();

      if (restante <= 0) {
        Promise.resolve()
          .then(() =>
            aoVencer(
              registro,
              () => !encerrando && pendentes.get(chave) === registro,
            ),
          )
          .catch((err) => {
            log.error(
              { module: "RULES", err, global_id: globalId },
              "[TIMER] Falha na execução agendada",
            );
          })
          .finally(() => {
            if (pendentes.get(chave) === registro) pendentes.delete(chave);
          });

        return;
      }

      registro.timeout = setTimeout(
        programar,
        Math.min(Math.ceil(restante), MAX_TIMEOUT),
      );
    }

    programar();

    log.info(
      { module: "RULES", global_id: globalId, regra_id: regraId },
      `[TIMER] ${chave}: OFF agendado em ${segundos}s`,
    );

    return true;
  }

  function parar() {
    encerrando = true;

    for (const registro of pendentes.values()) clearTimeout(registro.timeout);

    pendentes.clear();
  }

  return { agendar, cancelar, cancelarNodo, parar };
}
