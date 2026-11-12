// Used by the daily job search. Adds new jobs WITHOUT needing the password:
// each job is sealed with the public key and appended to data/inbox.json.
// The website merges the inbox into the main list next time it's unlocked.
//
// Usage: node tools/add-jobs.mjs new-jobs.json
//   new-jobs.json = [{ role, org, status, fit, deadline, location, salary, category,
//                      belowFloor, why, nextStep, howToApply, link, cvUrl, letterUrl, added }]
// Jobs already seen (same organisation + role) are skipped.
import { readFile, writeFile } from "node:fs/promises";
import { importPublic, seal, jobFingerprint } from "../js/crypto.js";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/add-jobs.mjs new-jobs.json"); process.exit(1); }

const incoming = JSON.parse(await readFile(file, "utf8"));
const pub = await importPublic(JSON.parse(await readFile("data/public-key.json", "utf8")));
const inbox = JSON.parse(await readFile("data/inbox.json", "utf8"));
const seen = JSON.parse(await readFile("data/seen.json", "utf8"));

let added = 0, skipped = 0;
for (const job of incoming) {
  if (!job.role || !job.org) { console.warn("skipping job without role/org"); skipped++; continue; }
  const fp = await jobFingerprint(job.org, job.role);
  if (seen.includes(fp)) { skipped++; continue; }
  job.id = job.id || (job.org + "-" + job.role).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  job.added = job.added || new Date().toISOString().slice(0, 10);
  job.status = job.status || "To review";
  inbox.push({ added: job.added, blob: await seal(pub, job) });
  seen.push(fp);
  added++;
}
await writeFile("data/inbox.json", JSON.stringify(inbox, null, 2) + "\n");
await writeFile("data/seen.json", JSON.stringify(seen, null, 2) + "\n");
console.log(`added ${added}, skipped ${skipped} (already listed or invalid)`);
