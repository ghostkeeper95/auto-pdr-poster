# auto-pdr-poster

Automated tool that scrapes PDR (traffic rules) quizzes from [pdrtest.com](https://pdrtest.com/) and publishes them to a Telegram channel.

## Prerequisites

- Node.js >= 20
- A Telegram bot token (create one via [@BotFather](https://t.me/BotFather))
- A Telegram chat/channel ID

## Setup

```bash
npm install
```

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Usage

**Development** (runs TypeScript directly):

```bash
npm run dev
```

**Production**:

```bash
npm run build
npm start
```

A successful run prints:

```
Sending test message to Telegram...
Message sent successfully!
```
