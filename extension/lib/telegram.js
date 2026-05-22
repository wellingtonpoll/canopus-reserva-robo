// extension/lib/telegram.js — fetch ao Telegram Bot API com AbortController timeout.
// Deps: state (TELEGRAM_TIMEOUT_MS).

async function telegramNotify(msg) {
  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = await chrome.storage.local.get([
    "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"
  ]);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
      signal: controller.signal
    });
  } catch (_) { /* timeout, offline ou erro do servidor — não bloqueia ciclo */ }
  finally {
    clearTimeout(timeout);
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") self.telegramNotify = telegramNotify;
if (typeof module !== "undefined") module.exports = { telegramNotify };
