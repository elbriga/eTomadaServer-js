import { criarLogRepository } from "../repositories/logRepository.js";

export default async function logsRoutes(app, { db, notificarLog }) {
  // POST /api/log
  const registrarLog = criarLogRepository(db, notificarLog);

  app.post(
    "/api/log",
    {
      schema: {
        body: {
          type: "object",
          required: ["deviceID", "level", "message"],
          properties: {
            deviceID: { type: "string" },
            level: { type: "integer" },
            module: { type: "string", default: "" },
            message: { type: "string" },
            uptime: { type: "integer", nullable: true },
            timestamp: { type: "integer", nullable: true },
          },
        },
      },
    },
    (request) => {
      const log = request.body;

      const id = registrarLog({
        timestamp: log.timestamp ?? null,
        device_id: log.deviceID,
        ip: request.ip,
        level: log.level,
        module: log.module ?? "",
        message: log.message,
        uptime: log.uptime ?? null,
      });

      return { ok: true, id };
    },
  );

  // GET /api/logs
  app.get(
    "/api/logs",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            deviceID: { type: "string" },
            level: { type: "string" },
            module: { type: "string" },
            search: { type: "string" },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10000,
              default: 250,
            },
          },
        },
      },
    },
    (request) => {
      const { deviceID, level, module, search, limit } = request.query;

      let sql = `
      SELECT
        l.id,
        l.timestamp,
        l.device_id,
        l.ip,
        lv.nome AS level,
        l.module,
        l.message,
        l.uptime
      FROM logs l
      JOIN level lv ON l.level = lv.id
      WHERE 1=1
    `;

      const params = [];

      if (deviceID) {
        sql += " AND l.device_id = ?";
        params.push(deviceID);
      }

      if (level) {
        sql += " AND lv.nome = ?";
        params.push(level);
      }

      if (module) {
        sql += " AND l.module = ?";
        params.push(module);
      }

      if (search) {
        sql += " AND l.message LIKE ?";
        params.push(`%${search}%`);
      }

      sql += " ORDER BY l.id DESC LIMIT ?";
      params.push(limit);

      return db.prepare(sql).all(...params);
    },
  );

  // GET /api/logs/nodes
  const selectNodes = db.prepare(`
    SELECT
      device_id,
      MAX(timestamp) AS last_log,
      COUNT(*) AS total_logs
    FROM logs
    GROUP BY device_id
    ORDER BY device_id
  `);

  app.get("/api/logs/nodes", () => {
    return selectNodes.all();
  });
}
