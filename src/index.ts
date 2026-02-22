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

const processedTxs = new Set<string>();

// ─────────────────────────────────────────────
// ESTRUTURA DE POSIÇÕES — FIFO por token
// ─────────────────────────────────────────────
interface Position {
  token: string;
  whaleTx: string;
  myTx: string;
  amountUsd: number;
  timestamp: number;
}

const POSITIONS_FILE = "data/positions.json";

function loadPositions(): Map<string, Position[]> {
  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data");
    if (!fs.existsSync(POSITIONS_FILE)) return new Map();
    const raw = fs.readFileSync(POSITIONS_FILE, "utf-8");
    const obj: Record<string, Position[]> = JSON.parse(raw);
    const map = new Map<string, Position[]>();
    for (const [whale, positions] of Object.entries(obj)) {
      map.set(whale, positions);
    }
    logger.info(`📂 Posições carregadas do disco: ${JSON.stringify(obj)}`);
    return map;
  } catch {
    logger.warn("⚠️  Não foi possível carregar posições do disco, iniciando zerado");
    return new Map();
  }
}

function savePositions(map: Map<string, Position[]>) {
  try {
    if (!fs.existsSync("data")) fs.mkdirSync("data");
    const obj: Record<string, Position[]> = {};
    for (const [whale, positions] of map.entries()) {
      if (positions.length > 0) obj[whale] = positions;
    }
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err: any) {
    logger.error(`❌ Erro ao salvar posições: ${err.message}`);
  }
}

const openPositions: Map<string, Position[]> = loadPositions();

function addPosition(whaleAddress: string, position: Position) {
  const addr = whaleAddress.toLowerCase();
  if (!openPositions.has(addr)) openPositions.set(addr, []);
  openPositions.get(addr)!.push(position);
  savePositions(openPositions);
  logger.info(`📌 Posição registrada: ${position.token} (whale: ${addr}) [total: ${openPositions.get(addr)!.length}]`);
}

// Remove a primeira posição do token (FIFO) e retorna ela
function popPosition(whaleAddress: string, token: string): Position | null {
  const addr = whaleAddress.toLowerCase();
  const tok = token.toLowerCase();
  const positions = openPositions.get(addr);
  if (!positions) return null;
  const idx = positions.findIndex(p => p.token === tok);
  if (idx === -1) return null;
  const [removed] = positions.splice(idx, 1);
  savePositions(openPositions);
  logger.info(`🗑️  Posição removida: ${tok} (whale: ${addr}) [restantes: ${positions.filter(p => p.token === tok).length}]`);
  return removed;
}

// Retorna todas as posições de um token específico
function getPositionsForToken(whaleAddress: string, token: string): Position[] {
  const addr = whaleAddress.toLowerCase();
  const tok = token.toLowerCase();
  return (openPositions.get(addr) ?? []).filter(p => p.token === tok);
}

// Retorna tokens únicos com posição aberta
function getUniqueTokens(whaleAddress: string): string[] {
  const addr = whaleAddress.toLowerCase();
  const positions = openPositions.get(addr) ?? [];
  return [...new Set(positions.map(p => p.token))];
}

// Conta quantas posições abertas tem de um token
function countPositions(whaleAddress: string, token: string): number {
  return getPositionsForToken(whaleAddress, token).length;
}

let httpProvider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let ws: WebSocket;

function isEth(token: string): boolean {
  const t = token.toLowerCase();
  return t === WETH || t === ETH_ADDRESS;
}

async function resolveSwapInfo(txHash: string, whaleFrom: string): Promise<{ tokenSold: string | null; isEthOut: boolean }> {
  let receipt = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    receipt = await httpProvider.getTransactionReceipt(txHash);
    if (receipt) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!receipt) {
    logger.warn(`⚠️  Receipt não encontrado após 20s para ${txHash}`);
    return { tokenSold: null, isEthOut: false };
  }

  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const withdrawalTopic = ethers.id("Withdrawal(address,uint256)");

  const isEthOut = receipt.logs.some(
    (log) => log.topics[0] === withdrawalTopic && log.address.toLowerCase() === WETH
  );

  // Token que SAIU da whale (ela vendeu)
  const soldLog = receipt.logs.find(
    (log) =>
      log.topics[0] === transferTopic &&
      log.topics[1] &&
      ethers.dataSlice(log.topics[1], 12).toLowerCase() === whaleFrom.toLowerCase() &&
      log.address.toLowerCase() !== WETH
  );

  // Token que ENTROU na whale (ela comprou)
  const boughtLog = receipt.logs.find(
    (log) =>
      log.topics[0] === transferTopic &&
      log.topics[2] &&
      ethers.dataSlice(log.topics[2], 12).toLowerCase() === whaleFrom.toLowerCase() &&
      log.address.toLowerCase() !== WETH
  );

  if (isEthOut && soldLog) {
    logger.info(`💰 Whale vendeu ${soldLog.address} → ETH`);
    return { tokenSold: soldLog.address.toLowerCase(), isEthOut: true };
  }

  if (isEthOut && !soldLog) {
    logger.warn(`⚠️  WETH withdrawal detectado mas tokenSold não identificado — fallback`);
    return { tokenSold: null, isEthOut: true };
  }

  if (boughtLog) {
    return { tokenSold: null, isEthOut: false };
  }

  logger.warn(`⚠️  Não foi possível identificar swap no receipt de ${txHash}`);
  return { tokenSold: null, isEthOut: false };
}

