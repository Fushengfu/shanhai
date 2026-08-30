import 'dart:async';
import 'package:flutter/material.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';
import 'message_bubbles.dart';
import 'tool_step.dart';

/// 通用聊天视图：历史消息 + 流式渲染 + 工具步骤 + 审批/提问弹窗 + 发送。
/// 会话模式与管家模式复用（仅发送命令与历史加载回调不同），按 sessionId 过滤事件流。
class ChatView extends StatefulWidget {
  final WsClient ws;
  /// 事件过滤用会话 id（管家模式为 'supervisor'）
  final String sessionId;
  /// 标题（显示在 AppBar）
  final String title;
  /// 发送消息回调（返回命令结果）
  final Future<CmdResult> Function(String message) sendFn;
  /// 加载历史回调（返回历史消息列表 + truncated 标记）。
  /// [sinceTurnSeq] 增量：只返回该轮之后的新增轮次（任务结束时补拉，避免全量重拉）；
  /// [beforeTurnSeq] 分页：加载该轮之前的更早历史（上滑「加载更早」时用）。
  final Future<HistoryResponse> Function({int? sinceTurnSeq, int? beforeTurnSeq}) loadHistoryFn;
  /// 是否管家模式（决定停止按钮用哪个命令；管家模式无停止按钮）
  final bool isSupervisor;
  /// 进入页面时该会话是否存在未完成轮次（断点续跑入口的初始值，后续随事件查询刷新）
  final bool initialIncompleteTurn;

  const ChatView({
    super.key,
    required this.ws,
    required this.sessionId,
    required this.title,
    required this.sendFn,
    required this.loadHistoryFn,
    this.isSupervisor = false,
    this.initialIncompleteTurn = false,
  });

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();

  List<HistoryItem> _items = [];
  String _streaming = '';
  String _streamingReasoning = '';
  List<ToolTrace> _pendingTools = [];
  bool _busy = false;
  bool _loading = true;
  /// 是否还有更早历史未加载（后端按「最近 20 轮」截断时返回 true），据此显示「加载更早」入口。
  bool _truncated = false;
  /// 当前会话是否存在未完成轮次（断点续跑入口；对齐桌面端 hasIncompleteTurn）
  bool _incompleteTurn = false;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<ConnState>? _stateSub;
  /// 当前屏幕上已弹出的审批/提问请求 id（防重复弹；弹窗关闭后移除）。
  /// 用于「切走会话再切回 / 连接后才查询到」场景下，去重实时事件与主动查询两条路径。
  final Set<String> _activeRequestIds = {};
  /// requestId → 弹窗自身 context：用于桌面端/其他端处理审批/提问后，主动 pop 关闭手机端对应弹窗。
  final Map<String, BuildContext> _dialogContexts = {};

  @override
  void initState() {
    super.initState();
    _incompleteTurn = widget.initialIncompleteTurn;
    _loadHistory();
    _eventSub = widget.ws.events.listen(_onEvent);
    // 切换设备后重新配对成功（paired）时，重新加载当前会话/管家的历史数据。
    // ChatView 由 HomePage 的 IndexedStack 保活，切换设备不会重建页面，
    // 若不监听配对状态，历史会一直停留在旧设备。
    _stateSub = widget.ws.stateStream.listen((s) {
      if (s == ConnState.paired && mounted) {
        _reloadForDeviceSwitch();
      }
    });
    // 进入页面时主动查询待处理弹窗：覆盖「先弹窗后进入 / 切走会话再切回」两类错过事件的情况
    _restorePendingDialogs();
  }

