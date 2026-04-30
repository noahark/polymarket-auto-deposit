export const POLYGON_CHAIN_ID = 137;

export const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
export const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
export const COLLATERAL_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

export const ONRAMP_ABI = [
  "function wrap(address _asset, address _to, uint256 _amount)"
];
