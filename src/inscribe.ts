/**
 * inscribe.ts — build the two-phase Ordinals commit/reveal transactions.
 *
 * Why two phases? An inscription lives inside a tapscript envelope in the
 * WITNESS of a transaction. For the inscription to be trustless, the content
 * must be committed to BEFORE it is revealed — otherwise anyone watching the
 * mempool could front-run it. Bitcoin commits to the envelope via a taproot
 * output whose script tree contains the inscription script:
 *
 *   Phase 1 (commit):  fund a P2TR output committing to the inscription
 *                      script (+ change back to the funding address).
 *   Phase 2 (reveal):  spend that output via the script path, embedding the
 *                      inscription envelope in the witness. The first output
 *                      carries the newly inscribed sat to its destination.
 *
 * This script NEVER signs and NEVER broadcasts. It writes UNSIGNED PSBTs
 * (base64) plus a JSON plan to ./out. You sign in an ord-compatible wallet
 * (e.g. Sparrow) after reviewing, then broadcast manually. See README.
 *
 *   npm run inscribe                 # phase 1: commit PSBTs + plan.json
 *   # sign + broadcast each commit PSBT, wait for confirmation,
 *   # then record the txid in out/plan.json (commitTxid per item)
 *   npm run inscribe:reveal -- --file <name>   # phase 2: reveal PSBT
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import {
  config,
  getNetworkConfig,
  getInscriptionKey,
  BtcNetwork,
} from "./config";
import {
  DUST_LIMIT_SATS,
  P2WPKH_INPUT_VBYTES,
  chunkContent,
  estimateCommitVbytes,
  estimateInscriptionScriptLen,
  estimateRevealVbytes,
  feeForVbytes,
  satsToBtc,
} from "./fees";

bitcoin.initEccLib(ecc);

/** Tapscript leaf version (BIP-342). */
const TAPSCRIPT_LEAF_VERSION = 0xc0;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".txt": "text/plain;charset=utf-8",
  ".html": "text/html;charset=utf-8",
};

interface Asset {
  fileName: string;
  contentType: string;
  content: Buffer;
}

interface PlanItem {
  file: string;
  contentType: string;
  contentBytes: number;
  inscriptionScriptHex: string;
  /** P2TR address committing to the inscription script. */
  commitAddress: string;
  /** Sats locked in the commit output: dust for the inscription + reveal fee. */
  commitValueSats: number;
  estimatedCommitFeeSats: number;
  estimatedRevealFeeSats: number;
  /** Filled in by YOU after the commit confirms. */
  commitTxid: string | null;
  commitVout: number;
}

interface Plan {
  network: string;
  feeRateSatVb: number;
  destinationAddress: string;
  createdAt: string;
  items: PlanItem[];
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean };
}

interface FundingInput {
  txid: string;
  vout: number;
  value: number;
  script: Buffer;
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `Esplora request failed: ${res.status} ${res.statusText} (${url})`
    );
  }
  return (await res.json()) as T;
}

/** Load every file in the assets dir as one inscription per file. */
function loadAssets(dir: string): Asset[] {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `Assets directory not found: ${dir}. Create it and drop files to inscribe inside.`
    );
  }
  const assets: Asset[] = [];
  for (const fileName of fs.readdirSync(dir).sort()) {
    if (fileName.startsWith(".")) continue;
    const full = path.join(dir, fileName);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(fileName).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      console.warn(
        `  ! skipping ${fileName}: unknown extension '${ext}' (no content-type mapping)`
      );
      continue;
    }
    const content = fs.readFileSync(full);
    if (content.length === 0) {
      console.warn(`  ! skipping ${fileName}: empty file`);
      continue;
    }
    if (content.length > 400_000) {
      console.warn(
        `  ! ${fileName} is ${(content.length / 1024).toFixed(0)} KB — ` +
          `large inscriptions are expensive; consider shrinking it first.`
      );
    }
    assets.push({ fileName, contentType, content });
  }
  return assets;
}