  @override
  void dispose() {
    _stateSub?.cancel();
    _eventSub?.cancel();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  /// 切换设备后重载：清空旧设备的流式/工具残留，再拉取新设备历史 + 恢复待处理弹窗。
  Future<void> _reloadForDeviceSwitch() async {
    if (!mounted) return;
    setState(() {
      _streaming = '';
      _streamingReasoning = '';
      _pendingTools = [];
      _busy = false;
      _loading = true;
      _activeRequestIds.clear(); // 旧设备的弹窗 id 已失效，清空后查询新设备
    });
    await _loadHistory();
    await _restorePendingDialogs();
  }

  /// 主动查询当前会话的待处理审批/提问并恢复弹窗。
  /// 审批/提问是一次性广播事件，客户端若错过（切走会话、连接前已发出），
  /// 只能通过查询桌面端 pending 队列来恢复，否则弹窗永远看不到、工具一直阻塞等待。
  Future<void> _restorePendingDialogs() async {
    if (!mounted || widget.ws.state != ConnState.paired) return;
    try {
      final r = await widget.ws.getPendingRequests();
      if (!mounted || !r.ok || r.data is! Map) return;
      final data = r.data as Map;
      final approvals = (data['approvals'] as List?) ?? const [];
      final asks = (data['asks'] as List?) ?? const [];
      for (final a in approvals) {
        if (a is! Map) continue;
        final req = ApprovalRequest.fromJson(a.cast<String, dynamic>());
        if (req.sessionId == widget.sessionId) _showApproval(req);
      }
      for (final q in asks) {
        if (q is! Map) continue;
        final req = AskRequest.fromJson(q.cast<String, dynamic>());
        if (req.sessionId == widget.sessionId) _showAsk(req);
      }
    } catch (_) {
      // 查询失败静默忽略（下次配对成功 / 重新进入页面时再试）
    }
  }

  Future<void> _loadHistory() async {
    try {
      final resp = await widget.loadHistoryFn();
      if (!mounted) return;
      setState(() {
        _items = resp.items;
        _truncated = resp.truncated;
        _loading = false;
      });
      _scrollToBottom();
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 任务结束（完成/中断/报错）时：把流式气泡 + pending 工具落成最终气泡，不再全量重拉历史。
  /// 若本地没有流式内容（可能错过了 delta 事件流），则用 sinceTurnSeq 增量补拉新增轮次兜底。
  Future<void> _finishTurn() async {
    final hasLocal = _streaming.isNotEmpty || _streamingReasoning.isNotEmpty || _pendingTools.isNotEmpty;
    if (hasLocal) {
      _commitStreamingToItems();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _loading = false;
      });
      _scrollToBottom();
    } else {
      // 本地无流式内容：增量补拉新增轮次（数据量小，非全量）
      await _incrementalRefresh();
    }
    _refreshIncompleteTurn();
  }

  /// 把当前流式气泡 + pending 工具落成一个最终 assistant 气泡追加到 _items。
  /// tool 步骤先作为 ToolItem 追加，_buildNodes 会自动聚合到紧随其后的 assistant 气泡内。
  void _commitStreamingToItems() {
    final hasContent = _streaming.isNotEmpty || _streamingReasoning.isNotEmpty || _pendingTools.isNotEmpty;
    if (!hasContent) return;
    for (final t in _pendingTools) {
      _items.add(ToolItem(trace: t));
    }
    _items.add(AssistantItem(
      content: _streaming,
      reasoningContent: _streamingReasoning.isEmpty ? null : _streamingReasoning,
      turnSeq: null,
      turnDuration: null,
    ));
    _streaming = '';
    _streamingReasoning = '';
    _pendingTools = [];
  }

  /// 增量补拉：用「本地最大 turnSeq」作为 sinceTurnSeq，只拉新增轮次并追加（不重建全量）。
  Future<void> _incrementalRefresh() async {
    if (!mounted) return;
    try {
      int maxSeq = 0;
      for (final it in _items) {
        if (it is UserItem && it.turnSeq != null && it.turnSeq! > maxSeq) maxSeq = it.turnSeq!;
        if (it is AssistantItem && it.turnSeq != null && it.turnSeq! > maxSeq) maxSeq = it.turnSeq!;
      }
      final resp = await widget.loadHistoryFn(sinceTurnSeq: maxSeq);
      if (!mounted) return;
      setState(() {
        if (resp.items.isNotEmpty) _items.addAll(resp.items);
        _truncated = resp.truncated;
        _busy = false;
        _loading = false;
      });
      _scrollToBottom();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _streaming = '';
        _streamingReasoning = '';
        _busy = false;
      });
    }
  }

  /// 加载更早历史：用「当前已加载的最早 turnSeq」作为 beforeTurnSeq，请求更早一轮分页，
  /// 结果头插到 _items 前面（保持正序）。
  Future<void> _loadEarlier() async {
    if (!mounted || _busy) return;
    int minSeq = 1 << 30;
    for (final it in _items) {
      if (it is UserItem && it.turnSeq != null && it.turnSeq! < minSeq) minSeq = it.turnSeq!;
    }
    try {
      final resp = await widget.loadHistoryFn(beforeTurnSeq: minSeq == (1 << 30) ? null : minSeq);
      if (!mounted) return;
      setState(() {
        if (resp.items.isNotEmpty) _items = [...resp.items, ..._items];
        _truncated = resp.truncated;
      });
    } catch (_) {
      // 静默忽略（下次上滑再试）
    }
  }

  /// 滚回最新消息。列表采用 reverse 布局，offset 0 即最新消息（视觉底部），
  /// 用 jumpTo 瞬时定位，避开 animateTo 目标值在懒加载列表下被低估的问题。
  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.jumpTo(0);
      }
    });
  }

  void _onEvent(ServerEvent e) {
    if (!mounted) return;
    final sid = e.payload['sessionId']?.toString();
    switch (e.event) {
      case 'delta':
        if (sid == widget.sessionId) {
          setState(() {
            // 桌面端（管家）发起的任务：手机端未参与发送，可能已错过 session_activity(start)，
            // _busy 仍为 false 会导致流式气泡不渲染。到达 delta 即进入流式态，实时显示回复。
            if (!_busy) _busy = true;
            _streaming += e.payload['text']?.toString() ?? '';
          });
          _scrollToBottom();
        }
        break;
      case 'reasoning':
        if (sid == widget.sessionId) {
          setState(() {
            if (!_busy) _busy = true;
            _streamingReasoning += e.payload['text']?.toString() ?? '';
          });
        }
        break;
      case 'tool_trace':
        final t = ToolTrace.fromJson(e.payload);
        if (t.sessionId == widget.sessionId) {
          setState(() {
            if (!_busy) _busy = true;
            if (t.kind == 'tool-call') {
              _pendingTools.add(t);
            } else {
              final idx = _pendingTools.indexWhere((x) => x.callId == t.callId && x.kind == 'tool-call');
              if (idx >= 0) {
                _pendingTools[idx] = t;
              } else {
                _pendingTools.add(t);
              }
            }
          });
          _scrollToBottom();
        }
        break;
      case 'session_activity':
        if (sid == widget.sessionId) {
          final kind = e.payload['kind'];
          if (kind == 'start') {
            setState(() {
              _busy = true;
              _streaming = '';
              _streamingReasoning = '';
              _pendingTools = [];
            });
          } else if (kind == 'end') {
            // 闪屏修复：先异步拉历史重建 _items（含 assistant 气泡），再一次性清空流式 + 置 busy=false，
            // 消除「先同步清流式、后异步重建 items」之间的空窗（正文消失→等一会→重现）。
            _finishTurn();
          }
        }
        break;
      case 'user_message':
        if (sid == widget.sessionId) {
          _addUserMessage(e.payload['message']?.toString() ?? '');
        }
        break;
      case 'approval_request':
        final req = ApprovalRequest.fromJson(e.payload);
        if (req.sessionId == widget.sessionId) {
          _showApproval(req);
        }
        break;
      case 'ask_request':
        final req = AskRequest.fromJson(e.payload);
        if (req.sessionId == widget.sessionId) {
          _showAsk(req);
        }
        break;
      case 'approval_resolved':
        // 桌面端/其他端已处理审批：关闭手机端对应弹窗
        _dismissRequestDialog(e.payload['requestId']?.toString() ?? '');
        break;
      case 'ask_resolved':
        // 桌面端/其他端已处理提问：关闭手机端对应弹窗
        _dismissRequestDialog(e.payload['requestId']?.toString() ?? '');
        break;
      case 'error':
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.payload['message']?.toString() ?? '出错')),
        );
        break;
    }
  }

  void _addUserMessage(String content) {
    if (content.isEmpty) return;
    setState(() {
      // 去重：末尾已是同内容 user 气泡则跳过（发送时乐观添加 + user_message 事件可能重复）
      if (_items.isNotEmpty && _items.last is UserItem && (_items.last as UserItem).content == content) return;
      _items.add(UserItem(content: content, attachments: const [], turnSeq: null));
    });
    _scrollToBottom();
  }

  Future<void> _send(String text) async {
    final content = text.trim();
    if (content.isEmpty || _busy) return;
    _inputCtrl.clear();
    // 乐观添加 user 气泡
    setState(() {
      _items.add(UserItem(content: content, attachments: const [], turnSeq: null));
      _busy = true;
      _streaming = '';
      _streamingReasoning = '';
      _pendingTools = [];
    });
    _scrollToBottom();
    await widget.sendFn(content);
  }

  void _stop() {
    widget.ws.sendCommand('stop_session', {'sessionId': widget.sessionId});
  }

  /// 重新发送（重试）/ 编辑后重发：截断到目标用户消息之前，重新生成。
  /// 与桌面端 resend 同语义：userMessageIndex 为第几条用户消息（0 起，跳过注入消息）。
  Future<void> _resend(int userMessageIndex, String? newContent) async {
    if (_busy) return;
    final payload = <String, dynamic>{
      'sessionId': widget.sessionId,
      'userMessageIndex': userMessageIndex,
    };
    if (newContent != null) payload['newContent'] = newContent;
    await widget.ws.sendCommand('resend', payload);
  }

  /// 编辑并重发：先乐观更新本地气泡内容，再触发 resend（带 newContent）。
  Future<void> _editAndResend(int itemIndex, int userMessageIndex, String newContent) async {
    if (_busy) return;
    setState(() {
      final newItems = List<HistoryItem>.of(_items);
      final old = newItems[itemIndex];
      if (old is UserItem) {
        newItems[itemIndex] = UserItem(content: newContent, attachments: old.attachments, turnSeq: old.turnSeq);
      }
      _items = newItems;
    });
    await _resend(userMessageIndex, newContent);
  }

  /// 断点续跑：保留已执行步骤，从断点继续（桌面端 resume 同语义）。
  /// 后端会广播 session_activity(start)/delta 等，由 _onEvent 进入流式态实时渲染。
  void _resume() {
    if (_busy) return;
    setState(() => _incompleteTurn = false);
    widget.ws.sendCommand('resume', {'sessionId': widget.sessionId});
  }

  /// 查询当前会话是否仍有未完成轮次（决定「继续执行」按钮显隐）。
  /// 桌面端 hasIncompleteTurn 随任务结束状态变化，会话结束/中断后需重新查询。
  Future<void> _refreshIncompleteTurn() async {
    if (!mounted || widget.ws.state != ConnState.paired) return;
    try {
      final r = await widget.ws.sendCommand('list_sessions');
      if (!mounted || !r.ok || r.data is! List) return;
      final sessions = (r.data as List)
          .map((e) => SessionSummary.fromJson(e as Map<String, dynamic>))
          .toList();
      final target = sessions.where((s) => s.id == widget.sessionId);
      if (target.isNotEmpty && mounted) {
        setState(() => _incompleteTurn = target.first.hasIncompleteTurn);
      }
    } catch (_) {
      // 查询失败静默忽略（下次会话事件时再刷新）
    }
  }

  // —— 审批弹窗 ——
  /// 风险等级 → 标签颜色（高危红 / 可逆琥珀 / 只读绿 / 其他灰）
  Color _riskColor(String level) {
    switch (level) {
      case 'high':
      case 'irreversible':
        return const Color(0xFFEF4444);
      case 'reversible':
        return const Color(0xFFF59E0B);
      case 'readonly':
        return const Color(0xFF34D399);
      default:
        return const Color(0xFF9CA3AF);
    }
  }

  Widget _riskBadge(String level) {
    final color = _riskColor(level);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(riskLevelLabel(level), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
    );
  }

  /// 统一弹出并跟踪审批/提问弹窗：保存弹窗 context 以便「其他端已处理」时能主动关闭；
  /// 弹窗关闭后统一清理去重标记与 context 引用。
  void _showTrackedDialog(String requestId, WidgetBuilder builder) {
    showDialog<void>(
      context: context,
      builder: (ctx) {
        _dialogContexts[requestId] = ctx;
        return builder(ctx);
      },
    ).then((_) => _cleanupRequest(requestId));
  }

  /// 弹窗关闭后的统一清理（无论响应/拒绝/取消/点击外部关闭/被主动关闭）
  void _cleanupRequest(String requestId) {
    _activeRequestIds.remove(requestId);
    _dialogContexts.remove(requestId);
  }

  /// 桌面端/其他端已处理该审批/提问时，主动关闭手机端对应弹窗并清理标记。
  void _dismissRequestDialog(String requestId) {
    if (requestId.isEmpty) return;
    final ctx = _dialogContexts.remove(requestId);
    _activeRequestIds.remove(requestId);
    if (ctx != null && ctx.mounted) {
      Navigator.of(ctx).pop();
    }
  }

  /// 弹窗内容区最大高度：保证标题 + 内容 + 底部按钮始终都在屏幕内，
  /// 内容过多时在内部滚动，底部「拒绝/允许/提交/取消」按钮不会被顶出屏幕。
  double _dialogContentMaxHeight(BuildContext ctx) =>
      MediaQuery.of(ctx).size.height * 0.55;

  void _showApproval(ApprovalRequest req) {
    if (!mounted || _activeRequestIds.contains(req.id)) return;
    _activeRequestIds.add(req.id);
    _showTrackedDialog(req.id, (ctx) => AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      backgroundColor: const Color(0xFF1C1C26),
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      titlePadding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      actionsPadding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      title: const Row(
        children: [
          Icon(Icons.warning_amber_rounded, size: 20, color: Color(0xFFF59E0B)),
          SizedBox(width: 10),
          Expanded(
            child: Text('需要确认操作', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Color(0xFFF2F2F7))),
          ),
        ],
      ),
      content: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: _dialogContentMaxHeight(ctx)),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 工具名（中文映射）独立一行，风险等级用彩色标签
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      friendlyToolName(req.toolName, req.args),
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Color(0xFFE0E0E0)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  _riskBadge(req.riskLevel),
                ],
              ),
              const SizedBox(height: 12),
              approvalArgsWidget(req.toolName, req.args),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('respond_approval', {'requestId': req.id, 'outcome': 'rejected'});
          },
          child: const Text('拒绝', style: TextStyle(color: Color(0xFF9CA3AF))),
        ),
        FilledButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('respond_approval', {'requestId': req.id, 'outcome': 'allowed-once'});
          },
          child: const Text('允许一次'),
        ),
      ],
    ));
  }

  // —— 提问/选择器弹窗 ——
  /// 统一提问弹窗骨架：标题「AI 需要你的确认」+ 问题正文 + reasoning 折叠 + 自定义 body + 底部动作。
  /// 对齐桌面端 AskCard 的信息层级（标题 / 问题 / 为什么问 / 选项或输入）。
  Widget _askShell({required AskRequest req, required Widget body, required List<Widget> actions}) {
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      backgroundColor: const Color(0xFF1C1C26),
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      titlePadding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      actionsPadding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      title: const Row(
        children: [
          Icon(Icons.help_outline, size: 18, color: Color(0xFF22D3EE)),
          SizedBox(width: 8),
          Expanded(
            child: Text('AI 需要你的确认', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFFF2F2F7))),
          ),
        ],
      ),
      content: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: _dialogContentMaxHeight(context)),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (req.question.trim().isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(req.question, style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0), height: 1.45)),
                ),
              if (req.reasoning != null && req.reasoning!.isNotEmpty) _ReasoningDisclosure(req.reasoning!),
              body,
            ],
          ),
        ),
      ),
      actions: actions,
    );
  }

  void _showAsk(AskRequest req) {
    if (!mounted || _activeRequestIds.contains(req.id)) return;
    _activeRequestIds.add(req.id);
    if (req.kind == 'session-picker' && req.sessionOptions != null && req.sessionOptions!.isNotEmpty) {
      _showSessionPicker(req);
    } else if (req.kind == 'model-picker' && req.modelOptions != null && req.modelOptions!.isNotEmpty) {
      _showModelPicker(req);
    } else if (req.options.isNotEmpty) {
      _showOptionsAsk(req);
    } else {
      _showTextAsk(req);
    }
  }

  void _showSessionPicker(AskRequest req) {
    _showTrackedDialog(req.id, (ctx) => _askShell(
      req: req,
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: req.sessionOptions!.map((s) {
          return ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: Icon(s.busy ? Icons.sync : Icons.forum_outlined, size: 18, color: s.busy ? const Color(0xFF22D3EE) : Colors.grey),
            title: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14)),
            subtitle: Text('${s.modelName} · ${s.stepCount} 步', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
            onTap: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': s.id});
            },
          );
        }).toList(),
      ),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
          },
          child: const Text('取消', style: TextStyle(color: Color(0xFF9CA3AF))),
        ),
      ],
    ));
  }

  void _showModelPicker(AskRequest req) {
    _showTrackedDialog(req.id, (ctx) => _askShell(
      req: req,
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: req.modelOptions!.map((m) {
          return ListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: const Icon(Icons.memory, size: 18, color: Colors.grey),
            title: Text(m.name, style: const TextStyle(fontSize: 14)),
            onTap: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': m.id});
            },
          );
        }).toList(),
      ),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
          },
          child: const Text('取消', style: TextStyle(color: Color(0xFF9CA3AF))),
        ),
      ],
    ));
  }

  void _showOptionsAsk(AskRequest req) {
    _showTrackedDialog(req.id, (ctx) => _OptionsAskDialog(
      req: req,
      onSubmit: (answer) {
        Navigator.pop(ctx);
        widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': answer});
      },
      onCancel: () {
        Navigator.pop(ctx);
        widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
      },
    ));
  }

  void _showTextAsk(AskRequest req) {
    final ctrl = TextEditingController();
    _showTrackedDialog(req.id, (ctx) => _askShell(
      req: req,
      body: TextField(
        controller: ctrl,
        autofocus: true,
        minLines: 1,
        maxLines: 4,
        style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0)),
        decoration: InputDecoration(
          hintText: req.placeholder ?? '请输入你的回答',
          hintStyle: const TextStyle(fontSize: 14, color: Color(0xFF5A5A5A)),
          filled: true,
          fillColor: const Color(0xFF262633),
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
        ),
        onSubmitted: (v) {
          Navigator.pop(ctx);
          widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': v});
        },
      ),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
          },
          child: const Text('取消', style: TextStyle(color: Color(0xFF9CA3AF))),
        ),
        FilledButton(
          onPressed: () {
            Navigator.pop(ctx);
            widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': ctrl.text});
          },
          child: const Text('确定'),
        ),
      ],
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        backgroundColor: Colors.transparent,
        actions: [
          if (_busy && !widget.isSupervisor)
            IconButton(onPressed: _stop, icon: const Icon(Icons.stop_circle_outlined), tooltip: '停止任务'),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _buildList(),
          ),
          if (_incompleteTurn && !_busy) _buildResumeBar(),
          _buildComposer(),
        ],
      ),
    );
  }

  /// 预计算「渲染块」索引（只记下标，不构建 Widget）：一轮聚合为一个块——
  /// user 独立成块；连续的 tool 步骤与紧随其后的 assistant 合并成一个 assistant 块；
  /// 尾部残留 tool（任务中断无收尾）独立成 tools 块。
  /// 这样 ListView.builder 的 itemBuilder 按块惰性构建 Widget，避免一次性物化全部节点。
  List<_Block> _buildBlocks() {
    final blocks = <_Block>[];
    var toolStart = -1; // 连续 tool 的起始下标
    var userIdx = 0;
    for (var i = 0; i < _items.length; i++) {
      final item = _items[i];
      if (item is UserItem) {
        if (toolStart >= 0) {
          blocks.add(_Block('tools', toolStart, i));
          toolStart = -1;
        }
        final msgIdx = item.turnSeq != null ? item.turnSeq! - 1 : userIdx;
        blocks.add(_Block('user', i, i + 1, msgIdx));
        userIdx++;
      } else if (item is AssistantItem) {
        blocks.add(_Block('assistant', toolStart >= 0 ? toolStart : i, i + 1));
        toolStart = -1;
      } else if (item is ToolItem) {
        if (toolStart < 0) toolStart = i;
      }
    }
    if (toolStart >= 0) blocks.add(_Block('tools', toolStart, _items.length));
    return blocks;
  }

  /// 按块惰性构建单个 Widget（只在 itemBuilder 拉到可视区时调用）。
  Widget _buildBlock(_Block b) {
    switch (b.type) {
      case 'user':
        final item = _items[b.start] as UserItem;
        return UserBubble(
          content: item.content,
          onResend: () => _resend(b.userMsgIdx, null),
          onEdit: (newContent) => _editAndResend(b.start, b.userMsgIdx, newContent),
        );
      case 'assistant':
        final item = _items[b.end - 1] as AssistantItem;
        final tools = <ToolTrace>[
          for (var i = b.start; i < b.end - 1; i++) (_items[i] as ToolItem).trace,
        ];
        return AssistantBubble(
          content: item.content,
          reasoning: item.reasoningContent,
          toolSteps: tools,
          turnDuration: item.turnDuration,
        );
      default: // tools
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = b.start; i < b.end; i++) ToolStepWidget(trace: (_items[i] as ToolItem).trace),
          ],
        );
    }
  }

  Widget _buildList() {
    final blocks = _buildBlocks();
    final extraBusy = _busy ? 1 : 0;
    final extraEarlier = _truncated ? 1 : 0;
    final itemCount = blocks.length + extraBusy + extraEarlier;
    return ListView.builder(
      controller: _scrollCtrl,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      itemCount: itemCount,
      itemBuilder: (ctx, i) {
        // reverse 列表：i=0 是视觉底部（最新），i=itemCount-1 是视觉顶部（最早）。
        // 流式气泡固定在底部；历史块按「新→旧」向上排列；「加载更早」入口在最顶部。
        if (_busy && i == 0) return _buildStreamingBubble();
        final blockIdx = i - extraBusy;
        if (blockIdx < blocks.length) {
          return _buildBlock(blocks[blocks.length - 1 - blockIdx]);
        }
        return _buildLoadEarlierBar();
      },
    );
  }

  /// 「加载更早」入口：当后端按「最近 20 轮」截断（truncated=true）时，在列表顶部显示，
  /// 点击用 beforeTurnSeq 分页拉取更早历史。
  Widget _buildLoadEarlierBar() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Center(
        child: TextButton.icon(
          onPressed: _loadEarlier,
          icon: const Icon(Icons.expand_less, size: 16, color: Color(0xFF808080)),
          label: const Text('加载更早历史', style: TextStyle(fontSize: 12, color: Color(0xFF808080))),
        ),
      ),
    );
  }

  /// 「继续执行」提示条：任务中断后显示，点击从断点续跑（对齐桌面端 continue 入口）。
  Widget _buildResumeBar() {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
        child: Row(
          children: [
            const Icon(Icons.play_circle_outline, size: 18, color: Color(0xFF22D3EE)),
            const SizedBox(width: 8),
            const Expanded(
              child: Text(
                '任务已中断，可继续执行',
                style: TextStyle(fontSize: 13, color: Color(0xFFE0E0E0)),
              ),
            ),
            FilledButton.tonal(
              onPressed: _resume,
              child: const Text('继续执行'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStreamingBubble() {
    return AssistantBubble(
      content: _streaming,
      reasoning: _streamingReasoning,
      toolSteps: _pendingTools,
      thinking: true,
    );
  }

  Widget _buildComposer() {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _inputCtrl,
                minLines: 1,
                maxLines: 5,
                textInputAction: TextInputAction.newline,
                onSubmitted: (_) => _send(_inputCtrl.text),
                decoration: InputDecoration(
                  hintText: widget.isSupervisor ? '对管家说…' : '发送消息…',
                  hintStyle: TextStyle(fontSize: 14, color: Colors.grey.shade600),
                  filled: true,
                  fillColor: const Color(0xFF1A1A24),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(22), borderSide: BorderSide.none),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: () => _send(_inputCtrl.text),
              icon: const Icon(Icons.arrow_upward),
              tooltip: '发送',
            ),
          ],
        ),
      ),
    );
  }
}

