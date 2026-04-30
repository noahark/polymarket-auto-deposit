import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  maxUint256,
  parseAbi
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  USDCE,
  PUSD,
  COLLATERAL_ONRAMP,
  POLYGON_CHAIN_ID,
  ERC20_ABI as ERC20_ABI_RAW,
  ONRAMP_ABI as ONRAMP_ABI_RAW
} from "./constants.js";

const ERC20_ABI = parseAbi(ERC20_ABI_RAW);
const ONRAMP_ABI = parseAbi(ONRAMP_ABI_RAW);

export function createClients(rpcUrl, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ chain: polygon, transport });
  const walletClient = createWalletClient({ account, chain: polygon, transport });

  return { publicClient, walletClient, account };
}

export async function getChainId(publicClient) {
  return publicClient.getChainId();
}

export async function getPolBalance(publicClient, address) {
  return publicClient.getBalance({ address });
}

export async function getUsdceBalance(publicClient, address) {
  return publicClient.readContract({
    address: USDCE,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address]
  });
}

export async function getPusdBalance(publicClient, address) {
  return publicClient.readContract({
    address: PUSD,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address]
  });
}

export async function getUsdceAllowance(publicClient, owner, spender) {
  return publicClient.readContract({
    address: USDCE,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender]
  });
}

export async function approveUsdce(walletClient, publicClient, amount, confirmations) {
  const hash = await walletClient.writeContract({
    address: USDCE,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [COLLATERAL_ONRAMP, amount]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
  if (receipt.status === "reverted") {
    throw new Error(`Approve tx reverted: ${hash}`);
  }

  return hash;
}

export async function wrapUsdce(walletClient, publicClient, recipient, amount, confirmations) {
  const hash = await walletClient.writeContract({
    address: COLLATERAL_ONRAMP,
    abi: ONRAMP_ABI,
    functionName: "wrap",
    args: [USDCE, recipient, amount]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations });
  if (receipt.status === "reverted") {
    throw new Error(`Wrap tx reverted: ${hash}`);
  }

  return hash;
}

export { formatUnits, maxUint256 };
