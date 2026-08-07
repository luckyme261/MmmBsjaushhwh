const { chromium } = require('playwright');
const fs = require('fs');

const STORAGE_STATE = 'session.json';

const CONFIG = {
  site: 'https://aruble.net',
  // Credentials must be provided via env vars (ARUBLE_EMAIL / ARUBLE_PASSWORD).
  email: process.env.ARUBLE_EMAIL || '',
  password: process.env.ARUBLE_PASSWORD || '',
  headless: true,
  // Random wait between claims (seconds). 6-7 minutes by default.
  // Override with CLAIM_WAIT_MIN / CLAIM_WAIT_MAX env vars.
  claimWaitMin: parseInt(process.env.CLAIM_WAIT_MIN || '360', 10),
  claimWaitMax: parseInt(process.env.CLAIM_WAIT_MAX || '420', 10),
  // Optional residential proxy, e.g. PROXY_URL=socks5://user:pass@host:port
  // Needed because the claim endpoint rejects datacenter/VPN IPs.
  proxyUrl: process.env.PROXY_URL || null,
  proxy: null,
  proxyUser: null,
  proxyPass: null,
  // For testing; set MAX_ROUNDS=n env to limit loop iterations.
  maxRounds: parseInt(process.env.MAX_ROUNDS || '0', 10) || Infinity,
};

