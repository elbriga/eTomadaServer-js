import { criarRuleRepository } from "../repositories/ruleRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import { avaliarRegrasGlobais } from "./ruleEvaluator.js";

export function criarRuleEngine({
  db,
  log,
  comandos = null,
  modo = "simulate",
  regraId = null,
  alvoId = null,
}) {
  const rules = criarRuleRepository(db);
  const resources = criarResourceRepository(db);

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
          (regraId === null || regra.id === regraId) &&
          regra.ativa &&
          regra.quando.tipo === "EVENTO" &&
          regra.quando.recurso === evento.recurso &&
          regra.quando.evento === evento.tipo,
      );
    /*
    const regras = rules
      .listar({ escopo: "GLOBAL" })
      .filter(
        (regra) =>
          regra.ativa &&
          regra.quando.tipo === evento.tipo &&
          (evento.tipo !== "EVENTO" ||
            (regra.quando.recurso === evento.recurso &&
              regra.quando.evento === evento.evento)),
      );
    */

    const valores = {
      ...obterValores(regras),
      ...valoresEvento,
    };

    return avaliarRegrasGlobais(regras, evento, valores);
  }

  async function registrarAcoes(acoes, origem) {
    for (const plano of acoes) {
      const { tipo, recurso, comando } = plano.acao;

      const contexto = {
        module: "RULES",
        regra_id: plano.regra_id,
        revision: plano.revision,
        acao: plano.acao,
      };

      if (modo !== "execute") {
        log.info(
          contexto,
          `[SIMULACAO] Regra #${plano.regra_id} ` +
            `disparada por ${origem}: ${JSON.stringify(plano.acao)}`,
        );
        continue;
      }

      // Primeira etapa: apenas comandos ON/OFF
      // e somente para o destino autorizado.
      if (
        tipo !== "ESTADO" ||
        !["ON", "OFF"].includes(comando) ||
        recurso !== alvoId ||
        !comandos
      ) {
        log.warn(contexto, "Ação não autorizada para execução");
        continue;
      }

      // A regra pode ter sido editada entre avaliação e execução.
      const atual = rules.buscar(plano.regra_id);

      if (
        !atual?.ativa ||
        atual.escopo !== "GLOBAL" ||
        atual.revision !== plano.revision
      ) {
        log.warn(contexto, "Regra alterada; ação descartada");
        continue;
      }

      try {
        const resultado = await comandos.executar(recurso, comando);

        log.info(
          {
            ...contexto,
            command_id: resultado.command_id,
          },
          `[EXECUTADA] Regra #${plano.regra_id}: ` + `${recurso} -> ${comando}`,
        );
      } catch (erro) {
        log.error(
          { ...contexto, err: erro },
          `[FALHA] Regra #${plano.regra_id}: ` + `${recurso} -> ${comando}`,
        );
      }
    }
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

    await registrarAcoes(acoes, `${deviceId}/${recursoId}`);

    return acoes;
  }

  return {
    processarEvento,
  };
}
