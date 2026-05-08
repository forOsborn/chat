require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const tencentcloud = require('tencentcloud-sdk-nodejs');

const app = express();
const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3000);
const COZE_API_BASE = process.env.COZE_API_BASE || 'https://api.coze.cn';
const COZE_PAT = process.env.COZE_PAT;
const BOT_ID = process.env.BOT_ID;
const WHISPER_COMMAND = process.env.WHISPER_COMMAND || 'whisper';
const WHISPER_CPP_COMMAND = process.env.WHISPER_CPP_COMMAND || path.join(__dirname, 'tools', 'whisper.cpp', 'Release', 'whisper-cli.exe');
const WHISPER_CPP_MODEL = process.env.WHISPER_CPP_MODEL || path.join(__dirname, 'models', 'ggml-base.bin');
const FFMPEG_COMMAND = process.env.FFMPEG_COMMAND || findFfmpegCommand();
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'Chinese';
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 120000);
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY;
const TENCENT_TTS_REGION = process.env.TENCENT_TTS_REGION || 'ap-guangzhou';
const TENCENT_ASR_REGION = process.env.TENCENT_ASR_REGION || TENCENT_TTS_REGION;
const TENCENT_ASR_ENGINE = process.env.TENCENT_ASR_ENGINE || '16k_zh';
const TENCENT_TTS_VOICE_TYPE = Number(process.env.TENCENT_TTS_VOICE_TYPE || 501002);
const TENCENT_TTS_CODEC = process.env.TENCENT_TTS_CODEC || 'mp3';
const TENCENT_TTS_SAMPLE_RATE = Number(process.env.TENCENT_TTS_SAMPLE_RATE || 24000);
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(os.tmpdir(), 'coze-voice-only-audio');
const FRONTEND_DIR = path.join(__dirname, '..', 'docs');

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use('/audio', express.static(AUDIO_DIR));
app.use(express.static(FRONTEND_DIR));

