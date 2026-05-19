#!/usr/bin/env node
/**
 * jira-export.mjs — Sync between Jira issues and tasks.yaml format.
 *
 * Two directions:
 *   export (default)  Jira → tasks.yaml
 *   sync              tasks.yaml → Jira (create/update issues)
 *
 * Usage:
 *   node scripts/jira-export.mjs export [options]
 *   node scripts/jira-export.mjs sync   [options]
 *
 * Options:
 *   --config <path>   Path to jira-config.yaml (default: jira-config.yaml)
 *   --output <path>   Output file for export direction (default: tasks.yaml)
 *   --input <path>    Input file for sync direction (default: tasks.yaml)
 *   --jql <query>     Override JQL filter from config
 *   --dry-run         Preview without making any changes
 *   --env <path>      Path to .env file
 *
 * Environment:
 *   JIRA_BASE_URL     Required. e.g. https://myorg.atlassian.net
 *   JIRA_EMAIL        Cloud auth: Atlassian account email
 *   JIRA_API_TOKEN    Cloud auth: API token from id.atlassian.com
 *   JIRA_PAT          Server/DC auth: Personal Access Token
 *
 * Authentication:
 *   Cloud:  Set JIRA_EMAIL + JIRA_API_TOKEN  →  HTTP Basic auth
 *   Server: Set JIRA_PAT                     →  Bearer token auth
 *
 * Examples:
 *   # Export active sprint issues to tasks.yaml (Cloud)
 *   JIRA_BASE_URL=https://myorg.atlassian.net \
 *   JIRA_EMAIL=me@example.com \
 *   JIRA_API_TOKEN=mytoken \
 *   node scripts/jira-export.mjs export \
 *     --jql "project = PROJ AND sprint in openSprints()"
 *
 *   # Export from Jira Server using a PAT
 *   JIRA_BASE_URL=https://jira.mycompany.com \
 *   JIRA_PAT=my-personal-access-token \
 *   node scripts/jira-export.mjs export --config jira-config.yaml
 *
 *   # Sync local tasks.yaml back to Jira (dry run first)
 *   node scripts/jira-export.mjs sync --input tasks.yaml --dry-run
 *
 *   # Load credentials from project .env file
 *   node scripts/jira-export.mjs export --env packages/backend/.env
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

const envPath = option("--env");
const configPath = option("--config") ?? "jira-config.yaml";
const outputPath = option("--output") ?? "tasks.yaml";
const inputPath = option("--input") ?? "tasks.yaml";
const jqlOverride = option("--jql");
const dryRun = flag("--dry-run");

// First positional arg is the direction
const direction = args[0] ?? "export";

if (direction !== "export" && direction !== "sync") {
  console.error(
    `Error: unknown direction "${direction}". Use "export" or "sync".`,
  );
  process.exit(1);
}

// ── Load .env ─────────────────────────────────────────────────────────────────

if (envPath) {
  try {
    const abs = resolve(process.cwd(), envPath);
    const lines = readFileSync(abs, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (e) {
    console.error(`Warning: could not load env from ${envPath}: ${e.message}`);
  }
}

// ── Validate credentials ──────────────────────────────────────────────────────

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL ?? "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? "";
const JIRA_PAT = process.env.JIRA_PAT ?? "";

if (!JIRA_BASE_URL) {
  console.error(
    "Error: JIRA_BASE_URL is required (e.g. https://myorg.atlassian.net)",
  );
  process.exit(1);
}

const isCloud = !!(JIRA_EMAIL && JIRA_API_TOKEN);
const isServer = !!JIRA_PAT;

if (!isCloud && !isServer) {
  console.error(
    "Error: set either JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server/DC)",
  );
  process.exit(1);
}

// Use API v3 for Cloud, v2 for Server (ADF vs plain text descriptions)
const API_VERSION = isCloud ? "3" : "2";
const API_BASE = `${JIRA_BASE_URL}/rest/api/${API_VERSION}`;

function authHeader() {
  if (isCloud) {
    const encoded = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString(
      "base64",
    );
    return `Basic ${encoded}`;
  }
  return `Bearer ${JIRA_PAT}`;
}

// ── Minimal YAML parser ───────────────────────────────────────────────────────
//
// Handles the specific subset used by jira-config.yaml and tasks.yaml:
//   - Top-level key: value pairs (quoted or unquoted)
//   - Nested maps (indented key: value pairs)
//   - Lists of objects (- key: value, followed by indented properties)
//   - Comments (#) and blank lines are ignored
//

function unquote(str) {
  if (str === undefined || str === null) return "";
  str = String(str).trim();
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    return str.slice(1, -1);
  }
  return str;
}

function getIndent(line) {
  return line.match(/^(\s*)/)[1].length;
}

function parseYaml(text) {
  const lines = text.split("\n");
  let i = 0;

  function peek() {
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t && !t.startsWith("#")) return lines[i];
      i++;
    }
    return null;
  }

  function parseMap(minIndent) {
    const obj = {};
    while (i < lines.length) {
      const line = peek();
      if (!line) break;
      const indent = getIndent(line);
      if (indent < minIndent) break;

      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) {
        i++;
        continue;
      }

      const key = unquote(trimmed.slice(0, colonIdx).trim());
      const rest = trimmed.slice(colonIdx + 1).trim();

      i++; // consume this line

      if (rest) {
        obj[key] = unquote(rest);
      } else {
        // Look ahead: list or nested map?
        const nextLine = peek();
        if (!nextLine) {
          obj[key] = null;
        } else {
          const nextIndent = getIndent(nextLine);
          if (nextIndent > indent) {
            if (nextLine.trim().startsWith("- ")) {
              obj[key] = parseList(nextIndent);
            } else {
              obj[key] = parseMap(nextIndent);
            }
          } else {
            obj[key] = null;
          }
        }
      }
    }
    return obj;
  }

  function parseList(minIndent) {
    const items = [];
    while (i < lines.length) {
      const line = peek();
      if (!line) break;
      const indent = getIndent(line);
      if (indent < minIndent) break;

      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) break;

      i++; // consume the list-item line

      const rest = trimmed.slice(2).trim();
      const colonIdx = rest.indexOf(":");

      if (colonIdx === -1) {
        items.push(unquote(rest));
        continue;
      }

      // Object item: first key on same line, rest on indented lines
      const firstKey = unquote(rest.slice(0, colonIdx).trim());
      const firstVal = unquote(rest.slice(colonIdx + 1).trim());
      const item = { [firstKey]: firstVal };

      // Collect additional properties at greater indent
      const propsIndent = indent + 2;
      while (i < lines.length) {
        const propLine = peek();
        if (!propLine) break;
        if (getIndent(propLine) < propsIndent) break;
        if (propLine.trim().startsWith("- ")) break;

        const propTrimmed = propLine.trim();
        i++;
        const pColon = propTrimmed.indexOf(":");
        if (pColon !== -1) {
          const pk = unquote(propTrimmed.slice(0, pColon).trim());
          const pv = unquote(propTrimmed.slice(pColon + 1).trim());
          item[pk] = pv;
        }
      }
      items.push(item);
    }
    return items;
  }

  return parseMap(0);
}

// ── YAML serializer ───────────────────────────────────────────────────────────

function yamlQuote(str) {
  if (str === null || str === undefined) return '""';
  const s = String(str);
  // Always quote to keep output safe and consistent
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function serializeYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  let out = "";

  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      out += `${pad}${key}:\n`;
      for (const item of val) {
        if (typeof item === "object" && item !== null) {
          const entries = Object.entries(item);
          if (entries.length === 0) {
            out += `${pad}  - {}\n`;
            continue;
          }
          const [fk, fv] = entries[0];
          out += `${pad}  - ${fk}: ${yamlQuote(fv)}\n`;
          for (const [k, v] of entries.slice(1)) {
            out += `${pad}    ${k}: ${yamlQuote(v)}\n`;
          }
        } else {
          out += `${pad}  - ${yamlQuote(item)}\n`;
        }
      }
    } else if (typeof val === "object" && val !== null) {
      out += `${pad}${key}:\n`;
      out += serializeYaml(val, indent + 2);
    } else {
      out += `${pad}${key}: ${yamlQuote(val)}\n`;
    }
  }

  return out;
}

// ── Load jira-config.yaml ─────────────────────────────────────────────────────

let config = {
  project_key: "",
  issue_type: "Task",
  jql_filter: "",
  status_map: {},
  priority_map: {},
  reverse_status_map: {},
  reverse_priority_map: {},
};

const absConfigPath = resolve(process.cwd(), configPath);
if (existsSync(absConfigPath)) {
  try {
    const raw = readFileSync(absConfigPath, "utf8");
    const parsed = parseYaml(raw);
    config = { ...config, ...parsed };
  } catch (e) {
    console.error(`Warning: could not parse ${configPath}: ${e.message}`);
  }
} else if (configPath !== "jira-config.yaml") {
  console.error(`Error: config file not found: ${configPath}`);
  process.exit(1);
}

// ── Jira API client ───────────────────────────────────────────────────────────

async function jiraFetch(method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const url = `${API_BASE}${path}`;
  const res = await fetch(url, opts);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jira API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
    );
  }

  if (res.status === 204) return null;
  return res.json();
}

// ── ADF helpers (Cloud API v3) ────────────────────────────────────────────────

/**
 * Convert Atlassian Document Format (ADF) to plain text.
 * Only handles common node types — enough for round-tripping descriptions.
 */
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;

  if (Array.isArray(node)) {
    return node.map(adfToText).join("");
  }

  const children = node.content ? adfToText(node.content) : "";

  switch (node.type) {
    case "doc":
      return children;
    case "paragraph":
      return children + "\n";
    case "heading":
      return children + "\n";
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "bulletList":
    case "orderedList":
      return children;
    case "listItem":
      return `- ${children.trim()}\n`;
    case "codeBlock":
      return children;
    case "blockquote":
      return children;
    case "rule":
      return "---\n";
    default:
      return children;
  }
}

