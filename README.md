# Polymarket Auto Deposit

自动确认 Polymarket `Confirm pending deposit` 的 Node.js 脚本。

This is a Node.js utility for automatically confirming Polymarket pending deposits by wrapping Polygon USDC.e into Polymarket pUSD.

> This project is not affiliated with Polymarket. Use it at your own risk. Never commit private keys, API credentials, real wallet config files, or logs.

## 中文说明

### 这个项目解决什么问题

Polymarket 升级到 pUSD 机制后，部分充值或结算资金会先以 USDC.e 留在 Polymarket Safe Proxy Wallet 中，网页端需要手动点击 `Confirm pending deposit` 才能完成入账。

本脚本用于自动完成这一步：

1. 读取 Safe Proxy Wallet 中的 USDC.e 余额。
2. 如果发现待确认余额，构造 Safe 批量交易。
3. 通过 Safe 执行 `USDC.e.approve(...)` 和 `CollateralOnramp.wrap(...)`。
4. 校验 Safe 中 pUSD 余额增量是否等于本次 wrap 数量。
5. 可选刷新 Polymarket CLOB balance/allowance。

### 支持模式

- Safe Proxy 模式：适用于 Polymarket 网页账户，资金在 Polymarket Safe Proxy Wallet 中。
- EOA 模式：适用于 USDC.e 直接在普通私钥钱包中的场景。

实际 Polymarket 网页账户通常应使用 Safe Proxy 模式。

### 安装

```bash
npm install
```

### 配置

复制示例文件：

```bash
cp .env.example .env
cp config/safe-wallets.example.json config/safe-wallets.json
```

编辑 `.env`：

```bash
PM_SAFE_MAIN_OWNER_PRIVATE_KEY=0xYOUR_EOA_OWNER_PRIVATE_KEY
```

编辑 `config/safe-wallets.json`：

```json
{
  "rpcUrl": "https://your-polygon-rpc.example",
  "wallets": [
    {
      "name": "main_safe",
      "executionMode": "safe",
      "safeAddress": "0xYourPolymarketSafeProxyWallet",
      "ownerAddress": "0xYourEOAOwnerAddress",
      "ownerPrivateKeyEnv": "PM_SAFE_MAIN_OWNER_PRIVATE_KEY"
    }
  ]
}
```

安全要求：

- `.env` 不要提交到 Git。
- `config/safe-wallets.json` 不要提交到 Git。
- 私钥只放在 `.env` 中。
- `safeAddress` 是 Polymarket Safe Proxy Wallet 地址。
- `ownerAddress` 是 Safe 的 owner，也是支付 Polygon gas 的 EOA 地址。
- EOA 地址需要有少量 POL 支付 gas。

### 常用命令

Safe 模式 dry run：

```bash
npm run safe:dry-run
```

执行一次自动确认：

```bash
npm run safe:once
```

持续监控：

```bash
npm run safe:watch
```

仅刷新 CLOB 余额，不发链上交易：

```bash
npm run safe:refresh
```

如果链上 wrap 已成功但 CLOB refresh 因网络问题失败，应使用 `safe:refresh`，不要重复执行链上 wrap。

### 退出码

- `0`: 成功或没有待确认入账。
- `1`: 配置或命令行参数错误。
- `2`: 链上操作失败。
- `3`: 链上 wrap 成功，但 CLOB refresh 失败。
- `4`: 链上交易成功，但 pUSD 增量校验失败。

### 关键合约

- Polygon chain id: `137`
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- pUSD: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- CollateralOnramp: `0x93070a847efEf7F70739046A929D47a521F5B8ee`

## English

### What This Project Does

After Polymarket's pUSD upgrade, some deposits or settled funds may remain as USDC.e inside a user's Polymarket Safe Proxy Wallet until the user manually clicks `Confirm pending deposit` in the web UI.

This script automates that confirmation flow:

1. Reads the USDC.e balance in the Safe Proxy Wallet.
2. Builds a Safe batch transaction when a pending balance is found.
3. Executes `USDC.e.approve(...)` and `CollateralOnramp.wrap(...)` through the Safe.
4. Verifies that the Safe pUSD balance increased by exactly the wrapped amount.
5. Optionally refreshes Polymarket CLOB balance/allowance.

### Supported Modes

- Safe Proxy mode: for Polymarket web accounts where funds are held by a Polymarket Safe Proxy Wallet.
- EOA mode: for cases where USDC.e is held directly by a normal private-key wallet.

Most Polymarket web accounts should use Safe Proxy mode.

### Installation

```bash
npm install
```

### Configuration

Copy the example files:

```bash
cp .env.example .env
cp config/safe-wallets.example.json config/safe-wallets.json
```

Edit `.env`:

```bash
PM_SAFE_MAIN_OWNER_PRIVATE_KEY=0xYOUR_EOA_OWNER_PRIVATE_KEY
```

Edit `config/safe-wallets.json`:

```json
{
  "rpcUrl": "https://your-polygon-rpc.example",
  "wallets": [
    {
      "name": "main_safe",
      "executionMode": "safe",
      "safeAddress": "0xYourPolymarketSafeProxyWallet",
      "ownerAddress": "0xYourEOAOwnerAddress",
      "ownerPrivateKeyEnv": "PM_SAFE_MAIN_OWNER_PRIVATE_KEY"
    }
  ]
}
```

Security rules:

- Do not commit `.env`.
- Do not commit `config/safe-wallets.json`.
- Keep private keys only in `.env`.
- `safeAddress` is your Polymarket Safe Proxy Wallet.
- `ownerAddress` is the Safe owner and Polygon gas payer.
- The EOA owner must have enough POL for gas.

### Commands

Safe mode dry run:

```bash
npm run safe:dry-run
```

Run once:

```bash
npm run safe:once
```

Watch continuously:

```bash
npm run safe:watch
```

Refresh CLOB balance only, without sending an on-chain transaction:

```bash
npm run safe:refresh
```

If the on-chain wrap succeeded but CLOB refresh failed due to a network error, use `safe:refresh`. Do not rerun the on-chain wrap flow as a refresh workaround.

### Exit Codes

- `0`: Success, or no pending deposit found.
- `1`: Configuration or CLI input error.
- `2`: On-chain operation failed.
- `3`: On-chain wrap succeeded, but CLOB refresh failed.
- `4`: On-chain transaction succeeded, but pUSD delta verification failed.

### Contracts

- Polygon chain id: `137`
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- pUSD: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- CollateralOnramp: `0x93070a847efEf7F70739046A929D47a521F5B8ee`

## License

MIT
