export default async function resourcesRoutes(app, { db }) {
  const upsertResource = db.prepare(`
    INSERT INTO resources (
      device_id,
      recurso_id,
      nome,
      tipo,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, recurso_id)
    DO UPDATE SET
      nome = excluded.nome,
      tipo = excluded.tipo,
      updated_at = excluded.updated_at
  `);

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
      const timestamp = Math.floor(Date.now() / 1000);

      db.exec("BEGIN");

      try {
        for (const recurso of recursos) {
          upsertResource.run(
            device_id,
            recurso.id,
            recurso.nome ?? "",
            recurso.tipo ?? "",
            timestamp,
          );
        }

        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      return {
        ok: true,
        device_id,
        recursos: recursos.length,
      };
    },
  );
}
