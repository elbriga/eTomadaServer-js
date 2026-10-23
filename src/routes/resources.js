import { criarResourceRepository } from "../repositories/resourceRepository.js";
import {
  criarResourceService,
  ResourceCommandError,
} from "../services/resourceService.js";
import { NodeClientError } from "../devices/nodeClient.js";
import { criarCommandRepository } from "../repositories/commandRepository.js";

export default async function resourcesRoutes(
  app,
  {
    db,
    monitor,
    permitirComandos = false,
    enviarComando,
    comandos: comandosCompartilhados,
  },
) {
  const resources = criarResourceRepository(db);
  const commandHistory = criarCommandRepository(db);
  const comandos =
    comandosCompartilhados ??
    criarResourceService({
      db,
      monitor,
      log: app.log,
      permitirComandos,
      enviarComando,
    });

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

      for (const recurso of recursos) {
        if (recurso.remoto === true) continue;

        commandHistory.reconciliar(
          device_id,
          recurso.id,
          recurso.device?.estado,
          "push",
        );
      }

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

  // GET /api/resources/:global_id/state
  app.get(
    "/api/resources/:global_id/state",
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
      const recurso = resources.buscarGlobal(request.params.global_id);

      if (!recurso) {
        return reply.code(404).send({
          detail: "Recurso não encontrado",
        });
      }

      const ultimo = commandHistory.ultimo(
        recurso.device_id,
        recurso.recurso_id,
      );

      const pendente =
        ultimo && ["pending", "uncertain"].includes(ultimo.status);

      return {
        global_id: recurso.global_id,
        device_id: recurso.device_id,
        recurso_id: recurso.recurso_id,

        reported: recurso.reported_json
          ? JSON.parse(recurso.reported_json)
          : null,
        reported_at: recurso.reported_at,

        desired: pendente
          ? {
              command_id: ultimo.id,
              command: ultimo.command,
              estado: ultimo.desired_state,
              status: ultimo.status,
            }
          : null,

        last_command: ultimo,
      };
    },
  );

  // POST /api/resources/:global_id/commands
  app.post(
    "/api/resources/:global_id/commands",
    {
      schema: {
        params: {
          type: "object",
          required: ["global_id"],
          properties: { global_id: globalIdSchema },
        },
        body: {
          type: "object",
          required: ["command"],
          additionalProperties: false,
          properties: {
            command: {
              type: "string",
              enum: ["ON", "OFF"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return await comandos.executar(
          request.params.global_id,
          request.body.command,
        );
      } catch (erro) {
        if (
          !(erro instanceof ResourceCommandError) &&
          !(erro instanceof NodeClientError)
        ) {
          throw erro;
        }

        app.log.warn(
          {
            module: "COMMAND",
            global_id: request.params.global_id,
            command: request.body.command,
            code: erro.code,
            erro: erro.message,
          },
          "Comando não confirmado",
        );

        return reply.code(erro.statusCode).send({
          ok: false,
          confirmed: false,
          command_id: erro.command_id ?? null,
          status: erro.execution_status ?? null,
          code: erro.code,
          detail: erro.message,
        });
      }
    },
  );

  // GET /api/resources/:global_id/commands
  app.get(
    "/api/resources/:global_id/commands",
    {
      schema: {
        params: {
          type: "object",
          required: ["global_id"],
          properties: { global_id: globalIdSchema },
        },
        querystring: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
          },
        },
      },
    },
    (request, reply) => {
      const recurso = resources.buscarGlobal(request.params.global_id);

      if (!recurso) {
        return reply.code(404).send({
          detail: "Recurso não encontrado",
        });
      }

      return commandHistory.listar(
        recurso.device_id,
        recurso.recurso_id,
        request.query.limit,
      );
    },
  );

  // GET /api/commands/:id
  app.get(
    "/api/commands/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    (request, reply) => {
      return (
        commandHistory.buscar(request.params.id) ??
        reply.code(404).send({
          detail: "Comando não encontrado",
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
