// extension/lib/loop.js — runPollingLoop + dormirAteAbertura.
// Deps: state, telemetria, notifications, telegram, horario (sistemaEstaAberto, proximaAberturaBR),
//       format (formatarDataBR, usuarioExibicao), turnstile (limparBadgeTurnstile),
//       schedule (agendarProximoCiclo, ajustarDelayDinamico), cycle (runMonitorCycle),
//       lifecycle (pararMonitoramento — resolved at call time via global lookup).

async function dormirAteAbertura() {
  const { dataStr, ms } = proximaAberturaBR();
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const sess = await chrome.storage.session.get(["sistemaFechadoLogged"]);
  if (!sess.sistemaFechadoLogged) {
    const msg = `⛔ Sistema fechado. Próxima abertura: ${dataStr}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: true, usuarioFechado: usuarioFmt });
  }
  const sleepMs = Math.max(1000, Math.min(ms, 1000 * 60 * 60));
  await agendarProximoCiclo(sleepMs);
}

async function runPollingLoop() {
  // M1: 1 batch read em vez de 4× session.get separados
  const sess = await chrome.storage.session.get([
    "isRunning", "nextRunAt",
    "turnstileBloqueado", "turnstileBloqueadoAte",
    "circuitAberto",
    "sistemaFechadoLogged"
  ]);
  if (!sess.isRunning) return;

  // H3: tenta restaurar batch persistido em SW kill prévia (no-op se vazio)
  await flushTelemetria().catch(() => {});

  // State machine guard — respeita o próximo schedule independente de quem disparou (alarm vs setTimeout)
  if (sess.nextRunAt && Date.now() < sess.nextRunAt) {
    const restanteMs = sess.nextRunAt - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }

  const { MODO_TESTE } = await chrome.storage.local.get(["MODO_TESTE"]);

  // Turnstile interativo — robô pausado até cliente resolver no portal (ou expirar)
  if (sess.turnstileBloqueado && sess.turnstileBloqueadoAte && Date.now() < sess.turnstileBloqueadoAte) {
    const restanteMs = sess.turnstileBloqueadoAte - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }
  if (sess.turnstileBloqueado) {
    await chrome.storage.session.set({ turnstileBloqueado: false, turnstileBloqueadoAte: null });
    await limparBadgeTurnstile();
    notificarPopup(`✅ Pausa por Turnstile encerrada. Retomando.`);
  }

  // Circuit breaker — verifica antes de qualquer request
  if (sess.circuitAberto && Date.now() < sess.circuitAberto) {
    const restanteMs = sess.circuitAberto - Date.now();
    notificarPopup(`🛑 Circuit breaker aberto. Próxima tentativa em ${(restanteMs/1000).toFixed(0)}s`);
    await agendarProximoCiclo(restanteMs);
    return;
  }
  if (sess.circuitAberto && Date.now() >= sess.circuitAberto) {
    await chrome.storage.session.set({ circuitAberto: null, hitsRecentes: [] });
    notificarPopup(`✅ Circuit breaker fechado. Retomando.`);
  }

  // Horário comercial — bypass em modo teste pra permitir validação a qualquer hora
  if (!MODO_TESTE && !sistemaEstaAberto()) {
    await dormirAteAbertura();
    return;
  }

  // Transição fechado → aberto: avisa retomada
  if (sess.sistemaFechadoLogged) {
    const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
    const usuarioFmt = usuarioExibicao(USUARIO);
    const agora = formatarDataBR(new Date().toISOString());
    const msg = `🚀 Retomando buscas no usuário ${usuarioFmt} em ${agora}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: false });
  }

  // M9: invalida sessão Canopus se mais velha que TTL — pega caso "robô voltou
  // do SW kill, sessão pode ter expirado no backend"
  const ID_USUARIO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
  const { idUsuarioObtidoEm } = await chrome.storage.local.get(["idUsuarioObtidoEm"]);
  if (idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) {
    // Spec 03: limpa tokenLogin/userPayload junto pra forçar re-hidratação no
    // próximo ciclo (TokenLogin pode ter expirado no backend).
    await chrome.storage.local.remove([
      "idUsuario", "idEmpresa", "idUsuarioObtidoEm",
      "tokenLogin", "userPayload"
    ]);
    notificarPopup("🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo.");
  }

  // Fix 9: mutex pra evitar reentrância (setTimeout + chrome.alarms disparam paralelo).
  // Sem isso, 2 ciclos rodam simultâneo → 2× requests à API → acelera bloqueio Cloudflare.
  const CYCLE_MAX_MS = 90_000;
  const sessLock = await chrome.storage.session.get(["cycleRunning", "cycleRunningSince"]);
  const lockAgora = Date.now();
  if (sessLock.cycleRunning && sessLock.cycleRunningSince && (lockAgora - sessLock.cycleRunningSince) < CYCLE_MAX_MS) {
    telemetria("cycle.skip_reentry", { decorridoMs: lockAgora - sessLock.cycleRunningSince });
    return;
  }
  await chrome.storage.session.set({ cycleRunning: true, cycleRunningSince: lockAgora });

  try {
    try {
      await runMonitorCycle();
    } catch (error) {
      if (error.message === "SISTEMA_FECHADO") {
        await chrome.storage.session.set({ sistemaFechadoLogged: false });
        await dormirAteAbertura();
        return;
      }

      if (error.message === "IP_BANIDO") {
        // Cloudflare baniu o IP do cliente. Não dá retry. Para tudo e alerta crítico.
        const msg = `🚫 IP BANIDO pelo Cloudflare (HTTP ${error.status}). Robô parado. Cliente precisa esperar 24h+ ou trocar de IP/rede.`;
        notificarPopup(msg);
        await registrarUltimoErroPersistente(`IP banido (HTTP ${error.status})`);
        await telegramNotify(msg);
        telemetria("sw.lifecycle", { event: "stopped_ip_banned", body: error.body });
        await flushTelemetria();
        await pararMonitoramento();
        return;
      }

      if (error.message === "RATE_LIMIT") {
        const baseWait = error.cloudflare1015
          ? CLOUDFLARE_1015_BACKOFF_SEC
          : Math.max(error.retryAfterSec || 0, RATE_LIMIT_BACKOFF_SEC);
        const fonte = error.cloudflare1015 ? "🔥 Cloudflare 1015" : `⛔ Rate limit (HTTP ${error.status || 429})`;
        const msg = `${fonte} — pausando ${baseWait}s antes de retry`;
        notificarPopup(msg);
        await telegramNotify(msg);
        await agendarProximoCiclo(baseWait * 1000);
        return;
      }

      console.error("❌ Erro no ciclo:", error.message);
      notificarPopup(`❌ Erro: ${error.message}`);
      await registrarUltimoErroPersistente(`Erro: ${error.message}`);
      await telegramNotify(`❌ Erro no robô: ${error.message}`);

      if (error.message.includes("LOGIN_FALHOU") || error.message.includes("HTTP 401")) {
        await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
      }
    }

    const { currentMin, currentMax } = await ajustarDelayDinamico();

    // Smart idle multiplier
    const { ciclosVazios = 0 } = await chrome.storage.session.get(["ciclosVazios"]);
    const idleMultiplier = 1 + IDLE_INCREMENT * Math.min(Number(ciclosVazios), IDLE_MAX_CICLOS);

    // Jitter triangular (bias suave pro centro do intervalo)
    const u = Math.random();
    const triangular = u < 0.5
      ? Math.sqrt(u * 0.5)
      : 1 - Math.sqrt((1 - u) * 0.5);
    const baseDelay = currentMin + triangular * Math.max(0, currentMax - currentMin);
    const delay = baseDelay * idleMultiplier;

    await agendarProximoCiclo(delay * 1000);
  } finally {
    await chrome.storage.session.set({ cycleRunning: false, cycleRunningSince: null });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.dormirAteAbertura = dormirAteAbertura;
  self.runPollingLoop = runPollingLoop;
}
if (typeof module !== "undefined") {
  module.exports = { dormirAteAbertura, runPollingLoop };
}
