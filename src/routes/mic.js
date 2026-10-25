const WHISPER_URL =
  process.env.WHISPER_URL || "http://10.0.1.100:8081/inference";

const TAMANHO_AUDIO = 16000 * 3 * 2;
const TAMANHO_WAV = 44 + TAMANHO_AUDIO;

const PROMPT_WHISPER =
  "eTomada. GROW. O eTomada liga a luz do GROW. " +
  "O eTomada controla o umidificador do terrário.";

function wavValido(wav) {
  return (
    Buffer.isBuffer(wav) &&
    wav.length === TAMANHO_WAV &&
    wav.toString("ascii", 0, 4) === "RIFF" &&
    wav.readUInt32LE(4) === TAMANHO_WAV - 8 &&
    wav.toString("ascii", 8, 16) === "WAVEfmt " &&
    wav.readUInt32LE(16) === 16 &&
    wav.readUInt16LE(20) === 1 &&
    wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === 16000 &&
    wav.readUInt16LE(34) === 16 &&
    wav.toString("ascii", 36, 40) === "data" &&
    wav.readUInt32LE(40) === TAMANHO_AUDIO
  );
}

export default async function micRoutes(app) {
  // Recebe WAV puro do firmware, sem multipart no ESP32.
  app.addContentTypeParser(
    "audio/wav",
    { parseAs: "buffer", bodyLimit: 128 * 1024 },
    (request, body, done) => done(null, body),
  );

  app.post("/api/mic/audio", async (request, reply) => {
    const deviceId = String(request.headers["x-device-id"] ?? "")
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9_-]{1,32}$/.test(deviceId)) {
      return reply.code(400).send({ ok: false, msg: "X-Device-ID invalido" });
    }

    if (!wavValido(request.body)) {
      return reply.code(400).send({ ok: false, msg: "WAV invalido" });
    }

    // Encaminha para whisper.cpp usando a API multipart.
    const form = new FormData();
    form.append(
      "file",
      new Blob([request.body], { type: "audio/wav" }),
      "comando.wav",
    );
    form.append("response_format", "json");
    form.append("language", "pt");
    form.append("prompt", PROMPT_WHISPER);
    form.append("carry_initial_prompt", "true");

    try {
      const response = await fetch(WHISPER_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(25000),
      });

      if (!response.ok) {
        throw new Error(`Whisper HTTP ${response.status}`);
      }

      const json = await response.json();
      if (typeof json.text !== "string") {
        throw new Error("Resposta do Whisper sem campo text");
      }

      const texto = json.text.trim();

      app.log.info(
        { module: "VOICE", device_id: deviceId },
        `Transcricao: [${texto || "(vazia)"}]`,
      );

      return { ok: true, device_id: deviceId, texto };
    } catch (err) {
      app.log.error(
        { module: "VOICE", device_id: deviceId, err },
        "Falha ao transcrever audio",
      );

      return reply.code(502).send({
        ok: false,
        msg: "Falha no Whisper",
      });
    }
  });
}
