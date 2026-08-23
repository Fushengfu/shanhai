import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';

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
  /// 加载历史回调（返回历史消息列表）
  final Future<List<HistoryItem>> Function() loadHistoryFn;
  /// 是否管家模式（决定停止按钮用哪个命令；管家模式无停止按钮）
  final bool isSupervisor;

  const ChatView({
    super.key,
    required this.ws,
    required this.sessionId,
    required this.title,
    required this.sendFn,
    required this.loadHistoryFn,
    this.isSupervisor = false,
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
  StreamSubscription<ServerEvent>? _eventSub;

  @override
  void initState() {
    super.initState();
    _loadHistory();
    _eventSub = widget.ws.events.listen(_onEvent);
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    try {
      final items = await widget.loadHistoryFn();
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
      });
      _scrollToBottom();
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(_scrollCtrl.position.maxScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  void _onEvent(ServerEvent e) {
    if (!mounted) return;
    final sid = e.payload['sessionId']?.toString();
    switch (e.event) {
      case 'delta':
        if (sid == widget.sessionId) {
          setState(() => _streaming += e.payload['text']?.toString() ?? '');
          _scrollToBottom();
        }
        break;
      case 'reasoning':
        if (sid == widget.sessionId) {
          setState(() => _streamingReasoning += e.payload['text']?.toString() ?? '');
        }
        break;
      case 'tool_trace':
        final t = ToolTrace.fromJson(e.payload);
        if (t.sessionId == widget.sessionId) {
          setState(() {
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
            setState(() {
              _busy = false;
              _streaming = '';
              _streamingReasoning = '';
            });
            _loadHistory();
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

  // —— 审批弹窗 ——
  void _showApproval(ApprovalRequest req) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('工具执行需要审批'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('工具：${req.toolName}', style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Text('风险等级：${req.riskLevel}'),
            const SizedBox(height: 8),
            Text('参数：${req.args}', maxLines: 6, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: Colors.grey.shade400)),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('respond_approval', {'requestId': req.id, 'outcome': 'rejected'});
            },
            child: const Text('拒绝'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('respond_approval', {'requestId': req.id, 'outcome': 'allowed-once'});
            },
            child: const Text('允许一次'),
          ),
        ],
      ),
    );
  }

  // —— 提问/选择器弹窗 ——
  void _showAsk(AskRequest req) {
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
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(req.question),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView(
            shrinkWrap: true,
            children: req.sessionOptions!.map((s) {
              return ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(s.busy ? Icons.sync : Icons.forum_outlined, color: s.busy ? const Color(0xFF22D3EE) : Colors.grey),
                title: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('${s.modelName} · ${s.stepCount} 步', maxLines: 1, overflow: TextOverflow.ellipsis),
                onTap: () {
                  Navigator.pop(ctx);
                  widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': s.id});
                },
              );
            }).toList(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
            },
            child: const Text('取消'),
          ),
        ],
      ),
    );
  }

  void _showModelPicker(AskRequest req) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(req.question),
        content: SizedBox(
          width: double.maxFinite,
          child: ListView(
            shrinkWrap: true,
            children: req.modelOptions!.map((m) {
              return ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.memory, color: Colors.grey),
                title: Text(m.name),
                onTap: () {
                  Navigator.pop(ctx);
                  widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': m.id});
                },
              );
            }).toList(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('cancel_ask', {'requestId': req.id});
            },
            child: const Text('取消'),
          ),
        ],
      ),
    );
  }

  void _showOptionsAsk(AskRequest req) {
    final selected = <String>{};
    showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text(req.question),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: req.options.map((o) {
              final checked = selected.contains(o);
              return CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(o),
                value: checked,
                onChanged: (v) {
                  setDialogState(() {
                    if (req.multiple) {
                      v == true ? selected.add(o) : selected.remove(o);
                    } else {
                      selected.clear();
                      if (v == true) selected.add(o);
                    }
                  });
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
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () {
                Navigator.pop(ctx);
                final answer = req.multiple ? selected.toList().join(',') : (selected.isNotEmpty ? selected.first : '');
                widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': answer});
              },
              child: const Text('确定'),
            ),
          ],
        ),
      ),
    );
  }

  void _showTextAsk(AskRequest req) {
    final ctrl = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(req.question),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: InputDecoration(hintText: req.placeholder ?? '输入回答…'),
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
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(ctx);
              widget.ws.sendCommand('respond_ask', {'requestId': req.id, 'answer': ctrl.text});
            },
            child: const Text('确定'),
          ),
        ],
      ),
    );
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
                : ListView.builder(
                    controller: _scrollCtrl,
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                    itemCount: _items.length + (_busy ? 1 : 0),
                    itemBuilder: (ctx, i) {
                      if (i < _items.length) {
                        return _buildItem(_items[i]);
                      }
                      return _buildStreamingBubble();
                    },
                  ),
          ),
          _buildComposer(),
        ],
      ),
    );
  }

  Widget _buildItem(HistoryItem item) {
    switch (item) {
      case UserItem():
        return _UserBubble(content: item.content);
      case AssistantItem():
        return _AssistantBubble(content: item.content, reasoning: item.reasoningContent);
      case ToolItem():
        return _ToolCard(trace: item.trace);
    }
  }

  Widget _buildStreamingBubble() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_pendingTools.isNotEmpty)
          ..._pendingTools.map((t) => _ToolCard(trace: t)),
        _AssistantBubble(content: _streaming, reasoning: _streamingReasoning, thinking: true),
      ],
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

