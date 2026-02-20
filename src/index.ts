import "dotenv/config";
import { ethers } from "ethers";
import WebSocket from "ws";
import { logger } from "./logger";
import { decodeSwap } from "./decoder";
import { executeCopyTrade, executeCopySell } from "./trader";
import { initTelegram, notifyBotStarted, notifyBotStopped, notifyBuyExecuted, notifyBuyFailed, notifySellDetected, notifySellExecuted, notifySellFailed, notifyInsufficientBalance } from "./telegram";
import fs from "fs";

if (!fs.existsSync("logs")) fs.mkdirSync("logs");

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
const WETH = process.env.WETH_ADDRESS!.toLowerCase();
const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const lastTrade: Map<string, number> = new Map();
const COOLDOWN_MS = 10_000;
const processedTxs = new Set<string>();

// ─────────────────────────────────────────────
// POSIÇÕES ABERTAS COM PERSISTÊNCIA EM ARQUIVO
// ─────────────────────────────────────────────
const POSITIONS_FILE = "data/positions.json";

function loadPositions(): Map<string, Set<string>> {
  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data");
    if (!fs.existsSync(POSITIONS_FILE)) return new Map();
    const raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
    const obj: Record<string, string[]> = JSON.parse(raw);
    const map = new Map<string, Set<string>>();
    for (const [whale, tokens] of Object.entries(obj)) {
      map.set(whale, new Set(tokens));
    }
    logger.info(`📂 Posições carregadas do disco: ${JSON.stringify(obj)}`);
    return map;
  } catch {
    logger.warn("⚠️  Não foi possível carregar posições do disco, iniciando zerado");
    return new Map();
  }
}

function savePositions(map: Map<string, Set<string>>) {
  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data");
    const obj: Record<string, string[]> = {};
    for (const [whale, tokens] of map.entries()) {
      if (tokens.size > 0) obj[whale] = Array.from(tokens);
    }
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err: any) {
    logger.error(`❌ Erro ao salvar posições: ${err.message}`);
  }
}

const openPositions: Map<string, Set<string>> = loadPositions();

function addPosition(whaleAddress: string, tokenAddress: string) {
  const addr = whaleAddress.toLowerCase();
  const token = tokenAddress.toLowerCase();
  if (!openPositions.has(addr)) openPositions.set(addr, new Set());
  openPositions.get(addr)!.add(token);
  savePositions(openPositions);
  logger.info(`📌 Posição registrada: ${token} (whale: ${addr})`);
}

function removePosition(whaleAddress: string, tokenAddress: string) {
  const addr = whaleAddress.toLowerCase();
  const token = tokenAddress.toLowerCase();
  openPositions.get(addr)?.delete(token);
  savePositions(openPositions);
  logger.info(`🗑️  Posição removida: ${token}`);
}

function getPositions(whaleAddress: string): string[] {
  return Array.from(openPositions.get(whaleAddress.toLowerCase()) ?? []);
}

let httpProvider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let ws: WebSocket;

function isEth(token: string): boolean {
  const t = token.toLowerCase();
  return t === WETH || t === ETH_ADDRESS;
}

async function resolveTokenOut(txHash: string, whaleFrom: string): Promise<string | null> {
  let receipt = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    receipt = await httpProvider.getTransactionReceipt(txHash);
    if (receipt) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!receipt) {
    logger.warn(`⚠️  Receipt não encontrado após 20s para ${txHash}`);
    return null;
  }

  const withdrawalTopic = ethers.id("Withdrawal(address,uint256)");
  const withdrawalLog = receipt.logs.find(
    (log) => log.topics[0] === withdrawalTopic && log.address.toLowerCase() === WETH
  );
  if (withdrawalLog) {
    logger.info(`💰 WETH Withdrawal detectado - whale recebeu ETH nativo`);
    return WETH;
  }

  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const relevantLogs = receipt.logs.filter(
    (log) =>
      log.topics[0] === transferTopic &&
      log.topics[2] &&
      ethers.dataSlice(log.topics[2], 12).toLowerCase() === whaleFrom.toLowerCase()
  );
  if (relevantLogs.length === 0) {
    logger.warn(`⚠️  Nenhum Transfer para ${whaleFrom} encontrado no receipt`);
    return null;
  }
  return relevantLogs[relevantLogs.length - 1].address;
}

