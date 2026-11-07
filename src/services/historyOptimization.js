import { criarHistoryRepository } from "../repositories/historyRepository.js";

// Janelas fechadas de cinco minutos; a janela atual mantém as leituras originais.
export const JANELA_SEGUNDOS = 300;
// Mudanças maiores que 20% da escala local iniciam outro patamar.
// Reduza para preservar variações menores; aumente para remover mais ruído.
const NIVEL_RUIDO = 0.20;

export function criarHistoryOptimization(db) {
  const historico = criarHistoryRepository(db);

  // O chamador mantém a configuração e a compactação na mesma transação.
  function compactar(deviceId, recursoId, agora = Math.floor(Date.now() / 1000)) {
    const limite = Math.floor(agora / JANELA_SEGUNDOS) * JANELA_SEGUNDOS;
    const eventos = historico.listarParaCompactacao(deviceId, recursoId, limite);
    let janela = [];
    let chaveAnterior = null;

    function fecharJanela() {
      if (janela.length < 3) return;
      const valores = janela.map((e) => e.valor);
      const tolerancia = valores.reduce((escala, valor) => Math.max(escala, Math.abs(valor)), 1e-9) * NIVEL_RUIDO;
      // Mediana de três remove picos isolados sem arredondar degraus sustentados.
      const filtrados = valores.map((v, i) => i === 0 || i === valores.length - 1
        ? v : [valores[i - 1], v, valores[i + 1]].sort((a, b) => a - b)[1]);
      let grupo = [];
      let soma = 0;
      function gravar() {
        if (grupo.length >= 3) historico.substituir(grupo, soma / grupo.length);
        grupo = [];
        soma = 0;
      }
      for (let i = 0; i < janela.length; i++) {
        if (grupo.length && Math.abs(filtrados[i] - soma / grupo.length) > tolerancia) gravar();
        grupo.push(janela[i]);
        soma += filtrados[i];
      }
      gravar();
    }

    for (const evento of eventos) {
      const chave = JSON.stringify([
        Math.floor(evento.timestamp / JANELA_SEGUNDOS),
        evento.evento, evento.ip, evento.status, evento.estado, evento.estado2,
      ]);
      if (evento.history_optimized || !Number.isFinite(evento.valor) || chave !== chaveAnterior) {
        fecharJanela();
        janela = [];
      }
      chaveAnterior = chave;
      if (!evento.history_optimized && Number.isFinite(evento.valor)) janela.push(evento);
    }
    fecharJanela();
  }

  return { compactar };
}
