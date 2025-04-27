const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

puppeteer.use(StealthPlugin());

const userDataDir = path.join(os.homedir(), 'chrome-grok-profile');
const debugPort = 9222;
const browserURL = `http://localhost:${debugPort}`;

// Читаем список сайтов из файла
const sitesFile = path.join(__dirname, 'sites.txt');
let sites = [];
if (fs.existsSync(sitesFile)) {
  sites = fs.readFileSync(sitesFile, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
} else {
  console.error('Файл sites.txt не найден!');
  process.exit(1);
}

// Формируем промпт по шаблону
const prompt = `На основе общедоступной информации из официальных сайтов компаний, реестров (например, СПАРК, Rusprofile, checko.ru) и других источников\nпришли списоком ИНН сайтов:\n${sites.join('\n')}\nНа те сайты, которые инн не нашел, пришли также их список.`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchChromeWithRemoteDebug() {
  // Проверяем, не запущен ли уже Chrome с нужным портом
  try {
    execSync(`lsof -i :${debugPort}`);
    console.log('Chrome с remote debugging уже запущен.');
    return;
  } catch {
    // Не запущен, стартуем
  }
  console.log('Запускаю Chrome с remote debugging...');
  exec(`google-chrome --remote-debugging-port=${debugPort} --user-data-dir="${userDataDir}" --window-size=1366,768 > chrome_debug.log 2>&1 &`);
  // Ждем запуска
  await sleep(8000);
}

(async () => {
  await launchChromeWithRemoteDebug();
  const browser = await puppeteer.connect({ browserURL });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto('https://grok.com', { waitUntil: 'networkidle2', timeout: 60000 });
  try {
    await page.waitForSelector('textarea', { timeout: 30000 });
  } catch {
    console.log('Поле ввода не найдено. Возможно, требуется ручная авторизация или капча.');
    return;
  }
  const resultsDir = path.join(__dirname, 'results_grok');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
  }
  // Отправляем только один промпт
  await sleep(2000 + Math.random() * 2000);
  const textarea = await page.$('textarea');
  await textarea.click({ clickCount: 3 });
  await textarea.press('Backspace');

  // 1. Печатаем основной текст промпта по-символьно с опечатками
  const promptParts = prompt.split('\n');
  const mainText = promptParts.slice(0, -sites.length).join('\n') + '\n';
  const sitesText = sites.join('\n');
  for (const char of mainText) {
    // 7% шанс опечатки для букв
    if (/[а-яa-z]/i.test(char) && Math.random() < 0.07) {
      // простая опечатка: соседний символ по коду
      const typo = String.fromCharCode(char.charCodeAt(0) + 1);
      await textarea.type(typo, { delay: 80 + Math.random() * 70 });
      await textarea.press('Backspace');
    }
    if (char === '\n') {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    } else {
      await textarea.type(char, { delay: 80 + Math.random() * 70 });
    }
  }

  // 2. Вставляем сайты через clipboard (Ctrl+V)
  await page.evaluate(async (sites) => {
    await navigator.clipboard.writeText(sites);
  }, sitesText);
  await textarea.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('V');
  await page.keyboard.up('Control');

  await sleep(500 + Math.random() * 500);
  const sendButton = await page.$('div[class*="aspect-square"],button[type="submit"]');
  if (sendButton) {
    await sendButton.click();
  } else {
    await textarea.press('Enter');
  }
  await sleep(10000 + Math.random() * 5000);
  const answers = await page.$$eval('div[class*="prose"]', nodes => nodes.map(n => n.innerText).filter(Boolean));
  fs.writeFileSync(path.join(resultsDir, `grok_result.txt`), answers.join('\n\n'), 'utf-8');
  console.log(`Ответ на промпт сохранен в results_grok/grok_result.txt`);
  console.log('Готово. Браузер оставлен открытым для ручного контроля.');
  // Не закрываем браузер!
})(); 