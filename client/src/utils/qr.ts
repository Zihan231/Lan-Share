/**
 * Minimal, zero-dependency ISO/IEC 18004 QR Code matrix generator (Byte mode, ECC Level M, Versions 1–10).
 * Works 100% offline in any browser context.
 */

interface VersionSpec {
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
  align: number[];
}

// ISO/IEC 18004 Table 7 & Table 9 for ECC Level M (versions 1..10)
const VERSIONS: VersionSpec[] = [
  { ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0, align: [] },
  { ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0, align: [6, 18] },
  { ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0, align: [6, 22] },
  { ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0, align: [6, 26] },
  { ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0, align: [6, 30] },
  { ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0, align: [6, 34] },
  { ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0, align: [6, 22, 38] },
  { ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39, align: [6, 24, 42] },
  { ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37, align: [6, 26, 46] },
  { ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44, align: [6, 28, 50] },
];

// GF(256) log/exp tables with primitive polynomial 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    EXP[i + 255] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
})();

function rsCompute(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = new Uint8Array(ecLen + 1);
  gen[0] = 1;
  for (let i = 0; i < ecLen; i++) {
    for (let j = i + 1; j >= 1; j--) {
      gen[j] = gen[j] ^ (gen[j - 1] ? EXP[LOG[gen[j - 1]] + i] : 0);
    }
  }
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      const logF = LOG[factor];
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= EXP[LOG[gen[j + 1]] + logF];
      }
    }
  }
  return rem;
}

const MASK_FNS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function formatBits(mask: number): number {
  // ECC Level M = 00
  const data = (0b00 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function penaltyScore(grid: Uint8Array[], n: number): number {
  let score = 0;
  // Rule 1: runs of 5+ same color in row/col
  for (let r = 0; r < n; r++) {
    let runR = 1;
    let runC = 1;
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === grid[r][c - 1]) {
        runR++;
        if (runR === 5) score += 3;
        else if (runR > 5) score += 1;
      } else runR = 1;

      if (grid[c][r] === grid[c - 1][r]) {
        runC++;
        if (runC === 5) score += 3;
        else if (runC > 5) score += 1;
      } else runC = 1;
    }
  }
  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }
  return score;
}

/**
 * Encodes `text` into a square boolean matrix (true = dark module, false = light module).
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);

  let verIdx = -1;
  for (let i = 0; i < VERSIONS.length; i++) {
    const s = VERSIONS[i];
    const totalData = s.g1Blocks * s.g1Data + s.g2Blocks * s.g2Data;
    const countBits = i + 1 <= 9 ? 8 : 16;
    const capacity = Math.floor((totalData * 8 - 4 - countBits) / 8);
    if (bytes.length <= capacity) {
      verIdx = i;
      break;
    }
  }
  if (verIdx === -1) throw new Error('Text too long for QR code');

  const version = verIdx + 1;
  const spec = VERSIONS[verIdx];
  const totalData = spec.g1Blocks * spec.g1Data + spec.g2Blocks * spec.g2Data;

  // Build bit stream
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalData * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = new Uint8Array(totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataWords[i] = b;
  }
  for (let i = bits.length / 8, pad = 0; i < totalData; i++, pad ^= 1) {
    dataWords[i] = pad === 0 ? 0xec : 0x11;
  }

  // Split into blocks & compute RS error correction
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.g1Blocks; i++) {
    const blk = dataWords.subarray(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsCompute(blk, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const blk = dataWords.subarray(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsCompute(blk, spec.ecPerBlock));
  }

  // Interleave data and EC codewords
  const finalWords: number[] = [];
  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) if (i < blk.length) finalWords.push(blk[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) finalWords.push(blk[i]);
  }

  // Prepare matrix
  const n = 17 + version * 4;
  const grid = Array.from({ length: n }, () => new Uint8Array(n));
  const reserved = Array.from({ length: n }, () => new Uint8Array(n));

  const setModule = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    grid[r][c] = dark ? 1 : 0;
    reserved[r][c] = 1;
  };

  // Finder patterns + separators
  const placeFinder = (row: number, col: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(row + dr, col + dc, inOuter && (onBorder || inInner));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);

  // Alignment patterns
  for (const r of spec.align) {
    for (const c of spec.align) {
      if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setModule(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
    if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
  }

  // Dark module & reserve format info slots
  setModule(n - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = 1;
    reserved[n - 1 - i][8] = 1;
  }

  // Version info (for v >= 7)
  if (version >= 7) {
    const vBits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setModule(a, b, dark);
      setModule(b, a, dark);
    }
  }

  // Place data bits in zig-zag
  let bitIdx = 0;
  let upward = true;
  const totalBits = finalWords.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = right - dc;
        if (reserved[r][c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          dark = ((finalWords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        grid[r][c] = dark ? 1 : 0;
      }
    }
    upward = !upward;
  }

  // Choose best mask (0..7)
  const writeFormat = (target: Uint8Array[], mask: number) => {
    const f = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      // Copy 1 (top-left)
      if (i <= 5) target[i][8] = bit;
      else if (i === 6) target[7][8] = bit;
      else if (i === 7) target[8][8] = bit;
      else if (i === 8) target[8][7] = bit;
      else target[8][14 - i] = bit;

      // Copy 2 (top-right + bottom-left)
      if (i <= 7) target[8][n - 1 - i] = bit;
      else target[n - 15 + i][8] = bit;
    }
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid = grid;

  for (let m = 0; m < 8; m++) {
    const cand = grid.map((row) => new Uint8Array(row));
    const fn = MASK_FNS[m];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!reserved[r][c] && fn(r, c)) cand[r][c] ^= 1;
      }
    }
    writeFormat(cand, m);
    const s = penaltyScore(cand, n);
    if (s < bestScore) {
      bestScore = s;
      bestMask = m;
      bestGrid = cand;
    }
  }

  writeFormat(bestGrid, bestMask);
  return bestGrid.map((row) => Array.from(row, (v) => v === 1));
}
