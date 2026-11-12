// End-to-end check: serves the production build with `next start`, drives the map in headless
// Chromium and saves screenshots to docs/. Run `npm run build` first (npm run check does both).
// Harness from mov/scripts/check.mjs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'docs');
mkdirSync(shots, { recursive: true });
const PORT = 4317;
const base = `http://localhost:${PORT}/`;

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

const mapFile = join(root, 'public', 'data', 'map.json');
check(existsSync(mapFile), 'public/data/map.json exists (npm run data)');
if (existsSync(mapFile)) {
  const days = (Date.now() - statSync(mapFile).mtimeMs) / 864e5;
  if (days > 150) console.warn(`WARN  TMDB data is ${Math.round(days)} days old; rebuild before 6 months (npm run data)`);
}

const server = spawn('npx', ['next', 'start', '--port', String(PORT)], { cwd: root, stdio: 'ignore' });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await new Promise(r => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(base);
  await page.waitForFunction(() => window.__rg?.ready, null, { timeout: 20000 });
  const count = await page.evaluate(() => window.__rg.count);
  check(count > 2000, `map has ${count} films`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, 'map.png') });

  // Search a keyword and highlight it.
  await page.keyboard.press('/');
  await page.keyboard.type('obsession');
  await page.waitForSelector('#results.show .res-row[data-n]');
  const kw = page.locator('.res-row[data-n]', { has: page.locator('.tag-keyword') }).first();
  await kw.click();
  const lit = await page.evaluate(() => window.__rg.highlighted);
  check(lit > 5 && lit < count, `keyword chip highlights ${lit} films`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, 'highlight.png') });
  // AND with a genre shrinks it.
  await page.keyboard.press('/');
  await page.keyboard.type('Thriller');
  await page.waitForSelector('.res-row[data-n] .tag-genre');
  await page.locator('.res-row[data-n]', { has: page.locator('.tag-genre') }).first().click();
  const orCount = await page.evaluate(() => window.__rg.highlighted);
  await page.click('#mode-and');
  const andCount = await page.evaluate(() => window.__rg.highlighted);
  check(andCount < orCount && andCount < lit, `AND (${andCount}) is narrower than OR (${orCount})`);
  for (let n = await page.locator('.hl-chip .x').count(); n > 0; n--) await page.locator('.hl-chip .x').first().click();

  // Click Vertigo on the map.
  const vertigoId = 426;
  await page.goto(`${base}?film=${vertigoId}`);
  await page.waitForFunction(() => window.__rg?.ready && document.querySelectorAll('#p-list .sim').length === 8, null, { timeout: 20000 });
  await page.click('#d-close');
  await page.waitForTimeout(500);
  const pt = await page.evaluate(id => window.__rg.screenOf(id), vertigoId);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(600);
  check((await page.evaluate(() => window.__rg.selected)) === vertigoId, 'clicking the Vertigo dot selects it');
  check(await page.locator('#detail.open').isVisible(), 'detail panel opens');
  const rows = await page.locator('#p-list .sim').allTextContents();
  check(rows.length === 8 && rows.every(r => /\d+%/.test(r)), 'similar list has 8 rows with match %');
  check(rows.some(r => /Hitchcock/.test(r)), 'Vertigo’s similar films mention Hitchcock');
  check(await page.locator('#controls.shifted').count() === 1, 'controls shift right when the card opens');

  // Like three films, then hop to a neighbour.
  await page.click('#d-like');
  await page.locator('#p-list .sim').nth(1).click();
  await page.waitForTimeout(500);
  await page.click('#d-like');
  check((await page.evaluate(() => window.__rg.trail)).length === 2, 'hopping grows the trail');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__rg.selected)) === vertigoId, 'Esc steps back to Vertigo');
  await page.locator('#p-list .sim').nth(3).hover();
  await page.mouse.move(pt.x, pt.y);
  await page.waitForTimeout(700);
  await page.locator('#p-list .sim').nth(0).hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, 'focus.png') });

  // Recommend.
  await page.goto(`${base}?like=426,829,1018&dislike=168259`);
  await page.waitForFunction(() => window.__rg?.ready && !document.querySelector('#rec-go').disabled, null, { timeout: 20000 });
  await page.click('#rec-go');
  await page.waitForTimeout(700);
  const rec = await page.evaluate(() => window.__rg.rec);
  check(rec?.length === 12 && !rec.includes(426), `recommend returns 12 films, none of them picks`);
  await page.screenshot({ path: join(shots, 'recommend.png') });

  // Labels toggle.
  await page.keyboard.press('Escape');
  await page.keyboard.press('l');
  await page.keyboard.press('l');

  // Chat, against a stand-in for /api/chat so the check doesn't need Ollama.
  const CHAT_IDS = [64682, 106646, 455207, 1213, 930564, 497828, 350, 496243];
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await page.route('**/api/chat', route =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body:
        sse('step', { step: 'understanding' }) +
        sse('step', { step: 'searching' }) +
        sse('results', { films: CHAT_IDS.map((id, k) => ({ id, n: k + 1, source: 'wikipedia' })), query: null, offline: false, model: 'stub', searched: 2467 }) +
        sse('step', { step: 'writing' }) +
        sse('text', { text: 'Wealth front and centre: The Great Gatsby [1] and [2] are the most lavish; [3] and [7] keep it light; [5] and [8] look at the rich with a darker eye.' }) +
        CHAT_IDS.map((_, k) => sse('why', { n: k + 1, text: `Reason ${k + 1}` })).join('') +
        sse('done', { suggestions: ['Only comedies', 'Darker', 'More like #2'], state: { query: null, results: CHAT_IDS } }),
    }),
  );
  await page.goto(base);
  await page.waitForFunction(() => window.__rg?.ready, null, { timeout: 20000 });
  await page.keyboard.press('Control+k');
  check(await page.evaluate(() => document.activeElement?.id === 'chat-input'), 'Ctrl+K focuses the chat');
  await page.keyboard.type('I want to watch a movie where a rich lifestyle is shown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#p-list .sim .why:not(.pending)');
  await page.waitForTimeout(700);
  check((await page.evaluate(() => window.__rg.chat)).length === 8, 'chat results glow on the map (8 films)');
  check((await page.locator('#p-title').textContent()) === 'From chat', 'right panel shows "From chat"');
  check((await page.locator('#chat-thread .ref').count()) === 6, 'reply has 6 film chips');
  check(!/Gatsby\s*Gatsby/.test(await page.locator('#chat-thread').textContent()), 'a title before its marker is folded into the chip');
  check((await page.locator('#chat-sugg button').count()) === 3, 'follow-up suggestions show');
  await page.locator('#p-list .sim').nth(1).hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, 'chat.png') });
  await page.locator('#chat-thread .ref').first().click();
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__rg.selected)) === CHAT_IDS[0], 'clicking a chip opens that film');
  check(await page.locator('#p-back').isVisible(), 'the panel offers a way back to the chat results');
  await page.click('#p-back');
  await page.waitForTimeout(300);
  check((await page.locator('#p-title').textContent()) === 'From chat', 'back to the chat results');
  await page.reload();
  await page.waitForFunction(() => window.__rg?.ready, null, { timeout: 20000 });
  check((await page.evaluate(() => window.__rg.chat))?.length === 8, 'the conversation survives a reload');
  await page.click('#chat-clear');
  check((await page.evaluate(() => window.__rg.chat)) === null && !(await page.locator('#panel.open').count()), 'Clear removes the glow and the panel');
  await page.unroute('**/api/chat');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);

  // Phone.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.goto(`${base}?film=${vertigoId}`);
  await phone.waitForFunction(() => window.__rg?.ready && document.querySelectorAll('#p-list .sim').length === 8, null, { timeout: 20000 });
  await phone.waitForTimeout(700);
  await phone.screenshot({ path: join(shots, 'phone.png') });
  const box = await phone.locator('#detail').boundingBox();
  check(box && box.height < 844 * 0.4, 'phone: card is a top sheet');
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed. Screenshots in docs/.');
