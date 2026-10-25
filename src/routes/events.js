import { criarResourceRepository } from "../repositories/resourceRepository.js";
import { criarCommandRepository } from "../repositories/commandRepository.js";

export default async function eventsRoutes(
  app,
  { db, monitor, ruleEngine = null },
) {
  let ativo = true;
  const tarefas = new Set();

  app.addHook("onClose", async () => {
    ativo = false;
    await Promise.allSettled([...tarefas]);
  });

  const resources = criarResourceRepository(db);
  const commands = criarCommandRepository(db);

  const insertEvent = db.prepare(`
    INSERT INTO events (
      timestamp, device_id, recurso_id, evento,
      ip, valor, status, estado, estado2
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // POST /api/evento
  app.post(
    "/api/evento",
    {
      schema: {
        body: {
          type: "object",
          required: ["origem", "id", "evento", "device"],
          properties: {
            origem: { type: "string" },
            id: { type: "string" },
            evento: { type: "string" },
            device: {
              type: "object",
              properties: {
                valor: { type: "number", nullable: true },
                status: { type: "string" },
                estado: { type: "integer", nullable: true },
                estadoFan: { type: "integer", nullable: true },
              },
            },
          },
        },
      },
    },
    (request) => {
      const event = request.body;
      const device = event.device;

      const timestamp = Math.floor(Date.now() / 1000);

      let estadoAnterior = null;

      if (ruleEngine && event.evento?.toUpperCase() === "TOGGLE") {
        const anterior = resources.buscar(event.origem, event.id);

        try {
          const estado = JSON.parse(anterior?.reported_json ?? "null")?.estado;

          if (estado === true || estado === 1) estadoAnterior = 1;
          else if (estado === false || estado === 0) estadoAnterior = 0;
        } catch {
          // Estado desconhecido; o evento ainda será processado.
        }
      }

      let id;
      let atualizado = false;

      db.exec("BEGIN IMMEDIATE");
      try {
        const result = insertEvent.run(
          timestamp,
          event.origem,
          event.id,
          event.evento,
          request.ip,
          device.valor ?? null,
          device.status ?? "",
          device.estado ?? null,
          device.estadoFan ?? null,
        );

        id = Number(result.lastInsertRowid);

        // Atualização parcial, sem criar recursos desconhecidos.
        atualizado = resources.aplicarEvento(event.origem, event.id, device);

        db.exec("COMMIT");
      } catch (erro) {
        db.exec("ROLLBACK");
        throw erro;
      }

      // Impede que um GET antigo sobrescreva o evento.
      if (atualizado) {
        monitor.receberEvento(event.origem);
        commands.reconciliar(event.origem, event.id, device.estado, "event");
      }

      // Relé desligado fisicamente > cancelar desligamento agendado.
      if (
        atualizado &&
        (device.estado === false || device.estado === 0) &&
        resources.buscar(event.origem, event.id)?.tipo === "RELE"
      ) {
        ruleEngine?.cancelarTimerFisico(event.origem, event.id);
      }

      // Motor global: processamento separado do recebimento HTTP.
      if (ruleEngine) {
        setImmediate(() => {
          if (!ativo) return;

          const tarefa = Promise.resolve()
            .then(() => ruleEngine.processarEvento(event, estadoAnterior))
            .catch((erro) => {
              app.log.error(
                { module: "RULES", err: erro },
                "Falha ao processar evento no motor de regras",
              );
            })
            .finally(() => tarefas.delete(tarefa));

          tarefas.add(tarefa);
        });
      }

      return { ok: true, id };
    },
  );

  // GET /api/history
  app.get(
    "/api/history",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["origem", "recurso"],
          properties: {
            origem: { type: "string" },
            recurso: { type: "string" },
            start: { type: "integer" },
            end: { type: "integer" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100000,
              default: 10000,
            },
          },
        },
      },
    },
    (request) => {
      const { origem, recurso, start, end, limit } = request.query;

      let sql = `
      SELECT
        id,
        timestamp,
        device_id,
        recurso_id,
        evento,
        valor,
        status,
        estado,
        estado2
      FROM events
      WHERE device_id = ?
        AND recurso_id = ?
    `;

      const params = [origem, recurso];

      if (start != null) {
        sql += " AND timestamp >= ?";
        params.push(start);
      }

      if (end != null) {
        sql += " AND timestamp <= ?";
        params.push(end);
      }

      sql += " ORDER BY timestamp ASC, id ASC LIMIT ?";
      params.push(limit);

      return db.prepare(sql).all(...params);
    },
  );

  // GET /api/history/resources
  const selectResources = db.prepare(`
    SELECT
      e.device_id,
      e.recurso_id,
      COALESCE(r.nome, '') AS nome,
      COALESCE(r.tipo, '') AS tipo,
      MAX(e.valor IS NOT NULL) AS has_valor,
      MAX(e.estado IS NOT NULL) AS has_estado,
      MAX(e.estado2 IS NOT NULL) AS has_estado2
    FROM events e
    LEFT JOIN resources r
      ON r.device_id = e.device_id
     AND r.recurso_id = e.recurso_id
    GROUP BY
      e.device_id,
      e.recurso_id,
      r.nome,
      r.tipo
    ORDER BY e.device_id, e.recurso_id
  `);

  app.get("/api/history/resources", () => {
    return selectResources.all();
  });
}
