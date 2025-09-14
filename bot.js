
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import fetch from "node-fetch"
import dotenv from "dotenv"
dotenv.config()


async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")

  const sock = makeWASocket({
    auth: state,
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update
    if (qr) {
      // Display QR code in terminal
      qrcode.generate(qr, { small: true })
      console.log("Scan the QR code above with your WhatsApp app.")
    }
    if (connection === "open") {
      console.log("✅ Bot connected to WhatsApp!")
    }
  })

  // Track our sent message IDs per chat to detect replies reliably
  const sentIdsByChat = new Map()
  // Track processed incoming messages to avoid double handling
  const processedMsgs = new Set()

  function isProcessed(msg) {
    const jid = msg?.key?.remoteJid
    const id = msg?.key?.id
    if (!jid || !id) return false
    const key = `${jid}|${id}`
    if (processedMsgs.has(key)) return true
    processedMsgs.add(key)
    if (processedMsgs.size > 2000) {
      // keep only the most recent ~1000 entries
      const keep = Array.from(processedMsgs).slice(-1000)
      processedMsgs.clear()
      keep.forEach(k => processedMsgs.add(k))
    }
    return false
  }

  function rememberSentId(chatId, id) {
    if (!id) return
    const arr = sentIdsByChat.get(chatId) || []
    arr.push(id)
    // keep last 50
    if (arr.length > 50) arr.shift()
    sentIdsByChat.set(chatId, arr)
  }

  function wasReplyToUs(chatId, stanzaId) {
    if (!stanzaId) return false
    const arr = sentIdsByChat.get(chatId) || []
    return arr.includes(stanzaId)
  }

  // Safely unwrap message content (handles ephemeral/viewOnce/edited wrappers)
  function unwrapMessageContent(message) {
    let content = message
    try {
      while (content?.ephemeralMessage) content = content.ephemeralMessage.message
      while (content?.viewOnceMessage) content = content.viewOnceMessage.message
      while (content?.editedMessage) content = content.editedMessage.message
    } catch (_) {}
    return content || {}
  }

  function extractTextAndContext(msg) {
    const content = unwrapMessageContent(msg.message)
    // Common message kinds where text + contextInfo can appear
    if (content?.extendedTextMessage) {
      return {
        text: content.extendedTextMessage.text || "",
        contextInfo: content.extendedTextMessage.contextInfo,
      }
    }
    if (content?.conversation) {
      return { text: content.conversation || "", contextInfo: undefined }
    }
    if (content?.imageMessage) {
      return {
        text: content.imageMessage.caption || "",
        contextInfo: content.imageMessage.contextInfo,
      }
    }
    if (content?.videoMessage) {
      return {
        text: content.videoMessage.caption || "",
        contextInfo: content.videoMessage.contextInfo,
      }
    }
    if (content?.documentMessage) {
      return {
        text: content.documentMessage.caption || "",
        contextInfo: content.documentMessage.contextInfo,
      }
    }
    // Fallback: try first key
    const firstKey = content ? Object.keys(content)[0] : undefined
    const any = firstKey ? content[firstKey] : undefined
    return {
      text: any?.text || any?.caption || "",
      contextInfo: any?.contextInfo,
    }
  }

  // ========== LLM selection logic ==========
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY
  const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1'
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'command-r7b-arabic'

  function systemArabicAnimeShort() {
    return 'أنت خبير في الأنمي اسمك سوسي. أجب فقط على الأسئلة المتعلقة بالأنمي، وباللغة العربية ألا  اذا يوجد اسماء تحتاج للكتابة باللغة الانجليزية ، ويجب أن يكون الرد صحيحًا ومختصرًا جدًا (ثلاث إلى أربع كلمات فقط).اذا كان السؤال عن افضل انمي سحر هو بلاك كلوفر, إذا كان السؤال خارج مجال الأنمي ، قل "هممم".'
  }

  async function generateWithOpenAI(userText) {
    if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY')
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemArabicAnimeShort() },
          { role: 'user', content: userText }
        ],
        temperature: 0.7,
        max_tokens: 32,
      }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenAI API ${res.status}: ${errText}`)
    }
    const json = await res.json().catch(() => null)
    const reply = json?.choices?.[0]?.message?.content || ''
    return (reply || '').trim()
  }

  // Main message handler
  sock.ev.on("messages.upsert", async (m) => {
    // process only primary notify events to reduce duplicates
    if (m?.type && m.type !== 'notify') return
  const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return
  if (msg?.messageDuplicate) return
  if (msg?.broadcast) return
    if (isProcessed(msg)) return

    const sender = msg.key.remoteJid
    const { text, contextInfo } = extractTextAndContext(msg)

    // Hotword-only trigger (both private and group)
    const isGroup = sender.includes("@g.us"); // kept for potential logging, not used in trigger
    let shouldReply = false;
    let myJid = sock.user?.id;

    function normalizeJid(jid) {
      return jid ? jid.split(":")[0] : jid;
    }

    if (text) {
      const configuredHotwords = (process.env.GROUP_HOTWORDS || 'سوسي,يا سوسي')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      const myBaseJid = normalizeJid(myJid);
      const myDigits = (myBaseJid || '').split('@')[0]
      const numberHotwords = myDigits ? [myDigits, `@${myDigits}`] : []
      const allHotwords = [...configuredHotwords, ...numberHotwords].map(h => h.toLowerCase())
      const lowerText = (text || '').toLowerCase()
      const hotwordHit = allHotwords.some(h => lowerText.includes(h))
      shouldReply = hotwordHit
    }

    if (shouldReply) {
      console.log(`📩 Message to respond: ${text}`)
      try {
        let reply = ''
        if (OPENAI_API_KEY) {
          reply = await generateWithOpenAI(text)
        } else {
          // fallback to Ollama local
          try {
            const ollamaResponse = await fetch("http://localhost:11434/api/generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt: `\n${systemArabicAnimeShort()}\n\nالرسالة: ${text}\nردك:\n`,
              })
            });
            if (!ollamaResponse.ok) {
              reply = `[Ollama error: ${ollamaResponse.status} ${ollamaResponse.statusText}]`
            } else {
              const raw = await ollamaResponse.text();
              raw.split('\n').forEach(line => {
                if (line.trim()) {
                  try {
                    const data = JSON.parse(line);
                    if (data.response) reply += data.response;
                  } catch (e) {}
                }
              });
              if (!reply.trim()) reply = '[Ollama: No response. Is the model running?]'
            }
          } catch (err) {
            reply = '[Ollama not running or unreachable]'
          }
        }
        reply = reply.trim();
        if (!reply) {
          reply = '404'
        }
        const sent = await sock.sendMessage(sender, { text: reply }, { quoted: msg });
        rememberSentId(sender, sent?.key?.id)
      } catch (err) {
        console.error("❌ LLM error:", err);
      }
    }
  })
}

startBot()


