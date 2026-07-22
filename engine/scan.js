// 外站票雷達 — 掃描引擎
// 用法:
//   node scan.js europe            掃歐洲組(VIE/MUC/PRG × 全出發地)
//   node scan.js oceania           掃澳紐冰島組
//   node scan.js all               全掃
//   node scan.js route BKK VIE business 10   單一組合(測試用)
// 產出: data/latest.json(最新矩陣)、data/history/*.json(逐日留存)、data/deals.json(好價清單)
const { chromium } = require('playwright');
const { flightsUrl } = require('./tfs');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DATA = p => path.join(ROOT, 'data', p);
const today = new Date();
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = iso(today);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = ([lo, hi]) => (lo + Math.random() * (hi - lo)) * 1000;

// ---------- 任務清單 ----------
function buildTasks(mode, args) {
  if (mode === 'route') {
    const [from, to, cabin = 'business', dur = '10'] = args;
    return [{ from, to, cabin, duration: Number(dur) }];
  }
  const dests = Object.entries(CFG.destinations)
    .filter(([, d]) => mode === 'all' || d.group === mode)
    .map(([code]) => code);
  const tasks = [];
  for (const to of dests)
    for (const cabin of CFG.cabins)
      for (const duration of CFG.durations)
        for (const from of CFG.origins)
          tasks.push({ from, to, cabin, duration });
  return tasks;
}