class _UserBubble extends StatelessWidget {
  final String content;
  const _UserBubble({required this.content});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: const Color(0xFF2A2A3A),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(content, style: const TextStyle(fontSize: 15)),
      ),
    );
  }
}

class _AssistantBubble extends StatelessWidget {
  final String content;
  final String? reasoning;
  final bool thinking;
  const _AssistantBubble({required this.content, this.reasoning, this.thinking = false});

  @override
  Widget build(BuildContext context) {
    final hasContent = content.isNotEmpty;
    final hasReasoning = reasoning != null && reasoning!.isNotEmpty;
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.86),
        decoration: BoxDecoration(
          color: const Color(0xFF1A1A24),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (hasReasoning)
              ExpansionTile(
                tilePadding: EdgeInsets.zero,
                title: Text('思考过程', style: TextStyle(fontSize: 12, color: Colors.grey.shade500)),
                childrenPadding: const EdgeInsets.only(bottom: 4),
                children: [
                  Text(reasoning!, style: TextStyle(fontSize: 13, color: Colors.grey.shade400, height: 1.5)),
                ],
              ),
            if (hasContent)
              MarkdownBody(
                data: content,
                selectable: true,
                styleSheet: _markdownStyle(context),
              ),
            if (!hasContent && !hasReasoning && thinking)
              Row(
                children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 8),
                  Text('思考中…', style: TextStyle(fontSize: 13, color: Colors.grey.shade500)),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

/// 深色主题下的 Markdown 样式（代码块/引用块适配深色气泡背景）
MarkdownStyleSheet _markdownStyle(BuildContext context) {
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: const TextStyle(fontSize: 15, height: 1.5, color: Color(0xFFE5E7EB)),
    code: const TextStyle(
      fontSize: 13,
      fontFamily: 'monospace',
      backgroundColor: Color(0xFF2A2A3A),
      color: Color(0xFF7DD3FC),
    ),
    codeblockDecoration: BoxDecoration(
      color: const Color(0xFF14141C),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: const Color(0xFF2A2A3A)),
    ),
    codeblockPadding: const EdgeInsets.all(10),
    blockquoteDecoration: BoxDecoration(
      color: const Color(0xFF1A1A24),
      border: const Border(left: BorderSide(color: Color(0xFF8B5CF6), width: 3)),
    ),
    blockquotePadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
  );
}

/// 工具名 → 中文显示名（对齐桌面端 ToolStep 的 TOOL_META，避免向用户暴露英文原始名）
const Map<String, String> _toolNameMap = {
  'read_file': '读取文件',
  'write_file': '写入文件',
  'edit_file': '编辑文件',
  'run_command': '执行命令',
  'list_dir': '列出目录',
  'image_analyze': '识别图片',
  'computer_screenshot': '屏幕截图',
  'computer_ocr': '文字识别',
  'computer_action': '电脑操作',
  'browser_create': '创建浏览器窗口',
  'browser_list': '列出浏览器窗口',
  'browser_navigate': '打开网页',
  'browser_close': '关闭浏览器窗口',
  'browser_screenshot': '网页截图',
  'browser_get_info': '读取页面信息',
  'browser_get_content': '读取页面内容',
  'browser_evaluate': '执行页面脚本',
  'browser_click': '点击页面元素',
  'browser_type': '页面输入',
  'browser_scroll': '滚动页面',
  'browser_wait': '等待元素',
  'browser_get_console_logs': '查看控制台日志',
  'browser_get_network_requests': '查看网络请求',
  'browser_get_cookies': '读取 Cookie',
  'browser_set_cookie': '设置 Cookie',
  'browser_clear_cookies': '清除 Cookie',
  'rollback_file': '回滚文件',
  'remember': '保存记忆',
  'recall_memory': '召回记忆',
  'plugin_inspect': '查看自修改',
  'plugin_define': '定义动态包',
  'plugin_run': '运行动态包',
  'plugin_stop': '停止动态包',
  'plugin_undefine': '删除动态包',
  'list_sessions': '查看会话列表',
  'inspect_session': '查看会话详情',
  'list_models': '查看可用模型',
  'switch_session': '切换激活会话',
  'send_message': '给会话下发任务',
  'inject_message': '给会话追加需求',
  'set_session_model': '切换会话模型',
  'set_session_approval': '配置会话安全模式',
  'set_session_workdir': '设置会话工作目录',
  'create_session': '新建会话',
  'rename_session': '重命名会话',
  'delete_session': '删除会话',
  'choose_session': '选择会话',
  'choose_model': '选择模型',
  'ask_user': '向用户提问',
};

