import { criarGroupRepository } from "../repositories/groupRepository.js";
import {
  criarGroupService,
  GroupCommandError,
} from "../services/groupService.js";

const groupIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z][A-Za-z0-9_]*$",
};

const nomeSchema = {
  type: "string",
  minLength: 1,
  maxLength: 100,
};

const descricaoSchema = {
  type: "string",
  maxLength: 500,
};

const idParams = {
  type: "object",
  required: ["group_id"],
  properties: { group_id: groupIdSchema },
};

const membroParams = {
  type: "object",
  required: ["group_id", "global_id"],
  properties: {
    group_id: groupIdSchema,
    global_id: groupIdSchema,
  },
};

function erroAssociacao(reply, codigo) {
  const mensagens = {
    GROUP_NOT_FOUND: "Grupo não encontrado",
    RESOURCE_NOT_FOUND: "Recurso global não encontrado",
    MEMBER_NOT_FOUND: "Recurso não pertence ao grupo",
  };

  return reply.code(404).send({
    detail: mensagens[codigo],
  });
}

export default async function groupsRoutes(
  app,
  { db, comandos, permitirComandos = false },
) {
  const groups = criarGroupRepository(db);
  const groupCommands = criarGroupService({
    groups,
    comandos,
    permitirComandos,
    log: app.log,
  });

  // GET /api/groups
  app.get("/api/groups", () => groups.listar());

  // POST /api/groups/:group_id/commands
  app.post(
    "/api/groups/:group_id/commands",
    {
      schema: {
        params: idParams,
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
        return await groupCommands.executar(
          request.params.group_id,
          request.body.command,
        );
      } catch (erro) {
        if (!(erro instanceof GroupCommandError)) throw erro;

        return reply.code(erro.statusCode).send({
          ok: false,
          code: erro.code,
          detail: erro.message,
        });
      }
    },
  );

  // POST /api/groups
  app.post(
    "/api/groups",
    {
      schema: {
        body: {
          type: "object",
          required: ["group_id"],
          additionalProperties: false,
          properties: {
            group_id: groupIdSchema,
            nome: nomeSchema,
            descricao: descricaoSchema,
          },
        },
      },
    },
    (request, reply) => {
      const { group_id, nome, descricao } = request.body;

      if (nome !== undefined && !nome.trim()) {
        return reply.code(400).send({
          detail: "Nome não pode ser vazio",
        });
      }

      const grupo = groups.criar({
        group_id,
        nome: nome?.trim() ?? group_id.toUpperCase(),
        descricao: descricao?.trim() ?? "",
      });

      if (!grupo) {
        return reply.code(409).send({
          detail: "Grupo já cadastrado",
        });
      }

      return reply.code(201).send(grupo);
    },
  );

  // GET /api/groups/:group_id
  app.get(
    "/api/groups/:group_id",
    {
      schema: { params: idParams },
    },
    (request, reply) => {
      return (
        groups.buscar(request.params.group_id) ??
        reply.code(404).send({
          detail: "Grupo não encontrado",
        })
      );
    },
  );

  // PATCH /api/groups/:group_id
  app.patch(
    "/api/groups/:group_id",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            nome: nomeSchema,
            descricao: descricaoSchema,
          },
        },
      },
    },
    (request, reply) => {
      const alteracoes = { ...request.body };

      if (alteracoes.nome !== undefined) {
        alteracoes.nome = alteracoes.nome.trim();

        if (!alteracoes.nome) {
          return reply.code(400).send({
            detail: "Nome não pode ser vazio",
          });
        }
      }

      if (alteracoes.descricao !== undefined) {
        alteracoes.descricao = alteracoes.descricao.trim();
      }

      return (
        groups.atualizar(request.params.group_id, alteracoes) ??
        reply.code(404).send({
          detail: "Grupo não encontrado",
        })
      );
    },
  );

  // DELETE /api/groups/:group_id
  app.delete(
    "/api/groups/:group_id",
    {
      schema: { params: idParams },
    },
    (request, reply) => {
      if (!groups.excluir(request.params.group_id)) {
        return reply.code(404).send({
          detail: "Grupo não encontrado",
        });
      }

      return reply.code(204).send();
    },
  );

  // PUT /api/groups/:group_id/resources/:global_id
  app.put(
    "/api/groups/:group_id/resources/:global_id",
    {
      schema: { params: membroParams },
    },
    (request, reply) => {
      const { group_id, global_id } = request.params;

      const resultado = groups.adicionarRecurso(group_id, global_id);

      if (resultado.erro) {
        return erroAssociacao(reply, resultado.erro);
      }

      return reply.code(resultado.added ? 201 : 200).send(resultado);
    },
  );

  // DELETE /api/groups/:group_id/resources/:global_id
  app.delete(
    "/api/groups/:group_id/resources/:global_id",
    {
      schema: { params: membroParams },
    },
    (request, reply) => {
      const { group_id, global_id } = request.params;

      const resultado = groups.removerRecurso(group_id, global_id);

      if (resultado.erro) {
        return erroAssociacao(reply, resultado.erro);
      }

      return reply.code(204).send();
    },
  );
}
