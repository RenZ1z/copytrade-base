import axios from "axios";
import { ethers } from "ethers";
import { logger } from "./logger";

const ZEROX_PRICE_URL = "https://api.0x.org/swap/allowance-holder/price";
const ZEROX_QUOTE_URL = "https://api.0x.org/swap/allowance-holder/quote";
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734";
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface TradeResult {
  status: "success" | "failed" | "skipped";
  txHash?: string;
  blockNumber?: number;
  buyAmountRaw?: string;
  sellAmountEth: number;
  ethPriceUsd: number;
  gasUsed?: number;
  gasPriceGwei?: number;
  gasCostEth?: number;
  confirmedAtMs?: number;
  errorMsg?: string;
  skipReason?: string;
}

let ethPriceUsd = 2000;

// ─────────────────────────────────────────────
// NONCE MANAGER
// ─────────────────────────────────────────────
let currentNonce: number | null = null;
let nonceLock = false;
const nonceLockQueue: (() => void)[] = [];

async function acquireNonceLock(): Promise<void> {
  if (!nonceLock) { nonceLock = true; return; }
  return new Promise(resolve => nonceLockQueue.push(resolve));
}

function releaseNonceLock(): void {
  const next = nonceLockQueue.shift();
  if (next) next();
  else nonceLock = false;
}

async function getNextNonce(signer: ethers.Wallet): Promise<number> {
  await acquireNonceLock();
  try {
    if (currentNonce === null) currentNonce = await signer.getNonce("pending");
    return currentNonce++;
  } finally {
    releaseNonceLock();
  }
}

function resetNonce(): void { currentNonce = null; }

async function getEthPrice(): Promise<number> {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 5000 }
    );
    ethPriceUsd = res.data?.ethereum?.usd ?? 2000;
  } catch {
    logger.warn("⚠️  Falha ao buscar preço ETH");
  }
  return ethPriceUsd;
}

async function sendAndWait(
  signer: ethers.Wallet,
  tx: { to: string; data: string; value?: string; gas?: string }
): Promise<ethers.TransactionReceipt | null> {
  const nonce = await getNextNonce(signer);
  try {
    const sent = await signer.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0"),
      gasLimit: BigInt(Math.round(Number(tx.gas ?? "500000") * 1.3)),
      nonce,
    });
    return await sent.wait();
  } catch (err: any) {
    if (err.code === "NONCE_EXPIRED" || err.code === "REPLACEMENT_UNDERPRICED" || err.message?.includes("nonce")) {
      logger.warn("⚠️  Erro de nonce, resetando...");
      resetNonce();
    }
    throw err;
  }
}

async function checkAndApproveToken(
  tokenAddress: string,
  amount: string,
  signer: ethers.Wallet,
  provider: ethers.JsonRpcProvider
): Promise<boolean> {
  try {
    const tokenContract = new ethers.Contract(
      tokenAddress,
      [
        "function allowance(address owner, address spender) view returns (uint256)",
        "function approve(address spender, uint256 amount) returns (bool)"
      ],
      signer
    );
    const owner = await signer.getAddress();
    const currentAllowance = await tokenContract.allowance(owner, ALLOWANCE_HOLDER);
    const amountBigInt = BigInt(amount);
    if (currentAllowance < amountBigInt) {
      logger.info(`📝 Fazendo approve de ${tokenAddress} pro AllowanceHolder...`);
      const nonce = await getNextNonce(signer);
      const tx = await tokenContract.approve(ALLOWANCE_HOLDER, amountBigInt, { nonce });
      const receipt = await tx.wait();
      if (receipt?.status === 1) {
        logger.info(`✅ Aprovação confirmada: ${receipt.hash}`);
        await new Promise(r => setTimeout(r, 2000));
        return true;
      } else {
        logger.error(`❌ Aprovação revertida`);
        return false;
      }
    }
    logger.info(`✅ Já tem allowance suficiente`);
    return true;
  } catch (err: any) {
    if (err.code === "NONCE_EXPIRED" || err.code === "REPLACEMENT_UNDERPRICED" || err.message?.includes("nonce")) resetNonce();
    logger.error(`❌ Erro no approve: ${err.message}`);
    return false;
  }
}

