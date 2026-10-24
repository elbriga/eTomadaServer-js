import { criarRuleService, RuleError } from "../services/ruleService.js";
import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { NodeClientError } from "../devices/nodeClient.js";
import { compararRegrasLocais } from "../services/ruleSyncCompare.js";
import { montarPacoteRegrasLocais } from "../services/ruleSyncPayload.js";

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

export default async function rulesRoutes(app, { db, monitor }) {
  const rules = criarRuleService(db);
  const nodes = criarNodeRepository(db);

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

  // Regras locais > comparar SQLite com configuração ativa do Full.
  app.get(
    "/api/nodes/:device_id/rules/compare",
    {
      schema: {
        params: {
          type: "object",
          required: ["device_id"],
          properties: {
            device_id: deviceIdSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const node = nodes.buscar(request.params.device_id);

      if (!node)
        return reply.code(404).send({
          detail: "Nodo não cadastrado",
        });

      if (node.api?.toUpperCase() !== "FULL")
        return reply.code(400).send({
          detail: "Comparação disponível somente para nodos Full",
        });

      let resposta;

      try {
        resposta = await monitor.consultar(node.device_id);
      } catch (erro) {
        if (!(erro instanceof NodeClientError)) throw erro;

        return reply.code(erro.statusCode).send({
          detail: erro.message,
          code: erro.code,
        });
      }

      // Não comparar um GET invalidado por atualização mais recente.
      if (resposta.desatualizado)
        return reply.code(409).send({
          detail: "Snapshot desatualizado; repita a consulta",
        });

      const snapshot = resposta.snapshot;

      if (
        snapshot?.api?.toUpperCase() !== "FULL" ||
        snapshot?.device_id?.toUpperCase() !== node.device_id.toUpperCase() ||
        !Array.isArray(snapshot.regras)
      ) {
        return reply.code(502).send({
          detail: "Snapshot de regras inválido",
        });
      }

      const locais = rules.listar({
        escopo: "LOCAL",
        device_id: node.device_id,
      });

      let comparacao;

      try {
        comparacao = compararRegrasLocais(locais, snapshot.regras);
      } catch (erro) {
        app.log.warn(
          { module: "RULES", err: erro, device_id: node.device_id },
          "Falha ao comparar regras locais",
        );

        return reply.code(502).send({
          detail: "Não foi possível comparar as regras",
        });
      }

      return {
        device_id: node.device_id,
        uptime: snapshot.uptime,
        ...comparacao,
      };
    },
  );

  // Regras locais > conjunto autoritativo que será enviado ao Full.
  app.get(
    "/api/nodes/:device_id/rules/desired",
    {
      schema: {
        params: {
          type: "object",
          required: ["device_id"],
          properties: {
            device_id: deviceIdSchema,
          },
        },
      },
    },
    (request, reply) => {
      const node = nodes.buscar(request.params.device_id);

      if (!node)
        return reply.code(404).send({
          detail: "Nodo não cadastrado",
        });

      if (node.api?.toUpperCase() !== "FULL")
        return reply.code(400).send({
          detail: "Sincronização disponível somente para nodos Full",
        });

      const locais = rules.listar({
        escopo: "LOCAL",
        device_id: node.device_id,
      });

      return montarPacoteRegrasLocais(node.device_id, locais);
    },
  );
}
