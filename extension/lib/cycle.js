// extension/lib/cycle.js — runMonitorCycle: 1 ciclo completo de discovery → filtro → reserva.
// Deps: state (IDLE_MAX_CICLOS), telemetria, notifications, telegram,
//       auth (fazerLogin), grupos (buscarGrupos, extrairGrupos, parseGruposConfig),
//       reserva (reservarComLimite), lifecycle (pararMonitoramento — resolved at call time).

async function runMonitorCycle() {
  const cycleStart = Date.now();
  telemetria("cycle.start", {});

  // Fix 15: declarado no top do escopo pra ficar acessível no finally — garante que
  // cycle.end + atualização metricasDia rode mesmo em ciclos sem detectados.
  let detectados = [];
  let resultados = [];
  let sistemaFechadoErr = null;

  try {
    const stored = await chrome.storage.local.get([
      "idUsuario", "idEmpresa", "GRUPOS_CONFIG", "MODO_TESTE"
    ]);
    let uid = stored.idUsuario;
    let eid = stored.idEmpresa;

    if (!uid) {
      const loginData = await fazerLogin();
      uid = loginData.IdUsuario;
      eid = loginData.IdEmpresa;
      await chrome.storage.local.set({ idUsuario: uid, idEmpresa: eid, idUsuarioObtidoEm: Date.now() });
      const loginMsg = "✅ Login realizado com sucesso!";
      notificarPopup(loginMsg);
      await telegramNotify(loginMsg);
    }

    const gruposResp = await buscarGrupos(uid);
    const gruposAlvo = parseGruposConfig(stored.GRUPOS_CONFIG);
    const grupos = extrairGrupos(gruposResp);

    notificarPopup(`📦 ${grupos.length} grupos consultados`);

    const { reservasPorGrupo = {} } = await chrome.storage.local.get(["reservasPorGrupo"]);
    const sessProdutos = await chrome.storage.session.get(["produtosBloqueados", "gruposEmCooldown"]);
    const produtosBloqueados = Array.isArray(sessProdutos.produtosBloqueados) ? sessProdutos.produtosBloqueados : [];
    const cooldownRaw = sessProdutos.gruposEmCooldown && typeof sessProdutos.gruposEmCooldown === "object" ? sessProdutos.gruposEmCooldown : {};
    const agoraMs = Date.now();
    let cooldownLimpou = false;
    const cooldown = {};
    for (const k of Object.keys(cooldownRaw)) {
      if (cooldownRaw[k] > agoraMs) cooldown[k] = cooldownRaw[k];
      else cooldownLimpou = true;
    }
    if (cooldownLimpou) await chrome.storage.session.set({ gruposEmCooldown: cooldown });

    // Dedup por CD_Grupo: API retorna múltiplos bens do mesmo grupo no mesmo ciclo.
    // Sem dedup, reservaríamos 2× o mesmo grupoId em paralelo (2× sendMessage, 2× cooldown).
    const jaDetectado = new Set();
    const dedupContagem = {};
    for (const grupo of grupos) {
      const codigo = String(grupo.CD_Grupo || "");
      if (!(codigo in gruposAlvo)) continue;
      dedupContagem[codigo] = (dedupContagem[codigo] || 0) + 1;
      if (jaDetectado.has(codigo)) continue;

      const limite = gruposAlvo[codigo];
      const feitas = reservasPorGrupo[codigo] || 0;
      if (feitas >= limite) continue;

      if (produtosBloqueados.includes(grupo.ID_Produto)) continue;
      if (cooldown[codigo]) continue;

      jaDetectado.add(codigo);
      detectados.push({ grupo, grupoId: codigo, limite });
    }
    const duplicados = Object.keys(dedupContagem).filter(k => dedupContagem[k] > 1);
    if (duplicados.length) {
      telemetria("dedup.applied", { duplicados, contagem: dedupContagem });
    }

    // Fix 16 Lote C: telemetria do filtro pra distinguir bug de paginação vs bug de filtro.
    // Se brutosCount alto mas detectadosCount=0, problema é filtro/config. Se brutosCount
    // truncado (ex: sempre 100), backend pagina e robô só vê página 1.
    telemetria("filter.detectados", {
      brutosCount: grupos.length,
      alvoConfigCount: Object.keys(gruposAlvo).length,
      detectadosCount: detectados.length,
      configKeys: Object.keys(gruposAlvo),
      cdGruposBrutos: grupos.slice(0, 20).map(g => String(g && g.CD_Grupo || "")),
      produtosBloqueadosCount: produtosBloqueados.length,
      cooldownAtivos: Object.keys(cooldown)
    });

    if (detectados.length === 0) {
      notificarPopup(`💥 Nenhuma cota disponível no momento...`);
      const sessIdle = await chrome.storage.session.get(["ciclosVazios"]);
      const novosVazios = Math.min(Number(sessIdle.ciclosVazios || 0) + 1, IDLE_MAX_CICLOS);
      await chrome.storage.session.set({ ciclosVazios: novosVazios });
      return; // finally roda — cycle.end + metricasDia
    }

    // Vagas detectadas → reset idle counter
    await chrome.storage.session.set({ ciclosVazios: 0 });

    const lista = Object.keys(gruposAlvo).sort().join(", ");
    notificarPopup(`🔍 Buscando por cotas: ${lista}...`);

    // Fix 6.1: serial — DOM é singleton, paralelo cria race condition no modal global
    for (const d of detectados) {
      try {
        const valor = await reservarComLimite(d.grupo, uid, eid, d.grupoId, d.limite, reservasPorGrupo, stored.MODO_TESTE);
        resultados.push({ status: "fulfilled", value: valor });
      } catch (err) {
        resultados.push({ status: "rejected", reason: err });
        if (err && err.message === "SISTEMA_FECHADO") {
          sistemaFechadoErr = err;
          break; // não adianta tentar mais grupos com sistema fechado
        }
      }
    }
  } finally {
    // Fix 15: cycle.end + atualização métricas SEMPRE rodam (mesmo em ciclo vazio
    // ou exception). Garante que ciclos/consultas crescem na tab Operações e Histórico
    // independente de haver detectados ou reservas.
    telemetria("cycle.end", {
      duracaoMs: Date.now() - cycleStart,
      detectados: detectados.length,
      resultados: resultados.map(r => r.status === "fulfilled"
        ? { ok: true, ...r.value }
        : { ok: false, erro: (r.reason && r.reason.message) || String(r.reason) })
    });

    // Fix 12: métricas em storage.local (persistente) pra agregar entre sessões + usuários.
    // metricasDia mantém últimos 30 dias. metricasHoras só do dia atual (cleanup auto).
    try {
      const agora = new Date();
      // Fix 14 B4: usa data local (BRT) em vez de UTC pra evitar virada em UTC midnight
      const dia = agora.toLocaleDateString('en-CA');
      const hh = String(agora.getHours()).padStart(2, "0");
      const keyHora = dia + "-" + hh;

      const local = await chrome.storage.local.get(["metricasDia", "metricasHoras"]);
      const metricasDia = (local.metricasDia && typeof local.metricasDia === "object") ? local.metricasDia : {};
      const metricasHoras = (local.metricasHoras && typeof local.metricasHoras === "object") ? local.metricasHoras : {};

      const reservasNoCiclo = resultados.filter(r => r.status === "fulfilled" && r.value && r.value.reservou).length;
      // 1 = chamada listGruposReserva; +N = chamadas de reserva tentadas (mesmo se falharam)
      const consultasNoCiclo = 1 + detectados.length;

      // Fix 14 B1: preservar rateLimits que apiPost incrementa em paralelo.
      // Read-modify-write: nunca sobrescrever campo que outro caminho atualiza.
      const m = metricasDia[dia] || { ciclos: 0, reservas: 0, consultas: 0, rateLimits: 0 };
      m.ciclos = (m.ciclos || 0) + 1;
      m.reservas = (m.reservas || 0) + reservasNoCiclo;
      m.consultas = (m.consultas || 0) + consultasNoCiclo;
      if (m.rateLimits == null) m.rateLimits = 0;
      metricasDia[dia] = m;

      const h = metricasHoras[keyHora] || { ciclos: 0, reservas: 0 };
      h.ciclos += 1;
      h.reservas += reservasNoCiclo;
      metricasHoras[keyHora] = h;

      // Cleanup metricasDia: mantém últimos 30 dias
      const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const cutoffStr = new Date(cutoff).toLocaleDateString('en-CA');
      for (const k of Object.keys(metricasDia)) {
        if (k < cutoffStr) delete metricasDia[k];
      }

      // Cleanup metricasHoras: só hoje
      for (const k of Object.keys(metricasHoras)) {
        if (!k.startsWith(dia + "-")) delete metricasHoras[k];
      }

      await chrome.storage.local.set({ metricasDia, metricasHoras });
    } catch (_) {}

    // Issue 2: missão cumprida — se GRUPOS_CONFIG esvaziou + houve pelo menos
    // uma reserva no histórico, para sozinho. Cliente não precisa clicar stop manual.
    try {
      const local = await chrome.storage.local.get(["GRUPOS_CONFIG", "reservasPorGrupo"]);
      const configVazia = !local.GRUPOS_CONFIG || !local.GRUPOS_CONFIG.trim();
      const totalReservas = local.reservasPorGrupo
        ? Object.values(local.reservasPorGrupo).reduce((acc, n) => acc + (n || 0), 0)
        : 0;
      if (configVazia && totalReservas > 0) {
        const msg = `🎯 Todas reservas concluídas (${totalReservas} ${totalReservas === 1 ? "feita" : "feitas"}). Robô parado automaticamente.`;
        notificarPopup(msg);
        telegramNotify(msg).catch(() => {});
        telemetria("missao.cumprida", { totalReservas });
        await pararMonitoramento();
      }
    } catch (_) {}

    await flushTelemetria();
  }

  if (sistemaFechadoErr) throw sistemaFechadoErr;
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") self.runMonitorCycle = runMonitorCycle;
if (typeof module !== "undefined") module.exports = { runMonitorCycle };
