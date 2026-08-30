// 山海远程连接协议的数据模型（与桌面端 docs/山海远程连接协议.md 对齐）。
// 全部为纯 DTO，只做 JSON 反序列化，不包含业务逻辑。

/// 单个会话的状态摘要（list_sessions 返回项）
class SessionSummary {
  final String id;
  final String title;
  final String workDir;
  final bool busy;
  final bool active;
  final String modelId;
  final String modelName;
  final String approvalPolicy;
  final String currentRequest;
  final int stepCount;
  final int contextLength;
  final int lastPrompt;
  final double contextUsageRatio;
  final int turnCount;
  final bool hasIncompleteTurn;
  final bool hasRetrySnapshot;
  final int expertCount;
  final int lastActiveAt;

  SessionSummary({
    required this.id,
    required this.title,
    required this.workDir,
    required this.busy,
    required this.active,
    required this.modelId,
    required this.modelName,
    required this.approvalPolicy,
    required this.currentRequest,
    required this.stepCount,
    required this.contextLength,
    required this.lastPrompt,
    required this.contextUsageRatio,
    required this.turnCount,
    required this.hasIncompleteTurn,
    required this.hasRetrySnapshot,
    required this.expertCount,
    required this.lastActiveAt,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> j) {
    return SessionSummary(
      id: (j['id'] ?? '') as String,
      title: (j['title'] ?? '') as String,
      workDir: (j['workDir'] ?? '') as String,
      busy: (j['busy'] ?? false) as bool,
      active: (j['active'] ?? false) as bool,
      modelId: (j['modelId'] ?? '') as String,
      modelName: (j['modelName'] ?? '') as String,
      approvalPolicy: (j['approvalPolicy'] ?? 'ask') as String,
      currentRequest: (j['currentRequest'] ?? '') as String,
      stepCount: (j['stepCount'] ?? 0) as int,
      contextLength: (j['contextLength'] ?? 0) as int,
      lastPrompt: (j['lastPrompt'] ?? 0) as int,
      contextUsageRatio: ((j['contextUsageRatio'] ?? 0) as num).toDouble(),
      turnCount: (j['turnCount'] ?? 0) as int,
      hasIncompleteTurn: (j['hasIncompleteTurn'] ?? false) as bool,
      hasRetrySnapshot: (j['hasRetrySnapshot'] ?? false) as bool,
      expertCount: (j['expertCount'] ?? 0) as int,
      lastActiveAt: (j['lastActiveAt'] ?? 0) as int,
    );
  }
}

/// 工具调用过程 trace（tool-call / tool-result）
class ToolTrace {
  final String kind;
  final String sessionId;
  final String callId;
  final String name;
  final Map<String, dynamic>? args;
  final dynamic result;
  final String? error;
  final bool approvalRequired;
  final bool approved;
  final String? reasoning;
  final int? startTs;
  final int? durationMs;

  ToolTrace({
    required this.kind,
    required this.sessionId,
    required this.callId,
    required this.name,
    this.args,
    this.result,
    this.error,
    this.approvalRequired = false,
    this.approved = false,
    this.reasoning,
    this.startTs,
    this.durationMs,
  });

  factory ToolTrace.fromJson(Map<String, dynamic> j) {
    return ToolTrace(
      kind: (j['kind'] ?? 'tool-call') as String,
      sessionId: (j['sessionId'] ?? '') as String,
      callId: (j['callId'] ?? '') as String,
      name: (j['name'] ?? '') as String,
      args: j['args'] as Map<String, dynamic>?,
      result: j['result'],
      error: j['error'] as String?,
      approvalRequired: (j['approvalRequired'] ?? false) as bool,
      approved: (j['approved'] ?? false) as bool,
      reasoning: j['reasoning'] as String?,
      startTs: j['startTs'] as int?,
      durationMs: j['durationMs'] as int?,
    );
  }
}

/// 历史消息项（get_history 返回项，三种类型）
sealed class HistoryItem {
  const HistoryItem();

  static HistoryItem fromJson(Map<String, dynamic> j) {
    final kind = j['kind'] as String;
    switch (kind) {
      case 'user':
        return UserItem(
          content: (j['content'] ?? '') as String,
          attachments: (j['attachments'] as List?) ?? const [],
          turnSeq: j['turnSeq'] as int?,
        );
      case 'assistant':
        return AssistantItem(
          content: (j['content'] ?? '') as String,
          reasoningContent: j['reasoningContent'] as String?,
          turnSeq: j['turnSeq'] as int?,
          turnDuration: j['turnDuration'] as int?,
        );
      default:
        return ToolItem(
          trace: ToolTrace.fromJson((j['trace'] ?? {}) as Map<String, dynamic>),
        );
    }
  }
}

/// get_history / get_supervisor_history 的返回体：items + truncated（是否还有更早历史未返回）。
/// 后端按「最近 20 轮」截断，truncated=true 表示可上滑加载更早历史。
class HistoryResponse {
  final List<HistoryItem> items;
  final bool truncated;
  const HistoryResponse({required this.items, required this.truncated});