if (CONFIG.proxyUrl) {
  try {
    const u = new URL(CONFIG.proxyUrl);
    CONFIG.proxy = `${u.protocol}//${u.host}`;
    CONFIG.proxyUser = u.username ? decodeURIComponent(u.username) : null;
    CONFIG.proxyPass = u.password ? decodeURIComponent(u.password) : null;
  } catch (e) {
    log(`WARN: could not parse PROXY_URL (${CONFIG.proxyUrl}): ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function waitForChallenge(page, getChallenge) {
  for (let i = 0; i < 30; i++) {
    const c = getChallenge();
    if (c && c.type) return c;
    await sleep(150);
  }
  throw new Error('No challenge data captured from /captcha/challenge');
}

// ---- Human gate: press & hold the fingerprint button until ring fills ----
async function solveGate(page, getGateStart) {
  const btn = page.locator('#scGateBtn');
  try {
    await btn.waitFor({ state: 'visible', timeout: 6000 });
  } catch (e) {
    throw new Error('Gate button not visible');
  }
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const box = await btn.boundingBox();
  if (!box) throw new Error('Gate button not visible');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  let holdMs = 1000;
  for (let i = 0; i < 20; i++) {
    const g = getGateStart();
    if (g && g.hold_ms) { holdMs = g.hold_ms; break; }
    await sleep(100);
  }

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // small human-like micro movements so the server sees "moves"
  for (let i = 0; i < 4; i++) {
    await sleep(holdMs / 4);
    await page.mouse.move(cx + (Math.random() - 0.5) * 6, cy + (Math.random() - 0.5) * 6);
  }
  await sleep(150);
  await page.mouse.up();
  log(`  gate: held ~${holdMs + 150}ms`);
}

// ---- Type slide: drag handle to the glowing zone (target_pct) ----
async function solveSlide(page, targetPct) {
  const track = page.locator('#scTrack');
  const handle = page.locator('#scHandle');
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const tb = await track.boundingBox();
  const hb = await handle.boundingBox();
  if (!tb || !hb) throw new Error('Slide elements not visible');

  const usable = tb.width - hb.width;
  const targetX = tb.x + hb.width / 2 + usable * (targetPct / 100);
  const startX = hb.x + hb.width / 2;
  const startY = hb.y + hb.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(startX + (targetX - startX) * ease, startY, { steps: 3 });
    await sleep(12);
  }
  await sleep(80);
  await page.mouse.up();
  log(`  slide: dragged to ${targetPct}%`);
}

// ---- Type drag_dot: drag the dot into the circle ----
async function solveDot(page, targetX, targetY) {
  const area = page.locator('#scDotArea');
  const dot = page.locator('#scDot');
  await dot.scrollIntoViewIfNeeded().catch(() => {});
  const ab = await area.boundingBox();
  const db = await dot.boundingBox();
  if (!ab || !db) throw new Error('Dot elements not visible');

  const startX = db.x + db.width / 2;
  const startY = db.y + db.height / 2;
  const endX = ab.x + ab.width * (targetX / 100);
  const endY = ab.y + ab.height * (targetY / 100);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 25;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t, { steps: 3 });
    await sleep(10);
  }
  await sleep(100);
  await page.mouse.up();
  log(`  dot: dragged to ${targetX}%, ${targetY}%`);
}

// ---- Type icon_order: click the emoji cells in the shown sequence ----
async function solveOrder(page, data) {
  const prompt = data.prompt || [];
  const display = data.display || [];
  log(`  order: prompt = ${JSON.stringify(prompt)}`);
  const cells = page.locator('#scOrderGrid .sc-icon-cell');
  const used = new Set();
  for (const emoji of prompt) {
    let clicked = false;
    for (let i = 0; i < display.length; i++) {
      if (used.has(i)) continue;
      if (String(display[i].icon).trim() !== String(emoji).trim()) continue;
      const cell = cells.nth(i);
      await cell.scrollIntoViewIfNeeded().catch(() => {});
      const box = await cell.boundingBox();
      if (!box) continue;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      used.add(i);
      clicked = true;
      await sleep(220);
      break;
    }
    if (!clicked) throw new Error('Could not find grid cell for prompt icon: ' + emoji);
  }
  log('  order: clicked sequence done');
}

// ---- Type least_repeat: click the rarest emoji ----
async function solveLeast(page, data) {
  const grid = data.grid || [];
  const counts = {};
  for (const item of grid) counts[item.icon] = (counts[item.icon] || 0) + 1;
  let rarest = null;
  let rarestCount = Infinity;
  for (const icon of Object.keys(counts)) {
    if (counts[icon] < rarestCount) { rarestCount = counts[icon]; rarest = icon; }
  }
  log(`  least: counts = ${JSON.stringify(counts)}, rarest = ${rarest}`);
  const cells = page.locator('#scLeastGrid .sc-icon-cell');
  for (let i = 0; i < grid.length; i++) {
    if (String(grid[i].icon).trim() !== String(rarest).trim()) continue;
    const cell = cells.nth(i);
    await cell.scrollIntoViewIfNeeded().catch(() => {});
    const box = await cell.boundingBox();
    if (!box) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return;
  }
  throw new Error('Could not find rarest cell');
}

// ---- Main captcha solver loop ----
async function solveCaptcha(page, options = {}) {
  const { openBy = null, isVerified = null } = options;
  let challenge = null;
  let gateStart = null;

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      if (url.includes('/captcha/challenge')) {
        const j = await resp.json();
        challenge = j;
      } else if (url.includes('/captcha/gate/start')) {
        const j = await resp.json();
        gateStart = j;
      }
    } catch (e) { /* ignore */ }
  };
  page.on('response', onResponse);

  if (openBy) {
    // Invoke the widget's own handler directly. A physical click is avoided
    // because Playwright can re-dispatch it after the login modal hides, and the
    // stray click lands on the captcha overlay which the site treats as "click
    // outside to close".
    let modalOpened = false;
    for (let i = 0; i < 5 && !modalOpened; i++) {
      await page.evaluate(openBy).catch(() => {});
      try {
        await page.waitForSelector('#slideCaptchaModal.open', { timeout: 5000 });
        modalOpened = true;
      } catch (e) {
        await sleep(800);
      }
    }
    if (!modalOpened) throw new Error('Could not open the captcha widget');
  }
  log('Opened captcha widget');

  let solved = false;
  let gateLoops = 0;
  const wrapSel = '#scGateWrap:visible, #scSlideWrap:visible, #scOrderWrap:visible, #scLeastWrap:visible, #scDotWrap:visible, #scBanWrap:visible';
  for (let attempt = 0; attempt < 15; attempt++) {
    // Wait up to ~60s for a challenge widget, tolerating the loading state / slow responses
    let id = null;
    for (let w = 0; w < 60; w++) {
      const loc = page.locator(wrapSel);
      const count = await loc.count().catch(() => 0);
      if (count > 0) { id = await loc.first().getAttribute('id'); break; }
      const modalOpen = await page.locator('#slideCaptchaModal.open').count().catch(() => 0);
      if (modalOpen === 0) {
        const loading = await page.locator('#scLoading.active').count().catch(() => 0);
        const status = await page.locator('#scStatus').innerText().catch(() => '');
        const subtitle = await page.locator('#scSubtitle').innerText().catch(() => '');
        throw new Error(
          `Captcha modal closed before a challenge appeared (loading=${loading}, subtitle="${subtitle}", status="${status}")`
        );
      }
      await sleep(1000);
    }
    if (!id) {
      const status = await page.locator('#scStatus').innerText().catch(() => '');
      const subtitle = await page.locator('#scSubtitle').innerText().catch(() => '');
      throw new Error(`No captcha widget appeared (subtitle="${subtitle}", status="${status}")`);
    }
    log(`  attempt ${attempt + 1}: widget = ${id}`);

    if (id === 'scBanWrap') {
      throw new Error('Temporarily blocked by captcha system');
    }

    try {
      if (id === 'scGateWrap') {
        gateLoops++;
        if (gateLoops > 6) {
          throw new Error('Too many consecutive gate challenges - likely IP-flagged.');
        }
        await solveGate(page, () => gateStart);
        await sleep(400); // server refetches the real challenge
        continue;
      }
      gateLoops = 0;

      const data = await waitForChallenge(page, () => challenge);
      if (id === 'scSlideWrap') await solveSlide(page, data.target_pct);
      else if (id === 'scOrderWrap') await solveOrder(page, data);
      else if (id === 'scLeastWrap') await solveLeast(page, data);
      else if (id === 'scDotWrap') await solveDot(page, data.target_x, data.target_y);
    } catch (e) {
      // Transient widget errors (e.g. a gate button that never rendered) are
      // retried against a fresh challenge instead of aborting the whole captcha.
      if (e.message === 'Temporarily blocked by captcha system') throw e;
      log(`  solve error (attempt ${attempt + 1}): ${e.message} - retrying with a fresh challenge`);
      await sleep(1500);
      continue;
    }

    // Wait for the outcome
    for (let i = 0; i < 40; i++) {
      if (isVerified) {
        if (await isVerified()) { solved = true; break; }
      } else {
        const verified = await page.locator('#loginCaptchaStatus.captcha-verified').count();
        if (verified > 0) { solved = true; break; }
      }
      const banVisible = await page.locator('#scBanWrap:visible').count();
      if (banVisible > 0) throw new Error('Temporarily blocked by captcha system');
      // still open with status "Verifying…" or a new challenge -> keep polling
      await sleep(400);
    }
    if (solved) break;
    log('  answer was rejected, retrying with a fresh challenge');
  }

  page.off('response', onResponse);

  if (!solved) {
    const status = await page.locator('#scStatus').innerText().catch(() => '');
    throw new Error('Captcha could not be solved. Status: ' + status);
  }
  log('Captcha verified!');
}
// ---- Bot-check page: math question + SlideCaptcha + verify ----
function evalMath(question) {
  const m = String(question).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([+\-×x*/÷])\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[3]);
  switch (m[2]) {
    case '+': return a + b;
    case '-': return a - b;
    case '×': case 'x': case '*': return a * b;
    case '÷': case '/': return b !== 0 ? a / b : null;
    default: return null;
  }
}

async function solveBotCheck(page) {
  log('On bot-check page - solving the security check...');
  await page.waitForSelector('.botcheck-question', { timeout: 15000 });
  await page.waitForSelector('#mathAnswer', { timeout: 15000 });

  const question = (await page.locator('.botcheck-question').innerText()).trim();
  const answer = evalMath(question);
  if (answer === null) throw new Error('Could not parse bot-check math: ' + question);
  log(`  math: ${question} -> ${answer}`);
  await page.type('#mathAnswer', String(answer), { delay: 90 });

  // Human-like pause before opening the captcha
  await sleep(1500 + Math.random() * 2000);

  const opened = await page.evaluate(() => {
    const btn = document.getElementById('openCaptchaBtn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error('Could not open the bot-check captcha');

  await solveCaptcha(page, {
    isVerified: async () => (await page.locator('#captchaStatus.passed').count()) > 0,
  });

  await sleep(1200 + Math.random() * 1500);

  const submitted = await page.evaluate(() => {
    const btn = document.getElementById('botCheckBtn');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!submitted) throw new Error('Could not submit the bot-check form');

  await page.waitForURL((u) => !u.pathname.includes('/bot-check'), { timeout: 20000 });
  log('Bot-check passed.');
}

// ---- Session / navigation helpers ----
async function gotoFaucet(page) {
  await page.goto(CONFIG.site + '/faucet', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // #claimCard can be delayed by an interstitial ad, a slow render, or the
  // site redirecting /faucet to its /bot-check security page. Handle all of
  // them and retry while dismissing interstitials between attempts.
  for (let i = 0; i < 4; i++) {
    if (page.url().includes('/bot-check')) {
      try {
        await solveBotCheck(page);
      } catch (e) {
        log(`  bot-check solve failed: ${e.message}`);
      }
    }
    try {
      await page.waitForSelector('#claimCard', { timeout: 10000 });
      return true; // logged in and on the faucet
    } catch (e) {
      await dismissInterstitial(page);
    }
  }
  return false; // likely logged out or session expired
}

async function reachFaucet(page, maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await gotoFaucet(page)) return true;
    await sleep(5000);
  }
  await dumpState(page, 'faucet_debug');
  return false;
}

async function dumpState(page, tag) {
  try {
    const s = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: (document.body ? document.body.innerText : '').slice(0, 300).replace(/\n/g, ' | '),
      claimCard: !!document.querySelector('#claimCard'),
      botCheck: !!document.querySelector('#interstitialSkip'),
    }));
    log(`[${tag}] url=${s.url} title="${s.title}" claimCard=${s.claimCard} botCheck=${s.botCheck}`);
    log(`[${tag}] body: ${s.body}`);
  } catch (e) { log(`[${tag}] evaluate failed: ${e.message}`); }
  await page.screenshot({ path: tag + '.png', fullPage: true }).catch(() => {});
}

async function dismissInterstitial(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForSelector('#interstitialSkip:not([disabled])', { timeout: 15000 });
      await page.click('#interstitialSkip');
      log('Closed interstitial ad');
    } catch (e) { /* no interstitial */ return; }
    // The bot-check interstitial redirects to its return_to URL after skipping;
    // give the redirect a moment and stop once we're past it.
    try {
      await page.waitForURL((u) => !u.pathname.includes('/bot-check'), { timeout: 10000 });
      return;
    } catch (e) { /* still on bot-check - the IP may be flagged; retry */ }
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

async function isFaucetReady(page) {
  const text = await page.locator('#claimBtnText').innerText().catch(() => '');
  const disabled = await page.locator('#claimBtn').isDisabled().catch(() => true);
  return !disabled && /claim now/i.test(text);
}

async function ensureLoggedIn(page) {
  log('Session expired - logging in...');
  // Drop the session cookies so the homepage shows the login button even when
  // the current session is still valid server-side (e.g. the claim endpoint
  // blocked it as VPN/proxy but auth still works). A fresh login then gets a
  // brand-new session. (The /logout endpoint is avoided: it routes through a
  // bot-check interstitial.)
  await page.context().clearCookies().catch(() => {});
  await page.goto(CONFIG.site, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the page to settle (also covers Cloudflare interstitials)
  await page.waitForSelector('button.btn-auth-login', { timeout: 90000 });

  log('Clicking Sign in...');
  await page.click('button.btn-auth-login');
  await page.waitForSelector('#loginModal.show', { timeout: 10000 });

  log('Filling credentials...');
  await page.fill('#loginForm input[name="email"]', CONFIG.email);
  await page.fill('#loginForm input[name="password"]', CONFIG.password);

  log('Starting captcha...');
  await solveCaptcha(page, { openBy: 'openAuthCaptcha("login")' });

  log('Clicking Login...');
  await page.click('#loginBtn');

  // Login success redirects away from the homepage; wait for it.
  await page.waitForTimeout(1500);
  await page.waitForURL((url) => url.toString() !== CONFIG.site + '/', { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  log('Logged in.');
}

async function startBrowser() {
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const contextOptions = {
    viewport: { width: 1366, height: 850 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  };
  if (CONFIG.proxy) {
    contextOptions.proxy = { server: CONFIG.proxy };
    if (CONFIG.proxyUser) contextOptions.proxy.username = CONFIG.proxyUser;
    if (CONFIG.proxyPass) contextOptions.proxy.password = CONFIG.proxyPass;
  }
  if (fs.existsSync(STORAGE_STATE)) contextOptions.storageState = STORAGE_STATE;
  const context = await browser.newContext(contextOptions);
  const saveSession = () => context.storageState({ path: STORAGE_STATE }).catch(() => {});
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  return { browser, context, page, saveSession };
}

async function run() {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error('ARUBLE_EMAIL / ARUBLE_PASSWORD environment variables are not set.');
  }
  // A fresh browser each round forces new proxy connections, so the rotating
  // residential proxy hands out a fresh exit IP per round. The site flags an
  // IP after ~1 claim, so rotating per round is what keeps claims working.
  let consecutiveFailures = 0;
  let round = 0;
  while (round < CONFIG.maxRounds) {
    round++;
    log(`--- Round ${round} ---`);
    const { browser, page, saveSession } = await startBrowser();
    try {
      // 1. Reach the faucet, reusing the existing session when possible.
      let onFaucet = await gotoFaucet(page);
      if (!onFaucet) {
        await ensureLoggedIn(page);
        await saveSession();
        onFaucet = await reachFaucet(page);
        if (!onFaucet) throw new Error('Could not reach faucet after login');
      }
      await dismissInterstitial(page);

      const reward = await page.locator('.claim-reward-value').first().innerText().catch(() => '');
      const balance = await page.locator('#cityBalAmount').first().innerText().catch(() => '');
      const timer = await page.locator('#timerDigits').first().innerText().catch(() => '');
      log(`Faucet: timer=${timer}, reward=${reward}, balance=${balance}`);

      // 2. Claim if the faucet is ready
      if (await isFaucetReady(page)) {
        await claimFaucet(page);
      } else {
        log(`Faucet on cooldown (timer=${timer}), skipping claim this round.`);
      }
      await saveSession();
      consecutiveFailures = 0;
    } catch (err) {
      log(`Round ${round} error: ${err.message}`);
      await page.screenshot({ path: `error_round${round}.png`, fullPage: true }).catch(() => {});
      consecutiveFailures++;
      if (consecutiveFailures >= 6) {
        log('6 consecutive failed rounds - aborting.');
        throw new Error('Aborting after 6 consecutive failed rounds');
      }
    } finally {
      await browser.close();
    }

    if (round >= CONFIG.maxRounds) break;

    // 3. Wait a random 6-7 minutes before the next claim
    const waitSec = CONFIG.claimWaitMin + Math.floor(Math.random() * (CONFIG.claimWaitMax - CONFIG.claimWaitMin + 1));
    log(`Waiting ${waitSec}s (${(waitSec / 60).toFixed(2)} min) before next claim...`);
    await sleep(waitSec * 1000);
  }
  log('Bot finished.');
}

// ---- Faucet claim ----
async function attemptClaim(page) {
  let claimResult = null;
  const onResp = async (resp) => {
    try {
      if (resp.url().includes('/faucet/claim')) {
        claimResult = await resp.json();
      }
    } catch (e) { /* ignore */ }
  };
  page.on('response', onResp);
  try {
    await solveCaptcha(page, {
      openBy: 'openCaptchaForClaim()',
      isVerified: async () => claimResult !== null,
    });
    // Wait for the claim POST to settle (success or cooldown/VPN error)
    for (let i = 0; i < 50; i++) {
      if (claimResult) break;
      await sleep(400);
    }
  } finally {
    page.off('response', onResp);
  }
  return claimResult;
}

async function claimFaucet(page) {
  const btnText = await page.locator('#claimBtnText').innerText().catch(() => '');
  const disabled = await page.locator('#claimBtn').isDisabled().catch(() => true);
  if (disabled || !/claim now/i.test(btnText)) {
    log(`Faucet on cooldown (button: "${btnText}"), skipping claim.`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Claiming faucet reward (attempt ${attempt}/3)...`);
    let result;
    try {
      result = await attemptClaim(page);
    } catch (e) {
      // Flagged IPs gate-loop in the captcha; the next round gets a fresh IP.
      log(`Claim captcha failed (${e.message}) - skipping claim this round.`);
      return;
    }

    if (result && result.success) {
      log(`Claim SUCCESS: +${result.amount} ${result.symbol} -> balance ${result.balance_after}`);
      return;
    }

    const msg = (result && result.message) || 'no server response';
    log(`Claim attempt ${attempt} failed: ${msg}`);

    // The site's fraud check rejects sessions whose IP looks like a VPN/proxy.
    // Re-logging in gets a fresh session, which sometimes clears the flag.
    if (!/vpn|proxy|detected/i.test(msg)) {
      log('Non-retryable claim error, giving up this round.');
      return;
    }
    if (attempt === 3) {
      log('Still VPN/proxy blocked after 3 attempts - giving up this round.');
      return;
    }

    log('VPN/proxy detected - re-logging in to get a fresh session...');
    try {
      await ensureLoggedIn(page);
      if (!(await reachFaucet(page))) throw new Error('Could not reach faucet after re-login');
      await dismissInterstitial(page);
      const ready = await isFaucetReady(page);
      if (!ready) {
        log('Faucet on cooldown after re-login, skipping claim this round.');
        return;
      }
    } catch (e) {
      log(`Re-login after VPN block failed: ${e.message} - skipping claim this round.`);
      return;
    }
  }
}

module.exports = { CONFIG, solveCaptcha, sleep };

if (require.main === module) run();
