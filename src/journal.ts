import Database from "better-sqlite3";
import path from "path";
import { logger } from "./logger";

const DB_PATH = path.resolve("data/trades.db");

export interface TradeRecord {
  id?: number;
  // Identificação
  whale_wallet: string;
  my_wallet: string;
  // Tokens
  token_in: string;
  token_out: string;
  // Valores
  amount_usd: number;
  sell_amount_eth: number;
  buy_amount_raw: string;       // amount do tokenOut recebido (raw, sem decimais)
  eth_price_usd: number;
  // Timing
  detected_at_ms: number;       // timestamp que detectou no mempool
  executed_at_ms: number;       // timestamp que mandou a TX
  confirmed_at_ms?: number;     // timestamp da confirmação
  delay_ms?: number;            // detected → executed
  // TX
  whale_tx_hash: string;
  my_tx_hash?: string;
  block_number?: number;
  gas_used?: number;
  gas_price_gwei?: number;
  gas_cost_eth?: number;
  // Status
  status: "pending" | "success" | "failed" | "skipped";
  error_msg?: string;
  // Análise (preenchida depois via update)
  exit_price_usd?: number;
  exit_tx_hash?: string;
  exit_at_ms?: number;
  realized_pnl_usd?: number;
  pnl_pct?: number;
}

let db: Database.Database;