const sessions = new Map();
const TtsClient = tencentcloud.tts.v20190823.Client;
const AsrClient = tencentcloud.asr.v20190614.Client;
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
const asrClient = TENCENT_SECRET_ID && TENCENT_SECRET_KEY
  ? new AsrClient({
      credential: {
        secretId: TENCENT_SECRET_ID,
        secretKey: TENCENT_SECRET_KEY
      },
      region: TENCENT_ASR_REGION,
      profile: {
        httpProfile: {
          endpoint: 'asr.tencentcloudapi.com'
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

function findFfmpegCommand() {
  const wingetFfmpeg = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'Microsoft',
    'WinGet',
    'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1.1-full_build',
    'bin',
    'ffmpeg.exe'
  );
  return fsSync.existsSync(wingetFfmpeg) ? wingetFfmpeg : 'ffmpeg';
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

function normalizeBase64Audio(audioBase64) {
  const raw = String(audioBase64 || '');
  const commaIndex = raw.indexOf(',');
  return commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw;
}

function getAudioExtension(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('webm')) return 'webm';
  if (type.includes('aac')) return 'aac';
  return 'webm';
}

async function isLikelySilentWav(filePath) {
  const buffer = await fs.readFile(filePath);
  const dataIndex = buffer.indexOf(Buffer.from('data'));
  if (dataIndex < 0 || dataIndex + 8 >= buffer.length) return false;

  const dataSize = buffer.readUInt32LE(dataIndex + 4);
  const start = dataIndex + 8;
  const end = Math.min(start + dataSize, buffer.length);
  let sumAbs = 0;
  let samples = 0;

  for (let offset = start; offset + 1 < end; offset += 2) {
    sumAbs += Math.abs(buffer.readInt16LE(offset));
    samples += 1;
  }

  if (!samples) return true;
  return sumAbs / samples < 80;
}

async function recognizeSpeechWithWhisper({ audioBuffer, mimeType }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coze-whisper-'));
  const audioPath = path.join(workDir, `speech.${getAudioExtension(mimeType)}`);

  try {
    await fs.writeFile(audioPath, audioBuffer);
    if (!fsSync.existsSync(WHISPER_CPP_COMMAND)) {
      throw new Error(`whisper.cpp command not found: ${WHISPER_CPP_COMMAND}`);
    }
    if (!fsSync.existsSync(WHISPER_CPP_MODEL)) {
      throw new Error(`whisper.cpp model not found: ${WHISPER_CPP_MODEL}`);
    }

    const wavPath = path.join(workDir, 'speech_converted.wav');
    await execFileAsync(FFMPEG_COMMAND, [
      '-y',
      '-i',
      audioPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      wavPath
    ], {
      timeout: WHISPER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 4,
      windowsHide: true
    });

    if (await isLikelySilentWav(wavPath)) return '';

    const whisperCppDir = path.dirname(WHISPER_CPP_COMMAND);
    const whisperCppModelArg = path.relative(whisperCppDir, WHISPER_CPP_MODEL);
    const outputBase = path.join(workDir, 'transcript');
    const { stdout } = await execFileAsync(WHISPER_CPP_COMMAND, [
      '-m',
      whisperCppModelArg,
      '-f',
      wavPath,
      '-l',
      'zh',
      '-otxt',
      '-of',
      outputBase
    ], {
      cwd: whisperCppDir,
      timeout: WHISPER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 4,
      windowsHide: true
    });

    const transcript = await fs.readFile(`${outputBase}.txt`, 'utf8').catch(() => '');
    return normalizeTranscript(transcript || stdout);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('Whisper command not found. Install with: pip install -U openai-whisper, and make sure ffmpeg is installed.');
    }
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeSpeech({ audioBase64, mimeType }) {
  if (false && !asrClient) {
    throw new Error('后端未配置腾讯云语音识别，请配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
  }

  const data = normalizeBase64Audio(audioBase64);
  if (!data) throw new Error('audioBase64 is required');

  const audioBuffer = Buffer.from(data, 'base64');
  if (!audioBuffer.length) throw new Error('音频数据为空');
  if (audioBuffer.length > 3 * 1024 * 1024) {
    throw new Error('单次语音不能超过 60 秒或 3MB，请缩短后重试');
  }

  const type = String(mimeType || '').toLowerCase();
  try {
    return await recognizeSpeechWithWhisper({ audioBuffer, mimeType });
  } catch (err) {
    if (!asrClient) throw err;
    console.warn('Whisper ASR warning, fallback to Tencent ASR:', err.message);
  }

  if (!asrClient) {
    throw new Error('Whisper ASR failed and Tencent ASR is not configured.');
  }

  const voiceFormat =
    type.includes('wav') ? 'wav' :
    type.includes('mp3') ? 'mp3' :
    type.includes('m4a') || type.includes('mp4') ? 'm4a' :
    type.includes('aac') ? 'aac' :
    'wav';

  const result = await asrClient.SentenceRecognition({
    EngSerViceType: TENCENT_ASR_ENGINE,
    SourceType: 1,
    VoiceFormat: voiceFormat,
    ProjectId: 0,
    SubServiceType: 2,
    UsrAudioKey: `voice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    Data: data,
    DataLen: audioBuffer.length,
    FilterDirty: 0,
    FilterModal: 0,
    FilterPunc: 0,
    ConvertNumMode: 1
  });

  return String(result?.Result || '').trim();
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

function buildNoEffectiveDialogueReport({ stageLabel, caseLabel, forceTimeUp = true }) {
  const lines = [
    forceTimeUp ? '当前阶段时间已到，本轮对话已结束。' : '',
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
  ];

  if (!forceTimeUp) {
    lines.push('', `当前阶段尚未结束。若你希望继续训练，请输入“再来一次${caseLabel}”或“开始${caseLabel}”。`);
  }

  return lines.filter(Boolean).join('\n');
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

async function cancelChat({ conversationId, chatId }) {
  if (!conversationId) throw new Error('conversationId 不能为空');

  const payload = {
    conversation_id: conversationId
  };
  if (chatId) payload.chat_id = chatId;

  try {
    return await cozeFetch('/v3/chat/cancel', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  } catch (err) {
    if (!chatId) throw err;
    return cozeFetch('/v3/chat/cancel', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: conversationId })
    });
  }
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
  const voluntaryEnding = forceTimeUp
    ? ''
    : `当前阶段尚未结束。若你希望继续训练，请输入“再来一次${caseLabel}”或“开始${caseLabel}”。`;

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
    voluntaryEnding,
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
      whisperCommand: WHISPER_COMMAND,
      whisperCppCommand: WHISPER_CPP_COMMAND,
      whisperCppModel: WHISPER_CPP_MODEL,
      whisperModel: WHISPER_MODEL,
      tencentTts: Boolean(ttsClient),
      tencentAsr: Boolean(asrClient)
    }
  });
});

app.post('/api/speech/recognize', async (req, res) => {
  try {
    const { audioBase64, mimeType } = req.body || {};
    const text = await recognizeSpeech({ audioBase64, mimeType });
    res.json({
      ok: true,
      text
    });
  } catch (err) {
    console.error('/api/speech/recognize error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
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
  let session = null;
  let chatId = '';
  try {
    const { localSessionId, content } = req.body || {};
    session = getSessionOrThrow(localSessionId);
    const text = normalizeTranscript(content);

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'content is required'
      });
    }

    const started = await startChat({
      conversationId: session.conversationId,
      userId: session.cozeUserId,
      content: text
    });
    chatId = started.chatId;
    session.activeChatId = chatId;
    session.cancelRequestedChatId = '';
    session.updatedAt = Date.now();

    const result = await waitForChatAndGetAnswer({
      conversationId: session.conversationId,
      chatId
    });

    if (session.cancelRequestedChatId === chatId) {
      return res.json({
        ok: true,
        canceled: true,
        answer: '',
        audioUrl: null
      });
    }

    session.updatedAt = Date.now();
    if (session.activeChatId === chatId) {
      session.activeChatId = '';
    }
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
    if (session && chatId && session.cancelRequestedChatId === chatId) {
      if (session.activeChatId === chatId) {
        session.activeChatId = '';
      }
      return res.json({
        ok: true,
        canceled: true,
        answer: '',
        audioUrl: null
      });
    }
    if (session && chatId && session.activeChatId === chatId) {
      session.activeChatId = '';
    }
    console.error('/api/chat/send error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/chat/cancel', async (req, res) => {
  try {
    const { localSessionId } = req.body || {};
    const session = getSessionOrThrow(localSessionId);
    const chatId = session.activeChatId;

    session.cancelRequestedChatId = chatId || '';
    session.activeChatId = '';
    session.updatedAt = Date.now();

    if (!chatId) {
      return res.json({
        ok: true,
        canceled: false,
        message: 'no active chat'
      });
    }

    try {
      await cancelChat({
        conversationId: session.conversationId,
        chatId
      });
    } catch (cancelErr) {
      console.warn('/api/chat/cancel warning:', cancelErr.message);
    }

    res.json({
      ok: true,
      canceled: true
    });
  } catch (err) {
    console.error('/api/chat/cancel error:', err);
    res.status(err.statusCode || 500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post('/api/session/score-current', async (req, res) => {
  try {
    const { localSessionId, transcript, stage } = req.body || {};
    const session = getSessionOrThrow(localSessionId);
    const currentStage = Number(stage || session.currentStage || 1);
    const stageLabel = currentStage === 2 ? '阶段二' : '阶段一';
    const caseLabel = currentStage === 2 ? '案例二' : '案例一';
    const stats = parseTranscriptStats(transcript);

    let answer = '';
    if (!stats.hasEffectiveDialogue) {
      answer = buildNoEffectiveDialogueReport({
        stageLabel,
        caseLabel,
        forceTimeUp: false
      });
    } else {
      const prompt = buildScoringPrompt({
        stageLabel,
        caseLabel,
        transcript,
        forceTimeUp: false
      });

      const result = await sendOneOffMessage({
        content: prompt,
        userId: `score_manual_${Date.now()}`
      });

      answer = result.answer;
    }

    session.updatedAt = Date.now();
    let audioUrl = null;
    try {
      audioUrl = await synthesizeSpeech(answer || '');
    } catch (ttsErr) {
      console.warn('/api/session/score-current tts warning:', ttsErr.message);
    }

    res.json({
      ok: true,
      answer,
      audioUrl
    });
  } catch (err) {
    console.error('/api/session/score-current error:', err);
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
