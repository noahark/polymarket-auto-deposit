// auto-claim-pending-deposit.js
import { createPublicClient, createWalletClient, http, parseUnits, parseAbi, encodeFunctionData, keccak256, toHex } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ================== 配置区 ==================
const SAFE_ADDRESS = '0xYourSafeProxyWalletAddress';           // 你的 Polymarket Safe
const OWNER_PRIVATE_KEY = '0x你的EOA私钥在这里';                             // ← 填这里（0x开头）
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';

const publicClient = createPublicClient({
  chain: polygon,
  transport: http('https://polygon-rpc.com'), // 或你喜欢的 RPC
});

const account = privateKeyToAccount(OWNER_PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http('https://polygon-rpc.com'),
});

// ABI
const usdcAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const onrampAbi = parseAbi(['function wrap(address _asset, address _to, uint256 _amount) external']);

// Multisend 合约（Gnosis Safe 标准）
const MULTISEND_ADDRESS = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';

// ================== 核心函数 ==================
async function getUsdcBalance() {
  const balance = await publicClient.readContract({
    address: USDC_E,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [SAFE_ADDRESS],
  });
  return balance;
}

async function buildMultisendData(amount) {
  const approveData = encodeFunctionData({
    abi: usdcAbi,
    functionName: 'approve',
    args: [ONRAMP, amount],
  });

  const wrapData = encodeFunctionData({
    abi: onrampAbi,
    functionName: 'wrap',
    args: [USDC_E, SAFE_ADDRESS, amount],
  });

  // Multisend 打包格式: 0x + (operation + to + value + data.length + data) 重复
  const calls = [
    { op: 0, to: USDC_E, value: 0n, data: approveData },
    { op: 0, to: ONRAMP, value: 0n, data: wrapData },
  ];

  let packed = '0x';
  for (const call of calls) {
    packed += call.op.toString(16).padStart(2, '0');                    // operation (uint8)
    packed += call.to.slice(2).padStart(40, '0');                       // to (address)
    packed += '0000000000000000000000000000000000000000000000000000000000000000'; // value (uint256)
    packed += call.data.slice(2).length.toString(16).padStart(64, '0'); // data.length
    packed += call.data.slice(2);                                       // data
  }

  return packed;
}

// 执行 Safe Transaction
async function executeSafeTx(amount) {
  const multisendData = await buildMultisendData(amount);

  // 构造 Safe execTransaction 参数
  const nonce = await publicClient.readContract({
    address: SAFE_ADDRESS,
    abi: parseAbi(['function nonce() view returns (uint256)']),
    functionName: 'nonce',
  });

  const txData = {
    to: MULTISEND_ADDRESS,
    value: 0n,
    data: multisendData,
    operation: 1,                    // DelegateCall
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce,
  };

  // 计算 Safe 交易哈希 (EIP-712)
  const domainSeparator = await publicClient.readContract({
    address: SAFE_ADDRESS,
    abi: parseAbi(['function domainSeparator() view returns (bytes32)']),
    functionName: 'domainSeparator',
  });

  const safeTxHash = keccak256(encodeFunctionData({ /* 手动组装 EIP-712 */ })); // 实际推荐用 safe-core-sdk，这里简化

  // 推荐方式：使用 @safe-global/safe-core-sdk（更稳）
  console.log('✅ 准备执行 Safe multisend...');
  console.log('金额:', amount / 1_000_000n, 'USDC.e');

  const hash = await walletClient.sendTransaction({
    to: SAFE_ADDRESS,
    data: /* 这里需要完整 execTransaction calldata */ , // 完整版我下面再给简化手动版
  });

  console.log('🚀 Safe Transaction Hash:', hash);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log('✅ Pending deposit 已自动 claim！');
}

// ================== 主循环 ==================
async function startAutoClaim() {
  console.log('🚀 Polymarket Auto-Claim 启动... 监控 Safe USDC.e 余额');

  while (true) {
    try {
      const balance = await getUsdcBalance();
      if (balance > 0n) {
        console.log(`检测到 ${balance / 1_000_000n} USDC.e pending，开始自动 claim...`);
        await executeSafeTx(balance);
      }
    } catch (err) {
      console.error('错误:', err.message);
    }
    await new Promise(r => setTimeout(r, 15000)); // 每15秒轮询
  }
}

startAutoClaim();