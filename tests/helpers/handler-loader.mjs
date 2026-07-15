import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

let loadSequence = 0;

/**
 * Load a TypeScript route with explicit replacements for its module imports.
 * The production source is transpiled in memory; no generated files are left
 * in the repository and every injected binding is fixed for that import.
 */
export async function loadInjectedHandler(sourceUrl, injectedModules) {
  const loaded = await loadInjectedModule(sourceUrl, injectedModules);
  if (typeof loaded.default !== "function") {
    const normalizedSourceUrl = sourceUrl instanceof URL
      ? sourceUrl
      : pathToFileURL(sourceUrl);
    throw new TypeError(`Expected ${normalizedSourceUrl.href} to export a default handler`);
  }
  return loaded.default;
}

export async function loadInjectedModule(sourceUrl, injectedModules) {
  const normalizedSourceUrl = sourceUrl instanceof URL
    ? sourceUrl
    : pathToFileURL(sourceUrl);
  const source = await readFile(normalizedSourceUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: fileURLToPath(normalizedSourceUrl),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
  });

  const diagnostics = transpiled.diagnostics || [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
  }

  const replacements = new Map(Object.entries(injectedModules));

  const executableSource = rewriteModuleSpecifiers(
    transpiled.outputText,
    normalizedSourceUrl,
    replacements,
  );
  const uniqueSource = `${executableSource}\n//# sourceURL=${normalizedSourceUrl.href}?contract=${++loadSequence}`;
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(uniqueSource)}`;
  return import(moduleUrl);
}

function createInjectedModuleUrl(bindings) {
  const key = `sidestream.contract.dependencies.${++loadSequence}`;
  const symbol = Symbol.for(key);
  globalThis[symbol] = Object.freeze({ ...bindings });

  const exports = Object.keys(bindings).map((name) => {
    if (!/^[$A-Z_a-z][$\w]*$/.test(name)) {
      throw new TypeError(`Invalid injected export name: ${name}`);
    }
    return `export const ${name} = dependencies[${JSON.stringify(name)}];`;
  });
  const source = [
    `const symbol = Symbol.for(${JSON.stringify(key)});`,
    "const dependencies = globalThis[symbol];",
    "if (!dependencies) throw new Error('Injected dependencies were released too early');",
    ...exports,
    "delete globalThis[symbol];",
  ].join("\n");
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function rewriteModuleSpecifiers(source, sourceUrl, replacements) {
  return source.replace(
    /((?:from|import)\s*)(["'])([^"']+)\2/g,
    (match, prefix, _quote, specifier) => {
      if (replacements.has(specifier)) {
        const configured = replacements.get(specifier);
        const injected = typeof configured === "string" && configured.startsWith("data:")
          ? configured
          : createInjectedModuleUrl(configured);
        replacements.set(specifier, injected);
        return `${prefix}${JSON.stringify(injected)}`;
      }
      if (!specifier.startsWith(".")) return match;

      const executableSpecifier = specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.ts`
        : specifier;
      return `${prefix}${JSON.stringify(new URL(executableSpecifier, sourceUrl).href)}`;
    },
  );
}
