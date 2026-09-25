/**
 * Shared configuration: network, fee rate, inscription key, and API endpoint.
 *
 * Design note on keys: this tool NEVER signs and NEVER broadcasts. WALLET_WIF
 * is a dedicated inscription key whose x-only public key becomes the internal
 * key of the inscription (tapscript) envelope. It authorizes the reveal spend,
 * so the PSBTs this tool emits are signed externally (e.g. Sparrow) after you
 * review them. Funding UTXOs come from FUNDING_ADDRESS, a separate
 * ord-compatible wallet you control.
 */
import "dotenv/config";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";

bitcoin.initEccLib(ecc);

export type BtcNetwork = typeof bitcoin.networks.bitcoin;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface NetworkConfig {
  name: "mainnet" | "testnet";
  network: BtcNetwork;
  esploraUrl: string;
}

/** Resolve the Bitcoin network and the Esplora-compatible API endpoint. */
export function getNetworkConfig(): NetworkConfig {
  const raw = (process.env.BITCOIN_NETWORK ?? "testnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(
      `Invalid BITCOIN_NETWORK=${process.env.BITCOIN_NETWORK}: expected "mainnet" or "testnet".`
    );
  }
  const name = raw as "mainnet" | "testnet";
  const network =
    name === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const esploraUrl =
    process.env.ORD_API_URL ??
    (name === "mainnet"
      ? "https://mempool.space/api"
      : "https://mempool.space/testnet/api");
  return { name, network, esploraUrl };
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(input: string): Buffer {
  let num = 0n;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(`Invalid base58 character in WIF: '${char}'`);
    }
    num = num * 58n + BigInt(digit);
  }
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const bytes = Buffer.from(hex, "hex");
  // Preserve leading zero bytes (leading '1's in base58).
  let leadingOnes = 0;
  for (const char of input) {
    if (char !== "1") break;
    leadingOnes++;
  }
  return Buffer.concat([Buffer.alloc(leadingOnes), bytes]);
}

function sha256d(data: Buffer): Buffer {
  return bitcoin.crypto.sha256(bitcoin.crypto.sha256(data));
}

/**
 * Decode and validate a WIF private key against the active network.
 * Throws on bad length, version byte, checksum, or out-of-range scalar.
 */
export function wifToPrivateKey(wif: string, network: BtcNetwork): Buffer {
  const raw = base58Decode(wif.trim());
  if (raw.length !== 38) {
    throw new Error(
      `Invalid WIF: decoded length is ${raw.length} bytes, expected 38.`
    );
  }
  const expectedVersion =
    network === bitcoin.networks.bitcoin ? 0x80 : 0xef;
  if (raw[0] !== expectedVersion) {
    throw new Error(
      `WIF version byte 0x${raw[0].toString(16)} does not match the configured network ` +
        `(expected 0x${expectedVersion.toString(16)}). ` +
        `Check BITCOIN_NETWORK or use a ${network === bitcoin.networks.bitcoin ? "mainnet" : "testnet"} WIF.`
    );
  }
  if (raw[33] !== 0x01) {
    throw new Error("Invalid WIF: expected compressed-key flag 0x01.");
  }
  const payload = raw.subarray(0, 34);
  const checksum = raw.subarray(34);
  if (!sha256d(payload).subarray(0, 4).equals(checksum)) {
    throw new Error("Invalid WIF: checksum mismatch.");
  }
  const privateKey = payload.subarray(1, 33);
  if (!ecc.pointFromScalar(privateKey)) {
    throw new Error("Invalid WIF: private key scalar is out of curve range.");
  }
  return privateKey;
}

export interface InscriptionKey {
  /** 32-byte secret — kept in memory only, never written to disk. */
  privateKey: Buffer;
  /** 32-byte x-only public key used as the taproot internal key. */
  xOnlyPubkey: Buffer;
}

/** Load WALLET_WIF and derive the x-only public key for inscription scripts. */
export function getInscriptionKey(): InscriptionKey {
  const { network } = getNetworkConfig();
  const privateKey = wifToPrivateKey(required("WALLET_WIF"), network);
  const compressed = Buffer.from(ecc.pointFromScalar(privateKey) as Uint8Array);
  return { privateKey, xOnlyPubkey: compressed.subarray(1, 33) };
}

const fundingAddress = required("FUNDING_ADDRESS");

export const config = {
  /** Sat/vB paid for both commit and reveal transactions. */
  feeRateSatVb: Number(process.env.FEE_RATE_SAT_VB ?? "10"),
  /** Address whose UTXOs fund the commit transaction. */
  fundingAddress,
  /** Where inscribed sats go. Defaults to the funding address. */
  destinationAddress:
    process.env.INSCRIPTION_DESTINATION_ADDRESS ?? fundingAddress,
  /** Folder of files to inscribe. */
  assetsDir: process.env.ASSETS_DIR ?? "assets",
  /** Where plans and unsigned PSBTs are written. */
  outDir: process.env.OUT_DIR ?? "out",
};

if (!Number.isFinite(config.feeRateSatVb) || config.feeRateSatVb <= 0) {
  throw new Error(
    `Invalid FEE_RATE_SAT_VB=${process.env.FEE_RATE_SAT_VB}: expected a positive number.`
  );
}
