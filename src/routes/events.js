export default async function eventsRoutes(app, { db }) {
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

      return {
        ok: true,
        id: Number(result.lastInsertRowid),
      };
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
