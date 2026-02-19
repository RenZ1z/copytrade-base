import "dotenv/config";
import { ethers } from "ethers";
import WebSocket from "ws";
import { logger } from "./logger";
import { decodeSwap } from "./decoder";
import { executeCopyTrade } from "./trader";
import { initJournal, insertTrade, updateTradeConfirmed, skipTrade } from "./journal";
import { initTelegram, notifyBotStarted, notifyBotStopped, notifyBuyExecuted, notifyBuyFailed, notifySellDetected, notifyInsufficientBalance } from "./telegram";
import fs from "fs";

// Cria diretório de logs se não existir
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// Validação de env vars obrigatórias
const REQUIRED_ENV = [
  "ALCHEMY_WS_URL",
  "ALCHEMY_HTTP_URL",
  "ZEROX_API_KEY",
  "MY_WALLET_ADDRESS",
  "MY_PRIVATE_KEY",
  "TARGET_WALLETS",
  "TRADE_AMOUNT_USD",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error(`❌ Variável de ambiente faltando: ${key}`);
    process.exit(1);
  }
}

const TARGET_WALLETS: string[] = process.env
  .TARGET_WALLETS!.split(",")
  .map((w) => w.trim().toLowerCase());

const TRADE_AMOUNT_USD = parseFloat(process.env.TRADE_AMOUNT_USD!);
const WETH = process.env.WETH_ADDRESS!;

// Cooldown por wallet para evitar copiar múltiplas TXs do mesmo burst
const lastTrade: Map<string, number> = new Map();
const COOLDOWN_MS = 30_000;

// Controle de TXs já processadas (evita duplicatas pending → confirmed)
const processedTxs = new Set<string>();

// Pending TXs que estamos aguardando confirmação para buscar o tokenOut via receipt
// key: txHash, value: { from, tokenOut (se já decodificado), timestamp }
interface PendingEntry {
  from: string;
  tokenOut?: string;
  tokenIn: string;
  detectedAt: number;
}
const pendingTrades = new Map<string, PendingEntry>();

// Timeout máximo para aguardar confirmação de uma pending TX (60s)
const PENDING_TIMEOUT_MS = 60_000;

let httpProvider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let ws: WebSocket;
let wsReady = false;

