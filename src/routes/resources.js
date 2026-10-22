import { criarResourceRepository } from "../repositories/resourceRepository.js";

export default async function resourcesRoutes(app, { db, monitor }) {
  const resources = criarResourceRepository(db);

  // POST /api/snapshot
  app.post(
    "/api/snapshot",
    {
      schema: {
        body: {
          type: "object",
          required: ["device_id", "recursos"],
          properties: {
            device_id: {
              type: "string",
              minLength: 1,
              maxLength: 32,
            },
            recursos: {
              type: "array",
              items: {
                type: "object",
                required: ["id"],
                properties: {
                  id: {
                    type: "string",
                    minLength: 1,
                    maxLength: 32,
                  },
                  nome: {
                    type: "string",
                    maxLength: 32,
                    default: "",
                  },
                  tipo: {
                    type: "string",
                    maxLength: 16,
                    default: "",
                  },
                },
              },
            },
          },
        },
      },
    },
    (request) => {
      const { device_id, recursos } = request.body;

      resources.descobrir(device_id, recursos);

      // Atualiza o monitor com o snapshot espontâneo.
      // Não realiza uma nova requisição HTTP ao nodo.
      monitor.receberSnapshot(request.body);

      return {
        ok: true,
        device_id,
        recursos: recursos.length,
      };
    },
  );

  const idSchema = {
    type: "string",
    minLength: 1,
    maxLength: 32,
  };

  const globalIdSchema = {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z][A-Za-z0-9_]*$",
  };

  // GET /api/resources
  app.get("/api/resources", () => resources.listar());

  // GET /api/resources/:global_id
  app.get(
    "/api/resources/:global_id",
    {
      schema: {
        params: {
          type: "object",
          required: ["global_id"],
          properties: { global_id: globalIdSchema },
        },
      },
    },
    (request, reply) => {
      return (
        resources.buscarGlobal(request.params.global_id) ??
        reply.code(404).send({
          detail: "Recurso não encontrado",
        })
      );
    },
  );

  // GET /api/nodes/:device_id/resources
  app.get(
    "/api/nodes/:device_id/resources",
    {
      schema: {
        params: {
          type: "object",
          required: ["device_id"],
          properties: { device_id: idSchema },
        },
      },
    },
    (request) => resources.listar(request.params.device_id),
  );

  // PATCH /api/nodes/:device_id/resources/:recurso_id
  app.patch(
    "/api/nodes/:device_id/resources/:recurso_id",
    {
      schema: {
        params: {
          type: "object",
          required: ["device_id", "recurso_id"],
          properties: {
            device_id: idSchema,
            recurso_id: idSchema,
          },
        },
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            global_id: {
              anyOf: [globalIdSchema, { type: "null" }],
            },
            nome_configurado: {
              type: "string",
              maxLength: 100,
            },
            descricao: {
              type: "string",
              maxLength: 500,
            },
          },
        },
      },
    },
    (request, reply) => {
      const { device_id, recurso_id } = request.params;

      try {
        return (
          resources.atualizar(device_id, recurso_id, request.body) ??
          reply.code(404).send({
            detail: "Recurso não encontrado",
          })
        );
      } catch (erro) {
        if (
          erro.message?.includes(
            "UNIQUE constraint failed: resources.global_id",
          )
        ) {
          return reply.code(409).send({
            detail: "global_id já utilizado",
          });
        }
        throw erro;
      }
    },
  );
}
