import { criarRuleService, RuleError } from "../services/ruleService.js";

const deviceIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 32,
};

const idParams = {
  type: "object",
  required: ["id"],
  properties: {
    id: {
      type: "integer",
      minimum: 1,
      maximum: 65535,
    },
  },
};

const propriedades = {
  nome: { type: "string", minLength: 1, maxLength: 100 },
  ativa: { type: "boolean" },
  escopo: { type: "string", enum: ["GLOBAL", "LOCAL"] },
  device_id: {
    anyOf: [deviceIdSchema, { type: "null" }],
  },
  quando: { type: "object" },
  acao: { type: "object" },
};

const camposObrigatorios = ["nome", "ativa", "escopo", "quando", "acao"];

const criarBody = {
  type: "object",
  additionalProperties: false,
  required: ["nome", "escopo", "quando", "acao"],
  properties: propriedades,
};

const atualizarBody = {
  type: "object",
  additionalProperties: false,
  required: [...camposObrigatorios, "revision"],
  properties: {
    ...propriedades,
    revision: {
      type: "integer",
      minimum: 1,
    },
  },
};

function responder(reply, operacao) {
  try {
    return operacao();
  } catch (erro) {
    if (!(erro instanceof RuleError)) throw erro;

    return reply.code(erro.statusCode).send({
      detail: erro.message,
    });
  }
}

export default async function rulesRoutes(app, { db }) {
  const rules = criarRuleService(db);

  app.get(
    "/api/rules",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            escopo: {
              type: "string",
              enum: ["GLOBAL", "LOCAL"],
            },
            device_id: deviceIdSchema,
          },
        },
      },
    },
    (request) => rules.listar(request.query),
  );

  app.get(
    "/api/rules/:id",
    { schema: { params: idParams } },
    (request, reply) => {
      return (
        rules.buscar(request.params.id) ??
        reply.code(404).send({
          detail: "Regra não encontrada",
        })
      );
    },
  );

  app.post("/api/rules", { schema: { body: criarBody } }, (request, reply) =>
    responder(reply, () => {
      const regra = rules.criar(request.body);
      return reply.code(201).send(regra);
    }),
  );

  app.put(
    "/api/rules/:id",
    {
      schema: {
        params: idParams,
        body: atualizarBody,
      },
    },
    (request, reply) =>
      responder(reply, () => rules.atualizar(request.params.id, request.body)),
  );

  app.delete(
    "/api/rules/:id",
    { schema: { params: idParams } },
    (request, reply) => {
      if (!rules.excluir(request.params.id)) {
        return reply.code(404).send({
          detail: "Regra não encontrada",
        });
      }

      return reply.code(204).send();
    },
  );
}
