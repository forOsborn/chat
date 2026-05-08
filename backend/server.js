require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const tencentcloud = require('tencentcloud-sdk-nodejs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COZE_API_BASE = process.env.COZE_API_BASE || 'https://api.coze.cn';
const COZE_PAT = process.env.COZE_PAT;
const BOT_ID = process.env.BOT_ID;
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY;
const TENCENT_TTS_REGION = process.env.TENCENT_TTS_REGION || 'ap-guangzhou';
const TENCENT_TTS_VOICE_TYPE = Number(process.env.TENCENT_TTS_VOICE_TYPE || 501002);
const TENCENT_TTS_CODEC = process.env.TENCENT_TTS_CODEC || 'mp3';
const TENCENT_TTS_SAMPLE_RATE = Number(process.env.TENCENT_TTS_SAMPLE_RATE || 24000);
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(os.tmpdir(), 'coze-voice-only-audio');

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use('/audio', express.static(AUDIO_DIR));

const sessions = new Map();
const TtsClient = tencentcloud.tts.v20190823.Client;
const ttsClient = TENCENT_SECRET_ID && TENCENT_SECRET_KEY
  ? new TtsClient({
      credential: {
        secretId: TENCENT_SECRET_ID,
        secretKey: TENCENT_SECRET_KEY
      },
      region: TENCENT_TTS_REGION,
      profile: {
        httpProfile: {
          endpoint: 'tts.tencentcloudapi.com'
        }
      }
    })
  : null;

function genLocalSessionId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function genCozeUserId() {
  return `nursing_training_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`.slice(0, 64);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requireConfig(name, value) {
  if (!value) {
    const err = new Error(`缺少 ${name}，请在后端环境变量中配置`);
    err.statusCode = 500;
    throw err;
  }
  return value;
}

function getSessionOrThrow(localSessionId) {
  const session = sessions.get(localSessionId);
  if (!session) {
    const err = new Error('session not found');
    err.statusCode = 404;
    throw err;
  }
  return session;
}

function normalizeTranscript(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeParentheticalText(text) {
  let result = String(text || '');
  let previous = '';
  while (result !== previous) {
    previous = result;
    result = result
      .replace(/（[^（）]*）/g, '')
      .replace(/\([^()]*\)/g, '');
  }
  return result;
}

function cleanTtsText(text) {
  return removeParentheticalText(normalizeTranscript(text))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/Powered by coze.*$/i, '')
    .replace(/\\[rnt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '')
    .replace(/[\\_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTtsText(text, maxLen = 120) {
  const source = cleanTtsText(text);
  const chunks = [];

  source.split(/(?<=[。！？!?；;])\s*/).forEach(part => {
    let rest = part.trim();
    while (rest.length > maxLen) {
      let cut = Math.max(
        rest.lastIndexOf('，', maxLen),
        rest.lastIndexOf(',', maxLen),
        rest.lastIndexOf('、', maxLen),
        rest.lastIndexOf(' ', maxLen)
      );
      if (cut < 40) cut = maxLen;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  });

  return chunks.filter(Boolean);
}

async function synthesizeSpeech(text) {
  if (!ttsClient) return null;

  const chunks = splitTtsText(text);
  if (chunks.length === 0) return null;

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  cleanupOldAudioFiles().catch(err => {
    console.warn('cleanup audio warning:', err.message);
  });

  const buffers = [];
  for (const chunk of chunks) {
    const result = await ttsClient.TextToVoice({
      Text: chunk,
      SessionId: crypto.randomUUID(),
      ModelType: 1,
      VoiceType: TENCENT_TTS_VOICE_TYPE,
      Codec: TENCENT_TTS_CODEC,
      SampleRate: TENCENT_TTS_SAMPLE_RATE
    });

    if (!result?.Audio) {
      throw new Error(`Tencent TTS returned empty audio for request ${result?.RequestId || ''}`);
    }

    buffers.push(Buffer.from(result.Audio, 'base64'));
  }

  const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${TENCENT_TTS_CODEC}`;
  const filePath = path.join(AUDIO_DIR, filename);
  await fs.writeFile(filePath, Buffer.concat(buffers));
  return `/audio/${filename}`;
}

async function cleanupOldAudioFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  const files = await fs.readdir(AUDIO_DIR).catch(() => []);

  await Promise.all(files.map(async file => {
    if (!/\.(mp3|wav|pcm)$/i.test(file)) return;
    const filePath = path.join(AUDIO_DIR, file);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || now - stat.mtimeMs < maxAgeMs) return;
    await fs.unlink(filePath).catch(() => {});
  }));
}

function parseTranscriptStats(transcript) {
  const text = normalizeTranscript(transcript);
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

  let userCount = 0;
  let assistantCount = 0;
  let validUserCount = 0;
  let validAssistantCount = 0;

  const invalidFragments = [
    '当前进入第一阶段',
    '下面是案例一的内容',
    '训练案例1',
    '【临床规范】',
    '【训练任务】',
    '请从以下引导句开始',
    '（训练标识：',
    '训练标识：'
  ];

  for (const line of lines) {
    if (line.startsWith('学员：')) {
      userCount += 1;
      const content = line.slice(3).trim();
      const isInvalid = invalidFragments.some(k => content.includes(k));
      if (!isInvalid && content.length >= 4) {
        validUserCount += 1;
      }
    } else if (line.startsWith('患者/系统：')) {
      assistantCount += 1;
      const content = line.slice(6).trim();
      const isInvalid = invalidFragments.some(k => content.includes(k));
      if (!isInvalid && content.length >= 6) {
        validAssistantCount += 1;
      }
    }
  }

  return {
    lines,
    userCount,
    assistantCount,
    validUserCount,
    validAssistantCount,
    hasEffectiveDialogue: validUserCount >= 1 && validAssistantCount >= 1
  };
}

function buildNoEffectiveDialogueReport({ stageLabel, caseLabel }) {
  return [
    '【护理差错告知能力反馈报告】',
    `阶段：${stageLabel} | 案例：${caseLabel}`,
    '',
    '一、优势项目：',
    '- 暂无：本轮尚未形成有效沟通互动，暂无法评估优势项目',
    '',
    '二、优先改进项：',
    '- 条目：尚未进入有效告知沟通',
    '- 问题：本轮仅完成案例展示、开场准备或零散发言，尚未形成完整的告知沟通往返',
    '- 建议下一句：李女士，我想和您说明一下刚才输液延迟的情况。',
    '- 场景提示：在案例信息已展示、准备正式开始向患者说明情况时使用',
    '',
    '三、综合提升方向：',
    '- 先尽快进入正式告知开场，不要停留在案例阅读阶段',
    '- 说明情况后及时观察并回应患者的第一反应',
    '- 完成至少一轮有效问答后，再进入反馈评估'
  ].join('\n');
}

async function cozeFetch(path, options = {}) {
  const cozePat = requireConfig('COZE_PAT', COZE_PAT);

  const res = await fetch(`${COZE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cozePat}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    throw new Error(`Coze HTTP ${res.status}: ${text}`);
  }

  if (json && typeof json.code !== 'undefined' && json.code !== 0) {
    throw new Error(`Coze API code=${json.code}, msg=${json.msg || ''}`);
  }

  return json ?? text;
}

async function createConversation() {
  const data = await cozeFetch('/v1/conversation/create', {
    method: 'POST',
    body: JSON.stringify({})
  });

  const conversationId =
    data?.data?.id ||
    data?.id ||
    data?.data?.conversation_id ||
    data?.conversation_id;

  if (!conversationId) {
    throw new Error(`创建会话成功，但未取到 conversation_id: ${JSON.stringify(data)}`);
  }

  return {
    conversationId,
    raw: data
  };
}

async function startChat({ conversationId, userId, content }) {
  if (!conversationId) throw new Error('conversationId 不能为空');
  if (!userId) throw new Error('userId 不能为空');
  if (!content) throw new Error('content 不能为空');
  const botId = requireConfig('BOT_ID', BOT_ID);

  const path = `/v3/chat?conversation_id=${encodeURIComponent(conversationId)}`;

  const payload = {
    bot_id: botId,
    user_id: userId,
    stream: false,
    auto_save_history: true,
    additional_messages: [
      {
        role: 'user',
        type: 'question',
        content_type: 'text',
        content
      }
    ],
    enable_card: false
  };

  const data = await cozeFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  const chatId = data?.data?.id || data?.id || data?.chat_id;
  if (!chatId) {
    throw new Error(`发起对话成功，但未取到 chat_id: ${JSON.stringify(data)}`);
  }

  return {
    chatId,
    raw: data
  };
}

async function retrieveChat({ conversationId, chatId }) {
  const path = `/v3/chat/retrieve?conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`;
  return cozeFetch(path, { method: 'GET' });
}

async function listChatMessages({ conversationId, chatId }) {
  const path = `/v3/chat/message/list?conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`;
  return cozeFetch(path, { method: 'GET' });
}

function getMessageItems(messageListResponse) {
  const data = messageListResponse?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(messageListResponse?.messages)) return messageListResponse.messages;
  return [];
}

function isFinalAnswerMessage(message) {
  if (!message || typeof message.content !== 'string' || !message.content.trim()) return false;
  if (message.role !== 'assistant') return false;

  const type = String(message.type || message.message_type || message.msg_type || '').toLowerCase();
  if (type && type !== 'answer' && type !== 'text') return false;

  const content = message.content.trim();
  if (content.startsWith('{"msg_type":"knowledge_recall"')) return false;
  if (content.includes('"msg_type":"knowledge_recall"')) return false;
  if (content.length > 3000 && /^[\[{]/.test(content)) return false;

  return true;
}

function pickAnswerMessage(items) {
  return [...items].reverse().find(isFinalAnswerMessage) || null;
}

async function waitForChatAndGetAnswer({ conversationId, chatId, maxPoll = 60, intervalMs = 1500 }) {
  let lastStatus = '';
  for (let i = 0; i < maxPoll; i++) {
    const info = await retrieveChat({ conversationId, chatId });
    const status = info?.data?.status || info?.status;
    lastStatus = status || 'unknown';

    if (status === 'completed') {
      const msgData = await listChatMessages({ conversationId, chatId });
      const items = getMessageItems(msgData);
      const answerMsg = pickAnswerMessage(items);

      if (!answerMsg?.content) {
        throw new Error('Coze 对话已完成，但未找到最终 answer 消息');
      }

      return {
        chatInfo: info,
        messages: items,
        answer: answerMsg?.content || ''
      };
    }

    if (i >= 3) {
      const msgData = await listChatMessages({ conversationId, chatId }).catch(() => null);
      const items = getMessageItems(msgData);
      const answerMsg = pickAnswerMessage(items);

      if (answerMsg?.content) {
        return {
          chatInfo: info,
          messages: items,
          answer: answerMsg.content
        };
      }
    }

    if (status === 'failed' || status === 'canceled') {
      throw new Error(`chat 状态异常: ${status}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`等待 Coze 对话完成超时，最后状态：${lastStatus}`);
}

async function sendOneOffMessage({ content, userId }) {
  const { conversationId } = await createConversation();
  const { chatId } = await startChat({
    conversationId,
    userId,
    content
  });
  const result = await waitForChatAndGetAnswer({ conversationId, chatId });
  return {
    conversationId,
    chatId,
    answer: result.answer
  };
}

function buildScoringPrompt({ stageLabel, caseLabel, transcript, forceTimeUp = true }) {
  const header = forceTimeUp
    ? '当前阶段时间已到，本轮对话已结束。'
    : '';

  return [
    '你现在不是患者，也不是案例训练角色。',
    '你现在的唯一身份是“护理差错告知沟通反馈评分员”。',
    '你必须依据《护理差错告知沟通能力行为锚定量表》的规则，输出一份结构化反馈报告。',
    '',
    '核心要求：',
    '1. 只输出反馈，不展示任何分数。',
    '2. 不要继续扮演患者。',
    '3. 不要继续和学员对话。',
    '4. 不要输出内部推理过程。',
    '5. 不要把原始对话大段复述成正文。',
    '6. 必须严格使用固定模板。',
    '',
    '量表关注点仅限以下9个条目：',
    '（1）主动说明差错事实',
    '（2）及时开启告知流程',
    '（3）共情与情绪回应',
    '（4）积极倾听与确认',
    '（5）信息清晰与完整',
    '（6）结构化表达',
    '（7）提供持续支持方案',
    '（8）关注多方福祉',
    '（9）系统改进导向',
    '',
    '输出时必须严格遵守以下模板，不得改变字段顺序：',
    header,
    '【护理差错告知能力反馈报告】',
    `阶段：${stageLabel} | 案例：${caseLabel}`,
    '',
    '一、优势项目：',
    '- 项目名称：具体表现',
    '（可多条）',
    '',
    '二、优先改进项：',
    '- 条目：条目名称',
    '- 问题：沟通中存在的问题',
    '- 建议下一句：推荐表达话术',
    '- 场景提示：在什么情况下使用',
    '',
    '三、综合提升方向：',
    '- 建议1',
    '- 建议2',
    '- 建议3',
    '',
    '额外约束：',
    '1. “建议下一句”必须是学员下一次可以直接说出口的话。',
    '2. “优先改进项”只写1条最关键的。',
    '3. “优势项目”写1到3条，结合实际表现，不要空泛。',
    '4. 不要输出“得分”“评分”“总分”等量化内容。',
    '',
    '以下是训练记录：',
    normalizeTranscript(transcript) || '（无记录）'
  ].filter(Boolean).join('\n');
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'backend running',
    config: {
      cozePat: Boolean(COZE_PAT),
      botId: Boolean(BOT_ID),
      tencentTts: Boolean(ttsClient)
    }
  });
});

app.all('/api/coze/proxy', async (req, res) => {
  try {
    const targetPath = String(req.query.path || '');
    if (!targetPath.startsWith('/v3/chat')) {
      return res.status(400).json({
        code: 400,
        msg: 'unsupported coze proxy path'
      });
    }

    const options = { method: req.method };
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      options.body = JSON.stringify(req.body || {});
    }

    const cozePat = requireConfig('COZE_PAT', COZE_PAT);
    const cozeRes = await fetch(`${COZE_API_BASE}${targetPath}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cozePat}`,
        'Content-Type': 'application/json'
      }
    });

    const text = await cozeRes.text();
    const contentType = cozeRes.headers.get('content-type');
    if (contentType) {
      res.type(contentType);
    }
    res.status(cozeRes.status).send(text);
  } catch (err) {
    console.error('/api/coze/proxy error:', err);
    res.status(500).json({
      code: 500,
      msg: err.message
    });
  }
});

app.post('/api/session/new', async (req, res) => {
  try {
    const localSessionId = genLocalSessionId();
    const cozeUserId = genCozeUserId();
    const { conversationId } = await createConversation();
    const now = Date.now();

    const session = {
      localSessionId,
      conversationId,
      cozeUserId,
      botId: BOT_ID,
      timerStarted: false,
      currentStage: 0,
      status: 'created',
      stage1Scored: false,
      finalScored: false,
      createdAt: now,
      updatedAt: now
    };

    sessions.set(localSessionId, session);

    res.json({
      ok: true,
      localSessionId,
      conversationId,
      cozeUserId
    });
  } catch (err) {
    console.error('/api/session/new error:', err);
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/session/start', (req, res) => {
  try {
    const { localSessionId } = req.body || {};
    const session = getSessionOrThrow(localSessionId);

    session.timerStarted = true;
    session.currentStage = 1;
    session.status = 'running';
    session.startedAt = Date.now();
    session.updatedAt = Date.now();

    res.json({
      ok: true,
      session
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/chat/send', async (req, res) => {
  try {
    const { localSessionId, content } = req.body || {};
    const session = getSessionOrThrow(localSessionId);
    const text = normalizeTranscript(content);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'content is required'
      });
    }

    const { chatId } = await startChat({
      conversationId: session.conversationId,
      userId: session.cozeUserId,
      content: text
    });

    const result = await waitForChatAndGetAnswer({
      conversationId: session.conversationId,
      chatId
    });

    session.updatedAt = Date.now();
    let audioUrl = null;
    try {
      audioUrl = await synthesizeSpeech(result.answer || '');
    } catch (ttsErr) {
      console.warn('/api/chat/send tts warning:', ttsErr.message);
    }

    res.json({
      ok: true,
      answer: result.answer || '',
      audioUrl
    });
  } catch (err) {
    console.error('/api/chat/send error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/session/stage1-timeup', async (req, res) => {
  try {
    const { localSessionId, transcript } = req.body || {};
    const session = getSessionOrThrow(localSessionId);

    if (session.stage1Scored) {
      return res.json({
        ok: true,
        repeated: true,
        answer: session.stage1ScoreAnswer || ''
      });
    }

    const stats = parseTranscriptStats(transcript);

    let answer = '';
    if (!stats.hasEffectiveDialogue) {
      answer = buildNoEffectiveDialogueReport({
        stageLabel: '阶段一',
        caseLabel: '案例一'
      });
    } else {
      const prompt = buildScoringPrompt({
        stageLabel: '阶段一',
        caseLabel: '案例一',
        transcript,
        forceTimeUp: true
      });

      const result = await sendOneOffMessage({
        content: prompt,
        userId: `score_stage1_${Date.now()}`
      });

      answer = result.answer;
    }

    session.stage1Scored = true;
    session.currentStage = 2;
    session.stage1ScoreAnswer = answer;
    session.status = 'stage2-ready';
    session.updatedAt = Date.now();

    res.json({
      ok: true,
      answer
    });
  } catch (err) {
    console.error('/api/session/stage1-timeup error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/session/final-timeup', async (req, res) => {
  try {
    const { localSessionId, transcript } = req.body || {};
    const session = getSessionOrThrow(localSessionId);

    if (session.finalScored) {
      return res.json({
        ok: true,
        repeated: true,
        answer: session.finalScoreAnswer || ''
      });
    }

    const stats = parseTranscriptStats(transcript);

    let answer = '';
    if (!stats.hasEffectiveDialogue) {
      answer = buildNoEffectiveDialogueReport({
        stageLabel: '阶段二',
        caseLabel: '案例二'
      });
    } else {
      const prompt = buildScoringPrompt({
        stageLabel: '阶段二',
        caseLabel: '案例二',
        transcript,
        forceTimeUp: true
      });

      const result = await sendOneOffMessage({
        content: prompt,
        userId: `score_final_${Date.now()}`
      });

      answer = result.answer;
    }

    session.finalScored = true;
    session.currentStage = 3;
    session.finalScoreAnswer = answer;
    session.status = 'finished';
    session.finishedAt = Date.now();
    session.updatedAt = Date.now();

    res.json({
      ok: true,
      answer
    });
  } catch (err) {
    console.error('/api/session/final-timeup error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/session/reset', (req, res) => {
  const { localSessionId } = req.body || {};
  if (localSessionId) {
    sessions.delete(localSessionId);
  }
  res.json({ ok: true });
});

app.get('/api/session/list', (req, res) => {
  res.json({
    ok: true,
    sessions: Array.from(sessions.values())
  });
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
