import { ethers } from "ethers";

// Seletores de função das principais DEXes na Base
// Qualquer tx com esses 4 bytes no início do input data é um swap
const SWAP_SELECTORS: Record<string, string> = {
  // Uniswap V3 / Uniswap Universal Router
  "0x5ae401dc": "Uniswap V3 - multicall",
  "0x24856bc3": "Uniswap V3 - execute",
  "0x3593564c": "Uniswap Universal Router - execute",
  "0x04e45aaf": "Uniswap V3 - exactInputSingle",
  "0xdb3e2198": "Uniswap V3 - exactOutputSingle",
  "0xb858183f": "Uniswap V3 - exactInput",
  "0x09b81346": "Uniswap V3 - exactOutput",
  // Aerodrome
  "0x8a657e67": "Aerodrome - swapExactTokensForTokens",
  "0x38ed1739": "Aerodrome - swapExactTokensForTokens (v2)",
  "0x7ff36ab5": "Aerodrome - swapExactETHForTokens",
  "0x18cbafe5": "Aerodrome - swapExactTokensForETH",
  // 0x / Matcha
  "0xd9627aa4": "0x - sellToUniswap",
  "0x415565b0": "0x - transformERC20",
  "0xf7fcd384": "0x - sellTokenForTokenToUniswapV3",
  // 1inch
  "0x7c025200": "1inch - swap",
  "0xe449022e": "1inch - uniswapV3Swap",
  "0x2e95b6c8": "1inch - unoswap",
};

export interface SwapInfo {
  isSwap: boolean;
  protocol?: string;
  selector?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: bigint;
}

/**
 * Tenta identificar se uma tx é um swap e extrai informações básicas.
 * Para Uniswap V3 exactInputSingle, decodifica tokenIn/tokenOut/amountIn.
 * Para outros protocolos, apenas sinaliza que é um swap.
 */
export function decodeSwap(tx: {
  data: string;
  value: bigint;
}): SwapInfo {
  if (!tx.data || tx.data.length < 10) {
    return { isSwap: false };
  }

  const selector = tx.data.slice(0, 10).toLowerCase();
  const protocol = SWAP_SELECTORS[selector];

  if (!protocol) {
    return { isSwap: false };
  }

  // Tenta decodificar exactInputSingle do Uniswap V3 (mais comum)
  if (selector === "0x04e45aaf") {
    try {
      const iface = new ethers.Interface([
        "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
      ]);
      const decoded = iface.decodeFunctionData("exactInputSingle", tx.data);
      const params = decoded[0];
      return {
        isSwap: true,
        protocol,
        selector,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
      };
    } catch {
      // fallthrough
    }
  }

  // Para outros protocolos, retorna apenas que é swap (0x API vai resolver o melhor roteamento)
  return { isSwap: true, protocol, selector };
}
