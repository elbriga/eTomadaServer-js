// Agendador central de regras por horário.
// Não conhece SQLite, regras nem comandos físicos.

const formato = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function horarioLocal(instante) {
  const partes = Object.fromEntries(
    formato
      .formatToParts(instante)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );

  return {
    chave: `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}`,
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
  };
}

export function criarRuleScheduler({
  processarHorario,
  log,
  relogio = () => new Date(),
  intervaloMs = 1000,
}) {
  let timer = null;
  let ultimoMinuto = null;
  let pendente = null;
  let encerrando = false;

  // Impede repetição após ajustes do relógio para trás.
  // Mantém aproximadamente dois dias de minutos observados.
  const vistos = new Set();

  async function tick(instante = relogio()) {
    if (encerrando) return [];

    const horario = horarioLocal(instante);

    // O primeiro minuto apenas estabelece a referência.
    // Não executamos regras do minuto em que o servidor iniciou.
    if (ultimoMinuto === null) {
      ultimoMinuto = horario.chave;
      return [];
    }

    if (horario.chave === ultimoMinuto) return [];
    ultimoMinuto = horario.chave;

    if (vistos.has(horario.chave)) return [];

    vistos.add(horario.chave);

    if (vistos.size > 2880) {
      vistos.delete(vistos.values().next().value);
    }

    // Não executar um horário muito depois da virada do minuto.
    if (instante.getUTCSeconds() > 10) {
      log.warn(
        { module: "RULES", horario: horario.chave },
        "Minuto de regra ignorado por atraso",
      );
      return [];
    }

    // Não permitir avaliações simultâneas.
    if (pendente) {
      log.warn(
        { module: "RULES", horario: horario.chave },
        "Minuto de regra ignorado: avaliação anterior em andamento",
      );
      return [];
    }

    pendente = Promise.resolve().then(() =>
      processarHorario({
        hora: horario.hora,
        minuto: horario.minuto,
      }),
    );

    try {
      return await pendente;
    } finally {
      pendente = null;
    }
  }

  function iniciar() {
    if (timer) return;

    encerrando = false;

    // Ignora a execução retroativa do minuto de inicialização.
    ultimoMinuto = horarioLocal(relogio()).chave;

    timer = setInterval(() => {
      void tick().catch((err) => {
        log.error({ module: "RULES", err }, "Erro no agendador de regras");
      });
    }, intervaloMs);

    timer.unref?.();

    log.info(
      { module: "RULES", fuso: "America/Sao_Paulo" },
      "Agendador de regras iniciado",
    );
  }

  async function parar() {
    encerrando = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (pendente) {
      await pendente.catch(() => {});
    }
  }

  return { iniciar, parar, tick };
}
