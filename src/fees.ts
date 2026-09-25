/**
 * Fee estimation helpers for Bitcoin Ordinals inscriptions.
 *
 * Sizes are in virtual bytes (vbytes), fees in satoshis. Every estimate is a
 * conservative upper bound — the commit/reveal flow slightly overpays rather
 * than risking a stuck transaction.
 */

/** Dust limit for a standard output (sats). The reveal output carries 546 sats. */
export const DUST_LIMIT_SATS = 546;

/** Max bytes per data push — larger pushes are non-standard and won't relay. */
export const MAX_PUSH_BYTES = 520;

/** vbytes of a P2WPKH input — the typical funding input. */
export const P2WPKH_INPUT_VBYTES = 68;
/** vbytes of a P2TR key-path input. */
export const P2TR_KEYPATH_INPUT_VBYTES = 58;
/** vbytes of a P2TR output (the commit output). */
export const P2TR_OUTPUT_VBYTES = 43;
/** vbytes of a P2WPKH output (the change output). */
export const P2WPKH_OUTPUT_VBYTES = 31;
/** Fixed overhead: version (4) + input/output counts (2) + locktime (4). */
export const TX_OVERHEAD_VBYTES = 10;

/** Split content into standardness-safe 520-byte pushes. */
export function chunkContent(content: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += MAX_PUSH_BYTES) {
    chunks.push(content.subarray(offset, offset + MAX_PUSH_BYTES));
  }
  return chunks;
}

/**
 * Estimated serialized length of the inscription (tapscript) envelope:
 *   <x-only pubkey> OP_CHECKSIG OP_0 OP_IF "ord" OP_1 <content-type> OP_0 <content…> OP_ENDIF
 */
export function estimateInscriptionScriptLen(
  contentLen: number,
  contentTypeLen: number
): number {
  const chunks = Math.max(1, Math.ceil(contentLen / MAX_PUSH_BYTES));
  return (
    34 + // push of the 32-byte x-only pubkey (1 length byte + 32) + OP_CHECKSIG
    2 + // OP_0 OP_IF
    5 + // push "ord" (1 length byte + 3) + OP_1 content-type tag
    (1 + contentTypeLen) + // push of the content-type string
    1 + // OP_0 body tag
    contentLen +
    chunks * 2 + // ~2 bytes of push overhead per 520-byte chunk
    1 // OP_ENDIF
  );
}

/**
 * vbytes of the reveal input (P2TR script-path spend).
 * Witness = signature (~66 bytes incl. push opcode) + inscription script
 * + control block (33-byte internal key + 32-byte merkle path for 1 leaf).
 */
export function estimateRevealInputVbytes(
  inscriptionScriptLen: number
): number {
  const witnessBytes = 66 + inscriptionScriptLen + 65;
  return 41 + Math.ceil(witnessBytes / 4);
}

/** vbytes of the commit tx: funding inputs + taproot output + change output. */
export function estimateCommitVbytes(
  fundingInputsVbytes: number,
  changeOutputVbytes: number = P2WPKH_OUTPUT_VBYTES
): number {
  return (
    TX_OVERHEAD_VBYTES + fundingInputsVbytes + P2TR_OUTPUT_VBYTES + changeOutputVbytes
  );
}

/** vbytes of the reveal tx: one script-path input + the inscription output. */
export function estimateRevealVbytes(
  inscriptionScriptLen: number,
  outputVbytes: number = P2TR_OUTPUT_VBYTES
): number {
  return (
    TX_OVERHEAD_VBYTES +
    estimateRevealInputVbytes(inscriptionScriptLen) +
    outputVbytes
  );
}

/** Fee in sats for a `vbytes` transaction at `feeRateSatVb` (always rounds up). */
export function feeForVbytes(vbytes: number, feeRateSatVb: number): number {
  return Math.ceil(vbytes * feeRateSatVb);
}

export function satsToBtc(sats: number): string {
  return (sats / 1e8).toFixed(8);
}
