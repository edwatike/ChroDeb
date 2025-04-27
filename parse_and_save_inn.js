const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const debugPort = 9222;
const browserURL = `http://localhost:${debugPort}`;
const sitesFile = path.join(__dirname, 'sites.txt');
const grokResultFile = path.join(__dirname, 'results_grok', 'grok_result.txt');
const dbFile = path.join(__dirname, 'inns.db');
const jsonFile = path.join(__dirname, 'inns.json');

// 1. Читаем список сайтов
const sites = fs.readFileSync(sitesFile, 'utf-8')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

// 2. Читаем ответ Grok
const grokAnswer = fs.readFileSync(grokResultFile, 'utf-8');

// 3. Извлекаем ИНН из ответа Grok
const innMap = {}; // { сайт: ИНН }
const notFoundSites = [];
const innRegex = /^([a-z0-9.-]+)\s*—\s*(\d{10,12})/gim;
let match;
while ((match = innRegex.exec(grokAnswer)) !== null) {
  innMap[match[1]] = match[2];
}

// 4. Находим сайты без ИНН
for (const site of sites) {
  if (!innMap[site]) {
    notFoundSites.push(site);
  }
}

// 5. Функция поиска ИНН в Google
async function findInnInGoogle(site) {
  // Подключаемся к уже запущенному браузеру с remote debugging
  const browser = await puppeteer.connect({ browserURL });
  const pages = await browser.pages();
  console.log('Открытые вкладки:');
  for (const p of pages) {
    console.log(await p.url());
  }

  // Ищем первую свободную вкладку (не grok.com), иначе создаём новую
  let page = pages.find(p => !/grok\.com/.test(p.url()));
  if (!page) {
    page = await browser.newPage();
  }

  await page.waitForSelector('textarea.gLFyf', { timeout: 7000 });
  // Сначала вставляем сайт
  await page.type('textarea.gLFyf', site);
  // Затем печатаем остальной текст запроса по буквам с задержкой
  const tail = ' инн компании';
  for (const char of tail) {
    await page.keyboard.type(char, { delay: 120 + Math.random() * 80 });
  }
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Делаем скриншот для диагностики
  await page.screenshot({ path: 'google_debug.png' });

  // Ждём поле поиска или кнопку согласия
  try {
    await page.waitForSelector('textarea.gLFyf', { timeout: 7000 });
  } catch {
    // Если появилось окно согласия — нажимаем кнопку
    const consentBtn = await page.$('button[aria-label^="Принять все"]') || await page.$('button[aria-label^="Accept all"]');
    if (consentBtn) {
      await consentBtn.click();
      await page.waitForSelector('textarea.gLFyf', { timeout: 7000 });
    } else {
      await page.close();
      throw new Error('Не найдено поле поиска и кнопка согласия!');
    }
  }

  await page.type('textarea.gLFyf', query);
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  // Пробуем найти ИНН в сниппетах
  const text = await page.evaluate(() => document.body.innerText);
  const innMatch = text.match(/\b\d{10,12}\b/);
  // Добавляю задержку перед закрытием вкладки
  await new Promise(r => setTimeout(r, 2000));
  await page.close();
  return innMatch ? innMatch[0] : null;
}

// 6. Основная логика
(async () => {
  for (const site of notFoundSites) {
    console.log(`Ищу ИНН для ${site} через Google...`);
    const inn = await findInnInGoogle(site);
    if (inn) {
      innMap[site] = inn;
      console.log(`Найден ИНН для ${site}: ${inn}`);
    } else {
      innMap[site] = null;
      console.log(`ИНН для ${site} не найден.`);
    }
  }

  // 7. Сохраняем в SQLite
  const db = new sqlite3.Database(dbFile);
  db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS inns (site TEXT PRIMARY KEY, inn TEXT)');
    const stmt = db.prepare('INSERT OR REPLACE INTO inns (site, inn) VALUES (?, ?)');
    for (const site of sites) {
      stmt.run(site, innMap[site] || null);
    }
    stmt.finalize();
  });
  db.close();

  // 8. Сохраняем в JSON
  const jsonArr = sites.map(site => ({ site, inn: innMap[site] || null }));
  fs.writeFileSync(jsonFile, JSON.stringify(jsonArr, null, 2), 'utf-8');
  console.log('Результаты сохранены в inns.db и inns.json');
})(); 