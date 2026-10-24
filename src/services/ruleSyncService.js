import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { criarRuleRepository } from "../repositories/ruleRepository.js";
import { consultarSnapshot } from "../devices/nodeClient.js";
import { enviarRegrasLocais } from "../devices/ruleSyncClient.js";
import { compararRegrasLocais } from "./ruleSyncCompare.js";
import { montarPacoteRegrasLocais } from "./ruleSyncPayload.js";

export function criarRuleSyncService({
  db,
  log,
  modo = "off",
  somenteNodo = null,
  consultar = consultarSnapshot,
  enviar = enviarRegrasLocais,
  retryMs = 30000,
}) {
  const nodes = criarNodeRepository(db);
  const rules = criarRuleRepository(db);

  const tarefas = new Map();
  const falhas = new Map();
  const simulacoes = new Map();

  let encerrando = false;

  const filtroNodo = somenteNodo?.toUpperCase() ?? null;

  function pacoteDesejado(deviceId) {
    return montarPacoteRegrasLocais(
      deviceId,
      rules.listar({
        escopo: "LOCAL",
        device_id: deviceId,
      }),
    );
  }

  function validarSnapshot(deviceId, snapshot) {
    if (
      snapshot?.device_id?.toUpperCase() !== deviceId ||
      snapshot?.api?.toUpperCase() !== "FULL" ||
      !Array.isArray(snapshot.regras)
    ) {
      throw new Error(`Snapshot de regras inválido: ${deviceId}`);
    }
  }

  async function verificar(deviceId, snapshot) {
    const pacote = pacoteDesejado(deviceId);

    if (!snapshot) snapshot = (await consultar(deviceId)).snapshot;

    validarSnapshot(deviceId, snapshot);

    const comparacao = compararRegrasLocais(pacote.regras, snapshot.regras);

    const igual =
      comparacao.situacao === "IGUAL" &&
      snapshot.rules_revision === pacote.revision;

    if (igual) {
      falhas.delete(deviceId);
      simulacoes.delete(deviceId);
      return false;
    }

    const contexto = {
      module: "RULES",
      device_id: deviceId,
      revision: pacote.revision,
      revision_nodo: snapshot.rules_revision ?? null,
      situacao: comparacao.situacao,
      total_servidor: pacote.regras.length,
      total_nodo: snapshot.regras.length,
    };

    if (modo === "simulate") {
      // Simulação > registrar somente mudanças na divergência.
      const assinatura = JSON.stringify({
        revision: pacote.revision,
        revision_nodo: snapshot.rules_revision,
        comparacao,
      });

      if (simulacoes.get(deviceId) !== assinatura) {
        simulacoes.set(deviceId, assinatura);
        log.info(contexto, "[SYNC][SIMULACAO] Sincronização necessária");
      }

      return false;
    }

    const falha = falhas.get(deviceId);

    if (
      falha?.revision === pacote.revision &&
      Date.now() - falha.quando < retryMs
    ) {
      return false;
    }

    // Sincronização > instalar o conjunto completo, inclusive exclusões.
    await enviar({ deviceId, pacote });

    // Confirmação > verificar o conteúdo efetivamente instalado.
    const confirmado = (await consultar(deviceId)).snapshot;
    validarSnapshot(deviceId, confirmado);

    const conferido = compararRegrasLocais(pacote.regras, confirmado.regras);

    if (
      confirmado.rules_revision !== pacote.revision ||
      conferido.situacao !== "IGUAL"
    ) {
      throw new Error(`Full ${deviceId} não confirmou o conjunto enviado`);
    }

    falhas.delete(deviceId);
    simulacoes.delete(deviceId);

    log.info(
      contexto,
      `[SYNC][OK] ${deviceId}: ${pacote.regras.length} regras instaladas`,
    );

    // Se o cadastro mudou durante o PUT, repetir com a revisão atual.
    return pacoteDesejado(deviceId).revision !== pacote.revision;
  }

  function solicitar(deviceId, snapshot = null) {
    if (encerrando || modo === "off") return Promise.resolve();

    const id = deviceId?.toUpperCase();

    if (!id || (filtroNodo && filtroNodo !== id)) return Promise.resolve();

    const node = nodes.buscar(id);

    if (!node?.enabled || node.api?.toUpperCase() !== "FULL")
      return Promise.resolve();

    const existente = tarefas.get(id);

    if (existente) {
      existente.repetir = true;
      return existente.promessa;
    }

    const registro = {
      repetir: false,
      promessa: null,
    };

    // Por nodo > nunca executar dois PUTs simultaneamente.
    const tarefa = (async () => {
      let atual = snapshot;

      for (let tentativa = 0; tentativa < 3; tentativa++) {
        registro.repetir = false;

        const mudou = await verificar(id, atual);

        if (!mudou && !registro.repetir) return;

        // Reavalia com um snapshot novo, não com o anterior ao PUT.
        atual = null;
      }

      log.warn(
        { module: "RULES", device_id: id },
        "[SYNC] Novas alterações pendentes; próxima verificação irá tratar",
      );
    })()
      .catch((err) => {
        let revision = null;

        try {
          revision = pacoteDesejado(id).revision;
        } catch {
          // Falha de montagem já será registrada no log abaixo.
        }

        falhas.set(id, {
          quando: Date.now(),
          revision,
        });

        log.warn(
          { module: "RULES", device_id: id, err },
          "[SYNC][FALHA] Regras locais não sincronizadas",
        );
      })
      .finally(() => tarefas.delete(id));

    registro.promessa = tarefa;
    tarefas.set(id, registro);

    return tarefa;
  }

  async function parar() {
    encerrando = true;
    await Promise.allSettled([...tarefas.values()].map((t) => t.promessa));
  }

  return { solicitar, parar };
}
