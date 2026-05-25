// extension/lib/state.js — constantes globais + sleep helper.
// Zero dependências. Carregado primeiro via importScripts.
//
// Expostas via self.X (SW global scope) + module.exports (Node tests).

const BASE_URL = "https://prod-api-portalparceiro-canopus.bsn.dev.br";
const ORIGIN_URL = "https://parceiros.consorciocanopus.com.br";
const alarmName = "canopusMonitor";

// HTTP retry / AIMD
const MAX_TENTATIVAS_NET = 4;             // retries só pra erros de rede
const RATE_LIMIT_BACKOFF_FACTOR = 2.0;    // AIMD multiplicative increase
const SUCCESS_DECAY_FACTOR = 0.9;         // AIMD multiplicative decrease (gentle)
const MAX_DYNAMIC_DELAY = 60;             // ceiling em segundos

// Token bucket — prevenção de rajada, dimensionado pros 3 calls por ciclo (login/skip + buscarGrupos + /reservas/add)
const BUCKET_CAPACITY       = 3;          // cobre ciclo completo sem starvation no caminho crítico
const BUCKET_REFILL_PER_SEC = 0.3;        // ~3.3s entre tokens em regime estável

// Circuit breaker
const CIRCUIT_HITS_THRESHOLD = 2;         // 2 hits em janela → abre
const CIRCUIT_WINDOW_MS      = 120_000;   // janela de 2min — captura hits espaçados
const CIRCUIT_OPEN_MS        = 10 * 60_000; // pausa de 10min

// Cooldown por grupo após RATE_LIMIT em /reservas/add — evita martelar mesmo grupoId em ciclos consecutivos
const GRUPO_COOLDOWN_MS = 30_000;

// Cooldown maior quando Turnstile falha/timeout — usuário ainda pode estar resolvendo no portal
const TURNSTILE_COOLDOWN_MS = 30_000;

// Pausa do polling loop quando content-script avisa que Turnstile está em modo interativo
const TURNSTILE_BLOQUEIO_MS = 30_000;

// URL pattern usado pelo chrome.tabs.query pra achar aba do portal
// (alinhado com matches do content_scripts no manifest pra não consultar tabs onde o script não roda)
const PORTAL_TAB_URL = "https://parceiros.consorciocanopus.com.br/apps/*";

// URL inicial usada quando o robô cria a janela minimizada (Fix 16 Lote B).
const PORTAL_BOOTSTRAP_URL = "https://parceiros.consorciocanopus.com.br/apps/reservas";

// Quanto esperar pelo content-script após criar uma janela nova antes de desistir.
// Fix 16 Lote E: 20s era curto pra Angular boot em janela minimizada throttled (~30-40s).
const MANAGED_WINDOW_READY_TIMEOUT_MS = 45_000;

// Timeout pra resposta do content-script (cobre o caso comum + Turnstile interativo)
const TAB_RESERVA_TIMEOUT_MS = 45_000;

// Floor obrigatório de DELAY_MIN/MAX (anti-rate-limit)
const FLOOR_DELAY_MIN = 7;                // alinhado com refill ~10s
const FLOOR_DELAY_MAX = 12;

// Cap interno em setTimeout — SW pode morrer; alarm re-ativa a cada 1min
const MAX_SETTIMEOUT_MS = 60_000;

// Backoff longo em rate limit no runPollingLoop
const RATE_LIMIT_BACKOFF_SEC          = 60;
const CLOUDFLARE_1015_BACKOFF_SEC     = 120;

// Smart idle
const IDLE_INCREMENT     = 0.3;           // 30% a mais por ciclo vazio
const IDLE_MAX_CICLOS    = 5;             // cap em 5 ciclos vazios

// Telemetria (opt-in pelo cliente). Ring buffer em chrome.storage.local + batching em memória.
const TELEMETRIA_MAX_ENTRIES = 500;
const TELEMETRIA_BATCH_MAX   = 10;
const TELEMETRIA_FLUSH_MS    = 2000;
const TELEMETRIA_BODY_TRUNC  = 2048;

// Sanitize regex — usadas em sanitize() de telemetria.js
const SANITIZE_REDACT_KEYS = /^(senha|password|pwd|secret)$/i;
const SANITIZE_TRUNCATE_KEYS = /^(telegram_?token|telegramtoken|TELEGRAM_TOKEN)$/i;
const SANITIZE_HEADER_KEYS = /^(token)$/i;  // header "token" do Canopus

// Horário comercial BR (minutos desde meia-noite local)
const ABERTURA_HHMM      = 7 * 60 + 55;   // 07:55
const FECHAMENTO_SEMANA  = 19 * 60 + 1;   // 19:01
const FECHAMENTO_SABADO  = 13 * 60;       // 13:00

// Telegram fetch timeout (Fix 4 H5: evita travar SW se Telegram offline)
const TELEGRAM_TIMEOUT_MS = 5_000;

