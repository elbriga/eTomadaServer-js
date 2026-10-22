export function registrarSse(app) {
  const clients = new Set();

  app.get("/api/events", (request, reply) => {
    reply.hijack();

    const res = reply.raw;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    clients.add(res);
    res.write(": conectado\n\n");

    const timer = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 30000);

    res.on("close", () => {
      clearInterval(timer);
      clients.delete(res);
    });
  });

  app.addHook("preClose", async () => {
    for (const res of clients) res.end();
  });

  app.addHook("onClose", async () => {
    for (const res of clients) res.destroy();

    clients.clear();
  });

  return function notificarLog(id) {
    const data = `event: log\ndata: ${JSON.stringify({ id })}\n\n`;

    for (const res of clients) {
      if (!res.destroyed && !res.write(data)) res.destroy();
    }
  };
}