/// 渲染块：只记录在 _items 中的下标区间，不持有 Widget。
/// type: 'user'（单个用户气泡）/ 'assistant'（一个 assistant 气泡，含前面聚合的 tool 步骤）/ 'tools'（尾部残留工具步骤）。
class _Block {
  final String type;
  final int start; // 在 _items 中的起始下标（含）
  final int end; // 在 _items 中的结束下标（不含）
  final int userMsgIdx; // user 块的 resend 序号（对齐 userMessageIndex）
  const _Block(this.type, this.start, this.end, [this.userMsgIdx = 0]);
}

/// 提问弹窗内「AI 为什么问你」折叠区（对齐桌面端 AskCard 的 reasoning details）
class _ReasoningDisclosure extends StatefulWidget {
  final String text;
  const _ReasoningDisclosure(this.text);

  @override
  State<_ReasoningDisclosure> createState() => _ReasoningDisclosureState();
}

class _ReasoningDisclosureState extends State<_ReasoningDisclosure> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            borderRadius: BorderRadius.circular(6),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(_open ? Icons.expand_more : Icons.chevron_right, size: 16, color: const Color(0xFF808080)),
                  const SizedBox(width: 2),
                  const Text('AI 为什么问你（点开看背景）', style: TextStyle(fontSize: 12, color: Color(0xFF808080))),
                ],
              ),
            ),
          ),
          if (_open)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.all(8),
              constraints: const BoxConstraints(maxHeight: 160),
              decoration: BoxDecoration(color: const Color(0xFF262633), borderRadius: BorderRadius.circular(8)),
              child: SingleChildScrollView(
                child: Text(widget.text, style: const TextStyle(fontSize: 12, color: Color(0xFFB0B0B0), height: 1.5)),
              ),
            ),
        ],
      ),
    );
  }
}

