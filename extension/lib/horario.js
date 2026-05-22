// extension/lib/horario.js — horário comercial BR (Seg-Sex 07:55-19:01, Sáb 07:55-13:00).
// Deps: state (ABERTURA_HHMM, FECHAMENTO_SEMANA, FECHAMENTO_SABADO), format (brasilNowParts).

function sistemaEstaAberto(date) {
  const { weekday, hour, minute } = brasilNowParts(date);
  const hhmm = hour * 60 + minute;
  if (weekday >= 1 && weekday <= 5) return hhmm >= ABERTURA_HHMM && hhmm < FECHAMENTO_SEMANA;
  if (weekday === 6)                return hhmm >= ABERTURA_HHMM && hhmm < FECHAMENTO_SABADO;
  return false;
}

function proximaAberturaBR(date) {
  const now = brasilNowParts(date);
  const hhmm = now.hour * 60 + now.minute;

  let y = now.year, m = now.month, d = now.day, wd = now.weekday;
  const hojeValidoEAntes =
    ((wd >= 1 && wd <= 5) || wd === 6) && hhmm < ABERTURA_HHMM;

  if (!hojeValidoEAntes) {
    // Avança até próximo dia válido (não-domingo)
    do {
      const t = new Date(Date.UTC(y, m - 1, d));
      t.setUTCDate(t.getUTCDate() + 1);
      y  = t.getUTCFullYear();
      m  = t.getUTCMonth() + 1;
      d  = t.getUTCDate();
      wd = t.getUTCDay();
    } while (wd === 0);
  }

  const pad = n => String(n).padStart(2, "0");
  const dataStr = `${pad(d)}/${pad(m)}/${y} às 07:55:00`;
  // BR fixo em UTC-03:00 (sem DST desde 2019)
  const target = new Date(`${y}-${pad(m)}-${pad(d)}T07:55:00-03:00`);
  const ms = Math.max(0, target.getTime() - Date.now());
  return { dataStr, ms };
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.sistemaEstaAberto = sistemaEstaAberto;
  self.proximaAberturaBR = proximaAberturaBR;
}
if (typeof module !== "undefined") {
  module.exports = { sistemaEstaAberto, proximaAberturaBR };
}
