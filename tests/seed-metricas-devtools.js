// tests/seed-metricas-devtools.js
//
// Script standalone pra popular 30 dias de métricas sample no storage.local da extensão
// Canopus Reserva Robô. Útil pra validar visualmente a tab Histórico + exportação CSV
// sem precisar rodar o robô por dias.
//
// Como usar:
//   1. Abre o side panel da extensão Canopus Robô (click no ícone na barra do Chrome)
//   2. Right-click dentro do panel → "Inspect" (abre DevTools do popup)
//   3. Aba "Console"
//   4. Cola TODO o conteúdo deste arquivo (entre as marcas BEGIN/END abaixo) e dá Enter
//   5. Mensagem "[seed] metricasDia populado com 30 dias" aparece no console
//   6. Troca pra tab "Histórico" no side panel — 4 gráficos populam com dados variados
//   7. Click "CSV" no header do Histórico — baixa arquivo com 30 linhas não-zero
//
// Limpar depois do teste: tab "Configurações" → botão "🗑 Limpar cache da extensão"
// (ou cole `chrome.storage.local.clear()` no console)

/* ═════ BEGIN seed script (cole daqui pro fim no console DevTools do popup) ═════ */

(async () => {
  const md = {};
  const mh = {};
  const hoje = new Date();

  // metricasDia: 30 dias com volumes variados
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const dia = d.toLocaleDateString('en-CA');

    // Volume realista: 30-100 ciclos/dia, 60-300 consultas, 1-15% taxa sucesso,
    // 0-20% taxa rate-limit. Variação dia-a-dia pra gráficos não ficarem flat.
    const ciclos = 30 + Math.floor(Math.random() * 70);
    const consultas = ciclos * (2 + Math.floor(Math.random() * 4));
    const reservas = Math.floor(consultas * (0.01 + Math.random() * 0.14));
    const rateLimits = Math.floor(consultas * Math.random() * 0.20);

    md[dia] = { ciclos, consultas, reservas, rateLimits };
  }

  // metricasHoras: só hoje (resto cleanup auto descarta)
  const hojeStr = hoje.toLocaleDateString('en-CA');
  for (let h = 0; h <= hoje.getHours(); h++) {
    mh[hojeStr + '-' + String(h).padStart(2, '0')] = {
      ciclos: Math.floor(Math.random() * 12),
      reservas: Math.floor(Math.random() * 3)
    };
  }

  await chrome.storage.local.set({ metricasDia: md, metricasHoras: mh });

  console.log('[seed] metricasDia populado com 30 dias');
  console.log('[seed] Resumo:', Object.entries(md).slice(-7).map(([dia, m]) =>
    `${dia}: ciclos=${m.ciclos} consultas=${m.consultas} reservas=${m.reservas} rateLimits=${m.rateLimits}`
  ).join('\n'));
})();

/* ═════ END seed script ═════ */
