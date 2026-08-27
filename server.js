const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const { execSync, exec } = require('child_process');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_PROJECT = process.env.CLOUDFLARE_PAGES_PROJECT_NAME || 'crm-demo-sites';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZIP → Ссылка</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 16px; padding: 2.5rem; width: min(100% - 2rem, 480px); box-shadow: 0 2px 20px rgba(0,0,0,0.08); }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #666; font-size: 0.95rem; margin-bottom: 2rem; }
    .drop { border: 2px dashed #d0d0d0; border-radius: 12px; padding: 2rem; text-align: center; cursor: pointer; transition: all 0.2s; }
    .drop:hover { border-color: #2563eb; background: #f0f7ff; }
    .drop input { display: none; }
    .drop-icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
    .drop-label { color: #444; font-size: 0.95rem; }
    .btn { width: 100%; margin-top: 1.25rem; padding: 0.9rem; background: #2563eb; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
    .btn:disabled { background: #93c5fd; cursor: not-allowed; }
    #status { margin-top: 1.25rem; padding: 1rem; border-radius: 10px; display: none; font-size: 0.9rem; }
    .info { background: #eff6ff; color: #1d4ed8; }
    .ok { background: #ecfdf5; color: #065f46; }
    .err { background: #fef2f2; color: #991b1b; }
    #result-url { word-break: break-all; font-weight: 600; margin-top: 0.5rem; }
    #filename { margin-top: 0.75rem; font-size: 0.85rem; color: #2563eb; }
  </style>
</head>
<body>
<div class="card">
  <h1>ZIP → Ссылка</h1>
  <p>Загрузи ZIP — получи живой сайт на Cloudflare</p>
  <div class="drop" onclick="document.getElementById('f').click()" ondragover="event.preventDefault()" ondrop="onDrop(event)">
    <div class="drop-icon">📦</div>
    <div class="drop-label">Перетащи ZIP или нажми</div>
    <input type="file" id="f" accept=".zip" onchange="onFile(this.files[0])">
  </div>
  <div id="filename"></div>
  <button class="btn" id="btn" onclick="upload()" disabled>Загрузить и задеплоить</button>
  <div id="status"></div>
  <div id="result-url"></div>
</div>
<script>
  let file = null;
  function onDrop(e) { e.preventDefault(); onFile(e.dataTransfer.files[0]); }
  function onFile(f) {
    if (!f || !f.name.endsWith('.zip')) return;
    file = f;
    document.getElementById('filename').textContent = '📎 ' + f.name;
    document.getElementById('btn').disabled = false;
  }
  function setStatus(msg, type) {
    const el = document.getElementById('status');
    el.style.display = 'block';
    el.className = type;
    el.textContent = msg;
  }
  async function upload() {
    if (!file) return;
    const btn = document.getElementById('btn');
    btn.disabled = true;
    document.getElementById('result-url').textContent = '';
    setStatus('⏳ Загружаю ZIP...', 'info');
    const fd = new FormData();
    fd.append('zip', file);
    try {
      setStatus('⏳ Собираю сайт... (1-3 минуты)', 'info');
      const res = await fetch('/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.url) {
        setStatus('✅ Готово! Сайт задеплоен:', 'ok');
        document.getElementById('result-url').innerHTML = '<a href="' + data.url + '" target="_blank">' + data.url + '</a>';
      } else {
        setStatus('❌ Ошибка: ' + (data.error || 'неизвестно'), 'err');
      }
    } catch(e) {
      setStatus('❌ ' + e.message, 'err');
    }
    btn.disabled = false;
  }
</script>
</body>
</html>`);
});

app.post('/upload', upload.single('zip'), async (req, res) => {
  const id = uuid();
  const workDir = `/tmp/build-${id}`;

  try {
    fs.mkdirSync(workDir, { recursive: true });

    await fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: workDir }))
      .promise();

    fs.unlinkSync(req.file.path);

    console.log(`[${id}] npm install...`);
    execSync('npm install --include=dev', { cwd: workDir, timeout: 120000 });

    console.log(`[${id}] npm run build...`);
    execSync('npm run build', { cwd: workDir, timeout: 120000 });

    const distDir = path.join(workDir, 'dist');
    if (!fs.existsSync(distDir)) throw new Error('dist/ не найден после сборки');

    console.log(`[${id}] Деплой на Cloudflare Pages...`);
    const url = await deployToCloudflare(distDir, id);

    await sendTelegram(`✅ Сайт готов\n🔗 ${url}`);

    fs.rmSync(workDir, { recursive: true, force: true });

    res.json({ url });
  } catch (e) {
    console.error(`[${id}] ERROR:`, e.message);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

async function deployToCloudflare(distDir, id) {
  const fetch = (await import('node-fetch')).default;
  const slug = `site-${id.slice(0, 8)}`;

  const files = getAllFiles(distDir);
  const form = new FormData();

  for (const file of files) {
    const relPath = path.relative(distDir, file);
    form.append('files', fs.createReadStream(file), { filename: relPath });
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/deployments`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, ...form.getHeaders() },
      body: form,
    }
  );

  const data = await response.json();
  if (!data.result?.url) throw new Error('Cloudflare: ' + JSON.stringify(data.errors));
  return data.result.url;
}

function getAllFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...getAllFiles(full));
    else results.push(full);
  }
  return results;
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const fetch = (await import('node-fetch')).default;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZIP→Link запущен на порту ${PORT}`));
