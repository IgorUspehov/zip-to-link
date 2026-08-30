import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

const app = express();
const upload = multer({ dest: '/tmp', limits: { fileSize: 50 * 1024 * 1024 } });
const SITES_DIR = path.join(process.cwd(), 'sites');
fs.mkdirSync(SITES_DIR, { recursive: true });

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://zip-to-link.onrender.com';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

function findSiteRoot(dir) {
  const siteDir = path.join(dir, 'site');
  if (fs.existsSync(path.join(siteDir, 'index.html'))) return siteDir;
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  const kids = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const kid of kids) {
    const inner = path.join(dir, kid.name);
    if (fs.existsSync(path.join(inner, 'index.html'))) return inner;
  }
  throw new Error('В ZIP нет index.html');
}

const FACTORY_ENGINE_ERROR =
  'В ZIP лежит движок Factory (Web Studio SDK), а не готовый сайт клиента. Не упаковывайте dist/ вручную — соберите ZIP через Delivery Center с manifest клиента.';

const ENGINE_TITLE_PATTERNS = [
  /Web Studio SDK/i,
  /движок для веб-студий/i,
  /Website\s*\+\s*CRM\s*\+\s*Online Booking/i,
  /^Website\s*\+\s*CRM/i,
];

function assertClientSiteNotEngine(src) {
  const indexPath = path.join(src, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  for (const pattern of ENGINE_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      throw new Error(FACTORY_ENGINE_ERROR);
    }
  }

  if (html.includes('__FACTORY_BOOTSTRAP__')) {
    const jsonMatch = html.match(/__FACTORY_BOOTSTRAP__\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!jsonMatch) {
      throw new Error(FACTORY_ENGINE_ERROR);
    }
    let bootstrap;
    try {
      bootstrap = JSON.parse(jsonMatch[1]);
    } catch {
      throw new Error(FACTORY_ENGINE_ERROR);
    }
    const modeOk = bootstrap.mode === 'product';
    const nameOk = Boolean(bootstrap.manifest?.business?.name);
    if (!modeOk || !nameOk) {
      throw new Error(FACTORY_ENGINE_ERROR);
    }
  }
}


app.use('/sites', express.static(SITES_DIR));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZIP → Ссылка</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;border-radius:16px;padding:2.5rem;width:min(100% - 2rem,480px);box-shadow:0 2px 20px rgba(0,0,0,.08)}
h1{font-size:1.5rem;margin-bottom:.5rem}p{color:#666;font-size:.95rem;margin-bottom:2rem}
.drop{border:2px dashed #d0d0d0;border-radius:12px;padding:2rem;text-align:center;cursor:pointer;transition:all .2s}
.drop:hover{border-color:#2563eb;background:#f0f7ff}
.drop input{display:none}
.btn{width:100%;margin-top:1.25rem;padding:.9rem;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}
.btn:disabled{background:#93c5fd;cursor:not-allowed}
#status{margin-top:1.25rem;padding:1rem;border-radius:10px;display:none;font-size:.9rem;word-break:break-all}
.info{background:#eff6ff;color:#1d4ed8}.ok{background:#ecfdf5;color:#065f46}.err{background:#fef2f2;color:#991b1b}
#filename{margin-top:.75rem;font-size:.85rem;color:#2563eb}a{color:#2563eb}
</style></head>
<body>
<div class="card">
  <h1>ZIP → Ссылка</h1>
  <p>Загрузи ZIP с готовым сайтом — получи ссылку</p>
  <div class="drop" onclick="document.getElementById('f').click()" ondragover="event.preventDefault()" ondrop="onDrop(event)">
    <div style="font-size:2.5rem">📦</div>
    <div>Перетащи ZIP или нажми</div>
    <input type="file" id="f" accept=".zip" onchange="onFile(this.files[0])">
  </div>
  <div id="filename"></div>
  <button class="btn" id="btn" onclick="upload()" disabled>Загрузить и получить ссылку</button>
  <div id="status"></div>
</div>
<script>
let file=null;
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
    if(data.url){setStatus('✅ Готово! <a href="'+data.url+'" target="_blank">'+data.url+'</a>','ok');}
    else{setStatus('❌ '+(data.error||'ошибка'),'err');}
  }catch(e){setStatus('❌ '+e.message,'err');}
  document.getElementById('btn').disabled=false;
}
</script></body></html>`);
});

app.post('/upload', upload.single('zip'), async (req, res) => {
  let unzipDir = null;
  try {
    if (!req.file) throw new Error('Нет файла');
    const slug = randomBytes(4).toString('hex');
    unzipDir = path.join('/tmp', `unzip-${slug}`);
    fs.mkdirSync(unzipDir, { recursive: true });

    new AdmZip(req.file.path).extractAllTo(unzipDir, true);
    fs.unlinkSync(req.file.path);

    const src = findSiteRoot(unzipDir);
    assertClientSiteNotEngine(src);
    const dest = path.join(SITES_DIR, slug);
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(unzipDir, { recursive: true, force: true });
    unzipDir = null;

    // Исправляем абсолютные пути /assets/ на относительные
    const indexPath = path.join(dest, 'index.html');
    if (fs.existsSync(indexPath)) {
      let html = fs.readFileSync(indexPath, 'utf8');
      html = html.replace(/src="\/assets\//g, 'src="./assets/');
      html = html.replace(/href="\/assets\//g, 'href="./assets/');
      html = html.replace(/src='\/assets\//g, "src='./assets/");
      html = html.replace(/href='\/assets\//g, "href='./assets/");
      fs.writeFileSync(indexPath, html);
    }

    const url = `${PUBLIC_URL}/sites/${slug}/`;
    let businessName = '';
    const manifestPath = path.join(dest, 'client-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        businessName = manifest.businessName || manifest.business_name || '';
      } catch {}
    }

    if (TG_TOKEN && TG_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: `✅ Сайт готов${businessName ? ' — ' + businessName : ''}\n🔗 ${url}` }),
      });
    }

    res.json({ ok: true, url });
  } catch (e) {
    if (unzipDir && fs.existsSync(unzipDir)) {
      fs.rmSync(unzipDir, { recursive: true, force: true });
    }
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/health', (_, res) => res.send('ok'));
app.listen(process.env.PORT || 3000, () => console.log('ZIP→Link запущен'));
