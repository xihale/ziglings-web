// Pure-logic catalog integrity validator.
// Returns an array of human-readable problem strings (empty = valid).
//
// `opts.exists(path)` is injected so tests can supply a fake filesystem;
// the CLI wrapper below uses the real fs.

export function checkCatalog(catalog, opts) {
  const problems = [];
  const exists = opts.exists;

  if (!catalog.zigFloor) problems.push("missing top-level zigFloor");

  const seenNumbers = new Set();
  for (const ex of catalog.exercises ?? []) {
    if (!ex.sourcePath) {
      problems.push(`exercise ${ex.slug ?? ex.number}: missing sourcePath`);
    } else if (!exists(ex.sourcePath)) {
      problems.push(`exercise ${ex.slug}: sourcePath file missing: ${ex.sourcePath}`);
    }
    if (!ex.patchPath) {
      problems.push(`exercise ${ex.slug ?? ex.number}: missing patchPath`);
    } else if (!exists(ex.patchPath)) {
      problems.push(`exercise ${ex.slug}: patchPath file missing: ${ex.patchPath}`);
    }
    if (ex.number != null) {
      if (seenNumbers.has(ex.number)) {
        problems.push(`duplicate number: ${ex.number} (slug ${ex.slug})`);
      }
      seenNumbers.add(ex.number);
    }
  }
  return problems;
}

// --- CLI wrapper ---
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Run as CLI only when invoked directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const catalogPath = resolve(root, "vendor/ziglings/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const problems = checkCatalog(catalog, { exists: (p) => existsSync(resolve(root, "vendor/ziglings", p)) });
  if (problems.length > 0) {
    console.error(`catalog integrity: ${problems.length} problem(s):`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log(`catalog integrity: OK (${catalog.exercises.length} exercises)`);
}
