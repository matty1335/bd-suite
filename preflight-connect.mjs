import { chromium } from './node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
import { homedir } from 'os';
// Read-only preflight: never clicks Connect or Send; only opens/closes the profile's More menu.
async function markTopCard(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-bd-topcard]').forEach(e => e.removeAttribute('data-bd-topcard'));
    const main = document.querySelector('main');
    if (!main) return null;
    const isDeg = (el) => /·\s*(1st|2nd|3rd)\b/.test(el?.innerText || '');
    let h = main.querySelector('h1');
    if (!h || !h.innerText.trim()) {
      h = [...main.querySelectorAll('h2')].find(x => x.innerText.trim() && isDeg(x.closest('section') || x.parentElement)) || null;
    }
    if (!h) return null;
    // The profile's own More button: some accounts label it aria-label="More", others
    // render it with only the text "More" next to a hidden aria-labelled duplicate.
    // Accept either, but only if it is actually visible.
    const isVisible = (b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    // Prefer the visible aria-labelled More; fall back to a visible text-only "More"
    // only when no labelled one is visible (other "More" texts, e.g. "...see more",
    // exist on some cards).
    const moreButtons = (n) => {
      const all = [...n.querySelectorAll('button')].filter(isVisible);
      const labelled = all.filter(b => b.getAttribute('aria-label') === 'More');
      return labelled.length ? labelled : all.filter(b => !b.getAttribute('aria-label') && (b.innerText || '').trim() === 'More');
    };
    let n = h.parentElement;
    while (n && n !== main && moreButtons(n).length === 0) n = n.parentElement;
    if (!n || n === main) n = h.closest('section') || h.parentElement;
    n.setAttribute('data-bd-topcard', '1');
    document.querySelectorAll('[data-bd-more]').forEach(e => e.removeAttribute('data-bd-more'));
    const mb = moreButtons(n)[0];
    if (mb) mb.setAttribute('data-bd-more', '1');
    const t = n.innerText || '';
    return { name: h.innerText.trim(), degree: (t.match(/·\s*(1st|2nd|3rd)/) || [])[1] || '' };
  }).catch(() => null);
}

const ctx = await chromium.launchPersistentContext(homedir() + '/.bd-suite/.linkedin-browser-profile', { headless: true, viewport:{width:1440,height:900}, userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', args:['--disable-blink-features=AutomationControlled'] });
const page = ctx.pages()[0] ?? await ctx.newPage();
for (const slug of process.argv.slice(2)) {
  try {
    await page.goto(`https://www.linkedin.com/in/${slug}/`, { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForTimeout(3500 + Math.random()*2000);
    const card = await markTopCard(page);
    if (!card) { console.log(slug, '| NO CARD'); continue; }
    const esc = (x) => x.replace(/"/g, '\\"');
    const nv = [...new Set([card.name, card.name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()])];
    const direct = await page.locator(nv.map(n=>`[data-bd-topcard] [aria-label="Invite ${esc(n)} to connect"]:not([role="menuitem"] *)`).join(', ')).count();
    let inMore=0, pendMore=0, moreVis=0;
    const mb = page.locator('[data-bd-more]').first();
    moreVis = await mb.count();
    if (!direct && moreVis) { await mb.click(); await page.waitForTimeout(800);
      inMore = await page.locator(nv.map(n=>`[role="menuitem"]:has([aria-label="Invite ${esc(n)} to connect"])`).join(', ') + ', [role="menuitem"]:text-is("Connect")').count();
      pendMore = await page.locator(nv.map(n=>`[role="menuitem"]:has([aria-label="Pending, click to withdraw invitation sent to ${esc(n)}"])`).join(', ') + ', [role="menuitem"]:text-is("Pending")').count();
      await page.keyboard.press('Escape'); }
    const v = card.degree==='1st' ? 'connected' : pendMore ? 'pending (More)' : direct ? 'Connect direct' : inMore ? 'Connect via More' : 'NOT FOUND';
    console.log(slug, '|', card.name, '|', card.degree, '| moreVisible', moreVis, '|', v);
  } catch (e) { console.log(slug, 'ERROR', e.message.slice(0,90)); }
}
await ctx.close();
