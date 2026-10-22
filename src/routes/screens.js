export default async function screensRoutes(app, { db }) {
  const selectScreens = db.prepare(`
    SELECT name, charts_json
    FROM history_screens
    ORDER BY name
  `);

  const insertScreen = db.prepare(`
    INSERT INTO history_screens (name, charts_json)
    VALUES (?, '[]')
  `);

  const updateScreen = db.prepare(`
    UPDATE history_screens
    SET charts_json = ?
    WHERE name = ?
  `);

  const deleteScreen = db.prepare(`
    DELETE FROM history_screens
    WHERE name = ?
  `);

  const nameSchema = {
    type: "string",
    minLength: 1,
    maxLength: 40,
  };

  const chartSchema = {
    type: "object",
    required: ["node", "recurso_id"],
    properties: {
      node: {
        type: "string",
        minLength: 1,
        maxLength: 32,
      },
      recurso_id: {
        type: "string",
        minLength: 1,
        maxLength: 32,
      },
      field: {
        type: "string",
        nullable: true,
      },
    },
  };

  // GET /api/history/screens
  app.get("/api/history/screens", () => {
    return selectScreens.all().map((row) => ({
      name: row.name,
      charts: JSON.parse(row.charts_json),
    }));
  });

  // POST /api/history/screens
  app.post(
    "/api/history/screens",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: nameSchema,
          },
        },
      },
    },
    (request, reply) => {
      const name = request.body.name.trim();

      if (!name) {
        return reply.code(422).send({
          detail: "Nome da tela vazio",
        });
      }

      try {
        insertScreen.run(name);
      } catch (err) {
        if (
          err.message.includes("UNIQUE constraint failed: history_screens.name")
        ) {
          return reply.code(409).send({
            detail: "Esta tela já existe",
          });
        }

        throw err;
      }

      return reply.code(201).send({
        name,
        charts: [],
      });
    },
  );

  // PUT /api/history/screens/:name
  app.put(
    "/api/history/screens/:name",
    {
      schema: {
        body: {
          type: "object",
          required: ["charts"],
          properties: {
            charts: {
              type: "array",
              maxItems: 100,
              items: chartSchema,
            },
          },
        },
      },
    },
    (request, reply) => {
      const { name } = request.params;

      const charts = request.body.charts.map((chart) => ({
        node: chart.node,
        recurso_id: chart.recurso_id,
        field: chart.field ?? null,
      }));

      const result = updateScreen.run(JSON.stringify(charts), name);

      if (Number(result.changes) === 0) {
        return reply.code(404).send({
          detail: "Tela não encontrada",
        });
      }

      return {
        name,
        charts,
      };
    },
  );

  // DELETE /api/history/screens/:name
  app.delete("/api/history/screens/:name", (request, reply) => {
    const result = deleteScreen.run(request.params.name);

    if (Number(result.changes) === 0) {
      return reply.code(404).send({
        detail: "Tela não encontrada",
      });
    }

    return reply.code(204).send();
  });
}
