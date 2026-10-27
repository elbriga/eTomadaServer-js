export async function telegramEnviar(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const ENV = process.env.ETOMADA_ENV;

  if (!token || !chatId) throw new Error("Telegram não configurado");

  // Envia a mensagem pela API HTTPS do Telegram
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${texto} >[${ENV.toUpperCase()}]`,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );

  const data = await response.json();

  if (!response.ok || !data.ok)
    throw new Error(data.description || `HTTP ${response.status}`);

  return data.result;
}
