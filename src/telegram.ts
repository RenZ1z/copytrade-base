import axios from "axios";
import { logger } from "./logger";

const TG_API = "https://api.telegram.org";

let botToken: string;
let chatId: string;
let enabled = false;

export function initTelegram(): void {
  botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  chatId   = process.env.TELEGRAM_CHAT_ID ?? "";

  if (!botToken || !chatId) {
    logger.warn("⚠️  Telegram não configurado (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID ausente)");
    return;
  }
  enabled = true;
  logger.info("📱 Telegram notificações ativadas");
}

async function send(text: string): Promise<void> {
  if (!enabled) return;
  try {
    await axios.post(`${TG_API}/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, { timeout: 8000 });
  } catch (err: any) {
    logger.error(`❌ Falha ao enviar Telegram: ${err.message}`);
  }
}

// ─── NOTIFICAÇÕES ────────────────────────────────────────────────

export async function notifyBuyExecuted(params: {
  whaleWallet: string;
  tokenOut: string;
  amountUsd: number;
  sellAmountEth: number;
  ethPriceUsd: number;
  txHash: string;
  whaleTxHash: string;
  delayMs: number;
  gasCostEth?: number;
}): Promise<void> {
  const shortWallet = params.whaleWallet.slice(0, 6) + "..." + params.whaleWallet.slice(-4);
  const shortToken  = params.tokenOut.slice(0, 6) + "..." + params.tokenOut.slice(-4);
  const gasCost     = params.gasCostEth ? `${(params.gasCostEth * params.ethPriceUsd).toFixed(4)}` : "—";

  const msg = [
    `🟢 <b>COMPRA EXECUTADA</b>`,
    ``,
    `👤 Whale: <code>${shortWallet}</code>`,
    `🪙 Token: <code>${params.tokenOut}</code>`,
    `💵 Entrada: <b>$${params.amountUsd.toFixed(2)}</b> (${params.sellAmountEth.toFixed(6)} ETH)`,
    `⚡ Delay: ${params.delayMs}ms`,
    `⛽ Gas: ~$${gasCost}`,
    ``,
    `🔗 <a href="https://basescan.org/tx/${params.txHash}">Minha TX</a>  |  <a href="https://basescan.org/tx/${params.whaleTxHash}">TX da Whale</a>`,
    `📊 <a href="https://dexscreener.com/base/${params.tokenOut}">DexScreener</a>`,
  ].join("\n");

  await send(msg);
}

export async function notifySellDetected(params: {
  whaleWallet: string;
  tokenIn: string;   // token que a whale está vendendo (nosso tokenOut de entrada)
  whaleTxHash: string;
}): Promise<void> {
  const shortWallet = params.whaleWallet.slice(0, 6) + "..." + params.whaleWallet.slice(-4);

  const msg = [
    `🔴 <b>WHALE VENDENDO</b>`,
    ``,
    `👤 Whale: <code>${shortWallet}</code>`,
    `🪙 Token: <code>${params.tokenIn}</code>`,
    ``,
    `⚠️ Considera vender manualmente se tiver posição aberta nesse token.`,
    `🔗 <a href="https://basescan.org/tx/${params.whaleTxHash}">TX da Whale</a>`,
    `📊 <a href="https://dexscreener.com/base/${params.tokenIn}">DexScreener</a>`,
  ].join("\n");

  await send(msg);
}

export async function notifyBuyFailed(params: {
  whaleWallet: string;
  tokenOut: string;
  reason: string;
  whaleTxHash: string;
}): Promise<void> {
  const shortWallet = params.whaleWallet.slice(0, 6) + "..." + params.whaleWallet.slice(-4);

  const msg = [
    `⚠️ <b>TRADE FALHOU</b>`,
    ``,
    `👤 Whale: <code>${shortWallet}</code>`,
    `🪙 Token: <code>${params.tokenOut}</code>`,
    `❌ Motivo: <code>${params.reason}</code>`,
    ``,
    `🔗 <a href="https://basescan.org/tx/${params.whaleTxHash}">TX da Whale</a>`,
  ].join("\n");

  await send(msg);
}

export async function notifyInsufficientBalance(params: {
  currentEth: string;
  requiredUsd: number;
  ethPriceUsd: number;
}): Promise<void> {
  const requiredEth = (params.requiredUsd / params.ethPriceUsd).toFixed(6);

  const msg = [
    `🚨 <b>SALDO INSUFICIENTE</b>`,
    ``,
    `💰 Saldo atual: <b>${params.currentEth} ETH</b>`,
    `💸 Necessário: ~${requiredEth} ETH (~$${params.requiredUsd})`,
    ``,
    `⏸️ Bot pausado até recarregar a wallet.`,
  ].join("\n");

  await send(msg);
}

export async function notifyBotStarted(wallets: string[]): Promise<void> {
  const walletList = wallets.map(w => `  • <code>${w}</code>`).join("\n");

  const msg = [
    `🚀 <b>Bot iniciado</b>`,
    ``,
    `📡 Monitorando ${wallets.length} wallet(s):`,
    walletList,
    ``,
    `⚡ Modo: mempool (baixo delay)`,
  ].join("\n");

  await send(msg);
}

export async function notifyBotStopped(): Promise<void> {
  await send(`⛔ <b>Bot encerrado.</b>`);
}
