require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const COZE_API_BASE = process.env.COZE_API_BASE || 'https://api.coze.cn';
const COZE_PAT = process.env.COZE_PAT;
const BOT_ID = process.env.BOT_ID;

if (!COZE_PAT) {
  throw new Error('缺少 COZE_PAT，请在 .env 中配置');
}
if (!BOT_ID) {
  throw new Error('缺少 BOT_ID，请在 .env 中配置');
}

app.use(cors());
app.use(express.json({ limit: '4mb' }));

const sessions = new Map();

function genLocalSessionId() {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
  const res = await fetch(`${COZE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${COZE_PAT}`,
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

  const path = `/v3/chat?conversation_id=${encodeURIComponent(conversationId)}`;

  const payload = {
    bot_id: BOT_ID,
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

async function waitForChatAndGetAnswer({ conversationId, chatId, maxPoll = 30, intervalMs = 1200 }) {
  for (let i = 0; i < maxPoll; i++) {
    const info = await retrieveChat({ conversationId, chatId });
    const status = info?.data?.status || info?.status;

    if (status === 'completed') {
      const msgData = await listChatMessages({ conversationId, chatId });
      const items = msgData?.data || [];

      const answerMsg =
        [...items].reverse().find(m => m.role === 'assistant' && m.type === 'answer') ||
        [...items].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string');

      return {
        chatInfo: info,
        messages: items,
        answer: answerMsg?.content || ''
      };
    }

    if (status === 'failed' || status === 'canceled') {
      throw new Error(`chat 状态异常: ${status}`);
    }

    await sleep(intervalMs);
  }

  throw new Error('等待 Coze 对话完成超时');
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
  res.json({ ok: true, message: 'backend running' });
});

app.post('/api/session/new', (req, res) => {
  try {
    const localSessionId = genLocalSessionId();

    const session = {
      localSessionId,
      timerStarted: false,
      currentStage: 0,
      status: 'created',
      stage1Scored: false,
      finalScored: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    sessions.set(localSessionId, session);

    res.json({
      ok: true,
      localSessionId
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
