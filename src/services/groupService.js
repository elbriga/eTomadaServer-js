export class GroupCommandError extends Error {
  constructor(message, code, statusCode = 409) {
    super(message);
    this.name = "GroupCommandError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function criarGroupService({
  groups,
  comandos,
  permitirComandos = false,
  log,
  concorrencia = 3,
}) {
  if (!Number.isInteger(concorrencia) || concorrencia < 1) {
    throw new TypeError("Concorrência inválida");
  }

  if (permitirComandos && typeof comandos?.executar !== "function") {
    throw new TypeError("ResourceService não configurado");
  }

  async function executar(groupId, command) {
    const grupo = groups.buscar(groupId);

    if (!grupo) {
      throw new GroupCommandError(
        "Grupo não encontrado",
        "GROUP_NOT_FOUND",
        404,
      );
    }

    if (command !== "ON" && command !== "OFF") {
      throw new GroupCommandError("Comando inválido", "INVALID_COMMAND", 400);
    }

    if (!permitirComandos) {
      throw new GroupCommandError(
        "Comandos físicos desabilitados neste ambiente",
        "COMMANDS_DISABLED",
        403,
      );
    }

    const membros = grupo.recursos;
    const results = new Array(membros.length);
    let proximo = 0;

    async function trabalhador() {
      while (true) {
        const indice = proximo++;
        if (indice >= membros.length) return;

        const recurso = membros[indice];
        const identificacao = {
          global_id: recurso.global_id,
          device_id: recurso.device_id,
          recurso_id: recurso.recurso_id,
        };

        if (recurso.tipo !== "RELE" || !recurso.global_id) {
          results[indice] = {
            ...identificacao,
            status: "skipped",
            reason:
              recurso.tipo !== "RELE"
                ? "UNSUPPORTED_RESOURCE"
                : "MISSING_GLOBAL_ID",
          };
          continue;
        }

        try {
          const resposta = await comandos.executar(recurso.global_id, command, {
            device_id: recurso.device_id,
            recurso_id: recurso.recurso_id,
          });

          results[indice] = {
            ...identificacao,
            status: "confirmed",
            command_id: resposta.command_id,
            estado: resposta.estado,
            duracao_ms: resposta.duracao_ms,
          };
        } catch (erro) {
          const status = ["uncertain", "mismatch"].includes(
            erro.execution_status,
          )
            ? erro.execution_status
            : "failed";

          results[indice] = {
            ...identificacao,
            status,
            command_id: erro.command_id ?? null,
            code: erro.code ?? "COMMAND_ERROR",
            detail: erro.message,
          };
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concorrencia, membros.length) }, () =>
        trabalhador(),
      ),
    );

    const summary = {
      total: results.length,
      attempted: 0,
      confirmed: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    };

    for (const result of results) {
      if (result.status === "skipped") {
        summary.skipped++;
      } else {
        summary.attempted++;

        if (result.status === "confirmed") summary.confirmed++;
        else if (result.status === "uncertain") summary.uncertain++;
        else summary.failed++;
      }
    }

    const ok = summary.attempted > 0 && summary.confirmed === summary.attempted;

    const dadosLog = {
      module: "GROUP",
      group_id: grupo.group_id,
      command,
      summary,
    };

    if (ok) {
      log?.info?.(dadosLog, "Comando coletivo confirmado");
    } else {
      log?.warn?.(dadosLog, "Comando coletivo parcialmente confirmado");
    }

    return {
      ok,
      group_id: grupo.group_id,
      command,
      summary,
      results,
    };
  }

  return { executar };
}
