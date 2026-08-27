# ZIP → Link

Загружаешь ZIP → сайт деплоится на Cloudflare Pages → получаешь ссылку + уведомление в Telegram.

## Деплой на Render

1. Push на GitHub
2. Render → New Web Service → подключи репо
3. Переменные:
   - CLOUDFLARE_ACCOUNT_ID
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_PAGES_PROJECT_NAME=crm-demo-sites
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
