// Byte-level comparison of two decoded outputs (baseline vs candidate
// dictionary). Pure functions over byte arrays: no I/O, no decoding.
//
// The result is a list of maximal contiguous difference ranges expressed in
// final output offsets. Each range carries a capped hexadecimal digest of
// both sides' bytes inside the range plus the first differing position, so
// the caller never has to ship whole outputs to the page.

// Hex digests inside a difference range are capped at this many bytes per
// side; longer ranges are flagged as truncated instead of dumped in full.
export const MAX_DIFF_HEX_BYTES = 64;

function hexSlice(buf, start, end, maxBytes) {
  const available = Math.max(0, Math.min(end, buf.length) - start);
  const shown = Math.min(available, maxBytes);
  let hex = '';
  for (let i = 0; i < shown; i++) {
    hex += buf[start + i].toString(16).padStart(2, '0');
  }
  return { hex, truncated: available > maxBytes };
}

// Compares two decoded outputs byte by byte.
//   baseline / candidate: Uint8Array final outputs of the strict decoder
// Returns:
//   {
//     identical: boolean,          // true when lengths and every byte match
//     ranges: [{
//       start, end,                // final output offsets, [start, end)
//       firstOffset,               // first differing position in the range
//       baselineHex, candidateHex, // capped hex digests of each side's bytes
//       baselineHexTruncated, candidateHexTruncated
//     }]
//   }
// Ranges are ordered by offset and never overlap. When the outputs have
// different lengths, the tail beyond the shorter output is a difference
// range in which the shorter side contributes no bytes (empty hex digest).
export function diffOutputs(baseline, candidate, options = {}) {
  const maxHexBytes = options.maxHexBytes ?? MAX_DIFF_HEX_BYTES;
  const common = Math.min(baseline.length, candidate.length);
  const total = Math.max(baseline.length, candidate.length);

  const ranges = [];
  let pos = 0;
  while (pos < total) {
    if (pos < common && baseline[pos] === candidate[pos]) {
      pos += 1;
      continue;
    }
    const start = pos;
    while (pos < total && (pos >= common || baseline[pos] !== candidate[pos])) {
      pos += 1;
    }
    const end = pos;
    const a = hexSlice(baseline, start, end, maxHexBytes);
    const b = hexSlice(candidate, start, end, maxHexBytes);
    ranges.push({
      start,
      end,
      firstOffset: start,
      baselineHex: a.hex,
      candidateHex: b.hex,
      baselineHexTruncated: a.truncated,
      candidateHexTruncated: b.truncated,
    });
  }

  return { identical: ranges.length === 0, ranges };
}