/**
 * Build a minimal ADF document from plain text (Cloud only).
 * Paragraphs are split on double newlines; single newlines within become hardBreaks.
 */
function textToAdf(text) {
  const paragraphs = (text ?? "").split(/\n{2,}/).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length
      ? paragraphs.map((para) => ({
          type: "paragraph",
          content: para.split("\n").flatMap((line, idx, arr) => {
            const nodes = [{ type: "text", text: line }];
            if (idx < arr.length - 1) nodes.push({ type: "hardBreak" });
            return nodes;
          }),
        }))
      : [{ type: "paragraph", content: [] }],
  };
}

// ── Extract description from a Jira issue ────────────────────────────────────

function extractDescription(issue) {
  const desc = issue.fields?.description;
  if (!desc) return "";

  if (isCloud && typeof desc === "object") {
    // ADF format (Cloud v3)
    return adfToText(desc).trim();
  }

  // Plain text (Server v2)
  return typeof desc === "string" ? desc.trim() : "";
}

// ── Map Jira issue → task object ──────────────────────────────────────────────

function issueToTask(issue) {
  const key = issue.key ?? "";
  const summary = issue.fields?.summary ?? "";
  const rawStatus = issue.fields?.status?.name ?? "";
  const rawPriority = issue.fields?.priority?.name ?? "";
  const issueType = issue.fields?.issuetype?.name ?? "";
  const description = extractDescription(issue);

  const statusMap = config.reverse_status_map;
  const priorityMap = config.reverse_priority_map;

  const status = statusMap[rawStatus] || rawStatus;
  const priority = priorityMap[rawPriority] || rawPriority;

  return {
    name: summary,
    jira_key: key,
    jira_id: issue.id ?? "",
    status,
    priority,
    type: issueType,
    context: description,
    acceptance_criteria: "",
  };
}

