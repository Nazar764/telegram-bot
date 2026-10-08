# Life Sync Bot

Telegram-бот, який перетворює плани та розклад на реалістичний таймлайн українською мовою.

## Налаштування

Потрібен Node.js 22 або новіший. Скопіюйте `.env.example` у `.env` і вкажіть токен Telegram-бота та ключ Gemini.

```sh
npm install
npm run dev
```

Для звичайного запуску зібраної версії:

```sh
npm run build
npm start
```

`npm run typecheck` перевіряє типи без створення файлів.
