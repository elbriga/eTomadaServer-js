import { performance } from "node:perf_hooks";

import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import {
  consultarSnapshot,
  consultarStatusRecovery,
  reiniciarRecovery,
  NodeClientError,
} from "../devices/nodeClient.js";
import { criarCommandRepository } from "../repositories/commandRepository.js";
import { criarRecoveryRepository } from "../repositories/recoveryRepository.js";
import { criarPendingNodeRepository } from "../repositories/pendingNodeRepository.js";
import { classificarUptime } from "./nodeUptime.js";
import { telegramEnviar } from "./telegramService.js";

export function criarNodeMonitor({
  db,
  log,
  aoReiniciar = null,
  aoSnapshot = null,
  aoAtualizar = null,
  intervaloMs = 30_000,
  timeoutMs = 2_000,
  autoRebootRecovery = false,
  nodoRebootRecovery = null,
  concorrencia = 4,
  falhasOffline = 2,
  checkpointMs = 300_000,
}) {
  // Nodos autorizados a enviar alertas ao Telegram.
  const telegramNodes = new Set(
    (process.env.TELEGRAM_NODES_ALERT ?? "")
      .split(",")
      .map((id) => id.trim().toUpperCase())
      .filter(Boolean),
  );

  function telegramEnviarNodo(deviceId, mensagem) {
    if (telegramNodes.has(deviceId.toUpperCase())) {
      telegramEnviar(`[${deviceId}] ${mensagem}`);
    }
  }

  const nodes = criarNodeRepository(db);
  const novos = criarPendingNodeRepository(db);
  const resources = criarResourceRepository(db);
  const commands = criarCommandRepository(db);
  const recovery = criarRecoveryRepository(db);
  const estados = new Map();
  const pendentes = new Map();
  const reconciliacoesBoot = new Set();

  let ativo = false;
  let timer = null;
  let rodadaAtual = null;

  const agora = () => Math.floor(Date.now() / 1000);

  // Notifica alterações sem interferir no monitoramento
  function avisarAtualizacao(deviceId) {
    try {
      aoAtualizar?.({ deviceId });
    } catch (err) {
      log.warn(
        { module: "NODES", device_id: deviceId, err },
        "Falha ao notificar atualização do nodo",
      );
    }
  }

  function estado(deviceId) {
    if (!estados.has(deviceId)) {
      estados.set(deviceId, {
        status: "unknown",
        falhas: 0,
        last_poll_at: null,
        last_seen_at: null,
        duracao_ms: null,
        last_error: null,
        snapshot: null,
        origem: null,
        revisaoPush: 0,
        ultimaObservacaoUptime: null,
      });
    }
    return estados.get(deviceId);
  }

  function observarUptime(deviceId, snapshot, origem) {
    const s = estado(deviceId);

    const atual = {
      uptime: snapshot.uptime,
      instanteMs: performance.now(),
    };

    const resultado = classificarUptime(s.ultimaObservacaoUptime, atual);

    // Snapshot espontâneo do Full > sinal explícito de boot.
    const bootPush =
      origem === "push" &&
      Number.isInteger(snapshot.uptime) &&
      snapshot.uptime >= 0 &&
      snapshot.uptime < 2 ** 32;

    if (resultado === "indeterminado" && !bootPush) {
      // Descartamos a referência antiga em vez de
      // produzir uma conclusão sobre um intervalo incerto.
      s.ultimaObservacaoUptime = null;
      return;
    }

    s.ultimaObservacaoUptime = atual;

    if (!bootPush && resultado !== "reiniciou") return;

    log.warn(
      {
        module: "NODES",
        device_id: deviceId,
        uptime: atual.uptime,
        origem,
      },
      bootPush
        ? "Boot informado pelo snapshot"
        : "Reinicialização de nodo detectada",
    );

    // Executa a reconciliação e acompanha operações assíncronas.
    try {
      const resultado = aoReiniciar?.({ deviceId, snapshot, origem });

      if (resultado && typeof resultado.then === "function") {
        const tarefa = Promise.resolve(resultado)
          .catch((err) => {
            log.error(
              { module: "RULES", err, device_id: deviceId },
              "Falha na reconciliação após reboot",
            );
          })
          .finally(() => reconciliacoesBoot.delete(tarefa));

        reconciliacoesBoot.add(tarefa);
      }
    } catch (err) {
      log.error(
        { module: "RULES", err, device_id: deviceId },
        "Falha na reconciliação após reboot",
      );
    }
  }

  function visualizar(node, incluirSnapshot = false) {
    const s = estados.get(node.device_id);

    return {
      recovery: recovery.obter(node.device_id),
      device_id: node.device_id,
      nome: node.nome,
      enabled: node.enabled,
      status: node.enabled ? (s?.status ?? "unknown") : "disabled",
      falhas_consecutivas: s?.falhas ?? 0,
      last_poll_at: s?.last_poll_at ?? null,
      last_seen_at: s?.last_seen_at ?? null,
      duracao_ms: s?.duracao_ms ?? null,
      last_error: s?.last_error ?? null,
      origem: s?.origem ?? null,
      ...(incluirSnapshot ? { snapshot: s?.snapshot ?? null } : {}),
    };
  }

  function confirmarBootEstavel(deviceId, snapshot) {
    // Nunca liberar nova tentativa com um boot ainda sujeito ao recovery.
    if (
      Number.isInteger(snapshot.uptime) &&
      snapshot.uptime >= 35_000 &&
      snapshot.uptime < 2 ** 32 &&
      recovery.limpar(deviceId)
    ) {
      log.info(
        { module: "NODES", device_id: deviceId },
        "Recovery encerrado: boot estável",
      );
    }
  }

  async function detectarRecovery(deviceId, s, revisaoInicial) {
    const info = await consultarStatusRecovery(deviceId, timeoutMs);
    if (!info) return false;

    const node = nodes.buscar(deviceId);
    if (
      !node?.enabled ||
      s.revisaoPush !== revisaoInicial ||
      estados.get(deviceId) !== s
    )
      return false;

    // Firmware atualizado informa MAC: impede reboot por DNS desatualizado.
    const normalizarMac = (mac) =>
      String(mac)
        .replace(/[^a-fA-F0-9]/g, "")
        .toUpperCase();
    if (
      info.mac &&
      node.mac &&
      normalizarMac(info.mac) !== normalizarMac(node.mac)
    ) {
      log.warn(
        { module: "NODES", device_id: deviceId },
        "Recovery com MAC divergente",
      );
      return false;
    }
    if (
      info.device_id != null &&
      (typeof info.device_id !== "string" ||
        info.device_id.toUpperCase() !== deviceId)
    ) {
      log.warn(
        { module: "NODES", device_id: deviceId },
        "Recovery com device_id divergente",
      );
      return false;
    }

    const anterior = recovery.obter(deviceId);
    recovery.registrar(deviceId);
    s.status = "recovery";
    s.falhas = 0;
    s.last_seen_at = agora();
    s.last_error = null;
    s.duracao_ms = null;
    s.origem = "recovery";

    avisarAtualizacao(deviceId);

    if (!anterior) {
      log.warn({ module: "NODES", device_id: deviceId }, "Nodo em RECOVERY");
      telegramEnviarNodo(deviceId, "em RECOVERY!");
    }

    if (
      !autoRebootRecovery ||
      (nodoRebootRecovery && nodoRebootRecovery !== deviceId) ||
      !["Full", "Lite"].includes(node.api)
    )
      return true;

    // Grava ANTES do HTTP: timeout ou reinício do servidor não repetem a ação.
    if (!recovery.marcarTentativa(deviceId)) return true;
    try {
      await reiniciarRecovery(deviceId, timeoutMs);
      log.warn(
        { module: "NODES", device_id: deviceId },
        "Reboot automático de recovery enviado",
      );
    } catch (erro) {
      recovery.registrarErro(deviceId, erro.message);
      log.warn(
        { module: "NODES", device_id: deviceId, err: erro },
        "Reboot de recovery sem confirmação; não será repetido",
      );
    }
    return true;
  }

  async function executarConsulta(deviceId) {
    const s = estado(deviceId);
    const revisaoInicial = s.revisaoPush;
    s.last_poll_at = agora();

    let resultado;

    try {
      resultado = await consultarSnapshot(deviceId, timeoutMs);
    } catch (erro) {
      if (
        erro.code === "HTTP_ERROR" &&
        erro.httpStatus === 404 &&
        (await detectarRecovery(deviceId, s, revisaoInicial))
      ) {
        throw new NodeClientError("Nodo em modo recovery", "RECOVERY", 503);
      }
      // Uma atualização espontânea mais recente invalida este GET
      // Não deixar um GET antigo alterar esse estado
      if (s.revisaoPush !== revisaoInicial || estados.get(deviceId) !== s) {
        throw erro;
      }

      s.falhas++;
      s.last_error = {
        code: erro.code ?? "ERROR",
        detail: erro.message,
      };
      s.duracao_ms = null;

      if (s.falhas >= falhasOffline && s.status !== "offline") {
        s.status = "offline";
        avisarAtualizacao(deviceId);
        if (nodes.buscar(deviceId)?.enabled) {
          log.warn({ device_id: deviceId, erro: erro.message }, "Nodo OFFLINE");
          telegramEnviarNodo(deviceId, `OFFLINE!! [${erro.message}]`);
        }
      }

      throw erro;
    }

    // POSTs de snapshot e eventos recebidos durante o GET têm prioridade
    if (s.revisaoPush !== revisaoInicial || estados.get(deviceId) !== s) {
      return { ...resultado, desatualizado: true };
    }

    // Descobre/atualiza metadados dos recursos locais do nodo.
    // Não grava estados físicos nesta etapa.
    resources.descobrir(deviceId, resultado.snapshot.recursos);

    for (const recurso of resultado.snapshot.recursos ?? []) {
      if (recurso.remoto === true) continue;

      commands.reconciliar(
        deviceId,
        recurso.id,
        recurso.device?.estado,
        "poll",
      );
    }

    const anterior = s.status;
    s.status = "online";
    s.falhas = 0;
    s.last_error = null;
    s.last_seen_at = agora();
    s.duracao_ms = resultado.duracao_ms;
    s.snapshot = resultado.snapshot;
    s.origem = "poll";

    confirmarBootEstavel(deviceId, resultado.snapshot);
    observarUptime(deviceId, resultado.snapshot, "poll");

    // Snapshot aceito > verificar configuração local do Full.
    aoSnapshot?.({
      deviceId,
      snapshot: resultado.snapshot,
      origem: "poll",
    });

    const node = nodes.buscar(deviceId);

    if (node?.enabled && anterior !== "online") {
      const msg = anterior === "offline" ? "RECONECTADO" : "ONLINE";
      log.info({ device_id: deviceId, duracao_ms: resultado.duracao_ms }, msg);
      telegramEnviarNodo(deviceId, msg);
    }

    // Checkpoint periódico: evita escrever no SQLite a cada polling.
    if (
      node?.enabled &&
      (!node.last_snapshot_at ||
        Date.now() - node.last_snapshot_at * 1000 >= checkpointMs)
    ) {
      nodes.salvarSnapshot(deviceId, resultado.snapshot);
    }

    avisarAtualizacao(deviceId);

    return resultado;
  }

  // Uma única consulta HTTP por nodo, mesmo com múltiplos solicitantes.
  async function consultar(deviceId, { persistir = false } = {}) {
    const node = nodes.buscar(deviceId);

    if (!node) {
      throw new NodeClientError("Nodo não cadastrado", "NODE_NOT_FOUND", 404);
    }

    const id = node.device_id;
    let tarefa = pendentes.get(id);

    if (!tarefa) {
      tarefa = executarConsulta(id);
      pendentes.set(id, tarefa);

      void tarefa.then(
        () => pendentes.delete(id),
        () => pendentes.delete(id),
      );
    }

    const resultado = await tarefa;

    // Consultas manuais podem exigir persistência imediata.
    if (persistir && !resultado.desatualizado) {
      nodes.salvarSnapshot(id, resultado.snapshot);
    }

    return resultado;
  }

  async function rodada() {
    const habilitados = nodes.listar().filter((node) => node.enabled);
    let proximo = 0;

    async function trabalhador() {
      while (ativo && proximo < habilitados.length) {
        const node = habilitados[proximo++];

        // Pode ter sido desabilitado durante a rodada.
        if (!nodes.buscar(node.device_id)?.enabled) continue;

        try {
          await consultar(node.device_id);
        } catch (erro) {
          if (!(erro instanceof NodeClientError)) {
            log.error(
              { err: erro, device_id: node.device_id },
              "Erro no monitor",
            );
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concorrencia, habilitados.length) }, () =>
        trabalhador(),
      ),
    );
  }

  // Agenda a próxima rodada somente após terminar a anterior.
  function agendar(delay) {
    timer = setTimeout(() => {
      timer = null;

      rodadaAtual = rodada()
        .catch((erro) => {
          log.error({ err: erro }, "Erro na rodada de monitoramento");
        })
        .finally(() => {
          rodadaAtual = null;
          if (ativo) agendar(intervaloMs);
        });
    }, delay);
  }

  function receberSnapshot(snapshot) {
    const deviceId = snapshot.device_id.trim().toUpperCase();
    const node = nodes.buscar(deviceId);

    if (!node) {
      if (!/^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/.test(deviceId)) {
        log.warn({ device_id: deviceId }, "Device ID inválido no snapshot");
        return false;
      }

      // Novo nodo > guardar snapshot até confirmação administrativa.
      const novo = novos.registrar({ ...snapshot, device_id: deviceId });
      if (novo) {
        log.warn(
          { module: "NODES", device_id: deviceId },
          "Snapshot recebido de nodo não cadastrado: aguardando cadastro",
        );
      }

      avisarAtualizacao(deviceId);
      return false;
    }

    // Persiste imediatamente o snapshot de boot.
    // Se a gravação falhar, não altera o estado em memória.
    if (!nodes.salvarSnapshot(node.device_id, snapshot)) {
      return false;
    }

    const s = estado(node.device_id);
    const anterior = s.status;

    // Invalida resultados de GET iniciados antes deste POST.
    s.revisaoPush++;

    s.status = "online";
    s.falhas = 0;
    s.last_error = null;
    s.last_seen_at = agora();
    s.duracao_ms = null;
    s.snapshot = snapshot;
    s.origem = "push";

    confirmarBootEstavel(node.device_id, snapshot);
    observarUptime(node.device_id, snapshot, "push");

    // Snapshot espontâneo > verificar regras sem novo GET.
    aoSnapshot?.({
      deviceId: node.device_id,
      snapshot,
      origem: "push",
    });

    if (node.enabled && anterior !== "online") {
      const msg = anterior === "offline" ? "RECONECTADO" : "ONLINE";
      log.info(
        {
          device_id: node.device_id,
          origem: "POST /api/snapshot",
        },
        msg,
      );
      telegramEnviarNodo(node.device_id, msg);
    }

    avisarAtualizacao(node.device_id);

    return true;
  }

  function receberEvento(deviceId) {
    const node = nodes.buscar(deviceId);
    if (!node) return false;

    const s = estados.get(node.device_id);

    // Invalida um GET que começou antes do evento.
    if (s) s.revisaoPush++;

    return true;
  }

  // Cadastro aprovado > transferir snapshot sem simular novo BOOT.
  function cadastrarNodo(dados) {
    const pendente = novos.buscar(dados.device_id);
    let node;

    db.exec("BEGIN IMMEDIATE");
    try {
      node = nodes.criar(dados);

      if (node && pendente) {
        if (!nodes.salvarSnapshot(node.device_id, pendente.snapshot)) {
          throw new Error("Falha ao incorporar snapshot do novo nodo");
        }
        novos.excluir(node.device_id);
      }

      db.exec("COMMIT");
    } catch (erro) {
      db.exec("ROLLBACK");
      throw erro;
    }

    if (!node) return null;

    if (pendente) {
      // Descobre recursos depois de concluir o cadastro.
      try {
        resources.descobrir(node.device_id, pendente.snapshot.recursos ?? []);
      } catch (erro) {
        log.error(
          { module: "NODES", device_id: node.device_id, err: erro },
          "Falha ao descobrir recursos após cadastro",
        );
      }

      const s = estado(node.device_id);
      s.snapshot = pendente.snapshot;
      s.last_seen_at = pendente.last_seen_at;
      s.origem = "discovery";

      // Snapshot recente confirma presença sem criar evento de boot.
      if (node.enabled && agora() - pendente.last_seen_at <= 90) {
        s.status = "online";
        s.falhas = 0;
        s.last_error = null;
      }
    }

    avisarAtualizacao(node.device_id);
    return nodes.buscar(node.device_id);
  }

  return {
    consultar,
    receberSnapshot,
    receberEvento,
    cadastrarNodo,

    listarNovos() {
      return novos.listar();
    },

    listarStatus() {
      return nodes.listar().map((node) => visualizar(node));
    },

    obterStatus(deviceId) {
      const node = nodes.buscar(deviceId);
      return node ? visualizar(node, true) : null;
    },

    resetar(deviceId) {
      estados.delete(deviceId.toUpperCase());
      avisarAtualizacao(deviceId.toUpperCase());
    },

    iniciar() {
      if (ativo) return;
      ativo = true;

      log.info({ intervaloMs, timeoutMs, concorrencia }, "Monitor iniciado");

      agendar(0);
    },

    async parar() {
      ativo = false;

      if (timer) clearTimeout(timer);
      timer = null;

      if (rodadaAtual) await rodadaAtual;
      await Promise.allSettled([...pendentes.values()]);
      await Promise.allSettled([...reconciliacoesBoot]);
    },
  };
}
