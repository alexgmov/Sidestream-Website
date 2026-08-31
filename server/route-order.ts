import path from "node:path";

// Static routes must precede sibling dynamic routes. Otherwise a path such as
// /api/internal/customers/funnel is consumed by [customerId].
export function sortCompiledApiRouteFiles(files: readonly string[]) {
  return [...files].sort((left, right) =>
    routeSpecificity(right) - routeSpecificity(left) || left.localeCompare(right));
}

function routeSpecificity(filename: string) {
  return filename.split(path.sep).reduce((score, segment) =>
    score + (/^\[[A-Za-z][A-Za-z0-9_]*\]\.js$/.test(segment) ? 0 : 1), 0);
}