/// 单选/多选提问弹窗：对齐桌面端 AskCard，支持「其他（自定义填写）」入口。
/// 单选/多选均点选高亮后点「提交」；选项都不符合时可切换为自由文本输入。
class _OptionsAskDialog extends StatefulWidget {
  final AskRequest req;
  final void Function(String answer) onSubmit;
  final VoidCallback onCancel;

  const _OptionsAskDialog({required this.req, required this.onSubmit, required this.onCancel});

  @override
  State<_OptionsAskDialog> createState() => _OptionsAskDialogState();
}

class _OptionsAskDialogState extends State<_OptionsAskDialog> {
  final Set<String> _selected = {};
  final TextEditingController _textCtrl = TextEditingController();
  bool _customMode = false;

  AskRequest get req => widget.req;
  bool get _multiple => req.multiple;
  double get _maxContentHeight => MediaQuery.of(context).size.height * 0.55;

  bool get _canSubmit {
    if (_customMode) return _textCtrl.text.trim().isNotEmpty;
    return _selected.isNotEmpty;
  }

  void _toggle(String opt) {
    setState(() {
      if (_multiple) {
        if (_selected.contains(opt)) {
          _selected.remove(opt);
        } else {
          _selected.add(opt);
        }
      } else {
        _selected
          ..clear()
          ..add(opt);
      }
    });
  }