// ─────────────────────────────────────────────
// PROCESSAMENTO DE TX PENDENTE (mempool)
// Detectamos a intenção da whale antes de confirmar
// ─────────────────────────────────────────────
async function handlePendingTx(tx: {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}): Promise<void> {
  const from = tx.from.toLowerCase();
  if (!TARGET_WALLETS.includes(from)) return;
  if (processedTxs.has(tx.hash)) return;

  logger.info(`⚡ [MEMPOOL] TX da whale detectada: ${tx.hash}`);

  const swap = decodeSwap({
    data: tx.input,
    value: BigInt(tx.value ?? "0"),
  });

  if (!swap.isSwap) {
    logger.info(`⏭️  Não é swap (selector: ${tx.input.slice(0, 10)})`);
    return;
  }

  logger.info(`🔄 Swap no mempool via ${swap.protocol}`);

  // Cooldown por wallet
  const now = Date.now();
  const lastTime = lastTrade.get(from) ?? 0;
  if (now - lastTime < COOLDOWN_MS) {
    logger.warn(`⏳ Cooldown ativo para ${from}, ignorando`);
    return;
  }

  const tokenIn = swap.tokenIn ?? WETH;
  const tokenOut = swap.tokenOut;

  if (tokenOut) {
    // Temos tudo que precisamos — executa AGORA sem esperar confirmação
    logger.info(`🚀 tokenOut decodificado direto do mempool, executando imediatamente`);
    processedTxs.add(tx.hash);
    lastTrade.set(from, now);

    // Checagem de saldo antes de tentar executar
    const balance = await httpProvider.getBalance(process.env.MY_WALLET_ADDRESS!);
    const ethPriceForCheck = 2000; // estimativa conservadora
    const requiredEth = (TRADE_AMOUNT_USD / ethPriceForCheck) * 1.05; // +5% buffer pra gas
    if (balance < ethers.parseEther(requiredEth.toFixed(8))) {
      logger.warn(`⚠️  Saldo insuficiente (${ethers.formatEther(balance)} ETH), pulando trade`);
      await notifyInsufficientBalance({
        currentEth: parseFloat(ethers.formatEther(balance)).toFixed(6),
        requiredUsd: TRADE_AMOUNT_USD,
        ethPriceUsd: ethPriceForCheck,
      });
      return;
    }

    const executedAtMs = Date.now();
    const tradeId = insertTrade({
      whale_wallet: from,
      my_wallet: process.env.MY_WALLET_ADDRESS!,
      token_in: tokenIn,
      token_out: tokenOut,
      amount_usd: TRADE_AMOUNT_USD,
      sell_amount_eth: 0,
      buy_amount_raw: "",
      eth_price_usd: 0,
      detected_at_ms: now,
      executed_at_ms: executedAtMs,
      delay_ms: executedAtMs - now,
      whale_tx_hash: tx.hash,
      status: "pending",
    });

    const result = await executeCopyTrade({
      tokenIn,
      tokenOut,
      amountUsd: TRADE_AMOUNT_USD,
      walletAddress: process.env.MY_WALLET_ADDRESS!,
      signer,
      provider: httpProvider,
    });

    if (result.status === "skipped") {
      skipTrade(tradeId, result.skipReason ?? "unknown");
      // Whale vendeu pra ETH — avisa no Telegram pra você checar posição aberta
      if (result.skipReason === "whale_sold_to_eth") {
        await notifySellDetected({ whaleWallet: from, tokenIn, whaleTxHash: tx.hash });
      }
    } else {
      updateTradeConfirmed(tradeId, {
        status: result.status,
        confirmed_at_ms: result.confirmedAtMs ?? Date.now(),
        block_number: result.blockNumber,
        gas_used: result.gasUsed,
        gas_price_gwei: result.gasPriceGwei,
        gas_cost_eth: result.gasCostEth,
        my_tx_hash: result.txHash,
        error_msg: result.errorMsg,
      });
      const { db } = require("./journal");
      db.prepare("UPDATE trades SET sell_amount_eth = ?, buy_amount_raw = ?, eth_price_usd = ? WHERE id = ?")
        .run(result.sellAmountEth, result.buyAmountRaw ?? "", result.ethPriceUsd, tradeId);

      if (result.status === "success" && result.txHash) {
        await notifyBuyExecuted({
          whaleWallet: from,
          tokenOut,
          amountUsd: TRADE_AMOUNT_USD,
          sellAmountEth: result.sellAmountEth,
          ethPriceUsd: result.ethPriceUsd,
          txHash: result.txHash,
          whaleTxHash: tx.hash,
          delayMs: executedAtMs - now,
          gasCostEth: result.gasCostEth,
        });
      } else if (result.status === "failed") {
        await notifyBuyFailed({
          whaleWallet: from,
          tokenOut,
          reason: result.errorMsg ?? "unknown",
          whaleTxHash: tx.hash,
        });
      }
    }
  } else {
    // Protocolo que não conseguimos decodificar completamente (ex: Universal Router)
    // Guarda na fila e aguarda confirmação para pegar o tokenOut via receipt
    logger.info(`⏳ tokenOut não decodificável via input, aguardando confirmação...`);
    pendingTrades.set(tx.hash, {
      from,
      tokenIn,
      tokenOut: undefined,
      detectedAt: now,
    });
  }
}

