// Used by the daily job search. Adds jobs (and their CV / cover letter PDFs)
// WITHOUT needing the password: everything is sealed with the public key.
// New items go into data/inbox.json; the website merges them on next unlock.
//
// Usage: node tools/add-jobs.mjs items.json
//
// items.json is an array. Each item is either:
//   a NEW job:   { role, org, status, fit, deadline, location, salary, category, belowFloor,
//                  why, nextStep, howToApply, link, added,
//                  cvPdfFile?, letterPdfFile? }      <- local paths to PDFs (optional)
//   an UPDATE:   { update: "<existing job id>", changes: { ...fields },
//                  cvPdfFile?, letterPdfFile? }
// New jobs already seen (same organisation + role) are skipped.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { importPublic, seal, jobFingerprint, b64 } from "../js/crypto.js";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/add-jobs.mjs items.json"); process.exit(1); }

const incoming = JSON.parse(await readFile(file, "utf8"));
const pub = await importPublic(JSON.parse(await readFile("data/public-key.json", "utf8")));
const inbox = JSON.parse(await readFile("data/inbox.json", "utf8"));
const seen = JSON.parse(await readFile("data/seen.json", "utf8"));
await mkdir("data/docs", { recursive: true });

async function sealPdf(path, label) {
  const bytes = await readFile(path);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
  const out = `data/docs/${id}.locked.json`;
  await writeFile(out, JSON.stringify(await seal(pub, { name: label, mime: "application/pdf", data: b64.from(bytes) })) + "\n");
  return out;
}
async function attachPdfs(item, target, org) {
  const base = String(org || "document").replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40);
  if (item.cvPdfFile) target.cvPdf = await sealPdf(item.cvPdfFile, `CV_Orlaith_Doyle_${base}.pdf`);
  if (item.letterPdfFile) target.letterPdf = await sealPdf(item.letterPdfFile, `Cover_Letter_Orlaith_Doyle_${base}.pdf`);
  delete target.cvPdfFile; delete target.letterPdfFile;
}

let added = 0, updated = 0, skipped = 0;
for (const item of incoming) {
  if (item.update) {
    const changes = { ...(item.changes || {}) };
    await attachPdfs(item, changes, item.org || item.update);
    inbox.push({ added: new Date().toISOString().slice(0, 10), blob: await seal(pub, { __update: item.update, changes }) });
    updated++;
    continue;
  }
  if (!item.role || !item.org) { console.warn("skipping job without role/org"); skipped++; continue; }
  const fp = await jobFingerprint(item.org, item.role);
  if (seen.includes(fp)) { skipped++; continue; }
  const job = { ...item };
  await attachPdfs(item, job, item.org);
  job.id = job.id || (job.org + "-" + job.role).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  job.added = job.added || new Date().toISOString().slice(0, 10);
  job.status = job.status || "To review";
  inbox.push({ added: job.added, blob: await seal(pub, job) });
  seen.push(fp);
  added++;
}
await writeFile("data/inbox.json", JSON.stringify(inbox, null, 2) + "\n");
await writeFile("data/seen.json", JSON.stringify(seen, null, 2) + "\n");
console.log(`added ${added}, updated ${updated}, skipped ${skipped} (already listed or invalid)`);
