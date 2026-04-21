// 简单内存版会话存储
// 先跑通逻辑，后面再换数据库

const sessions = new Map();

function createOrUpdateSession(localSessionId, patch) {
  const prev = sessions.get(localSessionId) || {
    localSessionId,
    conversationId: null,
    cozeUserId: null,
    botId: null,
    startedAt: null,
    currentStage: 0,
    status: 'init',
    stage1Scored: false,
    finalScored: false
  };

  const next = { ...prev, ...patch };
  sessions.set(localSessionId, next);
  return next;
}

function getSession(localSessionId) {
  return sessions.get(localSessionId) || null;
}

function resetSession(localSessionId) {
  sessions.delete(localSessionId);
}

function listSessions() {
  return Array.from(sessions.values());
}

module.exports = {
  createOrUpdateSession,
  getSession,
  resetSession,
  listSessions
};
