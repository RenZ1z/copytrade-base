import axios from "axios";
import { ethers } from "ethers";
import { logger } from "./logger";

const ZEROX_QUOTE_URL = "https://api.0x.org/swap/permit2/quote ";
const ZEROX_APPROVE_URL = "https://api.0x.org/swap/permit2/approve ";
const WETH = process.env.WETH_ADDRESS!;
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

async function getEthPrice(): Promise<number> {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd ",
      { timeout: 5000 }
    );
    ethPriceUsd = res.data?.ethereum?.usd ?? 2000;
  } catch {
    logger.warn("⚠️  Falha ao buscar preço ETH");
  }
  return ethPriceUsd;
}

async function sendAndWait(signer: ethers.Wallet, tx: { to: string; data: string; value?: string; gas?: string }): Promise<ethers.TransactionReceipt | null> {
  const sent = await signer.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? "0"),
    gasLimit: BigInt(Math.round(Number(tx.gas ?? "500000") * 1.3)),
  });
  return await sent.wait();
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
    const quoteRes = await axios.get(ZEROX_QUOTE_URL, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY!,
        "0x-version": "v2",
      },
      params: {
        chainId: 8453,
        sellToken: ETH_ADDRESS,
        buyToken: tokenOut,
        sellAmount,
        taker: walletAddress,
        slippageBps: Math.round(parseFloat(process.env.MAX_SLIPPAGE ?? "1") * 100),
      },
      timeout: 10000,
    });

    const quote = quoteRes.data;
    if (!quote?.transaction) {
      return { status: "failed", sellAmountEth: ethAmount, ethPriceUsd: price, errorMsg: "0x API returned no transaction" };
    }

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
}): Promise<TradeResult> {
  const { tokenIn, walletAddress, signer, provider } = params;
  const price = await getEthPrice();

  const tokenContract = new ethers.Contract(
    tokenIn,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );

  const balance = await tokenContract.balanceOf(walletAddress);
  if (balance === 0n) {
    logger.info(`⏭️  Sem saldo de ${tokenIn} para vender`);
    return { status: "skipped", skipReason: "no_balance", sellAmountEth: 0, ethPriceUsd: price };
  }

  logger.info(`💱 [SELL] Cotando: ${balance.toString()} ${tokenIn} -> ETH`);

  try {
    const quoteRes = await axios.get(ZEROX_QUOTE_URL, {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY!,
        "0x-version": "v2",
      },
      params: {
        chainId: 8453,
        sellToken: tokenIn,
        buyToken: ETH_ADDRESS,
        sellAmount: balance.toString(),
        taker: walletAddress,
        slippageBps: Math.round(parseFloat(process.env.MAX_SLIPPAGE ?? "3") * 100),
      },
      timeout: 10000,
    });

    const quote = quoteRes.data;
    logger.info(`📋 0x quote response keys: ${Object.keys(quote).join(', ')}`);

    if (quote.approval) {
      logger.info(`📝 Approval needed: ${JSON.stringify(quote.approval)}`);
      const approveRes = await axios.get(ZEROX_APPROVE_URL, {
        headers: {
          "0x-api-key": process.env.ZEROX_API_KEY!,
          "0x-version": "v2",
        },
        params: {
          chainId: 8453,
          token: tokenIn,
          amount: balance.toString(),
        },
        timeout: 10000,
      });

      logger.info(`📋 Approve response: ${JSON.stringify(approveRes.data)}`);

      if (approveRes.data?.data && approveRes.data?.to) {
        const approveTx = {
          to: approveRes.data.to,
          data: approveRes.data.data,
          value: "0",
          gas: approveRes.data.gas ?? "100000",
        };

        const approveReceipt = await sendAndWait(signer, approveTx);
        if (approveReceipt?.status !== 1) {
          return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg: "approval tx reverted" };
        }
        logger.info(`✅ Aprovação confirmada`);

        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!quote?.transaction) {
      logger.error(`❌ No transaction in quote. Full response: ${JSON.stringify(quote)}`);
      return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg: "0x API returned no transaction" };
    }

    logger.info(`📋 Transaction to send: to=${quote.transaction.to}, data=${quote.transaction.data?.slice(0, 20)}..., value=${quote.transaction.value}`);

    const buyAmountEth = parseFloat(ethers.formatEther(quote.buyAmount));

    const receipt = await sendAndWait(signer, quote.transaction);
    const confirmedAtMs = Date.now();

    if (receipt?.status === 1) {
      const gasPriceGwei = receipt.gasPrice ? parseFloat(ethers.formatUnits(receipt.gasPrice, "gwei")) : undefined;
      const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
      const gasCostEth = gasUsed && gasPriceGwei ? (gasUsed * gasPriceGwei) / 1e9 : undefined;

      logger.info(`✅ SELL confirmada no bloco ${receipt.blockNumber} (gas: ${gasUsed})`);

      return { status: "success", txHash: receipt.hash, blockNumber: receipt.blockNumber, sellAmountEth: buyAmountEth, ethPriceUsd: price, gasUsed, gasPriceGwei, gasCostEth, confirmedAtMs };
    } else {
      logger.error(`❌ SELL revertida`);
      return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, confirmedAtMs, errorMsg: "tx reverted" };
    }
  } catch (err: any) {
    const errorMsg = axios.isAxiosError(err) ? JSON.stringify(err.response?.data) : err.message;
    logger.error(`❌ Erro ao executar sell: ${errorMsg}`);
    return { status: "failed", sellAmountEth: 0, ethPriceUsd: price, errorMsg };
  }
}
