# Job Application Assistant

A personal job-search dashboard with a built-in Claude chat, hosted on GitHub Pages.

## How privacy works

This repository is public so it can be hosted free on GitHub Pages, but the job list and profile are **encrypted**. Everything in `data/*.locked.json` is unreadable without the password.

- `data/public-key.json` lets the daily job search *add* jobs without knowing the password. It cannot be used to read anything.
- `data/private-key.locked.json` is the reading key, locked with the password (PBKDF2, 310,000 rounds, AES-256-GCM).
- `data/jobs.locked.json` and `data/profile.locked.json` are sealed with RSA-OAEP 3072 + AES-256-GCM.
- `data/inbox.json` holds new jobs from the daily search, each sealed the same way. The website merges them in when you unlock it.
- `data/seen.json` holds one-way fingerprints so the same job isn't added twice.

The GitHub key (for saving changes) and the Anthropic key (for the chat) are stored only in your browser, never in this repository.

## Files

- `index.html`, `css/style.css`, `js/app.js`: the website (Times New Roman throughout).
- `js/crypto.js`: encryption, shared by the website and the scripts.
- `tools/add-jobs.mjs`: used by the daily search to add jobs to the inbox.
- `tools/init.mjs`: one-off setup (already run).

Nothing is ever sent to an employer from this site.