/**
 * Build the inscription envelope (tapscript):
 *   <x-only pubkey> OP_CHECKSIG OP_0 OP_IF "ord" OP_1 <content-type> OP_0 <content…> OP_ENDIF
 * Content is split into 520-byte pushes — larger pushes are non-standard.
 */
function buildInscriptionScript(
  xOnlyPubkey: Buffer,
  contentType: string,
  content: Buffer
): Buffer {
  return bitcoin.script.compile([
    xOnlyPubkey,
    bitcoin.opcodes.OP_CHECKSIG,
    bitcoin.opcodes.OP_0,
    bitcoin.opcodes.OP_IF,
    Buffer.from("ord", "utf8"),
    bitcoin.opcodes.OP_1, // tag 1 = content type
    Buffer.from(contentType, "utf8"),
    bitcoin.opcodes.OP_0, // tag 0 = body
    ...chunkContent(content),
    bitcoin.opcodes.OP_ENDIF,
  ]);
}

/** The P2TR payment committing to `script`, plus its control block for the reveal. */
function commitPayment(
  xOnlyPubkey: Buffer,
  script: Buffer,
  network: BtcNetwork
): { address: string; output: Buffer; controlBlock: Buffer } {
  const redeem = { output: script, redeemVersion: TAPSCRIPT_LEAF_VERSION };
  const p2tr = bitcoin.payments.p2tr({
    internalPubkey: xOnlyPubkey,
    scriptTree: { output: script },
    redeem,
    network,
  });
  if (!p2tr.address || !p2tr.output || !p2tr.witness) {
    throw new Error("Failed to derive the taproot commit payment.");
  }
  // For a single-leaf tree, the last witness element is the control block.
  const controlBlock = p2tr.witness[p2tr.witness.length - 1];
  return { address: p2tr.address, output: p2tr.output, controlBlock };
}

async function fetchUtxos(address: string, esploraUrl: string): Promise<EsploraUtxo[]> {
  const utxos = await apiGet<EsploraUtxo[]>(
    `${esploraUrl}/address/${address}/utxo`
  );
  return utxos.filter((u) => u.status.confirmed);
}

async function fetchPrevoutScript(
  txid: string,
  vout: number,
  esploraUrl: string
): Promise<Buffer> {
  const tx = await apiGet<{ vout: { scriptpubkey: string }[] }>(
    `${esploraUrl}/tx/${txid}`
  );
  const out = tx.vout[vout];
  if (!out) {
    throw new Error(`Output ${vout} not found in transaction ${txid}.`);
  }
  return Buffer.from(out.scriptpubkey, "hex");
}

/** Largest-first coin selection for `targetSats` from confirmed UTXOs. */
function selectInputs(utxos: EsploraUtxo[], targetSats: number): EsploraUtxo[] {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: EsploraUtxo[] = [];
  let total = 0;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    if (total >= targetSats) break;
  }
  if (total < targetSats) {
    throw new Error(
      `Insufficient confirmed funds: need ${targetSats} sats (${satsToBtc(targetSats)} BTC), ` +
        `have ${total} sats at ${config.fundingAddress}. Fund the address and wait for confirmation.`
    );
  }
  return selected;
}

function writeOutFile(name: string, contents: string): string {
  fs.mkdirSync(config.outDir, { recursive: true });
  const full = path.join(config.outDir, name);
  fs.writeFileSync(full, contents);
  return full;
}

function parseArgs(): { phase: "commit" | "reveal"; file?: string } {
  const args = process.argv.slice(2);
  const phaseArg = args[args.indexOf("--phase") + 1];
  const phase = phaseArg === "reveal" ? "reveal" : "commit";
  const fileIdx = args.indexOf("--file");
  const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
  return { phase, file };
}