  void _enterCustom() {
    setState(() {
      _customMode = true;
      _selected.clear();
    });
  }

  void _submit() {
    if (!_canSubmit) return;
    final answer = _customMode ? _textCtrl.text.trim() : _selected.toList().join('、');
    widget.onSubmit(answer);
  }

  @override
  void dispose() {
    _textCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      backgroundColor: const Color(0xFF1C1C26),
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      titlePadding: const EdgeInsets.fromLTRB(20, 20, 20, 0),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      actionsPadding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      title: const Row(
        children: [
          Icon(Icons.help_outline, size: 18, color: Color(0xFF22D3EE)),
          SizedBox(width: 8),
          Expanded(
            child: Text('AI 需要你的确认', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFFF2F2F7))),
          ),
        ],
      ),
      content: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: _maxContentHeight),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (req.question.trim().isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(req.question, style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0), height: 1.45)),
                ),
              if (req.reasoning != null && req.reasoning!.isNotEmpty) _ReasoningDisclosure(req.reasoning!),
              SizedBox(
                width: double.maxFinite,
                child: _customMode ? _buildCustomInput() : _buildOptions(),
              ),
            ],
          ),
        ),
      ),
      actions: [
        if (_customMode)
          TextButton(
            onPressed: () {
              setState(() {
                _customMode = false;
                _textCtrl.clear();
              });
            },
            child: const Text('返回选项', style: TextStyle(color: Color(0xFF9CA3AF))),
          ),
        TextButton(
          onPressed: widget.onCancel,
          child: const Text('取消', style: TextStyle(color: Color(0xFF9CA3AF))),
        ),
        FilledButton(
          onPressed: _canSubmit ? _submit : null,
          child: Text(_multiple ? '确定' : '提交'),
        ),
      ],
    );
  }

  Widget _buildOptions() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final opt in req.options) _optionRow(opt),
        if (_multiple)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('可多选，已选 ${_selected.length} 项', style: const TextStyle(fontSize: 11, color: Color(0xFF808080))),
          ),
        // 选项都不符合时：切换到自定义填写（对齐桌面端 AskCard）
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: InkWell(
            onTap: _enterCustom,
            borderRadius: BorderRadius.circular(8),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xFF262633),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFF3A3A3C)),
              ),
              child: const Row(
                children: [
                  Icon(Icons.add, size: 16, color: Color(0xFF808080)),
                  SizedBox(width: 8),
                  Text('其他（自定义填写）', style: TextStyle(fontSize: 13, color: Color(0xFFB0B0B0))),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _optionRow(String opt) {
    final active = _selected.contains(opt);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: InkWell(
        onTap: () => _toggle(opt),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: active ? const Color(0xFF2A2A3A) : const Color(0xFF262633),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: active ? const Color(0xFF22D3EE) : const Color(0xFF3A3A3C)),
          ),
          child: Row(
            children: [
              if (_multiple)
                Container(
                  width: 16,
                  height: 16,
                  decoration: BoxDecoration(
                    color: active ? const Color(0xFF22D3EE) : Colors.transparent,
                    borderRadius: BorderRadius.circular(4),
                    border: Border.all(color: active ? const Color(0xFF22D3EE) : const Color(0xFF5A5A5A)),
                  ),
                  alignment: Alignment.center,
                  child: active ? const Icon(Icons.check, size: 12, color: Colors.white) : null,
                )
              else
                Container(
                  width: 16,
                  height: 16,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Colors.transparent,
                    border: Border.all(color: active ? const Color(0xFF22D3EE) : const Color(0xFF5A5A5A), width: active ? 5 : 1),
                  ),
                ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  opt,
                  style: TextStyle(fontSize: 14, color: active ? const Color(0xFF22D3EE) : const Color(0xFFE0E0E0)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildCustomInput() {
    return TextField(
      controller: _textCtrl,
      autofocus: true,
      minLines: 1,
      maxLines: 4,
      style: const TextStyle(fontSize: 14, color: Color(0xFFE0E0E0)),
      decoration: InputDecoration(
        hintText: req.placeholder ?? '请输入你的回答',
        hintStyle: const TextStyle(fontSize: 14, color: Color(0xFF5A5A5A)),
        filled: true,
        fillColor: const Color(0xFF262633),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
      ),
      onSubmitted: (_) => _submit(),
      onChanged: (_) => setState(() {}), // 输入时刷新「提交」按钮启用态
    );
  }
}