export async function executeCopyTrade(params: {
  tokenOut: string;
  amountUsd: number;
  walletAddress: string;
  signer: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
}): Promise<TradeResult> {
  const { tokenOut, amountUsd, walletAddress, signer } = params;
  const price = await getEthPrice();
  const ethAmount = amountUsd / price;
  const sellAmount = ethers.parseEther(ethAmount.toFixed(8)).toString();

  logger.info(`💱 [BUY] Cotando: ${ethAmount.toFixed(6)} ETH (~$${amountUsd}) -> ${tokenOut}`);

  try {
    const priceRes = await axios.get(ZEROX_PRICE_URL, {
      headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
      params: { chainId: 8453, sellToken: ETH_ADDRESS, buyToken: tokenOut, sellAmount, taker: walletAddress },
      timeout: 10000,
    });

    if (!priceRes.data?.liquidityAvailable) {
      return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd: price, errorMsg: "Sem liquidez disponível" };
    }

    const quoteRes = await axios.get(ZEROX_QUOTE_URL, {
      headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
      params: {
        chainId: 8453, sellToken: ETH_ADDRESS, buyToken: tokenOut, sellAmount, taker: walletAddress,
        slippageBps: Math.round(parseFloat(process.env.MAX_SLIPPAGE ?? "1") * 100),
      },
      timeout: 10000,
    });

    const quote = quoteRes.data;
    if (!quote?.transaction) return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd: price, errorMsg: "0x API returned no transaction" };

    logger.info(`✅ Cotação ok. buyAmount: ${quote.buyAmount}`);
    const receipt = await sendAndWait(signer, quote.transaction);
    const confirmedAtMs = Date.now();

    if (receipt?.status === 1) {
      const gasPriceGwei = receipt.gasPrice ? parseFloat(ethers.formatUnits(receipt.gasPrice, "gwei")) : undefined;
      const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
      const gasCostEth = gasUsed && gasPriceGwei ? (gasUsed * gasPriceGwei) / 1e9 : undefined;
      logger.info(`✅ BUY confirmada no bloco ${receipt.blockNumber} (gas: ${gasUsed})`);
      return { status: "success", txHash: receipt.hash, blockNumber: receipt.blockNumber, buyAmountRaw: quote.buyAmount, sellAmountEth: ethAmount, ethPriceUsd: price, gasUsed, gasPriceGwei, gasCostEth, confirmedAtMs };
    } else {
      logger.error(`❌ BUY revertida`);
      return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd: price, confirmedAtMs, errorMsg: "tx reverted" };
    }
  } catch (err: any) {
    const errorMsg = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : err.message;
    logger.error(`❌ Erro ao executar buy: ${errorMsg}`);
    return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd: price, errorMsg };
  }
}

