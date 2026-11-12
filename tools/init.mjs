// One-off setup: creates the key pair and the password-locked data files.
// Usage: node tools/init.mjs <seed-dir>   (seed-dir holds jobs.json and profile.md)
// Prints the generated password ONCE. Nothing secret is written to the repo.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { generateKeyPair, importPublic, lockPrivateKey, seal, jobFingerprint } from "../js/crypto.js";

const seedDir = process.argv[2];
if (!seedDir) { console.error("usage: node tools/init.mjs <seed-dir>"); process.exit(1); }

const jobs = JSON.parse(await readFile(`${seedDir}/jobs.json`, "utf8"));
const profile = await readFile(`${seedDir}/profile.md`, "utf8");

const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const rnd = crypto.getRandomValues(new Uint8Array(16));
const password = Array.from(rnd, (b) => alphabet[b % alphabet.length]).join("").replace(/(.{4})(?!$)/g, "$1-");

const { publicJwk, privateJwk } = await generateKeyPair();
const pub = await importPublic(publicJwk);

await mkdir("data", { recursive: true });
await writeFile("data/public-key.json", JSON.stringify(publicJwk, null, 2) + "\n");
await writeFile("data/private-key.locked.json", JSON.stringify(await lockPrivateKey(privateJwk, password), null, 2) + "\n");
await writeFile("data/jobs.locked.json", JSON.stringify(await seal(pub, { jobs, updatedAt: new Date().toISOString() })) + "\n");
await writeFile("data/profile.locked.json", JSON.stringify(await seal(pub, { markdown: profile })) + "\n");
await writeFile("data/inbox.json", "[]\n");
const seen = [];
for (const j of jobs) seen.push(await jobFingerprint(j.org, j.role));
await writeFile("data/seen.json", JSON.stringify(seen, null, 2) + "\n");

console.log("PASSWORD:", password);