export function initJournal(): void {
  const fs = require("fs");
  if (!fs.existsSync("data")) fs.mkdirSync("data");

  db = new Database(DB_PATH);

  // WAL mode para melhor performance em escritas concorrentes
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      whale_wallet      TEXT NOT NULL,
      my_wallet         TEXT NOT NULL,
      token_in          TEXT NOT NULL,
      token_out         TEXT NOT NULL,
      amount_usd        REAL NOT NULL,
      sell_amount_eth   REAL NOT NULL,
      buy_amount_raw    TEXT,
      eth_price_usd     REAL,
      detected_at_ms    INTEGER NOT NULL,
      executed_at_ms    INTEGER NOT NULL,
      confirmed_at_ms   INTEGER,
      delay_ms          INTEGER,
      whale_tx_hash     TEXT NOT NULL,
      my_tx_hash        TEXT,
      block_number      INTEGER,
      gas_used          INTEGER,
      gas_price_gwei    REAL,
      gas_cost_eth      REAL,
      status            TEXT NOT NULL DEFAULT 'pending',
      error_msg         TEXT,
      exit_price_usd    REAL,
      exit_tx_hash      TEXT,
      exit_at_ms        INTEGER,
      realized_pnl_usd  REAL,
      pnl_pct           REAL,
      created_at        INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_whale_wallet  ON trades(whale_wallet);
    CREATE INDEX IF NOT EXISTS idx_token_out     ON trades(token_out);
    CREATE INDEX IF NOT EXISTS idx_status        ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_detected_at   ON trades(detected_at_ms);
  `);

  logger.info(`📒 Trade journal inicializado: ${DB_PATH}`);
}

/** Insere um novo trade e retorna o ID gerado */
export function insertTrade(record: Omit<TradeRecord, "id">): number {
  const stmt = db.prepare(`
    INSERT INTO trades (
      whale_wallet, my_wallet, token_in, token_out,
      amount_usd, sell_amount_eth, buy_amount_raw, eth_price_usd,
      detected_at_ms, executed_at_ms, confirmed_at_ms, delay_ms,
      whale_tx_hash, my_tx_hash, block_number,
      gas_used, gas_price_gwei, gas_cost_eth,
      status, error_msg
    ) VALUES (
      @whale_wallet, @my_wallet, @token_in, @token_out,
      @amount_usd, @sell_amount_eth, @buy_amount_raw, @eth_price_usd,
      @detected_at_ms, @executed_at_ms, @confirmed_at_ms, @delay_ms,
      @whale_tx_hash, @my_tx_hash, @block_number,
      @gas_used, @gas_price_gwei, @gas_cost_eth,
      @status, @error_msg
    )
  `);
  const result = stmt.run(record);
  return result.lastInsertRowid as number;
}

/** Atualiza status e dados de confirmação após a TX confirmar */
export function updateTradeConfirmed(id: number, data: {
  status: "success" | "failed";
  confirmed_at_ms: number;
  block_number?: number;
  gas_used?: number;
  gas_price_gwei?: number;
  gas_cost_eth?: number;
  my_tx_hash?: string;
  error_msg?: string;
}): void {
  const delay = data.confirmed_at_ms;
  db.prepare(`
    UPDATE trades SET
      status           = @status,
      confirmed_at_ms  = @confirmed_at_ms,
      block_number     = @block_number,
      gas_used         = @gas_used,
      gas_price_gwei   = @gas_price_gwei,
      gas_cost_eth     = @gas_cost_eth,
      my_tx_hash       = @my_tx_hash,
      error_msg        = @error_msg
    WHERE id = @id
  `).run({ ...data, id });
}

/** Marca trade como skipped (whale vendeu pra ETH, cooldown, etc) */
export function skipTrade(id: number, reason: string): void {
  db.prepare(`UPDATE trades SET status = 'skipped', error_msg = @reason WHERE id = @id`)
    .run({ id, reason });
}

// ─────────────────────────────────────────────
// QUERIES DE ANÁLISE
// ─────────────────────────────────────────────

export function getStats(whaleWallet?: string): void {
  const filter = whaleWallet ? `WHERE whale_wallet = '${whaleWallet.toLowerCase()}'` : "";

  const summary = db.prepare(`
    SELECT
      COUNT(*)                                      AS total_trades,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS executed,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
      AVG(delay_ms)                                 AS avg_delay_ms,
      MIN(delay_ms)                                 AS min_delay_ms,
      MAX(delay_ms)                                 AS max_delay_ms,
      SUM(amount_usd)                               AS total_invested_usd,
      SUM(gas_cost_eth)                             AS total_gas_eth
    FROM trades ${filter}
  `).get() as any;

  console.log("\n📊 ── RESUMO GERAL ──────────────────────────");
  console.log(`  Total trades:     ${summary.total_trades}`);
  console.log(`  Executados:       ${summary.executed}`);
  console.log(`  Skipped:          ${summary.skipped}`);
  console.log(`  Failed:           ${summary.failed}`);
  console.log(`  Avg delay:        ${Math.round(summary.avg_delay_ms ?? 0)}ms`);
  console.log(`  Min/Max delay:    ${summary.min_delay_ms}ms / ${summary.max_delay_ms}ms`);
  console.log(`  Total investido:  $${(summary.total_invested_usd ?? 0).toFixed(2)}`);
  console.log(`  Total gas:        ${(summary.total_gas_eth ?? 0).toFixed(6)} ETH`);

  // Por wallet
  const byWallet = db.prepare(`
    SELECT
      whale_wallet,
      COUNT(*)  AS trades,
      AVG(delay_ms) AS avg_delay,
      SUM(amount_usd) AS invested
    FROM trades ${filter}
    GROUP BY whale_wallet
    ORDER BY trades DESC
  `).all() as any[];

  if (byWallet.length > 1) {
    console.log("\n📊 ── POR WALLET ────────────────────────────");
    for (const row of byWallet) {
      console.log(`  ${row.whale_wallet.slice(0, 10)}...  trades: ${row.trades}  avg_delay: ${Math.round(row.avg_delay)}ms  invested: $${row.invested?.toFixed(2)}`);
    }
  }

  // Top tokens mais copiados
  const topTokens = db.prepare(`
    SELECT token_out, COUNT(*) AS count
    FROM trades ${filter}
    WHERE status = 'success'
    GROUP BY token_out
    ORDER BY count DESC
    LIMIT 10
  `).all() as any[];

  if (topTokens.length > 0) {
    console.log("\n📊 ── TOP TOKENS COPIADOS ───────────────────");
    for (const row of topTokens) {
      console.log(`  ${row.token_out}  ×${row.count}`);
    }
  }

  console.log("────────────────────────────────────────────\n");
}

export { db };