// ─────────────────────────────────────────────
// PROCESSAMENTO DE TX CONFIRMADA (bloco)
// Usado para resolver pendingTrades sem tokenOut
// ─────────────────────────────────────────────
async function handleConfirmedTx(txHash: string): Promise<void> {
  const pending = pendingTrades.get(txHash);
  if (!pending) return; // não era nossa

  pendingTrades.delete(txHash);

  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);

  const elapsed = Date.now() - pending.detectedAt;
  logger.info(`✅ TX confirmada ${txHash} (${elapsed}ms após detecção no mempool)`);

  // Busca receipt para extrair tokenOut via eventos Transfer
  const receipt = await httpProvider.getTransactionReceipt(txHash);
  if (!receipt) {
    logger.warn("⚠️  Receipt não disponível, abortando");
    return;
  }

  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const relevantLogs = receipt.logs.filter(
    (log) =>
      log.topics[0] === transferTopic &&
      log.topics[2] &&
      ethers.dataSlice(log.topics[2], 12).toLowerCase() === pending.from
  );

  if (relevantLogs.length === 0) {
    logger.warn("⚠️  Não foi possível identificar o token comprado no receipt");
    return;
  }

  const tokenOut = relevantLogs[relevantLogs.length - 1].address;
  logger.info(`🪙 tokenOut identificado via receipt: ${tokenOut}`);

  // Verifica cooldown novamente (pode ter passado da janela)
  const now = Date.now();
  const lastTime = lastTrade.get(pending.from) ?? 0;
  if (now - lastTime < COOLDOWN_MS) {
    logger.warn(`⏳ Cooldown ativo para ${pending.from}, abortando trade`);
    return;
  }
  lastTrade.set(pending.from, now);

  // Checagem de saldo antes de executar
  const balance2 = await httpProvider.getBalance(process.env.MY_WALLET_ADDRESS!);
  const requiredEth2 = (TRADE_AMOUNT_USD / 2000) * 1.05;
  if (balance2 < ethers.parseEther(requiredEth2.toFixed(8))) {
    logger.warn(`⚠️  Saldo insuficiente (${ethers.formatEther(balance2)} ETH), pulando trade`);
    await notifyInsufficientBalance({
      currentEth: parseFloat(ethers.formatEther(balance2)).toFixed(6),
      requiredUsd: TRADE_AMOUNT_USD,
      ethPriceUsd: 2000,
    });
    return;
  }

  const executedAtMs2 = Date.now();
  const tradeId2 = insertTrade({
    whale_wallet: pending.from,
    my_wallet: process.env.MY_WALLET_ADDRESS!,
    token_in: pending.tokenIn,
    token_out: tokenOut,
    amount_usd: TRADE_AMOUNT_USD,
    sell_amount_eth: 0,
    buy_amount_raw: "",
    eth_price_usd: 0,
    detected_at_ms: pending.detectedAt,
    executed_at_ms: executedAtMs2,
    delay_ms: executedAtMs2 - pending.detectedAt,
    whale_tx_hash: txHash,
    status: "pending",
  });

  const result2 = await executeCopyTrade({
    tokenIn: pending.tokenIn,
    tokenOut,
    amountUsd: TRADE_AMOUNT_USD,
    walletAddress: process.env.MY_WALLET_ADDRESS!,
    signer,
    provider: httpProvider,
  });

  if (result2.status === "skipped") {
    skipTrade(tradeId2, result2.skipReason ?? "unknown");
    if (result2.skipReason === "whale_sold_to_eth") {
      await notifySellDetected({ whaleWallet: pending.from, tokenIn: pending.tokenIn, whaleTxHash: txHash });
    }
  } else {
    updateTradeConfirmed(tradeId2, {
      status: result2.status,
      confirmed_at_ms: result2.confirmedAtMs ?? Date.now(),
      block_number: result2.blockNumber,
      gas_used: result2.gasUsed,
      gas_price_gwei: result2.gasPriceGwei,
      gas_cost_eth: result2.gasCostEth,
      my_tx_hash: result2.txHash,
      error_msg: result2.errorMsg,
    });
    const { db } = require("./journal");
    db.prepare("UPDATE trades SET sell_amount_eth = ?, buy_amount_raw = ?, eth_price_usd = ? WHERE id = ?")
      .run(result2.sellAmountEth, result2.buyAmountRaw ?? "", result2.ethPriceUsd, tradeId2);

    if (result2.status === "success" && result2.txHash) {
      await notifyBuyExecuted({
        whaleWallet: pending.from,
        tokenOut,
        amountUsd: TRADE_AMOUNT_USD,
        sellAmountEth: result2.sellAmountEth,
        ethPriceUsd: result2.ethPriceUsd,
        txHash: result2.txHash,
        whaleTxHash: txHash,
        delayMs: executedAtMs2 - pending.detectedAt,
        gasCostEth: result2.gasCostEth,
      });
    } else if (result2.status === "failed") {
      await notifyBuyFailed({
        whaleWallet: pending.from,
        tokenOut,
        reason: result2.errorMsg ?? "unknown",
        whaleTxHash: txHash,
      });
    }
  }
}

// ─────────────────────────────────────────────
// LIMPEZA DE PENDING TXs EXPIRADAS
// Remove TXs que provavelmente foram dropadas do mempool
// ─────────────────────────────────────────────
function cleanExpiredPending(): void {
  const now = Date.now();
  for (const [hash, entry] of pendingTrades.entries()) {
    if (now - entry.detectedAt > PENDING_TIMEOUT_MS) {
      logger.warn(`🗑️  TX ${hash} expirou sem confirmação (provavelmente dropada)`);
      pendingTrades.delete(hash);
    }
  }
}

