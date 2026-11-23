// Usage: node scripts/brotli.mjs <in> <out>          writes a Brotli copy of <in> at quality 11
//        node scripts/brotli.mjs --check <file> <br>  exits 1 unless <br> decodes to <file>
import { readFileSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const args = process.argv.slice(2);
if (args[0] === "--check" && args.length === 3) {
  const plain = readFileSync(args[1]);
  let decoded;
  try {
    decoded = brotliDecompressSync(readFileSync(args[2]));
  } catch (e) {
    console.error(`error: ${args[2]} is not valid Brotli data: ${e.message}`);
    process.exit(1);
  }
  if (!decoded.equals(plain)) {
    console.error(`error: ${args[2]} does not decode to ${args[1]}`);
    process.exit(1);
  }
} else if (args.length === 2) {
  const data = readFileSync(args[0]);
  const packed = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      [constants.BROTLI_PARAM_LGWIN]: 24,
    },
  });
  writeFileSync(args[1], packed);
} else {
  console.error("usage: node scripts/brotli.mjs <in> <out> | --check <file> <br>");
  process.exit(2);
}
