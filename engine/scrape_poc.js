// M1 探路 v2:結構化解析航班列 + 月曆價格視圖 DOM 偵察
// 用法: node scrape_poc.js [from] [to] [depart] [return] [cabin]
const { chromium } = require('playwright');
const { flightsUrl } = require('./tfs');
const path = require('path');
const fs = require('fs');

const FROM = process.argv[2] || 'BKK';
const TO = process.argv[3] || 'VIE';
const DEP = process.argv[4] || '2026-10-15';
const RET = process.argv[5] || '2026-10-25';
const CABIN = process.argv[6] || 'business';

const ROOT = path.join(__dirname, '..');
const OUT = p => path.join(ROOT, 'data', p);

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'data', 'browser-profile'), {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();

  const url = flightsUrl({ from: FROM, to: TO, depart: DEP, ret: RET, cabin: CABIN });
  console.log('[goto]', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /來回票價|已售完|找不到/.test(document.body.innerText), { timeout: 45000 });
  await page.waitForTimeout(2000);

  // 展開「顯示更多航班」
  for (let i = 0; i < 2; i++) {
    const more = await page.$('button[aria-label*="更多航班"], span:has-text("顯示更多航班")');
    if (!more) break;
    await more.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // 結構化解析:每個含「來回票價」的 li
  const flights = await page.evaluate(() => {
    const out = [];
    for (const li of document.querySelectorAll('li')) {
      const t = li.innerText || '';
      if (!t.includes('來回票價')) continue;
      if (li.querySelector('li')) continue; // 跳過巢狀外層
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      const priceLine = lines.find(l => /^\$[\d,]+$/.test(l));
      const durIdx = lines.findIndex(l => /^\d+\s*小時/.test(l));
      out.push({
        raw_head: lines.slice(0, durIdx > 0 ? durIdx : 4).join(' | '),
        duration: durIdx >= 0 ? lines[durIdx] : null,
        stops: lines.find(l => /^(直達|轉機)/.test(l)) || null,
        price: priceLine ? Number(priceLine.replace(/[$,]/g, '')) : null,
      });
    }
    return out;
  });
  console.log(`[flights] ${flights.length} 筆`);
  fs.writeFileSync(OUT('poc_flights.json'), JSON.stringify(flights, null, 2), 'utf8');

  // 月曆偵察:點「去程日期」文字欄(value 含「月」的 input)開日期選擇器
  const dateField = await page.$('input[value*="月"]');
  console.log('[calendar] dateField found:', !!dateField);
  if (dateField) {
    await dateField.click();
    await page.waitForTimeout(1500);
    // 等日期格出現價格文字(格子帶 data-iso,價格以「$X.XX萬」顯示)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-iso]')].some(el => /\$/.test(el.innerText || '')),
      { timeout: 20000 }).catch(() => console.log('[calendar] 20 秒內日期格沒出現價格'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: OUT('poc_calendar.png') });

    // 診斷:列出月曆附近所有帶 aria-label 的按鈕
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')]
        .map(b => b.getAttribute('aria-label')).filter(l => l && l.length < 30)
    );
    console.log('[buttons]', JSON.stringify(btns.slice(0, 40)));

    const grab = () => page.evaluate(() => {
      const cells = [];
      for (const el of document.querySelectorAll('[data-iso]')) {
        const label = el.getAttribute('aria-label') || '';
        const iso = el.getAttribute('data-iso') || '';
        const txt = (el.innerText || '').replace(/\n/g, ' ').trim();
        if (txt) cells.push({ iso, label, txt });
      }
      return cells;
    });
    let all = await grab();
    // 翻月:找含「下」與「月」的 aria-label 按鈕(例如 往後捲動/下個月)
    for (let i = 0; i < 2; i++) {
      const next = await page.evaluateHandle(() => {
        const cand = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')];
        return cand.find(b => /下|往後|next/i.test(b.getAttribute('aria-label') || '')) || null;
      });
      const el = next.asElement();
      if (!el) { console.log('[calendar] 找不到下個月按鈕'); break; }
      await el.click();
      await page.waitForTimeout(2500);
      all = all.concat(await grab());
    }
    await page.screenshot({ path: OUT('poc_calendar2.png') });
    fs.writeFileSync(OUT('poc_calendar.json'), JSON.stringify(all, null, 2), 'utf8');
    const priced = all.filter(c => /\$/.test(c.txt));
    console.log(`[calendar] ${all.length} 格,含價格 ${priced.length} 格,樣本:`);
    priced.slice(0, 6).forEach(c => console.log(JSON.stringify(c)));
  }

  await ctx.close();
  console.log('[done]');
})().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