/** PHASE 1 — build one unsigned commit PSBT per asset + the plan file. */
async function phaseCommit(): Promise<void> {
  const { name, network, esploraUrl } = getNetworkConfig();
  const { xOnlyPubkey } = getInscriptionKey();
  const assets = loadAssets(config.assetsDir);
  if (assets.length === 0) {
    throw new Error(`No inscribable files found in ${config.assetsDir}/.`);
  }

  console.log(`Network: ${name} | fee rate: ${config.feeRateSatVb} sat/vB`);
  console.log(`Funding address: ${config.fundingAddress}`);
  const utxos = await fetchUtxos(config.fundingAddress, esploraUrl);
  if (utxos.length === 0) {
    throw new Error(
      `No confirmed UTXOs at ${config.fundingAddress}. Fund it and wait for a confirmation.`
    );
  }

  const plan: Plan = {
    network: name,
    feeRateSatVb: config.feeRateSatVb,
    destinationAddress: config.destinationAddress,
    createdAt: new Date().toISOString(),
    items: [],
  };

  for (const asset of assets) {
    const script = buildInscriptionScript(
      xOnlyPubkey,
      asset.contentType,
      asset.content
    );
    const { address: commitAddress, output: commitOutput } = commitPayment(
      xOnlyPubkey,
      script,
      network
    );

    // The commit output must cover the reveal fee + dust for the inscription.
    const scriptLen = estimateInscriptionScriptLen(
      asset.content.length,
      asset.contentType.length
    );
    const estimatedRevealFeeSats = feeForVbytes(
      estimateRevealVbytes(scriptLen),
      config.feeRateSatVb
    );
    const commitValueSats = DUST_LIMIT_SATS + estimatedRevealFeeSats;

    // Select inputs (iterate: the commit fee itself depends on input count).
    let selected = selectInputs(
      utxos,
      commitValueSats +
        feeForVbytes(estimateCommitVbytes(P2WPKH_INPUT_VBYTES), config.feeRateSatVb)
    );
    let fundingInputsVbytes = selected.length * P2WPKH_INPUT_VBYTES;
    let estimatedCommitFeeSats = feeForVbytes(
      estimateCommitVbytes(fundingInputsVbytes),
      config.feeRateSatVb
    );
    const reselected = selectInputs(utxos, commitValueSats + estimatedCommitFeeSats);
    if (reselected.length !== selected.length) {
      selected = reselected;
      fundingInputsVbytes = selected.length * P2WPKH_INPUT_VBYTES;
      estimatedCommitFeeSats = feeForVbytes(
        estimateCommitVbytes(fundingInputsVbytes),
        config.feeRateSatVb
      );
    }

    const inputs: FundingInput[] = [];
    for (const u of selected) {
      inputs.push({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: await fetchPrevoutScript(u.txid, u.vout, esploraUrl),
      });
    }
    const totalIn = inputs.reduce((sum, i) => sum + i.value, 0);
    const change = totalIn - commitValueSats - estimatedCommitFeeSats;

    const psbt = new bitcoin.Psbt({ network });
    for (const input of inputs) {
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        witnessUtxo: { script: input.script, value: input.value },
      });
    }
    psbt.addOutput({ script: commitOutput, value: commitValueSats });
    if (change >= DUST_LIMIT_SATS) {
      psbt.addOutput({
        address: config.fundingAddress,
        value: change,
      });
    } else {
      console.warn(
        `  ! change of ${change} sats is dust — added to the miner fee instead.`
      );
    }

    const base = path.parse(asset.fileName).name;
    const psbtPath = writeOutFile(`commit-${base}.psbt`, psbt.toBase64());
    plan.items.push({
      file: asset.fileName,
      contentType: asset.contentType,
      contentBytes: asset.content.length,
      inscriptionScriptHex: script.toString("hex"),
      commitAddress,
      commitValueSats,
      estimatedCommitFeeSats,
      estimatedRevealFeeSats,
      commitTxid: null,
      commitVout: 0,
    });

    console.log(`\n${asset.fileName} (${asset.contentType}, ${asset.content.length} bytes)`);
    console.log(`  commit address: ${commitAddress}`);
    console.log(`  commit value:   ${commitValueSats} sats (${satsToBtc(commitValueSats)} BTC)`);
    console.log(`  est. commit fee: ${estimatedCommitFeeSats} sats | est. reveal fee: ${estimatedRevealFeeSats} sats`);
    console.log(`  unsigned PSBT -> ${psbtPath}`);
  }

  const planPath = writeOutFile("plan.json", JSON.stringify(plan, null, 2));
  console.log(`\nPlan written -> ${planPath}`);
  console.log(
    "\nNEXT: sign each commit PSBT in your wallet, broadcast, wait for confirmation,\n" +
      "then set commitTxid for each item in out/plan.json and run:\n" +
      "  npm run inscribe:reveal -- --file <asset-name-without-extension>"
  );
}

