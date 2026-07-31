#!/usr/bin/env node
// login.mjs — One-time LinkedIn login for the runner.
// Opens a real browser window. Log in manually (password, 2FA, captcha — whatever LinkedIn asks).
// Session is saved automatically to .linkedin-browser-profile/ and reused by linkedin-runner.mjs.
// Run again whenever the session expires (typically weeks to months).

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dir, '.linkedin-browser-profile');

console.log('\nLinkedIn Login\n' + '─'.repeat(40));
console.log('A browser window will open.');
console.log('Log in normally — type your password, complete 2FA if asked.');
console.log('This script will close automatically once you\'re logged in.\n');

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
  ],
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
});

const page = await ctx.newPage();
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

// Check if already logged in by hitting a page that requires auth
await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 2000));

const initial = page.url();
if (!initial.includes('/login') && !initial.includes('/authwall') && !initial.includes('/checkpoint')) {
  console.log('Already logged in — session is still valid.');
  console.log('No action needed. Run `pm2 restart linkedin-runner` if you just replaced the profile.');
  await ctx.close();
  process.exit(0);
}

// Not logged in — go to login page and wait for the user
await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
console.log('Waiting for you to log in... (timeout: 5 minutes)\n');

const TIMEOUT_MS = 5 * 60 * 1000;
const start = Date.now();
let success = false;

while (Date.now() - start < TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 1500));
  const u = page.url();
  const loggedIn =
    !u.includes('/login') &&
    !u.includes('/authwall') &&
    !u.includes('/signup') &&
    (
      u.includes('/feed') ||
      u.includes('/mynetwork') ||
      u.includes('/jobs') ||
      u.includes('/notifications') ||
      u.includes('/in/')
    );
  if (loggedIn) { success = true; break; }
}

if (success) {
  console.log('Logged in! Saving session...');
  await new Promise(r => setTimeout(r, 2000)); // let cookies settle
  await ctx.close();
  console.log('\nDone. Session saved to .linkedin-browser-profile/');
  console.log('Run:  pm2 restart linkedin-runner\n');
  process.exit(0);
} else {
  console.log('\nTimeout — login not detected within 5 minutes. Try again.');
  await ctx.close();
  process.exit(1);
}
