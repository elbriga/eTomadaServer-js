import { criarRuleRepository } from "../repositories/ruleRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import { avaliarRegrasGlobais } from "./ruleEvaluator.js";

export function criarRuleEngine({ db, log }) {
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

  function avaliar(evento) {
    const regras = rules
      .listar({ escopo: "GLOBAL" })
      .filter(
        (regra) =>
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

    const valores = obterValores(regras);
    return avaliarRegrasGlobais(regras, evento, valores);
  }

  function registrarAcoes(acoes, origem) {
    for (const acao of acoes) {
      log.info(
        {
          module: "RULES",
          regra_id: acao.regra_id,
          revision: acao.revision,
          acao: acao.acao,
        },
        `[SIMULACAO] Regra #${acao.regra_id} ` +
          `rev.${acao.revision} disparada por ${origem}: ` +
          JSON.stringify(acao.acao),
      );
    }
  }

  function processarEvento(eventoRecebido) {
    const { origem: deviceId, id: recursoId, evento: tipo } = eventoRecebido;

    const recurso = resources.buscar(deviceId, recursoId);

    if (!recurso?.global_id) return [];

    /*const evento = {
      tipo: "EVENTO",
      recurso: recurso.global_id,
      evento: tipo.trim().toUpperCase(),
    };*/
    const evento = {
      tipo: tipo.trim().toUpperCase(),
      recurso: recurso.global_id,
    };

    const acoes = avaliar(evento);

    registrarAcoes(acoes, `${deviceId}/${recursoId}`);

    return acoes;
  }

  return {
    processarEvento,
  };
}
