import 'dart:async';
import 'package:flutter/material.dart';
import '../theme.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';
import 'chat_page.dart';

/// 会话列表页（会话模式入口）：列出桌面端所有会话，点击进入直接对会话负责。
class SessionListPage extends StatefulWidget {
  final WsClient ws;
  const SessionListPage({super.key, required this.ws});

  @override
  State<SessionListPage> createState() => _SessionListPageState();
}

class _SessionListPageState extends State<SessionListPage> {
  List<SessionSummary> _sessions = [];
  bool _loading = true;
  StreamSubscription<ServerEvent>? _eventSub;
  StreamSubscription<ConnState>? _stateSub;

  @override
  void initState() {
    super.initState();
    _refresh();
    // 会话开始/结束、管家下发等事件都会改变会话状态，实时刷新列表
    _eventSub = widget.ws.events.listen((e) {
      if (e.event == 'session_activity' || e.event == 'user_message' || e.event == 'supervisor_result') {
        _refresh(silent: true);
      }
    });
    // 切换设备后重连配对成功（paired）时，会话列表需要重新拉取新设备的数据，
    // 否则 IndexedStack 保持本页存活、不会重建，列表会停留在旧设备。
    _stateSub = widget.ws.stateStream.listen((s) {
      if (s == ConnState.paired && mounted) {
        _refresh(silent: true);
      }
    });
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _stateSub?.cancel();
    super.dispose();
  }

  Future<void> _refresh({bool silent = false}) async {
    if (!silent) setState(() => _loading = true);
    try {
      final r = await widget.ws.sendCommand('list_sessions');
      if (!mounted) return;
      if (r.ok && r.data is List) {
        setState(() {
          _sessions = (r.data as List).map((e) => SessionSummary.fromJson(e as Map<String, dynamic>)).toList();
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _createSession() async {
    final r = await widget.ws.sendCommand('create_session');
    if (r.ok) await _refresh();
  }

  Future<void> _deleteSession(SessionSummary s) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('确定删除会话「${s.title}」？此操作不可恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除', style: TextStyle(color: Colors.redAccent))),
        ],
      ),
    );
    if (confirm == true) {
      await widget.ws.sendCommand('delete_session', {'sessionId': s.id});
      await _refresh();
    }
  }

  Future<void> _renameSession(SessionSummary s) async {
    final ctrl = TextEditingController(text: s.title);
    try {
      final newTitle = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('重命名会话'),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: const InputDecoration(hintText: '输入新名称…'),
            onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            TextButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: const Text('确定'),
            ),
          ],
        ),
      );
      if (newTitle != null && newTitle.isNotEmpty && newTitle != s.title) {
        await widget.ws.sendCommand('rename_session', {'sessionId': s.id, 'title': newTitle});
        await _refresh();
      }
    } finally {
      ctrl.dispose();
    }
  }

  Future<void> _showSessionActions(SessionSummary s) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('重命名'),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.redAccent),
              title: const Text('删除', style: TextStyle(color: Colors.redAccent)),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (action == 'rename') {
      await _renameSession(s);
    } else if (action == 'delete') {
      await _deleteSession(s);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('会话'),
        backgroundColor: Colors.transparent,
        actions: [
          IconButton(onPressed: _createSession, icon: const Icon(Icons.add), tooltip: '新建会话'),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _sessions.isEmpty
              ? const Center(child: Text('暂无会话', style: TextStyle(color: Colors.grey)))
              : RefreshIndicator(
                  onRefresh: _refresh,
                  child: ListView.builder(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
                    itemCount: _sessions.length,
                    itemBuilder: (ctx, i) => _SessionCard(
                      s: _sessions[i],
                      onTap: () {
                        Navigator.push(
                          context,
                          MaterialPageRoute(builder: (_) => ChatPage(ws: widget.ws, session: _sessions[i])),
                        ).then((_) => _refresh(silent: true));
                      },
                      onLongPress: () => _showSessionActions(_sessions[i]),
                    ),
                  ),
                ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  final SessionSummary s;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  const _SessionCard({required this.s, required this.onTap, required this.onLongPress});

  @override
  Widget build(BuildContext context) {
    final accent = Theme.of(context).colorScheme.primary;
    final c = context.appColors;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      color: c.cardBg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: s.busy ? c.running : (s.active ? accent : Colors.grey.shade600),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                        ),
                        if (s.busy)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(color: c.running.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
                            child: Text('执行中', style: TextStyle(fontSize: 11, color: c.running)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      s.currentRequest.isEmpty ? '（无需求）' : s.currentRequest,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 12,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        _meta(Icons.memory, s.modelName.isEmpty ? '默认模型' : s.modelName),
                        _meta(Icons.tune, '${s.stepCount} 步'),
                        _meta(Icons.pie_chart_outline, '上下文 ${(s.contextUsageRatio * 100).toStringAsFixed(0)}%'),
                      ],
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, color: Colors.grey),
            ],
          ),
        ),
      ),
    );
  }

  Widget _meta(IconData icon, String text) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: Colors.grey.shade600),
        const SizedBox(width: 3),
        Flexible(
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
          ),
        ),
      ],
    );
  }
}
