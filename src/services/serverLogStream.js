const ACESSO_HTTP = new Set(["incoming request", "request completed"]);

function nivelEtomada(nivelPino) {
  if (nivelPino >= 50) return 1; // error/fatal -> CRIT
  if (nivelPino >= 40) return 5; // warn -> AVISO
  if (nivelPino >= 30) return 10; // info -> NORMAL
  if (nivelPino >= 20) return 50; // debug -> DEBUG0
  return 70; // trace -> DEBUG!
}

export function criarServerLogStream({
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  let registrarLog = null;
  let parcial = "";

  function processar(linha) {
    if (!registrarLog || !linha) return;

    let log;
    try {
      log = JSON.parse(linha);
    } catch {
      return;
    }

    if (typeof log.level !== "number") return;

    // Mantém os acessos HTTP no journald, mas não no SQLite.
    if (log.reqId && ACESSO_HTTP.has(log.msg)) return;

    const origem = typeof log.device_id === "string" ? log.device_id : "";

    const modulo =
      typeof log.module === "string" && log.module
        ? log.module
        : origem
          ? "NODES"
          : "SERVER";

    const detalhe = log.err?.message ?? log.erro;
    const msg = String(log.msg ?? "");

    const mensagem = (
      (origem ? `[${origem}] ` : "") +
      msg +
      (typeof detalhe === "string" && detalhe && !msg.includes(detalhe)
        ? `: ${detalhe}`
        : "")
    ).trim();

    if (!mensagem) return;

    try {
      registrarLog({
        timestamp: Math.floor(
          (typeof log.time === "number" ? log.time : Date.now()) / 1000,
        ),
        device_id: "SERVER",
        level: nivelEtomada(log.level),
        module: modulo,
        message: mensagem,
        uptime: Math.floor(process.uptime()),
      });
    } catch (erro) {
      // Nunca chamar app.log aqui, pois causaria recursão.
      errorOutput.write(`Falha ao gravar log do servidor: ${erro.message}\n`);
    }
  }

  return {
    stream: {
      write(chunk) {
        // Preserva console e journald do systemd.
        output.write(chunk);
        parcial += String(chunk);

        let fim;
        while ((fim = parcial.indexOf("\n")) !== -1) {
          const linha = parcial.slice(0, fim);
          parcial = parcial.slice(fim + 1);
          processar(linha);
        }

        // Proteção contra linhas excessivamente grandes.
        if (parcial.length > 1024 * 1024) parcial = "";

        return true;
      },
    },

    configurar(funcaoRegistrarLog) {
      registrarLog = funcaoRegistrarLog;
    },

    parar() {
      registrarLog = null;
    },
  };
}