export async function executeCopySell(params: {
  tokenIn: string;
  walletAddress: string;
  signer: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
  fraction?: number;
  retries?: number;
  retryDelayMs?: number;
}): Promise<TradeResult> {
  const { tokenIn, walletAddress, signer, provider, fraction = 1.0, retries = 3, retryDelayMs = 5000 } = params;
  const price = await getEthPrice();

  const tokenContract = new ethers.Contract(
    tokenIn,
    ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"],
    provider
  );

  const totalBalance = await tokenContract.balanceOf(walletAddress);
  if (totalBalance === 0n) {
    logger.info(`⏭️  Sem saldo de ${tokenIn} para vender`);
    return { status: "skipped", skipReason: "no_balance", sellAmountEth: 0, ethPriceUsd: price };
  }

  const sellBalance = fraction >= 1.0
    ? totalBalance
    : (totalBalance * BigInt(Math.floor(fraction * 1_000_000))) / BigInt(1_000_000);

  if (sellBalance === 0n) {
    logger.info(`⏭️  Fração calculada zerou o saldo, usando saldo total`);
    return { status: "skipped", skipReason: "no_balance", sellAmountEth: 0, ethPriceUsd: price };
  }

  const decimals = await tokenContract.decimals().catch(() => 18);
  logger.info(`💱 [SELL] Cotando: ${ethers.formatUnits(sellBalance, decimals)} tokens (${fraction < 1 ? (fraction * 100).toFixed(1) + "% do saldo" : "100%"}) -> ETH`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const priceRes = await axios.get(ZEROX_PRICE_URL, {
        headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
        params: { chainId: 8453, sellToken: tokenIn, buyToken: ETH_ADDRESS, sellAmount: sellBalance.toString(), taker: walletAddress },
        timeout: 10000,
      });

      logger.info(`📋 Price response keys: ${Object.keys(priceRes.data).join(', ')}`);

      if (priceRes.data?.issues?.allowance) {
        logger.info(`⚠️  Allowance necessária: ${JSON.stringify(priceRes.data.issues.allowance)}`);
        const approved = await checkAndApproveToken(tokenIn, totalBalance.toString(), signer, provider);
        if (!approved) return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg: "Falha na aprovação do token" };
      }

      const quoteRes = await axios.get(ZEROX_QUOTE_URL, {
        headers: { "0x-api-key": process.env.ZEROX_API_KEY!, "0x-version": "v2" },
        params: {
          chainId: 8453, sellToken: tokenIn, buyToken: ETH_ADDRESS,
          sellAmount: sellBalance.toString(), taker: walletAddress,
          slippageBps: Math.round(parseFloat(process.env.MAX_SLIPPAGE ?? "3") * 100),
        },
        timeout: 10000,
      });

      const quote = quoteRes.data;
      logger.info(`📋 Quote response keys: ${Object.keys(quote).join(', ')}`);

      if (!quote?.transaction) {
        logger.error(`❌ No transaction in quote`);
        return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg: "0x API returned no transaction" };
      }

      logger.info(`📋 Transaction to send: to=${quote.transaction.to}, data=${quote.transaction.data?.slice(0, 30)}..., value=${quote.transaction.value}`);

      const buyAmountEth = parseFloat(ethers.formatEther(quote.buyAmount || "0"));
      const receipt = await sendAndWait(signer, quote.transaction);
      const confirmedAtMs = Date.now();

      if (receipt?.status === 1) {
        const gasPriceGwei = receipt.gasPrice ? parseFloat(ethers.formatUnits(receipt.gasPrice, "gwei")) : undefined;
        const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
        const gasCostEth = gasUsed && gasPriceGwei ? (gasUsed * gasPriceGwei) / 1e9 : undefined;
        logger.info(`✅ SELL confirmada no bloco ${receipt.blockNumber} (gas: ${gasUsed})`);
        return { status: "success", txHash: receipt.hash, blockNumber: receipt.blockNumber, sellAmountEth: buyAmountEth, ethPriceUsd: price, gasUsed, gasPriceGwei, gasCostEth, confirmedAtMs };
      } else {
        logger.error(`❌ SELL revertida (tentativa ${attempt}/${retries})`);
        if (attempt < retries) {
          logger.info(`⏳ Tentando novamente em ${retryDelayMs}ms...`);
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, confirmedAtMs, errorMsg: "tx reverted" };
      }
    } catch (err: any) {
      const errorMsg = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : err.message;
      logger.error(`❌ Erro ao executar sell (tentativa ${attempt}/${retries}): ${errorMsg}`);
      if (attempt < retries) {
        logger.info(`⏳ Tentando novamente em ${retryDelayMs}ms...`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      } else {
        return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg };
      }
    }
  }

  return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg: "max retries exceeded" };
}
