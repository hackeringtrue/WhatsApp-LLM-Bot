# WhatsApp LLM Bot (سوسي)

A WhatsApp bot using Baileys (multi-device). It replies in Arabic as an anime expert “سوسي”, triggered by hotwords (e.g., سوسي). Uses OpenAI if configured, otherwise falls back to a local Ollama model.

## Features
- QR login (multi-file auth state)
- Hotword-triggered replies in groups/private
- Very short answers (3–4 words), off-topic => "هممم"
- OpenAI first; Ollama fallback

## Prerequisites
- Node.js 18+
- WhatsApp on your phone
- Optional: Ollama running on http://localhost:11434

## Setup
1) Install
```powershell
npm install
```
2) Create `.env` next to `bot.js`:
```ini
# Bot
GROUP_HOTWORDS=سوسي,يا سوسي

# OpenAI (recommended)
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4.1

# Ollama fallback
OLLAMA_MODEL=command-r7b-arabic
```
Important: Do not commit `.env`. Rotate any keys that were exposed.

3) Run
```powershell
npm start
```
Scan the QR in your terminal.

## Usage
Mention a hotword (e.g., “سوسي …”) in any chat. The bot will reply briefly in Arabic.

## Docker (optional)
A simple compose example:
```yaml
services:
  wa-llm-bot:
    build: .
    container_name: wa-llm-bot
    restart: unless-stopped
    environment:
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      OPENAI_MODEL: ${OPENAI_MODEL:-gpt-4.1}
      OLLAMA_MODEL: ${OLLAMA_MODEL:-command-r7b-arabic}
      GROUP_HOTWORDS: ${GROUP_HOTWORDS:-سوسي,يا سوسي}
    volumes:
      - ./auth_info:/app/auth_info
      - ./.env:/app/.env:ro
```
Run:
```powershell
docker compose up -d --build
docker compose logs -f wa-llm-bot
```

## Troubleshooting
- No reply: ensure message contains one of `GROUP_HOTWORDS`.
- OpenAI errors: verify key/model and internet access.
- Ollama: ensure service is running and model is pulled.
- `.env` must be in the directory you run `node bot.js` from.

## Security
- Never commit `.env` or `auth_info/`.
- Rotate any keys that were shared publicly.
