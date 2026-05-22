// extension/lib/grupos.js — discovery + parsers + config parser.
// Deps: api (apiPost), telemetria.

async function buscarGrupos(idUsuario) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const resp = await apiPost(`/reservas/listGruposReserva/${idUsuario}`, {
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0")
  });
  // Fix 16 Lote C: telemetria diagnóstica pra investigar se backend pagina.
  // Pure diagnostic — não muda comportamento. Cliente exporta telemetria,
  // suporte verifica count + shape da response pra decidir fix de paginação.
  try {
    const grupos = extrairGrupos(resp);
    telemetria("buscarGrupos.resultado", {
      count: grupos.length,
      primeiros5CDGrupo: grupos.slice(0, 5).map(g => String(g && g.CD_Grupo || "")),
      sampleKeys: grupos[0] ? Object.keys(grupos[0]) : [],
      respKeys: resp ? Object.keys(resp) : [],
      temField_totalPages: resp && typeof resp.totalPages !== "undefined",
      temField_hasNext: resp && typeof resp.hasNext !== "undefined",
      temField_pageSize: resp && typeof resp.pageSize !== "undefined",
      respDataShape: Array.isArray(resp && resp.data)
        ? (Array.isArray(resp.data[0]) ? "nested-array" : "flat-array")
        : "non-array"
    });
  } catch (_) {}
  return resp;
}

function extrairGrupos(resp) {
  if (!resp || !Array.isArray(resp.data)) return [];
  const outer = resp.data;
  // API devolve { data: [[ {grupo}, ... ]] } — array aninhado
  if (outer.length > 0 && Array.isArray(outer[0])) return outer[0];
  // Fallback: caso já venha flat
  return outer;
}

function extrairReserva(resp) {
  if (!resp || !Array.isArray(resp.data)) return {};
  const first = resp.data[0];
  if (first && typeof first === "object" && !Array.isArray(first)) return first;
  if (Array.isArray(first) && first.length > 0 && typeof first[0] === "object") return first[0];
  return {};
}

function parseGruposConfig(configStr) {
  const alvo = {};
  if (!configStr) return alvo;
  for (const item of configStr.split(",")) {
    const parts = item.trim().split(":");
    if (parts.length === 2 && parts[0].trim() && !isNaN(parseInt(parts[1], 10))) {
      alvo[parts[0].trim()] = parseInt(parts[1], 10);
    }
  }
  return alvo;
}

function removerGrupoDoConfig(configStr, grupoId) {
  if (!configStr) return "";
  return configStr
    .split(",")
    .map(s => s.trim())
    .filter(s => !s.startsWith(grupoId + ":"))
    .join(",");
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.buscarGrupos = buscarGrupos;
  self.extrairGrupos = extrairGrupos;
  self.extrairReserva = extrairReserva;
  self.parseGruposConfig = parseGruposConfig;
  self.removerGrupoDoConfig = removerGrupoDoConfig;
}
if (typeof module !== "undefined") {
  module.exports = { buscarGrupos, extrairGrupos, extrairReserva, parseGruposConfig, removerGrupoDoConfig };
}