/// skill_run（可执行技能统一入口）的 skillId:action → 中文显示名
const Map<String, String> _skillActionNameMap = {
  'computer-use:screenshot': '屏幕截图',
  'computer-use:ocr': '文字识别',
  'computer-use:action': '电脑操作',
  'browser-use:create': '创建浏览器窗口',
  'browser-use:list': '列出浏览器窗口',
  'browser-use:navigate': '打开网页',
  'browser-use:close': '关闭浏览器窗口',
  'browser-use:screenshot': '网页截图',
  'browser-use:get_info': '读取页面信息',
  'browser-use:get_content': '读取页面内容',
  'browser-use:evaluate': '执行页面脚本',
  'browser-use:click': '点击页面元素',
  'browser-use:type': '页面输入',
  'browser-use:scroll': '滚动页面',
  'browser-use:wait': '等待元素',
  'browser-use:get_console_logs': '查看控制台日志',
  'browser-use:get_network_requests': '查看网络请求',
  'browser-use:get_cookies': '读取 Cookie',
  'browser-use:set_cookie': '设置 Cookie',
  'browser-use:clear_cookies': '清除 Cookie',
};

/// 工具名 → 中文显示名（skill_run 按 skillId+action 细分，未知名回退为原英文名）
String _friendlyToolName(String name, Map<String, dynamic>? args) {
  if (name == 'skill_run') {
    final skillId = args?['skillId']?.toString() ?? '';
    final action = args?['action']?.toString() ?? '';
    return _skillActionNameMap['$skillId:$action'] ?? '执行技能';
  }
  return _toolNameMap[name] ?? (name.isEmpty ? '工具操作' : name);
}

enum _ToolStatus { running, pendingApproval, done, error }

/// 工具调用/结果卡片：可折叠，头部显示状态图标 + 工具名 + 耗时，展开后查看美化后的参数与结果。
class _ToolCard extends StatefulWidget {
  final ToolTrace trace;
  const _ToolCard({required this.trace});

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _expanded = false;

  ToolTrace get trace => widget.trace;
  bool get _isCall => trace.kind == 'tool-call';

  _ToolStatus get _status {
    if (_isCall) {
      if (trace.approvalRequired && !trace.approved) return _ToolStatus.pendingApproval;
      return _ToolStatus.running;
    }
    if (trace.error != null && trace.error!.isNotEmpty) return _ToolStatus.error;
    return _ToolStatus.done;
  }

  String get _title {
    final name = _friendlyToolName(trace.name, trace.args);
    if (_status == _ToolStatus.pendingApproval) return '$name · 待审批';
    if (_status == _ToolStatus.error) return '$name · 失败';
    return name;
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xFF16161F),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: Colors.grey.shade800),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  _statusIcon(status),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _statusColor(status)),
                    ),
                  ),
                  if (trace.durationMs != null)
                    Text(_formatDuration(trace.durationMs!), style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                  const SizedBox(width: 6),
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more, size: 18, color: Colors.grey.shade500),
                ],
              ),
            ),
          ),
          if (_expanded) _buildDetail(),
        ],
      ),
    );
  }

  Widget _statusIcon(_ToolStatus s) {
    switch (s) {
      case _ToolStatus.running:
        return const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2));
      case _ToolStatus.pendingApproval:
        return const Icon(Icons.lock_outline, size: 16, color: Color(0xFFF59E0B));
      case _ToolStatus.error:
        return const Icon(Icons.error_outline, size: 16, color: Color(0xFFF87171));
      case _ToolStatus.done:
        return const Icon(Icons.check_circle_outline, size: 16, color: Color(0xFF34D399));
    }
  }

  Color _statusColor(_ToolStatus s) {
    switch (s) {
      case _ToolStatus.running:
        return const Color(0xFF22D3EE);
      case _ToolStatus.pendingApproval:
        return const Color(0xFFF59E0B);
      case _ToolStatus.error:
        return const Color(0xFFF87171);
      case _ToolStatus.done:
        return const Color(0xFF34D399);
    }
  }

  Widget _buildDetail() {
    final args = _pretty(trace.args);
    final result = _prettyResult();
    final reasoning = trace.reasoning;
    final hasReasoning = reasoning != null && reasoning.isNotEmpty;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (hasReasoning) _detailBlock('思考', reasoning),
          if (args.isNotEmpty) _detailBlock('参数', args),
          if (result.isNotEmpty) _detailBlock('结果', result),
          if (args.isEmpty && result.isEmpty && !hasReasoning)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('无参数 / 结果', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            ),
        ],
      ),
    );
  }

  Widget _detailBlock(String label, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade500, fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 220),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFF14141C),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: const Color(0xFF2A2A3A)),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                text,
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: Color(0xFFD1D5DB), height: 1.5),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _pretty(dynamic v) {
    if (v == null) return '';
    if (v is String) return v;
    try {
      const encoder = JsonEncoder.withIndent('  ');
      return encoder.convert(v);
    } catch (_) {
      return v.toString();
    }
  }

  String _prettyResult() {
    if (trace.error != null && trace.error!.isNotEmpty) return trace.error!;
    return _pretty(trace.result);
  }

  String _formatDuration(int ms) {
    if (ms < 1000) return '$ms ms';
    return '${(ms / 1000).toStringAsFixed(1)}s';
  }
}
