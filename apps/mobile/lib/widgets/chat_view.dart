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
                : _buildList(),
          ),
          _buildComposer(),
        ],
      ),
    );
  }

  /// 正序构建消息节点列表：把连续的 tool 步骤聚合到紧随其后的 assistant 气泡内
  /// （对齐桌面端 ChatPlugin 的 toolBuffer 聚合逻辑），user/assistant 独立成气泡。
  List<Widget> _buildNodes() {
    final nodes = <Widget>[];
    var toolBuffer = <ToolTrace>[];
    void flushTools() {
      if (toolBuffer.isEmpty) return;
      nodes.add(Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [for (final t in toolBuffer) ToolStepWidget(trace: t)],
      ));
      toolBuffer = [];
    }

    for (final item in _items) {
      if (item is UserItem) {
        flushTools();
        nodes.add(UserBubble(content: item.content));
      } else if (item is AssistantItem) {
        nodes.add(AssistantBubble(
          content: item.content,
          reasoning: item.reasoningContent,
          toolSteps: List<ToolTrace>.of(toolBuffer),
          turnDuration: item.turnDuration,
        ));
        toolBuffer = [];
      } else if (item is ToolItem) {
        toolBuffer.add(item.trace);
      }
    }
    // 尾部残留 tool（如任务中断、无 assistant 收尾）：独立渲染为紧凑步骤
    flushTools();
    return nodes;
  }

  Widget _buildList() {
    final nodes = _buildNodes();
    return ListView.builder(
      controller: _scrollCtrl,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      itemCount: nodes.length + (_busy ? 1 : 0),
      itemBuilder: (ctx, i) {
        // reverse 列表：i=0 是视觉底部（最新）。流式气泡固定在最底部，
        // 历史消息按「新→旧」向上排列，进页天然停在最新位置，无需手动滚底。
        if (_busy && i == 0) return _buildStreamingBubble();
        final offset = _busy ? i - 1 : i;
        return nodes[nodes.length - 1 - offset];
      },
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
