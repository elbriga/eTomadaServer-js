import { criarRuleRepository } from "../repositories/ruleRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import {
  avaliarRegrasGlobais,
  calcularEstadosBootGlobais,
} from "./ruleEvaluator.js";
import { horarioLocal } from "./ruleScheduler.js";
import { criarRuleTimers } from "./ruleTimers.js";
import { criarRuleLoopGuard } from "./ruleLoopGuard.js";

export function criarRuleEngine({
  db,
  log,
  comandos = null,
  modo = "simulate",
}) {
  const rules = criarRuleRepository(db);
  const resources = criarResourceRepository(db);
  const loopGuard = criarRuleLoopGuard();
  const bootsEmAndamento = new Set();

  let filaAcoes = Promise.resolve();

  // TIMER > executa OFF pela mesma fila dos comandos globais.
  const timers = criarRuleTimers({
    log,

    aoVencer(timer, ativo) {
      const tarefa = filaAcoes.then(async () => {
        if (!ativo() || modo !== "execute" || !comandos) return;

        const regra = rules.buscar(timer.regraId);
        const recurso = resources.buscarGlobal(timer.globalId);

        // Confirma revisão e identidade física antes do OFF.
        if (
          !regra?.ativa ||
          regra.revision !== timer.revision ||
          regra.escopo !== "GLOBAL" ||
          regra.acao?.tipo !== "TIMER" ||
          regra.acao.recurso !== timer.globalId ||
          regra.acao.timer !== timer.segundos ||
          recurso?.device_id !== timer.deviceId ||
          recurso.recurso_id !== timer.recursoId
        ) {
          log.warn(
            { module: "RULES", global_id: timer.globalId },
            "[TIMER] Configuração alterada; OFF descartado",
          );
          return;
        }

        // Se o relé já está desligado, não há nada a fazer.
        if (obterEstadoRele(timer.globalId) !== 1) {
          log.info(
            { module: "RULES", global_id: timer.globalId },
            "[TIMER] OFF dispensado: estado não está confirmado como ON",
          );
          return;
        }

        if (!ativo()) return;

        const resposta = await comandos.executar(timer.globalId, "OFF", {
          device_id: timer.deviceId,
          recurso_id: timer.recursoId,
        });

        log.info(
          {
            module: "RULES",
            regra_id: timer.regraId,
            command_id: resposta.command_id,
          },
          `[TIMER][EXECUTADA] ${timer.globalId} -> OFF`,
        );
      });

      filaAcoes = tarefa.catch((err) => {
        log.error({ module: "RULES", err }, "Falha no OFF agendado");
      });

      return tarefa;
    },
  });

  // Obtém o último valor confirmado de um recurso global.
  function obterValor(globalId) {
    const recurso = resources.buscarGlobal(globalId);

    if (!recurso?.reported_json || !recurso.reported_at) return undefined;

    let estado;

    try {
      estado = JSON.parse(recurso.reported_json);
    } catch {
      return undefined;
    }

    if (typeof estado?.valor === "number" && Number.isFinite(estado.valor))
      return estado.valor;

    if (typeof estado?.estado === "boolean") return Number(estado.estado);

    if (estado?.estado === 0 || estado?.estado === 1) return estado.estado;

    return undefined;
  }

  // Obtém estado digital confirmado de um relé.
  function obterEstadoRele(globalId) {
    const recurso = resources.buscarGlobal(globalId);

    if (
      recurso?.tipo !== "RELE" ||
      !recurso.reported_json ||
      !recurso.reported_at
    )
      return null;

    try {
      const estado = JSON.parse(recurso.reported_json).estado;

      if (estado === true || estado === 1) return 1;
      if (estado === false || estado === 0) return 0;
    } catch {
      // Estado inválido ou indisponível.
    }

    return null;
  }

  function obterValores(regras) {
    const valores = {};

    for (const regra of regras) {
      const variavel = regra.quando.check?.variavel;
      if (!variavel || Object.hasOwn(valores, variavel)) continue;

      // HORASSECO ainda não é calculado no servidor.
      if (variavel === "HORASSECO") continue;

      const valor = obterValor(variavel);

      if (valor !== undefined) valores[variavel] = valor;
    }

    return valores;
  }

  function avaliar(evento, valoresEvento = {}) {
    const regras = rules
      .listar({ escopo: "GLOBAL" })
      .filter(
        (regra) =>
          regra.ativa &&
          regra.quando.tipo === "EVENTO" &&
          regra.quando.recurso === evento.recurso &&
          regra.quando.evento === evento.tipo,
      );

    const valores = {
      ...obterValores(regras),
      ...valoresEvento,
    };

    return avaliarRegrasGlobais(regras, evento, valores);
  }

  // Proteção contra cascatas de comandos entre regras.
  function permitirAcaoFisica(destinos, contexto) {
    const resultado = loopGuard.permitir(destinos);

    if (!resultado.permitido && resultado.novoBloqueio) {
      log.warn(
        {
          ...contexto,
          recurso_fisico: resultado.chave,
        },
        `[LOOP] Limite de comandos atingido em ${resultado.chave}; ` +
          "bloqueando automações por 30 segundos",
      );
    }

    return resultado.permitido;
  }

  async function executarAcoes(acoes, origem, valoresEvento = {}) {
    for (const plano of acoes) {
      const { tipo, recurso, comando } = plano.acao;

      const contexto = {
        module: "RULES",
        regra_id: plano.regra_id,
        revision: plano.revision,
        acao: plano.acao,
      };

      // Confirma que a regra ainda existe na mesma revisão.
      const atual = rules.buscar(plano.regra_id);

      if (
        !atual?.ativa ||
        atual.escopo !== "GLOBAL" ||
        atual.revision !== plano.revision
      ) {
        log.warn(contexto, "Regra alterada; ação descartada");
        continue;
      }

      if (
        !(
          (tipo === "ESTADO" &&
            ["ON", "OFF", "TOGGLE", "FOLLOW", "TOGGLEF"].includes(comando)) ||
          tipo === "TIMER"
        )
      ) {
        log.warn(
          contexto,
          `Ação [${tipo}][${comando}] ainda não suportada pelo executor`,
        );
        continue;
      }

      const destino = resources.buscarGlobal(recurso);

      if (destino?.tipo !== "RELE") {
        log.warn(contexto, "Destino não é um relé válido");
        continue;
      }

      let comandoFinal = comando;
      let ajusteOrigem = null;
      let tempoTimer = 0;

      // TIMER > ON agora; OFF agendado após confirmação.
      if (tipo === "TIMER") {
        tempoTimer = plano.acao.timer;

        if (
          !Number.isInteger(tempoTimer) ||
          tempoTimer < 1 ||
          tempoTimer > 4294967295
        ) {
          log.warn(contexto, "TIMER inválido");
          continue;
        }

        comandoFinal = "ON";
      }

      // TOGGLE > inverte o estado confirmado do destino.
      if (comando === "TOGGLE") {
        const estado = obterEstadoRele(recurso);

        if (estado === null) {
          log.warn(contexto, "TOGGLE ignorado: estado do destino desconhecido");
          continue;
        }

        comandoFinal = estado ? "OFF" : "ON";
      }

      // FOLLOW > utiliza o estado da origem do evento.
      if (comando === "FOLLOW") {
        if (atual.quando.tipo !== "EVENTO") {
          log.warn(contexto, "FOLLOW exige condição de evento");
          continue;
        }

        const origemGlobal = atual.quando.recurso;

        const valor = Object.hasOwn(valoresEvento, origemGlobal)
          ? valoresEvento[origemGlobal]
          : obterValor(origemGlobal);

        if (typeof valor !== "number" || !Number.isFinite(valor)) {
          log.warn(contexto, "FOLLOW ignorado: estado da origem desconhecido");
          continue;
        }

        comandoFinal = valor !== 0 ? "ON" : "OFF";
      }

      // TOGGLEF > inverte destino e sincroniza a origem.
      if (comando === "TOGGLEF") {
        const estadoDestino = obterEstadoRele(recurso);
        const origemGlobal = atual.quando.recurso;
        const recursoOrigem = resources.buscarGlobal(origemGlobal);

        const estadoOrigem = Object.hasOwn(valoresEvento, origemGlobal)
          ? valoresEvento[origemGlobal]
          : obterEstadoRele(origemGlobal);

        if (
          atual.quando.tipo !== "EVENTO" ||
          estadoDestino === null ||
          recursoOrigem?.tipo !== "RELE" ||
          ![0, 1].includes(estadoOrigem)
        ) {
          log.warn(contexto, "TOGGLEF ignorado: estados ou origem inválidos");
          continue;
        }

        const novoEstado = estadoDestino ? 0 : 1;
        comandoFinal = novoEstado ? "ON" : "OFF";

        if (origemGlobal !== recurso && estadoOrigem !== novoEstado) {
          ajusteOrigem = {
            recurso: origemGlobal,
            device_id: recursoOrigem.device_id,
            recurso_id: recursoOrigem.recurso_id,
          };
        }
      }

      // Simulação > registra também o comando já resolvido.
      if (modo !== "execute") {
        log.info(
          {
            ...contexto,
            comando_resolvido: comandoFinal,
            ajuste_origem: ajusteOrigem?.recurso ?? null,
            timer_segundos: tempoTimer || null,
          },
          `[SIMULACAO] Regra #${plano.regra_id}: ` +
            `${recurso} -> ${comandoFinal} (${tipo === "TIMER" ? "TIMER" : comando})` +
            (ajusteOrigem
              ? `, origem ${ajusteOrigem.recurso} -> ${comandoFinal}`
              : "") +
            (tempoTimer ? `, OFF em ${tempoTimer}s` : ""),
        );
        continue;
      }

      if (!comandos) {
        log.warn(contexto, "Executor de comandos indisponível");
        continue;
      }

      // Verifica os relés envolvidos antes de iniciar comandos físicos.
      const destinosFisicos = [`${destino.device_id}/${destino.recurso_id}`];

      if (ajusteOrigem) {
        destinosFisicos.push(
          `${ajusteOrigem.device_id}/${ajusteOrigem.recurso_id}`,
        );
      }

      if (!permitirAcaoFisica(destinosFisicos, contexto)) continue;

      try {
        // TODO :: TOGGLEF dentro do try : se falahar não muda o destino > colocar fora do try?
        // TOGGLEF > corrige a origem antes de alterar o destino.
        if (ajusteOrigem) {
          await comandos.executar(ajusteOrigem.recurso, comandoFinal, {
            device_id: ajusteOrigem.device_id,
            recurso_id: ajusteOrigem.recurso_id,
          });
        }

        const resultado = await comandos.executar(recurso, comandoFinal, {
          device_id: destino.device_id,
          recurso_id: destino.recurso_id,
        });

        // TIMER > agenda OFF somente após ON confirmado.
        if (tempoTimer > 0) {
          timers.agendar({
            deviceId: destino.device_id,
            recursoId: destino.recurso_id,
            globalId: recurso,
            segundos: tempoTimer,
            regraId: plano.regra_id,
            revision: plano.revision,
          });
        }

        log.info(
          {
            ...contexto,
            command_id: resultado.command_id,
          },
          `[EXECUTADA] Regra #${plano.regra_id}: ` +
            `${recurso} -> ${comandoFinal} (${comando})`,
        );
      } catch (erro) {
        log.error(
          { ...contexto, err: erro },
          `[FALHA] Regra #${plano.regra_id}: ` +
            `${recurso} -> ${comandoFinal} (${comando})`,
        );
      }
    }
  }

  // Serializa ações para ler os estados após o comando anterior.
  function registrarAcoes(acoes, origem, valoresEvento = {}) {
    const tarefa = filaAcoes.then(() =>
      executarAcoes(acoes, origem, valoresEvento),
    );

    filaAcoes = tarefa.catch((err) => {
      log.error({ module: "RULES", err }, "Falha na fila de ações");
    });

    return tarefa;
  }

  async function processarEvento(eventoRecebido, estadoAnterior = null) {
    const { origem: deviceId, id: recursoId, evento: tipo } = eventoRecebido;

    const recurso = resources.buscar(deviceId, recursoId);
    if (!recurso?.global_id) return [];

    const evento = {
      tipo: tipo.trim().toUpperCase(),
      recurso: recurso.global_id,
    };

    const device = eventoRecebido.device ?? {};
    const valoresEvento = {};

    const estadoAtual =
      device.estado === true || device.estado === 1
        ? 1
        : device.estado === false || device.estado === 0
          ? 0
          : null;

    // Evita reexecutar a regra em eventos TOGGLE
    // duplicados que não representam mudança de estado.
    if (
      evento.tipo === "TOGGLE" &&
      estadoAtual !== null &&
      estadoAnterior !== null &&
      estadoAtual === estadoAnterior
    ) {
      return [];
    }

    if (estadoAtual !== null) {
      valoresEvento[recurso.global_id] = estadoAtual;
    } else if (
      typeof device.valor === "number" &&
      Number.isFinite(device.valor)
    ) {
      valoresEvento[recurso.global_id] = device.valor;
    }

    const acoes = avaliar(evento, valoresEvento);

    await registrarAcoes(acoes, `${deviceId}/${recursoId}`, valoresEvento);

    return acoes;
  }

  async function processarHorario({ hora, minuto }) {
    const regras = rules
      .listar({ escopo: "GLOBAL" })
      .filter((regra) => regra.ativa && regra.quando?.tipo === "HORARIO");

    const valores = obterValores(regras);

    const evento = {
      tipo: "HORARIO",
      hora,
      minuto,
    };

    const acoes = avaliarRegrasGlobais(regras, evento, valores);

    const origem =
      `HORARIO ${String(hora).padStart(2, "0")}:` +
      String(minuto).padStart(2, "0");

    // Horários utilizam o mesmo executor dos eventos.
    await registrarAcoes(acoes, origem);

    return acoes;
  }

  function simularBoot(
    deviceId,
    snapshot,
    instante = new Date(),
    registrar = true,
  ) {
    const { hora, minuto } = horarioLocal(instante);

    // Nesta etapa, não restaurar regras condicionais.
    const regras = rules
      .listar({ escopo: "GLOBAL" })
      .filter((regra) => !regra.quando?.check);

    const planos = calcularEstadosBootGlobais(regras, hora, minuto);

    // Usamos os estados do snapshot atual, não o cache
    // anterior do SQLite.
    const locais = new Map(
      (snapshot.recursos ?? [])
        .filter((r) => r.remoto !== true)
        .map((r) => [r.id, r]),
    );

    const resultados = [];

    for (const plano of planos) {
      const globalId = plano.acao.recurso;
      const recurso = resources.buscarGlobal(globalId);

      if (
        !recurso ||
        recurso.device_id.toUpperCase() !== deviceId.toUpperCase() ||
        recurso.tipo.toUpperCase() !== "RELE"
      )
        continue;

      const fisico = locais.get(recurso.recurso_id);
      if (!fisico) continue;

      const bruto = fisico.device?.estado;

      const observado =
        bruto === true || bruto === 1
          ? 1
          : bruto === false || bruto === 0
            ? 0
            : null;

      const esperado = plano.acao.comando === "ON" ? 1 : 0;

      const situacao =
        observado === null
          ? "DESCONHECIDO"
          : observado === esperado
            ? "OK"
            : "DIVERGENTE";

      const resultado = {
        device_id: deviceId,
        global_id: globalId,
        recurso_id: recurso.recurso_id,
        regra_id: plano.regra_id,
        revision: plano.revision,
        esperado,
        observado,
        situacao,
      };

      resultados.push(resultado);

      if (registrar)
        log.info(
          { module: "RULES", ...resultado },
          `[BOOT][SIMULACAO] ${deviceId}/${globalId}: ` +
            `esperado=${esperado}, observado=${observado}, ` +
            `situacao=${situacao}`,
        );
    }

    return resultados;
  }

  async function reconciliarBoot(deviceId, snapshot, instante = new Date()) {
    if (modo === "off") return [];

    const chave = deviceId.toUpperCase();

    // Impede duas reconciliações simultâneas do mesmo nodo.
    if (bootsEmAndamento.has(chave)) return [];

    // Execução física exige um snapshot válido do nodo reiniciado.
    if (
      modo === "execute" &&
      (snapshot?.device_id?.toUpperCase() !== chave ||
        !Number.isInteger(snapshot.uptime))
    ) {
      log.warn(
        { module: "RULES", device_id: deviceId },
        "[BOOT] Snapshot inválido para restauração",
      );
      return [];
    }

    bootsEmAndamento.add(chave);

    try {
      // Calcula os estados desejados usando a busca circular.
      const resultados = simularBoot(
        deviceId,
        snapshot,
        instante,
        modo !== "execute",
      );

      if (modo !== "execute") return resultados;

      if (modo !== "execute" || !comandos) {
        log.warn(
          { module: "RULES", device_id: deviceId },
          "[BOOT] Execução física não permitida",
        );
        return resultados;
      }

      for (const resultado of resultados) {
        const contexto = {
          module: "RULES",
          ...resultado,
        };

        if (resultado.situacao !== "DIVERGENTE") {
          log.info(
            contexto,
            `[BOOT] ${deviceId}/${resultado.global_id}: ` +
              `sem restauração (${resultado.situacao})`,
          );
          continue;
        }

        const comando = resultado.esperado === 1 ? "ON" : "OFF";

        // Confirma que a regra não foi editada ou desativada.
        const regra = rules.buscar(resultado.regra_id);

        if (
          !regra?.ativa ||
          regra.escopo !== "GLOBAL" ||
          regra.revision !== resultado.revision ||
          regra.quando?.tipo !== "HORARIO" ||
          regra.quando.check ||
          regra.acao?.tipo !== "ESTADO" ||
          regra.acao.recurso !== resultado.global_id ||
          regra.acao.comando !== comando
        ) {
          log.warn(contexto, "[BOOT] Regra alterada; restauração cancelada");
          continue;
        }

        // Confirma que o destino ainda pertence ao nodo reiniciado.
        const recurso = resources.buscarGlobal(resultado.global_id);

        if (
          recurso?.device_id !== resultado.device_id ||
          recurso.recurso_id !== resultado.recurso_id
        ) {
          log.warn(contexto, "[BOOT] Destino alterado; restauração cancelada");
          continue;
        }

        // Reconciliação > respeitar o limite de comandos do relé.
        if (
          !permitirAcaoFisica(
            [`${recurso.device_id}/${recurso.recurso_id}`],
            contexto,
          )
        ) {
          continue;
        }

        try {
          const resposta = await comandos.executar(
            resultado.global_id,
            comando,
            {
              device_id: resultado.device_id,
              recurso_id: resultado.recurso_id,
            },
          );

          log.info(
            {
              ...contexto,
              command_id: resposta.command_id,
            },
            `[BOOT][EXECUTADA] ${deviceId}/${resultado.global_id} -> ${comando}`,
          );
        } catch (err) {
          log.error(
            { ...contexto, err },
            `[BOOT][FALHA] ${deviceId}/${resultado.global_id} -> ${comando}`,
          );
        }
      }

      return resultados;
    } finally {
      bootsEmAndamento.delete(chave);
    }
  }

  function cancelarTimerFisico(deviceId, recursoId) {
    return timers.cancelar(deviceId, recursoId);
  }

  function cancelarTimersNodo(deviceId) {
    timers.cancelarNodo(deviceId);
  }

  async function parar() {
    timers.parar();
    await filaAcoes;
  }

  return {
    processarEvento,
    processarHorario,
    simularBoot,
    reconciliarBoot,
    cancelarTimerFisico,
    cancelarTimersNodo,
    parar,
  };
}