/** PHASE 2 — build the unsigned reveal PSBT for one asset (commit must be confirmed). */
async function phaseReveal(assetBase: string | undefined): Promise<void> {
  if (!assetBase) {
    throw new Error("Reveal phase needs --file <asset-name-without-extension>.");
  }
  const { network } = getNetworkConfig();
  const { xOnlyPubkey } = getInscriptionKey();

  const planPath = path.join(config.outDir, "plan.json");
  if (!fs.existsSync(planPath)) {
    throw new Error("out/plan.json not found — run the commit phase first.");
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;
  const item = plan.items.find(
    (i) => path.parse(i.file).name === assetBase
  );
  if (!item) {
    throw new Error(
      `No plan item for '${assetBase}'. Available: ${plan.items
        .map((i) => path.parse(i.file).name)
        .join(", ")}`
    );
  }
  if (!item.commitTxid) {
    throw new Error(
      `commitTxid is not set for '${item.file}' in out/plan.json. ` +
        "Broadcast the signed commit PSBT, wait for confirmation, then record its txid."
    );
  }

  const script = Buffer.from(item.inscriptionScriptHex, "hex");
  const { output: commitOutput, controlBlock } = commitPayment(
    xOnlyPubkey,
    script,
    network
  );

  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: item.commitTxid,
    index: item.commitVout,
    witnessUtxo: { script: commitOutput, value: item.commitValueSats },
    tapLeafScript: [
      {
        leafVersion: TAPSCRIPT_LEAF_VERSION,
        script,
        controlBlock,
      },
    ],
  });
  psbt.addOutput({
    address: plan.destinationAddress,
    value: DUST_LIMIT_SATS,
  });

  // Sanity check: the commit output must still cover the reveal fee at the
  // CURRENT fee rate — fees may have moved since the commit was built.
  const impliedFee = item.commitValueSats - DUST_LIMIT_SATS;
  const neededFee = feeForVbytes(
    estimateRevealVbytes(script.length),
    config.feeRateSatVb
  );
  if (impliedFee < neededFee) {
    console.warn(
      `  ! WARNING: commit output only leaves ${impliedFee} sats for fees, ` +
        `but ~${neededFee} sats are needed at ${config.feeRateSatVb} sat/vB. ` +
        "The reveal may not confirm — consider CPFP on the commit or waiting for lower fees."
    );
  }

  const psbtPath = writeOutFile(`reveal-${assetBase}.psbt`, psbt.toBase64());
  console.log(`\n${item.file}: unsigned reveal PSBT -> ${psbtPath}`);
  console.log(
    `Inscription will go to ${plan.destinationAddress} (output 0 of the reveal).\n` +
      "NEXT: sign with the WALLET_WIF key (import it into Sparrow as a single-key wallet),\n" +
      "broadcast, then look up the inscription id: <reveal-txid>i0"
  );
}

async function main(): Promise<void> {
  const { phase, file } = parseArgs();
  if (phase === "reveal") {
    await phaseReveal(file);
  } else {
    await phaseCommit();
  }
}

main().catch((err) => {
  console.error(`\nError: ${(err as Error).message}`);
  process.exit(1);
});
