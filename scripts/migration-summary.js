#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Migration Summary Generator — Issue #11
//
// Analyzes migration files changed in a PR and posts a structured summary
// comment on the PR detailing what tables, columns, and indexes are affected.
//
// Used by: .github/workflows/migration-test.yml (migration-summary job)
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────────
const REPO = process.env.GITHUB_REPOSITORY || 'stellar-network-builders/wavelum-backend';
const PR_NUMBER = process.env.PR_NUMBER;
const BASE_SHA = process.env.BASE_SHA;
const HEAD_SHA = process.env.HEAD_SHA;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const MIGRATION_DIRS = [
  'backend/migrations',
  'db/migrations',
  'legacy_cleanup/database/migrations',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractTableNames(sql) {
  const tables = new Set();
  const createRegex = /CREATE\s+(?:TABLE|TABLE\s+IF\s+NOT\s+EXISTS)\s+(\w+)/gi;
  const alterRegex = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
  const dropRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
  const indexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/gi;

  let match;
  while ((match = createRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  while ((match = alterRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  while ((match = dropRegex.exec(sql)) !== null) {
    tables.add(match[1].toLowerCase());
  }
  while ((match = indexRegex.exec(sql)) !== null) {
    tables.add(match[2].toLowerCase());
  }

  return [...tables];
}

function extractAddedColumns(sql) {
  const cols = new Set();
  const regex = /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+\w+/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    cols.add(match[1].toLowerCase());
  }
  return [...cols];
}

function extractAddedIndexes(sql) {
  const indexes = new Set();
  const regex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    indexes.add(match[1]);
  }
  return [...indexes];
}

function analyzeFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const basename = path.basename(filePath);
  const tables = extractTableNames(content);
  const addedColumns = extractAddedColumns(content);
  const addedIndexes = extractAddedIndexes(content);

  return {
    file: basename,
    path: filePath,
    tables,
    addedColumns,
    addedIndexes,
  };
}

function getChangedMigrationFiles() {
  if (!BASE_SHA || !HEAD_SHA) {
    // Fallback: find all migration files
    const files = [];
    for (const dir of MIGRATION_DIRS) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.sql') || f.endsWith('.js')) {
          files.push(path.join(dir, f));
        }
      }
    }
    return files;
  }

  const diffOutput = exec(`git diff --name-only ${BASE_SHA}..${HEAD_SHA}`);
  if (!diffOutput) return [];

  return diffOutput.split('\n').filter((f) => {
    return MIGRATION_DIRS.some((dir) => f.startsWith(dir)) &&
      (f.endsWith('.sql') || f.endsWith('.js'));
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!PR_NUMBER) {
    console.log('No PR number provided — skipping comment.');
    return;
  }

  const changedFiles = getChangedMigrationFiles();

  if (changedFiles.length === 0) {
    console.log('No migration files changed in this PR.');
    return;
  }

  console.log(`Analyzing ${changedFiles.length} migration file(s)...`);

  const analyses = changedFiles.map(analyzeFile).filter(Boolean);

  // Build summary table
  let summary = `## 📊 Migration Summary\n\n`;
  summary += `**${analyses.length} migration file(s) changed** in this PR.\n\n`;
  summary += `| File | Tables | New Columns | New Indexes |\n`;
  summary += `|------|--------|-------------|-------------|\n`;

  const allTables = new Set();
  const allColumns = new Set();
  const allIndexes = new Set();

  for (const a of analyses) {
    const tablesStr = a.tables.length > 0 ? a.tables.join(', ') : '—';
    const colsStr = a.addedColumns.length > 0 ? a.addedColumns.join(', ') : '—';
    const idxStr = a.addedIndexes.length > 0 ? a.addedIndexes.join(', ') : '—';
    summary += `| \`${a.file}\` | ${tablesStr} | ${colsStr} | ${idxStr} |\n`;

    a.tables.forEach((t) => allTables.add(t));
    a.addedColumns.forEach((c) => allColumns.add(c));
    a.addedIndexes.forEach((i) => allIndexes.add(i));
  }

  // Aggregate summary
  if (allTables.size > 0) {
    summary += `\n### 📋 Affected Tables\n\n`;
    for (const t of [...allTables].sort()) {
      summary += `- \`${t}\`\n`;
    }
  }

  if (allColumns.size > 0) {
    summary += `\n### ➕ New Columns Added\n\n`;
    for (const c of [...allColumns].sort()) {
      summary += `- \`${c}\`\n`;
    }
  }

  if (allIndexes.size > 0) {
    summary += `\n### 🔍 New Indexes Created\n\n`;
    for (const i of [...allIndexes].sort()) {
      summary += `- \`${i}\`\n`;
    }
  }

  summary += `\n---\n`;
  summary += `> This summary was automatically generated by the [migration-test workflow](https://github.com/${REPO}/actions/workflows/migration-test.yml).\n`;

  // Post to PR via GitHub CLI
  if (!GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN — skipping PR comment.');
    console.log(summary);
    return;
  }

  try {
    // Write body to temp file to avoid shell escaping issues
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-summary-'));
    const bodyFile = path.join(tmpDir, 'body.md');
    fs.writeFileSync(bodyFile, summary);

    const ghOutput = execSync(
      `gh pr comment ${PR_NUMBER} --repo ${REPO} --body-file ${bodyFile}`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );
    console.log('Migration summary posted to PR:', ghOutput.trim());

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  } catch (err) {
    console.log('Failed to post PR comment (gh CLI may not be available):', err.message);
    console.log(summary);
  }
}

// Export for potential reuse
module.exports = { extractTableNames, extractAddedColumns, extractAddedIndexes, analyzeFile };

// Run if called directly
if (require.main === module) {
  main();
}
