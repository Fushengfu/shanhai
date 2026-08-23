import 'package:flutter/material.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';
import '../widgets/chat_view.dart';

/// 会话管家页（管家模式）：直接对会话管家负责，由管家调度/配置所有会话。
class SupervisorPage extends StatelessWidget {
  final WsClient ws;
  const SupervisorPage({super.key, required this.ws});

  @override
  Widget build(BuildContext context) {
    return ChatView(
      ws: ws,
      sessionId: 'supervisor',
      title: '会话管家',
      isSupervisor: true,
      sendFn: (message) => ws.sendCommand('run_supervisor', {'message': message}),
      loadHistoryFn: () async {
        final r = await ws.sendCommand('get_supervisor_history');
        if (r.ok && r.data is List) {
          return (r.data as List).map((e) => HistoryItem.fromJson(e as Map<String, dynamic>)).toList();
        }
        return [];
      },
    );
  }
}
