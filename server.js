const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const { execSync } = require('child_process');
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

const jobs = {};

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZIP → Ссылка</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:2.5rem;width:min(100% - 2rem,480px);box-shadow:0 2px 20px rgba(0,0,0,.08)}
h1{font-size:1.5rem;margin-bottom:.5rem}
p{color:#666;font-size:.95rem;margin-bottom:2rem}
.drop{border:2px dashed #d0d0d0;border-radius:12px;padding:2rem;text-align:center;cursor:pointer;transition:all .2s}
.drop:hover{border-color:#2563eb;background:#f0f7ff}
.drop input{display:none}
.drop-icon{font-size:2.5rem;margin-bottom:.5rem}
.btn{width:100%;margin-top:1.25rem;padding:.9rem;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}
.btn:disabled{background:#93c5fd;cursor:not-allowed}
#status{margin-top:1.25rem;padding:1rem;border-radius:10px;display:none;font-size:.9rem}
.info{background:#eff6ff;color:#1d4ed8}
.ok{background:#ecfdf5;color:#065f46}
.err{background:#fef2f2;color:#991b1b}
#filename{margin-top:.75rem;font-size:.85rem;color:#2563eb}
a{color:#2563eb}
</style></head>
<body>
<div class="card">
  <h1>ZIP → Ссылка</h1>
  <p>Загрузи ZIP — получи живой сайт на Cloudflare</p>
  <div class="drop" onclick="document.getElementById('f').click()" ondragover="event.preventDefault()" ondrop="onDrop(event)">
    <div class="drop-icon">📦</div>
    <div>Перетащи ZIP или нажми</div>
    <input type="file" id="f" accept=".zip" onchange="onFile(this.files[0])">
  </div>
  <div id="filename"></div>
  <button class="btn" id="btn" onclick="upload()" disabled>Загрузить и задеплоить</button>
  <div id="status"></div>
</div>
<script>
let file=null,pollTimer=null;
function onDrop(e){e.preventDefault();onFile(e.dataTransfer.files[0]);}
function onFile(f){if(!f||!f.name.endsWith('.zip'))return;file=f;document.getElementById('filename').textContent='📎 '+f.name;document.getElementById('btn').disabled=false;}
function setStatus(msg,type){const el=document.getElementById('status');el.style.display='block';el.className=type;el.innerHTML=msg;}
async function upload(){
  if(!file)return;
  document.getElementById('btn').disabled=true;
  setStatus('⏳ Загружаю...','info');
  const fd=new FormData();fd.append('zip',file);
  try{
    const res=await fetch('/upload',{method:'POST',body:fd});
    const data=await res.json();
    if(data.jobId){setStatus('⏳ Собираю сайт... (1-3 минуты)','info');poll(data.jobId);}
    else{setStatus('❌ '+( data.error||'ошибка'),'err');document.getElementById('btn').disabled=false;}
  }catch(e){setStatus('❌ '+e.message,'err');document.getElementById('btn').disabled=false;}
}
function poll(id){
  pollTimer=setInterval(async()=>{
    const r=await fetch('/status/'+id);
    const d=await r.json();
    if(d.status==='done'){clearInterval(pollTimer);setStatus('✅ Готово! <a href="'+d.url+'" target="_blank">'+d.url+'</a>','ok');document.getElementById('btn').disabled=false;}
    else if(d.status==='error'){clearInterval(pollTimer);setStatus('❌ '+d.error,'err');document.getElementById('btn').disabled=false;}
    else{setStatus('⏳ '+d.step+'...','info');}
  },3000);
}
</script></body></html>`);
});

app.post('/upload', upload.single('zip'), (req, res) => {
  const id = uuid();
  jobs[id] = { status: 'pending', step: 'Распаковываю' };
  res.json({ jobId: id });
  runBuild(id, req.file.path);
});

app.get('/status/:id', (req, res) => {
  const job = jobs[req.params.id] || { status: 'error', error: 'Job not found' };
  res.json(job);
});

async function runBuild(id, zipPath) {
  const workDir = `/tmp/build-${id}`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    jobs[id].step = 'Распаковываю ZIP';

    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: workDir })).promise();
    fs.unlinkSync(zipPath);

    // Найти реальный корень проекта (где package.json)
    const projectRoot = findProjectRoot(workDir);
    if (!projectRoot) throw new Error('package.json не найден в ZIP');
    jobs[id].step = 'Нашёл проект: ' + path.relative(workDir, projectRoot);

    // Заглушки для отсутствующих файлов
    const srcDir = path.join(projectRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const indexCssPath = path.join(srcDir, 'index.css');
    if (!fs.existsSync(indexCssPath)) {
      fs.writeFileSync(indexCssPath, '/* stub */');
    }
    const mainTsxPath = path.join(srcDir, 'main.tsx');
    if (!fs.existsSync(mainTsxPath)) {
      fs.writeFileSync(mainTsxPath,
`import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
`);
    }
    // Убираем конфликт @types/react-router-dom v5
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.devDependencies) delete pkg.devDependencies['@types/react-router-dom'];
    if (pkg.dependencies) delete pkg.dependencies['@types/react-router-dom'];
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // Заглушка для vitePlugin.mjs если отсутствует
    const serverDir = path.join(projectRoot, 'server');
    const vitePluginPath = path.join(serverDir, 'vitePlugin.mjs');
    if (!fs.existsSync(vitePluginPath)) {
      fs.mkdirSync(serverDir, { recursive: true });
      fs.writeFileSync(vitePluginPath, `export default function demoApiPlugin() { return { name: 'demo-api-plugin' }; }\n`);
    }

    // Если dist/ уже есть в ZIP — пропускаем сборку
    const distDirCheck = path.join(projectRoot, 'dist');
    if (fs.existsSync(distDirCheck) && fs.readdirSync(distDirCheck).length > 0) {
      jobs[id].step = 'dist/ найден — пропускаю сборку';
      const url = await deployToCloudflare(distDirCheck);
      await sendTelegram('✅ Сайт готов\n🔗 ' + url);
      fs.rmSync(workDir, { recursive: true, force: true });
      jobs[id] = { status: 'done', url };
      return;
    }

    jobs[id].step = 'npm install';
    execSync('npm install --include=dev', { cwd: projectRoot, timeout: 180000 });

    jobs[id].step = 'npm run build';
    execSync('npm run build', { cwd: projectRoot, timeout: 180000 });

    const distDir = path.join(projectRoot, 'dist');
    if (!fs.existsSync(distDir)) throw new Error('dist/ не найден после сборки');

    jobs[id].step = 'Деплой на Cloudflare Pages';
    const url = await deployToCloudflare(distDir);

    await sendTelegram(`✅ Сайт готов\n🔗 ${url}`);
    fs.rmSync(workDir, { recursive: true, force: true });

    jobs[id] = { status: 'done', url };
  } catch (e) {
    console.error(`[${id}] ERROR:`, e.message);
    fs.rmSync(workDir, { recursive: true, force: true });
    jobs[id] = { status: 'error', error: e.message.slice(0, 300) };
  }
}

function findProjectRoot(dir) {
  // Сначала проверяем сам dir
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  // Потом смотрим на 1 уровень вглубь
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      if (fs.existsSync(path.join(sub, 'package.json'))) return sub;
    }
  }
  return null;
}

async function deployToCloudflare(distDir) {
  const fetch = (await import('node-fetch')).default;
  const form = new FormData();
  // manifest обязателен для Cloudflare Pages API
  const manifest = {};
  for (const file of getAllFiles(distDir)) {
    const relPath = path.relative(distDir, file);
    form.append('files', fs.createReadStream(file), { filename: relPath });
    manifest['/' + relPath] = relPath;
  }
  form.append('manifest', JSON.stringify(manifest));
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/deployments`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${CF_TOKEN}`, ...form.getHeaders() }, body: form }
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg }),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZIP→Link на порту ${PORT}`));