// ─────────────────────────────────────────────
// WEBSOCKET RAW — usa alchemy_pendingTransactions
// ethers.js não suporta esse método nativamente
// ─────────────────────────────────────────────
function connectWS(): void {
  logger.info("🔌 Conectando ao WebSocket da Alchemy...");
  ws = new WebSocket(process.env.ALCHEMY_WS_URL!);

  ws.on("open", () => {
    wsReady = true;
    logger.info("✅ WebSocket conectado");

    // Subscreve em pending TXs das wallets alvo via alchemy_pendingTransactions
    // Esse método filtra diretamente no lado do Alchemy — não recebe lixo
    const pendingSubPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: [
        "alchemy_pendingTransactions",
        {
          fromAddress: TARGET_WALLETS,
          hashesOnly: false, // recebe a TX completa, não só o hash
        },
      ],
    };
    ws.send(JSON.stringify(pendingSubPayload));

    // Subscreve em novos blocos para resolver pendingTrades
    const blockSubPayload = {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_subscribe",
      params: ["newHeads"],
    };
    ws.send(JSON.stringify(blockSubPayload));

    logger.info(`👀 Monitorando mempool de ${TARGET_WALLETS.length} wallet(s)`);
  });

  // IDs de subscrição retornados pelo Alchemy
  let pendingSubId: string | null = null;
  let blockSubId: string | null = null;

  ws.on("message", async (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Resposta da subscrição — captura os IDs
      if (msg.id === 1 && msg.result) {
        pendingSubId = msg.result;
        logger.info(`📡 Pending sub ID: ${pendingSubId}`);
        return;
      }
      if (msg.id === 2 && msg.result) {
        blockSubId = msg.result;
        logger.info(`📡 Block sub ID: ${blockSubId}`);
        return;
      }

      if (!msg.params?.subscription) return;

      // Evento de pending TX
      if (msg.params.subscription === pendingSubId) {
        const tx = msg.params.result;
        if (tx?.hash && tx?.from) {
          handlePendingTx(tx).catch((err) =>
            logger.error(`Erro no handler pending: ${err.message}`)
          );
        }
        return;
      }

      // Evento de novo bloco — processa confirmações de pendingTrades
      if (msg.params.subscription === blockSubId) {
        // Limpa expirados
        cleanExpiredPending();

        if (pendingTrades.size === 0) return;

        // Busca o bloco completo para varrer as TXs confirmadas
        const blockHash = msg.params.result?.hash;
        if (!blockHash) return;

        const block = await httpProvider.getBlock(blockHash, false);
        if (!block?.transactions) return;

        for (const txHash of block.transactions) {
          if (pendingTrades.has(txHash)) {
            handleConfirmedTx(txHash).catch((err) =>
              logger.error(`Erro no handler confirmed: ${err.message}`)
            );
          }
        }
      }
    } catch (err: any) {
      logger.error(`Erro ao processar mensagem WS: ${err.message}`);
    }
  });

  ws.on("error", (err) => {
    logger.error(`❌ WebSocket error: ${err.message}`);
  });

  ws.on("close", () => {
    wsReady = false;
    logger.warn("🔌 WebSocket desconectado, reconectando em 3s...");
    setTimeout(connectWS, 3000);
  });

  // Heartbeat: envia ping a cada 30s para manter conexão viva
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeat);
    }
  }, 30_000);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function startMonitor(): Promise<void> {
  logger.info("🚀 Copy Trade Bot (Mempool Mode) iniciando...");
  logger.info(`👛 Monitorando ${TARGET_WALLETS.length} wallet(s):`);
  TARGET_WALLETS.forEach((w) => logger.info(`   → ${w}`));
  logger.info(`💵 Valor por trade: $${TRADE_AMOUNT_USD} USD`);

  initJournal();
  initTelegram();
  httpProvider = new ethers.JsonRpcProvider(process.env.ALCHEMY_HTTP_URL!);
  signer = new ethers.Wallet(process.env.MY_PRIVATE_KEY!, httpProvider);

  logger.info(`🔑 Bot wallet: ${await signer.getAddress()}`);

  const balance = await httpProvider.getBalance(signer.getAddress());
  logger.info(`💰 Saldo ETH: ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther("0.005")) {
    logger.warn("⚠️  Saldo baixo! Mantenha pelo menos 0.005 ETH para gas");
  }

  await notifyBotStarted(TARGET_WALLETS);
  connectWS();
}

process.on("SIGINT", async () => {
  logger.info("⛔ Encerrando bot...");
  await notifyBotStopped();
  ws?.close();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logger.error(`💥 Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`💥 Unhandled rejection: ${reason}`);
});

startMonitor();