async function handleSwap(tx: {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}, tokenOut: string): Promise<void> {
  const from = tx.from.toLowerCase();

  if (isEth(tokenOut)) {
    logger.info(`🔔 WHALE VENDEU! Verificando posições abertas...`);
    const positions = getPositions(from);
    logger.info(`📋 Posições abertas pra ${from}: [${positions.join(', ') || 'nenhuma'}]`);

    if (positions.length === 0) {
      logger.info(`⏭️  Sem posições abertas pra vender`);
      await notifySellDetected({ whaleWallet: from, tokenIn: "unknown", whaleTxHash: tx.hash });
      return;
    }

    for (const tokenIn of positions) {
      logger.info(`💸 Vendendo posição: ${tokenIn}`);
      const result = await executeCopySell({
        tokenIn,
        walletAddress: process.env.MY_WALLET_ADDRESS!,
        signer,
        provider: httpProvider,
      });

      if (result.status === "success" && result.txHash) {
        removePosition(from, tokenIn);
        await notifySellExecuted({
          whaleWallet: from,
          tokenIn,
          receivedEth: result.sellAmountEth,
          txHash: result.txHash,
          whaleTxHash: tx.hash,
          gasCostEth: result.gasCostEth,
        });
      } else if (result.status === "skipped") {
        removePosition(from, tokenIn);
        logger.info(`⏭️  Sem saldo de ${tokenIn}, removendo posição`);
      } else {
        await notifySellFailed({
          whaleWallet: from,
          tokenIn,
          reason: result.errorMsg ?? "unknown",
          whaleTxHash: tx.hash,
        });
      }
    }
    return;
  }

  // COMPRA
  const now = Date.now();
  const lastTime = lastTrade.get(from) ?? 0;
  if (now - lastTime < COOLDOWN_MS) {
    logger.warn(`⏳ Cooldown ativo para ${from}, ignorando compra`);
    return;
  }
  lastTrade.set(from, now);

  const balance = await httpProvider.getBalance(process.env.MY_WALLET_ADDRESS!);
  const requiredEth = (TRADE_AMOUNT_USD / 2000) * 1.05;
  if (balance < ethers.parseEther(requiredEth.toFixed(8))) {
    logger.warn(`⚠️  Saldo insuficiente (${ethers.formatEther(balance)} ETH), pulando trade`);
    await notifyInsufficientBalance({
      currentEth: parseFloat(ethers.formatEther(balance)).toFixed(6),
      requiredUsd: TRADE_AMOUNT_USD,
      ethPriceUsd: 2000,
    });
    return;
  }

  const result = await executeCopyTrade({
    tokenOut,
    amountUsd: TRADE_AMOUNT_USD,
    walletAddress: process.env.MY_WALLET_ADDRESS!,
    signer,
    provider: httpProvider,
  });

  if (result.status === "success" && result.txHash) {
    addPosition(from, tokenOut);
    await notifyBuyExecuted({
      whaleWallet: from,
      tokenOut,
      amountUsd: TRADE_AMOUNT_USD,
      sellAmountEth: result.sellAmountEth,
      ethPriceUsd: result.ethPriceUsd,
      txHash: result.txHash,
      whaleTxHash: tx.hash,
      delayMs: Date.now() - now,
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
    to: tx.to ?? undefined,
  });

  if (!swap.isSwap) {
    logger.info(`⏭️  Não é swap (selector: ${tx.input.slice(0, 10)})`);
    return;
  }

  logger.info(`🔄 Swap no mempool via ${swap.protocol}`);
  processedTxs.add(tx.hash);

  if (swap.tokenOut) {
    await handleSwap(tx, swap.tokenOut);
  } else {
    logger.info(`⏳ tokenOut não decodificável, aguardando receipt em 3s...`);
    setTimeout(async () => {
      try {
        const tokenOut = await resolveTokenOut(tx.hash, from);
        if (tokenOut) {
          logger.info(`🪙 tokenOut resolvido via receipt: ${tokenOut}`);
          await handleSwap(tx, tokenOut);
        }
      } catch (err: any) {
        logger.error(`❌ Erro no fallback receipt para ${tx.hash}: ${err.message}`);
      }
    }, 3000);
  }
}

function connectWS(): void {
  logger.info("🔌 Conectando ao WebSocket da Alchemy...");
  ws = new WebSocket(process.env.ALCHEMY_WS_URL!);

  ws.on("open", () => {
    logger.info("✅ WebSocket conectado");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["newHeads"],
    }));
    logger.info(`👀 Monitorando blocos para ${TARGET_WALLETS.length} wallet(s)`);
  });

  let blockSubId: string | null = null;

  ws.on("message", async (raw: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.id === 1 && msg.result) {
        blockSubId = msg.result;
        logger.info(`📡 Block sub ID: ${blockSubId}`);
        return;
      }
      if (!msg.params?.subscription || msg.params.subscription !== blockSubId) return;

      const blockHash = msg.params.result?.hash;
      if (!blockHash) return;

      logger.info(`📦 Bloco recebido: ${blockHash}`);

      const rpcRes = await fetch(process.env.ALCHEMY_HTTP_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByHash",
          params: [blockHash, true],
        }),
      });
      const rpcJson = await rpcRes.json() as any;
      const txs: any[] = rpcJson?.result?.transactions ?? [];

      for (const tx of txs) {
        if (!tx?.from) continue;
        const from = (tx.from as string).toLowerCase();
        if (TARGET_WALLETS.includes(from)) {
          handlePendingTx({
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            input: tx.input ?? "0x",
            value: tx.value ?? "0x0",
          }).catch((err) => logger.error(`Erro no handler tx: ${err.message}`));
        }
      }
    } catch (err: any) {
      logger.error(`Erro ao processar mensagem WS: ${err.message}`);
    }
  });

  ws.on("error", (err) => logger.error(`❌ WebSocket error: ${err.message}`));
  ws.on("close", () => {
    logger.warn("🔌 WebSocket desconectado, reconectando em 3s...");
    setTimeout(connectWS, 3000);
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(heartbeat);
  }, 30_000);
}

async function startMonitor(): Promise<void> {
  logger.info("🚀 Copy Trade Bot (Mempool Mode) iniciando...");
  logger.info(`👛 Monitorando ${TARGET_WALLETS.length} wallet(s):`);
  TARGET_WALLETS.forEach((w) => logger.info(`   → ${w}`));
  logger.info(`💵 Valor por trade: $${TRADE_AMOUNT_USD} USD`);

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
