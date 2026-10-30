import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import { criarCommandRepository } from "../repositories/commandRepository.js";
import {
  enviarComandoRele,
  enviarComandosLote,
} from "../devices/nodeClient.js";

export class ResourceCommandError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = "ResourceCommandError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizarEstado(valor) {
  if (valor === true || valor === 1) return true;
  if (valor === false || valor === 0) return false;
  return null;
}

export function criarResourceService({
  db,
  monitor,
  log,
  permitirComandos = false,
  aoComandoConfirmado = null,
  enviarComando = enviarComandoRele,
  enviarLote = enviarComandosLote,
}) {
  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const commands = criarCommandRepository(db);
  const executando = new Set();

  // Recupera operações interrompidas por restart/crash.
  const interrompidos = commands.encerrarPendentes();
  if (interrompidos > 0) {
    log.warn(
      { module: "COMMAND", total: interrompidos },
      "Comandos pendentes recuperados como incertos",
    );
  }

  async function executar(
    globalId,
    comando,
    esperado = null,
    transportar = enviarComando,
  ) {
    const recurso = resources.buscarGlobal(globalId);

    if (!recurso) {
      throw new ResourceCommandError(
        `Recurso ${globalId} não encontrado`,
        "RESOURCE_NOT_FOUND",
        404,
      );
    }

    if (
      esperado &&
      (recurso.device_id !== esperado.device_id ||
        recurso.recurso_id !== esperado.recurso_id)
    ) {
      throw new ResourceCommandError(
        `Identificação física alterada para ${globalId}`,
        "RESOURCE_MOVED",
        409,
      );
    }

    if (recurso.tipo !== "RELE") {
      throw new ResourceCommandError(
        `Tipo ${recurso.tipo} não suporta este comando`,
        "UNSUPPORTED_RESOURCE",
        422,
      );
    }

    if (comando !== "ON" && comando !== "OFF") {
      throw new ResourceCommandError(
        `Comando inválido: ${comando}`,
        "INVALID_COMMAND",
        400,
      );
    }

    if (!permitirComandos) {
      throw new ResourceCommandError(
        "Comandos físicos desabilitados neste ambiente",
        "COMMANDS_DISABLED",
        403,
      );
    }

    const node = nodes.buscar(recurso.device_id);

    if (!node || !node.enabled) {
      throw new ResourceCommandError(
        `Nodo ${recurso.device_id} indisponível ou desabilitado`,
        "NODE_DISABLED",
        409,
      );
    }

    if (node.api !== "Full" && node.api !== "Lite") {
      throw new ResourceCommandError(
        `API do nodo ${node.device_id} desconhecida`,
        "UNSUPPORTED_API",
        409,
      );
    }

    // Chave física: evita comandos simultâneos ao mesmo relé.
    const chave = `${recurso.device_id}/${recurso.recurso_id}`;

    if (executando.has(chave)) {
      throw new ResourceCommandError(
        `Comando já em andamento para ${chave}`,
        "COMMAND_IN_PROGRESS",
        409,
      );
    }

    executando.add(chave);
    let registro = null;

    try {
      registro = commands.iniciar({
        device_id: recurso.device_id,
        recurso_id: recurso.recurso_id,
        global_id: recurso.global_id,
        command: comando,
      });

      // Descarta resultados de polling iniciados antes do comando.
      monitor.receberEvento(recurso.device_id);

      const resposta = await transportar({
        deviceId: node.device_id,
        recursoId: recurso.recurso_id,
        api: node.api,
        comando,
      });

      const retornado = resposta.recurso;

      if (
        !retornado ||
        retornado.id !== recurso.recurso_id ||
        retornado.tipo !== "RELE"
      ) {
        throw new ResourceCommandError(
          "Resposta sem confirmação do recurso solicitado",
          "NO_CONFIRMATION",
          502,
        );
      }

      const estado = normalizarEstado(retornado.device?.estado);

      if (estado === null) {
        throw new ResourceCommandError(
          "Resposta sem estado confirmado",
          "NO_CONFIRMATION",
          502,
        );
      }

      // A resposta contém uma observação real do hardware.
      // Persiste inclusive quando o estado é diferente do solicitado.
      const atualizado = resources.aplicarEvento(
        recurso.device_id,
        recurso.recurso_id,
        { estado },
      );

      if (!atualizado) {
        throw new ResourceCommandError(
          "Recurso removido durante o comando",
          "RESOURCE_CHANGED",
          409,
        );
      }

      // Invalida snapshots GET anteriores à confirmação.
      monitor.receberEvento(recurso.device_id);

      const resultado = commands.confirmarResposta(registro.id, estado);

      const estadoEsperado = comando === "ON";

      if (estado !== estadoEsperado) {
        throw new ResourceCommandError(
          `Estado divergente: solicitado ${comando}, confirmado ${estado ? "ON" : "OFF"}`,
          "STATE_MISMATCH",
          409,
        );
      }

      // Comando confirmado > invalidar timers anteriores do relé.
      if (aoComandoConfirmado) {
        try {
          aoComandoConfirmado({
            device_id: recurso.device_id,
            recurso_id: recurso.recurso_id,
            global_id: recurso.global_id,
            comando,
          });
        } catch (err) {
          log.error(
            { module: "RULES", err },
            "Falha ao notificar comando confirmado",
          );
        }
      }

      log.info(
        {
          module: "COMMAND",
          command_id: registro.id,
          device_id: node.device_id,
          recurso_id: recurso.recurso_id,
          global_id: recurso.global_id,
          comando,
          duracao_ms: resposta.duracao_ms,
        },
        "Comando confirmado",
      );

      return {
        ok: true,
        confirmed: true,
        command_id: registro.id,
        status: resultado.status,
        global_id: recurso.global_id,
        device_id: node.device_id,
        recurso_id: recurso.recurso_id,
        command: comando,
        estado,
        duracao_ms: resposta.duracao_ms,
        msg: resposta.msg ?? null,
      };
    } catch (erro) {
      if (registro) {
        // Atualiza apenas operações ainda pending.
        // Um mismatch já registrado não será sobrescrito.
        const resultado = commands.marcarIncerto(
          registro.id,
          erro.code ?? "UNEXPECTED_ERROR",
          erro.message,
        );

        erro.command_id = registro.id;
        erro.execution_status = resultado?.status;
      }

      throw erro;
    } finally {
      executando.delete(chave);
    }
  }

  async function executarLote(membros, comando) {
    const pendentes = [];

    // Cada recurso inicia seu histórico e aguarda o transporte comum.
    const tarefas = membros.map((recurso) =>
      executar(
        recurso.global_id,
        comando,
        {
          device_id: recurso.device_id,
          recurso_id: recurso.recurso_id,
        },
        (dados) =>
          new Promise((resolve, reject) => {
            pendentes.push({ ...dados, resolve, reject });
          }),
      ),
    );

    // Registrar os handlers antes do envio evita rejeições sem tratamento.
    const conclusoes = Promise.allSettled(tarefas);

    if (pendentes.length) {
      const primeiro = pendentes[0];

      try {
        if (
          pendentes.some(
            (p) => p.deviceId !== primeiro.deviceId || p.api !== primeiro.api,
          )
        ) {
          throw new ResourceCommandError(
            "Lote contém recursos de nodos diferentes",
            "INVALID_BATCH",
            400,
          );
        }

        const resposta = await enviarLote({
          deviceId: primeiro.deviceId,
          api: primeiro.api,
          recursos: pendentes.map((p) => ({
            id: p.recursoId,
            estado: p.comando,
          })),
        });

        // Relacionar confirmações pelo ID físico, nunca pela ordem.
        const resultados = new Map();
        for (const item of resposta.resultados) {
          if (typeof item.id !== "string") continue;
          resultados.set(item.id, resultados.has(item.id) ? null : item);
        }

        for (const pendente of pendentes) {
          const item = resultados.get(pendente.recursoId);

          if (!item) {
            pendente.reject(
              new ResourceCommandError(
                `Sem confirmação de ${pendente.recursoId}`,
                "NO_CONFIRMATION",
                502,
              ),
            );
            continue;
          }

          if (item.ok !== true) {
            pendente.reject(
              new ResourceCommandError(
                item.msg ?? `Comando recusado: ${item.id}`,
                "DEVICE_REJECTED",
                502,
              ),
            );
            continue;
          }

          pendente.resolve({
            recurso: item.recurso,
            msg: item.msg ?? null,
            duracao_ms: resposta.duracao_ms,
          });
        }
      } catch (erro) {
        // Falha no HTTP > cada registro pendente torna-se incerto.
        for (const pendente of pendentes) pendente.reject(erro);
      }
    }

    return conclusoes;
  }

  return { executar, executarLote };
}
