import 'package:flutter/material.dart';
import '../services/ws_client.dart';
import '../models/protocol.dart';
import '../widgets/chat_view.dart';

/// 会话聊天页（会话模式）：直接对某个会话负责，发消息执行、看工具步骤、应答审批/提问。
class ChatPage extends StatelessWidget {
  final WsClient ws;
  final SessionSummary session;
  const ChatPage({super.key, required this.ws, required this.session});

  @override
  Widget build(BuildContext context) {
    return ChatView(
      ws: ws,
      sessionId: session.id,
      title: session.title,
      initialIncompleteTurn: session.hasIncompleteTurn,
      sendFn: (message) => ws.sendCommand('send_message', {'sessionId': session.id, 'message': message, 'mode': 'insert'}),
      loadHistoryFn: ({int? sinceTurnSeq, int? beforeTurnSeq}) async {
        final payload = <String, dynamic>{'sessionId': session.id};
        if (sinceTurnSeq != null) payload['sinceTurnSeq'] = sinceTurnSeq;
        if (beforeTurnSeq != null) payload['beforeTurnSeq'] = beforeTurnSeq;
        final r = await ws.sendCommand('get_history', payload);
        if (r.ok && r.data is Map) {
          return HistoryResponse.fromJson(r.data as Map<String, dynamic>);
        }
        return HistoryResponse.empty;
      },
    );
  }
}
