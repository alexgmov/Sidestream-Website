import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepositoryPath = fileURLToPath(new URL("../../", import.meta.url));

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRepositorySource(repositoryRoot, candidate) {
  if (!isWithin(repositoryRoot, candidate)) return false;
  const relative = path.relative(repositoryRoot, candidate);
  return !relative.split(path.sep).some((segment) => segment.toLowerCase() === "node_modules");
}

function canonicalRepositoryFile(repositoryPath, canonicalRepositoryRoot, fileUrl) {
  let absolutePath;
  try {
    absolutePath = path.resolve(fileURLToPath(fileUrl));
  } catch {
    return null;
  }
  if (!isRepositorySource(repositoryPath, absolutePath)) return null;

  try {
    if (!statSync(absolutePath).isFile()) return null;
    const canonicalPath = realpathSync(absolutePath);
    return isRepositorySource(canonicalRepositoryRoot, canonicalPath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

export function createTypeScriptSourceResolveHook(root) {
  const repositoryPath = path.resolve(root);
  const canonicalRepositoryRoot = realpathSync(repositoryPath);

  return async function resolveTypeScriptSource(specifier, context, nextResolve) {
    let resolutionError;
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      resolutionError = error;
    }

    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (resolutionError?.code !== "ERR_MODULE_NOT_FOUND" || !isRelative ||
      !specifier.endsWith(".js") || !context.parentURL?.startsWith("file:")) {
      throw resolutionError;
    }

    const parentPath = canonicalRepositoryFile(
      repositoryPath,
      canonicalRepositoryRoot,
      context.parentURL,
    );
    if (!parentPath) throw resolutionError;

    const candidateUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    const candidatePath = canonicalRepositoryFile(
      repositoryPath,
      canonicalRepositoryRoot,
      candidateUrl,
    );
    if (!candidatePath) throw resolutionError;

    return nextResolve(pathToFileURL(candidatePath).href, context);
  };
}

export const resolve = createTypeScriptSourceResolveHook(defaultRepositoryPath);