// Helper genérico async sleep — usado por libs várias
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Exports ────────────────────────────────────────────────────────────────
// SW context (importScripts): popula self.X — outros libs/background acessam via global
if (typeof self !== "undefined") {
  self.BASE_URL = BASE_URL;
  self.ORIGIN_URL = ORIGIN_URL;
  self.alarmName = alarmName;
  self.MAX_TENTATIVAS_NET = MAX_TENTATIVAS_NET;
  self.RATE_LIMIT_BACKOFF_FACTOR = RATE_LIMIT_BACKOFF_FACTOR;
  self.SUCCESS_DECAY_FACTOR = SUCCESS_DECAY_FACTOR;
  self.MAX_DYNAMIC_DELAY = MAX_DYNAMIC_DELAY;
  self.BUCKET_CAPACITY = BUCKET_CAPACITY;
  self.BUCKET_REFILL_PER_SEC = BUCKET_REFILL_PER_SEC;
  self.CIRCUIT_HITS_THRESHOLD = CIRCUIT_HITS_THRESHOLD;
  self.CIRCUIT_WINDOW_MS = CIRCUIT_WINDOW_MS;
  self.CIRCUIT_OPEN_MS = CIRCUIT_OPEN_MS;
  self.GRUPO_COOLDOWN_MS = GRUPO_COOLDOWN_MS;
  self.TURNSTILE_COOLDOWN_MS = TURNSTILE_COOLDOWN_MS;
  self.TURNSTILE_BLOQUEIO_MS = TURNSTILE_BLOQUEIO_MS;
  self.PORTAL_TAB_URL = PORTAL_TAB_URL;
  self.PORTAL_BOOTSTRAP_URL = PORTAL_BOOTSTRAP_URL;
  self.MANAGED_WINDOW_READY_TIMEOUT_MS = MANAGED_WINDOW_READY_TIMEOUT_MS;
  self.TAB_RESERVA_TIMEOUT_MS = TAB_RESERVA_TIMEOUT_MS;
  self.FLOOR_DELAY_MIN = FLOOR_DELAY_MIN;
  self.FLOOR_DELAY_MAX = FLOOR_DELAY_MAX;
  self.MAX_SETTIMEOUT_MS = MAX_SETTIMEOUT_MS;
  self.RATE_LIMIT_BACKOFF_SEC = RATE_LIMIT_BACKOFF_SEC;
  self.CLOUDFLARE_1015_BACKOFF_SEC = CLOUDFLARE_1015_BACKOFF_SEC;
  self.IDLE_INCREMENT = IDLE_INCREMENT;
  self.IDLE_MAX_CICLOS = IDLE_MAX_CICLOS;
  self.TELEMETRIA_MAX_ENTRIES = TELEMETRIA_MAX_ENTRIES;
  self.TELEMETRIA_BATCH_MAX = TELEMETRIA_BATCH_MAX;
  self.TELEMETRIA_FLUSH_MS = TELEMETRIA_FLUSH_MS;
  self.TELEMETRIA_BODY_TRUNC = TELEMETRIA_BODY_TRUNC;
  self.SANITIZE_REDACT_KEYS = SANITIZE_REDACT_KEYS;
  self.SANITIZE_TRUNCATE_KEYS = SANITIZE_TRUNCATE_KEYS;
  self.SANITIZE_HEADER_KEYS = SANITIZE_HEADER_KEYS;
  self.ABERTURA_HHMM = ABERTURA_HHMM;
  self.FECHAMENTO_SEMANA = FECHAMENTO_SEMANA;
  self.FECHAMENTO_SABADO = FECHAMENTO_SABADO;
  self.TELEGRAM_TIMEOUT_MS = TELEGRAM_TIMEOUT_MS;
  self.sleep = sleep;
}

// Node test context (Jest): module.exports pra background.js fazer Object.assign(global, ...)
if (typeof module !== "undefined") {
  module.exports = {
    BASE_URL, ORIGIN_URL, alarmName,
    MAX_TENTATIVAS_NET, RATE_LIMIT_BACKOFF_FACTOR, SUCCESS_DECAY_FACTOR, MAX_DYNAMIC_DELAY,
    BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC,
    CIRCUIT_HITS_THRESHOLD, CIRCUIT_WINDOW_MS, CIRCUIT_OPEN_MS,
    GRUPO_COOLDOWN_MS, TURNSTILE_COOLDOWN_MS, TURNSTILE_BLOQUEIO_MS,
    PORTAL_TAB_URL, PORTAL_BOOTSTRAP_URL,
    MANAGED_WINDOW_READY_TIMEOUT_MS, TAB_RESERVA_TIMEOUT_MS,
    FLOOR_DELAY_MIN, FLOOR_DELAY_MAX, MAX_SETTIMEOUT_MS,
    RATE_LIMIT_BACKOFF_SEC, CLOUDFLARE_1015_BACKOFF_SEC,
    IDLE_INCREMENT, IDLE_MAX_CICLOS,
    TELEMETRIA_MAX_ENTRIES, TELEMETRIA_BATCH_MAX, TELEMETRIA_FLUSH_MS, TELEMETRIA_BODY_TRUNC,
    SANITIZE_REDACT_KEYS, SANITIZE_TRUNCATE_KEYS, SANITIZE_HEADER_KEYS,
    ABERTURA_HHMM, FECHAMENTO_SEMANA, FECHAMENTO_SABADO,
    TELEGRAM_TIMEOUT_MS,
    sleep
  };
}
