/**
 * stats.ts — análise do trade journal
 * Uso: npm run stats
 *      npm run stats -- --wallet 0xcc457582...
 *      npm run stats -- --token 0xabc123...
 *      npm run stats -- --export csv
 */
import "dotenv/config";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.resolve("data/trades.db");

if (!fs.existsSync(DB_PATH)) {
  console.error("❌ Nenhum banco encontrado em data/trades.db — rode o bot primeiro.");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const args = process.argv.slice(2);
const walletFilter = args.includes("--wallet") ? args[args.indexOf("--wallet") + 1] : null;
const tokenFilter  = args.includes("--token")  ? args[args.indexOf("--token") + 1]  : null;
const exportMode   = args.includes("--export") ? args[args.indexOf("--export") + 1]  : null;

const whereClause = [
  walletFilter ? `whale_wallet = '${walletFilter.toLowerCase()}'` : null,
  tokenFilter  ? `token_out = '${tokenFilter.toLowerCase()}'` : null,
  `status != 'pending'`,
].filter(Boolean).join(" AND ");

const WHERE = whereClause ? `WHERE ${whereClause}` : `WHERE status != 'pending'`;

// ── RESUMO GERAL ─────────────────────────────────────────────────────────────
const summary = db.prepare(`
  SELECT
    COUNT(*)                                                    AS total,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)          AS success,
    SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END)          AS failed,
    SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END)          AS skipped,
    ROUND(AVG(delay_ms))                                        AS avg_delay_ms,
    MIN(delay_ms)                                               AS min_delay_ms,
    MAX(delay_ms)                                               AS max_delay_ms,
    ROUND(SUM(amount_usd), 4)                                   AS total_invested,
    ROUND(SUM(gas_cost_eth), 8)                                 AS total_gas_eth,
    ROUND(AVG(gas_cost_eth), 8)                                 AS avg_gas_eth
  FROM trades ${WHERE}
`).get() as any;

console.log("\n╔══════════════════════════════════════════════════╗");
console.log("║           COPY TRADE — BATCH ANALYSIS           ║");
console.log("╚══════════════════════════════════════════════════╝");
if (walletFilter) console.log(`  Wallet filter : ${walletFilter}`);
if (tokenFilter)  console.log(`  Token filter  : ${tokenFilter}`);
console.log(`\n  Total trades   : ${summary.total}`);
console.log(`  ✅ Success      : ${summary.success}`);
console.log(`  ❌ Failed       : ${summary.failed}`);
console.log(`  ⏭️  Skipped      : ${summary.skipped}`);
console.log(`\n  ⏱️  Delay médio  : ${summary.avg_delay_ms}ms`);
console.log(`  ⏱️  Delay min/max: ${summary.min_delay_ms}ms / ${summary.max_delay_ms}ms`);
console.log(`\n  💵 Total invest : $${summary.total_invested}`);
console.log(`  ⛽ Total gas    : ${summary.total_gas_eth} ETH`);
console.log(`  ⛽ Avg gas/tx   : ${summary.avg_gas_eth} ETH`);

// ── POR WALLET ────────────────────────────────────────────────────────────────
const byWallet = db.prepare(`
  SELECT
    whale_wallet,
    COUNT(*)                                             AS trades,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)   AS success,
    ROUND(AVG(delay_ms))                                 AS avg_delay,
    ROUND(SUM(amount_usd), 2)                            AS invested
  FROM trades ${WHERE}
  GROUP BY whale_wallet
  ORDER BY trades DESC
`).all() as any[];

if (byWallet.length > 0) {
  console.log("\n── POR WALLET ──────────────────────────────────────");
  console.log("  Wallet                                     Trades  Success  AvgDelay  Invested");
  for (const r of byWallet) {
    const wallet = r.whale_wallet.padEnd(42);
    console.log(`  ${wallet}  ${String(r.trades).padStart(5)}  ${String(r.success).padStart(7)}  ${String(r.avg_delay + "ms").padStart(8)}  $${r.invested}`);
  }
}

// ── TOP TOKENS ────────────────────────────────────────────────────────────────
const topTokens = db.prepare(`
  SELECT
    token_out,
    COUNT(*)                                             AS count,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)   AS success,
    ROUND(SUM(amount_usd), 2)                            AS invested
  FROM trades ${WHERE}
  GROUP BY token_out
  ORDER BY count DESC
  LIMIT 15
`).all() as any[];

if (topTokens.length > 0) {
  console.log("\n── TOP TOKENS COPIADOS ─────────────────────────────");
  console.log("  Token                                       Trades  Success  Invested");
  for (const r of topTokens) {
    const token = r.token_out.padEnd(42);
    console.log(`  ${token}  ${String(r.count).padStart(5)}  ${String(r.success).padStart(7)}  $${r.invested}`);
  }
}

// ── DISTRIBUIÇÃO DE DELAY ─────────────────────────────────────────────────────
const delayBuckets = db.prepare(`
  SELECT
    CASE
      WHEN delay_ms < 500              THEN '< 500ms'
      WHEN delay_ms BETWEEN 500 AND 1000 THEN '500ms–1s'
      WHEN delay_ms BETWEEN 1001 AND 3000 THEN '1s–3s'
      WHEN delay_ms BETWEEN 3001 AND 6000 THEN '3s–6s'
      ELSE '> 6s'
    END AS bucket,
    COUNT(*) AS count
  FROM trades ${WHERE}
  WHERE delay_ms IS NOT NULL
  GROUP BY bucket
  ORDER BY MIN(delay_ms)
`).all() as any[];

if (delayBuckets.length > 0) {
  console.log("\n── DISTRIBUIÇÃO DE DELAY ───────────────────────────");
  for (const r of delayBuckets) {
    const bar = "█".repeat(Math.min(40, Math.round(r.count / summary.total * 40)));
    console.log(`  ${r.bucket.padEnd(12)}  ${bar} ${r.count}`);
  }
}

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
if (exportMode === "csv") {
  const rows = db.prepare(`SELECT * FROM trades ${WHERE} ORDER BY detected_at_ms DESC`).all() as any[];
  const headers = Object.keys(rows[0] ?? {}).join(",");
  const lines = rows.map((r: any) => Object.values(r).map(v => `"${v ?? ""}"`).join(","));
  const csv = [headers, ...lines].join("\n");
  const outPath = `data/trades_export_${Date.now()}.csv`;
  fs.writeFileSync(outPath, csv);
  console.log(`\n✅ Exportado: ${outPath} (${rows.length} registros)`);
}

console.log("\n────────────────────────────────────────────────────\n");
db.close();
