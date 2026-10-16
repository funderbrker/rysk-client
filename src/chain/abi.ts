import { erc20Abi, parseAbi } from 'viem';

// Human-readable ABIs only: viem derives event topics from these, so no topic hashes live in source.

export { erc20Abi };

export const vaultStoreAbi = parseAbi([
  'function getAccountVaultCounter(address owner) view returns (uint256)',
]);

export const multicall3Abi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
]);

export const transferEventAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const vaultOpenedEventAbi = parseAbi([
  'event VaultOpened(address indexed accountOwner, uint256 vaultId, uint256 indexed vaultType)',
]);

export const shortOtokenMintedEventAbi = parseAbi([
  'event ShortOtokenMinted(address indexed otoken, address indexed AccountOwner, address indexed to, uint256 vaultId, uint256 amount)',
]);
