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

### Safe 模式地址说明

Safe 模式每个 Polymarket 账号至少需要以下信息：

- `safeAddress`：**必填**。Polymarket Safe Proxy Wallet 地址，USDC.e 和 pUSD 实际在这里。这个地址不能从私钥或 API key 推导，必须从 Polymarket 页面获取。
- `ownerPrivateKeyEnv`：**必填**。保存 EOA owner 私钥的环境变量名。脚本会自动从私钥派生 owner 地址。
- `ownerAddress`：**可选**。仅用于额外校验。如果填写，必须和私钥派生出的 EOA 地址一致。
- `clob.*`：**可选**。用于 wrap 成功后刷新 Polymarket CLOB balance/allowance。

注意：
- 每个 Polymarket 账号有自己的 `safeAddress`。
- `safeAddress` 不等于 EOA 地址。
- API key/secret/passphrase 不等于链上钱包地址。

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
# account 1
PM_SAFE_ACCOUNT_1_OWNER_PRIVATE_KEY=0xYOUR_ACCOUNT_1_EOA_OWNER_PRIVATE_KEY
PM_SAFE_ACCOUNT_1_API_KEY=...
PM_SAFE_ACCOUNT_1_SECRET=...
PM_SAFE_ACCOUNT_1_PASSPHRASE=...

# account 2
PM_SAFE_ACCOUNT_2_OWNER_PRIVATE_KEY=0xYOUR_ACCOUNT_2_EOA_OWNER_PRIVATE_KEY
PM_SAFE_ACCOUNT_2_API_KEY=...
PM_SAFE_ACCOUNT_2_SECRET=...
PM_SAFE_ACCOUNT_2_PASSPHRASE=...
```

编辑 `config/safe-wallets.json`：

```json
{
  "rpcUrl": "https://your-polygon-rpc.example",
  "wallets": [
    {
      "name": "account_1",
      "executionMode": "safe",
      "safeAddress": "0xYourAccount1PolymarketSafeProxyWallet",
      "ownerPrivateKeyEnv": "PM_SAFE_ACCOUNT_1_OWNER_PRIVATE_KEY",
      "clob": {
        "enabled": true,
        "apiKeyEnv": "PM_SAFE_ACCOUNT_1_API_KEY",
        "secretEnv": "PM_SAFE_ACCOUNT_1_SECRET",
        "passphraseEnv": "PM_SAFE_ACCOUNT_1_PASSPHRASE"
      }
    },
    {
      "name": "account_2",
      "executionMode": "safe",
      "safeAddress": "0xYourAccount2PolymarketSafeProxyWallet",
      "ownerPrivateKeyEnv": "PM_SAFE_ACCOUNT_2_OWNER_PRIVATE_KEY",
      "clob": {
        "enabled": true,
        "apiKeyEnv": "PM_SAFE_ACCOUNT_2_API_KEY",
        "secretEnv": "PM_SAFE_ACCOUNT_2_SECRET",
        "passphraseEnv": "PM_SAFE_ACCOUNT_2_PASSPHRASE"
      }
    }
  ]
}
```

安全要求：

- `.env` 不要提交到 Git。
- `config/safe-wallets.json` 不要提交到 Git。
- 私钥只放在 `.env` 中。
- 每个 Polymarket 账号使用独立的 env 变量名。
- `ownerAddress` 不再必填，脚本会从私钥自动派生。如果填写，仅作为额外校验。
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

### Safe Mode Address Explanation

Safe mode requires the following information for each Polymarket account:

- `safeAddress`: **Required**. The Polymarket Safe Proxy Wallet address where USDC.e and pUSD are held. This cannot be derived from the private key or API credentials. Obtain it from your Polymarket account page.
- `ownerPrivateKeyEnv`: **Required**. The environment variable containing the EOA owner private key. The script derives the owner address automatically.
- `ownerAddress`: **Optional**. Extra validation only. If provided, it must match the address derived from the private key.
- `clob.*`: **Optional**. Used to refresh Polymarket CLOB balance/allowance after a successful wrap.

Note:
- Each Polymarket account has its own `safeAddress`.
- `safeAddress` is not the same as the EOA address.
- API key/secret/passphrase are not the same as on-chain wallet addresses.

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
# account 1
PM_SAFE_ACCOUNT_1_OWNER_PRIVATE_KEY=0xYOUR_ACCOUNT_1_EOA_OWNER_PRIVATE_KEY
PM_SAFE_ACCOUNT_1_API_KEY=...
PM_SAFE_ACCOUNT_1_SECRET=...
PM_SAFE_ACCOUNT_1_PASSPHRASE=...

# account 2
PM_SAFE_ACCOUNT_2_OWNER_PRIVATE_KEY=0xYOUR_ACCOUNT_2_EOA_OWNER_PRIVATE_KEY
PM_SAFE_ACCOUNT_2_API_KEY=...
PM_SAFE_ACCOUNT_2_SECRET=...
PM_SAFE_ACCOUNT_2_PASSPHRASE=...
```

Edit `config/safe-wallets.json`:

```json
{
  "rpcUrl": "https://your-polygon-rpc.example",
  "wallets": [
    {
      "name": "account_1",
      "executionMode": "safe",
      "safeAddress": "0xYourAccount1PolymarketSafeProxyWallet",
      "ownerPrivateKeyEnv": "PM_SAFE_ACCOUNT_1_OWNER_PRIVATE_KEY",
      "clob": {
        "enabled": true,
        "apiKeyEnv": "PM_SAFE_ACCOUNT_1_API_KEY",
        "secretEnv": "PM_SAFE_ACCOUNT_1_SECRET",
        "passphraseEnv": "PM_SAFE_ACCOUNT_1_PASSPHRASE"
      }
    },
    {
      "name": "account_2",
      "executionMode": "safe",
      "safeAddress": "0xYourAccount2PolymarketSafeProxyWallet",
      "ownerPrivateKeyEnv": "PM_SAFE_ACCOUNT_2_OWNER_PRIVATE_KEY",
      "clob": {
        "enabled": true,
        "apiKeyEnv": "PM_SAFE_ACCOUNT_2_API_KEY",
        "secretEnv": "PM_SAFE_ACCOUNT_2_SECRET",
        "passphraseEnv": "PM_SAFE_ACCOUNT_2_PASSPHRASE"
      }
    }
  ]
}
```

Security rules:

- Do not commit `.env`.
- Do not commit `config/safe-wallets.json`.
- Keep private keys only in `.env`.
- Use separate env variable names for each Polymarket account.
- `ownerAddress` is no longer required — the script derives it from the private key automatically. If provided, it is used for extra validation only.
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
