const COZE_API_BASE = process.env.COZE_API_BASE;
const COZE_PAT = process.env.COZE_PAT;

if (!COZE_API_BASE || !COZE_PAT) {
  throw new Error('缺少 COZE_API_BASE 或 COZE_PAT 环境变量');
}

async function callCozeChat({
  conversationId,
  botId,
  userId,
  content
}) {
  if (!conversationId) {
    throw new Error('conversationId 不能为空');
  }
  if (!botId) {
    throw new Error('botId 不能为空');
  }
  if (!userId) {
    throw new Error('userId 不能为空');
  }
  if (!content) {
    throw new Error('content 不能为空');
  }

  const url = `${COZE_API_BASE}/v3/chat?conversation_id=${encodeURIComponent(conversationId)}`;

  const body = {
    bot_id: botId,
    user_id: userId,
    stream: true,
    auto_save_history: true,
    additional_messages: [
      {
        role: 'user',
        type: 'question',
        content_type: 'text',
        content
      }
    ],
    enable_card: true
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${COZE_PAT}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Coze 调用失败 ${res.status}: ${text}`);
  }

  return {
    ok: true,
    raw: text
  };
}

async function forceScore({
  conversationId,
  botId,
  userId,
  stage
}) {
  // 最小可用版先直接发固定评分口令
  const content = '请评分';

  return callCozeChat({
    conversationId,
    botId,
    userId,
    content
  });
}

module.exports = {
  callCozeChat,
  forceScore
};