async function handleSwap(tx: {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
}, tokenOut: string, tokenSold?: string | null): Promise<void> {
  const from = tx.from.toLowerCase();

  if (isEth(tokenOut)) {
    logger.info(`🔔 WHALE VENDEU! Verificando posições abertas...`);

    // Determina quais tokens vender
    let tokensToSell: string[];
    if (tokenSold) {
      const count = countPositions(from, tokenSold);
      if (count === 0) {
        // Whale vendeu token que não temos (compra falhou ou nunca comprou)
        // → NOTIFICA qual token foi vendido, mas NÃO vende nada
        logger.info(`⏭️  Whale vendeu ${tokenSold} mas não temos posição`);
        await notifySellDetected({ whaleWallet: from, tokenIn: tokenSold, whaleTxHash: tx.hash });
        return;
      }
      logger.info(`🎯 Venda específica: ${tokenSold} (${count} posição(ões) abertas)`);
      tokensToSell = [tokenSold];
    } else {
      // tokenSold === null (não conseguiu identificar o que a whale vendeu)
      // → NOTIFICA no telegram, mas NÃO vende nada automaticamente
      logger.warn(`⚠️  Token vendido não identificado, avisando no telegram`);
      await notifySellDetected({ whaleWallet: from, tokenIn: "unknown", whaleTxHash: tx.hash });
      return;
    }

    for (const tokenIn of tokensToSell) {
      const remaining = countPositions(from, tokenIn);
      logger.info(`💸 Vendendo 1 de ${remaining} posição(ões) de ${tokenIn}`);

      // Calcula fração a vender: 1/remaining do saldo atual
      const fraction = 1 / remaining;
      logger.info(`📊 Fração a vender: ${(fraction * 100).toFixed(1)}% do saldo`);

      const result = await executeCopySell({
        tokenIn,
        walletAddress: process.env.MY_WALLET_ADDRESS!,
        signer,
        provider: httpProvider,
        fraction, // nova prop
      });

      if (result.status === "success" && result.txHash) {
        popPosition(from, tokenIn);
        await notifySellExecuted({
          whaleWallet: from,
          tokenIn,
          receivedEth: result.sellAmountEth,
          txHash: result.txHash,
          whaleTxHash: tx.hash,
          gasCostEth: result.gasCostEth,
        });
      } else if (result.status === "skipped") {
        popPosition(from, tokenIn);
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
    addPosition(from, {
      token: tokenOut.toLowerCase(),
      whaleTx: tx.hash,
      myTx: result.txHash,
      amountUsd: TRADE_AMOUNT_USD,
      timestamp: now,
    });
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

  logger.info(`⏳ Aguardando receipt em 3s...`);
  setTimeout(async () => {
    try {
      const { tokenSold, isEthOut } = await resolveSwapInfo(tx.hash, from);

      if (isEthOut) {
        await handleSwap(tx, WETH, tokenSold);
      } else {
        // Compra: identifica token via receipt
        const receipt = await httpProvider.getTransactionReceipt(tx.hash);
        if (!receipt) return;
        const transferTopic = ethers.id("Transfer(address,address,uint256)");
        const boughtLog = receipt.logs.find(
          (log) =>
            log.topics[0] === transferTopic &&
            log.topics[2] &&
            ethers.dataSlice(log.topics[2], 12).toLowerCase() === from &&
            log.address.toLowerCase() !== WETH
        );
        if (boughtLog) {
          logger.info(`🪙 Token comprado identificado: ${boughtLog.address}`);
          await handleSwap(tx, boughtLog.address, null);
        } else {
          logger.warn(`⚠️  Não foi possível identificar token comprado`);
        }
      }
    } catch (err: any) {
      logger.error(`❌ Erro ao processar receipt para ${tx.hash}: ${err.message}`);
    }
  }, 3000);
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
