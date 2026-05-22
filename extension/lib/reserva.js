// extension/lib/reserva.js — reservar() (dead code) + reservarComLimite (orchestration).
// Deps: state (TURNSTILE_COOLDOWN_MS), api (apiPost), telemetria, notifications,
//       telegram, grupos (extrairReserva, removerGrupoDoConfig), format (formatarDataBR, usuarioExibicao),
//       portal (reservarViaTab).

// Dead code per CLAUDE.md — Cloudflare bloqueia POST /reservas/add direto do SW.
// Mantido como referência; em prod usa-se reservarViaTab.
async function reservar(grupo, idUsuario, idEmpresa) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  return apiPost("/reservas/add", {
    IdEmpresa: idEmpresa,
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0"),
    ID_Grupo: grupo.ID_Grupo,
    ID_Bem: grupo.ID_Bem,
    ID_Produto: grupo.ID_Produto,
    NM_Produto: grupo.NM_Produto,
    PZ_Comercializacao: grupo.PZ_Comercializacao
  });
}

async function reservarComLimite(grupo, uid, eid, grupoId, limite, reservasPorGrupo, modoTeste) {
  if (modoTeste) {
    notificarPopup(`[TESTE] Simularia reserva: ${grupo.NM_Produto} (Grupo ${grupoId})`);
    return { teste: true, grupoId, produto: grupo.NM_Produto };
  }

  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const agora = formatarDataBR(new Date().toISOString());

  const msgEncontrada = `🍀 Cota ${grupoId} encontrada para o usuário ${usuarioFmt} em ${agora}!`;
  notificarPopup(msgEncontrada);
  await telegramNotify(msgEncontrada);

  const tabResult = await reservarViaTab(grupo, grupoId);
  if (tabResult.semAba) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, semAba: true };
  }
  if (tabResult.turnstileTimeout || tabResult.turnstileError) {
    const sessCool = await chrome.storage.session.get(["gruposEmCooldown"]);
    const cool = sessCool.gruposEmCooldown && typeof sessCool.gruposEmCooldown === "object" ? sessCool.gruposEmCooldown : {};
    cool[grupoId] = Date.now() + TURNSTILE_COOLDOWN_MS;
    await chrome.storage.session.set({ gruposEmCooldown: cool });
    return { reservou: false, grupoId, produto: grupo.NM_Produto, turnstile: true };
  }
  if (tabResult.fase2Pendente) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, fase2Pendente: true };
  }
  if (tabResult.erro) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, erro: tabResult.erro };
  }

  const result = tabResult.result;

  if (!(result && result.success)) {
    const details = String((result && (result.details || result.message)) || "");
    const detailsLower = details.toLowerCase();
    const bodyStr = JSON.stringify(result || {}).toLowerCase();

    if (detailsLower.includes("restrição vigente") || detailsLower.includes("restricao vigente")) {
      throw new Error("SISTEMA_FECHADO");
    }

    if (detailsLower.includes("limite de reservas desse produto")) {
      const idProd = grupo.ID_Produto;
      const sess = await chrome.storage.session.get(["produtosBloqueados"]);
      const lista = Array.isArray(sess.produtosBloqueados) ? sess.produtosBloqueados : [];
      if (!lista.includes(idProd)) {
        lista.push(idProd);
        await chrome.storage.session.set({ produtosBloqueados: lista });
      }
      const msg = `💣 Erro: "${details}" Removendo o produto: ${grupo.NM_Produto} do grupo ${grupoId}.`;
      notificarPopup(msg);
      await telegramNotify(msg);
      return { reservou: false, grupoId, produto: grupo.NM_Produto, produtoBloqueado: true };
    }

    if (bodyStr.includes("1015") || bodyStr.includes("rate_limited") || bodyStr.includes("\"429\"") || bodyStr.includes("\"403\"")) {
      await chrome.storage.session.set({ rateLimitHit: true });
    }

    if (details) {
      notificarPopup(`❌ Erro ao reservar: ${details}`);
    }
    return { reservou: false, grupoId, produto: grupo.NM_Produto, details };
  }

  const novoTotal = (reservasPorGrupo[grupoId] || 0) + 1;
  reservasPorGrupo[grupoId] = novoTotal;
  await chrome.storage.local.set({ reservasPorGrupo });

  const reserva = extrairReserva(result);
  const cota = String(reserva.CodigoCota || reserva.CD_Cota || "N/D");
  const produtoNome = reserva.NomeProduto || grupo.NM_Produto || "N/D";
  const dtReserva = formatarDataBR(reserva.DataReserva || reserva.DT_Reserva);
  const dtValidade = formatarDataBR(reserva.DataValidade || reserva.DT_Validade);

  const msgReserva =
    `🎉 Reservado!\n` +
    `Usuário: ${usuarioFmt}\n` +
    `Grupo: ${grupoId}\n` +
    `Cota: ${cota}\n` +
    `Produto: ${produtoNome}\n` +
    `Data da Reserva: ${dtReserva}\n` +
    `Válido até: ${dtValidade}`;

  notificarPopup(msgReserva);
  await telegramNotify(msgReserva);

  const concluido = novoTotal >= limite;
  if (concluido) {
    const conclusao = `✅ Grupo ${grupoId} concluído — ${limite} reservas feitas`;
    notificarPopup(conclusao);
    await telegramNotify(conclusao);
    const { GRUPOS_CONFIG } = await chrome.storage.local.get(["GRUPOS_CONFIG"]);
    const novoConfig = removerGrupoDoConfig(GRUPOS_CONFIG, grupoId);
    await chrome.storage.local.set({ GRUPOS_CONFIG: novoConfig });
  }

  return { reservou: true, grupoId, produto: grupo.NM_Produto, novoTotal, limite, concluido, cota };
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.reservar = reservar;
  self.reservarComLimite = reservarComLimite;
}
if (typeof module !== "undefined") {
  module.exports = { reservar, reservarComLimite };
}
