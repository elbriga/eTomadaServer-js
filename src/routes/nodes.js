import { criarNodeRepository } from "../repositories/nodeRepository.js";

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

export default async function nodesRoutes(app, { db }) {
  const nodes = criarNodeRepository(db);

  // GET /api/nodes
  app.get("/api/nodes", () => nodes.listar());

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

      const node = nodes.criar(dados);

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

      const node = nodes.atualizar(request.params.device_id, alteracoes);

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

      return reply.code(204).send();
    },
  );
}