// ── Export: Jira → tasks.yaml ─────────────────────────────────────────────────

async function runExport() {
  const jql = jqlOverride || config.jql_filter;

  if (!jql) {
    console.error(
      'Error: no JQL filter. Set jql_filter in jira-config.yaml or pass --jql "<query>"',
    );
    process.exit(1);
  }

  console.log(`Exporting Jira issues → ${outputPath}`);
  console.log(`JQL: ${jql}`);
  if (dryRun) console.log("[DRY RUN — no file will be written]\n");

  const tasks = [];
  let startAt = 0;
  const maxResults = 50;
  let total = Infinity;

  while (startAt < total) {
    const encodedJql = encodeURIComponent(jql);
    const fields = "summary,description,status,priority,issuetype";
    const data = await jiraFetch(
      "GET",
      `/search?jql=${encodedJql}&fields=${fields}&maxResults=${maxResults}&startAt=${startAt}`,
    );

    total = data.total ?? 0;
    const issues = data.issues ?? [];

    if (issues.length === 0) break;

    for (const issue of issues) {
      tasks.push(issueToTask(issue));
    }

    startAt += issues.length;
    process.stdout.write(`  fetched ${startAt}/${total}\r`);
  }

  process.stdout.write("\n");
  console.log(`Found ${tasks.length} issue(s)`);

  if (tasks.length === 0) {
    console.log("No issues matched the JQL filter — nothing to write.");
    return;
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const header =
    `# tasks.yaml — exported from Jira on ${timestamp}\n` +
    `# Source: ${JIRA_BASE_URL}\n` +
    `# JQL:    ${jql}\n\n`;

  const yaml = header + serializeYaml({ tasks });

  if (dryRun) {
    console.log("\n--- tasks.yaml preview ---");
    console.log(yaml.slice(0, 2000));
    if (yaml.length > 2000) console.log("... (truncated)");
    return;
  }

  writeFileSync(resolve(process.cwd(), outputPath), yaml, "utf8");
  console.log(`Written to ${outputPath}`);
}

// ── Sync: tasks.yaml → Jira ───────────────────────────────────────────────────

async function runSync() {
  const absInput = resolve(process.cwd(), inputPath);
  if (!existsSync(absInput)) {
    console.error(`Error: input file not found: ${inputPath}`);
    process.exit(1);
  }

  let tasks;
  try {
    const raw = readFileSync(absInput, "utf8");
    const parsed = parseYaml(raw);
    tasks = parsed.tasks;
  } catch (e) {
    console.error(`Error: could not parse ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log("No tasks found in input file.");
    return;
  }

  const projectKey = config.project_key;
  if (!projectKey) {
    console.error("Error: project_key is required in jira-config.yaml");
    process.exit(1);
  }

  console.log(`Syncing ${tasks.length} task(s) → Jira project ${projectKey}`);
  if (dryRun) console.log("[DRY RUN — no changes will be made]\n");

  const statusMap = config.status_map;
  const priorityMap = config.priority_map;

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const task of tasks) {
    const name = task.name ?? "";
    const jiraKey = task.jira_key ?? "";
    const rawStatus = task.status ?? "";
    const rawPriority = task.priority ?? "";
    const context = task.context ?? "";
    const ac = task.acceptance_criteria ?? "";

    const jiraStatus = statusMap[rawStatus] || rawStatus;
    const jiraPriority = priorityMap[rawPriority] || rawPriority;
    const issueType = task.type || config.issue_type || "Task";

    // Build description text
    let descText = context;
    if (ac)
      descText +=
        (descText ? "\n\nAcceptance Criteria:\n" : "Acceptance Criteria:\n") +
        ac;

    // Build description field (ADF for Cloud, plain text for Server)
    const descriptionField = isCloud ? textToAdf(descText) : descText;

    const fields = {
      summary: name,
      description: descriptionField,
      issuetype: { name: issueType },
      project: { key: projectKey },
    };

    if (jiraPriority) fields.priority = { name: jiraPriority };

    try {
      if (jiraKey) {
        // Update existing issue
        if (dryRun) {
          console.log(`[update] ${jiraKey}: ${name}`);
        } else {
          await jiraFetch("PUT", `/issue/${jiraKey}`, { fields });
          console.log(`✅ Updated ${jiraKey}: ${name}`);

          // Transition status if changed
          if (jiraStatus) {
            await transitionIssue(jiraKey, jiraStatus);
          }
        }
        updated++;
      } else {
        // Create new issue
        if (dryRun) {
          console.log(
            `[create] ${name} (${issueType}, ${jiraPriority || "no priority"})`,
          );
        } else {
          const created_issue = await jiraFetch("POST", "/issue", { fields });
          console.log(`✅ Created ${created_issue.key}: ${name}`);

          if (jiraStatus) {
            await transitionIssue(created_issue.key, jiraStatus);
          }
        }
        created++;
      }
    } catch (e) {
      console.error(`❌ Failed "${name}": ${e.message}`);
      failed++;
    }
  }

  console.log(
    `\nDone: ${created} created, ${updated} updated, ${failed} failed`,
  );
  if (failed > 0) process.exit(1);
}

/**
 * Transition a Jira issue to a named status by finding the matching transition ID.
 * Silently skips if no matching transition is found (issue may already be in that status).
 */
async function transitionIssue(issueKey, targetStatus) {
  try {
    const data = await jiraFetch("GET", `/issue/${issueKey}/transitions`);
    const transitions = data.transitions ?? [];
    const match = transitions.find(
      (t) => t.name?.toLowerCase() === targetStatus.toLowerCase(),
    );
    if (!match) return; // No matching transition — issue may already be in that status
    await jiraFetch("POST", `/issue/${issueKey}/transitions`, {
      transition: { id: match.id },
    });
  } catch (e) {
    console.warn(
      `  ⚠ Could not transition ${issueKey} to "${targetStatus}": ${e.message}`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const authType = isCloud ? "Cloud (Basic auth)" : "Server/DC (Bearer token)";
  console.log(`Jira: ${JIRA_BASE_URL} [${authType}, API v${API_VERSION}]`);

  if (direction === "export") {
    await runExport();
  } else {
    await runSync();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
