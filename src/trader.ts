import axios from "axios";
import { ethers } from "ethers";
import { logger } from "./logger";

const ZEROX_BASE_URL = "https://api.0x.org/swap/permit2/quote";
const WETH = process.env.WETH_ADDRESS!;

export interface TradeParams {
  tokenIn: string;
  tokenOut: string;
  amountUsd: number;
  walletAddress: string;
  signer: ethers.Wallet;
  provider: ethers.JsonRpcProvider;
}

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

export async function executeCopyTrade(params: TradeParams): Promise<TradeResult> {
  const { tokenIn, tokenOut, amountUsd, walletAddress, signer } = params;

  const isTargetETH =
    tokenOut.toLowerCase() === WETH.toLowerCase() ||
    tokenOut.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  if (isTargetETH) {
    logger.info(`⏭️  Ignorando: whale converteu para ETH (provável take profit)`);
    return { status: "skipped", skipReason: "whale_sold_to_eth", sellAmountEth: 0, ethPriceUsd: 0 };
  }

  // Busca preço do ETH
  let ethPriceUsd = 2000;
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { timeout: 5000 }
    );
    ethPriceUsd = res.data?.ethereum?.usd ?? 2000;
  } catch {
    logger.warn("⚠️  Falha ao buscar preço ETH, usando $2000");
  }

  const ethAmount = amountUsd / ethPriceUsd;
  const sellAmount = ethers.parseEther(ethAmount.toFixed(8)).toString();
  const sellToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

  logger.info(`💱 Cotando: ${ethAmount.toFixed(6)} ETH (~$${amountUsd}) -> ${tokenOut}`);

  try {
    const quoteRes = await axios.get(ZEROX_BASE_URL, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY!,
        "0x-version": "v2",
      },
      params: {
        chainId: 8453,
        sellToken,
        buyToken: tokenOut,
        sellAmount,
        taker: walletAddress,
        slippageBps: Math.round(parseFloat(process.env.MAX_SLIPPAGE ?? "1") * 100),
      },
      timeout: 10000,
    });

    const quote = quoteRes.data;
    if (!quote?.transaction) {
      return {
        status: "failed",
        sellAmountEth: ethAmount,
        ethPriceUsd,
        errorMsg: "0x API returned no transaction",
      };
    }

    logger.info(`✅ Cotação ok. buyAmount: ${quote.buyAmount}`);

    const tx = await signer.sendTransaction({
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: BigInt(quote.transaction.value ?? "0"),
      gasLimit: BigInt(Math.round(Number(quote.transaction.gas) * 1.2)),
    });

    logger.info(`🚀 TX enviada: ${tx.hash}`);
    logger.info(`🔗 https://basescan.org/tx/${tx.hash}`);

    const receipt = await tx.wait();
    const confirmedAtMs = Date.now();

    if (receipt?.status === 1) {
      const gasPriceGwei = receipt.gasPrice
        ? parseFloat(ethers.formatUnits(receipt.gasPrice, "gwei"))
        : undefined;
      const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
      const gasCostEth = gasUsed && gasPriceGwei ? (gasUsed * gasPriceGwei) / 1e9 : undefined;

      logger.info(`✅ TX confirmada no bloco ${receipt.blockNumber} (gas: ${gasUsed})`);

      return {
        status: "success",
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        buyAmountRaw: quote.buyAmount,
        sellAmountEth: ethAmount,
        ethPriceUsd,
        gasUsed,
        gasPriceGwei,
        gasCostEth,
        confirmedAtMs,
      };
    } else {
      logger.error(`❌ TX revertida: ${tx.hash}`);
      return {
        status: "failed",
        txHash: tx.hash,
        sellAmountEth: ethAmount,
        ethPriceUsd,
        confirmedAtMs,
        errorMsg: "tx reverted",
      };
    }
  } catch (err: any) {
    const errorMsg = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data)
      : err.message;
    logger.error(`❌ Erro ao executar trade: ${errorMsg}`);
    return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd, errorMsg };
  }
}
