import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function readRegularFile(filename, options = {}) {
  const maximumBytes = options.maximumBytes ?? 1024 * 1024;
  const encoding = options.encoding ?? "utf8";
  const requirePrivate = options.requirePrivate === true;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maximumBytes ||
      (requirePrivate && (before.mode & 0o077) !== 0)
    ) {
      throw new Error("operator_file_rejected");
    }
    if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
      throw new Error("operator_file_rejected");
    }
    const value = await handle.readFile({ encoding });
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error("operator_file_changed");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function writeRegularFileAtomically(filename, contents) {
  const directory = path.dirname(filename);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filename)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filename);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
