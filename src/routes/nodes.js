import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { NodeClientError } from "../devices/nodeClient.js";

const deviceIdSchema = {
  type: "string",
  maxLength: 32,
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$",
};

const paramsSchema = {
  type: "object",
  required: ["device_id"],
  properties: { device_id: deviceIdSchema },
};

const camposEditaveis = {
  nome: { type: "string", maxLength: 100 },
  enabled: { type: "boolean" },
};

export default async function nodesRoutes(app, { db, monitor }) {
  const nodes = criarNodeRepository(db);

  // GET /api/nodes
  app.get("/api/nodes", () => nodes.listar());

  // Dados consolidados para o painel de nodos
  app.get("/api/nodes/overview", () => {
    const cadastrados = nodes
      .listarComSnapshot()
      .map(({ snapshot_json, ...node }) => {
        const estado = monitor.obterStatus(node.device_id);
        const snapshotSalvo = JSON.parse(snapshot_json ?? "null");

        return {
          ...node,
          status: estado?.status ?? (node.enabled ? "unknown" : "disabled"),
          recovery: estado?.recovery ?? null,
          last_seen_at: estado?.last_seen_at ?? node.last_seen_at,
          last_poll_at: estado?.last_poll_at ?? null,
          duracao_ms: estado?.duracao_ms ?? null,
          last_error: estado?.last_error ?? null,
          snapshot: estado?.snapshot ?? snapshotSalvo,
        };
      });

    return [...cadastrados, ...monitor.listarNovos()].sort((a, b) =>
      a.device_id.localeCompare(b.device_id, "pt-BR"),
    );
  });

  // GET /api/nodes/:device_id
  app.get(
    "/api/nodes/:device_id",
    { schema: { params: paramsSchema } },
    (request, reply) => {
      const node = nodes.buscar(request.params.device_id);

      return (
        node ??
        reply.code(404).send({
          detail: "Nodo não encontrado",
        })
      );
    },
  );

  // GET /api/nodes/status
  app.get("/api/nodes/status", () => monitor.listarStatus());

  // GET /api/nodes/:device_id/status
  app.get(
    "/api/nodes/:device_id/status",
    { schema: { params: paramsSchema } },
    (request, reply) => {
      const status = monitor.obterStatus(request.params.device_id);

      return (
        status ??
        reply.code(404).send({
          detail: "Nodo não encontrado",
        })
      );
    },
  );

  // POST /api/nodes
  app.post(
    "/api/nodes",
    {
      schema: {
        body: {
          type: "object",
          required: ["device_id"],
          additionalProperties: false,
          properties: {
            device_id: deviceIdSchema,
            ...camposEditaveis,
          },
        },
      },
    },
    (request, reply) => {
      const dados = {
        ...request.body,
        device_id: request.body.device_id.toUpperCase(),
        nome: request.body.nome?.trim() ?? "",
      };

      const node = monitor.cadastrarNodo(dados);

      if (!node) {
        return reply.code(409).send({
          detail: "Nodo já cadastrado",
        });
      }

      return reply.code(201).send(node);
    },
  );

  // PATCH /api/nodes/:device_id
  app.patch(
    "/api/nodes/:device_id",
    {
      schema: {
        params: paramsSchema,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: camposEditaveis,
        },
      },
    },
    (request, reply) => {
      const alteracoes = { ...request.body };

      if (alteracoes.nome !== undefined) {
        alteracoes.nome = alteracoes.nome.trim();
      }

      const anterior = nodes.buscar(request.params.device_id);
      const node = nodes.atualizar(request.params.device_id, alteracoes);

      if (node && anterior.enabled !== node.enabled) {
        monitor.resetar(node.device_id);
      }

      return (
        node ??
        reply.code(404).send({
          detail: "Nodo não encontrado",
        })
      );
    },
  );

  // DELETE /api/nodes/:device_id
  app.delete(
    "/api/nodes/:device_id",
    { schema: { params: paramsSchema } },
    (request, reply) => {
      if (!nodes.excluir(request.params.device_id)) {
        return reply.code(404).send({
          detail: "Nodo não encontrado",
        });
      }

      monitor.resetar(request.params.device_id);

      return reply.code(204).send();
    },
  );

  // GET /api/nodes/:device_id/snapshot
  app.get(
    "/api/nodes/:device_id/snapshot",
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const node = nodes.buscar(request.params.device_id);

      if (!node) {
        return reply.code(404).send({
          detail: "Nodo não cadastrado",
        });
      }

      try {
        const resultado = await monitor.consultar(node.device_id, {
          persistir: true,
        });

        return {
          ok: true,
          device_id: node.device_id,
          hostname: resultado.hostname,
          duracao_ms: resultado.duracao_ms,
          snapshot: resultado.snapshot,
        };
      } catch (erro) {
        if (!(erro instanceof NodeClientError)) throw erro;

        app.log.warn(
          {
            device_id: node.device_id,
            code: erro.code,
            message: erro.message,
          },
          "Falha ao consultar snapshot",
        );

        return reply.code(erro.statusCode).send({
          ok: false,
          device_id: node.device_id,
          code: erro.code,
          detail: erro.message,
        });
      }
    },
  );
}