// ---------- 單一任務:抓 6 個月每日最低價 ----------
async function scanTask(page, t) {
  const dep = new Date(today.getTime() + CFG.anchorDaysAhead * 86400000);
  const ret = new Date(dep.getTime() + t.duration * 86400000);
  const url = flightsUrl({ from: t.from, to: t.to, depart: iso(dep), ret: iso(ret), cabin: t.cabin });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /來回票價|找不到|已售完/.test(document.body.innerText), { timeout: 45000 });
  await sleep(1500 + Math.random() * 1500);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  if (/異常流量|unusual traffic|驗證您不是機器人/.test(bodyText)) throw new Error('BLOCKED');

  // 開月曆
  const dateField = await page.$('input[value*="月"]');
  if (!dateField) throw new Error('找不到日期欄');
  await dateField.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-iso]')].some(el => /\$/.test(el.innerText || '')),
    { timeout: 25000 });
  await sleep(1200);

  const grab = () => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-iso]')) {
      const iso = el.getAttribute('data-iso');
      const txt = (el.innerText || '').replace(/\n/g, ' ');
      let m = txt.match(/\$([\d.]+)萬/);
      if (m) { out[iso] = Math.round(parseFloat(m[1]) * 10000); continue; }
      m = txt.match(/\$([\d,]+)/);
      if (m) out[iso] = Number(m[1].replace(/,/g, ''));
    }
    return out;
  });

  let prices = await grab();
  for (let i = 0; i < CFG.calendarFlips; i++) {
    const clicked = await page.evaluate(() => {
      const cand = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')];
      const btn = cand.find(b => /下一頁|下個月/.test(b.getAttribute('aria-label') || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await sleep(2200 + Math.random() * 1200);
    prices = { ...prices, ...(await grab()) };
  }
  // 關閉月曆(Esc),避免影響下一輪
  await page.keyboard.press('Escape').catch(() => {});
  return prices;
}

// ---------- 好價判定 ----------
function findDeals(matrix) {
  const deals = [];
  for (const key of Object.keys(matrix)) {
    const [from, to, cabin, dur] = key.split('|');
    if (from === CFG.baseline) continue;
    const cur = matrix[key];
    const base = matrix[[CFG.baseline, to, cabin, dur].join('|')] || {};
    // 按月分桶比較「當月最低」
    const byMonth = {}, baseByMonth = {};
    for (const [d, p] of Object.entries(cur)) {
      const m = d.slice(0, 7);
      if (!byMonth[m] || p < byMonth[m].p) byMonth[m] = { d, p };
    }
    for (const [d, p] of Object.entries(base)) {
      const m = d.slice(0, 7);
      if (!baseByMonth[m] || p < baseByMonth[m].p) baseByMonth[m] = { d, p };
    }
    const destCfg = CFG.destinations[to] || {};
    const absKey = CFG.absoluteThresholds[to] ? to : destCfg.group;
    const abs = (CFG.absoluteThresholds[absKey] || {})[cabin];
    for (const [m, best] of Object.entries(byMonth)) {
      const baseBest = baseByMonth[m];
      const ratio = baseBest ? best.p / baseBest.p : null;
      const isRatioDeal = ratio !== null && ratio <= CFG.dealRatio;
      const isAbsDeal = abs && best.p <= abs;
      if (isRatioDeal || isAbsDeal) {
        deals.push({
          from, to, cabin, duration: Number(dur), month: m,
          date: best.d, price: best.p,
          tpePrice: baseBest ? baseBest.p : null, tpeDate: baseBest ? baseBest.d : null,
          ratio: ratio ? Math.round(ratio * 100) / 100 : null,
          triggers: [...(isRatioDeal ? ['價差'] : []), ...(isAbsDeal ? ['絕對門檻'] : [])],
        });
      }
    }
  }
  deals.sort((a, b) => (a.ratio ?? 9) - (b.ratio ?? 9));
  return deals;
}

// ---------- Windows 彈窗 ----------
function notify(title, msg) {
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(15000, '${title}', '${msg.replace(/'/g, "''")}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 12; $n.Dispose()`;
  execFile('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], () => {});
}

// ---------- 主流程 ----------
(async () => {
  let mode = process.argv[2] || 'all';
  if (mode === 'auto') {
    // 輪值:一年中的第幾天,偶數掃歐洲、奇數掃澳紐冰島
    const doy = Math.floor((today - new Date(today.getFullYear(), 0, 0)) / 86400000);
    mode = doy % 2 === 0 ? 'europe' : 'oceania';
    console.log(`[auto] 今日輪值:${mode}`);
  }
  const tasks = buildTasks(mode, process.argv.slice(3));
  console.log(`[scan] ${todayIso} 模式=${mode} 任務數=${tasks.length}`);

  const ctx = await chromium.launchPersistentContext(DATA('browser-profile'), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  // 載入既有 latest(讓不同組的結果能合併)
  let latest = {};
  try { latest = JSON.parse(fs.readFileSync(DATA('latest.json'), 'utf8')).matrix || {}; } catch {}

  const matrix = latest;
  let ok = 0, fail = 0, blocked = false;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const key = [t.from, t.to, t.cabin, t.duration].join('|');
    process.stdout.write(`[${i + 1}/${tasks.length}] ${key} ... `);
    try {
      const prices = await scanTask(page, t);
      matrix[key] = prices;
      ok++;
      console.log(`${Object.keys(prices).length} 天`);
      // 即時存檔:中途被中斷也不丟已掃資料
      fs.writeFileSync(DATA('latest.json'),
        JSON.stringify({ scanDate: todayIso, scannedAt: new Date().toISOString(), mode, matrix }), 'utf8');
    } catch (e) {
      fail++;
      console.log(`失敗: ${e.message}`);
      if (e.message === 'BLOCKED') { blocked = true; break; }
    }
    if (i < tasks.length - 1) await sleep(jitter(CFG.delayBetweenTasksSec));
  }

  // 存檔
  const out = { scanDate: todayIso, scannedAt: new Date().toISOString(), mode, matrix };
  fs.writeFileSync(DATA('latest.json'), JSON.stringify(out), 'utf8');
  fs.mkdirSync(DATA('history'), { recursive: true });
  fs.writeFileSync(DATA(`history/${todayIso}_${mode}.json`), JSON.stringify(out), 'utf8');

  const deals = findDeals(matrix);
  fs.writeFileSync(DATA('deals.json'), JSON.stringify({ scanDate: todayIso, deals }, null, 2), 'utf8');

  console.log(`\n[done] 成功 ${ok} / 失敗 ${fail}${blocked ? '(被 Google 擋,提前中止,明天再試或降低頻率)' : ''}`);
  console.log(`[deals] ${deals.length} 筆好價`);
  deals.slice(0, 8).forEach(d =>
    console.log(`  ${CFG.originNames[d.from] || d.from}→${CFG.destinations[d.to]?.name || d.to} ${d.cabin === 'business' ? '商務' : '經濟'}${d.duration}天 ${d.date} NT$${d.price.toLocaleString()}${d.tpePrice ? ` (台北 ${d.tpePrice.toLocaleString()}, ${Math.round(d.ratio * 100)}%)` : ''} [${d.triggers.join('+')}]`));

  if (deals.length) {
    const top = deals[0];
    notify('外站票雷達:發現好價',
      `共 ${deals.length} 筆。最佳:${CFG.originNames[top.from] || top.from}→${CFG.destinations[top.to]?.name || top.to} ${top.cabin === 'business' ? '商務' : '經濟'} NT$${top.price.toLocaleString()} (${top.date})`);
  }

  // 走勢:每個組合「全期最低價」的逐掃描日序列(給 PWA 畫趨勢)
  let trend = {};
  try { trend = JSON.parse(fs.readFileSync(DATA('trend.json'), 'utf8')); } catch {}
  for (const [key, prices] of Object.entries(matrix)) {
    const vals = Object.values(prices);
    if (!vals.length) continue;
    (trend[key] = trend[key] || {})[todayIso] = Math.min(...vals);
  }
  fs.writeFileSync(DATA('trend.json'), JSON.stringify(trend), 'utf8');

  // git push(專案是 git repo 且設定了 remote 才會動作,失敗不影響掃描結果)
  try {
    const { execFileSync } = require('child_process');
    const git = args => execFileSync('git', args, { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    git(['rev-parse', '--is-inside-work-tree']);
    git(['add', 'data/latest.json', 'data/deals.json', 'data/trend.json', 'data/history']);
    try { git(['commit', '-m', `scan ${todayIso} ${mode}`]); } catch { /* 無變更 */ }
    if (git(['remote'])) { git(['push']); console.log('[git] 已推送到 GitHub'); }
  } catch { console.log('[git] 未設定 repo/remote,跳過上傳(儀表板仍可本機看)'); }

  await ctx.close();
})().catch(e => { console.error('[fatal]', e); process.exit(1); });
