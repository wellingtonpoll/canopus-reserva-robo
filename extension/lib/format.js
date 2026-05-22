// extension/lib/format.js — helpers de formatação (datas, usuário).
// Zero dependências. Carregado após state.js.

function formatarDataBR(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function usuarioExibicao(usr) {
  const u = String(usr || "").trim();
  return u.replace(/^0+/, "") || u;
}

function brasilNowParts(date) {
  const d = date || new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // Intl em alguns runtimes devolve "24" à meia-noite
  return {
    weekday: wdMap[get("weekday")] ?? 0,
    hour,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10)
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.formatarDataBR = formatarDataBR;
  self.usuarioExibicao = usuarioExibicao;
  self.brasilNowParts = brasilNowParts;
}
if (typeof module !== "undefined") {
  module.exports = { formatarDataBR, usuarioExibicao, brasilNowParts };
}
