import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress), gz = promisify(gzip);
/** Precompress only built static assets; request handling remains file streaming. */
export function compressedAssets(): Plugin {
  return { name: "compressed-static-assets", async writeBundle(options, bundle) {
    if (!options.dir) return;
    await Promise.all(Object.values(bundle).filter(asset => /\.(?:js|css|wasm)$/.test(asset.fileName)).map(async asset => {
      const source = asset.type === "chunk" ? asset.code : asset.source;
      const bytes = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
      const [br, gzip] = await Promise.all([brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), gz(bytes, { level: 9 })]);
      const path = join(options.dir!, asset.fileName);
      await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gzip)]);
    }));
  } };
}
