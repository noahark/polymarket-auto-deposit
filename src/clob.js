export async function refreshClobBalance(host, walletClient, creds) {
  const { AssetType, Chain, ClobClient } = await import("@polymarket/clob-client-v2");

  const client = new ClobClient({
    host,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds: {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase
    }
  });

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

  return client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}
