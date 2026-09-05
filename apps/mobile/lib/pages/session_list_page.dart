import 'dart:async';
import '../locale.dart';
import 'package:flutter/material.dart';
import '../theme.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';
import 'chat_page.dart';
import '../l10n/generated/app_localizations.dart';

/// 会话列表页（会话模式入口）：列出桌面端所有会话，点击进入直接对会话负责。

/// context-free 取词入口：沿用 7B 在 tool_step.dart 建立的同一形态（同一 resolvedLocale、同一份 ARB）。
/// 【为什么不在这里用 AppLocalizations.of(context)】of() 在 nullable-getter:false 下要求祖先必须装好
/// AppLocalizations.delegates；仓库既有测试 chat_view_scroll_test 就是把本组件挂在只带默认 delegate 的
/// MaterialApp 下跑的，of() 会直接抛 Null check operator。_l 不依赖祖先节点，且 7B 的 LS3 已实测
/// 「locale 变化会重建整棵页面子树 → context-free 取词同样跟切」，所以这里不是绕路，是同一套机制。
AppLocalizations get _l => lookupAppLocalizations(resolvedLocale(LocaleController.instance.value));
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
        // 对话框标题复用既有 toolSessionActionDelete（两侧同文，不登记第二份）
        title: Text(_l.toolSessionActionDelete),
        content: Text(_l.sessionDeleteConfirm(s.title)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(_l.commonCancel)),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(_l.commonDelete, style: const TextStyle(color: Colors.redAccent))),
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
          title: Text(_l.toolSessionActionRename),
          content: TextField(
            controller: ctrl,
            autofocus: true,
            decoration: InputDecoration(hintText: _l.sessionRenameHint),
            onSubmitted: (v) => Navigator.pop(ctx, v.trim()),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: Text(_l.commonCancel)),
            TextButton(
              onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
              child: Text(_l.commonOk),
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
              title: Text(_l.commonRename),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.redAccent),
              title: Text(_l.commonDelete, style: const TextStyle(color: Colors.redAccent)),
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
        title: Text(_l.homeNavSessions),
        backgroundColor: Colors.transparent,
        actions: [
          IconButton(onPressed: _createSession, icon: const Icon(Icons.add), tooltip: _l.toolSessionActionCreate),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _sessions.isEmpty
              ? Center(child: Text(_l.sessionEmpty, style: const TextStyle(color: Colors.grey)))
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
    final l = _l;
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
                            child: Text(l.sessionRunning, style: TextStyle(fontSize: 11, color: c.running)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      // currentRequest 是用户/模型数据，原样呈现；为空才用我们的占位
                      s.currentRequest.isEmpty ? l.sessionNoRequest : s.currentRequest,
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
                        // 量词与「上下文 N%」都进词条：英文没有「步」这个量词，拼不出来
                        _meta(Icons.memory, s.modelName.isEmpty ? l.sessionDefaultModel : s.modelName),
                        _meta(Icons.tune, l.commonSteps(s.stepCount)),
                        _meta(Icons.pie_chart_outline, l.sessionContextUsage((s.contextUsageRatio * 100).toStringAsFixed(0))),
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
