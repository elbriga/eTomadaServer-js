import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";
import { consultarSnapshot, NodeClientError } from "../devices/nodeClient.js";

export function criarNodeMonitor({
  db,
  log,
  intervaloMs = 30_000,
  timeoutMs = 2_000,
  concorrencia = 4,
  falhasOffline = 2,
  checkpointMs = 300_000,
}) {
  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);
  const estados = new Map();
  const pendentes = new Map();

  let ativo = false;
  let timer = null;
  let rodadaAtual = null;

  const agora = () => Math.floor(Date.now() / 1000);

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
      });
    }
    return estados.get(deviceId);
  }

  function visualizar(node, incluirSnapshot = false) {
    const s = estados.get(node.device_id);

    return {
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

  async function executarConsulta(deviceId) {
    const s = estado(deviceId);
    const revisaoInicial = s.revisaoPush;
    s.last_poll_at = agora();

    let resultado;

    try {
      resultado = await consultarSnapshot(deviceId, timeoutMs);
    } catch (erro) {
      // Um POST mais recente já confirmou o nodo online.
      // Não deixar um GET antigo alterar esse estado.
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
        if (nodes.buscar(deviceId)?.enabled) {
          log.warn({ device_id: deviceId, erro: erro.message }, "Nodo OFFLINE");
        }
      }

      throw erro;
    }

    // O POST recebido durante o GET tem prioridade.
    if (s.revisaoPush !== revisaoInicial || estados.get(deviceId) !== s) {
      return { ...resultado, desatualizado: true };
    }

    // Descobre/atualiza metadados dos recursos locais do nodo.
    // Não grava estados físicos nesta etapa.
    resources.descobrir(deviceId, resultado.snapshot.recursos);

    const anterior = s.status;
    s.status = "online";
    s.falhas = 0;
    s.last_error = null;
    s.last_seen_at = agora();
    s.duracao_ms = resultado.duracao_ms;
    s.snapshot = resultado.snapshot;
    s.origem = "poll";

    const node = nodes.buscar(deviceId);

    if (node?.enabled && anterior !== "online") {
      log.info(
        { device_id: deviceId, duracao_ms: resultado.duracao_ms },
        anterior === "offline" ? "Nodo RECONECTADO" : "Nodo ONLINE",
      );
    }

    // Checkpoint periódico: evita escrever no SQLite a cada polling.
    if (
      node?.enabled &&
      (!node.last_snapshot_at ||
        Date.now() - node.last_snapshot_at * 1000 >= checkpointMs)
    ) {
      nodes.salvarSnapshot(deviceId, resultado.snapshot);
    }

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
      log.warn(
        { device_id: deviceId },
        "Snapshot recebido de nodo não cadastrado",
      );
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

    if (node.enabled && anterior !== "online") {
      log.info(
        {
          device_id: node.device_id,
          origem: "POST /api/snapshot",
        },
        anterior === "offline" ? "Nodo RECONECTADO" : "Nodo ONLINE",
      );
    }

    return true;
  }

  return {
    consultar,
    receberSnapshot,

    listarStatus() {
      return nodes.listar().map((node) => visualizar(node));
    },

    obterStatus(deviceId) {
      const node = nodes.buscar(deviceId);
      return node ? visualizar(node, true) : null;
    },

    resetar(deviceId) {
      estados.delete(deviceId.toUpperCase());
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
    },
  };
}
