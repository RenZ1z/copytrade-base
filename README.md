# Copy Trade Bot — Base Network

Bot de copy trade para a Base network. Monitora wallets alvo via Alchemy WebSocket e replica swaps usando a 0x API.

## Stack
- **Node.js + TypeScript**
- **Alchemy** — WebSocket para monitorar blocos/txs
- **0x API** — cotação e execução dos swaps (roteamento inteligente entre DEXes)
- **PM2** — processo em background com auto-restart

---

## Setup na VPS (Ubuntu 20.04)

### 1. Instala dependências do sistema

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2 ts-node typescript
```

### 2. Clona / copia o projeto

```bash
cd ~
# Se usar git:
# git clone <repo>
# Ou copia a pasta manualmente via scp/rsync
cd copytrade-base
npm install
```

### 3. Configura o .env

```bash
cp .env.example .env
nano .env
```

Preencha:
- `ALCHEMY_WS_URL` e `ALCHEMY_HTTP_URL` → cria app em [alchemy.com](https://alchemy.com), seleciona **Base Mainnet**
- `ZEROX_API_KEY` → cria em [dashboard.0x.org](https://dashboard.0x.org) (free tier disponível)
- `MY_WALLET_ADDRESS` e `MY_PRIVATE_KEY` → **use uma wallet dedicada, nunca a principal**
- `TARGET_WALLETS` → wallets a monitorar, separadas por vírgula
- `TRADE_AMOUNT_USD` → quanto entra em cada copy trade (ex: `5`)
- `MAX_SLIPPAGE` → slippage máximo em % (ex: `1`)

### 4. Build e teste

```bash
npm run build

# Roda uma vez no terminal pra ver se está funcionando
npm start
```

Você deve ver algo como:
```
[2024-01-01 12:00:00] info: 🚀 Copy Trade Bot iniciando...
[2024-01-01 12:00:00] info: 👛 Monitorando 1 wallet(s):
[2024-01-01 12:00:00] info:    → 0xcc457582...
[2024-01-01 12:00:00] info: ✅ WebSocket conectado. Monitorando blocos...
```

### 5. Roda em background com PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # copia e executa o comando que ele gerar para auto-start no boot
```

### Comandos úteis PM2

```bash
pm2 status          # ver se está rodando
pm2 logs copytrade-base    # ver logs em tempo real
pm2 restart copytrade-base # reiniciar
pm2 stop copytrade-base    # parar
```

---

## Como funciona

1. Bot escuta cada novo bloco na Base via WebSocket
2. Para cada bloco, verifica se alguma TX é de uma wallet monitorada
3. Se for, tenta decodificar se é um swap
4. Se for swap: identifica o token comprado e executa um trade com o valor fixo configurado via 0x API
5. Loga tudo no terminal e em `logs/`

### Lógica de execução

- Sempre **compra com ETH nativo** o mesmo token que a whale comprou
- Se a whale vendeu para ETH (take profit), o bot **ignora**
- Cooldown de 30s por wallet para evitar multi-execuções na mesma oportunidade
- Gas limit com +20% de buffer para evitar fails

---

## ⚠️ Avisos importantes

- **Nunca coloque a private key da sua wallet principal no bot**. Use uma carteira dedicada com o capital separado
- Copy trade tem risco de **front-running**: você entra depois da whale e pode comprar mais caro
- Tokens de meme em Base podem ter **tax/honeypot** — o bot não faz verificação disso
- Mantenha pelo menos **0.01 ETH** na wallet do bot para gas
- Monitore os logs regularmente para garantir que está funcionando

---

## Custos

| Item | Custo |
|------|-------|
| VPS Oracle Free Tier | $0 |
| Alchemy (até 300M compute units/mês) | $0 |
| 0x API (até 200k calls/mês) | $0 |
| Gas por trade | ~$0.01–0.10 na Base |
| Taxa 0x | 0% (sem taxa de protocolo no free tier) |
