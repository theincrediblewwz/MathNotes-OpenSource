import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { openPromise } from "yauzl";
import { ZipFile } from "yazl";

export const SHARE_LIMITS = { files: 4096, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, markdownBytes: 8 * 1024 * 1024 };
export class SharePackageError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}
export function safeSharePath(value: string): string {
  const parts = value.split("/");
  if (parts.length > 32 || value.length > 4096 || parts.some(part => !part || part === "." || part === ".." ||
      /[\\\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new SharePackageError("unsafe_package_path", "分享包包含不兼容或越界的文件路径。");
  }
  return value;
}
const ignoredMetadata = (value: string) => value.split("/").some(part => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));

export async function extractShareZip(source: string, destination: string): Promise<void> {
  if ((await lstat(source)).size > SHARE_LIMITS.totalBytes) throw new SharePackageError("package_too_large", "分享包超过 256 MB。");
  const zip = await openPromise(source, { lazyEntries: true, validateEntrySizes: true });
  let total = 0, count = 0;
  const names = new Map<string, string>();
  const files = new Set<string>();
  try {
    for await (const entry of zip.eachEntry()) {
      if (++count > SHARE_LIMITS.files) throw new SharePackageError("too_many_files", "分享包文件数量过多。");
      const directory = entry.fileName.endsWith("/");
      const name = safeSharePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if ((mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) {
        throw new SharePackageError("unsupported_zip_entry", "不支持加密文件、符号链接或特殊文件。");
      }
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > SHARE_LIMITS.fileBytes || total > SHARE_LIMITS.totalBytes) throw new SharePackageError("package_too_large", "分享包解压后的文件过大。");
      const parts = name.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const original = parts.slice(0, i).join("/");
        const canonical = original.normalize("NFC").toLowerCase();
        if (names.has(canonical) && names.get(canonical) !== original) throw new SharePackageError("duplicate_package_path", "分享包包含大小写或 Unicode 冲突的路径。");
        names.set(canonical, original);
      }
      if (ignoredMetadata(name)) continue;
      const target = join(destination, ...parts);
      if (directory) { await mkdir(target, { recursive: true }); continue; }
      const key = name.normalize("NFC").toLowerCase();
      if (files.has(key)) throw new SharePackageError("duplicate_package_path", "分享包包含重复文件。");
      files.add(key);
      await mkdir(dirname(target), { recursive: true });
      let actual = 0, checksum = 0;
      const bounds = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        actual += chunk.length;
        if (actual > entry.uncompressedSize || actual > SHARE_LIMITS.fileBytes) return callback(new SharePackageError("package_too_large", "分享包解压大小与记录不符。"));
        checksum = crc32(chunk, checksum);
        callback(null, chunk);
      } });
      await pipeline(await zip.openReadStreamPromise(entry), bounds, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      if (actual !== entry.uncompressedSize || checksum !== entry.crc32) throw new SharePackageError("corrupt_package", "分享包校验失败，文件可能已损坏。");
    }
  } finally { zip.close(); }
}

export async function shareFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  let total = 0, count = 0;
  const names = new Map<string, string>();
  const visit = async (relative: string) => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      safeSharePath(name);
      if (++count > SHARE_LIMITS.files) throw new SharePackageError("too_many_files", "分享包文件数量过多。");
      const canonical = name.normalize("NFC").toLowerCase();
      if (names.has(canonical)) throw new SharePackageError("duplicate_package_path", "分享包包含大小写或 Unicode 冲突的路径。");
      names.set(canonical, name);
      if (ignoredMetadata(name)) continue;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new SharePackageError("unsafe_package_path", "分享包包含符号链接或特殊文件。");
      if (entry.isDirectory()) { await visit(name); continue; }
      const size = (await lstat(join(root, name))).size;
      total += size;
      if (size > SHARE_LIMITS.fileBytes || total > SHARE_LIMITS.totalBytes || result.length >= SHARE_LIMITS.files) throw new SharePackageError("package_too_large", "分享包文件过多或超过 256 MB。");
      result.push(name);
    }
  };
  await visit("");
  return result.sort();
}

export async function zipShareDirectory(root: string, target: string): Promise<void> {
  const files = await shareFiles(root);
  const zip = new ZipFile();
  const output = createWriteStream(target, { flags: "wx" });
  zip.on("error", error => output.destroy(error));
  const completion = pipeline(zip.outputStream, output);
  for (const name of files) zip.addFile(join(root, name), name);
  zip.end();
  await completion;
}