  factory HistoryResponse.fromJson(Map<String, dynamic> j) {
    return HistoryResponse(
      items: ((j['items'] as List?) ?? const [])
          .map((e) => HistoryItem.fromJson(e as Map<String, dynamic>))
          .toList(),
      truncated: (j['truncated'] ?? false) as bool,
    );
  }

  static const empty = HistoryResponse(items: [], truncated: false);
}

class UserItem extends HistoryItem {
  final String content;
  final List<dynamic> attachments;
  final int? turnSeq;
  const UserItem({required this.content, required this.attachments, this.turnSeq});
}

class AssistantItem extends HistoryItem {
  final String content;
  final String? reasoningContent;
  final int? turnSeq;
  final int? turnDuration;
  const AssistantItem({required this.content, this.reasoningContent, this.turnSeq, this.turnDuration});
}

class ToolItem extends HistoryItem {
  final ToolTrace trace;
  const ToolItem({required this.trace});
}

/// 审批请求（approval_request 事件）
class ApprovalRequest {
  final String id;
  final String? sessionId;
  final String toolName;
  final Map<String, dynamic> args;
  final String riskLevel;

  ApprovalRequest({required this.id, this.sessionId, required this.toolName, required this.args, required this.riskLevel});

  factory ApprovalRequest.fromJson(Map<String, dynamic> j) {
    return ApprovalRequest(
      id: (j['id'] ?? '') as String,
      sessionId: j['sessionId'] as String?,
      toolName: (j['toolName'] ?? '') as String,
      args: (j['args'] as Map?)?.cast<String, dynamic>() ?? const {},
      riskLevel: (j['riskLevel'] ?? '') as String,
    );
  }
}

/// AI 提问请求（ask_request 事件，支持单选/多选/填空/选择器）
class AskRequest {
  final String id;
  final String? sessionId;
  final String question;
  final List<String> options;
  final bool multiple;
  final String? placeholder;
  final String? kind;
  final String? reasoning;
  final List<SessionSummary>? sessionOptions;
  final List<ModelOption>? modelOptions;

  AskRequest({
    required this.id,
    this.sessionId,
    required this.question,
    required this.options,
    required this.multiple,
    this.placeholder,
    this.kind,
    this.reasoning,
    this.sessionOptions,
    this.modelOptions,
  });

  factory AskRequest.fromJson(Map<String, dynamic> j) {
    return AskRequest(
      id: (j['id'] ?? '') as String,
      sessionId: j['sessionId'] as String?,
      question: (j['question'] ?? '') as String,
      options: ((j['options'] as List?) ?? const []).map((e) => e.toString()).toList(),
      multiple: (j['multiple'] ?? false) as bool,
      placeholder: j['placeholder'] as String?,
      kind: j['kind'] as String?,
      reasoning: j['reasoning'] as String?,
      sessionOptions: (j['sessionOptions'] as List?)
          ?.map((e) => SessionSummary.fromJson(e as Map<String, dynamic>))
          .toList(),
      modelOptions: (j['modelOptions'] as List?)
          ?.map((e) => ModelOption.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}

/// 模型选择器选项
class ModelOption {
  final String id;
  final String name;
  ModelOption({required this.id, required this.name});

  factory ModelOption.fromJson(Map<String, dynamic> j) {
    return ModelOption(id: (j['id'] ?? '') as String, name: (j['name'] ?? '') as String);
  }
}

/// token 用量快照
class TokenStats {
  final int totalPrompt;
  final int totalCompletion;
  final int total;
  final int turnPrompt;
  final int turnCompletion;
  final int turn;
  final int contextLength;
  final int lastPrompt;
  final double contextUsageRatio;
  final int turnCount;

  TokenStats({
    required this.totalPrompt,
    required this.totalCompletion,
    required this.total,
    required this.turnPrompt,
    required this.turnCompletion,
    required this.turn,
    required this.contextLength,
    required this.lastPrompt,
    required this.contextUsageRatio,
    required this.turnCount,
  });

  factory TokenStats.fromJson(Map<String, dynamic> j) {
    return TokenStats(
      totalPrompt: (j['totalPrompt'] ?? 0) as int,
      totalCompletion: (j['totalCompletion'] ?? 0) as int,
      total: (j['total'] ?? 0) as int,
      turnPrompt: (j['turnPrompt'] ?? 0) as int,
      turnCompletion: (j['turnCompletion'] ?? 0) as int,
      turn: (j['turn'] ?? 0) as int,
      contextLength: (j['contextLength'] ?? 0) as int,
      lastPrompt: (j['lastPrompt'] ?? 0) as int,
      contextUsageRatio: ((j['contextUsageRatio'] ?? 0) as num).toDouble(),
      turnCount: (j['turnCount'] ?? 0) as int,
    );
  }
}
